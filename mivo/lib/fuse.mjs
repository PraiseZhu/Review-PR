// fuse.mjs — 审查熔断(PraiseZhu/Review-PR#209,总 issue #208):一个 PR 被服务器审过 N 个代码版本还没放行,就停止自动送审,
// 开「审查熔断 · PR #<n>」issue 等人来看;PR 作者或维护者在 issue 下回一整行「继续审」后,版本数从 0 重新算。
// 熔断只停审、不放行:review-pr 不写成通过,合并照旧被挡。
//
// 「代码版本」按 PR 自身改动指纹算(服务器结果里的 mivo.filePatchHashesV2 / filePatchHashes):同一 head 重复审、
// 只合了 main(PR 自身的 +/- 行没变)指纹相同,不重复计;拿不到指纹就用 head,证明不了只合 main 的照样计入。
// 上线前的历史:PR 还没有 fuse 记录时,用 reviews.json 里已有的 completedRuns 的 head 补,每个 head 算一版。
// 纯函数,无 I/O;读写 GitHub 与 reviews.json 在 mivo/prereview/round.mjs。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const FUSE_ISSUE_PREFIX = '审查熔断 · PR #';
export const FUSE_MARKER_RE = /<!-- mivo-fuse pr=(\d+) -->/;
const MAX_KEPT_VERSIONS = 200;
// 否定说法:「先别继续审」「不要继续审」这类回复不算恢复。
const RESUME_NEGATION_RE = /不\s*继续|不\s*要\s*继续|先\s*别|别\s*审|暂\s*不|先\s*不要|不\s*用\s*审|不\s*再\s*审/;
const TRAILING_PUNCT_RE = /[。.!！~～\s]+$/;

/**
 * 读规则文件里的 convergeFuse 与维护者名单。没配 convergeFuse 或 enabled 不是 true 时熔断关闭(上游夹具配置不受影响)。
 * 配了就必须合法,填错启动即报错,不悄悄回落。
 */
export function loadFuseConfig(rulesFile) {
  return toFuseConfig(JSON.parse(readFileSync(rulesFile, 'utf8')));
}

export function toFuseConfig(rules) {
  const fuse = rules?.convergeFuse;
  const maintainers = (Array.isArray(rules?.maintainerAllowlist) ? rules.maintainerAllowlist : []).map((login) => String(login).toLowerCase());
  if (!fuse || fuse.enabled !== true) return { enabled: false, maxVersions: null, resumeLine: null, maintainers };
  if (!Number.isInteger(fuse.maxVersions) || fuse.maxVersions < 2 || fuse.maxVersions > 100) {
    throw new Error(`convergeFuse.maxVersions 须是 2–100 的整数:${JSON.stringify(fuse.maxVersions)}`);
  }
  const resumeLine = String(fuse.resumeLine ?? '').trim();
  if (!resumeLine) throw new Error('convergeFuse.resumeLine 不能为空');
  return { enabled: true, maxVersions: fuse.maxVersions, resumeLine, maintainers };
}

const isFilled = (value) => value && typeof value === 'object' && Object.keys(value).length > 0;

/** 服务器结果 → 这一版的 PR 自身改动指纹。优先 v2(区分删除与空文件),没有就 v1,都没有就用 head。 */
export function toVersionFingerprint(server) {
  const hashes = isFilled(server?.mivo?.filePatchHashesV2) ? server.mivo.filePatchHashesV2
    : isFilled(server?.mivo?.filePatchHashes) ? server.mivo.filePatchHashes : null;
  if (!hashes) return `head:${server?.head ?? ''}`;
  const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `patch:${createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 24)}`;
}

/** 服务器结果里还没解决的问题按等级计数(只数 P0/P1/P2)。 */
export function toFindingCounts(server) {
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const finding of Array.isArray(server?.mivo?.findings) ? server.mivo.findings : []) {
    if (finding?.severity in counts) counts[finding.severity] += 1;
  }
  return counts;
}

/** reviews.json 里这个 PR 的版本历史;还没有 fuse 记录时用 completedRuns 的 head 补(seeded,没有时间,排在最前)。 */
export function selectFuseVersions(record) {
  if (Array.isArray(record?.fuse?.versions)) return record.fuse.versions;
  return Object.keys(record?.completedRuns ?? {}).map((head) => ({ fp: `head:${head}`, head, seeded: true }));
}

/** 收回一次真正完成的审查后,这个 PR 的 fuse 记录(不改入参)。 */
export function withFuseVersion(record, { fp, head, at, findings }) {
  const versions = [...selectFuseVersions(record), { fp, head, at }].slice(-MAX_KEPT_VERSIONS);
  return { ...(record?.fuse ?? {}), versions, lastFindings: findings ?? record?.fuse?.lastFindings ?? null };
}

/**
 * 从上次「继续审」之后,一共审过几个代码版本。指纹第一次出现才算一版;「继续审」之前出现过的指纹,之后再出现也不算
 * (恢复后作者没改代码、或只合了 main)。seeded 的版本没有时间,视为在任何一次「继续审」之前。
 */
