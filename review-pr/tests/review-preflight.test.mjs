// SC-R2 行为测试:review-preflight.mjs 子进程实跑 + 真实 temp git base/head。
// 覆盖:#483 真坏/好样例、既存命中 report-only、语法错→incomplete、parser 缺失→
// incomplete、snapshot 漂移、以及零误报对照(TS 泛型 / TSX / locator.waitFor /
// vi.waitFor(async))。反向变异:归因改恒"新增" → 恰红既存用例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVendoredTypescript, scanSource, scriptKindFor, BUILTIN_RULES } from '../scripts/lib.preflight-rules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'review-preflight.mjs');
const VENDOR = join(__dirname, '..', 'vendor', 'typescript');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// #483 的真实坏形态(async 谓词)与修复后形态(evaluate 轮询 + 硬 deadline)
const BAD = `import { expect } from '@playwright/test';
export async function waitReady(page) {
  await page.waitForFunction(async () => {
    const r = await fetch('/healthz');
    return r.ok;
  }, { timeout: 5000 });
}
`;
const GOOD = `export async function waitReady(page) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const ok = await page.evaluate(async () => (await fetch('/healthz')).ok);
    if (ok) return;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}
`;
// 零误报对照:同步谓词、locator.waitFor、vi.waitFor(async)、TS 泛型、TSX
const CLEAN_TS = `type Box<T> = { v: T };
export function pick<T>(a: T, b: T): Box<T> { return a < b ? { v: a } : { v: b }; }
export async function w(page: any, locator: any) {
  await page.waitForFunction(() => document.readyState === 'complete');
  await locator.waitFor({ state: 'visible' });
}
`;
const CLEAN_VITEST = `import { vi } from 'vitest';
export async function t() { await vi.waitFor(async () => { await Promise.resolve(); }); }
`;
const CLEAN_TSX = `export const C = ({ n }: { n: number }) => <div className="x">{n > 1 ? <b>a</b> : null}</div>;
`;

function repo({ baseFiles, headFiles }) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
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
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'head'], dir);
  const head = git(['rev-parse', 'HEAD'], dir);
  return { dir, base, head };
}

