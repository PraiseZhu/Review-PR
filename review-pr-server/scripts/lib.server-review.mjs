import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReviewIdentity, assertReviewArtifactPaths, createServerDispatchReceipt, assertDispatchReceipt } from './lib.review-identity.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function check(ok, message) { if (!ok) throw new Error(message); }
export function remaining(deadline, now = Date.now()) {
  const ms = Date.parse(deadline) - now;
  check(Number.isFinite(ms) && ms > 0, 'deadline-exhausted');
  return Math.max(1, Math.floor(ms));
}
export function validateRequest(r) {
  check(r?.schemaVersion === 1 && /^[\w.-]+\/[\w.-]+$/.test(r.repo ?? ''), 'request repo/schema invalid');
  check(Number.isSafeInteger(r.pr) && r.pr > 0, 'request PR invalid');
  for (const k of ['head', 'base', 'skillSha', 'controlSha']) check(/^[a-f0-9]{40}$/.test(r[k] ?? ''), `request ${k} invalid`);
  for (const k of ['runId', 'runAttempt', 'jobId']) check(/^[1-9][0-9]*$/.test(String(r[k] ?? '')), `request ${k} invalid`);
  check(r.historyVerified === true, 'verified history required');
  check(r.history === 'initial' && r.previousBundleDigest === null || r.history === 'continued' && /^[a-f0-9]{64}$/.test(r.previousBundleDigest ?? ''), 'history provenance invalid');
  for (const k of ['repoRoot', 'worktree', 'rulesFile']) check(typeof r[k] === 'string' && path.isAbsolute(r[k]), `request ${k} required`);
  remaining(r.deadlineAt);
  return r;
}
function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
function save(file, value) { const temp = `${file}.tmp-${process.pid}`; fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(temp, file); }
export function runScript(name, args, session) {
  const result = spawnSync(process.execPath, [path.join(scripts, name), ...args], {
    cwd: session.worktree, encoding: 'utf8', timeout: remaining(session.deadlineAt), maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, REVIEW_PR_REPO_ROOT: session.request.repoRoot, REVIEW_PR_RULES_FILE: session.request.rulesFile },
  });
  check(result.error?.code !== 'ETIMEDOUT', 'deadline-exhausted');
  check(result.status === 0, `${name} failed (${result.error?.code ?? result.status})`);
  return JSON.parse(result.stdout);
}
export function validateSegmentAnswer(answer, delivery) {
  check(answer?.segmentId === delivery.segmentId && answer.receivedOrder === delivery.order && answer.snapshotHash === delivery.snapshotHash, 'segment answer binding mismatch');
  const keys = xs => xs.map(x => {
    check(x && ['file', 'hunk'].includes(x.kind) && typeof x.fileId === 'string' && (x.kind !== 'hunk' || typeof x.hunkId === 'string'), 'invalid coverage key');
    return `${x.kind}:${x.fileId}:${x.hunkId ?? ''}`;
  }).sort();
  check(Array.isArray(answer.coverageKeys) && JSON.stringify(keys(answer.coverageKeys)) === JSON.stringify(keys(delivery.assignedCoverageKeys)), 'segment coverage mismatch');
  return true;
}
function sessionAt(file) {
  const s = read(file);
  validateRequest(s.request); check(s.deadlineAt === s.request.deadlineAt, 'deadline override forbidden'); remaining(s.deadlineAt);
  check(s.requestDigest === digest(s.request), 'request digest mismatch');
  const id = buildReviewIdentity({ repoRoot: s.request.repoRoot, worktree: s.worktree, skillRoot: path.dirname(scripts) });
  check(JSON.stringify(id) === JSON.stringify(s.identity), 'session identity mismatch');
  assertReviewArtifactPaths(id, [file, s.taskFile, s.preflightFile, s.promptFile]);
  return s;
}
export function prepareServer({ requestFile, outDir, deadline, run = runScript }) {
  const request = validateRequest(read(requestFile));
  check(request.deadlineAt === deadline, 'deadline override forbidden');
  check(fs.realpathSync(outDir) === fs.realpathSync(request.worktree), 'out-dir must equal worktree');
  const identity = buildReviewIdentity({ repoRoot: request.repoRoot, worktree: request.worktree, skillRoot: path.dirname(scripts) });
  const s = { schemaVersion: 1, request, requestDigest: digest(request), identity, worktree: identity.worktree, deadlineAt: deadline, deliveries: [], answers: [] };
  for (const [k, name] of Object.entries({ taskFile: 'task.json', preflightFile: 'preflight.json', promptFile: 'server-prompt.md' })) s[k] = path.join(s.worktree, name);
  const session = path.join(s.worktree, 'session.json');
  assertReviewArtifactPaths(identity, [session, s.taskFile, s.preflightFile, s.promptFile]);
  check(!fs.existsSync(session) && !fs.existsSync(s.taskFile), 'existing review session cannot be overwritten');
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: s.worktree, encoding: 'utf8', timeout: remaining(deadline) });
  check(git.status === 0 && git.stdout.trim() === request.head, 'head-changed');
  const context = run('context.mjs', [String(request.pr)], s);
  check(context.ok === true && context.meta?.headRefOid === request.head && context.meta?.state === 'OPEN' && context.meta?.isDraft === false, 'head-changed');
  check(context.security?.scanned === true, 'security scan incomplete');
  check(Array.isArray(context.security.hardHits) && context.security.hardHits.length === 0, 'security-hard-hit');
  check(Array.isArray(context.files), 'context files incomplete');
  const expectedPaths = context.files.map(f => f.path).join(',');
  check(expectedPaths.length > 0, 'empty review diff');
  const contextFile = path.join(s.worktree, 'server-context.json'); write(contextFile, context);
  const rules = read(request.rulesFile);
  const ruleMap = rules.ruleFiles?.ruleMap;
  let mappedDocs = [];
  if (typeof ruleMap === 'string' && ruleMap) mappedDocs = [ruleMap];
  else if (ruleMap && typeof ruleMap === 'object' && !Array.isArray(ruleMap)) {
    const hits = context.signoff?.triggers?.ruleMapHits;
    check(Array.isArray(hits), 'rule-map classification missing');
    check(hits.every(h => h && Object.hasOwn(ruleMap, h.doc)), 'unknown rule-map classification');
    mappedDocs = hits.map(h => h.doc);
  } else check(ruleMap == null || ruleMap === '', 'rule-map configuration invalid');
  const rulePaths = [...new Set(['AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md', ...(rules.ruleFiles?.required ?? []), ...(context.format?.uiCodeFiles?.length ? rules.ruleFiles?.uiRequired ?? [] : []), ...mappedDocs])];
  const optional = new Set(['AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md']);
  const loadedRules = [];
  for (const name of rulePaths) {
    check(typeof name === 'string' && !path.isAbsolute(name) && !name.split('/').includes('..'), 'rule path invalid');
    const result = spawnSync('git', ['show', `${request.base}:${name}`], { cwd: s.worktree, encoding: 'utf8', timeout: remaining(deadline), maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0 && optional.has(name) && !(rules.ruleFiles?.required ?? []).includes(name)) continue;
    check(result.error?.code !== 'ETIMEDOUT', 'deadline-exhausted');
  check(result.status === 0, `required rule missing: ${name}`);
    loadedRules.push({ path: name, sha256: createHash('sha256').update(result.stdout).digest('hex'), content: result.stdout });
  }
  const rulesFile = path.join(s.worktree, 'server-rules.json'); write(rulesFile, loadedRules);
  const preflight = run('review-preflight.mjs', ['--base', request.base, '--head', request.head, '--out', s.preflightFile, '--expected-paths', expectedPaths], s);
  check(preflight.complete, 'preflight incomplete');
  const taskPrompt = path.join(s.worktree, 'task-prompt.md');
  run('build-review-task.mjs', [String(request.pr), '--base', request.base, '--head', request.head, '--out-task', s.taskFile, '--out-prompt', taskPrompt, '--expected-paths', expectedPaths], s);
  const task = read(s.taskFile);
  check(task.snapshotComplete && task.ledgerReadable && !task.hazardsIncomplete && !task.classifierIncomplete && !task.profileConfigIncomplete && !task.escapeSourceIncomplete, 'task incomplete');
  s.snapshotHash = task.snapshotHash; s.segmentCount = task.segments.length;
  check(task.repo === request.repo, 'task repository mismatch');
  const entry = fs.readFileSync(path.join(scripts, '../server/SKILL.md'), 'utf8');
  const answerDir = path.join(s.worktree, 'server-answers');
  fs.mkdirSync(answerDir);
  fs.writeFileSync(s.promptFile, `${entry}\nSkill root: ${path.dirname(scripts)}\nSession: ${session}\nContext: ${contextFile}\nRules: ${rulesFile}\nTask semantics: ${taskPrompt}\nFinal answer: ${path.join(answerDir, 'model-answer.json')}\n`, { flag: 'wx' });
  write(session, s);
  return { ok: true, session, task: s.taskFile, preflight: s.preflightFile, prompt: s.promptFile, requestDigest: s.requestDigest, snapshotHash: s.snapshotHash, segmentCount: s.segmentCount };
}
export function bindServer({ sessionFile, executionFile }) {
  const s = sessionAt(sessionFile), execution = read(executionFile);
  check(!s.execution, 'session already bound');
  for (const k of ['runId', 'runAttempt', 'jobId']) check(String(execution[k]) === String(s.request[k]), `execution ${k} mismatch`);
  check(execution.requestDigest === s.requestDigest, 'execution request mismatch');
  const task = read(s.taskFile);
  task.dispatchReceipt = createServerDispatchReceipt({ pr: s.request.pr, snapshotHash: s.snapshotHash, identity: s.identity, execution });
  save(s.taskFile, task); s.execution = execution; s.taskDigest = digest(task); save(sessionFile, s);
  return { ok: true, session: sessionFile };
}
export function nextServer({ sessionFile, order, previousAnswer }) {
  const s = sessionAt(sessionFile), task = read(s.taskFile);
  check(s.execution, 'session not bound');
  check(s.taskDigest === digest(task), 'bound task changed');
  assertDispatchReceipt(task.dispatchReceipt, { pr: s.request.pr, snapshotHash: s.snapshotHash, identity: s.identity });
  check(order === s.deliveries.length + 1, 'out-of-order segment');
  if (order > 1) {
    check(previousAnswer, 'previous model answer required'); assertReviewArtifactPaths(s.identity, [previousAnswer]);
    const answer = read(previousAnswer); validateSegmentAnswer(answer, s.deliveries.at(-1)); s.answers.push(answer);
  }
  const delivery = runScript('deliver-review-segment.mjs', [String(s.request.pr), '--task', s.taskFile, '--base', s.request.base, '--head', s.request.head, '--order', String(order)], s);
  s.deliveries.push(delivery); save(sessionFile, s);
  return delivery;
}
export function finalizeServer({ sessionFile, answerFile, outputFile }) {
  const s = sessionAt(sessionFile); assertReviewArtifactPaths(s.identity, [answerFile, outputFile]);
  check(s.taskDigest === digest(read(s.taskFile)), 'bound task changed');
  check(s.execution && s.deliveries.length === s.segmentCount, 'review not fully delivered');
  const output = read(answerFile);
  check(output.schemaVersion === 'rro-1' && output.snapshotHash === s.snapshotHash, 'RRO binding mismatch');
  check(Array.isArray(output.segmentReceipts) && output.segmentReceipts.length === s.deliveries.length, 'missing model segment receipts');
  for (let i = 0; i < s.deliveries.length; i++) validateSegmentAnswer(output.segmentReceipts[i], s.deliveries[i]);
  runScript('consume-review-output.mjs', [String(s.request.pr), '--shape-preflight', '--output', answerFile, '--snapshot-hash', s.snapshotHash], s);
  // Preserve model-authored bytes. No synthetic coverage, verdict, tests or dispositions.
  fs.copyFileSync(answerFile, outputFile, fs.constants.COPYFILE_EXCL);
  const descriptor = path.join(s.worktree, 'native-review-descriptor.json');
  write(descriptor, { schemaVersion: 1, kind: 'mivo-native-review-output', worktree: s.worktree, task: s.taskFile, output: outputFile, preflight: s.preflightFile, head: s.request.head, base: s.request.base, history: s.request.history, previousBundleDigest: s.request.previousBundleDigest });
  return { ok: true, output: outputFile, descriptor };
}
