// convergence-state.mjs — per-PR「审查收敛状态」单一权威(SC-C2 同族复发判定 +
// SC-C3 收敛止损)。
//
// 为什么不是 review-receipt / runs.jsonl(设计红线,gpt 已否决过把它们挪用为权威):
//   - review-receipt(lib.mjs 的 writeReviewReceipt/readReviewReceipt)是
//     「当前 head 是否清白」的 last-write-wins 凭证,每个 PR 只保留最新一条,天然
//     不记历史——它的职责范围就是单点判断,不是跨轮台账,语义不能也不该被本模块
//     借用或改动。
//   - runs.jsonl(run-log.mjs)是全仓库共享的一条按轮追加审计日志,坏行只告警跳过
//     (F5/F6),不为单个 PR 保证任何完整性或可核验性,是"尽量记录"级别的日志,不是
//     "必须准确"级别的权威状态。
//   本模块是两者之外**新增**的第三份状态:每个 PR 一个独立文件,记录家族(family)
//   跨 head 的出现历史与止损计数,供 SC-C2/SC-C3 消费。
//
// D1(安全红线,不可放宽):复发的 finding 仍是 P0/P1、仍计入调用方自己统计的
// p0p1Count、仍应使该轮 review-receipt 判 dirty、仍阻断合并——本模块只从
// `newFamilyCount`(收敛指标)里排除复发,不touches、不影响 isReviewReceiptClean
// 或任何合并判定路径。调用方必须继续按原有口径统计 p0p1Count 并各自调用
// write-review-receipt.mjs;两者互不覆盖、互不替代。
//
// D3(机器 vs 语义判断的边界):"这条 finding 和上一轮某条是不是同一个家族" 是
// 语义判断(T1,交给审查 agent/主 agent 做),本模块**不做**语义匹配。本模块只做
// 机械核验:调用方声称的 `recurrenceOfSlug` 指向的 slug、以及该 slug 下早于当前
// head 的历史 occurrence,是否真实存在于 state 里。核验不过直接 throw——不接受
// "反正你说是复发我就信了"这种口径,也不会静默把无法验证的引用当新家族处理
// (那等于放过一次本该报错的调用方错误)。跨轮 join key 本身是 slug 不是
// family_id,见下方「跨轮 join key」一节——这是 2026-08-02 的纠正,本节的机器/
// 语义边界原则不变,只是被核验的引用换了字段名。
//
// D4(轮次口径):roundCount = 实际记录过的、按 headRefOid 去重的轮数,不是调用
// 次数、不是 push 次数、不是 cron 轮次。同一 head 被再次调用(如同一 commit 重跑
// 审查纠错)会覆盖该 head 名下的记录,不新增一轮。
//
// 损坏处置(D2 展开):state 文件存在但解析/结构校验不过时,绝不静默清零重来——
// 那等于悄悄丢掉"这个 PR 已经反复未收敛"这一信号,让止损计数器不知不觉重新从 0
// 起跑。做法:①隔离(rename)坏文件为 `<file>.corrupted-<时间戳>-<pid>.json`,保留
// 取证材料;②重建一份全新 state,但显式标记 `integrity.status =
// 'recovered-from-corruption'`;③既然我们已经不知道真实轮次,保守处置 = 直接把
// 本轮的连续计数强制推到收敛检查点阈值,宁可多触发一次检查点,也不当作"什么都
// 没发生过"。这条路径必须走显式告警(`integrityWarning` 非空字符串),供调用方原样
// 转达进 review 正文,不能吞掉。
//
// 通知层的两层拆分(SC-C4 调查带出的要求,2026-08-02):SC-C4 结论是 review-pr
// 不存在中间态重审放大、不需要 debounce,但顺带查出一个真缺口——非 required 的
// 第三方 bot(如 Greptile)长期缺席时,PR 会无限期挂在 skip-gate/threads-
// unresolved,没有"等待方缺席"的升级机制(本轮不做,留给另一次改动)。为了不让
// 那次改动需要重构本模块的通知投递管线,通知机制在设计上就拆成两层,不允许合并:
//   - **触发判定**(可插拔,本模块目前只实现一种):`recordConvergenceRound` 算出
//     `consecutiveRoundsWithNewFamilies` 达到 `CONVERGENCE_NOTIFY_THRESHOLD` 时
//     产出一条通知——这是"round/new-family"触发源专属的判断逻辑,未来的"等待方
//     缺席 N 轮"触发源会是另一段完全独立的判断代码(很可能不在本文件、甚至不来自
//     审查轮次),不复用这段逻辑。
//   - **通知投递 + 去重**(`hasNotified`/`markNotified`,与触发源无关):入参与
//     去重键都不能只认"round 触发"这一种形状——通知载荷用
//     `{reason, prNumber, head, thresholdKey, detail}`,`detail` 是随 reason 变化
//     的自由字段;去重键是 `reason` + `thresholdKey` + `headRefOid` 三元组
//     (state.notifiedThresholds 按 `{[reason]:{[thresholdKey]:headRefOid[]}}`
//     存储),`reason` 进键是为了让"缺席触发"将来落地时,不会被"round 触发"已经
//     发过的去重记录误吞、也不会反过来污染 round 触发自己的去重状态。
// 本轮只落地 `CONVERGENCE_NOTIFY_REASON_ROUND` 这一个 reason;新增缺席触发时只
// 需要新写一段触发判定 + 一个新 reason 常量,调用同一套 hasNotified/markNotified,
// 不需要改动这两个函数或 state 结构。
//
// 跨轮 join key = 不变量 slug,不是 family_id(lead 2026-08-02 纠正,rp-output 的
// 输出契约调查发现的事实):`family_id` 只在单份审查报告内唯一,审查 agent 每轮
// 独立生成报告,第 2 轮的 family_id 与第 1 轮的没有任何对应关系,拿它做跨轮比对
// 必然失效。真正的跨轮身份是"由 family 的一句话不变量文本做确定性归一化"得到的
// slug——同一不变量在不同轮次、哪怕换个说法描述,归一化后应该(在一级检测里)落到
// 同一个 slug。归一化函数**必须单一实现**,不能本模块自己另写一份(两份归一化只要
// 有一个字符差异,跨轮就永久对不上,且这种 bug 不报错、只静默漏判复发)。
//
// 归一化实现:直接 import rp-output 的 `lib.review-output-shape.mjs` 导出的
// `invariantSlug`,不在本文件另写一份(两份归一化只要差一个字符,跨轮就永久对
// 不上,且这种 bug 不报错、只静默漏判复发——该文件头部注释同样这么写)。该文件
// 目前是从 `conv/output-contract`@`98503eb` 逐字节复制过来的**只读依赖**,不是
// 本模块的代码,不应在这里被修改——它的实现、算法调整由 rp-output 侧负责,合并
// 时以对方分支的版本为准(冲突应体现为"引用它"而不是"改它")。
//
// 两级检测(定案 3):
//   一级(确定性):对本轮 finding 的 invariant 原文算 slug,命中 state 里已有的
//     historicalSlug → 直接判定复发,机器可断言,不需要调用方声明。
//   二级(T1 兜底):slug 未命中时,调用方(审查 agent/主 agent)可能仍判断这是同一
//     家族换了个说法——显式传 `recurrenceOfSlug: <历史 slug>`;本模块只核验该
//     slug 在 state 里确有早于当前 head 的记录,不做语义判断(同 D3 原则,只是
//     join key 从 family_id 换成了 slug)。
//   两级都未命中 → 当新 family 处理(宁可多报一条新 family,不静默吞掉复发)。
// 每条 occurrence 记 `matchedBy: 'slug' | 'semantic' | null`(null = 该 family
// 的第一条 occurrence,没有"匹配"这件事)供将来统计二级命中率、判断归一化要不要
// 加强。

