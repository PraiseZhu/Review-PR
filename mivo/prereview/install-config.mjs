// install-mini.sh 写 round.mjs 配置(#142):已有配置文件时合并,不整份重写。
// 安装参数决定的字段(路径、目标仓库、模式、workflow 分支、规则文件)每次按参数写;
// maxParallel、dailyCap 只在命令行显式给了才改,没给时保留原值(新文件用默认 3 / 30);
// viewerLogin、branchProtectionCacheMs、gateParallel、runnerLabel 等手工加的字段原样保留。
//   node install-config.mjs <配置文件> '<参数 JSON>'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const toCount = (name, value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} 须是正整数:${JSON.stringify(value)}`);
  return n;
};

/** existing:已有配置(没有传 null);args:安装参数,maxParallel / dailyCap 没给传空串或不传。 */
export function toInstallConfig(existing, args) {
  if (existing !== null && (typeof existing !== 'object' || Array.isArray(existing))) throw new Error('已有配置不是 JSON 对象');
  const base = existing ?? {};
  return { ...base, instance: args.instance, repoRoot: args.repoRoot, stateDir: args.stateDir, targetRepo: args.target, mode: args.mode,
    workflowRepo: 'xindong/mivo-canvas-plugin', workflowRef: args.ref, logDir: args.logDir, rulesFile: args.rules || null,
    maxParallel: args.maxParallel ? toCount('max-parallel', args.maxParallel) : base.maxParallel ?? 3,
    dailyCap: args.dailyCap ? toCount('daily-cap', args.dailyCap) : base.dailyCap ?? 30,
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
