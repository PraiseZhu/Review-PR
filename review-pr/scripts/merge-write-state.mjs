// Only errors proving the merge mutation was rejected may release an uncertain
// write ticket. Generic HTTP/network failures can happen after a successful merge.
const refusalRules = [
  ['merge-checks-rejected', /\brequired status check\b[\s\S]*(?:\bfail(?:ed|ing|ure)?\b|\bhas not succeeded\b|\b(?:is|are) (?:pending|expected|in progress)\b|\bmust pass\b)/i],
  ['merge-not-mergeable', /\bpull request is not mergeable\b/i],
  ['merge-head-changed', /\bhead (?:branch|sha) (?:was|has been|is) (?:modified|changed|out of date)\b/i],
  ['merge-base-changed', /\bbase branch (?:was|has been) (?:modified|changed)\b/i],
  ['merge-approval-required', /\b(?:at least \d+ approving reviews?|approving review is required|review required)\b/i],
  ['merge-threads-unresolved', /\b(?:all )?(?:conversations|review threads) must be resolved\b/i],
];

export function classifyMergeRejection(result) {
  if (!result || result.ok) return null;
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/ETIMEDOUT|ECONNRESET|EPIPE|\btimeout\b|timed out|connection reset|unexpected EOF|TLS|HTTP 50\d|context cancel/i.test(combined)) return null;
  let messages;
  for (const raw of [result.stdout, result.stderr]) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.data?.mergePullRequest === null && Array.isArray(parsed.errors) && parsed.errors.length &&
          parsed.errors.every((error) => error?.path?.[0] === 'mergePullRequest' && typeof error.message === 'string')) {
        messages = parsed.errors.map((error) => error.message);
        break;
      }
    } catch { /* gh usually renders GraphQL errors as text */ }
  }
  if (!messages) {
    const match = /^\s*GraphQL:\s*([\s\S]*?)\s*\(mergePullRequest\)\s*$/i.exec(String(result.stderr ?? ''));
    if (!match) return null;
    if (/\((?:mergePullRequest|deleteRef|enqueuePullRequest)\)|\bGraphQL:/.test(match[1])) return null;
    messages = [match[1].trim()];
  }
  const matched = messages.map((message) => refusalRules.find(([, pattern]) => pattern.test(message)));
  if (matched.some((rule) => !rule)) return null;
  return { status: 'rejected', code: matched[0][0], reason: `GitHub 明确拒绝合并：${messages.join('; ')}`,
    evidence: { operation: 'mergePullRequest', messages }, verifiedAt: new Date().toISOString() };
}
