import { spawnSync } from 'node:child_process';
import { isReviewVariable, REQUIRED_SECRETS, toCanonicalJson, toStep } from './cutover-lib.mjs';

const envName = 'slack-inbound';
const envSecret = 'MIVO_SLACK_BOT_TOKEN';
const encode = encodeURIComponent;
const api = (method, endpoint, body) => ({ method, endpoint, body });
const same = (left, right) => toCanonicalJson(left) === toCanonicalJson(right);
const isGlobalActor = (actor) => ['RepositoryRole', 'DeployKey', 'User'].includes(actor.actor_type);

function executeGh(args, options) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    const status = /HTTP (\d{3})/.exec(result.stderr ?? '')?.[1];
    const reason = status ? 'HTTP ' + status : (result.error?.code ?? '退出 ' + result.status);
    const error = new Error(reason);
    error.httpStatus = Number(status);
    throw error;
  }
  return result.stdout.trim();
}

export function request(operation, { pages = false, env } = {}) {
  const { method, endpoint, body } = operation;
  const args = ['api', '--method', method, endpoint];
  if (pages) args.push('--paginate', '--slurp');
  if (body !== undefined) args.push('--input', '-');
  try {
    const output = executeGh(args, { env, input: body === undefined ? undefined : JSON.stringify(body) });
    return output ? JSON.parse(output) : null;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(method + ' ' + endpoint + '：返回内容不是 JSON');
    error.message = method + ' ' + endpoint + '：' + error.message;
    throw error;
  }
}

const setSecretCode = [
  "const { spawnSync } = require('node:child_process');",
  "const [name, repo, environment] = process.argv.slice(1);",
  "const value = process.env[name]; if (!value) process.exit(2);",
  "const { [name]: ignored, ...env } = process.env;",
  "const args = ['secret', 'set', name, '-R', repo];",
  "if (environment) args.push('--env', environment);",
  "const result = spawnSync('gh', args, { env, input: value, stdio: ['pipe', 'ignore', 'ignore'], timeout: 120000 });",
  "process.exit(result.status === 0 ? 0 : 1);",
].join('\n');

export function executeGitHub(operation, manifest) {
  if (!operation.secret) return request(operation);
  const args = [operation.secret, manifest.newRepo, operation.environment ?? ''];
  if (manifest.rehearsal) {
    const cli = ['secret', 'set', args[0], '-R', args[1]];
    if (args[2]) cli.push('--env', args[2]);
    executeGh(cli, { input: 'CUTOVER_REHEARSAL_PLACEHOLDER_' + args[0] });
    return;
  }
  const result = spawnSync('agent-secret',
    ['run', args[0], '--', process.execPath, '-e', setSecretCode, ...args],
    { stdio: 'ignore', timeout: 120_000 });
  if (result.status !== 0) throw new Error('agent-secret / gh secret set 失败（' + (result.error?.code ?? '退出 ' + result.status) + '，输出已隐藏）');
}

export function undoGitHub(operation, manifest) {
  const root = 'repos/' + manifest.newRepo + '/';
  const relative = operation?.endpoint?.startsWith(root) ? operation.endpoint.slice(root.length) : '';
  if (!['PUT', 'PATCH', 'DELETE', 'POST'].includes(operation?.method) ||
      !(/^(actions\/variables\/[A-Z0-9_]+|labels\/[^/]+|rulesets\/\d+|environments\/slack-inbound(\/deployment-branch-policies(\/\d+)?)?)$/.test(relative) ||
        (operation.secretCreated && operation.method === 'DELETE' &&
          /^(actions|environments\/slack-inbound)\/secrets\/[A-Z0-9_]+$/.test(relative)))) {
    throw new Error('回滚目标不在新仓换仓范围内');
  }
  request(operation);
}

