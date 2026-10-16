// bypass.mjs — 绕过必需检查合入、又没写原因的 PR:判定该提醒谁(纯函数)。
// 读写 GitHub 的部分在 mivo/prereview/bypass-reason.mjs。规则在 Mivo docs/loops/review-pr-setup.md「紧急强合」:
// 强合前要在 PR 上写一条评论说明原因(为什么紧急、跳过哪几项检查或条件、谁决定的)。
// 判定数据用 GitHub 规则集自己记的绕过记录(rule suite 的 result === 'bypass'),不维护「谁能强合」的名单。

export const REMINDER_MARKER = '<!-- mivo-bypass-reminder -->';
// 评论里出现其中任一词就算写了原因;宁可漏提醒,不误提醒(漏发只是少一次提醒,不影响审查)。
const REASON_RE = /绕过|强合|bypass|三审/i;
const MACHINE_MARK = '<!-- mivo-';

const loginOf = (comment) => String(comment?.user?.login ?? comment?.login ?? '');
const isBot = (comment) => comment?.user?.type === 'Bot' || /\[bot\]$/i.test(loginOf(comment));

/**
 * PR 上是否已经有人写了绕过原因:任意一条评论同时满足
 * ① 作者不是 bot(登录名不以 [bot] 结尾);② 正文不含 `<!-- mivo-` 机器暗记(含本提醒自己的暗记);③ 正文匹配关键词。
 */
export function hasBypassReason(comments) {
  return (comments ?? []).some((comment) => {
    const body = String(comment?.body ?? '');
    return loginOf(comment) !== '' && !isBot(comment) && !body.includes(MACHINE_MARK) && REASON_RE.test(body);
  });
}

/** 规则集记录里要关心的:合入 main、结果是绕过、发生在上线(since)以后。其它记录静默忽略。 */
export function selectBypassSuites({ suites, since }) {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return [];
  return (suites ?? []).filter((suite) => suite?.result === 'bypass' && suite.ref === 'refs/heads/main'
    && Date.parse(suite.pushed_at) >= sinceMs && typeof suite.after_sha === 'string' && suite.after_sha !== '')
    .sort((a, b) => Date.parse(a.pushed_at) - Date.parse(b.pushed_at));
}

/**
 * @param suites 规则集记录(rule-suites 接口的原样数组:result、ref、after_sha、actor_name、pushed_at)
 * @param prBySha { <after_sha>: <PR 号> },找不到 PR 的记录不放进来
 * @param commentsByPr { <PR 号>: 评论数组(REST 形状:user.login、body) }
 * @param reminded { <PR 号>: {...} } 已经提醒过的
 * @returns {{ remind: {pr, actor, sha, at}[], skipped: {pr, sha, why}[] }}
 */
export function toBypassReminders({ suites, prBySha = {}, commentsByPr = {}, reminded = {}, since, maxPerRun = 5 }) {
  const remind = [];
  const skipped = [];
  const seen = new Set();
  for (const suite of selectBypassSuites({ suites, since })) {
    const sha = suite.after_sha;
    const pr = prBySha[sha];
    if (!pr) { skipped.push({ pr: null, sha, why: 'no-pr' }); continue; }
    if (seen.has(pr)) { skipped.push({ pr, sha, why: 'duplicate' }); continue; }
    seen.add(pr);
    if (Object.hasOwn(reminded, String(pr))) { skipped.push({ pr, sha, why: 'reminded' }); continue; }
    if (hasBypassReason(commentsByPr[pr])) { skipped.push({ pr, sha, why: 'has-reason' }); continue; }
    if (remind.length >= maxPerRun) { skipped.push({ pr, sha, why: 'over-limit' }); continue; }
    remind.push({ pr, actor: String(suite.actor_name ?? ''), sha, at: suite.pushed_at });
  }
  return { remind, skipped };
}

/** 提醒评论正文:@ 绕过的人,说明缺什么、要补什么;末尾带暗记,让「已有原因」的判定认得出它不是原因。 */
export function toReminderBody({ actor }) {
  return `@${actor} 这个 PR 是绕过必需检查合入的（GitHub 规则集记为 bypass），PR 上还没有原因说明。`
    + '按 docs/loops/review-pr-setup.md「紧急强合」，请在这里补一句：为什么绕过、跳过了哪几项检查、谁决定的（例如：本地三审已通过，记录见 …）。\n\n'
    + REMINDER_MARKER;
}
