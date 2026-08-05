// pkg-a.review-gates.test.mjs — 缴械台账包 A 的 A2/A3/A4/A5 回归防线
// (A1 force-review 的行为级测试在 lib.detect-loop-exclusion.test.mjs 尾部)。
//
// 分层如实声明:
// - A5 的 judgeMergedLoopPr / loadAuditState 是**行为级**单测(纯函数 + 子进程整脚本);
// - A2/A3/A4 落在 pre-merge-check.mjs / notify-merge-*.mjs 的主流程里,行为级复现需要
//   mock 整条 gh 链,本文件用**源码接线断言**钉住(与「timeout 常量必须真的传进 spawnSync」
//   同款纪律:单元层锁不住接线,接线断言防的是"常量在而不传等于无界"这类静默退化)。
//   接线断言的已知局限:锁得住"分支被删/条件被改写",锁不住"分支还在但逻辑等价地绕过"
//   ——后者靠 mivo 侧 force-review 数据面(t1BodyMarkers 清空 + defaultWhenAmbiguous=t2)
//   与本仓 A1 行为测试双保险。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LIB_PATH } from './helpers.mjs';

const SCRIPTS = dirname(LIB_PATH);
const src = (f) => readFileSync(join(SCRIPTS, f), 'utf8');
const AUDIT_URL = pathToFileURL(join(SCRIPTS, 'audit-merged-loop-prs.mjs')).href;

// ── A2:loop PR 封死 authorized-fast-merge ──

test('A2 接线:pre-merge-check 在 fast-merge 判定前调用 detectLoopExclusion,loop 命中即封死', () => {
  const s = src('pre-merge-check.mjs');
  // 三条一起钉:import 了 detectLoopExclusion / 命中分支存在且拿不到 available / 封死理由字面量
  assert.match(s, /detectLoopExclusion[\s\S]{0,400}from '\.\/lib\.mjs'/, 'import 接线被删');
  assert.match(s, /approveMergeAuth\.authorized && loopExclusionForGate/, 'loop 封死分支被删');
  assert.match(s, /loop-managed-pr-fast-merge-forbidden/, '封死理由字面量被改');
  // 封死分支里绝不能出现 authorizedFastMergeAvailable = true
  const branch = s.slice(s.indexOf('approveMergeAuth.authorized && loopExclusionForGate'), s.indexOf('} else if (approveMergeAuth.authorized)'));
  assert.ok(!branch.includes('authorizedFastMergeAvailable = true'), '封死分支内不得置 available=true');
});

test('A2 顺序:loop 封死分支必须先于普通 fast-merge 分支(else-if 链顺序即优先级)', () => {
  const s = src('pre-merge-check.mjs');
  const guard = s.indexOf('approveMergeAuth.authorized && loopExclusionForGate');
  const normal = s.indexOf('} else if (approveMergeAuth.authorized)');
  assert.ok(guard > 0 && normal > guard, 'loop 分支必须在普通分支之前(顺序反了 = loop PR 先进普通通道)');
});

// ── A3:self-merge 硬门绑 isDraft=false ──

test('A3 接线:gh 查询字段含 isDraft,且 selfMergeAvailable 条件用 === false(undefined 不放行)', () => {
  const s = src('pre-merge-check.mjs');
  assert.match(s, /--json',\s*'title,body,state,isDraft,/, 'gh 查询未取 isDraft(条件恒 undefined,永不 self-merge——方向安全但功能全废,必须显式取)');
  assert.match(s, /isSelfPr && isSelfFixAuthor && m\.isDraft === false/, 'selfMergeAvailable 未绑 isDraft === false');
});

test('A3 既有回执硬门未被削弱:stage2Clean 仍是 self-merge 前置(回归保护)', () => {
  const s = src('pre-merge-check.mjs');
  assert.match(s, /viewerLogin && prAuthor && receiptGate\.stage2Clean && securityGate\.pass/, 'stage2Clean/securityGate 前置被削');
});

