// convergence-state.test.mjs — SC-C2(同族复发判定)+ SC-C3(收敛止损)单测。
//
// PR 号命名空间:970001-970099 单元级(家族/复发/覆盖/连续计数/阈值/两级检测),
// 970100-970199 损坏与隔离,970200-970299 与 review-receipt / runs.jsonl 的
// 跨模块独立性回归,970300+ CLI 端到端。与其它测试文件(900000/920000/930000 段)
// 及真实 PR 号不重叠——但**仍需**在每个测试开头调用 `resetPr()` 清掉上一次真实
// 运行遗留的状态文件:STATE_DIR 是这台机器上持久的真实目录(同 lib.review-
// receipt.test.mjs 的既有做法),receipt 类测试天然幂等(单对象 last-write-wins,
// 重跑收敛到同一结果),但本文件的测试会跨多个 head 累积家族历史,不是简单覆盖
// 就能收敛回同一状态——重跑必须先清空,否则会把上一次运行遗留的家族/occurrence
// 也算进本次断言,得到误报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readConvergenceState, recordConvergenceRound, hasNotified, markNotified,
  computeConservativeSeedRounds,
  CONVERGENCE_CHECKPOINT_THRESHOLD, CONVERGENCE_NOTIFY_THRESHOLD, CONVERGENCE_NOTIFY_REASON_ROUND,
} from '../scripts/convergence-state.mjs';
import { STATE_DIR, stateFile, writeReviewReceipt, readReviewReceipt, isReviewReceiptClean } from '../scripts/lib.mjs';
// invariantSlug 是 rp-output 侧的只读依赖(见 convergence-state.mjs 文件头
// 「归一化实现」说明),这里 import 它只是为了让测试断言用同一份真实算法构造
// fixture(如"这两个字符串归一化后应该相等/不相等"),不测它自己的行为——
// 那是 rp-output 自己的测试范围,不重复覆盖。
import { invariantSlug } from '../scripts/lib.review-output-shape.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'scripts', 'record-convergence-round.mjs');

/** 清掉某 PR 在真实 STATE_DIR 里遗留的收敛状态文件(含隔离出的损坏副本),让每个
 * 测试都能假设"这个 PR 号从未被记录过"——见文件头注释,不能像 receipt 测试那样
 * 假设重跑天然幂等。 */
function resetPr(pr) {
  const prefix = `convergence-${pr}.json`;
  for (const name of readdirSync(STATE_DIR)) {
    if (name === prefix || name.startsWith(`${prefix}.corrupted-`)) {
      unlinkSync(join(STATE_DIR, name));
    }
  }
}

function slugOf(pr) {
  const { state } = readConvergenceState(pr);
  const slugs = Object.keys(state.families);
  assert.equal(slugs.length, 1, `期望恰好一个家族,实际 ${slugs.length}`);
  return slugs[0];
}

// ── invariantSlug 是 rp-output 的只读依赖,不是本模块的代码——这里不重新测试它
// 自身的实现(那是 rp-output 的测试范围),只确认 convergence-state.mjs 确实在用
// 这份真实实现(而不是自己另写的占位版),用它的输出关系构造 fixture ──

test('convergence-state 确实复用 invariantSlug 的真实归一化行为(同一不变量换大小写/空白应归一到同一 slug)', () => {
  assert.equal(invariantSlug('Foo Bar Baz'), invariantSlug('foo  bar baz'));
  assert.equal(invariantSlug('缺少空值校验  在 foo 函数'), invariantSlug('缺少空值校验 在 FOO 函数'));
  assert.throws(() => invariantSlug(''), TypeError, '空串应 throw(真实实现的行为,不是本模块能改的)');
  assert.throws(() => invariantSlug('   '), TypeError, '去空白后为空同样应 throw');
});

test('输入校验:invariant 为纯空白字符串(trim 后为空)同样 throw,不能靠裸 === "" 放过', () => {
  resetPr(970024);
  assert.throws(
    () => recordConvergenceRound({ pr: 970024, headRefOid: 'sha-1', findings: [{ invariant: '   ', severity: 'P1' }] }),
    /invariant/,
  );
});

// ── 基础:首轮建家族,missing 状态正确识别 ──

