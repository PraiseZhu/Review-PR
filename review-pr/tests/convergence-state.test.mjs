// convergence-state.test.mjs — SC-C2(同族复发判定)+ SC-C3(收敛止损)单测。
//
// PR 号命名空间:970001-970099 单元级(家族/复发/覆盖/连续计数/阈值/两级检测),
// 970100-970199 损坏与隔离,970200-970299 与 review-receipt / runs.jsonl 的
// 跨模块独立性回归,970300+ CLI 端到端,970400+ D3(persistent/reopened),
// 970500+ D4(通知失败不 mark + attempt 记账)。与其它测试文件(900000/920000/
// 930000 段)及真实 PR 号不重叠——但**仍需**在每个测试开头调用 `resetPr()` 清掉
// 上一次真实运行遗留的状态文件:STATE_DIR 是这台机器上持久的真实目录(同
// lib.review-receipt.test.mjs 的既有做法),receipt 类测试天然幂等(单对象
// last-write-wins,重跑收敛到同一结果),但本文件的测试会跨多个 head 累积家族
// 历史,不是简单覆盖就能收敛回同一状态——重跑必须先清空,否则会把上一次运行
// 遗留的家族/occurrence 也算进本次断言,得到误报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readConvergenceState, recordConvergenceRound, hasNotified, markNotified, recordNotificationAttempt,
  computeConservativeSeedRounds,
  CONVERGENCE_CHECKPOINT_THRESHOLD, CONVERGENCE_NOTIFY_THRESHOLD, CONVERGENCE_NOTIFY_REASON_ROUND,
} from '../scripts/convergence-state.mjs';
import { STATE_DIR, stateFile, writeReviewReceipt, readReviewReceipt, isReviewReceiptClean } from '../scripts/lib.mjs';
// invariantKey 是 rp-output 侧的只读依赖(见 convergence-state.mjs 文件头
// 「跨轮 join key」说明),这里 import 它只是为了让测试断言用同一份真实算法构造
// fixture(如"这两个字符串归一化后应该相等/不相等"),不测它自己的行为——那是
// lib.invariant-key.test.mjs 的范围,不重复覆盖。
import { invariantKey } from '../scripts/lib.review-output-shape.mjs';

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

function keyOf(pr) {
  const { state } = readConvergenceState(pr);
  const keys = Object.keys(state.families);
  assert.equal(keys.length, 1, `期望恰好一个家族,实际 ${keys.length}`);
  return keys[0];
}

// F5A(2026-08-02 对抗审 finding 5A):上一版断言只匹配宽泛的 /invariant/。对抗审把生产
// 前置校验退回裸 `=== ''`,预测本条必红,实跑**全门仍 248/248 绿**——因为下游
// `invariantKey` 抛的 TypeError 信息里恰好也含 "invariant",顶替了被撤掉的接线守卫。
// 断言太宽 = 测试在证明"某处抛了个提到 invariant 的错",不是"这道守卫在工作"。
// 现在钉住守卫自己的可辨认信息(非空字符串 + 点名 invariant),撤掉守卫必红。
test('输入校验:invariant 为纯空白字符串(trim 后为空)同样 throw,不能靠裸 === "" 放过', () => {
  resetPr(970024);
  assert.throws(
    () => recordConvergenceRound({ pr: 970024, headRefOid: 'sha-1', findings: [{ invariant: '   ', severity: 'P1' }] }),
    // 这是**前置守卫自己**的信息(convergence-state 的接线层)。下游 invariantKey 抛的是
    // 「invariantKey: invariant 必须是非空字符串」——两句都含 "invariant",宽松的
    // /invariant/ 因此分不清是谁抛的,守卫被撤掉也照样绿。这里钉死前者。
    /finding 缺少非空的 invariant 字段/,
  );
});

// ── D1(gpt 阻断复现):截断 slug 曾把两条前 64 字符相同、尾部不同的 invariant 误判
// 成同一 family;invariantKey 用完整 hash,不该再发生 ──