// ── A4:播报路由只跳「仍自管」──

test('A4 接线:notify-merge-ack 只在 verdict !== t2 时跳过(t2 的致谢由巡审侧发)', () => {
  const s = src('notify-merge-ack.mjs');
  assert.match(s, /loopExclusion && loopExclusion\.verdict !== 't2'/, 'ack 路由条件不对(一刀切会吞掉全部 t2 致谢)');
});

test('A4 接线:notify-merge-backfill 同口径', () => {
  const s = src('notify-merge-backfill.mjs');
  assert.match(s, /loopExclusion && loopExclusion\.verdict !== 't2'/, 'backfill 路由条件不对');
});

// ── A5:事后审计闸 ──

test('A5 judgeMergedLoopPr 全矩阵:缺回执/缺head/stale/非clean → 漏网;head匹配+clean → 过', async () => {
  const { judgeMergedLoopPr } = await import(AUDIT_URL);
  const H = 'a'.repeat(40);
  assert.equal(judgeMergedLoopPr({ receipt: null, headRefOid: H }).ok, false);
  assert.match(judgeMergedLoopPr({ receipt: null, headRefOid: H }).reason, /no-receipt/);
  assert.equal(judgeMergedLoopPr({ receipt: { headRefOid: H, verdict: 'clean' }, headRefOid: null }).ok, false);
  assert.equal(judgeMergedLoopPr({ receipt: { headRefOid: 'b'.repeat(40), verdict: 'clean' }, headRefOid: H }).ok, false);
  assert.match(judgeMergedLoopPr({ receipt: { headRefOid: 'b'.repeat(40), verdict: 'clean' }, headRefOid: H }).reason, /stale-receipt/);
  assert.equal(judgeMergedLoopPr({ receipt: { headRefOid: H, verdict: 'dirty' }, headRefOid: H }).ok, false);
  assert.equal(judgeMergedLoopPr({ receipt: { headRefOid: H, verdict: 'clean' }, headRefOid: H }).ok, true);
});

test('A5 loadAuditState:损坏 fail-visible(抛而非静默重建——静默重建会丢游标造成误告警窗)', async () => {
  const { loadAuditState } = await import(AUDIT_URL);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pkg-a-audit-')));
  writeFileSync(join(dir, 'audit-merged-loop.json'), '{broken');
  assert.throws(() => loadAuditState(dir));
  // 不存在 → 干净默认值(cursor=null 触发首跑语义)
  const dir2 = realpathSync(mkdtempSync(join(tmpdir(), 'pkg-a-audit2-')));
  assert.deepEqual(loadAuditState(dir2), { schemaVersion: 1, cursor: null, audited: {} });
});

/** 子进程整脚本跑一轮(与 detect-loop-exclusion 测试同款手法:REPO_ROOT 是模块级常量)。 */
function runAudit(repoRoot, extraArgs = []) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'audit-merged-loop-prs.mjs'), ...extraArgs], {
    cwd: repoRoot, encoding: 'utf8',
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: join(repoRoot, '.audit-state') },
  });
  return r;
}

/** STATE_DIR = <envRoot>/<repoStateKey>——repoStateKey 是仓库哈希,测试不硬编码,直接找。 */
function findAuditStateFile(repoRoot) {
  const root = join(repoRoot, '.audit-state');
  for (const sub of readdirSync(root)) {
    const f = join(root, sub, 'audit-merged-loop.json');
    if (existsSync(f)) return f;
  }
  throw new Error(`audit-merged-loop.json 不在 ${root} 任何子目录下`);
}

