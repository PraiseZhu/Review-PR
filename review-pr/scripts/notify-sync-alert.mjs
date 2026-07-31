#!/usr/bin/env node
// notify-sync-alert.mjs — 「自同步停摆」这类**不会自愈**的运维故障,定向私聊 owner 一次
//
// 为什么单独一个出口,而不是塞进每轮汇总(notify-summary.mjs):
//   维护者明确要求播报频道只承载合并致谢,不要每轮汇总噪音(所以 summaryBroadcast 故意
//   未配置)。但「skills 仓分叉、自同步双向停摆」属于另一类事件——它不会自愈、每轮都会
//   重现、且只有人能修。2026-07-31 实测:这类故障静默了一天多才被人翻仓发现,期间 18 个
//   evo commit 推不上去、远端 skill 更新拉不下来。所以给它一条独立的、低频的、定向到
//   owner 私聊的出口,与群内播报互不干扰。
//
// 复用现成设施,不引入新的仓内配置(避免为一个运维开关去改目标仓库并走 PR):
//   - 播报模块:复用 loopPrExclusion.mergeAckNotify.notifyModule(已配置);
//   - 私聊目标:读 notify.env 的 `SLACK_OPS_ALERT_CHANNEL_ID`(gitignored 本地配置,
//     loadNotifyConfig 会读入文件里所有 KEY=VALUE)。**未配置即整套能力关闭**
//     (posted:false, reason:'ops-alert-channel-not-configured'),与本 skill 其余
//     「配置缺失=功能关闭」的约定一致;
//   - 投递方式:把 config 的 SLACK_CHANNEL_ID 就地换成私聊目标再交给 sendAlert,
//     因此不需要改目标仓库的 notify.mjs。
//
// 幂等:按 `kind:signature` 去重(signature 由调用方给,如 `<本地HEAD>:<远端HEAD>`)。
// 同一个故障状态只吵一次;状态一变(又分叉到新位置)才再吵。**只在真送达远端通道时才写
// 去重指纹**——降级路径(pending-alerts / 桌面通知)不算送达,留给下轮重试。
//
// 失败不阻断:任何异常都不 throw、退出码恒 0(与 notify-merge-ack.mjs 同一套韧性契约,
// 连 lib.mjs 也走动态 import,理由见该文件头)。告警发不出去绝不能拖累 review 流程。
//
// 跑:node <skill-root>/scripts/notify-sync-alert.mjs --kind <diverged|code-conflict> \
//       --signature <sig> [--detail "<补充信息,如冲突文件/backupRef>"] [--dry-run]

import { readFileSync, writeFileSync } from 'node:fs';

function printFallback(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  try {
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* best-effort:写失败最多下轮重复告警一次 */
  }
}

const KIND_TEXT = {
  diverged: {
    what: 'skills 仓与远端分叉,自同步双向停摆(ff-pull 拉不动、push 非 ff 被拒)。',
    why: '台账类冲突本应自动收敛,走到这一步说明冲突在脚本 / SKILL.md 这类需要人判断的文件上。',
  },
  'code-conflict': {
    what: 'skills 仓 rebase 收敛时撞上非台账文件冲突,已 abort 保持原状,自动同步无法继续。',
    why: '自动合并代码类冲突会静默丢改动,按设计转人工。',
  },
};

try {
  const { print, resolveInRepoRoot, loadRules } = await import('./lib.mjs');

  const prRules = loadRules();
  const MERGE_ACK = prRules.loopPrExclusion?.mergeAckNotify ?? {};
  if (!MERGE_ACK.notifyModule) {
    print({ ok: true, posted: false, reason: 'notify-module-not-configured' });
    process.exit(0);
  }

  const kind = argAfter('--kind') || 'diverged';
  const signature = argAfter('--signature') || 'unknown';
  const detail = argAfter('--detail');
  const dryRun = process.argv.includes('--dry-run');

  const STATE_DIR = resolveInRepoRoot(MERGE_ACK.stateDir ?? 'history/loops/state');
  // 去重台账与合并致谢的分开放(同目录,便于一起清理),沿用同一层目录约定。
  const DEDUP_FILE = resolveInRepoRoot(
    (MERGE_ACK.dedupFile ?? 'scripts/review-pr/.merge-notified.json').replace(/[^/]+$/, '.sync-alert.json'),
  );

  const notifyModulePath = resolveInRepoRoot(MERGE_ACK.notifyModule);
  const { loadNotifyConfig, sendAlert } = await import(`file://${notifyModulePath}`);
  const baseConfig = loadNotifyConfig(STATE_DIR);
  const target = baseConfig.SLACK_OPS_ALERT_CHANNEL_ID;
  if (!target) {
    print({ ok: true, posted: false, reason: 'ops-alert-channel-not-configured' });
    process.exit(0);
  }

  const state = readState(DEDUP_FILE);
  const fingerprint = `${kind}:${signature}`;
  if (state[kind] === signature) {
    print({ ok: true, posted: false, reason: 'already-alerted', fingerprint });
    process.exit(0);
  }

  const t = KIND_TEXT[kind] ?? KIND_TEXT.diverged;
  const title = 'review-pr 自同步停摆,需要你处理一下。';
  const text = [
    t.what,
    t.why,
    detail ? `现场:${detail}` : '',
    '这个状态不会自愈,每轮都会重现,直到有人 reconcile。修复:进 skills 仓 merge 或 rebase 掉分叉后 push;台账类文件可按 fingerprint 取并集,代码类要人判断保留哪边。',
  ].filter(Boolean).join('\n');

  if (dryRun) {
    print({ ok: true, posted: false, reason: 'dry-run', title, text, target, dedupFile: DEDUP_FILE });
    process.exit(0);
  }

  // 私聊目标就地替换 SLACK_CHANNEL_ID —— 群内播报出口保持原样,互不影响。
  // **同时把 webhook 摘掉**:sendAlert 在 api 通道不可用(如 bot token 失效)时会降级走
  // incoming webhook,而 webhook 的目标频道是固定的群频道——运维告警一旦从那儿漏出去,
  // 就违背了「这类噪音不进团队频道」的约定。摘掉后最坏只降级到 pending-alerts + 桌面
  // 通知(channel:'degraded',不写去重指纹,下轮重试),绝不会发错地方。
  const result = await sendAlert({
    stateDir: STATE_DIR,
    config: { ...baseConfig, SLACK_WEBHOOK_URL: '', SLACK_CHANNEL_ID: target },
    title,
    text,
  });
  const posted = result.channel === 'api' || result.channel === 'webhook';
  if (posted) {
    state[kind] = signature;
    writeState(DEDUP_FILE, state);
  }
  print({ ok: true, posted, channel: result.channel, ...(posted ? { fingerprint } : {}) });
} catch (e) {
  printFallback({ ok: true, posted: false, reason: 'sync-alert-error', error: String(e?.message ?? e) });
}
