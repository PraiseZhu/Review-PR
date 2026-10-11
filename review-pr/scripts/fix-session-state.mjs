#!/usr/bin/env node
// fix-session-state.mjs — 「自动跟进修复(fix-handoff)」的 PR → 跟进会话绑定与投递去重状态。
//
// 背景:selfFixAuthors(pr-rules.json)名单里作者的 PR 卡在作者侧问题时,skill 通过
// handoff 工具为该 PR 开 / 复用一个专属跟进会话去修复(见 references/fix-handoff.md)。
// 批次主 session 串行使用本脚本；PR 审查子 agent 不直接写共享绑定。本脚本不碰 MCP/GitHub:
//   1. 绑定:PR 号 → 跟进会话 sessionId(首次 create 后由 skill 回写;之后同 PR 走 jump 复用)。
//   2. 去重:同一卡点不重复投递。指纹由调用方拼。thread / CI 失败 / 冲突必须分开记;
//      冲突再带当时的 base。同 head 的 findings→threads-unresolved 仍去重;CI/冲突是新卡点。
//   3. 看门狗:指纹没变也从不查会话是否还在干活。投递超过 FIX_WATCHDOG_MS 仍无进展则催一次;
//      第二次超时交回给人(needsHuman),不再当 auto-fixing。
//
// 用法:
//   node <skill-root>/scripts/fix-session-state.mjs get <PR> --fingerprint <fp>
//     → { ok, pr, sessionId, lastFingerprint, dispatchedAt, shouldDispatch, reason, watchdog?, needsHuman }
//   node <skill-root>/scripts/fix-session-state.mjs set <PR> --session <id> --fingerprint <fp>
//        [--watchdog nudge|escalate] [--needs-human]
//   node <skill-root>/scripts/fix-session-state.mjs clear <PR>
//   node <skill-root>/scripts/fix-session-state.mjs sweep --open <逗号分隔的 open PR 号列表>
//
// 状态文件位于 Skill 外部状态目录。读写失败不炸流程:get 失败按「无绑定」兜底。

import { existsSync, readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePR, print, fail, stateFile } from './lib.mjs';
import { atomicWriteJson } from './runtime-io.mjs';

const STATE_FILE = stateFile('fix-sessions.json');
export const FIX_WATCHDOG_MS = 6 * 60 * 60 * 1000;

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function argAfter(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? '') : '';
}

function readThreadUrls(argv) {
  const path = argAfter(argv, '--threads-file');
  if (!path) return null;
  const urls = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(urls) || !urls.length || urls.some((url) =>
    typeof url !== 'string' || !/^https:\/\/[^\s]+#discussion_r\d+$/.test(url))) {
    throw new Error('--threads-file 必须是非空的真实 review thread URL 数组');
  }
  return [...new Set(urls)].sort();
}

function causeOf(fingerprint) {
  return String(fingerprint ?? '').split('|')[1] || '';
}

function sameThreadRoute(previous, next) {
  const a = causeOf(previous);
  const b = causeOf(next);
  if (!a || !b) return false;
  if (a === b) return true;
  return (a === 'review-failed' && b === 'skip-gate') || (a === 'skip-gate' && b === 'review-failed');
}

export function evaluateFixDispatch({ entry, fingerprint, threadUrls = null, now = Date.now() } = {}) {
  const knownThreads = Array.isArray(entry?.threadUrls) && entry.threadUrls.length ? entry.threadUrls : null;
  const sameHead = Boolean(fingerprint && entry?.fingerprint?.split('|')[0] === fingerprint.split('|')[0]);
  const sameThreads = Boolean(sameHead && threadUrls && knownThreads && threadUrls.every((url) => knownThreads.includes(url)));
  const result = {
    sessionId: entry?.sessionId ?? null,
    lastFingerprint: entry?.fingerprint ?? null,
    lastThreadUrls: knownThreads ?? [],
    dispatchedAt: entry?.dispatchedAt ?? null,
    nudgeCount: Number.isInteger(entry?.nudgeCount) ? entry.nudgeCount : 0,
    needsHuman: entry?.needsHuman === true,
    shouldDispatch: true,
  };
  if (!entry) {
    return { ...result, reason: '无绑定,首次投递(走 create 新建跟进会话)' };
  }

  const age = now - Date.parse(entry.dispatchedAt);
  const timedOut = Number.isFinite(age) && age >= FIX_WATCHDOG_MS;
  const watchdog = timedOut ? ((entry.nudgeCount ?? 0) < 1 ? 'nudge' : 'escalate') : undefined;
  const applyWatchdog = (reason) => {
    if (!timedOut) return { ...result, shouldDispatch: false, reason };
    return {
      ...result,
      shouldDispatch: true,
      watchdog,
      reason: watchdog === 'nudge'
        ? '投递后超时仍无进展,催跟进会话说明卡点并继续修'
        : '第二次看门狗仍无进展,交回维护者',
    };
  };

  if (entry.needsHuman && fingerprint && entry.fingerprint === fingerprint &&
      (!threadUrls || sameThreads || !knownThreads)) {
    return { ...result, shouldDispatch: false, reason: '跟进会话已交回给人,不再自动投递' };
  }
  if (sameThreads && sameThreadRoute(entry.fingerprint, fingerprint)) {
    return applyWatchdog('同 head 的这些 thread 已成功投递,不因审查路由变化重复催办');
  }
  if (sameHead && threadUrls && knownThreads && !sameThreads) {
    return { ...result, reason: '同 head 出现尚未投递的新 thread,复用会话跟进新增意见' };
  }
  if (fingerprint && entry.fingerprint === fingerprint) {
    return applyWatchdog('指纹与上次投递一致(卡点无变化,跟进会话应该还在处理),本轮不重复投递');
  }
  return { ...result, reason: '已有绑定且卡点指纹变化,投递新卡点(走 jump 复用会话)' };
}

