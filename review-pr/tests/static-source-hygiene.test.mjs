// 文本卫生静态守卫(第 2 轮核验 R0 回归)。抓的是两类**真实发生过**的问题:
//   ① scripts/lib.review-consume.mjs 里写了两个真 NUL 字节当分隔符 → git 把整份文件判为
//      binary,正常 diff / review 能力直接消失(核验席实测)。分隔符必须写成源码转义。
//   ② vendored LICENSE.txt 是上游 CRLF,`git diff --check` 把 55 行全报 trailing whitespace。
//      修法是 .gitattributes 把 vendor/** 标成 -text -whitespace(保持 verbatim 字节),
//      而不是去改上游文件——所以这里正向断言那条规则在位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVendoredTypescript } from '../scripts/lib.preflight-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 第 5 轮核验 BLOCKER:两道静态门此前都是纯 regex/字符串扫描,都被实测绕过——
//   ① stripComments 的 `[^:]` 保护(防止把 URL 里的 `//` 当注释)反而放过了
//      "label + 行注释"这种合法 JS(`signed:// commit.gpgsign=false`,`signed:` 是
//      标签,后面的 `//` 是真注释,但因紧跟 `:` 被误判成"URL 里的 //"不剥,残留文本
//      骗过守卫);
//   ② helper-import 检查只做 `line.includes(HELPER)`,把真实 import 注释掉
//      (`// import './helpers.isolated-state-dir.mjs';`)后仍判"已 import"。
// 两处都改用 vendored TypeScript 的 scanner/AST——字符串、模板、正则里的内容天然不会被
// 误判成注释(scanner 理解语法),而"是不是真的 import 语句"只有解析出 ImportDeclaration
// 节点才算,注释掉的文本根本不会出现在 AST 里。
const { ok: TS_OK, ts: TS, error: TS_ERROR } = loadVendoredTypescript();

/**
 * 签名门的语义分析:直接在 AST 上找**真实 git 调用里的真实字符串字面量**——不剥注释、
 * 不做文本匹配(第 6 轮核验 BLOCKER:上一版 scanner 剥注释在带 substitution 的模板上
 * 会失同步——`\`\${foo}bar\`` 之后 scanner 需要 parser 触发 reScanTemplateToken 才能
 * 正确续扫,裸 scan() 循环做不到,后续真注释残留;且剥完注释仍是 `includes(...)` 文本
 * 匹配,一个不喂给 git 的 decoy 字符串常量就能骗过)。
 *
 * AST 语义天然免疫这三类:注释不产生 AST 节点;模板/字符串由 parser 正确消费;字面量
 * 必须处于「git 相关调用的参数子树里」才算数,游离的 decoy 常量不算。
 *
 * 「git 相关调用」判据:CallExpression 满足任一——
 *   a) callee 链上的标识名含 git(`git([...])` 包装函数、`runGit(...)`);
 *   b) 参数里有字符串字面量 'git'(`spawnSync('git', [...])`)。
 * 返回 { createsCommits, hasSeam }:
 *   createsCommits = 某个 git 调用的参数子树里有字面量 'commit';
 *   hasSeam       = 某个 git 调用的参数子树里有 'commit.gpgsign=false',或相邻的
 *                   ('commit.gpgsign','false') 字面量对(git config 形态)。
 * 诚实边界:不做数据流分析——变量拼接出的参数看不见(宁可漏 createsCommits 也不误报
 * seam;本仓测试全部用字面量参数,已由下方守卫单测钉死三个反例)。
 */
function analyzeGitCalls(text) {
  if (!TS_OK) throw new Error(`vendored typescript 加载失败,静态守卫无法运行(fail-closed):${TS_ERROR}`);
  const sf = TS.createSourceFile('seam-check.mjs', text, TS.ScriptTarget.Latest, true, TS.ScriptKind.JS);
  let createsCommits = false;
  let hasSeam = false;
  const calleeNames = (n) => {
    const names = [];
    let cur = n;
    for (;;) {
      if (!cur) break;
      if (TS.isIdentifier(cur)) { names.push(cur.text); break; }
      if (TS.isPropertyAccessExpression(cur)) { names.push(cur.name.text); cur = cur.expression; continue; }
      if (TS.isCallExpression(cur) || TS.isParenthesizedExpression(cur)) { cur = cur.expression; continue; }
      break;
    }
    return names;
  };
  // 注意:forEachChild 的 callback 返回 truthy 会**提前终止整个遍历**——这里的递归
  // 回调绝不能有返回值(第一版 `return out` 让扫描只走到第一个子节点,全部文件误报)。
  const stringsIn = (node, out) => {
    if (TS.isStringLiteralLike(node)) out.push(node.text);
    TS.forEachChild(node, (c) => { stringsIn(c, out); });
  };
  const visit = (node) => {
    if (TS.isCallExpression(node)) {
      const args = [];
      for (const a of node.arguments) stringsIn(a, args);
      const gitish = calleeNames(node.expression).some((x) => /git/i.test(x)) || args.includes('git');
      if (gitish) {
        if (args.includes('commit')) createsCommits = true;
        if (args.includes('commit.gpgsign=false')) hasSeam = true;
        for (let i = 0; i + 1 < args.length; i += 1) {
          if (args[i] === 'commit.gpgsign' && args[i + 1] === 'false') hasSeam = true;
        }
      }
    }
    TS.forEachChild(node, visit);
  };
  visit(sf);
  return { createsCommits, hasSeam };
}

