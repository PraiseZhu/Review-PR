import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as scope from './scope.mjs';

const { splitDiffByFile, filePatchHashes, computeReviewScope, previousFromResult } = scope;

// 文本文件 diff:index 右侧是文件新内容的 blob 编号(blob 默认 abbrev 可更长,v2 只取前 7 位)。
const textDiff = ({ right = 'aaaaaaa', hunk = '@@ -10,3 +10,4 @@', mode = '', added = '+added', ctx = ' keep' } = {}) => [
  'diff --git a/src/a.ts b/src/a.ts',
  ...(mode ? mode.split('\n') : []),
  `index 1111111..${right} 100644`,
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  `${hunk} export function a() {`,
  ctx, added, ' tail',
].join('\n');
const binaryDiff = (right) => [
  'diff --git a/img/x.png b/img/x.png',
  `index 1111111..${right} 100644`,
  'Binary files a/img/x.png and b/img/x.png differ',
].join('\n');
const v1 = (diffText, path) => splitDiffByFile(diffText)[path].hash;
const v2 = (diffText, path) => splitDiffByFile(diffText)[path].hashV2;

test('SC1 只挪位置:+行内容不变、文件新内容编号变 → v2 不同,v1 仍相同(这是漏审的来源)', () => {
  const a = textDiff({ right: 'aaaaaaa' });
  const b = textDiff({ right: 'bbbbbbb', ctx: ' other-context' });
  assert.equal(v1(a, 'src/a.ts'), v1(b, 'src/a.ts'));
  assert.ok(v2(a, 'src/a.ts'), '每个文件对象要有 hashV2');
  assert.notEqual(v2(a, 'src/a.ts'), v2(b, 'src/a.ts'));
});

test('SC2 只改权限:只有 mode 行变化 → v2 不同', () => {
  const none = textDiff({ added: '+added' });
  const exec = textDiff({ mode: 'old mode 100644\nnew mode 100755' });
  assert.equal(v1(none, 'src/a.ts'), v1(exec, 'src/a.ts'));
  assert.notEqual(v2(none, 'src/a.ts'), v2(exec, 'src/a.ts'));
  const modeOnly = (mode) => ['diff --git a/run.sh b/run.sh', mode].join('\n');
  assert.notEqual(v2(modeOnly('new mode 100755'), 'run.sh'), v2(modeOnly('new mode 100644'), 'run.sh'));
  const created = (mode) => ['diff --git a/n.sh b/n.sh', `new file mode ${mode}`, 'index 0000000..abcdef1', '--- /dev/null', '+++ b/n.sh', '@@ -0,0 +1,1 @@', '+x'].join('\n');
  assert.notEqual(v2(created('100644'), 'n.sh'), v2(created('100755'), 'n.sh'));
});

test('SC3 换二进制:Binary files 行相同、index 右侧编号不同 → v2 不同', () => {
  assert.equal(v1(binaryDiff('aaaaaaa'), 'img/x.png'), v1(binaryDiff('bbbbbbb'), 'img/x.png'));
  assert.notEqual(v2(binaryDiff('aaaaaaa'), 'img/x.png'), v2(binaryDiff('bbbbbbb'), 'img/x.png'));
});

test('SC4 行号漂移:base 前移、内容和编号都没变 → v2 相同;编号只看前 7 位', () => {
  const a = textDiff();
  const shifted = textDiff({ hunk: '@@ -40,3 +40,4 @@' });
  assert.ok(v2(a, 'src/a.ts'), '每个文件对象要有 hashV2');
  assert.equal(v2(a, 'src/a.ts'), v2(shifted, 'src/a.ts'));
  assert.equal(v2(textDiff({ right: 'aaaaaaa1234' }), 'src/a.ts'), v2(textDiff({ right: 'aaaaaaa9999' }), 'src/a.ts'));
});

test('v1 计算结果与改动前逐字节一致(固定样例)', () => {
  const diffText = textDiff();
  const body = ['+added'].join('\n');
  assert.equal(v1(diffText, 'src/a.ts'), createHash('sha256').update(body).digest('hex'));
  const bin = binaryDiff('aaaaaaa');
  assert.equal(v1(bin, 'img/x.png'), createHash('sha256').update('Binary files a/img/x.png and b/img/x.png differ').digest('hex'));
});