test('首次记录(missing → ok):建一个新家族,roundCount=1,checkpoint/notify 均未触发', () => {
  resetPr(970001);
  const before = readConvergenceState(970001);
  assert.equal(before.status, 'missing');

  const r = recordConvergenceRound({
    pr: 970001, headRefOid: 'sha-1', findings: [{ invariant: '缺少空值校验', severity: 'P1', description: 'a.js:1' }],
  });
  assert.equal(r.roundCount, 1);
  assert.equal(r.newFamilyCount, 1);
  assert.equal(r.p0p1Count, 1);
  assert.equal(r.consecutiveRoundsWithNewFamilies, 1);
  assert.equal(r.checkpointRequired, false);
  assert.equal(r.notification, null);
  assert.equal(r.integrityWarning, null);
  assert.deepEqual(r.recurringFamilies, []);

  const after = readConvergenceState(970001);
  assert.equal(after.status, 'ok');
});

// ── 定案 3·一级检测(确定性):slug 自动命中,不需要调用方声明 ──

test('一级检测:同一不变量换个大小写/空白写法,不传 recurrenceOfSlug 也能自动判定复发', () => {
  const pr = 970002;
  resetPr(pr);
  recordConvergenceRound({
    pr, headRefOid: 'sha-1', findings: [{ invariant: 'X 未处理并发写入', severity: 'P0', description: 'b.js:5' }],
  });

  const r2 = recordConvergenceRound({
    pr, headRefOid: 'sha-2',
    findings: [{ invariant: 'x  未处理并发写入', severity: 'P0', description: 'b.js:9' }], // 大小写+空白不同,未声明 recurrenceOfSlug
  });
  assert.equal(r2.p0p1Count, 1, 'D1:复发 finding 仍要计入本轮 p0p1Count');
  assert.equal(r2.newFamilyCount, 0, '一级命中不应贡献新家族数');
  assert.equal(r2.recurringFamilies.length, 1);
  assert.equal(r2.recurringFamilies[0].matchedBy, 'slug', '未声明 recurrenceOfSlug 时,命中必须来自一级自动检测');
  assert.equal(r2.recurringFamilies[0].priorHead, 'sha-1');
  assert.equal(r2.recurringFamilies[0].priorDescription, 'b.js:5');
});

// ── 定案 3·二级检测(T1 兜底):换了完全不同的说法,靠显式 recurrenceOfSlug ──

test('二级检测:完全不同的措辞,一级 slug 不会命中,必须靠显式 recurrenceOfSlug(matchedBy=semantic)', () => {
  const pr = 970003;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: '未处理并发写入竞态', severity: 'P0' }] });
  const slug1 = slugOf(pr);
  assert.notEqual(invariantSlug('写锁未生效导致数据竞争'), slug1, '措辞完全不同,一级归一化不应偶然撞上同一 slug(否则本测试没测到二级路径)');

  const r2 = recordConvergenceRound({
    pr, headRefOid: 'sha-2',
    findings: [{ invariant: '写锁未生效导致数据竞争', severity: 'P0', recurrenceOfSlug: slug1 }],
  });
  assert.equal(r2.newFamilyCount, 0);
  assert.equal(r2.recurringFamilies.length, 1);
  assert.equal(r2.recurringFamilies[0].matchedBy, 'semantic', '一级不命中、靠显式引用命中的必须标 semantic,不能标 slug');
  assert.equal(r2.recurringFamilies[0].slug, slug1);
  assert.equal(r2.recurringFamilies[0].priorHead, 'sha-1');
});

test('二级检测:显式 recurrenceOfSlug 恰好等于一级自动算出的 slug 时,按更简单可解释的 slug 记录,不虚报 semantic', () => {
  const pr = 970021;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'A 不变量', severity: 'P1' }] });
  const slug1 = slugOf(pr);
  const r2 = recordConvergenceRound({
    pr, headRefOid: 'sha-2',
    findings: [{ invariant: 'a 不变量', severity: 'P1', recurrenceOfSlug: slug1 }], // 大小写不同但归一化后等于 slug1
  });
  assert.equal(r2.recurringFamilies[0].matchedBy, 'slug', 'recurrenceOfSlug 与自动算出的 slug 一致时不应虚报成 semantic');
});