/** 解析文件的顶层 `import ... from '<specifier>'` 语句(真实 AST 节点,注释掉的文本
 *  不会出现在这里)。返回 `{ specifier, names, line }[]`,`names` 是具名导入的标识名。 */
function parseImports(text) {
  if (!TS_OK) throw new Error(`vendored typescript 加载失败,静态守卫无法运行(fail-closed):${TS_ERROR}`);
  const sf = TS.createSourceFile('hygiene-check.mjs', text, TS.ScriptTarget.Latest, true, TS.ScriptKind.JS);
  const out = [];
  for (const stmt of sf.statements) {
    if (!TS.isImportDeclaration(stmt) || !TS.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    const nb = stmt.importClause?.namedBindings;
    // 第 6 轮核验:alias(`writeReviewReceipt as wr`)要按**原始导出名**(propertyName)
    // 识别 writer,不是本地名;namespace import(`import * as L`)无法枚举成员——按
    // fail-closed 记 wildcard(下方守卫把它当"可能含 writer"处理)。
    const names = nb && TS.isNamedImports(nb) ? nb.elements.map((el) => (el.propertyName ?? el.name).text) : [];
    const wildcard = !!(nb && TS.isNamespaceImport?.(nb));
    const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
    out.push({ specifier: stmt.moduleSpecifier.text, names, wildcard, line });
  }
  return out;
}

const tracked = () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout.split('\u0000').filter(Boolean);
};

// vendor/ 是上游 verbatim 字节,按 .gitattributes 豁免;二进制资产也不参与文本检查
const isCheckedText = (p) => !p.startsWith('vendor/')
  && /\.(mjs|js|cjs|ts|tsx|json|md|ya?ml)$/i.test(p);

test('R0 卫生:tracked 文本文件不得含真 NUL 字节(否则 git 判 binary,丢 diff/review 能力)', () => {
  const files = tracked();
  if (files === null) return; // 非 git 环境(打包分发)跳过
  const bad = [];
  for (const p of files.filter(isCheckedText)) {
    const buf = readFileSync(join(ROOT, p));
    if (buf.includes(0)) bad.push(p);
  }
  assert.deepEqual(bad, [], `含真 NUL 的文件(应改用 \\u0000 源码转义):${bad.join(', ')}`);
});

test('R0 卫生:tracked 文本文件不得有 CRLF 或行尾空白(git diff --check 会红)', () => {
  const files = tracked();
  if (files === null) return;
  const bad = [];
  for (const p of files.filter(isCheckedText)) {
    const text = readFileSync(join(ROOT, p), 'utf8');
    if (text.includes('\r')) bad.push(`${p}(CRLF)`);
    else if (/[ \t]+\n/.test(text)) bad.push(`${p}(行尾空白)`);
  }
  assert.deepEqual(bad, [], bad.join(', '));
});

test('R0 卫生:.gitattributes 把 vendor/** 标为 -text -whitespace(vendored 字节 verbatim + 不参与 whitespace 检查)', () => {
  const f = join(ROOT, '.gitattributes');
  assert.ok(existsSync(f), '缺 .gitattributes——vendored LICENSE 的上游 CRLF 会让 git diff --check 全红');
  const text = readFileSync(f, 'utf8');
  const line = text.split('\n').find((l) => l.trim().startsWith('vendor/'));
  assert.ok(line, '缺 vendor/ 规则行');
  assert.match(line, /-text/);
  assert.match(line, /-whitespace/);
});

test('R0 可移植性:任何**创建 git 提交**的测试文件都必须显式禁签名', () => {
  // 核验席环境里全局 commit.gpgsign=true,并发跑 temp-git 用例会撞 gpg「Cannot allocate
  // memory」而随机红(实跑 409/414)。本机 gpg 可用所以复现不到 —— 那正是必须用**静态守卫**
  // 而不是靠"我这儿是绿的"的原因:新加建仓 helper 时漏掉这条,只有别人的机器会红。
  // 只针对**建提交**的文件(init / remote add / ls-files 不签名,不在此列)。
  const dir = join(ROOT, 'tests');
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const { createsCommits, hasSeam } = analyzeGitCalls(readFileSync(join(dir, f), 'utf8'));
    if (createsCommits && !hasSeam) bad.push(f);
  }
  assert.deepEqual(bad, [], `这些会建提交的测试文件没显式禁签名:${bad.join(', ')}`);
});

