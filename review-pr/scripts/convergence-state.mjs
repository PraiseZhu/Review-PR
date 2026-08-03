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
// 机械核验:调用方声称的 `recurrenceOfKey` 指向的 key、以及该 key 下早于当前
// head 的历史 occurrence,是否真实存在于 state 里。核验不过直接 throw——不接受
// "反正你说是复发我就信了"这种口径,也不会静默把无法验证的引用当新家族处理
// (那等于放过一次本该报错的调用方错误)。跨轮 join key 见下方「跨轮 join key」
// 一节。
//
// D3 扩展(persistent vs reopened,2026-08-02,gpt 阻断修正):同一 key 的复发不是
// 只有一种。原实现把"任意较早 head 出现过同一 key"都算一回事,但"相邻两轮持续
// 没修好"和"曾经真的消失过、现在又出现"是两件后果不同的事——前者从未收敛过,不该
// 被描述成"已收敛后复发"、也不该触发只该在"复发"时才触发的升级路径。分类:
//   - **reopened**(真复发):上一次 occurrence 的 head 与当前 head 之间,
//     `state.heads` 里存在至少一个**已审**(有记录)的中间 head 不含这个 key——
//     证明它真的消失过一次。触发升级路径(收敛检查点契约,SKILL 5.0/5.4),卡片
//     可以说"上一轮已收敛"。
//   - **persistent**(持续未修):找不到这样的中间 head(相邻,或中间已审的 head
//     全都仍带着这个 key)。仍是 P0/P1、仍计入 `p0p1Count`、仍使 verdict=dirty、
//     仍阻断合并、仍不算新 family——**这些一条都不因为分类而改变**——但措辞不得
//     声称"已收敛",也**不触发**升级路径(它本来就没收敛过,没有"再次出现"这件事)。
//   - fail 方向:分类只看 `state.heads` 里**已经记录**的审查轮次——被 cron 跳过、
//     从未被记录的 head 不提供任何证据(既不证明修好也不证明没修好),不能被当成
//     "干净"。找不到证据时一律判 persistent,宁可少触发一次升级,不能谎称已收敛。
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
// 通知层的两层拆分(SC-C4 调查带出的要求,2026-08-02):SC-C4 在 2026-07-28~
// 08-02 观测窗(31 次运行、12 个进入阶段二独立审查的 PR、1/12 触发过重审)内
// 未观察到中间态重审放大,暂不引入 debounce(cron ~3h 网格本身就是隐式
// debounce)——这是基于当前样本量的暂定结论,不是"结构上不可能"的全称判断,
// 见 SKILL 5.7 同一处收窄措辞。这次调查顺带查出一个真缺口——非 required 的
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
// 通知失败不 mark(D4,2026-08-02,gpt 阻断修正):`markNotified` **只能**在调用方
// 确认播报真的投递成功之后才调——失败(子进程报错、`posted:false`)绝不能 mark,
// 否则一次未送达 = 同一 head 永久静音(下一轮阈值条件依然为真,但 `hasNotified`
// 会一直读到"已经发过"从而抑制)。失败路径的重试不需要额外机制:下一轮只要
// `consecutiveRoundsWithNewFamilies` 仍 `>= CONVERGENCE_NOTIFY_THRESHOLD`,
// `recordConvergenceRound` 会在**新的** head 上重新判定(每个 head 只判一次,
// 不会刷屏)。为了让"投递失败了几次、上次什么时候试的"这件事在运维排查时可查,
// 新增 `recordNotificationAttempt`(见下方),与 `markNotified` 完全独立、互不
// 影响——它只负责记账,不参与任何去重判定。
//
// 检查点(`checkpointRequired`)不去重(与上面的 notification 去重刻意不同,
// 2026-08-02 gpt 复核后收窄措辞):**不是**"任何去重都必然让门 fail-open"这种
// 全称——理论上一份绑定 head+本轮输入内容 hash 的 completion receipt,可以既避免
// 重复提示又保持 fail-closed(下次输入没变就不用再提示,输入变了立刻重新提示)。
// 但本模块**当前没有**这样的 completion receipt,"这一轮是否已经产出过收敛检查点
// 六件套"没有任何机器可核验的凭证——在这个前提下,唯一安全的做法就是每轮重新算、
// 条件仍成立就仍然提示,重复提示是**当前**依赖 T1 过程约定(agent 自己记得"这轮
// 已经写过六件套了")而非机器强制的安全网,不是"永远不能加去重"的教条。本轮**不
// 新增** completion receipt 机制(确认门:删掉这个机制,`checkpointRequired` 的
// 目标——"下一个修复 commit 前必须先产出六件套"——照样成立,只是没有去重,新增
// 属于范围外的死复杂度)。
//
// 跨轮 join key = `invariantKey`,**不是** `invariantSlug`、也不是 `family_id`
// (2026-08-02 两次纠正,按时间顺序):
//   ① 最初错误:拿 `family_id` 做跨轮比对——`family_id` 只在单份审查报告内唯一,
//     审查 agent 每轮独立生成报告,第 2 轮的 family_id 与第 1 轮没有任何对应
//     关系,必然失效。
//   ② 第一次纠正后仍有阻断:改用 `invariantSlug`(截断到 64 字符的展示用归一化)
//     当身份用——gpt 实跑复现:两条"前 64 字符相同、尾部完全不同"的 invariant
//     会被截断成同一个 slug,机器把两个真正不同的问题误判成同一 family 复发
//     (`matchedBy` 还记成确定性命中),旧版单测甚至把这个碰撞断言成"可接受"
//     (已删除,见 lib.review-output-shape.mjs 与本模块测试文件的改动记录)。
//   ③ 现在:`invariantKey` 对完整归一化文本算 SHA-256、不截断,消除了截断碰撞
//     这一类问题;`invariantSlug` 降级为纯展示,不参与任何身份判定。
// 归一化 + hash 的**唯一实现**是 `lib.review-output-shape.mjs` 导出的
// `invariantKey`,不在本文件另写一份(两份实现只要差一个字符,跨轮就永久对不上,
// 且这种 bug 不报错、只静默漏判复发)。该文件是从 `conv/output-contract` 逐字节
// 复制过来的**只读依赖**,不是本模块的代码,不应在这里被修改。
//
// 两级检测(定案 3,join key 已从 slug 换成 key,机器/语义边界不变):
//   一级(确定性):对本轮 finding 的 invariant 原文算 `invariantKey`,命中 state
//     里已有的历史 key → 直接判定复发,机器可断言,不需要调用方声明。
//   二级(T1 兜底):key 未命中时,调用方(审查 agent/主 agent)可能仍判断这是同一
//     家族换了个说法——显式传 `recurrenceOfKey: <历史 key>`;本模块只核验该
//     key 在 state 里确有早于当前 head 的记录,不做语义判断。
//   两级都未命中 → 当新 family 处理(宁可多报一条新 family,不静默吞掉复发)。
// 每条 occurrence 记 `matchedBy: 'key' | 'semantic' | 'same-round' | null`
// (`'same-round'` = 同一轮内两条 finding 撞了同一个 key,不是跨轮复发,不重复计
// 新家族;`null` = 该 family 的第一条 occurrence,没有"匹配"这件事)供将来统计
// 二级命中率、判断归一化要不要加强。命中(`'key'`/`'semantic'`)的 occurrence 还
// 会带 `recurrenceType: 'reopened'|'persistent'`(见上方 D3 扩展)。

