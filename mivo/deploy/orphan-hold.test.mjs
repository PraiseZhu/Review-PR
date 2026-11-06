// 孤儿停点(PraiseZhu/Review-PR#205):判定(纯函数)和回收(临时 HOME 里的真文件)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DEPLOY_LOCK_REL, HOSTS, HOLD_STALE_MIN, toDeployLockText, toOrphanDecision, toHoldAlert, toReleaseLockScript, toLinkLockScript } from './tuple-lib.mjs';
import { MONITOR_PAUSE_REL, RECORD_DIR_REL, isLockHolderAlive, reconcileOrphanHold } from './orphan-hold.mjs';

const TARGET = 'c1d089d23cded598785a4bb5e2e6f4dc8c9766b5';
const LOCK = { owner: 'deploy-tuple:mini', pid: 51201, host: HOSTS.mini, at: '2026-11-06T07:43:00.000Z', target: TARGET, expiresAt: '2026-11-06T10:13:00.000Z' };
const LOCK_TEXT = toDeployLockText(LOCK);
const HOLD_TEXT = `${JSON.stringify({ at: '2026-11-06T07:44:00.000Z', reason: '整组上线 c1d089d' })}\n`;
const MONITOR_REASON = '新审查机整组上线 c1d089d';
const MONITOR_TEXT = `${JSON.stringify({ from: '2026-11-06T07:43:00.000Z', until: '2026-11-06T11:43:00.000Z', reason: MONITOR_REASON })}\n`;
const recordOf = (extra = {}) => ({ lockText: LOCK_TEXT, holdText: HOLD_TEXT, monitorPause: true, monitorPauseText: MONITOR_TEXT, stopStarted: true, bootout: 'none',
  switched: [], phases: [{ name: '停点:暂停已写,等前置审查退出' }], ...extra });
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
    { record: recordOf({ bootout: 'done' }) },
    { record: recordOf({ pauseWritten: true }) },
    { record: recordOf({ monitorPauseText: undefined }) },
  ]) {
    assert.equal(decide(over).action, 'alert', JSON.stringify(over));
  }
});

