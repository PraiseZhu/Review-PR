#!/usr/bin/env node
// lib.review-profiles.mjs — 风险类型专用审查 profile + 路径 matcher + 覆盖分片 +
// 负向证据必答分类器(SC-R3 / SC-R4 / SC-R6,2026-08-05 SC v4 共识)。
//
// 缺口⑥:#469 的 19 处假等待之所以"读起来都对",是因为审查从没被要求把**测试代码当
// 判定器**审——现行 prompt 只说"看安全、看错误路径、看测试",从没问"这个测试有没有
// 可能永远绿"。profile 把这类问题变成命中路径后的**必答项**,机器核对"被问到且答了"
// (答得对不对仍是 LLM 判断,如实声明)。
//
// 内置 profile **代码层 always-on**:不能只写进 skill 的 config/pr-rules.json——
// loadRules 是三层"整文件三选一",目标仓自带配置会整体取代默认文件,内置项会凭空消失
// (第 2 轮复审点名)。这里的 BUILTIN_PROFILES 与目标仓 riskProfiles 做**增量合并**。
import { createHash } from 'node:crypto';

/** ── 路径 matcher(唯一实现,大小写敏感,全串锚定)──
 *   `**` 跨目录(含零段);`*` 单段内任意字符(不跨 `/`);其余字符字面量。
 *   语义写死并单测:`scripts/e2e/**` 匹配 `scripts/e2e/a.mjs` 与 `scripts/e2e/x/y.mjs`,
 *   不匹配 `scripts/e2eother/a.mjs`;`**\/*guard*` 这类中缀通配也支持。 */
