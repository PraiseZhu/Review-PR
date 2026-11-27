import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cutover.mjs', import.meta.url));
const project = 'AI-Agent/Claude/projects/Project Mivo Canvas-Plugin';
const config = 'mivo-prereview/config/mivo.json';
const mirror = 'mivo-prereview/repos/mivo';
const state = 'mivo-prereview/state/mivo';
const oldRepo = 'owner/old';
const newRepo = 'owner/new';
const standalone = project + '/_ops/mivo-canvas-plugin';
const issueAgentCode = project + '/_ops/issue-agent-code/xindong__mivo-canvas-plugin';
const unrelatedCode = project + '/_ops/issue-agent-code/xindong__mivo-canvas';
const productRulesRepo = 'Library/Application Support/Cindy/owners/df571e02df2913aaa537/bots/bot_1793900094540_m0fggd/workspace/product-rules-check';
const rehearsalIds = { praisebuild: 701, praisetriage: 702, praisewatch: 703, 'praise-qa': 704 };
const untouched = '.config/unrelated.json';
const appDirs = ['praisebuild', 'praisetriage', 'praisewatch'].map((name) => 'mivo-gh-router/' + name + '/config.json');
const issueRuntimes = ['runtime-primary', 'runtime-fallback'].map((name) => project + '/history/loops/issue-agent/' + name + '.json');
const monitor = 'mivo-prereview/monitor/scripts/schedule-checks/mivo.mjs';
const qa = 'mivo-prereview/praise-qa-gh.sh';
const life = project + '/_ops/lifeline-v3/config.json';
const watch = project + '/_ops/mivo-watcher/config/profile.json';
const policy = 'praise-merge-runtime/config/policy.json';
const steward = '.config/pr-steward/profile.json';
const qaOriginal = [
  '# Installations: owner/old -> 123, owner/* -> 888; other repos -> the gh login.',
  'PQA_APP_ID="${PRAISE_QA_APP_ID:-104}"',
  'PQA_KEY="${PRAISE_QA_KEY:-$HOME/.config/test-apps/104.pem}"',
  'pqa_installation() {',
  '  case "$1" in',
  '    owner/old) echo 123 ;;',
  '    owner/?*) echo 888 ;;',
  '  esac',
  '}',
  '',
].join('\n');

function fakeGh() {
  const [command, flag, method, address] = process.argv.slice(2);
  if (command !== 'api' || flag !== '--method' || method !== 'GET') process.exit(9);
  const endpoint = address.split('?')[0];
  const relative = endpoint.split('/').slice(3).join('/');
  if (relative === 'installation') {
    const fs = require('node:fs');
    const { createVerify } = require('node:crypto');
    const [header, payload, signature] = process.env.GH_TOKEN.split('.');
    const { iss } = JSON.parse(Buffer.from(payload, 'base64url'));
    const keys = JSON.parse(fs.readFileSync(process.env.CUTOVER_TEST_KEYS, 'utf8'));
    if (!keys[iss] || !createVerify('RSA-SHA256').update(header + '.' + payload).verify(keys[iss], signature, 'base64url')) process.exit(8);
    fs.appendFileSync(process.env.CUTOVER_TEST_READS, iss + '\n');
    if (iss === process.env.CUTOVER_TEST_FAIL_APP) {
      console.error('gh: App not installed (HTTP 404)');
      process.exit(1);
    }
    console.log(JSON.stringify({ id: 10000 + Number(iss) }));
    return;
  }
  let res;
  if (relative === '') res = { full_name: 'owner/new', private: true, default_branch: 'main', archived: false };
  if (relative === 'actions/variables') res = { variables: [
    { name: 'MIVO_REVIEW_MODE', value: 'dry-run' }, { name: 'MIVO_REVIEW_RUNNER_LABEL', value: 'mivo-review' },
  ] };
  if (relative === 'actions/secrets') res = { secrets: ['LITELLM_CREDENTIALS_JSON', 'PRAISEBUILD_PRIVATE_KEY', 'PRAISEREVIEW_PRIVATE_KEY'].map((name) => ({ name })) };
  if (relative === 'environments') res = { environments: [{ name: 'slack-inbound' }] };
  if (relative === 'environments/slack-inbound') res = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  if (relative === 'environments/slack-inbound/secrets') res = { secrets: [{ name: 'MIVO_SLACK_BOT_TOKEN' }] };
  if (relative === 'environments/slack-inbound/deployment-branch-policies') res = { branch_policies: [{ id: 1, name: 'main', type: 'branch' }] };
  if (relative === 'labels' || relative === 'rulesets') res = [];
  if (res === undefined) process.exit(8);
  console.log(JSON.stringify(process.argv.includes('--slurp') ? [res] : res));
}

