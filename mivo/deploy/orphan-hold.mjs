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

// 并发协议(部署获取、部署释放、回收三方):
// - 部署只有两种动作:`ln` 新建锁(目标已存在则失败)和释放(内容和自己写的逐字相同才删)。锁文件名被一把锁占着的时候,
//   别的部署拿不到锁,也就不会写停点、握手回执、巡检暂停。
// - 回收者先给锁文件建硬链接 deploy-tuple.lock.reclaim,记下被钉住的 inode:同一时刻只有一个回收者(已存在则报警)。
//   硬链接只钉住 inode,拦不住部署释放(释放是 rm 路径),所以光占位不够。
// - 死锁判定之后(判活返回「已不在」),**再核对锁文件名下仍是被钉住的那个 inode**,通过之后才读停点和部署记录、才删东西:
//   进程已不在,它不会再释放或改任何文件;锁文件名仍被它的锁占着,别的部署拿不到锁、写不了新状态;别的回收者被占位挡着。
//   所以这之后读到的和要删的都是这次判定的那次部署留下的。判活期间锁被正常释放(或又被新部署拿走)的,inode 对不上,
//   一个文件都不动。核对放在判活之后、读取和删除之前,而不是删除之后。
// - 删除过程中每一步之前都再核对一次 inode;锁最后撤。
// 占位在 finally 里一定放掉;进程被强杀才会残留,残留时下次回收报警,手动删。
const CLAIM_SUFFIX = '.reclaim';
function claimLock(lockFile) {
  const claim = `${lockFile}${CLAIM_SUFFIX}`;
  try {
    fs.linkSync(lockFile, claim);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'none' };
    if (error.code === 'EEXIST') return { status: 'busy', claim };
    throw error;
  }
  return { status: 'claimed', claim };
}
const identityOf = (file) => {
  try {
    const st = fs.statSync(file);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
};

// dir 是 <stateDir>/mivo(放 deploy-hold.json、deploy-tuple.lock 的目录)。返回 { action, reason, removed? }:
// none(没有锁、判活期间锁换了人)、keep(持有者还在)、alert(不能自动撤,reason 写明原因)、revoke(已撤,removed 列出撤掉的文件)。
export function reconcileOrphanHold({ dir, home = os.homedir(), isAlive = isLockHolderAlive, recordDir = path.join(home, RECORD_DIR_REL) }) {
  // 只处理线上那一套状态目录,测试、沙盒实例的目录不碰。
  if (path.resolve(dir) !== path.resolve(home, path.dirname(DEPLOY_LOCK_REL))) return { action: 'none', reason: '不是线上状态目录' };
  const lockFile = path.join(dir, path.basename(DEPLOY_LOCK_REL));
  const claimed = claimLock(lockFile);
  if (claimed.status === 'none') return { action: 'none', reason: '没有部署锁' };
  if (claimed.status === 'busy') {
    return { action: 'alert', reason: `${path.basename(claimed.claim)} 已存在:另一个回收者正在处理;如果确认没有回收进程在跑,手动删掉它` };
  }
  try {
    const pinned = identityOf(claimed.claim);
    const owned = () => pinned != null && identityOf(lockFile) === pinned;
    const lockText = readText(claimed.claim);
    const lock = lockText == null ? null : parseDeployLock(lockText);
    const alive = lock ? isAlive(lock) : null;
    // 持有者还在、查不了、锁读不懂:不用读停点和记录,判定不会走到撤销。
    if (alive !== false) return toOrphanDecision({ lock, lockText, hold: { exists: false, text: null }, alive, record: null });
    // 判活期间持有者可能正常收尾(释放了锁)、新部署又拿了锁:锁文件名下不是被钉住的那把,就一个文件都不动。
    if (!owned()) return { action: 'none', reason: '判活期间部署锁已被释放或换了人,不动' };

    const holdFile = path.join(dir, HOLD_NAME);
    const holdText = readText(holdFile);
    const hold = { exists: holdText != null, text: holdText };
    const record = findRecord(recordDir, lockText);
    const decision = toOrphanDecision({ lock, lockText, hold, alive, record });
    if (decision.action !== 'revoke') return decision;

    const removed = [];
    const remove = (file) => {
      if (!owned()) throw new Error(`撤销过程中部署锁换了人,已撤 ${removed.length} 个文件,停止`);
      fs.rmSync(file, { force: true });
      removed.push(file);
    };
    if (decision.remove.hold) remove(holdFile);
    if (decision.remove.quiesced) remove(path.join(dir, QUIESCED_NAME));
    if (decision.remove.monitorPause) {
      // 只撤本次部署写的那份维护标记:内容和记录里的原文逐字相同(含 from 时间戳)。别人写的、别次部署写的不动。
      const pauseFile = path.join(home, MONITOR_PAUSE_REL);
      if (readText(pauseFile) === record.monitorPauseText) remove(pauseFile);
    }
    // 锁最后撤:前面任何一步抛错,锁还在,下次还会再进来收拾。
    if (decision.remove.lock) remove(lockFile);
    return { ...decision, removed };
  } finally {
    fs.rmSync(claimed.claim, { force: true });
  }
}
