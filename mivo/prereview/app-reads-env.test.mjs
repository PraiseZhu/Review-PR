// round.mjs 的 setupEnv / loadConfig:Mini 经 GitHub App 分流时去掉 viewer 与 fork 名读取。
// 做法同 protected-check.test.mjs:从 round.mjs 抽出具名函数放进 vm,依赖用替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
const extract = (name) => {
  const declaration = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(source)?.[0];
  assert.ok(declaration, `round.mjs 里找不到函数 ${name}`);
  return declaration;
};
const base = { mode: 'live', repoRoot: '/r', stateDir: '/s', workflowRepo: 'o/r', workflowRef: 'main', logDir: '/l', targetRepo: 'o/r' };

function setupEnv(config, env = {}) {
  const sandbox = { process: { env }, join: (...parts) => parts.join('/'), HERE: '/here', run: () => ({ stdout: '' }) };
  vm.runInNewContext(`${extract('setupEnv')}\nglobalThis.result = setupEnv(${JSON.stringify(config)});`, sandbox);
  return sandbox.result;
}
function loadConfig(config) {
  const sandbox = { process: { argv: ['node', 'round.mjs', '--config', 'x.json'] }, readJson: () => ({ ...config }), resolve: (p) => p, MODES: ['dry-run', 'sandbox', 'live'] };
  vm.runInNewContext(`${extract('loadConfig')}\nglobalThis.load = loadConfig;`, sandbox);
  return sandbox.load();
}

test('配了 viewerLogin:脚本环境带 REVIEW_PR_VIEWER_LOGIN,快照不读 fork 名', () => {
  const env = setupEnv({ ...base, viewerLogin: 'ExampleUser' });
  assert.equal(env.REVIEW_PR_VIEWER_LOGIN, 'ExampleUser');
  assert.equal(env.REVIEW_PR_SNAPSHOT_FORK_NAME, '0');
});

test('没配 viewerLogin:不从 launchd 环境继承 REVIEW_PR_VIEWER_LOGIN', () => {
  const env = setupEnv(base, { REVIEW_PR_VIEWER_LOGIN: 'Inherited' });
  assert.equal(Object.hasOwn(env, 'REVIEW_PR_VIEWER_LOGIN'), false);
  assert.equal(env.REVIEW_PR_SNAPSHOT_FORK_NAME, '0');
});

test('viewerLogin 格式不对时启动即报错', () => {
  assert.equal(loadConfig({ ...base, viewerLogin: 'ExampleUser' }).viewerLogin, 'ExampleUser');
  for (const bad of ['', 'a b', '-x', 'x'.repeat(40), 7]) {
    assert.throws(() => loadConfig({ ...base, viewerLogin: bad }), /viewerLogin/);
  }
  assert.equal(loadConfig(base).viewerLogin, undefined);
});