import { readFileSync, existsSync, renameSync } from 'node:fs';
import { stateFile, writeJsonAtomic } from './lib.mjs';
import { invariantSlug } from './lib.review-output-shape.mjs';

export const CONVERGENCE_CHECKPOINT_THRESHOLD = 5;
export const CONVERGENCE_NOTIFY_THRESHOLD = 10;

/** SC-C3「新 P0/P1 family 数连续达标」这一种触发源的 reason 标识——通知投递层
 * (hasNotified/markNotified)按 reason 分域去重,与其它触发源(如未来的"等待方
 * 缺席")互不干扰。 */
export const CONVERGENCE_NOTIFY_REASON_ROUND = 'round-nonconvergence';

const SEVERITIES = new Set(['P0', 'P1']);
const STATE_VERSION = 2; // v1→v2:跨轮 join key 从 family_id 换成 slug,顶层 families 键随之改变含义,老版本文件按 corrupted 处理(见 validateShape)。

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 定位某 PR 的收敛状态文件路径(与 reviewReceiptFile 同款防御性校验)。 */
function convergenceStateFile(pr) {
  const n = Number(pr);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`收敛状态文件路径要求 pr 是非负整数,收到:${JSON.stringify(pr)}`);
  }
  return stateFile(`convergence-${n}.json`);
}

