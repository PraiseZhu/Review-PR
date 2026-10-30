import test from 'node:test';
import assert from 'node:assert/strict';
import { toKeyRing, toKeySwitch, switchToBackup, activeCredentials, keyTexts, toCredentialSummary, noteKeyResult, toRateLimitWait, toRateLimitRetry,
  RATE_LIMIT_DEFAULT_WAIT_MS, RATE_LIMIT_MAX_WAIT_MS } from './keys.mjs';

const PRIMARY = JSON.stringify({ api_key: 'sk-primary-AAAAAAAA', base_url: 'https://gw.example.com/v1' });
const NOW = Date.parse('2026-10-18T03:00:00Z');
const env = (over = {}) => ({ LITELLM_CREDENTIALS_JSON: PRIMARY, LITELLM_BACKUP_API_KEY: 'sk-backup-BBBBBBBB', ...over });

test('每轮从主 key 开始;备用 key 没设地址时用主凭据的网关;两把相同或格式不对就当没有备用', () => {
  const ring = toKeyRing(env(), NOW);
  assert.equal(ring.active, 'primary');
  assert.deepEqual(ring.backup, { apiKey: 'sk-backup-BBBBBBBB', baseUrl: 'https://gw.example.com/v1' });
  assert.deepEqual(keyTexts(ring), ['sk-primary-AAAAAAAA', 'sk-backup-BBBBBBBB']);
  assert.equal(activeCredentials(ring, env()), ring.primary);
  assert.equal(toKeyRing(env({ LITELLM_BACKUP_BASE_URL: 'https://other.example.com' }), NOW).backup.baseUrl, 'https://other.example.com/v1');
  const same = toKeyRing(env({ LITELLM_BACKUP_API_KEY: 'sk-primary-AAAAAAAA' }), NOW);
  assert.equal(same.backup, null);
  assert.match(same.warnings[0], /备用 key 与主 key 相同/);
  const badBase = toKeyRing(env({ LITELLM_BACKUP_BASE_URL: 'http://plain.example.com' }), NOW);
  assert.equal(badBase.backup, null);
  assert.match(badBase.warnings[0], /备用 key 凭据不可用.*https/);
  assert.equal(toKeyRing({ LITELLM_CREDENTIALS_JSON: PRIMARY }, NOW).backup, null, '没配备用 key');
  assert.deepEqual(toKeyRing({ LITELLM_CREDENTIALS_JSON: PRIMARY }, NOW).warnings, []);
});

test('冷却期没到期就直接用备用 key;到期、没有备用 key、时间格式不对都从主 key 开始;主凭据坏了改用备用', () => {
  const cooling = toKeyRing(env({ MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL: '2026-10-18T03:30:00Z' }), NOW);
  assert.equal(cooling.active, 'backup');
  assert.equal(cooling.preferUntil, '2026-10-18T03:30:00.000Z');
  assert.equal(toKeyRing(env({ MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL: '2026-10-18T02:59:00Z' }), NOW).active, 'primary');
  assert.equal(toKeyRing(env({ MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL: 'soon' }), NOW).active, 'primary');
  assert.equal(toKeyRing({ LITELLM_CREDENTIALS_JSON: PRIMARY, MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL: '2026-10-18T03:30:00Z' }, NOW).active, 'primary');
  const broken = toKeyRing(env({ LITELLM_CREDENTIALS_JSON: '{bad', LITELLM_BACKUP_BASE_URL: 'https://gw.example.com' }), NOW);
  assert.equal(broken.active, 'backup');
  assert.match(broken.warnings.join('\n'), /主 key 凭据不可用/);
  const none = toKeyRing({ LITELLM_CREDENTIALS_JSON: '{bad' }, NOW);
  assert.equal(none.active, null);
  assert.equal(activeCredentials(none, { LITELLM_CREDENTIALS_JSON: '{bad' }), '{bad', '两把都不可用时把原文交给 runCodex 报原错误');
});

test('只在用主 key、有备用、失败且是 key 本身的问题时换;一轮只换一次;记下主 key 是否能用', () => {
  const ring = toKeyRing(env(), NOW);
  assert.equal(toKeySwitch(ring, { ok: false, keyFailure: null, outputStarted: false }), null, '非 key 问题不换');
  assert.equal(ring.primaryOk, false, '没有输出的非 key 失败不能证明主 key 能用');
  assert.equal(toKeySwitch(ring, { ok: false, keyFailure: null, outputStarted: true }), null);
  assert.equal(ring.primaryOk, true, '模型产出过条目说明网关收了主 key');
  const change = toKeySwitch(ring, { ok: false, keyFailure: { kind: 'budget', status: 400 }, outputStarted: true });
  assert.deepEqual(change, { kind: 'budget', status: 400, midRun: true });
  switchToBackup(ring, change, { model: 'openai/m', label: '1' });
  assert.equal(ring.active, 'backup');
  assert.equal(toKeySwitch(ring, { ok: false, keyFailure: { kind: 'auth', status: 401 } }), null, '已经在备用 key 上就不再换');
  const summary = toCredentialSummary(ring);
  assert.equal(summary.primaryFailedMidRun, true);
  assert.equal(summary.startedOn, 'primary');
  assert.equal(summary.active, 'backup');
  assert.doesNotMatch(JSON.stringify(summary), /AAAAAAAA|BBBBBBBB|gw\.example/);
  const noBackup = toKeyRing({ LITELLM_CREDENTIALS_JSON: PRIMARY }, NOW);
  assert.equal(toKeySwitch(noBackup, { ok: false, keyFailure: { kind: 'auth', status: 401 } }), null, '没有备用 key 时照旧');
});