test('D1/D3 核心:复发 finding 仍计入 p0p1Count,只从 newFamilyCount 里排除(跨模块回归:对 isReviewReceiptClean 零影响)', () => {
  const pr = 970004;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'Y', severity: 'P1' }] });
  const slug1 = slugOf(pr);
  recordConvergenceRound({
    pr, headRefOid: 'sha-2', findings: [{ invariant: 'Y', severity: 'P1', recurrenceOfSlug: slug1 }],
  });

  // 旧 head 的 clean 回执绝不能覆盖新 head(既有语义,P1-5 核心;本测试只是确认
  // convergence-state 的记录不会绕开或弱化这条判定)。
  writeReviewReceipt({ pr, headRefOid: 'sha-1', verdict: 'clean', p0p1Count: 0 });
  const receipt = readReviewReceipt(pr);
  assert.equal(isReviewReceiptClean({ receipt, headRefOid: 'sha-2' }), false, '旧 head 回执不能因为 convergence-state 记了复发就被追认成对新 head 也 clean');

  // 同一 head 的 dirty 回执(如实反映复发仍未清空 P0/P1)照常判不干净。
  writeReviewReceipt({ pr, headRefOid: 'sha-2', verdict: 'dirty', p0p1Count: 1 });
  const receipt2 = readReviewReceipt(pr);
  assert.equal(isReviewReceiptClean({ receipt: receipt2, headRefOid: 'sha-2' }), false);
});

test('D3 核心:recurrenceOfSlug 引用不存在的 slug → 机器拒绝(fail-closed,不当新家族静默通过)', () => {
  resetPr(970005);
  assert.throws(
    () => recordConvergenceRound({
      pr: 970005, headRefOid: 'sha-1', findings: [{ invariant: 'Z', severity: 'P0', recurrenceOfSlug: 'slug-doesnotexist' }],
    }),
    /recurrenceOfSlug=slug-doesnotexist 引用的历史在 state 中不存在/,
  );
  // 且这次失败的调用不应该产生任何持久化的半成品状态。
  assert.equal(readConvergenceState(970005).status, 'missing');
});

test('D3:recurrenceOfSlug 只能指向早于当前 head 的历史,不能"自证"同轮内刚创建的家族', () => {
  resetPr(970006);
  // 家族第一次出现就在本轮内声明 recurrenceOfSlug 指向一个刚刚(同轮同 head)才
  // 会创建的 slug —— 该 slug 此刻在 state 里还不存在,必须拒绝。
  assert.throws(
    () => recordConvergenceRound({
      pr: 970006,
      headRefOid: 'sha-1',
      findings: [
        { invariant: 'A', severity: 'P1' },
        { invariant: 'B完全不同', severity: 'P1', recurrenceOfSlug: invariantSlug('A') },
      ],
    }),
    /引用的历史在 state 中不存在/,
  );
});

// ── 同一轮内两条 finding 撞同一个 slug:不是跨轮复发,也不重复计新家族 ──

test('同轮 slug 撞车:两条 finding 归一化后落到同一 slug,只计一次新家族,第二条记 matchedBy=same-round,不进 recurringFamilies', () => {
  const pr = 970022;
  resetPr(pr);
  const r = recordConvergenceRound({
    pr, headRefOid: 'sha-1',
    findings: [
      { invariant: '全新问题A', severity: 'P1' },
      { invariant: '全新问题a', severity: 'P1' }, // 大小写不同,归一化后同一个 slug
    ],
  });
  assert.equal(r.p0p1Count, 2, '两条 finding 都要计入 p0p1Count');
  assert.equal(r.newFamilyCount, 1, '同一 slug 本轮只算一次新家族,不是两次');
  assert.deepEqual(r.recurringFamilies, [], '同轮撞车不是跨轮复发,不该出现在 recurringFamilies 里');

  const { state } = readConvergenceState(pr);
  const fams = Object.values(state.families);
  assert.equal(fams.length, 1);
  assert.equal(fams[0].occurrences.length, 2);
  assert.equal(fams[0].occurrences[0].matchedBy, null, '该家族第一条 occurrence 无"匹配"这件事');
  assert.equal(fams[0].occurrences[1].matchedBy, 'same-round');
});

// ── D4:roundCount 按去重 head 计,同 head 重跑覆盖而非新增轮次 ──

