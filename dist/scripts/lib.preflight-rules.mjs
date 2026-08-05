#!/usr/bin/env node
// lib.preflight-rules.mjs — 确定性 preflight 规则引擎(SC-R2,2026-08-05 SC v4 共识)。
//
// 为什么存在(#469 缺口①):`page.waitForFunction(async () => ...)` 是**机器可判定**的
// 固定模式——async 谓词返回 Promise,Promise 恒 truthy,1ms 就"满足"了,测试瞬间绿但
// 什么都没等到。#483 用 AST 守卫一次抓出 19 处、零漏报。把这类已知硬模式继续押给 LLM
// 概率判断没有理由:命中即机器打回,不经 LLM。
//
// parser 纪律(第 2 轮共识裁决):
//   - typescript 从 **vendor/ 钉版本**加载(vendor/typescript/PROVENANCE.json 记 version
//     与 sha256);运行时断言 resolved 路径在 vendor 下且 ts.version === 钉死值;
//   - **无 node_modules fallback**、**禁 regex 降级**——parser 缺失/版本不符/加载失败
//     一律 `complete:false`(消费方 fail-closed:R1 invalid、pre-merge 拒),绝不因
//     "解析不了就当没命中"放行;
//   - ScriptKind 按扩展名(.ts/.tsx/.js/.jsx/.mjs/.cjs)——#483 踩过 ScriptKind.JS 套在
//     .ts 上造成 234/775 假红的坑;
//   - 检查 `parseDiagnostics`:语法错文件不产出"无命中"结论,记 unparsable。
//
// 承诺面(如实声明,不冒称):
//   - 只认 **lexical receiver** 为 `page` / `frame` 标识符(或 `xxx.page` 这类成员表达式
//     的末段属性名)上的 `.waitForFunction(...)`;通过 alias(`const p = page`)、解构、
//     容器传参等间接持有的对象**不在承诺内**——那类要靠 LLM 层(R3 profile 必答)兜;
//   - `locator.waitFor` 不收谓词、`vi.waitFor(async ...)` 是合法用法,均**不**报——
//     泛化成"任何 .waitFor" 会产生假红(复审裁决,已在 fixture 钉死零误报);
//   - 谓词返回值只按**语法确定性**判 Promise:async 修饰、await、`new Promise`、`Promise.x()`、
//     async IIFE、三元任一分支、以及"链基已是 Promise"的 `.then/.catch/.finally`。
//     **不按方法名猜**:`.evaluate` 只对异步持有者白名单 receiver 认(同步 `model.evaluate()`
//     不报),`x.then()` 里的 x 若不是 Promise 也不报——第 2 轮核验点名的两处假红。
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// REVIEW_PR_VENDOR_TS_DIR:**测试专用 seam**。"parser 缺失 → fail-closed"这条路径必须能被
// 测试触发,但绝不能靠移走仓库里真实的 vendor 文件——那会在并行跑测试时让其它用例随机
// 读不到 parser(实测踩到:一次全量跑里 1/8 概率随机红)。生产不设此变量。
const VENDOR_DIR = process.env.REVIEW_PR_VENDOR_TS_DIR
  ? resolve(process.env.REVIEW_PR_VENDOR_TS_DIR)
  : resolve(HERE, '..', 'vendor', 'typescript');
const VENDOR_ENTRY = join(VENDOR_DIR, 'typescript.js');
const PROVENANCE = join(VENDOR_DIR, 'PROVENANCE.json');