test('D1 阻断复现:前 64 字符相同、尾部完全不同的两条 invariant 跨轮不再被误判复发', () => {
  const pr = 970025;
  resetPr(pr);
  const base = 'a'.repeat(64);
  const r1 = recordConvergenceRound({
    pr, headRefOid: 'sha-1', findings: [{ invariant: `${base}前半相同后面不同一二三四五六七八九十`, severity: 'P0' }],
  });
  const r2 = recordConvergenceRound({
    pr, headRefOid: 'sha-2', findings: [{ invariant: `${base}前半相同后面不同壹贰叄肆伍陆柒捌玖拾`, severity: 'P0' }],
  });
  assert.equal(r1.newFamilyCount, 1);
  assert.equal(
    r2.newFamilyCount, 1,
    '两条真正不同的 invariant(仅前 64 字符相同)必须都算新家族——旧版用截断 slug 会在这里错判成复发(newFamilyCount 从 1 错成 0)',
  );
  assert.deepEqual(r2.recurringFamilies, [], '不应该有任何"复发"记录——这两条压根不是同一个问题');
  const { state } = readConvergenceState(pr);
  assert.equal(Object.keys(state.families).length, 2, '必须是两个独立家族,不是被截断 join key 误合并成一个');
});

// ── 定案 3·一级检测(确定性):key 自动命中,不需要调用方声明 ──

test('一级检测:同一不变量换个大小写/空白写法,不传 recurrenceOfKey 也能自动判定复发(相邻 head,无中间干净 head → persistent)', () => {
  const pr = 970002;
  resetPr(pr);
  recordConvergenceRound({
    pr, headRefOid: 'sha-1', findings: [{ invariant: 'X 未处理并发写入', severity: 'P0', description: 'b.js:5' }],
  });

  const r2 = recordConvergenceRound({
    pr, headRefOid: 'sha-2',
    findings: [{ invariant: 'x  未处理并发写入', severity: 'P0', description: 'b.js:9' }], // 大小写+空白不同,未声明 recurrenceOfKey
  });
  assert.equal(r2.p0p1Count, 1, 'D1:复发 finding 仍要计入本轮 p0p1Count');
  assert.equal(r2.newFamilyCount, 0, '一级命中不应贡献新家族数');
  assert.equal(r2.recurringFamilies.length, 1);
  assert.equal(r2.recurringFamilies[0].matchedBy, 'key', '未声明 recurrenceOfKey 时,命中必须来自一级自动检测');
  assert.equal(r2.recurringFamilies[0].priorHead, 'sha-1');
  assert.equal(r2.recurringFamilies[0].priorDescription, 'b.js:5');
  assert.equal(r2.recurringFamilies[0].recurrenceType, 'persistent', 'D3:相邻两轮、中间没有任何已审 head,从未真的消失过,必须是 persistent 不是 reopened');
});

// ── 定案 3·二级检测(T1 兜底):换了完全不同的说法,靠显式 recurrenceOfKey ──

test('二级检测:完全不同的措辞,一级 key 不会命中,必须靠显式 recurrenceOfKey(matchedBy=semantic)', () => {
  const pr = 970003;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: '未处理并发写入竞态', severity: 'P0' }] });
  const key1 = keyOf(pr);
  assert.notEqual(invariantKey('写锁未生效导致数据竞争'), key1, '措辞完全不同,一级归一化不应偶然撞上同一 key(否则本测试没测到二级路径)');

  const r2 = recordConvergenceRound({
    pr, headRefOid: 'sha-2',
    findings: [{ invariant: '写锁未生效导致数据竞争', severity: 'P0', recurrenceOfKey: key1 }],
  });
  assert.equal(r2.newFamilyCount, 0);
  assert.equal(r2.recurringFamilies.length, 1);
  assert.equal(r2.recurringFamilies[0].matchedBy, 'semantic', '一级不命中、靠显式引用命中的必须标 semantic,不能标 key');
  assert.equal(r2.recurringFamilies[0].key, key1);
  assert.equal(r2.recurringFamilies[0].priorHead, 'sha-1');
});

