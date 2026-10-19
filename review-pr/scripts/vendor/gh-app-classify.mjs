// [MIVO-PATCH app-read-route] 原样搬运,不要在这里改逻辑。
// 来源:xindong/mivo-canvas-plugin scripts/ops/gh-app-router/classify.mjs @ 077a4bb56(原文件 sha256 12dd0e7f9f7082d1c650424f66d40ca972c9e575d5a7771178d533110cb09245)。
// Mini 上的 gh 分流器用同一份规则;服务器发布步骤用它判断「这条 gh 请求能不能改用 App 只读令牌」。
// 规则要改,先改插件仓那份,再整份重新搬运,并更新 gh-read-route.test.mjs 里的 sha256。
// gh 命令分类器（纯函数，不碰文件系统；readFile 由调用方注入）。
//
// 默认走 PraiseZhu（user）。只有同时满足「只读、不依赖身份、目标仓在白名单」的请求
// 才走 GitHub App（app）；看不懂的一律 user。分类出错的后果由「App 令牌只有只读权限」兜底。
//
// 本目录会被整份拷到 Mini 部署，只能 import node 内置模块，不能 import 仓库其它文件。

export const APP = 'app'
export const USER = 'user'

// helpers
const toUser = (reason, cmd) => ({ route: USER, reason, cmd })
const toApp = (reason, cmd) => ({ route: APP, reason, cmd })

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
const NODE_IDENTITY_CONNECTIONS = /\b(?:repositories|repositoriesContributedTo|organizations|starredRepositories|watching|pinnedItems|pinnableItems|gists|packages|sponsoring|sponsors|contributionsCollection)\b/
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

// 支持 --long=v、--long v、-x v、-xv、-x=v、`--` 之后全是位置参数；合并短参数或未知参数 → unknown。
export function parseFlags(args, spec) {
  const out = { ordered: [], values: new Map(), bools: new Set(), positionals: [], unknown: false }
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
        if (eq !== -1) out.unknown = true
        else out.bools.add(name)
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
      if (!name) { out.unknown = true; continue }
      if (spec.long.get(name) === 'bool') {
        if (arg.length > 2) out.unknown = true
        else out.bools.add(name)
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
  'variable get': {
    reason: 'variable_read', needJson: false, deny: { org: 'org_or_env', env: 'org_or_env' },
    spec: makeSpec({ value: [...REPO_FLAG, 'jq:q', 'json', 'template:t', 'env:e', 'org:o'] }),
  },
  'variable list': {
    reason: 'variable_read', needJson: false, deny: { org: 'org_or_env', env: 'org_or_env' },
    spec: makeSpec({ value: [...REPO_FLAG, 'jq:q', 'json', 'template:t', 'env:e', 'org:o'] }),
  },
}

// headRepository / headRepositoryOwner 指向 fork 仓：App 看不到时 GitHub 照样成功、字段缺失，不会回落，所以交给 PraiseZhu。
const SENSITIVE_JSON_FIELDS = new Set(['reviewrequests', 'projectcards', 'projectitems', 'headrepository', 'headrepositoryowner'])

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

function classifyGraphql(parsed, ctx, cmd) {
  const method = lastValue(parsed, 'method')
  if (method !== undefined && method.toUpperCase() !== 'POST') return toUser('graphql_method', cmd)

  const input = lastValue(parsed, 'input')
  let queryText
  let variables = {}
  const readText = (src) => {
    if (src === '-') return ctx.stdinText
    return ctx.readFile(src)
  }
  try {
    if (input !== undefined) {
      if (parsed.ordered.some((f) => f.long === 'raw-field' || f.long === 'field')) return toUser('graphql_shape', cmd)
      const raw = readText(input)
      if (typeof raw !== 'string') return toUser('graphql_unparsed', cmd)
      let body
      try { body = JSON.parse(raw) } catch { return toUser('graphql_unparsed', cmd) }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.query !== 'string') {
        return toUser('graphql_unparsed', cmd)
      }
      if (body.variables !== undefined && (body.variables === null || typeof body.variables !== 'object' || Array.isArray(body.variables))) {
        return toUser('graphql_unparsed', cmd)
      }
      queryText = body.query
      variables = body.variables ?? {}
    } else {
      for (const { long, value } of parsed.ordered) {
        if (long !== 'raw-field' && long !== 'field') continue
        const eq = value.indexOf('=')
        if (eq === -1) return toUser('graphql_shape', cmd)
        const key = value.slice(0, eq)
        const val = value.slice(eq + 1)
        if (key === 'operationName') continue
        if (key === 'query') {
          if (val.startsWith('@')) {
            const raw = readText(val.slice(1))
            if (typeof raw !== 'string') return toUser('graphql_unparsed', cmd)
            queryText = raw
          } else {
            queryText = val
          }
          continue
        }
        if (long === 'field') {
          if (val.startsWith('@')) return toUser('field_from_file', cmd)
          if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(val)) continue // 非字符串，不能当仓库名
        }
        variables[key] = val
      }
    }
  } catch {
    return toUser('graphql_unreadable', cmd)
  }
  if (typeof queryText !== 'string' || queryText.trim() === '') return toUser('graphql_shape', cmd)

  // 在原文（含字符串和注释）上做保守检查，宁可多判给 user。
  if (/viewer/i.test(queryText)) return toUser('graphql_viewer', cmd)
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

