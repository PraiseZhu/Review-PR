// model-switch.mjs — 「换审查机模型」的纯函数(维护者 2026-10-18):Mini 上三个 Cindy 自动化(主审 / 备用 / 核对员)
// 各自选好模型和思考档位,运行时 models/switch.mjs 先派服务器验证(models/check.mjs),通过才写对应的角色变量。
// 这里只放映射、校验、判定与告警,不调网络、不读环境。
import { ROLE_ENV, ROLE_EFFORTS, SERVER_MODEL_RE, parseRoleModel, TIER_DEFAULTS, FALLBACK } from './models.mjs';

export const ROLES = Object.keys(ROLE_ENV);
export const ROLE_TEXT = { primary: '主审', fallback: '备用模型', verifier: '核对员' };
export const CHECK_WORKFLOW = 'review-model-check.yml';
export const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
// 测试时临时覆盖单档主审的变量:有它们时主审角色变量不生效(lib/models.mjs 的优先级)。
export const TIER_OVERRIDE_VARS = ['LIGHT', 'STANDARD', 'HEAVY'].flatMap((t) => [`MIVO_REVIEW_MODEL_${t}`, `MIVO_REVIEW_EFFORT_${t}`]);

/**
 * Cindy 自动化里选的模型 → 服务器网关上的模型 id。
 * 末段是 gpt-/o 系 → openai/<末段>(覆盖 Cindy 的 openai/、codex/、openai-codex/ 与裸 id)。
 * 否则 raw 恰好是「来源/模型」一段斜杠、且来源不是 codex / openai-codex / chatgpt → 原样作为网关 id(再过 SERVER_MODEL_RE)。
 * 裸的非 gpt id 被拒:非 gpt 模型要选网关同名的来源(如 xd),id 形如 deepseek/xxx。
 * 能不能真的用由服务器验证(模型清单 + Codex CLI 冒烟)决定。
 */
export function toServerModel(cindyModel) {
  const raw = String(cindyModel ?? '').trim();
  if (!raw) throw new Error('没有读到自动化选的模型');
  const parts = raw.split('/');
  const base = parts.at(-1);
  if (/^(?:gpt-|o\d)[A-Za-z0-9._-]*$/i.test(base)) {
    const model = `openai/${base}`;
    if (!SERVER_MODEL_RE.test(model)) throw new Error(`模型 id 不合法:${model.slice(0, 80)}`);
    return model;
  }
  const source = parts[0];
  if (parts.length === 2 && !['codex', 'openai-codex', 'chatgpt'].includes(source)) {
    if (!SERVER_MODEL_RE.test(raw)) throw new Error(`模型 id 不合法:${raw.slice(0, 80)}`);
    return raw;
  }
  throw new Error(`非 gpt 模型要选网关同名的来源(如 xd),id 形如 deepseek/xxx;自动化选的是 ${raw.slice(0, 80)}`);
}

export function toEffort(effort) {
  const value = String(effort ?? '').trim();
  if (!value) throw new Error('没有读到自动化选的思考档位,请先在自动化里选好档位');
  if (!ROLE_EFFORTS.includes(value)) throw new Error(`思考档位不合法:${value.slice(0, 20)}(可选 ${ROLE_EFFORTS.join(' / ')})`);
  return value;
}

export function toRole(role) {
  const value = String(role ?? '').trim();
  if (!ROLES.includes(value)) throw new Error(`角色不合法:${value || '空'}(可选 ${ROLES.join(' / ')})`);
  return value;
}

/** 写进角色变量的值。model / effort 是服务器认的两项;其余只是记录,不影响审查。 */
export function toRoleValue({ model, effort, cindyModel, provider, checkRunId, setAt }) {
  return JSON.stringify({ model, effort, cindyModel: cindyModel ?? null, provider: provider ?? null, checkRunId: checkRunId ?? null, setAt });
}

/** 各角色现在生效的模型(变量合法用变量,否则默认值;核对员默认值来自 review-features.json)。 */
export function toEffectiveRoles(variables, verifierDefault) {
  const pick = (role, fallbackValue) => parseRoleModel(variables[ROLE_ENV[role]]).value ?? fallbackValue;
  return {
    primary: pick('primary', { model: TIER_DEFAULTS.standard.model, effort: TIER_DEFAULTS.standard.effort }),
    fallback: pick('fallback', { ...FALLBACK }),
    verifier: pick('verifier', verifierDefault ? { model: verifierDefault.model, effort: verifierDefault.effort } : null),
  };
}

/**
 * 切换前必须满足的条件:返回阻断原因(null 表示可以切)。主审角色被单档覆盖变量压住时切了也不生效,先让人删掉。
 */
export function toSwitchBlocker({ role, variables }) {
  if (role !== 'primary') return null;
  const present = TIER_OVERRIDE_VARS.filter((name) => String(variables[name] ?? '').trim());
  return present.length ? `仓库里还有测试用的单档覆盖变量 ${present.join('、')},它们优先于主审角色变量,切了也不生效;请先删掉这些变量` : null;
}

/** 切换后的独立性与备用告警(不阻断,给人看)。 */
export function toSwitchWarnings({ role, target, effective }) {
  const next = { ...effective, [role]: target };
  const warnings = [];
  if (next.fallback && next.primary && next.fallback.model === next.primary.model) {
    warnings.push(`备用模型和主审是同一个模型(${next.primary.model}):主审失败时不会再换备用模型重试`);
  }
  if (next.verifier && next.primary && next.verifier.model === next.primary.model) {
    warnings.push(`核对员和主审是同一个模型(${next.primary.model}):主审成功时核对员会改用主审配置,还相同就不核对,P1 照常阻断`);
  }
  return warnings;
}

/**
 * 服务器验证结果(check.json)能不能放行这次切换。返回 { ok, reason, warnings }。
 * 只认这次请求:request_id、角色、模型、档位都要对上。主 key 通过即可;主 key 报 key 本身的错误而备用 key 通过也算
 * (模型和档位已证明可用,只是主 key 现在有问题)。备用 key 没通过只告警。
 */
export function toCheckVerdict(check, { requestId, role, model, effort }) {
  if (!check || typeof check !== 'object') return { ok: false, reason: '服务器验证没有产出结果', warnings: [] };
  const mismatch = [['requestId', requestId], ['role', role], ['model', model], ['effort', effort]].find(([k, v]) => check[k] !== v);
  if (mismatch) return { ok: false, reason: `服务器验证结果对不上这次请求(${mismatch[0]})`, warnings: [] };
  const primary = check.keys?.primary;
  const backup = check.keys?.backup;
  const warnings = [...(Array.isArray(check.warnings) ? check.warnings : [])];
  if (backup?.configured && !backup.smoke?.ok) warnings.push(`备用 key 用这个模型没通过验证(${backup.smoke?.error || '原因未知'}):主 key 出问题时换不过去`);
  if (!backup?.configured) warnings.push('服务器没有配置备用 key');
  if (primary?.smoke?.ok) return { ok: true, reason: '主 key 验证通过', warnings };
  if (primary?.smoke?.keyFailure && backup?.smoke?.ok) {
    return { ok: true, reason: '主 key 现在报 key 错误,备用 key 验证通过', warnings: [...warnings, `主 key 现在不能用:${primary.smoke.error || primary.smoke.keyFailure.kind}`] };
  }
  const listed = primary?.models;
  const missing = listed?.ok && listed.present === false ? `;网关模型清单里没有 ${model}` : '';
  return { ok: false, reason: `${primary?.smoke?.error || check.reason || '验证没有通过'}${missing}`, warnings };
}
