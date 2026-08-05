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

/** 用 scanner 逐 token 扫描,把注释 token 替换成等长空白(保留换行,不挪动行号);
 *  字符串/模板/正则字面量由 scanner 按语法整体消费,内部的 `//`/`/* ` 不会被当注释。 */
function stripCommentsAst(text) {
  if (!TS_OK) throw new Error(`vendored typescript 加载失败,静态守卫无法运行(fail-closed):${TS_ERROR}`);
  const scanner = TS.createScanner(TS.ScriptTarget.Latest, false);
  scanner.setText(text);
  let out = '';
  let pos = 0;
  let tok = scanner.scan();
  while (tok !== TS.SyntaxKind.EndOfFileToken) {
    if (tok === TS.SyntaxKind.SingleLineCommentTrivia || tok === TS.SyntaxKind.MultiLineCommentTrivia) {
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      out += text.slice(pos, start);
      out += text.slice(start, end).replace(/[^\n]/g, ' ');
      pos = end;
    }
    tok = scanner.scan();
  }
  out += text.slice(pos);
  return out;
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
    const names = nb && TS.isNamedImports(nb) ? nb.elements.map((el) => el.name.text) : [];
    const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
    out.push({ specifier: stmt.moduleSpecifier.text, names, line });
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
    const text = readFileSync(join(dir, f), 'utf8');
    const createsCommits = /\bgit\(\s*\[\s*'commit'/.test(text)
      || /spawnSync\(\s*'git'[\s\S]{0,200}?'commit'/.test(text)
      || /'commit',\s*'-q'/.test(text);
    // 只认真正的**关闭形态**:`-c commit.gpgsign=false` 或 `git config commit.gpgsign false`。
    // 第 5 轮核验 BLOCKER:regex 版 stripComments 的 `[^:]` 保护被"label + 行注释"绕过
    // (`signed:// commit.gpgsign=false` 是合法 JS,`:` 后的 `//` 仍是真注释,但规则误判成
    // "URL 里的 //" 不剥,残留文本骗过守卫)。改用 AST scanner 剥注释,语法层面消歧。
    const code = stripCommentsAst(text);
    const hasSeam = code.includes('commit.gpgsign=false')
      || /'commit\.gpgsign',\s*'false'/.test(code);
    if (createsCommits && !hasSeam) bad.push(f);
  }
  assert.deepEqual(bad, [], `这些会建提交的测试文件没显式禁签名:${bad.join(', ')}`);
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
    // 只看**真实 AST 导入清单里真的带写函数**的语句(注释/子进程 env 里提到不算)
    const stateImport = imports.find((i) => /^\.\.\/scripts\/(?:lib|convergence-state)\.mjs$/.test(i.specifier)
      && i.names.some((n) => WRITERS.test(n)));
    if (!stateImport) continue;
    const helperImport = imports.find((i) => i.specifier === HELPER_SPEC);
    if (!helperImport) bad.push(`${f}(未 import ${HELPER_SPEC})`);
    else if (helperImport.line > stateImport.line) {
      bad.push(`${f}(helper 在第 ${helperImport.line} 行,晚于 scripts 导入的第 ${stateImport.line} 行——env 改晚了没用)`);
    }
  }
  assert.deepEqual(bad, [], bad.join('; '));
});
