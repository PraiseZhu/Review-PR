import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../scripts/lib.mjs'), 'utf8');

test('lib.mjs git spawnSync is argv; gh keeps Windows cmd shim', () => {
  const gitSpawns = [...src.matchAll(/spawnSync\('git'/g)];
  assert.ok(gitSpawns.length >= 7, `expected git spawnSync sites, got ${gitSpawns.length}`);
  assert.equal((src.match(/shell: isWin/g) || []).length, 0);
  assert.match(src, /function winShellFor\(cmd\) \{/);
  assert.match(src, /return isWin && cmd !== 'git'/);
  assert.match(src, /shell: winShellFor\(cmd\)/);
  assert.match(src, /shell: false/);
});