/** 规则注册表:内置规则(代码层 always-on)。ruleVersion 参与 SC-R5 的自动核销判定—— * 规则实现变了不能冒充"代码已修",所以版本变化时旧 finding 保持 open。 */
export const BUILTIN_RULES = [
  {
    ruleId: 'playwright-waitforfunction-async-predicate',
    // v2:补齐显式返回 Promise 的 literal 形态(new Promise / Promise.x / block 体 return)
    // v3(2026-08-05 第 2 轮核验):剥语法壳(as/satisfies/<T>/非空断言)、认三元与 async IIFE;
    //     同时**收窄**假红面——`.evaluate` 只对异步持有者白名单认,`.then` 只对已是 Promise 的链基认
    // v4(2026-08-05 第 3 轮核验):**谓词根节点**也剥壳(`waitForFunction((async()=>true))`
    //     此前整条判定被跳过);补 &&/||/?? 任一操作数、逗号表达式右操作数、
    //     以及 `Promise["resolve"]()` 这类 element-access 成员调用
    // v5(2026-08-05 第 4 轮核验):receiver / new target 同样剥壳(`(page).waitForFunction`、
    //     `new (Promise)(...)`);同步 literal IIFE 复用函数体返回分析
    //     (`() => (() => Promise.resolve(1))()`);return 遍历在**任意** function-like
    //     (含对象方法/getter)处停止下潜;`&&` 按 JS 短路语义只看右操作数
    //     (`Promise.resolve() && ready` 恒返回 ready,不是假等待——上一版假红)
    ruleVersion: 'v5',
    severity: 'P1',
    invariant: 'waitForFunction 的谓词不得是 async/返回 Promise——Promise 恒 truthy,会 1ms 假通过而根本没在等待',
    title: 'waitForFunction 收到 async/Promise 谓词(假等待)',
  },
];

/**
 * 加载 vendored typescript。返回 { ok, ts?, error?, version?, resolvedPath? }。
 * 任何一环不满足都 ok:false —— 调用方据此产出 complete:false,不得降级。
 */
export function loadVendoredTypescript() {
  if (!existsSync(VENDOR_ENTRY) || !existsSync(PROVENANCE)) {
    return { ok: false, error: `vendored typescript 缺失(期望 ${VENDOR_ENTRY} 与 PROVENANCE.json)` };
  }
  let prov;
  try {
    prov = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  } catch (e) {
    return { ok: false, error: `PROVENANCE.json 不可读:${e.message}` };
  }
  if (typeof prov.version !== 'string' || typeof prov.sha256 !== 'string') {
    return { ok: false, error: 'PROVENANCE.json 缺 version/sha256' };
  }
  // 体量校验:整文件 sha256 每次算要读 9MB,只在 bytes 不符时才判失败(bytes 变了必然
  // 内容变了;bytes 相同而内容被改属本地篡改场景,不是本 SC 的威胁模型——如实声明)。
  if (Number.isInteger(prov.bytes) && statSync(VENDOR_ENTRY).size !== prov.bytes) {
    return { ok: false, error: `vendored typescript 体量与 PROVENANCE 不符(期望 ${prov.bytes})` };
  }
  let ts;
  try {
    ts = createRequire(import.meta.url)(VENDOR_ENTRY);
  } catch (e) {
    return { ok: false, error: `vendored typescript 加载失败:${e.message}` };
  }
  const resolvedPath = createRequire(import.meta.url).resolve(VENDOR_ENTRY);
  if (!resolvedPath.startsWith(VENDOR_DIR)) {
    return { ok: false, error: `typescript 解析到 vendor 之外(${resolvedPath})——禁 node_modules fallback` };
  }
  if (ts.version !== prov.version) {
    return { ok: false, error: `typescript 版本不符(载入 ${ts.version},钉死 ${prov.version})` };
  }
  return { ok: true, ts, version: ts.version, resolvedPath };
}

const SCRIPT_KINDS = {
  '.ts': 'TS', '.mts': 'TS', '.cts': 'TS',
  '.tsx': 'TSX',
  '.js': 'JS', '.mjs': 'JS', '.cjs': 'JS',
  '.jsx': 'JSX',
};

/** 按扩展名选 ScriptKind(#483 教训:ScriptKind.JS 套 .ts 会把泛型当比较运算符,大面积假红)。 */
export function scriptKindFor(ts, path) {
  const key = SCRIPT_KINDS[extname(path).toLowerCase()];
  return key ? ts.ScriptKind[key] : null;
}

/** Playwright/Puppeteer 风格的**异步 API 持有者**白名单(receiver 末段标识名)。
 *  只对这份名单上的 receiver 认 `.evaluate/.evaluateHandle` 恒返 Promise——第 2 轮核验
 *  点名的假红正是"任何方法名叫 evaluate 就算 Promise"(同步 `model.evaluate()` 被误报)。
 *  名单外的同名调用不在承诺内(交 R3 profile 必答兜),宁少报不假红。 */
