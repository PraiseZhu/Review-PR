import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./signoff-release.mjs', import.meta.url)), 'utf8');

test('#71 已堵 hold 标记重读空档:只从同一次 pr view 解析,且只认审查账号', () => {
  assert.equal([...src.matchAll(/parseLastHoldMarker\(commentObjs/g)].length, 1);
  assert.match(src, /parseLastHoldMarker\(commentObjs, \{ viewerLogin \}\)/);
  assert.equal([...src.matchAll(/'comments'/g)].length, 1, 'comments 只随一次 pr view 取');
});
