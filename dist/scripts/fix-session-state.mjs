#!/usr/bin/env node
// fix-session-state.mjs — 「自动跟进修复(fix-handoff)」的 PR → 跟进会话绑定与投递去重状态。
//
// 背景:selfFixAuthors(pr-rules.json)名单里作者的 PR 卡在作者侧问题时,skill 不打回,
// 而是通过 handoff 工具为该 PR 开 / 复用一个专属跟进会话去修复(详见 SKILL「自动跟进修复
// (fix-handoff)」)。本脚本管两件确定性的事,不碰 MCP、不碰 GitHub:
//   1. 绑定:PR 号 → 跟进会话 sessionId(首次 create 后由 skill 回写;之后同 PR 走 jump 复用)。
//   2. 去重:同一卡点不重复投递。指纹由调用方拼(建议 `${headRefOid}|${auto.action}`),
//      上次投递后指纹没变 → shouldDispatch=false(跟进会话大概率还在修,别打扰);
//      指纹变了(修完 push 了新 commit 又发现新问题 / 卡点类别变了)→ true,再投新卡点。
//
// 用法:
//   node <skill-root>/scripts/fix-session-state.mjs get <PR> --fingerprint <fp>
//     → { ok, pr, sessionId|null, lastFingerprint|null, dispatchedAt|null, shouldDispatch, reason }
//       sessionId=null → 该 PR 无绑定,shouldDispatch 恒 true(走 create);
//       sessionId 非空 → 走 jump;若 jump 撞 NOT_FOUND/ARCHIVED/DELETED,skill 应 clear 后重走 create。
//   node <skill-root>/scripts/fix-session-state.mjs set <PR> --session <id> --fingerprint <fp>
//     → 投递成功后回写绑定 + 指纹(create 与 jump 成功后都要调,jump 只会更新指纹)。
//   node <skill-root>/scripts/fix-session-state.mjs clear <PR>
//     → 删除绑定(PR 已合并 / 关闭,或 jump 发现目标会话已不存在时)。
//   node <skill-root>/scripts/fix-session-state.mjs sweep --open <逗号分隔的 open PR 号列表>
//     → 批量清理:绑定里不在 open 列表中的 PR(已合并 / 已关闭)一次性删掉,返回 cleared 数组。
//       auto 批处理每轮阶段 1 扫描后调一次(open 列表来自 --scan-all 的 candidates)。
//
// 状态文件位于 Skill 外部状态目录：{ "<pr>": { sessionId, fingerprint, dispatchedAt } }。
// 读写失败不炸流程:get 失败按「无绑定」兜底(方向安全:最多多开一个会话,不会漏跟进)。

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
    const fingerprint = argAfter('--fingerprint');
    let shouldDispatch = true;
    let reason;
    if (!entry) {
      reason = '无绑定,首次投递(走 create 新建跟进会话)';
    } else if (fingerprint && entry.fingerprint === fingerprint) {
      shouldDispatch = false;
      reason = '指纹与上次投递一致(卡点无变化,跟进会话应该还在处理),本轮不重复投递';
    } else {
      reason = '已有绑定且卡点指纹变化,投递新卡点(走 jump 复用会话)';
    }
    print({
      ok: true,
      pr,
      sessionId: entry?.sessionId ?? null,
      lastFingerprint: entry?.fingerprint ?? null,
      dispatchedAt: entry?.dispatchedAt ?? null,
      shouldDispatch,
      reason,
    });
  } else if (cmd === 'set') {
    const sessionId = argAfter('--session');
    const fingerprint = argAfter('--fingerprint');
    if (!sessionId) throw new Error('set 需要 --session <id>');
    state[key] = { sessionId, fingerprint, dispatchedAt: new Date().toISOString() };
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    print({ ok: true, pr, saved: state[key] });
  } else {
    const existed = Boolean(entry);
    delete state[key];
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    print({ ok: true, pr, cleared: existed });
  }
} catch (e) {
  fail(e);
}
