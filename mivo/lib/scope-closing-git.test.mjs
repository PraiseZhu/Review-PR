// 链式收口(#262)用真实 git 仓核对「两个版本之间真实改了多少行」:
// 作者在上一版之后合并了主干、又改了几行。主干带进来的文件不算本 PR 的改动;大文件里改 3 行按 6 行算,不按整份补丁 200 行算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { splitDiffByFile, filePatchHashes, filePatchHashesV2, computeReviewScope, parseNumstat, toDeltaLinesByFile } from './scope.mjs';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' };
const CHAIN = { mode: 'chain', maxIncrementalRounds: 2, maxChangedLines: 400 };
const lines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

function buildRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'mivo-closing-git-'));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const write = (path, content) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); };
  git('init', '-q', '-b', 'main');
  write('src/big.ts', lines('line', 300));
  write('src/other.ts', lines('other', 50));
  git('add', '.'); git('commit', '-q', '-m', 'base');
  // 上一版(H0):PR 往 big.ts 加 200 行,加 10 行交接文件 → 整份 PR diff 210 行。
  git('checkout', '-q', '-b', 'pr');
  write('src/big.ts', lines('line', 300) + lines('new', 200));
  write('docs/pr/7/review.md', lines('risk', 10));
  git('add', '.'); git('commit', '-q', '-m', 'pr round 1');
  const h0 = git('rev-parse', 'HEAD').trim();
  const diff0 = git('diff', 'main...pr');
  // 主干前进:other.ts 50 行全改(与本 PR 无关)。
  git('checkout', '-q', 'main');
  write('src/other.ts', lines('changed', 50));
  git('add', '.'); git('commit', '-q', '-m', 'main moves');
  // 本版(H1):合并主干;big.ts 新增的 200 行里改 3 行;交接文件改 2 行;加一个二进制文件和一个带空格的中文文件名(5 行)。
  git('checkout', '-q', 'pr');
  git('merge', '-q', '--no-edit', 'main');
  write('src/big.ts', lines('line', 300) + lines('new', 200).replace('new 7\n', 'fixed 7\n').replace('new 80\n', 'fixed 80\n').replace('new 150\n', 'fixed 150\n'));
  write('docs/pr/7/review.md', lines('risk', 10).replace('risk 2\n', 'risk two\n').replace('risk 9\n', 'risk nine\n'));
  write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff]));
  write('docs/说明 文档.md', lines('说明', 5));
  git('add', '.'); git('commit', '-q', '-m', 'pr round 2');
  const h1 = git('rev-parse', 'HEAD').trim();
  const diff1 = git('diff', 'main...pr');
  const numstat = git('diff', '--numstat', '--no-renames', '-z', h0, h1);
  return { repo, h0, h1, diff0, diff1, numstat };
}

test('SC3 真实 git:合并主干后小改 → numstat 只算本 PR 的文件;链式判增量(15 行),旧口径算成 215 行判全量', () => {
  const { repo, h0, h1, diff0, diff1, numstat } = buildRepo();
  try {
    // 两个版本之间:主干带进来的 other.ts(50 删 + 50 增)也在 numstat 里,但不是本 PR 的改动。
    const all = parseNumstat(numstat);
    assert.equal(all['src/other.ts'], 100);
    const before = splitDiffByFile(diff0);
    const after = splitDiffByFile(diff1);
    assert.deepEqual(Object.keys(after).sort(), ['assets/logo.png', 'docs/pr/7/review.md', 'docs/说明 文档.md', 'src/big.ts'], '主干的 other.ts 不在 PR diff 里');
    const deltaLinesByFile = toDeltaLinesByFile(numstat, [...Object.keys(after), ...Object.keys(before)]);
    // 手算:big.ts 改 3 行 = 3 删 + 3 增;review.md 改 2 行 = 2 删 + 2 增;中文文件新增 5 行;二进制没有行数。
    assert.deepEqual(deltaLinesByFile, { 'src/big.ts': 6, 'docs/pr/7/review.md': 4, 'docs/说明 文档.md': 5, 'assets/logo.png': null });

    const fileChangedLines = Object.fromEntries(Object.entries(after).map(([path, f]) => [path, f.changedLines]));
    assert.deepEqual(fileChangedLines, { 'src/big.ts': 200, 'docs/pr/7/review.md': 10, 'docs/说明 文档.md': 5, 'assets/logo.png': 0 }, '旧口径:每个文件在整个 PR 里的补丁行数');
    const previous = { head: h0, baseRefName: 'main', diffHash: 'd0', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: false,
      findings: [{ path: 'src/big.ts', line: 307, body: '[P2] 旧问题', key: 'k1', severity: 'P2' }], deferred: [],
      filePatchHashes: filePatchHashes(before), filePatchHashesV2: filePatchHashesV2(before), totalDiffLines: 210, tier: 'standard', triggerKinds: [],
      specDigest: 'spec-1', lastFullReviewAt: '2026-11-26T12:00:00Z', sinceFull: { head: h0, runId: '41', totalDiffLines: 210, rounds: 0, changedLines: 0 } };
    const current = { head: h1, baseRefName: 'main', diffHash: 'd1', filePatchHashes: filePatchHashes(after), filePatchHashesV2: filePatchHashesV2(after),
      fileChangedLines, deltaLinesByFile, totalDiffLines: 215, tier: 'standard', triggerKinds: [], specDigest: 'spec-1', now: Date.parse('2026-11-27T12:00:00Z') };

    const chain = computeReviewScope({ previous, current, headIsDescendant: true, closing: CHAIN });
    assert.equal(chain.mode, 'incremental', chain.reason);
    assert.deepEqual(chain.files, ['assets/logo.png', 'docs/pr/7/review.md', 'docs/说明 文档.md', 'src/big.ts']);
    assert.deepEqual(chain.closing, { skipFinalFull: true, basedOn: { head: h0, runId: '41' }, anchorTotalDiffLines: 210, rounds: 1, changedLines: 15, deltaLines: 15 });

    const legacy = computeReviewScope({ previous, current, headIsDescendant: true });
    assert.equal(legacy.mode, 'full');
    assert.match(legacy.reason, /变化行数 215 超过上一版 diff\(210 行\)的一半/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