import { readFileSync, existsSync, renameSync } from 'node:fs';
import { stateFile, writeJsonAtomic } from './lib.mjs';
import { invariantKey } from './lib.review-output-shape.mjs';

export const CONVERGENCE_CHECKPOINT_THRESHOLD = 5;
export const CONVERGENCE_NOTIFY_THRESHOLD = 10;

/** SC-C3「新 P0/P1 family 数连续达标」这一种触发源的 reason 标识——通知投递层
 * (hasNotified/markNotified)按 reason 分域去重,与其它触发源(如未来的"等待方
 * 缺席")互不干扰。 */
export const CONVERGENCE_NOTIFY_REASON_ROUND = 'round-nonconvergence';

const SEVERITIES = new Set(['P0', 'P1']);
// v1→v2:跨轮 join key 从 family_id 换成 invariantSlug(截断展示归一化),顶层
// families 键随之改变含义。v2→v3(2026-08-02,gpt 阻断修正):join key 从截断
// slug 换成不截断的 invariantKey(完整 hash),消除截断碰撞误判复发;occurrence
// 新增 recurrenceType 字段(D3)。历次版本不符的文件都按既有 corrupted 处理(隔离
// 重建,见 validateShape),无生产数据,不写迁移代码。
const STATE_VERSION = 3;

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