/**
 * 只读结构校验(与 run-log.mjs 的 validateShape 同一思路:任何形态不对都判
 * false,交给调用方决定是"missing 首轮"还是"corrupted 需要隔离重建",本函数
 * 自己不抛错、不修改传入对象)。
 */
function isValidHeadRecord(h) {
  return (
    isPlainObject(h)
    && typeof h.headRefOid === 'string' && h.headRefOid !== ''
    && Number.isInteger(h.p0p1Count) && h.p0p1Count >= 0
    && Number.isInteger(h.newFamilyCount) && h.newFamilyCount >= 0
    && Number.isInteger(h.consecutiveRoundsWithNewFamilies) && h.consecutiveRoundsWithNewFamilies >= 0
  );
}

const MATCHED_BY_VALUES = new Set(['slug', 'semantic', 'same-round', null]);

function isValidOccurrence(o) {
  return (
    isPlainObject(o)
    && typeof o.headRefOid === 'string' && o.headRefOid !== ''
    && SEVERITIES.has(o.severity)
    && (o.familyId === null || typeof o.familyId === 'string')
    && MATCHED_BY_VALUES.has(o.matchedBy)
  );
}

function isValidFamily(fam) {
  return (
    isPlainObject(fam)
    && typeof fam.invariant === 'string' && fam.invariant !== ''
    && typeof fam.firstSeenHead === 'string' && fam.firstSeenHead !== ''
    && Array.isArray(fam.occurrences) && fam.occurrences.length > 0
    && fam.occurrences.every(isValidOccurrence)
  );
}

/** `notifiedThresholds` 按 `{[reason]:{[thresholdKey]:headRefOid[]}}` 两层嵌套——
 * reason 是触发源标识,thresholdKey 是该触发源内部的判定档位(round 触发源目前
 * 只用 `String(CONVERGENCE_NOTIFY_THRESHOLD)` 这一档)。 */
function isValidNotifiedThresholds(v) {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every((byThreshold) => (
    isPlainObject(byThreshold)
    && Object.values(byThreshold).every((list) => Array.isArray(list) && list.every((h) => typeof h === 'string'))
  ));
}

function validateShape(state) {
  if (!isPlainObject(state)) return false;
  if (state.version !== STATE_VERSION) return false;
  if (!Array.isArray(state.heads) || !state.heads.every(isValidHeadRecord)) return false;
  if (!isPlainObject(state.families) || !Object.values(state.families).every(isValidFamily)) return false;
  if (!isValidNotifiedThresholds(state.notifiedThresholds)) return false;
  if (state.seed !== null && !(isPlainObject(state.seed) && Number.isInteger(state.seed.seedRoundCount))) return false;
  if (!isPlainObject(state.integrity) || typeof state.integrity.status !== 'string') return false;
  return true;
}

