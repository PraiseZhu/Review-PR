// gh-route-inventory.test.mjs — 前置审查全部 gh 调用清单守卫(PraiseZhu/Review-PR#174)。
//
// 清单 mivo/prereview/gh-route-inventory.json 逐条登记 review-pr/scripts、mivo/prereview、mivo/lib 三个根里
// 非测试 .mjs 的全部 gh 调用模板。本测试做三件事:
//   1. 词法扫描源码(不 import、不执行被扫模块),与清单按"文件 + 调用名 + 规范化参数指纹"做多重集合双向比较:
//      新增、删除、修改任一调用(含查询字符串里的敏感字段、args.push 的字段)而没更新清单都会失败;改行号、注释、空白不会。
//   2. 清单里每个 case 的 argv/stdin 经 vendor 分类器(与 Mivo gh 分流器同一份)得到的路由必须等于 expected。
//   3. expected=user 的 case 必须说明去向:flipsIn(后续 issue 会让它变 app)或 keep(只允许三类可机器校验的理由)。
// 另外对 flows 含 server 的 case,用 gh-read-route 的 decideReadRoute 分别算旧 vendor 和新 vendor 的路由,不允许 app→user。
//
// 清单怎么更新:改了 gh 调用后跑 `node --test mivo/prereview/gh-route-inventory.test.mjs`,失败信息会指出缺哪个调用;
// 在 JSON 里补/改对应条目(sig 取失败信息给出的值),给出可执行的 argv 样本与 expected,再重跑。见 mivo/README.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify, needsStdin, APP } from '../../review-pr/scripts/vendor/gh-app-classify.mjs';
import { decideReadRoute } from '../../review-pr/scripts/gh-read-route.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INVENTORY_PATH = join(REPO_ROOT, 'mivo/prereview/gh-route-inventory.json');
const ROOTS = ['review-pr/scripts', 'mivo/prereview', 'mivo/lib'];
// flipsIn 只允许指向真正会让这条调用改走 App 的后续 issue:读侧、身份读取、受限写。
const ALLOWED_FLIPS = ['xindong/mivo-canvas-plugin#1751', 'PraiseZhu/Review-PR#176', 'xindong/mivo-canvas-plugin#1752'];
const KEEP_CATEGORIES = ['pr-merge-approve', 'unreachable-under-config', 'interactive-skill'];
const FLOWS = ['mini', 'server', 'interactive'];
// unreachable-under-config 只能豁免这两种具体调用(每个 case 的 guard 字段指向其中一种,argv 必须匹配形状):
//   maintainer-team:CODEOWNERS 根 Team 的成员/权限读取(maintainerSource=allowlist 时不走);
//   auth-status-without-viewer:没设 REVIEW_PR_VIEWER_LOGIN 时的 `gh auth status` 兼容分支(线上审查身份已设)。
const UNREACHABLE_GUARDS = {
  'maintainer-team': {
    files: ['review-pr/scripts/lib.mjs'],
    matches: (argv) => argv[0] === 'api' && argv.some((a) => /^(?:orgs\/[^/]+\/)?teams\/[^/?]+(?:\/(?:members|repos)(?:\/[^?]*)?)?(?:\?.*)?$/.test(String(a))),
  },
  'auth-status-without-viewer': {
    files: ['review-pr/scripts/lib.mjs'],
    matches: (argv) => argv.length === 2 && argv[0] === 'auth' && argv[1] === 'status',
  },
};

// ── lexer ──────────────────────────────────────────────────────────────────
// analyze(src) → { masked, code }:masked 是把注释换成空格后的同长文本;code[i]=1 表示该字符是代码
// (不在字符串/模板正文/正则里)。括号配对和"是不是真调用"都只看 code[i]。

export function analyze(src) {
  const n = src.length;
  const masked = src.split('');
  const code = new Uint8Array(n);
  const stack = [{ mode: 'code', brace: 0 }];
  const prevCodeChar = (at) => {
    for (let k = at - 1; k >= 0; k--) if (code[k] && !/\s/.test(src[k])) return k;
    return -1;
  };
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    if (top.mode === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ mode: 'code', brace: 0 }); i += 2; continue; }
      i++;
      continue;
    }
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { masked[i] = ' '; code[i] = 1; i++; } continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) { if (src[k] !== '\n') masked[k] = ' '; code[k] = 1; }
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '`') { stack.push({ mode: 'tpl' }); i++; continue; }
    if (c === '/') {
      const p = prevCodeChar(i);
      const before = p < 0 ? '' : src.slice(Math.max(0, p - 6), p + 1);
      const regexStart = p < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(src[p]) || /(?:return|typeof|case)$/.test(before);
      if (regexStart) {
        i++;
        let inClass = false;
        while (i < n && (inClass || src[i] !== '/') && src[i] !== '\n') {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          i++;
        }
        i++;
        continue;
      }
    }
    if (c === '{') top.brace++;
    if (c === '}') {
      if (top.brace === 0 && stack.length > 1) { stack.pop(); i++; continue; }
      top.brace--;
    }
    code[i] = 1;
    i++;
  }
  return { masked: masked.join(''), code };
}

