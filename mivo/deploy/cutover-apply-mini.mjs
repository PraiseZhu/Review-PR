import { randomUUID, createSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { localPath } from './cutover-apply.mjs';
import { toJsonEditor } from './cutover-apply-json.mjs';
import { request } from './cutover-apply-github.mjs';
import { toStep } from './cutover-lib.mjs';
import { MINI_CONFIG_REL, SKILL_ROOT } from '../lib/common.mjs';

const root = 'mivo-prereview';
const project = 'AI-Agent/Claude/projects/Project Mivo Canvas-Plugin';
const mirror = root + '/repos/mivo';
const state = root + '/state/mivo';
const skill = root + '/skill';
const routers = ['praisebuild', 'praisetriage', 'praisewatch'];
const productRules = 'Library/Application Support/Cindy/owners/df571e02df2913aaa537/bots/bot_1793900094540_m0fggd/workspace/product-rules-check';
const independentOps = project + '/_ops/mivo-canvas-plugin';
const issueAgentCode = project + '/_ops/issue-agent-code/xindong__mivo-canvas-plugin';
const shaRE = /^[0-9a-f]{40}$/;
const appIdRE = /^\d+$/;
const fileDigest = (file) => fs.readFileSync(file, 'utf8');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  if (result.status !== 0) throw new Error(command + ' 失败（' + (result.error?.code ?? '退出 ' + result.status) + '）');
  return result.stdout.trim();
}

const git = (directory, ...args) => run('git', ['--no-optional-locks', '-C', directory, ...args]);

function findRepo(home, relative) {
  const directory = localPath(home, relative);
  if (git(directory, 'rev-parse', '--show-toplevel') !== directory) return null;
  const dotGit = localPath(home, relative + '/.git');
  if (!fs.statSync(dotGit).isDirectory() || git(directory, 'rev-parse', '--absolute-git-dir') !== dotGit) {
    throw new Error(relative + ' 不是独立 checkout；不改父级或共享 origin');
  }
  localPath(home, relative + '/.git/config');
  return directory;
}

function ensureRepo(home, relative) {
  const directory = findRepo(home, relative);
  if (!directory) throw new Error(relative + ' 指向父检出，没有自己的 origin');
  return directory;
}

function toInstallationId(home, config, newRepo, label) {
  const { appId, keyPath } = config;
  if (!appIdRE.test(String(appId)) || typeof keyPath !== 'string' || !keyPath) throw new Error(label + ' 缺少 App ID 或私钥路径');
  const relative = path.isAbsolute(keyPath) ? path.relative(home, keyPath) : keyPath.replace(/^(?:~|\$HOME)\//, '');
  let jwt;
  try {
    const keyFile = localPath(home, relative);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const input = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iat: now - 60, exp: now + 480, iss: String(appId) });
    const signature = createSign('RSA-SHA256').update(input).sign(fs.readFileSync(keyFile), 'base64url');
    jwt = input + '.' + signature;
  } catch {
    throw new Error(label + ' 无法以本 App 的凭据签名，未读取其他 App 的 installationId');
  }
  try {
    const installation = request({ method: 'GET', endpoint: 'repos/' + newRepo + '/installation' },
      { env: { ...process.env, GH_TOKEN: jwt } });
    if (!Number.isSafeInteger(installation?.id) || installation.id < 1) throw new Error('返回的 id 无效');
    return installation.id;
  } catch (error) {
    throw new Error(label + ' App installationId 查不到：' + error.message);
  }
}

function atomicWrite(file, contents, mode) {
  const temporary = file + '.cutover-' + randomUUID();
  fs.writeFileSync(temporary, contents, { mode, flag: 'wx' });
  try { fs.renameSync(temporary, file); } catch (error) {
    fs.unlinkSync(temporary);
    throw error;
  }
}

function toInstallerArgs({ sha, target, workflowRepo, mode, ref, substitute }) {
  return ['--sha', sha, '--instance', 'mivo', '--target-repo', target, '--workflow-repo', workflowRepo,
    '--mode', mode, '--workflow-ref', ref, ...(substitute ? ['--no-load'] : [])];
}

