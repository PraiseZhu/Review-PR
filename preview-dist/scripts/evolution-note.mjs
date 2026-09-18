#!/usr/bin/env node
// evolution-note.mjs — 自进化台账的唯一读写通道(对应 SKILL 第 8 节)。
//
// 台账是 Skill 知识的一部分,随 Skill 仓库走(不是运行时状态,不放外部状态目录):
//   - <SKILL_ROOT>/evolution/ledger.json :结构化台账(唯一事实源,只经本脚本读写);
//   - <SKILL_ROOT>/EVOLUTION.md          :由 ledger 全量再生成的人类可读视图(手改会被覆盖)。
//
// 条目按 fingerprint(根因 slug)去重:同一根因再次出现只自增 occurrences 和 lastSeen,
// 不重复写分析——主 agent 拿到 isNew=false 就不必再花 token 重新总结同一件事。
//
// tier 三档(与 SKILL 8.1 对应,决定条目归组与默认 status):
//   - by-design :设计上就该人来的(他人 thread、真人 approve、语义冲突…),只计数;
//   - proposal  :扩权类提案(任何新增/放宽署名操作或安全边界),等维护者拍板,永不自动落地;
//   - auto      :可自动化的遗漏,已按 SKILL 8.3 规则当轮落地(带 --commit 时记 landed)。
//
// 子命令:
//   add        --fingerprint <slug> --tier <by-design|proposal|auto> --title "…"
//              [--detail "…"] [--proposal "…"] [--commit <sha>] [--no-sync]
//   set-status --fingerprint <slug> --status <open|landed|adopted|rejected> [--note "…"] [--no-sync]
//   list       (输出整份 ledger)
//
// preview 版:台账仅本地落盘(skillRepoCommitPush 为只读 stub,写盘后不提交不推送,
// 恒返回 skipped:'dist-readonly'——纯落盘,由维护者在主仓落地)。
// 主仓版:add / set-status 每次写盘后自动把 ledger.json + EVOLUTION.md 提交并推送。
//
// 联动重建:台账写入成功后,同步重建 preview-dist(三审第③席用的受限分发版,产物
// 含台账副本,台账一变产物即真过期——见 preview-dist.manifest.json freshnessIgnore
// 为空)。重建走 build-dist.mjs 子进程,结果在输出 rebuild 字段;失败不回滚台账,
// 以 ok:false 显式报出(台账优先、产物滞后可见)。preview 分发版(构建器已剥离,
// 产物内不存在 build-dist.mjs)自动跳过,不报错;另有一道机器级兜底:本脚本自身
// 位于名为 preview-dist 的目录内时(outDir 与 SKILL_ROOT 重合)一律跳过,不依赖
// manifest exclude 配置巧合——否则重建会先把运行中的整棵树 rm 掉。
//
// 纪律:台账正文不写 token、凭证、内部绝对路径或敏感命中原文;PR 只写号码。
// 退出码:0 = 成功;1 = 参数/IO 错误。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { print, fail, skillRepoCommitPush } from './lib.mjs';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_DIR = join(SKILL_ROOT, 'evolution');
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.json');
const MD_FILE = join(SKILL_ROOT, 'EVOLUTION.md');

const FINGERPRINT_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TIERS = ['by-design', 'proposal', 'auto'];
const STATUSES = ['open', 'landed', 'adopted', 'rejected', 'tracked'];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
}

function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] }; // 不存在/损坏按空台账起步
  }
}

function writeLedger(ledger) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2) + '\n');
  writeFileSync(MD_FILE, renderMd(ledger));
}

