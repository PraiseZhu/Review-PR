// 审查机换仓:只读预检、路径漂移检查、切换当天的命令清单(见 mivo/README.md「换仓」)。
// --preview / --drift / --plan 和不带 --yes 的 --apply 保持只读。
//
// 用法:
//   node mivo/deploy/cutover.mjs --manifest <切换清单.json> --preview   全部核对:路径漂移 + 新仓 GitHub 设置 + Mini 本机(在 Mini 上跑才核)
//   node mivo/deploy/cutover.mjs --manifest <切换清单.json> --drift     只核路径漂移
//   node mivo/deploy/cutover.mjs --manifest <切换清单.json> --plan      打印切换当天按角色排好的命令清单(不执行)
//   文件树默认经 gh 读两个仓的默认分支;--old-git / --new-git <本地 clone> 改读本地(配 --old-ref / --new-ref,默认 origin/<分支>)。
//   --json 输出 JSON;--verbose 连通过的路径规则也列出来;--help 打印用法。
// 退出码:0 全部通过;1 有缺项、漂移或不一致;2 没有缺项但有查不了的项;3 参数或切换清单不合法(什么都没读)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toCliArgs } from './tuple-lib.mjs';
import { toManifest, toPathRules, toDriftReport, toSettingsReport, toMiniReport, toExitCode, toReportText, toCutoverPlan } from './cutover-lib.mjs';
import { DEFAULT_ISSUE_AGENT_DIR, RUNTIME_NAMES } from './issue-agent-consumers.mjs';
import { SKILL_ROOT, MINI_CONFIG_REL } from '../lib/common.mjs';
import { executeGitHub, readGitHubState, toGitHubPlan, undoGitHub } from './cutover-apply-github.mjs';
import { readJournal, runApply, runRollback } from './cutover-apply.mjs';
import { checkMiniRollback, executeMini, prepareMiniStep, readMiniState, undoMini } from './cutover-apply-mini.mjs';

const USAGE = `用法:node mivo/deploy/cutover.mjs --manifest <切换清单.json> (--preview | --drift | --plan | --apply <github|mini> [--yes])
       node mivo/deploy/cutover.mjs --rollback <备份目录> [--home <目录>]
       [--old-git <本地 clone> [--old-ref <ref>]] [--new-git <本地 clone> [--new-ref <ref>]] [--json] [--verbose]
  --preview   只读预检:路径漂移、新仓 GitHub 设置、Mini 本机(在 Mini 上跑才核)
  --drift     只核路径漂移(规则在旧仓命中、新仓一个都不命中就报)
  --plan      打印切换当天的命令清单,不执行
  --apply     核对并展示 GitHub 或 Mini 执行计划;只有 --yes 才写入
  --home      Mini 和备份目录的根,缺省 HOME
  --install-mini <替身脚本>  只用于显式 --home 指向的隔离副本
  切换清单格式见 mivo/deploy/cutover.example.json。
退出码:0 全部通过,1 有缺项或漂移,2 有查不了的项,3 参数或切换清单不合法。
`;
const CLI = toCliArgs(process.argv.slice(2), {
  flags: ['preview', 'drift', 'plan', 'json', 'verbose', 'yes'],
  values: ['manifest', 'old-git', 'old-ref', 'new-git', 'new-ref', 'apply', 'rollback', 'home', 'install-mini'],
});

// helpers
const short = (text) => String(text ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 240);
function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 512 * 1024 * 1024 });
  return r.status === 0 ? { ok: true, stdout: r.stdout } : { ok: false, error: short(r.stderr || r.error || `exit ${r.status}`) };
}
function toRead(r, parse) {
  if (!r.ok) return { ok: false, error: r.error };
  try { return { ok: true, value: parse(r.stdout) }; } catch (error) { return { ok: false, error: `返回内容读不懂:${error.message}` }; }
}
const lines = (text) => text.split('\n').filter(Boolean);
const ghNames = (endpoint, jq) => toRead(gh(['api', endpoint, '--paginate', '--jq', jq]), lines);
const readJsonFile = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// 实例配置要分清「没有」和「读不了」:文件不存在返回 null,存在但读不了、JSON 坏了或顶层不是对象返回 { unreadable }。
function readMiniConfig(file) {
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return { unreadable: error.message.slice(0, 200) }; }
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  return isObject ? value : { unreadable: `顶层应是 JSON 对象,实际 ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}` };
}

