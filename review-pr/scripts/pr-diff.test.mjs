import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrDiff } from './pr-diff.mjs';

const tooLarge = new Error('HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)\nPullRequest.diff too_large');
const meta = { baseRefOid: 'a'.repeat(40), headRefOid: 'b'.repeat(40) };
const request = { repo: 'owner/repo', pr: 4347, meta };
const oversizedGithub = () => { throw tooLarge; };

function runGit(directory, args, options = {}) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true,
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result;
}

function gitFixture(testContext, shallow) {
  const directory = mkdtempSync(join(tmpdir(), 'review-pr-diff-'));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const remote = join(directory, 'remote.git');
  const client = join(directory, 'client');
  mkdirSync(source);
  const sourceGit = (args) => runGit(source, args).stdout.trim();
  sourceGit(['init', '--quiet', '--initial-branch=main']);
  sourceGit(['config', 'user.name', 'Diff Test']);
  sourceGit(['config', 'user.email', 'diff@example.com']);
  sourceGit(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(source, 'shared.txt'), 'shared\n');
  sourceGit(['add', '.']);
  sourceGit(['commit', '--quiet', '-m', 'shared ancestor']);
  const ancestor = sourceGit(['rev-parse', 'HEAD']);
  runGit(directory, ['clone', '--quiet', '--bare', source, remote]);
  runGit(directory, ['clone', '--quiet', ...(shallow ? ['--depth=1'] : []), pathToFileURL(remote).href, client]);
  sourceGit(['checkout', '--quiet', '-b', 'feature']);
  writeFileSync(join(source, 'large.txt'), Array.from({ length: 20_050 }, (_, index) => 'row ' + index).join('\n') + '\nlast line\n');
  sourceGit(['add', '.']);
  sourceGit(['commit', '--quiet', '-m', 'large PR']);
  const headRefOid = sourceGit(['rev-parse', 'HEAD']);
  sourceGit(['checkout', '--quiet', 'main']);
  writeFileSync(join(source, 'base-only.txt'), 'not part of the PR\n');
  sourceGit(['add', '.']);
  sourceGit(['commit', '--quiet', '-m', 'base advances separately']);
  const baseRefOid = sourceGit(['rev-parse', 'HEAD']);
  sourceGit(['push', '--quiet', remote, 'main', 'feature']);
  sourceGit(['checkout', '--quiet', 'feature']);
  writeFileSync(join(source, 'later.txt'), 'not part of the pinned head\n');
  sourceGit(['add', '.']);
  sourceGit(['commit', '--quiet', '-m', 'head advances after snapshot']);
  sourceGit(['push', '--quiet', remote, 'feature']);
  const clientGit = (args, options) => runGit(client, args, options);
  writeFileSync(join(client, 'shared.txt'), 'staged user edit\n');
  clientGit(['add', 'shared.txt']);
  writeFileSync(join(client, 'shared.txt'), 'unstaged user edit\n');
  writeFileSync(join(client, 'untracked.txt'), 'user data\n');
  writeFileSync(join(client, '.git', 'FETCH_HEAD'), 'preserve shared FETCH_HEAD\n');
  clientGit(['config', 'diff.external', 'must-not-execute']);
  clientGit(['config', 'color.diff', 'always']);
  clientGit(['config', 'diff.noprefix', 'true']);
  clientGit(['config', 'diff.outputIndicatorNew', '>']);
  clientGit(['config', 'diff.outputIndicatorOld', '<']);
  clientGit(['config', 'fetch.prune', 'true']);
  clientGit(['config', 'fetch.pruneTags', 'true']);
  clientGit(['update-ref', 'refs/remotes/origin/local-only', ancestor]);
  return { source, client, ancestor, meta: { headRefOid, baseRefOid }, clientGit };
}

