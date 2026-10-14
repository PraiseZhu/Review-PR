// deferrals.mjs — 审查问题转 issue 跟进:解析 PR 说明里登记的 issue,并按规则核验。纯函数,读 issue 由调用方注入。
// PR 作者决定把审查出的 P1 留到后续 PR 修时,开 issue 并在 PR 说明加「转 issue 跟进的审查问题」一节登记;
// 服务器只采用核验通过的条目,审查模型只能把同一问题的 P1 标到这些 issue 上,P0 不能转(维护者 2026-10-14 决定)。

export const DEFERRAL_HEADING = '转 issue 跟进的审查问题';
export const MAX_DEFERRALS = 10;

const HEADING_RE = /^(#{2,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const ANY_HEADING_RE = /^(#{1,6})[ \t]+/;
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/;
// 完整链接(issues/pull)或 [owner/repo]#N;#N 前面不能是字母数字、/、#、&、.、:、-(排除网页锚点和 HTML 实体)。
const REF_RE = /https?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\/(issues|pull)\/(\d{1,7})(?!\d)|(?<![\w/#&.:-])(?:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+))?#(\d{1,7})(?!\d)/g;

const clip = (text, max) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 从 PR 说明里取「转 issue 跟进的审查问题」一节(## 到 ####,标题文字精确匹配,只认第一处),
 * 到下一个同级或更高级标题为止。先去掉 HTML 注释(模板示例)、统一换行,跳过代码块。
 * 每个列表项取第一个不指向本 PR 的引用;本仓其他 PR 的 /pull/ 链接不算登记;没有引用的列表项忽略。
 * @returns {{found:boolean, entries:{issue:number, ref:string, text:string}[], rejected:{issue:number|null, ref:string, text:string, reason:string}[]}}
 */
export function parseDeferrals(body, { repo, pr }) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const self = String(repo).toLowerCase();
  const entries = [];
  const rejected = [];
  const seen = new Set();
  let found = false;
  let level = 0;
  let fence = false;
  for (const line of lines) {
    if (/^[ \t]*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (!found) {
      const heading = line.match(HEADING_RE);
      if (heading && heading[2] === DEFERRAL_HEADING) { found = true; level = heading[1].length; }
      continue;
    }
    const any = line.match(ANY_HEADING_RE);
    if (any && any[1].length <= level) break;
    const item = line.match(LIST_ITEM_RE);
    if (!item) continue;
    const text = clip(item[1], 300);
    let ref = null;
    for (const m of item[1].matchAll(REF_RE)) {
      const refRepo = m[1] ?? m[4] ?? repo;
      const number = Number(m[3] ?? m[5]);
      const sameRepo = refRepo.toLowerCase() === self;
      if (sameRepo && number === pr) continue;
      if (sameRepo && m[2] === 'pull') continue;
      ref = { raw: m[0], number, sameRepo };
      break;
    }
    if (!ref) continue;
    if (entries.length + rejected.length >= MAX_DEFERRALS) {
      rejected.push({ issue: ref.sameRepo ? ref.number : null, ref: ref.raw, text, reason: `超过 ${MAX_DEFERRALS} 项上限` });
      continue;
    }
    if (!ref.sameRepo) { rejected.push({ issue: null, ref: ref.raw, text, reason: '跨仓引用,只认本仓 issue' }); continue; }
    if (seen.has(ref.number)) { rejected.push({ issue: ref.number, ref: ref.raw, text, reason: '重复登记' }); continue; }
    seen.add(ref.number);
    entries.push({ issue: ref.number, ref: ref.raw, text });
  }
  return { found, entries, rejected };
}

/** issue 标题或正文是否提到本 PR:#<pr> 后面不跟数字,或本 PR 链接(不区分大小写)。 */
export function mentionsPr(text, { pr, prUrl }) {
  const s = String(text ?? '');
  if (new RegExp(`#${pr}(?!\\d)`).test(s)) return true;
  return Boolean(prUrl) && new RegExp(`${escapeRe(String(prUrl).replace(/\/+$/, ''))}(?!\\d)`, 'i').test(s);
}

/**
 * 逐条核验。readIssue(number) 返回 {ok:true, issue} 或 {ok:false, notFound?, error};抛错按读取失败记。
 * 只采用同时满足这些条件的:issue 在本仓(没被转移)、是 issue 不是 PR、OPEN、开 issue 的人是 PR 作者或维护者、
 * 标题或正文提到本 PR。
 * @returns {{verified:{issue:number, title:string, url:string, opener:string, text:string}[], rejected:{issue:number, ref:string, text:string, reason:string}[]}}
 */
export function verifyDeferrals({ entries, repo, pr, prUrl, author, maintainers, readIssue }) {
  const allowed = new Set([author, ...(maintainers ?? [])].map((login) => String(login ?? '').toLowerCase()).filter(Boolean));
  const repoSuffix = `/repos/${String(repo).toLowerCase()}`;
  const verified = [];
  const rejected = [];
  for (const entry of entries ?? []) {
    const reject = (reason) => rejected.push({ issue: entry.issue, ref: entry.ref, text: entry.text, reason });
    let read;
    try { read = readIssue(entry.issue); } catch (error) { read = { ok: false, error: error.message }; }
    if (!read?.ok) { reject(read?.notFound ? 'issue 不存在' : `读取失败:${clip(read?.error || '未知错误', 160)}`); continue; }
    const issue = read.issue ?? {};
    // gh api 会跟随转移后的跳转:issue 已转到别的仓时读到的是别仓的 issue。
    if (issue.repository_url && !String(issue.repository_url).toLowerCase().endsWith(repoSuffix)) { reject('issue 不在本仓(可能已转移)'); continue; }
    if (issue.pull_request) { reject('这是 PR,不是 issue'); continue; }
    if (String(issue.state ?? '').toLowerCase() !== 'open') { reject(`issue 不是 OPEN(${issue.state ?? '未知'})`); continue; }
    const opener = String(issue.user?.login ?? '');
    // 原因会写进 PR 上的报告:登录名包反引号、不带 @,免得提醒到无关的人。
    if (!allowed.has(opener.toLowerCase())) { reject(`开 issue 的 \`${opener || '(未知)'}\` 不是 PR 作者或维护者`); continue; }
    if (!mentionsPr(issue.title, { pr, prUrl }) && !mentionsPr(issue.body, { pr, prUrl })) {
      reject(`issue 标题和正文都没有提到本 PR(#${pr} 或 PR 链接)`);
      continue;
    }
    verified.push({ issue: entry.issue, title: clip(issue.title, 200), url: String(issue.html_url ?? ''), opener, text: entry.text });
  }
  return { verified, rejected };
}

/** 把 `gh api repos/<repo>/issues/<n>` 的 run() 结果转成 readIssue 的返回值。 */
export function toIssueRead(result) {
  if (result?.ok) {
    try { return { ok: true, issue: JSON.parse(result.stdout) }; } catch (error) { return { ok: false, error: `返回不是 JSON:${error.message}` }; }
  }
  const detail = String(result?.stderr || result?.error || '').trim();
  return { ok: false, notFound: /HTTP 404|HTTP 410|Not Found|Gone/i.test(detail), error: detail.split('\n').at(-1) || '未知错误' };
}

/** 已转 issue 的问题摘要;没有时返回 null。 */
export function toDeferredSummary(deferred) {
  const list = deferred ?? [];
  if (!list.length) return null;
  const issues = [...new Set(list.map((f) => f.deferredTo))].sort((a, b) => a - b);
  return { count: list.length, issues, text: `${list.length} 条 P1 已转 issue 跟进(${issues.map((n) => `#${n}`).join('、')})` };
}
