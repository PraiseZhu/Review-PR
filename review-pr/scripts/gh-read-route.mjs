// gh-read-route.mjs — [MIVO-PATCH app-read-route] 服务器 publish 的读请求改用 GitHub App 只读令牌。
//
// 为什么:PraiseZhu 每小时 5000 次额度由 Mini、服务器审查机和本机会话共用。服务器 publish 一次约 140 次调用,
// 绝大多数是读;读请求换成 PraiseBuild App 的安装令牌就不再占 PraiseZhu 的额度。写、审查账号身份、
// 管理类端点、看不懂的请求一律仍用原令牌(GH_TOKEN)。
//
// 开关(都可选;没设令牌或没设仓名单时本模块什么都不改,行为与之前完全一致):
//   REVIEW_PR_READ_TOKEN      App 只读令牌(workflow 在 publish 前现取,有效期 1 小时)
//   REVIEW_PR_READ_REPOS      允许走 App 的仓,逗号分隔(owner/name);只有这些仓下的读请求会分流
//   REVIEW_PR_GH_ROUTE_LOG    可选:每次分流判断追加一行 JSON(只有命令前两个词、原因、结果,不含令牌和参数正文)
//
// 分类规则单一来源是 vendor/gh-app-classify.mjs(与 Mini 的 gh 分流器同一份),这里不自己判断。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { classify, needsStdin, APP } from './vendor/gh-app-classify.mjs';

export const READ_TOKEN_ENV = 'REVIEW_PR_READ_TOKEN';
const TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const REPO_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
// 随调用者身份变化的字段:合并状态(含 admin / bypass 视角)、viewer* 系列。
const IDENTITY_FIELD_RE = /mergeStateStatus|viewerCan|viewerDid|viewerHas|viewerIs|viewerLatestReview|viewerPermission|viewerSubscription|viewerThumbsUp/i;

const METRICS = { app: 0, appFallback: 0, user: 0 };
export function routeMetrics() { return { ...METRICS }; }
export function resetRouteMetrics() { METRICS.app = 0; METRICS.appFallback = 0; METRICS.user = 0; }

/** 读开关。令牌和仓名单任缺一项返回 null(不分流);仓名单里有不合法的项直接抛错,不悄悄放宽。 */
export function readRouteConfig(env = process.env) {
  const token = String(env[READ_TOKEN_ENV] ?? '').trim();
  if (!token) return null;
  const repos = String(env.REVIEW_PR_READ_REPOS ?? '').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (repos.length === 0) return null;
  const bad = repos.find((r) => !REPO_RE.test(r));
  if (bad) throw new Error(`REVIEW_PR_READ_REPOS 里有不合法的仓名(期望 owner/name,实际 ${JSON.stringify(bad.slice(0, 80))})`);
  return { token, repos, logFile: String(env.REVIEW_PR_GH_ROUTE_LOG ?? '').trim() };
}

/** 纯函数:这条 gh 调用走 App 还是原令牌。caller 显式给了 env(身份令牌那类调用)或要求不换凭证的,一律原令牌。 */
export function decideReadRoute(args, { input, env = process.env, config, explicitEnv = false, noCredFallback = false } = {}) {
  if (!config) return { route: 'user', reason: 'disabled' };
  if (explicitEnv) return { route: 'user', reason: 'caller_env' };
  if (noCredFallback) return { route: 'user', reason: 'no_cred_fallback' };
  let stdinText = null;
  if (needsStdin(args)) {
    if (typeof input !== 'string') return { route: 'user', reason: 'stdin_missing' };
    stdinText = input;
  }
  const d = classify(args, { repos: config.repos, env, stdinText, readFile: (path) => readFileSync(path, 'utf8') });
  if (d.route !== APP) return { route: 'user', reason: d.reason };
  // 本地补一道:GitHub 按「谁在读」返回不同值的字段一律用原令牌。实测(2026-10-20,xindong/mivo-canvas-plugin):
  // PraiseZhu 作者的 PR 上 mergeStateStatus 个人令牌读到 CLEAN、App 读到 BLOCKED;审查机对「作者就是审查账号」的 PR
  // 用它复核合并状态,读错会把该放行的 PR 当成未放行。分类器是搬运的原文不改,所以在这里挡。
  if (IDENTITY_FIELD_RE.test(`${args.join(' ')}\n${stdinText ?? ''}`)) return { route: 'user', reason: 'identity_field' };
  return { route: 'app', reason: d.reason };
}

/** 给 App 那次调用用的环境:摘掉调用方带来的令牌,只放 App 令牌。不改入参。 */
export function appReadEnv(env, token) {
  const next = { ...env };
  for (const key of TOKEN_KEYS) delete next[key];
  next.GH_TOKEN = token;
  next.GH_PROMPT_DISABLED = '1';
  return next;
}

const FALLBACK_RES = [
  /\(HTTP (?:401|403|404)\)/,
  /Bad credentials/i,
  /Resource not accessible by integration/i,
  /Could not resolve to a (?:Repository|node)\b/i,
  /"type"\s*:\s*"(?:FORBIDDEN|NOT_FOUND)"/,
];
/** 纯函数:App 那次失败了,要不要换原令牌重试。只认「权限 / 不存在 / 令牌失效」;5xx、422、超时、限流原样返回。 */
export function shouldFallbackToUser(result) {
  if (!result || result.ok) return false;
  if (result.status === 4) return true;
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  if (/rate limit/i.test(text)) return false;
  return FALLBACK_RES.some((re) => re.test(text));
}

/** 记一次分流结果(内存计数 + 可选日志行)。日志写失败不影响本次调用。 */
export function recordRoute(config, { route, reason, args, ms }) {
  if (route === 'app') METRICS.app += 1;
  else if (route === 'app-fallback') METRICS.appFallback += 1;
  else METRICS.user += 1;
  if (!config?.logFile) return;
  const cmd = args[0] === 'api' ? 'api' : args.slice(0, 2).join(' ');
  try { appendFileSync(config.logFile, `${JSON.stringify({ ts: new Date().toISOString(), route, cmd, reason, ms })}\n`); } catch { /* 日志失败不影响调用 */ }
}

/** 汇总分流日志:{ app, appFallback, user, reasons:{原因:次数} }。文件不存在返回 null。 */
export function summarizeRouteLog(file) {
  if (!file || !existsSync(file)) return null;
  const out = { app: 0, appFallback: 0, user: 0, reasons: {} };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.route === 'app') out.app += 1;
    else if (row.route === 'app-fallback') out.appFallback += 1;
    else out.user += 1;
    const key = `${row.route}:${row.reason}`;
    out.reasons[key] = (out.reasons[key] ?? 0) + 1;
  }
  return out;
}