test('二级检测:显式 recurrenceOfKey 恰好等于一级自动算出的 key 时,按更简单可解释的 key 记录,不虚报 semantic', () => {
  const pr = 970021;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'A 不变量', severity: 'P1' }] });
  const key1 = keyOf(pr);
  const r2 = recordConvergenceRound({
    pr, headRefOid: 'sha-2',
    findings: [{ invariant: 'a 不变量', severity: 'P1', recurrenceOfKey: key1 }], // 大小写不同但归一化后等于 key1
  });
  assert.equal(r2.recurringFamilies[0].matchedBy, 'key', 'recurrenceOfKey 与自动算出的 key 一致时不应虚报成 semantic');
});

test('D1/D3 核心:复发 finding 仍计入 p0p1Count,只从 newFamilyCount 里排除(跨模块回归:对 isReviewReceiptClean 零影响)', () => {
  const pr = 970004;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: 'Y', severity: 'P1' }] });
  const key1 = keyOf(pr);
  recordConvergenceRound({
    pr, headRefOid: 'sha-2', findings: [{ invariant: 'Y', severity: 'P1', recurrenceOfKey: key1 }],
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

test('D3 核心:recurrenceOfKey 引用不存在的 key → 机器拒绝(fail-closed,不当新家族静默通过)', () => {
  resetPr(970005);
  assert.throws(
    () => recordConvergenceRound({
      pr: 970005, headRefOid: 'sha-1', findings: [{ invariant: 'Z', severity: 'P0', recurrenceOfKey: 'key-doesnotexist' }],
    }),
    /recurrenceOfKey=key-doesnotexist 引用的历史在 state 中不存在/,
  );
  // 且这次失败的调用不应该产生任何持久化的半成品状态。
  assert.equal(readConvergenceState(970005).status, 'missing');
});

test('D3:recurrenceOfKey 只能指向早于当前 head 的历史,不能"自证"同轮内刚创建的家族', () => {
  resetPr(970006);
  // 家族第一次出现就在本轮内声明 recurrenceOfKey 指向一个刚刚(同轮同 head)才
  // 会创建的 key —— 该 key 此刻在 state 里还不存在,必须拒绝。
  assert.throws(
    () => recordConvergenceRound({
      pr: 970006,
      headRefOid: 'sha-1',
      findings: [
        { invariant: 'A', severity: 'P1' },
        { invariant: 'B完全不同', severity: 'P1', recurrenceOfKey: invariantKey('A') },
      ],
    }),
    /引用的历史在 state 中不存在/,
  );
});

// ── 同一轮内两条 finding 撞同一个 key:不是跨轮复发,也不重复计新家族 ──

test('同轮 key 撞车:两条 finding 归一化后落到同一 key,只计一次新家族,第二条记 matchedBy=same-round/recurrenceType=null,不进 recurringFamilies', () => {
  const pr = 970022;
  resetPr(pr);
  const r = recordConvergenceRound({
    pr, headRefOid: 'sha-1',
    findings: [
      { invariant: '全新问题A', severity: 'P1' },
      { invariant: '全新问题a', severity: 'P1' }, // 大小写不同,归一化后同一个 key
    ],
  });
  assert.equal(r.p0p1Count, 2, '两条 finding 都要计入 p0p1Count');
  assert.equal(r.newFamilyCount, 1, '同一 key 本轮只算一次新家族,不是两次');
  assert.deepEqual(r.recurringFamilies, [], '同轮撞车不是跨轮复发,不该出现在 recurringFamilies 里');

  const { state } = readConvergenceState(pr);
  const fams = Object.values(state.families);
  assert.equal(fams.length, 1);
  assert.equal(fams[0].occurrences.length, 2);
  assert.equal(fams[0].occurrences[0].matchedBy, null, '该家族第一条 occurrence 无"匹配"这件事');
  assert.equal(fams[0].occurrences[0].recurrenceType, null);
  assert.equal(fams[0].occurrences[1].matchedBy, 'same-round');
  assert.equal(fams[0].occurrences[1].recurrenceType, null, '同轮撞车不是跨轮复发,不应该有 reopened/persistent 之分');
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

// ── D4 阻断修正:通知失败不 mark;attempt 记账与去重判定完全独立 ──

test('D4:投递失败(不调 markNotified)→ hasNotified 仍为 false → 下一轮同 head 重放依然判需要通知(不会被误静音)', () => {
  const pr = 970501;
  resetPr(pr);
  let last;
  for (let i = 1; i <= 10; i++) {
    last = recordConvergenceRound({ pr, headRefOid: `sha-${i}`, findings: [{ invariant: `inv-${i}`, severity: 'P1' }] });
  }
  assert.ok(last.notification, '第 10 轮应判定需要通知');
  const { reason, thresholdKey } = last.notification;
  // 模拟投递失败:只记一次 attempt,不调 markNotified。
  recordNotificationAttempt({ pr, reason, thresholdKey, headRefOid: 'sha-10' });
  assert.equal(hasNotified({ pr, reason, thresholdKey, headRefOid: 'sha-10' }), false, '失败路径绝不能 mark,否则这个 head 会被永久静音');

  // 同一 head 重放(如同一轮审查因某种原因重新跑一次):notification 必须仍非
  // null——失败没有被误 mark 成"已经发过"。
  const replay = recordConvergenceRound({ pr, headRefOid: 'sha-10', findings: [{ invariant: 'inv-10', severity: 'P1' }] });
  assert.ok(replay.notification, '投递失败后重放同一 head,必须仍然判定需要通知,不能被失败尝试误静音');
});

test('D4:投递成功(调 markNotified)→ hasNotified 变 true → 同 head 重放不再判需要通知', () => {
  const pr = 970502;
  resetPr(pr);
  let last;
  for (let i = 1; i <= 10; i++) {
    last = recordConvergenceRound({ pr, headRefOid: `sha-${i}`, findings: [{ invariant: `inv-${i}`, severity: 'P1' }] });
  }
  const { reason, thresholdKey } = last.notification;
  recordNotificationAttempt({ pr, reason, thresholdKey, headRefOid: 'sha-10' });
  markNotified({ pr, reason, thresholdKey, headRefOid: 'sha-10' });
  assert.equal(hasNotified({ pr, reason, thresholdKey, headRefOid: 'sha-10' }), true);

  const replay = recordConvergenceRound({ pr, headRefOid: 'sha-10', findings: [{ invariant: 'inv-10', severity: 'P1' }] });
  assert.equal(replay.notification, null, '投递成功已 mark,重放同一 head 不应再要求通知');
});

test('D4:recordNotificationAttempt 计数递增 + lastAttemptAt 更新,与 markNotified/hasNotified 完全独立(不影响去重判定)', () => {
  const pr = 970503;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [] });
  const a1 = recordNotificationAttempt({
    pr, reason: CONVERGENCE_NOTIFY_REASON_ROUND, thresholdKey: '10', headRefOid: 'sha-1',
  });
  assert.equal(a1.count, 1);
  assert.equal(typeof a1.lastAttemptAt, 'string');

  const a2 = recordNotificationAttempt({
    pr, reason: CONVERGENCE_NOTIFY_REASON_ROUND, thresholdKey: '10', headRefOid: 'sha-1',
  });
  assert.equal(a2.count, 2, '同一 head 多次尝试应累加计数,不是每次重置成 1');

  // 记了两次 attempt,但从未调 markNotified——去重判定不受影响,仍是"没发过"。
  assert.equal(hasNotified({ pr, reason: CONVERGENCE_NOTIFY_REASON_ROUND, thresholdKey: '10', headRefOid: 'sha-1' }), false);

  const { state } = readConvergenceState(pr);
  assert.equal(state.notifiedThresholds[CONVERGENCE_NOTIFY_REASON_ROUND]?.['10'], undefined, 'attempt 不应写进 notifiedThresholds');
  assert.equal(state.notificationAttempts[CONVERGENCE_NOTIFY_REASON_ROUND]['10']['sha-1'].count, 2);
});

test('recordNotificationAttempt 要求已存在有效收敛状态,missing 时必须 throw', () => {
  resetPr(970504);
  assert.throws(
    () => recordNotificationAttempt({ pr: 970504, reason: CONVERGENCE_NOTIFY_REASON_ROUND, thresholdKey: '10', headRefOid: 'sha-1' }),
    /应先调用 recordConvergenceRound/,
  );
});

// ── D3:persistent vs reopened ──

test('D3:相邻 head 持续未修 → persistent,不触发升级文案("已收敛"的说法)', () => {
  const pr = 970401;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: '未处理并发写入', severity: 'P0' }] });
  const r2 = recordConvergenceRound({ pr, headRefOid: 'sha-2', findings: [{ invariant: '未处理并发写入', severity: 'P0' }] });
  assert.equal(r2.recurringFamilies[0].recurrenceType, 'persistent');
  // 仍是 D1 的安全红线:persistent 不改变任何合并判定口径。
  assert.equal(r2.p0p1Count, 1);
  assert.equal(r2.newFamilyCount, 0);
});