const ASYNC_HOLDER_RE = /^(page|frame|locator|elementHandle|handle|context|browser|browserContext|worker|iframe)$/;

/** 剥掉不改变运行时值的语法外壳:括号 / as / satisfies / <T> 断言 / 非空断言。
 *  第 2 轮核验实测漏判的四种形态全部源于此处没剥壳(`Promise.resolve(x) as Promise<T>`)。 */
function unwrapExpression(ts, e) {
  let n = e;
  for (;;) {
    if (!n) return n;
    if (ts.isParenthesizedExpression(n)) { n = n.expression; continue; }
    if (ts.isAsExpression?.(n)) { n = n.expression; continue; }
    if (ts.isSatisfiesExpression?.(n)) { n = n.expression; continue; }
    if (ts.isTypeAssertionExpression?.(n) || ts.isTypeAssertion?.(n)) { n = n.expression; continue; }
    if (ts.isNonNullExpression?.(n)) { n = n.expression; continue; }
    return n;
  }
}

/** return 遍历的下潜边界:任何 function-like(含对象字面量方法 / getter / 构造器)与 class。
 *  第 4 轮核验点名的假红:谓词体里写 `const o = { async m() { return fetch(x) } }; return true;`
 *  时旧边界(只列 function/arrow/class)会把内层方法的 return 当成谓词自己的返回值。 */
function isReturnBoundary(ts, n) {
  if (typeof ts.isFunctionLike === 'function' && ts.isFunctionLike(n)) return true;
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration?.(n) === true || ts.isGetAccessor?.(n) === true
    || ts.isSetAccessor?.(n) === true || ts.isConstructorDeclaration?.(n) === true
    || ts.isClassDeclaration(n) || ts.isClassExpression(n);
}

/** receiver 末段标识名(`a.b.page` → `page`;`page` → `page`);其它形态返回 null。 */
function receiverName(ts, expr) {
  const e = unwrapExpression(ts, expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/**
 * 表达式本身是否**语法上确定**返回 Promise。只认可判定的形态,不按方法名猜:
 *   await x / new Promise(...) / Promise.xxx(...) / (async () => ...)() /
 *   <白名单 receiver>.evaluate(...) / <本身是 Promise 的表达式>.then|catch|finally(...) /
 *   三元的任一分支满足。
 */
function isPromiseishExpression(ts, raw) {
  const e = unwrapExpression(ts, raw);
  if (!e) return false;
  if (ts.isAwaitExpression(e)) return true;
  // new target 也剥壳:`new (Promise)(...)`、`new global.Promise(...)`(第 4 轮核验点名)
  if (ts.isNewExpression(e) && receiverName(ts, e.expression) === 'Promise') return true;
  // 三元:任一分支是 Promise 就够——谓词返回值可能是 Promise,恒 truthy 的风险已成立
  if (ts.isConditionalExpression(e)) {
    return isPromiseishExpression(ts, e.whenTrue) || isPromiseishExpression(ts, e.whenFalse);
  }
  // 逻辑/空值合并:按 **JS 短路返回语义**判,不是"任一操作数有 Promise 形状就报"
  // (第 4 轮核验点名的假红:`() => Promise.resolve() && ready` 里 Promise 恒 truthy,
  //  `&&` 的值恒为 ready,谓词实际在等 ready,不是假等待)。
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    // `A && B`:A 确定是 Promise → 恒 truthy → 值恒为 B;A 不确定 → 值是 falsy 的 A
    // (falsy 值不可能是 Promise)或 B。两种情况风险都只来自 B。
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return isPromiseishExpression(ts, e.right);
    // `A || B` / `A ?? B`:A 确定是 Promise → 非 falsy/非 null → 值就是 A(风险成立);
    // 否则值可能是 B。任一侧确定是 Promise 即报。
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return isPromiseishExpression(ts, e.left) || isPromiseishExpression(ts, e.right);
    }
    if (op === ts.SyntaxKind.CommaToken) return isPromiseishExpression(ts, e.right);
  }
  if (ts.isCallExpression(e)) {
    const callee = unwrapExpression(ts, e.expression);
    // IIFE:`(async () => ...)()` 与**同步** literal IIFE `(() => Promise.resolve(1))()`
    // 都按函数体返回分析判(后者是第 4 轮核验点名的漏判:明确返回 Promise 却判 0)
    if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
      return functionLikeReturnsPromise(ts, callee) !== null;
    }
    // 成员调用:`.x()` 与 `["x"]()` 同义(`Promise["resolve"](1)` 也是 Promise)
    const memberName = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : (ts.isElementAccessExpression(callee) && callee.argumentExpression
        && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : null);
    if (memberName !== null) {
      if (receiverName(ts, callee.expression) === 'Promise') return true;      // Promise.resolve/all/race...
      if ((memberName === 'evaluate' || memberName === 'evaluateHandle')
        && ASYNC_HOLDER_RE.test(receiverName(ts, callee.expression) ?? '')) return true;
      // thenable 链:只有**链基本身已是 Promise** 时才算(`x.then()` 里的 x 可能是任意
      // 有 then 方法的同步对象——按名字猜会假红)
      if (memberName === 'then' || memberName === 'catch' || memberName === 'finally') {
        return isPromiseishExpression(ts, callee.expression);
      }
    }
  }
  return false;
}

