// 换仓切换(cutover-lib.mjs 纯函数 + cutover.mjs 命令行)。命令行用临时 git 仓当新旧文件树,PATH 最前面放 gh 替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  toManifest, toPathRules, toPathMatcher, toDriftReport, toSettingsReport, toMiniReport, toExitCode, toReportText, toCutoverPlan,
  REQUIRED_FILES, REQUIRED_SECRETS, isReviewVariable,
} from './cutover-lib.mjs';
import { matchPathPatterns } from '../../review-pr/scripts/lib.mjs';
import { SKILL_ROOT } from '../lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cutover.mjs');
const OLD = 'xindong/mivo-canvas-plugin';
const NEW = 'acme/mivo-next';
const manifest = (over = {}) => toManifest(JSON.stringify({ version: 1, oldRepo: OLD, newRepo: NEW, kind: 'transfer', ...over }));
const realConfig = () => ({
  prRules: JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'review-pr/config/pr-rules.json'), 'utf8')),
  features: JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'mivo/config/review-features.json'), 'utf8')),
  ruleMap: fs.readFileSync(path.join(SKILL_ROOT, 'review-pr/references/rule-map.md'), 'utf8'),
});

test('切换清单:补默认值;字段不合法时报出字段、期望与实际', () => {
  assert.deepEqual(manifest(), { version: 1, oldRepo: OLD, newRepo: NEW, kind: 'transfer', oldBranch: 'main', defaultBranch: 'main', runnerLabel: 'mivo-review' });
  assert.equal(manifest({ kind: 'fresh', defaultBranch: 'trunk' }).defaultBranch, 'trunk');
  assert.throws(() => toManifest('{oops'), /切换清单不是合法 JSON/);
  assert.throws(() => manifest({ version: 2 }), /version 须是 1,实际 2/);
  assert.throws(() => manifest({ newRepo: 'no-slash' }), /newRepo 须是 owner\/name,实际 "no-slash"/);
  assert.throws(() => manifest({ kind: 'move' }), /kind 须是 transfer \/ fresh/);
  assert.throws(() => manifest({ runnerLabel: 'bad label' }), /runnerLabel 须是 runner 标签名,实际 "bad label"/);
});

test('现网配置的路径字段都登记了匹配方式(漏登记的会进 unclassified);存储红线和必需文件都在核对清单里', () => {
  const { rules, unclassified } = toPathRules(realConfig());
  assert.deepEqual(unclassified, []);
  const has = (kind, pattern) => rules.some((r) => r.kind === kind && r.pattern === pattern);
  assert.ok(has('regex', '^shared/persist-contract\\.ts$'));
  assert.ok(has('regex', '^cindyplugin/src/persist/'));
  assert.ok(has('glob', '**/AGENTS.md'));
  assert.ok(has('prefix', 'docs/pr/'), 'taskIssue.alwaysInScope 的 docs/pr/<pr>/ 按 docs/pr/ 核');
  assert.ok(has('rule-map', '*.css'));
  for (const { path: file } of REQUIRED_FILES) assert.ok(has('exact', file), file);
  // 新加一个没登记的 *Paths 字段:不静默放过
  const extra = toPathRules({ ...realConfig(), prRules: { ...realConfig().prRules, newGatePaths: ['x/'] } });
  assert.deepEqual(extra.unclassified, ['newGatePaths']);
});

test('契约:glob 规则的匹配结果和审查时用的 matchPathPatterns 逐条一致', () => {
  const files = ['AGENTS.md', 'apps/web/AGENTS.md', 'AGENTS.md.bak', 'docs/loops/a.md', 'docs/loopsX/a.md', 'package.json', 'apps/package.json', '.npmrc', 'a/.npmrc'];
  const patterns = ['**/AGENTS.md', 'docs/loops/', 'package.json', '**/package.json', '**/.npmrc', 'CONTRIBUTING.md'];
  for (const pattern of patterns) {
    const ours = files.filter(toPathMatcher({ kind: 'glob', pattern }));
    assert.deepEqual(ours, matchPathPatterns(files, [pattern]), pattern);
  }
});

