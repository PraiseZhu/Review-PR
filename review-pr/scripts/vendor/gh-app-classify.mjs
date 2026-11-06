// [MIVO-PATCH app-read-route] 原样搬运,不要在这里改逻辑。
// 来源:xindong/mivo-canvas-plugin scripts/ops/gh-app-router/classify.mjs @ e1b1f040fabf90ac6c8d134b133904463a4a6214(#1867 合入提交,PR #1868;原文件 sha256 e2b7ab94747656fd96c0745ab3f08b3196f86efba1ba1f52e99842685ee3a114)。
// Mini 上的 gh 分流器用同一份规则;服务器发布步骤用它判断「这条 gh 请求能不能改用 App 只读令牌」。
// 规则要改,先改插件仓那份,再整份重新搬运,并更新 gh-read-route.test.mjs 里的 sha256。
// gh 命令分类器（纯函数，不碰文件系统；readFile 由调用方注入）。
//
// 默认走 PraiseZhu（user）。只有同时满足「只读、不依赖身份、目标仓在白名单」的请求
// 才走 GitHub App（app）；看不懂的一律 user。分类出错的后果由「App 令牌只有只读权限」兜底。
// 写请求默认也全是 user；routes.writes 打开后，白名单内的写才判 app-write（带类别，见下面的 APP_WRITE），
// 此时兜底是「写令牌按类别只申请对应的一项权限」（app-token.mjs）。
//
// 本目录会被整份拷到 Mini 部署，只能 import node 内置模块，不能 import 仓库其它文件。

export const APP = 'app'
export const USER = 'user'
export const APP_WRITE = 'app-write'

// config.json 的 routes：按目录打开的放行开关，默认全关。关着时分类结果与没有这些开关时逐条一致。
// 「结果随调用者身份变化」的读**不设开关**：mergeStateStatus / mergeable_state / current_user_can_bypass / permissions /
// viewer* / @me 等永远走 PraiseZhu（见 SENSITIVE_JSON_FIELDS 与 switchedRestReason），因为 App 读到的值可能和 PraiseZhu
// 不同又不报错（#1714 现网：同一 PR，App 读 blocked、PraiseZhu 读 clean），回落接不住。开关只留给「要额外权限、但不含
// 按调用者算的字段」的读，权限没授到时 403 回落即可：
//   adminRead   ：branches/<ref>/protection 等 Administration 读（App 要先在 GitHub 上授权 administration: read）；rulesets/<id> 不在范围内，见 switchedRestReason
//   secretsRead ：actions/secrets/<name>（App 要先授权 secrets: read）
//   writes      ：白名单内的写命令 / 写端点改用 App 写令牌（见下面「app writes」；App 要先授权对应类别的 write 权限）
export const ROUTE_SWITCHES = ['adminRead', 'secretsRead', 'writes']
const toRouteSwitches = (routes) => Object.fromEntries(ROUTE_SWITCHES.map((key) => [key, routes?.[key] === true]))

// helpers
const toUser = (reason, cmd) => ({ route: USER, reason, cmd })
const toApp = (reason, cmd) => ({ route: APP, reason, cmd })
const toAppWrite = (reason, cmd, category) => ({ route: APP_WRITE, reason, cmd, category })

const GITHUB_HOST = 'github.com'

// REST 子资源白名单：看不懂的子资源默认走 user。branches 故意不放（分支对象里的 protection 摘要随身份变化）。
const DENY_SEGMENTS = new Set([
  'protection', 'required_signatures', 'rulesets', 'rule-suites', 'rules', 'teams',
  'collaborators', 'permission', 'requested_reviewers', 'secrets', 'keys', 'hooks', 'invitations',
])
const REST_ALLOWED = new Set([
  'actions', 'check-runs', 'check-suites', 'comments', 'commits', 'compare', 'contents', 'events',
  'git', 'issues', 'labels', 'languages', 'milestones', 'pulls', 'readme', 'releases', 'statuses', 'tags',
])
const ACTIONS_ALLOWED = new Set(['artifacts', 'jobs', 'runs', 'variables', 'workflows'])

const WRITE_COMMANDS = new Set([
  'variable set', 'variable delete',
  'run cancel', 'run rerun', 'run delete',
  'workflow run', 'workflow enable', 'workflow disable',
  'issue create', 'issue close', 'issue reopen', 'issue comment', 'issue edit', 'issue delete',
  'issue lock', 'issue unlock', 'issue pin', 'issue unpin', 'issue transfer',
  'pr create', 'pr comment', 'pr review', 'pr edit', 'pr ready', 'pr merge', 'pr close',
  'pr reopen', 'pr checkout',
])

const GRAPHQL_ROOT_ALLOWED = new Set(['repository', 'node', 'nodes', '__typename'])
const GRAPHQL_CROSS_REPO_FIELDS = /\b(?:repositories|forks|parent|templateRepository|headRepository|baseRepository)\b/i
// node 查询里的类型条件（`... on X` / `fragment F on X`）只许是仓库内的对象，账号 / 组织类型一律判给 PraiseZhu；
// 类型名按词法记号认，`on` 与类型名之间夹逗号、注释也认得出。按可见性变化的连接名在原文上再查一遍（见 classifyGraphql）。
const NODE_REPO_TYPES = new Set([
  'Repository', 'PullRequest', 'Issue', 'PullRequestReviewThread', 'PullRequestReview', 'PullRequestReviewComment',
  'IssueComment', 'CommitComment', 'Commit', 'CheckSuite', 'CheckRun', 'StatusContext', 'Status', 'StatusCheckRollup',
  'Workflow', 'WorkflowRun', 'Deployment', 'DeploymentStatus', 'Label', 'Milestone', 'Release', 'Ref', 'Tag', 'Tree', 'Blob',
  'Discussion', 'DiscussionComment', 'PullRequestCommit',
])
// pullRequests / issues：User 上也有这两个连接（经 assignees、author 等直接落到 User，不需要 `on User`），按可见性返回子集；仓库自己的同名连接一并保守判给 PraiseZhu（QA #1084）。
const NODE_IDENTITY_CONNECTIONS = /\b(?:repositories|repositoriesContributedTo|organizations|starredRepositories|watching|pinnedItems|pinnableItems|gists|packages|sponsoring|sponsors|contributionsCollection|pullRequests|issues)\b/
function hasNonRepoTypeCondition(text) {
  const toks = lexGraphql(text)
  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i].t !== 'name' || toks[i].v !== 'on') continue
    const type = toks[i + 1]
    if (type?.t !== 'name') return true
    if (!NODE_REPO_TYPES.has(type.v) && !/^[A-Z][A-Za-z]*Event$/.test(type.v)) return true
  }
  return false
}

// flag parsing
function makeSpec({ value = [], bool = [] }) {
  const long = new Map()
  const short = new Map()
  for (const [kind, list] of [['value', value], ['bool', bool]]) {
    for (const item of list) {
      const [name, sh] = item.split(':')
      long.set(name, kind)
      if (sh) short.set(sh, name)
    }
  }
  return { long, short }
}

// pflag 的布尔选项也接受 `=value` 等号写法（`--include=true`、`-i=false`），值只认 strconv.ParseBool 的那几种。
// pflag 对同一个选项是最后一次赋值生效：显式关掉（=false/0/f）等价于没写，同时要清掉前面 `--watch` / `--help`
// 那种裸写法留下的记录，否则 `--watch --watch=false` 仍被当成已设置（绕过并发槽、丢掉只读重试资格）。
// 其它写法 gh 自己会报错，这里按看不清处理（unknown）。`-iH` 这类合并短参数同样看不清。
const BOOL_TRUE = /^(?:1|t|true)$/i
const BOOL_FALSE = /^(?:0|f|false)$/i
function applyBoolValue(out, name, raw) {
  if (BOOL_TRUE.test(raw)) { out.bools.add(name); return true }
  if (BOOL_FALSE.test(raw)) { out.bools.delete(name); return true }
  return false
}

