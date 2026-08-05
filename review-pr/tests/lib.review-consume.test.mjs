// SC-R1a 矩阵测试:validateReviewOutput(单一 JSON 契约)+ deriveVerdict(闭合公式)。
// 反向变异纪律:MUTATIONS 数组预测红集,逐条实跑(同 lib.validate-finding-family 的做法)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewOutput, deriveVerdict, REVIEW_OUTPUT_SCHEMA_VERSION } from '../scripts/lib.review-consume.mjs';

const FAM = () => ({
  family_id: 'f1', invariant: '等待谓词必须真的等待', severity: 'P1',
  manifestations: [{ path: 'scripts/e2e/a.mjs', line: 10, evidence: 'e', impact: 'i', fix: 'f', verification: 'v', severity: 'P1' }],
  fixGuidance: '改 evaluate 轮询',
});
const RUN = () => ({ runId: 'r1', command: 'node --test x', exitCode: 1, outputAnchor: '3 failed' });
const base = (over = {}) => ({
  schemaVersion: REVIEW_OUTPUT_SCHEMA_VERSION,
  findingFamilies: [], verificationGaps: [], verificationRuns: [],
  profileAnswers: [], findingDispositions: [], negativeEvidence: [], escapeAssessment: [],
  segmentReceipts: [], modelVerdictNote: 'x', ...over,
});
const ok = (o, ctx) => validateReviewOutput(o, ctx);

test('合法空输出(零 finding)通过;各字段缺失逐一报错', () => {
  assert.equal(ok(base()).ok, true);
  for (const key of ['findingFamilies', 'verificationGaps', 'verificationRuns', 'profileAnswers', 'findingDispositions', 'negativeEvidence', 'escapeAssessment', 'segmentReceipts']) {
    const o = base(); delete o[key];
    const r = ok(o);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes(key)), `${key} 缺失应报错`);
  }
  assert.equal(ok(base({ schemaVersion: 'v0' })).ok, false);
});

