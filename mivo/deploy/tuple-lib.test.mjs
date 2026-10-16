import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOSTS, WF_PATH, toHostCommand, toTrustText, trustTuple, toStopReady, toUpdateDecision, toCheckExit, toCompleteFrame, toDeployArgs,
} from './tuple-lib.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const WF = 'c'.repeat(64);
const ok = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });

test('本机直接用 sh 执行,其它机器经 ssh,都先 cd 到 $HOME', () => {
  assert.deepEqual(toHostCommand('mini', 'mini', 'echo hi'), ['sh', ['-c', 'cd "$HOME" || exit 9\necho hi']]);
  assert.deepEqual(toHostCommand('air', 'mini', 'echo hi'),
    ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOSTS.air, 'cd "$HOME" || exit 9\necho hi']]);
  assert.equal(toHostCommand('pro', 'mini', 'x')[1][4], 'Praise-MacBook');
  assert.equal(toHostCommand('mini', 'pro', 'x')[1][4], 'Praise-Mini');
  assert.throws(() => toHostCommand('constructor', 'mini', 'x'), /不认识的机器/);
});

test('trust 只换 skillSha、workflowSha256 和 review-pr.yml 那一项,其它字段原样', () => {
  const text = JSON.stringify({
    protocol: 'dispatch-review-v1', skillSha: A, workflowSha256: 'old', workflowId: 381252611,
    sourceManifest: { [WF_PATH]: 'old', 'other.yml': 'keep' },
  });
  const next = toTrustText(text, { skill: B, wf: WF });
  const j = JSON.parse(next);
  assert.equal(j.skillSha, B);
  assert.equal(j.workflowSha256, WF);
  assert.deepEqual(j.sourceManifest, { [WF_PATH]: WF, 'other.yml': 'keep' });
  assert.equal(j.protocol, 'dispatch-review-v1');
  assert.equal(j.workflowId, 381252611);
  assert.ok(next.endsWith('\n'));
  assert.deepEqual(trustTuple(next), { skill: B, wf: WF, manifest: WF });
});

test('停点:进程在跑、状态读不到、锁还在或读不到锁,都不算到', () => {
  for (const stop of ['pause', 'hold']) {
    for (const [state, lock] of [['running', ''], ['unknown', ''], ['not running', 'mivo-prereview/state/mivo/x/lock.json'], ['absent', null]]) {
      assert.equal(toStopReady({ stop, state, lock, quiesced: null }).ready, false, `${stop} ${state} ${lock}`);
    }
  }
});

test('hold:前置在停点写入前已空闲退出(没有回执)也算到停点', () => {
  assert.deepEqual(toStopReady({ stop: 'hold', state: 'not running', lock: '', quiesced: null }), { ready: true, via: 'idle' });
  assert.deepEqual(toStopReady({ stop: 'hold', state: 'absent', lock: '', quiesced: null }), { ready: true, via: 'idle' });
});

test('hold:有停机握手回执时要写明锁已放掉', () => {
  assert.deepEqual(toStopReady({ stop: 'hold', state: 'not running', lock: '', quiesced: { lockReleased: true } }),
    { ready: true, via: 'handshake' });
  const held = toStopReady({ stop: 'hold', state: 'not running', lock: '', quiesced: { lockReleased: false } });
  assert.equal(held.ready, false);
  assert.match(held.reason, /锁没放掉/);
});

test('pause:不看回执', () => {
  assert.deepEqual(toStopReady({ stop: 'pause', state: 'not running', lock: '', quiesced: { lockReleased: false } }),
    { ready: true, via: 'idle' });
});

test('自动换版本:Mini 检出和仓库变量不一致先要人看,即使 main 没变', () => {
  const d = toUpdateDecision({ current: A, checkout: B, target: A, compare: null, checks: [] });
  assert.equal(d.action, 'blocked');
  assert.match(d.reason, /不一致/);
});

test('自动换版本:已是最新就不换', () => {
  assert.deepEqual(toUpdateDecision({ current: A, checkout: A, target: A, compare: null, checks: [] }),
    { action: 'none', reason: '已是最新(aaaaaaa)' });
});

test('自动换版本:main 不是线上的后续提交就不换', () => {
  for (const compare of ['behind', 'diverged', 'identical', null]) {
    const d = toUpdateDecision({ current: A, checkout: A, target: B, compare, checks: [ok('node-test')] });
    assert.equal(d.action, 'blocked', String(compare));
    assert.match(d.reason, /不是线上/);
  }
});

test('自动换版本:CI 还没结果或没跑完就改天再看,没过要人看', () => {
  const base = { current: A, checkout: A, target: B, compare: 'ahead' };
  assert.equal(toUpdateDecision({ ...base, checks: [] }).action, 'wait');
  const pending = toUpdateDecision({ ...base, checks: [ok('personal-ci'), { name: 'node-test', status: 'in_progress', conclusion: null }] });
  assert.equal(pending.action, 'wait');
  assert.match(pending.reason, /还没跑完:node-test/);
  const failed = toUpdateDecision({ ...base, checks: [ok('personal-ci'), ok('node-test', 'failure')] });
  assert.equal(failed.action, 'blocked');
  assert.match(failed.reason, /CI 没过:node-test=failure/);
});

test('自动换版本:CI 全部成功(跳过、中立也算)才换', () => {
  const d = toUpdateDecision({ current: A, checkout: A, target: B, compare: 'ahead',
    checks: [ok('personal-ci'), ok('node-test', 'skipped'), ok('credential-scan', 'neutral')] });
  assert.deepEqual(d, { action: 'update', reason: 'aaaaaaa → bbbbbbb' });
});

test('前置检查退出码:没事做跳过(2),要换或要人看放行(0)', () => {
  assert.equal(toCheckExit({ action: 'none' }), 2);
  assert.equal(toCheckExit({ action: 'wait' }), 2);
  assert.equal(toCheckExit({ action: 'update' }), 0);
  assert.equal(toCheckExit({ action: 'blocked' }), 0);
});

test('收尾帧是一行 cindy-script/1 JSON,结果过长截断', () => {
  const frame = toCompleteFrame('第一行\n第二行');
  assert.ok(frame.endsWith('\n'));
  assert.equal(frame.trimEnd().split('\n').length, 1);
  assert.deepEqual(JSON.parse(frame), { protocol: 'cindy-script/1', type: 'complete', resultText: '第一行\n第二行' });
  assert.equal(JSON.parse(toCompleteFrame('x'.repeat(5000))).resultText.length, 4000);
});

test('自动换版本只换本仓提交,在 Mini 上用 hold 停点', () => {
  assert.deepEqual(toDeployArgs({ current: A, target: B, wf: WF, recordDir: '/logs', maxWaitMin: 40 }), [
    '--on', 'mini', '--old-skill', A, '--new-skill', B, '--old-wf', WF, '--new-wf', WF,
    '--stop', 'hold', '--max-wait-min', '40', '--record-dir', '/logs',
  ]);
});
