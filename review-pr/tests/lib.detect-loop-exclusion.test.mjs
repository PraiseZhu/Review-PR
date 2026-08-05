// detectLoopExclusion 的 titlePrefix(legacy 单值)/ titlePrefixes(数组)兼容性单测 ——
// SC6a(2026-08-02):mivo 仓 Mivo loop(原 bug-doctor)改名后新 PR 标题前缀是
// `[mivo] `,但 review-pr 只认单值 titlePrefix 时,下一个 loop PR 会被误当人类 PR
// 审查 + 催办。本文件验证:归一化后同时兼容两种配置形态,命中后返回的
// matchedPrefix 是实际命中的那一个前缀(不是配置字面量本身),且身份门槛(stateFile
// 台账精确命中 PR 号)在新配置形态下依旧有效——命中前缀但台账查不到仍必须回落到
// null,不能被新前缀配置绕过。
//
// detectLoopExclusion 依赖模块顶层常量 REPO_ROOT(由 REVIEW_PR_REPO_ROOT env var 或
// process.cwd() 在模块加载时一次性算出,ESM 缓存后同进程内无法用不同 env var 重跑),
// 所以每个场景都在真实子进程里 import 一份新的 lib.mjs 实例,与 helpers.mjs 里其余
// 依赖 REPO_ROOT 的测试(resolveStateDirWithLib 等)手法一致。
//
// R1 修复轮追加(2026-08-02):normalizeTitlePrefixes 的 O(n) 去重 + 最长前缀优先 +
// 可信上限 fail-safe(SC-E1-1/SC-LONGEST-2)、非法配置显式告警(SC-WARN-3)、以及
// context.mjs 的 titleForFormat 接线单测(SC-WIRE-4/SC-CTXTEST-5——后者需要真的
// import 一份 context.mjs,同样走子进程手法,原因见 context.mjs 的 IS_MAIN_MODULE
// 说明:被 import 时不再触发 gh 网络调用 / process.exit,可以安全直接 import)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIB_URL, LIB_PATH } from './helpers.mjs';

const CONTEXT_URL = pathToFileURL(join(dirname(LIB_PATH), 'context.mjs')).href;

function freshTempDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'review-pr-detect-loop-')));
}

function writeStateFile(repoRoot, relPath, state) {
  const abs = join(repoRoot, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify(state));
}

