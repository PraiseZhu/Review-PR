// 孤儿停点(PraiseZhu/Review-PR#205):判定(纯函数)和回收(临时 HOME 里的真文件)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEPLOY_LOCK_REL, HOSTS, HOLD_STALE_MIN, toDeployLockText, toOrphanDecision, toHoldAlert } from './tuple-lib.mjs';
import { MONITOR_PAUSE_REL, RECORD_DIR_REL, isLockHolderAlive, reconcileOrphanHold } from './orphan-hold.mjs';

const TARGET = 'c1d089d23cded598785a4bb5e2e6f4dc8c9766b5';
const LOCK = { owner: 'deploy-tuple:mini', pid: 51201, host: HOSTS.mini, at: '2026-11-06T07:43:00.000Z', target: TARGET, expiresAt: '2026-11-06T10:13:00.000Z' };
const LOCK_TEXT = toDeployLockText(LOCK);
const HOLD_TEXT = `${JSON.stringify({ at: '2026-11-06T07:44:00.000Z', reason: '整组上线 c1d089d' })}\n`;
const MONITOR_REASON = '新审查机整组上线 c1d089d';
const recordOf = (extra = {}) => ({ lockText: LOCK_TEXT, holdText: HOLD_TEXT, monitorPause: true, switched: [], phases: [{ name: '停点:暂停已写,等前置审查退出' }], ...extra });
const decide = (over = {}) => toOrphanDecision({ lock: LOCK, lockText: LOCK_TEXT, hold: { exists: true, text: HOLD_TEXT }, alive: false, record: recordOf(), ...over });

test('SC1 持有进程已不在、switched 为空:撤停点、握手回执、巡检暂停和锁', () => {
  const d = decide();
  assert.equal(d.action, 'revoke');
  assert.deepEqual(d.remove, { hold: true, quiesced: true, monitorPause: true, lock: true });
  assert.match(d.reason, /pid 51201.*switched 为空/);
});

test('SC1 停点内容不是本次写的:不撤停点,只撤锁和巡检暂停', () => {
  const d = decide({ hold: { exists: true, text: '{"at":"x","reason":"别人的"}\n' } });
  assert.equal(d.action, 'revoke');
  assert.deepEqual(d.remove, { hold: false, quiesced: false, monitorPause: true, lock: true });
});

test('SC2 switched 非空:绝不撤,只报警', () => {
  for (const switched of [['variable'], ['variable', 'checkout']]) {
    const d = decide({ record: recordOf({ switched }) });
    assert.equal(d.action, 'alert');
    assert.match(d.reason, /switched 非空/);
    assert.equal(d.remove, undefined);
  }
});

test('只要不能证明什么都没切就不撤:无记录、记录对不上锁、switched 读不懂、已合并 PR、已 bootout、写过 pause.json', () => {
  for (const over of [
    { record: null },
    { record: recordOf({ lockText: 'x' }) },
    { record: recordOf({ switched: undefined }) },
    { record: recordOf({ merged: 'abc' }) },
    { record: recordOf({ phases: [{ name: '停点:前置审查已退出、锁已释放,已 bootout(停机握手)' }] }) },
    { record: recordOf({ pauseWritten: true }) },
  ]) {
    assert.equal(decide(over).action, 'alert', JSON.stringify(over));
  }
});

test('SC3 持有进程仍在:什么都不撤;查不了(null)也不撤', () => {
  assert.equal(decide({ alive: true }).action, 'keep');
  assert.equal(decide({ alive: null }).action, 'alert');
  assert.equal(decide({ alive: undefined }).action, 'alert');
});

test('没有锁或锁读不懂:不撤', () => {
  assert.equal(decide({ lock: null, lockText: null }).action, 'none');
  assert.equal(decide({ lock: null }).action, 'alert');
});

test('SC4 停点超过 60 分钟就是 stale,与孤儿判定无关;读不懂 at 也算', () => {
  const at = Date.parse('2026-11-06T08:00:00Z');
  assert.equal(HOLD_STALE_MIN, 60);
  assert.equal(toHoldAlert({ holdAtMs: at, now: at + 60 * 60_000 }).stale, false);
  const stale = toHoldAlert({ holdAtMs: at, now: at + 61 * 60_000 });
  assert.equal(stale.stale, true);
  assert.equal(stale.ageMin, 61);
  assert.match(stale.text, /已挂 61 分钟/);
  assert.equal(toHoldAlert({ holdAtMs: Number.NaN, now: at }).stale, true);
});

