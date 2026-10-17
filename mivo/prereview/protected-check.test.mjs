import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
const declaration = /^function protectedCheckDone\(task\) \{[\s\S]*?^\}/m.exec(source)?.[0];
assert.ok(declaration);
const repository = 'xindong/mivo-canvas-plugin';
const head = '7f9b0b1ad91032936ab1e160cd765fff5aa085e0';
const runUrl = `https://github.com/${repository}/actions/runs/39062858448`;
const formalCheck = {
  id: 117484379795, name: 'review-pr', head_sha: head, status: 'completed', conclusion: 'success',
  app: { slug: 'github-actions' }, external_id: runUrl,
};
const formalRun = {
  id: 39062858448, html_url: runUrl, repository: { full_name: repository },
  event: 'workflow_dispatch', path: '.github/workflows/review-pr.yml', head_branch: 'main',
  head_sha: 'main-workflow-not-pr-head', status: 'completed', conclusion: 'success',
};

function inspect(checks, { workflow = formalRun, checkResponse, runResponse } = {}) {
  const calls = [];
  const sandbox = {
    CONFIG: { targetRepo: repository, workflowRepo: repository, workflowRef: 'main' },
    ghRead(args) {
      calls.push(args);
      if (args[1].includes('/check-runs?')) {
        return checkResponse ?? { ok: true, stdout: JSON.stringify(args.includes('--slurp') ? checks : checks[0]) };
      }
      assert.equal(args[1], `repos/${repository}/actions/runs/39062858448`);
      return runResponse ?? { ok: true, stdout: JSON.stringify(workflow) };
    },
  };
  vm.runInNewContext(`${declaration}\nglobalThis.inspect = protectedCheckDone;`, sandbox);
  return { done: sandbox.inspect({ head }), calls };
}

test('同名 dry-run job 的 success 不能抑制正式派发（#1086）', () => {
  const job = { ...formalCheck, id: 117478681210, external_id: '9c53bba0-2bd2-5439-a62b-b77ac9c95646' };
  const result = inspect([{ check_runs: [job] }]);
  assert.equal(result.done, false);
  assert.equal(result.calls.length, 1);
});

test('生产者写出的正式成功检查与 main workflow 绑定；workflow head 不是 PR head', () => {
  const result = inspect([{ check_runs: [formalCheck] }]);
  assert.equal(result.done, true);
  assert.equal(result.calls.length, 2);
});

for (const [name, change] of [
  ['其它 App', { app: { slug: 'unrelated-bot' } }],
  ['无 App', { app: null }],
  ['旧 head', { head_sha: 'old-head' }],
  ['其它检查名', { name: 'ci' }],
  ['无来源', { external_id: null }],
  ['其它仓运行', { external_id: 'https://github.com/other/repo/actions/runs/39062858448' }],
  ['URL 后缀', { external_id: `${runUrl}/jobs/1` }],
  ['进行中', { status: 'in_progress', conclusion: null }],
  ['失败', { conclusion: 'failure' }],
  ['跳过', { conclusion: 'skipped' }],
]) {
  test(`${name}不能证明正式检查已完成`, () => {
    assert.equal(inspect([{ check_runs: [{ ...formalCheck, ...change }] }]).done, false);
  });
}

for (const [name, change] of [
  ['其它 workflow', { path: '.github/workflows/other.yml' }],
  ['测试分支', { head_branch: 'test-branch' }],
  ['非派发事件', { event: 'pull_request' }],
  ['其它仓', { repository: { full_name: 'other/repo' } }],
  ['其它运行 URL', { html_url: `${runUrl}0` }],
  ['运行失败', { conclusion: 'failure' }],
  ['运行未结束', { status: 'in_progress' }],
]) {
  test(`${name}的运行不能作为正式完成证据`, () => {
    assert.equal(inspect([{ check_runs: [formalCheck] }], { workflow: { ...formalRun, ...change } }).done, false);
  });
}

test('分页找正式检查；更晚的普通 job 不遮蔽正式结果', () => {
  const result = inspect([
    { check_runs: [{ ...formalCheck, id: formalCheck.id + 10, external_id: 'job-uuid' }] },
    { check_runs: [formalCheck] },
  ]);
  assert.equal(result.done, true);
  assert.ok(result.calls[0].includes('--paginate'));
  assert.ok(result.calls[0].includes('--slurp'));
});

test('较新的正式失败不被旧 success 遮蔽', () => {
  const newer = { ...formalCheck, id: formalCheck.id + 1, conclusion: 'failure' };
  assert.equal(inspect([{ check_runs: [formalCheck, newer] }]).done, false);
});

for (const response of [{ ok: false, stdout: '' }, { ok: true, stdout: '{broken' }, { ok: true, stdout: 'null' }]) {
  test(`读取失败或数据异常不放行：${JSON.stringify(response)}`, () => {
    assert.equal(inspect([], { checkResponse: response }).done, false);
    assert.equal(inspect([{ check_runs: [formalCheck] }], { runResponse: response }).done, false);
  });
}

test('无检查时继续派发', () => {
  assert.equal(inspect([{ check_runs: [] }]).done, false);
});