export function needsStdin(argv) {
  if (argv[0] !== 'api') return false
  const parsed = parseFlags(argv.slice(1), API_SPEC)
  if (parsed.unknown || parsed.positionals.length !== 1) return false
  if (!isGraphqlEndpoint(normalizeEndpoint(parsed.positionals[0]))) return false
  if (lastValue(parsed, 'input') === '-') return true
  return parsed.ordered.some((f) => (f.long === 'raw-field' || f.long === 'field') && f.value === 'query=@-')
}

function classifyApi(argv, ctx) {
  const parsed = parseFlags(argv.slice(1), API_SPEC)
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
  if (endpoint === 'graphql') return classifyGraphql(parsed, ctx, 'api graphql')

  const fields = parsed.ordered.filter((f) => f.long === 'raw-field' || f.long === 'field')
  const hasInput = parsed.values.has('input')
  const explicit = lastValue(parsed, 'method')
  const method = (explicit ?? (fields.length > 0 || hasInput ? 'POST' : 'GET')).toUpperCase()
  if (method !== 'GET') return toUser(explicit === undefined ? 'fields_without_get' : 'write_method', cmd)
  if (hasInput) return toUser('input_body', cmd)
  if (fields.some((f) => f.value.slice(f.value.indexOf('=') + 1).startsWith('@'))) return toUser('field_from_file', cmd)

  const path = endpoint.split('?')[0]
  if (path.includes('{')) return toUser('placeholder', cmd)
  const raw = path.split('/')
  const segs = []
  for (const seg of raw) {
    if (seg === '' || seg === '.' || seg === '..') return toUser('unsafe_path', cmd)
    let decoded
    try { decoded = decodeURIComponent(seg) } catch { return toUser('unsafe_path', cmd) }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return toUser('unsafe_path', cmd)
    segs.push(decoded.toLowerCase())
  }
  if (segs[0] === 'user') return toUser('identity_endpoint', cmd)
  if (segs[0] !== 'repos') return toUser('non_repo_endpoint', cmd)
  if (segs.length < 3) return toUser('unsafe_path', cmd)
  if (!ctx.repoSet.has(`${segs[1]}/${segs[2]}`)) return toUser('repo_not_allowlisted', cmd)
  if (segs.length === 3) return toUser('identity_endpoint', cmd) // 仓库对象带随调用者变化的 permissions
  if (segs.slice(3).some((s) => DENY_SEGMENTS.has(s))) return toUser('admin_endpoint', cmd)
  if (!REST_ALLOWED.has(segs[3])) return toUser('endpoint_not_allowlisted', cmd)
  if (segs[3] === 'actions' && !ACTIONS_ALLOWED.has(segs[4])) return toUser('endpoint_not_allowlisted', cmd)
  return toApp('rest_get', cmd)
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
  const parsed = parseFlags(argv.slice(2), def.spec)
  if (parsed.unknown) return toUser('unsupported_flag', cmd)
  for (const [flag, reason] of Object.entries(def.deny)) {
    if (parsed.bools.has(flag) || parsed.values.has(flag)) return toUser(reason, cmd)
  }
  const json = lastValue(parsed, 'json')
  if (def.needJson && json === undefined) return toUser('human_output', cmd)
  if (json !== undefined) {
    for (const field of json.split(',')) {
      if (SENSITIVE_JSON_FIELDS.has(field.trim().toLowerCase())) return toUser('sensitive_json_field', cmd)
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

export function classify(argv, { repos = [], env = {}, stdinText = null, readFile, stdoutIsTTY = false } = {}) {
  const ctx = {
    repoSet: new Set(repos.map((r) => r.toLowerCase())),
    env,
    stdinText,
    readFile: readFile ?? (() => { throw new Error('readFile unavailable') }),
  }
  if (argv.length === 0) return toUser('no_command', 'other')
  if (HELP_FIRST.has(argv[0]) || argv.includes('--help') || argv.includes('-h')) return toUser('help', 'other')
  if (env.GH_HOST && env.GH_HOST.toLowerCase() !== GITHUB_HOST) return toUser('not_github_host', 'other')
  if (env.GH_DEBUG) return toUser('debug_output', 'other')
  if (stdoutIsTTY) return toUser('interactive', 'other')
  if (argv.some((a) => /@me\b/i.test(a))) return toUser('at_me', 'other')
  if (argv[0] === 'api') return classifyApi(argv, ctx)
  const key = `${argv[0]} ${argv[1] ?? ''}`
  if (Object.hasOwn(READ_COMMANDS, key)) return classifyRead(key, argv, ctx)
  if (WRITE_COMMANDS.has(key) || argv[0] === 'label') return toUser('write_command', key)
  if (argv[0] === 'auth') return toUser('auth', 'auth')
  if (key === 'run watch') return toUser('streaming', key)
  return toUser('unknown_command', 'other')
}
