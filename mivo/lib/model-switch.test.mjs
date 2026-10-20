import test from 'node:test';
import assert from 'node:assert/strict';
import { toServerModel, toEffort, toRole, toRoleValue, toEffectiveRoles, toSwitchBlocker, toSwitchWarnings, toCheckVerdict } from './model-switch.mjs';

test('Cindy 非 gpt 模型:网关同名来源原样返回;裸 id、codex 前缀与非法字符被拒', () => {
  assert.equal(toServerModel('deepseek/deepseek-v4.1-flash'), 'deepseek/deepseek-v4.1-flash');
  assert.equal(toServerModel('anthropic/claude-sonnet-5-5'), 'anthropic/claude-sonnet-5-5');
  for (const bad of ['codex/deepseek-x', 'claude-opus-5-5', 'grok-4.6']) {
    assert.throws(() => toServerModel(bad), /非 gpt 模型要选网关同名的来源/, bad);
  }
  for (const bad of ['deepseek/a b', 'deepseek/$(id)', 'DeepSeek/x']) {
    assert.throws(() => toServerModel(bad), /模型 id 不合法/, bad);
  }
});

test('Cindy 模型 id 映射成网关 id:去掉来源前缀加 openai/;只接 gpt / o 系', () => {
  assert.equal(toServerModel('gpt-6-luna'), 'openai/gpt-6-luna');
  assert.equal(toServerModel(' openai/gpt-6.1-sol '), 'openai/gpt-6.1-sol');
  assert.equal(toServerModel('openai-codex/gpt-5.5'), 'openai/gpt-5.5');
  assert.equal(toServerModel('o5-mini'), 'openai/o5-mini');
  for (const bad of ['claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'grok-4.6', '', null, 'gpt-6 luna']) assert.throws(() => toServerModel(bad), Error, String(bad));
  assert.equal(toEffort('max'), 'max');
  assert.equal(toEffort('ultra'), 'ultra');
  assert.throws(() => toEffort(''), /先在自动化里选好档位/);
  assert.throws(() => toEffort('turbo'), /思考档位不合法/);
  assert.equal(toRole('verifier'), 'verifier');
  assert.throws(() => toRole('boss'), /角色不合法/);
  assert.deepEqual(JSON.parse(toRoleValue({ model: 'openai/a', effort: 'max', cindyModel: 'a', provider: 'art-cindy', checkRunId: 9, setAt: 't' })),
    { model: 'openai/a', effort: 'max', cindyModel: 'a', provider: 'art-cindy', checkRunId: 9, setAt: 't' });
});

test('生效配置、阻断与独立性告警', () => {
  const vars = { MIVO_REVIEW_ROLE_FALLBACK: JSON.stringify({ model: 'openai/gpt-7', effort: 'low' }) };
  const effective = toEffectiveRoles(vars, { model: 'openai/gpt-6.1-sol', effort: 'medium' });
  assert.deepEqual(effective, { primary: { model: 'openai/gpt-6-luna', effort: 'max' }, fallback: { model: 'openai/gpt-7', effort: 'low' },
    verifier: { model: 'openai/gpt-6.1-sol', effort: 'medium' } });
  assert.equal(toSwitchBlocker({ role: 'primary', variables: {} }), null);
  assert.match(toSwitchBlocker({ role: 'primary', variables: { MIVO_REVIEW_MODEL_HEAVY: 'openai/x' } }), /MIVO_REVIEW_MODEL_HEAVY.*请先删掉/);
  assert.equal(toSwitchBlocker({ role: 'fallback', variables: { MIVO_REVIEW_MODEL_HEAVY: 'openai/x' } }), null, '只压主审');
  assert.deepEqual(toSwitchWarnings({ role: 'verifier', target: { model: 'openai/gpt-6.1-sol', effort: 'high' }, effective }), []);
  const w = toSwitchWarnings({ role: 'primary', target: { model: 'openai/gpt-6.1-sol', effort: 'max' }, effective });
  assert.equal(w.length, 1);
  assert.match(w[0], /核对员和主审是同一个模型/);
  assert.match(toSwitchWarnings({ role: 'fallback', target: { model: 'openai/gpt-6-luna', effort: 'low' }, effective })[0], /备用模型和主审是同一个模型/);
});

test('验证结果放行:只认这次请求;主 key 通过即可;主 key 报 key 错误时备用通过也算;备用不通只告警', () => {
  const req = { requestId: 'msw-primary-1234', role: 'primary', model: 'openai/gpt-7', effort: 'max' };
  const smoke = (ok, extra = {}) => ({ ok, error: ok ? null : '模型交回的随机数对不上', keyFailure: null, ...extra });
  const check = (primary, backup = { configured: true, smoke: smoke(true) }) => ({ ...req, ok: true, keys: { primary: { configured: true, models: { ok: true, present: true }, smoke: primary }, backup } });
  assert.deepEqual(toCheckVerdict(check(smoke(true)), req), { ok: true, reason: '主 key 验证通过', warnings: [] });
  assert.equal(toCheckVerdict({ ...check(smoke(true)), requestId: 'other-request-1' }, req).ok, false);
  assert.match(toCheckVerdict({ ...check(smoke(true)), effort: 'low' }, req).reason, /对不上这次请求\(effort\)/);
  assert.equal(toCheckVerdict(null, req).ok, false);
  const viaBackup = toCheckVerdict(check(smoke(false, { error: 'unexpected status 401', keyFailure: { kind: 'auth', status: 401 } })), req);
  assert.equal(viaBackup.ok, true);
  assert.match(viaBackup.warnings.join('\n'), /主 key 现在不能用/);
  const fail = toCheckVerdict({ ...check(smoke(false, { error: 'unexpected status 404' })), keys: { primary: { configured: true, models: { ok: true, present: false }, smoke: smoke(false, { error: 'unexpected status 404' }) }, backup: { configured: false } } }, req);
  assert.equal(fail.ok, false);
  assert.match(fail.reason, /unexpected status 404;网关模型清单里没有 openai\/gpt-7/);
  assert.match(fail.warnings.join('\n'), /没有配置备用 key/);
  const backupBad = toCheckVerdict(check(smoke(true), { configured: true, smoke: smoke(false, { error: 'unexpected status 401' }) }), req);
  assert.equal(backupBad.ok, true);
  assert.match(backupBad.warnings[0], /备用 key 用这个模型没通过验证/);
});