const fromList = (endpoint, key) => {
  const result = request(api('GET', endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100'), { pages: true });
  if (!Array.isArray(result) || result.some((page) => !Array.isArray(key ? page[key] : page))) {
    throw new Error('列表结构不符：' + endpoint);
  }
  return result.flatMap((page) => key ? page[key] : page);
};

const ruleBody = ({ name, target, enforcement, conditions, rules, bypass_actors: actors }) => {
  if (!Array.isArray(actors) || !Array.isArray(rules) || !name || !target || !enforcement) {
    throw new Error('规则集详情缺少必要字段（需要有权读取 bypass actors）：' + name);
  }
  return { name, target, enforcement, ...(conditions ? { conditions } : {}), rules, bypass_actors: actors };
};

export function readGitHubState(manifest) {
  const source = 'repos/' + manifest.oldRepo;
  const destination = 'repos/' + manifest.newRepo;
  const newRepo = request(api('GET', destination));
  if (newRepo.archived || newRepo.default_branch !== manifest.defaultBranch ||
      newRepo.full_name?.toLowerCase() !== manifest.newRepo.toLowerCase() ||
      (manifest.rehearsal && newRepo.private !== true)) {
    throw new Error('新仓不存在、已归档、默认分支不符，或 rehearsal 目标不是私有仓');
  }
  const readRules = (base) => fromList(base + '/rulesets?includes_parents=true').map((summary) => {
    if (summary.source_type !== 'Repository') return summary;
    return { ...summary, body: ruleBody(request(api('GET', base + '/rulesets/' + summary.id))) };
  });
  const oldRules = readRules(source);
  const newRules = readRules(destination);
  const environments = fromList(destination + '/environments', 'environments');
  const environment = environments.some(({ name }) => name === envName)
    ? request(api('GET', destination + '/environments/' + envName)) : null;
  const environmentRoot = destination + '/environments/' + envName;
  return {
    oldRules, newRules, environment,
    oldVariables: fromList(source + '/actions/variables', 'variables'),
    newVariables: fromList(destination + '/actions/variables', 'variables'),
    oldLabels: fromList(source + '/labels'),
    newLabels: fromList(destination + '/labels'),
    secrets: fromList(destination + '/actions/secrets', 'secrets'),
    environmentSecrets: environment ? fromList(environmentRoot + '/secrets', 'secrets') : [],
    branchPolicies: environment?.deployment_branch_policy?.custom_branch_policies
      ? fromList(environmentRoot + '/deployment-branch-policies', 'branch_policies') : [],
  };
}

const labelBody = ({ name, color, description }) => ({ name, color, description: description ?? '' });
const comparableRuleSet = (body) => ({
  ...body,
  rules: body.rules.map((rule) => {
    const restriction = rule.parameters?.dismissal_restriction;
    if (rule.type !== 'pull_request' || !same(restriction, { enabled: false, allowed_actors: [] })) return rule;
    const { dismissal_restriction: ignored, ...parameters } = rule.parameters;
    return { ...rule, parameters };
  }),
});
const ruleStep = (oldRule, current, endpoint) => {
  const { body } = oldRule;
  if (current && same(comparableRuleSet(body), comparableRuleSet(current.body))) return toStep('规则集', body.name, current.body, body);
  return current
    ? toStep('规则集', body.name, current.body, body,
      api('PUT', endpoint + '/' + current.id, body), api('PUT', endpoint + '/' + current.id, current.body))
    : toStep('规则集', body.name, null, body, api('POST', endpoint, body), { method: 'DELETE', endpoint, responseId: 'id' });
};

function toEnvironmentBody(environment) {
  const body = { deployment_branch_policy: environment?.deployment_branch_policy ?? null };
  for (const rule of environment?.protection_rules ?? []) {
    if (rule.type === 'wait_timer') body.wait_timer = rule.wait_timer;
    else if (rule.type === 'required_reviewers') {
      body.reviewers = rule.reviewers.map(({ type, reviewer }) => ({ type, id: reviewer.id }));
      if (typeof rule.prevent_self_review === 'boolean') body.prevent_self_review = rule.prevent_self_review;
    } else if (rule.type !== 'branch_policy') {
      throw new Error('slack-inbound 含不支持安全回滚的保护规则：' + rule.type);
    }
  }
  return body;
}

export function toGitHubPlan(manifest, state) {
  const { oldRepo, newRepo, kind, defaultBranch, rehearsal, runnerLabel } = manifest;
  const root = 'repos/' + newRepo;
  const sameOwner = oldRepo.split('/')[0].toLowerCase() === newRepo.split('/')[0].toLowerCase();
  const rules = [];
  for (const rule of state.oldRules) {
    if (rule.source_type !== 'Repository') {
      rules.push(toStep('规则集', rule.name, rule.source_type, null, null, null, '不适用/人工：组织或企业管理员处理，不复制'));
      continue;
    }
    if (!sameOwner && rule.body.bypass_actors.some((actor) => !isGlobalActor(actor))) {
      if (!rehearsal) throw new Error('跨组织不可移植的规则集：' + rule.name + '（含组织身份绕过者，未写入任何 GitHub 设置）');
      rules.push(toStep('规则集', rule.name, rule.body, null, null, null, '不适用：跨组织 bypass actor，保留原样且不写入'));
      continue;
    }
    const current = state.newRules.find((entry) => entry.source_type === 'Repository' && entry.name === rule.name);
    rules.push(ruleStep(rule, current, root + '/rulesets'));
  }

  const steps = [];
  const variables = new Map(state.oldVariables.filter(({ name }) => isReviewVariable(name)).map(({ name, value }) => [name, value]));
  variables.set('MIVO_REVIEW_MODE', 'dry-run');
  variables.set('MIVO_REVIEW_RUNNER_LABEL', runnerLabel);
  if (kind === 'fresh') {
    variables.delete('MIVO_REVIEW_WATCHDOG_ISSUE');
    steps.push(toStep('变量', 'MIVO_REVIEW_WATCHDOG_ISSUE', null, null, null, null, 'fresh：不抄旧 issue，人工设置新 issue'));
  }
  const existing = new Map(state.newVariables.map(({ name, value }) => [name, value]));
  const variableRoot = root + '/actions/variables';
  for (const [name, value] of variables) {
    const before = existing.get(name);
    const endpoint = variableRoot + '/' + encode(name);
    const operation = before === value ? null : before === undefined
      ? api('POST', variableRoot, { name, value }) : api('PATCH', endpoint, { value });
    steps.push(toStep('变量', name, before ?? null, value, operation, before === undefined
      ? api('DELETE', endpoint) : api('PATCH', endpoint, { value: before })));
  }

  const addSecret = (name, current, environment) => {
    const target = environment ? environment + '/' + name : name;
    if (current.some((secret) => secret.name === name)) {
      steps.push(toStep('secret', target, '已存在', '保留', null, null, '已存在，人工确认；GitHub 不返回值'));
      return;
    }
    const endpoint = root + (environment ? '/environments/' + environment : '/actions') + '/secrets/' + name;
    steps.push(toStep('secret', target, '未设置', rehearsal ? '演练占位' : '从 agent-secret 注入',
      { secret: name, environment }, { method: 'DELETE', endpoint, secretCreated: true }));
  };
  for (const name of REQUIRED_SECRETS) addSecret(name, state.secrets);

  const envRoot = root + '/environments/' + envName;
  const deployment = { protected_branches: false, custom_branch_policies: true };
  if (same(state.environment?.deployment_branch_policy, deployment)) {
    steps.push(toStep('环境', envName, deployment, deployment));
  } else {
    const oldBody = state.environment ? toEnvironmentBody(state.environment) : null;
    const newBody = { ...oldBody, deployment_branch_policy: deployment };
    steps.push(toStep('环境', envName, oldBody, newBody, api('PUT', envRoot, newBody),
      oldBody ? api('PUT', envRoot, oldBody) : api('DELETE', envRoot)));
  }
  const policyRoot = envRoot + '/deployment-branch-policies';
  const desired = { name: defaultBranch, type: 'branch' };
  const onDefault = state.branchPolicies.filter(({ name, type }) => name === defaultBranch && type === 'branch');
  if (onDefault.length > 1) throw new Error('slack-inbound 默认分支策略重复');
  steps.push(toStep('环境部署分支', envName, onDefault.length ? desired : null, desired,
    onDefault.length ? null : api('POST', policyRoot, desired),
    { method: 'DELETE', endpoint: policyRoot, responseId: 'id' }));
  for (const { id, name, type } of state.branchPolicies) {
    if (name === defaultBranch && type === 'branch') continue;
    const policy = { name, type };
    steps.push(toStep('环境部署分支', envName, policy, null, api('DELETE', policyRoot + '/' + id), api('POST', policyRoot, policy)));
  }
  addSecret(envSecret, state.environmentSecrets, envName);

  for (const oldLabel of state.oldLabels) {
    const desired = labelBody(oldLabel);
    const current = state.newLabels.find((label) => label.name.toLowerCase() === desired.name.toLowerCase());
    const before = current ? labelBody(current) : null;
    const endpoint = root + '/labels/' + encode(desired.name);
    if (kind === 'transfer' || same(before, desired)) {
      steps.push(toStep('label', desired.name, before, desired, null, null,
        kind === 'transfer' && !same(before, desired) ? 'transfer 只核对：不一致' : undefined));
      continue;
    }
    steps.push(toStep('label', desired.name, before, desired,
      current ? api('PATCH', root + '/labels/' + encode(current.name), { ...desired, new_name: desired.name })
        : api('POST', root + '/labels', desired),
      current ? api('PATCH', endpoint, { ...before, new_name: before.name }) : api('DELETE', endpoint)));
  }
  return [...steps, ...rules];
}
