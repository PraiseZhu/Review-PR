import { createHash } from 'node:crypto';
import { classifyBasePrLookup } from './review-dependencies.mjs';

export function targetBranchFingerprint({ baseRefName, defaultBranch, basePr }) {
  if (!baseRefName || !defaultBranch || baseRefName === defaultBranch ||
      !Number.isSafeInteger(basePr?.number) || basePr.number <= 0 ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(basePr.state)) {
    throw new Error('目标分支提醒缺少有效的 stacked PR 证据');
  }
  // Ordinary pushes and CI updates do not warrant another comment. A parent
  // merging does: the author's next step changes from waiting to retargeting.
  return createHash('sha256').update(JSON.stringify([baseRefName, defaultBranch,
    basePr.number, basePr.state, basePr.mergedAt ?? null])).digest('hex');
}

export function targetBranchMarker(fingerprint) {
  if (!/^[0-9a-f]{64}$/.test(fingerprint ?? '')) throw new Error('目标分支提醒指纹无效');
  return `<!-- review-pr:target-branch fingerprint=${fingerprint} -->`;
}

const code = (value) => `<code>${String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</code>`;

export function targetBranchBody({ author, baseRefName, defaultBranch, basePr, reviewOnly = false }) {
  const mention = author ? `@${author} ` : '';
  const target = code(defaultBranch);
  const opening = `${mention}这个 PR 当前的目标分支是 ${code(baseRefName)}，最终需要合入 ${target}，改动才会进入主干。`;
  let action;
  if (basePr.state === 'MERGED') {
    action = `父 PR #${basePr.number} 已合并，但本 PR 的目标分支尚未调整，自动审查/合并因此跳过。` +
      `请在 PR 页面 Edit 中将 base 改为 ${target}，核对 Files changed 只包含预期改动；` +
      `如有冲突或旧的父分支提交残留，请整理分支并重新推送，确认针对 ${target} 的 CI 通过。`;
  } else if (basePr.state === 'OPEN') {
    action = `这是依赖父 PR #${basePr.number} 的 stacked PR，自动流程会等待父 PR 合并。` +
      `如果这是有意拆分的依赖，请先完成父 PR；父 PR 合并后确认本 PR 的 base 已改为 ${target}，再核对差异和 CI。` +
      `如果目标分支选错且没有这项依赖，请将 base 改为 ${target}。`;
  } else {
    action = `父 PR #${basePr.number} 已关闭但未合并，这项依赖尚未满足，自动流程会跳过。` +
      `请确认父 PR 是否还需合入；若已不再依赖它，请整理本分支并将 base 改为 ${target}，核对差异和 CI。`;
  }
  const ending = reviewOnly
    ? '本轮为 review-only；调整后可重新运行复审，该模式不会主动合并。'
    : '调整后，下一轮自动流程会重新检查差异、CI 和审查条件；满足合并条件后才会合入。';
  return `${opening}\n\n${action}\n\n${ending}\n\n${targetBranchMarker(targetBranchFingerprint({ baseRefName, defaultBranch, basePr }))}`;
}

// Inject the GitHub boundary for offline behavioral tests. This reads all comment
// pages rather than relying on machine-local state, so restarts retain deduplication.
export function notifyTargetBranch({ owner, repo, pr, expectedHead, expectedBaseRef, reviewOnly = false, dryRun = false }, api) {
  const slug = `${owner}/${repo}`;
  const read = () => {
    const meta = api.ghJson(['pr', 'view', String(pr), '--repo', slug, '--json', 'state,isDraft,author,headRefOid,baseRefName']);
    if (!meta?.state || !meta.headRefOid || !meta.baseRefName || typeof meta.isDraft !== 'boolean') throw new Error('PR 元数据不完整');
    if (meta.state !== 'OPEN' || meta.isDraft || (expectedHead && meta.headRefOid !== expectedHead) ||
        (expectedBaseRef && meta.baseRefName !== expectedBaseRef)) return null;
    const defaultBranch = api.ghJson(['repo', 'view', slug, '--json', 'defaultBranchRef'])?.defaultBranchRef?.name;
    if (!defaultBranch) throw new Error('默认分支未完整读取');
    if (meta.baseRefName === defaultBranch) return null;
    const pulls = api.fetchRestPages(`repos/${slug}/pulls?state=all&head=${encodeURIComponent(`${owner}:${meta.baseRefName}`)}`);
    const { basePr } = classifyBasePrLookup({ repo: slug, pr, baseRefName: meta.baseRefName, defaultBranch, pulls });
    if (!basePr) return null; // A verified long-lived base is not a stacked prerequisite.
    return { head: meta.headRefOid, author: meta.author?.login ?? '', baseRefName: meta.baseRefName, defaultBranch, basePr };
  };
  const current = read();
  const base = { ok: true, pr, mode: 'target-branch', posted: false };
  if (!current) return { ...base, reason: 'state-changed' };
  const fingerprint = targetBranchFingerprint(current);
  const receipt = { ...base, head: current.head, baseRefName: current.baseRefName, defaultBranch: current.defaultBranch, fingerprint };
  const viewer = String(api.ghJson(['api', 'user'])?.login ?? '').toLowerCase();
  if (!viewer) throw new Error('评论账号未完整读取');
  const comments = api.fetchRestPages(`repos/${slug}/issues/${pr}/comments`);
  const prior = comments.find((comment) => String(comment?.user?.login ?? '').toLowerCase() === viewer &&
    String(comment.body ?? '').includes(targetBranchMarker(fingerprint)));
  if (prior) return { ...receipt, reason: 'already-commented', url: prior.html_url };
  const body = targetBranchBody({ ...current, reviewOnly });
  if (dryRun) return { ...receipt, reason: 'dry-run', body };
  const fresh = read();
  if (!fresh || fresh.head !== current.head || targetBranchFingerprint(fresh) !== fingerprint) return { ...base, reason: 'state-changed' };
  const result = api.writeGh(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], { input: body, allowFail: true });
  if (!result.ok) return { ...receipt, ok: false, reason: 'comment-failed', error: String(result.stderr ?? '').trim().slice(0, 300) };
  return { ...receipt, posted: true, url: String(result.stdout ?? '').trim() };
}
