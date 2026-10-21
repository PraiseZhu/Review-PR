#!/usr/bin/env node
// maintainer-authority.test.mjs — CODEOWNERS 根 Team、成员分页、digest 与快照安全回归。

import {
  parseMaintainerTeamFromCodeowners,
  fetchMaintainerAuthority as fetchMaintainerAuthorityWithConfig,
  computeMaintainerAuthorityDigest,
  validateMaintainerAuthoritySnapshot,
  evaluateMaintainerApprovalPolicy,
  evaluateApprovalExemption,
  normalizeMaintainerAllowlist,
  MAINTAINER_AUTHORITY_VERSION,
} from './lib.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  check(name, actual === expected, `got ${actual}, want ${expected}`);
}
function throws(name, fn, pattern) {
  try {
    fn();
    check(name, false, '没有抛错');
  } catch (error) {
    check(name, pattern.test(String(error?.message ?? error)), String(error?.message ?? error));
  }
}

const ok = (value) => ({ ok: true, stdout: JSON.stringify(value), stderr: '', status: 0 });
const bad = (message = 'HTTP 404 Not Found') => ({ ok: false, stdout: '', stderr: message, status: 1 });
const empty204 = () => ({ ok: true, stdout: '', stderr: '', status: 0 });
const asResult = (value) => (
  value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok')
    ? value
    : ok(value)
);
const fetchMaintainerAuthority = (options = {}) => fetchMaintainerAuthorityWithConfig({
  maintainerAllowlist: [],
  ...options,
});

function makeGh({
  codeownersPath = '.github/CODEOWNERS',
  codeowners = '* @Acme/Maintainers\n',
  members = [[{ login: 'Zed' }, { login: 'alice' }], [{ login: 'ALICE' }, { login: 'bob' }]],
  repoMeta = { default_branch: 'main' },
  commitMeta = { sha: 'a'.repeat(40) },
  teamMeta = { privacy: 'closed' },
  teamRepo = { permissions: { pull: true, push: true, maintain: false, admin: false } },
  teamRepoDefault = null,
  teamRepoMedia = null,
  teamReposList = null,
  teamResult = null,
  contentsOverrides = {},
} = {}) {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args.slice());
    const endpoint = args.find((arg) => typeof arg === 'string' && (
      arg.startsWith('repos/') || arg.startsWith('orgs/')
    ));
    if (endpoint === 'repos/Acme/Widget') return ok(repoMeta);
    if (endpoint === 'repos/Acme/Widget/commits/main') return ok(commitMeta);
    if (endpoint?.startsWith('repos/Acme/Widget/contents/')) {
      const path = endpoint.slice('repos/Acme/Widget/contents/'.length);
      if (Object.prototype.hasOwnProperty.call(contentsOverrides, path)) return contentsOverrides[path];
      if (path !== codeownersPath) return bad();
      return ok({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(codeowners, 'utf8').toString('base64'),
        sha: 'blob-sha',
      });
    }
    if (endpoint === 'orgs/acme/teams/maintainers') return ok(teamMeta);
    if (endpoint === 'orgs/acme/teams/maintainers/repos/Acme/Widget') {
      const wantsMedia = args.some((arg) => String(arg).includes('application/vnd.github.v3.repository+json'));
      if (wantsMedia) return asResult(teamRepoMedia ?? teamRepo);
      return asResult(teamRepoDefault ?? teamRepo);
    }
    if (endpoint === 'orgs/acme/teams/maintainers/repos') {
      return asResult(teamReposList ?? [[]]);
    }
    if (endpoint === 'orgs/acme/teams/maintainers/members') {
      return teamResult ?? ok(members);
    }
    return bad(`unexpected ${endpoint ?? args.join(' ')}`);
  };
  return { ghFn, calls };
}

