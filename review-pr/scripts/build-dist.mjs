#!/usr/bin/env node
// build-dist.mjs — review-pr 分发版(dist/)构建器(PR-D,2026-08-06,GPT 共识计划)
//
// 目标:从主 skill 生成给其他 admin 只读消费的 dist/——剥离维护者侧台账数据与写回能力,
// 保留完整审查机制(含本地台账机制本身,只是不带数据、不回推)。
//
// 设计要点(共识 SC-13′/14/15‴/16′/23/24/25):
// - manifest 驱动整树转换(不是 SKILL-only 标记):exclude / markerStrips / stubs /
//   replacements / replaceFiles / neutralize / forbidden / absent 全部声明在
//   scripts/dist.manifest.json,本脚本只是执行器。
// - 确定性构建:无时间戳、文件排序固定 → 幂等(同输入 byte 级一致)。
// - forbidden-scan:输出树 token 扫描,白名单精确到文件;absent 断言文件级删除。
// - dist_manifest.json(入仓,防自引用):记 source_input_tree_hash(源树内容 hash,
//   不记 HEAD SHA)/strip_config_hash/builder_version/product_tree_hash(排除本 manifest
//   自身,固定 canonical 排序)。--check = 重建到临时目录并四项比对,任一不符 exit 1。
// - replacements 的 find 串在源中找不到时 fail-loud(上游改了行文必须同步 manifest,
//   不允许静默漏剥)。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const BUILDER_VERSION = 'dist-builder/1';
const HERE = dirname(fileURLToPath(import.meta.url));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walkFiles(root) {
  const out = [];
  const rec = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === 'node_modules' || name === '.DS_Store') continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) rec(p); else out.push(p);
    }
  };
  rec(root);
  return out.sort();
}