const OPEN = { '(': ')', '[': ']', '{': '}' };
function findClose(ctx, openAt) {
  let depth = 0;
  for (let i = openAt; i < ctx.masked.length; i++) {
    if (!ctx.code[i]) continue;
    const c = ctx.masked[i];
    if (c in OPEN || c === ')' || c === ']' || c === '}') {
      if (c in OPEN) depth++;
      else if (--depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(ctx, from, to) {
  const parts = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (!ctx.code[i]) continue;
    const c = ctx.masked[i];
    if (c in OPEN) depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push([start, i]); start = i + 1; }
  }
  if (ctx.masked.slice(start, to).trim()) parts.push([start, to]);
  return parts;
}

function statementEnd(ctx, from) {
  let depth = 0;
  for (let i = from; i < ctx.masked.length; i++) {
    if (!ctx.code[i]) continue;
    const c = ctx.masked[i];
    if (c in OPEN) depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth <= 0) return i + 1;
  }
  return ctx.masked.length;
}

// 规范化:代码里的空白、注释、尾逗号不参与指纹;字符串/模板正文逐字保留。
function canon(ctx, from, to) {
  const out = [];
  let pendingSpace = false;
  for (let i = from; i < to; i++) {
    const c = ctx.masked[i];
    if (ctx.code[i] && /\s/.test(c)) { pendingSpace = true; continue; }
    if (ctx.code[i] && (c === ')' || c === ']' || c === '}') && out.length && out[out.length - 1].code && out[out.length - 1].ch === ',') out.pop();
    if (pendingSpace && out.length && /[\w$]/.test(out[out.length - 1].ch) && /[\w$]/.test(c) && ctx.code[i] && out[out.length - 1].code) out.push({ ch: ' ', code: true });
    pendingSpace = false;
    out.push({ ch: c, code: Boolean(ctx.code[i]) });
  }
  while (out.length && out[out.length - 1].code && out[out.length - 1].ch === ',') out.pop();
  return out.map((o) => o.ch).join('');
}
const norm = (text) => text.replace(/\s+/g, ' ').trim();

// ── scanner ────────────────────────────────────────────────────────────────

const CALLEES = ['gh', 'ghJson', 'ghFn', 'ghRead', 'writeGh', 'ghGraphql', 'ghGraphqlFn', 'fetchRestPages', 'fetchPaginatedRestItems', 'fetchGraphqlConnection'];
const SPAWNERS = ['run', 'spawnSync', 'spawn', 'execFileSync', 'execFile'];
const GH_SHAPED_FIRST = ['api', 'pr', 'issue', 'repo', 'label', 'run', 'variable', 'workflow', 'auth', 'search', 'release'];

// ── 依赖解析 ───────────────────────────────────────────────────────────────
// 调用的参数(数组、选项对象)里出现的每个标识符,都按「调用点所在函数 → 外层各函数 → 模块顶层」的词法作用域链找来源:
//   形参 → 不进指纹(调用方决定值),但函数体里其它改动它的语句要并入;
//   const/let/var/function 声明 → 声明表达式并入指纹(递归 3 层),声明之后改动它的语句也并入;
//   import 进来的名字:相对路径且在扫描根内 → 并入被引用模块里的声明;其它(node:、内建)视为外部;
//   同一作用域层可见的同名声明不止一个(块级遮蔽)、或哪一层都找不到 → unresolved(测试红)。
// 「纯转发」= 调用的某个实参是形参本身(args / ...rest),且函数体里没有任何其它语句提到它;否则不是转发封装,必须有 case。
const JS_WORDS = new Set(['const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'class', 'extends', 'import', 'export', 'default', 'true', 'false', 'null', 'undefined', 'this', 'new', 'typeof', 'void', 'await', 'async', 'function', 'return', 'of', 'in', 'instanceof', 'delete',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Set', 'Map', 'RegExp', 'Error', 'Buffer', 'Symbol', 'Promise', 'Infinity', 'NaN',
  'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'process', 'console', 'globalThis', 'require', 'setTimeout', 'clearTimeout', 'URL', 'Atomics', 'Int32Array', 'SharedArrayBuffer']);
const PURE_CALLEES = /^(?:String|Number|Boolean|encodeURIComponent|decodeURIComponent|parseInt|parseFloat|isNaN|Array\.isArray|Object\.keys|Object\.values|Object\.entries|JSON\.stringify|Math\.\w+|typeof)$/;
const MUTATING_METHODS = 'push|unshift|splice|concat|pop|shift|reverse|sort|fill|set|add|assign|copyWithin|delete|clear|append';

const ANALYZE_CACHE = new Map();
function analyzeCached(src) {
  let c = ANALYZE_CACHE.get(src);
  if (!c) { c = analyze(src); ANALYZE_CACHE.set(src, c); }
  return c;
}

function stripDefault(t) {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '=' && depth === 0 && t[i + 1] !== '>' && t[i + 1] !== '=') return t.slice(0, i).trim();
  }
  return t.trim();
}

function patternNames(text) {
  const names = [];
  const walk = (piece) => {
    let t = piece.trim().replace(/^\.\.\./, '');
    if (!t) return;
    t = stripDefault(t);
    if (t.startsWith('{') || t.startsWith('[')) {
      const inner = t.slice(1, t.lastIndexOf(t[0] === '{' ? '}' : ']'));
      for (const part of splitTop(inner, ',')) walk(part.includes(':') && t[0] === '{' ? part.slice(part.indexOf(':') + 1) : part);
      return;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(t)) names.push(t);
  };
  for (const part of splitTop(text, ',')) walk(part);
  return names;
}

// 嵌套括号安全的顶层逗号切分(给参数形参和对象/数组模式用)
function splitTop(text, sep) {
  const parts = [];
  let depth = 0, cur = '', q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { cur += c; if (c === '\\') cur += text[++i] ?? ''; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 文件里所有函数(含箭头函数、catch 块)的形参表:{ start, names, listEnd, bodyEnd }。 */
function functionScopes(ctx) {
  if (ctx.scopes) return ctx.scopes;
  const out = [];
  const m = ctx.masked;
  const bodyEndFrom = (at) => {
    let i = at;
    while (i < m.length && /\s/.test(m[i])) i++;
    if (m[i] === '{') { const c = findClose(ctx, i); return c < 0 ? m.length : c; }
    let depth = 0;
    for (; i < m.length; i++) {
      if (!ctx.code[i]) continue;
      const c = m[i];
      if (c in OPEN) depth++;
      else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) return i; }
      else if ((c === ',' || c === ';') && depth === 0) return i;
    }
    return m.length;
  };
  for (const f of m.matchAll(/\bfunction\s*\*?\s*[\w$]*\s*\(/g)) {
    if (!ctx.code[f.index]) continue;
    const open = f.index + f[0].length - 1;
    const close = findClose(ctx, open);
    if (close < 0) continue;
    const brace = m.indexOf('{', close);
    out.push({ start: f.index, names: patternNames(m.slice(open + 1, close)), listEnd: close, bodyEnd: brace < 0 ? m.length : bodyEndFrom(brace) });
  }
  for (const a of m.matchAll(/=>/g)) {
    if (!ctx.code[a.index]) continue;
    let k = a.index - 1;
    while (k >= 0 && /\s/.test(m[k])) k--;
    let names = [];
    let start = k;
    if (m[k] === ')') {
      let depth = 0, j = k;
      for (; j >= 0; j--) { if (!ctx.code[j]) continue; if (m[j] === ')') depth++; else if (m[j] === '(' && --depth === 0) break; }
      if (j < 0) continue;
      names = patternNames(m.slice(j + 1, k));
      start = j;
    } else {
      const id = /[A-Za-z_$][\w$]*$/.exec(m.slice(Math.max(0, k - 80), k + 1));
      if (!id) continue;
      names = [id[0]];
      start = k - id[0].length + 1;
    }
    out.push({ start, names, listEnd: k, bodyEnd: bodyEndFrom(a.index + 2) });
  }
  for (const c of m.matchAll(/\bcatch\s*\(([^)]*)\)\s*\{/g)) {
    if (!ctx.code[c.index]) continue;
    const open = c.index + c[0].length - 1;
    out.push({ start: c.index, names: patternNames(c[1]), listEnd: c.index + 5, bodyEnd: findClose(ctx, open) });
  }
  ctx.scopes = out;
  return out;
}

/** 包含 pos 的函数/catch 作用域,最内层在前。 */
function scopeChain(ctx, pos) {
  return functionScopes(ctx).filter((s) => s.start < pos && pos <= s.bodyEnd).sort((a, b) => b.start - a.start);
}

function blockPairs(ctx) {
  if (ctx.blocks) return ctx.blocks;
  const out = [];
  const stack = [];
  for (let i = 0; i < ctx.masked.length; i++) {
    if (!ctx.code[i]) continue;
    if (ctx.masked[i] === '{') stack.push(i);
    else if (ctx.masked[i] === '}') { const o = stack.pop(); if (o !== undefined) out.push({ open: o, close: i }); }
  }
  ctx.blocks = out;
  return out;
}
function innermostBlock(ctx, pos) {
  let best = null;
  for (const b of blockPairs(ctx)) if (b.open < pos && pos < b.close && (!best || b.open > best.open)) best = b;
  return best;
}

/** for (const x of ...) 的声明只在这条 for 语句里可见。 */
function forStatementRange(ctx, pos) {
  const m = ctx.masked;
  let depth = 0;
  for (let j = pos - 1; j >= 0; j--) {
    if (!ctx.code[j]) continue;
    if (m[j] === ')') depth++;
    else if (m[j] === '(') {
      if (depth === 0) {
        if (!/\bfor\s*(?:await\s*)?$/.test(m.slice(Math.max(0, j - 12), j))) return null;
        const close = findClose(ctx, j);
        let k = close + 1;
        while (k < m.length && /\s/.test(m[k])) k++;
        return { open: j, close: m[k] === '{' ? findClose(ctx, k) : statementEnd(ctx, k) };
      }
      depth--;
    }
  }
  return null;
}

/** name 在本文件里的全部声明:{ at, kind, level, block }。level = 声明所在函数的 start(模块顶层 -1)。 */
function declsOf(ctx, name) {
  ctx.declCache ??= new Map();
  if (ctx.declCache.has(name)) return ctx.declCache.get(name);
  const esc = name.replace(/\$/g, '\\$');
  const out = [];
  const add = (at, kind, isVar) => {
    const scope = scopeChain(ctx, at)[0];
    const block = isVar ? null : (forStatementRange(ctx, at) ?? innermostBlock(ctx, at));
    out.push({ at, kind, level: scope ? scope.start : -1, block });
  };
  for (const mt of ctx.masked.matchAll(new RegExp(`(?<![\\w$])(?:const|let|var)\\s+${esc}(?![\\w$])`, 'g'))) {
    if (ctx.code[mt.index]) add(mt.index, 0, /^var\b/.test(mt[0]));
  }
  for (const mt of ctx.masked.matchAll(/(?<![\w$])(?:const|let|var)\s*([{\[])/g)) { // 解构声明
    if (!ctx.code[mt.index]) continue;
    const open = mt.index + mt[0].length - 1;
    const close = findClose(ctx, open);
    if (close < 0 || !patternNames(ctx.masked.slice(open, close + 1)).includes(name)) continue;
    if (/^\s*(?:=(?!=)|of\b|in\b)/.test(ctx.masked.slice(close + 1, close + 8))) add(mt.index, 1, /^var\b/.test(mt[0]));
  }
  for (const mt of ctx.masked.matchAll(new RegExp(`(?<![\\w$])function\\s*\\*?\\s+${esc}\\s*\\(`, 'g'))) {
    if (ctx.code[mt.index]) add(mt.index, 2, true);
  }
  ctx.declCache.set(name, out);
  return out;
}

/** 词法作用域里 name 在 at 处指向什么:{ type: 'decl'|'param'|'ambiguous'|null, ... }。 */
function resolveName(ctx, name, at) {
  for (const sc of [...scopeChain(ctx, at), null]) {
    const level = sc ? sc.start : -1;
    const ds = declsOf(ctx, name).filter((d) => d.level === level && (d.block === null || (d.block.open < at && at < d.block.close)));
    // 块级遮蔽:可见的同名声明里,块最内层的那个才是实际绑定(lib.mjs 的 allowlistedMembers 就是这样);同一个块里有两处同名声明才算说不清。
    const innermost = ds.length > 1 ? Math.max(...ds.map((d) => (d.block ? d.block.open : -1))) : null;
    const bound = ds.length > 1 ? ds.filter((d) => (d.block ? d.block.open : -1) === innermost) : ds;
    if (bound.length > 1) return { type: 'ambiguous' };
    if (bound.length === 1) return { type: 'decl', decl: bound[0], level };
    if (sc && sc.names.includes(name)) return { type: 'param', scope: sc };
  }
  return { type: null };
}

function declText(ctx, decl) {
  const m = ctx.masked;
  if (decl.kind === 2) { // 函数声明:签名 + 函数体
    const open = m.indexOf('(', decl.at);
    const close = findClose(ctx, open);
    const brace = m.indexOf('{', close);
    const end = findClose(ctx, brace) + 1;
    return { text: canon(ctx, decl.at, end), from: decl.at, to: end, isFunction: true };
  }
  const semi = statementEnd(ctx, decl.at);
  const forHeader = /^(?:const|let|var)\s+(?:[\w$]+\s+|[{\[][^=;]*[}\]]\s*)(?:of|in)\b/.test(m.slice(decl.at, decl.at + 80));
  if (forHeader) {
    let depth = 0, i = decl.at;
    for (; i < m.length; i++) { if (!ctx.code[i]) continue; if (m[i] in OPEN) depth++; else if (')]}'.includes(m[i]) && --depth < 0) break; }
    return { text: canon(ctx, decl.at, i), from: decl.at, to: i, isFunction: false };
  }
  const eqRaw = m.indexOf('=', decl.at);
  const eqAt = eqRaw >= 0 && eqRaw < semi ? eqRaw : -1; // let x; 没有初始值:赋值散落在后面
  if (eqAt < 0) return { text: canon(ctx, decl.at, semi), from: decl.at, to: semi, isFunction: false, uninitialized: true };
  const end = statementEnd(ctx, eqAt);
  const isFn = /^\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^\s*(?:async\s+)?function\b/.test(m.slice(eqAt + 1, eqAt + 200));
  return { text: canon(ctx, decl.at, end), from: decl.at, to: end, isFunction: isFn };
}

/** [from, to] 里出现的标识符(只算代码、不算属性名/对象键/范围内自己声明的):{ name, at, isCall }。 */
function identifiersIn(ctx, from, to) {
  const m = ctx.masked;
  const local = new Set();
  const range = m.slice(from, to);
  for (const a of range.matchAll(/\(([^()]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>/g)) for (const n of patternNames(a[1] ?? a[2])) local.add(n);
  for (const d of range.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(d[1]);
  for (const d of range.matchAll(/catch\s*\(([^)]*)\)/g)) for (const n of patternNames(d[1])) local.add(n);
  for (const d of range.matchAll(/(?:const|let|var)\s*([{\[][^=;]*[}\]])\s*=/g)) for (const n of patternNames(d[1])) local.add(n);
  const found = [];
  for (const id of range.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) {
    const at = from + id.index;
    if (!ctx.code[at]) continue;
    if (at > 0 && m[at - 1] === '/' && !ctx.code[at - 1]) continue; // 正则字面量后面的 flags(如 /x/m)
    const name = id[0];
    if (JS_WORDS.has(name) || local.has(name)) continue;
    let p = at - 1;
    while (p >= 0 && /\s/.test(m[p])) p--;
    if (m[p] === '.' && m.slice(p - 2, p + 1) !== '...') continue; // 属性访问
    let n = at + name.length;
    while (n < m.length && /\s/.test(m[n])) n++;
    if (m[n] === ':' && (m[p] === '{' || m[p] === ',')) continue; // 对象键
    found.push({ name, at, isCall: m[n] === '(' });
  }
  return found;
}

/** pos 所在语句的 [start, end)。 */
function statementRange(ctx, pos, lo, hi) {
  const m = ctx.masked;
  let start = lo;
  let depth = 0;
  for (let j = pos - 1; j >= lo; j--) {
    if (!ctx.code[j]) continue;
    const c = m[j];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') { if (depth === 0) { start = j + 1; break; } depth--; }
    else if (c === '}') { if (depth === 0) { start = j + 1; break; } depth++; }
    else if (c === '{') { if (depth === 0) { start = j + 1; break; } depth--; }
    else if (c === ';' && depth === 0) { start = j + 1; break; }
  }
  let end = hi;
  depth = 0;
  for (let j = pos; j < hi; j++) {
    if (!ctx.code[j]) continue;
    const c = m[j];
    if (c in OPEN) depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) { end = j; break; } }
    else if (c === ';' && depth === 0) { end = j + 1; break; }
  }
  return [start, end];
}

function calleeBefore(ctx, pos) { // pos 是裸实参的位置:找包着它的那个调用的函数名
  const m = ctx.masked;
  let depth = 0;
  for (let j = pos - 1; j >= 0; j--) {
    if (!ctx.code[j]) continue;
    if (m[j] === ')' || m[j] === ']' || m[j] === '}') depth++;
    else if (m[j] === '(' || m[j] === '[' || m[j] === '{') { if (depth === 0) return /([\w$.]+)\s*$/.exec(m.slice(Math.max(0, j - 60), j))?.[1] ?? ''; depth--; }
  }
  return '';
}

/** 一处提到 name 的位置算不算「会改动它」:赋值、下标赋值、自增、改动型方法、当作裸实参传给别的函数。 */
function isMutationMention(ctx, at, name, container) {
  const m = ctx.masked;
  const after = m.slice(at + name.length, at + name.length + 80);
  const before = m.slice(Math.max(0, at - 6), at);
  if (/^\s*(?:\+|-|\*|\/|\?\?|\|\||&&)?=(?![=>])/.test(after)) return true;
  if (/^\s*\[[^\]]*\]\s*(?:\+|\?\?)?=(?!=)/.test(after)) return true;
  if (/^\s*(?:\+\+|--)/.test(after) || /(?:\+\+|--)\s*$/.test(before)) return true;
  if (new RegExp(`^\\s*\\.\\s*(?:${MUTATING_METHODS})\\s*\\(`).test(after)) return true;
  if (container && /(?:\(|,)\s*$/.test(before) && /^\s*[,)]/.test(after)) return !PURE_CALLEES.test(calleeBefore(ctx, at)); // 数组/对象当作裸实参传给别的函数(可能被改动)
  if (/\.\.\.\s*$/.test(before) && /^\s*[,)\]]/.test(after)) return false; // 展开进别的数组/调用:读,不改动
  return false;
}

/** [lo, hi) 里提到 name 的语句(去重),strict=true 时任何一处提到都算,否则只算会改动它的。skip 是要排除的区间(调用本身)。 */
function mentionStatements(ctx, name, lo, hi, { strict, skip, container, same }) {
  const m = ctx.masked;
  const found = [];
  const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  const slice = m.slice(lo, hi);
  for (const mt of slice.matchAll(re)) {
    const at = lo + mt.index;
    if (!ctx.code[at]) continue;
    let p = at - 1;
    while (p >= lo && /\s/.test(m[p])) p--;
    if (m[p] === '.' && m.slice(p - 2, p + 1) !== '...') continue;
    let n = at + name.length;
    while (n < hi && /\s/.test(m[n])) n++;
    if (m[n] === ':' && (m[p] === '{' || m[p] === ',')) continue;
    if (skip && at >= skip[0] && at <= skip[1]) continue;
    if (same && !same(at)) continue; // 其它作用域里的同名变量不是它
    if (!strict && !isMutationMention(ctx, at, name, container)) continue;
    const [s, e] = statementRange(ctx, at, lo, hi);
    if (!found.some(([a, b]) => a === s && b === e)) found.push([s, e]);
  }
  return found;
}

function importMap(ctx) {
  if (ctx.imports) return ctx.imports;
  const map = new Map();
  for (const mt of ctx.masked.matchAll(/\bimport\s+([^'"]*?)\s+from\s*['"]([^'"]+)['"]/g)) {
    if (!ctx.code[mt.index]) continue;
    const clause = mt[1];
    const braces = /\{([^}]*)\}/.exec(clause);
    const def = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean)[0];
    if (def && !def.startsWith('*')) map.set(def, { imported: 'default', spec: mt[2] });
    for (const part of (braces?.[1] ?? '').split(',')) {
      const [imp, local] = part.trim().split(/\s+as\s+/);
      if (imp) map.set(local ?? imp, { imported: imp, spec: mt[2] });
    }
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) map.set(ns[1], { imported: '*', spec: mt[2] });
  }
  ctx.imports = map;
  return map;
}

