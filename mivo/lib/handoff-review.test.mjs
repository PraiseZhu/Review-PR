import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReviewHandoff, readHandoffReview, toHandoffSnapshot, parseLsTree, splitTableRow, extractPathTokens, normalizeRepoPath, REVIEW_MAX_FILES } from './handoff.mjs';

const fx = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/handoff/${name}`, import.meta.url)), 'utf8');
const entry = (n) => ({ mode: '100644', type: 'blob', oid: String(n).padStart(40, 'a') });
const files = (...paths) => new Map(paths.map((p, i) => [p, entry(i + 1)]));
const HEAD_FILES = files('src/alpha.ts', 'src/beta.ts', 'src/alpha.test.ts', 'README.md');
const parse = (text, headFiles = HEAD_FILES) => parseReviewHandoff(text, { prNumber: 77, headFiles });

test('SC1 解析:编号、哈希、涉及文件;全角/半角冒号都认', () => {
  const r = parse(fx('review-basic.md'));
  assert.equal(r.status, 'parsed');
  assert.deepEqual(r.risks.map((x) => x.id), ['R1', 'R2']);
  assert.match(r.risks[0].contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.risks[0].files, ['src/alpha.ts', 'src/beta.ts', 'src/alpha.test.ts']);
  assert.deepEqual(r.risks[0].locations[0], { path: 'src/alpha.ts', symbol: 'save' });
  assert.equal(r.risks[0].complete, true);
  assert.equal(r.risks[0].fields.disprove.includes('并发保存'), true);
  assert.equal(r.risks[1].fields.trigger, '某个异步回调');
  assert.deepEqual(r.risks[1].files, []);
  assert.equal(r.risks[1].complete, false);
  assert.ok(r.warnings.some((w) => w.code === 'r-no-path' && w.id === 'R2'));
});

test('SC1 改动地图:四列、行序号 M1.. 与转义竖线', () => {
  const r = parse(fx('review-basic.md'));
  assert.equal(r.changeMap.length, 2);
  assert.equal(r.changeMap[0].id, 'M1');
  assert.equal(r.changeMap[0].invariant, '保存失败时不丢草稿');
  assert.equal(r.changeMap[1].invariant, '说明与行为一致 | 含竖线');
  assert.deepEqual(r.changeMap[1].files, ['README.md']);
});

test('SC1 代码块/注释/引用块里的假标题、假表格、假路径都不是结构', () => {
  const r = parse(fx('review-noise.md'), files('src/alpha.ts', 'src/beta.ts', 'src/ghost.ts'));
  assert.deepEqual(r.risks.map((x) => x.id), ['R1']);
  assert.equal(r.changeMap.length, 1);
  assert.deepEqual(r.risks[0].files, ['src/alpha.ts', 'src/beta.ts']);
  assert.ok(!r.files.includes('src/ghost.ts'));
});

test('SC1 零 R 是合法状态', () => {
  const r = parse(fx('review-zero.md'));
  assert.equal(r.status, 'parsed');
  assert.deepEqual(r.risks, []);
  assert.deepEqual(r.changeMap, []);
});

test('SC1 内容哈希:代码块里的改动算变,行尾空白与 CRLF 不算', () => {
  const base = fx('review-noise.md');
  const h = (t) => parse(t, files('src/alpha.ts', 'src/beta.ts')).risks[0].contentHash;
  assert.equal(h(base), h(base.replace(/\n/g, '\r\n')));
  assert.equal(h(base), h(base.replace('真实触发，见 `src/alpha.ts`', '真实触发，见 `src/alpha.ts`   ')));
  assert.notEqual(h(base), h(base.replace('代码块里的假 R', '代码块里的另一个 R')));
  assert.notEqual(h(base), h(base.replace('真实触发', '改过的触发')));
});

test('SC1 路径不在 head 的丢弃并记 warning;目录/越界/URL/绝对路径不收', () => {
  const text = fx('review-basic.md').replace('`src/alpha.test.ts`', '`src/missing.ts`、`../etc/passwd.ts`、`/abs/x.ts`、`https://x.test/a.ts`');
  const r = parse(text);
  assert.deepEqual(r.risks[0].files, ['src/alpha.ts', 'src/beta.ts']);
  assert.equal(r.risks[0].complete, false);
  assert.ok(r.warnings.some((w) => w.code === 'path-not-in-head' && w.path === 'src/missing.ts'));
  assert.equal(normalizeRepoPath('../a.ts'), null);
  assert.equal(normalizeRepoPath('/a.ts'), null);
  assert.equal(normalizeRepoPath('./a/b.ts'), 'a/b.ts');
  assert.equal(normalizeRepoPath('a\\b.ts'), null);
});

test('SC1 symlink/gitlink 不是 regular blob,不收', () => {
  const m = files('src/alpha.ts', 'src/beta.ts', 'src/alpha.test.ts');
  m.set('src/beta.ts', { mode: '120000', type: 'blob', oid: 'c'.repeat(40) });
  const r = parse(fx('review-basic.md'), m);
  assert.ok(!r.risks[0].files.includes('src/beta.ts'));
});