/** 台账写盘后的自动提交推送(--no-sync 跳过)。只 add 台账两个文件,绝不裹挟其他改动。 */
function syncLedger(message) {
  if (process.argv.includes('--no-sync')) return { skipped: 'no-sync' };
  try {
    return skillRepoCommitPush({ paths: ['evolution/ledger.json', 'EVOLUTION.md'], message });
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

/**
 * 台账写入后的联动重建:preview-dist 产物含台账副本(freshnessIgnore 为空),
 * 台账一变产物即真过期,因此每次写盘成功后同步重建,让 preview 门保持绿。
 *
 * 走 build-dist.mjs 子进程(与手动/CI 重建同一条命令路径,幂等确定性由构建器保证)。
 * 失败不回滚台账写入:返回 ok:false + error,由主 agent 显式报出(台账优先、
 * 产物滞后可见)。preview 分发版产物内不含 build-dist.mjs(exclude 声明),
 * 这里按「构建器不存在」跳过——preview 是只读快照,不自我重建。
 *
 * 机器级兜底(实测过、不依赖 exclude 配置):exclude 一旦漏掉 build-dist.mjs,
 * 从 preview 副本运行本脚本时 outDir 会与 SKILL_ROOT 重合,重建先 rm 掉运行中
 * 的整棵树(含刚写的台账)——位置重合即跳过,防的是配置巧合失效后的自毁。
 */
function rebuildPreviewDist() {
  const builder = join(SKILL_ROOT, 'scripts', 'build-dist.mjs');
  if (!existsSync(builder)) return { skipped: 'dist-readonly' };
  const manifest = join(SKILL_ROOT, 'scripts', 'preview-dist.manifest.json');
  if (!existsSync(manifest)) return { skipped: 'no-preview-manifest' };
  const outDir = resolve(SKILL_ROOT, '..', 'preview-dist');
  if (resolve(outDir) === SKILL_ROOT) return { skipped: 'self-rebuild' };
  try {
    const stdout = execFileSync(process.execPath, [builder, '--manifest', manifest, '--out', outDir],
      { encoding: 'utf8', timeout: 60_000 }); // 对齐 lib.mjs 子进程超时约定,防构建器挂死卡住台账流程
    return { ok: true, outDir, stdout: stdout.trim().slice(0, 200) };
  } catch (e) {
    return { ok: false, outDir, error: String(e?.message || e).slice(0, 300) };
  }
}

const fmtDate = (iso) => (iso ?? '').slice(0, 10);

function renderMd(ledger) {
  const groups = [
    ['proposal', '## 待维护者拍板(扩权类提案,永不自动落地)', (e) => e.status !== 'rejected'],
    ['auto', '## 已自动落地(automatable-gap)', () => true],
    ['by-design', '## 无法自动化(by-design,只计数观察)', () => true],
  ];
  const rejected = ledger.entries.filter((e) => e.tier === 'proposal' && e.status === 'rejected');
  let md = '# review-pr 自进化台账\n\n';
  md += '自动生成:由 `scripts/evolution-note.mjs` 从 `evolution/ledger.json` 再生成,**手改本文件会被覆盖**。\n';
  md += '条目按根因 fingerprint 去重;分类与落地规则见 SKILL.md 第 8 节。\n';
  for (const [tier, heading, keep] of groups) {
    const entries = ledger.entries.filter((e) => e.tier === tier && keep(e));
    if (!entries.length) continue;
    md += `\n${heading}\n\n`;
    for (const e of entries.slice().sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))) {
      md += `- \`${e.fingerprint}\` **${e.title}** — 出现 ${e.occurrences} 次,首见 ${fmtDate(e.firstSeen)},最近 ${fmtDate(e.lastSeen)},status: ${e.status}${e.commit ? `,commit \`${e.commit}\`` : ''}\n`;
      if (e.detail) md += `  - 现象:${e.detail}\n`;
      if (e.proposal) md += `  - 提案:${e.proposal}\n`;
      if (e.note) md += `  - 备注:${e.note}\n`;
    }
  }
  if (rejected.length) {
    md += '\n## 已否决的提案(留档防止重复提出)\n\n';
    for (const e of rejected) {
      md += `- \`${e.fingerprint}\` ${e.title}${e.note ? ` — ${e.note}` : ''}\n`;
    }
  }
  return md;
}

try {
  const cmd = process.argv[2];
  const ledger = readLedger();

  if (cmd === 'list') {
    print({ ok: true, ledgerFile: LEDGER_FILE, mdFile: MD_FILE, count: ledger.entries.length, entries: ledger.entries });
    process.exit(0);
  }

  const fingerprint = arg('fingerprint');
  if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
    throw new Error('缺少或不合法的 --fingerprint(根因 slug:小写字母/数字/连字符,3-64 位,如 threads-unresolved-bot-outdated)');
  }

  if (cmd === 'add') {
    const tier = arg('tier');
    const title = arg('title');
    if (!TIERS.includes(tier)) throw new Error(`--tier 必须是 ${TIERS.join('|')}`);
    if (!title) throw new Error('缺少 --title(一句话根因)');
    const detail = arg('detail');
    const proposal = arg('proposal');
    const commit = arg('commit');
    const now = new Date().toISOString();

    let entry = ledger.entries.find((e) => e.fingerprint === fingerprint);
    const isNew = !entry;
    if (isNew) {
      entry = {
        fingerprint,
        tier,
        title,
        detail: detail ?? null,
        proposal: proposal ?? null,
        status: tier === 'auto' ? (commit ? 'landed' : 'open') : tier === 'proposal' ? 'open' : 'tracked',
        commit: commit ?? null,
        note: null,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
      };
      ledger.entries.push(entry);
    } else {
      entry.occurrences += 1;
      entry.lastSeen = now;
      // 复现时允许补充/修正信息,但不允许悄悄降级安全档:proposal 一旦是 proposal 永远是 proposal
      if (detail) entry.detail = detail;
      if (proposal) entry.proposal = proposal;
      if (commit) { entry.commit = commit; if (entry.tier === 'auto') entry.status = 'landed'; }
      if (tier && tier !== entry.tier && entry.tier !== 'proposal') entry.tier = tier;
    }
    writeLedger(ledger);
    const rebuild = rebuildPreviewDist();
    const sync = syncLedger(`evo: ledger ${fingerprint}`);
    print({ ok: true, isNew, entry, sync, rebuild, ledgerFile: LEDGER_FILE, mdFile: MD_FILE, note: isNew ? '新根因:值得在摘要🧬组里向用户/维护者报告' : '已知根因(去重命中):只自增计数,不必重复分析与报告' });
    process.exit(0);
  }

  if (cmd === 'set-status') {
    const status = arg('status');
    if (!STATUSES.includes(status)) throw new Error(`--status 必须是 ${STATUSES.join('|')}`);
    const entry = ledger.entries.find((e) => e.fingerprint === fingerprint);
    if (!entry) throw new Error(`台账中没有 fingerprint=${fingerprint} 的条目`);
    entry.status = status;
    const note = arg('note');
    if (note) entry.note = note;
    writeLedger(ledger);
    const rebuild = rebuildPreviewDist();
    const sync = syncLedger(`evo: ledger ${fingerprint} status=${status}`);
    print({ ok: true, entry, sync, rebuild, ledgerFile: LEDGER_FILE, mdFile: MD_FILE });
    process.exit(0);
  }

  throw new Error('用法:evolution-note.mjs <add|set-status|list> …(见文件头注释)');
} catch (e) {
  fail(e);
}
