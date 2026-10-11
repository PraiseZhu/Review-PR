import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalIso, formatLocalDisplay } from './local-time.mjs';

test('local ISO is parseable and never uses UTC Z', () => {
  const ms = Date.parse('2026-09-17T07:25:02.811Z');
  const iso = formatLocalIso(ms);
  assert.equal(Date.parse(iso), ms);
  assert.equal(iso.includes('Z'), false);
  assert.match(iso, /[+-]\d{2}:\d{2}$/);
  assert.doesNotMatch(iso, /T07:25:02\.811Z$/);
});

test('Feishu display uses the host clock instead of UTC Z', () => {
  const utc = '2026-09-17T07:25:02.811Z';
  const display = formatLocalDisplay(utc);
  assert.equal(display.includes('Z'), false);
  assert.match(display, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT[+-]\d/);
  const local = new Date(utc);
  const expectedHour = String(local.getHours()).padStart(2, '0');
  assert.equal(display.slice(11, 13), expectedHour);
});

test('invalid display input is returned as-is', () => {
  assert.equal(formatLocalDisplay(''), '');
  assert.equal(formatLocalDisplay('时间未记录'), '时间未记录');
  assert.throws(() => formatLocalIso('not-a-date'));
});
