// Explicit merge prerequisites and repository-qualified stacked branch evidence.
import { isGateBase } from './gate-bases.mjs'; // [MIVO-PATCH gate-bases]
const canonicalRepo = (repo) => String(repo ?? '').trim().toLowerCase();
const repositoryOf = (value) => typeof value === 'string' ? value : value?.nameWithOwner ?? value?.full_name ?? null;

function proseLines(body) {
  const lines = [];
  let fence = null;
  for (const line of String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (!fence) lines.push(line.replace(/(`+)[\s\S]*?\1/g, ''));
  }
  return lines;
}

const REF = /^(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#][^\s<>),;]*)?|([\w.-]+\/[\w.-]+)?#(\d+))(?![\w])/i;
function leadingReference(raw, repo) {
  let rest = raw.trimStart().replace(/^(?:(?:pull\s+requests?|prs?)\b|PR)\s*[:：]?\s*/i, '');
  const link = /^\[[^\]]*\]\(\s*(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+[^\s)]*)\s*\)/i.exec(rest);
  const wrapped = !link && /^<(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+[^\s>]*)>/i.exec(rest);
  const match = REF.exec(link?.[1] ?? wrapped?.[1] ?? rest);
  if (!match) return null;
  const number = Number(match[2] || match[4]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { ref: `${canonicalRepo(match[1] || match[3] || repo)}#${number}`,
    rest: rest.slice(link ? link[0].length : wrapped ? wrapped[0].length : match[0].length) };
}

// A positive dependency clause consumes only its immediately following reference
// list. "Depends on #1; fixes #2" must never turn issue #2 into a prerequisite.
export function explicitDependencies(body, repo) {
  const found = new Set();
  for (const line of proseLines(body)) {
    const markers = line.matchAll(/\b(?:depends\s+on|blocked\s+by)\b|依赖(?:于)?|基于/gi);
    for (const marker of markers) {
      const prefix = line.slice(0, marker.index).split(/[;；。.!?！？]/).at(-1);
      if (/(?:\b(?:not|never|no\s+longer|no\s+need\s+to|doesn['’]t|isn['’]t|is\s+not)\s+(?:currently\s+)?|(?:不再|不需要|无需|没有|不是|并非|不|未|无)(?:直接|继续)?\s*)$/i.test(prefix)) continue;
      let rest = line.slice(marker.index + marker[0].length).replace(/^\s*[:：]?\s*/, '');
      for (;;) {
        const item = leadingReference(rest, repo);
        if (!item) break;
        found.add(item.ref);
        const separator = /^\s*(?:[,，、]\s*(?:(?:and|or)\b\s*)?|(?:and|or)\b\s*|[和及与]\s*|&\s*)/i.exec(item.rest);
        if (!separator) break;
        rest = item.rest.slice(separator[0].length);
      }
    }
  }
  return [...found];
}

// [MIVO-PATCH gate-bases] 快照里同仓、head 分支为 branch 的其它 PR;叠放判定与门禁组 PR 识别共用。
export function headBranchPrs({ repo, pr, branch, snapshot = [] }) {
  return snapshot.filter((parent) => parent.number !== pr && parent.headRefName === branch &&
    canonicalRepo(repositoryOf(parent.headRepository)) === canonicalRepo(repo));
}

export function stackedBaseDependencies({ repo, pr, baseRefName, defaultBranch, snapshot = [], gateBases = [] }) {
  if (!defaultBranch || !baseRefName || baseRefName === defaultBranch) return [];
  // [MIVO-PATCH gate-bases] 门禁分支(如 integration/*)的 PR 不按叠放处理。
  if (isGateBase(baseRefName, gateBases)) return [];
  return headBranchPrs({ repo, pr, branch: baseRefName, snapshot });
}

// [MIVO-PATCH gate-bases] 门禁分支:basePr 置空、不 retarget,组 PR 另存 gateGroupPr(只用来丢弃指向它的显式依赖)。
// 非门禁分支与默认分支原样返回。
export function applyGateBase({ lookup, baseRefName, defaultBranch, gateBases = [] }) {
  const gateBase = Boolean(defaultBranch) && baseRefName !== defaultBranch && isGateBase(baseRefName, gateBases);
  if (!gateBase) return { gateBase: false, basePr: lookup.basePr, gateGroupPr: null, needsRetarget: lookup.needsRetarget };
  return { gateBase: true, basePr: null, gateGroupPr: lookup.basePr ?? null, needsRetarget: false };
}

// Rows are the complete REST pull-request listing for the target owner:branch.
// Null head.repo means a deleted source repository, not the still-live base repo.
export function classifyBasePrLookup({ repo, pr, baseRefName, defaultBranch, pulls }) {
  if (!defaultBranch || !baseRefName) throw new Error('默认分支或 base 分支未完整读取');
  if (baseRefName === defaultBranch) return { verified: true, reason: 'default-branch', basePr: null, needsRetarget: false };
  if (!Array.isArray(pulls)) throw new Error('base PR 查询未返回完整列表');
  const matching = pulls.filter((pull) => {
    if (!Number.isSafeInteger(pull?.number) || !pull?.head || typeof pull.head.ref !== 'string' || pull.head.repo === undefined ||
        (pull.head.repo !== null && !repositoryOf(pull.head.repo))) {
      throw new Error('base PR 查询缺少 head 仓库归属');
    }
    return pull.number !== pr && pull.head.ref === baseRefName &&
      canonicalRepo(repositoryOf(pull.head.repo)) === canonicalRepo(repo);
  }).sort((a, b) => b.number - a.number);
  // A newer open PR on a reused branch is the current prerequisite; an older
  // merged PR must not hide it. Otherwise retain the latest historical PR.
  const picked = matching.find((pull) => String(pull.state).toUpperCase() === 'OPEN') ?? matching[0];
  if (!picked) return { verified: true, reason: 'no-associated-pr', basePr: null, needsRetarget: false };
  const state = picked.merged_at ? 'MERGED' : String(picked.state).toUpperCase();
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) throw new Error('base PR 状态未完整读取');
  return { verified: true, reason: 'associated-pr', needsRetarget: state === 'MERGED',
    basePr: { number: picked.number, state, mergedAt: picked.merged_at ?? null,
      url: picked.html_url ?? null, headRepository: repositoryOf(picked.head.repo), headRefName: picked.head.ref } };
}

export function collectDependencyRefs({ repo, candidate, snapshot, meta, gateBases = [] }) { // [MIVO-PATCH gate-bases]
  if (!meta?.defaultBranch || !meta.baseRefName) throw new Error('默认分支或 base 分支未完整读取');
  if (meta.baseRefName !== meta.defaultBranch && meta.basePrLookup?.verified !== true) {
    throw new Error(`非默认 base 的依赖查询失败：${meta.basePrLookup?.error || '未取得完整查询证据'}`);
  }
  // [MIVO-PATCH gate-bases] 门禁分支:丢弃指向组 PR(开着/已关闭/已合并)的显式依赖,兄弟 PR 与别仓依赖照旧。
  const gate = meta.baseRefName !== meta.defaultBranch && isGateBase(meta.baseRefName, gateBases);
  const groupRefs = new Set();
  if (gate) {
    const groupNumbers = [...headBranchPrs({ repo, pr: candidate.number, branch: meta.baseRefName, snapshot }).map((p) => p.number),
      meta.gateGroupPr?.number, meta.basePr?.number];
    for (const number of groupNumbers) if (Number.isSafeInteger(number)) groupRefs.add(`${canonicalRepo(repo)}#${number}`);
  }
  const refs = new Set(explicitDependencies(meta.body, repo).filter((ref) => !groupRefs.has(ref)));
  // Keep snapshot-open prerequisites even if a parent merges or the child is
  // retargeted while full contexts are collected. They re-enter next round.
  for (const parent of stackedBaseDependencies({ repo, pr: candidate.number,
    baseRefName: candidate.baseRefName, defaultBranch: meta.defaultBranch, snapshot, gateBases })) { // [MIVO-PATCH gate-bases]
    refs.add(`${canonicalRepo(repo)}#${parent.number}`);
  }
  if (!gate && meta.baseRefName !== meta.defaultBranch && meta.basePr) refs.add(`${canonicalRepo(repo)}#${meta.basePr.number}`); // [MIVO-PATCH gate-bases]
  return [...refs];
}
