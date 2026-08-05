#!/usr/bin/env node
// resolve-author-feishu.mjs — 用 PR 作者的 GitHub 账号 / 提交 git 邮箱在公司 org 名录
// (README)里查飞书映射(只读)。
//
// 匹配键(按优先级):
//   ① PR 作者 GitHub login——名录行本身带 [@login](github.com/login),而作者 login 永远
//      可知、不受「同事用个人邮箱提交」影响,是主键;
//   ② PR commits 的 author/committer 邮箱——辅助(比如名录某行没写 GitHub 账号时)。
// 到 pr-rules.json 配置的 orgMappingRepos(taptap/org、xindong/org 的 README.md)里逐行
// 匹配 → 输出命中行原文(matched[].matchedBy 标注命中键)。「行里哪个字段是飞书名 / 公司
// 邮箱」留给 skill 里的 LLM 读行判断(名录格式可能变,行内语义解析是语义活;login/邮箱
// 匹配、翻页、去重、失败分类这些确定性活在本脚本)。
//
// 名录读取顺序(fine-grained PAT 的坑:它绑定单一 resource owner + 勾选仓库,gh api 读不到
// taptap/org 这类跨 org 仓库,而本机 git 的 SSH key / 用户凭证读得到):
//   1. 本地 roster clone(~/.cindy/org-rosters/<owner>-<repo>,仓库工作区之外):存在则先
//      `git pull --ff-only`(30s 超时,拉失败用现存副本并标 stale),读 README.md;
//   2. 本地没有 → `git clone --depth 1 git@github.com:<slug>.git`(走本机 SSH key);
//   3. clone 失败 → 兜底 gh api(PAT 授权过的仓库仍可用);
//   4. 全失败 → 记入 fetchErrors。
//
// 失败分类(群通知的措辞要区分,别混):
//   - matched 非空                → 找到映射,可私聊
//   - matched 空 + fetchErrors 空  → 名录里确实没这个人(not-found):不私聊,群消息里说明
//   - matched 空 + fetchErrors 非空 → 名录根本读不到(SSH / PAT 都不通):不私聊,
//     群消息里说明「名录读不到」而不是「人不存在」
//
// 跑:node <skill-root>/scripts/resolve-author-feishu.mjs <PR>
// 退出码恒 0(脚本自身异常才 1),结果全在 JSON 字段。

import { parseRepo, parsePR, gh, ghJson, print, fail, loadOrgRosters, parseRosterLine, loadRules } from './lib.mjs';

const prRules = loadRules();
const MAPPING_REPOS = prRules.feishuNotify?.orgMappingRepos ?? [];

// GitHub 的 noreply 邮箱(xxx@users.noreply.github.com)不进公司名录,匹配不到属正常,单独标记
const isNoreply = (e) => /@users\.noreply\.github\.com$/i.test(e);

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;

  // ── 0. PR 作者 GitHub login(匹配主键)──
  const authorLogin = ghJson(['pr', 'view', String(pr), '--repo', slug, '--json', 'author'])?.author?.login ?? '';

  // ── 1. 收集 PR 全部 commit 的 author / committer 邮箱(辅助键;--paginate 兜住多页)──
  const r = gh(['api', `repos/${slug}/pulls/${pr}/commits?per_page=100`, '--paginate'], { allowFail: true });
  if (!r.ok) throw new Error(`拉 PR commits 失败: ${(r.stderr || '').trim().slice(0, 200)}`);
  // --paginate 可能输出多个拼接的 JSON 数组,逐段解析
  const commits = (r.stdout.match(/\[[\s\S]*?\](?=\s*\[|\s*$)/g) ?? ['[]']).flatMap((s) => {
    try { return JSON.parse(s); } catch { return []; }
  });
  const emails = [...new Set(
    commits.flatMap((c) => [c.commit?.author?.email, c.commit?.committer?.email])
      .filter(Boolean)
      .filter((e) => e !== 'noreply@github.com'), // merge commit 的 GitHub 系统邮箱,无意义
  )];
  const usableEmails = emails.filter((e) => !isNoreply(e));

  // ── 2. 拉名录 README(共享底座 loadOrgRosters:本地 roster clone 优先 → SSH clone → gh api 兜底)──
  const { rosters, fetchErrors } = loadOrgRosters(MAPPING_REPOS);

  // ── 3. 逐行匹配名录(大小写不敏感;命中行原文交给 LLM 读出飞书标识)──
  // 主键:GitHub login——匹配 github.com/<login> 或 @<login>,后面必须是非 login 字符
  // (防 @xd 误中 @xd-bobo 这类前缀);辅助键:git 邮箱子串。同一行命中多键只记一次。
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const loginRe = authorLogin
    ? new RegExp(`(?:github\\.com/|@)${esc(authorLogin)}(?![A-Za-z0-9-])`, 'i')
    : null;
  // 结构化行解析走共享底座 parseRosterLine(| [@login](url) | 中文名 | 公司邮箱 | 角色 |)。
  const matched = [];
  for (const { repo: repoSlug, text } of rosters) {
    for (const line of text.split('\n')) {
      const lower = line.toLowerCase();
      const byLogin = loginRe?.test(line) ?? false;
      const byEmail = usableEmails.find((e) => lower.includes(e.toLowerCase())) ?? null;
      if (byLogin || byEmail) {
        matched.push({
          matchedBy: byLogin ? 'github-login' : 'email',
          email: byEmail,
          repo: repoSlug,
          parsed: parseRosterLine(line),
          line: line.trim().slice(0, 500),
        });
      }
    }
  }
  // login 命中排前(主键更可信)
  matched.sort((a, b) => (a.matchedBy === 'github-login' ? -1 : 1) - (b.matchedBy === 'github-login' ? -1 : 1));

  print({
    ok: true,
    pr,
    authorLogin,
    emails,
    noreplyOnly: usableEmails.length === 0 && emails.length > 0,
    rostersFetched: rosters.map((x) => ({ repo: x.repo, source: x.source })),
    fetchErrors,
    matched,
    found: matched.length > 0,
    note: 'found=true → 优先用 matched[].parsed(结构化 {githubLogin, name, email}):email 非空直接走飞书 receive_id_type=email 私聊,只有 name 就 contact_search;parsed=null(名录格式变了)才读 line 原文判断。matchedBy=github-login 的行优先采信。found=false 时看 fetchErrors:非空=名录读不到(群消息措辞用「名录读不到」),空=名录里没这个人(措辞用「没找到映射」)',
  });
} catch (e) {
  fail(e);
}