// 支持 --long=v、--long v、-x v、-xv、-x=v、布尔 `=true|false`、`--` 之后全是位置参数；合并短参数或未知参数 → unknown。
// `shortHelp` 打开时，没注册成选项的 `-h…`（`-h`、`-h=false`、`-hfoo`）记 `implicitHelp`：pflag 对未注册的 `-h`
// 直接按 help 处理（gh 2.92 实测 `gh api user -h=false` 打 help），它不是请求，也不是「看不懂的参数」。
export function parseFlags(args, spec, { shortHelp = false } = {}) {
  const out = { ordered: [], values: new Map(), bools: new Set(), positionals: [], unknown: false, implicitHelp: false }
  const addValue = (long, value) => {
    out.ordered.push({ long, value })
    const list = out.values.get(long) ?? []
    list.push(value)
    out.values.set(long, list)
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      out.positionals.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      const kind = spec.long.get(name)
      if (!kind) { out.unknown = true; continue }
      if (kind === 'bool') {
        if (eq === -1) out.bools.add(name)
        else if (!applyBoolValue(out, name, arg.slice(eq + 1))) out.unknown = true
        continue
      }
      if (eq !== -1) { addValue(name, arg.slice(eq + 1)); continue }
      if (i + 1 >= args.length) { out.unknown = true; continue }
      i += 1
      addValue(name, args[i])
      continue
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      const name = spec.short.get(arg[1])
      if (!name) {
        if (shortHelp && arg[1] === 'h') { out.implicitHelp = true; continue }
        out.unknown = true; continue
      }
      if (spec.long.get(name) === 'bool') {
        const attached = arg.slice(2)
        if (attached === '') out.bools.add(name)
        else if (!(attached.startsWith('=') && applyBoolValue(out, name, attached.slice(1)))) out.unknown = true
        continue
      }
      let rest = arg.slice(2)
      if (rest.startsWith('=')) rest = rest.slice(1)
      if (rest !== '') { addValue(name, rest); continue }
      if (i + 1 >= args.length) { out.unknown = true; continue }
      i += 1
      addValue(name, args[i])
      continue
    }
    out.positionals.push(arg)
  }
  return out
}

const lastValue = (parsed, long) => parsed.values.get(long)?.at(-1)

const API_SPEC = makeSpec({
  value: [
    'method:X', 'raw-field:f', 'field:F', 'header:H', 'input', 'jq:q', 'template:t',
    'hostname', 'preview:p', 'cache',
  ],
  bool: ['include:i', 'paginate', 'slurp', 'silent', 'verbose'],
})

const REPO_FLAG = ['repo:R']
const LABEL_JSON_FIELDS = new Set(['name', 'color', 'description', 'id'])

// 非 api 只读命令：deny 命中 → user，needJson 表示必须带 --json（默认人读输出会顺带查 reviewRequests 等身份相关字段）。
const READ_COMMANDS = {
  'pr view': {
    reason: 'pr_read', needJson: true, deny: { web: 'web' },
    spec: makeSpec({ value: [...REPO_FLAG, 'jq:q', 'json', 'template:t'], bool: ['comments:c', 'web:w'] }),
  },
  'pr list': {
    reason: 'pr_read', needJson: true, deny: { web: 'web', search: 'search' },
    spec: makeSpec({
      value: [...REPO_FLAG, 'app', 'assignee:a', 'author:A', 'base:B', 'head:H', 'jq:q', 'json',
        'label:l', 'limit:L', 'search:S', 'state:s', 'template:t'],
      bool: ['draft:d', 'web:w'],
    }),
  },
  'pr diff': {
    reason: 'pr_read', needJson: false, deny: { web: 'web' },
    spec: makeSpec({ value: [...REPO_FLAG, 'color', 'exclude:e'], bool: ['name-only', 'patch', 'web:w'] }),
  },
  'pr checks': {
    reason: 'pr_read', needJson: false, deny: { web: 'web', watch: 'streaming' },
    spec: makeSpec({
      value: [...REPO_FLAG, 'jq:q', 'json', 'template:t', 'interval:i'],
      bool: ['required', 'fail-fast', 'watch', 'web:w'],
    }),
  },
  'issue view': {
    reason: 'issue_read', needJson: true, deny: { web: 'web' },
    spec: makeSpec({ value: [...REPO_FLAG, 'jq:q', 'json', 'template:t'], bool: ['comments:c', 'web:w'] }),
  },
  'issue list': {
    reason: 'issue_read', needJson: true, deny: { web: 'web', search: 'search' },
    spec: makeSpec({
      value: [...REPO_FLAG, 'app', 'assignee:a', 'author:A', 'jq:q', 'json', 'label:l', 'limit:L',
        'mention', 'milestone:m', 'search:S', 'state:s', 'template:t'],
      bool: ['web:w'],
    }),
  },
  'run view': {
    reason: 'run_read', needJson: false, deny: { web: 'web' },
    spec: makeSpec({
      value: [...REPO_FLAG, 'attempt:a', 'job:j', 'jq:q', 'json', 'template:t'],
      bool: ['exit-status', 'log', 'log-failed', 'verbose:v', 'web:w'],
    }),
  },
  // run list 的 -w 是 --workflow，其它命令的 -w 是 --web，所以 spec 必须按命令分开。
  'run list': {
    reason: 'run_read', needJson: false, deny: {},
    spec: makeSpec({
      value: [...REPO_FLAG, 'branch:b', 'commit:c', 'created', 'event:e', 'jq:q', 'json', 'limit:L',
        'status:s', 'template:t', 'user:u', 'workflow:w'],
      bool: ['all:a'],
    }),
  },
  'run download': {
    reason: 'run_read', needJson: false, deny: {},
    spec: makeSpec({ value: [...REPO_FLAG, 'dir:D', 'name:n', 'pattern:p'] }),
  },
  // label list 只读仓库的标签；--json 字段限定在 LABEL_JSON_FIELDS（见 classifyRead），其它 label 子命令仍是写命令。
  'label list': {
    reason: 'label_read', needJson: true, deny: { web: 'web', search: 'search' },
    jsonFields: LABEL_JSON_FIELDS,
    spec: makeSpec({
      value: [...REPO_FLAG, 'jq:q', 'json', 'limit:L', 'order', 'search:S', 'sort', 'template:t'],
      bool: ['web:w'],
    }),
  },
  'variable get': {
    reason: 'variable_read', needJson: false, deny: { org: 'org_or_env', env: 'org_or_env' },
    spec: makeSpec({ value: [...REPO_FLAG, 'jq:q', 'json', 'template:t', 'env:e', 'org:o'] }),
  },
  'variable list': {
    reason: 'variable_read', needJson: false, deny: { org: 'org_or_env', env: 'org_or_env' },
    spec: makeSpec({ value: [...REPO_FLAG, 'jq:q', 'json', 'template:t', 'env:e', 'org:o'] }),
  },
}

// gh 里 `ls` 是 list 子命令的短别名（gh 2.92：`pr|issue|run|variable ls` 都能跑）。别名和规范命令是同一个请求，
// 所以分流、只读判定和 spec 查找都按规范 key 查表，别名不会漏进「未知命令」那条路。
// 只登记 READ_COMMANDS 里有的这四个组：其它 `ls`（label、repo、secret…）本来就不在这张表里，照旧走未知命令，不改分流。
const LIST_ALIAS_GROUPS = new Set(['pr', 'issue', 'run', 'variable'])

function commandKey(argv) {
  const group = argv[0] ?? ''
  const sub = argv[1] ?? ''
  return sub === 'ls' && LIST_ALIAS_GROUPS.has(group) ? `${group} list` : `${group} ${sub}`
}

// gh 的 root persistent flag：`--help`（`-h` 是 pflag 对未注册简写的 help 处理）。cobra 允许它出现在命令前
// （`gh --help=false api user`）、命令与子命令之间（`gh pr --help=false view 1`），也允许和子命令后的写法混用，
// 取值按 pflag 的「最后一次赋值生效」（`--help --help=false` 是真实请求；`gh --help=false api user` 实测发请求）。
// 下面几处判定都按位置切片（`argv[0]` / `argv[1]` 是命令、`argv.slice(2)` 是参数），前置写法会让切片错位：
// 真实请求被当成 unknown_command 或 help，丢掉只读限流重试、绕过并发槽。
// 所以入口处先把「命令位置之前」的 help 写法剥掉，按 last-value-wins 只留最终值，再以 canonical
// `--help` / `--help=false` 放回命令（有子命令时放回子命令）之后：`commandKey` 看到真实命令，
// `parseFlags` 仍按位置解析剩下的参数，子命令后面那个 help 写法照旧覆盖这里放回的值。
// 命令前没有 help 写法时原样返回（绝大多数调用，不重建数组）。
const ROOT_HELP_EQ = '--help='

// 单个 token 的 help 取值：true / false / 'invalid'（`--help=yes`，gh 自己会报 invalid argument）/ null（不是 root help）。
// `-h…` 一律算 help：pflag 对没注册的 `-h` 直接按 help 处理（gh 2.92 实测 `gh -h=false version` 也打 usage）。
function rootHelpState(arg) {
  if (arg === '--help' || (arg.startsWith('-h') && !arg.startsWith('--'))) return true
  if (!arg.startsWith(ROOT_HELP_EQ)) return null
  const raw = arg.slice(ROOT_HELP_EQ.length)
  if (BOOL_TRUE.test(raw)) return true
  if (BOOL_FALSE.test(raw)) return false
  return 'invalid'
}