test('D3:中间存在至少一个已审、且不含该 family 的 head → reopened,可以说"上一轮已收敛"', () => {
  const pr = 970402;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: '未处理并发写入', severity: 'P0' }] });
  recordConvergenceRound({ pr, headRefOid: 'sha-2', findings: [] }); // 中间这一轮真的干净,已审记录在案
  const r3 = recordConvergenceRound({ pr, headRefOid: 'sha-3', findings: [{ invariant: '未处理并发写入', severity: 'P0' }] });
  assert.equal(r3.recurringFamilies[0].recurrenceType, 'reopened');
});

test('D3:中间已审 head 仍带着该 family(没有真的消失过)→ 依然 persistent,不能因为"隔了一轮"就判 reopened', () => {
  const pr = 970403;
  resetPr(pr);
  recordConvergenceRound({
    pr, headRefOid: 'sha-1', findings: [{ invariant: '未处理并发写入', severity: 'P0' }, { invariant: '缺少边界检查', severity: 'P1' }],
  });
  // 中间这一轮:另一条 finding 变化了,但"未处理并发写入"这个 family 仍然在,
  // 从未真的消失过。
  recordConvergenceRound({ pr, headRefOid: 'sha-2', findings: [{ invariant: '未处理并发写入', severity: 'P0' }] });
  const r3 = recordConvergenceRound({ pr, headRefOid: 'sha-3', findings: [{ invariant: '未处理并发写入', severity: 'P0' }] });
  assert.equal(r3.recurringFamilies[0].recurrenceType, 'persistent', '中间已审 head 从未证明它消失过,不能判 reopened');
});