test('findingFamilies 真正接线 validateFindingFamily:坏 family 报错带索引前缀', () => {
  const bad = FAM(); delete bad.fixGuidance;
  const r = ok(base({ findingFamilies: [bad] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('findingFamilies[0]:') && e.includes('fixGuidance')));
});

test('verificationRuns:runId 重复/形状缺失报错', () => {
  const r = ok(base({ verificationRuns: [RUN(), RUN()] }));
  assert.ok(r.errors.some((e) => e.includes('runId 重复')));
  assert.equal(ok(base({ verificationRuns: [{ runId: 'r1' }] })).ok, false);
});

test('profileAnswers:闭集/重复/checked-clean 缺 hunkId/finding 本地引用验真/N-A 缺 reason', () => {
  const a = (over) => ({ profileId: 'test-infra', fileId: 'F1', checkId: 'c1', ...over });
  assert.equal(ok(base({ profileAnswers: [a({ answer: 'maybe' })] })).ok, false);
  assert.equal(ok(base({ profileAnswers: [a({ answer: 'checked-clean' })] })).ok, false, 'checked-clean 必须引 hunkId');
  assert.equal(ok(base({ profileAnswers: [a({ answer: 'checked-clean', hunkId: 'H1' })] })).ok, true);
  // finding 引用:无对应 family/manifestationIndex 越界 → 拒
  assert.equal(ok(base({ profileAnswers: [a({ answer: 'finding', findingRef: { family_id: 'f1', manifestationIndex: 0 } })] })).ok, false);
  assert.equal(ok(base({
    findingFamilies: [FAM()],
    profileAnswers: [a({ answer: 'finding', findingRef: { family_id: 'f1', manifestationIndex: 0 } })],
  })).ok, true);
  assert.equal(ok(base({
    findingFamilies: [FAM()],
    profileAnswers: [a({ answer: 'finding', findingRef: { family_id: 'f1', manifestationIndex: 9 } })],
  })).ok, false, 'manifestationIndex 越界');
  const dup = [a({ answer: 'checked-clean', hunkId: 'H1' }), a({ answer: 'checked-clean', hunkId: 'H2' })];
  assert.ok(ok(base({ profileAnswers: dup })).errors.some((e) => e.includes('重复作答')));
});

test('findingDispositions:模型不得产出 accepted-risk(只走交互通道)', () => {
  const r = ok(base({ findingDispositions: [{ findingId: 'fid-a', disposition: 'accepted-risk' }] }), { injectedOpenIds: ['fid-a'] });
  assert.equal(r.ok, false);
});

test('findingDispositions:只认注入的 open ID;resolved 需证据;invalidated 需依据;重复拒', () => {
  const EV = { kind: 'diff-anchor', snapshotHash: 'snap1-t', fileId: 'F1', hunkId: 'H1' };
  const d = (over) => ({ findingId: 'fid-a', disposition: 'resolved', evidence: EV, ...over });
  assert.equal(ok(base({ findingDispositions: [d()] }), { injectedOpenIds: ['fid-a'] }).ok, true);
  assert.equal(ok(base({ findingDispositions: [d()] }), { injectedOpenIds: [] }).ok, false, '未注入的 ID 不可 disposition');
  assert.equal(ok(base({ findingDispositions: [d({ evidence: undefined })] }), { injectedOpenIds: ['fid-a'] }).ok, false);
  assert.equal(ok(base({ findingDispositions: [d({ disposition: 'invalidated', basis: undefined })] }), { injectedOpenIds: ['fid-a'] }).ok, false);
  assert.equal(ok(base({ findingDispositions: [d(), d()] }), { injectedOpenIds: ['fid-a'] }).ok, false, '重复 disposition');
});

test('negativeEvidence:executed 全字段+observedSignal 闭集+runId 引用存在;N-A 需 reason', () => {
  const e = (over) => ({
    fileId: 'F1', hunkId: 'H1', kind: 'executed', snapshotHash: 's1', command: 'node --test',
    negativeOracle: '断言反转应红', observedSignal: 'expected-failure-observed', outputAnchor: '1 failed', verificationRunId: 'r1', ...over,
  });
  assert.equal(ok(base({ verificationRuns: [RUN()], negativeEvidence: [e()] })).ok, true);
  assert.equal(ok(base({ negativeEvidence: [e()] })).ok, false, 'runId 悬空');
  assert.equal(ok(base({ verificationRuns: [RUN()], negativeEvidence: [e({ observedSignal: 'passed' })] })).ok, false);
  assert.equal(ok(base({ negativeEvidence: [{ fileId: 'F1', kind: 'not-applicable' }] })).ok, false);
  assert.equal(ok(base({ negativeEvidence: [{ fileId: 'F1', kind: 'not-applicable', reasonCode: 'doc-only', explanation: '纯注释' }] })).ok, true);
  assert.equal(ok(base({ negativeEvidence: [{ fileId: 'F1', kind: 'not-applicable', reasonCode: '随便写的理由码', explanation: 'x' }] })).ok, false, 'reasonCode 必须在闭集内');
});

// ── deriveVerdict ──
const LG = (over = {}) => ({ effectiveOpenCount: 0, acceptedRiskCount: 0, ...over });
const dv = (over = {}) => deriveVerdict({ shape: { ok: true, errors: [] }, output: base(), ledgerResult: LG(), flags: {}, ...over });

test('verdict:全空 → clean(三条件成立)', () => {
  const r = dv();
  assert.equal(r.verdict, 'clean');
});

test('verdict:shape 不 ok → invalid(优先级最高)', () => {
  const r = deriveVerdict({ shape: { ok: false, errors: ['x'] }, output: base({ findingFamilies: [FAM()] }), ledgerResult: LG(), flags: {} });
  assert.equal(r.verdict, 'invalid');
});

test('verdict:required gap / 各外部 flag → invalid', () => {
  assert.equal(dv({ output: base({ verificationGaps: [{ description: 'd', required: true }] }) }).verdict, 'invalid');
  for (const flag of ['preflightIncomplete', 'profileConfigIncomplete', 'snapshotMismatch', 'coverageMismatch', 'requiredNegativeKeysMissing', 'missingProfileAnswers', 'missingDispositions']) {
    assert.equal(dv({ flags: { [flag]: true } }).verdict, 'invalid', flag);
  }
});

test('verdict:P0/P1 family → dirty;effective-open>0 → dirty;accepted-risk>0 → dirty(恒非 clean)', () => {
  assert.equal(dv({ output: base({ findingFamilies: [FAM()] }) }).verdict, 'dirty');
  assert.equal(dv({ ledgerResult: LG({ effectiveOpenCount: 1 }) }).verdict, 'dirty');
  const ar = dv({ ledgerResult: LG({ acceptedRiskCount: 1 }) });
  assert.equal(ar.verdict, 'dirty');
  assert.match(ar.reasons.join(';'), /accepted-risk/);
});

test('verdict:第 3 轮反例——历史 P1 打成 accepted-risk 且本轮零 family,仍 dirty 不落 clean', () => {
  const r = dv({ output: base(), ledgerResult: LG({ effectiveOpenCount: 0, acceptedRiskCount: 1 }) });
  assert.equal(r.verdict, 'dirty');
});

test('verdict:ledger 结果缺失/非法 → invalid(fail-closed,不许绕过 disposition 后结果)', () => {
  assert.equal(deriveVerdict({ shape: { ok: true, errors: [] }, output: base(), ledgerResult: null, flags: {} }).verdict, 'invalid');
  assert.equal(deriveVerdict({ shape: { ok: true, errors: [] }, output: base(), ledgerResult: { effectiveOpenCount: '0', acceptedRiskCount: 0 }, flags: {} }).verdict, 'invalid');
});

test('verdict:模型自报不采信——modelVerdictNote 写 APPROVED 不影响 dirty', () => {
  const r = dv({ output: base({ findingFamilies: [FAM()], modelVerdictNote: 'APPROVED' }) });
  assert.equal(r.verdict, 'dirty');
});

// ── 第 1 轮完成度核验补强 ──

test('R1a 复审:resolved evidence 必须结构化并绑 snapshot;自由文本/缺字段/悬空 run 一律拒', () => {
  const ctx = { injectedOpenIds: ['fid-a'] };
  const mk = (evidence) => base({ findingDispositions: [{ findingId: 'fid-a', disposition: 'resolved', evidence }] });
  assert.equal(ok(mk('x'), ctx).ok, false, '自由文本不再接受');
  assert.equal(ok(mk({ kind: 'other', snapshotHash: 's' }), ctx).ok, false);
  assert.equal(ok(mk({ kind: 'diff-anchor', fileId: 'F1', hunkId: 'H1' }), ctx).ok, false, '缺 snapshotHash');
  assert.equal(ok(mk({ kind: 'diff-anchor', snapshotHash: 's', fileId: 'F1' }), ctx).ok, false, '缺 hunkId');
  assert.equal(ok(mk({ kind: 'diff-anchor', snapshotHash: 's', fileId: 'F1', hunkId: 'H1' }), ctx).ok, true);
  assert.equal(ok(mk({ kind: 'verification-run', snapshotHash: 's', verificationRunId: 'nope' }), ctx).ok, false, 'run 悬空');
  const withRun = base({
    verificationRuns: [RUN()],
    findingDispositions: [{ findingId: 'fid-a', disposition: 'resolved', evidence: { kind: 'verification-run', snapshotHash: 's', verificationRunId: 'r1' } }],
  });
  assert.equal(ok(withRun, ctx).ok, true);
});

test('R1a 复审:segmentReceipts 进 schema——缺 receivedOrder / 段内重复 key / 重复 segmentId / 非法 kind 一律拒', () => {
  const K = (h) => ({ kind: 'hunk', fileId: 'F1', hunkId: h });
  const seg = (over) => ({ segmentId: 's1', receivedOrder: 1, coverageKeys: [K('H1')], ...over });
  assert.equal(ok(base({ segmentReceipts: [seg()] })).ok, true);
  assert.equal(ok(base({ segmentReceipts: [seg({ receivedOrder: undefined })] })).ok, false, '缺 receivedOrder(投递序号)');
  assert.equal(ok(base({ segmentReceipts: [seg({ coverageKeys: [K('H1'), K('H1')] })] })).ok, false, '段内重复不构成覆盖');
  assert.equal(ok(base({ segmentReceipts: [seg({ coverageKeys: [] }), seg({ coverageKeys: [], receivedOrder: 2 })] })).ok, false, 'segmentId 重复');
  assert.equal(ok(base({ segmentReceipts: [seg({ coverageKeys: [{ kind: 'blob', fileId: 'F1' }] })] })).ok, false);
  assert.equal(ok(base({ segmentReceipts: [seg({ coverageKeys: [{ kind: 'hunk', fileId: 'F1' }] })] })).ok, false, 'hunk key 缺 hunkId');
});

test('R1a 复审:negativeEvidence 可选 findingRef 验真', () => {
  const n = { fileId: 'F1', kind: 'not-applicable', reasonCode: 'doc-only', explanation: 'x', findingRef: { family_id: 'f1', manifestationIndex: 0 } };
  assert.equal(ok(base({ negativeEvidence: [n] })).ok, false, '无对应 finding 时拒');
  assert.equal(ok(base({ findingFamilies: [FAM()], negativeEvidence: [n] })).ok, true);
});

test('R1a 复审:新增 invalid flags 全部生效', () => {
  for (const flag of ['taskInvalid', 'segmentOrderMismatch', 'staleProfileAnchor', 'negativeEvidenceInconsistent', 'classifierIncomplete', 'escapeAssessmentMismatch', 'hazardRegisterFailed']) {
    assert.equal(dv({ flags: { [flag]: true } }).verdict, 'invalid', flag);
  }
});

test('R1a 复审:findingFamilies 为对象(非数组)时 deriveVerdict 不抛,判 invalid', () => {
  const bad = base({ findingFamilies: { f1: {} } });
  const shape = validateReviewOutput(bad, {});
  assert.equal(shape.ok, false);
  const r = deriveVerdict({ shape, output: bad, ledgerResult: LG(), flags: {} });
  assert.equal(r.verdict, 'invalid');
});
