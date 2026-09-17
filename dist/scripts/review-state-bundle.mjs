import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (value, reason) => { if (!value) throw new Error(`review bundle: ${reason}`); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function contextIdentity(context) {
  check(object(context), 'context is required');
  for (const key of ['repo', 'nodeId', 'headRefOid', 'baseRefOid', 'snapshotHash', 'skillSha', 'workflowSha', 'runId', 'consumerResult', 'executionIdentity']) {
    check(typeof context[key] === 'string' && context[key].length > 0, `context.${key} is required`);
  }
  check(/^[\w.-]+\/[\w.-]+$/.test(context.repo), 'invalid repository');
  for (const key of ['headRefOid', 'baseRefOid', 'skillSha', 'workflowSha']) check(/^[a-f0-9]{40}$/.test(context[key]), `invalid ${key}`);
  check(Number.isSafeInteger(context.pr) && context.pr > 0 && Number.isSafeInteger(context.runAttempt) && context.runAttempt > 0, 'invalid PR/runAttempt');
  check(['clean', 'dirty', 'invalid', 'blocked'].includes(context.consumerResult), 'invalid consumer result');
  check(typeof context.prescanEnabled === 'boolean', 'prescan status required');
  check(['initial', 'continued'].includes(context.history), 'explicit history status required');
  check(context.history === 'initial' ? context.previousBundleDigest === null : sha(context.previousBundleDigest), 'previous bundle digest required for continued history');
  return structuredClone(context);
}

// Reject links in every existing path component, not just the leaf file.
function safePath(value, directory = false) {
  check(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value, 'canonical absolute path required');
  const parts = value.split(path.sep).filter(Boolean);
  let current = path.parse(value).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    check(!stat.isSymbolicLink(), 'symbolic links are forbidden');
  }
  const stat = fs.statSync(value);
  check(directory ? stat.isDirectory() : stat.isFile(), directory ? 'directory required' : 'regular file required');
  return value;
}

function stateRoot(stateDir, resolvedStateDir) {
  safePath(stateDir, true);
  safePath(resolvedStateDir, true);
  check(stateDir === resolvedStateDir, 'stateDir must equal native resolved STATE_DIR');
}

function names(context) {
  const pr = context.pr;
  return {
    receipt: `review-receipt-${pr}.json`, ledger: `findings-${pr}.json`, delivery: `review-delivery-${pr}.json`,
    ...(context.prescanEnabled ? { prescan: `prescan-artifact-${pr}.json`, prescanDelivery: `prescan-delivery-${pr}.json`, prescanRecord: `prescan-record-${pr}.json` } : {}),
    task: 'task.json', output: 'output.json', preflight: 'preflight.json',
  };
}

function jsonBytes(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  check(object(value), 'native artifact must be a JSON object');
  return value;
}

function readBounded(file) {
  safePath(file);
  check(fs.statSync(file).size <= MAX_FILE, 'file exceeds 10 MiB');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const storage = Buffer.alloc(MAX_FILE + 1);
    let length = 0;
    while (length < storage.length) {
      const read = fs.readSync(fd, storage, length, storage.length - length, null);
      if (read === 0) break;
      length += read;
    }
    check(length <= MAX_FILE, 'file exceeds 10 MiB');
    const bytes = storage.subarray(0, length);
    jsonBytes(bytes);
    return bytes;
  } finally { fs.closeSync(fd); }
}

function nativeIdentity(files, context) {
  const receipt = jsonBytes(files.receipt);
  check(receipt.headRefOid === context.headRefOid, 'receipt head mismatch');
  if (context.consumerResult === 'clean') {
    check(receipt.verdict === 'clean' && receipt.snapshotHash === context.snapshotHash, 'clean receipt identity mismatch');
    check(receipt.p0p1Count === 0 && receipt.source === 'consume-review-output', 'clean receipt is not native consumer evidence');
    for (const key of ['schemaVersion', 'outputHash', 'ledgerHash', 'escapeSourceHash', 'knownHazardsHash']) {
      check(typeof receipt[key] === 'string' && receipt[key].length > 0, `clean receipt missing ${key}`);
    }
  } else check(receipt.verdict !== 'clean', 'non-clean consumer cannot export clean receipt');
  const ledger = jsonBytes(files.ledger);
  check(ledger.version === 1 && Array.isArray(ledger.entries), 'invalid native ledger');
  const delivery = jsonBytes(files.delivery);
  check(delivery.version === 1 && Array.isArray(delivery.deliveries) && delivery.snapshotHash === context.snapshotHash, 'invalid native delivery');
}

