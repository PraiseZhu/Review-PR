#!/usr/bin/env node
// signoff-hold.mjs — 维护者确认门的拦截动作:自动创建讨论 issue → 在 PR 上发评论告知作者
// (带 issue 链接)→ 打上维护者确认标签。**不再转 draft**(旧 draft 制已废除:draft 带来的
// hold↔ready 死循环、PAT 无 convertToDraft 权限、归属判定一整族复杂度随之消失;
// 真正挡合并的是流程内部的判定,标签只是 GitHub 后台的可筛性入口——
// 通过动作是维护者在 PR 上 Approve,摘标签不构成通过)。
//
// 移植自 lizi 上游 signoff-hold.mjs(makecindy/cindy-lizi-skills,2026-08-09),
// 适配点:全部依赖函数已在 mivo 侧 lib.mjs(signoff 统一段)补齐;--kind 只影响措辞,
// 触发判定由 context.mjs 按 mivo 扁平配置(securityReviewPaths / archGate / ruleFiles)
// 输出,本脚本只做动作 + 幂等。文案(issue 标题 / issue 正文 / PR 评论)由调用方
// (主 agent 按 SKILL 要求与语气规范拟)经 --payload-file 传 JSON 进来,脚本不生成
// 任何一句对外文字;缺文案时拒绝执行主动作(reason=missing-payload,标签照打)。
//
// 状态回帖(renotice):首次 hold 的评论只发一次,但门会**反复**亮起来 —— 维护者
// Request Changes → 标签摘掉、球给作者;作者改完推上来 → 门重新亮、标签挂回去。
// 这个「挂回去」以前是完全静默的;所以本脚本在「已经 hold 过 + 本轮发现标签不在」
// 时自动补一条回帖,按 head sha 去重。判据用的是**看到时标签不在**(不是「加标签成功」)。
// 这条文案是固定模板、由脚本自己出:它不含任何语义判断,而可靠性要求它不能依赖上层
// 每轮都记得传文案。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段,让 auto 轮转能继续下一候选。
//
// 跑:node <skill-root>/scripts/signoff-hold.mjs <PR> [--payload-file <path|->]
//     [--kind <product|arch|security|coldUpdate|rules|pluginBase>] [--labels-only] [--dry-run]
//     [--no-renotice]
//   --payload-file:JSON 文案来源,`-` = stdin(推荐,避开中文/引号问题)。结构:
//     { "issueTitle": "...", "issueBody": "...", "commentBody": "...{{ISSUE_URL}}..." }
//     commentBody 里的 {{ISSUE_URL}} 会被替换成新建 issue 的链接;没写占位符则自动在
//     末尾追加一行「讨论 issue:<url>」。已存在标记评论时 payload 可省(只补打标签)。
//   --kind:当前在拦的触发类别(context 的 signoff.triggers 命中),只影响措辞。
//   --labels-only:只确保维护者确认标签挂上(并摘掉旧门类子标签),不开 issue、不发首次
//     hold 评论。用于标签状态重同步。**状态回帖照发**(见上)。
//   --no-renotice:关掉状态回帖(只给测试/特殊场景用)。
//   --dry-run:只探测(是否已拦截过 / 将做什么),不写任何外部状态——**也不获取排他锁**
//     (round2 修复:此前 dry-run 会真的写锁文件,和本行文档自称的"不写外部状态"矛盾,
//     还会跟真实执行抢锁造成饥饿)。
//
// 正确调用(`-` 走 stdin):
//   node .../signoff-hold.mjs 123 --kind security --payload-file - <<'JSON'
//   { "issueTitle": "…", "issueBody": "…", "commentBody": "…{{ISSUE_URL}}…" }
//   JSON
//
// 排他锁相关环境变量(见下方"幂等原子 claim"段):
//   SIGNOFF_HOLD_LOCK_DIR:锁文件目录,默认 stateFile('signoff-hold-locks')(按本地
//     git-common-dir 哈希隔离,见 lib.mjs repoStateKey)。
//   SIGNOFF_HOLD_LOCK_TIMEOUT_MS:抢锁轮询的超时上限,默认 15000。
// 锁超时(拿不到锁)时的输出:reason='lock-timeout' + needsIntervention:true +
//   holderPid/holderStartedAt(能读到时)——round2 前是完全静默的 {held:false},现在
//   显式标注"需要人工介入",不再悄悄交给下一轮空转。
// 其它 round2 新增输出字段:heldBlockedBy(held=false 时点名 issue/comment/labels 里
//   具体是哪项没成)、legacyLabelWarning(旧门类标签清理失败,与本轮 signoff 标签是否
//   挂上——labelWarning——是两件独立的事,不互相连坐)。

import { readFileSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, writeSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseRepo, parsePR, gh, print, fail, renderIssueUrl, PRODUCT_GATE_MARKER_PREFIX, SIGNOFF_RENOTICE_MARKER_PREFIX, parseSignoffRenotices, loadRules, syncSignoffLabel, SIGNOFF_LABEL_DEFAULT, removeLegacyGateLabels, issueNumberFromUrl, decideIssueReuse, stateFile } from './lib.mjs';

// 隐藏去重标记:HTML 注释,GitHub 渲染不可见,但 API 返回的 body 里查得到。
// 前缀沿用 review-pr:product-gate(lib.mjs 常量,parseLastHoldMarker 共用)——存量被 hold
// 的 PR 用的就是它。kind=arch 兼容位:非 product 触发统一带 kind=arch(历史消费方只区分这两种)。
const MARKER_PREFIX = PRODUCT_GATE_MARKER_PREFIX;
const marker = (issueUrl, kind) =>
  kind === 'product' ? `${MARKER_PREFIX} issue=${issueUrl} -->` : `${MARKER_PREFIX} kind=arch issue=${issueUrl} -->`;

const KIND_TOPICS = {
  product: '产品 / UI 变更',
  arch: '技术架构调整',
  security: '安全敏感改动',
  coldUpdate: 'mobile 冷更(runtime fingerprint 变化)',
  rules: '审查规则文档变更',
  pluginBase: '插件基座改动(影响全部已装插件)',
};