// CODEOWNERS 根规则：只认唯一 `* @org/team`。
eq('解析唯一根 Team', parseMaintainerTeamFromCodeowners(`
# comment
/docs @acme/docs
*   @Acme/Maintainers   # root owner
/src @acme/app
`, { repoOwner: 'ACME' }), {
  line: 4,
  org: 'acme',
  teamSlug: 'maintainers',
  teamHandle: '@acme/maintainers',
});
throws('缺根规则拒绝', () => parseMaintainerTeamFromCodeowners('/src @acme/app', { repoOwner: 'acme' }), /缺少唯一/);
throws('重复根规则拒绝', () => parseMaintainerTeamFromCodeowners('* @acme/a\n* @acme/b', { repoOwner: 'acme' }), /2 条/);
throws('个人 root owner 拒绝', () => parseMaintainerTeamFromCodeowners('* @alice', { repoOwner: 'acme' }), /必须是 @org\/team-slug/);
throws('多个 root owner 拒绝', () => parseMaintainerTeamFromCodeowners('* @acme/a @acme/b', { repoOwner: 'acme' }), /必须且只能/);
throws('跨组织 Team 拒绝', () => parseMaintainerTeamFromCodeowners('* @other/a', { repoOwner: 'acme' }), /不属于仓库组织/);
throws('近似根模式不算根规则', () => parseMaintainerTeamFromCodeowners('/* @acme/a', { repoOwner: 'acme' }), /缺少唯一/);

// 完整抓取：位置优先级、固定默认分支 SHA、分页、规范化与 digest。
{
  const { ghFn, calls } = makeGh();
  const authority = fetchMaintainerAuthority({
    owner: 'Acme', repo: 'Widget', ghFn, nowIso: '2026-08-24T00:00:00.000Z',
  });
  eq('成员分页去重排序', authority.members, ['alice', 'bob', 'zed']);
  eq('Team 成员单独保留', authority.teamMembers, ['alice', 'bob', 'zed']);
  eq('空补充白名单单独保留', authority.allowlistedMembers, []);
  check('Team 成员人数正确', authority.teamMemberCount === 3);
  check('补充白名单人数正确', authority.allowlistedMemberCount === 0);
  check('成员人数正确', authority.memberCount === 3);
  check('Team 规范化', authority.codeowners.teamHandle === '@acme/maintainers');
  check('Team 必须可见', authority.codeowners.teamPrivacy === 'closed');
  check('记录 Team 仓库权限', authority.codeowners.repositoryPermission === 'push');
  check('记录默认分支 SHA', authority.base.sha === 'a'.repeat(40));
  check('记录首个 CODEOWNERS 路径', authority.codeowners.path === '.github/CODEOWNERS');
  check('contents 固定到 SHA', calls.some((args) => args.includes(`ref=${'a'.repeat(40)}`)));
  check('Team API 使用完整分页', calls.some((args) =>
    args.includes('--paginate') && args.includes('--slurp') && args.includes('role=all') && args.includes('per_page=100')));
  check('digest 有前缀', /^sha256:[0-9a-f]{64}$/.test(authority.digest));
}
{
  const { ghFn } = makeGh();
  const authority = fetchMaintainerAuthority({
    owner: 'Acme', repo: 'Widget', ghFn, maintainerAllowlist: ['FMFSAISAI', 'alice'],
  });
  eq('最终成员是 Team 与补充白名单并集', authority.members, ['alice', 'bob', 'fmfsaisai', 'zed']);
  eq('补充白名单规范化去重排序', authority.allowlistedMembers, ['alice', 'fmfsaisai']);
  check('并集人数去重', authority.memberCount === 4);
  check('补充白名单人数按白名单自身计数', authority.allowlistedMemberCount === 2);
}
eq('白名单规范化', normalizeMaintainerAllowlist([' FMFSAISAI ', 'fmfsaisai', 'Alice']), ['alice', 'fmfsaisai']);
throws('白名单形状异常拒绝', () => normalizeMaintainerAllowlist('fmfsaisai'), /必须是.*数组/);
throws('白名单 login 异常拒绝', () => normalizeMaintainerAllowlist(['good', 'bad login']), /不是有效/);
throws('白名单 login 不能以连字符结尾', () => normalizeMaintainerAllowlist(['bad-']), /不是有效/);
{
  const { ghFn } = makeGh({
    teamRepo: { permissions: { pull: true, push: true, maintain: true, admin: false } },
  });
  const authority = fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
  check('maintain 权限映射', authority.codeowners.repositoryPermission === 'maintain');
}
{
  const { ghFn } = makeGh({
    teamRepo: { permissions: { pull: true, push: true, maintain: true, admin: true } },
  });
  const authority = fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
  check('admin 权限映射', authority.codeowners.repositoryPermission === 'admin');
}
{
  const { ghFn, calls } = makeGh({
    teamRepoDefault: empty204(),
    teamRepoMedia: {
      full_name: 'Acme/Widget',
      role_name: 'maintain',
      permissions: { pull: true, push: true, maintain: true, admin: false },
    },
  });
  try {
    const authority = fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
    check('默认 204 后用 repository media type 读到 maintain', authority.codeowners.repositoryPermission === 'maintain');
    eq('204 恢复后成员名单仍完整去重', authority.members, ['alice', 'bob', 'zed']);
    check('204 后补打了 repository media type', calls.some((args) => (
      args.includes('orgs/acme/teams/maintainers/repos/Acme/Widget')
      && args.some((arg) => String(arg).includes('application/vnd.github.v3.repository+json'))
    )));
    check('repository media header 不含空格，避免 Windows shell 拆参', calls.some((args) => (
      args.includes('Accept:application/vnd.github.v3.repository+json')
    )));
    check('204 恢复后仍分页读成员', calls.some((args) => (
      args.includes('orgs/acme/teams/maintainers/members')
      && args.includes('--paginate')
      && args.includes('--slurp')
      && args.includes('role=all')
    )));
  } catch (error) {
    check('默认 204 后用 repository media type 读到 maintain', false, String(error?.message ?? error));
  }
}
{
  const { ghFn } = makeGh({
    teamRepoDefault: empty204(),
    teamRepoMedia: empty204(),
    teamReposList: [[{
      full_name: 'Acme/Widget',
      role_name: 'write',
      permissions: { pull: true, push: true, maintain: false, admin: false },
    }]],
  });
  try {
    const authority = fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
    check('204 且 media 仍空时从 Team 仓库列表回退到 write/push', authority.codeowners.repositoryPermission === 'push');
    eq('列表回退后成员名单仍完整', authority.members, ['alice', 'bob', 'zed']);
  } catch (error) {
    check('204 且 media 仍空时从 Team 仓库列表回退到 write/push', false, String(error?.message ?? error));
  }
}
{
  const { ghFn, calls } = makeGh();
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
  check('默认已有权限时不请求 media type', !calls.some((args) => (
    args.some((arg) => String(arg).includes('application/vnd.github.v3.repository+json'))
  )));
  check('默认已有权限时不拉 Team 仓库列表', !calls.some((args) => (
    args.includes('orgs/acme/teams/maintainers/repos') && !args.includes('orgs/acme/teams/maintainers/repos/Acme/Widget')
  )));
}
{
  const { ghFn } = makeGh({ codeownersPath: 'CODEOWNERS' });
  const authority = fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
  check('第二位置回退', authority.codeowners.path === 'CODEOWNERS');
}
{
  const { ghFn } = makeGh({ codeownersPath: 'docs/CODEOWNERS' });
  const authority = fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
  check('第三位置回退', authority.codeowners.path === 'docs/CODEOWNERS');
}