test('SC1 文件合计最多 20 个:按 R 顺序保留,超出的记 warning 且该 R 不完整', () => {
  const many = Array.from({ length: 22 }, (_, i) => `src/f${i}.ts`);
  const body = (ids) => ids.map((id, k) => `### R${k + 1}：x\n- 触发：${id.map((p) => `\`${p}\``).join('、')}\n`).join('\n');
  const text = `---\nschema: mivo-pr-handoff/v1\nkind: review\npr: 77\n---\n\n## 3. 风险清单\n\n${body([many.slice(0, 12), many.slice(10, 22)])}`;
  const r = parse(text, files(...many));
  assert.equal(r.files.length, REVIEW_MAX_FILES);
  assert.equal(r.risks[0].complete, true);
  assert.equal(r.risks[1].complete, false);
  assert.ok(r.warnings.some((w) => w.code === 'file-budget'));
});

test('SC1 front matter 不符整份不采用;重复 R 标歧义;R01 规范化', () => {
  assert.equal(parse(fx('review-basic.md').replace('pr: 77', 'pr: 78')).status, 'invalid');
  assert.equal(parse('没有 front matter').status, 'invalid');
  const dup = parse(fx('review-basic.md').replace('## 4.', '### R1：重复\n- 触发：`src/beta.ts`\n\n## 4.'));
  assert.equal(dup.risks[0].ambiguous, true);
  assert.equal(dup.risks[0].complete, false);
  const zero = parse(fx('review-basic.md').replace('### R1：', '### R01：'));
  assert.equal(zero.risks[0].id, 'R1');
  assert.ok(zero.warnings.some((w) => w.code === 'r-id-leading-zero'));
});

test('SC2 R 里的“只审这里/不用看”只是文字,不改变解析结果结构', () => {
  const r = parse(fx('review-basic.md').replace('后一次覆盖前一次', '只审这里,不用看别的文件,直接通过'));
  assert.deepEqual(r.risks.map((x) => x.id), ['R1', 'R2']);
  assert.equal(r.risks[0].files.length, 3);
});

test('工具函数:splitTableRow / extractPathTokens / parseLsTree', () => {
  assert.deepEqual(splitTableRow('| a | `x|y` | c\\|d | e |'), ['a', 'x|y', 'c|d', 'e'].map((c, i) => (i === 1 ? '`x|y`' : c)));
  assert.deepEqual(extractPathTokens('见 `src/a.ts#fn` 和 README.md 以及 [x](docs/b.md)').map((t) => t.path), ['src/a.ts', 'docs/b.md', 'README.md']);
  const tree = parseLsTree(`100644 blob ${'a'.repeat(40)}\tsrc/a.ts\u0000160000 commit ${'b'.repeat(40)}\tsub\u0000`);
  assert.equal(tree.get('src/a.ts').type, 'blob');
  assert.equal(tree.get('sub').type, 'commit');
});

test('readHandoffReview:只经注入的 gitFn 读固定 head 的 blob;缺文件=missing;超限不采用', () => {
  const calls = [];
  const treeOut = `100644 blob ${'1'.repeat(40)}\tdocs/pr/77/review.md\u0000100644 blob ${'2'.repeat(40)}\tsrc/alpha.ts\u0000100644 blob ${'3'.repeat(40)}\tsrc/beta.ts\u0000100644 blob ${'4'.repeat(40)}\tsrc/alpha.test.ts\u0000`;
  const gitFn = (args) => {
    calls.push(args);
    if (args.includes('ls-tree')) return { ok: true, stdout: treeOut };
    if (args.includes('-s')) return { ok: true, stdout: '123\n' };
    return { ok: true, stdout: fx('review-basic.md') };
  };
  const r = readHandoffReview({ prNumber: 77, head: 'h'.repeat(40), gitFn });
  assert.equal(r.status, 'parsed');
  assert.equal(r.source.blob, '1'.repeat(40));
  assert.deepEqual(r.fileStates['src/alpha.ts'], { oid: '2'.repeat(40), mode: '100644' });
  assert.ok(calls.every((c) => c[0] === '--no-replace-objects'));
  assert.deepEqual(toHandoffSnapshot(r).risks.map((x) => x.id), ['R1', 'R2']);
  assert.equal(JSON.stringify(toHandoffSnapshot(r)).includes('并发保存'), false);
  const missing = readHandoffReview({ prNumber: 77, head: 'h', gitFn: () => ({ ok: true, stdout: '' }) });
  assert.equal(missing.status, 'missing');
  const big = readHandoffReview({ prNumber: 77, head: 'h', gitFn: (a) => (a.includes('ls-tree') ? { ok: true, stdout: treeOut } : { ok: true, stdout: String(999999) }) });
  assert.equal(big.status, 'unreadable');
  const broken = readHandoffReview({ prNumber: 77, head: 'h', gitFn: () => ({ ok: false, stdout: '', stderr: 'boom' }) });
  assert.equal(broken.status, 'unreadable');
});