test('D4:同一 head 重复调用 → 覆盖旧记录,roundCount 不重复递增,家族 occurrence 不重复计入', () => {
  const pr = 970007;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'A', severity: 'P1' }] });
  const r1 = recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'A', severity: 'P1' }] });
  assert.equal(r1.roundCount, 1, '同一 head 第二次记录不应把轮数计成 2');

  const { state } = readConvergenceState(pr);
  assert.equal(state.heads.length, 1);
  const fams = Object.values(state.families);
  assert.equal(fams.length, 1, '重跑同一 head 不应留下两个几乎相同的家族');
  assert.equal(fams[0].occurrences.length, 1, '重跑同一 head 不应把 occurrence 重复叠加');
});

test('D4:覆盖同一 head 后若该家族只在这个 head 出现过,重跑不再提交该 finding 时应连家族一起摘除(不留空家族)', () => {
  const pr = 970008;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'A', severity: 'P1' }] });
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [] }); // 重跑时这条 finding 被判定不成立,不再提交
  const { state } = readConvergenceState(pr);
  assert.equal(Object.keys(state.families).length, 0, '不应残留 occurrences=[] 的空家族');
});

// ── 连续计数:清空重置;止损阈值边界(反向变异关注点:4 轮 false,第 5 轮才 true)──

test('连续计数:出现一轮 0 新家族(收敛)后重置为 0,不是跨轮累加不清零', () => {
  const pr = 970009;
  resetPr(pr);
  const r1 = recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'A', severity: 'P1' }] });
  assert.equal(r1.consecutiveRoundsWithNewFamilies, 1);
  const r2 = recordConvergenceRound({ pr, headRefOid: 'sha-2', findings: [] }); // 本轮 0 P0/P1,收敛
  assert.equal(r2.consecutiveRoundsWithNewFamilies, 0, '收敛的一轮必须把连续计数清零');
  const r3 = recordConvergenceRound({ pr, headRefOid: 'sha-3', findings: [{ invariant: 'B', severity: 'P0' }] });
  assert.equal(r3.consecutiveRoundsWithNewFamilies, 1, '清零后的新问题从 1 重新计,不延续清零前的历史值');
});

test('止损阈值边界:连续 4 轮新家族 checkpointRequired 仍为 false,第 5 轮起才 true(反向变异:>=5 误写成 >5 会让本测试的第二个断言失败)', () => {
  const pr = 970010;
  resetPr(pr);
  let last;
  for (let i = 1; i <= 4; i++) {
    last = recordConvergenceRound({ pr, headRefOid: `sha-${i}`, findings: [{ invariant: `inv-${i}`, severity: 'P1' }] });
  }
  assert.equal(last.consecutiveRoundsWithNewFamilies, 4);
  assert.equal(last.checkpointRequired, false, '第 4 轮不该触发检查点');

  const r5 = recordConvergenceRound({ pr, headRefOid: 'sha-5', findings: [{ invariant: 'inv-5', severity: 'P1' }] });
  assert.equal(r5.consecutiveRoundsWithNewFamilies, CONVERGENCE_CHECKPOINT_THRESHOLD);
  assert.equal(r5.checkpointRequired, true, '第 5 轮起必须触发检查点');
});

test('止损阈值边界:连续 9 轮 notification 为 null,第 10 轮起为非 null(反向变异同上,>=10 误写 >10 会让第二断言失败)', () => {
  const pr = 970011;
  resetPr(pr);
  let last;
  for (let i = 1; i <= 9; i++) {
    last = recordConvergenceRound({ pr, headRefOid: `sha-${i}`, findings: [{ invariant: `inv-${i}`, severity: 'P1' }] });
  }
  assert.equal(last.consecutiveRoundsWithNewFamilies, 9);
  assert.equal(last.notification, null, '第 9 轮不该触发红色通报');

  const r10 = recordConvergenceRound({ pr, headRefOid: 'sha-10', findings: [{ invariant: 'inv-10', severity: 'P1' }] });
  assert.equal(r10.consecutiveRoundsWithNewFamilies, CONVERGENCE_NOTIFY_THRESHOLD);
  assert.ok(r10.notification, '第 10 轮起必须触发红色通报');
  // 通知载荷必须是「reason/prNumber/head/detail」这种不绑定单一触发源的通用形状
  // (SC-C4 调查带出的要求:未来的"等待方缺席"触发源要能复用同一套投递+去重层,
  // 不能让通知层的入参形状只认得 roundCount/newFamilyCount 这一种触发源)。
  assert.equal(r10.notification.reason, CONVERGENCE_NOTIFY_REASON_ROUND);
  assert.equal(r10.notification.prNumber, pr);
  assert.equal(r10.notification.head, 'sha-10');
  assert.equal(r10.notification.thresholdKey, String(CONVERGENCE_NOTIFY_THRESHOLD));
  assert.equal(r10.notification.detail.consecutiveRoundsWithNewFamilies, CONVERGENCE_NOTIFY_THRESHOLD);
});