// 任何不完整来源都 fail closed。
throws('无 CODEOWNERS 拒绝', () => {
  const { ghFn } = makeGh({ codeownersPath: 'missing' });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /没有可读取/);
throws('高优先级 CODEOWNERS 非 404 失败时不降级到下一位置', () => {
  const { ghFn } = makeGh({
    codeownersPath: 'CODEOWNERS',
    contentsOverrides: { '.github/CODEOWNERS': bad('HTTP 403 Forbidden') },
  });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /403/);
throws('默认分支缺失拒绝', () => {
  const { ghFn } = makeGh({ repoMeta: {} });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /没有可验证的默认分支/);
throws('commit SHA 异常拒绝', () => {
  const { ghFn } = makeGh({ commitMeta: { sha: 'short' } });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /SHA 无效/);
throws('读取期间默认分支变化拒绝', () => {
  const base = makeGh();
  let commitReads = 0;
  const ghFn = (args, options) => {
    if (args.includes('repos/Acme/Widget/commits/main')) {
      commitReads += 1;
      if (commitReads === 2) return ok({ sha: 'b'.repeat(40) });
    }
    return base.ghFn(args, options);
  };
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /读取期间发生变化/);
throws('secret Team 拒绝', () => {
  const { ghFn } = makeGh({ teamMeta: { privacy: 'secret' } });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /必须是 GitHub 可见 Team/);
throws('只读 Team 拒绝', () => {
  const { ghFn } = makeGh({ teamRepo: { permissions: { pull: true, push: false, maintain: false, admin: false } } });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /没有可验证的 write\/maintain\/admin 权限/);
throws('Team 仓库权限形状异常拒绝', () => {
  const { ghFn } = makeGh({ teamRepo: {} });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /没有可验证的 write\/maintain\/admin 权限/);
throws('204 且 media 只读仍拒绝', () => {
  const { ghFn } = makeGh({
    teamRepoDefault: empty204(),
    teamRepoMedia: { permissions: { pull: true, push: false, maintain: false, admin: false }, role_name: 'read' },
    teamReposList: [[]],
  });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /没有可验证的 write\/maintain\/admin 权限/);
throws('204 且列表没有该仓库仍拒绝', () => {
  const { ghFn } = makeGh({
    teamRepoDefault: empty204(),
    teamRepoMedia: empty204(),
    teamReposList: [[{
      full_name: 'Acme/Other',
      permissions: { pull: true, push: true, maintain: false, admin: false },
    }]],
  });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /没有可验证的 write\/maintain\/admin 权限/);
throws('默认 Team 仓库权限 403 不伪装成 204', () => {
  const { ghFn } = makeGh({
    teamRepoDefault: bad('HTTP 403: Resource not accessible by personal access token'),
  });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /403/);
throws('Team API 失败拒绝', () => {
  const { ghFn } = makeGh({ teamResult: bad('HTTP 403 Forbidden') });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn, maintainerAllowlist: ['fmfsaisai'] });
}, /403/);
throws('分页结果形状异常拒绝', () => {
  const { ghFn } = makeGh({ teamResult: ok({ login: 'alice' }) });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /分页.*形状异常/);
throws('成员对象异常拒绝', () => {
  const { ghFn } = makeGh({ members: [[{ login: 'alice' }, {}]] });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /无效账号/);
throws('空 Team 拒绝', () => {
  const { ghFn } = makeGh({ members: [[]] });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /没有可验证的有效成员/);
throws('CODEOWNERS 响应形状异常拒绝', () => {
  const { ghFn } = makeGh({
    contentsOverrides: {
      '.github/CODEOWNERS': ok({ type: 'file', encoding: 'none', content: null }),
    },
  });
  fetchMaintainerAuthority({ owner: 'Acme', repo: 'Widget', ghFn });
}, /不是可读取的 base64/);

// digest 只跟有效权限变化；抓取时间、默认分支 SHA、blob SHA 不影响。
const baseAuthority = {
  version: MAINTAINER_AUTHORITY_VERSION,
  repository: 'Acme/Widget',
  fetchedAt: '2026-08-24T00:00:00Z',
  base: { ref: 'main', sha: 'a'.repeat(40) },
  codeowners: {
    path: '.github/CODEOWNERS', blobSha: 'blob-a', org: 'acme', teamSlug: 'maintainers', teamHandle: '@acme/maintainers',
    teamPrivacy: 'closed', repositoryPermission: 'push',
  },
  teamMembers: ['alice', 'bob'],
  teamMemberCount: 2,
  allowlistedMembers: [],
  allowlistedMemberCount: 0,
  members: ['alice', 'bob'],
  memberCount: 2,
};
const baseDigest = computeMaintainerAuthorityDigest(baseAuthority);
check('无关审计字段不改 digest', baseDigest === computeMaintainerAuthorityDigest({
  ...baseAuthority,
  fetchedAt: '2026-08-25T00:00:00Z',
  base: { ref: 'main', sha: 'b'.repeat(40) },
  codeowners: { ...baseAuthority.codeowners, blobSha: 'blob-b' },
}));
check('成员顺序与大小写不改 digest', baseDigest === computeMaintainerAuthorityDigest({
  ...baseAuthority, members: ['BOB', 'Alice'],
}));
check('成员变化会改 digest', baseDigest !== computeMaintainerAuthorityDigest({
  ...baseAuthority,
  allowlistedMembers: ['carol'], allowlistedMemberCount: 1,
  members: ['alice', 'bob', 'carol'], memberCount: 3,
}));
check('有效成员不变但来源变化仍会改 digest', baseDigest !== computeMaintainerAuthorityDigest({
  ...baseAuthority,
  teamMembers: ['alice'], teamMemberCount: 1,
  allowlistedMembers: ['bob'], allowlistedMemberCount: 1,
}));
check('根 Team 变化会改 digest', baseDigest !== computeMaintainerAuthorityDigest({
  ...baseAuthority,
  codeowners: { ...baseAuthority.codeowners, teamSlug: 'owners', teamHandle: '@acme/owners' },
}));
check('Team 仓库权限变化会改 digest', baseDigest !== computeMaintainerAuthorityDigest({
  ...baseAuthority,
  codeowners: { ...baseAuthority.codeowners, repositoryPermission: 'maintain' },
}));

const snapshot = { ...baseAuthority, digest: baseDigest, runToken: '12345678-abcd' };
check('合法快照通过', validateMaintainerAuthoritySnapshot(snapshot, {
  owner: 'Acme', repo: 'Widget', lockToken: '12345678-abcd', expectedDigest: baseDigest,
}) === snapshot);
throws('旧锁 token 拒绝', () => validateMaintainerAuthoritySnapshot(snapshot, {
  owner: 'Acme', repo: 'Widget', lockToken: 'other-token', expectedDigest: baseDigest,
}), /不属于当前 review 锁/);
throws('错误仓库拒绝', () => validateMaintainerAuthoritySnapshot(snapshot, {
  owner: 'Acme', repo: 'Other', lockToken: '12345678-abcd', expectedDigest: baseDigest,
}), /仓库不匹配/);
throws('成员未规范化拒绝', () => validateMaintainerAuthoritySnapshot({
  ...snapshot, teamMembers: ['Bob', 'alice'],
}, { owner: 'Acme', repo: 'Widget', lockToken: '12345678-abcd' }), /去重、排序的小写/);
throws('最终成员不是并集拒绝', () => validateMaintainerAuthoritySnapshot({
  ...snapshot, members: ['alice'], memberCount: 1,
}, { owner: 'Acme', repo: 'Widget', lockToken: '12345678-abcd' }), /不是 Team 与补充白名单的并集/);
throws('快照篡改拒绝', () => validateMaintainerAuthoritySnapshot({
  ...snapshot,
  allowlistedMembers: ['carol'], allowlistedMemberCount: 1,
  members: ['alice', 'bob', 'carol'], memberCount: 3,
}, { owner: 'Acme', repo: 'Widget', lockToken: '12345678-abcd' }), /digest 校验失败/);
throws('expected digest 变化拒绝', () => validateMaintainerAuthoritySnapshot(snapshot, {
  owner: 'Acme', repo: 'Widget', lockToken: '12345678-abcd', expectedDigest: `sha256:${'f'.repeat(64)}`,
}), /权限已变化/);

const memberPolicy = evaluateMaintainerApprovalPolicy({
  authorLogin: 'ALICE', viewerLogin: 'Bob', authority: snapshot,
});
check('维护者作者免独立 Approve', memberPolicy.authorIsMaintainer && memberPolicy.approvalRequired === false);
check('另一位维护者 viewer 可 Approve', memberPolicy.viewerCanApprove && !memberPolicy.viewerIsAuthor);
check('非维护者作者需要 Approve', evaluateMaintainerApprovalPolicy({
  authorLogin: 'outsider', authority: snapshot,
}).approvalRequired);
check('维护者作者获得 approval exemption', evaluateApprovalExemption({
  authorLogin: 'alice', authority: snapshot,
}).exempt);
const allowlistAuthority = {
  ...snapshot,
  allowlistedMembers: ['fmfsaisai'], allowlistedMemberCount: 1,
  members: ['alice', 'bob', 'fmfsaisai'], memberCount: 3,
};
const allowlistPolicy = evaluateMaintainerApprovalPolicy({
  authorLogin: 'fmfsaisai', viewerLogin: 'fmfsaisai', authority: allowlistAuthority,
});
check('补充白名单作者免独立 Approve', allowlistPolicy.authorIsMaintainer && allowlistPolicy.approvalRequired === false);
check('viewer=作者时不得自批', allowlistPolicy.viewerIsMaintainer &&
  allowlistPolicy.viewerIsAuthor && !allowlistPolicy.viewerCanApprove);
const crossMaintainerPolicy = evaluateMaintainerApprovalPolicy({
  authorLogin: 'fmfsaisai', viewerLogin: 'alice', authority: allowlistAuthority,
});
check('另一位维护者可为白名单维护者作者 Approve',
  crossMaintainerPolicy.authorIsMaintainer && crossMaintainerPolicy.viewerCanApprove);
check('补充白名单来源可审计',
  allowlistPolicy.authorAuthoritySource === 'maintainer-allowlist' &&
  evaluateApprovalExemption({ authorLogin: 'fmfsaisai', authority: allowlistAuthority }).source === 'maintainer-allowlist');
check('selfFix/static rules 不提供 exemption', !evaluateApprovalExemption({
  authorLogin: 'magiclizi', authority: snapshot, rules: { selfFixAuthors: ['magiclizi'] },
}).exempt);

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('maintainer-authority.test.mjs: 全部用例通过');