function seedAuditRepo() {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pkg-a-audit-repo-')));
  // 最小 git 仓(STATE_DIR 校验需要);pr-rules 带 loopPrExclusion + 台账
  spawnSync('git', ['init', '-q'], { cwd: repoRoot });
  // STATE_DIR 校验会拒绝「受 git 跟踪且未忽略」的目录(SKILL.md 状态目录一节),先 ignore
  // 注意不带尾斜杠:`.audit-state/` 目录模式对**尚不存在**的路径 check-ignore 不匹配,
  // STATE_DIR 校验(isSafeFromDirtyWorkingTree)会拒绝并回退系统临时目录
  writeFileSync(join(repoRoot, '.gitignore'), '.audit-state\n');
  mkdirSync(join(repoRoot, 'agent-use', 'docs'), { recursive: true });
  writeFileSync(join(repoRoot, 'agent-use', 'docs', 'pr-rules.json'), JSON.stringify({
    loopPrExclusion: { titlePrefixes: ['[mivo] '], stateFile: 'history/loops/state.json', forceVerdict: 't2' },
  }));
  mkdirSync(join(repoRoot, 'history', 'loops'), { recursive: true });
  writeFileSync(join(repoRoot, 'history', 'loops', 'state.json'), JSON.stringify({
    clusters: { c1: { pr: 701 }, c2: { pr: 702 } },
  }));
  return repoRoot;
}

test('A5 首跑语义:无游标 → 只立游标不回溯,输出 firstRun=true', () => {
  const repoRoot = seedAuditRepo();
  const r = runAudit(repoRoot, ['--now', '2026-08-05T10:00:00Z']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.firstRun, true);
  assert.equal(out.cursorSet, '2026-08-05T10:00:00Z');
  // 游标真的落盘了
  const st = JSON.parse(readFileSync(findAuditStateFile(repoRoot), 'utf8'));
  assert.equal(st.cursor, '2026-08-05T10:00:00Z');
});

test('A5 行为:窗口内 merged loop PR 无回执 → 判漏网;非 loop PR 不进审计;dry-run 不落盘', () => {
  const repoRoot = seedAuditRepo();
  runAudit(repoRoot, ['--now', '2026-08-05T10:00:00Z']); // 立游标
  const mergedFile = join(repoRoot, 'merged.json');
  writeFileSync(mergedFile, JSON.stringify([
    { number: 701, title: '[mivo] fix x', body: '', headRefOid: 'c'.repeat(40), mergeCommitOid: 'd'.repeat(40), mergedAt: '2026-08-05T11:00:00Z' },
    { number: 900, title: 'feat: 人类 PR', body: '', headRefOid: 'e'.repeat(40), mergeCommitOid: 'f'.repeat(40), mergedAt: '2026-08-05T11:30:00Z' },
    { number: 702, title: '[mivo] fix y', body: '', headRefOid: 'a'.repeat(40), mergeCommitOid: 'b'.repeat(40), mergedAt: '2026-08-05T09:00:00Z' }, // 游标之前 → 不审
  ]));
  const r = runAudit(repoRoot, ['--dry-run', '--now', '2026-08-05T12:00:00Z', '--input-merged', mergedFile]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.audited.length, 1, '只有 701 该进审计(900 非 loop,702 在游标前)');
  assert.equal(out.audited[0].pr, 701);
  assert.equal(out.audited[0].ok, false);
  assert.match(out.audited[0].reason, /no-receipt/);
  // dry-run:游标未推进、无 audited 台账写入
  const st = JSON.parse(readFileSync(findAuditStateFile(repoRoot), 'utf8'));
  assert.equal(st.cursor, '2026-08-05T10:00:00Z');
  assert.deepEqual(st.audited, {});
});