function normalizeRootFlags(argv) {
  let help = null
  let i = 0
  for (; i < argv.length; i += 1) {
    const state = rootHelpState(argv[i])
    if (state === null) break
    if (state === 'invalid') return argv // 看不懂的布尔值：交给 parseFlags 的 unknown 兜底，不改写 argv
    help = state
  }
  const group = argv[i]
  if (group === undefined) return argv
  // 命令与子命令之间：这里能出现的同样只有 root persistent flag。
  let j = i + 1
  for (; j < argv.length; j += 1) {
    const state = rootHelpState(argv[j])
    if (state === null) break
    if (state === 'invalid') return argv
    help = state
  }
  if (help === null) return argv
  // 子命令 = 命令后第一个不是 root help 的 token；以 '-' 开头时它是命令自己的选项（`api -X GET`），
  // 结构前缀只有命令一个 token，canonical help 紧跟命令，不会被任何带值选项当成自己的值。
  const sub = argv[j] !== undefined && !argv[j].startsWith('-') ? argv[j] : undefined
  const mark = sub === undefined ? j : j + 1
  return [group, ...(sub === undefined ? [] : [sub]), help ? '--help' : '--help=false', ...argv.slice(mark)]
}

// deny 的原因分两类：只影响分流的（search、org_or_env——请求本身仍是纯读，可以安全重放）和可能影响重试安全的。
// 只有前者列在这里；其它 reason（web 会开浏览器、streaming 是长流）以及以后新增的 reason 一律按不能重试处理。
const RETRY_SAFE_DENY_REASONS = new Set(['search', 'org_or_env'])

// headRepository / headRepositoryOwner 指向 fork 仓：App 看不到时 GitHub 照样成功、字段缺失，不会回落，所以交给 PraiseZhu。
// mergestatestatus（mergeStateStatus / GET 单个 PR 的 mergeable_state）按调用者算：App 的只读身份不参与 can-merge，
// GitHub 照样返回 200、不触发回落（#1714：同一 PR，App BLOCKED、PraiseZhu CLEAN），所以不管哪个目录、哪个开关都交给
// PraiseZhu。这条不设开关——身份相关的读一旦放给 App，调用方就会把可合并的 PR 当成卡住。
const SENSITIVE_JSON_FIELDS = new Set(['reviewrequests', 'projectcards', 'projectitems', 'headrepository', 'headrepositoryowner', 'mergestatestatus'])

// graphql
function lexGraphql(text) {
  const tokens = []
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') { i += 1; continue }
    if (ch === '#') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i += 1
      continue
    }
    if (text.startsWith('"""', i)) {
      let j = i + 3
      for (;;) {
        if (j >= n) throw new Error('unterminated block string')
        if (text.startsWith('\\"""', j)) { j += 4; continue }
        if (text.startsWith('"""', j)) break
        j += 1
      }
      tokens.push({ t: 'str', v: text.slice(i + 3, j) })
      i = j + 3
      continue
    }
    if (ch === '"') {
      let j = i + 1
      for (;;) {
        if (j >= n || text[j] === '\n' || text[j] === '\r') throw new Error('unterminated string')
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '"') break
        j += 1
      }
      tokens.push({ t: 'str', v: JSON.parse(text.slice(i, j + 1)) })
      i = j + 1
      continue
    }
    if (text.startsWith('...', i)) { tokens.push({ t: 'spread', v: '...' }); i += 3; continue }
    if (ch === '$') {
      const m = /^\$([_A-Za-z][_0-9A-Za-z]*)/.exec(text.slice(i, i + 256))
      if (!m) throw new Error('bad variable')
      tokens.push({ t: 'var', v: m[1] })
      i += m[0].length
      continue
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(text.slice(i, i + 256))
    if (nameMatch) { tokens.push({ t: 'name', v: nameMatch[0] }); i += nameMatch[0].length; continue }
    const numMatch = /^-?\d[\d.eE+-]*/.exec(text.slice(i, i + 64))
    if (numMatch) { tokens.push({ t: 'num', v: numMatch[0] }); i += numMatch[0].length; continue }
    if ('!():=@[]{}|&'.includes(ch)) { tokens.push({ t: 'punct', v: ch }); i += 1; continue }
    throw new Error('unexpected character')
  }
  return tokens
}

const isPunct = (tok, v) => tok?.t === 'punct' && tok.v === v

// 顶层扫描：只允许 repository / node / nodes / __typename 四种根字段，并识别嵌套 repository 查找。
function scanGraphqlRoot(text, variables) {
  const toks = lexGraphql(text)
  let pos = 0
  const peek = () => toks[pos]
  const skipBalanced = (open, close) => {
    if (!isPunct(peek(), open)) throw new Error(`expected ${open}`)
    let depth = 0
    for (; pos < toks.length; pos += 1) {
      if (isPunct(toks[pos], open)) depth += 1
      else if (isPunct(toks[pos], close)) {
        depth -= 1
        if (depth === 0) { pos += 1; return }
      }
    }
    throw new Error(`unbalanced ${open}`)
  }
  const skipDirectives = () => {
    while (isPunct(peek(), '@')) {
      pos += 1
      if (peek()?.t !== 'name') throw new Error('bad directive')
      pos += 1
      if (isPunct(peek(), '(')) skipBalanced('(', ')')
    }
  }

  if (peek()?.t === 'name') {
    if (peek().v !== 'query') throw new Error('not a query operation')
    pos += 1
    if (peek()?.t === 'name') pos += 1
  }
  if (isPunct(peek(), '(')) skipBalanced('(', ')')
  skipDirectives()
  if (!isPunct(peek(), '{')) throw new Error('expected selection set')
  pos += 1

  const roots = []
  while (!isPunct(peek(), '}')) {
    const tok = peek()
    if (!tok || tok.t !== 'name') throw new Error('unexpected root token')
    pos += 1
    let field = tok.v
    if (isPunct(peek(), ':')) {
      pos += 1
      if (peek()?.t !== 'name') throw new Error('bad alias')
      field = peek().v
      pos += 1
    }
    const args = new Map()
    if (isPunct(peek(), '(')) {
      const start = pos
      skipBalanced('(', ')')
      const end = pos - 1
      for (let k = start + 1; k < end;) {
        const nameTok = toks[k]
        if (nameTok.t !== 'name' || !isPunct(toks[k + 1], ':')) throw new Error('bad argument')
        const valueTok = toks[k + 2]
        if (!valueTok) throw new Error('bad argument value')
        if (isPunct(valueTok, '[') || isPunct(valueTok, '{')) {
          const close = isPunct(valueTok, '[') ? ']' : '}'
          let depth = 0
          let m = k + 2
          for (; m < end; m += 1) {
            if (isPunct(toks[m], valueTok.v)) depth += 1
            else if (isPunct(toks[m], close)) { depth -= 1; if (depth === 0) break }
          }
          args.set(nameTok.v, null)
          k = m + 1
        } else {
          args.set(nameTok.v, valueTok)
          k += 3
        }
      }
    }
    skipDirectives()
    if (isPunct(peek(), '{')) skipBalanced('{', '}')
    roots.push({ field, args })
  }
  pos += 1 // 根选择集的 }

  // 操作之后只允许 fragment 定义；出现第二个操作 → 抛错。
  while (pos < toks.length) {
    if (peek().t !== 'name' || peek().v !== 'fragment') throw new Error('second operation')
    pos += 1
    if (peek()?.t !== 'name') throw new Error('bad fragment')
    pos += 1
    if (peek()?.t !== 'name' || peek().v !== 'on') throw new Error('bad fragment')
    pos += 1
    if (peek()?.t !== 'name') throw new Error('bad fragment')
    pos += 1
    skipDirectives()
    skipBalanced('{', '}')
  }

  const resolve = (tok) => {
    if (!tok) return null
    if (tok.t === 'str') return tok.v
    if (tok.t === 'var') {
      const v = variables?.[tok.v]
      return typeof v === 'string' ? v : null
    }
    return null
  }
  const repositoryTokenCount = toks.filter((tok) => tok.t === 'name' && tok.v === 'repository').length
  const rootRepositoryCount = roots.filter(({ field }) => field === 'repository').length
  const scannedRoots = roots.map(({ field, args }) => {
    if (!GRAPHQL_ROOT_ALLOWED.has(field)) return { rootField: field }
    if (field === '__typename') return { typename: true }
    if (field === 'node' || field === 'nodes') return { node: true } // 全局 id 解不出所属仓，靠 App 只读 + 回落兜底
    return { owner: resolve(args.get('owner')), name: resolve(args.get('name')) }
  })
  return { roots: scannedRoots, nestedRepository: repositoryTokenCount > rootRepositoryCount }
}

