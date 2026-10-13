import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixDispatch, FIX_WATCHDOG_MS } from './fix-session-state.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const now = Date.parse('2026-09-23T00:00:00Z');
const thread = 'https://github.com/o/r/pull/1#discussion_r101';

test('same-head conflict or CI after a skip-gate dispatch is a new request', () => {
  const entry = { sessionId: 's1', fingerprint: `${head}|skip-gate`, dispatchedAt: new Date(now).toISOString(), nudgeCount: 0 };
  assert.equal(evaluateFixDispatch({ entry, fingerprint: `${head}|skip-gate`, now }).shouldDispatch, false);
  assert.equal(evaluateFixDispatch({ entry, fingerprint: `${head}|skip-ci-failed`, now }).shouldDispatch, true);
  assert.equal(evaluateFixDispatch({ entry, fingerprint: `${head}|skip-conflict|${base}`, now }).shouldDispatch, true);
});

test('watchdog nudges once after 6 hours, then escalates to needs-human', () => {
  const entry = { sessionId: 's1', fingerprint: `${head}|skip-gate`, dispatchedAt: new Date(now).toISOString(),
    nudgeCount: 0, threadUrls: [thread] };
  const same = evaluateFixDispatch({ entry, fingerprint: `${head}|skip-gate`, threadUrls: [thread], now: now + 1 });
  assert.equal(same.shouldDispatch, false);
  assert.equal(same.watchdog, undefined);
  const nudge = evaluateFixDispatch({ entry, fingerprint: `${head}|skip-gate`, threadUrls: [thread], now: now + FIX_WATCHDOG_MS });
  assert.equal(nudge.shouldDispatch, true);
  assert.equal(nudge.watchdog, 'nudge');
  const afterNudge = { ...entry, dispatchedAt: new Date(now + FIX_WATCHDOG_MS).toISOString(), nudgeCount: 1 };
  const stillHot = evaluateFixDispatch({ entry: afterNudge, fingerprint: `${head}|skip-gate`,
    threadUrls: [thread], now: now + FIX_WATCHDOG_MS + 1 });
  assert.equal(stillHot.shouldDispatch, false);
  const escalate = evaluateFixDispatch({ entry: afterNudge, fingerprint: `${head}|skip-gate`,
    threadUrls: [thread], now: now + FIX_WATCHDOG_MS * 2 });
  assert.equal(escalate.shouldDispatch, true);
  assert.equal(escalate.watchdog, 'escalate');
  const human = evaluateFixDispatch({ entry: { ...afterNudge, needsHuman: true }, fingerprint: `${head}|skip-gate`,
    threadUrls: [thread], now: now + FIX_WATCHDOG_MS * 3 });
  assert.equal(human.shouldDispatch, false);
  assert.equal(human.needsHuman, true);
});
