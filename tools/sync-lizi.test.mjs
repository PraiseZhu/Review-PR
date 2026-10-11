import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTrees, isExcluded } from './sync-lizi.mjs';

const manifest = {
  excluded: ['review-pr/history/', 'review-pr/EVOLUTION.md'],
  patched: ['review-pr/scripts/lib.mjs'],
  added: ['review-pr/scripts/mivo-patches.test.mjs'],
};
const tree = (entries) => ({ files: Object.keys(entries).sort(), read: (file) => Buffer.from(entries[file]) });

test('只有登记过的补丁与新增文件时没有违规', () => {
  const upstream = tree({ 'review-pr/scripts/lib.mjs': 'a', 'review-pr/SKILL.md': 's', 'review-pr/history/x.json': 'h', 'review-pr/EVOLUTION.md': 'e' });
  const local = tree({ 'review-pr/scripts/lib.mjs': 'a+mivo', 'review-pr/SKILL.md': 's', 'review-pr/scripts/mivo-patches.test.mjs': 't' });
  assert.deepEqual(compareTrees({ upstreamFiles: upstream.files, localFiles: local.files, manifest,
    readUpstream: upstream.read, readLocal: local.read }), []);
});

test('未登记的改动、未登记的新增、缺失和误带回的排除路径都会报出', () => {
  const upstream = tree({ 'review-pr/scripts/lib.mjs': 'a', 'review-pr/SKILL.md': 's', 'review-pr/scripts/gone.mjs': 'g' });
  const local = tree({ 'review-pr/scripts/lib.mjs': 'a', 'review-pr/SKILL.md': 's-changed', 'review-pr/extra.mjs': 'x', 'review-pr/EVOLUTION.md': 'e' });
  const kinds = compareTrees({ upstreamFiles: upstream.files, localFiles: local.files, manifest,
    readUpstream: upstream.read, readLocal: local.read }).map((p) => `${p.kind}:${p.file}`).sort();
  assert.deepEqual(kinds, [
    'excluded-path-present:review-pr/EVOLUTION.md',
    'missing-locally:review-pr/scripts/gone.mjs',
    'registered-addition-missing:review-pr/scripts/mivo-patches.test.mjs',
    'registered-but-identical:review-pr/scripts/lib.mjs',
    'unregistered-addition:review-pr/extra.mjs',
    'unregistered-change:review-pr/SKILL.md',
  ]);
});

test('排除规则:目录前缀与精确文件', () => {
  assert.equal(isExcluded('review-pr/history/a/b.json', manifest.excluded), true);
  assert.equal(isExcluded('review-pr/EVOLUTION.md', manifest.excluded), true);
  assert.equal(isExcluded('review-pr/EVOLUTION.md.bak', manifest.excluded), false);
});