test('D3 边界:中间 head 被 cron 跳过(从未记录,不是"干净")→ 没有证据 → fail 向 persistent,不能谎称已收敛', () => {
  const pr = 970404;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: '未处理并发写入', severity: 'P0' }] });
  // sha-2 从未被调用(cron 跳过、或该轮审查压根没跑)——state.heads 里不存在这个
  // head,不能被当成"干净的中间 head"。
  const r3 = recordConvergenceRound({ pr, headRefOid: 'sha-3', findings: [{ invariant: '未处理并发写入', severity: 'P0' }] });
  assert.equal(
    r3.recurringFamilies[0].recurrenceType, 'persistent',
    '缺审的 head 不提供任何"干净"证据,找不到证据时必须 fail 向 persistent,不能谎称"上一轮已收敛"',
  );
});

test('D3(反向变异关注点):二级语义命中同样要走分类,不是只有一级才分类', () => {
  const pr = 970405;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'sha-1', findings: [{ invariant: '未处理并发写入竞态', severity: 'P0' }] });
  recordConvergenceRound({ pr, headRefOid: 'sha-2', findings: [] }); // 干净的中间 head
  const key1 = keyOf(pr);
  const r3 = recordConvergenceRound({
    pr, headRefOid: 'sha-3',
    findings: [{ invariant: '写锁未生效导致数据竞争', severity: 'P0', recurrenceOfKey: key1 }],
  });
  assert.equal(r3.recurringFamilies[0].matchedBy, 'semantic');
  assert.equal(r3.recurringFamilies[0].recurrenceType, 'reopened', '二级命中同样要经过 D3 分类,不能只有一级才分类');
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
  writeFileSync(file, JSON.stringify({
    version: 3, heads: 'not-an-array', families: {}, notifiedThresholds: {}, notificationAttempts: {}, seed: null, integrity: { status: 'ok' },
  }));
  const { status, error } = readConvergenceState(pr);
  assert.equal(status, 'corrupted');
  assert.match(error, /结构校验未通过/);
});