/** 相对 import 且指向扫描根内的文件:返回被引用的声明文本;其它 import(node:、内建、扫描根外)返回 null。 */
function importedDeclText(ctx, name, files) {
  const info = importMap(ctx).get(name);
  if (!info || !files || !info.spec.startsWith('.') || info.imported === '*' || info.imported === 'default') return null;
  const dir = ctx.file.split('/').slice(0, -1).join('/');
  const target = join(dir, info.spec).split(sep).join('/');
  const src = files.get(target);
  if (src === undefined) return null;
  const mctx = analyzeCached(src);
  mctx.file = target;
  const decl = declsOf(mctx, info.imported).find((d) => d.level === -1);
  return decl ? declText(mctx, decl).text : null;
}

export const __ctx = (src) => analyzeCached(src);
export const __declsOf = declsOf;
function resolveDeps(ctx, callRange, target, files) {
  const { open: openAt, close: closeAt } = callRange;
  const [exprFrom, exprTo] = target;
  const deps = [];
  const unresolved = [];
  let impure = false;
  let forwarder = null;
  const seen = new Set();
  const first = ctx.masked.slice(exprFrom, exprTo).trim().replace(/^\.\.\./, '');
  const bareIdent = /^[A-Za-z_$][\w$]*$/.test(first) ? first : null;
  const strictNames = new Set(splitTopLevel(ctx, openAt + 1, closeAt)
    .map(([a, b]) => ctx.masked.slice(a, b).trim().replace(/^\.\.\./, ''))
    .filter((t) => /^[A-Za-z_$][\w$]*$/.test(t)));
  const push = (text) => { if (!deps.includes(text)) deps.push(text); };
  const absorb = (stmts, depth) => {
    for (const [s, e] of stmts) {
      push(canon(ctx, s, e));
      if (depth < 3) for (const sub of identifiersIn(ctx, s, e)) visit(sub, depth + 1);
    }
  };
  const visit = (id, depth) => {
    const { name, at } = id;
    const r = resolveName(ctx, name, at);
    const top = depth === 0;
    const strict = top && strictNames.has(name);
    const skip = top ? [openAt, closeAt] : null;
    if (r.type === 'ambiguous') { unresolved.push(`${name}(同一作用域层有多处同名声明,无法确定指哪一个)`); return; }
    if (r.type === 'param') {
      const key = `param:${r.scope.start}:${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      const body = [r.scope.listEnd + 1, r.scope.bodyEnd];
      const stmts = mentionStatements(ctx, name, body[0], strict ? body[1] : Math.min(body[1], closeAt), { strict, skip, same: (a) => { const x = resolveName(ctx, name, a); return x.type === 'param' && x.scope.start === r.scope.start; } });
      if (strict && stmts.length) impure = true;
      if (top && name === bareIdent && strict && !stmts.length) forwarder = name;
      absorb(stmts, depth);
      return;
    }
    if (r.type === 'decl') {
      const key = `decl:${r.decl.at}`;
      if (seen.has(key)) return;
      seen.add(key);
      const info = declText(ctx, r.decl);
      push(info.text);
      if (info.isFunction) {
        if (depth < 2) for (const sub of identifiersIn(ctx, info.from, info.to)) if (sub.name !== name) visit(sub, depth + 1);
        return;
      }
      const scope = functionScopes(ctx).find((s) => s.start === r.level);
      const levelEnd = scope ? scope.bodyEnd : ctx.masked.length;
      const hi = strict || info.uninitialized ? levelEnd : Math.min(levelEnd, closeAt);
      absorb(mentionStatements(ctx, name, info.to, hi, { strict, skip, container: /^(?:const|let|var)\s*[\w$]+=\s*[\[{]/.test(info.text), same: (a) => { const x = resolveName(ctx, name, a); return x.type === 'decl' && x.decl.at === r.decl.at; } }), depth);
      if (depth < 3) for (const sub of identifiersIn(ctx, info.from, info.to)) if (sub.name !== name) visit(sub, depth + 1);
      return;
    }
    // 没找到:import / 内建 / 找不到
    const key = `import:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (importMap(ctx).has(name)) {
      const text = importedDeclText(ctx, name, files);
      if (text) push(text);
      return;
    }
    unresolved.push(name);
  };
  for (const id of identifiersIn(ctx, exprFrom, closeAt)) visit(id, 0);
  return { deps, forwarder: impure ? null : forwarder, unresolved: [...new Set(unresolved)] };
}

/** 扫一个文件:返回调用模板列表和无法解析的位置。 */
export function scanFile(file, src, files = null) {
  const ctx = analyzeCached(src);
  ctx.file = file;
  const templates = [];
  const unresolved = [];
  const aliases = [
    ...ctx.masked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:ghFn\s*\?\?\s*)?gh(?![\w$])/g),
    ...ctx.masked.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*createPrWriteGuard\s*\(/g),
    ...ctx.masked.matchAll(new RegExp(`(?<![\\w$])(?:${CALLEES.join('|')})\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*[,}=]`, 'g')), // const { gh: g } = lib
  ].map((m) => m[1]).filter((a) => !CALLEES.includes(a));
  for (const [local, info] of importMap(ctx)) if (CALLEES.includes(info.imported) && local !== info.imported) aliases.push(local); // import { gh as g }
  const names = [...CALLEES, ...aliases];
  const callRe = new RegExp(`(?<![\\w$])((?:(?:api|lib)\\.)?(?:${names.join('|')}))\\s*\\(`, 'g');
  const spawnRe = new RegExp(`(?<![\\w$.])(${SPAWNERS.join('|')})\\s*\\(\\s*['"]gh['"]`, 'g');
  const known = new Set(names);
  const record = (kind, callee, openAt, argIndex) => {
    if (!ctx.code[openAt - 1] && !ctx.code[openAt]) return;
    const close = findClose(ctx, openAt);
    if (close < 0) { unresolved.push({ file, callee, why: '括号不配对' }); return; }
    const after = ctx.masked.slice(close + 1).match(/^\s*(\S)/)?.[1];
    const before = ctx.masked.slice(Math.max(0, openAt - 80), openAt);
    if (after === '{' || /\bfunction\s+[\w$]*\s*$/.test(before) || /\bfunction\s+[\w$.]+\s*$/.test(before)) return; // 函数/方法定义
    const parts = splitTopLevel(ctx, openAt + 1, close);
    const argsText = canon(ctx, openAt + 1, close);
    const target = parts[argIndex];
    if (!target) { unresolved.push({ file, callee, why: '缺少参数' }); return; }
    const dep = resolveDeps(ctx, { open: openAt, close }, target, files);
    for (const name of dep.unresolved) unresolved.push({ file, callee, line: src.slice(0, openAt).split('\n').length, why: `参数 ${name} 找不到声明` });
    const line = src.slice(0, openAt).split('\n').length;
    const body = { callee, args: argsText, deps: dep.deps };
    const sig = createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 10);
    templates.push({ file, callee, sig, args: argsText, deps: dep.deps, forwarder: dep.forwarder, line, kind });
  };
  for (const m of ctx.masked.matchAll(callRe)) {
    if (!ctx.code[m.index]) continue;
    record('call', m[1], m.index + m[0].length - 1, 0);
  }
  for (const m of ctx.masked.matchAll(spawnRe)) {
    if (!ctx.code[m.index]) continue;
    const open = ctx.masked.indexOf('(', m.index);
    record('spawn', `${m[1]}:gh`, open, 1);
  }
  // 动态属性取 gh:api['gh'](...) —— 参数没法静态对应到调用名,直接 unresolved
  for (const m of ctx.masked.matchAll(new RegExp(`\\[\\s*['"](?:${CALLEES.join('|')})['"]\\s*\\]\\s*\\(`, 'g'))) {
    if (!ctx.code[m.index]) continue;
    unresolved.push({ file, callee: 'dynamic-property', line: src.slice(0, m.index).split('\n').length, why: '用下标/动态属性取 gh 调用,扫描器无法对应调用名' });
  }
  // 未知写法:调用名不在已知集合,但第一个参数长得像 gh 子命令数组 → 不静默放过
  const shapedRe = new RegExp(`(?<![\\w$])([\\w$.]+)\\s*\\(\\s*\\[\\s*['"](${GH_SHAPED_FIRST.join('|')})['"]`, 'g');
  for (const m of ctx.masked.matchAll(shapedRe)) {
    if (!ctx.code[m.index]) continue;
    const callee = m[1];
    if (known.has(callee.replace(/^(?:api|lib)\./, '')) || SPAWNERS.includes(callee)) continue;
    if (/^(?:if|for|while|switch|return|new)$/.test(callee)) continue;
    unresolved.push({ file, callee, why: `未知调用名 ${callee} 收到 gh 形态的参数数组` });
  }
  return { templates, unresolved };
}

