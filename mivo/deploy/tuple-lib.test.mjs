import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  HOSTS, WF_PATH, DEPLOY_LOCK_REL, DEPLOY_LOCK_PATH, DEPLOY_LOCK_SLACK_MS, toHostCommand, toTrustText, trustTuple, toStopReady, isOwnHold,
  toUpdateDecision, toCheckExit, toCompleteFrame, toDeployArgs,
  toFinalizeFailure, toAutoUpdateFinish, toLockAcquire, toDeployLockText, isOwnLock, toLockExpiresAt,
  toLockKeep, toLockBlockedText, toLinkLockScript, toReleaseLockScript, finalizeDeployError,
  RELEASE_LOCK_RETRIES, toReleaseLockResult,
  shouldTakeDeployLock, shouldResumePrereview, toNewCommitCheck, toMergedPrNumbers, toBehindMainNote,
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

test('hold 按内容认是不是本次写的:写成功但 ssh 回执丢了也认,不存在或内容不同(别人的)不认', () => {
  const mine = '{"at":"2026-10-16T06:30:01.000Z","reason":"整组上线 bbbbbbb"}\n';
  assert.equal(isOwnHold({ exists: true, text: mine }, mine), true);
  assert.equal(isOwnHold({ exists: true, text: '{"at":"2026-10-16T06:29:00.000Z","reason":"别人的维护"}\n' }, mine), false);
  assert.equal(isOwnHold({ exists: false, text: null }, mine), false);
  assert.equal(isOwnHold({ exists: true, text: mine }, null), false, '还没开始写停点');
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

test('tuple 已整组切到新版本后撤停点或 bootstrap 失败:exit 2,说明新版本已上', () => {
  const all = toFinalizeFailure({ switchedCount: 5, stepCount: 5 });
  assert.equal(all.code, 2);
  assert.match(all.message, /新版本已上/);
  assert.match(all.message, /前置审查停止/);
  assert.match(all.message, /要人工处理/);
  const none = toFinalizeFailure({ switchedCount: 0, stepCount: 5 });
  assert.equal(none.code, 1);
  assert.match(none.message, /线上仍是旧版/);
  assert.match(none.message, /前置照常/);
  const partial = toFinalizeFailure({ switchedCount: 3, stepCount: 5 });
  assert.equal(partial.code, 1);
});

test('自动换版本:deploy-tuple exit 2 不再写线上仍是旧版、前置照常', () => {
  const stopped = toAutoUpdateFinish(2, { reason: 'aaaaaaa → bbbbbbb', current: A, log: '/l', tail: 'x' });
  assert.equal(stopped.code, 2);
  assert.doesNotMatch(stopped.text, /线上仍是/);
  assert.doesNotMatch(stopped.text, /前置照常/);
  assert.match(stopped.text, /前置审查保持停止/);
  const reverted = toAutoUpdateFinish(1, { reason: 'aaaaaaa → bbbbbbb', current: A, log: '/l', tail: 'x' });
  assert.equal(reverted.code, 1);
  assert.match(reverted.text, /线上仍是 aaaaaaa/);
  assert.match(reverted.text, /前置照常/);
  assert.equal(toAutoUpdateFinish(0, { reason: 'aaaaaaa → bbbbbbb', current: A, log: '/l', tail: '' }).code, 0);
});

test('部署锁:无人占用才拿锁,别人占用且未过期则不改任何东西', () => {
  const now = Date.parse('2026-10-16T06:30:00.000Z');
  assert.deepEqual(toLockAcquire({ existing: { exists: false, text: null }, now }), { action: 'acquire' });
  const holder = {
    owner: 'deploy-tuple:pro', pid: 4242, host: HOSTS.pro, at: '2026-10-16T06:29:00.000Z', target: A,
    expiresAt: '2026-10-16T11:00:00.000Z',
  };
  const held = toLockAcquire({ existing: { exists: true, text: toDeployLockText(holder) }, now });
  assert.equal(held.action, 'blocked');
  assert.equal(held.expired, false);
  assert.match(held.reason, /deploy-tuple:pro/);
  assert.match(held.reason, /4242/);
  assert.match(held.reason, /expiresAt 2026-10-16T11:00:00.000Z/);
  assert.equal(held.holder.pid, 4242);
  assert.match(toLockBlockedText(held), /不动 Mini 和线上状态/);
  assert.doesNotMatch(toLockBlockedText(held), /锁已过期/);
});

test('部署锁:过期也不顶替,只提示人工删除', () => {
  const start = Date.parse('2026-10-16T00:00:00.000Z');
  const maxWaitMs = 300 * 60 * 1000;
  const expiresAt = toLockExpiresAt(start, maxWaitMs);
  assert.equal(Date.parse(expiresAt), start + maxWaitMs + DEPLOY_LOCK_SLACK_MS);
  assert.ok(DEPLOY_LOCK_SLACK_MS >= 90 * 60 * 1000);
  const holder = { owner: 'deploy-tuple:mini', pid: 9, host: HOSTS.mini, at: new Date(start).toISOString(), target: A, expiresAt };
  const live = toLockAcquire({ existing: { exists: true, text: toDeployLockText(holder) }, now: start + 241 * 60 * 1000 });
  assert.equal(live.action, 'blocked', '241 分钟仍在 max-wait-min 300 + 90 余量之内');
  assert.equal(live.expired, false);
  const atExpiry = toLockAcquire({ existing: { exists: true, text: toDeployLockText(holder) }, now: Date.parse(expiresAt) });
  assert.equal(atExpiry.action, 'blocked', 'now === expiresAt 仍不顶替');
  assert.equal(atExpiry.expired, false);
  const stale = toLockAcquire({ existing: { exists: true, text: toDeployLockText(holder) }, now: Date.parse(expiresAt) + 1 });
  assert.equal(stale.action, 'blocked');
  assert.equal(stale.expired, true);
  const text = toLockBlockedText(stale);
  assert.match(text, /锁已过期/);
  assert.match(text, new RegExp(`先在 ${HOSTS.mini} 上按 pid 9 确认原进程已结束`));
  assert.match(text, new RegExp(`再删 ${DEPLOY_LOCK_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 后重跑`));
  assert.doesNotMatch(text, /顶替/);
});

test('部署锁:只删自己的(按内容认),preview 和 check 不拿锁', () => {
  const mine = toDeployLockText({ owner: 'deploy-tuple:mini', pid: 1, host: HOSTS.mini, at: '2026-10-16T06:30:01.000Z', target: B, expiresAt: '2026-10-16T12:00:00.000Z' });
  assert.equal(isOwnLock({ exists: true, text: mine }, mine), true);
  assert.equal(isOwnLock({ exists: true, text: toDeployLockText({ owner: 'other', pid: 2, host: HOSTS.pro, at: '2026-10-16T06:29:00.000Z', target: A, expiresAt: '2026-10-16T12:00:00.000Z' }) }, mine), false);
  assert.equal(isOwnLock({ exists: false, text: null }, mine), false);
  assert.equal(shouldTakeDeployLock({ preview: true, check: false }), false);
  assert.equal(shouldTakeDeployLock({ preview: false, check: true }), false);
  assert.equal(shouldTakeDeployLock({ preview: false, check: false }), true);
});

test('部署锁:ln 回执丢失时按内容认回自己的锁', () => {
  const mine = toDeployLockText({ owner: 'deploy-tuple:mini', pid: 1, host: HOSTS.mini, at: '2026-10-16T06:30:01.000Z', target: B, expiresAt: '2026-10-16T12:00:00.000Z' });
  assert.equal(toLockKeep({ createdOk: true, existing: { exists: false, text: null }, lockText: mine }).action, 'keep');
  assert.equal(toLockKeep({ createdOk: false, existing: { exists: true, text: mine }, lockText: mine }).action, 'keep');
  assert.equal(toLockKeep({ createdOk: false, existing: { exists: true, text: mine + 'x' }, lockText: mine }).action, 'blocked');
  assert.equal(toLockKeep({ createdOk: false, existing: { exists: false, text: null }, lockText: mine }).action, 'blocked');
});

test('收尾 bootstrap:开始前 absent 不重新加载,已加载的才恢复', () => {
  const disabled = shouldResumePrereview('absent');
  assert.equal(disabled.resume, false);
  assert.equal(disabled.message, '开始前前置已停用,未重新加载');
  assert.deepEqual(shouldResumePrereview('running'), { resume: true });
  assert.deepEqual(shouldResumePrereview('not running'), { resume: true });
});

test('--preview 缺提交只报告 Mini 尚未取到,不 fetch', () => {
  assert.deepEqual(toNewCommitCheck({ preview: true, hasCommit: false }), { action: 'missing', message: 'Mini 尚未取到该提交' });
  assert.deepEqual(toNewCommitCheck({ preview: false, hasCommit: false }), { action: 'fetch' });
  assert.deepEqual(toNewCommitCheck({ preview: true, hasCommit: true }), { action: 'ok' });
  assert.deepEqual(toNewCommitCheck({ preview: false, hasCommit: true }), { action: 'ok' });
});

test('拿锁脚本用 ln,目标已存在则失败,锁名不被 lockHeld 误认', () => {
  const script = toLinkLockScript(DEPLOY_LOCK_REL);
  assert.match(script, /ln "\$tmp" "\$f"/);
  assert.doesNotMatch(script, /mkdir "\$[df]"|toSteal|steal/);
  assert.doesNotMatch(script, /set -C|noclobber|flock|lockf/);
  assert.ok(DEPLOY_LOCK_REL.endsWith('deploy-tuple.lock'));
  assert.doesNotMatch(path.basename(DEPLOY_LOCK_REL), /^lock\.json$/);
  const matched = (p) => p.startsWith('mivo-prereview/state/mivo/')
    && p.slice('mivo-prereview/state/mivo/'.length).split('/').length <= 2
    && path.basename(p) === 'lock.json';
  assert.equal(matched(DEPLOY_LOCK_REL), false);
  assert.equal(matched(`${DEPLOY_LOCK_REL}.tmp.1.2`), false);
  assert.equal(matched('mivo-prereview/state/mivo/01234567890123456789/lock.json'), true);
});

test('ln 锁:两个进程同时拿,只有一个成功,锁文件创建时已有完整内容', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-lock-ln-'));
  try {
    const aText = toDeployLockText({ owner: 'A', pid: 100, host: HOSTS.mini, at: '2026-10-16T06:00:00.000Z', target: B, expiresAt: '2026-10-16T12:00:00.000Z' });
    const bText = toDeployLockText({ owner: 'B', pid: 200, host: HOSTS.pro, at: '2026-10-16T06:00:00.000Z', target: B, expiresAt: '2026-10-16T12:00:00.000Z' });
    fs.writeFileSync(path.join(root, 'a.json'), aText);
    fs.writeFileSync(path.join(root, 'b.json'), bText);
    fs.writeFileSync(path.join(root, 'worker.sh'), `${toLinkLockScript(DEPLOY_LOCK_REL)}\n`);
    const parallel = spawnSync('sh', ['-c', [
      `cd ${JSON.stringify(root)}`,
      '( cat a.json | sh worker.sh; echo A:$? ) > a.out &',
      '( cat b.json | sh worker.sh; echo B:$? ) > b.out &',
      'wait',
      'cat a.out b.out',
    ].join('\n')], { encoding: 'utf8' });
    assert.equal(parallel.status, 0, parallel.stderr);
    const codes = [...parallel.stdout.matchAll(/[AB]:(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(codes.length, 2);
    assert.equal(codes.filter((c) => c === 0).length, 1, parallel.stdout);
    assert.equal(codes.filter((c) => c === 1).length, 1, parallel.stdout);
    const lockFile = path.join(root, DEPLOY_LOCK_REL);
    assert.equal(fs.statSync(lockFile).isFile(), true);
    const body = fs.readFileSync(lockFile, 'utf8');
    assert.ok(body === aText || body === bText);
    assert.match(body, /"expiresAt"/);
    assert.equal(fs.readdirSync(path.dirname(lockFile)).some((name) => name.includes('.tmp.')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ln 锁:目标已存在则失败,不改已有内容', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-lock-ln-exist-'));
  try {
    const lockFile = path.join(root, DEPLOY_LOCK_REL);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const other = toDeployLockText({ owner: 'B', pid: 2, host: HOSTS.pro, at: '2026-10-16T06:01:00.000Z', target: B, expiresAt: '2026-10-16T12:00:00.000Z' });
    fs.writeFileSync(lockFile, other);
    const mine = toDeployLockText({ owner: 'A', pid: 1, host: HOSTS.mini, at: '2026-10-16T06:00:00.000Z', target: A, expiresAt: '2026-10-16T12:00:00.000Z' });
    const r = spawnSync('sh', ['-c', `cd ${JSON.stringify(root)}\n${toLinkLockScript(DEPLOY_LOCK_REL)}`], { encoding: 'utf8', input: mine });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), other);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('过期锁不顶替:ln 仍失败,内容原样', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-lock-stale-'));
  try {
    const lockFile = path.join(root, DEPLOY_LOCK_REL);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const stale = toDeployLockText({ owner: 'old', pid: 1, host: HOSTS.mini, at: '2026-10-16T00:00:00.000Z', target: A, expiresAt: '2026-10-16T00:00:01.000Z' });
    fs.writeFileSync(lockFile, stale);
    const mine = toDeployLockText({ owner: 'A', pid: 100, host: HOSTS.pro, at: '2026-10-16T06:00:00.000Z', target: B, expiresAt: '2026-10-16T12:00:00.000Z' });
    const r = spawnSync('sh', ['-c', `cd ${JSON.stringify(root)}\n${toLinkLockScript(DEPLOY_LOCK_REL)}`], { encoding: 'utf8', input: mine });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), stale);
    const decision = toLockAcquire({ existing: { exists: true, text: stale }, now: Date.parse('2026-10-16T06:00:00.000Z') });
    assert.equal(decision.action, 'blocked');
    assert.equal(decision.expired, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('释放锁:内容不同就不删,只告警', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-lock-rel-'));
  try {
    const lockFile = path.join(root, DEPLOY_LOCK_REL);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const mine = toDeployLockText({ owner: 'A', pid: 1, host: HOSTS.mini, at: '2026-10-16T06:00:00.000Z', target: A, expiresAt: '2026-10-16T12:00:00.000Z' });
    const other = toDeployLockText({ owner: 'B', pid: 2, host: HOSTS.pro, at: '2026-10-16T06:01:00.000Z', target: B, expiresAt: '2026-10-16T12:00:00.000Z' });
    fs.writeFileSync(lockFile, other);
    const r = spawnSync('sh', ['-c', `cd ${JSON.stringify(root)}\n${toReleaseLockScript(DEPLOY_LOCK_REL)}`], { encoding: 'utf8', input: mine });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /已不是本次的,不删/);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), other);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('释放锁:确认是自己的才删掉', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-lock-rel-own-'));
  try {
    const lockFile = path.join(root, DEPLOY_LOCK_REL);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const mine = toDeployLockText({ owner: 'A', pid: 1, host: HOSTS.mini, at: '2026-10-16T06:00:00.000Z', target: A, expiresAt: '2026-10-16T12:00:00.000Z' });
    fs.writeFileSync(lockFile, mine);
    const r = spawnSync('sh', ['-c', `cd ${JSON.stringify(root)}\n${toReleaseLockScript(DEPLOY_LOCK_REL)}`], { encoding: 'utf8', input: mine });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('释放锁只发一次:ssh 断线不重试,报结果未知并给人工核对办法', () => {
  assert.equal(RELEASE_LOCK_RETRIES, 1);
  assert.deepEqual(toReleaseLockResult({ status: 0, stderr: '' }), { ok: true, message: '' });
  assert.deepEqual(toReleaseLockResult({ status: 0, stderr: '部署锁已不是本次的,不删\n' }), { ok: true, message: '部署锁已不是本次的,不删' });
  const lost = toReleaseLockResult({ status: 255, stderr: 'Connection reset' });
  assert.equal(lost.ok, false);
  assert.match(lost.message, /结果未知/);
  assert.ok(lost.message.includes(DEPLOY_LOCK_PATH), lost.message);
  const failed = toReleaseLockResult({ status: 1, stderr: 'rm: Permission denied' });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Permission denied/);
});

test('save 抛 ENOSPC 时仍释放自己的锁', () => {
  let released = false;
  const { saveError, releaseError } = finalizeDeployError({
    save: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); },
    release: () => { released = true; },
  });
  assert.equal(released, true);
  assert.equal(saveError.message, 'ENOSPC');
  assert.equal(releaseError, null);
});

// 目标落后 main 时只提示、不拒绝:10-15 那次部署选了比 main 落后 26 分钟的提交,漏了 #64、#65,没人看得出来。
test('目标等于 main:不提示', () => {
  assert.equal(toBehindMainNote({ status: 'identical', aheadBy: 0, messages: [] }), null);
});

test('目标落后 main、期间有两个合并提交:提示个数并列出 #64 #65', () => {
  const messages = ['Merge pull request #64 from PraiseZhu/keel/a', 'Merge pull request #65 from PraiseZhu/keel/b'];
  assert.deepEqual(toMergedPrNumbers(messages), [64, 65]);
  const note = toBehindMainNote({ status: 'ahead', aheadBy: 2, messages });
  assert.equal(note, '目标比 main 落后 2 个提交，没包含：#64 #65');
});

test('落后部分里有非合并提交:提示里给出这类提交的个数', () => {
  const messages = ['fix(mivo): 一个直接提交', 'Merge pull request #66 from PraiseZhu/keel/c', 'docs: 另一个直接提交'];
  const note = toBehindMainNote({ status: 'ahead', aheadBy: 3, messages });
  assert.match(note, /落后 3 个提交/);
  assert.match(note, /没包含：#66/);
  assert.match(note, /其中 2 个不是合并提交（含已合并 PR 分支上自带的提交）/);
  const onlyOther = toBehindMainNote({ status: 'ahead', aheadBy: 1, messages: ['chore: 直接提交'] });
  assert.equal(onlyOther, '目标比 main 落后 1 个提交，其中 1 个不是合并提交（含已合并 PR 分支上自带的提交）');
});

test('squash 合并的提交(标题末尾 (#N))也认出 PR 号;同一个 PR 的合并提交和 squash 提交只列一次', () => {
  const messages = ['fix(mivo): 一个改动 (#52)', 'Merge pull request #64 from PraiseZhu/keel/a', 'feat: 另一个 (#47)', 'Merge pull request #64 from PraiseZhu/keel/a again', '修 bug (#12) 之后的补丁'];
  assert.deepEqual(toMergedPrNumbers(messages), [52, 64, 47]);
  const note = toBehindMainNote({ status: 'ahead', aheadBy: 5, messages });
  assert.match(note, /没包含：#52 #64 #47/);
  assert.match(note, /其中 1 个不是合并提交/, '只有标题中间带 (#12) 的那条不算 squash');
});

test('提交列表被接口截断(messages 比 aheadBy 少):提示里写明只列出了前面的一部分', () => {
  const messages = Array.from({ length: 250 }, (_, i) => `Merge pull request #${i + 1} from PraiseZhu/keel/x${i}`);
  const note = toBehindMainNote({ status: 'ahead', aheadBy: 926, messages });
  assert.match(note, /^目标比 main 落后 926 个提交/);
  assert.match(note, /只列出最早 250 个提交里的 PR/);
  assert.doesNotMatch(toBehindMainNote({ status: 'ahead', aheadBy: 2, messages: messages.slice(0, 2) }), /只列出/);
});

test('不在 main 上(diverged、behind)不是「落后」提示的事:函数不出声,拒绝仍由 preflight 负责', () => {
  assert.equal(toBehindMainNote({ status: 'diverged', aheadBy: 2, messages: ['x'] }), null);
  assert.equal(toBehindMainNote({ status: 'behind', aheadBy: 0, messages: [] }), null);
});

test('preflight 仍然拒绝不在 main 上的目标,只是落后才提示(源码里两个判断都在)', () => {
  const source = fs.readFileSync(new URL('./deploy-tuple.mjs', import.meta.url), 'utf8');
  assert.match(source, /\['identical', 'ahead'\]\.includes\(/, '拒绝条件不变');
  assert.match(source, /不在 Review-PR main 上/);
  assert.match(source, /toBehindMainNote\(/);
  assert.match(source, /record\.behindMain = /);
  assert.doesNotMatch(source, /--allow-behind|allowBehind/, '不加放行参数');
});