// 源输入枚举:git 仓内用 tracked 清单(脏工作树的未跟踪杂物不进 hash);
// 非 git(测试沙盒/临时拷贝)回退全量 walk。两种模式都读工作树字节。
function listSourceFiles(sourceDir) {
  try {
    const raw = execFileSync('git', ['-C', sourceDir, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const rels = raw.split('\0').filter(Boolean);
    if (rels.length) return rels.map((r) => join(sourceDir, r)).filter((p) => existsSync(p)).sort();
  } catch { /* not a git repo → walk */ }
  return walkFiles(sourceDir);
}

export function sourceInputTreeHash(sourceDir) {
  const h = createHash('sha256');
  for (const p of listSourceFiles(sourceDir)) {
    h.update(relative(sourceDir, p)); h.update('\0');
    h.update(sha256(readFileSync(p))); h.update('\n');
  }
  return h.digest('hex');
}

export function productTreeHash(distDir) {
  const h = createHash('sha256');
  for (const p of walkFiles(distDir)) {
    const rel = relative(distDir, p);
    if (rel === 'dist_manifest.json') continue; // 防自引用(共识 v2.4)
    h.update(rel); h.update('\0');
    h.update(sha256(readFileSync(p))); h.update('\n');
  }
  return h.digest('hex');
}

function applyMarkerStrip(text, name, file) {
  const isMd = file.endsWith('.md');
  const start = isMd ? `<!-- dist:strip:start ${name} -->` : `// dist:strip:start ${name}`;
  const end = isMd ? `<!-- dist:strip:end ${name} -->` : `// dist:strip:end ${name}`;
  const s = text.indexOf(start), e = text.indexOf(end);
  if (s === -1 || e === -1 || e < s) throw new Error(`markerStrip ${name} 在 ${file} 中缺失/错序(fail-loud)`);
  const out = text.slice(0, s) + text.slice(e + end.length + (text[e + end.length] === '\n' ? 1 : 0));
  return out.replace(/\n{2,}$/, '\n'); // strip 到 EOF 时不留悬空空行(git diff --check 卫生)
}

function applyStub(text, name, replacement, file) {
  const start = `// dist:stub:start ${name}`;
  const end = `// dist:stub:end ${name}`;
  const s = text.indexOf(start), e = text.indexOf(end);
  if (s === -1 || e === -1 || e < s) throw new Error(`stub ${name} 在 ${file} 中缺失/错序(fail-loud)`);
  return text.slice(0, s) + replacement.join('\n') + '\n' + text.slice(e + end.length + (text[e + end.length] === '\n' ? 1 : 0));
}

function applyReplacements(text, reps, file) {
  for (const { find, replace } of reps) {
    const idx = text.indexOf(find);
    if (idx === -1) throw new Error(`replacement find 串未命中(上游行文变了?同步 manifest): ${file}: ${find.slice(0, 50)}…`);
    if (text.indexOf(find, idx + 1) !== -1) throw new Error(`replacement find 串命中多处(需更精确): ${file}: ${find.slice(0, 50)}…`);
    text = replace === '' ? text.split('\n').filter((l) => l !== find).join('\n') : text.replace(find, replace);
  }
  return text;
}

// 中性化 config:清空维护者个人名单/通知收件人,其余结构原样(2 空格缩进确定性输出)
function neutralizeConfig(text, spec) {
  const cfg = JSON.parse(text);
  for (const path of spec.emptyArrays) {
    const seg = path.split('.');
    let o = cfg;
    for (const k of seg.slice(0, -1)) o = o?.[k];
    if (o && seg.at(-1) in o) o[seg.at(-1)] = [];
  }
  for (const path of spec.emptyStrings) {
    const seg = path.split('.');
    let o = cfg;
    for (const k of seg.slice(0, -1)) o = o?.[k];
    if (o && seg.at(-1) in o) o[seg.at(-1)] = '';
  }
  return JSON.stringify(cfg, null, 2) + '\n';
}

export function buildDist({ sourceDir, manifestPath, outDir }) {
  const manifestText = readFileSync(manifestPath, 'utf8');
  const m = JSON.parse(manifestText);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const excluded = (rel) => m.exclude.some((x) => rel === x || rel.startsWith(x.endsWith('/') ? x : `${x}/`));
  for (const p of listSourceFiles(sourceDir)) {
    const rel = relative(sourceDir, p);
    if (excluded(rel)) continue;
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(p, dest);
  }
  for (const { file, name } of m.markerStrips) {
    const p = join(outDir, file);
    writeFileSync(p, applyMarkerStrip(readFileSync(p, 'utf8'), name, file));
  }
  for (const { file, name, replacement } of m.stubs) {
    const p = join(outDir, file);
    writeFileSync(p, applyStub(readFileSync(p, 'utf8'), name, replacement, file));
  }
  const byFile = new Map();
  for (const r of m.replacements) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  for (const [file, reps] of byFile) {
    const p = join(outDir, file);
    writeFileSync(p, applyReplacements(readFileSync(p, 'utf8'), reps, file));
  }
  if (m.neutralize) {
    const p = join(outDir, m.neutralize.file);
    writeFileSync(p, neutralizeConfig(readFileSync(p, 'utf8'), m.neutralize));
  }
  for (const { src, dest } of m.replaceFiles) {
    const d = join(outDir, dest);
    mkdirSync(dirname(d), { recursive: true });
    cpSync(join(sourceDir, src), d);
  }

  // absent 断言(文件级删除证明)
  for (const rel of m.absent) {
    if (existsSync(join(outDir, rel))) throw new Error(`absent 断言失败: dist 中仍存在 ${rel}`);
  }
  // forbidden-scan(token 级,白名单精确到文件)
  const violations = [];
  for (const p of walkFiles(outDir)) {
    const rel = relative(outDir, p);
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    for (const { token, allow = [] } of m.forbidden) {
      if (!text.includes(token)) continue;
      if (allow.some((a) => a.file === rel)) continue;
      violations.push(`${rel}: 含禁词 "${token}"`);
    }
  }
  if (violations.length) throw new Error(`forbidden-scan 未过(${violations.length}):\n${violations.join('\n')}`);

  const distManifest = {
    builder_version: BUILDER_VERSION,
    source_input_tree_hash: sourceInputTreeHash(sourceDir),
    strip_config_hash: sha256(manifestText),
    product_tree_hash: productTreeHash(outDir)
  };
  writeFileSync(join(outDir, 'dist_manifest.json'), JSON.stringify(distManifest, null, 2) + '\n');
  return distManifest;
}

// freshness 比对(共识 v2.3/v2.4 + 审 D-F1 修正):**一切锚定当场重建的产物**——
// 先真重建到临时目录(重建本身跑 forbidden/absent),再比 ①记录 manifest 四字段 vs 重建
// manifest ②仓内 dist 实际树 hash vs 重建产物树 hash。伪造/手补 dist_manifest 只能让
// ①里的 product_tree_hash 与②同时露馅(记录值锚的是重建,不是 dist 自身重算)。
export function checkDist({ sourceDir, manifestPath, distDir }) {
  const problems = [];
  const mf = join(distDir, 'dist_manifest.json');
  if (!existsSync(mf)) return { fresh: false, problems: ['dist_manifest.json 不存在'] };
  const rec = JSON.parse(readFileSync(mf, 'utf8'));
  const tmp = mkdtempSync(join(tmpdir(), 'dist-rebuild-'));
  try {
    const expect = buildDist({ sourceDir, manifestPath, outDir: tmp });
    for (const k of ['builder_version', 'source_input_tree_hash', 'strip_config_hash', 'product_tree_hash']) {
      if (rec[k] !== expect[k]) problems.push(`${k} 不符(记录 ${String(rec[k]).slice(0, 12)} ≠ 重建 ${String(expect[k]).slice(0, 12)})`);
    }
    const actual = productTreeHash(distDir);
    if (actual !== expect.product_tree_hash) {
      problems.push(`product_tree_hash(实际) 不符: 仓内 dist 树 ${actual.slice(0, 12)} ≠ 重建产物 ${expect.product_tree_hash.slice(0, 12)}(手改 dist/伪造 manifest 均在此露馅,审 D-F1)`);
    }
  } catch (e) {
    problems.push(`重建失败(fail-closed): ${e.message}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { fresh: problems.length === 0, problems };
}

// tag 不可覆盖(SC-23):远端已存在同名 tag 一律拒绝,不带 force
export function assertTagAvailable(repoDir, tag) {
  const local = execFileSync('git', ['-C', repoDir, 'tag', '-l', tag], { encoding: 'utf8' }).trim();
  if (local) throw new Error(`tag ${tag} 本地已存在,拒绝覆盖`);
  const remote = execFileSync('git', ['-C', repoDir, 'ls-remote', '--tags', 'origin', tag], { encoding: 'utf8' }).trim();
  if (remote) throw new Error(`tag ${tag} 远端已存在,拒绝覆盖`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
  const sourceDir = resolve(opt('source') ?? join(HERE, '..'));
  const manifestPath = resolve(opt('manifest') ?? join(HERE, 'dist.manifest.json'));
  const distDir = resolve(opt('out') ?? join(HERE, '..', '..', 'dist'));
  if (argv.includes('--check')) {
    const res = checkDist({ sourceDir, manifestPath, distDir }); // 内部即真重建+双向比对(审 D-F1)
    if (!res.fresh) {
      process.stderr.write(`[build-dist --check] dist 过期:\n${res.problems.join('\n')}\n重建: node scripts/build-dist.mjs\n`);
      process.exit(1);
    }
    process.stdout.write('[build-dist --check] fresh\n');
  } else if (argv.includes('--tag')) {
    const repoDir = resolve(sourceDir, '..');
    const res = checkDist({ sourceDir, manifestPath, distDir });
    if (!res.fresh) { process.stderr.write(`tag 前 dist 必须 fresh:\n${res.problems.join('\n')}\n`); process.exit(1); }
    const d = new Date();
    const base = `review-pr-dist-v${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    let tag = null;
    for (let n = 1; n <= 99; n++) {
      const cand = `${base}.${n}`;
      try { assertTagAvailable(repoDir, cand); tag = cand; break; } catch { /* 已存在,递增 */ }
    }
    if (!tag) { process.stderr.write('当日 tag 序号耗尽\n'); process.exit(1); }
    execFileSync('git', ['-C', repoDir, 'tag', '-a', tag, '-m', `dist ${tag}`], { stdio: 'inherit' });
    process.stdout.write(`created tag ${tag}(push 用: git push origin ${tag},禁 --force)\n`);
  } else {
    const dm = buildDist({ sourceDir, manifestPath, outDir: distDir });
    process.stdout.write(`built dist/ product_tree_hash=${dm.product_tree_hash.slice(0, 16)}\n`);
  }
}
