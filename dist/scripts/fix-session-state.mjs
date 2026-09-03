#!/usr/bin/env node
// fix-session-state.mjs — 历史跟进会话绑定的只读清理(5.4 fix-handoff 已于 2026-09-03 停用)。
//
// 本流程不得再为任何 PR 开 / 复用跟进修复会话。get / set 拒绝投递;只保留
// clear / sweep 清掉已合并、已关闭 PR 的旧绑定。不碰 MCP、不碰 GitHub。
//
// 用法:
//   node <skill-root>/scripts/fix-session-state.mjs get <PR> [--fingerprint <fp>]
//     → shouldDispatch 恒 false(5.4 已停用,禁止 create/jump)。仍回 sessionId 供核对旧绑定。
//   node <skill-root>/scripts/fix-session-state.mjs set <PR> --session <id> --fingerprint <fp>
//     → 失败退出,不写盘。
//   node <skill-root>/scripts/fix-session-state.mjs clear <PR>
//     → 删除绑定。
//   node <skill-root>/scripts/fix-session-state.mjs sweep --open <逗号分隔的 open PR 号列表>
//     → 绑定里不在 open 列表中的 PR 一次性删掉。auto 每轮阶段 1 扫描后可调一次。
//
// 状态文件位于 Skill 外部状态目录：{ "<pr>": { sessionId, fingerprint, dispatchedAt } }。
// 读写失败不炸流程:get 失败按「无绑定 + 不投递」兜底。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parsePR, print, fail, stateFile } from './lib.mjs';

const STATE_FILE = stateFile('fix-sessions.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // 损坏当空,下次 set 重建
  }
}

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

try {
  const [, , cmd, prArg] = process.argv;
  if (!['get', 'set', 'clear', 'sweep'].includes(cmd)) {
    throw new Error('用法:fix-session-state.mjs <get|set|clear|sweep> [PR] [--session <id>] [--fingerprint <fp>] [--open <n,n,...>]');
  }

  if (cmd === 'sweep') {
    const openArg = argAfter('--open');
    if (process.argv.indexOf('--open') < 0) throw new Error('sweep 需要 --open <逗号分隔的 open PR 号列表>(可为空串=全清)');
    const openSet = new Set(openArg.split(',').map((s) => s.trim()).filter(Boolean).map((s) => String(parsePR(s))));
    const state = loadState();
    const cleared = Object.keys(state).filter((k) => !openSet.has(k));
    for (const k of cleared) delete state[k];
    if (cleared.length) writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    print({ ok: true, cleared: cleared.map(Number), remaining: Object.keys(state).map(Number) });
    process.exit(0);
  }

  const pr = parsePR(prArg);
  const key = String(pr);
  const state = loadState();
  const entry = state[key] ?? null;

  if (cmd === 'get') {
    print({
      ok: true,
      pr,
      sessionId: entry?.sessionId ?? null,
      lastFingerprint: entry?.fingerprint ?? null,
      dispatchedAt: entry?.dispatchedAt ?? null,
      shouldDispatch: false,
      reason: '5.4 已停用,禁止开/复用跟进会话(get 只读旧绑定,不得 create/jump)',
    });
  } else if (cmd === 'set') {
    throw new Error('5.4 已停用:fix-session-state set 拒绝写绑定,不得为 PR 开跟进会话');
  } else {
    const existed = Boolean(entry);
    delete state[key];
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    print({ ok: true, pr, cleared: existed });
  }
} catch (e) {
  fail(e);
}
