// #176 SC7:服务器 scriptEnv 把 REVIEW_PR_VIEWER_ALIASES 原样透传给 prepare / publish 的脚本(本轮只透传,其余服务器侧单值归属判断属 #177)。
// 从 review.mjs 抽出 scriptEnv 放进 vm,不 import CLI 顶层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./review.mjs', import.meta.url), 'utf8');
const declaration = /^function scriptEnv\([^)]*\) \{[\s\S]*?^\}/m.exec(source)?.[0];

function scriptEnv(processEnv, extra) {
  assert.ok(declaration, 'review.mjs 里找不到 scriptEnv');
  const sandbox = { process: { env: processEnv }, REPO_DIR: '/r', WORK: '/w', ROUTE_LOG: '/l', join: (...parts) => parts.join('/') };
  vm.runInNewContext(`${declaration}\nglobalThis.result = scriptEnv(${JSON.stringify(extra ?? {})});`, sandbox);
  return sandbox.result;
}

test('scriptEnv 透传 REVIEW_PR_VIEWER_LOGIN / REVIEW_PR_VIEWER_ALIASES', () => {
  const env = scriptEnv({ REVIEW_PR_VIEWER_LOGIN: 'praisebuild[bot]', REVIEW_PR_VIEWER_ALIASES: '["PraiseZhu"]' });
  assert.equal(env.REVIEW_PR_VIEWER_LOGIN, 'praisebuild[bot]');
  assert.equal(env.REVIEW_PR_VIEWER_ALIASES, '["PraiseZhu"]');
});

test('scriptEnv 没配别名时不凭空生成;extra 能覆盖', () => {
  assert.equal(Object.hasOwn(scriptEnv({}), 'REVIEW_PR_VIEWER_ALIASES'), false);
  assert.equal(scriptEnv({ REVIEW_PR_VIEWER_ALIASES: '["A"]' }, { REVIEW_PR_VIEWER_ALIASES: '["B"]' }).REVIEW_PR_VIEWER_ALIASES, '["B"]');
});
