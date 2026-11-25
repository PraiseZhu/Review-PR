// install-mini.sh 写 round.mjs 配置(#142):已有配置文件时合并,不整份重写。
// 安装参数决定的字段(路径、目标仓库、模式、workflow 分支、规则文件)每次按参数写;
// maxParallel、dailyCap、规则文件只在命令行显式给了才改,没给时保留原值(新文件用默认 3 / 30、生产规则);
// 结果按 round.mjs 启动时的同一范围校验(maxParallel 1–40、dailyCap 正整数),不写出启动不了的配置;
// viewerLogin、branchProtectionCacheMs、gateParallel、runnerLabel 等手工加的字段原样保留。
// workflowRepo(review-pr.yml、仓库变量、runner 所在的仓)每次按参数写:给了 --workflow-repo 用它,没给就等于目标仓;
// sandbox 审的是另一个仓,必须显式给(换仓见 mivo/README.md「换仓」)。
//   node install-config.mjs <配置文件> '<参数 JSON>'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_RE } from '../lib/common.mjs';

// 命令行没给是空串(install-mini.sh 的默认值);null 算给了,按非法值报错。
const given = (value) => value !== undefined && value !== '';
const toCount = (name, value, max, rule) => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} 须是${rule}:${JSON.stringify(value)}`);
  return n;
};

/** existing:已有配置(没有传 null);args:安装参数,maxParallel / dailyCap 没给传空串或不传。 */
export function toInstallConfig(existing, args) {
  if (existing !== null && (typeof existing !== 'object' || Array.isArray(existing))) throw new Error('已有配置不是 JSON 对象');
  const base = existing ?? {};
  const workflowRepo = given(args.workflowRepo) ? args.workflowRepo : args.target;
  if (typeof workflowRepo !== 'string' || !REPO_RE.test(workflowRepo)) throw new Error(`--workflow-repo 须是 owner/name:${JSON.stringify(workflowRepo ?? null)}`);
  if (args.mode === 'sandbox' && workflowRepo === args.target) {
    throw new Error(`sandbox 模式要用 --workflow-repo 指向放 review-pr.yml 的仓,不能等于目标仓 ${args.target}`);
  }
  return { ...base, instance: args.instance, repoRoot: args.repoRoot, stateDir: args.stateDir, targetRepo: args.target, mode: args.mode,
    workflowRepo, workflowRef: args.ref, logDir: args.logDir,
    rulesFile: given(args.rules) ? args.rules : base.rulesFile ?? null,
    maxParallel: given(args.maxParallel) ? toCount('--max-parallel', args.maxParallel, 40, '1–40 的整数')
      : toCount('已有配置的 maxParallel', Object.hasOwn(base, 'maxParallel') ? base.maxParallel : 3, 40, '1–40 的整数'),
    dailyCap: given(args.dailyCap) ? toCount('--daily-cap', args.dailyCap, Number.MAX_SAFE_INTEGER, '正整数')
      : toCount('已有配置的 dailyCap', Object.hasOwn(base, 'dailyCap') ? base.dailyCap : 30, Number.MAX_SAFE_INTEGER, '正整数'),
    pollSeconds: base.pollSeconds ?? 30 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, json] = process.argv.slice(2);
  // 已有文件读不懂就报错退出,不覆盖。
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const config = toInstallConfig(existing, { ...JSON.parse(json), instance: basename(file).replace(/\.json$/, '') });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, file);
}
