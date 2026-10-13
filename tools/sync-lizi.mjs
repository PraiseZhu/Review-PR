#!/usr/bin/env node
// sync-lizi.mjs — 让 review-pr/ 与 review-pr-auto/ 跟上 lizi 上游(makecindy/cindy-lizi-skills),
// 并证明和上游的差异只来自 tools/lizi-sync.json 登记过的补丁。
//
//   node tools/sync-lizi.mjs --check [--upstream-dir <已解压的上游根目录>]
//     核对:上游文件(排除 excluded)本地都在;内容不同的必须登记在 patched;
//     本地多出的必须登记在 added;登记了 patched 却和上游一样的也报出来。退出码 0=干净,1=有差异。
//   node tools/sync-lizi.mjs --to <新上游 SHA> [--upstream-dir <新上游根>] [--base-dir <旧上游根>]
//     升级:没补丁的文件直接换成新上游;有补丁的文件用 git merge-file 三方合并
//     (旧上游 → 新上游 叠到本地),有冲突的留冲突标记并列出;最后更新清单里的 sha。
//
// 上游是私有仓,下载 tarball 用本机 gh 的登录态;脚本不打印任何凭证。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_FILE = join(ROOT, 'tools', 'lizi-sync.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return '';
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
  return argv[i + 1];
};

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...options });
  if (r.error) throw new Error(`${cmd} 执行失败: ${r.error.message}`);
  return r;
}

export function listFiles(base, roots) {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(base, full).split(sep).join('/'));
    }
  };
  for (const root of roots) walk(join(base, root));
  return files.sort();
}

export const isExcluded = (path, excluded) => excluded.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));

/** 纯函数:比较两棵树,返回违规清单。readA/readB 返回 Buffer。 */
export function compareTrees({ upstreamFiles, localFiles, manifest, readUpstream, readLocal }) {
  const excluded = manifest.excluded ?? [];
  const patched = new Set(manifest.patched ?? []);
  const added = new Set(manifest.added ?? []);
  const problems = [];
  const upstreamSet = new Set(upstreamFiles.filter((file) => !isExcluded(file, excluded)));
  for (const file of upstreamSet) {
    if (!localFiles.includes(file)) { problems.push({ file, kind: 'missing-locally' }); continue; }
    const same = Buffer.compare(readUpstream(file), readLocal(file)) === 0;
    if (!same && !patched.has(file)) problems.push({ file, kind: 'unregistered-change' });
    if (same && patched.has(file)) problems.push({ file, kind: 'registered-but-identical' });
  }
  for (const file of localFiles) {
    if (upstreamSet.has(file)) continue;
    if (isExcluded(file, excluded)) problems.push({ file, kind: 'excluded-path-present' });
    else if (!added.has(file)) problems.push({ file, kind: 'unregistered-addition' });
  }
  for (const file of added) if (!localFiles.includes(file)) problems.push({ file, kind: 'registered-addition-missing' });
  for (const file of patched) if (!upstreamSet.has(file)) problems.push({ file, kind: 'patched-not-in-upstream' });
  return problems;
}

// 上游仓带几百 MB 的运行归档,只按需取两个 skill 目录:浅克隆 + 无 blob 过滤 + 稀疏检出。
function fetchUpstream(repo, sha, roots) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`上游 SHA 无效: ${sha}`);
  const dir = mkdtempSync(join(tmpdir(), 'lizi-upstream-'));
  const git = (args) => {
    const r = run('git', ['-C', dir, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args]);
    if (r.status !== 0) throw new Error(`git ${args[0]} 失败: ${r.stderr.trim().split('\n')[0]}`);
    return r;
  };
  try {
    git(['init', '-q']);
    git(['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
    git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', sha]);
    git(['sparse-checkout', 'set', '--no-cone', ...roots.map((root) => `/${root}`), '!/review-pr/history/']);
    git(['checkout', '-q', 'FETCH_HEAD']);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`取上游 ${repo}@${sha} 失败: ${error.message}`);
  }
  return { root: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function check(manifest, upstreamRoot) {
  const roots = manifest.managedRoots;
  const problems = compareTrees({
    upstreamFiles: listFiles(upstreamRoot, roots),
    localFiles: listFiles(ROOT, roots),
    manifest,
    readUpstream: (file) => readFileSync(join(upstreamRoot, file)),
    readLocal: (file) => readFileSync(join(ROOT, file)),
  });
  return problems;
}

function upgrade(manifest, oldRoot, newRoot, newSha) {
  const roots = manifest.managedRoots;
  const excluded = manifest.excluded ?? [];
  const patched = new Set(manifest.patched ?? []);
  const report = { replaced: [], merged: [], conflicts: [], removedUpstream: [], newUpstream: [] };
  const newFiles = listFiles(newRoot, roots).filter((file) => !isExcluded(file, excluded));
  const oldFiles = new Set(listFiles(oldRoot, roots).filter((file) => !isExcluded(file, excluded)));
  for (const file of newFiles) {
    const target = join(ROOT, file);
    mkdirSync(dirname(target), { recursive: true });
    if (!patched.has(file)) {
      if (!existsSync(target) || Buffer.compare(readFileSync(target), readFileSync(join(newRoot, file))) !== 0) {
        copyFileSync(join(newRoot, file), target);
        report.replaced.push(file);
      }
      if (!oldFiles.has(file)) report.newUpstream.push(file);
      continue;
    }
    const base = oldFiles.has(file) ? join(oldRoot, file) : join(newRoot, file);
    const merge = run('git', ['merge-file', '-L', 'mivo', '-L', 'upstream-old', '-L', 'upstream-new', target, base, join(newRoot, file)]);
    if (merge.status === 0) report.merged.push(file);
    else report.conflicts.push(file);
  }
  for (const file of oldFiles) if (!newFiles.includes(file)) report.removedUpstream.push(file);
  manifest.upstream.sha = newSha;
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return report;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
    if (flag('--check')) {
      const given = value('--upstream-dir');
      const fetched = given ? null : fetchUpstream(manifest.upstream.repo, manifest.upstream.sha, manifest.managedRoots);
      try {
        const problems = check(manifest, given ? resolve(given) : fetched.root);
        console.log(JSON.stringify({ ok: problems.length === 0, upstream: manifest.upstream, problems }, null, 2));
        process.exitCode = problems.length ? 1 : 0;
      } finally { fetched?.cleanup(); }
    } else if (value('--to')) {
      const newSha = value('--to');
      const oldGiven = value('--base-dir');
      const newGiven = value('--upstream-dir');
      const oldTree = oldGiven ? null : fetchUpstream(manifest.upstream.repo, manifest.upstream.sha, manifest.managedRoots);
      const newTree = newGiven ? null : fetchUpstream(manifest.upstream.repo, newSha, manifest.managedRoots);
      try {
        const report = upgrade(manifest, oldGiven ? resolve(oldGiven) : oldTree.root, newGiven ? resolve(newGiven) : newTree.root, newSha);
        console.log(JSON.stringify({ ok: report.conflicts.length === 0, ...report }, null, 2));
        process.exitCode = report.conflicts.length ? 1 : 0;
      } finally { oldTree?.cleanup(); newTree?.cleanup(); }
    } else {
      console.error('用法: node tools/sync-lizi.mjs --check [--upstream-dir <dir>] | --to <sha> [--upstream-dir <dir>] [--base-dir <dir>]');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`[sync-lizi] ${error.message}`);
    process.exitCode = 1;
  }
}