// ── 通知去重:按 reason+threshold+head,同 head 不重发,新 head 仍会重新触发 ──

test('通知去重⑤:同 head 标记已通知后 notification 变 null;新的仍未收敛的 head 重新触发(不是永久静音)', () => {
  const pr = 970012;
  resetPr(pr);
  let last;
  for (let i = 1; i <= 10; i++) {
    last = recordConvergenceRound({ pr, headRefOid: `sha-${i}`, findings: [{ invariant: `inv-${i}`, severity: 'P1' }] });
  }
  assert.ok(last.notification);
  const { reason, thresholdKey } = last.notification;
  assert.equal(hasNotified({ pr, reason, thresholdKey, headRefOid: 'sha-10' }), false);

  markNotified({ pr, reason, thresholdKey, headRefOid: 'sha-10' });
  assert.equal(hasNotified({ pr, reason, thresholdKey, headRefOid: 'sha-10' }), true);

  // 同 head 重跑(如 cron 重复触发审查、未推新 commit):不能重复要求通知。
  const replay = recordConvergenceRound({ pr, headRefOid: 'sha-10', findings: [{ invariant: 'inv-10', severity: 'P1' }] });
  assert.equal(replay.notification, null, '同一 head 已通知过,重放同一 head 不应再要求通知');

  // 新 head 仍未收敛:必须重新触发,不能因为"threshold 10 之前发过一次"就永久静音。
  const r11 = recordConvergenceRound({ pr, headRefOid: 'sha-11', findings: [{ invariant: 'inv-11', severity: 'P1' }] });
  assert.ok(r11.notification, '新 head 仍持续未收敛,应重新触发红色通报,不是"发过一次就永远不再发"');
});

test('通知去重:reason 进键——同一 head+threshold,不同 reason 各自独立去重,不会互相误吞(SC-C4 要求的核心)', () => {
  const pr = 970013;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [] });
  markNotified({ pr, reason: CONVERGENCE_NOTIFY_REASON_ROUND, thresholdKey: '10', headRefOid: 'sha-1' });

  // 假想的另一个触发源(如未来的"等待方缺席"),同一 head、同一档位字符串"10",
  // 但 reason 不同——不能因为 round 触发源已经标记过就被误判成"这个也发过了"。
  assert.equal(
    hasNotified({ pr, reason: 'reviewer-absent', thresholdKey: '10', headRefOid: 'sha-1' }),
    false,
    'reason 不同必须视为完全独立的去重记录,不能被 round 触发源的记录误吞',
  );
  assert.equal(hasNotified({ pr, reason: CONVERGENCE_NOTIFY_REASON_ROUND, thresholdKey: '10', headRefOid: 'sha-1' }), true);
});

test('markNotified 幂等:同一 head 标记两次不产生重复条目', () => {
  const pr = 970014;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [] });
  markNotified({ pr, reason: CONVERGENCE_NOTIFY_REASON_ROUND, thresholdKey: '10', headRefOid: 'sha-1' });
  const list = markNotified({ pr, reason: CONVERGENCE_NOTIFY_REASON_ROUND, thresholdKey: '10', headRefOid: 'sha-1' });
  assert.deepEqual(list, ['sha-1']);
});

test('markNotified 在 state 尚不存在(missing)时必须 throw,不能静默假装标记成功', () => {
  resetPr(970015);
  assert.throws(
    () => markNotified({ pr: 970015, reason: CONVERGENCE_NOTIFY_REASON_ROUND, thresholdKey: '10', headRefOid: 'sha-1' }),
    /应先调用 recordConvergenceRound/,
  );
});

