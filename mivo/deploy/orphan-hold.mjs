// 孤儿停点回收(PraiseZhu/Review-PR#205):在 Mini 上读本机文件,换版本进程已死且没切任何东西时,撤掉它留下的
// 停点、部署锁、巡检暂停。判定规则在 tuple-lib.mjs 的 toOrphanDecision(纯函数);这里只负责读文件、认进程、删文件。
// 调用方:round.mjs(发现停点时)和 auto-update.mjs(执行模式,拿锁换版本之前)。其它实例、其它目录一律不动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOSTS, DEPLOY_LOCK_REL, parseDeployLock, toOrphanDecision } from './tuple-lib.mjs';

export const RECORD_DIR_REL = 'Library/Logs/mivo-prereview/deploy';
export const MONITOR_PAUSE_REL = 'mivo-prereview/monitor/scripts/schedule-checks/pause-until.json';
const HOLD_NAME = 'deploy-hold.json';
const QUIESCED_NAME = 'quiesced.json';
const RECORDS_SCANNED = 50;

// helpers
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// 锁持有进程还在不在:true / false / null(查不了)。锁写的主机不是 Mini(Pro 上跑的换版本)在这里查不了;
// pid 还在但命令行不是 deploy-tuple,说明 pid 被别的进程复用了,原进程已经不在。
export function isLockHolderAlive(lock, { run = spawnSync } = {}) {
  if (lock?.host !== HOSTS.mini) return null;
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r = run('ps', ['-p', String(pid), '-ww', '-o', 'command='], { encoding: 'utf8', timeout: 10_000 });
  if (r.error || r.status == null) return null;
  if (r.status !== 0) return r.status === 1 ? false : null;
  return /deploy-tuple/.test(String(r.stdout));
}

// 找这次部署的记录:记录里的 lockText 和锁原文逐字相同。只看最新的 50 份。
function findRecord(recordDir, lockText) {
  let names;
  try {
    names = fs.readdirSync(recordDir).filter((n) => /^deploy-.*\.record\.json$/.test(n)).sort().reverse().slice(0, RECORDS_SCANNED);
  } catch {
    return null;
  }
  for (const name of names) {
    const record = parseJson(readText(path.join(recordDir, name)) ?? '');
    if (record?.lockText === lockText) return record;
  }
  return null;
}

// dir 是 <stateDir>/mivo(放 deploy-hold.json、deploy-tuple.lock 的目录)。返回 { action, reason, removed? }:
// none(没有锁)、keep(持有者还在)、alert(不能自动撤,reason 写明原因)、revoke(已撤,removed 列出撤掉的文件)。
export function reconcileOrphanHold({ dir, home = os.homedir(), isAlive = isLockHolderAlive, recordDir = path.join(home, RECORD_DIR_REL) }) {
  // 只处理线上那一套状态目录,测试、沙盒实例的目录不碰。
  if (path.resolve(dir) !== path.resolve(home, path.dirname(DEPLOY_LOCK_REL))) return { action: 'none', reason: '不是线上状态目录' };
  const lockFile = path.join(dir, path.basename(DEPLOY_LOCK_REL));
  const lockText = readText(lockFile);
  const lock = lockText == null ? null : parseDeployLock(lockText);
  const holdFile = path.join(dir, HOLD_NAME);
  const holdText = readText(holdFile);
  const hold = { exists: holdText != null, text: holdText };
  const record = lock ? findRecord(recordDir, lockText) : null;
  const decision = toOrphanDecision({ lock, lockText, hold, alive: lock ? isAlive(lock) : null, record });
  if (decision.action !== 'revoke') return decision;

  const removed = [];
  const remove = (file) => {
    fs.rmSync(file, { force: true });
    removed.push(file);
  };
  if (decision.remove.hold) remove(holdFile);
  if (decision.remove.quiesced) remove(path.join(dir, QUIESCED_NAME));
  if (decision.remove.monitorPause) {
    // 只撤本次部署写的那份维护标记(原因里带目标提交前 7 位);别人写的不动。
    const pauseFile = path.join(home, MONITOR_PAUSE_REL);
    const pause = parseJson(readText(pauseFile) ?? '');
    if (pause?.reason === `新审查机整组上线 ${String(lock.target ?? '').slice(0, 7)}`) remove(pauseFile);
  }
  // 锁最后撤,并且内容没变才删:前面任何一步抛错,锁还在,下次还会再进来收拾。
  if (decision.remove.lock && readText(lockFile) === lockText) remove(lockFile);
  return { ...decision, removed };
}