test('successful API diff does not touch local Git', () => {
  const result = readPrDiff(request, {
    github: (args, options) => {
      assert.deepEqual(args, ['pr', 'diff', '4347', '--repo', 'owner/repo']);
      assert.equal(options.readOnly, true);
      return { stdout: 'complete API diff\n' };
    },
    localGit: () => assert.fail('local Git must not run'),
  });
  assert.equal(result, 'complete API diff\n');
});

test('authentication, network and unrelated 406 errors do not trigger fallback', () => {
  for (const message of ['HTTP 403: Forbidden', 'HTTP 406: unsupported media type', 'HTTP 503: unavailable', 'ETIMEDOUT']) {
    const error = new Error(message);
    assert.throws(() => readPrDiff(request, {
      github: () => { throw error; }, localGit: () => assert.fail('local Git must not run'),
    }), (actual) => actual === error);
  }
});

for (const shallow of [false, true]) {
  test('local fallback preserves full pinned PR diff and user state (shallow=' + shallow + ')', (testContext) => {
    const fixture = gitFixture(testContext, shallow);
    const snapshot = () => ({
      head: fixture.clientGit(['rev-parse', 'HEAD']).stdout,
      refs: fixture.clientGit(['for-each-ref', '--format=%(refname) %(objectname)']).stdout,
      index: fixture.clientGit(['ls-files', '--stage']).stdout,
      status: fixture.clientGit(['status', '--porcelain']).stdout,
      fetchHead: readFileSync(join(fixture.client, '.git', 'FETCH_HEAD'), 'utf8'),
      workingFile: readFileSync(join(fixture.client, 'shared.txt'), 'utf8'),
      untrackedFile: readFileSync(join(fixture.client, 'untracked.txt'), 'utf8'),
    });
    const before = snapshot();
    const diff = readPrDiff({ ...request, meta: fixture.meta }, { github: oversizedGithub, localGit: fixture.clientGit });
    assert.equal(diff, runGit(fixture.source, ['diff', '--no-renames', fixture.ancestor, fixture.meta.headRefOid, '--']).stdout);
    assert.ok(diff.split('\n').length > 20_000);
    assert.match(diff, /\+last line\n$/);
    assert.doesNotMatch(diff, /base-only|later\.txt|user edit/);
    assert.deepEqual(snapshot(), before);
    assert.equal(fixture.clientGit(['rev-parse', '--is-shallow-repository']).stdout.trim(), 'false');
  });
}

test('fallback rejects missing or non-immutable revisions before fetching', () => {
  for (const revision of [{}, { ...meta, headRefOid: 'feature' }, { ...meta, baseRefOid: '--all' }]) {
    assert.throws(() => readPrDiff({ ...request, meta: revision }, {
      github: oversizedGithub, localGit: () => assert.fail('local Git must not run'),
    }), /完整 head\/base SHA/);
  }
});

test('fallback preserves the original API error and local fetch failure', () => {
  let fetchCount = 0;
  assert.throws(() => readPrDiff(request, {
    github: oversizedGithub,
    localGit: (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'false\n' };
      assert.equal(args[0], 'fetch');
      fetchCount++;
      throw new Error('fetch access denied');
    },
  }), (error) => /HTTP 406/.test(error.message) && /本地 diff 兜底失败.*fetch access denied/.test(error.message));
  assert.equal(fetchCount, 1);
});

test('incomplete history or multiple merge bases never produce reusable diff', () => {
  for (const failure of ['shallow', 'multiple-merge-bases']) {
    assert.throws(() => readPrDiff(request, {
      github: oversizedGithub,
      localGit: (args) => {
        if (args[0] === 'fetch') return { stdout: '' };
        if (args[0] === 'rev-parse') return { stdout: failure === 'shallow' ? 'true\n' : 'false\n' };
        if (args[0] === 'merge-base') return { stdout: meta.baseRefOid + '\n' + meta.headRefOid + '\n' };
        assert.fail('diff must not run with incomplete or ambiguous history');
      },
    }), failure === 'shallow' ? /历史仍不完整/ : /唯一 merge-base/);
  }
});
