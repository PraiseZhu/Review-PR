#!/usr/bin/env node
// lib.review-output-shape.mjs — 独立代码审查输出契约(SKILL 第 4 节第 6 条「family
// 归族」)的形状校验,纯函数,零依赖,不 import lib.mjs(该文件当前由并行任务改动状态/
// 回执段,避免冲突)。
//
// 边界(对齐 conv/output-contract 的 D2 裁决):本文件只校验字段存在、severity 取值
// 合法、manifestations 结构完整、family.severity 是否等于成员最高 severity——这些
// 都是可机械判定的形状/一致性检查。它**不**、也**不能**判断"这几条 manifestation 是不
// 是真的同一个不变量"——那是审查 agent 自己的语义判断(T1),机器不能代它下结论,
// 判断不了的宁可拆成多个 family。本文件同样不判断 invariant/fixGuidance 的文字是否
// "写得对",只判断这些字段是否存在且非空。

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
