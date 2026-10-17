import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const writeSecond = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
};

export function selfWriteChainMatches(receipts, baseline, current, head) {
  const start = writeSecond(baseline);
  const target = writeSecond(current);
  if (start === null || target === null || !Array.isArray(receipts)) return false;
  const edges = receipts.filter((receipt) => receipt?.head === head &&
    writeSecond(receipt.beforeUpdatedAt) !== null && writeSecond(receipt.updatedAt) !== null &&
    writeSecond(receipt.updatedAt) >= writeSecond(receipt.beforeUpdatedAt));
  const reachable = new Set([start]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const receipt of edges) {
      const before = writeSecond(receipt.beforeUpdatedAt);
      const after = writeSecond(receipt.updatedAt);
      if (!reachable.has(before)) continue;
      if (after === target) return true;
      if (!reachable.has(after)) { reachable.add(after); changed = true; }
    }
  }
  return false;
}

function receiptFile({ directory, repo, pr, head, scope }) {
  if (!directory || !repo || !Number.isSafeInteger(pr) || pr < 1 || !/^[0-9a-f]{40}$/.test(head ?? '') || !scope) return null;
  const key = createHash('sha256').update(JSON.stringify([repo, pr, head, scope])).digest('hex');
  return join(directory, `${key}.jsonl`);
}

function targetsPr(args, { repo, pr }) {
  if (args[0] === 'api') {
    const mutation = args.some((arg) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(arg)) ||
      !args.includes('GET') && args.some((arg) => ['-f', '-F', '--input'].includes(arg));
    return mutation && args.some((arg) =>
      ['issues', 'pulls'].some((kind) => arg === `repos/${repo}/${kind}/${pr}` || arg.startsWith(`repos/${repo}/${kind}/${pr}/`)));
  }
  return args[0] === 'pr' && ['comment', 'edit', 'review', 'merge'].includes(args[1]) && args.includes(String(pr));
}

export function recordSelfWrite(options) {
  try {
    const { args, result, startedAt, finishedAt, repo, pr, head, beforeUpdatedAt, beforeObservedAt } = options;
    const file = receiptFile(options);
    if (!file || !result?.ok || !targetsPr(args, options) || writeSecond(beforeUpdatedAt) === null) return false;
    const start = writeSecond(startedAt);
    const finish = writeSecond(finishedAt);
    if (start === null || finish === null || start > finish) return false;
    let response;
    try { response = JSON.parse(result.stdout); } catch { response = null; }
    const event = response?.updated_at ?? response?.submitted_at ?? response?.created_at;
    const second = event ? writeSecond(event) : start === finish ? start : null;
    if (second === null || second < start || second > finish || second < writeSecond(beforeUpdatedAt) ||
        second !== writeSecond(beforeObservedAt)) return false;
    const receipt = { repo, pr, head, beforeUpdatedAt, updatedAt: new Date(second * 1000).toISOString() };
    mkdirSync(options.directory, { recursive: true });
    appendFileSync(file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

export function readSelfWrites(options) {
  try {
    const file = receiptFile(options);
    if (!file) return [];
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    return rows.filter((row) => row.repo === options.repo && row.pr === options.pr && row.head === options.head &&
      writeSecond(row.beforeUpdatedAt) !== null && writeSecond(row.updatedAt) !== null);
  } catch { return []; }
}