export function exportReviewStateBundle({ stateDir, resolvedStateDir, artifacts, context }) {
  const identity = contextIdentity(context);
  stateRoot(stateDir, resolvedStateDir);
  check(object(artifacts) && Object.keys(artifacts).sort().join(',') === 'output,preflight,task', 'exact task/output/preflight artifacts required');
  const descriptors = [];
  const payload = {};
  const original = {};
  let total = 0;
  for (const [role, name] of Object.entries(names(identity))) {
    const sourcePath = artifacts[role] ?? path.join(stateDir, name);
    const bytes = readBounded(sourcePath);
    total += bytes.length;
    check(total <= MAX_TOTAL, 'bundle exceeds 50 MiB');
    original[role] = bytes;
    descriptors.push({ role, name, sourcePath, size: bytes.length, sha256: digest(bytes) });
    payload[role] = bytes.toString('base64');
  }
  nativeIdentity(original, identity);
  // Re-read after collection so concurrent native consumer writes cannot mix snapshots.
  for (const descriptor of descriptors) check(digest(readBounded(descriptor.sourcePath)) === descriptor.sha256, 'source changed during export');
  const manifest = { schemaVersion: 1, kind: 'native-review-state-bundle', context: identity, files: descriptors };
  const manifestJson = JSON.stringify(manifest);
  check(manifestJson.length <= 1024 * 1024, 'manifest exceeds 1 MiB');
  return { manifestJson, manifestDigest: digest(manifestJson), payload };
}

export function importReviewStateBundle({ bundle, stateDir, resolvedStateDir, artifactsDir, expectedManifestDigest, expectedIdentity }) {
  check(object(bundle) && typeof bundle.manifestJson === 'string' && bundle.manifestJson.length <= 1024 * 1024, 'bounded manifest required');
  check(sha(expectedManifestDigest) && digest(bundle.manifestJson) === expectedManifestDigest, 'verified manifest digest mismatch');
  const manifest = JSON.parse(bundle.manifestJson);
  check(manifest.schemaVersion === 1 && manifest.kind === 'native-review-state-bundle', 'unsupported bundle');
  const identity = contextIdentity(manifest.context);
  check(isDeepStrictEqual(identity, contextIdentity(expectedIdentity)), 'verified identity mismatch');
  stateRoot(stateDir, resolvedStateDir);
  safePath(artifactsDir, true);
  check(artifactsDir !== stateDir, 'native artifacts must have a separate directory');
  const allowed = names(identity);
  check(Array.isArray(manifest.files) && manifest.files.length === Object.keys(allowed).length && object(bundle.payload), 'incomplete files');
  check(Object.keys(bundle.payload).sort().join(',') === Object.keys(allowed).sort().join(','), 'unknown payload');
  const prepared = [];
  const original = {};
  const seen = new Set();
  let total = 0;
  for (const descriptor of manifest.files) {
    check(object(descriptor) && Object.hasOwn(allowed, descriptor.role) && !seen.has(descriptor.role) && descriptor.name === allowed[descriptor.role], 'unknown, duplicate or unsafe file');
    seen.add(descriptor.role);
    check(Number.isSafeInteger(descriptor.size) && descriptor.size >= 0 && descriptor.size <= MAX_FILE && sha(descriptor.sha256), 'invalid file bounds/hash');
    const encoded = bundle.payload[descriptor.role];
    check(typeof encoded === 'string' && encoded.length <= Math.ceil(MAX_FILE / 3) * 4, 'oversize payload');
    const bytes = Buffer.from(encoded, 'base64');
    check(bytes.toString('base64') === encoded && bytes.length === descriptor.size && digest(bytes) === descriptor.sha256, 'payload digest mismatch');
    total += bytes.length;
    check(total <= MAX_TOTAL, 'bundle exceeds 50 MiB');
    jsonBytes(bytes);
    original[descriptor.role] = bytes;
    const target = path.join(['task', 'output', 'preflight'].includes(descriptor.role) ? artifactsDir : stateDir, descriptor.name);
    if (fs.existsSync(target) || (() => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; } })()) {
      check(digest(readBounded(target)) === descriptor.sha256, 'refusing to overwrite existing native history');
    } else prepared.push({ target, bytes });
  }
  nativeIdentity(original, identity);
  const created = [];
  try {
    for (const { target, bytes } of prepared) {
      safePath(path.dirname(target), true);
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      created.push(target);
    }
  } catch (error) {
    for (const target of created.reverse()) fs.unlinkSync(target);
    throw error;
  }
  return { status: 'imported', manifestDigest: expectedManifestDigest, context: identity, fileCount: manifest.files.length,
    consumerReplayAllowed: false, nativePreMergeRequired: true };
}
