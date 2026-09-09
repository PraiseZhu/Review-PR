import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { exportReviewStateBundle, importReviewStateBundle } from '../scripts/review-state-bundle.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'native-review-bundle-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const artifactsDir = path.join(root, 'artifacts');
  for (const dir of [source, target, artifactsDir]) fs.mkdirSync(dir);
  const context = { repo: 'xindong/mivo-canvas-plugin', nodeId: 'PR_1', pr: 7, headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
    snapshotHash: 'snapshot', skillSha: 'c'.repeat(40), workflowSha: 'd'.repeat(40), runId: '123', runAttempt: 1,
    consumerResult: 'clean', executionIdentity: '/original/worktree/task.json', prescanEnabled: false, history: 'initial', previousBundleDigest: null };
  const receipt = ` ${JSON.stringify({ headRefOid: context.headRefOid, verdict: 'clean', snapshotHash: 'snapshot', p0p1Count: 0,
    source: 'consume-review-output', schemaVersion: 'rro-1', outputHash: 'output-hash', ledgerHash: 'ledger-hash', escapeSourceHash: 'escape-hash', knownHazardsHash: 'hazard-hash' })}\n`;
  fs.writeFileSync(path.join(source, 'review-receipt-7.json'), receipt);
  fs.writeFileSync(path.join(source, 'findings-7.json'), JSON.stringify({ version: 1, entries: [{ findingId: 'old', status: 'resolved' }] }));
  fs.writeFileSync(path.join(source, 'review-delivery-7.json'), JSON.stringify({ version: 1, snapshotHash: 'snapshot', deliveries: [] }));
  const artifacts = {};
  for (const role of ['task', 'output', 'preflight']) {
    artifacts[role] = path.join(source, `${role}.json`);
    fs.writeFileSync(artifacts[role], JSON.stringify({ role, executionIdentity: context.executionIdentity }));
  }
  const options = { stateDir: source, resolvedStateDir: source, artifacts, context };
  const exportBundle = () => exportReviewStateBundle(options);
  const importBundle = (bundle, overrides = {}) => importReviewStateBundle({ bundle, stateDir: target, resolvedStateDir: target, artifactsDir,
    expectedManifestDigest: bundle.manifestDigest, expectedIdentity: context, ...overrides });
  return { root, source, target, artifactsDir, artifacts, context, receipt, options, exportBundle, importBundle };
}

test('original receipt and history bytes roundtrip, repeat import is idempotent', (t) => {
  const f = fixture(t);
  const bundle = f.exportBundle();
  assert.equal(f.importBundle(bundle).fileCount, 6);
  assert.equal(f.importBundle(bundle).consumerReplayAllowed, false);
  assert.equal(fs.readFileSync(path.join(f.target, 'review-receipt-7.json'), 'utf8'), f.receipt);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'findings-7.json')), fs.readFileSync(path.join(f.source, 'findings-7.json')));
});

test('manifest digest, expected identity and payload are independently checked', (t) => {
  const f = fixture(t);
  const bundle = f.exportBundle();
  assert.throws(() => f.importBundle(bundle, { expectedManifestDigest: '0'.repeat(64) }), /digest mismatch/);
  assert.throws(() => f.importBundle(bundle, { expectedIdentity: { ...f.context, headRefOid: 'e'.repeat(40) } }), /identity mismatch/);
  assert.throws(() => f.importBundle(bundle, { expectedManifestDigest: undefined, verified: true }), /digest mismatch/);
  bundle.payload.receipt = Buffer.from('{}').toString('base64');
  assert.throws(() => f.importBundle(bundle), /payload digest mismatch/);
  assert.deepEqual(fs.readdirSync(f.target), []);
});

test('unknown paths and roles cannot be imported even with a matching manifest digest', (t) => {
  const f = fixture(t);
  for (const change of [{ name: '../escape.json' }, { role: 'secret' }]) {
    const bundle = f.exportBundle();
    const manifest = JSON.parse(bundle.manifestJson);
    Object.assign(manifest.files[0], change);
    bundle.manifestJson = JSON.stringify(manifest);
    bundle.manifestDigest = digest(bundle.manifestJson);
    assert.throws(() => f.importBundle(bundle), /unknown, duplicate or unsafe/);
  }
});

test('missing native ledger and continued history without prior digest are blocked', (t) => {
  const f = fixture(t);
  f.context.history = 'continued';
  assert.throws(f.exportBundle, /previous bundle digest/);
  f.context.previousBundleDigest = 'e'.repeat(64);
  const bundle = f.exportBundle();
  assert.throws(() => f.importBundle(bundle, { expectedIdentity: { ...f.context, history: 'initial', previousBundleDigest: null } }), /identity mismatch/);
  fs.unlinkSync(path.join(f.source, 'findings-7.json'));
  assert.throws(f.exportBundle, /ENOENT/);
});

test('source and target symlinks are rejected and existing history is not overwritten', (t) => {
  const f = fixture(t);
  const bundle = f.exportBundle();
  const target = path.join(f.target, 'review-receipt-7.json');
  fs.symlinkSync(path.join(f.source, 'review-receipt-7.json'), target);
  assert.throws(() => f.importBundle(bundle), /symbolic links/);
  fs.unlinkSync(target);
  fs.writeFileSync(target, '{}');
  assert.throws(() => f.importBundle(bundle), /overwrite existing/);
  fs.unlinkSync(f.artifacts.task);
  fs.symlinkSync(f.artifacts.output, f.artifacts.task);
  assert.throws(f.exportBundle, /symbolic links/);
});

test('resolved STATE_DIR mismatch and oversize files fail before writes', (t) => {
  const f = fixture(t);
  assert.throws(() => exportReviewStateBundle({ ...f.options, resolvedStateDir: f.target }), /resolved STATE_DIR/);
  fs.writeFileSync(f.artifacts.task, ' '.repeat(10 * 1024 * 1024 + 1));
  assert.throws(f.exportBundle, /10 MiB/);
});

test('enabled prescan requires all native prescan artifacts', (t) => {
  const f = fixture(t);
  f.context.prescanEnabled = true;
  assert.throws(f.exportBundle, /ENOENT/);
  for (const name of ['prescan-artifact', 'prescan-delivery', 'prescan-record']) fs.writeFileSync(path.join(f.source, `${name}-7.json`), '{}');
  assert.equal(f.importBundle(f.exportBundle()).fileCount, 9);
});

test('non-clean consumer cannot export a clean receipt', (t) => {
  const f = fixture(t);
  f.context.consumerResult = 'invalid';
  assert.throws(f.exportBundle, /non-clean consumer/);
});

test('aggregate clean without native consumer bindings cannot become a bundle', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'review-receipt-7.json'), JSON.stringify({ headRefOid: f.context.headRefOid, verdict: 'clean', snapshotHash: 'snapshot' }));
  assert.throws(f.exportBundle, /not native consumer evidence/);
});
