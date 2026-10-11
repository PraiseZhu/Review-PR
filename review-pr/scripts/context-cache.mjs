// Only immutable code material may survive a context refresh. Never cache gates,
// approvals, comments, threads, CI, labels, or metadata used to decide writes.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const validFiles = (files) => Array.isArray(files) && files.every((f) =>
  typeof f?.path === 'string' && f.path.length > 0 &&
  Number.isInteger(f.additions) && f.additions >= 0 && Number.isInteger(f.deletions) && f.deletions >= 0);
const filesHash = (files) => sha256(JSON.stringify(files.map(({ path, additions, deletions }) => ({ path, additions, deletions }))));

export function sameCodeRevision(before, after) {
  return !!before?.headRefOid && !!before?.baseRefOid && !!before?.baseRefName &&
    before.headRefOid === after?.headRefOid && before.baseRefOid === after?.baseRefOid &&
    before.baseRefName === after?.baseRefName;
}

export function writeDiffFile(file, diff) {
  if (!isAbsolute(file)) throw new Error('diff evidence 必须使用绝对路径');
  if (typeof diff !== 'string') throw new Error('diff evidence 内容无效');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, diff, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function createContextEvidence({ repo, pr, meta, files, diff, diffFile = null, observedAt = new Date().toISOString() }) {
  if (!repo || !Number.isInteger(pr) || !sameCodeRevision(meta, meta) || !validFiles(files) || typeof diff !== 'string') {
    throw new Error('context 缺少可绑定 head/base 的完整 diff/files');
  }
  if (diffFile != null && !isAbsolute(diffFile)) throw new Error('diff evidence 必须使用绝对路径');
  return { version: 1, repo, pr, head: meta.headRefOid, base: meta.baseRefOid, baseRefName: meta.baseRefName,
    diffHash: sha256(diff), filesHash: filesHash(files), diffFile, observedAt };
}

export function loadCachedCode(contextFile, { repo, pr, meta, readFile = readFileSync } = {}) {
  const miss = (reason) => ({ reused: false, reason });
  if (!contextFile) return miss('not-requested');
  let context;
  try { context = JSON.parse(readFile(resolve(contextFile), 'utf8')); }
  catch { return miss('context-unreadable'); }
  const evidence = context?.evidence;
  if (context?.ok !== true || context?.scan === true || evidence?.version !== 1 ||
      evidence.repo !== repo || evidence.pr !== pr || context.pr !== pr) return miss('context-binding-mismatch');
  if (!sameCodeRevision(meta, context.meta) || evidence.head !== meta.headRefOid ||
      evidence.base !== meta.baseRefOid || evidence.baseRefName !== meta.baseRefName) return miss('revision-changed');
  if (!validFiles(context.files) || evidence.filesHash !== filesHash(context.files)) return miss('files-integrity-mismatch');
  if (typeof evidence.diffFile !== 'string' || !isAbsolute(evidence.diffFile)) return miss('diff-file-missing');
  let diff;
  try { diff = readFile(evidence.diffFile, 'utf8'); }
  catch { return miss('diff-unreadable'); }
  if (typeof diff !== 'string' || sha256(diff) !== evidence.diffHash) return miss('diff-integrity-mismatch');
  // Deliberately return no other cached context fields. Mutable state is always
  // collected and evaluated by the same context.mjs gate implementation.
  return { reused: true, reason: 'same-head-base', diff, files: context.files.map(({ path, additions, deletions }) =>
    ({ path, additions, deletions })), diffFile: evidence.diffFile };
}