test('R0 守卫自检:注释/模板/decoy 骗不过签名门,alias/namespace 骗不过 writer 识别(第 6 轮核验三反例)', () => {
  // ① 带 substitution 的模板 + 真注释里的 seam 文本:上一版 scanner 剥注释在模板处失同步,
  //    注释残留 → 文本匹配 hasSeam=true 放行。AST 语义下注释不产生节点 → hasSeam=false。
  const tpl = 'const x = `${foo}bar`; // commit.gpgsign=false\nspawnSync("git", ["commit", "-q", "m"]);\n';
  const a = analyzeGitCalls(tpl);
  assert.equal(a.createsCommits, true, '模板 + 注释不得干扰 commit 检测');
  assert.equal(a.hasSeam, false, '注释里的 seam 文本不算关闭签名——上一版在此被骗过');
  // ② decoy:游离字符串常量不喂给任何 git 调用 → 不算 seam
  const decoy = 'const d = "commit.gpgsign=false";\nspawnSync("git", ["commit", "-q", "m"]);\n';
  assert.equal(analyzeGitCalls(decoy).hasSeam, false, '不在 git 调用参数子树里的 decoy 字符串不算 seam');
  // ③ 真实关闭形态(两种)都认
  assert.equal(analyzeGitCalls('spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "m"]);').hasSeam, true);
  assert.equal(analyzeGitCalls('spawnSync("git", ["config", "commit.gpgsign", "false"]);').hasSeam, true);
  // ④ 包装函数形态(git([...]))也认——本仓测试的主流写法
  const wrapped = 'const git = (a) => spawnSync("git", ["-c", "commit.gpgsign=false", ...a]);\ngit(["commit", "-q", "m"]);\n';
  const w = analyzeGitCalls(wrapped);
  assert.equal(w.createsCommits, true);
  assert.equal(w.hasSeam, true);
  // ⑤ writer 识别:alias 按原始导出名、namespace 按 wildcard(fail-closed)
  const aliased = parseImports("import { writeReviewReceipt as wr } from '../scripts/lib.mjs';\n");
  assert.deepEqual(aliased[0].names, ['writeReviewReceipt'], 'alias 必须按原始导出名识别 writer——上一版拿本地名 wr 漏判');
  const ns = parseImports("import * as L from '../scripts/lib.mjs';\n");
  assert.equal(ns[0].wildcard, true, 'namespace import 无法枚举成员,必须记 wildcard(fail-closed 当作可能含 writer)');
  // ⑥ 注释掉的 import 不产生 AST 节点
  assert.deepEqual(parseImports("// import { writeReviewReceipt } from '../scripts/lib.mjs';\n"), []);
});

test('R0 隔离:在本进程内写持久状态的测试文件必须先 import 私有 STATE_DIR helper', () => {
  // 第 4 轮核验 R0:两份默认全量测试并发跑时,共享真实 STATE_DIR + 固定 PR 号会让彼此的
  // resetPr() 互删状态(实测 431/432)。helper 给每个测试进程一个私有目录,但它**必须**排在
  // lib.mjs / convergence-state.mjs 的静态导入之前(STATE_DIR 在模块加载期即定死)。
  //
  // 第 5 轮核验 BLOCKER:上一版用 `line.includes(HELPER)` 裸文本匹配,把真实 import 整行
  // 注释掉(`// import './helpers.isolated-state-dir.mjs';`)后仍判"已 import"。改用真实
  // AST:解析出 ImportDeclaration 节点,注释掉的文本根本不出现在语句列表里。
  const dir = join(ROOT, 'tests');
  const HELPER_SPEC = './helpers.isolated-state-dir.mjs';
  const WRITERS = /^(writeReviewReceipt|recordConvergenceRound|markNotified|recordNotificationAttempt)$/;
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.test.mjs'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const imports = parseImports(text);
    // 只看**真实 AST 导入清单里真的带写函数**的语句(注释/子进程 env 里提到不算)。
    // 第 6 轮核验:alias 已按原始导出名收进 names;namespace import 无法枚举成员,
    // 按 wildcard fail-closed 当作"可能含 writer"。
    const stateImport = imports.find((i) => /^\.\.\/scripts\/(?:lib|convergence-state)\.mjs$/.test(i.specifier)
      && (i.wildcard || i.names.some((n) => WRITERS.test(n))));
    if (!stateImport) continue;
    const helperImport = imports.find((i) => i.specifier === HELPER_SPEC);
    if (!helperImport) bad.push(`${f}(未 import ${HELPER_SPEC})`);
    else if (helperImport.line > stateImport.line) {
      bad.push(`${f}(helper 在第 ${helperImport.line} 行,晚于 scripts 导入的第 ${stateImport.line} 行——env 改晚了没用)`);
    }
  }
  assert.deepEqual(bad, [], bad.join('; '));
});