test('filePatchHashesV2 导出:按路径排序的 { path: hashV2 }', () => {
  assert.equal(typeof scope.filePatchHashesV2, 'function');
  const files = splitDiffByFile(`${textDiff()}\n${binaryDiff('aaaaaaa')}`);
  assert.deepEqual(scope.filePatchHashesV2(files), { 'img/x.png': files['img/x.png'].hashV2, 'src/a.ts': files['src/a.ts'].hashV2 });
  assert.deepEqual(Object.keys(filePatchHashes(files)), ['img/x.png', 'src/a.ts']);
});

const mkCurrent = (diffText, over = {}) => {
  const files = splitDiffByFile(diffText);
  return {
    head: 'h1', baseRefName: 'main', diffHash: 'd1', filePatchHashes: filePatchHashes(files), filePatchHashesV2: scope.filePatchHashesV2?.(files),
    fileChangedLines: Object.fromEntries(Object.entries(files).map(([p, f]) => [p, f.changedLines])), totalDiffLines: 100,
    tier: 'standard', triggerKinds: [], specDigest: 'spec-1', now: Date.parse('2026-10-11T12:00:00Z'), ...over,
  };
};
const mkPrevious = (diffText, over = {}) => {
  const files = splitDiffByFile(diffText);
  return {
    head: 'h0', baseRefName: 'main', diffHash: 'd0', reviewed: true, reportComplete: true, outcome: 'review-only', reviewClean: true, findings: [],
    filePatchHashes: filePatchHashes(files), filePatchHashesV2: scope.filePatchHashesV2?.(files), totalDiffLines: 100,
    tier: 'standard', triggerKinds: [], specDigest: 'spec-1', lastFullReviewAt: '2026-10-10T12:00:00Z', ...over,
  };
};
const two = (rightA) => `${textDiff({ right: rightA })}\n${binaryDiff('ccccccc')}`;

test('范围:双方都有 v2 → 按 v2 比,只挪位置的文件进入增量范围,没变的文件不进', () => {
  const result = computeReviewScope({ previous: mkPrevious(two('aaaaaaa')), current: mkCurrent(two('bbbbbbb')), headIsDescendant: true });
  assert.equal(result.mode, 'incremental');
  assert.deepEqual(result.files, ['src/a.ts']);
  assert.deepEqual(result.changedFiles, ['src/a.ts']);
});

test('SC5 过渡:上一轮只有 v1 → 按 v1 比较,结果与改动前一致,不会因 v2 缺失全文件算变', () => {
  const prevV1Only = mkPrevious(two('aaaaaaa'), { filePatchHashesV2: undefined });
  const same = computeReviewScope({ previous: prevV1Only, current: mkCurrent(two('bbbbbbb')), headIsDescendant: true });
  assert.equal(same.mode, 'reuse', 'v1 看不出变化,按 v1 比就是沿用');
  const changed = computeReviewScope({ previous: prevV1Only, current: mkCurrent(two('aaaaaaa').replace('+added', '+changed')), headIsDescendant: true });
  assert.equal(changed.mode, 'incremental');
  assert.deepEqual(changed.files, ['src/a.ts']);
  const emptyV2 = computeReviewScope({ previous: mkPrevious(two('aaaaaaa'), { filePatchHashesV2: {} }), current: mkCurrent(two('aaaaaaa')), headIsDescendant: true });
  assert.equal(emptyV2.mode, 'reuse', '上一轮 v2 为空对象也按 v1');
});

test('previousFromResult 读 result.mivo.filePatchHashesV2;没有时为 null', () => {
  const base = { head: 'h', reviewed: true, outcome: 'review-only', mivo: { reportComplete: true, filePatchHashes: { 'a.ts': 'x' } } };
  assert.equal(previousFromResult(base, '').filePatchHashesV2, null);
  assert.deepEqual(previousFromResult({ ...base, mivo: { ...base.mivo, filePatchHashesV2: { 'a.ts': 'y' } } }, '').filePatchHashesV2, { 'a.ts': 'y' });
});