function fakeInstaller() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const args = process.argv.slice(2);
  const get = (flag) => args[args.indexOf(flag) + 1];
  fs.appendFileSync(process.env.TEST_INSTALL_LOG, JSON.stringify(args) + '\n');
  if (!args.includes('--no-load')) process.exit(3);
  const root = path.join(process.env.HOME, 'mivo-prereview');
  const file = path.join(root, 'config/mivo.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (get('--target-repo') === 'owner/old' &&
      !fs.existsSync(path.join(root, 'state/mivo/sentinel'))) process.exit(4);
  const mirror = path.join(root, 'repos/mivo');
  if (!fs.existsSync(mirror)) {
    fs.mkdirSync(mirror, { recursive: true });
    execFileSync('git', ['-C', mirror, 'init', '-q']);
    execFileSync('git', ['-C', mirror, 'remote', 'add', 'origin', 'https://github.com/owner/new.git']);
  }
  const origin = execFileSync('git', ['-C', mirror, 'config', '--local', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
  if (origin.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') !== get('--target-repo')) process.exit(5);
  const next = { ...old, targetRepo: get('--target-repo'), workflowRepo: get('--workflow-repo'),
    mode: get('--mode'), workflowRef: get('--workflow-ref') };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
}

function fixture(t, { kind = 'fresh' } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-mini-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const home = fs.realpathSync(rootDir) + '/home';
  const bin = rootDir + '/bin';
  fs.mkdirSync(bin);
  const gh = bin + '/gh';
  fs.writeFileSync(gh, '#!' + process.execPath + '\n(' + fakeGh.toString() + ')();\n', { mode: 0o755 });
  const installer = rootDir + '/installer.sh';
  const installerCode = rootDir + '/installer.cjs';
  fs.writeFileSync(installerCode, '(' + fakeInstaller.toString() + ')();\n');
  fs.writeFileSync(installer, 'exec "' + process.execPath + '" "' + installerCode + '" "$@"\n');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_INSTALL_LOG: rootDir + '/install.log',
    CUTOVER_TEST_KEYS: rootDir + '/keys.json', CUTOVER_TEST_READS: rootDir + '/app-reads' };
  const manifest = rootDir + '/manifest.json';
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, oldRepo, newRepo, kind, rehearsal: true,
    rehearsalInstallationIds: rehearsalIds }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  const invoke = (...args) => run('--home', home, '--install-mini', installer, ...args);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(home + '/' + file), { recursive: true });
    fs.writeFileSync(home + '/' + file, text);
  };
  const read = (file) => fs.readFileSync(home + '/' + file, 'utf8');
  const git = (directory, ...args) => {
    const result = spawnSync('git', ['-C', home + '/' + directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  write(config, '{"targetRepo":"owner/old","workflowRepo":"owner/old","workflowRef":"main","mode":"live","unrelated":true}\n');
  for (const app of appDirs) write(app, '{\r\n  "repos": [\r\n    "other/repo",\r\n    "owner/old"\r\n  ],\r\n  "installationId": 81,\r\n  "keep": "owner/old"\r\n}\r\n');
  for (const runtime of issueRuntimes) write(runtime, '{"repoAllowlist":["owner/old","other/repo"],"codeRepoMap":{"owner/old":{"path":"/work/owner__old"}},"keep":"owner/old"}\n');
  write(qa, qaOriginal);
  write(monitor, 'const REPO = "owner/old";\nconst query = \'repository(owner:"owner",name:"old")\';\n');
  write(life, '{ "repo"   : "owner/old", "reason": "owner/old" }\n');
  write(watch, '{ "targetRepo" : "owner/old" }\n');
  write(policy, '{ "repos": { "owner/old": { "skip": false } }, "notes": "owner/old" }\n');
  write(steward, '{"repos":["owner/old"],"policies":{"owner/old":1},"notes":"owner/old"}\n');
  write(untouched, '{"untouched":"owner/old"}\n');
  write(state + '/sentinel', 'old state bytes\n');
  for (const directory of [standalone, mirror, productRulesRepo, issueAgentCode, unrelatedCode, 'mivo-prereview/skill', project]) {
    write(directory + '/tracked', 'original\n');
    git(directory, 'init', '-q');
    git(directory, 'add', '-A');
    git(directory, 'commit', '-qm', 'fixture');
    git(directory, 'remote', 'add', 'origin', directory === unrelatedCode ? 'https://github.com/xindong/mivo-canvas.git' : 'https://github.com/owner/old.git');
  }
  write(productRulesRepo + '/tracked', 'local work\n');
  return { write, read, invoke, home, manifest, run, env, apply: (...args) => invoke('--manifest', manifest, '--apply', 'mini', ...args),
    installs: () => fs.readFileSync(env.TEST_INSTALL_LOG, 'utf8').trim().split('\n').map(JSON.parse) };
}

function tree(home) {
  const walk = (relative) => {
    const where = path.join(home, relative);
    return fs.readdirSync(where, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(relative, entry.name);
      if (child === 'mivo-prereview/cutover-backup' || child === config) return [];
      if (entry.isDirectory()) return walk(child);
      return [[child, fs.readFileSync(path.join(home, child)).toString('base64')]];
    });
  };
  return new Map(walk(''));
}

test('Mini 演示只读；fresh 限定字段、跳过脏树，回滚还原归档、origin 和配置', (t) => {
  const fixtureData = fixture(t);
  const before = tree(fixtureData.home);
  const original = fixtureData.read(config);
  const dryRun = fixtureData.apply();
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.deepEqual(tree(fixtureData.home), before);
  assert.equal(fixtureData.read(config), original);
  assert.equal(fs.existsSync(fixtureData.home + '/mivo-prereview/cutover-backup'), false);
  const live = fixtureData.apply('--yes');
  assert.equal(live.status, 0, live.stdout + live.stderr);
  assert.match(live.stdout, /lifeline-v3.*无独立 origin/);
  assert.match(live.stdout, /product-rules-check.*工作树有未提交改动，跳过/);
  assert.match(live.stdout, /主检出仅生产执行/);
  assert.match(live.stdout, /App installationId praisebuild.*替身，未实测/);
  assert.match(live.stdout, /App installationId praise-qa.*替身，未实测/);
  assert.match(live.stdout, /换仓只读预检/);
  for (const app of appDirs) assert.equal(fixtureData.read(app),
    '{\r\n  "repos": [\r\n    "other/repo",\r\n    "owner/old",\r\n    "owner/new"\r\n  ],\r\n  "installationId": ' +
    rehearsalIds[app.split('/')[1]] + ',\r\n  "keep": "owner/old"\r\n}\r\n');
  for (const runtime of issueRuntimes) assert.equal(fixtureData.read(runtime),
    '{"repoAllowlist":["owner/new","other/repo"],"codeRepoMap":{"owner/new":{"path":"/work/owner__old"}},"keep":"owner/old"}\n');
  assert.equal(fixtureData.read(qa), [
    '# Installations: owner/old -> 123, owner/new -> 704, owner/* -> 888; other repos -> the gh login.',
    'PQA_APP_ID="${PRAISE_QA_APP_ID:-104}"',
    'PQA_KEY="${PRAISE_QA_KEY:-$HOME/.config/test-apps/104.pem}"',
    'pqa_installation() {',
    '  case "$1" in',
    '    owner/new) echo 704 ;;',
    '    owner/old) echo 123 ;;',
    '    owner/?*) echo 888 ;;',
    '  esac',
    '}',
    '',
  ].join('\n'));
  assert.equal(fixtureData.read(monitor), 'const REPO = "owner/new";\nconst query = \'repository(owner:"owner",name:"new")\';\n');
  assert.equal(fixtureData.read(life), '{ "repo"   : "owner/new", "reason": "owner/old" }\n');
  assert.equal(fixtureData.read(watch), '{ "targetRepo" : "owner/new" }\n');
  assert.equal(fixtureData.read(policy), '{ "repos": { "owner/new": { "skip": false } }, "notes": "owner/old" }\n');
  assert.equal(fixtureData.read(steward), '{"repos":["owner/new"],"policies":{"owner/new":1},"notes":"owner/old"}\n');
  assert.equal(fixtureData.read(untouched), '{"untouched":"owner/old"}\n');
  assert.match(fixtureData.read(project + '/.git/config'), /owner\/old\.git/);
  assert.match(fixtureData.read(standalone + '/.git/config'), /owner\/new\.git/);
  assert.match(fixtureData.read(issueAgentCode + '/.git/config'), /owner\/new\.git/);
  assert.match(fixtureData.read(unrelatedCode + '/.git/config'), /xindong\/mivo-canvas\.git/);
  assert.match(fixtureData.read(productRulesRepo + '/.git/config'), /owner\/old\.git/);
  assert.match(fixtureData.read(mirror + '/.git/config'), /owner\/new\.git/);
  assert.equal(fs.existsSync(fixtureData.home + '/' + state), false);
  assert.equal(JSON.parse(fixtureData.read(config)).workflowRepo, newRepo);
  const rollback = fixtureData.invoke('--rollback', /^备份：(.+)$/m.exec(live.stdout)[1]);
  assert.equal(rollback.status, 0, rollback.stdout + rollback.stderr);
  assert.deepEqual(tree(fixtureData.home), before);
  assert.equal(JSON.parse(fixtureData.read(config)).workflowRepo, oldRepo);
  const installs = fixtureData.installs();
  assert.match(installs[0][1], /^[0-9a-f]{40}$/);
  assert.deepEqual(installs.map((args) => args.slice(2)), [
    ['--instance', 'mivo', '--target-repo', newRepo, '--workflow-repo', newRepo, '--mode', 'dry-run', '--workflow-ref', 'main', '--no-load'],
    ['--instance', 'mivo', '--target-repo', oldRepo, '--workflow-repo', oldRepo, '--mode', 'live', '--workflow-ref', 'main', '--no-load'],
  ]);
});

test('transfer 从旧镜像只读演示，安装前切 origin，回滚重装前逐字节还原', (t) => {
  const data = fixture(t, { kind: 'transfer' });
  const before = tree(data.home);
  const instance = data.read(config);
  const oldOrigin = 'https://github.com/owner/old.git';
  const originFile = mirror + '/.git/config';
  const preview = data.apply();
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /执行 origin mivo-prereview\/repos\/mivo："https:\/\/github.com\/owner\/old.git" → "https:\/\/github.com\/owner\/new.git"/);
  assert.deepEqual(tree(data.home), before);
  assert.equal(data.read(config), instance);
  assert.equal(fs.existsSync(data.env.TEST_INSTALL_LOG), false);
  assert.equal(fs.existsSync(data.home + '/mivo-prereview/cutover-backup'), false);

  const applied = data.apply('--yes');
  assert.equal(applied.status, 0, applied.stderr);
  const backup = /^备份：(.+)$/m.exec(applied.stdout)[1];
  const journal = JSON.parse(fs.readFileSync(path.join(backup, 'journal.json'), 'utf8'));
  assert.equal(journal.completed.find(({ undo }) => undo.file === originFile).undo.oldOrigin, oldOrigin);
  assert.match(data.read(originFile), /https:\/\/github.com\/owner\/new\.git/);
  assert.match(data.read(standalone + '/.git/config'), /owner\/old\.git/);
  assert.equal(data.read(state + '/sentinel'), 'old state bytes\n');
  assert.equal(JSON.parse(data.read(config)).targetRepo, newRepo);

  const rolledBack = data.invoke('--rollback', backup);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.deepEqual(tree(data.home), before);
  assert.equal(JSON.parse(data.read(config)).targetRepo, oldRepo);
  assert.equal(JSON.parse(data.read(config)).workflowRepo, oldRepo);
  assert.deepEqual(data.installs().map((args) => args.slice(2)), [
    ['--instance', 'mivo', '--target-repo', newRepo, '--workflow-repo', newRepo, '--mode', 'dry-run', '--workflow-ref', 'main', '--no-load'],
    ['--instance', 'mivo', '--target-repo', oldRepo, '--workflow-repo', oldRepo, '--mode', 'live', '--workflow-ref', 'main', '--no-load'],
  ]);
});

