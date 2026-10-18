import test from 'node:test';
import assert from 'node:assert/strict';
import { toKeyStatus, toKeyStatusReason } from './key-status.mjs';

const base = { backupConfigured: true, startedOn: 'primary', active: 'primary', preferBackup: false, switched: null, primaryOk: false };

test('key 状态:主 key 能用 → primary;换过备用 → backup;在用的那把也报 key 错误 → down;推不出来不写', () => {
  assert.equal(toKeyStatus({ ...base, primaryOk: true }, [{ credential: 'primary', ok: true }]), 'primary');
  const switched = { ...base, active: 'backup', switched: { kind: 'auth', status: 401, midRun: false } };
  assert.equal(toKeyStatus(switched, [{ credential: 'backup', ok: true }]), 'backup');
  assert.match(toKeyStatusReason('backup', switched), /主 key 认证失败\(401\),已自动改用备用 key/);
  assert.equal(toKeyStatus(switched, [{ credential: 'backup', ok: false, keyFailure: { kind: 'budget', status: 400 } }]), 'down');
  assert.match(toKeyStatusReason('down', switched, [{ keyFailure: { kind: 'budget', status: 400 } }]), /备用 key 也报 key 错误:额度或预算用完\(400\)/);
  assert.equal(toKeyStatus({ ...base, backupConfigured: false }, [{ credential: 'primary', ok: false, keyFailure: { kind: 'auth', status: 401 } }]), 'down');
  assert.match(toKeyStatusReason('down', { ...base, backupConfigured: false }, [{ keyFailure: { kind: 'auth', status: 401 } }]), /没有配置备用 key/);
  assert.equal(toKeyStatus({ ...base, active: 'backup', startedOn: 'backup' }, []), 'backup', '主凭据坏了直接用备用');
  assert.equal(toKeyStatus({ ...base, active: 'backup', startedOn: 'backup', preferBackup: true }, [{ credential: 'backup', ok: true }]), null, '冷却期里主 key 没试过');
  assert.equal(toKeyStatus({ ...base }, [{ credential: 'primary', ok: false }]), null, '网关 5xx 之类推不出 key 状态');
  assert.equal(toKeyStatus(null, []), null);
  const midRunNoRetry = { ...base, active: 'backup', switched: { kind: 'rate-limit', status: 429, midRun: true } };
  assert.equal(toKeyStatus(midRunNoRetry, [{ credential: 'primary', ok: false, keyFailure: { kind: 'rate-limit', status: 429 } }]), 'backup', '换了但没时间重跑:备用没试过,不算 down');
  assert.match(toKeyStatusReason('backup', midRunNoRetry), /被限流\(429\)\(审到一半\)/);
});
