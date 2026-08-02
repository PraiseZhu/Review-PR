#!/usr/bin/env node
// lib.review-output-shape.mjs — 独立代码审查输出契约(SKILL 第 4 节第 6 条「family
// 归族」)的三个纯函数,不 import lib.mjs(该文件当前由并行任务改动状态/回执段,
// 避免冲突)。仅依赖 `node:crypto`(Node 内置,不是外部包/不是 lib.mjs,不影响
// "零耦合"的原意)。
//
// 1. `validateFindingFamily` —— family 对象的形状校验。
//
//    边界(对齐 conv/output-contract 的 D2 裁决):只校验字段存在、severity 取值
//    合法、manifestations 结构完整、family.severity 是否等于成员最高 severity——
//    这些都是可机械判定的形状/一致性检查。它**不**、也**不能**判断"这几条
//    manifestation 是不是真的同一个不变量"——那是审查 agent 自己的语义判断(T1),
//    机器不能代它下结论,判断不了的宁可拆成多个 family。本文件同样不判断
//    invariant/fixGuidance 的文字是否"写得对",只判断这些字段是否存在且非空。
//
// 2. `invariantKey` —— 跨轮 join key 的**唯一实现**(权威身份,2026-08-02 定案)。
//
//    `family_id` 只在单份审查报告内唯一、不跨轮持久(每轮审查 agent 独立生成,数字
//    可能撞、也可能对不上同一个不变量),不能拿它做跨轮识别"这是不是同一个
//    family"。跨轮识别的 join key 是这里导出的 `invariantKey(invariant)`:对完整
//    归一化文本算 SHA-256、不截断——per-PR convergence state(rp-state 维护,存
//    历史 family 记录)与本 SKILL 的 review-pr 侧共用同一份实现——**禁止在别处
//    重新实现一份**,哪怕只差一个字符(大小写、去空白任一环节不一致),跨轮 join
//    就会静默对不上,表现为"复发没被识别成复发",且不报错、不告警(fail-open,
//    SKILL 5.0 明确要求避免的场景)。若归一化规则需要调整,改这一份、同步通知
//    rp-state 侧重新对齐,不要各自维护一份"看起来差不多"的版本。
//
// 3. `invariantSlug` —— **降级为纯展示**,不再是身份(gpt 2026-08-02 阻断修正)。
//
//    早前把 `invariantSlug`(截断到 64 字符)当跨轮 join key 用,gpt 实跑复现:
//    两条前 64 字符相同、尾部完全不同的 invariant 会被截断成同一个 slug,导致
//    机器把两个真正不同的问题误判成同一 family 复发——而且不报错,`matchedBy`
//    还会记成确定性命中,旧版单测甚至把这个碰撞断言成"已知可接受"(锁死了错误
//    契约,已删除该断言)。现在 `invariantSlug` 只用于人类可读的展示场合(如
//    review 评论里 `<!-- family-anchor: <slug> -->` marker 的可读文本),**不得**
//    再被任何身份判定/跨轮比对逻辑消费——身份判定只认 `invariantKey`。截断导致
//    的展示层碰撞(两个不同 family 恰好显示同一个 slug)在这个降级后的角色下是
//    无害的:marker 只是 thread 锚点,不是检测源,展示文本重复不影响任何判定
//    结果的正确性。

import { createHash } from 'node:crypto';

