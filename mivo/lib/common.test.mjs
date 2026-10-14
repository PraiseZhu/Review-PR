import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScript, runScriptAsync } from './common.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mivo-common-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const scriptFile = (name, body) => { const file = join(dir, name); writeFileSync(file, body); return file; };

const chatty = scriptFile('chatty.mjs', "console.log('准备中');\nconsole.log(JSON.stringify({ ok: true, value: 7 }));\n");
const noJson = scriptFile('no-json.mjs', "console.error('坏了');\nprocess.exit(3);\n");
const slow = scriptFile('slow.mjs', 'setTimeout(() => {}, 10_000);\n');

test('runScriptAsync:取最后一行 JSON,带回退出码', async () => {
  assert.deepEqual(await runScriptAsync(chatty, []), { ok: true, value: 7, exitCode: 0 });
});

test('runScriptAsync:没有 JSON 时给出失败和退出码', async () => {
  const r = await runScriptAsync(noJson, []);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.error, /没有返回 JSON\(exit 3\):坏了/);
});

test('runScriptAsync:超时会杀掉子进程并返回失败,不会一直挂着', async () => {
  const started = Date.now();
  const r = await runScriptAsync(slow, [], { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 5_000, '超时后应很快返回');
});

test('runScript(同步)对绝对路径脚本给出同样结果', () => {
  assert.deepEqual(runScript(chatty, []), { ok: true, value: 7, exitCode: 0 });
  const r = runScript(noJson, []);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
});
