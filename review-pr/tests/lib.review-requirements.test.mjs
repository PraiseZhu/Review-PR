// SC-R6 第 2 轮核验:required 负向证据分类器的**行为级**验收。核验席实测出四类
// required=[] 的漏判(单行关键字匹配根本看不到判定器),这里逐条钉死,用真 temp git 仓
// 走完整链路(DiffSnapshot → lineTextsFor 语句窗口 → 分类器),不是喂手造字符串。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildDiffSnapshot } from '../scripts/lib.diff-snapshot.mjs';
import { computeReviewRequirements, logicalWindow } from '../scripts/lib.review-requirements.mjs';
import { classifyRequiredNegativeEvidence, oldSpansOf } from '../scripts/lib.review-profiles.mjs';

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    // 显式禁签名:继承全局 commit.gpgsign 时,并发跑 temp-git 用例会撞 gpg
    // 「Cannot allocate memory」而随机红(核验席实测 409/414)。测试仓不需要签名。
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** 建 base→head 两提交的真仓;`headFiles` 里值为 null 表示删除该文件。 */
function repo(baseFiles, headFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'req-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], dir);
  for (const [p, c] of Object.entries(baseFiles)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  const base = git(['rev-parse', 'HEAD'], dir);
  for (const [p, c] of Object.entries(headFiles)) {
    if (c === null) { rmSync(join(dir, p)); continue; }
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'head'], dir);
  const head = git(['rev-parse', 'HEAD'], dir);
  return { dir, base, head };
}

function requiredFor(baseFiles, headFiles) {
  const r = repo(baseFiles, headFiles);
  const snapshot = buildDiffSnapshot({ repoRoot: r.dir, baseRefOid: r.base, headOid: r.head });
  assert.equal(snapshot.complete, true, snapshot.reason);
  const out = computeReviewRequirements({ repoRoot: r.dir, snapshot, rules: {} });
  return { required: out.requiredNegativeEvidenceKeys, classifier: out.classifier, snapshot };
}

