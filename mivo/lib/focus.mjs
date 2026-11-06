// focus.mjs — 任务书「审查重点与不重做」一节(#188,总 issue #132)。
// 借鉴 makecindy/cindy REVIEW.md §3「不要重复机器门禁」、§4「重点看机器查不到的部分」。
// CI 已覆盖的全量命令放 config/review-features.json 的 focus.ciCovered:context 只有 gate.ci 总状态、没有通过检查的名单,
// 要名单得改共享脚本 review-pr/scripts/context.mjs。清单来源是 Mivo .github/workflows/ci.yml 在每个 head 上跑的 job。
// 开关文件只在这里读;prompt.mjs 只拿读好的清单(prompt.mjs 不直接读开关文件,见 verify.test.mjs 的守卫)。
import { readFileSync } from 'node:fs';

/** 读 focus.ciCovered;没有 focus 块时是空清单(不告警),不合法时是空清单并给 warning。 */
export function loadFocusConfig(file, read = readFileSync) {
  let raw;
  try { raw = JSON.parse(read(file, 'utf8')); } catch (error) {
    return { ciCovered: [], warning: `review-features.json 读不到或不合法(${String(error.message).slice(0, 120)}),focus.ciCovered 按空清单处理` };
  }
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(raw) || (raw.focus !== undefined && !isObject(raw.focus))) {
    return { ciCovered: [], warning: 'review-features.json 的顶层或 focus 块不是对象,focus.ciCovered 按空清单处理' };
  }
  const list = raw.focus?.ciCovered;
  if (list === undefined) return { ciCovered: [], warning: null };
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string' && item.trim() && item.length <= 200)) {
    return { ciCovered: [], warning: 'review-features.json 的 focus.ciCovered 不是字符串数组,按空清单处理' };
  }
  return { ciCovered: [...new Set(list.map((item) => item.trim()))].slice(0, 30), warning: null };
}

/** 任务书的「审查重点与不重做」一节:CI 总状态为 pass 且有清单时才列「CI 已覆盖」。goalLine 替换 ① 的默认说法(产品规则开着时用)。 */
export function toFocusLines({ ciStatus = null, ciCovered = [], goalLine = null } = {}) {
  const lines = [
    '## 审查重点与不重做',
    '',
    '按下面的顺序分配时间。顺序只决定先看哪里、在哪里多花时间,**不缩小审查范围**:④ 仍要覆盖「本轮范围」的全部内容。',
    '',
    goalLine ?? '- ① 本 PR 要做成什么:本轮没有子 issue 与产品规则材料,跳过 ①。',
    '- ② 作者交接的风险:有作者交接(下文「作者交接」一节)时,先对 review.md 第 3 节每条 R 按「怎么证明我错了」在当前代码上动手证伪;没有交接就跳过 ②。',
    '- ③ 改动地图:review.md 第 2 节每行的「必须保持的不变量」和「直接下游」是否保持;没有交接时,自己从 diff 找出每个改动点的直接下游再核对。',
    '- ④ 其余 diff:共享符号与调用方、错误与回滚路径、持久化与协议、安全与数据外发。',
    '',
    '规则文档:rule-map「所有 PR」必读的文档只核对与本 diff 相关的条款,Rule coverage 每份文档写一行(相关条款的结论,或「与本 diff 无关」),不逐条展开无关条款;按改动路径命中的规则文件照常逐条审。',
  ];
  if (ciStatus !== 'pass' || !ciCovered.length) return lines;
  return [...lines,
    '',
    'CI 已覆盖、不要重跑:当前 head 的 CI 全绿,下面这些全量命令已在 Mivo CI(`.github/workflows/ci.yml`)跑过:',
    ...ciCovered.map((command) => `- \`${command}\``),
    '不要在工作目录里重跑它们;Verification 写「CI 已覆盖:<命令>」,这不算「未执行」。只跑与 ② 的 R、你准备报的问题直接相关的定向测试(例如 `npm run test:unit -- <路径>`)。',
  ];
}
