// approve-exec 交接前提的只读检查:直接取 release-mivo-pr.mjs 里的 dispatchPrerequisites 原函数执行,不另写一份判据。
// 用法:node prereq-check.mjs <trust.json>... [--base <Mivo 提交>]   不给 --base 时用 main 当前提交。
// 只读:只调 gh 的查询接口,不写任何文件。全部通过 exit 0,任一份不通过 exit 1。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPTS = path.join(os.homedir(), '.claude/skills/approve-exec/scripts');
const SOURCE = path.join(SCRIPTS, 'release-mivo-pr.mjs');
const REPO = 'xindong/mivo-canvas-plugin';

// helpers
function toFunctionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`release-mivo-pr.mjs 里找不到 ${name}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`${name} 的花括号不配对`);
}
function toConstLine(text, name) {
  const m = new RegExp(`^const ${name} = .*;$`, 'm').exec(text);
  if (!m) throw new Error(`release-mivo-pr.mjs 里找不到 const ${name}`);
  return m[0];
}

const text = fs.readFileSync(SOURCE, 'utf8');
// 不用 release-mivo-pr.mjs 的 deliveryGh:verifyControlSourceSync 会传第二个参数 { maxBytes },
// deliveryGh 把它当成 runner 调用,必报 runner is not a function(approve-exec 现存缺陷,另报)。
const deliveryGh = (args, options = {}) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: options.maxBytes ?? 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`GitHub query failed: ${String(r.stderr ?? r.error ?? '').slice(0, 300)}`);
  return JSON.parse(r.stdout);
};
const { verifyControlSourceSync } = await import(pathToFileURL(path.join(SCRIPTS, 'mivo-control-source.mjs')).href);
const { createHash } = await import('node:crypto');
const body = [
  ...['sha', 'hash', 'check', 'parse'].map((name) => toConstLine(text, name)),
  `const DISPATCH_WORKFLOW = '.github/workflows/review-pr.yml';`,
  toFunctionSource(text, 'dispatchPrerequisites'),
  'return dispatchPrerequisites;',
].join('\n');
const dispatchPrerequisites = new Function('createHash', 'verifyControlSourceSync', body)(createHash, verifyControlSourceSync);

const args = process.argv.slice(2);
const at = args.indexOf('--base');
const base = at >= 0 ? args.splice(at, 2)[1] : deliveryGh(['api', `repos/${REPO}/commits/main`]).sha;
if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error(`--base 不是提交 SHA:${base}`);
if (!args.length) throw new Error('用法:node prereq-check.mjs <trust.json>... [--base <sha>]');
let failed = 0;
for (const file of args) {
  const trust = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    const r = dispatchPrerequisites({ repo: REPO, baseRefOid: base }, deliveryGh, trust);
    console.log(`通过 ${file}:base=${base.slice(0, 9)} skillSha=${trust.skillSha.slice(0, 9)} workflowSha256=${r.workflowSha256.slice(0, 12)} workflowId=${r.workflowId}`);
  } catch (error) {
    failed += 1;
    console.log(`不通过 ${file}:${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