test('漂移:存储文件搬了目录 → drift;必需文件没了 → missing;两边都没有 → absent;命令删了 → drift', () => {
  const rules = [
    { kind: 'regex', pattern: '^shared/persist-contract\\.ts$', sources: ['pr-rules.json redlinePaths'] },
    { kind: 'regex', pattern: '^secrets/', sources: ['pr-rules.json redlinePaths'] },
    { kind: 'prefix', pattern: 'src/', sources: ['uiPaths'] },
    { kind: 'exact', pattern: '.github/workflows/review-pr.yml', sources: ['审查机代码'] },
    { kind: 'regex', pattern: '(', sources: ['坏规则'] },
  ];
  const old = { files: ['shared/persist-contract.ts', 'src/a.ts', '.github/workflows/review-pr.yml', 'scripts/ci/cycle-guard.mjs'], scripts: { 'test:unit': 'x', 'test:server-pg': 'y' } };
  const moved = { files: ['packages/shared/persist-contract.ts', 'src/a.ts'], scripts: { 'test:unit': 'x' } };
  const items = toDriftReport({ rules, unclassified: ['futurePaths'], ciCovered: ['npm run test:unit', 'npm run test:server-pg', 'node scripts/ci/cycle-guard.mjs', 'gitleaks'], old, new: moved });
  const status = (pattern) => items.find((i) => i.pattern === pattern).status;
  assert.equal(status('^shared/persist-contract\\.ts$'), 'drift');
  assert.equal(items.find((i) => i.pattern === '^shared/persist-contract\\.ts$').oldCount, 1);
  assert.equal(status('^secrets/'), 'absent');
  assert.equal(status('src/'), 'ok');
  assert.equal(status('.github/workflows/review-pr.yml'), 'missing');
  assert.equal(status('('), 'invalid');
  assert.equal(status('futurePaths'), 'unknown');
  assert.equal(status('npm run test:unit'), 'ok');
  assert.equal(status('npm run test:server-pg'), 'drift');
  assert.equal(status('node scripts/ci/cycle-guard.mjs'), 'drift');
  assert.equal(status('gitleaks'), 'manual');
  assert.equal(toExitCode(items), 1);
  // 新仓 package.json 读不到:npm 命令记「查不了」,不当成删了
  const noPkg = toDriftReport({ rules: [], ciCovered: ['npm run test:unit'], old, new: { files: [], scripts: null } });
  assert.equal(noPkg[0].status, 'unknown');
  assert.equal(toExitCode(noPkg), 2);
});

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });
const find2 = (items, item) => items.find((i) => i.item === item) ?? assert.fail(`没有这一项:${item}`);
const checksRule = (...contexts) => ({ type: 'required_status_checks',
  parameters: { strict_required_status_checks_policy: false, required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })) } });
const OLD_RULES = [
  { type: 'deletion', parameters: null },
  { type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'merge'], require_code_owner_review: true } },
  checksRule('verify', 'review-pr'),
];
// 同一组规则:顺序、参数键顺序、数组顺序都换了(重建规则集后 GitHub 返回的顺序可能不同),不算差异。
const NEW_RULES = [
  checksRule('review-pr', 'verify'),
  { type: 'pull_request', parameters: { require_code_owner_review: true, allowed_merge_methods: ['merge', 'squash'] } },
  { type: 'deletion' },
];
const settingsReads = (over = {}) => ({
  repo: ok({ full_name: NEW, default_branch: 'main', archived: false }),
  workflow: ok('active'),
  oldVariables: ok({ MIVO_REVIEW_MODE: 'live', MIVO_REVIEW_SKILL_SHA: 'a'.repeat(40), MIVO_REVIEW_RUNNER_LABEL: 'mivo-review', PRAISEBUILD_APP_ID: '1',
    MIVO_PREREVIEW_HEARTBEAT: '2026-11-25T00:00:00Z', MIVO_AUTOMERGE_MODE: 'on' }),
  newVariables: ok({ MIVO_REVIEW_MODE: 'dry-run', MIVO_REVIEW_SKILL_SHA: 'a'.repeat(40), MIVO_REVIEW_RUNNER_LABEL: 'mivo-review', PRAISEBUILD_APP_ID: '1' }),
  secrets: ok([...REQUIRED_SECRETS]), orgSecrets: ok(['ANTHROPIC_API_KEY']), environments: ok(['slack-inbound']),
  labels: ok(['review:merge-ready']), oldLabels: ok(['review:merge-ready']),
  rulesets: ok(['main-required-checks']), oldRulesets: ok(['main-required-checks']),
  oldBranchRules: ok(OLD_RULES), newBranchRules: ok(NEW_RULES),
  runners: ok([{ status: 'online', labels: ['self-hosted', 'mivo-review'] }]),
  ...over,
});