/** 在真实子进程里 import 真实 lib.mjs 并调用 detectLoopExclusion,返回其结果。 */
function callDetectLoopExclusion(repoRoot, args) {
  const code = `
import(${JSON.stringify(LIB_URL)}).then(({ detectLoopExclusion }) => {
  const result = detectLoopExclusion(${JSON.stringify(args)});
  process.stdout.write(JSON.stringify(result));
}).catch((e) => { console.error(e); process.exit(1); });
`;
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot },
  });
  if (r.status !== 0) throw new Error(`子进程失败(exit ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** 在真实子进程里 import 真实 lib.mjs 并调用 normalizeTitlePrefixes,返回其结果。 */
function callNormalizeTitlePrefixes(rules) {
  const code = `
import(${JSON.stringify(LIB_URL)}).then(({ normalizeTitlePrefixes }) => {
  process.stdout.write(JSON.stringify(normalizeTitlePrefixes(${JSON.stringify(rules)})));
}).catch((e) => { console.error(e); process.exit(1); });
`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`子进程失败(exit ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/**
 * 在真实子进程里 import 真实 context.mjs 并调用其导出的 computeTitleFacts,返回结果。
 * context.mjs 顶层有 loadRules() 等文件 IO(安全,无网络),但真正会发起 gh 网络调用 /
 * process.exit 的主流程已被 IS_MAIN_MODULE 守卫限定为"仅入口脚本直接执行时才跑"——
 * 子进程用 `-e` 内联脚本 import,argv[1] 不等于 context.mjs 自身路径,守卫天然为
 * false,import 不会触发那些副作用(见 context.mjs 顶部 IS_MAIN_MODULE 的说明)。
 */
function callComputeTitleFacts(title, loopExclusion) {
  const code = `
import(${JSON.stringify(CONTEXT_URL)}).then(({ computeTitleFacts }) => {
  process.stdout.write(JSON.stringify(computeTitleFacts(${JSON.stringify(title)}, ${JSON.stringify(loopExclusion)})));
}).catch((e) => { console.error(e); process.exit(1); });
`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`子进程失败(exit ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('titlePrefixes 数组:命中 [mivo] 前缀,台账精确命中 PR 号 → 返回 matchedPrefix=[mivo] ', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 501, tCap: 'T2' } },
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[mivo] fix: 修复画布拖拽偏移',
    body: '',
    pr: 501,
    rules: {
      titlePrefixes: ['[mivo] ', '[bug-doctor] '],
      stateFile: 'history/loops/state.json',
    },
  });
  assert.deepEqual(result, { matched: true, verdict: 't2', source: 'state.json', matchedPrefix: '[mivo] ' });
});

test('titlePrefixes 数组:命中 [bug-doctor] 前缀(旧 loop 名残留 PR),同一份配置里的另一个前缀也要认', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 502, tCap: 'T1' } },
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[bug-doctor] fix: 旧前缀残留 PR',
    body: '',
    pr: 502,
    rules: {
      titlePrefixes: ['[mivo] ', '[bug-doctor] '],
      stateFile: 'history/loops/state.json',
    },
  });
  assert.deepEqual(result, { matched: true, verdict: 't1', source: 'state.json', matchedPrefix: '[bug-doctor] ' });
});

test('命中前缀但台账没有该 PR 号 → 返回 null,按普通 PR 处理(身份门槛在新配置形态下依旧生效)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 999, tCap: 'T1' } }, // 台账里只有 999,查询的是 503
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[mivo] fix: 台账查不到的 PR',
    body: '',
    pr: 503,
    rules: {
      titlePrefixes: ['[mivo] ', '[bug-doctor] '],
      stateFile: 'history/loops/state.json',
    },
  });
  assert.equal(result, null);
});

test('legacy 单值 titlePrefix 兼容:只配置旧字段(不配 titlePrefixes)行为与升级前一致', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 504, tCap: 'T2' } },
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[bug-doctor] fix: legacy 单值配置',
    body: '',
    pr: 504,
    rules: {
      titlePrefix: '[bug-doctor] ',
      stateFile: 'history/loops/state.json',
    },
  });
  assert.deepEqual(result, { matched: true, verdict: 't2', source: 'state.json', matchedPrefix: '[bug-doctor] ' });
});

test('titlePrefix 与 titlePrefixes 同时配置(迁移期常见形态):两者各自命中都要认,不因为存在数组就忽略 legacy 字段', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 505, tCap: 'T2' } },
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[legacy-only] fix: 只有 legacy 字段才命中的前缀',
    body: '',
    pr: 505,
    rules: {
      titlePrefixes: ['[mivo] '],
      titlePrefix: '[legacy-only] ',
      stateFile: 'history/loops/state.json',
    },
  });
  assert.deepEqual(result, { matched: true, verdict: 't2', source: 'state.json', matchedPrefix: '[legacy-only] ' });
});

test('标题不含任何配置的前缀 → 恒返回 null', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 506, tCap: 'T1' } },
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: 'fix: 普通贡献者 PR,标题没有任何 loop 前缀',
    body: '',
    pr: 506,
    rules: {
      titlePrefixes: ['[mivo] ', '[bug-doctor] '],
      stateFile: 'history/loops/state.json',
    },
  });
  assert.equal(result, null);
});

test('titlePrefixes 非法形态(非数组)静默忽略,不抛错,legacy titlePrefix 仍正常工作', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 507, tCap: 'T2' } },
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[bug-doctor] fix: titlePrefixes 配置形态非法',
    body: '',
    pr: 507,
    rules: {
      titlePrefixes: '[mivo] ', // 误配成裸字符串而非数组
      titlePrefix: '[bug-doctor] ',
      stateFile: 'history/loops/state.json',
    },
  });
  assert.deepEqual(result, { matched: true, verdict: 't2', source: 'state.json', matchedPrefix: '[bug-doctor] ' });
});

test('body 里的 t1BodyMarkers 优先于台账 cluster.tCap,新前缀配置下这条判据链路不变', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 508, tCap: 'T2' } }, // 台账写的是 T2,但 body marker 应优先采信 T1
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[mivo] fix: body 声明 T1',
    body: '<!-- mivo-loop:tlevel=T1 -->',
    pr: 508,
    rules: {
      titlePrefixes: ['[mivo] '],
      stateFile: 'history/loops/state.json',
      t1BodyMarkers: ['^<!-- mivo-loop:tlevel=T1 -->$'],
      t2BodyMarkers: ['^<!-- mivo-loop:tlevel=T2 -->$'],
    },
  });
  assert.deepEqual(result, { matched: true, verdict: 't1', source: 'body-marker', matchedPrefix: '[mivo] ' });
});

test('rules 未配置任何 loopPrExclusion(null)→ 恒返回 null,不因传入 title/body/pr 而崩', () => {
  const repoRoot = freshTempDir();
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[mivo] fix: 目标仓库没有配置 loopPrExclusion',
    body: '',
    pr: 509,
    rules: null,
  });
  assert.equal(result, null);
});

// ── R1 修复轮(2026-08-02)新增:SC-WIRE-4 补齐 t2BodyMarkers 与 default 两个 return
// 分支的 matchedPrefix 断言 ──

test('body 里的 t2BodyMarkers 优先于台账 cluster.tCap(R1 补齐,SC-WIRE-4)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 510, tCap: 'T1' } }, // 台账写的是 T1,但 body marker 应优先采信 T2
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[mivo] fix: body 声明 T2',
    body: '<!-- mivo-loop:tlevel=T2 -->',
    pr: 510,
    rules: {
      titlePrefixes: ['[mivo] '],
      stateFile: 'history/loops/state.json',
      t1BodyMarkers: ['^<!-- mivo-loop:tlevel=T1 -->$'],
      t2BodyMarkers: ['^<!-- mivo-loop:tlevel=T2 -->$'],
    },
  });
  assert.deepEqual(result, { matched: true, verdict: 't2', source: 'body-marker', matchedPrefix: '[mivo] ' });
});

test('t1BodyMarkers/t2BodyMarkers 都未命中、台账 tCap 也非 T1/T2 → 退回 defaultWhenAmbiguous 配置值(R1 补齐,SC-WIRE-4)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 511, tCap: 'unknown' } },
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[mivo] fix: 台账 tCap 读不出明确 T-level',
    body: '',
    pr: 511,
    rules: {
      titlePrefixes: ['[mivo] '],
      stateFile: 'history/loops/state.json',
      defaultWhenAmbiguous: 't2',
    },
  });
  assert.deepEqual(result, { matched: true, verdict: 't2', source: 'default', matchedPrefix: '[mivo] ' });
});

test('default 分支且未配置 defaultWhenAmbiguous → 保守默认 skip,matchedPrefix 仍如实回传(R1 补齐,SC-WIRE-4)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 512 } }, // 无 tCap 字段
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[bug-doctor] fix: 台账无 tCap 也无 defaultWhenAmbiguous 配置',
    body: '',
    pr: 512,
    rules: {
      titlePrefixes: ['[bug-doctor] '],
      stateFile: 'history/loops/state.json',
    },
  });
  assert.deepEqual(result, { matched: true, verdict: 'skip', source: 'default', matchedPrefix: '[bug-doctor] ' });
});

// ── R1 修复轮新增:SC-E1-1(可信上限 fail-safe)/ SC-LONGEST-2(最长前缀优先)在
// detectLoopExclusion 这一层的端到端行为 ──

test('titlePrefixes 项数超过可信上限(33>32)→ fail-safe 整体禁用,即便标题命中其中一项也返回 null(SC-E1-1)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 513, tCap: 'T2' } },
  });
  const manyPrefixes = Array.from({ length: 33 }, (_, i) => `[p${i}] `);
  const result = callDetectLoopExclusion(repoRoot, {
    title: `${manyPrefixes[5]}fix: 命中第 6 个前缀,但配置项数已超上限`,
    body: '',
    pr: 513,
    rules: {
      titlePrefixes: manyPrefixes,
      stateFile: 'history/loops/state.json',
    },
  });
  assert.equal(result, null);
});

test('单项前缀长度超过可信上限(>128 字节)→ fail-safe 整体禁用(SC-E1-1)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 514, tCap: 'T2' } },
  });
  const hugePrefix = `[${'x'.repeat(130)}] `;
  const result = callDetectLoopExclusion(repoRoot, {
    title: `${hugePrefix}fix: 单项超长`,
    body: '',
    pr: 514,
    rules: {
      titlePrefixes: [hugePrefix],
      stateFile: 'history/loops/state.json',
    },
  });
  assert.equal(result, null);
});

test('titlePrefixes=["[mivo]","[mivo] "] 命中最长前缀,不依赖声明顺序(SC-LONGEST-2 场景 1/2)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 515, tCap: 'T2' } },
  });
  const resultA = callDetectLoopExclusion(repoRoot, {
    title: '[mivo] fix: 声明顺序 A(短前缀在前)',
    body: '',
    pr: 515,
    rules: { titlePrefixes: ['[mivo]', '[mivo] '], stateFile: 'history/loops/state.json' },
  });
  assert.equal(resultA.matchedPrefix, '[mivo] ');

  const resultB = callDetectLoopExclusion(repoRoot, {
    title: '[mivo] fix: 声明顺序 B(长前缀在前)',
    body: '',
    pr: 515,
    rules: { titlePrefixes: ['[mivo] ', '[mivo]'], stateFile: 'history/loops/state.json' },
  });
  assert.equal(resultB.matchedPrefix, '[mivo] ');
});

test('数组项 ["[mivo]"] 与 legacy titlePrefix="[mivo] " 并存时命中更长的 legacy 值(SC-LONGEST-2 场景 3,原为 false 的组合)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', {
    clusters: { c1: { pr: 516, tCap: 'T2' } },
  });
  const result = callDetectLoopExclusion(repoRoot, {
    title: '[mivo] fix: 数组项与 legacy 字段声称的顺序恰好相反',
    body: '',
    pr: 516,
    rules: {
      titlePrefixes: ['[mivo]'],
      titlePrefix: '[mivo] ',
      stateFile: 'history/loops/state.json',
    },
  });
  assert.equal(result.matchedPrefix, '[mivo] ');
});

// ── R1 修复轮新增:normalizeTitlePrefixes 的直接单测(SC-E1-1/SC-LONGEST-2/SC-WARN-3,
// 现已导出,不必再全部经 detectLoopExclusion 间接验证)──

test('normalizeTitlePrefixes:非法条目(嵌套非字符串/空字符串)被过滤,invalid=true,合法子集仍可用(SC-WARN-3)', () => {
  const result = callNormalizeTitlePrefixes({
    titlePrefixes: ['[mivo] ', 42, '', '[bug-doctor] '],
    titlePrefix: '[legacy] ',
  });
  assert.equal(result.invalid, true);
  assert.equal(result.overLimit, false);
  assert.deepEqual(new Set(result.prefixes), new Set(['[mivo] ', '[bug-doctor] ', '[legacy] ']));
});

test('normalizeTitlePrefixes:titlePrefixes 整体非数组(误配裸字符串)时 invalid=true,legacy 字段仍正常纳入(SC-WARN-3)', () => {
  const result = callNormalizeTitlePrefixes({
    titlePrefixes: '[mivo] ',
    titlePrefix: '[bug-doctor] ',
  });
  assert.equal(result.invalid, true);
  assert.deepEqual(result.prefixes, ['[bug-doctor] ']);
});

test('normalizeTitlePrefixes:合法配置 invalid=false、overLimit=false,按长度降序返回(SC-E1-1/SC-LONGEST-2)', () => {
  const result = callNormalizeTitlePrefixes({
    titlePrefixes: ['[mivo]', '[bug-doctor] ', '[mivo] '],
  });
  assert.equal(result.invalid, false);
  assert.equal(result.overLimit, false);
  assert.deepEqual(result.prefixes, ['[bug-doctor] ', '[mivo] ', '[mivo]']);
});

test('normalizeTitlePrefixes:rules 为 null → 返回空数组且两个标记均为 false', () => {
  const result = callNormalizeTitlePrefixes(null);
  assert.deepEqual(result, { prefixes: [], invalid: false, overLimit: false });
});

test('normalizeTitlePrefixes:33 项超过 MAX_COUNT=32 → overLimit=true、prefixes 清空(SC-E1-1)', () => {
  const manyPrefixes = Array.from({ length: 33 }, (_, i) => `[p${i}] `);
  const result = callNormalizeTitlePrefixes({ titlePrefixes: manyPrefixes });
  assert.equal(result.overLimit, true);
  assert.deepEqual(result.prefixes, []);
});

// ── R1 修复轮新增:context.mjs computeTitleFacts 的接线单测(SC-WIRE-4/SC-CTXTEST-5)。
// context.mjs 此前整份零测试覆盖——把这条"必须用 matchedPrefix 剥前缀"的接线改回
// base 实现(只认模块级 LOOP_EXCLUSION_RULES.titlePrefix)不会有任何测试变红,是本轮
// 修复前席②实测的缺口。以下测试直接 import 真实 context.mjs 并调用其导出的纯函数,
// 反向变异(把 computeTitleFacts 改回读 LOOP_EXCLUSION_RULES?.titlePrefix)时应当且
// 恰好让下面第一条('type gate 通过')变红——已手工验证,见交付报告 ──

test('context.mjs computeTitleFacts:titlePrefixes=["[mivo] "]、T2 托管 PR 用 matchedPrefix 剥前缀后 type gate 通过(SC-WIRE-4/SC-CTXTEST-5)', () => {
  const loopExclusion = { matched: true, verdict: 't2', source: 'state.json', matchedPrefix: '[mivo] ' };
  const result = callComputeTitleFacts('[mivo] fix: 修复画布拖拽偏移', loopExclusion);
  assert.equal(result.titleForFormat, 'fix: 修复画布拖拽偏移');
  assert.equal(result.type, 'fix');
  assert.equal(result.titleTypeOk, true);
});

test('context.mjs computeTitleFacts:未命中 loopExclusion(null)时 titleForFormat 就是原始 title,行为不变(SC-CTXTEST-5)', () => {
  const result = callComputeTitleFacts('fix: 普通贡献者 PR', null);
  assert.equal(result.titleForFormat, 'fix: 普通贡献者 PR');
  assert.equal(result.type, 'fix');
  assert.equal(result.titleTypeOk, true);
});

// ── A1 force-review 强制路由(缴械配套,owner 2026-08-04)──
// 配置 forceVerdict 后:身份确认 → 一律 t2 进审,优先于 body marker 与 cluster.tCap;
// 身份门槛不被 force 绕过(台账未命中仍 null)。六场景第 6 条(带 /approve-merge 的
// loop PR 仍不许 fast-merge)在 tests/pkg-a.review-gates.test.mjs 的 A2 段覆盖。

function forceRules(repoRoot, extra = {}) {
  return { titlePrefixes: ['[mivo] '], stateFile: 'history/loops/state.json', forceVerdict: 't2',
    t1BodyMarkers: ['^T-level: T1$'], t2BodyMarkers: ['^T-level: T2$'], defaultWhenAmbiguous: 'skip', ...extra };
}

test('A1-1 force + body T2 marker + state T1 → t2,source=force-config(不再读 marker/tCap)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', { clusters: { c: { pr: 601, tCap: 'T1' } } });
  const r = callDetectLoopExclusion(repoRoot, { title: '[mivo] x', body: 'T-level: T2', pr: 601, rules: forceRules(repoRoot) });
  assert.deepEqual({ verdict: r.verdict, source: r.source }, { verdict: 't2', source: 'force-config' });
});

test('A1-2 force + body 无 marker + state T1 → t2(tCap=T1 不再造成跳审)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', { clusters: { c: { pr: 602, tCap: 'T1' } } });
  const r = callDetectLoopExclusion(repoRoot, { title: '[mivo] x', body: '', pr: 602, rules: forceRules(repoRoot) });
  assert.equal(r.verdict, 't2');
});

test('A1-3 force + body T1 marker → 仍 t2(loop 侧数据漂移回 T1 也压不过 force)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', { clusters: { c: { pr: 603, tCap: 'T1' } } });
  const r = callDetectLoopExclusion(repoRoot, { title: '[mivo] x', body: 'T-level: T1', pr: 603, rules: forceRules(repoRoot) });
  assert.equal(r.verdict, 't2');
});

test('A1-4 force + state tCap 未知值 → t2(不落 defaultWhenAmbiguous=skip)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', { clusters: { c: { pr: 604, tCap: 'T9' } } });
  const r = callDetectLoopExclusion(repoRoot, { title: '[mivo] x', body: '', pr: 604, rules: forceRules(repoRoot) });
  assert.equal(r.verdict, 't2');
});

test('A1-5 force 不绕身份门槛:台账未命中 PR → null(按普通 PR 走全套审查)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', { clusters: { c: { pr: 999, tCap: 'T2' } } });
  const r = callDetectLoopExclusion(repoRoot, { title: '[mivo] x', body: '', pr: 605, rules: forceRules(repoRoot) });
  assert.equal(r, null);
});

test('A1-6 forceVerdict 拼写漂移(非 t2 值)→ 收敛为 t2 且 source 标 coerced(绝不产生更宽松结果)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', { clusters: { c: { pr: 606, tCap: 'T1' } } });
  const r = callDetectLoopExclusion(repoRoot, { title: '[mivo] x', body: '', pr: 606, rules: forceRules(repoRoot, { forceVerdict: 'T2' }) });
  assert.deepEqual({ verdict: r.verdict, source: r.source }, { verdict: 't2', source: 'force-config-coerced' });
});

test('A1-7 未配置 forceVerdict → 原有语义原样(state T1 → t1,回归保护)', () => {
  const repoRoot = freshTempDir();
  writeStateFile(repoRoot, 'history/loops/state.json', { clusters: { c: { pr: 607, tCap: 'T1' } } });
  const rules = forceRules(repoRoot); delete rules.forceVerdict;
  const r = callDetectLoopExclusion(repoRoot, { title: '[mivo] x', body: '', pr: 607, rules });
  assert.deepEqual({ verdict: r.verdict, source: r.source }, { verdict: 't1', source: 'state.json' });
});
