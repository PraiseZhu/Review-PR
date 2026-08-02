#!/usr/bin/env node
// lib.review-output-shape.mjs — 独立代码审查输出契约(SKILL 第 4 节第 6 条「family
// 归族」)的两个纯函数,零依赖,不 import lib.mjs(该文件当前由并行任务改动状态/回执
// 段,避免冲突)。
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
// 2. `invariantSlug` —— 跨轮 join key 的**唯一实现**。
//
//    `family_id` 只在单份审查报告内唯一、不跨轮持久(每轮审查 agent 独立生成,数字
//    可能撞、也可能对不上同一个不变量),不能拿它做跨轮识别"这是不是同一个
//    family"。跨轮识别的 join key 是这里导出的 `invariantSlug(invariant)`:
//    per-PR convergence state(rp-state 维护,存历史 family 记录)与本 SKILL 的
//    review-pr 侧共用同一份归一化实现——**禁止在别处重新实现一份**,哪怕只差
//    一个字符(大小写、去空白、截断长度任一环节不一致),跨轮 join 就会静默对不上,
//    表现为"复发没被识别成复发",且不报错、不告警(fail-open,SKILL 5.0 明确要求
//    避免的场景)。若归一化规则需要调整,改这一份、同步通知 rp-state 侧重新对齐,
//    不要各自维护一份"看起来差不多"的版本。

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

/**
 * family 一句话不变量描述 → 确定性归一化 slug,用作跨轮识别"同 family 复发"的
 * join key(SKILL 5.0)。算法(三步,顺序固定,任一步改动都是跨 join 双方的破坏性
 * 变更——见文件头部说明):
 *   1. `trim()` 去首尾空白;
 *   2. `toLowerCase()` 转小写(避免大小写差异造成假阴性);
 *   3. `replace(/\s+/g, '')` 去掉全部内部空白(不止是折叠——中英文混排时空格位置
 *      在不同轮次的复述里最不稳定,直接去掉比折叠成单空格更抗漂移);
 *   4. 截断到前 `INVARIANT_SLUG_MAX_LEN`(64)个字符。
 * 超长不变量描述截断后可能发生"前 64 字符相同、后面不同"的碰撞——这是已知、
 * 可接受的行为(一句话不变量本就该短,64 字符内说不清楚本身是另一个问题),不是
 * bug,不在这里加长度或加 hash 规避。
 *
 * 已知限制:不归一化标点(半角/全角逗号、句号等差异会产生不同 slug)。同一不变量
 * 换个标点复述,一级(slug)会未命中,退到 SKILL 5.0 的二级语义判断兜底——这是
 * 可接受的(二级是 fail-safe:顶多多花一次语义判断,不会给出错答案),不在这里加
 * 标点归一化(过度归一化标点会引入假碰撞,把两个真的不同的不变量判成同一个,风险
 * 比"退到语义兜底"更大)。
 *
 * 非字符串或去空白后为空的输入直接 `throw`,不返回空字符串——空字符串会让两个
 * 完全无关、都因为字段缺失而拿不到合法 invariant 的 family 在 join key 上碰撞,
 * 被误判成"同一个不变量复发"(静默错误,比调用方直接崩溃更危险)。调用方应在
 * `invariant` 通过 `validateFindingFamily` 的形状校验之后才调用本函数。
 */
export function invariantSlug(invariant) {
  if (typeof invariant !== 'string' || invariant.trim().length === 0) {
    throw new TypeError('invariantSlug: invariant 必须是非空字符串');
  }
  return invariant.trim().toLowerCase().replace(/\s+/g, '').slice(0, INVARIANT_SLUG_MAX_LEN);
}