// ── 幂等原子 claim(SC-1) ──
// 旧实现是 check-then-act:读标记评论判「是否已 hold 过」和写 issue/评论之间没有互斥,
// 同一份本地 checkout 下的两个并发实例(如同一 worktree 被同一台机器上的两条流水线
// 同时触发)会各自认为「没 hold 过」,各建一份 issue、各发一条评论。这里用
// fs.openSync(path,'wx') 排他创建当锁——它是文件系统级原子操作,不存在「检查时不存在、
// 创建时已被抢先」的窗口。锁覆盖从读 PR 元数据到写完 issue/评论/标签的整段
// check-then-act,谁抢到锁谁独占执行,另一个实例原地等待(轮询)或超时退让,不会出现
// "两边都判定为需要新建"的竞态。
// 覆盖边界(round2 收窄声明,勿再扩大):锁目录锚定在本地 git-common-dir 的 realpath
// 哈希(见 lib.mjs repoStateKey)——同一份本地 clone 下的所有 worktree 共享同一把锁,
// 但不同 clone(不同机器 / 不同 CI runner 各自 checkout 一份)拿到的是不同锁目录,
// 互斥在这种场景下不生效。真正的跨机器互斥需要挪到 GitHub 一侧(如基于
// If-Match/conditional write 的原子标记),留作后续独立 PR,这里先如实收窄声明范围。
const LOCK_POLL_MS = 100;
const LOCK_TIMEOUT_MS = Number(process.env.SIGNOFF_HOLD_LOCK_TIMEOUT_MS || 15000);

// round5 R5-1(blocker 修复,推翻 round4 的上界声称):round4 声称「临界区最坏 11 次
// gh 调用 × 15s = 165s < 300s 租约」,复审席实测否掉——对账是 O(重复数) 不是常数 3:
// 10 个唯一 hold URL 实测 27 次调用(9 view + 9 close + 9 comment),27×15s=405s 已超
// LOCK_STALE_MS。失效链:持锁进程在临界区内跑对账超过 LOCK_STALE_MS → 它仍活着但已
// 满足 isLockStale 的时间条件 → 另一实例接管 → 两个实例对同一 PR 做重复的不可逆
// GitHub 写入(正是 D2 要消灭的双写,只是从「没有上界」变成「上界算错」)。
// 本轮修复:上界由代码强制,不再写死常数声称。
//   1) 临界区调用预算(ghB):每次 gh 调用消耗 1 个预算,预算耗尽后不再发出调用,
//      剩余工作主动放弃并 fail-visible(budgetExhausted 进 errors/legacyErrors 报出,
//      下一轮重试自愈)——这是「临界区内允许的 gh 调用数」的显式上界;
//   2) 对账每轮最多处理 MAX_RECONCILE_DUPS 个重复,超出部分报在 reconciliation.
//      unprocessed(数量 + URL),下一轮继续——对账这个 O(n) 项被结构性钳住。
// 预算取值推导(推导值,未逐秒实测;实际调用数由 tests「D2 对账上界」对 10 个重复
// 实测绑定):固定部分最坏 8 次调用(pr view / issue view / issue create / pr comment /
// label create / label POST / legacy label DELETE / renotice,均为数据无关的固定调用
// 点;实测单轮完整流程固定调用 5~6 次,见「D2 对账上界」用例),对账 3×3=9 次 →
// 预算 17 次;17 × 15s = 255s < 300s,余量 45s。legacy 标签多于 1 个等超预算场景:
// 后续调用 budgetExhausted fail-visible,下一轮重试——宁可少做,不可超过租约。
// SIGNOFF_HOLD_GH_TIMEOUT_MS 供测试用短值验证超时机制(生产默认 15s)。
export const GH_CALL_TIMEOUT_MS = Number(process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS || 15000);
// 锁内容损坏/legacy 纯 pid 格式读不出 token 时的 mtime 兜底阈值
export const LOCK_STALE_MS = 5 * 60 * 1000;
// round5 R5-1:临界区 gh 调用预算 = 固定部分 + 对账(每重复最坏 3 次:view+close+comment)。
// 推导值(见上注释):FIXED_CRITICAL_CALLS 为数据无关调用点枚举口径,未逐秒实测;
// MAX_RECONCILE_DUPS 按 17×15s<300s 且留 45s 余量选取。行为上界由 ghB 强制、由测试
// 对实际调用数实测绑定,两者都非写死常数声称。
export const FIXED_CRITICAL_CALLS = 8;
export const MAX_RECONCILE_DUPS = 3;
export const CRITICAL_SECTION_MAX_CALLS = FIXED_CRITICAL_CALLS + 3 * MAX_RECONCILE_DUPS;
// 临界区 gh 调用的统一超时包装:所有临界区网络调用必须走 ghT,否则可能超出租约。
const ghT = (args, opts = {}) => gh(args, { timeoutMs: GH_CALL_TIMEOUT_MS, ...opts });
// round5 R5-1:预算包装——main() 里临界区所有 gh 调用走 ghB,调用数超过
// CRITICAL_SECTION_MAX_CALLS 后不再发出,立即返回 budgetExhausted 失败(调用方按
// 「未完成,下一轮重试」处理,报进输出,fail-visible,不静默)。
function makeBudgetedGh(inner) {
  let calls = 0;
  return (args, opts = {}) => {
    if (calls >= CRITICAL_SECTION_MAX_CALLS) {
      return {
        ok: false, budgetExhausted: true, stdout: '', status: 1,
        stderr: 'critical-section-budget-exhausted:本轮临界区 gh 调用预算已用完,剩余动作未执行,下一轮重试',
      };
    }
    calls += 1;
    return inner(args, opts);
  };
}
const ghB = makeBudgetedGh(ghT);