test('结构校验:version 字段不认识的将来格式 → corrupted(不假装能读懂未来版本;同样覆盖 v1/v2→v3 的老状态文件拒绝路径)', () => {
  const pr = 970023;
  resetPr(pr);
  const file = stateFile(`convergence-${pr}.json`);
  writeFileSync(file, JSON.stringify({
    version: 99, heads: [], families: {}, notifiedThresholds: {}, notificationAttempts: {}, seed: null, integrity: { status: 'ok' },
  }));
  assert.equal(readConvergenceState(pr).status, 'corrupted');

  // v1(family_id 版)、v2(截断 slug 版)文件即使字段形态凑巧齐全,version 已不
  // 匹配,必须按 corrupted 处理(隔离重建),不能被新 schema 误读成合法 ok 状态。
  for (const oldVersion of [1, 2]) {
    writeFileSync(file, JSON.stringify({
      version: oldVersion, heads: [], families: {}, notifiedThresholds: {}, seed: null, integrity: { status: 'ok' },
    }));
    assert.equal(readConvergenceState(pr).status, 'corrupted', `version=${oldVersion} 的老文件必须被拒绝`);
  }
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
    const key1 = keyOf(pr);
    const r2 = recordConvergenceRound({
      pr, headRefOid: 'sha-2', findings: [{ invariant: 'A', severity: 'P1', recurrenceOfKey: key1 }],
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

function runCli(args, stdin) {
  const opts = { encoding: 'utf8' };
  if (stdin !== undefined) opts.input = stdin;
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], opts);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非 JSON 输出交给调用方按 stderr/status 断言 */ }
  return { json, stdout: r.stdout, stderr: r.stderr, status: r.status };
}

test('CLI:record → get → mark-notified → record-attempt 全链路', () => {
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

  const attempt = runCli([
    String(pr), '--record-attempt', '--reason', CONVERGENCE_NOTIFY_REASON_ROUND, '--threshold', '10', '--head', 'sha-1',
  ]);
  assert.equal(attempt.status, 0, attempt.stderr);
  assert.equal(attempt.json.attempt.count, 1);
});

test('CLI:第二轮换个说法自动一级命中复发(端到端验证 invariantKey 归一化真的在 CLI 路径生效)', () => {
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
  assert.equal(rec2.json.recurringFamilies[0].matchedBy, 'key');
});

test('CLI:空 findings 数组(显式收敛信号)合法,退出码 0', () => {
  const pr = 970302;
  resetPr(pr);
  const r = runCli([String(pr), '--head', 'sha-1'], '[]');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.p0p1Count, 0);
  assert.equal(r.json.newFamilyCount, 0);
});

// ── D2 阻断修正:空/纯空白 stdin 必须报错,不能被当成显式 [] ──

test('D2:完全不传 stdin(TTY 场景,无 pipe)→ 退出码 1,不落盘', () => {
  const pr = 970307;
  resetPr(pr);
  const file = stateFile(`convergence-${pr}.json`);
  const r = runCli([String(pr), '--head', 'sha-1']); // 不传 stdin 参数,opts 不带 input
  assert.equal(r.status, 1, '缺少显式 stdin 必须报错,不能静默当成 []');
  assert.ok(r.json.error && /stdin/.test(r.json.error), 'error 里应说明缺 stdin');
  assert.equal(existsSync(file), false, '报错路径绝不能落盘,state 字节必须保持不存在');
});

test('D2:stdin 为空字符串 → 退出码 1,状态文件字节不变', () => {
  const pr = 970308;
  resetPr(pr);
  // 先记一轮真实数据,取到落盘后的字节内容作为"不变"的基线。
  runCli([String(pr), '--head', 'sha-1'], JSON.stringify([{ invariant: 'A', severity: 'P1' }]));
  const file = stateFile(`convergence-${pr}.json`);
  const before = readFileSync(file, 'utf8');

  const r = runCli([String(pr), '--head', 'sha-2'], '');
  assert.equal(r.status, 1, '空字符串 stdin 必须报错,不能被 `raw || \'[]\'` 那种写法悄悄当成显式 []');
  assert.ok(r.json.error && /stdin/.test(r.json.error));

  const after = readFileSync(file, 'utf8');
  assert.equal(after, before, 'state 文件必须一个字节都不变——这次调用应该在写入之前就已经失败退出');
});