/**
 * 读取某 PR 的收敛状态。三态返回(不是布尔 ok/fail):
 *   - `missing`:文件不存在 —— 真首轮,与 run-log.mjs 的 first-run 同一含义;
 *   - `corrupted`:文件存在但读取/解析/结构校验任一步不过 —— 历史不可信,调用方
 *     (`recordConvergenceRound`)据此走隔离重建路径,绝不能当 missing 处理(那会
 *     悄悄丢掉"已损坏"这个信号本身);
 *   - `ok`:结构校验通过,可安全使用。
 * 本函数纯读,不做任何隔离/重建动作(隔离动作有副作用,只应发生在明确要写入新一轮
 * 记录时,读取阶段不能有旁路副作用)。
 */
export function readConvergenceState(pr) {
  const file = convergenceStateFile(pr);
  if (!existsSync(file)) return { status: 'missing', state: null, file, error: null };
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    return { status: 'corrupted', state: null, file, error: `读取失败: ${e.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { status: 'corrupted', state: null, file, error: `JSON 解析失败: ${e.message}` };
  }
  if (!validateShape(parsed)) {
    return { status: 'corrupted', state: null, file, error: '结构校验未通过(字段缺失、类型不符或版本不识别)' };
  }
  return { status: 'ok', state: parsed, file, error: null };
}

function freshState(pr) {
  return {
    version: STATE_VERSION,
    pr: Number(pr),
    createdAt: new Date().toISOString(),
    seed: null,
    integrity: { status: 'ok' },
    heads: [],
    families: {},
    notifiedThresholds: {},
  };
}

/**
 * 隔离损坏文件(rename,不是删除——取证材料留着供人工核查)。rename 本身失败
 * (极少见,如权限问题)时返回 null,调用方仍继续重建新状态,只是取证材料没能保留,
 * 这一情形会被 integrityWarning 的文案一并提及,不静默吞掉。
 */
function quarantineCorrupted(file) {
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.corrupted-${suffix}-${process.pid}.json`;
  try {
    renameSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * 纯函数:统计 GitHub GraphQL `reviews.nodes` 里 `CHANGES_REQUESTED` 的数量,供
 * D4「老 PR 首次接入用保守 seed 规则」使用——调用方(CLI 或 SKILL 流程)在这个
 * PR 第一次被本模块记录之前,若已通过 `gh`/GraphQL 取到该 PR 的历史 review 列表,
 * 可把结果传给本函数得到一个诚实的 seed 值,再经 `recordConvergenceRound` 的
 * `seedRoundCount` 参数落地。非数组输入(未取到数据/查询失败)一律返回 0——不是
 * "假装没有历史",而是"没有证据时不编造历史",与凭空猜高同样不可取;调用方应把
 * "为什么是 0"(真的没有,还是查询失败)通过自己的日志/字段区分,本函数不越权
 * 猜测数据缺失的原因。
 */
export function computeConservativeSeedRounds(reviews) {
  if (!Array.isArray(reviews)) return 0;
  return reviews.filter((r) => r && r.state === 'CHANGES_REQUESTED').length;
}

/**
 * 记录一轮独立审查的收敛结果(SC-C2 + SC-C3 的唯一写入口)。
 *
 * @param {number} pr
 * @param {string} headRefOid 本轮审查针对的 head commit —— 必须非空。
 * @param {Array<{invariant:string, severity:'P0'|'P1', description?:string,
 *   familyId?:string, recurrenceOfSlug?:string}>} findings
 *   本轮**存活**的 P0/P1 findings(调用方已完成 4.1 严重度分类与主 agent 复核之后
 *   的最终清单;P2 不传入,不参与收敛统计)。空数组 = 本轮 0 P0/P1(收敛信号)。
 *   - `familyId`:该 finding 在**本轮**审查报告里的 family_id(仅供回溯该轮报告,
 *     不跨轮、不参与任何匹配逻辑——见文件头注释「跨轮 join key」),可省略。
 *   - `recurrenceOfSlug`:调用方(审查 agent/主 agent 的 T1 语义判断)认定这条
 *     finding 与某个既有 slug 同源(二级检测,用于一级 slug 自动匹配未命中但
 *     语义上仍是同一不变量换了说法的场景)。本函数只核验该 slug 在 state 里确有
 *     早于当前 head 的历史记录,不做语义判断——核验不过直接 throw。省略时只走
 *     一级(对 `invariant` 算出的 slug 自动比对 state 历史)。
 * @param {number} [seedRoundCount] 仅在该 PR 第一次被记录(state 从 missing 起建)
 *   时生效,忽略于后续调用(D4「保守 seed」只在起点生效一次,不应每轮重复叠加)。
 * @returns {{pr:number, headRefOid:string, roundCount:number, p0p1Count:number,
 *   newFamilyCount:number, consecutiveRoundsWithNewFamilies:number,
 *   recurringFamilies:Array<{slug:string, familyId:string|null, invariant:string,
 *   priorHead:string, priorDescription:string|null, matchedBy:'slug'|'semantic'}>,
 *   checkpointRequired:boolean, notification:{reason:string, prNumber:number,
 *   head:string, thresholdKey:string, detail:object}|null,
 *   integrityWarning:string|null}}
 *   `notification` 非 null 时代表本轮触发源(round/new-family)判定需要发一次
 *   升级通知且尚未对当前 head 发过——按文件头注释「通知层的两层拆分」,这是
 *   round 触发源自己的判定结果,不代表通知已经发出;调用方发出后必须调
 *   `markNotified` 回写去重,否则下一轮同 head 重放会再次判需要通知。
 */
export function recordConvergenceRound({ pr, headRefOid, findings, seedRoundCount } = {}) {
  if (!headRefOid || typeof headRefOid !== 'string') {
    throw new Error('headRefOid 不能为空(本轮审查必须绑定到具体的 head commit)');
  }
  if (!Array.isArray(findings)) {
    throw new Error('findings 必须是数组(可为空数组,代表本轮 0 P0/P1)');
  }
  for (const f of findings) {
    // 去空白后为空(纯空白字符串)同样拒绝——不能靠上层的裸 `=== ''` 判断放过,
    // `invariantSlug` 对这类输入会 throw TypeError,那个报错点在匹配循环内部,
    // 不如在这里统一、提前给出更清晰的报错。
    if (!isPlainObject(f) || typeof f.invariant !== 'string' || f.invariant.trim() === '') {
      throw new Error(`finding 缺少非空的 invariant 字段: ${JSON.stringify(f)}`);
    }
    if (!SEVERITIES.has(f.severity)) {
      throw new Error(`finding.severity 必须是 'P0' 或 'P1',收到: ${JSON.stringify(f?.severity)}`);
    }
    if (f.familyId !== undefined && (typeof f.familyId !== 'string' || f.familyId === '')) {
      throw new Error(`familyId 若提供必须是非空字符串,收到: ${JSON.stringify(f.familyId)}`);
    }
    if (f.recurrenceOfSlug !== undefined && (typeof f.recurrenceOfSlug !== 'string' || f.recurrenceOfSlug === '')) {
      throw new Error(`recurrenceOfSlug 必须是非空字符串 slug,收到: ${JSON.stringify(f.recurrenceOfSlug)}`);
    }
  }

  const { status, state: loaded, file, error } = readConvergenceState(pr);
  let state;
  let integrityWarning = null;
  let forceCheckpoint = false;

  if (status === 'ok') {
    state = loaded;
  } else if (status === 'missing') {
    state = freshState(pr);
    if (Number.isInteger(seedRoundCount) && seedRoundCount > 0) {
      state.seed = { seedRoundCount, seededAt: new Date().toISOString() };
    }
  } else {
    // corrupted —— 隔离旧文件,不静默清零重来:见文件头注释「损坏处置」。
    const quarantinedFile = quarantineCorrupted(file);
    state = freshState(pr);
    state.integrity = {
      status: 'recovered-from-corruption',
      quarantinedFile,
      quarantinedAt: new Date().toISOString(),
      detail: error,
    };
    integrityWarning = '收敛状态文件损坏('
      + error
      + (quarantinedFile ? `),已隔离旧文件至 ${quarantinedFile} 并重建。` : '),隔离旧文件失败,已直接重建。')
      + '历史轮次记录不可信,本轮起强制触发收敛检查点,请人工核查该 PR 是否已经历多轮未收敛。';
    forceCheckpoint = true;
  }

  const existingIdx = state.heads.findIndex((h) => h.headRefOid === headRefOid);
  const isNewHead = existingIdx === -1;

  // 覆盖同一 head 的重跑:先摘除该 head 名下的旧 occurrence,避免同一 head 的
  // 新旧两次记录被同时计入同一家族(D4:同 head 重跑不是新轮次,旧记录整体让位)。
  if (!isNewHead) {
    for (const fam of Object.values(state.families)) {
      fam.occurrences = fam.occurrences.filter((o) => o.headRefOid !== headRefOid);
    }
    // 摘除后可能出现"这个家族只在这个 head 出现过一次,现在被摘空了"——空家族
    // 不是合法状态(validateShape 要求 occurrences.length>0),直接连家族一起删,
    // 等价于"这个家族从未真的被记录过"。
    for (const [fid, fam] of Object.entries(state.families)) {
      if (fam.occurrences.length === 0) delete state.families[fid];
    }
  }

  const recurringFamilies = [];
  let newFamilyCount = 0;
  const recordedAt = new Date().toISOString();

  for (const f of findings) {
    const autoSlug = invariantSlug(f.invariant);
    // 目标 slug:二级显式声明优先,否则用一级自动算出的 slug——两条路径最终都
    // 落到"往 state.families[targetSlug] 追加一条 occurrence"这一件事上,分支
    // 只是决定 targetSlug 是什么、以及 matchedBy 怎么记。
    const targetSlug = f.recurrenceOfSlug || autoSlug;
    const fam = state.families[targetSlug];
    // "早于当前 head 的历史"排除当前 head 自己的 occurrence——本轮同一 head 下
    // 若已有另一条 finding 刚创建/命中了同一个 slug,不能把它当"跨轮历史"用
    // (那不是复发,是同一轮内两条 finding 撞了同一个 slug;见文件头注释)。
    const priorOccurrences = fam ? fam.occurrences.filter((o) => o.headRefOid !== headRefOid) : [];

    if (f.recurrenceOfSlug) {
      // D3:机器只核验"引用的历史是否真实存在",不做语义匹配——语义判断已经由
      // 调用方(T1,二级检测)做完,这里只管"你说的那段历史,在 state 里真的有吗"。
      if (priorOccurrences.length === 0) {
        throw new Error(
          `recurrenceOfSlug=${f.recurrenceOfSlug} 引用的历史在 state 中不存在(或没有早于当前 head 的`
          + '记录)——不能凭空声称复发,请改用新家族(省略 recurrenceOfSlug)或核对 slug 是否正确',
        );
      }
      const priorOccurrence = priorOccurrences[priorOccurrences.length - 1];
      // 显式引用的 slug 恰好等于本轮 invariant 自动算出的 slug 时,其实一级
      // 确定性匹配本就该命中——按更简单、更可解释的一级记录,不因为调用方多此
      // 一举传了 recurrenceOfSlug 就升级成"语义"命中(matchedBy 是给未来统计
      // 二级命中率用的,虚报会稀释这个信号的可信度)。
      const matchedBy = f.recurrenceOfSlug === autoSlug ? 'slug' : 'semantic';
      fam.occurrences.push({
        headRefOid, recordedAt, severity: f.severity, description: f.description ?? null,
        familyId: f.familyId ?? null, matchedBy,
      });
      recurringFamilies.push({
        slug: f.recurrenceOfSlug,
        familyId: f.familyId ?? null,
        invariant: fam.invariant,
        priorHead: priorOccurrence.headRefOid,
        priorDescription: priorOccurrence.description ?? null,
        matchedBy,
      });
    } else if (priorOccurrences.length > 0) {
      // 一级(确定性):本轮 invariant 归一化后的 slug 命中了 state 里早于当前
      // head 的历史 —— 不需要调用方声明,机器自己就能断言这是复发。
      const priorOccurrence = priorOccurrences[priorOccurrences.length - 1];
      fam.occurrences.push({
        headRefOid, recordedAt, severity: f.severity, description: f.description ?? null,
        familyId: f.familyId ?? null, matchedBy: 'slug',
      });
      recurringFamilies.push({
        slug: targetSlug,
        familyId: f.familyId ?? null,
        invariant: fam.invariant,
        priorHead: priorOccurrence.headRefOid,
        priorDescription: priorOccurrence.description ?? null,
        matchedBy: 'slug',
      });
    } else if (fam) {
      // 两级都没有可验证的"跨轮"历史,但这个 slug 在**本轮**已经被另一条 finding
      // 创建/命中过——同一轮内的 slug 撞车,不是真正的跨轮复发,也不是"新"
      // family(这个 slug 本轮已经算过一次新家族了),两头都不计,只补一条
      // occurrence 保持该家族记录完整。
      fam.occurrences.push({
        headRefOid, recordedAt, severity: f.severity, description: f.description ?? null,
        familyId: f.familyId ?? null, matchedBy: 'same-round',
      });
    } else {
      // 两级都未命中,且这个 slug 本轮也是第一次出现 —— 当新 family。
      state.families[targetSlug] = {
        invariant: f.invariant,
        firstSeenHead: headRefOid,
        occurrences: [{
          headRefOid, recordedAt, severity: f.severity, description: f.description ?? null,
          familyId: f.familyId ?? null, matchedBy: null,
        }],
      };
      newFamilyCount += 1;
    }
  }

  const p0p1Count = findings.length;
  // 连续计数从"这个 head 之前那一条"续接——覆盖场景下"之前那一条"是
  // heads[existingIdx-1](不能用即将被本轮替换掉的自己);新 head 场景下就是
  // 数组末尾那一条(若存在)。真正的第一条 head(此刻 state.heads 仍为空)如果
  // 带着 D4 的保守 seed,续接点不能是 0——0 等价于"当作全新 PR",会让老 PR 白白
  // 再多等 seedRoundCount 轮才追上真实进度,与"保守"的意图相反;此时续接点改用
  // seedRoundCount 本身(种子只代表"已知的历史轮次数",不预设这些历史轮次本身
  // 是否都带新问题,所以只做续接基数,不直接当"已经连续 N 轮"处理)。
  const priorForStreak = isNewHead ? state.heads[state.heads.length - 1] : state.heads[existingIdx - 1];
  const seedFloor = (isNewHead && state.heads.length === 0 && state.seed) ? state.seed.seedRoundCount : 0;
  let consecutiveRoundsWithNewFamilies = newFamilyCount > 0
    ? (priorForStreak?.consecutiveRoundsWithNewFamilies ?? seedFloor) + 1
    : 0;
  if (forceCheckpoint) {
    consecutiveRoundsWithNewFamilies = Math.max(consecutiveRoundsWithNewFamilies, CONVERGENCE_CHECKPOINT_THRESHOLD);
  }

  const headRecord = { headRefOid, recordedAt, p0p1Count, newFamilyCount, consecutiveRoundsWithNewFamilies };
  if (isNewHead) {
    state.heads.push(headRecord);
  } else {
    state.heads[existingIdx] = headRecord;
  }

  writeJsonAtomic(file, state);

  // 故意不去重(与下面 notification 的去重层刻意不同——lead 2026-08-02 定案,
  // 理由比"这是两件不同的事"更硬):给一个门做去重,等于把它变成 fail-open。
  // `checkpointRequired` 是闸门语义——"下一个修复 commit 之前必须先产出六件套";
  // 若给它加去重,第二轮就会读到"这个 head 已经要求过一次了"从而判定本轮可以
  // 跳过,门被自己关掉。`notification` 是对外投递,同一 head 重复发是真的刷屏,
  // 去重是对的——两者去重与否的差异不是随意的,是各自语义决定的。因此
  // `checkpointRequired` 必须每轮重新算、条件仍成立就仍然拦,永不查/写任何去重
  // 记录。
  const checkpointRequired = consecutiveRoundsWithNewFamilies >= CONVERGENCE_CHECKPOINT_THRESHOLD;

  // round 触发源自己的判定(见文件头注释「通知层的两层拆分」):是否达标 + 是否
  // 已经对这个 head 发过——两个条件都满足才产出通知载荷,否则 null(不是"不需要
  // 通知"和"已经发过"混在一个布尔里,调用方拿到 null 不需要关心是哪种原因)。
  const roundThresholdKey = String(CONVERGENCE_NOTIFY_THRESHOLD);
  const alreadyNotifiedThisHead = (
    state.notifiedThresholds[CONVERGENCE_NOTIFY_REASON_ROUND]?.[roundThresholdKey] ?? []
  ).includes(headRefOid);
  const notification = (consecutiveRoundsWithNewFamilies >= CONVERGENCE_NOTIFY_THRESHOLD && !alreadyNotifiedThisHead)
    ? {
      reason: CONVERGENCE_NOTIFY_REASON_ROUND,
      prNumber: Number(pr),
      head: headRefOid,
      thresholdKey: roundThresholdKey,
      detail: { consecutiveRoundsWithNewFamilies, recurringFamilies },
    }
    : null;

  return {
    pr: Number(pr),
    headRefOid,
    roundCount: state.heads.length,
    p0p1Count,
    newFamilyCount,
    consecutiveRoundsWithNewFamilies,
    recurringFamilies,
    checkpointRequired,
    notification,
    integrityWarning,
  };
}

/**
 * 通知投递层的去重读(纯读,与触发源无关——见文件头注释「通知层的两层拆分」)。
 * `reason` 必填:去重键是 `reason`+`thresholdKey`+`headRefOid` 三元组,不同触发源
 * (如未来的"等待方缺席")即使 `thresholdKey` 恰好撞了同一个字符串也不会互相误吞。
 */
export function hasNotified({ pr, reason, thresholdKey, headRefOid }) {
  if (!reason || typeof reason !== 'string') throw new Error('reason 不能为空');
  const { state } = readConvergenceState(pr);
  const list = state?.notifiedThresholds?.[reason]?.[String(thresholdKey)] ?? [];
  return list.includes(headRefOid);
}

/**
 * 播报发出(或已尝试发出,见 SKILL 收敛止损段的"标记时机"说明)后回写去重记录。
 * 要求 state 已处于 `ok`——正常流程里 `recordConvergenceRound` 总会先把状态修到
 * `ok`(哪怕是从损坏里重建出来的全新 ok 状态),因此调用顺序应始终是先 record
 * 再 markNotified;若此刻仍读到 missing/corrupted,说明调用顺序被打乱或状态在
 * 两次调用之间被外部破坏,直接 throw,不静默假装标记成功。
 */
export function markNotified({ pr, reason, thresholdKey, headRefOid }) {
  if (!reason || typeof reason !== 'string') throw new Error('reason 不能为空');
  if (!headRefOid || typeof headRefOid !== 'string') throw new Error('headRefOid 不能为空');
  const { status, state, file } = readConvergenceState(pr);
  if (status !== 'ok') {
    throw new Error(
      `markNotified 要求已存在有效的收敛状态(当前 status=${status}),应先调用 recordConvergenceRound`,
    );
  }
  const byReason = state.notifiedThresholds[reason] ?? (state.notifiedThresholds[reason] = {});
  const key = String(thresholdKey);
  const list = byReason[key] ?? (byReason[key] = []);
  if (!list.includes(headRefOid)) list.push(headRefOid);
  writeJsonAtomic(file, state);
  return list;
}
