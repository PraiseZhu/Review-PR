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
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, needsStdin, APP } from '../../review-pr/scripts/vendor/gh-app-classify.mjs';
import { decideReadRoute } from '../../review-pr/scripts/gh-read-route.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INVENTORY_PATH = join(REPO_ROOT, 'mivo/prereview/gh-route-inventory.json');
const ROOTS = ['review-pr/scripts', 'mivo/prereview', 'mivo/lib'];
// flipsIn 只允许指向真正会让这条调用改走 App 的后续 issue:读侧、身份读取、受限写。
const ALLOWED_FLIPS = ['xindong/mivo-canvas-plugin#1751', 'PraiseZhu/Review-PR#176', 'xindong/mivo-canvas-plugin#1752'];
const KEEP_CATEGORIES = ['pr-merge-approve', 'unreachable-under-config', 'interactive-skill'];
const FLOWS = ['mini', 'server', 'interactive'];

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

/** 解析 a0 里引用的标识符:局部 const/let(含 push 追加)、模块级大写常量;参数形参标成 forwarder;都找不到记 unresolved。 */
function resolveDeps(ctx, callAt, exprFrom, exprTo, scanTo = exprTo) {
  const deps = [];
  const expr = ctx.masked.slice(exprFrom, exprTo);
  const wholeCall = ctx.masked.slice(exprFrom, scanTo); // 选项对象里引用的大写常量(如 input 里的 GraphQL 查询)也算依赖
  let forwarder = null;
  const unresolved = [];
  const first = expr.trim();
  const bareIdent = /^[A-Za-z_$][\w$]*$/.test(first) ? first : null;
  const names = new Set(wholeCall.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []);
  if (bareIdent) names.add(bareIdent);
  for (const name of names) {
    const declRe = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=`, 'g');
    let declAt = -1;
    for (const m of ctx.masked.matchAll(declRe)) if (m.index < callAt && ctx.code[m.index]) declAt = m.index;
    if (declAt < 0 && /^[A-Z]/.test(name)) { // 模块级常量也可能声明在调用之后(函数内引用)
      for (const m of ctx.masked.matchAll(declRe)) if (ctx.code[m.index]) { declAt = m.index; break; }
    }
    const paramRe = /(?:function\s*[\w$]*\s*\(([^()]*)\)\s*\{|\(([^()]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)/g;
    let paramAt = -1;
    for (const m of ctx.masked.slice(0, callAt).matchAll(paramRe)) {
      const list = m[1] ?? m[2] ?? m[3] ?? '';
      if (new RegExp(`(?:^|[\\s,({=])${name.replace(/\$/g, '\\$')}(?:$|[\\s,)}=:])`).test(list)) paramAt = m.index;
    }
    if (declAt >= 0 && declAt > paramAt) {
      const eq = ctx.masked.indexOf('=', declAt);
      const end = statementEnd(ctx, eq);
      deps.push(canon(ctx, declAt, end));
      const mut = new RegExp(`\\b${name.replace(/\$/g, '\\$')}(?:\\.(?:push|unshift|splice|concat)\\(|\\s*\\+?=[^=])`, 'g');
      for (const m of ctx.masked.slice(end, callAt).matchAll(mut)) {
        if (!ctx.code[end + m.index]) continue;
        let stmtEnd = statementEnd(ctx, end + m.index);
        const open = ctx.masked.indexOf('(', end + m.index);
        if (m[0].includes('(') && open >= 0) stmtEnd = Math.min(stmtEnd, findClose(ctx, open) + 1);
        deps.push(canon(ctx, end + m.index, stmtEnd));
      }
    } else if (paramAt >= 0) {
      if (name === bareIdent) forwarder = name;
    } else if (name === bareIdent) {
      unresolved.push(name);
    }
  }
  return { deps, forwarder, unresolved };
}

/** 扫一个文件:返回调用模板列表和无法解析的位置。 */
export function scanFile(file, src) {
  const ctx = analyze(src);
  const templates = [];
  const unresolved = [];
  const aliases = [
    ...ctx.masked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:ghFn\s*\?\?\s*)?gh(?![\w$])/g),
    ...ctx.masked.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*createPrWriteGuard\s*\(/g),
  ].map((m) => m[1]).filter((a) => a !== 'gh');
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
    const dep = resolveDeps(ctx, openAt, target[0], target[1], close);
    for (const name of dep.unresolved) unresolved.push({ file, callee, why: `参数 ${name} 找不到声明` });
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
    const r = scanFile(file, src);
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
  for (const t of templates) scanned.set(keyOf(t), { count: (scanned.get(keyOf(t))?.count ?? 0) + 1, sample: scanned.get(keyOf(t))?.sample ?? t });
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
      if (hasKeep && keep.category === 'unreachable-under-config' && rules.allowlistOk !== true) diagnostics.push(`${label}: unreachable-under-config 要求 pr-rules.json 与 sandbox-pr-rules.json 的 maintainerSource 都是 allowlist`);
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

test('服务器 publish 路由不变差:flows 含 server 的 case,旧 vendor 判 app 的新 vendor 仍判 app,且 serverRoute 与实际一致', () => {
  const config = { token: 't', repos: ['xindong/mivo-canvas-plugin'], logFile: '' };
  for (const e of inventory.entries) {
    if (!e.flows.includes('server')) continue;
    for (const c of e.cases ?? []) {
      assert.ok(['app', 'user'].includes(c.serverRoute) && ['app', 'user'].includes(c.legacyServerRoute), `${e.id} / ${c.name}: 缺 serverRoute / legacyServerRoute`);
      const got = decideReadRoute(c.argv, { input: c.stdin ?? undefined, env: {}, config }).route;
      assert.equal(got, c.serverRoute, `${e.id} / ${c.name}: serverRoute 记录 ${c.serverRoute},decideReadRoute 给 ${got}`);
      assert.ok(!(c.legacyServerRoute === 'app' && c.serverRoute === 'user'), `${e.id} / ${c.name}: 同步 vendor 后从 app 变成 user`);
    }
  }
});

test('SC5:四处 App 可读的新写法都在清单里,并且判 app(服务器流程也一样)', () => {
  const find = (file, sigPart) => inventory.entries.filter((e) => e.source.file === file && e.cases?.some((c) => c.name === sigPart || c.argv.join(' ').includes(sigPart)));
  const wanted = [
    ['mivo/prereview/round.mjs', 'pr view 7 --repo xindong/mivo-canvas-plugin --json headRefOid --jq .headRefOid'],
    ['review-pr/scripts/lib.mjs', 'default-branch'],
    ['review-pr/scripts/lib.mjs', 'auth-probe'],
    ['review-pr/scripts/target-branch-reminder.mjs', 'pr view 7 --repo xindong/mivo-canvas-plugin --json state,isDraft,author,headRefOid,baseRefName'],
  ];
  for (const [file, key] of wanted) {
    const hit = find(file, key);
    assert.equal(hit.length, 1, `${file} 里找不到 ${key}`);
    for (const c of hit[0].cases.filter((x) => x.name === key || x.argv.join(' ').includes(key))) assert.equal(c.expected, 'app', `${hit[0].id}/${c.name}`);
  }
  // target-branch-reminder 读默认分支经注入的 fetchDefaultBranch(lib 的 GraphQL),源码里不再有 repo view
  const targetSrc = sources.get('review-pr/scripts/target-branch-reminder.mjs');
  assert.ok(!/['"]repo['"]\s*,\s*['"]view['"]/.test(analyze(targetSrc).masked), 'target-branch-reminder 不得再用 gh repo view');
  assert.match(analyze(targetSrc).masked, /api\.fetchDefaultBranch\(/);
});

test('守卫对真实源码的变化敏感:改 GraphQL 常量里的字段、改 readLiveHead 的 --json 字段都必须红', () => {
  const mutate = (file, from, to) => {
    const copy = new Map(sources);
    const text = copy.get(file);
    assert.ok(text.includes(from), `${file} 里找不到要替换的片段 ${from}`);
    copy.set(file, text.replace(from, to));
    return validateInventory(scanGhTemplates(copy).templates, inventory).join('\n');
  };
  assert.match(mutate('mivo/prereview/round.mjs', "'--json', 'headRefOid', '--jq'", "'--json', 'mergeStateStatus', '--jq'"), /没登记/);
  assert.match(mutate('review-pr/scripts/context.mjs', 'const GQL = `', 'const GQL = `\n  # sentinel mergeStateStatus\n'), /没登记/);
  assert.match(mutate('review-pr/scripts/lib.mjs', '{repository(owner:$owner,name:$name){defaultBranchRef{name}}}', '{repository(owner:$owner,name:$name){defaultBranchRef{name} viewerPermission}}'), /没登记/);
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
  assert.match(classifyInventory(mk({ keep: { category: 'pr-merge-approve', reason: '总 issue 明确不做 merge 与 Approve' } })).join('\n'), /pr-merge-approve 只能是/);
});

test('路由上下文隔离:白名单外的仓仍是 user;GraphQL 需要 stdin 却没给直接报错;读文件夹具不放行宿主路径', () => {
  assert.equal(routeOf({ name: 'x', argv: ['pr', 'view', '1', '--repo', 'other/repo', '--json', 'headRefOid'] }).route, 'user');
  assert.equal(routeOf({ name: 'x', argv: ['pr', 'view', '1', '--repo', 'xindong/mivo-canvas-plugin', '--json', 'headRefOid'] }).route, APP);
  assert.throws(() => routeOf({ name: 'g', argv: ['api', 'graphql', '--input', '-'] }), /需要 stdin/);
});