const SEVERITIES = ['P0', 'P1'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * 校验单条 manifestation 的形状。返回该条的错误列表(带 `manifestations[<i>].` 前缀),
 * 便于调用方拼进整体错误列表定位。
 */
function validateManifestationShape(m, i) {
  const errors = [];
  const prefix = `manifestations[${i}]`;
  if (m === null || typeof m !== 'object' || Array.isArray(m)) {
    return [`${prefix} 不是对象`];
  }
  if (!isNonEmptyString(m.path)) errors.push(`${prefix}.path 缺失或非法(需非空字符串)`);
  if (!isPositiveInt(m.line)) errors.push(`${prefix}.line 缺失或非法(需正整数)`);
  if (!isNonEmptyString(m.evidence)) errors.push(`${prefix}.evidence 缺失或非法(需非空字符串)`);
  if (!isNonEmptyString(m.impact)) errors.push(`${prefix}.impact 缺失或非法(需非空字符串)`);
  if (!isNonEmptyString(m.fix)) errors.push(`${prefix}.fix 缺失或非法(需非空字符串)`);
  if (!isNonEmptyString(m.verification)) errors.push(`${prefix}.verification 缺失或非法(需非空字符串)`);
  if (!SEVERITIES.includes(m.severity)) errors.push(`${prefix}.severity 缺失或非法(需 P0 或 P1)`);
  return errors;
}

/**
 * 校验一个 family 对象的形状(SKILL 第 4 节第 6 条):
 *   { family_id, invariant, severity, manifestations: [...], fixGuidance }
 * 只验形状,不验语义——见文件头部边界说明。返回 `{ ok, errors }`,`errors` 为空数组
 * 时 `ok` 才为 true。多条错误会一次性全部收集,不是遇到第一条就短路返回,方便调用方
 * 一次性看到全部问题。
 */
export function validateFindingFamily(family) {
  const errors = [];

  if (family === null || typeof family !== 'object' || Array.isArray(family)) {
    return { ok: false, errors: ['family 不是对象'] };
  }

  if (!isNonEmptyString(family.family_id)) errors.push('family_id 缺失或非法(需非空字符串)');
  if (!isNonEmptyString(family.invariant)) errors.push('invariant 缺失或非法(需非空字符串)');
  if (!isNonEmptyString(family.fixGuidance)) errors.push('fixGuidance 缺失或非法(需非空字符串)');
  if (!SEVERITIES.includes(family.severity)) errors.push('severity 缺失或非法(需 P0 或 P1)');

  if (!Array.isArray(family.manifestations) || family.manifestations.length === 0) {
    errors.push('manifestations 缺失或为空(至少 1 条,单条表现也要建 family)');
  } else {
    family.manifestations.forEach((m, i) => {
      errors.push(...validateManifestationShape(m, i));
    });

    // family.severity 必须等于成员最高 severity(P0 > P1)。仅当每条 manifestation
    // 自身的 severity 都已通过上面的形状校验(值合法)时才做这层一致性检查——某条
    // manifestation.severity 本身不合法时,该条已经报错,不在这里重复算最高值。
    const memberSeverities = family.manifestations
      .map((m) => (m && typeof m === 'object' ? m.severity : null))
      .filter((s) => SEVERITIES.includes(s));
    if (memberSeverities.length === family.manifestations.length && memberSeverities.length > 0) {
      const maxSeverity = memberSeverities.includes('P0') ? 'P0' : 'P1';
      if (SEVERITIES.includes(family.severity) && family.severity !== maxSeverity) {
        errors.push(
          `severity 与成员最高 severity 不一致(family.severity=${family.severity},成员最高=${maxSeverity})`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

const INVARIANT_SLUG_MAX_LEN = 64;
const INVARIANT_KEY_ALGO_PREFIX = 'ik1-'; // 算法版本前缀——归一化规则若将来必须改动,换前缀而不是静默改变同名函数的输出,让新旧 key 在数据里可区分,不会被误当成同一身份。

/**
 * 共享归一化步骤(`invariantSlug` 与 `invariantKey` 唯一共用的实现,算法本身
 * ——三步,顺序固定,任一步改动都是跨 join 双方的破坏性变更——见文件头部说明):
 *   1. `trim()` 去首尾空白;
 *   2. `toLowerCase()` 转小写(避免大小写差异造成假阴性);
 *   3. `replace(/\s+/g, '')` 去掉全部内部空白(不止是折叠——中英文混排时空格位置
 *      在不同轮次的复述里最不稳定,直接去掉比折叠成单空格更抗漂移)。
 *
 * 已知限制(对 `invariantSlug` 与 `invariantKey` 都成立):不归一化标点(半角/
 * 全角逗号、句号等差异会产生不同结果)。同一不变量换个标点复述,一级(key)会
 * 未命中,退到 SKILL 5.0 的二级语义判断兜底——这是可接受的(二级是
 * fail-safe:顶多多花一次语义判断,不会给出错答案),不在这里加标点归一化
 * (过度归一化标点会引入假碰撞,把两个真的不同的不变量判成同一个,风险比"退到
 * 语义兜底"更大)。
 *
 * 非字符串或去空白后为空的输入直接 `throw`,不返回空字符串——空字符串会让两个
 * 完全无关、都因为字段缺失而拿不到合法 invariant 的 family 在 join key 上碰撞,
 * 被误判成"同一个不变量复发"(静默错误,比调用方直接崩溃更危险)。调用方应在
 * `invariant` 通过 `validateFindingFamily` 的形状校验之后才调用本函数。
 */
function normalizeInvariantOrThrow(invariant, fnName) {
  if (typeof invariant !== 'string' || invariant.trim().length === 0) {
    throw new TypeError(`${fnName}: invariant 必须是非空字符串`);
  }
  return invariant.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * family 一句话不变量描述 → 确定性归一化 slug,**仅供人类可读展示**(如 review
 * 评论里 `<!-- family-anchor: <slug> -->` marker 的文本)——不是跨轮身份,身份见
 * 下方 `invariantKey`(2026-08-02 gpt 阻断修正,见文件头部说明)。
 *
 * 截断到前 `INVARIANT_SLUG_MAX_LEN`(64)个字符。超长不变量描述截断后可能发生
 * "前 64 字符相同、后面不同"的碰撞——在**展示层**这是已知、可接受的行为(marker
 * 只是 thread 锚点,两个不同 family 显示同一段文本不影响任何判定结果);但**绝不
 * 能**把这份输出喂给任何身份判定/跨轮比对逻辑,那正是本轮修的阻断——需要身份
 * 判定时必须用 `invariantKey`,不许用本函数"顶一下"。
 */
export function invariantSlug(invariant) {
  return normalizeInvariantOrThrow(invariant, 'invariantSlug').slice(0, INVARIANT_SLUG_MAX_LEN);
}

/**
 * family 一句话不变量描述 → 跨轮识别"同 family 复发"的**权威** join key
 * (SKILL 5.0 一级/确定性判定用;2026-08-02 定案,取代此前误用的 `invariantSlug`)。
 * 对上面同一套归一化文本算 SHA-256、**不截断**——完整 hash 消除了"前 N 字符相同、
 * 后面不同"这一类截断碰撞;剩余的"碰撞"只有两种:①归一化后文本本就完全相等
 * (这是预期行为,就该判同一个 key,不是碰撞)、②SHA-256 的密码学碰撞(概率上
 * 可忽略,不在这里加规避分支——加了也测不出来,纯粹的死复杂度)。前缀 `ik1-`
 * 是算法版本号,不是随机盐,只用来在数据里标注"这个 key 是用哪一版规则算出来的"、
 * 与未来若必须改算法时产出的新前缀区分,不影响确定性或跨轮可比性。
 *
 * 与 `invariantSlug` 共用同一套归一化 + 同款非法输入处理(见上方
 * `normalizeInvariantOrThrow`),不额外发明一份校验逻辑。
 */
export function invariantKey(invariant) {
  const normalized = normalizeInvariantOrThrow(invariant, 'invariantKey');
  return `${INVARIANT_KEY_ALGO_PREFIX}${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}
