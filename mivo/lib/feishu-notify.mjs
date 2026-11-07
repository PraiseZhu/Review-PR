// feishu-notify.mjs — 审查熔断时用飞书「Mivo」机器人私聊 PR 作者(PraiseZhu/Review-PR#210,总 issue #208)。
// 接收人:作者的 GitHub 账号在组织名册里对到真人,用名册里的公司邮箱查飞书 open_id。名册仓默认是目标仓所属组织的 <owner>/org,
// convergeFuse.notify.rosterRepos 只作追加(#219);对不上(机器人账号、名册没有、名册读不到、飞书查不到)就转给 fallbackLogin,
// 正文前加一行说明。不按 GitHub 昵称或资料页邮箱猜人。
// 文案是用户 2026-11-07 确认的固定模板(#210「确认文案」),不调用模型。日志、结果包、issue 评论里不写邮箱和凭证。
// 拼文案、选接收人是纯函数;sendFuseNotice 只做 HTTP(fetch 由调用方注入,测试用假的)。
import { parseRosterLine } from '../../review-pr/scripts/lib.mjs';

const FEISHU_API = 'https://open.feishu.cn/open-apis';
export const FEISHU_STEP_TIMEOUT_MS = 10_000; // 每个请求的上限
export const FEISHU_TOTAL_TIMEOUT_MS = 30_000; // 整个发送过程(取 token、查作者、查兜底人、发消息)的硬上限(#210 SC4)

/** 规则文件里的 convergeFuse.notify。没配或 enabled 不是 true 就不发;配了就必须完整,填错启动即报错。 */
export function toFuseNotifyConfig(rules) {
  const notify = rules?.convergeFuse?.notify;
  if (!notify || notify.enabled !== true) return { enabled: false };
  for (const key of ['appId', 'keychainService', 'keychainAccount', 'fallbackLogin']) {
    if (typeof notify[key] !== 'string' || !notify[key].trim()) throw new Error(`convergeFuse.notify.${key} 不能为空`);
  }
  // rosterRepos 可省略或为空:名册仓默认按目标仓组织推导(toFuseRosterRepos),这里只是追加的名册。
  const rosterRepos = notify.rosterRepos ?? [];
  if (!Array.isArray(rosterRepos) || rosterRepos.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(String(r)))) {
    throw new Error(`convergeFuse.notify.rosterRepos 须是 owner/repo 数组:${JSON.stringify(notify.rosterRepos)}`);
  }
  return { enabled: true, appId: notify.appId.trim(), keychainService: notify.keychainService.trim(), keychainAccount: notify.keychainAccount.trim(),
    rosterRepos: rosterRepos.map(String), fallbackLogin: notify.fallbackLogin.trim() };
}

/** 要读的名册仓:目标仓所属组织的 <owner>/org 在前(缺名册时让人补的就是它),配置里的 rosterRepos 追加在后,不分大小写去重。 */
export function toFuseRosterRepos({ targetRepo, rosterRepos = [] }) {
  const owner = String(targetRepo ?? '').split('/')[0];
  const seen = new Set();
  const out = [];
  for (const repo of [owner ? `${owner}/org` : null, ...rosterRepos]) {
    if (!repo || seen.has(String(repo).toLowerCase())) continue;
    seen.add(String(repo).toLowerCase());
    out.push(String(repo));
  }
  return out;
}

/** 机器人账号:GitHub App 在 PR 作者里写成 app/<name>(gh 的返回),在评论等处写成 <name>[bot];没有账号也按机器人处理。 */
export function isBotLogin(login) {
  const text = String(login ?? '');
  return !text || /\[bot\]$/i.test(text) || /^app\//i.test(text);
}

/** 熔断通知转给兜底人时在熔断 issue 下留的一行说明;发给作者本人或作者是机器人(没法补名册)时返回 null。 */
export function toFuseForwardNote({ author, reason, to, rosterRepo }) {
  if (reason === 'not-in-roster') return `飞书通知已转给 @${to}：作者 @${author} 不在名册里，请补 ${rosterRepo} 名册。`;
  if (reason === 'feishu-user-not-found') return `飞书通知已转给 @${to}：作者 @${author} 在名册里的邮箱飞书查不到，请核对 ${rosterRepo} 名册。`;
  return null;
}

/** 熔断私聊正文。open 是最近一版未解决的 P0/P1/P2 总数(null / 0 时改说「还没有放行」);forwardedFrom 是对不上真人的作者账号。 */
export function toFuseNotifyText({ pr, title = '', count, open = null, prUrl, issueUrl, forwardedFrom = null }) {
  const lines = [
    ...(forwardedFrom ? [`PR #${pr} 的作者 @${forwardedFrom} 在名册里没找到对应的飞书账号，这条通知先转给你，麻烦帮忙看一下。`, ''] : []),
    `PR #${pr}${title ? `「${title}」` : ''}已经改到第 ${count} 版了，辛苦啦。我先把自动审查暂停一下，想请你来看看。`,
    '',
    `${Number(open) > 0 ? `最近这一版还有 ${open} 个问题没解决。` : '最近这一版还没有放行。'}来回改了这么多轮，可能换个思路会更快，所以先停下来等你拿主意。`,
    prUrl,
    '',
    '你可以按自己的判断选一种：',
    '· 想接着审：在熔断 issue 里回一行「继续审」就好，我会接着审，版本数从头算',
    '· 剩下的问题不打算修：可以请维护者在对应讨论串回「维护者裁定不改：理由」，或者转成 issue 以后再跟进，然后回「继续审」',
    '· 想换个方案：关掉这个 PR，重新开一个也完全没问题',
    '',
    `熔断 issue：${issueUrl}`,
    '',
    '处理好以后：',
    '· 在熔断 issue 里回「继续审」就行，我 3 分钟左右能看到',
    '· 飞书私信回复我这边收不到，回到 issue 里就好',
    '',
    '暂停期间这个 PR 先不会放行，等你回来我们再继续 😌',
  ];
  return lines.join('\n');
}