export function listSourceFiles(root = REPO_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'node_modules' && name !== 'fixtures') walk(full); continue; }
      if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  for (const r of ROOTS) walk(join(root, r));
  return out.sort();
}

// ── 入口归属 ───────────────────────────────────────────────────────────────
// mini = 从 mivo/prereview/round.mjs 出发的引用闭包;server = 从 mivo/server/review.mjs 出发的闭包;都不在 = interactive。
// 引用 = 去掉注释后的源码里「整段字符串就是 *.mjs 路径」的写法(import 路径或 spawn 的脚本名)。没有调用方的入口脚本归 interactive。
const FLOW_ENTRIES = { mini: ['mivo/prereview/round.mjs', 'mivo/prereview/admit-candidates.mjs'], server: ['mivo/server/review.mjs'] };
const BARE_SEARCH_DIRS = ['review-pr/scripts', 'mivo/prereview', 'mivo/lib'];

export function computeFlows(sourceMap, entries = FLOW_ENTRIES) {
  const dirOf = (file) => file.split('/').slice(0, -1).join('/');
  const resolve = (from, token) => {
    const candidates = token.startsWith('.')
      ? [join(dirOf(from), token).split(sep).join('/')]
      : [dirOf(from), ...BARE_SEARCH_DIRS].map((d) => `${d}/${token.split('/').pop()}`);
    return candidates.map((c) => c.replace(/\/[^/]+\/\.\.\//g, '/')).find((c) => sourceMap.has(c));
  };
  const refs = new Map();
  for (const [file, src] of sourceMap) {
    const { masked } = analyze(src);
    // 只认整段字符串就是脚本路径的写法(import 路径、runScript('x.mjs'));提示词/说明文字里顺带提到脚本名不算调用。
    refs.set(file, new Set([...masked.matchAll(/['"]((?:\.{1,2}\/)*[\w./-]*[\w-]+\.mjs)['"]/g)].map((m) => resolve(file, m[1])).filter(Boolean)));
  }
  const closure = (roots) => {
    const seen = new Set();
    const queue = roots.filter((r) => sourceMap.has(r));
    while (queue.length) {
      const f = queue.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const next of refs.get(f) ?? []) queue.push(next);
    }
    return seen;
  };
  const mini = closure(entries.mini);
  const server = closure(entries.server);
  const out = new Map();
  for (const file of sourceMap.keys()) {
    const flows = [mini.has(file) && 'mini', server.has(file) && 'server'].filter(Boolean);
    out.set(file, flows.length ? flows : ['interactive']);
  }
  return out;
}

/** files: Map<相对路径, 源码>。返回 { templates, unresolved }。 */
export function scanGhTemplates(files) {
  const templates = [];
  const unresolved = [];
  for (const [file, src] of files) {
    const r = scanFile(file, src, files);
    templates.push(...r.templates);
    unresolved.push(...r.unresolved);
  }
  return { templates, unresolved };
}

const keyOf = (t) => `${t.file}#${t.callee}#${t.sig}`;

/** 清单 vs 扫描结果:多重集合双向比较,返回诊断列表(空 = 一致)。 */
export function validateInventory(templates, inventory) {
  const diagnostics = [];
  const scanned = new Map();
  // forwarder 资格只来自扫描器:同一模板的所有出现处都是「参数就是函数形参本身」才算
  for (const t of templates) {
    const prev = scanned.get(keyOf(t));
    scanned.set(keyOf(t), { count: (prev?.count ?? 0) + 1, sample: prev?.sample ?? t, forwarder: (prev?.forwarder ?? true) && Boolean(t.forwarder) });
  }
  const listed = new Map();
  const seenIds = new Set();
  for (const e of inventory.entries) {
    if (seenIds.has(e.id)) diagnostics.push(`清单 id 重复: ${e.id}`);
    seenIds.add(e.id);
    const key = `${e.source.file}#${e.source.callee}#${e.source.sig}`;
    if (listed.has(key)) diagnostics.push(`清单重复登记同一模板(请合并并写 count): ${key}`);
    listed.set(key, e);
  }
  for (const [key, s] of scanned) {
    const e = listed.get(key);
    if (!e) diagnostics.push(`源码有 gh 调用没登记: ${key} 参数=${s.sample.args.slice(0, 160)}`);
    else if (e.source.count !== s.count) diagnostics.push(`调用次数不符: ${key} 清单=${e.source.count} 源码=${s.count}`);
    if (e && Boolean(e.forwarder) !== s.forwarder) diagnostics.push(`forwarder 判定不一致: ${key} 清单${e.forwarder ? '标了' : '没标'} forwarder,扫描器${s.forwarder ? '判为转发封装(参数是函数形参)' : '判为具体调用,必须有 case'}`);
  }
  for (const [key] of listed) if (!scanned.has(key)) diagnostics.push(`清单有陈旧条目(源码里已没有这个调用): ${key}`);
  return diagnostics;
}

// ── 路由校验 ───────────────────────────────────────────────────────────────

const ROUTING_REPOS = ['xindong/mivo-canvas-plugin'];
const NO_FILES = (path) => { throw new Error(`清单 case 不允许读宿主文件: ${path}`); };

export function routeOf(c, classifyFn = classify, repos = ROUTING_REPOS) {
  const stdinText = c.stdin ?? null;
  if (needsStdin(c.argv) && stdinText === null) throw new Error(`case ${c.name} 的 argv 需要 stdin 但没给 stdin`);
  const readFile = (path) => {
    const files = c.files ?? {};
    if (!(path in files)) return NO_FILES(path);
    return files[path];
  };
  return classifyFn(c.argv, { repos, env: {}, stdoutIsTTY: false, stdinText, readFile });
}

/** 清单里每个 case 经分类器的路由必须等于 expected,user 必须有去向。返回诊断列表。 */
export function classifyInventory(inventory, classifyFn = classify, rules = {}) {
  const diagnostics = [];
  for (const e of inventory.entries) {
    if (!Array.isArray(e.flows) || e.flows.length === 0 || e.flows.some((f) => !FLOWS.includes(f))) diagnostics.push(`${e.id}: flows 必须是 ${FLOWS.join('/')} 的非空子集`);
    if (e.forwarder) {
      if (e.cases?.length) diagnostics.push(`${e.id}: 转发封装不带 case(上游模板各自登记)`);
      if (typeof e.forwarder.note !== 'string' || !e.forwarder.note) diagnostics.push(`${e.id}: 转发封装要写 note`);
      continue;
    }
    if (!e.cases?.length) { diagnostics.push(`${e.id}: 没有 case`); continue; }
    for (const c of e.cases) {
      const label = `${e.id} / ${c.name}`;
      let got;
      try { got = routeOf(c, classifyFn); } catch (error) { diagnostics.push(`${label}: ${error.message}`); continue; }
      if (got.route !== c.expected) diagnostics.push(`${label}: 期望 ${c.expected},分类器给 ${got.route}(${got.reason})`);
      if (c.expected !== 'user') continue;
      if ('ownerPending' in c) diagnostics.push(`${label}: 不允许 ownerPending 字段,先把归属定到真实后续 issue`);
      const hasFlip = ALLOWED_FLIPS.includes(c.flipsIn);
      if (c.flipsIn !== undefined && !hasFlip) diagnostics.push(`${label}: flipsIn ${JSON.stringify(c.flipsIn)} 不在允许范围 ${ALLOWED_FLIPS.join(' / ')}`);
      const keep = c.keep;
      const hasKeep = keep && KEEP_CATEGORIES.includes(keep.category) && typeof keep.reason === 'string' && keep.reason.length >= 12;
      if (hasFlip === Boolean(hasKeep)) diagnostics.push(`${label}: expected=user 必须二选一:flipsIn(见 ALLOWED_FLIPS)或 keep{category,reason}`);
      if (keep && !hasKeep) diagnostics.push(`${label}: keep 的 category 只能是 ${KEEP_CATEGORIES.join('/')} 且 reason 要具体`);
      if (hasKeep && keep.category === 'interactive-skill' && !(e.flows.length === 1 && e.flows[0] === 'interactive')) diagnostics.push(`${label}: interactive-skill 的条目 flows 只能是 ["interactive"]`);
      if (hasKeep && keep.category === 'unreachable-under-config') {
        if (rules.allowlistOk !== true) diagnostics.push(`${label}: unreachable-under-config 要求 pr-rules.json 与 sandbox-pr-rules.json 的 maintainerSource 都是 allowlist`);
        const guard = UNREACHABLE_GUARDS[c.guard];
        if (!guard) diagnostics.push(`${label}: unreachable-under-config 必须带 guard(${Object.keys(UNREACHABLE_GUARDS).join(' / ')}),实际 ${JSON.stringify(c.guard)}`);
        else if (!guard.files.includes(e.source.file) || !guard.matches(c.argv)) diagnostics.push(`${label}: guard ${c.guard} 与这个调用的文件/argv 形状不符,不能用 unreachable-under-config 豁免`);
      }
      if (hasKeep && keep.category === 'pr-merge-approve' && !((c.argv[0] === 'pr' && c.argv[1] === 'merge') || (c.argv.includes('POST') && c.argv.some((a) => /pulls\/[^/]+\/reviews$/.test(String(a))) && /"event"\s*:\s*"APPROVE"/.test(c.stdin ?? '')))) diagnostics.push(`${label}: pr-merge-approve 只能是 pr merge 或 event=APPROVE 的 POST reviews`);
    }
  }
  return diagnostics;
}

// ── 测试 ───────────────────────────────────────────────────────────────────

const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
const readSources = () => new Map(listSourceFiles().map((f) => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));
const sources = readSources();
const scan = scanGhTemplates(sources);
const flowSources = new Map([...sources, ...FLOW_ENTRIES.server.map((f) => [f, readFileSync(join(REPO_ROOT, f), 'utf8')])]);
const flowsByFile = computeFlows(flowSources);

if (process.env.GH_ROUTE_INVENTORY_DUMP) writeFileSync(process.env.GH_ROUTE_INVENTORY_DUMP, JSON.stringify({ ...scan, flows: Object.fromEntries(flowsByFile) }, null, 1));

test('清单 schema:三个扫描根、分类器来源 hash、路由上下文', () => {
  assert.equal(inventory.schemaVersion, 1);
  assert.deepEqual(inventory.roots, ROOTS);
  const body = readFileSync(join(REPO_ROOT, 'review-pr/scripts/vendor/gh-app-classify.mjs'), 'utf8').split('\n').slice(4).join('\n');
  assert.equal(createHash('sha256').update(body).digest('hex'), inventory.classifier.sha256, '清单记录的分类器 sha256 要与 vendor 一致');
  assert.match(inventory.classifier.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(inventory.routingContext.repos, ROUTING_REPOS);
});

test('扫描没有无法解析的 gh 调用(未知写法一律报错,不静默放过)', () => {
  assert.deepEqual(scan.unresolved, []);
});

test('源码里全部 gh 调用模板与清单按多重集合双向相等', () => {
  assert.deepEqual(validateInventory(scan.templates, inventory), []);
});

test('清单 case 的路由等于 expected,user 都有去向', () => {
  const allowlistOk = ['review-pr/config/pr-rules.json', 'mivo/config/sandbox-pr-rules.json']
    .every((f) => JSON.parse(readFileSync(join(REPO_ROOT, f), 'utf8')).maintainerSource === 'allowlist');
  assert.deepEqual(classifyInventory(inventory, classify, { allowlistOk }), []);
});

test('每个条目的 flows 等于它所在文件的入口归属(mini / server / interactive),interactive 的 keep 才成立', () => {
  for (const e of inventory.entries) {
    assert.deepEqual([...e.flows].sort(), [...flowsByFile.get(e.source.file)].sort(), `${e.id}: flows 与 ${e.source.file} 的入口归属不符`);
  }
  // interactive 的文件不被 round.mjs / review.mjs 闭包里的任何文件引用
  const interactive = new Set(inventory.entries.filter((e) => e.flows.includes('interactive')).map((e) => e.source.file));
  for (const f of interactive) assert.deepEqual(flowsByFile.get(f), ['interactive'], f);
});

// ── SC11:旧 vendor + 新 vendor 双边复算 ─────────────────────────────────────
// 旧 vendor 正文(9eb30bd 的 gh-app-classify.mjs 去掉前 4 行)以 base64 存在清单 classifier.legacyBody 里,
// 校验 sha256 后写进系统临时目录,配当前 gh-read-route.mjs(本 PR 没改它)动态加载,得到「同步前」的 decideReadRoute。
const SERVER_CONFIG = { token: 't', repos: ['xindong/mivo-canvas-plugin'], logFile: '' };

async function loadRouteModules() {
  const { legacyBody, legacyBodySha256, previousSha256 } = inventory.classifier;
  const body = Buffer.from(legacyBody, 'base64');
  const sha = createHash('sha256').update(body).digest('hex');
  assert.equal(sha, legacyBodySha256, '旧 vendor 正文的 sha256 与清单记录不符');
  assert.equal(sha, previousSha256, '旧 vendor 正文必须就是同步前 vendor(previousSha256)');
  const dir = mkdtempSync(join(tmpdir(), 'gh-route-legacy-'));
  mkdirSync(join(dir, 'vendor'));
  writeFileSync(join(dir, 'vendor/gh-app-classify.mjs'), Buffer.concat([Buffer.from('// 同步前的 vendor 分类器(测试临时副本,正文来自清单 classifier.legacyBody)\n//\n//\n//\n'), body]));
  copyFileSync(join(REPO_ROOT, 'review-pr/scripts/gh-read-route.mjs'), join(dir, 'gh-read-route.mjs'));
  const legacy = await import(pathToFileURL(join(dir, 'gh-read-route.mjs')).href);
  return { dir, decideLegacy: legacy.decideReadRoute, decideNew: decideReadRoute };
}
const routeModules = await loadRouteModules();
test.after(() => rmSync(routeModules.dir, { recursive: true, force: true }));

/** flows 含 server 的每个 case:旧/新路由都真算,与清单记录一致,且不存在 app→user。 */
export function checkServerRoutes(inv, decideNew, decideLegacy) {
  const diagnostics = [];
  let checked = 0;
  for (const e of inv.entries) {
    if (!e.flows.includes('server')) continue;
    for (const c of e.cases ?? []) {
      const label = `${e.id} / ${c.name}`;
      const input = c.stdin ?? undefined;
      const now = decideNew(c.argv, { input, env: {}, config: SERVER_CONFIG }).route;
      const before = decideLegacy(c.argv, { input, env: {}, config: SERVER_CONFIG }).route;
      checked++;
      if (c.legacyServerRoute !== before) diagnostics.push(`${label}: legacyServerRoute 记录 ${c.legacyServerRoute},旧 vendor 复算 ${before}`);
      if (c.serverRoute !== now) diagnostics.push(`${label}: serverRoute 记录 ${c.serverRoute},新 vendor 复算 ${now}`);
      if (before === 'app' && now === 'user') diagnostics.push(`${label}: 服务器路由变差 app → user`);
    }
  }
  if (checked === 0) diagnostics.push('flows 含 server 的 case 一个都没有,SC11 没有被检查');
  return diagnostics;
}

test('服务器 publish 路由不变差(SC11):旧/新 vendor 各复算一遍,记录一致,且没有 app→user', () => {
  assert.deepEqual(checkServerRoutes(inventory, routeModules.decideNew, routeModules.decideLegacy), []);
});

test('F3 负例:serverRoute 记错、出现 app→user 都必须红', () => {
  const wrongNew = structuredClone(inventory);
  const c = wrongNew.entries.find((e) => e.flows.includes('server') && e.cases?.some((x) => x.serverRoute === 'app')).cases.find((x) => x.serverRoute === 'app');
  c.serverRoute = 'user';
  assert.match(checkServerRoutes(wrongNew, routeModules.decideNew, routeModules.decideLegacy).join('\n'), /serverRoute 记录 user/);
  // 把旧路由当成「新」路由、新当成「旧」路由,模拟变差的方向:旧 vendor 判 app、新 vendor 判 user 的情形必须被识别
  const swapped = checkServerRoutes(inventory, routeModules.decideLegacy, routeModules.decideNew);
  assert.ok(Array.isArray(swapped));
  const regress = checkServerRoutes(inventory, () => ({ route: 'user' }), routeModules.decideLegacy);
  assert.match(regress.join('\n'), /app → user/);
});

test('清单里没有 ownerPending,也没有指向 #173 的 flipsIn', () => {
  const text = JSON.stringify(inventory);
  assert.ok(!text.includes('ownerPending'));
  assert.ok(!text.includes('Review-PR#173'));
});

test('扫描根之外的服务器调用也登记:mivo/server/review.mjs 的 Prepare 直接用 GH_TOKEN 读仓库元数据', () => {
  assert.ok(inventory.outOfScanRoots.length >= 1);
  for (const item of inventory.outOfScanRoots) {
    const text = readFileSync(join(REPO_ROOT, item.file), 'utf8');
    assert.ok(text.includes(item.snippet), `${item.file} 里找不到登记的调用 ${item.snippet}`);
    assert.deepEqual(item.flows, ['server']);
    assert.equal(item.tokenFlipsIn, 'xindong/mivo-canvas-plugin#1757');
  }
});

test('F1:数组里的小写局部变量(endpoint)改形,指纹必须变,清单必须红', () => {
  const mutate = (file, from, to) => {
    const copy = new Map(sources);
    const text = copy.get(file);
    assert.ok(text.includes(from), `${file} 里找不到 ${from}`);
    copy.set(file, text.replace(from, to));
    return scanGhTemplates(copy);
  };
  // 真实源码:fetchStaleRebase 的 compare 端点(App 可读)改成仓库根(user)
  const changed = mutate('review-pr/scripts/lib.mjs', 'const endpoint = `repos/${slug}/compare/${encodeURIComponent(baseRef)}...${headSha}`;', 'const endpoint = `repos/${slug}`;');
  assert.deepEqual(changed.unresolved, []);
  assert.match(validateInventory(changed.templates, inventory).join('\n'), /没登记/);
  // 合成夹具:局部变量被改,指纹变
  const synth = (endpoint) => scanGhTemplates(new Map([[SYNTH_FILE, `export function a(slug, ghFn) { const endpoint = ${endpoint}; return ghFn(['api', endpoint], { allowFail: true }); }`]])).templates[0].sig;
  assert.notEqual(synth('`repos/${slug}/compare/main...x`'), synth('`repos/${slug}`'));
  // 间接依赖(局部变量引用另一个局部变量)也要进指纹
  const indirect = (base) => scanGhTemplates(new Map([[SYNTH_FILE, `export function a(slug, ghFn) { const base = ${base}; const endpoint = \`\${base}/compare\`; return ghFn(['api', endpoint]); }`]])).templates[0].sig;
  assert.notEqual(indirect('`repos/${slug}`'), indirect('`orgs/${slug}`'));
});

test('F1:数组里的标识符既不是形参也找不到声明 → unresolved(红)', () => {
  const r = scanGhTemplates(new Map([[SYNTH_FILE, "export function a(ghFn) { return ghFn(['api', mystery]); }"]]));
  assert.match(JSON.stringify(r.unresolved), /mystery/);
  const ok = scanGhTemplates(new Map([[SYNTH_FILE, "export function a(ghFn, endpoint) { return ghFn(['api', endpoint]); }"]]));
  assert.deepEqual(ok.unresolved, []);
});

test('F2:unreachable-under-config 绑定具体调用:真实可达的 rules/branches 读不能用它豁免', () => {
  const entry = structuredClone(inventory.entries.find((e) => e.source.file === 'mivo/lib/code-scan.mjs' && e.cases?.some((c) => c.argv.join(' ').includes('rules/branches'))));
  assert.ok(entry, '找不到 code-scan 的 rules/branches 条目');
  const c = entry.cases.find((x) => x.argv.join(' ').includes('rules/branches'));
  delete c.flipsIn;
  c.keep = { category: 'unreachable-under-config', reason: '配置固定 allowlist 时这里不可达,测试应拒绝这条实际可达请求' };
  assert.notDeepEqual(classifyInventory({ entries: [entry] }, classify, { allowlistOk: true }), [], 'rules/branches 读被 unreachable-under-config 豁免了');
  c.guard = 'maintainer-team';
  assert.notDeepEqual(classifyInventory({ entries: [entry] }, classify, { allowlistOk: true }), [], '带 guard 也必须匹配该情形的调用形状');
});

test('F2:unreachable-under-config 的 case 必须带 guard,且 argv 匹配 guard 的形状、文件匹配', () => {
  const kept = inventory.entries.flatMap((e) => (e.cases ?? []).filter((c) => c.keep?.category === 'unreachable-under-config').map((c) => [e, c]));
  assert.ok(kept.length >= 6);
  for (const [e, c] of kept) {
    assert.ok(['maintainer-team', 'auth-status-without-viewer'].includes(c.guard), `${e.id}/${c.name}: 缺 guard`);
    assert.equal(e.source.file, 'review-pr/scripts/lib.mjs');
  }
  // guard 与调用形状不符
  const team = structuredClone(kept.find(([, c]) => c.guard === 'maintainer-team')[0]);
  team.cases[0].guard = 'auth-status-without-viewer';
  assert.match(classifyInventory({ entries: [team] }, classify, { allowlistOk: true }).join('\n'), /guard/);
});

test('F4:forwarder 资格由扫描器判定:把具体调用标成 forwarder 并删掉 cases 必须红;真转发封装漏标也红', () => {
  const fake = structuredClone(inventory);
  const entry = fake.entries.find((e) => e.source.file === 'mivo/lib/code-scan.mjs' && e.cases?.length);
  entry.forwarder = { note: '故意将具体调用冒充转发封装' };
  delete entry.cases;
  assert.match(validateInventory(scan.templates, fake).join('\n'), /forwarder/);
  const missing = structuredClone(inventory);
  const real = missing.entries.find((e) => e.forwarder);
  delete real.forwarder;
  real.cases = [{ name: 'x', argv: ['api', 'user'], expected: 'user', flipsIn: 'PraiseZhu/Review-PR#176' }];
  assert.match(validateInventory(scan.templates, missing).join('\n'), /forwarder/);
  // 具体调用不带 case 也红(没标 forwarder 时)
  const bare = structuredClone(inventory);
  delete bare.entries.find((e) => e.source.file === 'mivo/lib/code-scan.mjs' && e.cases?.length).cases;
  assert.match(classifyInventory(bare, classify, {}).join('\n'), /没有 case/);
  // 合成夹具:形参转发是 forwarder,具体 argv 不是
  assert.ok(scanGhTemplates(new Map([[SYNTH_FILE, 'export function w(args) { return gh(args, {}); }']])).templates[0].forwarder);
  assert.ok(!scanGhTemplates(new Map([[SYNTH_FILE, "export function w(slug) { return gh(['api', `repos/${slug}`]); }"]])).templates[0].forwarder);
});

test('F3:SC11 真的复算旧 vendor:把全部 legacyServerRoute 改成 user 必须红', () => {
  assert.equal(typeof checkServerRoutes, 'function', '守卫里没有「旧 vendor + 新 vendor 双边复算」');
  const lying = structuredClone(inventory);
  for (const e of lying.entries) for (const c of e.cases ?? []) if (c.legacyServerRoute) c.legacyServerRoute = 'user';
  assert.match(checkServerRoutes(lying, routeModules.decideNew, routeModules.decideLegacy).join('\n'), /legacyServerRoute/);
});

test('N1:转发封装在转发前改了形参(args.push)不再算纯转发,清单必须红', () => {
  const copy = new Map(sources);
  const text = copy.get('review-pr/scripts/lib.mjs');
  const from = "export function ghJson(args, opts = {}) {\n";
  assert.ok(text.includes(from));
  copy.set('review-pr/scripts/lib.mjs', text.replace(from, `${from}  if (args[0] === 'pr' && args[1] === 'view') {\n    args.push('--json', 'mergeStateStatus');\n  }\n`));
  const changed = scanGhTemplates(copy);
  assert.deepEqual(changed.unresolved, []);
  assert.match(validateInventory(changed.templates, inventory).join('\n'), /没登记|forwarder/);
  const fwd = (body) => scanGhTemplates(new Map([[SYNTH_FILE, `export function w(args, opts) { ${body} }`]])).templates[0].forwarder;
  assert.ok(fwd('return gh(args, opts);'), '纯转发仍是 forwarder');
  assert.ok(!fwd("args.push('--json', 'x'); return gh(args, opts);"), 'push 之后不是纯转发');
  assert.ok(!fwd("args = [...args, '--json', 'x']; return gh(args, opts);"), '重新赋值不是纯转发');
  assert.ok(!fwd("args[3] = 'x'; return gh(args, opts);"), '下标赋值不是纯转发');
  assert.ok(!fwd("tweak(args); return gh(args, opts);"), '传给别的函数不是纯转发');
});

test('N2:依赖按词法作用域找,其它函数里的同名声明不得抢走外层的 endpoint', () => {
  const sig = (route) => scanGhTemplates(new Map([[SYNTH_FILE, `export function f(slug) {
  const endpoint = \`repos/\${slug}/${route}\`;
  function other() {
    const endpoint = 'unused';
    return endpoint;
  }
  return gh(['api', endpoint]);
}`]])).templates[0];
  const a = sig('pulls');
  assert.notEqual(a.sig, sig('rules/branches/main').sig, '改外层端点指纹必须变');
  assert.ok(!a.deps.some((d) => d.includes("'unused'")), '其它函数里的同名声明不得参与');
  // 块级遮蔽:内层块的声明才是实际绑定,指纹跟着它走;同一个块里有两处同名声明 → unresolved
  const shadow = (outer, inner) => scanGhTemplates(new Map([[SYNTH_FILE, `export function f(slug) { const endpoint = \`repos/\${slug}/${outer}\`; if (slug) { const endpoint = '${inner}'; return gh(['api', endpoint]); } }`]])).templates[0].sig;
  assert.notEqual(shadow('a', 'x'), shadow('a', 'y'), '遮蔽时改内层声明指纹必须变');
  assert.equal(shadow('a', 'x'), shadow('b', 'x'), '遮蔽时外层声明不是实际绑定,不参与');
  const dup = scanGhTemplates(new Map([[SYNTH_FILE, "export function f(slug) { var endpoint = 'a'; var endpoint = 'b'; return gh(['api', endpoint]); }"]]));
  assert.match(JSON.stringify(dup.unresolved), /endpoint/);
});

// ── 包装/回退调用的样本:执行真实函数,捕获 gh 的实际请求 ──────────────────────────
// 这类调用(bindGraphqlToPr 改写查询、Team 权限的 media type 回退)的 argv/stdin 是函数里拼出来的,手写样本会和真实请求对不上,
// 所以:跑真实函数 + 记录 gh 替身收到的请求,清单样本必须和捕获结果一致。
const stateDirForLib = mkdtempSync(join(tmpdir(), 'gh-route-state-'));
test.after(() => rmSync(stateDirForLib, { recursive: true, force: true }));
async function importLib() {
  process.env.REVIEW_PR_STATE_DIR ??= stateDirForLib; // lib.mjs 加载时会建状态目录
  return import('../../review-pr/scripts/lib.mjs');
}
const okResult = (v) => ({ ok: true, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '', status: 0 });
const requestKey = (argv, stdin) => `${argv.join('\u0000')}\u0001${stdin ?? ''}`;

/** bindGraphqlToPr + 真实 fetchAllReviewThreads(resolve-fixed-threads 的生产调用路径)实际发出的 GraphQL 请求。 */
export async function captureBoundThreadRequests() {
  const lib = await importLib();
  const { fetchSingleSnapshot } = await import('../lib/resolve-fixed-threads.mjs');
  const binding = { head: 'a'.repeat(40), base: 'b'.repeat(40), baseRefName: 'main' };
  const calls = [];
  const ghGraphqlFn = (query, vars) => {
    calls.push({ argv: ['api', 'graphql', '--input', '-'], stdin: JSON.stringify({ query, variables: vars }) });
    return { data: { repository: { pullRequest: { state: 'OPEN', isDraft: false, headRefOid: binding.head, baseRefOid: binding.base, baseRefName: 'main', reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
  };
  fetchSingleSnapshot({ owner: 'xindong', repo: 'mivo-canvas-plugin', pr: 7, binding, ghGraphqlFn, fetchAllReviewThreads: lib.fetchAllReviewThreads });
  return calls;
}

/** Team 模式的 fetchMaintainerAuthority(含权限 204 → media type 回退 → Team 仓库列表回退)实际发出的 gh 请求。 */
export async function captureTeamAuthorityRequests() {
  const lib = await importLib();
  const calls = [];
  const ghFn = (args, options = {}) => {
    calls.push({ argv: [...args], stdin: options.input ?? null });
    if (args[1] === 'graphql') return okResult({ data: { repository: { defaultBranchRef: { name: 'main' } } } });
    const endpoint = args.find((a) => /^(?:repos|orgs)\//.test(a)) ?? '';
    if (endpoint === 'repos/xindong/mivo-canvas-plugin/commits/main') return okResult({ sha: 'a'.repeat(40) });
    if (endpoint.startsWith('repos/xindong/mivo-canvas-plugin/contents/')) return okResult({ type: 'file', encoding: 'base64', sha: 'blob', content: Buffer.from('* @xindong/maintainers\n').toString('base64') });
    if (endpoint === 'orgs/xindong/teams/maintainers') return okResult({ privacy: 'closed' });
    if (endpoint === 'orgs/xindong/teams/maintainers/repos/xindong/mivo-canvas-plugin') return okResult(''); // 204:要走 media type 回退
    if (endpoint === 'orgs/xindong/teams/maintainers/repos') return okResult([[{ full_name: 'xindong/mivo-canvas-plugin', permissions: { push: true } }]]);
    if (endpoint === 'orgs/xindong/teams/maintainers/members') return okResult([[{ login: 'alice' }]]);
    return { ok: false, stdout: '', stderr: `unexpected ${args.join(' ')}`, status: 1 };
  };
  lib.fetchMaintainerAuthority({ owner: 'xindong', repo: 'mivo-canvas-plugin', ghFn, maintainerAllowlist: [], maintainerSource: 'team', nowIso: '2026-11-04T00:00:00.000Z' });
  return calls;
}

test('N3a:resolve-fixed-threads 的样本是 bindGraphqlToPr 包装后的真实线程读取,不是 mutation', async () => {
  const captured = await captureBoundThreadRequests();
  assert.ok(captured.length >= 1);
  const entries = inventory.entries.filter((e) => e.source.file === 'mivo/lib/resolve-fixed-threads.mjs' && e.cases?.some((c) => c.argv[1] === 'graphql'));
  assert.ok(entries.length >= 1, '清单里没有 resolve-fixed-threads 的 GraphQL 条目');
  const have = new Set(entries.flatMap((e) => e.cases.map((c) => requestKey(c.argv, c.stdin))));
  for (const call of captured) assert.ok(have.has(requestKey(call.argv, call.stdin)), `清单样本与真实请求不一致: ${call.stdin.slice(0, 120)}`);
  for (const e of entries) for (const c of e.cases) assert.ok(!/mutation/.test(c.stdin ?? ''), `${e.id}: bindGraphqlToPr 会拒绝没有注入点的 mutation,不能当样本`);
});

test('N3b:Team 权限回退请求的样本来自真实 fetchMaintainerAuthority,且归 maintainer-team guard', async () => {
  const captured = await captureTeamAuthorityRequests();
  const libCases = inventory.entries.filter((e) => e.source.file === 'review-pr/scripts/lib.mjs').flatMap((e) => (e.cases ?? []).map((c) => [e, c]));
  const have = new Set(libCases.map(([, c]) => requestKey(c.argv, c.stdin)));
  for (const call of captured) assert.ok(have.has(requestKey(call.argv, call.stdin)), `清单里没有和真实请求一致的样本: ${call.argv.join(' ')}`);
  const media = captured.find((c) => c.argv.some((a) => String(a).startsWith('Accept:application/vnd.github.v3.repository')));
  assert.ok(media, '没有捕获到 media type 回退请求');
  const hit = libCases.find(([, c]) => requestKey(c.argv, c.stdin) === requestKey(media.argv, media.stdin));
  assert.equal(hit[1].expected, 'user');
  assert.equal(hit[1].guard, 'maintainer-team');
});

// ── 守卫自身的负例(全部内存里做,不写仓库文件、不调用 gh) ─────────────────────

const SYNTH_FILE = 'review-pr/scripts/synthetic.mjs';
const synthEntry = (src, extra = {}) => {
  const { templates } = scanGhTemplates(new Map([[SYNTH_FILE, src]]));
  return { templates, entries: templates.map((t, i) => ({ id: `synthetic-${i}`, source: { file: t.file, callee: t.callee, sig: t.sig, count: 1 }, flows: ['mini'], cases: [], ...extra })) };
};

test('守卫负例:删掉一条真实清单条目必红;多一条不存在的必红', () => {
  const fewer = { ...inventory, entries: inventory.entries.slice(1) };
  assert.match(validateInventory(scan.templates, fewer).join('\n'), /源码有 gh 调用没登记/);
  const more = { ...inventory, entries: [...inventory.entries, { id: 'ghost', source: { file: 'mivo/lib/none.mjs', callee: 'gh', sig: 'deadbeef00', count: 1 }, flows: ['mini'], cases: [] }] };
  assert.match(validateInventory(scan.templates, more).join('\n'), /陈旧条目/);
});

test('守卫负例:新文件里加一个 gh 调用必红;同一调用多出一处(count 变化)必红', () => {
  const base = synthEntry("export function a(slug) { return ghJson(['pr', 'view', '1', '--repo', slug, '--json', 'state']); }");
  assert.deepEqual(validateInventory(base.templates, base), []);
  const grown = scanGhTemplates(new Map([[SYNTH_FILE, "export function a(slug) { return ghJson(['pr', 'view', '1', '--repo', slug, '--json', 'state']); }\nexport function b() { return gh(['api', 'user']); }"]]));
  assert.match(validateInventory(grown.templates, base).join('\n'), /没登记/);
  const twice = scanGhTemplates(new Map([[SYNTH_FILE, "export function a(slug) { ghJson(['pr', 'view', '1', '--repo', slug, '--json', 'state']);\n ghJson(['pr', 'view', '1', '--repo', slug, '--json', 'state']); }"]]));
  assert.match(validateInventory(twice.templates, base).join('\n'), /调用次数不符/);
});

test('守卫稳定性:改行号、插空行、改注释、改空白都不红', () => {
  const base = synthEntry("export function a(slug) {\n  return ghJson(['pr', 'view', '1', '--repo', slug, '--json', 'state']);\n}");
  const moved = scanGhTemplates(new Map([[SYNTH_FILE, "// 新注释 gh(['api','user'])\n\n\n/* ghJson(['x']) */\nexport function a(slug) {\n\n  return ghJson(\n    ['pr', 'view', '1',   '--repo', slug,\n     '--json', 'state'],\n  );\n}"]]));
  assert.deepEqual(validateInventory(moved.templates, base), []);
});

test('守卫负例:改 args.push 的字段、改 GraphQL 常量里的敏感字段、改敏感参数都必须红', () => {
  const pushed = (field) => `export function a(slug) { const args = ['pr', 'view', '1', '--repo', slug]; args.push('--json', '${field}'); return ghJson(args); }`;
  const base = synthEntry(pushed('state'));
  assert.notEqual(scanGhTemplates(new Map([[SYNTH_FILE, pushed('state,mergeStateStatus')]])).templates[0].sig, base.templates[0].sig);
  const gql = (field) => `const Q = \`query($o:String!){ repository(owner:$o){ pullRequest(number:1){ ${field} } } }\`;\nexport function a() { return ghGraphql(Q, { o: 'x' }); }`;
  const gqlBase = scanGhTemplates(new Map([[SYNTH_FILE, gql('state')]])).templates[0];
  assert.deepEqual(gqlBase.forwarder, null);
  assert.notEqual(scanGhTemplates(new Map([[SYNTH_FILE, gql('mergeStateStatus')]])).templates[0].sig, gqlBase.sig);
  const endpoint = (path) => `export function a(slug, pr) { return fetchRestPages(\`repos/\${slug}/pulls/\${pr}/${path}\`); }`;
  assert.notEqual(scanGhTemplates(new Map([[SYNTH_FILE, endpoint('reviews')]])).templates[0].sig, scanGhTemplates(new Map([[SYNTH_FILE, endpoint('')]])).templates[0].sig);
});

test('守卫负例:注释和字符串里的 gh([...]) 不算调用;函数定义不算调用;嵌套模板和多行数组能识别', () => {
  const fake = scanGhTemplates(new Map([[SYNTH_FILE, "// gh(['api','user'])\nconst s = \"ghJson(['pr','view'])\";\nconst t = `gh(['x']) ${1}`;\nexport function gh(args) { return run('x', args); }\nexport function ghJson(args) {\n  return args;\n}"]]));
  assert.deepEqual(fake.templates, []);
  assert.deepEqual(fake.unresolved, []);
  const nested = scanGhTemplates(new Map([[SYNTH_FILE, "export function a(o, b) {\n  return fetchRestPages(`repos/${o}/pulls?head=${encodeURIComponent(`${o}:${b}`)}`);\n}"]]));
  assert.equal(nested.templates.length, 1);
  assert.match(nested.templates[0].args, /encodeURIComponent/);
});

test('守卫负例:未知调用名收到 gh 形态参数数组 → unresolved(红);参数找不到声明 → unresolved', () => {
  const unknown = scanGhTemplates(new Map([[SYNTH_FILE, "export function a() { return mystery(['pr', 'view', '1']); }"]]));
  assert.match(JSON.stringify(unknown.unresolved), /未知调用名 mystery/);
  const dangling = scanGhTemplates(new Map([[SYNTH_FILE, 'export function a() { return gh(argsFromNowhere); }']]));
  assert.match(JSON.stringify(dangling.unresolved), /argsFromNowhere/);
});

test('守卫负例:转发封装(参数是形参)标成 forwarder;expected=user 没 flipsIn/keep 必红;argv 与期望不符必红;keep 类别被限制', () => {
  const fwd = scanGhTemplates(new Map([[SYNTH_FILE, 'export function w(args, opts) { return gh(args, opts); }']]));
  assert.equal(fwd.templates[0].forwarder, 'args');
  const mk = (c, flows = ['mini']) => ({ entries: [{ id: 'e', source: { file: 'f', callee: 'gh', sig: 's', count: 1 }, flows, cases: [{ name: 'c', argv: ['api', 'user'], expected: 'user', ...c }] }] });
  assert.match(classifyInventory(mk({})).join('\n'), /二选一/);
  assert.match(classifyInventory(mk({ flipsIn: '' })).join('\n'), /二选一/);
  assert.match(classifyInventory(mk({ flipsIn: 'not-an-issue' })).join('\n'), /二选一/);
  assert.deepEqual(classifyInventory(mk({ flipsIn: 'PraiseZhu/Review-PR#176' })), []);
  assert.deepEqual(classifyInventory(mk({ flipsIn: 'xindong/mivo-canvas-plugin#1751' })), []);
  assert.deepEqual(classifyInventory(mk({ flipsIn: 'xindong/mivo-canvas-plugin#1752' })), []);
  // 总 issue #173 或其它 issue 不能当 flipsIn;ownerPending 字段一律红
  assert.match(classifyInventory(mk({ flipsIn: 'PraiseZhu/Review-PR#173' })).join('\n'), /不在允许范围/);
  assert.match(classifyInventory(mk({ flipsIn: 'xindong/mivo-canvas-plugin#1757' })).join('\n'), /不在允许范围/);
  assert.match(classifyInventory(mk({ flipsIn: 'PraiseZhu/Review-PR#176', ownerPending: '待定' })).join('\n'), /ownerPending/);
  assert.match(classifyInventory(mk({ keep: { category: 'legacy', reason: '历史遗留不用管了反正' } })).join('\n'), /category 只能是/);
  assert.match(classifyInventory(mk({ keep: { category: 'interactive-skill', reason: '只在交互式 skill 里跑,不在自动链上' } })).join('\n'), /flows 只能是/);
  assert.deepEqual(classifyInventory(mk({ keep: { category: 'interactive-skill', reason: '只在交互式 skill 里跑,不在自动链上' } }, ['interactive'])), []);
  assert.match(classifyInventory(mk({ expected: 'app' })).join('\n'), /期望 app,分类器给 user/);
  assert.match(classifyInventory(mk({ keep: { category: 'unreachable-under-config', reason: '配置固定 allowlist 时走不到这里' } })).join('\n'), /maintainerSource/);
  assert.match(classifyInventory(mk({ keep: { category: 'unreachable-under-config', reason: '配置固定 allowlist 时走不到这里' } }), classify, { allowlistOk: true }).join('\n'), /必须带 guard/);
  assert.match(classifyInventory(mk({ keep: { category: 'pr-merge-approve', reason: '总 issue 明确不做 merge 与 Approve' } })).join('\n'), /pr-merge-approve 只能是/);
});

test('路由上下文隔离:白名单外的仓仍是 user;GraphQL 需要 stdin 却没给直接报错;读文件夹具不放行宿主路径', () => {
  assert.equal(routeOf({ name: 'x', argv: ['pr', 'view', '1', '--repo', 'other/repo', '--json', 'headRefOid'] }).route, 'user');
  assert.equal(routeOf({ name: 'x', argv: ['pr', 'view', '1', '--repo', 'xindong/mivo-canvas-plugin', '--json', 'headRefOid'] }).route, APP);
  assert.throws(() => routeOf({ name: 'g', argv: ['api', 'graphql', '--input', '-'] }), /需要 stdin/);
});
