import { gh, git } from './lib.mjs';

const DIFF_TOO_LARGE = /\bPullRequest\.diff\s+too_large\b|diff exceeded the maximum number of (?:lines|files)\b/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export function readPrDiff({ repo, pr, meta }, { github = gh, localGit = git } = {}) {
  try {
    return github(['pr', 'diff', String(pr), '--repo', repo], { timeoutMs: 120_000, readOnly: true }).stdout ?? '';
  } catch (error) {
    if (!DIFF_TOO_LARGE.test(String(error?.message ?? error))) throw error;
    try {
      const { baseRefOid, headRefOid } = meta ?? {};
      if (!COMMIT_SHA.test(baseRefOid ?? '') || !COMMIT_SHA.test(headRefOid ?? '')) {
        throw new Error('本地 diff 需要本轮固定的完整 head/base SHA');
      }
      const runGit = (args) => localGit(args, { timeoutMs: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' } }).stdout.trim();
      const shallow = runGit(['rev-parse', '--is-shallow-repository']) === 'true';
      runGit(['fetch', '--no-write-fetch-head', '--no-tags', '--no-prune', '--no-prune-tags',
        '--no-recurse-submodules', '--no-auto-gc', '--refmap=',
        ...(shallow ? ['--unshallow'] : []), 'origin', baseRefOid, headRefOid]);
      if (runGit(['rev-parse', '--is-shallow-repository']) !== 'false') {
        throw new Error('本地历史仍不完整，不能生成可信的 PR diff');
      }
      const mergeBase = runGit(['merge-base', '--all', baseRefOid, headRefOid]);
      if (!COMMIT_SHA.test(mergeBase)) throw new Error('本地 diff 无法确定唯一 merge-base');
      return localGit(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
        '--no-relative', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short',
        '--ignore-submodules=none', '--unified=3', '--output-indicator-new=+', '--output-indicator-old=-',
        '--output-indicator-context= ', mergeBase, headRefOid, '--'], { timeoutMs: 120_000,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } }).stdout;
    } catch (fallbackError) {
      throw new Error('GitHub diff 读取失败：' + error.message + '\n本地 diff 兜底失败：' + fallbackError.message, { cause: fallbackError });
    }
  }
}
