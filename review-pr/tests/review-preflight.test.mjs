// SC-R2 行为测试:review-preflight.mjs 子进程实跑 + 真实 temp git base/head。
// 覆盖:#483 真坏/好样例、既存命中 report-only、语法错→incomplete、parser 缺失→
// incomplete、snapshot 漂移、以及零误报对照(TS 泛型 / TSX / locator.waitFor /
// vi.waitFor(async))。反向变异:归因改恒"新增" → 恰红既存用例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVendoredTypescript, scanSource, scriptKindFor } from '../scripts/lib.preflight-rules.mjs';

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
  const r = repo({ baseFiles: { 'a.md': 'x\n' }, headFiles: { 'scripts/e2e/a.mjs': BAD } });
  const entry = join(VENDOR, 'typescript.js');
  const stash = join(VENDOR, 'typescript.js.stashed-for-test');
  assert.ok(existsSync(entry));
  renameSync(entry, stash);
  try {
    const { res, json } = run(r);
    assert.equal(json.complete, false);
    assert.match(json.reason, /parser 不可用/);
    assert.deepEqual(json.hits, [], 'parser 缺失时绝不给出命中/无命中结论');
    assert.equal(res.status, 2);
  } finally {
    renameSync(stash, entry);
  }
});

test('R2 fail-closed:base/head oid 非法 → complete=false', () => {
  const r = repo({ baseFiles: { 'a.md': 'x\n' }, headFiles: { 'b.md': 'y\n' } });
  const { json } = run({ ...r, base: 'a'.repeat(40) });
  assert.equal(json.complete, false);
  assert.match(json.reason, /DiffSnapshot 不完整/);
});
