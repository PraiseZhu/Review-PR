// [MIVO-PATCH reviewer-app] 失败信息不得带令牌:先抹掉环境里的令牌原值,再抹 GitHub 令牌格式与 Bearer 头。
export function scrubSecrets(text) {
  let out = String(text ?? '');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'REVIEW_PR_IDENTITY_TOKEN', 'REVIEW_PR_READ_TOKEN', 'CHECKS_TOKEN']) {
    const value = String(process.env[key] ?? '').trim();
    if (value.length >= 8) out = out.split(value).join('[redacted]');
  }
  return out.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/g, '[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
}