test('GitHub 设置:齐了全通过;心跳和自动合并这类非审查机变量不要求;缺项、标签不对、查不了分别报', () => {
  const all = toSettingsReport(manifest(), settingsReads());
  assert.equal(toExitCode(all), 0, toReportText(all));
  assert.equal(all.find((i) => i.item === '审查机仓库变量(按旧仓对照)').detail, '4 个都在');
  assert.equal(isReviewVariable('MIVO_AUTOMERGE_MODE'), false);
  assert.equal(isReviewVariable('MIVO_PREREVIEW_HEARTBEAT'), false);
  assert.equal(isReviewVariable('MIVO_REVIEW_ROLE_PRIMARY'), true);

  const broken = toSettingsReport(manifest(), settingsReads({
    repo: ok({ full_name: NEW, default_branch: 'trunk', archived: false }),
    newVariables: ok({ MIVO_REVIEW_SKILL_SHA: 'b'.repeat(40) }),
    secrets: fail('HTTP 403'),
    runners: ok([{ status: 'offline', labels: ['mivo-review'] }]),
  }));
  const find = (item) => broken.find((i) => i.item === item);
  assert.equal(find('默认分支').detail, '期望 main,实际 trunk');
  assert.equal(find('审查机仓库变量(按旧仓对照)').detail, '缺 MIVO_REVIEW_MODE、MIVO_REVIEW_RUNNER_LABEL、PRAISEBUILD_APP_ID');
  assert.equal(find('MIVO_REVIEW_SKILL_SHA').status, 'mismatch');
  assert.match(find('MIVO_REVIEW_RUNNER_LABEL').detail, /期望 mivo-review,实际 未设置\(workflow 会落到缺省 mivo-review-next/);
  assert.deepEqual([find('仓库 secrets').status, find('仓库 secrets').detail], ['unknown', '查不了:HTTP 403']);
  assert.deepEqual([find('带 mivo-review 标签的在线 runner').status, find('带 mivo-review 标签的在线 runner').detail], ['missing', '0 个']);
  assert.equal(toExitCode(broken), 1);
  // 新仓还不存在
  const absent = toSettingsReport(manifest(), settingsReads({ repo: fail('HTTP 404'), workflow: fail('HTTP 404') }));
  assert.deepEqual([find2(absent, `仓 ${NEW}`).status, find2(absent, '.github/workflows/review-pr.yml 登记').status], ['missing', 'missing']);
  // 没权限、限流不是「新仓不存在」:记查不了,退出 2
  const denied = toSettingsReport(manifest(), settingsReads({ repo: fail('HTTP 403: Resource not accessible'), workflow: fail('HTTP 401: Bad credentials') }));
  assert.deepEqual([find2(denied, `仓 ${NEW}`).status, find2(denied, `仓 ${NEW}`).detail], ['unknown', '查不了:HTTP 403: Resource not accessible']);
  assert.equal(find2(denied, '.github/workflows/review-pr.yml 登记').status, 'unknown');
  assert.equal(toExitCode(denied), 2);
});

test('GitHub 设置:变量值和默认分支规则按旧仓逐条对照;同名但值或内容不同也报,MODE、RUNNER_LABEL、新建仓的看门狗 issue 不比值', () => {
  const find = (items, item) => items.find((i) => i.item === item);
  const all = toSettingsReport(manifest(), settingsReads());
  assert.equal(find(all, '默认分支必需检查(按旧仓对照)').detail, '2 项一致');
  assert.equal(find(all, '默认分支生效规则(含组织、企业级,按旧仓逐条对照)').detail, '3 条一致');

  const oldVariables = ok({ MIVO_REVIEW_MODE: 'live', MIVO_REVIEW_ROLE_PRIMARY: '{"model":"m1"}', MIVO_REVIEW_WATCHDOG_ISSUE: '12', MIVO_REVIEW_RUNNER_LABEL: 'mivo-review' });
  const newVariables = ok({ MIVO_REVIEW_MODE: 'dry-run', MIVO_REVIEW_ROLE_PRIMARY: '{"model":"m2"}', MIVO_REVIEW_WATCHDOG_ISSUE: '3', MIVO_REVIEW_RUNNER_LABEL: 'mivo-review' });
  const wrong = toSettingsReport(manifest(), settingsReads({
    oldVariables, newVariables,
    newBranchRules: ok([checksRule('verify'), { type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'merge'], require_code_owner_review: false } },
      { type: 'deletion', parameters: null }]),
  }));
  assert.deepEqual([find(wrong, 'MIVO_REVIEW_ROLE_PRIMARY').status, find(wrong, 'MIVO_REVIEW_ROLE_PRIMARY').detail],
    ['mismatch', '新仓 "{\\"model\\":\\"m2\\"}",旧仓 "{\\"model\\":\\"m1\\"}":要和旧仓一样']);
  assert.equal(find(wrong, 'MIVO_REVIEW_WATCHDOG_ISSUE').status, 'mismatch'); // 转移:issue 编号保留,值要一样
  assert.equal(find(wrong, 'MIVO_REVIEW_MODE').status, 'info');
  assert.equal(wrong.filter((i) => i.item === 'MIVO_REVIEW_RUNNER_LABEL').length, 1); // 只有按清单核的那一条
  assert.deepEqual([find(wrong, '默认分支必需检查(按旧仓对照)').status, find(wrong, '默认分支必需检查(按旧仓对照)').detail], ['mismatch', '新仓缺 review-pr']);
  assert.equal(find(wrong, '默认分支生效规则(含组织、企业级,按旧仓逐条对照)').detail,
    '类型或参数对不上:新仓缺 pull_request、required_status_checks;新仓多 required_status_checks、pull_request');
  assert.equal(toExitCode(wrong), 1);

  const fresh = toSettingsReport(manifest({ kind: 'fresh' }), settingsReads({ oldVariables, newVariables }));
  assert.equal(find(fresh, 'MIVO_REVIEW_WATCHDOG_ISSUE'), undefined); // 新建仓:换成新仓的 issue 编号
  const unread = toSettingsReport(manifest(), settingsReads({ newBranchRules: fail('HTTP 403') }));
  assert.deepEqual([find(unread, '新仓默认分支生效规则').status, toExitCode(unread)], ['unknown', 2]);
});

