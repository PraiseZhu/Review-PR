// reviewer-identity.mjs — 审查身份集合(纯函数,无 I/O)。
//
// 「这是不是审查账号写的」统一走这里:身份集合 = viewerLogin ∪ viewerAliases。
// 没配 aliases 时集合只有 viewer 自己;三个名字(PraiseZhu / praisebuild[bot] / praise-reviewer[bot])
// 只出现在示例和测试里,不内置。集合只回答「归属」,不赋予任何权限:维护者名单、
// 写前身份绑定、bot 禁止审批合并都不看集合成员关系。
//
// 本模块禁止 import lib.mjs(它顶层会建状态目录)、禁止读环境变量、文件和 gh;
// 读环境和 gh 回落的包装是 lib.mjs 的 readReviewIdentity。

// 登录名比较的 canonical key:小写;bot 一律写成 `base[bot]`。
// REST 的 bot 登录名自带 [bot] 后缀,GraphQL 的 Bot 登录名不带但 __typename=Bot。
// 去后缀后只靠「是不是 Bot」区分,所以同名 User(praisebuild)不会撞上 Bot(praisebuild[bot])。
const BOT_SUFFIX = '[bot]';
// 与 lib.mjs 的 GITHUB_LOGIN_RE 同口径(1–39 位,字母数字起头,其后字母数字或连字符),末尾可带 [bot]。
const VIEWER_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/i;

/** 把 string 或 {login, type?, __typename?} 归一成 {login, isBot, key};缺失返回 null。 */
export function normalizeReviewActor(value) {
  let rawLogin = '';
  let typed = '';
  if (typeof value === 'string') rawLogin = value;
  else if (value && typeof value === 'object') {
    rawLogin = typeof value.login === 'string' ? value.login : '';
    typed = String(value.__typename ?? value.type ?? '').trim();
  }
  let login = rawLogin.trim().toLowerCase();
  if (!login) return null;
  let isBot = /^bot$/i.test(typed);
  // `gh pr view --json` 把 GitHub App 写成 app/<slug>。
  if (login.startsWith('app/')) {
    login = login.slice(4);
    isBot = true;
  }
  if (login.endsWith(BOT_SUFFIX)) {
    login = login.slice(0, -BOT_SUFFIX.length);
    isBot = true;
  }
  if (!login) return null;
  return { login, isBot, key: isBot ? `${login}${BOT_SUFFIX}` : login };
}

/**
 * 评论 / review 记录的作者,兼容 GraphQL(author.login + __typename)、REST(user.login + type)、
 * 字符串 author 和顶层 login。不读记录顶层 __typename(那是记录自己的类型,不是作者类型)。
 * 返回 {login, __typename},可直接交给 normalizeReviewActor;没有作者时 login 为 ''。
 */
export function reviewRecordActor(record) {
  if (!record || typeof record !== 'object') return { login: '', __typename: '' };
  const { author, user } = record;
  const authorLogin = typeof author === 'string' ? author : typeof author?.login === 'string' ? author.login : '';
  const login = String(record.login || authorLogin || user?.login || '').trim();
  const typename = author?.is_bot === true ? 'Bot'
    : String(author?.__typename ?? author?.type ?? user?.__typename ?? user?.type ?? '').trim();
  return { login, __typename: typename };
}

/** 配置里的审查账号登录名(viewerLogin / REVIEW_PR_VIEWER_LOGIN)。合法返回去空白后的原拼写,非法抛错并写出字段名。 */
export function validateViewerLogin(value, field = 'viewerLogin') {
  const login = typeof value === 'string' ? value.trim() : '';
  if (!VIEWER_LOGIN_RE.test(login)) {
    const shown = typeof value === 'string' ? JSON.stringify(value.slice(0, 60)) : typeof value;
    throw new Error(`${field} 不是合法的 GitHub 登录名(期望字母、数字、连字符,最长 39 位,bot 可带 [bot] 后缀,实际 ${shown})`);
  }
  return login;
}

/**
 * viewerAliases 解析。入参是 JSON 数组字符串(环境变量)或数组(config.json);未设/空白返回 []。
 * 不接受逗号分隔写法。重复的 canonical key 去掉、保序。非法输入抛错并写出字段名(元素带下标)。
 */
export function parseViewerAliases(raw, field = 'REVIEW_PR_VIEWER_ALIASES') {
  if (raw === undefined || raw === null) return [];
  let list = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try { list = JSON.parse(raw); } catch (error) {
      throw new Error(`${field} 必须是 JSON 数组字符串,例如 ["PraiseZhu"](解析失败:${error.message})`);
    }
  }
  if (!Array.isArray(list)) throw new Error(`${field} 必须是登录名数组,实际 ${typeof list}`);
  const seen = new Set();
  const out = [];
  list.forEach((item, index) => {
    const login = validateViewerLogin(item, `${field}[${index}]`);
    const { key } = normalizeReviewActor(login);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(login);
  });
  return out;
}

/**
 * 身份集合。viewerLogin 是「当前实际写入账号」(可为 string 或带类型的对象),viewerAliases 是历史/并行身份。
 * viewer 为空时集合为空(fail closed):不能单凭 aliases 形成「当前身份」。
 * 返回值只含 JSON 可序列化的值,可随 context 输出再传回来。
 */
export function createReviewIdentity({ viewerLogin = '', viewerAliases = [] } = {}) {
  const viewer = normalizeReviewActor(viewerLogin);
  const aliasActors = (Array.isArray(viewerAliases) ? viewerAliases : []).map(normalizeReviewActor).filter(Boolean);
  const logins = viewer ? [...new Set([viewer.key, ...aliasActors.map((actor) => actor.key)])] : [];
  const viewerText = typeof viewerLogin === 'string' ? viewerLogin.trim() : viewer?.key ?? '';
  return {
    viewerLogin: viewerText,
    viewerAliases: aliasActors.map((actor) => actor.key),
    logins,
    isBot: Boolean(viewer?.isBot),
  };
}

/** 旧调用方传的 viewer 字符串、新调用方传的身份对象,都收成身份对象。字符串 = 只有自己的集合。 */
export function toReviewIdentity(value) {
  if (value && typeof value === 'object' && Array.isArray(value.logins)) return value;
  if (value && typeof value === 'object' && typeof value.login === 'string') return createReviewIdentity({ viewerLogin: value });
  return createReviewIdentity({ viewerLogin: typeof value === 'string' ? value : '' });
}

/** actor 是否在身份集合里。actor 缺失 / 不可识别返回 false。 */
export function isReviewIdentity(actor, identity) {
  const key = normalizeReviewActor(actor)?.key;
  return Boolean(key) && toReviewIdentity(identity).logins.includes(key);
}

/** 两个非空 actor 是否同一个账号(精确比较,不做 aliases 等价)。写前身份绑定用它。 */
export function sameReviewActor(a, b) {
  const left = normalizeReviewActor(a)?.key;
  const right = normalizeReviewActor(b)?.key;
  return Boolean(left) && left === right;
}