function run(r, extraEnv = {}) {
  const res = spawnSync('node', [SCRIPT, '--base', r.base, '--head', r.head], {
    cwd: r.dir, encoding: 'utf8',
    env: { ...process.env, REVIEW_PR_REPO_ROOT: r.dir, REVIEW_PR_STATE_DIR: join(r.dir, '.state'), ...extraEnv },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* fallthrough */ }
  assert.ok(json, `应输出 JSON:status=${res.status}\n${res.stdout.slice(0, 500)}\n${res.stderr.slice(0, 500)}`);
  return { res, json };
}

test('R2 parser:vendored typescript 版本钉死、路径在 vendor 下', () => {
  const p = loadVendoredTypescript();
  assert.equal(p.ok, true, p.error);
  assert.ok(p.resolvedPath.startsWith(VENDOR), `parser 必须解析到 vendor,得到 ${p.resolvedPath}`);
  assert.match(p.version, /^\d+\.\d+\.\d+/);
});

test('R2 ScriptKind 按扩展名(#483 教训:ScriptKind.JS 套 .ts 会大面积假红)', () => {
  const { ts } = loadVendoredTypescript();
  assert.equal(scriptKindFor(ts, 'a.ts'), ts.ScriptKind.TS);
  assert.equal(scriptKindFor(ts, 'a.tsx'), ts.ScriptKind.TSX);
  assert.equal(scriptKindFor(ts, 'a.mjs'), ts.ScriptKind.JS);
  assert.equal(scriptKindFor(ts, 'a.md'), null);
});

test('R2 零误报对照:同步谓词/locator.waitFor/vi.waitFor(async)/TS 泛型/TSX 全部不报', () => {
  const { ts } = loadVendoredTypescript();
  for (const [path, text] of [['a.ts', CLEAN_TS], ['b.ts', CLEAN_VITEST], ['c.tsx', CLEAN_TSX], ['d.mjs', GOOD]]) {
    const r = scanSource(ts, { path, text });
    assert.equal(r.ok, true, `${path}: ${r.error}`);
    assert.deepEqual(r.hits, [], `${path} 不应有命中`);
  }
});

test('R2 命中:新增行上的 async 谓词 → hits(机器打回);既存命中 → reportOnly', () => {
  // base 已有一处坏代码(既存),head 新增另一处(本次引入)
  const r = repo({
    baseFiles: { 'scripts/e2e/old.mjs': BAD, 'README.md': '# x\n' },
    headFiles: { 'scripts/e2e/new.mjs': BAD },
  });
  const { res, json } = run(r);
  assert.equal(res.status, 0, JSON.stringify(json).slice(0, 400));
  assert.equal(json.complete, true, json.reason);
  assert.equal(json.hits.length, 1, `新增文件里的命中应阻断:${JSON.stringify(json.hits)}`);
  assert.equal(json.hits[0].path, 'scripts/e2e/new.mjs');
  assert.equal(json.hits[0].ruleId, 'playwright-waitforfunction-async-predicate');
  assert.ok(json.hits[0].ruleVersion);
  // old.mjs 未在本次 diff 里 → 不出现在任何列表(它连 diff 都没进)
  assert.equal(json.reportOnly.length, 0);
});

test('R2 既存命中 report-only:同一文件本次只改了无关行,旧命中不打回作者', () => {
  const withTail = `${BAD}export const tail = 1;\n`;
  const r = repo({ baseFiles: { 'scripts/e2e/a.mjs': BAD }, headFiles: { 'scripts/e2e/a.mjs': withTail } });
  const { json } = run(r);
  assert.equal(json.complete, true, json.reason);
  assert.equal(json.hits.length, 0, '旧命中不在新增行上,不得阻断');
  assert.equal(json.reportOnly.length, 1, '但必须 report-only 记录');
});

test('R2 修复后样例:head 把 BAD 改成 GOOD → 零 hits(#483 修复形态)', () => {
  const r = repo({ baseFiles: { 'scripts/e2e/a.mjs': BAD }, headFiles: { 'scripts/e2e/a.mjs': GOOD } });
  const { json } = run(r);
  assert.equal(json.complete, true, json.reason);
  assert.deepEqual(json.hits, []);
  assert.deepEqual(json.reportOnly, []);
});

test('R2 fail-closed:语法错文件 → complete=false(不产出"无命中")', () => {
  const r = repo({ baseFiles: { 'a.md': 'x\n' }, headFiles: { 'scripts/e2e/broken.ts': 'export const a = (\n' } });
  const { res, json } = run(r);
  assert.equal(json.complete, false);
  assert.equal(res.status, 2);
  assert.ok(json.unparsable.length >= 1);
});

test('R2 fail-closed:parser 缺失 → complete=false,禁 regex 降级', () => {
  // 用测试专用 seam 指向空目录,**不动仓库里真实的 vendor 文件**——移走真文件会在并行
  // 跑测试时让其它用例随机读不到 parser(实测踩到,1/8 概率随机红)。
  const r = repo({ baseFiles: { 'a.md': 'x\n' }, headFiles: { 'scripts/e2e/a.mjs': BAD } });
  assert.ok(existsSync(join(VENDOR, 'typescript.js')), '真实 vendor 必须始终在位');
  const emptyVendor = mkdtempSync(join(tmpdir(), 'no-vendor-'));
  const { res, json } = run(r, { REVIEW_PR_VENDOR_TS_DIR: emptyVendor });
  assert.equal(json.complete, false);
  assert.match(json.reason, /parser 不可用/);
  assert.deepEqual(json.hits, [], 'parser 缺失时绝不给出命中/无命中结论');
  assert.equal(res.status, 2);
});

test('R2 fail-closed:vendor 体量与 PROVENANCE 不符(被换过)→ complete=false', () => {
  const r = repo({ baseFiles: { 'a.md': 'x\n' }, headFiles: { 'scripts/e2e/a.mjs': BAD } });
  const fake = mkdtempSync(join(tmpdir(), 'bad-vendor-'));
  const prov = JSON.parse(readFileSync(join(VENDOR, 'PROVENANCE.json'), 'utf8'));
  writeFileSync(join(fake, 'PROVENANCE.json'), JSON.stringify(prov));
  writeFileSync(join(fake, 'typescript.js'), 'module.exports = { version: "9.9.9" };\n'); // 体量不符
  const { json } = run(r, { REVIEW_PR_VENDOR_TS_DIR: fake });
  assert.equal(json.complete, false);
  assert.match(json.reason, /体量与 PROVENANCE 不符/);
});

test('R2 fail-closed:base/head oid 非法 → complete=false', () => {
  const r = repo({ baseFiles: { 'a.md': 'x\n' }, headFiles: { 'b.md': 'y\n' } });
  const { json } = run({ ...r, base: 'a'.repeat(40) });
  assert.equal(json.complete, false);
  assert.match(json.reason, /DiffSnapshot 不完整/);
});

test('R2 复审补齐:显式返回 Promise 的 literal 形态全部命中(new Promise / block 体 return / function 表达式)', () => {
  const { ts } = loadVendoredTypescript();
  const hit = (text) => {
    const r = scanSource(ts, { path: 'a.mjs', text });
    assert.equal(r.ok, true, r.error);
    return r.hits.length;
  };
  // 第 1 轮核验实测漏判的三种(修前均为 0)
  assert.equal(hit('export async function w(page){ await page.waitForFunction(() => new Promise(r=>r(1))); }'), 1, '() => new Promise(...)');
  assert.equal(hit('export async function w(page){ await page.waitForFunction(() => { return Promise.resolve(1); }); }'), 1, 'block 体 return Promise.resolve');
  assert.equal(hit('export async function w(page){ await page.waitForFunction(function(){ return new Promise(r=>r(1)); }); }'), 1, 'function 表达式 return new Promise');
  assert.equal(hit('export async function w(page){ await page.waitForFunction(() => page.evaluate(() => 1)); }'), 1, '简明体 page.evaluate');
  assert.equal(hit('export async function w(page){ await page.waitForFunction(() => Promise.resolve(1).then(x=>x)); }'), 1, 'thenable 链(链基已是 Promise)');
  // 零误报:同步谓词、内层函数里的 Promise(不是本谓词的返回值)、标识符谓词
  assert.equal(hit('export async function w(page){ await page.waitForFunction(() => document.readyState === "complete"); }'), 0);
  assert.equal(hit('export async function w(page){ await page.waitForFunction(() => { const f = () => Promise.resolve(1); return !!f; }); }'), 0, '嵌套内层函数的 return 不属于本谓词');
  assert.equal(hit('export async function w(page, p){ await page.waitForFunction(p); }'), 0, '标识符谓词在承诺面之外');
});

test('R2 第 2 轮核验补齐:剥语法壳 / 三元 / async IIFE 全部命中,且不再按方法名猜(零假红)', () => {
  const { ts } = loadVendoredTypescript();
  const hit = (text, path = 'a.ts') => {
    const r = scanSource(ts, { path, text });
    assert.equal(r.ok, true, r.error);
    return r.hits.length;
  };
  // 第 2 轮核验实测漏判的四种(修前均为 0)
  assert.equal(hit('export async function w(page: any){ await page.waitForFunction(() => Promise.resolve(true) as Promise<boolean>); }'), 1, 'as 断言外壳');
  assert.equal(hit('export async function w(page: any, cond: boolean){ await page.waitForFunction(() => cond ? Promise.resolve(true) : false); }'), 1, '三元任一分支是 Promise');
  assert.equal(hit('export async function w(page: any){ await page.waitForFunction(() => (async () => true)()); }'), 1, 'async IIFE');
  assert.equal(hit('export async function w(page: any){ await page.waitForFunction(() => { return Promise.resolve(true) as Promise<boolean>; }); }'), 1, 'block 体 return + as 断言');
  // satisfies / 非空断言 同属剥壳面
  assert.equal(hit('export async function w(page: any){ await page.waitForFunction(() => Promise.resolve(true)!); }'), 1, '非空断言外壳');
  // 第 2 轮核验实测**假红**的两种(修前均为 1):按方法名猜 Promise
  assert.equal(hit('export async function w(page: any, model: any){ await page.waitForFunction(() => model.evaluate()); }'), 0, '同步 model.evaluate() 不是 Promise——不得按方法名假红');
  assert.equal(hit('export async function w(page: any, x: any){ await page.waitForFunction(() => x.then()); }'), 0, '任意 x.then() 链基不是 Promise——不得假红');
  // 白名单 receiver 仍要报(收窄不等于放过真问题)
  assert.equal(hit('export async function w(page: any, frame: any){ await page.waitForFunction(() => frame.evaluate(() => 1)); }'), 1, 'frame.evaluate 在异步持有者白名单内');
});

test('R2:规则版本随检测面变化 bump(SC-R5 的核销依赖 ruleVersion,不 bump 会冒充"代码已修")', () => {
  assert.equal(BUILTIN_RULES[0].ruleVersion, 'v3', '检测面扩了必须 bump');
});
