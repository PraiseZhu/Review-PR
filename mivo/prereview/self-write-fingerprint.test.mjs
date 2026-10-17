// 审查机自己的写动作(发评论、摘标签、重置 check)只让 PR 的 updatedAt 前移时,下一轮 pre-check 不再把同一个 head 选中。
// 补丁 self-write,代码在 review-pr/scripts/review-round.mjs(observeCandidateFingerprint)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateList, makeReviewPlan, collectRoundResults, nextRoundState } from '../../review-pr/scripts/review-round.mjs';

const now = Date.parse('2026-09-08T00:00:00Z');
const snapshot = (count) => Array.from({ length: count }, (_, i) => ({ number: i + 1,
  title: `修复 ${i + 1}`, url: `https://github.com/o/r/pull/${i + 1}`, createdAt: new Date(now + i).toISOString(),
  head: (i + 1).toString(16).padStart(40, '0'), headRefName: `pr-${i + 1}`, baseRefName: 'main',
  base: 'a'.repeat(40), updatedAt: new Date(now).toISOString(), isDraft: false, unresolved: 0, ci: 'SUCCESS',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED' }));
const contexts = (list) => list.map((p) => ({ ok: true, pr: p.number, meta: { state: 'OPEN', headRefOid: p.head }, dependencies: [] }));
const result = (plan, item, outcome) => ({ runId: plan.runId, mode: plan.mode, pr: item.pr, head: item.head,
  enteredReview: true, reviewed: true, reviewClean: false, merged: false, outcome, reason: '已执行' });

// #1081(2026-10-17):审查机自己发评论、摘标签,只让 PR 的 updatedAt 前移,下一轮 pre-check 把同一个 head 又选中,多派了一次完整审查。
// 记的是动手前的观察值(不能吞掉并发的新 thread / CI / review),所以只认「只有 updatedAt 变、且不晚于上一轮收尾时刻」这一种。
test('审查机自己的写动作只改 updatedAt 时不再选中同一个 head;其它字段变化或收尾之后的改动照常唤醒', () => {
  const before = now - 40 * 60 * 1000;
  const rows = snapshot(1).map((p) => ({ ...p, updatedAt: new Date(before).toISOString() }));
  const manifest = createCandidateList({ repo: 'o/r', snapshot: rows, now: before });
  const plan = makeReviewPlan(manifest, contexts(rows));
  const payload = collectRoundResults(plan, [result(plan, plan.groups[0].prs[0], 'ci-pending')]);
  const state = nextRoundState(plan, payload, {}, now);
  const select = (data, saved = state, time = now + 1000) => createCandidateList({ repo: 'o/r', snapshot: data, state: saved, now: time });
  const own = [{ ...rows[0], updatedAt: new Date(now - 5000).toISOString() }];

  const selected = select(own);
  assert.equal(selected.candidates.length, 0, '只有收尾前的 updatedAt 前移 = 审查机自己的写动作');
  assert.equal(selected.skipped[0].fingerprintFields.updatedAt, own[0].updatedAt, '基线随之前移,下一轮不再比较旧值');
  const next = nextRoundState({ mode: 'auto', runId: 'next-round', manifest: selected }, { processed: [] }, state, now + 1000);
  assert.equal(next.prs[1].fingerprintFields.updatedAt, own[0].updatedAt);
  assert.equal(next.prs[1].checkedAt, state.prs[1].checkedAt, '收尾时刻不变,不能靠反复吸收把窗口越推越宽');
  assert.equal(select(own, next, now + 2 * 60 * 60 * 1000).candidates.length, 0);

  const wake = (patch, saved = state) => select([{ ...own[0], ...patch }], saved).candidates.length;
  assert.equal(wake({ updatedAt: new Date(now + 500).toISOString() }), 1, '上一轮收尾之后才有的改动');
  assert.equal(wake({ unresolved: 1 }), 1);
  assert.equal(wake({ ci: 'FAILURE' }), 1);
  assert.equal(wake({ reviewDecision: 'APPROVED' }), 1);
  assert.equal(wake({ head: 'b'.repeat(40) }), 1);
  assert.equal(wake({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }), 1);
  const noChecked = { ...state, prs: { 1: { ...state.prs[1], checkedAt: undefined } } };
  const noFields = { ...state, prs: { 1: { ...state.prs[1], fingerprintFields: undefined } } };
  assert.equal(wake({}, noChecked), 1, '没有收尾时刻的旧状态无法确认,照旧唤醒');
  assert.equal(wake({}, noFields), 1, '没有字段明细的旧状态无法确认,照旧唤醒');
});