test('down:最后能用的那把 key 报 key 错误才记;同一把后来又成功就清掉;主 key 在有备用时报错不算', () => {
  const ring = toKeyRing(env(), NOW);
  noteKeyResult(ring, 'primary', { ok: false, keyFailure: { kind: 'auth', status: 401 } }, 'review');
  assert.equal(ring.down, null, '有备用时主 key 报错是换 key,不是 down');
  noteKeyResult(ring, 'backup', { ok: false, keyFailure: { kind: 'access', status: 403 } }, 'review');
  assert.deepEqual(ring.down, { kind: 'access', status: 403, credential: 'backup', phase: 'review' });
  noteKeyResult(ring, 'backup', { ok: true, keyFailure: null }, 'review');
  assert.equal(ring.down, null, '备用模型在备用 key 上成功:key 没坏');
  noteKeyResult(ring, 'backup', { ok: false, keyFailure: { kind: 'auth', status: 401 } }, 'verify');
  assert.deepEqual(toCredentialSummary(ring).down, { kind: 'auth', status: 401, credential: 'backup', phase: 'verify' });
  const noBackup = toKeyRing({ LITELLM_CREDENTIALS_JSON: PRIMARY }, NOW);
  noteKeyResult(noBackup, 'primary', { ok: false, keyFailure: { kind: 'budget', status: null } }, 'review');
  assert.equal(noBackup.down.credential, 'primary');
});

test('限流(#143):不换备用 key、不记 down', () => {
  const ring = toKeyRing(env(), NOW);
  const limited = { ok: false, keyFailure: { kind: 'rate-limit', status: 429 }, outputStarted: false };
  assert.equal(toKeySwitch(ring, limited), null);
  assert.equal(ring.active, 'primary');
  const noBackup = toKeyRing({ LITELLM_CREDENTIALS_JSON: PRIMARY }, NOW);
  noteKeyResult(noBackup, 'primary', limited, 'review');
  assert.equal(noBackup.down, null, '限流不说明 key 坏了');
  // 预算用完的 429 照旧换 key
  assert.deepEqual(toKeySwitch(ring, { ok: false, keyFailure: { kind: 'budget', status: 429 }, outputStarted: false }), { kind: 'budget', status: 429, midRun: false });
});

test('限流等待(#143):按 Retry-After,没有就 60 秒;最多重试 3 次、总等待不超过 5 分钟、要留够运行时间', () => {
  assert.equal(toRateLimitWait('unexpected status 429 Too Many Requests: Rate limit reached. Please retry after 7 seconds'), 7000);
  assert.equal(toRateLimitWait('429 ... Retry-After: 30'), 30_000);
  assert.equal(toRateLimitWait('429 retry_after=250ms'), 250);
  assert.equal(toRateLimitWait('429 retry after 9999 seconds'), RATE_LIMIT_MAX_WAIT_MS);
  assert.equal(toRateLimitWait('unexpected status 429 Too Many Requests: Crossed TPM / RPM'), RATE_LIMIT_DEFAULT_WAIT_MS);
  assert.equal(toRateLimitWait(null), RATE_LIMIT_DEFAULT_WAIT_MS);
  const limited = { ok: false, keyFailure: { kind: 'rate-limit', status: 429 }, finalError: '429 Crossed TPM / RPM' };
  const base = { result: limited, retries: 0, waitedMs: 0, remainingMs: 100 * 60_000, minRetryMs: 15 * 60_000 };
  assert.deepEqual(toRateLimitRetry(base), { waitMs: 60_000 });
  assert.deepEqual(toRateLimitRetry({ ...base, retries: 2, waitedMs: 120_000 }), { waitMs: 60_000 });
  assert.equal(toRateLimitRetry({ ...base, retries: 3, waitedMs: 180_000 }), null, '最多 3 次');
  assert.equal(toRateLimitRetry({ ...base, retries: 1, waitedMs: 250_000 }), null, '总等待超过 5 分钟');
  assert.equal(toRateLimitRetry({ ...base, remainingMs: 15.5 * 60_000 }), null, '等完剩余时间不够跑一次');
  assert.equal(toRateLimitRetry({ ...base, result: { ...limited, keyFailure: { kind: 'budget', status: 429 } } }), null, '预算用完不等');
  assert.equal(toRateLimitRetry({ ...base, result: { ok: true } }), null);
});
