import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTrustedRebaseReminder, rebaseReminderFingerprint, rebaseReminderMarker } from './rebase-reminder.mjs';

test('stale-rebase reminder is stable for one merge-base episode', () => {
  const fingerprint = rebaseReminderFingerprint('2026-09-07T03:44:49Z');
  assert.equal(fingerprint.length, 64);
  assert.equal(fingerprint, rebaseReminderFingerprint('2026-09-07T03:44:49Z'));
  assert.notEqual(fingerprint, rebaseReminderFingerprint('2026-09-10T03:44:49Z'));
  const marker = rebaseReminderMarker(fingerprint);
  const comments = [
    { user: { login: 'author' }, body: marker },
    { user: { login: 'MagicLizi' }, body: `请 rebase\n\n${marker}` },
  ];
  assert.equal(hasTrustedRebaseReminder(comments, { viewer: 'magiclizi', fingerprint }), true);
  assert.equal(hasTrustedRebaseReminder(comments, { viewer: 'other-maintainer', fingerprint }), false);
  assert.equal(hasTrustedRebaseReminder([{ user: { login: 'author' }, body: marker }], { viewer: 'MagicLizi', fingerprint }), false);

  const legacy = '@author 👋 这个 PR 已经有 4 天没有 rebase 了。请在本地 rebase 最新的 `origin/main` 后重新推送。';
  assert.equal(hasTrustedRebaseReminder([
    { user: { login: 'MagicLizi' }, created_at: '2026-09-08T00:00:00Z', body: legacy },
  ], { viewer: 'MagicLizi', fingerprint, mergeBaseDate: '2026-09-07T03:44:49Z' }), true);
  assert.equal(hasTrustedRebaseReminder([
    { user: { login: 'MagicLizi' }, created_at: '2026-09-06T00:00:00Z', body: legacy },
  ], { viewer: 'MagicLizi', fingerprint, mergeBaseDate: '2026-09-07T03:44:49Z' }), false);
});

test('stale-rebase reminder rejects malformed evidence', () => {
  assert.throws(() => rebaseReminderFingerprint(''));
  assert.throws(() => rebaseReminderMarker('short'));
});