// 取出 GraphQL 请求的查询文本和变量（--input 的 JSON，或 -f/-F query=…）；取不到返回 {reason}（reason 即分流用的原因）。
function readGraphqlRequest(parsed, ctx) {
  const input = lastValue(parsed, 'input')
  let queryText
  let variables = {}
  const readText = (src) => {
    if (src === '-') return ctx.stdinText
    return ctx.readFile(src)
  }
  try {
    if (input !== undefined) {
      if (parsed.ordered.some((f) => f.long === 'raw-field' || f.long === 'field')) return { reason: 'graphql_shape' }
      const raw = readText(input)
      if (typeof raw !== 'string') return { reason: 'graphql_unparsed' }
      let body
      try { body = JSON.parse(raw) } catch { return { reason: 'graphql_unparsed' } }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.query !== 'string') {
        return { reason: 'graphql_unparsed' }
      }
      if (body.variables !== undefined && (body.variables === null || typeof body.variables !== 'object' || Array.isArray(body.variables))) {
        return { reason: 'graphql_unparsed' }
      }
      queryText = body.query
      variables = body.variables ?? {}
    } else {
      for (const { long, value } of parsed.ordered) {
        if (long !== 'raw-field' && long !== 'field') continue
        const eq = value.indexOf('=')
        if (eq === -1) return { reason: 'graphql_shape' }
        const key = value.slice(0, eq)
        const val = value.slice(eq + 1)
        if (key === 'operationName') continue
        if (key === 'query') {
          if (val.startsWith('@')) {
            const raw = readText(val.slice(1))
            if (typeof raw !== 'string') return { reason: 'graphql_unparsed' }
            queryText = raw
          } else {
            queryText = val
          }
          continue
        }
        if (long === 'field') {
          if (val.startsWith('@')) return { reason: 'field_from_file' }
          if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(val)) continue // 非字符串，不能当仓库名
        }
        variables[key] = val
      }
    }
  } catch {
    return { reason: 'graphql_unreadable' }
  }
  if (typeof queryText !== 'string' || queryText.trim() === '') return { reason: 'graphql_shape' }
  return { queryText, variables }
}

function classifyGraphql(parsed, ctx, cmd) {
  const method = lastValue(parsed, 'method')
  if (method !== undefined && method.toUpperCase() !== 'POST') return toUser('graphql_method', cmd)

  const request = readGraphqlRequest(parsed, ctx)
  if (request.reason) return toUser(request.reason, cmd)
  const { queryText, variables } = request

  // 在原文（含字符串和注释）上做保守检查，宁可多判给 user。
  if (/viewer/i.test(queryText)) return toUser('graphql_viewer', cmd)
  if (/mergeStateStatus/i.test(queryText)) return toUser('graphql_merge_state', cmd) // 按调用者算，永远走 PraiseZhu，见 SENSITIVE_JSON_FIELDS
  if (/\b(mutation|subscription)\b/.test(queryText)) return toUser('graphql_mutation', cmd)
  if (/@me\b/i.test(queryText)) return toUser('at_me', cmd)
  if (/protection|ruleset|collaborator|team|member|permission|reviewRequest|requestedReviewer|project/i.test(queryText)
    || GRAPHQL_CROSS_REPO_FIELDS.test(queryText)) {
    return toUser('graphql_sensitive', cmd)
  }

  let scan
  try { scan = scanGraphqlRoot(queryText, variables) } catch { return toUser('graphql_unparsed', cmd) }
  if (scan.nestedRepository) return toUser('graphql_sensitive', cmd)
  let repoCount = 0
  let nodeCount = 0
  for (const root of scan.roots) {
    if (root.typename) continue
    if (root.rootField !== undefined) return toUser('graphql_root_field', cmd)
    if (root.node) { nodeCount += 1; continue }
    repoCount += 1
    if (!root.owner || !root.name) return toUser('repo_unknown', cmd)
    if (!ctx.repoSet.has(`${root.owner}/${root.name}`.toLowerCase())) return toUser('repo_not_allowlisted', cmd)
  }
  if (repoCount === 0 && nodeCount === 0) return toUser('graphql_root_field', cmd)
  // node 的全局 id 看不出属于谁：取账号 / 组织下按可见性变化的内容时，App 会成功返回它看得到的子集、不报错，回落接不住，只能交给 PraiseZhu。
  if (nodeCount > 0 && (NODE_IDENTITY_CONNECTIONS.test(queryText) || hasNonRepoTypeCondition(queryText))) {
    return toUser('graphql_node_identity', cmd)
  }
  return toApp(nodeCount > 0 ? 'graphql_node' : 'graphql_query', cmd)
}

// api
function normalizeEndpoint(raw) {
  let endpoint = raw
  if (/^https:\/\/api\.github\.com\//i.test(endpoint)) endpoint = endpoint.replace(/^https:\/\/api\.github\.com\//i, '')
  return endpoint
}

function isGraphqlEndpoint(endpoint) {
  return endpoint.replace(/^\/+/, '') === 'graphql'
}

// writes 为 true（routes.writes 开着且没有 WRITES_DISABLED）时，白名单里按 --input 带 JSON 的三个写端点也要先读 stdin：
// 分类要看 body（event / 键 / 类型），读到的字节之后原样转发给 gh。writes 关着时行为与没有这个参数时完全一致。
export function needsStdin(argv, { writes = false } = {}) {
  argv = normalizeRootFlags(argv)
  if (argv[0] !== 'api') return false
  const { spec, shortHelp } = commandFlags(argv)
  const parsed = parseFlags(argv.slice(1), spec, { shortHelp })
  // help 不发请求，别为它去读 stdin（`api graphql --input - --help` 在终端里会把包装器卡住）。
  if (parsed.unknown || parsed.bools.has('help') || parsed.implicitHelp || parsed.positionals.length !== 1) return false
  const endpoint = normalizeEndpoint(parsed.positionals[0])
  if (!isGraphqlEndpoint(endpoint)) return writes && isStdinWriteInput(parsed, endpoint)
  if (lastValue(parsed, 'input') === '-') return true
  return parsed.ordered.some((f) => (f.long === 'raw-field' || f.long === 'field') && f.value === 'query=@-')
}

// REST 路径切段：每段解码并转小写；`%2F` 解出来的 `/` 记在 slashAt（原文已按 `/` 切开，只能来自 %2F）。
// rawSegs 是同一批段解码后、没转小写的版本：仓库名与端点大小写不敏感，标签名区分大小写，只有标签校验用它。
// 空段、`.` / `..`、反斜杠、片段、占位符一律看不清，返回 {reason}。读（GET）和写（app 写白名单）共用这一份。
function parseRestSegments(path) {
  if (path.includes('{')) return { reason: 'placeholder' }
  const segs = []
  const rawSegs = []
  const slashAt = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return { reason: 'unsafe_path' }
    let decoded
    try { decoded = decodeURIComponent(seg) } catch { return { reason: 'unsafe_path' } }
    if (decoded === '.' || decoded === '..' || decoded.includes('\\') || decoded.includes('#')) return { reason: 'unsafe_path' }
    if (decoded.includes('/')) slashAt.push(segs.length)
    segs.push(decoded.toLowerCase())
    rawSegs.push(decoded)
  }
  return { segs, rawSegs, slashAt }
}