test('进程判活:锁写的不是 Mini、pid 不合法、ps 出错都是 null;pid 不存在是 false;命令行不是 deploy-tuple 是 false', () => {
  const ps = (result) => (cmd, args) => { assert.deepEqual([cmd, args.slice(0, 2)], ['ps', ['-p', '51201']]); return result; };
  assert.equal(isLockHolderAlive({ ...LOCK, host: HOSTS.pro }, { run: ps({}) }), null);
  assert.equal(isLockHolderAlive({ ...LOCK, pid: 'x' }, { run: ps({}) }), null);
  assert.equal(isLockHolderAlive(LOCK, { run: ps({ error: new Error('boom') }) }), null);
  assert.equal(isLockHolderAlive(LOCK, { run: ps({ status: 1, stdout: '' }) }), false);
  assert.equal(isLockHolderAlive(LOCK, { run: ps({ status: 0, stdout: '/usr/bin/vim a.txt\n' }) }), false);
  assert.equal(isLockHolderAlive(LOCK, { run: ps({ status: 0, stdout: 'node /x/mivo/deploy/deploy-tuple.mjs --on mini\n' }) }), true);
});

// 临时 HOME 里放线上同样的目录结构。
function setup(t, { lock = LOCK_TEXT, hold = HOLD_TEXT, record = recordOf(), monitorPause = { from: '2026-11-06T07:43:00Z', until: '2026-11-06T11:43:00Z', reason: MONITOR_REASON } } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-orphan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, path.dirname(DEPLOY_LOCK_REL));
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  if (lock != null) put(path.join(home, DEPLOY_LOCK_REL), lock);
  if (hold != null) put(path.join(dir, 'deploy-hold.json'), hold);
  put(path.join(dir, 'quiesced.json'), '{"lockReleased":true}\n');
  if (record) put(path.join(home, RECORD_DIR_REL, 'deploy-c1d089d-20261106T0743.record.json'), JSON.stringify(record));
  if (monitorPause) put(path.join(home, MONITOR_PAUSE_REL), JSON.stringify(monitorPause));
  const exists = (rel) => fs.existsSync(path.join(home, rel));
  const files = () => ({
    lock: exists(DEPLOY_LOCK_REL), hold: fs.existsSync(path.join(dir, 'deploy-hold.json')),
    quiesced: fs.existsSync(path.join(dir, 'quiesced.json')), monitorPause: exists(MONITOR_PAUSE_REL),
  });
  return { home, dir, files, run: (isAlive) => reconcileOrphanHold({ dir, home, isAlive }) };
}
const ALL = { lock: true, hold: true, quiesced: true, monitorPause: true };

test('SC1 回收:进程已不在、switched 为空,三个文件和握手回执都撤掉并返回撤了什么', (t) => {
  const w = setup(t);
  const r = w.run(() => false);
  assert.equal(r.action, 'revoke');
  assert.deepEqual(r.removed.map((f) => path.basename(f)), ['deploy-hold.json', 'quiesced.json', 'pause-until.json', 'deploy-tuple.lock']);
  assert.deepEqual(w.files(), { lock: false, hold: false, quiesced: false, monitorPause: false });
});

test('SC2 回收:switched 非空,四个文件都原样留着,只返回 alert', (t) => {
  const w = setup(t, { record: recordOf({ switched: ['variable'] }) });
  const r = w.run(() => false);
  assert.equal(r.action, 'alert');
  assert.deepEqual(w.files(), ALL);
});

test('SC3 回收:进程还在,四个文件都留着', (t) => {
  const w = setup(t);
  assert.equal(w.run(() => true).action, 'keep');
  assert.deepEqual(w.files(), ALL);
  assert.equal(w.run(() => null).action, 'alert');
  assert.deepEqual(w.files(), ALL);
});

test('回收:找不到部署记录时不撤', (t) => {
  const w = setup(t, { record: null });
  assert.equal(w.run(() => false).action, 'alert');
  assert.deepEqual(w.files(), ALL);
});

test('回收:巡检暂停不是本次写的(原因对不上)就留着,其余照撤', (t) => {
  const w = setup(t, { monitorPause: { from: 'x', until: 'y', reason: '维护者手写的计划内维护' } });
  assert.equal(w.run(() => false).action, 'revoke');
  assert.deepEqual(w.files(), { lock: false, hold: false, quiesced: false, monitorPause: true });
});

test('回收:不是线上状态目录就不碰', (t) => {
  const w = setup(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-orphan-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, 'deploy-hold.json'), HOLD_TEXT);
  assert.equal(reconcileOrphanHold({ dir: other, home: w.home, isAlive: () => false }).action, 'none');
  assert.equal(fs.existsSync(path.join(other, 'deploy-hold.json')), true);
});

test('回收:没有锁就什么都不做(停点可能是维护者手写的)', (t) => {
  const w = setup(t, { lock: null });
  assert.equal(w.run(() => false).action, 'none');
  assert.deepEqual(w.files(), { lock: false, hold: true, quiesced: true, monitorPause: true });
});