function lockPathFor(owner, repo, pr) {
  const dir = process.env.SIGNOFF_HOLD_LOCK_DIR || stateFile('signoff-hold-locks');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${owner}__${repo}__${pr}.lock`);
}

// 同步阻塞等待,不依赖 subprocess/sleep 二进制;Node 主线程允许 Atomics.wait(仅浏览器
// 主线程禁止),这里跑在 CLI 脚本里,合法且不引入额外依赖。
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function readLockInfo(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed.pid === 'number' && typeof parsed.token === 'string') return parsed;
  } catch { /* 内容损坏,或 round1 遗留的纯 pid 字符串格式 → 交给调用方走 mtime 兜底 */ }
  return null;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true; // 收到信号本身就说明进程还在(不管是否同用户可签)
  } catch (e) {
    return e.code !== 'ESRCH'; // ESRCH=进程已死→陈旧;EPERM 等一律保守当"还活着"
  }
}

// round3 D2(blocker 修复):陈旧判据 = 「进程死了」或「持有超过 LOCK_STALE_MS」任一成立。
// round2 只看 pid,而 readLockInfo 对合法 JSON 恒返回非 null → mtime 兜底分支永远走不到;
// 叠加 isPidAlive 在 EPERM(跨用户杀不动)与 PID 复用(死进程 pid 被新进程复用)下都判
// "活着" → 锁永久不可回收、门永久失效,相对 round1 纯 mtime(5 分钟自愈)是能力回退。
// 加回时间上限后,EPERM/PID 复用最坏只把回收延迟到 LOCK_STALE_MS 之后,不会永久死锁。
// startedAt 缺失/非法(旧格式 JSON)时该子句恒 false,退化为仅 pid 判定,行为同 round2。
// round4 D1(blocker 修复):写入方统一 ISO 8601(round3 写数字时间戳,而 Date.parse 对
// 数字返回 NaN → 该模块自己写出的锁,自己永远判不出陈旧);判据对两种形态都容错,
// 防止旧格式数字锁文件残留时又踩坑:
//   - 数字毫秒时间戳(旧格式残留):正确解析,超 LOCK_STALE_MS 即判陈旧可回收;
//   - 缺失 / 非法字符串:无法凭时间判定年龄 → 退化为仅 pid 判定(fail-closed:
//     不凭时间抢占活进程;pid 已死则照常回收,不会"永不陈旧");
//   - 未来时间戳(时钟偏移/写入错误):年龄为负,同样 fail-closed 不回收,等 pid 判定。
// round5 R5-3:导出供测试做「生产写入 → 读取判定」端到端断言(acquireHoldLock 真实
// 写锁后读回,用同一份 parseStartedAtMs / isLockStale 验证真实形状,不再只喂手搓对象)。
export function parseStartedAtMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

export function isLockStale(info) {
  if (!info) return true;
  if (!isPidAlive(info.pid)) return true;
  const startedAt = parseStartedAtMs(info.startedAt);
  if (!Number.isFinite(startedAt)) return false; // 缺失/非法 → 仅 pid 判定(fail-closed)
  return Date.now() - startedAt > LOCK_STALE_MS;
}

// 接管锁正常只持有毫秒级,60s 足够覆盖进程死在中间的自愈(对齐 prepare.mjs 的
// TAKEOVER_TTL_MS)。
const TAKEOVER_TTL_MS = 60 * 1000;

// round3 D3:takeover 文件读回;round2 写入的是裸 pid 字符串,连日后加 TTL 都无从计算,
// 这里统一为 JSON {startedAt, token}。解析失败/旧裸 pid 格式 → 返回 null,视为可清理
// 的陈旧残留(不视为"别人正在接管")。
function readTakeoverInfo(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed.token === 'string') return parsed;
  } catch { /* 残留旧格式 / 内容损坏 → 交给调用方当陈旧残留处理 */ }
  return null;
}

export function tryTakeoverStaleLock(path, takeoverPath, token, writeOwn) {
  // 两阶段抢占(镜像 prepare.mjs 的 takeover 机制,round2 D2 修复):先原子创建 sibling
  // .takeover 文件当"抢占锁",拿到后在其保护下复核主锁确实还陈旧、再 unlink+recreate;
  // 避免两个并发实例同时判定陈旧、同时抢占导致互相删对方刚写的新锁。
  // round3 D3:takeover 文件带 {startedAt, token} 元数据——SIGKILL 下 finally 不执行,
  // 残留文件必须能自愈:未超 TAKEOVER_TTL_MS 视为"另一实例正在接管"放弃本轮(交外层
  // 轮询重试),超 TTL 的残留(含 round2 裸 pid 格式)清理后重试一轮。
  for (let attempt = 0; attempt < 2; attempt++) {
    const takeoverPayload = JSON.stringify({ startedAt: new Date().toISOString(), token });
    try {
      const tfd = openSync(takeoverPath, 'wx');
      try {
        writeSync(tfd, takeoverPayload);
      } finally {
        closeSync(tfd);
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = readTakeoverInfo(takeoverPath);
      const startedAt = info?.startedAt == null ? NaN : Date.parse(info.startedAt);
      if (Number.isFinite(startedAt) && Date.now() - startedAt < TAKEOVER_TTL_MS) {
        return false; // 另一实例正在接管,本轮放弃,交给外层轮询重试
      }
      // 残留(进程死在中间 / round2 裸 pid 格式)→ 清理后重试;清理失败(极端竞态)也放弃
      try { unlinkSync(takeoverPath); } catch { return false; }
      continue;
    }
    try {
      // round3 D4(wx 成功后复核内容):上面「stale 残留 → unlink → create」不是原子抢占,
      // 另一实例可能基于更早的 stale 读把我们刚建的接管锁误删重建(与主锁当年踩过的
      // unlink+create 竞态同款,prepare.mjs 同款复核)。内容不是自己的就退出竞争,
      // 避免两个实例同时自认持有接管锁 → 双持有主锁。
      const own = readTakeoverInfo(takeoverPath);
      if (!own || own.token !== token) return false;
      // 持有接管锁后复核主锁:可能已被别的实例接管重建(变新),那就不是我们的了
      const recheck = readLockInfo(path);
      if (recheck && !isLockStale(recheck)) return false; // 被别的实例刷新成活锁,不抢
      try { unlinkSync(path); } catch { /* 已被抢占清理过 */ }
      // round4 D6(blocker 修复):宽 catch 不能吞编程错误——round3 自己踩过
      // ReferenceError 被 catch 吞掉的坑,同类模式不许再留。wx 成功 = 文件是**我们**
      // 创建的,writeOwn 失败时 close + unlink 清掉 0 字节残留(否则后续轮询读到
      // 新 mtime 的空锁一路走到超时);ReferenceError/TypeError 是编程错误,重新抛出,
      // 不得静默降级成"抢占失败";其余带 errno 的 IO 错误(EEXIST 竞态等)才按
      // 预期失败处理,交外层轮询重试。
      let fd = null;
      try {
        fd = openSync(path, 'wx');
        writeOwn(fd);
        closeSync(fd);
        fd = null;
        return true;
      } catch (e) {
        if (fd != null) {
          try { closeSync(fd); } catch { /* fd 已不可用 */ }
          try { unlinkSync(path); } catch { /* 已被抢先清理 */ }
        }
        if (e instanceof ReferenceError || e instanceof TypeError) throw e;
        return false; // 极端竞态/IO 错误下重建失败,交外层轮询重试而不是崩溃
      }
    } finally {
      try { unlinkSync(takeoverPath); } catch { /* 本就没有,或已清理 */ }
    }
  }
  return false;
}

export function acquireHoldLock(owner, repo, pr, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const path = lockPathFor(owner, repo, pr);
  const takeoverPath = `${path}.takeover`;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  // round4 D1:写入 ISO 8601 字符串(与同仓 prepare.mjs 的 new Date().toISOString() 一致),
  // 不再写数字时间戳——round3 写数字导致 Date.parse 判据恒 NaN、自己写出的锁永远判不出
  // 陈旧。判据侧对数字/ISO 两种形态都容错,旧格式数字残留锁不会踩坑。
  const writeOwn = (fd) => writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }));
  for (;;) {
    try {
      const fd = openSync(path, 'wx'); // 原子排他创建:已存在则抛 EEXIST,不存在才会创建成功
      writeOwn(fd);
      closeSync(fd);
      return { path, acquired: true, token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 判陈旧(round3 D2,替换 round2 纯 pid 判定):「持有者进程死了」或「持有超过
      // LOCK_STALE_MS」任一成立即陈旧(见 isLockStale)。一次性判定,不是心跳续期。
      // 锁内容损坏/round1 遗留纯 pid 字符串格式(读不出 pid+token)时,退回 mtime 超时
      // 兜底,这条兜底路径预期随存量锁文件自然淘汰。
      const info = readLockInfo(path);
      let stale = false;
      if (info) {
        stale = isLockStale(info);
      } else {
        try {
          const st = statSync(path);
          stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
        } catch { /* 锁在检测瞬间被持有者自己释放,走下面超时判断/轮询重试 */ }
      }
      if (stale && tryTakeoverStaleLock(path, takeoverPath, token, writeOwn)) {
        return { path, acquired: true, token };
      }
      if (Date.now() >= deadline) {
        // 超时且锁还在被(可能仍然活着的)另一实例占用:不再是旧版的静默
        // {acquired:false, timeout:true} —— 显式标注 needsIntervention,把持锁方 pid/
        // 起始时间带出去,让调用方决定要不要报警/人工介入,而不是悄悄交给下一轮空转。
        const holder = readLockInfo(path) ?? {};
        return {
          path, acquired: false, timeout: true, needsIntervention: true,
          holderPid: holder.pid ?? null, holderStartedAt: holder.startedAt ?? null,
        };
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

export function releaseHoldLock(lockInfo) {
  if (!lockInfo?.acquired) return { released: false, alreadyAbsent: false, notOwner: false };
  // round2 D3:释放前核对 token,不再无条件按路径 unlink——旧版的 bug 是 acquire 写进 pid
  // 却从来不读回来比对,release 时见路径存在就删。误删的后果是双实例同跑,比漏删严重
  // 得多(同 main lock 的 releaseLockOwned 教训,见 lib.mjs releaseLockOwned)。
  let raw;
  try {
    raw = readFileSync(lockInfo.path, 'utf8');
  } catch (e) {
    // round4 D5(blocker 修复):**读**失败与 unlink 失败同规则——只有 ENOENT 才是真
    // 「已缺席」;EACCES 等其它 errno 是读取失败,报 alreadyAbsent:true 是事实错误且
    // 静默(锁文件还在,调用方却以为没了)。非 ENOENT 写 stderr + 显式 readError。
    if (e.code === 'ENOENT') return { released: false, alreadyAbsent: true, notOwner: false };
    process.stderr.write(`[signoff-hold] 读取锁失败(${lockInfo.path}):${e.code ?? e.message}\n`);
    return { released: false, alreadyAbsent: false, notOwner: false, readError: e.code ?? String(e.message) };
  }
  let info = null;
  try { info = JSON.parse(raw); } catch { /* legacy 纯 pid 字符串格式,无法核对 token */ }
  if (!info || info.token !== lockInfo.token) {
    return { released: false, alreadyAbsent: false, notOwner: true };
  }
  try {
    unlinkSync(lockInfo.path);
    return { released: true, alreadyAbsent: false, notOwner: false };
  } catch (e) {
    // round3 #6:unlink 失败 ≠ 锁不存在。ENOENT 才是真「已缺席」;EACCES/EBUSY/EROFS 等
    // 是删除失败,报 alreadyAbsent:true 是事实错误且静默(调用方会以为锁已经没了,
    // 而它其实还在)。非 ENOENT 写 stderr + 显式 unlinkError,不让调用方误读。
    if (e.code === 'ENOENT') return { released: false, alreadyAbsent: true, notOwner: false };
    process.stderr.write(`[signoff-hold] 释放锁失败(unlink ${lockInfo.path}):${e.code ?? e.message}\n`);
    return { released: false, alreadyAbsent: false, notOwner: false, unlinkError: e.code ?? String(e.message) };
  }
}

// ── 三个生产动作抽成可单测的导出函数(SC-3):均接受可注入的 ghFn(默认真实 gh),
// 测试用 fake ghFn 记调用次数/参数,不需要真的打 GitHub API。──
export function performIssueCreate({ pr, slug, kind, author, issueTitle, issueBody, ghFn = gh }) {
  const topic = KIND_TOPICS[kind];
  const footer = `\n\n---\n关联 PR:#${pr}(作者 @${author});本 issue 由 review-pr 流程自动创建,用于先讨论该 PR 涉及的${topic},维护者确认后 PR 会恢复推进。`;
  const r = ghFn(['issue', 'create', '--repo', slug, '--title', issueTitle, '--body-file', '-'], {
    input: issueBody + footer,
    allowFail: true,
  });
  const created = (r.stdout || '').trim().split('\n').pop()?.trim() ?? '';
  if (r.ok && /^https:\/\//.test(created)) {
    return { issueUrl: created, issueCreated: true, issueError: null };
  }
  return { issueUrl: null, issueCreated: false, issueError: (r.stderr || r.stdout || '').trim().slice(0, 300) };
}

