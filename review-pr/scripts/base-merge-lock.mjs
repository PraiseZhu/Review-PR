// Per-base Lamport bakery lock. Each participant owns a unique durable file, so
// stale cleanup never deletes a replacement owner's lock (no read/unlink CAS).
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { atomicWriteJson } from './runtime-io.mjs';

const localHost = hostname();
export function processIsAlive(owner) {
  if (owner.host !== localHost || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : null; }
}

export async function acquireBaseMergeLock({ directory, repo, baseRefName, pr, head,
  maxWaitMs = 30_000, pollMs = 500, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isAlive = processIsAlive, reconcileAbandoned = async () => false } = {}) {
  if (!directory || !repo || !baseRefName || !Number.isSafeInteger(pr) || !head) throw new Error('base merge lock 参数不完整');
  const key = createHash('sha256').update(`${repo.toLowerCase()}|${baseRefName}`).digest('hex').slice(0, 24);
  const root = join(directory, `merge-base-${key}`);
  mkdirSync(root, { recursive: true });
  const token = randomUUID();
  const file = join(root, `${token}.json`);
  let record = { version: 1, token, repo, baseRefName, pr, head, pid: process.pid, host: localHost,
    phase: 'choosing', ticket: 0, createdAt: new Date(now()).toISOString() };
  const write = (extra) => { record = { ...record, ...extra }; atomicWriteJson(file, record); };
  const remove = (path) => { try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  const participants = async () => {
    const rows = [];
    for (const name of readdirSync(root).filter((name) => /^[a-f0-9-]+\.json$/i.test(name))) {
      const path = join(root, name);
      let owner;
      try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw new Error('base merge lock 记录无法核验'); }
      if (owner.version !== 1 || name !== `${owner.token}.json` || owner.baseRefName !== baseRefName ||
          String(owner.repo).toLowerCase() !== repo.toLowerCase() || !Number.isSafeInteger(owner.ticket) || owner.ticket < 0) {
        throw new Error('base merge lock 归属记录异常');
      }
      if (owner.token !== token && isAlive(owner) === false) {
        if (owner.phase === 'merging' && !await reconcileAbandoned(owner)) {
          rows.push({ ...owner, unresolvedMutation: true });
        } else remove(path); // The filename is unique and will never be reused.
      } else rows.push(owner);
    }
    return rows;
  };
  const abandon = (code, reason, owner) => { remove(file); return { acquired: false, code, reason, owner }; };
  write({});
  try {
    const before = await participants();
    write({ ticket: Math.max(0, ...before.map((owner) => owner.ticket)) + 1, phase: 'waiting' });
    const start = now();
    for (;;) {
      const rows = await participants();
      const unknown = rows.find((owner) => owner.unresolvedMutation);
      if (unknown) return abandon('merge-reconciliation-pending', `PR #${unknown.pr} 的上次合并结果不明，必须先核验，不能并发重发`, unknown);
      const prior = rows.find((owner) => owner.token !== token && (owner.phase === 'choosing' ||
        owner.ticket < record.ticket || owner.ticket === record.ticket && owner.token < token));
      if (!prior) break;
      if (now() - start >= maxWaitMs) return abandon('base-merge-lock-busy', `base ${baseRefName} 正由另一条 PR 完成合并检查`, prior);
      await sleep(pollMs);
    }
    write({ phase: 'checking' });
    const assertOwned = ({ allowRejected = false } = {}) => {
      const owner = JSON.parse(readFileSync(file, 'utf8'));
      if (owner.token !== token || !['checking', 'merging', ...(allowRejected ? ['rejected'] : [])].includes(owner.phase)) throw new Error('base merge lock 已丢失');
      return owner;
    };
    return { acquired: true, token, baseRefName, file,
      assertOwned,
      markMerging: () => { assertOwned(); write({ phase: 'merging' }); },
      markRejected: (rejection) => {
        const owner = assertOwned();
        if (owner.phase !== 'merging' || rejection?.status !== 'rejected' ||
            rejection?.evidence?.operation !== 'mergePullRequest' || !rejection?.reason) throw new Error('缺少明确的合并拒写证据');
        write({ phase: 'rejected', rejection });
      },
      release: ({ confirmed = false } = {}) => {
        const owner = assertOwned({ allowRejected: true });
        if (owner.phase === 'merging' && !confirmed) return { released: false, pending: true, reason: '合并写入结果不明，保留记录供只读核验' };
        remove(file);
        return { released: true, pending: false };
      },
    };
  } catch (error) { remove(file); throw error; }
}