test('D2:stdin 为纯空白(空格/换行)→ 退出码 1,状态文件字节不变', () => {
  const pr = 970309;
  resetPr(pr);
  runCli([String(pr), '--head', 'sha-1'], JSON.stringify([{ invariant: 'A', severity: 'P1' }]));
  const file = stateFile(`convergence-${pr}.json`);
  const before = readFileSync(file, 'utf8');

  for (const whitespaceOnly of ['   ', '\n\n', '  \t \n ']) {
    const r = runCli([String(pr), '--head', 'sha-2'], whitespaceOnly);
    assert.equal(r.status, 1, `纯空白 stdin(${JSON.stringify(whitespaceOnly)})必须报错`);
  }
  const after = readFileSync(file, 'utf8');
  assert.equal(after, before, '纯空白 stdin 的失败尝试不应改动 state 文件');
});

test('D2:显式传 "[]" 仍然合法(与"空/纯空白必须报错"是两回事,不能矫枉过正把显式空数组也拦掉)', () => {
  const pr = 970310;
  resetPr(pr);
  const r = runCli([String(pr), '--head', 'sha-1'], '[]');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.newFamilyCount, 0);
});

test('CLI:stdin 非合法 JSON(非空但解析失败)→ 退出码 1,不静默吞掉', () => {
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

test('CLI:--record-attempt 缺 --reason/--threshold/--head → 退出码 1', () => {
  const pr = 970311;
  resetPr(pr);
  const r1 = runCli([String(pr), '--record-attempt', '--threshold', '10', '--head', 'sha-1']);
  assert.equal(r1.status, 1);
  const r2 = runCli([String(pr), '--record-attempt', '--reason', CONVERGENCE_NOTIFY_REASON_ROUND, '--head', 'sha-1']);
  assert.equal(r2.status, 1);
  const r3 = runCli([String(pr), '--record-attempt', '--reason', CONVERGENCE_NOTIFY_REASON_ROUND, '--threshold', '10']);
  assert.equal(r3.status, 1);
});

// ============ 2026-08-02 对抗审 finding 2/3/4 回归 ============

test('F2:一级 key 已命中历史时,矛盾的二级 recurrenceOfKey 必须 fail-closed 抛错(不静默劫持到别的族)', () => {
  const pr = 970601;
  resetPr(pr);
  // h1 同时记录 A / B 两族
  recordConvergenceRound({
    pr, headRefOid: 'f2-h1',
    findings: [{ invariant: 'family A', severity: 'P1' }, { invariant: 'family B', severity: 'P1' }],
  });
  const keyB = invariantKey('family B');
  // h2 声称「这条是 family A」同时又声称「它是 keyB 的复发」——两句话互相矛盾
  assert.throws(
    () => recordConvergenceRound({
      pr, headRefOid: 'f2-h2',
      findings: [{ invariant: 'family A', severity: 'P1', recurrenceOfKey: keyB }],
    }),
    /一级确定性命中优先于二级语义声明/,
    '一级已命中 A 时不得被二级声明劫持到 B',
  );
  // 抛错后 state 不得被写坏:A 仍然只有 h1 那一条,没有多出 h2 的 occurrence
  const { state } = readConvergenceState(pr);
  const famA = state.families[invariantKey('family A')];
  assert.deepEqual(famA.occurrences.map((o) => o.headRefOid), ['f2-h1'], 'A 的 occurrence 不应因失败调用而变化');
});

test('F2:一级 key 未命中时,二级 recurrenceOfKey 照常介入(修 finding 2 不得误伤二级本职)', () => {
  const pr = 970602;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'f2b-h1', findings: [{ invariant: 'family A', severity: 'P1' }] });
  const keyA = invariantKey('family A');
  // 换了个说法(一级算出的 key 不命中),显式声明是 A 的复发 → 应被接受并记 semantic
  const r = recordConvergenceRound({
    pr, headRefOid: 'f2b-h2',
    findings: [{ invariant: 'family A 换个说法完全不同的文本', severity: 'P1', recurrenceOfKey: keyA }],
  });
  assert.equal(r.newFamilyCount, 0, '二级命中不算新 family');
  const { state } = readConvergenceState(pr);
  const last = state.families[keyA].occurrences.at(-1);
  assert.equal(last.matchedBy, 'semantic', '一级未命中 + 显式声明 → matchedBy=semantic');
});

