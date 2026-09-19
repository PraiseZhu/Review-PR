#!/usr/bin/env node
import { prepareServer, bindServer, nextServer, finalizeServer } from './lib.server-review.mjs';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
try {
  const command = process.argv[2];
  const values = process.argv.slice(3);
  const allowed = { prepare: ['--request', '--out-dir', '--deadline'], bind: ['--session', '--execution'], next: ['--session', '--order', '--previous-answer'], finalize: ['--session', '--answer', '--out'] }[command];
  if (!allowed || values.length % 2 || new Set(values.filter((_, i) => i % 2 === 0)).size !== values.length / 2 || values.some((v, i) => i % 2 === 0 && !allowed.includes(v))) throw new Error('invalid or duplicate arguments');
  let result;
  if (command === 'prepare') result = prepareServer({ requestFile: arg('--request'), outDir: arg('--out-dir'), deadline: arg('--deadline') });
  else if (command === 'bind') result = bindServer({ sessionFile: arg('--session'), executionFile: arg('--execution') });
  else if (command === 'next') result = nextServer({ sessionFile: arg('--session'), order: Number(arg('--order')), previousAnswer: arg('--previous-answer') });
  else if (command === 'finalize') result = finalizeServer({ sessionFile: arg('--session'), answerFile: arg('--answer'), outputFile: arg('--out') });
  else throw new Error('expected prepare|bind|next|finalize');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, reason: error.message })}\n`);
  process.exitCode = error.message.includes('deadline') ? 4 : error.message.includes('head-changed') ? 3 : 2;
}