// 分支名带 `/` 时 gh 会把它编成 %2F。只有 commits/<ref>、rules/branches/<ref>、branches/<ref> 的最后一段认这种写法：
// 别的位置的 %2F 会把一个路径段变成多个，绕过下面按段数做的判断。
const REF_PARENTS = new Set(['commits', 'rules/branches', 'branches'])
function isRefSlashPath(segs, slashAt) {
  const last = segs.length - 1
  if (slashAt.length !== 1 || slashAt[0] !== last || segs[0] !== 'repos' || last < 4) return false
  if (!REF_PARENTS.has(segs.slice(3, last).join('/'))) return false
  return segs[last].split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

// Metadata 读：结果与调用者身份无关，只要 App 有 Metadata 读权限（所有 App 都有）。段数必须恰好，其余子路径仍按 DENY_SEGMENTS 走 PraiseZhu。
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/
function isMetadataRead(tail) {
  if (tail.length !== 3) return false
  if (tail[0] === 'collaborators') return tail[2] === 'permission' && GITHUB_LOGIN.test(tail[1])
  return tail[0] === 'rules' && tail[1] === 'branches'
}

// 开关打开才放行的读：段数和形状都要恰好，开关关着（或授权没到位而回落）时仍走 PraiseZhu。
function switchedRestReason(tail, routes) {
  if (routes.adminRead) {
    const [head, second, third, fourth] = tail
    if (head === 'branches' && third === 'protection' && (tail.length === 3 || (tail.length === 4 && fourth === 'required_signatures'))) return 'rest_admin_read'
    // rulesets/<id> 单个规则集带 current_user_can_bypass（按调用者算：App 没有 bypass 能力），放行后「当前账号能不能 admin bypass」会变成错的，
    // 所以它不在 adminRead 里、永远走 PraiseZhu；rulesets/rule-suites 是历史评估结果，与调用者无关，仍放行。
    if (head === 'rulesets' && tail.length === 2 && second === 'rule-suites') return 'rest_admin_read'
    if (head === 'actions' && second === 'runners' && tail.length === 2) return 'rest_admin_read'
  }
  if (routes.secretsRead && tail.length === 3 && tail[0] === 'actions' && tail[1] === 'secrets') return 'rest_secrets_read'
  return null
}

function classifyApi(argv, ctx) {
  const { spec, shortHelp } = commandFlags(argv)
  const parsed = parseFlags(argv.slice(1), spec, { shortHelp })
  let cmd = 'api'
  if (parsed.unknown) return toUser('unsupported_flag', cmd)
  if (parsed.positionals.length !== 1) return toUser('api_shape', cmd)
  const hostname = lastValue(parsed, 'hostname')
  if (hostname !== undefined && hostname.toLowerCase() !== GITHUB_HOST) return toUser('not_github_host', cmd)
  if (parsed.bools.has('verbose')) return toUser('debug_output', cmd)
  for (const header of parsed.values.get('header') ?? []) {
    const name = header.split(':')[0].trim().toLowerCase()
    if (name !== 'accept' && name !== 'x-github-api-version') return toUser('custom_header', cmd)
  }

  let endpoint = normalizeEndpoint(parsed.positionals[0])
  if (endpoint.includes('://')) return toUser('foreign_url', cmd)
  endpoint = endpoint.replace(/^\/+/, '')
  // 片段不发给 API，但 gh 会按字面拼路径：`pulls/1#x` 绕过单个 PR 对象的判断，一律判给 PraiseZhu。
  if (endpoint.includes('#')) return toUser('unsafe_path', cmd)
  if (endpoint === 'graphql') return classifyGraphql(parsed, ctx, 'api graphql')

  const fields = parsed.ordered.filter((f) => f.long === 'raw-field' || f.long === 'field')
  const hasInput = parsed.values.has('input')
  const explicit = lastValue(parsed, 'method')
  const method = (explicit ?? (fields.length > 0 || hasInput ? 'POST' : 'GET')).toUpperCase()
  if (method !== 'GET') {
    // 写必须显式写出方法：`-f` 隐含的 POST 不放；白名单对不上就回到原来的 user 原因。
    const write = explicit !== undefined && ctx.routes.writes ? classifyApiWrite(method, parsed, endpoint, ctx) : null
    return write ?? toUser(explicit === undefined ? 'fields_without_get' : 'write_method', cmd)
  }
  if (hasInput) return toUser('input_body', cmd)
  if (fields.some((f) => f.value.slice(f.value.indexOf('=') + 1).startsWith('@'))) return toUser('field_from_file', cmd)

  const split = parseRestSegments(endpoint.split('?')[0])
  if (split.reason) return toUser(split.reason, cmd)
  const { segs, slashAt } = split
  if (slashAt.length > 0 && !isRefSlashPath(segs, slashAt)) return toUser('unsafe_path', cmd)
  if (segs[0] === 'user') return toUser('identity_endpoint', cmd)
  if (segs[0] !== 'repos') return toUser('non_repo_endpoint', cmd)
  if (segs.length < 3) return toUser('unsafe_path', cmd)
  if (!ctx.repoSet.has(`${segs[1]}/${segs[2]}`)) return toUser('repo_not_allowlisted', cmd)
  if (segs.length === 3) return toUser('identity_endpoint', cmd) // 仓库对象带随调用者变化的 permissions
  if (isMetadataRead(segs.slice(3))) return toApp('rest_metadata', cmd)
  const switched = switchedRestReason(segs.slice(3), ctx.routes)
  if (switched) return toApp(switched, cmd)
  // 单个 PR 对象带按调用者算的 mergeable_state（App 看到 blocked，且 GitHub 返回 200、不会回落），永远走 PraiseZhu；
  // 列表接口不带这个字段，仍走 App。
  // 段号不能只认 ^\d+$：GitHub 对 `:number` 取前导整数，`pulls/1.`、`pulls/1.5`、`pulls/1e0`、`pulls/1abc`
  // 都返回 PR 1 的完整对象（2026-11-05 现网实测，均 200 + mergeable_state），所以 pulls/<任意写法> 一律走 user。
  if (segs.length === 5 && segs[3] === 'pulls') return toUser('merge_state_endpoint', cmd)
  if (segs.slice(3).some((s) => DENY_SEGMENTS.has(s))) return toUser('admin_endpoint', cmd)
  if (!REST_ALLOWED.has(segs[3])) return toUser('endpoint_not_allowlisted', cmd)
  if (segs[3] === 'actions' && !ACTIONS_ALLOWED.has(segs[4])) return toUser('endpoint_not_allowlisted', cmd)
  return toApp('rest_get', cmd)
}

// app writes
// routes.writes 打开后，下面这张白名单里的写才判 app-write，并带上类别（actions / actions_variables / issues / pull_requests）：
// 路由层按类别只给 App 写令牌申请对应的一项权限（app-token.mjs）。白名单对不上的写仍是 user，原因沿用原来的
// （write_command / write_method / fields_without_get），所以开关关着和白名单未命中时的分类结果逐条一致。
// 永远不在白名单里（因此永远 user）：pr merge、APPROVE 评审（api 与 GraphQL）、repo、release、secret、workflow enable|disable、
// 白名单外的变量名、review-pr.yml 以外的 workflow、GraphQL mutation（含 resolveReviewThread）、非白名单仓、body 任意的 --input。
// App 写失败不回落 PraiseZhu（路由层保证），所以这里宁严勿松：任何一处看不清都返回 null。
const APP_WRITE_WORKFLOW = 'review-pr.yml'
const APP_WRITE_VARIABLES = new Set(['MIVO_PREREVIEW_HEARTBEAT', 'MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL', 'MIVO_REVIEW_KEY_STATUS'])
// 标签名（精确、区分大小写，不 trim、不转小写）。受管标签是前置审查真实在读写的那批（来源见 classify.test.mjs 的 PRE_REVIEW_MANAGED_LABELS）：
// 精确名 + `status:<x>` / `touches:<x>`，<x> 非空且只含小写字母、数字、连字符。可建改（label create|edit）也可删（DELETE issues/<N>/labels/<名>）。
// 旧门禁标签是 Review-PR 迁移时还在清理的历史标签，只放行删除；建、改、加都判 user。
const MANAGED_LABEL_NAMES = new Set(['review:merge-ready', 'awaiting-discussion'])
const MANAGED_LABEL_PATTERN = /^(?:status|touches):[a-z0-9-]+$/
const LEGACY_GATE_NAMES = new Set(['awaiting-maintainer-discussion', 'needs-maintainer-approval', 'need-whitelist'])
const LEGACY_GATE_PATTERN = /^need-whitelist:[a-z0-9-]+$/
const isManagedLabel = (name) => MANAGED_LABEL_NAMES.has(name) || MANAGED_LABEL_PATTERN.test(name)
const isLegacyGateLabel = (name) => LEGACY_GATE_NAMES.has(name) || LEGACY_GATE_PATTERN.test(name)
const isDeletableLabel = (name) => isManagedLabel(name) || isLegacyGateLabel(name)
// 加标签（POST issues/<N>/labels）的黑名单比删除的白名单宽：GitHub 按不区分大小写的名字找标签，`Need-Whitelist` 一样会加上旧门禁标签，
// 所以这里 trim + 转小写，且 `need-whitelist:` 开头的任何后缀都算，不要求后缀合法。
const isLegacyGateLabelForAdd = (name) => {
  const folded = name.trim().toLowerCase()
  return LEGACY_GATE_NAMES.has(folded) || folded.startsWith('need-whitelist:')
}
const REVIEW_EVENTS = new Set(['REQUEST_CHANGES', 'COMMENT'])
const NUMBER_ARG = /^[1-9]\d{0,18}$/

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOnlyKeys = (keys, allowed) => [...keys].every((key) => allowed.includes(key))

// 非 api 写命令：spec 只登记允许的选项，其余选项解析成 unknown → 回到 user。目标仓必须显式给出（-R 或 GH_REPO），号码只认纯数字。
const FIELD_OPTIONS = ['raw-field:f', 'field:F']
const hasNumberArg = (parsed) => parsed.positionals.length === 1 && NUMBER_ARG.test(parsed.positionals[0])
const hasNamedArg = (allowed) => (parsed) => parsed.positionals.length === 1 && allowed.has(parsed.positionals[0])
// label create|edit 只认受管标签（旧门禁标签不在内：它们只许删）。
const hasManagedLabelArg = (parsed) => parsed.positionals.length === 1 && isManagedLabel(parsed.positionals[0])
// -f/-F 的 key=value 里值以 @ 开头会读文件 / stdin，内容看不见，一律不放。
const workflowFieldsAreLiteral = (parsed) => [...(parsed.values.get('raw-field') ?? []), ...(parsed.values.get('field') ?? [])]
  .every((value) => value.includes('=') && !value.slice(value.indexOf('=') + 1).startsWith('@'))

const COMMENT_SPEC = makeSpec({ value: [...REPO_FLAG, 'body:b', 'body-file:F'] })
const LABEL_SPEC = makeSpec({ value: [...REPO_FLAG, 'color:c', 'description:d'] })
const WRITE_COMMAND_DEFS = {
  'workflow run': {
    reason: 'workflow_run', category: 'actions',
    spec: makeSpec({ value: [...REPO_FLAG, 'ref:r', ...FIELD_OPTIONS] }),
    check: (parsed) => hasNamedArg(new Set([APP_WRITE_WORKFLOW]))(parsed) && workflowFieldsAreLiteral(parsed),
  },
  'run cancel': { reason: 'run_cancel', category: 'actions', spec: makeSpec({ value: REPO_FLAG }), check: hasNumberArg },
  'run rerun': { reason: 'run_rerun', category: 'actions', spec: makeSpec({ value: REPO_FLAG, bool: ['failed'] }), check: hasNumberArg },
  'variable set': {
    reason: 'variable_set', category: 'actions_variables',
    spec: makeSpec({ value: [...REPO_FLAG, 'body:b'] }), check: hasNamedArg(APP_WRITE_VARIABLES),
  },
  'variable delete': { reason: 'variable_delete', category: 'actions_variables', spec: makeSpec({ value: REPO_FLAG }), check: hasNamedArg(APP_WRITE_VARIABLES) },
  'issue create': {
    reason: 'issue_create', category: 'issues',
    spec: makeSpec({ value: [...REPO_FLAG, 'title:t', 'body:b', 'body-file:F', 'label:l'] }),
    check: (parsed) => parsed.positionals.length === 0,
  },
  'issue comment': { reason: 'issue_comment', category: 'issues', spec: COMMENT_SPEC, check: hasNumberArg },
  'issue close': { reason: 'issue_close', category: 'issues', spec: makeSpec({ value: [...REPO_FLAG, 'comment:c', 'reason:r'] }), check: hasNumberArg },
  'label create': { reason: 'label_create', category: 'issues', spec: LABEL_SPEC, check: hasManagedLabelArg },
  'label edit': { reason: 'label_edit', category: 'issues', spec: LABEL_SPEC, check: hasManagedLabelArg },
  'pr comment': { reason: 'pr_comment', category: 'pull_requests', spec: COMMENT_SPEC, check: hasNumberArg },
}

// 非 api 写命令的出口：开关关着、不在白名单、参数对不上都回到原来的 write_command。
function classifyWriteCommand(key, argv, ctx) {
  const rejected = toUser('write_command', key)
  if (!ctx.routes.writes || !Object.hasOwn(WRITE_COMMAND_DEFS, key)) return rejected
  const def = WRITE_COMMAND_DEFS[key]
  // 全局 `--help` 是 root 的 persistent flag（命令前的写法被 normalizeRootFlags 挪到了命令之后）：`--help=false` 等于没写，真 help 不发请求。
  const parsed = parseFlags(argv.slice(2), { long: new Map([...def.spec.long, ['help', 'bool']]), short: def.spec.short })
  if (parsed.unknown || parsed.bools.has('help')) return rejected
  const repoFlags = parsed.values.get('repo')
  if (repoFlags !== undefined && repoFlags.length !== 1) return rejected
  const rawRepo = repoFlags === undefined ? ctx.env.GH_REPO : repoFlags[0]
  if (!rawRepo) return rejected // 靠 cwd 推断目标仓的写不放
  const candidate = toRepoCandidate(rawRepo)
  if (!candidate.repo || !ctx.repoSet.has(candidate.repo)) return rejected
  if (!def.check(parsed)) return rejected
  return toAppWrite(def.reason, key, def.category)
}

// gh api 写白名单：tail 是 repos/<o>/<r>/ 之后的段（已解码、转小写），号码只认纯数字（写不接受 GitHub 对 `1.5` 取前导整数那种写法）。
// rawTail 是同样的段、解码后没转小写，只给标签名校验用（标签名区分大小写）。
// body 指 body 的校验类型：none = 不许带任何 body；其余见 API_WRITE_JSON_SHAPES / API_WRITE_FIELD_SHAPES。
function matchApiWriteEndpoint(method, tail, rawTail = tail) {
  const [a, b, c, d, e] = tail
  if (a === 'actions' && b === 'runs' && tail.length === 4 && NUMBER_ARG.test(c) && method === 'POST') {
    if (d === 'approve') return { reason: 'run_approve', category: 'actions', body: 'none' }
    if (d === 'rerun') return { reason: 'run_rerun', category: 'actions', body: 'none' }
  }
  if (a === 'issues' && tail.length === 3 && NUMBER_ARG.test(b)) {
    if (c === 'labels' && method === 'POST') return { reason: 'issue_labels_add', category: 'issues', body: 'labels' }
    if (c === 'comments' && method === 'POST') return { reason: 'issue_comment_api', category: 'issues', body: 'comment' }
  }
  // 只放「去掉一个受管标签（或旧门禁标签）」：`DELETE issues/<N>/labels`（不带名字）会清空该 issue 的全部标签，前置审查不用，判给 PraiseZhu。
  if (a === 'issues' && tail.length === 4 && NUMBER_ARG.test(b) && c === 'labels' && method === 'DELETE' && isDeletableLabel(rawTail[3])) {
    return { reason: 'issue_label_remove', category: 'issues', body: 'none' }
  }
  if (a === 'pulls' && NUMBER_ARG.test(b)) {
    if (tail.length === 3 && c === 'reviews' && method === 'POST') return { reason: 'pr_review_api', category: 'pull_requests', body: 'review' }
    if (tail.length === 5 && c === 'reviews' && NUMBER_ARG.test(d) && e === 'dismissals' && method === 'PUT') {
      return { reason: 'pr_review_dismiss', category: 'pull_requests', body: 'dismissal' }
    }
  }
  return null
}

// --input 的 JSON 里同一个对象出现重复键时，不同解析器取第一个还是最后一个并不统一：校验看到的 event 未必是 GitHub 看到的。
// 所以有重复键的 body 一律不放。调用前文本已经 JSON.parse 成功，这里只做扫描（键按 JSON 字符串解码后比较，`event` 也认得出）。
function hasDuplicateJsonKeys(text) {
  const stack = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) return true
      const top = stack.at(-1)
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1))
        if (top.keys.has(key)) return true
        top.keys.add(key)
        top.expectKey = false
      }
      i = j + 1
      continue
    }
    if (ch === '{') stack.push({ keys: new Set(), expectKey: true })
    else if (ch === '[') stack.push({ keys: null, expectKey: false })
    else if (ch === '}' || ch === ']') stack.pop()
    else if (ch === ',' && stack.at(-1)?.keys) stack.at(-1).expectKey = true
    i += 1
  }
  return false
}