test('hasNotified/markNotified 拒绝空 reason(通知投递层不允许在不知道触发源的情况下去重)', () => {
  resetPr(970016);
  recordConvergenceRound({ pr: 970016, headRefOid: 'sha-1', findings: [] });
  assert.throws(() => hasNotified({ pr: 970016, reason: '', thresholdKey: '10', headRefOid: 'sha-1' }), /reason/);
  assert.throws(() => markNotified({ pr: 970016, reason: '', thresholdKey: '10', headRefOid: 'sha-1' }), /reason/);
});

// ── seed:仅首次生效,老 PR 保守 seed 规则 ──

test('D4 seed:seedRoundCount 只在首次记录时生效,后续调用忽略(不会每轮重复叠加);且真的会推高首轮的连续计数,不是只记个审计字段', () => {
  const pr = 970017;
  resetPr(pr);
  const r1 = recordConvergenceRound({
    pr, headRefOid: 'sha-1', findings: [{ invariant: 'A', severity: 'P1' }], seedRoundCount: 3,
  });
  const { state: s1 } = readConvergenceState(pr);
  assert.deepEqual(s1.seed, { seedRoundCount: 3, seededAt: s1.seed.seededAt });
  assert.equal(
    r1.consecutiveRoundsWithNewFamilies, 4,
    'D4「保守 seed」必须真的推高首轮起点(seedRoundCount+1),否则老 PR 会被当成全新 PR,要多等 seedRoundCount 轮才追上真实进度——与"保守"的意图相反',
  );

  recordConvergenceRound({
    pr, headRefOid: 'sha-2', findings: [{ invariant: 'B', severity: 'P1' }], seedRoundCount: 999,
  });
  const { state: s2 } = readConvergenceState(pr);
  assert.equal(s2.seed.seedRoundCount, 3, '第二次调用传入的 seedRoundCount 必须被忽略,不能覆盖首次种下的值');
});

test('D4 seed:首轮若本身就是 0 新家族(收敛),不因为有 seed 就强行判定未收敛', () => {
  const pr = 970018;
  resetPr(pr);
  const r1 = recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [], seedRoundCount: 7 });
  assert.equal(r1.consecutiveRoundsWithNewFamilies, 0, '首轮本身干净时,不该因为 seed 存在就把连续计数抬高——seed 只影响"有新问题时从哪起跳",不能无中生有制造未收敛');
});

test('computeConservativeSeedRounds:纯函数,统计 CHANGES_REQUESTED,非数组/缺失一律 0(不编造)', () => {
  assert.equal(computeConservativeSeedRounds(null), 0);
  assert.equal(computeConservativeSeedRounds(undefined), 0);
  assert.equal(computeConservativeSeedRounds([]), 0);
  assert.equal(computeConservativeSeedRounds([{ state: 'APPROVED' }, { state: 'COMMENTED' }]), 0);
  assert.equal(
    computeConservativeSeedRounds([{ state: 'CHANGES_REQUESTED' }, { state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }]),
    2,
  );
});

// ── 输入校验 ──

test('输入校验:headRefOid 为空 / findings 非数组 / severity 非法 / invariant 缺失 / familyId 非法 均 throw', () => {
  resetPr(970019);
  assert.throws(() => recordConvergenceRound({ pr: 970019, headRefOid: '', findings: [] }), /headRefOid/);
  assert.throws(() => recordConvergenceRound({ pr: 970019, headRefOid: 'sha-1', findings: 'nope' }), /findings 必须是数组/);
  assert.throws(
    () => recordConvergenceRound({ pr: 970019, headRefOid: 'sha-1', findings: [{ invariant: 'A', severity: 'P2' }] }),
    /severity/,
  );
  assert.throws(
    () => recordConvergenceRound({ pr: 970019, headRefOid: 'sha-1', findings: [{ severity: 'P1' }] }),
    /invariant/,
  );
  assert.throws(
    () => recordConvergenceRound({ pr: 970019, headRefOid: 'sha-1', findings: [{ invariant: 'A', severity: 'P1', familyId: '' }] }),
    /familyId/,
  );
});

// ── 结构校验:畸形但合法 JSON 的文件必须判 corrupted,不能判 ok 或 missing ──