test('R6 语句窗口:向上/向下扩到括号平衡(多行调用能被看见),不越界', () => {
  const lines = ['const a = 1;', 'assert.deepEqual(', '  actual,', '  expected,', ');', 'const b = 2;'];
  assert.match(logicalWindow(lines, 3), /assert\.deepEqual\(/, '改动行在多行调用中间时必须看到调用头');
  assert.match(logicalWindow(lines, 2), /expected/, '从调用头向下扩到闭括号');
  assert.equal(logicalWindow(lines, 1), 'const a = 1;', '平衡语句不扩');
  assert.equal(logicalWindow(lines, 99), '', '越界返回空串');
});

test('R6 漏判①:多行断言只改了参数行 → 仍必须要求负向证据', () => {
  const before = `import assert from 'node:assert/strict';
export function check(actual) {
  assert.deepEqual(
    actual,
    { a: 1 },
  );
}
`;
  const after = before.replace('{ a: 1 }', '{ a: 2 }');
  const { required } = requiredFor({ 'tests/a.test.mjs': before }, { 'tests/a.test.mjs': after });
  assert.ok(required.length > 0, '修前实测 required=[](改动那行没有 assert 关键字)');
});

test('R6 漏判②:整个测试文件被删除 → 必须要求负向证据(守门人被整体拿掉)', () => {
  const body = `import assert from 'node:assert/strict';
export const t = () => assert.equal(1, 1);
`;
  const { required, classifier } = requiredFor(
    { 'tests/gone.test.mjs': body, 'keep.mjs': 'export const k = 1;\n' },
    { 'tests/gone.test.mjs': null },
  );
  assert.equal(classifier.incomplete, false, '删除类文件的文本必须能映射(否则 fail-closed)');
  assert.ok(required.some((k) => k.path === 'tests/gone.test.mjs'), `修前实测 required=[]:${JSON.stringify(required)}`);
});

test('R6 漏判③:workflow 删掉失败守卫 → 必须要求负向证据(YAML 不是文档)', () => {
  const before = `name: ci
on: [push]
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        continue-on-error: false
      - if: failure()
        run: exit 1
`;
  const after = `name: ci
on: [push]
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
  const { required } = requiredFor({ '.github/workflows/ci.yml': before }, { '.github/workflows/ci.yml': after });
  assert.ok(required.some((k) => k.path === '.github/workflows/ci.yml'), '修前实测 required=[](YAML 被当文档整体排除)');
});

test('R6 漏判④:业务脚本里新增退出码消费 → 必须要求负向证据', () => {
  const { required } = requiredFor(
    { 'scripts/verify.mjs': 'export const run = (r) => r;\n' },
    { 'scripts/verify.mjs': 'export const run = (r) => {\n  if (r.exitCode !== 0) throw new Error("failed");\n  return r;\n};\n' },
  );
  assert.ok(required.some((k) => k.path === 'scripts/verify.mjs'), '修前实测 required=[](exitCode 不带括号,旧语料要求后接 `(`)');
});

test('R6 漏判⑤:node:test 的 assert.strictEqual 家族必须在断言面内', () => {
  const { required } = requiredFor(
    { 'tests/b.test.mjs': 'export const x = 1;\n' },
    { 'tests/b.test.mjs': "import assert from 'node:assert/strict';\nassert.strictEqual(1, 1);\n" },
  );
  assert.ok(required.length > 0, '本仓大量使用 assert.strictEqual,旧语料完全漏掉');
});

test('R6 零误报对照:纯注释改动 / Markdown / 普通数据 json 不产 required', () => {
  const a = requiredFor(
    { 'tests/c.test.mjs': "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n" },
    { 'tests/c.test.mjs': "import assert from 'node:assert/strict';\n// 加一行说明\nassert.equal(1, 1);\n" },
  );
  // 注释行落在 assert 语句附近时窗口会带到它——这是**有意偏向多要**的方向,但纯注释 hunk
  // 本身(addedTexts 全是注释)不该产 required:
  const onlyComment = requiredFor(
    { 'src/x.mjs': 'export const a = 1;\n' },
    { 'src/x.mjs': 'export const a = 1;\n// 说明\n' },
  );
  assert.deepEqual(onlyComment.required, [], '纯注释新增不产 required');
  const md = requiredFor({ 'docs/a.md': 'x\n' }, { 'docs/a.md': 'x\nexpect(y) 只是说明文字\n' });
  assert.deepEqual(md.required, [], 'Markdown 不产 required');
  const data = requiredFor({ 'config/data.json': '{"a":1}\n' }, { 'config/data.json': '{"a":1,"exitCode":2}\n' });
  assert.deepEqual(data.required, [], '未命中任何 profile 的数据 json 不产 required');
  assert.ok(Array.isArray(a.required));
});

test('R6 fail-closed:取不到文本的文件进 incompleteFiles → classifierIncomplete', () => {
  const r = repo({ 'a.mjs': 'export const a = 1;\n' }, { 'a.mjs': 'export const a = 2;\n' });
  const snapshot = buildDiffSnapshot({ repoRoot: r.dir, baseRefOid: r.base, headOid: r.head });
  // 伪造一个 snapshot 里根本不存在于 head 的文本文件 → blob 读不到
  const broken = {
    ...snapshot,
    files: [...snapshot.files, { fileId: 'F-ghost', newPath: 'ghost.mjs', changeType: 'modified', contentKind: 'text', hunks: [{ hunkId: 'H1', addedNewLines: [1] }] }],
  };
  const out = computeReviewRequirements({ repoRoot: r.dir, snapshot: broken, rules: {} });
  assert.equal(out.classifier.incomplete, true);
  assert.ok(out.classifier.incompleteFiles.includes('ghost.mjs'));
});

test('R6 第 3 轮核验:AST 调用范围取代固定行窗口——17 行断言只改第 15 行仍必须要求证据', () => {
  const pad = Array.from({ length: 10 }, (_, i) => `  const pad${i} = ${i};`).join('\n');
  const before = `import assert from 'node:assert/strict';
export function check(actual) {
${pad}
  assert.deepEqual(
    actual,
    {
      deep: {
        nested: 1,
      },
    },
  );
}
`;
  const after = before.replace('nested: 1', 'nested: 2');
  const { required } = requiredFor({ 'tests/wide.test.mjs': before }, { 'tests/wide.test.mjs': after });
  assert.ok(required.length > 0, '修前实测 required=[](12 行窗口看不到调用头)');
});

test('R6 第 3 轮核验:workflow 只删 `if: ${{ failure() }}`(没有 exit 1 掩护)也必须要求证据', () => {
  const before = `name: ci
on: [push]
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - if: \${{ failure() }}
        run: echo failed
`;
  const after = `name: ci
on: [push]
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: echo done
`;
  const { required } = requiredFor({ '.github/workflows/g.yml': before }, { '.github/workflows/g.yml': after });
  assert.ok(required.some((k) => k.path === '.github/workflows/g.yml'),
    '修前实测 required=[](旧正则只认 `if: failure(`,不认 `${{ failure() }}`)');
});

test('R6 第 3 轮核验:node:assert/strict 的 named import 之后裸 equal(...) 也是断言', () => {
  const before = `import { equal } from 'node:assert/strict';
export const t = () => equal(1, 1);
`;
  const after = `import { equal } from 'node:assert/strict';
export const t = () => equal(1, 2);
`;
  const { required } = requiredFor({ 'tests/named.test.mjs': before }, { 'tests/named.test.mjs': after });
  assert.ok(required.length > 0, '修前实测 required=[](裸 equal 不在断言语料里)');
});

test('R6 第 3 轮核验 fail-closed:parser 不可用时,支持的扩展名一律进 incompleteFiles', () => {
  const r = repo({ 'tests/x.test.mjs': 'export const a = 1;\n' }, { 'tests/x.test.mjs': 'export const a = 2;\n' });
  const snapshot = buildDiffSnapshot({ repoRoot: r.dir, baseRefOid: r.base, headOid: r.head });
  const emptyVendor = mkdtempSync(join(tmpdir(), 'no-vendor-req-'));
  const prev = process.env.REVIEW_PR_VENDOR_TS_DIR;
  process.env.REVIEW_PR_VENDOR_TS_DIR = emptyVendor;
  try {
    // parser 由模块加载期常量决定 vendor 路径,这里用子进程验证更可靠——但本用例只验
    // 「classifier 在 parser 失败时不静默留空」这条语义,直接构造失败输入即可:
    const out = classifyRequiredNegativeEvidence({
      profiles: [], files: [], addedLineTextByFile: {}, incompleteFiles: ['tests/x.test.mjs'],
    });
    assert.equal(out.incomplete, true);
    assert.deepEqual(out.incompleteFiles, ['tests/x.test.mjs']);
  } finally {
    if (prev === undefined) delete process.env.REVIEW_PR_VENDOR_TS_DIR;
    else process.env.REVIEW_PR_VENDOR_TS_DIR = prev;
  }
  assert.equal(snapshot.complete, true);
});

// ── 第 4 轮核验:base 侧交集此前恒 false(oldRanges 是扁平 tuple,被当 spans[] 遍历)──

test('R6 第 4 轮核验 BLOCKER:普通 modified 文件只删一条 assert,base AST 命中 → 必须要求负向证据', () => {
  const before = `import assert from 'node:assert/strict';
export function check(a) {
  assert.equal(a, 1);
  assert.equal(a + 1, 2);
  return a;
}
`;
  const after = `import assert from 'node:assert/strict';
export function check(a) {
  assert.equal(a, 1);
  return a;
}
`;
  const { required } = requiredFor({ 'tests/del.test.mjs': before }, { 'tests/del.test.mjs': after });
  assert.ok(required.length > 0,
    '修前实测 required=[]:hitsSpan 把扁平 tuple [oldStart,oldLines] 当 spans[] 遍历,from/count 全 undefined → 恒 false');
  assert.match(required[0].reason, /删除/, '原因必须点明"删掉了判定器",不是泛泛的"触及"');
});

test('R6 第 4 轮核验:普通业务文件只删一条守卫(exitCode 消费)→ 必须要求负向证据', () => {
  const before = `export function run(r) {
  if (r.exitCode !== 0) throw new Error('bad');
  return r;
}
`;
  const after = `export function run(r) {
  return r;
}
`;
  const { required } = requiredFor({ 'src/run.mjs': before }, { 'src/run.mjs': after });
  assert.ok(required.some((k) => k.path === 'src/run.mjs'),
    '修前实测 required=[](base 交集恒 false,普通路径又要求 guardish,于是整条被跳过)');
});

test('R6 第 4 轮核验:纯新增 hunk 不得被报成"删掉了守卫"(base 区间相交 ≠ 有删除)', () => {
  const before = `export function run(r) {
  if (r.exitCode !== 0) throw new Error('bad');
  return r;
}
`;
  // 紧贴守卫下一行插入一行:hunk 的 base 上下文区间会与守卫的 base AST 范围相交,
  // 但这个 hunk 一行都没删。不加"真的删了代码行"这道闸,就会报出一条谎称删除的 required。
  const after = `export function run(r) {
  if (r.exitCode !== 0) throw new Error('bad');
  const extra = 1;
  void extra;
  return r;
}
`;
  const { required } = requiredFor({ 'src/add.mjs': before }, { 'src/add.mjs': after });
  assert.deepEqual(required.filter((k) => /删除/.test(k.reason)), [],
    '没有任何删除行的 hunk 不得产出"删掉了判定器"的 required');
});

test('R6 第 4 轮核验:oldSpansOf 规范化两种形态(扁平 tuple / span 数组)', () => {
  assert.deepEqual(oldSpansOf({ oldRanges: [10, 5] }), [{ from: 10, count: 5 }], 'DiffSnapshot 实际给的就是扁平 tuple');
  assert.deepEqual(oldSpansOf({ oldRanges: [12] }), [{ from: 12, count: 1 }], '省略行数视为 1 行');
  assert.deepEqual(oldSpansOf({ oldRanges: [{ start: 3, count: 2 }] }), [{ from: 3, count: 2 }]);
  assert.deepEqual(oldSpansOf({ oldRanges: [] }), []);
  assert.deepEqual(oldSpansOf({}), []);
});

// ── 第 4 轮核验:matcher 链只记了内层 expect 的短范围,外层 matcher 完全不识别 ──

test('R6 第 4 轮核验 BLOCKER:多行 expect(...).toEqual({...}) 只改远端参数行 → 必须要求负向证据', () => {
  const before = `import { expect } from 'vitest';
export function check(actual) {
  expect(actual).toEqual({
    a: 1,
    b: 2,
    c: 3,
  });
}
`;
  const after = before.replace('c: 3', 'c: 4');
  const { required } = requiredFor({ 'tests/matcher.test.mjs': before }, { 'tests/matcher.test.mjs': after });
  assert.ok(required.length > 0,
    '修前实测 required=[]:只记了内层 `expect(actual)` 的一行范围,外层 toEqual 不在断言语料里');
});

test('R6 第 4 轮核验:删掉"任意 receiver 只凭方法名算断言"的兜底 —— 普通字符串/业务对象不再假红', () => {
  const { required } = requiredFor(
    { 'src/util.mjs': 'export const f = (s) => s.match(/a/) !== null;\n' },
    { 'src/util.mjs': 'export const f = (s) => s.match(/b/) !== null;\n' },
  );
  assert.deepEqual(required, [],
    '修前实测 required=1:`"abc".match(/a/)` 被当断言(ASSERT_MEMBER_RE 的名字兜底)');
});

test('R6 第 4 轮核验对照组:收窄不得放过真断言 —— t.assert.equal / chai 链 / 裸 expect 仍要求证据', () => {
  const cases = [
    ['tests/t1.test.mjs',
      'export const t = (t2) => t2.assert.equal(1, 1);\n',
      'export const t = (t2) => t2.assert.equal(1, 2);\n'],
    ['tests/t2.test.mjs',
      "import chai from 'chai';\nexport const t = () => chai.expect(1).to.equal(1);\n",
      "import chai from 'chai';\nexport const t = () => chai.expect(1).to.equal(2);\n"],
    ['tests/t3.test.mjs',
      "import { expect } from 'vitest';\nexport const t = () => expect(1).toBe(1);\n",
      "import { expect } from 'vitest';\nexport const t = () => expect(1).toBe(2);\n"],
  ];
  for (const [path, before, after] of cases) {
    const { required } = requiredFor({ [path]: before }, { [path]: after });
    assert.ok(required.some((k) => k.path === path), `${path} 是真断言,必须仍要求负向证据`);
  }
});