/**
 * 字面量函数(箭头 / 函数表达式)是否 async 或**语法上确定返回 Promise**。
 * 与 isPromiseishExpression 互相递归:literal IIFE 的判定就是"对被调用的那个字面量函数
 * 做同一套返回分析"。
 */
function functionLikeReturnsPromise(ts, node) {
  if (!node) return null;
  if ((node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return 'async-function-predicate';
  // 简明箭头体:`() => new Promise(...)` / `() => Promise.resolve(x)` / `() => page.evaluate(...)`
  if (ts.isArrowFunction(node) && node.body && !ts.isBlock(node.body)) {
    return isPromiseishExpression(ts, node.body) ? 'returns-promise-predicate' : null;
  }
  // 有 block 体的 literal 函数:遍历自身作用域内的 return(第 1 轮核验漏判:
  // `() => { return new Promise(...) }` 此前完全不查)。**不下潜任何嵌套 function-like**
  // ——那些 return 属于内层函数,不是本函数的返回值(第 4 轮核验:对象方法/getter 也算)。
  if (!node.body || !ts.isBlock(node.body)) return null;
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (isReturnBoundary(ts, n)) return;
    if (ts.isReturnStatement(n) && isPromiseishExpression(ts, n.expression)) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node.body, walk);
  return found ? 'returns-promise-predicate' : null;
}

/** 谓词表达式是否 async / 显式返回 Promise(literal 函数体内的 return 也算)。 */
function isAsyncOrPromisePredicate(ts, raw) {
  // 第 3 轮核验:剥壳此前只作用在**返回表达式**上,谓词根节点本身被括号/断言包住时
  // (`waitForFunction((async () => true))`)整个判定被跳过。先剥谓词根节点。
  const node = unwrapExpression(ts, raw);
  if (!node) return null;
  // 标识符谓词(`waitForFunction(myPredicate)`):无法在词法层判定 → 不报(承诺面之外)
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return null;
  return functionLikeReturnsPromise(ts, node);
}

/** receiver 是否 lexical 的 page/frame。第 4 轮核验:`(page).waitForFunction(...)` 里
 *  receiver 是 ParenthesizedExpression,不剥壳则整条判定被跳过。 */
function isPageOrFrameReceiver(ts, expr) {
  const e = unwrapExpression(ts, expr);
  if (!e) return false;
  if (ts.isIdentifier(e)) return /^(page|frame)$/.test(e.text);
  if (ts.isPropertyAccessExpression(e)) return /^(page|frame)$/.test(e.name.text);
  return false;
}

/**
 * 扫一个文件,返回命中列表(含 1-based line)。
 * @returns {{ ok: boolean, hits: object[], error?: string }}
 */
export function scanSource(ts, { path, text }) {
  const kind = scriptKindFor(ts, path);
  if (kind == null) return { ok: true, hits: [], skipped: 'unsupported-extension' };
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, kind);
  // parseDiagnostics 是内部字段但稳定存在;语法错文件不给"无命中"结论
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length > 0) {
    return { ok: false, hits: [], error: `解析诊断 ${diags.length} 条(语法错误文件不产出"无命中"结论)` };
  }
  const rule = BUILTIN_RULES[0];
  const hits = [];
  const visit = (node) => {
    // callee 也剥壳:`(page.waitForFunction)(...)` 同样是同一个调用(第 4 轮核验)
    const calleeP = ts.isCallExpression(node) ? unwrapExpression(ts, node.expression) : null;
    if (calleeP && ts.isPropertyAccessExpression(calleeP)
      && calleeP.name.text === 'waitForFunction'
      && isPageOrFrameReceiver(ts, calleeP.expression)) {
      const why = isAsyncOrPromisePredicate(ts, node.arguments[0]);
      if (why) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push({
          ruleId: rule.ruleId, ruleVersion: rule.ruleVersion, severity: rule.severity,
          invariant: rule.invariant, reason: why,
          path, line: line + 1,
          nodeStartLine: line + 1,
          nodeEndLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          evidence: text.slice(node.getStart(sf), Math.min(node.getEnd(), node.getStart(sf) + 160)).split('\n')[0],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { ok: true, hits };
}

/**
 * 命中是否落在本次**真正新增/修改的行**上(SC-R8 hunk 的 addedNewLines)。
 * 用 addedNewLines 而不是 hunk newRanges:后者含 3 行上下文,会把"邻近有人改了一行"
 * 误判成"本次引入了这处旧命中",打回无关作者(实测踩到,已由 report-only 用例钉死)。
 */
export function hitTouchesNewLines(hit, addedLineSets) {
  const added = new Set((addedLineSets ?? []).flat());
  for (let ln = hit.nodeStartLine; ln <= hit.nodeEndLine; ln += 1) {
    if (added.has(ln)) return true;
  }
  return false;
}

export function ruleSetHash() {
  return `rs1-${createHash('sha256').update(JSON.stringify(BUILTIN_RULES)).digest('hex').slice(0, 16)}`;
}

/** ── SC-R6 第 3 轮核验:判定器调用的 AST 行范围 ──
 * 固定行窗口(12 行)在真实代码上仍会漏:17 行的 `assert.deepEqual(...)` 只改第 15 行时
 * 看不到调用头。改为按**调用节点**的真实行范围与 hunk 求交。
 *
 * 断言家族的识别包含 named import:`import { equal } from 'node:assert/strict'` 之后
 * 裸 `equal(...)` 也是断言(核验席实测漏判)。
 */
const ASSERT_MODULES = /^(node:)?assert(\/strict)?$/;
const WAIT_MEMBER_RE = /^(waitForFunction|waitForSelector|waitForTimeout|waitForEvent|waitForResponse|waitForLoadState|waitForNavigation|waitFor)$/;
// 断言链的**根**只认这几个名字(外加 assert 模块的 named/default import 名)。第 4 轮核验
// 删掉了"任意 receiver 只凭方法名(equal/match/...)就算断言"的兜底——它把 `"abc".match(/a/)`
// 判成断言,普通字符串/业务对象调用因此假红。
const ASSERT_ROOT_RE = /^(expect|assert|chai)$/;
const GUARD_MEMBER_RE = /^(exit)$/;
const GUARD_NAME_RE = /^(throwIf|invariant|assertInvariant|guard[A-Z]\w*|\w+Guard)$/;
const EXIT_CODE_RE = /^(exitCode|exit_code|returncode|statusCode)$/;

/** 调用链上出现过的标识名(由内到外),末位是链根。
 *  `expect(a).not.toEqual(b)` 的 callee.expression → ['not', 'expect'];
 *  `t.assert.equal(...)` → ['assert', 't'];`"abc".match` 的 receiver → []。 */
function chainNames(ts, node) {
  const names = [];
  let n = node;
  for (;;) {
    if (!n) break;
    if (ts.isCallExpression(n)) { n = n.expression; continue; }
    if (ts.isPropertyAccessExpression(n)) { names.push(n.name.text); n = n.expression; continue; }
    if (ts.isElementAccessExpression(n)) { n = n.expression; continue; }
    if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression?.(n) === true) { n = n.expression; continue; }
    break;
  }
  if (n && ts.isIdentifier(n)) names.push(n.text);
  return names;
}

/**
 * 扫一个文件,返回判定器调用的行范围。
 * @returns {{ ok: boolean, ranges?: {kind:'wait'|'assert'|'guard', startLine:number, endLine:number}[], error?: string }}
 */
export function oracleCallRanges(ts, { path, text }) {
  const kind = scriptKindFor(ts, path);
  if (kind == null) return { ok: true, ranges: [], skipped: 'unsupported-extension' };
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  if ((sf.parseDiagnostics ?? []).length > 0) {
    return { ok: false, ranges: [], error: `解析诊断 ${sf.parseDiagnostics.length} 条` };
  }
  // ① 收集从 assert 模块 named-import 进来的标识名
  const assertNames = new Set();
  const collectImports = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
      && ASSERT_MODULES.test(node.moduleSpecifier.text)) {
      const nb = node.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) assertNames.add(el.name.text);
      // 第 5 轮核验:namespace import(`import * as a from 'node:assert/strict'`)漏收——
      // `a` 就是整个 assert 模块本身,`a.deepEqual(...)` 必须能命中,与 default import
      // 走同一个集合(default import 名同样即"整个模块",两者语义相同)。
      if (nb && ts.isNamespaceImport?.(nb)) assertNames.add(nb.name.text);
      if (node.importClause?.name) assertNames.add(node.importClause.name.text); // default import
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(sf);

  const ranges = [];
  const push = (kindName, node) => {
    const s = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const e = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    ranges.push({ kind: kindName, startLine: s, endLine: e });
  };
  const isAssertName = (x) => ASSERT_ROOT_RE.test(x) || assertNames.has(x);
  // 已被外层断言链记过范围的内层调用:`expect(a).toEqual(b)` 记**最外层**(整条 matcher
  // 的行范围),内层 `expect(a)` 不再单独记短范围——上一版只记内层,多行 matcher 的远端
  // 参数行改动因此与断言范围不相交,required 凭空为 0(第 4 轮核验 BLOCKER)。
  const suppressed = new Set();
  const markCalleeChain = (node) => {
    let n = node.expression;
    for (;;) {
      if (!n) return;
      if (ts.isCallExpression(n)) { suppressed.add(n); n = n.expression; continue; }
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)
        || ts.isParenthesizedExpression(n) || ts.isNonNullExpression?.(n) === true) { n = n.expression; continue; }
      return;
    }
  };
  // 成员名 + 被访问的基础表达式,PropertyAccess(`.toEqual`)与 ElementAccess(字符串字面量
  // 下标 `['toEqual']`)统一处理(第 5 轮核验 BLOCKER:上一版只认 PropertyAccessExpression,
  // `expect(actual)['toEqual']({...})` 的外层调用完全不落入任何分支——既不分类,也不
  // markCalleeChain 抑制内层——于是只剩内层 `expect(actual)` 的短范围,多行 matcher 的
  // 远端参数行改动与断言范围不相交,required 仍可能凭空为 0)。
  const memberOf = (n) => {
    if (ts.isPropertyAccessExpression(n)) return { name: n.name.text, base: n.expression };
    if (ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) {
      return { name: n.argumentExpression.text, base: n.expression };
    }
    return null;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && !suppressed.has(node)) {
      const callee = unwrapExpression(ts, node.expression);
      if (ts.isIdentifier(callee)) {
        if (isAssertName(callee.text)) push('assert', node);
        else if (GUARD_NAME_RE.test(callee.text)) push('guard', node);
      } else {
        const mem = memberOf(callee);
        if (mem) {
          const { name: prop, base } = mem;
          const names = chainNames(ts, base);
          const root = names.length > 0 ? names[names.length - 1] : null;
          if (WAIT_MEMBER_RE.test(prop)) push('wait', node);
          else if (names.some(isAssertName)) { push('assert', node); markCalleeChain(node); }
          else if (root === 'process' && GUARD_MEMBER_RE.test(prop)) push('guard', node);
          else if (GUARD_NAME_RE.test(prop)) push('guard', node);
        }
      }
    }
    // 退出码/返回码的**消费**(`r.exitCode !== 0`、`if (r.status)`):按属性访问所在语句算 guard
    if (ts.isPropertyAccessExpression(node) && EXIT_CODE_RE.test(node.name.text)) push('guard', node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { ok: true, ranges };
}