function scriptStep(file, previous, next, oldRepo, newRepo) {
  return toStep('文件', file, oldRepo, newRepo, previous === next ? null : { type: 'file', file, previous, next });
}

function toQaRoutes(script, oldRepo, newRepo, installationId) {
  const newline = script.includes('\r\n') ? '\r\n' : '\n';
  const lines = script.split(newline);
  const start = lines.indexOf('pqa_installation() {');
  const caseStart = start + 1;
  const caseEnd = lines.findIndex((line, index) => index > caseStart && line.trim() === 'esac');
  const body = lines.slice(caseStart + 1, caseEnd);
  const oldRoutes = body.filter((line) => line.trimStart().startsWith(oldRepo + ')'));
  const newRoutes = body.filter((line) => line.trimStart().startsWith(newRepo + ')'));
  const oldMatch = /^([ \t]*)\S+\) echo (\d+) ;;$/.exec(oldRoutes[0] ?? '');
  const header = lines.findIndex((line) => line.startsWith('# Installations: '));
  const oldMapping = oldRepo + ' -> ' + oldMatch?.[2];
  if (start < 0 || lines[caseStart]?.trim() !== 'case "$1" in' || caseEnd < 0 ||
      oldRoutes.length !== 1 || !oldMatch || newRoutes.length > 1 || header < 0 ||
      !lines[header].includes(oldMapping)) throw new Error('praise-qa-gh.sh 安装路由或映射说明格式不符，不修改');
  const newMapping = newRepo + ' -> ' + installationId;
  if (newRoutes.length) {
    const route = newRoutes[0];
    const match = /^([ \t]*)\S+\) echo (\d+) ;;$/.exec(route);
    if (!match) throw new Error('praise-qa-gh.sh 新仓安装路由格式不符，不修改');
    const priorMapping = newRepo + ' -> ' + match[2];
    if (!lines[header].includes(priorMapping)) throw new Error('praise-qa-gh.sh 新仓映射说明和 case 不一致，不修改');
    lines[header] = lines[header].replace(priorMapping, newMapping);
    lines[caseStart + 1 + body.indexOf(route)] = match[1] + newRepo + ') echo ' + installationId + ' ;;';
  } else {
    if (lines[header].includes(newRepo + ' -> ')) throw new Error('praise-qa-gh.sh 新仓映射说明和 case 不一致，不修改');
    lines[header] = lines[header].replace(oldMapping, oldMapping + ', ' + newMapping);
    lines.splice(caseStart + 1, 0, oldMatch[1] + newRepo + ') echo ' + installationId + ' ;;');
  }
  return lines.join(newline);
}

