// dry-run 用的 gh 垫片:读操作原样交给真 gh,写操作一律拦下并记日志、返回失败。
// 前置审查在 dry-run 模式下把这个目录放在 PATH 最前面,Cindy 脚本内部的任何写入都发不出去。
// 唯一放行的写是 `gh workflow run`(派发 dry-run 模式的服务器审查,服务器那边同样不写)。
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';


const WRITE_SUBCOMMANDS = {
  pr: ['comment', 'create', 'edit', 'merge', 'close', 'reopen', 'ready', 'review', 'lock', 'unlock'],
  issue: ['create', 'comment', 'edit', 'close', 'reopen', 'delete', 'lock', 'unlock', 'transfer', 'pin', 'unpin'],
  label: ['create', 'edit', 'delete', 'clone'],
  run: ['rerun', 'cancel', 'delete'],
  workflow: ['enable', 'disable'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
  repo: ['create', 'edit', 'delete', 'fork', 'rename', 'archive', 'sync'],
  release: ['create', 'edit', 'delete', 'upload'],
};

export function isWrite(argv, input = '') {
  const [cmd, sub] = argv;
  if (cmd === 'workflow' && sub === 'run') return process.env.MIVO_DRYRUN_ALLOW_DISPATCH !== '1';
  if (WRITE_SUBCOMMANDS[cmd]?.includes(sub)) return true;
  if (cmd !== 'api') return false;
  const methodIndex = argv.findIndex((a) => a === '-X' || a === '--method');
  const method = methodIndex >= 0 ? String(argv[methodIndex + 1] ?? '').toUpperCase()
    : (argv.find((a) => /^--method=/.test(a)) ?? '').split('=')[1]?.toUpperCase() ?? '';
  if (argv.includes('graphql')) return /\bmutation\b/.test(String(input)) || argv.some((a) => /^query=.*\bmutation\b/s.test(a));
  if (method) return method !== 'GET' && method !== 'HEAD';
  // gh api 带字段却没写方法时默认 POST。
  return argv.some((a) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a) || /^--(?:field|raw-field|input)=/.test(a));
}

export function main() {
  const realGh = process.env.MIVO_REAL_GH;
  if (!realGh) { process.stderr.write('dry-run gh 垫片:缺少 MIVO_REAL_GH\n'); process.exit(127); }
  const args = process.argv.slice(2);
  let stdin = Buffer.alloc(0);
  try { if (!process.stdin.isTTY) stdin = readFileSync(0); } catch { /* 无 stdin */ }
  if (isWrite(args, stdin.toString('utf8'))) {
    const line = `${new Date().toISOString()} BLOCKED gh ${args.map((a) => (a.length > 120 ? `${a.slice(0, 120)}…` : a)).join(' ')}\n`;
    if (process.env.MIVO_DRYRUN_LOG) { try { appendFileSync(process.env.MIVO_DRYRUN_LOG, line); } catch { /* 日志失败不影响拦截 */ } }
    process.stderr.write(`dry-run: 已拦下写操作 gh ${args.slice(0, 3).join(' ')}\n`);
    process.exit(1);
  }
  const result = spawnSync(realGh, args, { input: stdin, stdio: ['pipe', 'inherit', 'inherit'] });
  process.exit(result.status ?? 1);
}
