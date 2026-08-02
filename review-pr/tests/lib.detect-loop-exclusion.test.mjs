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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIB_URL } from './helpers.mjs';

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