test('bootout 崩溃窗口:bootout 成功但「已 bootout」阶段还没落盘时,记录里是 pending(或旧版本记录没有这个字段),一律不撤', () => {
  const crashed = recordOf({ bootout: 'pending' }); // phases 里还没有「已 bootout」
  assert.ok(!crashed.phases.some((p) => p.name.includes('已 bootout')));
  for (const record of [crashed, recordOf({ bootout: undefined })]) {
    const d = decide({ record });
    assert.equal(d.action, 'alert');
    assert.match(d.reason, /bootout/);
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
function setup(t, { lock = LOCK_TEXT, hold = HOLD_TEXT, record = recordOf(), monitorPause = MONITOR_TEXT } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-orphan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, path.dirname(DEPLOY_LOCK_REL));
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  if (lock != null) put(path.join(home, DEPLOY_LOCK_REL), lock);
  if (hold != null) put(path.join(dir, 'deploy-hold.json'), hold);
  put(path.join(dir, 'quiesced.json'), '{"lockReleased":true}\n');
  if (record) put(path.join(home, RECORD_DIR_REL, 'deploy-c1d089d-20261106T0743.record.json'), JSON.stringify(record));
  if (monitorPause) put(path.join(home, MONITOR_PAUSE_REL), monitorPause);
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

test('回收:巡检暂停不是本次写的就留着,其余照撤;同提交前 7 位、同原因、别次部署写的也留着', (t) => {
  const other = `${JSON.stringify({ from: '2026-11-06T09:00:00.000Z', until: '2026-11-06T13:00:00.000Z', reason: MONITOR_REASON })}\n`;
  const w = setup(t, { monitorPause: other });
  assert.equal(w.run(() => false).action, 'revoke');
  assert.deepEqual(w.files(), { lock: false, hold: false, quiesced: false, monitorPause: true });
});

test('bootout 崩溃窗口(回收):记录是 pending 时四个文件都留着,锁也留着', (t) => {
  const w = setup(t, { record: recordOf({ bootout: 'pending' }) });
  const r = w.run(() => false);
  assert.equal(r.action, 'alert');
  assert.match(r.reason, /bootout/);
  assert.deepEqual(w.files(), ALL);
});

test('并发回收:A 占住锁之后,B 不能同时回收,新部署也拿不到锁、写不了新停点;A 做完才放开', (t) => {
  const w = setup(t);
  const lockFile = path.join(w.home, DEPLOY_LOCK_REL);
  const events = {};
  fs.writeFileSync(path.join(w.dir, 'new-lock.tmp'), toDeployLockText({ ...LOCK, pid: 60001, at: '2026-11-06T09:30:00.000Z' })); // 新部署先写好的临时锁
  const r = w.run(() => {
    // A 正在判活:这时另一个回收者 B 和一个新部署同时来了。
    events.b = w.run(() => false);
    try {
      fs.linkSync(path.join(w.dir, 'new-lock.tmp'), lockFile);
      events.newDeploy = 'got-lock';
    } catch (error) {
      events.newDeploy = error.code;
    }
    events.filesWhileA = w.files();
    return false;
  });
  assert.equal(r.action, 'revoke');
  assert.equal(events.b.action, 'alert', 'B 看到占位,不动手');
  assert.match(events.b.reason, /另一个回收者/);
  assert.equal(events.newDeploy, 'EEXIST', '新部署拿不到锁(ln 目标已存在)');
  assert.deepEqual(events.filesWhileA, ALL, 'A 做完之前什么都没被别人动');
  assert.deepEqual(w.files(), { lock: false, hold: false, quiesced: false, monitorPause: false });
  assert.equal(fs.existsSync(`${path.join(w.home, DEPLOY_LOCK_REL)}.reclaim`), false, '占位已放掉');
});

test('并发回收:别人已经回收完、新部署拿了新锁写了新停点,再来的回收者读到的是新锁:持有者还在就什么都不删', (t) => {
  const w = setup(t);
  assert.equal(w.run(() => false).action, 'revoke');
  // 新部署:新锁、新停点、新握手回执、同原因(同提交前 7 位)的新巡检暂停。
  const newLock = toDeployLockText({ ...LOCK, pid: 60001, at: '2026-11-06T09:30:00.000Z' });
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(path.join(w.home, DEPLOY_LOCK_REL), newLock);
  put(path.join(w.dir, 'deploy-hold.json'), '{"at":"2026-11-06T09:31:00.000Z","reason":"整组上线 c1d089d"}\n');
  put(path.join(w.dir, 'quiesced.json'), '{"lockReleased":true}\n');
  put(path.join(w.home, MONITOR_PAUSE_REL), JSON.stringify({ from: '2026-11-06T09:30:00.000Z', until: '2026-11-06T13:30:00.000Z', reason: MONITOR_REASON }));
  // 上一次部署的记录仍在(lockText 是旧锁),A 拿旧快照来回收:不能按旧记录删新部署的东西。
  const r = w.run((lock) => lock.pid === 60001 ? true : false);
  assert.equal(r.action, 'keep');
  assert.deepEqual(w.files(), ALL);
});

test('并发回收:新锁的持有者已死但它的记录还没落盘:找不到记录,不撤新部署的任何东西', (t) => {
  const w = setup(t);
  assert.equal(w.run(() => false).action, 'revoke');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(path.join(w.home, DEPLOY_LOCK_REL), toDeployLockText({ ...LOCK, pid: 60001, at: '2026-11-06T09:30:00.000Z' }));
  put(path.join(w.dir, 'deploy-hold.json'), '{"at":"2026-11-06T09:31:00.000Z","reason":"整组上线 c1d089d"}\n');
  const r = w.run(() => false);
  assert.equal(r.action, 'alert');
  assert.equal(fs.existsSync(path.join(w.dir, 'deploy-hold.json')), true);
  assert.equal(fs.existsSync(path.join(w.home, DEPLOY_LOCK_REL)), true);
});

test('回收者在手时旧部署的释放命令只能等:回收完、新部署拿锁写停点之后它再继续,不删新部署的任何东西', async (t) => {
  const w = setup(t);
  const newLockText = toDeployLockText({ ...LOCK, pid: 60001, at: '2026-11-06T09:30:00.000Z' });
  const newHold = '{"at":"2026-11-06T09:31:00.000Z","reason":"整组上线 c1d089d"}\n';
  const newPause = `${JSON.stringify({ from: '2026-11-06T09:30:00.000Z', until: '2026-11-06T13:30:00.000Z', reason: MONITOR_REASON })}\n`;
  const env = { ...process.env, HOME: w.home };
  let release;
  const r = w.run(() => {
    // A 正在判活并占着占位;旧部署 D 的释放命令这时才跑起来(真实进程):拿不到占位,只能等。
    release = spawn('sh', ['-c', `cd "$HOME" || exit 9\n${toReleaseLockScript(DEPLOY_LOCK_REL)}`], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    release.stdin.end(LOCK_TEXT);
    return false;
  });
  const exited = new Promise((resolve) => release.on('close', resolve));
  assert.equal(r.action, 'revoke');
  assert.equal(fs.existsSync(path.join(w.home, DEPLOY_LOCK_REL)), false, 'A 撤掉了旧锁');
  // 新部署 E 拿到新锁,写新停点、握手回执、同原因的巡检暂停。
  const got = spawnSync('sh', ['-c', `cd "$HOME" || exit 9\n${toLinkLockScript(DEPLOY_LOCK_REL)}`], { input: newLockText, encoding: 'utf8', env });
  assert.equal(got.status, 0, got.stderr);
  fs.writeFileSync(path.join(w.dir, 'deploy-hold.json'), newHold);
  fs.writeFileSync(path.join(w.dir, 'quiesced.json'), '{"lockReleased":true}\n');
  fs.writeFileSync(path.join(w.home, MONITOR_PAUSE_REL), newPause);
  assert.equal(await exited, 0, '旧释放命令正常结束(锁已不是它的,不删)');
  assert.equal(fs.readFileSync(path.join(w.home, DEPLOY_LOCK_REL), 'utf8'), newLockText, '新部署的锁还在');
  assert.equal(fs.readFileSync(path.join(w.dir, 'deploy-hold.json'), 'utf8'), newHold, '新停点还在');
  assert.equal(fs.existsSync(path.join(w.dir, 'quiesced.json')), true, '新握手回执还在');
  assert.equal(fs.readFileSync(path.join(w.home, MONITOR_PAUSE_REL), 'utf8'), newPause, '新巡检暂停还在');
  assert.equal(fs.existsSync(`${path.join(w.home, DEPLOY_LOCK_REL)}.reclaim`), false, '占位已放掉');
});

// 真实进程:部署父进程被强杀,但它启动的释放命令(shell)还活着。rm 处放一道屏障,让释放命令停在「已 cmp、将 rm」。
const waitFor = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等不到:${what}`);
};
const startBarrieredRelease = (w, lockText) => {
  const shimDir = path.join(w.home, 'shim');
  const barrier = path.join(w.home, 'barrier');
  const entered = path.join(w.home, 'entered');
  fs.mkdirSync(shimDir);
  fs.writeFileSync(barrier, '');
  // 只在删锁文件那一刻停;占位文件和其它 rm 照常执行。
  fs.writeFileSync(path.join(shimDir, 'rm'), [
    '#!/bin/sh',
    `for a in "$@"; do case "$a" in *deploy-tuple.lock) touch '${entered}'; while [ -e '${barrier}' ]; do sleep 0.02; done;; esac; done`,
    'exec /bin/rm "$@"',
  ].join('\n'), { mode: 0o755 });
  const child = spawn('sh', ['-c', `cd "$HOME" || exit 9\n${toReleaseLockScript(DEPLOY_LOCK_REL)}`], {
    env: { ...process.env, HOME: w.home, PATH: `${shimDir}:${process.env.PATH}` }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end(lockText);
  const exited = new Promise((resolve) => child.on('close', (status) => resolve({ status, stderr })));
  return { entered: () => fs.existsSync(entered), open: () => fs.rmSync(barrier, { force: true }), exited };
};

test('释放命令还活着(已 cmp、将 rm)时回收者不动手:不会把新部署的锁删掉', async (t) => {
  const w = setup(t);
  const newLockText = toDeployLockText({ ...LOCK, pid: 60001, at: '2026-11-06T09:30:00.000Z' });
  const release = startBarrieredRelease(w, LOCK_TEXT);
  await waitFor(release.entered, '释放命令走到 rm');
  // 部署父进程已死(isAlive 返回 false),但释放命令还在:回收者看到占位,不能撤任何东西。
  const r = w.run(() => false);
  assert.equal(r.action, 'alert');
  assert.match(r.reason, /另一个回收者|reclaim/);
  assert.deepEqual(w.files(), ALL, '回收者什么都没删');
  // 释放命令继续:删掉自己的锁、放掉占位。新部署随即拿到新锁。
  release.open();
  const exit = await release.exited;
  assert.equal(exit.status, 0, exit.stderr);
  const claim = `${path.join(w.home, DEPLOY_LOCK_REL)}.reclaim`;
  assert.equal(fs.existsSync(claim), false, '释放命令放掉了占位');
  const got = spawnSync('sh', ['-c', `cd "$HOME" || exit 9\n${toLinkLockScript(DEPLOY_LOCK_REL)}`], { input: newLockText, encoding: 'utf8', env: { ...process.env, HOME: w.home } });
  assert.equal(got.status, 0, got.stderr);
  assert.equal(fs.readFileSync(path.join(w.home, DEPLOY_LOCK_REL), 'utf8'), newLockText, '新部署的锁在,没有被误删');
  // 之后再来的回收者看到的是新锁:持有者还在就什么都不动。
  assert.equal(w.run((lock) => lock.pid === 60001).action, 'keep');
  assert.equal(fs.readFileSync(path.join(w.home, DEPLOY_LOCK_REL), 'utf8'), newLockText);
});

test('回收者占着占位时释放命令不删锁:等不到占位就以退出码 3 报「锁还在」', (t) => {
  const w = setup(t);
  const lockFile = path.join(w.home, DEPLOY_LOCK_REL);
  fs.linkSync(lockFile, `${lockFile}.reclaim`); // 回收者在手
  const r = spawnSync('sh', ['-c', `cd "$HOME" || exit 9\n${toReleaseLockScript(DEPLOY_LOCK_REL)}`], { input: LOCK_TEXT, encoding: 'utf8', env: { ...process.env, HOME: w.home } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /一直被占着/);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), LOCK_TEXT, '锁没被动');
  assert.equal(fs.existsSync(`${lockFile}.reclaim`), true, '别人的占位没被释放命令放掉');
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