export function performStatusComment({ pr, slug, kind, issueUrl, commentBody, ghFn = gh }) {
  const rendered = commentBody.includes('{{ISSUE_URL}}')
    ? renderIssueUrl(commentBody, issueUrl)
    : `${commentBody}\n\n讨论 issue:<${issueUrl}>`;
  const r = ghFn(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
    input: `${rendered}\n\n${marker(issueUrl, kind)}`,
    allowFail: true,
  });
  if (r.ok) return { commented: true, commentError: null };
  return { commented: false, commentError: (r.stderr || '').trim().slice(0, 300) };
}

export function performLabelSync({ owner, repo, pr, label, current = [], dryRun = false, ghFn = gh }) {
  const result = syncSignoffLabel({ owner, repo, pr, want: true, label, current, ghFn, dryRun });
  const legacy = removeLegacyGateLabels({ owner, repo, pr, current, ghFn, dryRun });
  if (legacy.legacyRemoved.length) result.legacyRemoved = legacy.legacyRemoved;
  // round2 D5:legacy 清理失败与「本轮 signoff 标签是否挂上」是两件事,不 merge 进
  // result.errors/warning——否则 labelsOk(= !labels.warning)会被旧标签 403 之类的清理
  // 失败拖累,误判为"本轮标签没挂上"从而 held 被判 false,即便 signoff 标签其实已经
  // 成功挂上。清理失败单独走 legacyErrors/legacyWarning,不参与 held 判定。
  if (legacy.errors.length) {
    result.legacyErrors = legacy.errors;
    result.legacyWarning = `旧门类标签清理没完成:${legacy.errors[0]}`;
  }
  return result;
}