test('F3:损坏隔离后即便本轮后续抛错,下一次也不得被当成真首轮(强制检查点信号不丢)', () => {
  const pr = 970603;
  resetPr(pr);
  const file = stateFile(`convergence-${pr}.json`);
  writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
  // 第一次:检测到损坏 → 隔离 + 重建,但 findings 带不存在的 recurrenceOfKey → 后续抛错
  assert.throws(
    () => recordConvergenceRound({
      pr, headRefOid: 'f3-h1',
      findings: [{ invariant: 'x', severity: 'P1', recurrenceOfKey: invariantKey('从不存在的族') }],
    }),
    /引用的历史在 state 中不存在/,
  );
  // 关键:canonical 文件必须已经存在(隔离与恢复态落盘是一个原子步骤),不是 missing
  const after = readConvergenceState(pr);
  assert.equal(after.status, 'ok', '抛错后 canonical 文件必须存在——否则下一次会被当成真首轮');
  assert.equal(after.state.integrity.status, 'recovered-from-corruption', '恢复态标记必须留在文件里');
  assert.equal(after.state.heads.length, 0, '那一轮未成功完成,不应留下 head 记录');
});

// 独立成块:上面钉的是「隔离与恢复态落盘原子化」(canonical 文件必须在),这里钉的是
// 「恢复态未完成时强制信号仍延续」。合成一块的话,删早落盘和删延续推导会红同一个块,
// 变异红集分辨不出是哪条判定在起作用。拆开后前者红 2 块、后者红 1 块。
test('F3:损坏恢复态尚未成功完成时,重试仍必须强制检查点并给出告警', () => {
  const pr = 970606;
  resetPr(pr);
  const file = stateFile(`convergence-${pr}.json`);
  writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
  assert.throws(
    () => recordConvergenceRound({
      pr, headRefOid: 'f3b-h1',
      findings: [{ invariant: 'x', severity: 'P1', recurrenceOfKey: invariantKey('从不存在的族') }],
    }),
    /引用的历史在 state 中不存在/,
  );
  const r = recordConvergenceRound({ pr, headRefOid: 'f3b-h2', findings: [{ invariant: 'x', severity: 'P1' }] });
  assert.equal(r.checkpointRequired, true, '损坏后的重试仍必须强制收敛检查点');
  assert.ok(r.integrityWarning, '损坏信号必须仍以告警形式传出,不能静默');
  assert.match(r.integrityWarning, /未成功完成/);
});

test('F4:state.pr 与请求的 PR 不符 → corrupted,不得判 ok', () => {
  const pr = 970604;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'f4-h1', findings: [{ invariant: 'x', severity: 'P1' }] });
  const file = stateFile(`convergence-${pr}.json`);
  const st = JSON.parse(readFileSync(file, 'utf8'));
  st.pr = 999999; // 错绑到另一个 PR
  writeFileSync(file, JSON.stringify(st), 'utf8');
  assert.equal(readConvergenceState(pr).status, 'corrupted', 'PR 错绑的 state 不可信');
});

test('F4:families 键不等于 invariantKey(原文) → corrupted(读侧必须能识别写侧漂移)', () => {
  const pr = 970605;
  resetPr(pr);
  recordConvergenceRound({ pr, headRefOid: 'f5-h1', findings: [{ invariant: 'A', severity: 'P1' }] });
  const file = stateFile(`convergence-${pr}.json`);
  const st = JSON.parse(readFileSync(file, 'utf8'));
  const realKey = invariantKey('A');
  st.families = { 'legacy-slug-a': st.families[realKey] }; // 旧 slug 风格的键,原文仍是 'A'
  writeFileSync(file, JSON.stringify(st), 'utf8');
  const after = readConvergenceState(pr);
  assert.equal(after.status, 'corrupted', 'families 键与 invariantKey(原文) 不符必须判 corrupted');
  assert.match(after.error, /families 键/);
});
