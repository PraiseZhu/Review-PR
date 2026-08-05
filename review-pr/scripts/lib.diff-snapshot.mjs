#!/usr/bin/env node
// lib.diff-snapshot.mjs — 共享 DiffSnapshot 底座(SC-R8,2026-08-05 SC v4 共识)。
//
// 目的:security 扫描、preflight(SC-R2)、覆盖 manifest(SC-R4)、negativeEvidence 锚点
// (SC-R6)全部消费**同一份** diff 快照——消灭"各自抓 gh pr diff 的多份跨 head 快照"。
// patch 由已 fetch 的 **immutable git objects** 生成(git diff <mergeBase> <head>),
// 不吃可变工作树、不吃可被并发 push change 的 ref 名。
//
// 身份四元组:{baseRefOid, mergeBaseOid, headOid, diffDigest} → snapshotHash。
// 绑定 snapshotHash 而非裸 head 的原因(第 2 轮共识):base 前进而 head 不变时,
// mergeBase/diff 都会变——旧证据不得仍算新鲜。
//
// fail 方向:对象缺失 / merge-base 算不出 / patch 解析异常 / 与调用方提供的 PR 文件
// 元数据(expectedPaths)对不上 → complete=false;全部消费方 fail-closed(R1 invalid,
// pre-merge 拒),绝不静默降级。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import process from 'node:process';

const isWin = process.platform === 'win32';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function git(args, { cwd, timeoutMs = 60_000 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: isWin, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function computeSnapshotHash({ baseRefOid, mergeBaseOid, headOid, diffDigest }) {
  return `snap1-${sha(`${baseRefOid}|${mergeBaseOid}|${headOid}|${diffDigest}`)}`;
}

/** --raw -z 输出解析:每条记录 ":oldMode newMode oldOid newOid status\0path[\0path2]"。 */
function parseRawZ(raw) {
  const entries = [];
  const parts = raw.split('\0').filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i += 1) {
    const meta = parts[i];
    if (!meta.startsWith(':')) return null; // 形状异常,整体判不完整
    const m = meta.match(/^:(\d{6}) (\d{6}) [0-9a-f]+\.* [0-9a-f]+\.* ([A-Z])(\d*)$/);
    if (!m) return null;
    const [, oldMode, newMode, letter] = m;
    const twoPath = letter === 'R' || letter === 'C';
    const p1 = parts[i + 1];
    const p2 = twoPath ? parts[i + 2] : null;
    if (p1 == null || (twoPath && p2 == null)) return null;
    i += twoPath ? 2 : 1;
    entries.push({ oldMode, newMode, letter, oldPath: twoPath ? p1 : (letter === 'A' ? null : p1), newPath: twoPath ? p2 : (letter === 'D' ? null : p1) });
  }
  return entries;
}

const CHANGE_TYPES = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type-change' };

/** 从整份 patch 里切出每个文件段(diff --git 分界)并解析 hunk 头。 */
function parsePatchFiles(rawPatch) {
  const out = new Map(); // key = newPath ?? oldPath(删除项用 oldPath)
  if (!rawPatch.trim()) return out;
  const segments = rawPatch.split(/^diff --git /m).filter((s) => s.trim().length > 0);
  for (const seg of segments) {
    const isBinary = /^Binary files .* differ$/m.test(seg) || /^GIT binary patch$/m.test(seg);
    const hunks = [];
    const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm;
    let m;
    let idx = 0;
    const matches = [];
    while ((m = re.exec(seg)) !== null) matches.push({ m, bodyStart: m.index + m[0].length });
    matches.forEach((entry, i) => {
      const mm = entry.m;
      const oldStart = Number(mm[1]); const oldLines = mm[2] == null ? 1 : Number(mm[2]);
      const newStart = Number(mm[3]); const newLines = mm[4] == null ? 1 : Number(mm[4]);
      // addedNewLines:**真正新增/修改的 head 行号**(以 `+` 开头的行),不是 hunk 范围。
      // 归因(SC-R2)必须用它:hunk 范围含 3 行上下文,拿它判定会把"邻近有人改了一行"
      // 误判成"本次引入了这处旧命中",反过来打回无关作者(实测踩到)。
      const bodyEnd = i + 1 < matches.length ? matches[i + 1].m.index : seg.length;
      const body = seg.slice(entry.bodyStart, bodyEnd).split('\n').slice(1);
      const addedNewLines = [];
      let cursor = newStart;
      for (const line of body) {
        if (line.startsWith('+')) { addedNewLines.push(cursor); cursor += 1; }
        else if (line.startsWith('-')) { /* 删除行不占 head 行号 */ }
        else if (line.startsWith('\\')) { /* \ No newline at end of file */ }
        else { cursor += 1; } // 上下文行
      }
      hunks.push({
        index: idx, header: mm[0], oldRanges: [oldStart, oldLines], newRanges: [newStart, newLines], addedNewLines,
        // SC-R4 第 4 轮核验:分段投递必须投**可审查的内容**——每段 payload 要带该 hunk 的
        // immutable patch 文本(否则 opaque key 根本没法审对应代码)。文本切自 rawPatch,
        // 不参与 fileId/hunkId/snapshotHash 计算(它们只依赖 diffDigest 与 header)。
        patchText: `${mm[0]}\n${seg.slice(entry.bodyStart, bodyEnd).replace(/^\n/, '')}`,
      });
      idx += 1;
    });
    // 路径:优先 +++ b/<path>(删除文件为 /dev/null,则取 --- a/<path>)
    const plus = seg.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/m);
    const minus = seg.match(/^--- (?:a\/(.*)|\/dev\/null)$/m);
    const newPath = plus?.[1] ?? null;
    const oldPath = minus?.[1] ?? null;
    const key = newPath ?? oldPath;
    if (key == null) {
      // 纯 mode-change/rename 无 ---/+++ 行:从段首 "a/x b/x" 提取
      const head = seg.split('\n', 1)[0].trim();
      const hm = head.match(/^a\/(.+?) b\/(.+)$/);
      if (!hm) return null;
      out.set(hm[2], { isBinary, hunks });
      continue;
    }
    out.set(key, { isBinary, hunks });
  }
  return out;
}

