// static-break-glass-origin.test.mjs — 自动化不得生成授权评论(SC-6,automated-review-gate
// wave0,2026-08-08)。与 static-merge-inventory.test.mjs(合并出口唯一性)同款静态纪律。
//
// 契约:`/approve-merge <sha>` 是**人工**在 PR 评论区下达的命令(见 SKILL 5.1)——机器只允许
// 解析/消费/描述它,任何脚本都不得**生成**它。自动化产出的评论若含该命令文本,会被
// findApproveMergeAuthorization 当成真实授权消费,整套「review-pr 是唯一合并闸」被一条
// 自动化评论绕穿——这与 loop 的 PR-write token 场景(decideAuthorizedFastMerge 的 A2 封死)
// 是同一类威胁的另一半:那边封"loop 能发评论",这边封"任何脚本会发出授权命令文本"。
//
// wave0 delta(2026-08-08,lead 验收):不再硬编码"字面量只能在三个文件"——那会误伤
// 后续新增的授权策略模块(如 lib.merge-authorization-policy.mjs 只解析不投递也应合法)。
// 改为**全局不变量**,按功能而非文件名判定:
//   - SC-6a:任何脚本的非注释代码行含 `/approve-merge` 字面量 → 该文件不得含评论
//     投递调用点("能生成命令文本的文件不得是投递者");逆向同样成立——评论投递
//     脚本的非注释代码行零字面量。未来策略模块只要不投递评论就不会误伤。
//   - SC-6b:字面量只有三条消费链合法(解析/检测/人类可读描述),由 import 断言
//     钉住解析唯一性:解析必须走 lib.mjs 的 parseApproveMergeShaCommands /
//     hasApproveMergeCommand,不允许任何脚本自写解析正则(自写=可能漂移的新判定)。
//   - SC-6c(canary):detector 必须能抓住植入违规、不误伤纯注释提及——否则"现在碰巧
//     没有违规"只是侥幸,不是被断言锁住(可观测性纪律)。
// 诚实边界:本测试锁代码层;agent 在 shell 里手敲的评论不在机器承诺内(与
// static-merge-inventory.test.mjs 同款边界声明,SKILL.md 的过程纪律管那一层)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..', 'scripts');
const COMMAND = '/approve-merge';

/** 非注释代码行中含 COMMAND 字面量的位置(注释里的提及不算生成)。 */
function findCommandCodeSites(src, path) {
  const hits = [];
  for (const [i, raw] of src.split('\n').entries()) {
    const line = raw.trim();
    const isComment = line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
    if (isComment) continue;
    if (line.includes(COMMAND)) hits.push({ path, line: i + 1, text: line.slice(0, 90) });
  }
  return hits;
}

/** 评论投递调用点:任何把 body 发成评论的形态(gh pr comment / gh issue comment / --body-file)。 */
function findCommentPostSites(src, path) {
  const hits = [];
  for (const [i, raw] of src.split('\n').entries()) {
    const line = raw.trim();
    const isComment = line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
    if (isComment) continue;
    if (/--body-file/.test(line)
      || /['"`]pr['"`]\s*,\s*['"`]comment['"`]/.test(line)
      || /['"`]issue['"`]\s*,\s*['"`]comment['"`]/.test(line)) {
      hits.push({ path, line: i + 1, text: line.slice(0, 90) });
    }
  }
  return hits;
}

const allScripts = () => readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));
const fmt = (hits) => hits.map((o) => `${o.path}:${o.line} ${o.text}`).join('\n');

test('SC-6a:含 /approve-merge 字面量的脚本不得含评论投递调用点(能生成命令文本的文件不得是投递者)', () => {
  const offenders = [];
  for (const f of allScripts()) {
    const src = readFileSync(join(SCRIPTS, f), 'utf8');
    const cmdSites = findCommandCodeSites(src, f);
    if (cmdSites.length === 0) continue;
    offenders.push(...findCommentPostSites(src, f));
  }
  assert.deepEqual(offenders, [],
    `含 /approve-merge 代码形态的文件出现评论投递形态(可能把命令文本拼进自动化评论):\n${fmt(offenders)}`);
});

