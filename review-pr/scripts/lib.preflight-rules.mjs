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
//     泛化成"任何 .waitFor" 会产生假红(复审裁决,已在 fixture 钉死零误报)。
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = resolve(HERE, '..', 'vendor', 'typescript');
const VENDOR_ENTRY = join(VENDOR_DIR, 'typescript.js');
const PROVENANCE = join(VENDOR_DIR, 'PROVENANCE.json');

/** 规则注册表:内置规则(代码层 always-on)。ruleVersion 参与 SC-R5 的自动核销判定—— * 规则实现变了不能冒充"代码已修",所以版本变化时旧 finding 保持 open。 */
export const BUILTIN_RULES = [
  {
    ruleId: 'playwright-waitforfunction-async-predicate',
    ruleVersion: 'v1',
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

/** 谓词表达式是否 async / 显式返回 Promise。 */
function isAsyncOrPromisePredicate(ts, node) {
  if (!node) return null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const isAsync = (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    if (isAsync) return 'async-function-predicate';
    // 简明箭头体直接是 Promise 表达式:`() => page.evaluate(...)` / `() => Promise.resolve(x)`
    if (ts.isArrowFunction(node) && node.body && !ts.isBlock(node.body)) {
      const b = node.body;
      if (ts.isCallExpression(b) && ts.isPropertyAccessExpression(b.expression)) {
        const obj = b.expression.expression;
        const prop = b.expression.name.text;
        if (ts.isIdentifier(obj) && obj.text === 'Promise') return 'returns-promise-predicate';
        if (prop === 'evaluate' || prop === 'evaluateHandle') return 'returns-promise-predicate';
      }
      if (ts.isAwaitExpression(b)) return 'async-function-predicate';
    }
    return null;
  }
  // 标识符谓词(`waitForFunction(myPredicate)`):无法在词法层判定 → 不报(承诺面之外)
  return null;
}

/** receiver 是否 lexical 的 page/frame。 */
function isPageOrFrameReceiver(ts, expr) {
  if (ts.isIdentifier(expr)) return /^(page|frame)$/.test(expr.text);
  if (ts.isPropertyAccessExpression(expr)) return /^(page|frame)$/.test(expr.name.text);
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
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'waitForFunction'
      && isPageOrFrameReceiver(ts, node.expression.expression)) {
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
