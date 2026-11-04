// [MIVO-PATCH reviewer-app] 服务器审查 prepare 读默认分支:只用 GraphQL defaultBranchRef(App 安装令牌可读),
// 不再调 repos/<o>/<r> 根 REST(分类器把它判给个人账号),也不调 gh api user。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toDefaultBranchRequest, parseDefaultBranch } from './default-branch.mjs';

test('请求:参数化 GraphQL,owner/repo 来自 targetRepo,经 stdin 传入', () => {
  const request = toDefaultBranchRequest('xindong/mivo-canvas-plugin');
  assert.deepEqual(request.args, ['api', 'graphql', '--input', '-']);
  const body = JSON.parse(request.input);
  assert.match(body.query, /defaultBranchRef\{name\}/);
  assert.deepEqual(body.variables, { owner: 'xindong', repo: 'mivo-canvas-plugin' });
  assert.throws(() => toDefaultBranchRequest('no-slash'), /owner\/repo.*no-slash/);
  assert.throws(() => toDefaultBranchRequest('a/b/c'), /owner\/repo.*a\/b\/c/);
});

test('解析:取 defaultBranchRef.name;errors 非空、缺字段都报期望与实际,不默认 main', () => {
  const ok = (name) => JSON.stringify({ data: { repository: { defaultBranchRef: { name } } } });
  assert.equal(parseDefaultBranch(ok('main'), 'o/r'), 'main');
  assert.equal(parseDefaultBranch(ok('release/1.x'), 'o/r'), 'release/1.x');
  for (const [stdout, pattern] of [
    [JSON.stringify({ errors: [{ message: 'Resource not accessible by integration' }], data: null }), /Resource not accessible by integration/],
    [JSON.stringify({ data: { repository: null } }), /o\/r.*repository/],
    [JSON.stringify({ data: { repository: { defaultBranchRef: null } } }), /o\/r.*defaultBranchRef/],
    [JSON.stringify({ data: { repository: { defaultBranchRef: { name: '' } } } }), /o\/r.*defaultBranchRef/],
    ['not json', /o\/r.*JSON/],
  ]) assert.throws(() => parseDefaultBranch(stdout, 'o/r'), pattern);
});

test('review.mjs:不再有 gh api user,也不再读 repos/<o>/<r> 根 REST,改用 default-branch 辅助函数', () => {
  const source = readFileSync(new URL('../server/review.mjs', import.meta.url), 'utf8')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.equal(/['"]api['"],\s*['"]user['"]/.test(source), false, '不得调用 gh api user');
  // repos/${...targetRepo} 后面必须还有子路径;裸 `repos/${input.targetRepo}` 是仓库根 REST。
  assert.equal(/`repos\/\$\{[^}]*targetRepo\}`/.test(source), false, '不得读 repos/<o>/<r> 根 REST');
  assert.match(source, /toDefaultBranchRequest\(/);
  assert.match(source, /parseDefaultBranch\(/);
});