test('A5 窗口两端都裁:mergedAt 晚于 now 的合并不进本轮(右边界;实测发现只裁左端的缺口)', () => {
  const repoRoot = seedAuditRepo();
  runAudit(repoRoot, ['--now', '2026-08-05T10:00:00Z']); // 立游标
  const mergedFile = join(repoRoot, 'merged.json');
  writeFileSync(mergedFile, JSON.stringify([
    { number: 701, title: '[mivo] in-window', body: '', headRefOid: 'c'.repeat(40), mergeCommitOid: 'd'.repeat(40), mergedAt: '2026-08-05T11:00:00Z' },
    { number: 702, title: '[mivo] after-now', body: '', headRefOid: 'a'.repeat(40), mergeCommitOid: 'b'.repeat(40), mergedAt: '2026-08-05T15:00:00Z' },
  ]));
  const r = runAudit(repoRoot, ['--dry-run', '--now', '2026-08-05T12:00:00Z', '--input-merged', mergedFile]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.audited.map((a) => a.pr), [701], '只有窗口内的 701 该被审到(702 晚于 now)');
});

test('A5 漏跑=延迟不是永久漏审:游标只在真跑时推进,下次跑把跨过的窗口一并审到', () => {
  const repoRoot = seedAuditRepo();
  runAudit(repoRoot, ['--now', '2026-08-05T10:00:00Z']);
  const mergedFile = join(repoRoot, 'merged.json');
  writeFileSync(mergedFile, JSON.stringify([
    { number: 701, title: '[mivo] a', body: '', headRefOid: 'c'.repeat(40), mergeCommitOid: 'd'.repeat(40), mergedAt: '2026-08-05T11:00:00Z' },
    { number: 702, title: '[mivo] b', body: '', headRefOid: 'a'.repeat(40), mergeCommitOid: 'b'.repeat(40), mergedAt: '2026-08-05T15:00:00Z' },
  ]));
  // 模拟"某轮漏跑":dry-run 不落盘 → 游标停在 10:00
  const skipped = JSON.parse(runAudit(repoRoot, ['--dry-run', '--now', '2026-08-05T12:00:00Z', '--input-merged', mergedFile]).stdout);
  assert.equal(skipped.windowFrom, '2026-08-05T10:00:00Z');
  // 下一次真跑:窗口 10:00→16:00,两个合并都该被审到(SKILL.md 该声称的实测支撑)
  const later = JSON.parse(runAudit(repoRoot, ['--dry-run', '--now', '2026-08-05T16:00:00Z', '--input-merged', mergedFile]).stdout);
  assert.deepEqual(later.audited.map((a) => a.pr).sort(), [701, 702]);
});

test('A5 幂等:已 alerted 的 <pr>:<mergeOid> 下轮 skipped=already-audited,不重复告警', () => {
  const repoRoot = seedAuditRepo();
  runAudit(repoRoot, ['--now', '2026-08-05T10:00:00Z']);
  // 手工预置「上轮已告警」台账
  const stPath = findAuditStateFile(repoRoot);
  const st = JSON.parse(readFileSync(stPath, 'utf8'));
  st.audited[`701:${'d'.repeat(40)}`] = { alerted: true, at: '2026-08-05T11:59:00Z' };
  writeFileSync(stPath, JSON.stringify(st));
  const mergedFile = join(repoRoot, 'merged.json');
  writeFileSync(mergedFile, JSON.stringify([
    { number: 701, title: '[mivo] fix x', body: '', headRefOid: 'c'.repeat(40), mergeCommitOid: 'd'.repeat(40), mergedAt: '2026-08-05T11:00:00Z' },
  ]));
  const r = runAudit(repoRoot, ['--dry-run', '--now', '2026-08-05T13:00:00Z', '--input-merged', mergedFile]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.audited[0].skipped, 'already-audited');
});

test('A5 接线:revert 走 GitHub 原生 revertPullRequest mutation 且开 ready(draft: false)', () => {
  const s = src('audit-merged-loop-prs.mjs');
  assert.match(s, /revertPullRequest\(input:\s*\{\s*pullRequestId:.*draft:\s*false/s, 'revert PR 必须 ready——draft 不进巡审,闸就断了');
  assert.match(s, /仍走 review-pr 巡审审查合并/, 'revert PR body 必须写明处置路径');
});