function runCli(argv) {
  const [, , cmd, prArg] = argv;
  if (!['get', 'set', 'clear', 'sweep'].includes(cmd)) {
    throw new Error('用法:fix-session-state.mjs <get|set|clear|sweep> [PR] [--session <id>] [--fingerprint <fp>] [--open <n,n,...>] [--watchdog nudge|escalate] [--needs-human]');
  }

  if (cmd === 'sweep') {
    const openArg = argAfter(argv, '--open');
    if (argv.indexOf('--open') < 0) throw new Error('sweep 需要 --open <逗号分隔的 open PR 号列表>(可为空串=全清)');
    const openSet = new Set(openArg.split(',').map((s) => s.trim()).filter(Boolean).map((s) => String(parsePR(s))));
    const state = loadState();
    const cleared = Object.keys(state).filter((k) => !openSet.has(k));
    for (const k of cleared) delete state[k];
    if (cleared.length) atomicWriteJson(STATE_FILE, state);
    print({ ok: true, cleared: cleared.map(Number), remaining: Object.keys(state).map(Number) });
    return;
  }

  const pr = parsePR(prArg);
  const key = String(pr);
  const state = loadState();
  const entry = state[key] ?? null;

  if (cmd === 'get') {
    const fingerprint = argAfter(argv, '--fingerprint');
    const threadUrls = readThreadUrls(argv);
    const decision = evaluateFixDispatch({ entry, fingerprint, threadUrls, now: Date.now() });
    print({ ok: true, pr, ...decision });
    return;
  }

  if (cmd === 'set') {
    const sessionId = argAfter(argv, '--session');
    const fingerprint = argAfter(argv, '--fingerprint');
    if (!sessionId) throw new Error('set 需要 --session <id>');
    const threadUrls = readThreadUrls(argv);
    const watchdog = argAfter(argv, '--watchdog');
    if (watchdog && !['nudge', 'escalate'].includes(watchdog)) throw new Error('--watchdog 只能是 nudge 或 escalate');
    const needsHuman = argv.includes('--needs-human') || watchdog === 'escalate';
    const sameFingerprint = Boolean(entry?.fingerprint && fingerprint && entry.fingerprint === fingerprint);
    const timedOut = Boolean(entry?.dispatchedAt) &&
      Number.isFinite(Date.parse(entry.dispatchedAt)) &&
      (Date.now() - Date.parse(entry.dispatchedAt)) >= FIX_WATCHDOG_MS;
    const nudged = watchdog === 'nudge' || (sameFingerprint && timedOut && !needsHuman);
    const next = {
      sessionId,
      fingerprint,
      dispatchedAt: new Date().toISOString(),
      nudgeCount: needsHuman || nudged ? Math.max(entry?.nudgeCount ?? 0, 1) : 0,
    };
    if (needsHuman) next.needsHuman = true;
    if (threadUrls) next.threadUrls = threadUrls;
    else if (sameFingerprint && Array.isArray(entry?.threadUrls) && entry.threadUrls.length) next.threadUrls = entry.threadUrls;
    state[key] = next;
    atomicWriteJson(STATE_FILE, state);
    print({ ok: true, pr, saved: state[key] });
    return;
  }

  const existed = Boolean(entry);
  delete state[key];
  atomicWriteJson(STATE_FILE, state);
  print({ ok: true, pr, cleared: existed });
}

const realOrRaw = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
const isMain = !!process.argv[1] && realOrRaw(process.argv[1]) === realOrRaw(fileURLToPath(import.meta.url));
if (isMain) {
  try { runCli(process.argv); } catch (e) { fail(e); }
}