// ── held 判据(SC-2):issue/评论/标签三件套全成功才算真正拦住 ──
// issueOk / commentOk 要分「本轮需要新开一轮讨论(needIssue)」与「复用既有 open issue」
// 两种情况:复用时旧 issue+旧评论已经把作者引到当前有效讨论,不需要本轮重新创建/重新发
// 评论才算数;需要新开时(从未 hold 过,或旧 issue 已 CLOSED)必须本轮真正成功,不能拿
// "曾经 hold 过"这个陈旧事实顶替——否则旧 issue 被关闭后 gate 重新触发,held 会被误判
// 为 true,把作者晒在一个已关闭的讨论里却显示"已经拦住"。
// round4 D2:GitHub 侧对账 —— 万一仍发生双写(锁被绕过/抢占窗口),PR 上会留下多份
// hold issue,每份都会在重入时把作者引到不同的讨论里。对账规则:保留 number 最小
// (= 最早创建)的 issue,关闭其余 OPEN 的并留一条说明,把它引到保留的讨论。
// 不可逆动作的正确性不该只依赖本地文件锁 —— 锁是优化,这里才是保证;
// 每轮开始时执行,双写后下一轮自愈,而不是永久留两个 issue @ 作者两次。
// 只对可解析为本仓 issue 的 URL 动作;state 查询失败 / close 失败 → 记 errors
// (下一轮重试),不误关。dry-run 不调用(调用方保证)。
// round5 R5-1(blocker):对账是 O(重复数) 不是常数——每重复最坏 3 次 gh 调用
// (view + close + comment)。每轮最多处理 maxDups 个重复(上界由代码结构性强制,
// 循环根本不会处理更多),超出部分进 unprocessed(数量 + URL)报出,下一轮继续
// (自愈),而不是把整个临界区跑穿 LOCK_STALE_MS 租约(双实例重复不可逆写入)。
// ghFn 返回 budgetExhausted(临界区调用预算耗尽,见 main() 的 ghB)时同样进
// unprocessed——那是「预算内没做完」,不是「GitHub 查询失败」,不得混进 errors。
export function reconcileDuplicateHoldIssues({ slug, urls = [], ghFn = gh, maxDups = MAX_RECONCILE_DUPS }) {
  const entries = [...new Set((urls ?? []).filter(Boolean))]
    .map((url) => ({ url, number: issueNumberFromUrl(slug, url) }))
    .filter((e) => e.number != null);
  if (entries.length <= 1) return { keptUrl: entries[0]?.url ?? null, closed: [], errors: [], unprocessed: [] };
  entries.sort((a, b) => a.number - b.number);
  const kept = entries[0];
  const closed = [];
  const errors = [];
  const unprocessed = [];
  for (const dup of entries.slice(1 + maxDups)) {
    unprocessed.push({ number: dup.number, url: dup.url });
  }
  for (const dup of entries.slice(1, 1 + maxDups)) {
    const st = ghFn(['issue', 'view', String(dup.number), '--repo', slug, '--json', 'state'], { allowFail: true });
    if (st.budgetExhausted) {
      unprocessed.push({ number: dup.number, url: dup.url });
      continue;
    }
    let state = null;
    try { state = String(JSON.parse(st.stdout || '{}').state ?? '').toUpperCase(); } catch { /* 非 JSON */ }
    if (state !== 'OPEN' && state !== 'CLOSED') {
      errors.push(`duplicate-issue-${dup.number}: state 查询失败,未关闭`);
      continue;
    }
    if (state === 'OPEN') {
      const c = ghFn(['issue', 'close', String(dup.number), '--repo', slug], { allowFail: true });
      if (c.budgetExhausted) {
        unprocessed.push({ number: dup.number, url: dup.url });
        continue;
      }
      if (!c.ok) {
        errors.push(`close-failed-${dup.number}: ${(c.stderr || c.stdout || '').trim().slice(0, 200)}`);
        continue;
      }
      const cm = ghFn(['issue', 'comment', String(dup.number), '--repo', slug, '--body',
        `此 issue 是重复创建的讨论(本 PR 已有更早的讨论 issue #${kept.number}),已自动关闭。讨论请移步 #${kept.number}。`],
      { allowFail: true });
      if (cm.budgetExhausted) {
        unprocessed.push({ number: dup.number, url: dup.url });
        continue;
      }
      if (!cm.ok) errors.push(`comment-failed-${dup.number}`);
    }
    closed.push({ number: dup.number, url: dup.url });
  }
  return { keptUrl: kept.url, closed, errors, unprocessed };
}

export function computeHeld({ issueCreated, priorIssueUrl, needIssue, commented, alreadyHeld, labelsOk }) {
  const issueOk = issueCreated || (!needIssue && priorIssueUrl != null);
  const commentOk = commented || (!needIssue && alreadyHeld);
  const held = issueOk && commentOk && labelsOk;
  const heldBlockedBy = held ? [] : [
    ...(!issueOk ? ['issue'] : []),
    ...(!commentOk ? ['comment'] : []),
    ...(!labelsOk ? ['labels'] : []),
  ];
  return { held, heldBlockedBy };
}