test('Mini 本机:配置还指旧仓记 info;白名单、巡检、issue 评估缺新仓记缺;找不到 issue 评估目录记查不了', () => {
  const items = toMiniReport(manifest(), {
    config: { targetRepo: OLD, workflowRepo: OLD, mode: 'live' },
    routers: [{ name: 'praisebuild', repos: [OLD] }, { name: 'praisewatch', repos: [OLD, NEW] }],
    monitor: [{ file: 'mivo.mjs', line: 26 }, { file: 'mivo.mjs', line: 172 }],
    issueAgent: null,
  });
  const by = (item) => items.find((i) => i.item === item);
  assert.equal(by('实例配置 config/mivo.json').status, 'info');
  assert.equal(by('App 分流白名单 praisebuild').status, 'missing');
  assert.equal(by('App 分流白名单 praisewatch').status, 'ok');
  assert.equal(by('巡检脚本里的旧仓名').detail, 'mivo.mjs:26、mivo.mjs:172');
  assert.equal(by('issue 评估 repoAllowlist').status, 'unknown');
  const corrupt = toMiniReport(manifest(), { config: { unreadable: 'Unexpected token' }, routers: [], monitor: [], issueAgent: [{ file: 'runtime-primary.json', allow: [NEW] }] });
  assert.deepEqual([corrupt[0].status, toExitCode(corrupt)], ['unknown', 2]);
  const done = toMiniReport(manifest(), { config: { targetRepo: NEW, workflowRepo: NEW }, routers: [], monitor: [], issueAgent: [{ file: 'runtime-primary.json', allow: [NEW] }] });
  assert.equal(toExitCode(done), 0);
});

