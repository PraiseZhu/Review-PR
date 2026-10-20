// models/check.mjs:注入假的模型调用与 curl,不碰网络。真 CLI 链路由 Mivo 的 review-model-check.yml 在服务器上跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheck, listModels } from './check.mjs';

const PRIMARY = JSON.stringify({ api_key: 'sk-primary-PPPPPPPP', base_url: 'https://gw.example.com/v1' });
const NOON = () => new Date('2026-10-18T04:00:00Z'); // 北京时间 12:00
const env = (over = {}) => ({ INPUT_ROLE: 'primary', INPUT_MODEL: 'openai/gpt-7', INPUT_EFFORT: 'max', INPUT_REQUEST_ID: 'msw-primary-12345678',
  LITELLM_CREDENTIALS_JSON: PRIMARY, LITELLM_BACKUP_API_KEY: 'sk-backup-BBBBBBBB', ...over });
const curlOk = (ids) => () => ({ ok: true, stdout: `${JSON.stringify({ data: ids.map((id) => ({ id })) })}\n200` });
// 假模型:按 key 决定行为;'ok' 读出 nonce.txt 交回,'wrong' 交回别的数,'401' 报 key 错误。
const fakeModel = (byKey) => async ({ workdir, credentials, model, effort }) => {
  const mode = byKey[credentials.apiKey.includes('primary') ? 'primary' : 'backup'];
  if (mode === '401') return { ok: false, error: 'unexpected status 401 Unauthorized: key sk-primary-PPPPPPPP', keyFailure: { kind: 'auth', status: 401 }, durationMs: 5 };
  const nonce = mode === 'wrong' ? 'nope' : readFileSync(join(workdir, 'nonce.txt'), 'utf8').trim();
  return { ok: true, answer: { nonce }, durationMs: 10, model, effort };
};

test('主备两把都验证:模型清单与最小任务都通过;结果里没有 key 原文', async () => {
  const r = await runCheck({ env: env(), runModel: fakeModel({ primary: 'ok', backup: 'ok' }), runCmd: curlOk(['openai/gpt-7', 'openai/gpt-6-luna', 'anthropic/x']), now: NOON });
  assert.equal(r.ok, true);
  assert.equal(r.keys.primary.models.present, true);
  assert.deepEqual(r.keys.primary.models.available, ['openai/gpt-6-luna', 'openai/gpt-7']);
  assert.equal(r.keys.backup.smoke.ok, true);
  assert.doesNotMatch(JSON.stringify(r), /PPPPPPPP|BBBBBBBB/);
});

test('交回的随机数对不上(没有真的调用工具)算失败;主 key 报 key 错误而备用通过算通过;错误里的 key 被抹掉', async () => {
  const wrong = await runCheck({ env: env(), runModel: fakeModel({ primary: 'wrong', backup: 'ok' }), runCmd: curlOk(['openai/gpt-7']), now: NOON });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /随机数对不上/);
  const viaBackup = await runCheck({ env: env(), runModel: fakeModel({ primary: '401', backup: 'ok' }), runCmd: curlOk([]), now: NOON });
  assert.equal(viaBackup.ok, true);
  assert.doesNotMatch(JSON.stringify(viaBackup), /PPPPPPPP/);
  const noBackup = await runCheck({ env: env({ LITELLM_BACKUP_API_KEY: '' }), runModel: fakeModel({ primary: '401' }), runCmd: curlOk([]), now: NOON });
  assert.equal(noBackup.ok, false);
  assert.deepEqual(noBackup.keys.backup, { configured: false });
});

test('输入不合法或维护窗口内直接拒绝,不调模型', async () => {
  const never = async () => assert.fail('不该调模型');
  for (const [over, reason] of [[{ INPUT_ROLE: 'boss' }, /角色不合法/], [{ INPUT_MODEL: 'claude-x' }, /模型 id 不合法/], [{ INPUT_EFFORT: 'turbo' }, /思考档位不合法/], [{ INPUT_REQUEST_ID: 'x' }, /request_id 不合法/]]) {
    const r = await runCheck({ env: env(over), runModel: never, runCmd: curlOk([]), now: NOON });
    assert.equal(r.ok, false);
    assert.match(r.reason, reason);
  }
  const window = await runCheck({ env: env(), runModel: never, runCmd: curlOk([]), now: () => new Date('2026-10-17T22:30:00Z') });
  assert.match(window.reason, /维护窗口/);
});

test('模型清单:key 走 stdin 的 curl 配置,不进参数;非 200 与非法 JSON 都报出来', () => {
  let seen = null;
  const r = listModels({ apiKey: 'sk-k', baseUrl: 'https://gw.example.com/v1' }, { runCmd: (cmd, args, opts) => { seen = { cmd, args, input: opts.input }; return { ok: true, stdout: '{"data":[{"id":"openai/a"}]}\n200' }; } });
  assert.deepEqual(r.ids, ['openai/a']);
  assert.equal(seen.cmd, 'curl');
  assert.ok(!seen.args.join(' ').includes('sk-k'));
  assert.match(seen.input, /url = "https:\/\/gw\.example\.com\/v1\/models"/);
  assert.equal(listModels({ apiKey: 'k', baseUrl: 'https://g/v1' }, { runCmd: () => ({ ok: true, stdout: '{"error":1}\n401' }) }).error, '模型清单读取失败(HTTP 401)');
  assert.equal(listModels({ apiKey: 'k', baseUrl: 'https://g/v1' }, { runCmd: () => ({ ok: true, stdout: 'nope\n200' }) }).error, '模型清单不是合法 JSON');
});
test('模型清单 available 列全部网关 id,不再只留 openai/', async () => {
  const r = await runCheck({ env: env({ INPUT_MODEL: 'deepseek/deepseek-v4.1-flash' }), runModel: fakeModel({ primary: 'ok', backup: 'ok' }),
    runCmd: curlOk(['openai/gpt-7', 'deepseek/deepseek-v4.1-flash', 'anthropic/x']), now: NOON });
  assert.equal(r.ok, true);
  assert.equal(r.keys.primary.models.present, true);
  assert.deepEqual(r.keys.primary.models.available, ['anthropic/x', 'deepseek/deepseek-v4.1-flash', 'openai/gpt-7']);
});