// 读 --input 的 JSON（`-` 读 stdin，其它读文件）；读不到、不是 JSON、有重复键都返回 undefined。
function readJsonInput(parsed, ctx) {
  const source = lastValue(parsed, 'input')
  let raw
  try { raw = source === '-' ? ctx.stdinText : ctx.readFile(source) } catch { return undefined }
  if (typeof raw !== 'string') return undefined
  let body
  try { body = JSON.parse(raw) } catch { return undefined }
  return hasDuplicateJsonKeys(raw) ? undefined : body
}

const API_WRITE_JSON_SHAPES = {
  labels: (body) => {
    const list = Array.isArray(body) ? body : (isPlainObject(body) && hasOnlyKeys(Object.keys(body), ['labels']) ? body.labels : null)
    return Array.isArray(list) && list.length > 0
      && list.every((label) => typeof label === 'string' && label !== '' && !isLegacyGateLabelForAdd(label))
  },
  dismissal: (body) => isPlainObject(body) && hasOnlyKeys(Object.keys(body), ['message', 'event'])
    && typeof body.message === 'string' && (body.event === undefined || body.event === 'DISMISS'),
  review: (body) => isPlainObject(body) && hasOnlyKeys(Object.keys(body), ['event', 'body', 'commit_id', 'comments'])
    && REVIEW_EVENTS.has(body.event)
    && (body.body === undefined || typeof body.body === 'string')
    && (body.commit_id === undefined || typeof body.commit_id === 'string')
    && (body.comments === undefined || Array.isArray(body.comments)),
}