export function toFuseCount({ versions = [], resumedAt = null }) {
  const seen = new Set();
  let count = 0;
  for (const version of versions) {
    const afterResume = !resumedAt || Date.parse(version.at) > Date.parse(resumedAt);
    if (afterResume && !seen.has(version.fp)) count += 1;
    seen.add(version.fp);
  }
  return count;
}

/**
 * 判门要派审时问一句:这个 head 要不要熔断。审过的版本数达到上限、当前 head 也不是审查通过的 head 才熔断。
 * 已经熔断(fuse.trip 在)时,不管版本数,一直停到有人回「继续审」。
 */
export function toFuseDecision({ record, head, maxVersions }) {
  const fuse = record?.fuse ?? {};
  const count = toFuseCount({ versions: selectFuseVersions(record), resumedAt: fuse.resumedAt ?? null });
  if (fuse.trip) return { tripped: true, count, trip: fuse.trip };
  const tripped = Number.isInteger(maxVersions) && count >= maxVersions && record?.cleanHead !== head;
  return { tripped, count, trip: null };
}

/** 收回结果时:这一版审完就到上限且没放行,下一轮要重判一次,好让判门开熔断 issue(否则要等作者再推才看得到)。 */
export function shouldWakeForFuse({ record, reviewClean, maxVersions }) {
  if (reviewClean || !Number.isInteger(maxVersions) || record?.fuse?.trip) return false;
  return toFuseCount({ versions: selectFuseVersions(record), resumedAt: record?.fuse?.resumedAt ?? null }) >= maxVersions;
}

/**
 * 熔断 issue 下第一条有效的「继续审」。有效:没被折叠;不是流程评论(不含 HTML 注释标记);有一整行恰好是 resumeLine
 * (允许行尾标点);全文没有否定说法;评论人是维护者或 PR 作者;发在熔断之后。comments 是 GraphQL 的 issue 评论节点。
 */
export function findResumeComment({ comments = [], maintainers = [], author = '', resumeLine, since = null }) {
  const allowed = new Set([...maintainers.map((login) => String(login).toLowerCase()), String(author ?? '').toLowerCase()].filter(Boolean));
  const ordered = [...comments].sort((a, b) => (Date.parse(a?.createdAt) || 0) - (Date.parse(b?.createdAt) || 0));
  for (const comment of ordered) {
    const body = String(comment?.body ?? '');
    const login = String(comment?.author?.login ?? '').toLowerCase();
    if (comment?.isMinimized || !login || !allowed.has(login) || body.includes('<!--')) continue;
    if (since && !(Date.parse(comment.createdAt) >= Date.parse(since))) continue;
    if (RESUME_NEGATION_RE.test(body)) continue;
    if (!body.split(/\r?\n/).some((line) => line.trim().replace(TRAILING_PUNCT_RE, '') === resumeLine)) continue;
    return { login: comment.author.login, at: comment.createdAt, id: comment.databaseId ?? null };
  }
  return null;
}

/** 熔断 issue 的标题与正文。正文首行是去重 / 归属标记,round.mjs 也靠标题前缀唤醒(admission.mjs toHeldWake)。 */
export function toFuseIssue({ pr, title = '', url = '', author = '', count, maxVersions, findings = null, resumeLine }) {
  const f = findings ?? {};
  const open = findings ? `最近一版还有 P0 ${f.P0 ?? 0} 条、P1 ${f.P1 ?? 0} 条、P2 ${f.P2 ?? 0} 条问题没解决` : '最近一版还没有放行';
  const prRef = url ? `[PR #${pr}](${url})` : `PR #${pr}`;
  const lines = [
    `<!-- mivo-fuse pr=${pr} -->`,
    `${prRef}${title ? `「${title}」` : ''}已经被服务器审查审过 ${count} 个代码版本，${open}。审查机先停止自动送审。`,
    '',
    `这不是放行：\`review-pr\` 不会写成通过，合并仍被挡住。改到第 ${maxVersions} 版还没收敛，多半是在原地打转，需要人来看一下${author ? `（作者 @${author}）` : ''}。`,
    '',
    '「代码版本」按 PR 自身的改动算：同一版代码重复审只算一次，只合了 main 的提交不算。',
    '',
    '### 怎么处理',
    '',
    `- **继续审**：PR 作者或维护者在本 issue 下回复一整行「${resumeLine}」。审查机下一轮（约 3 分钟内）恢复送审，版本数从 0 重新算，再满 ${maxVersions} 版会再停。`,
    `- **剩下的问题不打算修**：在对应讨论串回复「维护者裁定不改：<理由>」（只对 P1 有效），或按「审查问题转 issue 跟进」登记，再回「${resumeLine}」。`,
    '- **方案要重做**：关闭这个 PR，另开新 PR。',
    '',
    `「${resumeLine}」要本人回复，agent 不得代写。`,
  ];
  return { title: `${FUSE_ISSUE_PREFIX}${pr}：审到第 ${count} 版还没放行`, body: `${lines.join('\n')}\n` };
}

/** 恢复送审时关熔断 issue 留的一句话。 */
export function toFuseResumeComment({ login, resumeLine }) {
  return `收到 @${login} 的「${resumeLine}」，恢复自动送审，版本数从 0 重新算。`;
}