test('SC-6a 逆向:评论投递脚本的非注释代码行零字面量(投递脚本不得顺带生成授权命令)', () => {
  const offenders = [];
  for (const f of allScripts()) {
    const src = readFileSync(join(SCRIPTS, f), 'utf8');
    if (findCommentPostSites(src, f).length === 0) continue;
    offenders.push(...findCommandCodeSites(src, f));
  }
  assert.deepEqual(offenders, [],
    `评论投递脚本中出现 /approve-merge 代码形态:\n${fmt(offenders)}`);
});

test('SC-6b:命令解析唯一走 lib.mjs 解析函数——scripts/ 内不得自写 /approve-merge 解析正则(新判定可能漂移)', () => {
  // 解析/消费只允许通过 lib.mjs 的 parseApproveMergeShaCommands / hasApproveMergeCommand
  // / findApproveMergeAuthorization。自写正则 = 新的、未测试的判定面。
  const offenders = [];
  for (const f of allScripts()) {
    const src = readFileSync(join(SCRIPTS, f), 'utf8');
    for (const [i, raw] of src.split('\n').entries()) {
      const line = raw.trim();
      const isComment = line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
      if (isComment) continue;
      // 自写解析正则:把 /approve-merge 放进 RegExp/正则字面量/字符串匹配,且不是对
      // lib 解析函数/常量 APPROVE_MERGE_COMMAND 的引用
      if (/new RegExp\(.*approve-merge|\/approve-merge\/[a-z]*\.test|\^\/approve-merge/.test(line)
        && !/parseApproveMergeShaCommands|hasApproveMergeCommand|findApproveMergeAuthorization|APPROVE_MERGE_COMMAND/.test(line)) {
        offenders.push({ path: f, line: i + 1, text: line.slice(0, 90) });
      }
    }
  }
  assert.deepEqual(offenders, [], `scripts/ 内出现自写 /approve-merge 解析正则:\n${fmt(offenders)}`);
});

test('SC-6c(canary):detector 必须抓住植入违规、不误伤纯注释提及(反向变异,防断言虚设)', () => {
  // 植入违规:投递脚本的 body 模板里拼了命令文本 → 必须被 SC-6a/6a-逆向 抓住
  const planted = [
    'const body = `已按 owner 指示执行:/approve-merge ${HEAD}`;\ngh([\'pr\', \'comment\', \'1\', \'--repo\', \'a/b\', \'--body-file\', \'-\'], { stdin: body });',
    // 纯注释提及(行注释 / 块注释)→ 不得误伤
    '// 提醒:人工发 /approve-merge <sha> 才有效\ngh([\'pr\', \'comment\', \'1\', \'--repo\', \'a/b\', \'--body-file\', \'-\'], { stdin: body });',
    '/* 只有解析器能消费 /approve-merge(块注释) */\nconst x = 1;',
    'export const a = 1;',
    // 合法消费形态:只解析不投递的纯函数模块(未来策略模块的形态,不应被 SC-6 误伤)
    // ——字面量只在 lib.mjs 解析函数内部,消费端 import 调用、不自写正则
    'import { parseApproveMergeShaCommands } from \'./lib.mjs\';\nexport const detect = (body) => parseApproveMergeShaCommands(body);',
  ];
  assert.equal(findCommandCodeSites(planted[0], 'planted.mjs').length, 1, '模板串里的字面量必须被抓住');
  assert.equal(findCommandCodeSites(planted[1], 'ok.mjs').length, 0, '行注释提及不得误伤');
  assert.equal(findCommandCodeSites(planted[2], 'ok2.mjs').length, 0, '块注释提及不得误伤');
  assert.equal(findCommentPostSites(planted[0], 'planted.mjs').length, 1, '投递调用点必须被识别');
  assert.equal(findCommentPostSites(planted[3], 'none.mjs').length, 0, '无投递调用的文件不得误报');
  assert.equal(findCommandCodeSites(planted[4], 'pure-consumer.mjs').length, 0, '纯解析模块不含命令字面量(字面量在 lib 内部)');
  assert.equal(findCommentPostSites(planted[4], 'pure-consumer.mjs').length, 0, '纯解析模块无投递调用 → SC-6a 不拦(未来策略模块不误伤)');
  // 组合语义:planted[0] 若出现在 scripts/ 里,SC-6a 与逆向都会拦
  assert.equal(findCommentPostSites(planted[0], 'p.mjs').length > 0 && findCommandCodeSites(planted[0], 'p.mjs').length > 0, true,
    '违规样本必须同时命中投递与字面量检测');
});