// -f/-F 写法：[key, value] 列表；值以 @ 开头（读文件 / stdin）、没有 `=`、空键都看不清，返回 null。
function toFieldEntries(parsed) {
  const entries = []
  for (const { long, value } of parsed.ordered) {
    if (long !== 'raw-field' && long !== 'field') continue
    const eq = value.indexOf('=')
    if (eq <= 0 || value.slice(eq + 1).startsWith('@')) return null
    entries.push([value.slice(0, eq), value.slice(eq + 1)])
  }
  return entries
}

// 同一个键出现两次时 gh 取最后一个，校验却可能只看到第一个：重复键不放。
function toUniqueFields(entries) {
  const map = new Map()
  for (const [key, value] of entries) {
    if (map.has(key)) return null
    map.set(key, value)
  }
  return map
}

const API_WRITE_FIELD_SHAPES = {
  labels: (entries) => entries.length > 0
    && entries.every(([key, value]) => key === 'labels[]' && value !== '' && !isLegacyGateLabelForAdd(value)),
  comment: (entries) => entries.length === 1 && entries[0][0] === 'body',
  dismissal: (entries) => {
    const fields = toUniqueFields(entries)
    return fields !== null && hasOnlyKeys(fields.keys(), ['message', 'event']) && fields.has('message')
      && (!fields.has('event') || fields.get('event') === 'DISMISS')
  },
  review: (entries) => {
    const fields = toUniqueFields(entries)
    return fields !== null && hasOnlyKeys(fields.keys(), ['event', 'body', 'commit_id']) && REVIEW_EVENTS.has(fields.get('event'))
  },
}

function apiWriteBodyOk(kind, parsed, ctx) {
  const hasFields = parsed.ordered.some((f) => f.long === 'raw-field' || f.long === 'field')
  const inputs = parsed.values.get('input') ?? []
  if (kind === 'none') return !hasFields && inputs.length === 0
  if (inputs.length > 0) {
    if (hasFields || inputs.length !== 1 || !Object.hasOwn(API_WRITE_JSON_SHAPES, kind)) return false
    const body = readJsonInput(parsed, ctx)
    return body !== undefined && API_WRITE_JSON_SHAPES[kind](body)
  }
  const entries = toFieldEntries(parsed)
  return entries !== null && API_WRITE_FIELD_SHAPES[kind](entries)
}

function classifyApiWrite(method, parsed, endpoint, ctx) {
  if (endpoint.includes('?')) return null
  const split = parseRestSegments(endpoint)
  if (split.reason || split.slashAt.length > 0) return null
  const { segs, rawSegs } = split
  if (segs[0] !== 'repos' || segs.length < 4 || !ctx.repoSet.has(`${segs[1]}/${segs[2]}`)) return null
  const hit = matchApiWriteEndpoint(method, segs.slice(3), rawSegs.slice(3))
  if (!hit) return null
  // 分页 / 缓存 / 预览头对写没有意义，出现就是看不懂。
  if (parsed.bools.has('paginate') || parsed.bools.has('slurp') || parsed.values.has('cache') || parsed.values.has('preview')) return null
  if (!apiWriteBodyOk(hit.body, parsed, ctx)) return null
  return toAppWrite(hit.reason, 'api', hit.category)
}

// needsStdin 用：这条 api 是不是白名单里「--input - 带 JSON」的写端点（要先读 stdin 才能分类）。不查目标仓：多读一次 stdin 无害，gh 照样收到原字节。
function isStdinWriteInput(parsed, endpoint) {
  const method = lastValue(parsed, 'method')
  if (method === undefined || lastValue(parsed, 'input') !== '-') return false
  const path = endpoint.replace(/^\/+/, '')
  if (path.includes('?')) return false
  const split = parseRestSegments(path)
  if (split.reason || split.slashAt.length > 0 || split.segs[0] !== 'repos' || split.segs.length < 4) return false
  const hit = matchApiWriteEndpoint(method.toUpperCase(), split.segs.slice(3), split.rawSegs.slice(3))
  return hit !== null && Object.hasOwn(API_WRITE_JSON_SHAPES, hit.body)
}

// non-api read commands
function toRepoCandidate(raw) {
  let value = raw.trim().replace(/^https:\/\/github\.com\//i, '').replace(/^github\.com\//i, '')
  value = value.replace(/\/+$/, '').replace(/\.git$/i, '')
  if (value.split('/').length > 2) return { hostMismatch: true }
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) return { invalid: true }
  return { repo: value.toLowerCase() }
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues|actions\/runs)\/\d+/i