// 文件树:本地 clone(git ls-tree)或 GitHub(git/trees 递归)。返回 { files, scripts },读不到抛错。
function readTree({ repo, branch, gitDir, ref }) {
  if (gitDir) {
    const at = ref ?? `origin/${branch}`;
    const ls = spawnSync('git', ['-C', gitDir, 'ls-tree', '-r', '-z', '--name-only', at], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (ls.status !== 0) throw new Error(`git ls-tree ${at} 失败:${short(ls.stderr)}`);
    const pkg = spawnSync('git', ['-C', gitDir, 'show', `${at}:package.json`], { encoding: 'utf8' });
    return { files: ls.stdout.split('\0').filter(Boolean), scripts: pkg.status === 0 ? (JSON.parse(pkg.stdout).scripts ?? {}) : null };
  }
  const tree = toRead(gh(['api', `repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    '--jq', '{truncated: .truncated, files: [.tree[] | select(.type == "blob") | .path]}']), JSON.parse);
  if (!tree.ok) throw new Error(tree.error);
  if (tree.value.truncated) throw new Error('GitHub 返回的文件树被截断,改用 --old-git / --new-git 指向本地 clone');
  const pkg = toRead(gh(['api', `repos/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`, '--jq', '.content']),
    (text) => JSON.parse(Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8')).scripts ?? {});
  return { files: tree.value.files, scripts: pkg.ok ? pkg.value : null };
}

function driftItems(manifest) {
  const prRules = readJsonFile(path.join(SKILL_ROOT, 'review-pr/config/pr-rules.json'));
  const features = readJsonFile(path.join(SKILL_ROOT, 'mivo/config/review-features.json'));
  const ruleMap = fs.readFileSync(path.join(SKILL_ROOT, 'review-pr/references/rule-map.md'), 'utf8');
  if (!prRules || !features) return [{ area: '路径规则', item: '审查机配置', status: 'unknown', detail: 'pr-rules.json 或 review-features.json 读不懂' }];
  const { rules, unclassified } = toPathRules({ prRules, features, ruleMap });
  const trees = {};
  for (const [side, repo, branch, gitDir, ref] of [
    ['old', manifest.oldRepo, manifest.oldBranch, CLI.values.get('old-git'), CLI.values.get('old-ref')],
    ['new', manifest.newRepo, manifest.defaultBranch, CLI.values.get('new-git'), CLI.values.get('new-ref')],
  ]) {
    try { trees[side] = readTree({ repo, branch, gitDir, ref }); } catch (error) {
      return [{ area: '路径规则', item: `${side === 'old' ? '旧仓' : '新仓'} ${repo} 的文件树`, status: 'unknown', detail: error.message }];
    }
  }
  return toDriftReport({ rules, unclassified, ciCovered: features.focus?.ciCovered ?? [], old: trees.old, new: trees.new });
}

function settingsItems(manifest) {
  const { oldRepo, newRepo } = manifest;
  const variables = (repo) => toRead(gh(['api', `repos/${repo}/actions/variables?per_page=100`, '--paginate', '--jq', '.variables[] | [.name, .value] | @json']),
    (text) => Object.fromEntries(lines(text).map((line) => JSON.parse(line))));
  const branchRules = (repo, branch) => toRead(gh(['api', `repos/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`, '--paginate',
    '--jq', '.[] | {type, parameters} | @json']), (text) => lines(text).map((line) => JSON.parse(line)));
  return toSettingsReport(manifest, {
    repo: toRead(gh(['api', `repos/${newRepo}`, '--jq', '{full_name, default_branch, archived}']), JSON.parse),
    workflow: toRead(gh(['api', `repos/${newRepo}/actions/workflows/review-pr.yml`, '--jq', '.state']), (text) => text.trim()),
    oldVariables: variables(oldRepo),
    newVariables: variables(newRepo),
    secrets: ghNames(`repos/${newRepo}/actions/secrets?per_page=100`, '.secrets[].name'),
    orgSecrets: ghNames(`repos/${newRepo}/actions/organization-secrets?per_page=100`, '.secrets[].name'),
    environments: ghNames(`repos/${newRepo}/environments?per_page=100`, '.environments[].name'),
    labels: ghNames(`repos/${newRepo}/labels?per_page=100`, '.[].name'),
    oldLabels: ghNames(`repos/${oldRepo}/labels?per_page=100`, '.[].name'),
    rulesets: ghNames(`repos/${newRepo}/rulesets?per_page=100&includes_parents=true`, '.[].name'),
    oldRulesets: ghNames(`repos/${oldRepo}/rulesets?per_page=100&includes_parents=true`, '.[].name'),
    oldBranchRules: branchRules(oldRepo, manifest.oldBranch),
    newBranchRules: branchRules(newRepo, manifest.defaultBranch),
    runners: toRead(gh(['api', `repos/${newRepo}/actions/runners?per_page=100`, '--paginate', '--jq', '.runners[] | {status, labels: [.labels[].name]} | @json']),
      (text) => lines(text).map((line) => JSON.parse(line))),
  });
}

// Mini 本机:只在本机有 ~/mivo-prereview 时核;只读 repos、repoAllowlist 这些字段,不读私钥。
function miniItems(manifest, home) {
  const miniRoot = path.join(home, 'mivo-prereview');
  if (!fs.existsSync(miniRoot) ||
      !fs.readdirSync(miniRoot).some((entry) => entry !== 'cutover-backup')) {
    return [{ area: 'Mini 本机', item: '本机核对', status: 'info', detail: '本机没有 ~/mivo-prereview,跳过(在 Mini 上跑才核)' }];
  }
  const routerRoot = path.join(home, 'mivo-gh-router');
  const routers = (fs.existsSync(routerRoot) ? fs.readdirSync(routerRoot) : [])
    .filter((name) => fs.existsSync(path.join(routerRoot, name, 'config.json')))
    .map((name) => ({ name, repos: readJsonFile(path.join(routerRoot, name, 'config.json'))?.repos ?? null }));
  const checksDir = path.join(home, 'mivo-prereview/monitor/scripts/schedule-checks');
  const [owner, name] = manifest.oldRepo.split('/');
  const monitor = (fs.existsSync(checksDir) ? fs.readdirSync(checksDir).filter((f) => f.endsWith('.mjs')) : []).flatMap((file) =>
    fs.readFileSync(path.join(checksDir, file), 'utf8').split('\n').flatMap((text, i) =>
      (text.includes(manifest.oldRepo) || (text.includes(`"${owner}"`) && text.includes(`"${name}"`)) ? [{ file, line: i + 1 }] : [])));
  const issueAgentDir = path.join(home, path.relative(os.homedir(), DEFAULT_ISSUE_AGENT_DIR));
  const issueAgent = fs.existsSync(issueAgentDir)
    ? RUNTIME_NAMES.filter((file) => fs.existsSync(path.join(issueAgentDir, file)))
      .map((file) => ({ file, allow: readJsonFile(path.join(issueAgentDir, file))?.repoAllowlist ?? null }))
    : null;
  const items = toMiniReport(manifest, { config: readMiniConfig(path.join(home, MINI_CONFIG_REL)), routers, monitor, issueAgent });
  for (const name of Object.keys(manifest.rehearsalInstallationIds ?? {})) {
    items.push({ area: 'Mini 本机', item: 'App installationId ' + name, status: 'manual', detail: '替身，未实测' });
  }
  return items;
}

function showPreview(manifest, home, kind = 'preview') {
  let items;
  if (kind === 'preview' && manifest.rehearsal) {
    const manual = (item, detail) => ({ area: '演练不适用/人工', item, status: 'manual', detail });
    items = [
      manual('路径漂移与 workflow 文件', '演练仓不复制旧仓代码；真实新仓推送代码后核对'),
      manual('组织 secrets', '个人仓不会继承旧组织的 ANTHROPIC_API_KEY'),
      manual('GitHub App 安装', '演练仓不安装生产 App'),
      manual('runner', '演练仓不注册生产 runner'),
    ];
    try {
      const remaining = toGitHubPlan(manifest, readGitHubState(manifest));
      items.push(...remaining.map((step) => {
        if (step.note?.startsWith('不适用')) return manual(step.target, step.note);
        return { area: '演练 GitHub 设置', item: step.action + ' ' + step.target,
          status: step.skip && !step.note?.includes('不一致') ? 'ok' : 'mismatch', detail: step.note ?? (step.skip ? '已核对' : '仍有改动待执行') };
      }));
    } catch (error) {
      items.push({ area: '演练 GitHub 设置', item: '读取设置', status: 'unknown', detail: error.message });
    }
    items.push(...miniItems(manifest, home));
  } else {
    items = [...driftItems(manifest), ...(kind === 'preview' ? [...settingsItems(manifest), ...miniItems(manifest, home)] : [])];
  }
  const exitCode = toExitCode(items);
  const report = toReportText(items, { verbose: CLI.flags.has('verbose') });
  process.stdout.write(CLI.flags.has('json') ? `${JSON.stringify({ manifest, exitCode, items }, null, 2)}\n`
    : `# 换仓${kind === 'preview' ? '只读预检' : '路径漂移检查'}:${manifest.oldRepo} → ${manifest.newRepo}\n\n${manifest.rehearsal && kind === 'preview' && exitCode === 0
      ? report.replace('全部通过', '可演练项通过；不适用和人工项未验证') : report}`);
  return exitCode;
}

function main() {
  if (CLI.help) { process.stdout.write(USAGE); return; }
  const actions = ['preview', 'drift', 'plan', 'apply', 'rollback'].filter((flag) => CLI.flags.has(flag) || CLI.values.has(flag));
  const segment = CLI.values.get('apply');
  const rollback = CLI.values.get('rollback');
  const problem = CLI.error ?? (actions.length !== 1 ? '--preview、--drift、--plan、--apply、--rollback 要给且只给一个'
    : !rollback && !CLI.values.get('manifest') ? '缺 --manifest'
      : rollback && CLI.values.has('manifest') ? '--rollback 从备份读清单，不接受 --manifest'
        : segment && !['github', 'mini'].includes(segment) ? '--apply 须是 github 或 mini'
          : CLI.flags.has('yes') && !segment ? '--yes 只用于 --apply' : null);
  if (problem) { process.stderr.write(`${problem}\n${USAGE}`); process.exitCode = 3; return; }
  let home;
  const requestedHome = CLI.values.get('home') ?? os.homedir();
  try { home = fs.realpathSync(requestedHome); } catch (error) {
    if (error.code === 'ENOENT' && !segment && !rollback && !CLI.values.has('home')) home = path.resolve(requestedHome);
    else {
      console.error('--home 读不到：' + error.message);
      process.exitCode = 3;
      return;
    }
  }
  const requestedInstaller = CLI.values.get('install-mini');
  const installer = requestedInstaller ? fs.realpathSync(requestedInstaller) : null;
  const isolated = CLI.values.has('home') && home !== fs.realpathSync(os.homedir());
  if (installer && (!isolated || !fs.statSync(installer).isFile())) {
    throw new Error('--install-mini 只允许用于 --home 指向的隔离副本');
  }
  const mini = { home, installer, isolated };
  if (rollback) {
    const { directory, record } = readJournal(rollback, home);
    if (record.segment === 'mini' && CLI.values.has('home') && home !== fs.realpathSync(os.homedir()) && !installer) {
      throw new Error('隔离回滚必须提供 --install-mini 替身');
    }
    if (record.segment === 'mini') checkMiniRollback(record, home);
    runRollback({ directory, record, undo: (operation, backup) => record.segment === 'mini'
      ? undoMini(operation, backup, mini) : undoGitHub(operation, record.manifest) });
    return;
  }
  let manifest;
  try { manifest = toManifest(fs.readFileSync(CLI.values.get('manifest'), 'utf8')); } catch (error) {
    process.stderr.write(`${error.code === 'ENOENT' ? `切换清单不存在:${CLI.values.get('manifest')}` : error.message}\n`);
    process.exitCode = 3;
    return;
  }
  if (manifest.rehearsalInstallationIds && !isolated) throw new Error('真实 HOME 不允许使用演练 App ID');
  if (segment) {
    if (manifest.oldRepo.toLowerCase() === manifest.newRepo.toLowerCase()) {
      console.error('执行段的新旧仓不能相同');
      process.exitCode = 3;
      return;
    }
    if (segment === 'mini') {
      if (CLI.flags.has('yes') && (CLI.values.has('home') || manifest.rehearsal) && !installer) {
        throw new Error('隔离执行必须提供 --home 与 --install-mini 替身');
      }
      process.exitCode = runApply({ manifest, segment, home, installer, steps: readMiniState(manifest, mini),
        yes: CLI.flags.has('yes'), execute: (operation) => executeMini(operation, mini),
        prepare: (step, directory, index) => prepareMiniStep(step, home, directory, index),
        preview: () => showPreview(manifest, home) });
      return;
    }
    process.exitCode = runApply({ manifest, segment, home,
      steps: toGitHubPlan(manifest, readGitHubState(manifest)), yes: CLI.flags.has('yes'),
      execute: (operation) => executeGitHub(operation, manifest),
      preview: () => showPreview(manifest, home) });
    return;
  }
  if (actions[0] === 'plan') {
    const oldVariables = toRead(gh(['api', `repos/${manifest.oldRepo}/actions/variables?per_page=100`, '--paginate', '--jq', '.variables[] | [.name, .value] | @json']),
      (text) => Object.fromEntries(lines(text).map((line) => JSON.parse(line))));
    if (!oldVariables.ok) process.stderr.write(`旧仓变量读不到(${oldVariables.error}),清单里留占位\n`);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    process.stdout.write(toCutoverPlan({ manifest, oldVariables: oldVariables.ok ? oldVariables.value : null,
      skillSha: oldVariables.ok ? oldVariables.value.MIVO_REVIEW_SKILL_SHA ?? null : null, date }));
    return;
  }
  process.exitCode = showPreview(manifest, home, actions[0]);
}

try { main(); } catch (error) {
  console.error('换仓停止：' + error.message);
  process.exitCode = 1;
}
