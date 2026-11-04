// [MIVO-PATCH reviewer-app] 默认分支读取:GraphQL defaultBranchRef,不用 repos/<o>/<r> 根 REST。
// 纯函数,不发请求;调用方(mivo/server/review.mjs)用 gh api graphql --input - 执行。

const DEFAULT_BRANCH_QUERY = 'query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){defaultBranchRef{name}}}';

/** targetRepo(owner/repo)→ gh 参数与 stdin。格式不对抛错并写出期望与实际。 */
export function toDefaultBranchRequest(targetRepo) {
  const parts = String(targetRepo ?? '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`targetRepo 必须是 owner/repo(实际 ${JSON.stringify(String(targetRepo ?? '').slice(0, 80))})`);
  }
  const [owner, repo] = parts;
  return { args: ['api', 'graphql', '--input', '-'], input: JSON.stringify({ query: DEFAULT_BRANCH_QUERY, variables: { owner, repo } }) };
}

/** 解析 gh api graphql 的 stdout,返回默认分支名;errors 非空或缺字段抛错(不默认 main)。 */
export function parseDefaultBranch(stdout, targetRepo) {
  let parsed;
  try { parsed = JSON.parse(String(stdout ?? '')); } catch (error) {
    throw new Error(`${targetRepo} 的 defaultBranchRef 响应不是合法 JSON(${error.message})`);
  }
  const errors = Array.isArray(parsed?.errors) ? parsed.errors : parsed?.errors != null ? [parsed.errors] : [];
  if (errors.length) {
    throw new Error(`${targetRepo} 读默认分支失败:${errors.map((error) => String(error?.message ?? error).slice(0, 160)).join('; ')}`);
  }
  const repository = parsed?.data?.repository;
  if (!repository) throw new Error(`${targetRepo} 读默认分支失败:响应里没有 repository(期望 data.repository.defaultBranchRef.name)`);
  const name = repository.defaultBranchRef?.name;
  if (typeof name !== 'string' || !name) {
    throw new Error(`${targetRepo} 读默认分支失败:缺 defaultBranchRef(期望非空分支名,实际 ${JSON.stringify(repository.defaultBranchRef ?? null)})`);
  }
  return name;
}