export function readMiniState(manifest, { home, installer, isolated }) {
  const { oldRepo, newRepo, kind, defaultBranch, oldBranch, transferOrigins, rehearsalInstallationIds } = manifest;
  if (rehearsalInstallationIds && !isolated) throw new Error('真实 HOME 不允许使用演练 App ID');
  const steps = [];
  const configFile = localPath(home, MINI_CONFIG_REL);
  const config = JSON.parse(fileDigest(configFile));
  const pendingInstall = config.targetRepo !== newRepo || config.workflowRepo !== newRepo || config.mode !== 'dry-run' ||
    config.workflowRef !== defaultBranch;
  if (pendingInstall && (config.targetRepo !== oldRepo || config.workflowRepo !== oldRepo)) {
    throw new Error(MINI_CONFIG_REL + ' 未指向旧仓，或处于未经核对的中间状态');
  }
  if (pendingInstall && !['live', 'dry-run'].includes(config.mode)) throw new Error(MINI_CONFIG_REL + ' 的原模式无法安全重装');
  if (pendingInstall && config.workflowRef !== oldBranch) throw new Error(MINI_CONFIG_REL + ' 的旧 workflowRef 与清单不同');
  const liveSkill = ensureRepo(home, skill);
  const sha = git(liveSkill, 'rev-parse', 'HEAD');
  if (!shaRE.test(sha) || git(liveSkill, 'status', '--porcelain')) throw new Error('线上 skill SHA 不合法或工作树不干净');

  const jsonFile = (file, edit, note) => {
    const previous = fileDigest(localPath(home, file));
    const json = toJsonEditor(previous);
    edit(json, JSON.parse(previous));
    steps.push({ ...scriptStep(file, previous, json.finish(), oldRepo, newRepo), note });
  };

  for (const label of routers) {
    jsonFile('mivo-gh-router/' + label + '/config.json', (json, router) => {
      if (!Number.isSafeInteger(router.installationId) || router.installationId < 1) throw new Error(label + ' 原 installationId 无效');
      json.array(['repos'], oldRepo, newRepo, { retain: true });
      const newId = rehearsalInstallationIds ? rehearsalInstallationIds[label] : toInstallationId(home, router, newRepo, label);
      json.field(['installationId'], router.installationId, newId);
    }, rehearsalInstallationIds ? 'installationId：替身，未实测' : undefined);
  }

  const qaFile = root + '/praise-qa-gh.sh';
  const qa = fileDigest(localPath(home, qaFile));
  const appId = /^PQA_APP_ID="\$\{PRAISE_QA_APP_ID:-(\d+)\}"\r?$/m.exec(qa)?.[1];
  const keyPath = /^PQA_KEY="\$\{PRAISE_QA_KEY:-([^}]+)\}"\r?$/m.exec(qa)?.[1];
  const qaId = rehearsalInstallationIds ? rehearsalInstallationIds['praise-qa'] :
    toInstallationId(home, { appId, keyPath }, newRepo, 'Praise QA');
  const newQa = toQaRoutes(qa, oldRepo, newRepo, qaId);
  steps.push({ ...scriptStep(qaFile, qa, newQa, oldRepo, newRepo),
    note: rehearsalInstallationIds ? 'installationId：替身，未实测' : undefined });

  const checks = root + '/monitor/scripts/schedule-checks';
  const [oldOwner, oldName] = oldRepo.split('/');
  const [newOwner, newName] = newRepo.split('/');
  const spell = (owner, name) => 'owner:"' + owner + '",name:"' + name + '"';
  let monitorFound = false;
  for (const entry of fs.readdirSync(localPath(home, checks)).filter((name) => name.endsWith('.mjs')).sort()) {
    const file = checks + '/' + entry;
    const previous = fileDigest(localPath(home, file));
    const next = previous.replaceAll(oldRepo, newRepo).replaceAll(spell(oldOwner, oldName), spell(newOwner, newName));
    if (previous !== next || previous.includes(newRepo) || previous.includes(spell(newOwner, newName))) {
      monitorFound = true;
      steps.push(scriptStep(file, previous, next, oldRepo, newRepo));
    }
  }
  if (!monitorFound) throw new Error(checks + ' 找不到切换目标');

  for (const name of ['runtime-primary', 'runtime-fallback']) {
    jsonFile(project + '/history/loops/issue-agent/' + name + '.json', (json) => {
      json.array(['repoAllowlist'], oldRepo, newRepo);
      json.key(['codeRepoMap'], oldRepo, newRepo);
    });
  }
  jsonFile(project + '/_ops/lifeline-v3/config.json', (json) => json.field(['repo'], oldRepo, newRepo));
  jsonFile(project + '/_ops/mivo-watcher/config/profile.json', (json) => json.field(['targetRepo'], oldRepo, newRepo));
  jsonFile('praise-merge-runtime/config/policy.json', (json) => json.key(['repos'], oldRepo, newRepo));
  jsonFile('.config/pr-steward/profile.json', (json) => {
    json.array(['repos'], oldRepo, newRepo);
    json.key(['policies'], oldRepo, newRepo);
  });

  const changeOrigins = kind === 'fresh' || transferOrigins;
  const repos = changeOrigins ? [independentOps, productRules, issueAgentCode] : [];
  const nextUrl = 'https://github.com/' + newRepo + '.git';
  const origins = ['mivo-watcher', 'lifeline-v3', 'issue-agent-live'].map((name) =>
    toStep('origin', project + '/_ops/' + name, null, null, null, null, '主检出里被 /_ops/ 忽略的子目录，无独立 origin，随主检出生效'));
  origins.push(toStep('origin', project + '/_tmp/mivo-canvas-plugin-ro', null, null, null, null, '临时只读副本，无线上引用'));
  origins.push(toStep('origin', 'Cindy dialogues/*', null, null, null, null, '会话临时副本，不在变更清单'));
  if (isolated) origins.push(toStep('origin', project, null, null, null, null, '主检出仅生产执行，隔离演练跳过'));
  else if (changeOrigins) repos.unshift(project);
  for (const relative of repos) {
    const directory = findRepo(home, relative);
    if (!directory) {
      origins.push(toStep('origin', relative, null, null, null, null, '解析到父检出，无独立 origin'));
      continue;
    }
    const origin = git(directory, 'config', '--local', '--get-all', 'remote.origin.url');
    const originRepo = origin.replace(/^(https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '');
    if (![oldRepo, newRepo].includes(originRepo)) throw new Error(relative + ' 的 origin 不是新仓或旧仓');
    const dirty = Boolean(git(directory, 'status', '--porcelain'));
    const skip = dirty || originRepo === newRepo;
    origins.push(toStep('origin', relative, origin, nextUrl, skip ? null : { type: 'origin', repo: relative, origin, nextUrl },
      null, dirty ? '工作树有未提交改动，跳过' : undefined));
  }
  const mirrorDir = ensureRepo(home, mirror);
  const expectedMirror = pendingInstall ? oldRepo : newRepo;
  const mirrorOrigin = verifyOrigin(mirrorDir, expectedMirror);
  if (pendingInstall) ensureCleanMirror(mirrorDir);
  const mirrorChange = kind === 'transfer' && pendingInstall
    ? { type: 'origin', repo: mirror, origin: mirrorOrigin, nextUrl } : null;
  origins.push(toStep('origin', mirror, mirrorOrigin, nextUrl, mirrorChange, null,
    kind === 'fresh' ? '镜像由安装脚本管理，执行段只核对' : undefined));
  if (kind === 'fresh' && pendingInstall) {
    const suffix = '.' + oldRepo.replace('/', '__') + '-' + new Date().toISOString().slice(0, 10).replaceAll('-', '');
    for (const from of [state, mirror]) {
      localPath(home, from);
      const to = from + suffix;
      if (fs.existsSync(localPath(home, to, { missing: true }))) throw new Error('已有归档：' + to);
      steps.push(toStep('归档', from, from, to, { type: 'archive', from, to }, { type: 'archive', from, to }));
    }
  }
  const substitute = Boolean(installer);
  const after = { target: newRepo, workflowRepo: newRepo, mode: 'dry-run', ref: defaultBranch };
  const before = { target: config.targetRepo, workflowRepo: config.workflowRepo, mode: config.mode, ref: config.workflowRef };
  steps.push(toStep('安装实例', MINI_CONFIG_REL, before, after,
    pendingInstall ? { type: 'installer', sha, ...after, substitute } : null,
    { type: 'installer', sha, ...before, substitute }));
  return [...origins, ...steps];
}

function verifyOrigin(directory, expected) {
  const origin = git(directory, 'config', '--local', '--get-all', 'remote.origin.url');
  const actual = origin.replace(/^(https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '');
  if (actual !== expected) throw new Error(directory + ' 的 origin 不符；期望 ' + expected);
  return origin;
}

function ensureCleanMirror(directory) {
  if (git(directory, 'status', '--porcelain')) throw new Error(mirror + ' 有未提交改动，不能继续切换或重装实例');
}

export function checkMiniRollback(record, home) {
  const affectsMirror = (undo) => undo?.type === 'installer' || undo?.file === mirror + '/.git/config';
  if (record.manifest.kind === 'transfer' &&
      (affectsMirror(record.pending?.undo) || record.completed.some(({ undo }) => affectsMirror(undo)))) {
    ensureCleanMirror(ensureRepo(home, mirror));
  }
}

export function prepareMiniStep(step, home, directory, index) {
  const op = step.operation;
  if (op.type === 'file' || op.type === 'origin' || op.type === 'installer') {
    const file = op.type === 'file' ? op.file : op.type === 'origin' ? op.repo + '/.git/config' : MINI_CONFIG_REL;
    const source = localPath(home, file);
    if (op.type === 'file' && fileDigest(source) !== op.previous) throw new Error(file + ' 在预检之后被改动');
    const backup = 'file-' + index;
    fs.writeFileSync(path.join(directory, backup), fs.readFileSync(source), { flag: 'wx', mode: 0o600 });
    return op.type === 'installer' ? step.undo : { type: 'file', file, backup, mode: fs.statSync(source).mode & 0o777,
      ...(op.type === 'origin' ? { oldOrigin: op.origin } : {}) };
  }
  return step.undo;
}

export function executeMini(op, { home, installer }) {
  if (op.type === 'file') {
    const file = localPath(home, op.file);
    atomicWrite(file, op.next, fs.statSync(file).mode & 0o777);
  } else if (op.type === 'origin') {
    const directory = ensureRepo(home, op.repo);
    if (git(directory, 'status', '--porcelain')) throw new Error(op.repo + ' 在预检后产生了未提交改动');
    if (git(directory, 'config', '--local', '--get-all', 'remote.origin.url') !== op.origin) {
      throw new Error(op.repo + ' 的 origin 在预检后有变化');
    }
    git(directory, 'remote', 'set-url', 'origin', op.nextUrl);
  } else if (op.type === 'archive') {
    const to = localPath(home, op.to, { missing: true });
    if (fs.existsSync(to)) throw new Error('归档路径已存在：' + op.to);
    fs.renameSync(localPath(home, op.from), to);
  } else if (op.type === 'installer') {
    if (Boolean(installer) !== op.substitute) throw new Error('必须沿用相同的真实/替身安装模式');
    if (!shaRE.test(op.sha)) throw new Error('安装 SHA 非法');
    const script = installer ?? path.join(SKILL_ROOT, 'mivo/prereview/install-mini.sh');
    run('bash', [script, ...toInstallerArgs(op)], { env: { ...process.env, HOME: home } });
    const config = JSON.parse(fileDigest(localPath(home, MINI_CONFIG_REL)));
    if (config.targetRepo !== op.target || config.workflowRepo !== op.workflowRepo ||
        config.mode !== op.mode || config.workflowRef !== op.ref) throw new Error('安装后配置的仓名、分支或模式不匹配');
    verifyOrigin(ensureRepo(home, mirror), op.target);
  } else throw new Error('未知 Mini 执行步骤');
}

export function undoMini(op, directory, options) {
  const { home } = options;
  if (op.type === 'file') {
    atomicWrite(localPath(home, op.file), fs.readFileSync(localPath(directory, op.backup)), op.mode);
  } else if (op.type === 'archive') {
    const original = localPath(home, op.from, { missing: true });
    const archived = localPath(home, op.to, { missing: true });
    if (!fs.existsSync(archived) && fs.existsSync(original)) return;
    if (fs.existsSync(original)) {
      const retained = path.join(directory, 'kept-new-' + op.from.replaceAll('/', '_'));
      if (fs.existsSync(retained)) throw new Error('回滚保留目录已存在：' + retained);
      fs.renameSync(original, retained);
    }
    fs.renameSync(archived, original);
  } else if (op.type === 'installer') {
    verifyOrigin(ensureRepo(home, mirror), op.target);
    executeMini(op, options);
  } else throw new Error('未知 Mini 回滚步骤');
}