test('结构校验:合法 JSON 但缺关键字段(如 heads 不是数组)→ corrupted,不是 ok/missing', () => {
  const pr = 970020;
  resetPr(pr);
  const file = stateFile(`convergence-${pr}.json`);
  writeFileSync(file, JSON.stringify({ version: 2, heads: 'not-an-array', families: {}, notifiedThresholds: {}, seed: null, integrity: { status: 'ok' } }));
  const { status, error } = readConvergenceState(pr);
  assert.equal(status, 'corrupted');
  assert.match(error, /结构校验未通过/);
});

test('结构校验:version 字段不认识的将来格式 → corrupted(不假装能读懂未来版本;同样覆盖 v1→v2 的老状态文件迁移路径)', () => {
  const pr = 970023;
  resetPr(pr);
  const file = stateFile(`convergence-${pr}.json`);
  writeFileSync(file, JSON.stringify({ version: 99, heads: [], families: {}, notifiedThresholds: {}, seed: null, integrity: { status: 'ok' } }));
  assert.equal(readConvergenceState(pr).status, 'corrupted');

  // v1(family_id 版)文件即使字段形态凑巧齐全,version 已不匹配,必须按 corrupted
  // 处理(隔离重建),不能被新 schema 误读成合法 ok 状态。
  writeFileSync(file, JSON.stringify({
    version: 1, heads: [], families: {}, notifiedThresholds: {}, seed: null, integrity: { status: 'ok' },
  }));
  assert.equal(readConvergenceState(pr).status, 'corrupted');
});

// ── 损坏处置⑥:显式告警 + 隔离旧文件 + 强制触发检查点,不静默清零重来 ──

test('⑥ state 文件损坏:隔离旧文件(取证材料保留)+ 显式 integrityWarning + 强制 checkpointRequired=true', () => {
  const pr = 970101;
  resetPr(pr);
  const file = stateFile(`convergence-${pr}.json`);
  writeFileSync(file, '{ not valid json at all');

  const before = readdirSync(STATE_DIR).filter((f) => f.startsWith(`convergence-${pr}.json`));
  assert.deepEqual(before, [`convergence-${pr}.json`]);

  const r = recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'A', severity: 'P1' }] });
  assert.equal(r.checkpointRequired, true, '损坏恢复后的这一轮必须被视为已达检查点阈值,不能假装是干净的第 1 轮');
  assert.ok(r.integrityWarning && r.integrityWarning.includes('收敛状态文件损坏'), '必须显式告警,不能吞掉损坏信号');

  const after = readdirSync(STATE_DIR).filter((f) => f.startsWith(`convergence-${pr}.json`));
  assert.equal(after.length, 2, '损坏的旧文件应被隔离保留(rename),不是直接覆盖删除');
  const quarantined = after.find((f) => f !== `convergence-${pr}.json`);
  assert.match(quarantined, /\.corrupted-.*\.json$/);
  const quarantinedContent = readFileSync(join(STATE_DIR, quarantined), 'utf8');
  assert.equal(quarantinedContent, '{ not valid json at all', '隔离文件必须保留损坏时的原始内容,供人工核查');

  const { state } = readConvergenceState(pr);
  assert.equal(state.integrity.status, 'recovered-from-corruption');
  assert.equal(state.integrity.quarantinedFile, join(STATE_DIR, quarantined));
});

// ── ④ runs.jsonl 损坏与本模块完全隔离(两份不同文件,互不影响)──

test('④ runs.jsonl 审计链损坏不影响收敛状态的权威性(两者是完全独立的文件)', () => {
  // 本测试会真的写坏这台机器上共享的 runs.jsonl(同 lib.review-receipt.test.mjs
  // 对 STATE_DIR 的既有用法——不隔离到临时目录)。用 try/finally 还原,保证中途
  // 任何断言失败都不会把这份共享审计日志永久留在损坏状态给其它测试/真实审查
  // 用户添麻烦。
  const runsFile = stateFile('runs.jsonl');
  const before = existsSync(runsFile) ? readFileSync(runsFile, 'utf8') : null;
  try {
    writeFileSync(runsFile, 'this is not jsonl at all\n{{{garbage\n');

    const pr = 970201;
    resetPr(pr);
    const r1 = recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'A', severity: 'P1' }] });
    const slug1 = slugOf(pr);
    const r2 = recordConvergenceRound({
      pr, headRefOid: 'sha-2', findings: [{ invariant: 'A', severity: 'P1', recurrenceOfSlug: slug1 }],
    });

    assert.equal(r1.newFamilyCount, 1);
    assert.equal(r2.newFamilyCount, 0);
    assert.equal(r2.recurringFamilies.length, 1);
    assert.equal(readConvergenceState(pr).status, 'ok', 'runs.jsonl 损坏绝不能让 convergence state 也被判 corrupted');

    // 收敛状态的写入同样不应反过来"修复"或改动 runs.jsonl 的损坏内容——两份状态
    // 物理隔离,谁也不该覆盖谁。
    const runsAfter = readFileSync(runsFile, 'utf8');
    assert.equal(runsAfter, 'this is not jsonl at all\n{{{garbage\n');
  } finally {
    if (before !== null) writeFileSync(runsFile, before);
    else if (existsSync(runsFile)) unlinkSync(runsFile);
  }
});