test('命令清单:只抄审查机变量,MODE 先 dry-run;转移改镜像地址,新建仓归档旧状态;装实例带 --workflow-repo', () => {
  const oldVariables = { MIVO_REVIEW_MODE: 'live', MIVO_REVIEW_RUNNER_LABEL: 'old-label', MIVO_REVIEW_WATCHDOG_ISSUE: '976',
    MIVO_PREREVIEW_HEARTBEAT: 'x', MIVO_AUTOMERGE_MODE: 'on', PRAISEREVIEW_APP_ID: '1234567' };
  const transfer = toCutoverPlan({ manifest: manifest(), oldVariables, skillSha: 'c'.repeat(40), date: '20261201' });
  assert.match(transfer, /^gh variable set MIVO_REVIEW_MODE -R acme\/mivo-next --body 'dry-run'/m);
  assert.match(transfer, /^gh variable set MIVO_REVIEW_RUNNER_LABEL -R acme\/mivo-next --body 'mivo-review'$/m);
  assert.match(transfer, /^gh variable set PRAISEREVIEW_APP_ID -R acme\/mivo-next --body '1234567'$/m);
  assert.doesNotMatch(transfer, /gh variable set MIVO_PREREVIEW_HEARTBEAT/);
  assert.doesNotMatch(transfer, /gh variable set MIVO_AUTOMERGE_MODE/);
  assert.match(transfer, /旧仓另有 1 个不属于审查机的变量,本清单不迁.*MIVO_AUTOMERGE_MODE/);
  assert.match(transfer, /git -C ~\/mivo-prereview\/repos\/mivo remote set-url origin https:\/\/github\.com\/acme\/mivo-next\.git/);
  assert.doesNotMatch(transfer, /mv ~\/mivo-prereview\/state\/mivo/);
  assert.match(transfer, new RegExp(`install-mini\\.sh --sha ${'c'.repeat(40)} --instance mivo --target-repo acme/mivo-next --workflow-repo acme/mivo-next --mode dry-run --workflow-ref main`));
  const fresh = toCutoverPlan({ manifest: manifest({ kind: 'fresh' }), oldVariables, skillSha: null, date: '20261201' });
  assert.match(fresh, /^mv ~\/mivo-prereview\/state\/mivo ~\/mivo-prereview\/state\/mivo\.xindong__mivo-canvas-plugin-20261201$/m);
  assert.match(fresh, /MIVO_REVIEW_WATCHDOG_ISSUE .* # 新建仓:先在新仓开看门狗 issue/);
  assert.match(fresh, /gh label clone xindong\/mivo-canvas-plugin -R acme\/mivo-next/);
  assert.match(fresh, /--sha <线上 MIVO_REVIEW_SKILL_SHA>/);
  // 值里有单引号也能原样粘进 shell
  assert.match(toCutoverPlan({ manifest: manifest(), oldVariables: { MIVO_REVIEW_X: "it's" } }), /--body 'it'\\''s'/);
});

// ── 命令行 ───────────────────────────────────────────────────────────────

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\\n');
const a = args.join(' ');
if (args[0] !== 'api' || args.includes('-X') || args.includes('--method')) { process.stderr.write('只读替身:拒绝 ' + a); process.exit(1); }
const hit = Object.keys(s).find((prefix) => args[1].startsWith(prefix));
if (!hit) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
process.stdout.write(s[hit]);
`;

function gitTree(root, name, files, scripts) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  git('init', '-q');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'x\n');
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
  git('add', '-A');
  git('commit', '-q', '-m', 'tree');
  return dir;
}

function setupCli(t, { scenario = {}, manifestText } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-cutover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(scenario));
  const manifestFile = path.join(root, 'cutover.json');
  fs.writeFileSync(manifestFile, manifestText ?? JSON.stringify({ version: 1, oldRepo: OLD, newRepo: NEW, kind: 'fresh' }));
  const env = { ...process.env, HOME: path.join(root, 'home'), PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_SCENARIO: path.join(root, 'scenario.json'), FAKE_GH_LOG: path.join(root, 'gh.log') };
  const run = (...args) => spawnSync(process.execPath, [CLI, '--manifest', manifestFile, ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const ghCalls = () => (fs.existsSync(env.FAKE_GH_LOG) ? fs.readFileSync(env.FAKE_GH_LOG, 'utf8').trim().split('\n') : []);
  return { root, run, ghCalls };
}

test('命令行 --drift:新仓把存储契约文件搬了目录,报漂移退出 1,并写出旧仓命中数;只读本地 git,不调 gh', (t) => {
  const f = setupCli(t);
  const base = ['shared/persist-contract.ts', 'src/a.ts', ...REQUIRED_FILES.map((r) => r.path), 'docs/product-rules/README.md'];
  const scripts = { 'test:unit': 'x' };
  const oldDir = gitTree(f.root, 'old', base, scripts);
  const newDir = gitTree(f.root, 'new', base.map((p) => (p === 'shared/persist-contract.ts' ? 'packages/shared/persist-contract.ts' : p)), scripts);
  const r = f.run('--drift', '--old-git', oldDir, '--old-ref', 'HEAD', '--new-git', newDir, '--new-ref', 'HEAD');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /✗ 漂移:regex \^shared\/persist-contract\\\.ts\$\(旧仓 1 个文件 → 新仓 0 个\) ← pr-rules\.json redlinePaths/);
  assert.match(r.stdout, /结论:有缺项或漂移/);
  assert.deepEqual(f.ghCalls(), []);
  // 同一棵树当新旧两边:没有漂移
  const same = f.run('--drift', '--old-git', oldDir, '--old-ref', 'HEAD', '--new-git', oldDir, '--new-ref', 'HEAD', '--json');
  const report = JSON.parse(same.stdout);
  assert.equal(report.items.filter((i) => i.status === 'drift').length, 0);
});

test('命令行 --preview:新仓还不存在时报缺退出 1;全程只发 GET,不写任何东西', (t) => {
  const f = setupCli(t, { scenario: { [`repos/${OLD}/actions/variables`]: '["MIVO_REVIEW_MODE","live"]\n' } });
  const dir = gitTree(f.root, 'tree', ['src/a.ts'], {});
  const r = f.run('--preview', '--old-git', dir, '--old-ref', 'HEAD', '--new-git', dir, '--new-ref', 'HEAD');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /✗ 缺:仓 acme\/mivo-next — 读不到:gh: Not Found \(HTTP 404\)/);
  assert.match(r.stdout, /本机没有 ~\/mivo-prereview,跳过/);
  const calls = f.ghCalls();
  assert.ok(calls.length > 0);
  for (const call of calls) assert.ok(call.startsWith('api ') && !/ (-X|--method) /.test(call), call);
});

test('命令行 --preview:Mini 实例配置存在但 JSON 坏了或顶层不是对象,记查不了,不说「没有这个文件」', (t) => {
  const f = setupCli(t);
  const dir = gitTree(f.root, 'tree', ['src/a.ts'], {});
  const configFile = path.join(f.root, 'home', 'mivo-prereview', 'config', 'mivo.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const configItem = () => {
    const r = f.run('--preview', '--json', '--old-git', dir, '--old-ref', 'HEAD', '--new-git', dir, '--new-ref', 'HEAD');
    return JSON.parse(r.stdout).items.find((i) => i.item === '实例配置 config/mivo.json') ?? assert.fail(`没有实例配置这一项:${r.stdout.slice(0, 300)}`);
  };
  fs.writeFileSync(configFile, '{oops');
  const corrupt = configItem();
  assert.equal(corrupt.status, 'unknown');
  assert.match(corrupt.detail, /^查不了:/);
  fs.writeFileSync(configFile, '[]');
  assert.deepEqual(Object.values((({ status, detail }) => ({ status, detail }))(configItem())), ['unknown', '查不了:顶层应是 JSON 对象,实际 array']);
  fs.writeFileSync(configFile, JSON.stringify({ targetRepo: OLD, workflowRepo: OLD, mode: 'live' }));
  assert.equal(configItem().status, 'info');
  fs.rmSync(configFile);
  assert.deepEqual([configItem().status, configItem().detail], ['missing', '没有这个文件']);
});

test('命令行:参数或清单不对退出 3,一次 gh 都不调;--plan 读旧仓变量拼清单', (t) => {
  const f = setupCli(t, { scenario: { [`repos/${OLD}/actions/variables`]: '["MIVO_REVIEW_SKILL_SHA","' + 'd'.repeat(40) + '"]\n' } });
  assert.equal(f.run('--preview', '--plan').status, 3);
  assert.equal(f.run('--prevew').status, 3);
  assert.equal(f.run().status, 3);
  assert.deepEqual(f.ghCalls(), []);
  const bad = setupCli(t, { manifestText: '{"version":1,"oldRepo":"x","newRepo":"y/z","kind":"fresh"}' });
  const b = bad.run('--preview');
  assert.equal(b.status, 3);
  assert.match(b.stderr, /oldRepo 须是 owner\/name,实际 "x"/);
  assert.deepEqual(bad.ghCalls(), []);
  const plan = f.run('--plan');
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, new RegExp(`install-mini\\.sh --sha ${'d'.repeat(40)} --instance mivo --target-repo acme/mivo-next`));
});
