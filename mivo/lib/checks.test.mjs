import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTarget, toMirrorDispatchArgs } from './checks.mjs';

const WF = 'xindong/mivo-canvas-plugin';
const SANDBOX = 'xindong/mivo-review-sandbox';
const HEAD = 'a'.repeat(40);

test('只有 live 审本仓才直接写;sandbox 审沙箱仓走镜像;其余不写', () => {
  assert.equal(checkTarget({ mode: 'live', targetRepo: WF, workflowRepo: WF }), 'direct');
  assert.equal(checkTarget({ mode: 'sandbox', targetRepo: SANDBOX, workflowRepo: WF }), 'sandbox-mirror');
  assert.equal(checkTarget({ mode: 'dry-run', targetRepo: WF, workflowRepo: WF }), 'none');
  assert.equal(checkTarget({ mode: 'dry-run', targetRepo: SANDBOX, workflowRepo: WF }), 'none');
  assert.equal(checkTarget({ mode: 'sandbox', targetRepo: WF, workflowRepo: WF }), 'none');
  assert.equal(checkTarget({ mode: 'live', targetRepo: SANDBOX, workflowRepo: WF }), 'none');
});

test('镜像派发参数:审查中与结论两种形态,标题和摘要截断', () => {
  const input = { head: HEAD, targetRepo: SANDBOX, runUrl: 'https://github.com/x/y/actions/runs/1' };
  const pending = toMirrorDispatchArgs(input, { title: '审查中', summary: '档位 light' });
  assert.deepEqual(pending.slice(0, 7), ['workflow', 'run', 'review-pr.yml', '-R', SANDBOX, '--ref', 'main']);
  assert.ok(pending.includes(`head_sha=${HEAD}`));
  assert.ok(pending.includes('status=in_progress'));
  assert.ok(pending.includes('conclusion='));
  assert.ok(pending.includes('source_run_url=https://github.com/x/y/actions/runs/1'));
  const done = toMirrorDispatchArgs(input, { conclusion: 'failure', title: 't'.repeat(500), summary: 's'.repeat(9000) });
  assert.ok(done.includes('status=completed'));
  assert.ok(done.includes('conclusion=failure'));
  assert.ok(done.includes(`title=${'t'.repeat(200)}`));
  assert.ok(done.includes(`summary=${'s'.repeat(4000)}`));
});