test('transfer 实例镜像有未提交改动时，在创建备份或调用安装器前停止', (t) => {
  const data = fixture(t, { kind: 'transfer' });
  data.write(mirror + '/tracked', 'local work\n');
  const before = tree(data.home);
  const result = data.apply('--yes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repos\/mivo 有未提交改动/);
  assert.equal(fs.existsSync(data.env.TEST_INSTALL_LOG), false);
  assert.equal(fs.existsSync(data.home + '/mivo-prereview/cutover-backup'), false);
  assert.deepEqual(tree(data.home), before);
});

test('生产不接受替身 installationId，即使清单标记 rehearsal', (t) => {
  const fixtureData = fixture(t);
  const rejected = fixtureData.run('--manifest', fixtureData.manifest, '--apply', 'mini', '--yes');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /真实 HOME 不允许使用演练 App ID/);
  const config = JSON.parse(fs.readFileSync(fixtureData.manifest, 'utf8'));
  config.rehearsal = false;
  fs.writeFileSync(fixtureData.manifest, JSON.stringify(config));
  const notRehearsal = fixtureData.apply('--yes');
  assert.equal(notRehearsal.status, 3);
  assert.match(notRehearsal.stderr, /rehearsalInstallationIds 仅允许用于 rehearsal/);
  config.rehearsal = true;
  config.rehearsalInstallationIds['praise-qa'] = config.rehearsalInstallationIds.praisebuild;
  fs.writeFileSync(fixtureData.manifest, JSON.stringify(config));
  assert.match(fixtureData.apply('--yes').stderr, /须提供四个 App 各自不同/);
});

