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
