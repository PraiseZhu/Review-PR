// Compatibility for the three PR JSON fields missing from older gh releases.
// This module has no process, repository, or filesystem state. runRaw is the
// existing gh runner; only an exact unsupported-field response enables fallback.
const COMPAT_FIELDS = new Set(['headRefOid', 'baseRefOid', 'closingIssuesReferences']);
const OID_RE = /^[a-f0-9]{40}$/i;

class CommandFailure extends Error {
  constructor(args, result) {
    super(`gh ${args.join(' ')} ${result.status === -1 ? '执行失败' : `退出码 ${result.status}`}: ${(result.stderr ?? '').trim()}`);
    this.result = result;
  }
}

function jsonObject(text, description) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${description}: malformed JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description}: expected a JSON object`);
  }
  return value;
}

function fieldList(args) {
  const index = args.indexOf('--json');
  if (index >= 0) return String(args[index + 1] ?? '').split(',').filter(Boolean);
  const inline = args.find((arg) => arg.startsWith('--json='));
  return inline ? inline.slice(7).split(',').filter(Boolean) : [];
}

function fallbackRequest(args) {
  let repo;
  const fields = fieldList(args);
  for (let i = 3; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--repo' || arg === '-R') { repo = args[++i]; continue; }
    if (arg.startsWith('--repo=')) { repo = arg.slice(7); continue; }
    if (arg === '--json') { i += 1; continue; }
    if (arg.startsWith('--json=')) continue;
    // jq/template transform the output shape. Do not silently merge JSON into
    // their projected output; a modern CLI still receives these flags unchanged.
    throw new Error(`gh PR field compatibility: cannot safely preserve option ${arg}`);
  }
  const number = Number(args[2]);
  const match = typeof repo === 'string' && repo.match(/^([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i);
  if (!/^\d+$/.test(args[2] ?? '') || !Number.isSafeInteger(number) || number <= 0 || !match) {
    throw new Error('gh PR field compatibility requires an explicit PR number and --repo owner/repo');
  }
  if (new Set(fields).size !== fields.length || fields.some((field) => !/^[A-Za-z][A-Za-z0-9]*$/.test(field))) {
    throw new Error('gh PR field compatibility: invalid or duplicate JSON fields');
  }
  return { number, owner: match[1], repo: match[2], slug: repo, fields };
}

function checkedPull(parsed, request) {
  if (parsed.errors != null && (!Array.isArray(parsed.errors) || parsed.errors.length > 0)) {
    throw new Error('gh PR field compatibility: GraphQL errors or partial data');
  }
  const repository = parsed.data?.repository;
  const pull = repository?.pullRequest;
  if (typeof repository?.nameWithOwner !== 'string'
      || repository.nameWithOwner.toLowerCase() !== request.slug.toLowerCase()
      || !pull || pull.number !== request.number) {
    throw new Error('gh PR field compatibility: response repository/PR identity mismatch');
  }
  if (!OID_RE.test(pull.headRefOid ?? '') || !OID_RE.test(pull.baseRefOid ?? '')
      || typeof pull.body !== 'string' || typeof pull.updatedAt !== 'string' || !pull.updatedAt) {
    throw new Error('gh PR field compatibility: missing or invalid head/base/body/version');
  }
  return pull;
}

const identity = (pull) => JSON.stringify([pull.number, pull.headRefOid, pull.baseRefOid, pull.body, pull.updatedAt]);

function graphQuery({ request, withIssues, cursor, runRaw, opts }) {
  const query = `query($owner:String!,$repo:String!,$number:Int!${withIssues ? ',$cursor:String' : ''}) {
    repository(owner:$owner,name:$repo) { nameWithOwner
      pullRequest(number:$number) { number headRefOid baseRefOid body updatedAt
        ${withIssues ? 'closingIssuesReferences(first:100,after:$cursor) { totalCount nodes { number title body url repository { nameWithOwner } } pageInfo { hasNextPage endCursor } }' : ''}
      }
    }
  }`;
  const args = ['api', 'graphql', '-F', 'query=@-', '-f', `owner=${request.owner}`, '-f', `repo=${request.repo}`, '-F', `number=${request.number}`];
  if (withIssues && cursor != null) args.push('-f', `cursor=${cursor}`);
  const result = runRaw(args, { ...opts, allowFail: true, input: query });
  if (!result.ok) throw new CommandFailure(args, result);
  return checkedPull(jsonObject(result.stdout, 'gh GraphQL response'), request);
}

function compatibleView(args, opts, runRaw) {
  const request = fallbackRequest(args);
  if (opts.input != null) throw new Error('gh PR field compatibility cannot replace caller stdin');
  const withIssues = request.fields.includes('closingIssuesReferences');
  const issueNodes = [];
  const seenIssues = new Set();
  const seenCursors = new Set();
  let cursor = null;
  let anchor;
  let total;
  let complete = false;
  for (let page = 0; page < 50; page += 1) {
    const pull = graphQuery({ request, withIssues, cursor, runRaw, opts });
    if (anchor && identity(pull) !== identity(anchor)) throw new Error('gh PR field compatibility: PR changed while reading evidence');
    anchor ??= pull;
    if (!withIssues) { complete = true; break; }
    const connection = pull.closingIssuesReferences;
    if (!connection || !Array.isArray(connection.nodes) || !Number.isSafeInteger(connection.totalCount)
        || connection.totalCount < 0 || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error('gh PR field compatibility: incomplete closingIssuesReferences connection');
    }
    if (total != null && total !== connection.totalCount) throw new Error('gh PR field compatibility: issue count changed between pages');
    total = connection.totalCount;
    for (const node of connection.nodes) {
      if (!node || !Number.isSafeInteger(node.number) || node.number <= 0
          || typeof node.title !== 'string' || typeof node.body !== 'string'
          || typeof node.url !== 'string' || !node.url
          || typeof node.repository?.nameWithOwner !== 'string' || !node.repository.nameWithOwner) {
        throw new Error('gh PR field compatibility: incomplete associated issue');
      }
      if (seenIssues.has(node.url)) throw new Error('gh PR field compatibility: duplicate issue across pages');
      seenIssues.add(node.url);
      issueNodes.push(node);
    }
    if (!connection.pageInfo.hasNextPage) {
      if (issueNodes.length !== total) throw new Error('gh PR field compatibility: truncated associated issue list');
      complete = true;
      break;
    }
    const next = connection.pageInfo.endCursor;
    if (typeof next !== 'string' || !next || seenCursors.has(next) || connection.nodes.length === 0) {
      throw new Error('gh PR field compatibility: pagination cursor did not advance');
    }
    seenCursors.add(next);
    cursor = next;
  }
  if (!complete) throw new Error('gh PR field compatibility: pagination limit exceeded');

  // Fetch body with its associated issues in GraphQL, never by joining a body
  // read by gh pr view with a different PR version's association response.
  const nativeFields = request.fields.filter((field) => !COMPAT_FIELDS.has(field) && field !== 'body');
  let native = {};
  if (nativeFields.length) {
    const readFields = [...new Set([...nativeFields, 'number', 'url'])];
    const nativeArgs = ['pr', 'view', String(request.number), '--repo', request.slug, '--json', readFields.join(',')];
    const result = runRaw(nativeArgs, { ...opts, allowFail: true });
    if (!result.ok) throw new CommandFailure(nativeArgs, result);
    native = jsonObject(result.stdout, 'gh PR response');
    let url;
    try { url = new URL(native.url); } catch { throw new Error('gh PR field compatibility: missing PR URL'); }
    if (native.number !== request.number || url.pathname.toLowerCase() !== `/${request.slug}/pull/${request.number}`.toLowerCase()) {
      throw new Error('gh PR field compatibility: native response PR identity mismatch');
    }
    for (const field of nativeFields) {
      if (!Object.hasOwn(native, field)) throw new Error(`gh PR field compatibility: native response missing ${field}`);
    }
  }
  // Bracket the remaining native read and pagination with the same head/base,
  // body and PR updatedAt. This is an observed consistency check, not a remote
  // transaction: edits to issue bodies between pages remain GitHub's live data.
  if (nativeFields.length || seenCursors.size) {
    const finalPull = graphQuery({ request, withIssues: false, cursor: null, runRaw, opts });
    if (identity(finalPull) !== identity(anchor)) throw new Error('gh PR field compatibility: PR changed while reading evidence');
  }
  const values = { ...native, headRefOid: anchor.headRefOid, baseRefOid: anchor.baseRefOid, body: anchor.body, closingIssuesReferences: issueNodes };
  return { ok: true, stdout: `${JSON.stringify(Object.fromEntries(request.fields.map((field) => [field, values[field]])))}\n`, stderr: '', status: 0 };
}

export function runGhWithPrViewCompat(args, opts = {}, { runRaw }) {
  if (args[0] !== 'pr' || args[1] !== 'view' || !fieldList(args).some((field) => COMPAT_FIELDS.has(field))) {
    return runRaw(args, opts);
  }
  const result = runRaw(args, { ...opts, allowFail: true });
  if (result.ok) return result;
  const unknown = (result.stderr ?? '').match(/^\s*Unknown JSON field:\s*"([A-Za-z][A-Za-z0-9]*)"\s*$/m)?.[1];
  if (!unknown || !COMPAT_FIELDS.has(unknown) || !fieldList(args).includes(unknown)) {
    if (opts.allowFail) return result;
    throw new CommandFailure(args, result);
  }
  try {
    return compatibleView(args, opts, runRaw);
  } catch (error) {
    if (!opts.allowFail) throw error;
    return error instanceof CommandFailure ? error.result : { ok: false, stdout: '', stderr: error.message, status: 1 };
  }
}