export function matchPath(pattern, path) {
  if (typeof pattern !== 'string' || typeof path !== 'string') return false;
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` → 任意层级(含零层);裸 `**` → 任意字符(含 /)
        if (pattern[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(path);
}

/** ── 内置 profile(always-on) ── */
export const BUILTIN_PROFILES = [
  {
    id: 'test-infra',
    pathPatterns: ['tests/**', 'test/**', 'scripts/e2e/**', 'e2e/**', '**/*.test.*', '**/*.spec.*', '**/*guard*', '**/playwright.config.*', '**/vitest.config.*'],
    mandatoryChecks: [
      { id: 'async-predicate-semantics', ask: '本改动里所有等待/轮询原语的谓词是否可能返回 Promise(async 箭头、返回 evaluate/Promise 的简明体)?逐处给出结论。' },
      { id: 'swallowed-errors', ask: '是否存在 catch 后不重抛/不断言的吞错,使失败被静默?' },
      { id: 'timeout-binding', ask: '超时/等待时长是否与被等待的真实条件绑定(而不是固定 sleep 或恒满足条件)?' },
      { id: 'empty-collection-assert', ask: '断言是否会在集合为空/选择器零命中时恒真(如 forEach 空数组、expect(arr).toHaveLength(arr.length))?' },
      { id: 'tautological-assert', ask: '是否存在恒真断言(比较同一表达式、把常量与自身比、断言可选链结果非 undefined 之类)?' },
      { id: 'unconsumed-exit-code', ask: '是否有子进程/命令的退出码或返回值未被消费,失败因此不会让测试变红?' },
      { id: 'could-be-always-green', ask: '**该测试/守卫是否存在恒绿可能?给出它会变红的具体条件**——说不出会红的条件就是恒绿嫌疑。' },
    ],
  },
  {
    id: 'ci-workflow',
    pathPatterns: ['.github/workflows/**', '.github/actions/**', '**/*.gitlab-ci.yml', '.gitlab-ci.yml'],
    mandatoryChecks: [
      { id: 'permissions-surface', ask: 'workflow 的 permissions/secrets 面是否最小化?是否给 PR 触发的 job 授予了写权限?' },
      { id: 'untrusted-input-injection', ask: '是否把不可信输入(PR 标题/分支名/评论)插进 run: 脚本或表达式,形成注入面?' },
      { id: 'action-pinning', ask: '第三方 action 是否 pin 到 commit SHA(而非可变 tag)?' },
      { id: 'trigger-conditions', ask: '触发条件是否会让本 workflow 在 fork PR 上拿到 secrets,或让必需检查在某些路径下永不上报?' },
    ],
  },
];

/** ── 目标仓 riskProfiles 增量合并 ── */
export function mergeProfiles(repoProfiles) {
  const warnings = [];
  const byId = new Map(BUILTIN_PROFILES.map((p) => [p.id, { ...p, source: 'builtin' }]));
  let configIncomplete = false;
  if (repoProfiles !== undefined && repoProfiles !== null) {
    if (!Array.isArray(repoProfiles)) {
      warnings.push('riskProfiles 不是数组——目标仓声明的高危检查无法生效');
      configIncomplete = true;
    } else {
      for (const [i, p] of repoProfiles.entries()) {
        const bad = (why) => { warnings.push(`riskProfiles[${i}] ${why}`); configIncomplete = true; };
        if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id.trim()) { bad('缺 id'); continue; }
        if (!Array.isArray(p.pathPatterns) || p.pathPatterns.length === 0 || p.pathPatterns.some((x) => typeof x !== 'string' || !x.trim())) { bad(`(${p.id}) pathPatterns 非法`); continue; }
        if (!Array.isArray(p.mandatoryChecks) || p.mandatoryChecks.length === 0) { bad(`(${p.id}) mandatoryChecks 为空`); continue; }
        const ids = new Set();
        let checkBad = false;
        for (const c of p.mandatoryChecks) {
          if (!c || typeof c.id !== 'string' || !c.id.trim() || typeof c.ask !== 'string' || !c.ask.trim()) { bad(`(${p.id}) mandatoryChecks 条目缺 id/ask`); checkBad = true; break; }
          if (ids.has(c.id)) { bad(`(${p.id}) mandatoryChecks 的 id 重复:${c.id}`); checkBad = true; break; }
          ids.add(c.id);
        }
        if (checkBad) continue;
        const existing = byId.get(p.id);
        if (existing) {
          // 同 id:检查项取并集(内置项不可被目标仓删掉——那等于悄悄降低门槛)
          const merged = [...existing.mandatoryChecks];
          for (const c of p.mandatoryChecks) if (!merged.some((x) => x.id === c.id)) merged.push(c);
          byId.set(p.id, { ...existing, pathPatterns: [...new Set([...existing.pathPatterns, ...p.pathPatterns])], mandatoryChecks: merged, source: 'builtin+repo' });
        } else {
          byId.set(p.id, { ...p, source: 'repo' });
        }
      }
    }
  }
  // fail-closed(第 2 轮复审裁决):目标仓显式配置存在但有非法项时,内置与其余合法
  // profile 照常运行(继续多抓问题),同时置 configIncomplete → R1 invalid——声明过的
  // 高危检查被悄悄摘掉时不允许 clean。
  return { profiles: [...byId.values()], warnings, configIncomplete };
}

/** 文件命中哪些 profile。 */
export function profilesForPath(profiles, path) {
  return profiles.filter((p) => p.pathPatterns.some((pat) => matchPath(pat, path)));
}

/** ── SC-R3:required (profileId,fileId,checkId) 全集 ── */
export function requiredProfileAnswersFor(profiles, snapshotFiles) {
  const out = [];
  for (const f of snapshotFiles) {
    const path = f.newPath ?? f.oldPath;
    if (!path || f.changeType === 'deleted') continue;
    for (const p of profilesForPath(profiles, path)) {
      for (const c of p.mandatoryChecks) out.push({ profileId: p.id, fileId: f.fileId, path, checkId: c.id, ask: c.ask });
    }
  }
  return out;
}

/** ── SC-R6:负向证据必答分类器 ──
 * 触及"等待原语 / 断言 / 守卫调用"的 (fileId,hunkId) 恒为 required(只能由 executed
 * 满足,不接受 N/A);纯注释/文档 hunk 直接不产 required key(不靠 N/A 豁免)。
 * 判定按 hunk 的新增行文本做锚定匹配——确定性、可单测。 */
const WAIT_ASSERT_RE = /\b(waitForFunction|waitForSelector|waitForTimeout|waitFor|waitForEvent|waitForResponse|waitForLoadState|expect|assert|assertEquals|should|toBe|toEqual|toHaveLength|toThrow|process\.exit|exitCode)\b/;
const COMMENT_ONLY_RE = /^\s*(\/\/|\/\*|\*|#|$)/;

export function classifyRequiredNegativeEvidence({ profiles, files, addedLineTextByFile }) {
  const required = [];
  for (const f of files) {
    const path = f.newPath ?? f.oldPath;
    if (!path || f.changeType === 'deleted' || f.contentKind !== 'text') continue;
    if (!profilesForPath(profiles, path).some((p) => p.id === 'test-infra')) continue;
    const linesByHunk = addedLineTextByFile?.[path] ?? {};
    for (const h of f.hunks) {
      const texts = linesByHunk[h.hunkId] ?? [];
      const meaningful = texts.filter((t) => !COMMENT_ONLY_RE.test(t));
      if (meaningful.length === 0) continue; // 纯注释/空白 hunk:不产 required key
      if (meaningful.some((t) => WAIT_ASSERT_RE.test(t))) {
        required.push({ fileId: f.fileId, hunkId: h.hunkId, path, reason: 'hunk 触及等待原语/断言/守卫调用——必须给负向证据(executed)' });
      }
    }
  }
  return required;
}

/** ── SC-R4:coverage keys 分片(单席顺序分片,两类 key 都恰一个 owner)── */
export function buildSegments({ coverageKeys, sizeBudget = 60 }) {
  const segments = [];
  const budget = Math.max(1, sizeBudget);
  for (let i = 0; i < coverageKeys.length; i += budget) {
    segments.push({
      segmentId: `seg-${String(segments.length + 1).padStart(2, '0')}`,
      assignedCoverageKeys: coverageKeys.slice(i, i + budget),
      sizeBudget: budget,
    });
  }
  if (segments.length === 0) segments.push({ segmentId: 'seg-01', assignedCoverageKeys: [], sizeBudget: budget });
  return segments;
}

export function profileSetHash(profiles) {
  return `ps1-${createHash('sha256').update(JSON.stringify(profiles.map((p) => [p.id, p.pathPatterns, p.mandatoryChecks.map((c) => c.id)]))).digest('hex').slice(0, 16)}`;
}