test('同组织仍使用四个 App 各自的签名，Praise QA 返回 404 则首次写入前停止', (t) => {
  const data = fixture(t);
  const manifestData = JSON.parse(fs.readFileSync(data.manifest, 'utf8'));
  delete manifestData.rehearsalInstallationIds;
  fs.writeFileSync(data.manifest, JSON.stringify(manifestData));
  const keys = {};
  [...appDirs, qa].forEach((name, index) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const appId = 101 + index;
    const keyPath = '.config/test-apps/' + appId + '.pem';
    data.write(keyPath, privateKey);
    if (name !== qa) data.write(name, JSON.stringify({ ...JSON.parse(data.read(name)), appId, keyPath }));
    keys[appId] = publicKey;
  });
  fs.writeFileSync(data.env.CUTOVER_TEST_KEYS, JSON.stringify(keys));
  data.env.CUTOVER_TEST_FAIL_APP = '104';
  const before = tree(data.home);
  const result = data.apply('--yes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Praise QA App installationId 查不到.*HTTP 404/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY|eyJ/);
  assert.equal(fs.readFileSync(data.env.CUTOVER_TEST_READS, 'utf8'), '101\n102\n103\n104\n');
  assert.equal(fs.existsSync(data.env.TEST_INSTALL_LOG), false);
  assert.equal(fs.existsSync(data.home + '/mivo-prereview/cutover-backup'), false);
  assert.deepEqual(tree(data.home), before);
  delete data.env.CUTOVER_TEST_FAIL_APP;
  const success = data.apply('--yes');
  assert.equal(success.status, 0, success.stderr);
  assert.match(data.read(qa), /# Installations: owner\/old -> 123, owner\/new -> 10104/);
  assert.match(data.read(qa), /owner\/new\) echo 10104 ;;\n    owner\/old\) echo 123 ;;/);
  const repeat = data.apply('--yes');
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(repeat.stdout, /0 步写入/);
});