function classifyRead(key, argv, ctx) {
  const def = READ_COMMANDS[key]
  const cmd = key
  const { spec, shortHelp } = commandFlags(argv)
  const parsed = parseFlags(argv.slice(2), spec, { shortHelp })
  if (parsed.unknown) return toUser('unsupported_flag', cmd)
  for (const [flag, reason] of Object.entries(def.deny)) {
    if (parsed.bools.has(flag) || parsed.values.has(flag)) return toUser(reason, cmd)
  }
  const json = lastValue(parsed, 'json')
  if (def.needJson && json === undefined) return toUser('human_output', cmd)
  // --json 可以重复，gh 会把多个值合并到同一个查询里，所以每个出现过的值都要检查。
  // SENSITIVE_JSON_FIELDS 里的字段按调用者算或随身份可见性变化，任何命令、任何开关下都判 PraiseZhu。
  for (const value of parsed.values.get('json') ?? []) {
    for (const field of value.split(',')) {
      if (SENSITIVE_JSON_FIELDS.has(field.trim().toLowerCase())) return toUser('sensitive_json_field', cmd)
    }
  }

  if (def.jsonFields) {
    for (const value of parsed.values.get('json') ?? []) {
      if (!value.split(',').every((field) => def.jsonFields.has(field.trim().toLowerCase()))) return toUser('json_field_not_allowlisted', cmd)
    }
  }

  const candidates = []
  const repoFlag = lastValue(parsed, 'repo')
  if (repoFlag !== undefined) {
    const c = toRepoCandidate(repoFlag)
    if (c.hostMismatch) return toUser('not_github_host', cmd)
    if (c.invalid) return toUser('repo_unknown', cmd)
    candidates.push(c.repo)
  } else if (ctx.env.GH_REPO) {
    const c = toRepoCandidate(ctx.env.GH_REPO)
    if (c.hostMismatch) return toUser('not_github_host', cmd)
    if (c.invalid) return toUser('repo_unknown', cmd)
    candidates.push(c.repo)
  }
  for (const positional of parsed.positionals) {
    const m = PR_URL.exec(positional)
    if (m) { candidates.push(`${m[1]}/${m[2]}`.toLowerCase()); continue }
    if (/^https?:\/\//i.test(positional)) return toUser('not_github_host', cmd)
  }
  if (candidates.length === 0) return toUser('repo_unknown', cmd) // 靠 cwd 推断，目标不确定
  if (new Set(candidates).size > 1) return toUser('repo_conflict', cmd)
  if (!ctx.repoSet.has(candidates[0])) return toUser('repo_not_allowlisted', cmd)
  return toApp(def.reason, cmd)
}

// entry
const HELP_FIRST = new Set(['--version', '-v', 'version', 'help', '--help', '-h'])

export function classify(argv, { repos = [], routes = {}, env = {}, stdinText = null, readFile, stdoutIsTTY = false } = {}) {
  argv = normalizeRootFlags(argv)
  const ctx = {
    repoSet: new Set(repos.map((r) => r.toLowerCase())),
    routes: toRouteSwitches(routes),
    env,
    stdinText,
    readFile: readFile ?? (() => { throw new Error('readFile unavailable') }),
  }
  if (argv.length === 0) return toUser('no_command', 'other')
  if (HELP_FIRST.has(argv[0]) || helpRequested(argv)) return toUser('help', 'other')
  if (env.GH_HOST && env.GH_HOST.toLowerCase() !== GITHUB_HOST) return toUser('not_github_host', 'other')
  if (env.GH_DEBUG) return toUser('debug_output', 'other')
  if (stdoutIsTTY) return toUser('interactive', 'other')
  if (argv.some((a) => /@me\b/i.test(a))) return toUser('at_me', 'other')
  if (argv[0] === 'api') return classifyApi(argv, ctx)
  const key = commandKey(argv)
  if (Object.hasOwn(READ_COMMANDS, key)) return classifyRead(key, argv, ctx)
  if (WRITE_COMMANDS.has(key) || argv[0] === 'label') return classifyWriteCommand(key, argv, ctx)
  if (argv[0] === 'auth') return toUser('auth', 'auth')
  if (key === 'run watch') return toUser('streaming', key)
  return toUser('unknown_command', 'other')
}

// retry eligibility
// 限流重试的资格，独立于身份分流：只看「请求会不会改东西」。拿不准一律 false——误判成只读会让写请求被重放。
// 只在 PraiseZhu 出口用；不改 classify 的任何分流结果。
export function isReadOnly(argv, { stdinText = null, readFile } = {}) {
  argv = normalizeRootFlags(argv)
  if (argv.length === 0) return false
  const { key, spec, shortHelp } = commandFlags(argv)
  if (argv[0] === 'api') {
    const parsed = parseFlags(argv.slice(1), spec, { shortHelp })
    if (parsed.unknown || parsed.positionals.length !== 1) return false
    if (parsed.bools.has('help') || parsed.implicitHelp) return false // help 不发请求，也没有可重放的东西
    for (const header of parsed.values.get('header') ?? []) {
      const name = header.split(':')[0].trim().toLowerCase()
      if (name !== 'accept' && name !== 'x-github-api-version') return false // 可能带 X-HTTP-Method-Override 之类
    }
    const endpoint = normalizeEndpoint(parsed.positionals[0])
    const method = lastValue(parsed, 'method')
    if (isGraphqlEndpoint(endpoint)) {
      if (method !== undefined && method.toUpperCase() !== 'POST') return false
      const ctx = { stdinText, readFile: readFile ?? (() => { throw new Error('readFile unavailable') }) }
      const request = readGraphqlRequest(parsed, ctx)
      if (request.reason) return false
      return !/\b(mutation|subscription)\b/.test(request.queryText)
    }
    const fields = parsed.ordered.filter((f) => f.long === 'raw-field' || f.long === 'field')
    if (parsed.values.has('input')) return false
    if (fields.some((f) => f.value.slice(f.value.indexOf('=') + 1).startsWith('@'))) return false // 可能读 stdin 或文件，重放不了
    return (method ?? (fields.length > 0 ? 'POST' : 'GET')).toUpperCase() === 'GET'
  }
  if (!Object.hasOwn(READ_COMMANDS, key)) return false
  const def = READ_COMMANDS[key]
  const parsed = parseFlags(argv.slice(2), spec, { shortHelp })
  if (parsed.unknown) return false
  if (parsed.bools.has('help') || parsed.implicitHelp) return false // 同上：help 不是请求
  // 只按「能不能安全重放」判：deny 里纯属路由限制的选项（--search、--env、--org）仍是只读。
  return !Object.entries(def.deny).some(([flag, reason]) => !RETRY_SAFE_DENY_REASONS.has(reason)
    && (parsed.bools.has(flag) || parsed.values.has(flag)))
}

// 没有专用 spec 的命令（pr comment / pr create 等写命令、repo、release 等）：只登记各命令里含义一致的带值选项。
// 其它选项在解析里记为 unknown，hasBareExemptOption 遇到 unknown 保守地不豁免。
const FALLBACK_SPEC = makeSpec({ value: [...REPO_FLAG, 'body:b', 'body-file:F', 'title:t', 'jq:q', 'json', 'template'] })

// 短 `-h` 在这些命令里是带值选项，不是 help：`repo create|edit -h <homepage>`、`config get|list|set -h <host>`
// （gh 2.92 全量命令树里只有这几类；`auth *` 的 `-h` 也是值选项，但整条 `auth` 本来就不占槽）。
// 它们走 FALLBACK_SPEC，不在这里排除时 hasBareExemptOption 会把 `-h` 当 help，真实的 PATCH 就绕过并发槽。
// gh 升级后新增了把 `-h` 当值的命令时，这里要补。
const H_VALUE_COMMANDS = new Set(['repo create', 'repo edit', 'config get', 'config list', 'config set'])

// 每个命令实际生效的 flag spec：命令自己的 spec 加上 gh 的全局布尔 `--help`。
// `--help` 是 root 的 persistent flag，任何子命令都认，也吃 `=true|false` 并按 pflag 的「最后一次赋值生效」；
// `--version` 只在命令位置（`gh api --version` 是 unknown flag），所以不进 spec。
// 短 `-h` 只对把 `-h` 注册成带值选项的命令（H_VALUE_COMMANDS）不算 help；其余命令的 `-h…` 由 pflag 直接按 help
// 处理（`-h=false` 也打 help，gh 2.92 实测），交给 `parseFlags` 的 `shortHelp`。
function commandFlags(argv) {
  const key = commandKey(argv)
  let spec = FALLBACK_SPEC
  if (argv[0] === 'api') spec = API_SPEC
  else if (Object.hasOwn(READ_COMMANDS, key)) spec = READ_COMMANDS[key].spec
  const long = new Map(spec.long)
  long.set('help', 'bool')
  return { key, spec: { long, short: spec.short }, shortHelp: !spec.short.has('h') && !H_VALUE_COMMANDS.has(key) }
}

// 这条 argv 是不是 help 请求。认不出的选项说明 argv 本身不合法（gh 自己会报 unknown flag 退出），
// 按 help 处理没有意义：交给后面的分流兜底（保守地判给 PraiseZhu）。
function helpRequested(argv) {
  const { spec, shortHelp } = commandFlags(argv)
  const parsed = parseFlags(argv.slice(1), spec, { shortHelp })
  if (parsed.unknown) return false
  return parsed.bools.has('help') || parsed.implicitHelp
}

// 命令行里有没有真正的布尔 `-h` / `--help` / `--watch`（api 还认 `--verbose`）。
// 三个消费点（`classify` 的 help、`isReadOnly` 的只读资格、`hasBareExemptOption` 的豁免）都经 `commandFlags` 取 spec，
// 全局 `--help` 与 `-h` 的归属只在这一处定义，免得某一处漏掉同一个全局选项又得出不同结论；
// 命令前 / 命令与子命令之间的写法由 `normalizeRootFlags` 统一规范化（四个公开入口都先做这一步）。
// 按命令的 spec 解析（READ_COMMANDS、API_SPEC，其余用 FALLBACK_SPEC），所以带值选项吃掉的下一个参数
// （`--body -h`、`-q --watch`）和 `--` 之后的位置参数都不算；把 `-h` 当值的命令（H_VALUE_COMMANDS）也不认 help。
// 出现 spec 里没有的选项就看不清哪个参数是它的值：保守地不豁免。
function hasBareExemptOption(argv) {
  const { spec, shortHelp } = commandFlags(argv)
  const parsed = parseFlags(argv, {
    long: new Map([...spec.long, ['watch', 'bool']]),
    short: spec.short,
  }, { shortHelp })
  if (parsed.unknown) return false
  return parsed.bools.has('help') || parsed.implicitHelp || parsed.bools.has('watch')
    || (argv[0] === 'api' && parsed.bools.has('verbose'))
}

// 不占并发槽的调用：不发 API 请求（help、auth）、人在终端里的、调试输出、长时间流式的命令。
// 单独看 argv 和环境，不依赖 classify 的 reason（reason 会被 @me、GH_HOST 等更早的判断遮住）。
export function isGateExempt(argv, { env = {}, stdoutIsTTY = false } = {}) {
  argv = normalizeRootFlags(argv)
  if (argv.length === 0 || HELP_FIRST.has(argv[0])) return true
  if (stdoutIsTTY || env.GH_DEBUG) return true
  if (argv[0] === 'auth') return true
  if (argv[0] === 'run' && argv[1] === 'watch') return true
  return hasBareExemptOption(argv)
}
