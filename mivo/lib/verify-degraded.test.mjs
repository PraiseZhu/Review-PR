// 核对员 / 备用模型在网关不可用时不白等(2026-10-19 实测 sol 超时,每轮核对员白等最多 20 分钟):
// marker 降级字段 → 整体跳过;核对员第一次超时/网关类失败 → 本轮不再核剩下的。跳过的 P1 照旧阻断,P0 不核。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as verify from './verify.mjs';
import { DEFAULT_FEATURES } from './verify.mjs';

const MIN = 60_000;
const CFG = { ...DEFAULT_FEATURES.verify, mode: 'enforce', maxFindings: 5 };
const SOL = 'openai/gpt-6.1-sol';
const LUNA = 'openai/gpt-6-luna';
const same = { answeredBy: LUNA, primary: { model: LUNA } };
const P1S = [{ severity: 'P1', key: 'a', uid: 'ua' }, { severity: 'P1', key: 'b', uid: 'ub' }, { severity: 'P1', key: 'c', uid: 'uc' }];
const CONFIRMED = { ok: true, durationMs: 1000, answer: { verdict: 'confirmed', evidence: [], note: '成立' } };
const run = (over) => verify.runVerification({ findings: P1S, config: CFG, ...same, remainingMs: () => 90 * MIN, ...over });

test('核对员模型被标不可用:整体跳过(model-unavailable),一次都不调用', async () => {
  const result = await run({ unavailable: { [SOL]: 'healthy.marker 标为不可用' }, runOne: () => assert.fail('不该调用') });
  assert.deepEqual(result.skipped, P1S.map((f) => ({ key: f.key, uid: f.uid, reason: 'model-unavailable' })));
  assert.deepEqual(result.items, []);
  assert.equal(result.unavailable, 'healthy.marker 标为不可用');
  // 标的是别的模型时不受影响
  const calls = [];
  const other = await run({ unavailable: { 'openai/other': 'x' }, runOne: async (f) => { calls.push(f.key); return CONFIRMED; } });
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(other.skipped, []);
  assert.ok(!('unavailable' in other) || other.unavailable == null);
});

test('熔断:核对员第一次超时/卡住/网关类失败后本轮不再核剩下的;答卷不合格与普通失败不触发', async () => {
  for (const failure of [
    { ok: false, timedOut: true, error: '审查超时(15 分钟)' },
    { ok: false, idleKilled: true, error: '审查 15 分钟没有任何输出,判定卡住' },
    { ok: false, error: 'codex exec 退出码 1:unexpected status 502 Bad Gateway' },
    { ok: false, error: 'codex exec 退出码 1:stream disconnected before completion', keyFailure: null },
    { ok: false, error: 'codex exec 退出码 1:unexpected status 401', keyFailure: { kind: 'auth', status: 401 } },
  ]) {
    const calls = [];
    const result = await run({ runOne: async (f) => { calls.push(f.key); return failure; } });
    assert.deepEqual(calls, ['a'], failure.error);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].ok, false);
    assert.deepEqual(result.skipped, [{ key: 'b', uid: 'ub', reason: 'model-unavailable' }, { key: 'c', uid: 'uc', reason: 'model-unavailable' }], failure.error);
    assert.match(result.unavailable, /超时|卡住|网关|不可用|key/);
  }
  for (const soft of [{ ok: false, error: 'codex exec 退出码 3:verifier exploded' }, { ok: true, durationMs: 1, answer: { verdict: 'maybe', evidence: [], note: '' } }]) {
    const calls = [];
    const result = await run({ runOne: async (f) => { calls.push(f.key); return soft; } });
    assert.deepEqual(calls, ['a', 'b', 'c'], '答卷不合格/普通失败不熔断');
    assert.deepEqual(result.skipped, []);
  }
});

test('熔断后 P0 照旧不核、P1 照旧阻断(applyVerification 保留没核到的)', async () => {
  const findings = [{ severity: 'P0', key: 'x', uid: 'ux' }, ...P1S];
  const result = await verify.runVerification({ findings, config: CFG, ...same, remainingMs: () => 90 * MIN, runOne: async () => ({ ok: false, timedOut: true, error: '审查超时(15 分钟)' }) });
  assert.ok(!result.items.some((i) => i.key === 'x') && !result.skipped.some((i) => i.key === 'x'), 'P0 不进核对');
  assert.equal(verify.applyVerification({ findings, verification: result }).findings.length, 4);
});

test('toUnavailableModels:marker 降级的模型 + 主审本轮超时/卡住/网关失败的模型;主审成功或额度类以外的普通失败不算', () => {
  assert.deepEqual(verify.toUnavailableModels({ degraded: null, attempts: [{ model: LUNA, ok: true }] }), {});
  assert.deepEqual(Object.keys(verify.toUnavailableModels({ degraded: { model: SOL, reason: 'gateway timeout' }, attempts: [] })), [SOL]);
  assert.match(verify.toUnavailableModels({ degraded: { model: SOL, reason: 'gateway timeout' }, attempts: [] })[SOL], /gateway timeout/);
  const timedOut = verify.toUnavailableModels({ degraded: null, attempts: [{ model: LUNA, ok: false, timedOut: true }, { model: SOL, ok: true }] });
  assert.deepEqual(Object.keys(timedOut), [LUNA]);
  assert.deepEqual(Object.keys(verify.toUnavailableModels({ degraded: null, attempts: [{ model: LUNA, ok: false, idleKilled: true }] })), [LUNA]);
  assert.deepEqual(verify.toUnavailableModels({ degraded: null, attempts: [{ model: LUNA, ok: false, error: '模型没有交出可解析的最终答卷' }] }), {});
});