/**
 * 从 immutable git objects 构建 DiffSnapshot。
 * @param {object} p { repoRoot, baseRefOid, headOid, fetchMissing=true, expectedPaths=null }
 *   expectedPaths:调用方从 PR 元数据拿到的 changed files 路径清单(可选)——与 patch
 *   文件集做对账,不一致 → complete=false(元数据/patch 截断互检)。
 */
export function buildDiffSnapshot({ repoRoot, baseRefOid, headOid, fetchMissing = true, expectedPaths = null }) {
  const fail = (reason) => ({ complete: false, reason, baseRefOid, headOid, mergeBaseOid: null, diffDigest: null, snapshotHash: null, files: [] });
  if (!/^[0-9a-f]{40}$/.test(baseRefOid ?? '') || !/^[0-9a-f]{40}$/.test(headOid ?? '')) return fail('base/head oid 缺失或非法');
  const cwd = repoRoot;
  const has = (oid) => git(['cat-file', '-e', `${oid}^{commit}`], { cwd }).ok;
  if ((!has(baseRefOid) || !has(headOid)) && fetchMissing) {
    git(['fetch', '--quiet', 'origin', baseRefOid, headOid], { cwd, timeoutMs: 120_000 });
  }
  if (!has(baseRefOid) || !has(headOid)) return fail('git objects 缺失(fetch 后仍取不到 base/head commit)');
  const mb = git(['merge-base', baseRefOid, headOid], { cwd });
  const mergeBaseOid = mb.ok ? mb.stdout.trim() : null;
  if (!mergeBaseOid || !/^[0-9a-f]{40}$/.test(mergeBaseOid)) return fail('merge-base 计算失败');

  const rawR = git(['diff', '--raw', '-z', '-M', '-C', mergeBaseOid, headOid], { cwd });
  const patchR = git(['diff', '--patch', '-M', '-C', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', mergeBaseOid, headOid], { cwd });
  if (!rawR.ok || !patchR.ok) return fail('git diff 执行失败');
  const rawEntries = parseRawZ(rawR.stdout);
  if (rawEntries === null) return fail('--raw 元数据解析失败');
  const patchFiles = parsePatchFiles(patchR.stdout);
  if (patchFiles === null) return fail('patch 解析失败');

  const rawPatch = patchR.stdout;
  const diffDigest = `dd1-${sha(rawPatch)}`;
  const files = [];
  for (const e of rawEntries) {
    const keyPath = e.newPath ?? e.oldPath;
    const changeType = CHANGE_TYPES[e.letter];
    if (!changeType) return fail(`未知 change 类型 ${e.letter}`);
    const seg = patchFiles.get(keyPath) ?? null;
    const isSubmodule = e.oldMode === '160000' || e.newMode === '160000';
    const contentKind = isSubmodule ? 'submodule' : (seg?.isBinary ? 'binary' : 'text');
    const fileId = `f1-${sha(`${diffDigest}|${e.oldPath ?? ''}|${e.newPath ?? ''}`).slice(0, 16)}`;
    const hunks = (seg?.hunks ?? []).map((h) => ({
      hunkId: `h1-${sha(`${diffDigest}|${keyPath}|${h.index}|${h.header}`).slice(0, 16)}`,
      oldRanges: h.oldRanges,
      newRanges: h.newRanges,
      addedNewLines: h.addedNewLines ?? [],
      patchText: h.patchText ?? '',
    }));
    files.push({
      fileId,
      oldPath: e.oldPath, newPath: e.newPath, changeType, contentKind,
      oldMode: e.oldMode === '000000' ? null : e.oldMode,
      newMode: e.newMode === '000000' ? null : e.newMode,
      hunks,
    });
  }
  // 与 PR 元数据对账(可选):patch 文件路径集 vs expectedPaths 集,不相等 → 不完整
  if (Array.isArray(expectedPaths)) {
    const got = new Set(files.map((f) => f.newPath ?? f.oldPath));
    const want = new Set(expectedPaths);
    const same = got.size === want.size && [...got].every((p) => want.has(p));
    if (!same) return fail(`PR 文件元数据与 patch 集不一致(patch=${got.size} 项, 元数据=${want.size} 项)`);
  }
  const snapshotHash = computeSnapshotHash({ baseRefOid, mergeBaseOid, headOid, diffDigest });
  return { complete: true, reason: null, baseRefOid, mergeBaseOid, headOid, diffDigest, snapshotHash, rawPatch, files };
}

/** 覆盖 coverage keys(SC-R4 消费):文本 hunk → hunk key;零 hunk/binary/submodule/mode-only → file key。 */
export function coverageKeysOf(snapshot) {
  const keys = [];
  for (const f of snapshot.files ?? []) {
    if (f.contentKind === 'text' && f.hunks.length > 0) {
      for (const h of f.hunks) keys.push({ kind: 'hunk', fileId: f.fileId, hunkId: h.hunkId });
    } else {
      keys.push({ kind: 'file', fileId: f.fileId });
    }
  }
  return keys;
}