// ── CLI 端到端 ──

function runCli(args, stdin = '') {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', input: stdin });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非 JSON 输出交给调用方按 stderr/status 断言 */ }
  return { json, stdout: r.stdout, stderr: r.stderr, status: r.status };
}

test('CLI:record → get → mark-notified 全链路', () => {
  const pr = 970301;
  resetPr(pr);
  const rec = runCli(
    [String(pr), '--head', 'sha-1'],
    JSON.stringify([{ invariant: 'A', severity: 'P0', description: 'x.js:1' }]),
  );
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(rec.json.ok, true);
  assert.equal(rec.json.newFamilyCount, 1);

  const got = runCli([String(pr), '--get']);
  assert.equal(got.status, 0);
  assert.equal(got.json.status, 'ok');
  assert.equal(Object.keys(got.json.state.families).length, 1);

  const marked = runCli([
    String(pr), '--mark-notified', '--reason', CONVERGENCE_NOTIFY_REASON_ROUND, '--threshold', '10', '--head', 'sha-1',
  ]);
  assert.equal(marked.status, 0, marked.stderr);
  assert.deepEqual(marked.json.notifiedHeads, ['sha-1']);
});

test('CLI:第二轮换个说法自动一级命中复发(端到端验证 slug 归一化真的在 CLI 路径生效)', () => {
  const pr = 970306;
  resetPr(pr);
  runCli(
    [String(pr), '--head', 'sha-1'],
    JSON.stringify([{ invariant: '缺少边界检查', severity: 'P1' }]),
  );
  const rec2 = runCli(
    [String(pr), '--head', 'sha-2'],
    JSON.stringify([{ invariant: '缺少  边界检查', severity: 'P1' }]), // 空白不同
  );
  assert.equal(rec2.status, 0, rec2.stderr);
  assert.equal(rec2.json.newFamilyCount, 0);
  assert.equal(rec2.json.recurringFamilies[0].matchedBy, 'slug');
});

test('CLI:空 findings 数组(收敛信号)合法,退出码 0', () => {
  const pr = 970302;
  resetPr(pr);
  const r = runCli([String(pr), '--head', 'sha-1'], '[]');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.p0p1Count, 0);
  assert.equal(r.json.newFamilyCount, 0);
});

test('CLI:stdin 非合法 JSON → 退出码 1,不静默吞掉', () => {
  const pr = 970303;
  resetPr(pr);
  const r = runCli([String(pr), '--head', 'sha-1'], 'not json');
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
});

test('CLI:缺 --head → 退出码 1', () => {
  const pr = 970304;
  resetPr(pr);
  const r = runCli([String(pr)], '[]');
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
});

test('CLI:--mark-notified 缺 --reason/--threshold/--head → 退出码 1', () => {
  const pr = 970305;
  resetPr(pr);
  const r1 = runCli([String(pr), '--mark-notified', '--threshold', '10', '--head', 'sha-1']);
  assert.equal(r1.status, 1, 'reason 必填,不能有默认值');
  const r2 = runCli([String(pr), '--mark-notified', '--reason', CONVERGENCE_NOTIFY_REASON_ROUND, '--head', 'sha-1']);
  assert.equal(r2.status, 1);
  const r3 = runCli([String(pr), '--mark-notified', '--reason', CONVERGENCE_NOTIFY_REASON_ROUND, '--threshold', '10']);
  assert.equal(r3.status, 1);
});