// 只在直接被跑为 CLI 时执行主流程;被 import(如 signoff-policy.test.mjs 覆盖上面
// 导出的纯函数/生产动作)时不触发任何真实 gh/git 调用,否则测试进程会在 import 阶段
// 就被 parsePR/parseRepo 的失败路径(fail() → process.exit(1))直接杀掉。
// round2 D1:判定用 realpathSync 归一化后比较 argv[1] 与本模块自身路径,而不是裸字符串
// `===`——原写法在三种情况下会误判为"不是主模块"从而整个脚本什么都不做(fail-open,
// 门形同虚设):① 经 symlink 调用(本 skill 的调用惯例本就是 `node "<SKILL_ROOT>/..."`,
// 而 ~/.claude/skills 与 ~/.claude/skills/review-pr 都是 symlink);② 路径含空格;
// ③ 路径含中文字符——import.meta.url 会对空格/非 ASCII 字符做百分号编码,而
// process.argv[1] 是调用方传入的原始字面路径,两侧编码口径不一致,裸字符串比较必错。
// 模式抄自 context.mjs 的 IS_MAIN_MODULE(该文件同样的判定,已验证过三类场景)。
// realpath 只作用在 argv[1] 一侧:Node 在构造 import.meta.url 时本就会解析 symlink,
// 字面值已经是解析后的真实路径;fileURLToPath 把百分号编码解回原始字符,消除
// 空格/中文的编码不对称。
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (!isMainModule && process.argv[1]) {
  // round4 D4(blocker 修复):守卫误判必须 stdout 输出 JSON 错误 + 非零退出码,不能只写
  // stderr——round3 实测 `node --preserve-symlinks-main` 下 exit=0、零 gh 调用、stdout
  // 空,自动化消费方(按本脚本自声明的「stdout 输出 JSON」契约)会把空 stdout 当成
  // 「成功但无结果」,hold 动作从未执行却没人知道。区分两种情形:
  //   - 合法 import(argv[1] 是别的文件,如测试运行器):两侧 realpath 不一致,保持
  //     完全静默,这是正常形态;
  //   - 守卫误判(argv[1] 存在且与本模块解析到同一真实文件、字面比较却失配,链接/
  //     编码形态差异):stdout 输出 {ok:false, error} + process.exit(1),让失败可见。
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
      print({ ok: false, error: 'entry-guard-misclassified', message: `入口守卫判定失败但 argv[1] 与本模块指向同一文件(argv[1]=${process.argv[1]})——脚本将不执行任何动作,请改用直接路径调用(避免 --preserve-symlinks-main / symlink 形态)。` });
      process.exit(1);
    }
  } catch { /* 任一侧 realpath 失败则无从判断,不报警 */ }
}
if (isMainModule) {
try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const kindIdx = process.argv.indexOf('--kind');
  const kind = kindIdx >= 0 && KIND_TOPICS[process.argv[kindIdx + 1]] ? process.argv[kindIdx + 1] : 'product';
  const labelsOnly = process.argv.includes('--labels-only');
  const kindGiven = kindIdx >= 0 && KIND_TOPICS[process.argv[kindIdx + 1]] != null;
  const noRenotice = process.argv.includes('--no-renotice');
  const SIGNOFF_LABEL = (loadRules().signoffGate?.label ?? SIGNOFF_LABEL_DEFAULT).trim() || SIGNOFF_LABEL_DEFAULT;
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  let payload = null;
  if (payloadSrc) {
    payload = JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8'));
  }
  const issueTitle = (payload?.issueTitle ?? '').trim();
  const issueBody = (payload?.issueBody ?? '').trim();
  const commentBody = (payload?.commentBody ?? '').trim();
  const payloadComplete = issueTitle !== '' && issueBody !== '' && commentBody !== '';

  // 原子 claim(SC-1):check-then-act 全程持有本 PR 的专属文件锁,消除双实例各建
  // 一份 issue/各发一条评论的 TOCTOU 竞态。锁拿不到(另一实例持锁超时)本轮直接放弃,
  // 不做任何写操作,交下一轮重试——总比两边各写一份强。
  // round2 bug#8:dry-run 不获取锁——本行文档自称"不写任何外部状态",而获取锁本身就是
  // 写锁文件,且会跟真实执行抢锁造成饥饿;dry-run 只读,天然不需要互斥。
  const lock = dryRun ? null : acquireHoldLock(owner, repo, pr);
  if (lock && !lock.acquired) {
    // round2 D2:锁超时不再是完全静默的 {held:false, reason:'lock-timeout'} ——显式标注
    // needsIntervention,把持锁方 pid/起始时间带出去(能读到时),这是"需要人工介入排查"
    // 的信号,不是"下一轮再试就好"的常规状态。
    process.stderr.write(`[signoff-hold] 锁超时未拿到,疑似有持有者卡死或长时间占用(pid=${lock.holderPid ?? '未知'})——需要人工介入排查,而不是静默交给下一轮重试。\n`);
    print({
      ok: true, pr, held: false, reason: 'lock-timeout', needsIntervention: true,
      ...(lock.holderPid != null ? { holderPid: lock.holderPid } : {}),
      ...(lock.holderStartedAt != null ? { holderStartedAt: lock.holderStartedAt } : {}),
    });
  } else
  try {
  // round5 R5-1:临界区内所有 gh 调用走 ghB(ghT + 调用预算,见模块顶部)——带
  // GH_CALL_TIMEOUT_MS 超时,且调用数超过 CRITICAL_SECTION_MAX_CALLS 后不再发出
  // (budgetExhausted fail-visible,下一轮重试);总耗时 = 调用数 × 单次超时,由代码
  // 强制不超过租约,不再是写死的常数声称。ghJson 不支持超时选项,这里显式解析。
  const meta = JSON.parse(ghB([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,state,mergedAt,author,url,comments,labels,headRefOid',
  ]).stdout || 'null');
  const author = meta.author?.login ?? '';
  const currentLabels = (meta.labels ?? []).map((l) => l.name);
  const headSha = String(meta.headRefOid ?? '').toLowerCase();
  // 挂维护者确认标签;顺手摘掉旧主标签与旧门类子标签(迁移遗留)——委托给 performLabelSync
  // (与 computeHeld 共用同一份判定事实,SC-3 测试直接覆盖该导出函数)
  const syncLabels = () => performLabelSync({ owner, repo, pr, label: SIGNOFF_LABEL, current: currentLabels, dryRun, ghFn: ghB });
  // 标签失败不静默:顶到输出最外层(labelWarning),SKILL 要求最终报告里照抄。
  // 少了标签 → GitHub 后台与待确认面板都筛不到该 PR,门的判定不受影响。
  // round2 D5:legacyWarning(旧门类标签清理失败)单独顶成 legacyLabelWarning,不与
  // labelWarning 混在一起——两者是否成功是独立的事,legacy 清理失败不该连坐 held 判定。
  const withLabelWarning = (out) => {
    const withMain = out.labels?.warning ? { ...out, labelWarning: out.labels.warning } : out;
    return out.labels?.legacyWarning ? { ...withMain, legacyLabelWarning: out.labels.legacyWarning } : withMain;
  };
  const printOut = (out) => {
    // round5 R5-1:unprocessed(预算/上限内没做完的重复)与 closed/errors 同等重要,
    // 必须顶到输出——「主动放弃剩余工作」的可见性,调用方据此知道对账没做完。
    const withRecon = reconcile && (reconcile.closed.length || reconcile.errors.length || reconcile.unprocessed.length)
      ? { ...out, reconciliation: reconcile } : out;
    return print(withLabelWarning(withRecon));
  };

  // 找既有标记评论,读出当时开的 issue 链接。取「最后一条带 issue= 的标记」为准。
  const markerComments = (meta.comments ?? []).filter((c) => (c.body ?? '').includes(MARKER_PREFIX));
  const alreadyHeld = markerComments.length > 0;
  const markerUrls = markerComments
    .map((c) => c.body.match(/issue=(\S+?)\s*-->/)?.[1] ?? null)
    .filter(Boolean);
  // round4 D2:GitHub 侧对账(双写自愈)——标记评论里出现多个不同 hold issue 时,保留
  // 最早(number 最小)的,关闭其余并留说明;万一锁被绕过仍发生双写,下一轮开始即自愈,
  // 不会永久留两个 issue @ 作者两次。dry-run 不写外部状态,跳过对账。
  // round5 R5-1:对账每轮最多处理 MAX_RECONCILE_DUPS 个重复(超出进 unprocessed 报出,
  // 下一轮继续),ghFn 走 ghB(预算强制)——O(重复数) 的上界由代码保证。
  const reconcile = dryRun ? null : reconcileDuplicateHoldIssues({ slug, urls: markerUrls, ghFn: ghB });
  const priorIssueUrl = reconcile ? reconcile.keptUrl : (markerUrls.pop() ?? null);
  // ── 旧讨论 issue 复用/新开判定(decideIssueReuse,见 lib.mjs;signoff-policy.test.mjs 覆盖)──
  // 旧 issue 可能已被 close-product-issue.mjs --no-longer-required 收尾关闭,之后 gate
  // 再亮起来时不能把作者引到一个已关闭的讨论里 —— 视同没开过,凭 payload 新开当前讨论
  // issue(新标记评论盖过旧标记)。state 查询失败 fail-safe 复用旧链接:网络抖动不该制造
  // 重复 issue,下一轮查到 CLOSED 再开也不迟。
  let priorIssueState = null;
  let priorIssueStateError = null;
  if (priorIssueUrl != null) {
    const priorNum = issueNumberFromUrl(slug, priorIssueUrl);
    if (priorNum == null) {
      priorIssueStateError = 'issue-url-unparsable';
    } else {
      const r = ghB(['issue', 'view', String(priorNum), '--repo', slug, '--json', 'state'], { allowFail: true });
      if (r.ok) {
        try {
          const s = String(JSON.parse(r.stdout || '{}').state ?? '').toUpperCase();
          priorIssueState = s === 'OPEN' || s === 'CLOSED' ? s : null;
        } catch { priorIssueStateError = 'state-parse-failed'; }
      } else {
        priorIssueStateError = (r.stderr || r.stdout || '').trim().split('\n')[0]?.slice(0, 200) || 'unknown';
      }
    }
  }
  const reuse = decideIssueReuse({ priorIssueUrl, issueState: priorIssueState });
  const needIssue = reuse.needNewIssue;
  // 输出透出旧 issue 状态;labels-only 模式不建 issue,旧 issue 已关闭时以 needsFreshHold
  // 提示调用方带 payload 重跑完整模式。
  const priorIssueInfo = priorIssueUrl == null ? {} : {
    priorIssueState,
    issueReuse: reuse.reason,
    ...(priorIssueStateError ? { priorIssueStateError } : {}),
    ...(reuse.needNewIssue ? { priorIssueClosed: true } : {}),
  };

  // ── 状态回帖 ──
  // 触发条件(全部满足):已经 hold 过(作者收过带 issue 链接的完整说明)+ 本轮看到时标签
  // **不在**(= 门刚从放行/等作者翻回等维护者,或标签被人摘了)+ 这版 head 还没回帖过。
  // 用「看到时标签不在」而不是「加标签成功」:标签写失败(权限类)时门照旧在拦,作者更该知道。
  // headSha 拿不到时**宁可不发**:去重键为空 → 标记写成 head= 解析不回来 → 每轮都重复回帖,
  // 那比漏一条更糟。这种情况在输出里如实写 no-head-sha。
  const labelWasAbsent = !currentLabels.includes(SIGNOFF_LABEL);
  const noticedHeads = parseSignoffRenotices(meta.comments ?? []);
  const renoticeDone = noticedHeads.has(headSha);
  // 回帖里的讨论链接用 reuse.reuseUrl:旧 issue 已关闭时不回帖 —— 不能把作者引进一个
  // 已关闭的讨论;完整模式新开 issue 时那条带标记的评论本身就是完整通知,不需要回帖叠加。
  const renoticeIssueUrl = reuse.reuseUrl;
  const renoticeWanted = !noRenotice && renoticeIssueUrl != null && labelWasAbsent && !renoticeDone && headSha !== '';
  // 文案固定模板。三条纪律:
  //   ① kind 没传就不硬说是哪一类 —— 默认值 product 在 --labels-only 时是猜的,猜错比不说更糟;
  //   ② 不写「你刚推了新代码」这类断言 —— 本分支也会在「首次 hold 时标签写失败、下一轮补挂」
  //      时走到,那时作者并没有推东西,说了就是错话;
  //   ③ 不写「不用你再管了」—— 门在拦的同时可能还有 review 意见 / CI 要作者修。
  const renoticeBody = () => {
    const scope = kindGiven ? `维护者确认门(${KIND_TOPICS[kind]})` : '维护者确认门';
    const hail = author ? `@${author} 👋 ` : '';
    return [
      `${hail}**这个 PR 现在在等维护者确认**,确认之前流程不会合并它 —— 不是卡住了,也不是在等你再改一版(你推的改动流程都读到了,判的就是最新一版代码)。`,
      '',
      `- 在拦的是:${scope}。`,
      `- 讨论 issue:<${renoticeIssueUrl}>`,
      '- 通过方式只有一个:维护者在本 PR 上 **Approve**。维护者觉得要改会直接 **Request Changes**,那时候球才回到你手里。',
      '- 这期间如果还有 review 意见没处理完、CI 没过,照常修就行,不影响这条等待。',
      '',
      '这条是流程自动发的状态提醒(同一版代码只发一次),不用回复。',
    ].join('\n');
  };
  const doRenotice = () => {
    if (!renoticeWanted) {
      return {
        renoticed: false,
        renoticeSkipped: noRenotice ? 'disabled'
          : priorIssueUrl == null ? 'never-held'
            : renoticeIssueUrl == null ? 'prior-issue-closed'
              : !labelWasAbsent ? 'label-already-on'
                : renoticeDone ? 'already-noticed-for-head'
                  : headSha === '' ? 'no-head-sha' : 'unknown',
      };
    }
    if (dryRun) return { renoticed: false, wouldRenotice: true };
    const r = ghB(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
      input: `${renoticeBody()}\n\n${SIGNOFF_RENOTICE_MARKER_PREFIX} head=${headSha} -->`,
      allowFail: true,
    });
    // 回帖失败不连坐标签、也不改变门的判定:头一行报错顶到输出里,下一轮凭「无 head 标记」自动重试。
    return r.ok
      ? { renoticed: true, renoticeHead: headSha }
      : { renoticed: false, renoticeError: (r.stderr || r.stdout || '').trim().split('\n')[0]?.slice(0, 200) ?? 'unknown' };
  };

  // 已合并 / 已关闭的 PR 不碰
  if (meta.state !== 'OPEN' || meta.mergedAt) {
    print({ ok: true, pr, author, held: false, reason: 'pr-not-open', state: meta.state });
  } else if (labelsOnly) {
    // 标签先挂回去,再回帖:回帖里说的「在等维护者确认」要和 GitHub 上的标签状态一致。
    // 旧 issue 已关闭 → needsFreshHold=true:labels-only 建不了 issue,调用方带 payload
    // 重跑完整模式新开当前讨论 issue。
    printOut({
      ok: true, pr, author, labelsOnly: true, alreadyHeld, ...priorIssueInfo,
      ...(priorIssueUrl != null && reuse.needNewIssue ? { needsFreshHold: true } : {}),
      labels: syncLabels(), ...doRenotice(),
    });
  } else {
    if (dryRun) {
      printOut({
        ok: true, pr, author, dryRun: true,
        alreadyHeld, priorIssueUrl, ...priorIssueInfo,
        wouldCreateIssue: needIssue && payloadComplete,
        wouldComment: needIssue && payloadComplete,
        missingPayload: needIssue && !payloadComplete,
        labels: syncLabels(),
        ...doRenotice(),
      });
    } else if (needIssue && !payloadComplete) {
      // 开 issue / 发评论必须有完整文案——光打标签会让作者一头雾水。标签照打:判定已经是
      // 「维护者确认门在拦」,GitHub 后台就该能筛到它。遇到本 reason 补 payload 重试,别排查脚本。
      printOut({
        ok: true, pr, author, held: false, reason: 'missing-payload', alreadyHeld, ...priorIssueInfo,
        labels: syncLabels(),
      });
    } else {
      // 1) 开讨论 issue(没有可复用 issue 时;失败则本轮不发评论,下轮自动重试)——委托给
      // performIssueCreate(SC-3 测试直接覆盖该导出函数)
      let issueUrl = reuse.reuseUrl;
      let issueCreated = false;
      let issueError = null;
      if (needIssue) {
        const r = performIssueCreate({ pr, slug, kind, author, issueTitle, issueBody, ghFn: ghB });
        if (r.issueCreated) {
          issueUrl = r.issueUrl;
          issueCreated = true;
        } else {
          issueError = r.issueError;
        }
      }

      // 2) 发评论(带隐藏标记;仅在本轮新开了 issue 时——评论的核心就是给 issue 链接)——
      // 委托给 performStatusComment(SC-3 测试直接覆盖该导出函数)
      let commented = false;
      let commentError = null;
      if (issueCreated && issueUrl) {
        const r = performStatusComment({ pr, slug, kind, issueUrl, commentBody, ghFn: ghB });
        commented = r.commented;
        commentError = r.commentError;
      }

      // 3) 维护者确认标签(与 issue/评论共同构成 held 判据,见下——三件套全成功才算 held,
      // 不再是「失败不连坐」:标签 POST 失败时 held 必须为 false,并在 heldBlockedBy 里点名)
      const labels = syncLabels();

      // 4) 状态回帖(只在「早就 hold 过、这轮门重新亮起来」时;本轮首次 hold 已经有 2) 的评论)
      const renotice = doRenotice();

      // held 判据(SC-2):issue 建成(或有效复用)&& 评论发出 && 标签同步成功,三件套全成功
      // 才算 held——委托给 computeHeld(纯函数,SC-3 测试直接覆盖)。任一项失败时
      // heldBlockedBy 点名具体失败项,不再只挂 labelWarning 一个侧信道。
      const { held, heldBlockedBy } = computeHeld({
        issueCreated, priorIssueUrl, needIssue, commented, alreadyHeld,
        labelsOk: !labels.warning,
      });
      printOut({
        ok: true, pr, author, kind, held, ...(held ? {} : { heldBlockedBy }), ...priorIssueInfo,
        issueUrl, issueCreated, issueError,
        commented, alreadyHeld, commentError,
        labels,
        ...renotice,
        url: meta.url,
      });
    }
  }
  } finally {
    if (lock) {
      const rel = releaseHoldLock(lock);
      if (rel.notOwner) {
        // round2 D3:token 不匹配 = 本实例的锁已被判定陈旧后由另一实例抢占重建,当前实例
        // 不再是持有者——跳过 unlink,避免误删新持有者的锁(误删的后果是双实例同跑)。
        process.stderr.write('[signoff-hold] 释放锁时发现 token 不匹配(锁已被判定陈旧后被其他实例抢占重建)——本实例不是当前持有者,已跳过 unlink,避免误删新持有者的锁。\n');
      }
    }
  }
} catch (e) {
  fail(e);
}
}