/** 名册正文(README 表格)里这个 GitHub 账号的公司邮箱;没有返回 null。按账号精确匹配,不分大小写。 */
export function selectRosterEmail(rosterTexts, login) {
  const want = String(login ?? '').toLowerCase();
  if (!want) return null;
  for (const text of rosterTexts ?? []) {
    for (const line of String(text).split(/\r?\n/)) {
      const row = parseRosterLine(line);
      if (row?.githubLogin && row.githubLogin.toLowerCase() === want && row.email) return row.email;
    }
  }
  return null;
}

/**
 * 发给谁:作者能在名册里对到邮箱就发作者;机器人账号(app/ 开头或 [bot] 结尾)或名册里没有就转给 fallbackLogin。
 * 返回 [{ login, email, forwardedFrom, reason }],按尝试顺序排(作者在前,兜底在后;作者就是兜底人时只有一项)。
 */
export function toFuseRecipients({ rosterTexts, author, fallbackLogin }) {
  const isBot = isBotLogin(author);
  const authorEmail = isBot ? null : selectRosterEmail(rosterTexts, author);
  const fallbackEmail = selectRosterEmail(rosterTexts, fallbackLogin);
  const out = [];
  if (authorEmail) out.push({ login: author, email: authorEmail, forwardedFrom: null, reason: null });
  if (String(author ?? '').toLowerCase() !== String(fallbackLogin).toLowerCase() && fallbackEmail) {
    out.push({ login: fallbackLogin, email: fallbackEmail, forwardedFrom: author || 'unknown', reason: isBot ? 'bot-author' : authorEmail ? 'feishu-user-not-found' : 'not-in-roster' });
  }
  return out;
}

async function postJson(fetchFn, url, body, token, total) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(FEISHU_STEP_TIMEOUT_MS), total]),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function fetchToken(fetchFn, appId, appSecret, total) {
  const auth = await postJson(fetchFn, `${FEISHU_API}/auth/v3/tenant_access_token/internal`, { app_id: appId, app_secret: appSecret }, null, total);
  const token = auth.data?.tenant_access_token;
  return auth.data?.code === 0 && token ? { token } : { code: `token-${auth.data?.code ?? auth.status}` };
}

async function lookupOpenId(fetchFn, email, token, total) {
  const found = await postJson(fetchFn, `${FEISHU_API}/contact/v3/users/batch_get_id?user_id_type=open_id`, { emails: [email] }, token, total);
  return found.data?.code === 0 ? found.data?.data?.user_list?.[0]?.user_id ?? null : null;
}

/**
 * 只查不发(#219 新作者提醒、只读回放用):这些邮箱在飞书能不能查到 open_id。
 * 返回 { status: 'ok', found: { <email>: true|false } } 或 { status: 'failed', code }(原因码同 sendFuseNotice)。
 */
export async function findFeishuUsers({ fetchFn = fetch, appId, appSecret, emails, totalTimeoutMs = FEISHU_TOTAL_TIMEOUT_MS }) {
  if (!appSecret) return { status: 'failed', code: 'no-credential' };
  const total = AbortSignal.timeout(totalTimeoutMs);
  try {
    const auth = await fetchToken(fetchFn, appId, appSecret, total);
    if (!auth.token) return { status: 'failed', code: auth.code };
    const found = {};
    for (const email of emails ?? []) found[email] = Boolean(await lookupOpenId(fetchFn, email, auth.token, total));
    return { status: 'ok', found };
  } catch (error) {
    return { status: 'failed', code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

/**
 * 取 token → 按邮箱查 open_id → 发纯文本私聊。recipients 依次尝试:作者查不到 open_id 时换兜底人,兜底人收到的正文带转发说明。
 * 返回 { status: 'sent', to, forwarded } 或 { status: 'failed', code }。code 是固定原因码,不含凭证、邮箱或飞书返回原文。
 */
export async function sendFuseNotice({ fetchFn = fetch, appId, appSecret, recipients, message, totalTimeoutMs = FEISHU_TOTAL_TIMEOUT_MS }) {
  if (!appSecret) return { status: 'failed', code: 'no-credential' };
  if (!recipients?.length) return { status: 'failed', code: 'no-recipient' };
  const total = AbortSignal.timeout(totalTimeoutMs);
  try {
    const auth = await fetchToken(fetchFn, appId, appSecret, total);
    if (!auth.token) return { status: 'failed', code: auth.code };
    const { token } = auth;
    for (const recipient of recipients) {
      const openId = await lookupOpenId(fetchFn, recipient.email, token, total);
      if (!openId) continue;
      const text = message({ forwardedFrom: recipient.forwardedFrom });
      const sent = await postJson(fetchFn, `${FEISHU_API}/im/v1/messages?receive_id_type=open_id`,
        { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) }, token, total);
      if (sent.data?.code !== 0) return { status: 'failed', code: `send-${sent.data?.code ?? sent.status}` };
      return { status: 'sent', to: recipient.login, forwarded: Boolean(recipient.forwardedFrom), reason: recipient.reason };
    }
    return { status: 'failed', code: 'feishu-user-not-found' };
  } catch (error) {
    return { status: 'failed', code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network' };
  }
}
