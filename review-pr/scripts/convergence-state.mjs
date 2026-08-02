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
// 机械核验:调用方声称的 `recurrenceOfFamily` 指向的家族、以及该家族下早于当前
// head 的历史 occurrence,是否真实存在于 state 里。核验不过直接 throw——不接受
// "反正你说是复发我就信了"这种口径,也不会静默把无法验证的引用当新家族处理
// (那等于放过一次本该报错的调用方错误)。
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

import { readFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { stateFile, writeJsonAtomic } from './lib.mjs';

export const CONVERGENCE_CHECKPOINT_THRESHOLD = 5;
export const CONVERGENCE_NOTIFY_THRESHOLD = 10;

const SEVERITIES = new Set(['P0', 'P1']);
const STATE_VERSION = 1;

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

function isValidOccurrence(o) {
  return isPlainObject(o) && typeof o.headRefOid === 'string' && o.headRefOid !== '' && SEVERITIES.has(o.severity);
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

function isValidNotifiedThresholds(v) {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every((list) => Array.isArray(list) && list.every((h) => typeof h === 'string'));
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

function newFamilyId() {
  return `fam-${randomBytes(4).toString('hex')}`;
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
 * @param {Array<{invariant:string, severity:'P0'|'P1', description?:string, recurrenceOfFamily?:string}>} findings
 *   本轮**存活**的 P0/P1 findings(调用方已完成 4.1 严重度分类与主 agent 复核之后
 *   的最终清单;P2 不传入,不参与收敛统计)。空数组 = 本轮 0 P0/P1(收敛信号)。
 *   `recurrenceOfFamily` 非空时代表调用方(审查 agent/主 agent 的 T1 判断)认定
 *   这条 finding 与某个既有家族同源;本函数只核验该家族在 state 里确有早于当前
 *   head 的历史记录,不做语义判断——核验不过直接 throw。
 * @param {number} [seedRoundCount] 仅在该 PR 第一次被记录(state 从 missing 起建)
 *   时生效,忽略于后续调用(D4「保守 seed」只在起点生效一次,不应每轮重复叠加)。
 * @returns {{pr:number, headRefOid:string, roundCount:number, p0p1Count:number,
 *   newFamilyCount:number, consecutiveRoundsWithNewFamilies:number,
 *   recurringFamilies:Array<{familyId:string, invariant:string, priorHead:string,
 *   priorDescription:string|null}>, checkpointRequired:boolean,
 *   notifyRequired:boolean, integrityWarning:string|null}}
 */
export function recordConvergenceRound({ pr, headRefOid, findings, seedRoundCount } = {}) {
  if (!headRefOid || typeof headRefOid !== 'string') {
    throw new Error('headRefOid 不能为空(本轮审查必须绑定到具体的 head commit)');
  }
  if (!Array.isArray(findings)) {
    throw new Error('findings 必须是数组(可为空数组,代表本轮 0 P0/P1)');
  }
  for (const f of findings) {
    if (!isPlainObject(f) || typeof f.invariant !== 'string' || f.invariant === '') {
      throw new Error(`finding 缺少非空的 invariant 字段: ${JSON.stringify(f)}`);
    }
    if (!SEVERITIES.has(f.severity)) {
      throw new Error(`finding.severity 必须是 'P0' 或 'P1',收到: ${JSON.stringify(f?.severity)}`);
    }
    if (f.recurrenceOfFamily !== undefined && (typeof f.recurrenceOfFamily !== 'string' || f.recurrenceOfFamily === '')) {
      throw new Error(`recurrenceOfFamily 必须是非空字符串 familyId,收到: ${JSON.stringify(f.recurrenceOfFamily)}`);
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
    if (f.recurrenceOfFamily) {
      const fam = state.families[f.recurrenceOfFamily];
      // D3:机器只核验"引用的历史是否真实存在",不做语义匹配——语义判断已经由
      // 调用方(T1)做完,这里只管"你说的那段历史，在 state 里真的有吗"。此时
      // fam.occurrences(若存在)只含早于当前 head 的记录(本轮尚未 push,且
      // 上面已摘除了本 head 自己的旧记录),因此"存在且非空"即等价于"存在早于
      // 当前 head 的历史 occurrence"。
      if (!fam || fam.occurrences.length === 0) {
        throw new Error(
          `recurrenceOfFamily=${f.recurrenceOfFamily} 引用的历史在 state 中不存在(或没有早于当前 head 的`
          + '记录)——不能凭空声称复发,请改用新家族(省略 recurrenceOfFamily)或核对 familyId 是否正确',
        );
      }
      const priorOccurrence = fam.occurrences[fam.occurrences.length - 1];
      fam.occurrences.push({
        headRefOid, recordedAt, severity: f.severity, description: f.description ?? null,
      });
      recurringFamilies.push({
        familyId: f.recurrenceOfFamily,
        invariant: fam.invariant,
        priorHead: priorOccurrence.headRefOid,
        priorDescription: priorOccurrence.description ?? null,
      });
    } else {
      const familyId = newFamilyId();
      state.families[familyId] = {
        invariant: f.invariant,
        firstSeenHead: headRefOid,
        occurrences: [{ headRefOid, recordedAt, severity: f.severity, description: f.description ?? null }],
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

  const checkpointRequired = consecutiveRoundsWithNewFamilies >= CONVERGENCE_CHECKPOINT_THRESHOLD;
  const notifiedHeads = state.notifiedThresholds[String(CONVERGENCE_NOTIFY_THRESHOLD)] ?? [];
  const notifyRequired = consecutiveRoundsWithNewFamilies >= CONVERGENCE_NOTIFY_THRESHOLD
    && !notifiedHeads.includes(headRefOid);

  return {
    pr: Number(pr),
    headRefOid,
    roundCount: state.heads.length,
    p0p1Count,
    newFamilyCount,
    consecutiveRoundsWithNewFamilies,
    recurringFamilies,
    checkpointRequired,
    notifyRequired,
    integrityWarning,
  };
}

/** 某 PR 在某个 head 上,某个阈值是否已经通知过(纯读,供调用方判断是否要重发)。 */
export function hasNotifiedThreshold({ pr, threshold, headRefOid }) {
  const { state } = readConvergenceState(pr);
  const list = state?.notifiedThresholds?.[String(threshold)] ?? [];
  return list.includes(headRefOid);
}

/**
 * 播报发出(或已尝试发出,见 SKILL 收敛止损段的"标记时机"说明)后回写去重记录。
 * 要求 state 已处于 `ok`——正常流程里 `recordConvergenceRound` 总会先把状态修到
 * `ok`(哪怕是从损坏里重建出来的全新 ok 状态),因此调用顺序应始终是先 record
 * 再 markThresholdNotified;若此刻仍读到 missing/corrupted,说明调用顺序被打乱
 * 或状态在两次调用之间被外部破坏,直接 throw,不静默假装标记成功。
 */
export function markThresholdNotified({ pr, threshold, headRefOid }) {
  if (!headRefOid || typeof headRefOid !== 'string') throw new Error('headRefOid 不能为空');
  const { status, state, file } = readConvergenceState(pr);
  if (status !== 'ok') {
    throw new Error(
      `markThresholdNotified 要求已存在有效的收敛状态(当前 status=${status}),应先调用 recordConvergenceRound`,
    );
  }
  const key = String(threshold);
  const list = state.notifiedThresholds[key] ?? (state.notifiedThresholds[key] = []);
  if (!list.includes(headRefOid)) list.push(headRefOid);
  writeJsonAtomic(file, state);
  return list;
}
