import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inBusinessWindow, parseMarker, toHealthVerdict, readHealth, toHealthReason } from './health.mjs';

// 与老审查机 review_tool_health.py 同一套判据(test_review_tool_health.py 的对应用例)。
const at = (iso) => new Date(iso);

test('窗口:Asia/Shanghai 06:00–06:59 关门,05:59 与 07:00 开门,与主机时区无关', () => {
  assert.equal(inBusinessWindow(at('2026-10-12T05:59:59+08:00')), true);
  assert.equal(inBusinessWindow(at('2026-10-12T06:00:00+08:00')), false);
  assert.equal(inBusinessWindow(at('2026-10-12T06:59:59+08:00')), false);
  assert.equal(inBusinessWindow(at('2026-10-12T07:00:00+08:00')), true);
  assert.equal(inBusinessWindow(at('2026-10-11T22:30:00Z')), false); // UTC 22:30 = 上海 06:30
});

test('marker:healthy 且有 run_id 才放行;缺文件放行;其他状态与读不到都拦', () => {
  const now = at('2026-10-12T08:00:00+08:00');
  const writtenAt = at('2026-10-12T06:05:00+08:00');
  const healthy = parseMarker('status=healthy\nrun_id=timer-20261011T220500Z\ncodex=0.154.0\nfail_streak=0\n');
  assert.deepEqual([toHealthVerdict({ now, fields: healthy, writtenAt }).ok, toHealthVerdict({ now, fields: healthy, writtenAt }).reason], [true, 'ok']);
  assert.equal(toHealthVerdict({ now, fields: null }).reason, 'ok-no-marker');
  assert.equal(toHealthVerdict({ now, fields: null }).ok, true);
  for (const [text, reason] of [
    ['status=unhealthy\nrun_id=close-20261012', 'toolchain-unhealthy'],
    ['status=updating\nrun_id=timer-1', 'toolchain-updating'],
    ['status=weird\nrun_id=x', 'toolchain-unhealthy'],
    ['status=healthy', 'toolchain-healthy'], // 没有 run_id
    ['', 'toolchain-unhealthy'],
  ]) {
    const verdict = toHealthVerdict({ now, fields: parseMarker(text), writtenAt });
    assert.equal(verdict.ok, false, text);
    assert.equal(verdict.reason, reason, text);
  }
  assert.equal(toHealthVerdict({ now, fields: null, unreadable: true }).reason, 'toolchain-unreadable');
  assert.equal(toHealthVerdict({ now: at('2026-10-12T06:30:00+08:00'), fields: healthy, writtenAt }).reason, 'outside-business-window');
});

test('超过 26 小时没更新只告警、不拦;连续失败天数带出来', () => {
  const now = at('2026-10-12T08:00:00+08:00');
  const fields = parseMarker('status=healthy\nrun_id=timer-20260916T220501Z\nfail_streak=2');
  const stale = toHealthVerdict({ now, fields, writtenAt: at('2026-09-17T06:05:13+08:00') });
  assert.equal(stale.ok, true);
  assert.equal(stale.markerStale, true);
  assert.equal(stale.failStreak, '2');
  assert.equal(toHealthVerdict({ now, fields, writtenAt: at('2026-10-11T06:05:00+08:00') }).markerStale, false);
  assert.match(toHealthReason(toHealthVerdict({ now, fields: parseMarker('status=unhealthy\nrun_id=x\nfail_streak=3') })), /连续失败 3 天/);
  assert.match(toHealthReason({ reason: 'outside-business-window' }), /07:00 后自动重审/);
});

test('readHealth 读真实文件:存在、缺失、没权限', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mivo-health-'));
  try {
    const marker = join(dir, 'healthy.marker');
    const now = at('2026-10-12T09:00:00+08:00');
    assert.equal(readHealth({ now, markerPath: marker }).reason, 'ok-no-marker');
    writeFileSync(marker, 'status=healthy\nrun_id=timer-1\n');
    utimesSync(marker, at('2026-10-12T06:05:00+08:00'), at('2026-10-12T06:05:00+08:00'));
    const ok = readHealth({ now, markerPath: marker });
    assert.equal(ok.reason, 'ok');
    assert.equal(ok.markerAgeHours, 2.9);
    if (process.getuid?.() !== 0) {
      chmodSync(marker, 0o000);
      assert.equal(readHealth({ now, markerPath: marker }).reason, 'toolchain-unreadable');
      chmodSync(marker, 0o644);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marker 降级字段:fallback=down(及同义值,大小写不敏感)→ verdict.degraded;缺省模型是默认备用 sol;放行判据不变', () => {
  const now = at('2026-10-19T10:00:00+08:00');
  const writtenAt = at('2026-10-19T06:05:00+08:00');
  const base = 'status=healthy\nrun_id=timer-1\nfail_streak=0\n';
  const verdict = (extra) => toHealthVerdict({ now, fields: parseMarker(base + extra), writtenAt });
  assert.deepEqual(verdict('fallback=down\nfallback_reason=gateway timeout\n').degraded, { model: 'openai/gpt-6.1-sol', reason: 'gateway timeout' });
  for (const value of ['down', 'DOWN', 'Unavailable', 'failed', 'timeout', ' Timeout ']) {
    assert.equal(verdict(`fallback=${value}`).degraded?.model, 'openai/gpt-6.1-sol', value);
  }
  assert.equal(verdict('fallback=down\nfallback_model=openai/gpt-6-luna').degraded.model, 'openai/gpt-6-luna');
  assert.equal(verdict('fallback=down\nfallback_model=deepseek/deepseek-v4.1-flash').degraded.model, 'deepseek/deepseek-v4.1-flash');
  // 无字段、值不认识、模型 id 格式不对 = 现行为(没有降级)
  for (const extra of ['', 'fallback=ok', 'fallback=healthy', 'fallback=', 'fallback=weird', 'fallback=down\nfallback_model=bad model!', 'fallback_reason=x']) {
    assert.equal(verdict(extra).degraded, null, extra);
  }
  // 放行判据(ok/window/reason/status/runId)不受降级字段影响
  const plain = verdict('');
  const degraded = verdict('fallback=down');
  for (const key of ['ok', 'window', 'reason', 'markerStatus', 'runId', 'failStreak']) assert.equal(degraded[key], plain[key], key);
  assert.equal(degraded.ok, true);
  // 缺文件、读不到、不健康的 marker 没有降级信息
  assert.equal(toHealthVerdict({ now, fields: null }).degraded, null);
  assert.equal(toHealthVerdict({ now, fields: null, unreadable: true }).degraded, null);
});

test('readHealth 读到带降级字段的真实 marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mivo-health-degraded-'));
  try {
    const marker = join(dir, 'healthy.marker');
    writeFileSync(marker, 'status=healthy\nrun_id=timer-1\nfallback=down\nfallback_reason=10-19 sol 网关超时\n');
    const verdict = readHealth({ now: at('2026-10-19T10:00:00+08:00'), markerPath: marker });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.degraded, { model: 'openai/gpt-6.1-sol', reason: '10-19 sol 网关超时' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