const MATCHED_BY_VALUES = new Set(['key', 'semantic', 'same-round', null]);
// D3:只有真正的跨轮命中(matchedBy: 'key'|'semantic')才有 recurrenceType 可言;
// 'same-round'(同轮撞车)和 null(该家族第一条 occurrence)都没有"上一次跨轮
// 出现"这个概念,recurrenceType 必须是 null。
const RECURRENCE_TYPE_VALUES = new Set(['reopened', 'persistent', null]);

function isValidOccurrence(o) {
  return (
    isPlainObject(o)
    && typeof o.headRefOid === 'string' && o.headRefOid !== ''
    && SEVERITIES.has(o.severity)
    && (o.familyId === null || typeof o.familyId === 'string')
    && MATCHED_BY_VALUES.has(o.matchedBy)
    && RECURRENCE_TYPE_VALUES.has(o.recurrenceType)
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

/** `notificationAttempts` 按 `{[reason]:{[thresholdKey]:{[headRefOid]:{count,
 * lastAttemptAt}}}}` 三层嵌套(D4)——与 `notifiedThresholds` 完全独立、互不
 * 影响,只负责"尝试过几次、上次什么时候"这个运维可观测性问题,不参与任何去重
 * 判定。 */
function isValidNotificationAttempts(v) {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every((byThreshold) => (
    isPlainObject(byThreshold)
    && Object.values(byThreshold).every((byHead) => (
      isPlainObject(byHead)
      && Object.values(byHead).every((rec) => (
        isPlainObject(rec) && Number.isInteger(rec.count) && rec.count > 0 && typeof rec.lastAttemptAt === 'string'
      ))
    ))
  ));
}

// F4(2026-08-02 对抗审 finding 4):被判 `ok` 的 state 必须①绑定请求中的 PR、②每个
// families 键等于该 family 原文的 canonical invariantKey。旧实现两条都不查——只验
// `Object.values(...)`,从不验 entry key 与 `invariantKey(fam.invariant)` 的关系,也不看
// `state.pr`。于是「families 按 invariantKey 建键」这条不变量**只在写路径成立**,读路径
// 识别不出漂移:对抗审写了一份结构合法但 pr=999999、键为 `legacy-slug-a`(原文 `A`)的
// state,读到 `ok`;下一轮再记录 A 得 newFamilyCount:1、recurringFamilies:[],最后文件里
// slug 键和 ik1- 键并存。不变量在写侧成立、读侧无法 fail-closed 识别 = 迟早漂回去。
function validateShape(state, pr) {
  if (!isPlainObject(state)) return false;
  if (state.version !== STATE_VERSION) return false;
  // 错绑 PR 的 state 一律不可信(字段错配,不是恶意场景的专用措辞)
  if (Number(state.pr) !== Number(pr)) return false;
  if (!Array.isArray(state.heads) || !state.heads.every(isValidHeadRecord)) return false;
  if (!isPlainObject(state.families) || !Object.values(state.families).every(isValidFamily)) return false;
  // 键必须是该 family 原文算出的 canonical key。invariantKey 抛错(原文非法)同样算不可信
  // ——fail-closed,不把「输入坏」当成「没有这个 family」。
  for (const [key, fam] of Object.entries(state.families)) {
    let canonical;
    try { canonical = invariantKey(fam.invariant); } catch { return false; }
    if (key !== canonical) return false;
  }
  if (!isValidNotifiedThresholds(state.notifiedThresholds)) return false;
  if (!isValidNotificationAttempts(state.notificationAttempts)) return false;
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
  if (!validateShape(parsed, pr)) {
    return { status: 'corrupted', state: null, file, error: '结构校验未通过(字段缺失、类型不符、版本不识别、PR 错绑,或 families 键与 invariantKey(原文) 不符)' };
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
    notificationAttempts: {},
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
 * D3:把一次跨轮命中(一级 key 命中或二级语义引用)分类成 `'reopened'`(真的消失
 * 过一次,现在复发)或 `'persistent'`(从未消失,持续未修)。
 *
 * 判据:在 `priorOccurrence` 所在的 head 与当前 head 之间(不含两端),
 * `state.heads` 里是否存在**至少一个已审记录的 head 不含这个 family**(该 head
 * 存在于 `state.heads`,但 `familyOccurrenceHeads` 里没有它)。存在 → reopened
 * (有真实证据证明它消失过);不存在(包括相邻、或中间的已审 head 全都仍带着这个
 * family)→ persistent。
 *
 * fail 方向(D3 边界,不可放宽):`state.heads` 只包含**实际记录过**的审查轮次——
 * 被 cron 跳过、从未被记录的 head 天然不会出现在这个数组里,因此也不会被误当成
 * "干净的中间 head"。找不到证据(包括 `priorOccurrence` 的 head 因某种原因不在
 * `state.heads` 里——理论上不会发生,防御性兜底)时一律返回 persistent,不能把
 * "没查"当"查过是干净的"。
 *
 * 调用时机:必须在**本轮 occurrence push 之前**调用——`familyOccurrenceHeads`
 * 若已经包含当前 head,会把"当前 head 本身"误当成"中间的干净 head"的候选(虽然
 * `currentHeadIdx` 的 slice 上界已经排除了它,这里仍按"调用前状态"的约定实现,
 * 避免调用顺序变化后产生隐蔽的一次性偏移错误)。
 */
function classifyRecurrence(state, familyOccurrenceHeads, priorOccurrenceHeadRefOid, currentHeadIdx) {
  const priorIdx = state.heads.findIndex((h) => h.headRefOid === priorOccurrenceHeadRefOid);
  if (priorIdx === -1) return 'persistent'; // 防御性兜底(见上方说明),fail 向 persistent
  const middleHeads = state.heads.slice(priorIdx + 1, currentHeadIdx);
  const hasCleanMiddleHead = middleHeads.some((h) => !familyOccurrenceHeads.has(h.headRefOid));
  return hasCleanMiddleHead ? 'reopened' : 'persistent';
}

/**
 * 记录一轮独立审查的收敛结果(SC-C2 + SC-C3 的唯一写入口)。
 *
 * @param {number} pr
 * @param {string} headRefOid 本轮审查针对的 head commit —— 必须非空。
 * @param {Array<{invariant:string, severity:'P0'|'P1', description?:string,
 *   familyId?:string, recurrenceOfKey?:string}>} findings
 *   本轮**存活**的 P0/P1 findings(调用方已完成 4.1 严重度分类与主 agent 复核之后
 *   的最终清单;P2 不传入,不参与收敛统计)。空数组 = 本轮 0 P0/P1(收敛信号)。
 *   - `familyId`:该 finding 在**本轮**审查报告里的 family_id(仅供回溯该轮报告,
 *     不跨轮、不参与任何匹配逻辑——见文件头注释「跨轮 join key」),可省略。
 *   - `recurrenceOfKey`:调用方(审查 agent/主 agent 的 T1 语义判断)认定这条
 *     finding 与某个既有 key 同源(二级检测,用于一级 `invariantKey` 自动匹配
 *     未命中但语义上仍是同一不变量换了说法的场景)。本函数只核验该 key 在
 *     state 里确有早于当前 head 的历史记录,不做语义判断——核验不过直接 throw。
 *     省略时只走一级(对 `invariant` 算出的 `invariantKey` 自动比对 state 历史)。
 * @param {number} [seedRoundCount] 仅在该 PR 第一次被记录(state 从 missing 起建)
 *   时生效,忽略于后续调用(D4「保守 seed」只在起点生效一次,不应每轮重复叠加)。
 * @returns {{pr:number, headRefOid:string, roundCount:number, p0p1Count:number,
 *   newFamilyCount:number, consecutiveRoundsWithNewFamilies:number,
 *   recurringFamilies:Array<{key:string, familyId:string|null, invariant:string,
 *   priorHead:string, priorDescription:string|null, matchedBy:'key'|'semantic',
 *   recurrenceType:'reopened'|'persistent'}>, checkpointRequired:boolean,
 *   notification:{reason:string, prNumber:number, head:string, thresholdKey:string,
 *   detail:object}|null, integrityWarning:string|null}}
 *   `notification` 非 null 时代表本轮触发源(round/new-family)判定需要发一次
 *   升级通知且尚未对当前 head 发过——按文件头注释「通知层的两层拆分」,这是
 *   round 触发源自己的判定结果,不代表通知已经发出;调用方**确认投递成功后**
 *   必须调 `markNotified` 回写去重(D4:失败绝不能 mark,否则一次未送达 = 永久
 *   静音),否则下一轮同 head 重放会再次判需要通知。
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
    // `invariantKey` 对这类输入会 throw TypeError,那个报错点在匹配循环内部,
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
    if (f.recurrenceOfKey !== undefined && (typeof f.recurrenceOfKey !== 'string' || f.recurrenceOfKey === '')) {
      throw new Error(`recurrenceOfKey 必须是非空字符串 key,收到: ${JSON.stringify(f.recurrenceOfKey)}`);
    }
  }

  const { status, state: loaded, file, error } = readConvergenceState(pr);
  let state;
  let integrityWarning = null;
  let forceCheckpoint = false;

  if (status === 'ok') {
    state = loaded;
    // F3(2026-08-02 对抗审 finding 3):上一轮检测到损坏、隔离并重建了 state,但那一轮在
    // 后续校验里抛错、没走到 headRecord 落盘(heads 仍为空)——此时"强制检查点"这个信号
    // 只存在于那一轮的返回值里,重试就丢了。改成从**持久化的 state** 重新推出来。
    //
    // F3-b(2026-08-03 终审 finding 2): 上一版的条件是 `heads.length === 0`,漏了
    // **同一 head 原样重放**这一格: 损坏后第一次成功记录使 heads=1、streak 被抬到阈值;
    // 紧接着对同一 head 重跑(D4 覆盖路径),`priorForStreak = heads[existingIdx-1]` 在
    // existingIdx===0 时是 undefined,streak 重算回 1,而 heads 非空又让这里不再 force
    // → checkpointRequired 从 true 翻成 false。没有新 head、没有输入变化、也没有任何检查点
    // 完成回执,门却被一次重放关掉——这正是 F6 讲的「给门做去重就等于 fail-open」同一族。
    //
    // 改成认「损坏是在哪个 head 上检测到的」: 那个 head 上的任何一次记录(含重放)都仍强制。
    // 为什么不永久强制: 换到**新** head 时本条不再 force,但抬高后的 streak 已进上一条
    // headRecord、由既有 streak 机制自然延续;等到某一轮真的没有新 family,streak 归零,
    // 门自然打开。既堵住重放解除,也不会永久拦。
    const forcedHead = state.integrity?.detectedAtHead ?? null;
    if (state.integrity?.status === 'recovered-from-corruption'
        && (state.heads.length === 0 || forcedHead === headRefOid)) {
      forceCheckpoint = true;
      integrityWarning = (state.heads.length === 0
        ? '上一轮检测到收敛状态文件损坏并已重建,但那一轮未成功完成'
        : '本 head 上曾检测到收敛状态文件损坏并已重建,重放不解除该信号')
        + (state.integrity.quarantinedFile ? `(旧文件已隔离至 ${state.integrity.quarantinedFile})` : '')
        + '——历史轮次记录仍不可信,本轮继续强制触发收敛检查点。';
    }
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
      // F3-b: 记下损坏是在哪个 head 上检测到的——该 head 上的任何一次记录(含原样重放)
      // 都必须仍然强制检查点,不能被重放解除(当前没有 completion receipt,见文件头 F6 段)。
      detectedAtHead: headRefOid,
    };
    integrityWarning = '收敛状态文件损坏('
      + error
      + (quarantinedFile ? `),已隔离旧文件至 ${quarantinedFile} 并重建。` : '),隔离旧文件失败,已直接重建。')
      + '历史轮次记录不可信,本轮起强制触发收敛检查点,请人工核查该 PR 是否已经历多轮未收敛。';
    forceCheckpoint = true;
    // F3:隔离与"恢复态落盘"必须成为一个原子步骤。旧实现隔离完就往下走,而下面的
    // recurrence 校验仍可能抛错;一抛错 canonical 文件就不存在了,下一次调用读到
    // `missing` = 真首轮,损坏信号和强制检查点双双丢失(对抗审实测复现)。
    // 这里在任何可抛错的步骤**之前**先落一份带 integrity 标记的恢复态:
    // 后续正常完成会用完整 state 覆盖它;后续抛错则至少留下"这份 state 是从损坏恢复来的、
    // 且还没有任何一轮成功完成"这个事实,由上面 status==='ok' 分支重新推出强制信号。
    writeJsonAtomic(file, state);
  }

  const existingIdx = state.heads.findIndex((h) => h.headRefOid === headRefOid);
  const isNewHead = existingIdx === -1;
  // 本轮 head 在 state.heads 里"将占据"的位置(新 head 尚未 push 时就是
  // heads.length;覆盖场景就是它已经在的位置)——D3 分类需要拿它划定"中间 head"
  // 的范围,必须在下面的摘除/匹配循环**之前**算好,不能等 head 记录真的 push/
  // 覆盖之后再算(那时 isNewHead 场景的 heads.length 已经变了)。
  const currentHeadIdx = isNewHead ? state.heads.length : existingIdx;

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
    const autoKey = invariantKey(f.invariant);
    // 目标 key:二级显式声明优先,否则用一级自动算出的 key——两条路径最终都
    // 落到"往 state.families[targetKey] 追加一条 occurrence"这一件事上,分支
    // 只是决定 targetKey 是什么、以及 matchedBy 怎么记。
    // F2(2026-08-02 对抗审 finding 2):一级确定性 key 已命中历史时,二级语义声明**不得**
    // 覆盖它。旧实现是无条件 `f.recurrenceOfKey || autoKey`,只核验"被引用的 key 有历史",
    // 从不核验"autoKey 是不是也已经确定性命中了另一个 family"。对抗审实测:h1 记了 A/B 两族,
    // h2 传 {invariant:'family A', recurrenceOfKey:keyB} 被接受,occurrence 挂到 B,A 反而没有。
    // 处置是 **fail-closed 抛错**,不是静默取 autoKey:调用方同时声称"这条是 A"和"这条是 B 的
    // 复发",说明它自己也没判清;机器替它选一边就是在掩盖混乱(而这里的 T1 目标恰恰是让
    // 判不清的地方显形)。autoKey 无历史时二级照常介入——那才是二级该管的场景。
    // F2-b(2026-08-03 终审 finding 1): 判据不能只看**跨 head**的历史。上一版用
    // `.filter(o => o.headRefOid !== headRefOid)` 排除了当前 head,于是同一次调用里
    // 「第一条 finding 刚把 A 建起来、第二条 finding 仍是 A 但声称是 keyB 的复发」这一格
    // 漏掉了: A 此刻只有当前 head 的 occurrence,过滤后为 0,guard 不响,第二条被劫持到 B。
    // 终审实测落盘: A 只收第一条, B 收到第二条且 matchedBy='semantic'。
    // 正确的不变量是「autoKey 已经确定性归组」——**不区分它是这一轮建的还是上几轮建的**。
    // 注意 D4 的同 head 覆盖路径已在进入本循环**之前**摘除了当前 head 名下的旧 occurrence,
    // 所以这里看到的当前 head occurrence 只可能来自**本次调用更早的那几条 finding**,
    // 正是要拦的那一格;若摘除后 family 余 0 条,guard 不响、二级照常介入(那是它该管的)。
    const autoFam = state.families[autoKey];
    const autoOccurrences = autoFam ? autoFam.occurrences : [];
    if (f.recurrenceOfKey && f.recurrenceOfKey !== autoKey && autoOccurrences.length > 0) {
      const sameRound = autoOccurrences.every((o) => o.headRefOid === headRefOid);
      throw new Error(
        `recurrenceOfKey=${f.recurrenceOfKey} 与本轮 invariant 自动算出的 key=${autoKey} 不同,`
        + `而后者在 state 中**已有**${sameRound ? '本轮(同一 head)刚建立的记录' : '早于当前 head 的历史'}`
        + '——一级确定性命中优先于二级语义声明,二级只在一级未命中时介入。'
        + '请核对:要么这条 invariant 文本写错了,要么 recurrenceOfKey 引用错了族。',
      );
    }
    const targetKey = f.recurrenceOfKey || autoKey;
    const fam = state.families[targetKey];
    // "早于当前 head 的历史"排除当前 head 自己的 occurrence——本轮同一 head 下
    // 若已有另一条 finding 刚创建/命中了同一个 key,不能把它当"跨轮历史"用
    // (那不是复发,是同一轮内两条 finding 撞了同一个 key;见文件头注释)。
    const priorOccurrences = fam ? fam.occurrences.filter((o) => o.headRefOid !== headRefOid) : [];

    if (f.recurrenceOfKey) {
      // D3:机器只核验"引用的历史是否真实存在",不做语义匹配——语义判断已经由
      // 调用方(T1,二级检测)做完,这里只管"你说的那段历史,在 state 里真的有吗"。
      if (priorOccurrences.length === 0) {
        throw new Error(
          `recurrenceOfKey=${f.recurrenceOfKey} 引用的历史在 state 中不存在(或没有早于当前 head 的`
          + '记录)——不能凭空声称复发,请改用新家族(省略 recurrenceOfKey)或核对 key 是否正确',
        );
      }
      const priorOccurrence = priorOccurrences[priorOccurrences.length - 1];
      // 显式引用的 key 恰好等于本轮 invariant 自动算出的 key 时,其实一级
      // 确定性匹配本就该命中——按更简单、更可解释的一级记录,不因为调用方多此
      // 一举传了 recurrenceOfKey 就升级成"语义"命中(matchedBy 是给未来统计
      // 二级命中率用的,虚报会稀释这个信号的可信度)。
      const matchedBy = f.recurrenceOfKey === autoKey ? 'key' : 'semantic';
      // D3:分类必须在这条 occurrence 真正 push 进 fam.occurrences 之前算——
      // classifyRecurrence 依赖的"family 目前占据哪些 head"快照不能已经包含
      // 本轮这一条。
      const familyOccurrenceHeads = new Set(fam.occurrences.map((o) => o.headRefOid));
      const recurrenceType = classifyRecurrence(state, familyOccurrenceHeads, priorOccurrence.headRefOid, currentHeadIdx);
      fam.occurrences.push({
        headRefOid, recordedAt, severity: f.severity, description: f.description ?? null,
        familyId: f.familyId ?? null, matchedBy, recurrenceType,
      });
      recurringFamilies.push({
        key: f.recurrenceOfKey,
        familyId: f.familyId ?? null,
        invariant: fam.invariant,
        priorHead: priorOccurrence.headRefOid,
        priorDescription: priorOccurrence.description ?? null,
        matchedBy,
        recurrenceType,
      });
    } else if (priorOccurrences.length > 0) {
      // 一级(确定性):本轮 invariant 归一化后的 key 命中了 state 里早于当前
      // head 的历史 —— 不需要调用方声明,机器自己就能断言这是复发。
      const priorOccurrence = priorOccurrences[priorOccurrences.length - 1];
      const familyOccurrenceHeads = new Set(fam.occurrences.map((o) => o.headRefOid));
      const recurrenceType = classifyRecurrence(state, familyOccurrenceHeads, priorOccurrence.headRefOid, currentHeadIdx);
      fam.occurrences.push({
        headRefOid, recordedAt, severity: f.severity, description: f.description ?? null,
        familyId: f.familyId ?? null, matchedBy: 'key', recurrenceType,
      });
      recurringFamilies.push({
        key: targetKey,
        familyId: f.familyId ?? null,
        invariant: fam.invariant,
        priorHead: priorOccurrence.headRefOid,
        priorDescription: priorOccurrence.description ?? null,
        matchedBy: 'key',
        recurrenceType,
      });
    } else if (fam) {
      // 两级都没有可验证的"跨轮"历史,但这个 key 在**本轮**已经被另一条 finding
      // 创建/命中过——同一轮内的 key 撞车,不是真正的跨轮复发,也不是"新"
      // family(这个 key 本轮已经算过一次新家族了),两头都不计,只补一条
      // occurrence 保持该家族记录完整。没有跨轮意义上的"上一次",recurrenceType
      // 必须是 null(不是 persistent——persistent 描述的是"跨轮持续未修",这里
      // 连跨轮这件事都不存在)。
      fam.occurrences.push({
        headRefOid, recordedAt, severity: f.severity, description: f.description ?? null,
        familyId: f.familyId ?? null, matchedBy: 'same-round', recurrenceType: null,
      });
    } else {
      // 两级都未命中,且这个 key 本轮也是第一次出现 —— 当新 family。
      state.families[targetKey] = {
        invariant: f.invariant,
        firstSeenHead: headRefOid,
        occurrences: [{
          headRefOid, recordedAt, severity: f.severity, description: f.description ?? null,
          familyId: f.familyId ?? null, matchedBy: null, recurrenceType: null,
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

  // 故意不去重(与下面 notification 的去重层刻意不同——lead 2026-08-02 定案)。
  // F6(2026-08-02 对抗审 finding 6):上一版这里写「给一个门做去重,等于把它变成
  // fail-open」——那是**全称句**,已被同文件头部与 SKILL.md 收窄推翻,此处漏改。
  // 准确的说法是条件结论:**在当前没有 completion receipt 的前提下**,给这个门做去重
  // 就等于把它变成 fail-open。绑定 head + 输入 hash 的 completion receipt 是安全反例
  // ——那样可以既不刷屏又不放行,但本仓尚未有该机制(新增机制须先过确认门)。
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
 * 播报**确认投递成功**之后回写去重记录(D4,2026-08-02 阻断修正:此前文档要求
 * "尝试过就 mark",失败也 mark 会让一次未送达永久静音同一 head——已改为只在
 * 调用方确认成功后才调用本函数;失败路径改用下面的 `recordNotificationAttempt`
 * 记账,不 mark)。要求 state 已处于 `ok`——正常流程里 `recordConvergenceRound`
 * 总会先把状态修到 `ok`(哪怕是从损坏里重建出来的全新 ok 状态),因此调用顺序
 * 应始终是先 record 再 markNotified;若此刻仍读到 missing/corrupted,说明调用
 * 顺序被打乱或状态在两次调用之间被外部破坏,直接 throw,不静默假装标记成功。
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

/**
 * 记一次通知投递尝试(D4,与 `markNotified`/`hasNotified` 完全独立、互不
 * 影响):无论投递成功还是失败都可以调,只负责"尝试过几次、上次什么时候"这个
 * 运维可观测性问题——排查"为什么 ≥10 告警没到"时,能在 state 里查到"其实已经
 * 尝试过 N 次,只是每次都失败",而不是无法区分"从没到过阈值"与"到了但投递
 * 一直失败"。不参与、也不影响任何去重判定(`notification` 是否非 null 只看
 * `notifiedThresholds`,与本函数写的 `notificationAttempts`无关)。要求 state
 * 已处于 `ok`,同 `markNotified`。
 */
export function recordNotificationAttempt({ pr, reason, thresholdKey, headRefOid }) {
  if (!reason || typeof reason !== 'string') throw new Error('reason 不能为空');
  if (!headRefOid || typeof headRefOid !== 'string') throw new Error('headRefOid 不能为空');
  const { status, state, file } = readConvergenceState(pr);
  if (status !== 'ok') {
    throw new Error(
      `recordNotificationAttempt 要求已存在有效的收敛状态(当前 status=${status}),应先调用 recordConvergenceRound`,
    );
  }
  const byReason = state.notificationAttempts[reason] ?? (state.notificationAttempts[reason] = {});
  const key = String(thresholdKey);
  const byHead = byReason[key] ?? (byReason[key] = {});
  const prev = byHead[headRefOid];
  const record = { count: (prev?.count ?? 0) + 1, lastAttemptAt: new Date().toISOString() };
  byHead[headRefOid] = record;
  writeJsonAtomic(file, state);
  return record;
}
