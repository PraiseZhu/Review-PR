# 阶段一：安全、格式与前置 gate

> 本文件由 `SKILL.md` 渐进披露拆出，正文与拆分前逐字一致。从 `SKILL.md` 按需 Read，不要经其它 reference 二次跳转。

## Contents

- 3. 阶段一：读取 PR、安全与隐私、格式和前置 gate
- 3.0 使用 Skill 自带的确定性脚本
- 3.0.1 确定性 preflight（SC-R2，阶段二之前必跑）
- 3.0.2 风险 profile 与审查任务构建（SC-R3/R4/R6/R7）
- 3.0.3 预扫标注（R1，advisory，2026-08-05 final SC v2，默认关闭）
- 3.0.4 测试跑法（维护者本地验证，2026-08-10 定稿）
- 3.1 安全与隐私内容门（本阶段最先执行）
- 3.2 格式门
- 3.3 目的与重复实现检查
- 3.4 产品/UI 与技术架构 gate
- 3.5 前置 gate
- 3.6 PR 依赖与合并顺序
- 3.7 Loop 托管 PR 排除
- 3.8 审查执行环境安全（security 确认门）
- 3.9 审查规则文档门（rules 确认门）
- 3.10 thread 清理（triage）：代 reply / 条件 resolve 白名单 bot 意见

---

## 3. 阶段一：读取 PR、安全与隐私、格式和前置 gate

### 3.0 使用 Skill 自带的确定性脚本

确定性步骤按 Skill 脚本执行，不自行重写判断：

```text
node "<SKILL_ROOT>/scripts/prepare.mjs"
node "<SKILL_ROOT>/scripts/context.mjs" <N>
```

`prepare.mjs` 成功获取锁时输出 `lock.token`，整轮保存；之后所有
`refresh-lock.mjs`、`release-lock.mjs`、`cleanup.mjs` 调用一律带 `--token <token>`，
脚本只操作归属匹配的锁，防止误删并发实例接管重建的锁。拿到锁后 `prepare.mjs`
会拉起 `lock-heartbeat-daemon.mjs`（每 20 分钟续一次，TTL 仍按“距最后一次心跳
60 分钟”计算），主会话**禁止**用 `refresh-lock.mjs` 当等待循环、禁止
`sleep`+再调、禁止在子 agent 未完成时反复续期。`refresh-lock.mjs` 只留给守护
挂掉时的补救；10 分钟内重复调用返回 `skipped=cooldown`，不改锁。它返回
`lost=true` 表示锁已被别的实例接管——立即停止一切 GitHub 写操作、结束本轮并
写入汇总，且不要再释放锁。

auto 批处理必须一次运行：

```text
node "<SKILL_ROOT>/scripts/context.mjs" --scan-all
```

交互模式从同一份 context 复用 `format`、`gate`、`productGate`、`archGate`、`history`
和 `meta`；auto 模式阶段一只消费 `--scan` 摘要，完整 diff 和历史交给对应审查 agent。
脚本加载或配置读取失败时停止当前 gate 并报告，不回退到一套由模型临时重写的判定逻辑。

对每个候选只拉一次完整上下文；保留 JSON 或等价记录，后续步骤复用，不重复请求：

```bash
gh pr view <N> --json number,title,body,state,isDraft,author,createdAt,updatedAt,\
baseRefName,headRefName,headRefOid,files,commits,comments,reviews,\
statusCheckRollup,mergeStateStatus,reviewDecision,url
gh pr diff <N> --patch
```

同时取得所有分页的 issue comments、review comments/threads 和 commits，按时间从新到
旧阅读。不要只看 diff：历史讨论里可能已有设计决定、已解决问题或仍未解决的承诺。

### 3.0.1 确定性 preflight（SC-R2，阶段二之前必跑）

已知的**机器可判定** bug 模式不再押给 LLM 概率判断——命中即机器打回，不经审查 agent：

```bash
node "<SKILL_ROOT>/scripts/review-preflight.mjs" --base <baseRefOid> --head <headOid> \
  --out <preflight.json> \
  --expected-paths "$(gh pr view <N> --json files --jq '[.files[].path]|join(",")')"
```

`--base` 取 `gh pr view <N> --json baseRefOid` 的返回值——baseRefOid(PR 分叉点),不是 base 分支当前 tip;
误用 `origin/main`(当前 tip)会让 snapshot 漂移,preflight 与 task 重建都应锚在分叉点上。

- 首发规则：Playwright `page/frame.waitForFunction` 收到 async / 返回 Promise 的谓词
  （#469 的 19 处假等待就是这一类：Promise 恒 truthy，1ms 假通过，CI 全绿但什么都没等）。
  **承诺面**：只认 lexical `page`/`frame` 接收者；alias、解构、容器传参持有的对象不在
  机器承诺内（那类靠 3.0.2 的 profile 必答兜）。`locator.waitFor` 与 `vi.waitFor(async)`
  是合法用法，有零误报 fixture 钉死，不会误报。
- **归因**：只有落在本次**真正新增/修改的行**上的命中才阻断；既存命中记 `reportOnly`
  （写进汇总，不打回作者——不拿 PR 之前的旧账算在作者头上）。
- **fail-closed**：parser 缺失/版本不符、语法错文件、DiffSnapshot 不完整 →
  `complete:false`，本轮 `consume-review-output` 判 `invalid`。**禁 regex 降级**：
  解析不了绝不当成"没命中"。parser 是 `vendor/typescript`（钉版本 + PROVENANCE.json
  记 sha256/来源，无 node_modules fallback）。
- 目标仓可用 `reviewPreflight.disabledRuleIds` 声明式停用某规则——只接受**声明式参数**，
  永不执行来自 PR head 的规则代码。

### 3.0.2 风险 profile 与审查任务构建（SC-R3/R4/R6/R7）

`build-review-task.mjs` 是阶段二任务的**唯一**构建器（见第 4 节；逃逸候选的数据源默认由它
**自己现场取**（`gh pr view --json body,closingIssuesReferences`），`--pr-body-file` /
`--related-issues-file` 只是离线/测试 seam；元数据互检需要文件清单时传
`--expected-paths <逗号分隔>`）。它按路径命中把
`test-infra`（tests/**、scripts/e2e/**、*guard*、playwright/vitest 配置）与 `ci-workflow`
（.github/**）两套**必答清单**注入任务，逐 `文件×检查` 作答——这一层解决的正是"审查
从没被要求怀疑测试本身"：`could-be-always-green` 那条要求审查者说出"这个测试在什么
条件下会红"，说不出就是恒绿嫌疑。内置 profile 在**代码层 always-on**，与目标仓
`riskProfiles` 增量合并（目标仓可加不可删）；目标仓配置有非法项时内置照跑（继续多抓
问题）但本轮判 `invalid`（声明过的高危检查不允许被悄悄摘掉）。

### 3.0.3 预扫标注（R1，advisory，2026-08-05 final SC v2，默认关闭）

阶段二独立审查**之前**可选的一层轻量机器辅助观察，用于捕捉"陈旧注释""漏改引用"
"术语残留""测试 import 缺失""文档声明与实现不符""明显笔误"六类确定性 preflight
（3.0.1）覆盖不到、但又不需要正式审查那样深的语义理解的问题。**默认
`prescan.enabled:false`**（`pr-rules.json`），关闭时 task/prompt 与基线逐字节一致，
不产出任何 artifact。

**架构要点（与 submit-pr 的 Phase 1.5 自清洗预扫不是同一种机制）**：本 skill 审的是
外部贡献者的 PR，lead 不能替作者改代码，所以预扫产物不是"自己修掉"，而是"标注给
正式审查席处置"——机制上更接近数据，不是修复动作。执行侧本身不是脚本外拨的 HTTP
调用：巡审会话本身已由 mini schedule 预设跑在特定模型上（如
`deepseek/deepseek-v4-flash`），预扫是**会话内的一个步骤**，不需要、也不接受
`apiKeyEnv`/`model`/`endpoint` 这类网络调用配置——`prescan` 配置只有 `enabled` 一个键。

流程（`enabled:true` 时）：

```bash
node "<SKILL_ROOT>/scripts/prepare-prescan-segment.mjs" <N> --base <baseRefOid> --head <headRefOid> --order <1..N>
```

先过安全门（敏感内容命中/扫描失败 → 拒绝输出任何 patch，零内容外发），再按与阶段二
同一 `buildSegments` 分段算法给出该段的 path/行区间/immutable patch。巡审会话对
该段内容产出严格 JSON（六类白名单闭集，禁 verdict/severity/修复建议，无可疑项返回
`[]`），交：

```bash
node "<SKILL_ROOT>/scripts/record-prescan-segment.mjs" <N> --order <1..N> --segment-id <segId> \
  --base <baseRefOid> --head <headRefOid> --observations <observations.json>
```

严格校验（JSON 外任何文字/未知字段/未知 category/跨段文件引用/line 不在新增行/note
空或超长一律整段拒绝，不"尽力解析部分内容"）；`observationId` 由机器派生，不接受
模型自报。全部段记录完成后：

```bash
node "<SKILL_ROOT>/scripts/record-prescan-segment.mjs" <N> --finalize --base <baseRefOid> --head <headRefOid>
```

产出 `complete` artifact（三 hash 绑定：inputHash/policyHash/artifactHash），供
`build-review-task.mjs` 读取填入 `task.prescan`（只留承诺字段与总数，不含明细）、
`deliver-review-segment.mjs` 按段附带该段 observations 给阶段二审查会话。**正式
审查 agent 必须对每条已投递的观察给出 `prescanAssessments[]` 里的
`{observationId, disposition:"finding"|"dismissed", findingRef?, basis}`**——
`finding` 需引用真实 `findingFamilies` 条目，`dismissed` 需非空依据；观察本身**不
直接驱动 dirty**，只有确认后的正式 finding 才计入裁决。

**T1 边界（如实声明）**：机器保证的是观察从生成到消费全程未被篡改、按段隔离投递、
正式审查席逐条给出处置——**不能**验证观察内容本身的语义正确性（"这条注释是不是真的
陈旧"仍是审查 agent 的判断）。`enabled:false`、或本轮状态为 `skipped`/`failed`，
**不降低**任何既有机器保证（preflight/覆盖对账/负向证据/逃逸闭环照常运行）。

### 3.0.4 测试跑法（维护者本地验证，2026-08-10 定稿）

全量测试的标准跑法（在 `review-pr/` 目录下）：

```text
node --test tests/*.test.mjs
```

- 覆盖 `tests/` 下**全部** `*.test.mjs`，包括自断言形态的脚本
  （如 `tests/signoff-policy-script.test.mjs`——它不是 node:test 声明，靠模块顶层
  自断言 + `process.exit(1)` 报失败；`node --test` 加载它计 1 条文件级条目，
  断言失败会使该文件转红）。
- `tests/` 目录之外**不得**存在任何 `*.test.mjs`——否则它不会被上面的 glob 覆盖，
  成为标准跑法之外的裸奔测试（2026-08-10 事故：`scripts/signoff-policy.test.mjs`
  曾坐在 glob 之外，四个策略函数(isUiTestPath / decideIssueReuse /
  shouldCloseDiscussionIssue / classifyGateHits)的唯一测试从全量里漏掉，七轮审查
  与四份终审均未发现）。`tests/test-file-location-guard.test.mjs` 机器强制此约束，
  任何 `tests/` 之外的 `*.test.mjs` 都使全量转红。
- 两个产物门单独跑：`node --test tests/build-dist.test.mjs` 与
  `node --test tests/preview-dist.test.mjs`（产物重建后必须全绿）。

### 3.1 安全与隐私内容门（本阶段最先执行）

任何 PR 都不允许携带凭证、密钥或个人隐私数据——这是先于格式门的第一道审计。
`context.mjs` 的 `security` 字段是确定性扫描结果，覆盖 PR 标题、body 与 diff 全部
新增行（内置模式 + `config/pr-rules.json` 的 `sensitiveContent` 扩展；判定逻辑单一
来源在 `scripts/lib.mjs` 的 `scanPrSensitiveContent`，`pre-merge-check.mjs` 在
授权快速合并通道合并前对当前 head 也调用同一份函数重新现场扫描，见 5.1「授权快速
合并通道」）：

- **硬命中（`security.hardHits`）**：私钥块、AWS／GitHub／GitLab／npm／Slack／Google
  凭证、`sk-` 系 API key 等高置信格式。存在任一硬命中即本门不通过：不进入代码审查、
  不合并。交互模式展示命中清单（文件、行号、类型）后确认打回；auto 模式按
  `auto.action=pushback-security` 输出打回结论（preview 版：REQUEST_CHANGES 评论与 5.4 fix-handoff 已剥离，结论写内部审查输出，由 owner 在正式流程落地）。打回必须同时要求：
  ① 从分支历史中彻底移除敏感内容（仅追加一个删除 commit 不算完成，历史仍可见）；
  ② 立即轮换已泄露的凭证——内容一经推到远端即视为已泄露，无论 PR 是否合并。
- **软命中（`security.softHits`）**：疑似密码／token 字面量赋值、JWT、手机号、
  身份证号、邮箱等。不直接阻断，由阶段二审查 agent 逐条定性：确认是真实凭证或
  真实个人数据记 **P0**（安全或凭证泄露红线），测试桩、占位符、公开示例则放行并在
  报告 Verification 中说明定性依据。
- `security.scanned=false`（diff 拉取失败）不得视为通过：交互模式提示需人工确认；
  auto 模式可继续进入审查，但审查 agent 必须自行核对完整 diff 无凭证与隐私数据后
  才能给 pass，并在 Verification 写明"敏感内容为人工核对"。
- **输出纪律**：打回评论、内部汇总、各类通知一律只写文件、行号与类型，绝不引用
  命中原文；`security` 字段里的样本已脱敏（前缀 + 长度），不要用 `gh pr diff` 等
  方式还原后再输出。
- 误报治理走配置而不是口头放行：`sensitiveContent.allowPaths` 豁免测试夹具等已知
  误报路径，`extraHardPatterns`／`extraSoftPatterns` 追加项目自有格式。豁免只用于
  降软命中噪声，不得用来放行真实凭证；对硬命中拿不准时一律从严打回。

本门优先级最高：即使 PR 同时命中产品/UI 或架构 gate，也先按本门打回（凭证已在
公网，越早轮换越好），讨论流程等作者清理完再走。

### 3.2 格式门

严格按当前 `.github/PULL_REQUEST_TEMPLATE.md` 检查：

- Title 的 type、scope 和描述符合模板；不要凭旧 skill 硬编码类型；
- “这次改了什么”“怎么验证的”“风险”三个部分存在且是实质内容；
- 自动验证、手工验证、未执行验证如实填写，不能用“已测试”代替命令与结果；
- 变更类型、影响范围、breaking change、UI 证据和回滚信息与 diff 相符；
- **UI 证据提醒（非阻断，2026-07-25 起不再是格式门）**：`format.uiCodeFiles` 非空
  （改动命中 `uiPaths` 下的非文档文件，`uiExcludePaths` 内的多语言 locale 等纯文案
  数据文件、`.md` 文档与 `.d.ts` 纯类型声明不算——后两者不可能产生视觉变化）而
  Description 未附界面效果证据时，`context.mjs` 置 `format.uiEvidenceMissing=true`
  并生成建议文案 `format.uiEvidenceNotice`。**缺证据不打回、不计入格式问题、不阻断
  审查与合并**；处理方式是把 notice 作为一条普通 PR 评论发给作者（投递与去重见下方
  「UI 证据提醒评论」），请其补充截图／录屏，或改动后界面的 HTML 页面（```html
  代码块、.html 附件或在线预览链接）。
  证据存在性在这里判（`format.bodyUiEvidenceKinds` 标明 image／html）；已附证据时，
  内容与 diff 是否一致、界面是否符合 `ruleFiles.uiRequired` 列出的设计规范，仍在
  阶段二由审查 agent 判（见第 4 节第 7 条）；
- 命中数据库、system prompt、协议、原生层、权限／安全、跨平台或远程／手机规则时，
  Description 必须有对应结论。

格式不合格时：

- 交互模式先展示缺项（preview 版：不提交 `REQUEST_CHANGES` 评论，打回结论写内部审查输出）；
- auto 模式只输出一次结构化打回结论（preview 版：评论动作已剥离）；
- 格式问题是 P1，不把文案风格偏好写成阻断项。

**UI 证据提醒评论**：`format.uiEvidenceMissing=true` 时，把 `format.uiEvidenceNotice`
作为一条普通评论发到 PR 上，正文末尾附去重标记
`<!-- review-pr:ui-evidence-notice -->`；发送前先在已拉取的评论历史里查该标记，
已存在即不重发（同一 PR 只提醒一次）。交互模式发送前照常确认；auto 模式可直接
发送（与 notify-author-resolve 的一次性提醒评论同级，发送失败不阻塞流程）。提醒
不改变任何 gate 结论，也不因作者不补证据而升级为阻断；`selfFixAuthors` 的 PR
同样只发这条提醒（或 ownPr 时不发），**禁止**把缺口并进跟进会话消息——5.4 已停用。
`auto.ownPr=true`（viewer 与作者是同一个账号，即本流程账号自己开的 PR）时不发本
评论——收件人就是本流程账号自己，评论没有收件人，只会在 PR 上堆无人消费的噪音；
证据缺口照常写进报告与汇总，gate 结论不变。**被 skip 的候选本轮不发 UI 证据提醒**——
等它进入处理轮次再发（提醒无时效价值，避免同一作者同轮收多条噪音；skip 语义见
6.1 扫描阶段）。

### 3.3 目的与重复实现检查

对 `feat`、可见产品行为、Agent／Skill／插件和跨端能力，先从 PR body、关联 issue 和
仓库搜索确认：

- 用户要完成的真实工作是什么，改动是否仍保持单一目的；
- 仓库是否已有相同入口、共享符号或可复用能力，是否只是重复包装底层 Agent；
- 能力应属于 Core、Agent、Skill 还是插件，是否增加普通用户的配置和理解负担；
- 是否说明 Desktop、Mobile、SSH 远程和设备互联中哪些已适配、哪些有跟踪 issue。

这一步不能用主观“感觉重复”直接打回：没有事实时交互模式询问用户或作者，auto 模式
标记 `needs-context` 并跳过。若确认违反产品原则或产生重复入口，再按 P1 进入审查报告。

### 3.4 产品/UI 与技术架构 gate

本仓库维护者必须先消费 `context` 的 `productGate`、`archGate` 与 `signoff` 字段，
再进入普通代码审查（`signoff.triggers` 是 security/rules 两门 + arch 触发器的统一
命中事实，`signoff.suggestedHolds` 是编排要执行的 hold 建议，消费规则见 3.8/3.9
与本节下方「payload 合同」）：

- 产品/UI gate：按 [references/internal-gates.md](internal-gates.md) 判定
  `exempt`、`needsProductCheck`、白名单同意（讨论 issue 留言与 PR 评论区直接回复
  同等采信）和 UI/产品语义；
- 技术架构 gate：产品 gate 未命中时，按 `archGate.triggers`、技术白名单和讨论
  issue / PR 评论区同意判定是否属于较大架构调整；
- mobile 冷更（`archGate.coldUpdate.trigger` 非空）走同一道门，但判定既不看改动大小、
  也不受本门常规豁免：谁改手机端会触发冷更的代码都要进一步确认——作者身份、普通
  Approve、标回 Ready 都不算放行，只认 `coldUpdate.approvers` 里的把关人明确针对冷更的
  表态，名单内成员自己提的 PR 也要显式确认（口径与两种 trigger 的处置见
  [references/internal-gates.md](internal-gates.md)「mobile 冷更（runtime
  fingerprint）触发器」）；
- 真正命中产品/UI 时运行 `signoff-hold.mjs --kind product`，真正命中架构调整时运行
  `signoff-hold.mjs --kind arch`（与 security/rules 两门共用同一套统一 hold 机制，
  product-hold.mjs / product-release.mjs 旧文件保留为兼容入口，新编排一律走
  signoff-hold（signoff-release 写入/摘标签脚本尚未合入，当前由维护者按本 SKILL 手工操作））；hold 动作 = 开讨论 issue + 发状态评论（带隐藏
  标记）+ 挂 `awaiting-discussion` 标签，**不再转 draft**（2026-08-09 起标签制取代
  draft 制：draft 带来的 hold↔ready 死循环与 PAT 权限问题随之消失，真正挡合并的是
  流程内部判定，标签只是 GitHub 后台的可筛性入口）；动作必须幂等（重复 hold 复用
  既有讨论 issue，`decideIssueReuse` 语义，见 tests/signoff-policy-script.test.mjs）；
- **payload 合同（写死，缺失即拒绝主动作）**：`issueTitle`/`issueBody`/`commentBody`
  三字段全部非空，生成来源 = 门类模板（模板 D）+ PR 上下文（PR 号、作者、触发路径、
  把关人），由主 agent 按「对外话术与人格边界」撰写（人格关闭，第一句先澄清"不是
  代码问题"），经 `--payload-file`（推荐 `-` 走 stdin）传给 signoff-hold；脚本返回
  `reason=missing-payload` 时**不得计为 held**（`held=false`），必须在轮次汇总里
  如实记录「缺 payload 未 hold」，补 payload 重试，不能当「已拦截」收尾；
- **hold 成功判据 = 三件套全成功**：标签 + 状态评论 + 讨论 issue 三样都成功才算
  held；`issueCreated=false` / `commented=false` / `labels.changed=false` 任一失败
  必须显式进轮次汇总（脚本输出逐字段可查），不得静默降级为「只打了标签」；
- auto 模式 issue 新建成功后按配置发送一次讨论通知；交互模式在 issue、评论和通知
  发出前逐项确认；
- 放行判定（release）：**admins 名单成员的 GitHub Approve**
  （`signoff.adminsApprovedCurrentHead=true`）；白名单在讨论 issue 或 PR 评论区任一处
  明确同意（产品/架构门口径）后由维护者按本 SKILL 手工摘标签（signoff-release.mjs 尚未合入，零测试，已从本批移出、另立 PR 并带测试），
  不能把摘标签留给作者；存量被旧 draft 制 hold 成 draft 的 PR，在门判定为不拦 /
  已放行时用 `gh pr ready` 一次性迁移恢复（幂等，已 ready 即跳过）；
- **持久放行**：跨 commit 持久的载体是**放行标记**（signoff-release marker 评论，白名单
  明确同意后由维护者按本 SKILL 发出，评论作者须为 admins 名单成员）——被标记确认过的
  **门类**跨 commit 持久放行，作者再 push 不重新亮门；**未确认过的新门类首次触发仍拦**
  （确认只放行它当时覆盖的门类，不连带放行之后新出现的门类，如旧的 security 确认不会
  放行新出现的 rules 门）。这是本仓对上游（PR 全局持久）的刻意收窄，不是与上游对齐。
  **Approve 不跨 commit 持久**：admin Approve 绑定当前 head oid
  （`adminsApprovedCurrentHead`），只一次性确认当前 head 上已触发的门类；作者再 push
  后若该门类没有放行标记，门重新亮。当前接线到本机制的触发门类为 security / rules；
  product / arch 走 signoff-hold 既有流程（放行仍按 admins Approve 判定），coldUpdate
  / pluginBase 为上游口径，本仓无对应接线；
- **放行时关闭讨论 issue（决策已落地，执行接线随 signoff-release.mjs 另立 PR）**：
  放行生效时的关闭**决策**已随 scan 输出（`closeOnRelease`）落地——只认 hold marker
  的评论作者 ∈ admins 名单成员（本机制 viewer 账号在 admins 名单内，故机制自建 marker
  可通过校验；marker 文本形状可被任何有评论权限的账号复制，身份不可伪造）；close 的
  **执行动作**（关 issue 与失败原因进轮次汇总）随 signoff-release 写入脚本另立 PR
  接线，接线前自动关闭未生效；
- 合并后仍可运行 `close-product-issue.mjs` 兜底（`--sweep` 覆盖网页手动合并遗留），
  避免讨论 issue 悬挂。

产品/UI gate 和架构 gate 的详细名单、阈值、Slack 归属、通知去重与异常处理见
[references/internal-gates.md](internal-gates.md)。Bugfix、已有功能补充和
纯技术改动不因路径命中就机械 hold，语义拿不准时从严。

### 3.5 前置 gate

在进入代码审查前必须确认：

1. PR 仍是 open、非 draft，且 base/head 没有在读取后变化；
2. 没有冲突（`mergeStateStatus` 不为 `DIRTY`；若状态过期，重新拉元数据）；冲突且
   满足 5.5 条件时**仅交互模式**可走主干侧冲突代合并（auto 不合、写入汇总）；交互模式下若同时还有审查 P0/P1，可由用户
   选择 5.6 代修合并一并处理；其余情况等作者处理；
3. 所有 review conversation 都已 resolve；bot 也不能因“是 bot”而自动忽略；
4. head commit 上**所有已上报检查**（含非 required 的 check-run / commit status，如
   跑在 PR 上但未升门的检查与第三方 App 审查）没有失败或仍在运行——
   `mergeStateStatus=UNSTABLE`（GitHub 判可合并但有非 required 检查未过）同样算
   gate 未过，脚本按 statusCheckRollup 判定；fork workflow 等待批准时不擅自批准；
5. 旧 reviewer 的 `CHANGES_REQUESTED`、issue comment 中明确的阻断意见已有对应修复
   和证据；不要仅因 comment 被 resolve 就判定代码已改；
6. 没有未落地的前置依赖（见 3.6）：被依赖的 PR 未合并时，本 PR 可以审查，但不进入
   合并。

交互模式 gate 未过时停下来，用人话列出阻断原因，再询问是否仅继续读取上下文；没有
明确同意不进入审查。auto 模式跳过该 PR并写入汇总；未 resolve thread 与冲突类跳过
按第 6 节阶段 1 给作者发一次性提醒评论,不让作者对被卡原因无感知。无法判断时按阻断处理。

### 3.6 PR 依赖与合并顺序

多个 open PR 之间可能有先后关系（如 PR1 是功能、PR2 是它的 fix），必须先合被依赖者，
不能反序。依赖按两类识别：

- **硬依赖（确定性）**：PR 的 `baseRefName` 不是默认分支，而是另一个 open PR 的
  head 分支（stacked PR）。此时“合并”只会合进那个分支而不是默认分支：base PR 未
  合并前不合并本 PR；base PR 合并后 GitHub 会自动把本 PR retarget 到默认分支，此时
  重新拉元数据、等 CI 在新 base 上重跑后再按正常流程落地，不凭旧数据直接合。
- **软依赖（声明或语义）**：PR body、标题或评论声明 `depends on #N`、“基于 #N”、
  “修复 #N 引入的问题”；或 fix/feat PR 的改动明显建立在另一个 open PR 新增的代码
  之上（文件重叠时由主 agent 或审查 agent 判断）。识别到即视为“先 #N 后本 PR”。

执行规则：

- 落地顺序按依赖关系排序，其余仍按 `createdAt` 升序；被依赖 PR 尚未合并时，依赖方
  记 skip（reason: `depends-on-#N`），写入汇总，下一轮或被依赖者落地后同轮补入；
- 依赖成环或声明与 base 关系矛盾时不猜测，按阻断处理并点名维护者；
- 交互模式发现依赖时明确告知“应先合 #N 再合本 PR”，用户坚持反序才反序，并在
  review/汇总中记录该决定；
- 审查本身不受依赖限制（可以先审后合），但审查 agent 应把“依赖的代码尚未合入”
  与“代码本身有问题”区分开，不把前者写成 P0/P1。

### 3.7 Loop 托管 PR 排除

一些接入仓库有自己的自动修 bug loop，其托管的 PR 由 loop 自己合并、自己播报，
review-pr 不应重复审查或合并，避免两套合并主体打架。配置在 `pr-rules.json` 的
`loopPrExclusion`（缺省或 `null` = 整套机制关闭）：

- `titlePrefix`（legacy 单值 string）/ `titlePrefixes`（数组 string[]，新配置推荐用
  这个）：loop 自己开的 PR 标题固定前缀，二者可同时配置——目标仓库的 loop 改名后
  新旧前缀并存的迁移期，两个前缀都要认，命中任一即算匹配。**仅命中前缀不足以认定
  托管**——任何贡献者都能在自己 PR 标题前加同样的字面量冒充托管，骗过
  `defaultWhenAmbiguous` 的默认 skip 让自己的 PR 永久漏审。`detectLoopExclusion`
  （`lib.mjs`）还要求 `stateFile` 指向的本地台账里按 PR 号精确命中该条记录，查不到
  就按普通 PR 处理；命中后返回的 `matchedPrefix` 是实际命中的那一个前缀字面量
  （不能假设一定是 `titlePrefix` 的值——配置了 `titlePrefixes` 时可能命中数组里的
  任一项）；
- `t1BodyMarkers`/`t2BodyMarkers`：body 里 loop 自己声明 T-level 的 metadata 行
  （锚定整行的正则，逐行匹配），命中优先采信；都没命中退回台账的 `cluster.tCap`；
- `defaultWhenAmbiguous`：身份已确认但读不出 T-level 时的保守默认（`skip`）；
- `forceVerdict`（**缴械配套**——「缴械」指 owner 2026-08-04 决策 `mergeAuthority=review-pr-only`：
  剥除目标仓库自身 loop 的自动合并权，合并权整体移交 review-pr 巡审；本节 A2/A4/A5 均是这条
  决策在 skill 侧的配套落地）：
  配置后身份确认即**强制 t2 进全套审查**，优先于 `t1BodyMarkers`/`t2BodyMarkers` 与
  `cluster.tCap`——loop 侧数据（body 标记/台账 tCap）漂移回 T1 也不能再造成跳审。
  唯一有意义的取值是 `"t2"`；任何非空值都收敛为 t2（fail-safe 朝「进审」方向,
  `source=force-config-coerced` 供识别拼写漂移），身份门槛（stateFile 台账命中）
  **不被 force 绕过**——台账查不到仍按普通 PR 走全套审查。目标仓库缴械后应配置本键；
- T1（或拿不准）→ `context.mjs` 的 `auto.action=skip-loop-managed`，优先级最高，
  压过产品门/架构门/格式门/前置门（但让位于安全与隐私门硬命中——凭证泄露必须打回）；
  T2 → 正常走 review-pr，但格式门做两处豁免：标题判 type 前先剥掉 `detectLoopExclusion`
  返回的 `matchedPrefix`（`titleForFormat`），段落存在性检查整体豁免
  （`wantSections=[]`，loop 的 body 遵循自己的证据结构，不是本仓 PR 模板的三段式，
  逐字匹配注定误判缺段落）；
- **loop 托管 PR 一律无缘授权快速合并通道**（A2，缴械配套）：`pre-merge-check.mjs`
  在 fast-merge 判定前用同一份 `detectLoopExclusion` 判身份，命中（不分 t1/t2）即封死
  `authorizedFastMergeAvailable`（`blockedReason=loop-managed-pr-fast-merge-forbidden`）
  ——loop 的 PR-write token 能发评论，不封则一句 `/approve-merge <sha>` 就能骗巡审代合。
  3.8 末尾「authorized-fast-merge 可压过安全审查门」的例外对 loop PR 因此不存在；
- 合并后的致谢播报（A4，缴械配套）：`notify-merge-ack.mjs` 挂在 review-pr **自己执行合并**
  的流程末尾；`notify-merge-backfill.mjs` 每轮 auto 补扫一次近期 merged PR，补发维护者在
  GitHub 网页手动合并、agent 无从感知因而漏播的致谢（两者共享同一份去重台账，互认已播）。
  两者判定同一份 `detectLoopExclusion`，**只跳「仍自管」的 PR（verdict=t1/skip）**——
  t2/force-review 的 loop PR 由 review-pr 合并，致谢也由本侧播报（缴械后一刀切会把全部
  t2 致谢吞掉）。`mergeAckNotify.notifyModule` 未配置时播报能力整体关闭；
- **事后审计闸**（A5，缴械配套）：`scripts/audit-merged-loop-prs.mjs` 每轮扫上轮游标
  以来 merged 的 loop 托管 PR，核 head-bound clean 审查回执（receipt 层三条：存在 /
  headRefOid 逐字相等 / verdict=clean，不重建 stage2 hash——保证等级如实声明在脚本头）。
  核不过 → 定向 T0 告警（复用 `SLACK_OPS_ALERT_CHANNEL_ID` 私聊出口）+ 经 GitHub 原生
  `revertPullRequest` mutation 自动开 ready 的 revert PR（仍走巡审审合，本闸只开不合）。
  幂等台账按 `<pr>:<mergeOid>` 记账；首跑只立游标不回溯（缴械前的历史合并本就无回执）。
  **游标推进边界**：游标不是每轮无条件推到 now——只有当窗口内每条 loop 合并都已到
  remediation 终态（clean 回执通过 / revert PR 已创建且告警真送达）才推进；存在未解决
  的（revert 创建失败或告警配置了却没送达），游标停在这些 PR 里最早的 mergedAt，让
  下一轮窗口重新纳入重试（`decideCursorAfterRemediation`）。唯一豁免：**告警能力关闭**
  （`mergeAckNotify.notifyModule` / ops 频道未配置，仓库级长期状态而非"这次失败"）且
  revert 已创建 → 允许游标越过，否则未配置告警的仓库游标会永久卡死；该豁免不写
  `alerted`（那个字段语义严格是"真送达"），所以这类 entry 若因别的 PR 卡住游标而被
  重扫，会无害地重算一遍（能力关闭是本地短路，不产生网络调用，revert 幂等不重开）——
  这是已知冗余，刻意换取判据简单。告警送达判定与 `notify-sync-alert.mjs` 同款
  （api/webhook 算送达，degraded 降级不算），发送时摘掉 webhook 防 T0 告警漏进致谢群。
  **接线**：auto 模式每轮在 `prepare.mjs` 拿到锁后、批处理开始前跑一次
  `node "<SKILL_ROOT>/scripts/audit-merged-loop-prs.mjs"`，输出进当轮汇总;
  `loopPrExclusion` 未配置时天然 no-op。
  **保证等级如实声明**：这是**过程保证**，不是机器保证——本 skill 全仓只有一处确定性
  spawn（`pre-check.mjs` → `record-escaped-finding.mjs`），其余脚本一律由 agent 按本文
  逐条执行，本闸同此惯例。因此「漏网合并最迟一轮内被发现」的前提是**agent 真的跑了这一
  步**；某轮漏跑则该轮不产生任何告警，且因游标只在真跑时推进，下一次跑会把跨过的窗口
  一并审到（漏跑=延迟，不是永久漏审——这是刻意选的失败方向）。想要机器级必跑需把它挂进
  scheduler hook，但 `pre-check.mjs` 的契约是「轻量、快、exit 2 表示无活可做」，塞进 gh
  查询与可能的 revert PR 创建会破坏该契约，故未做；如需升级应另立独立 hook。

### 3.8 审查执行环境安全（security 确认门）

`pr-rules.json` 的 `securityReviewPaths`（缺省为空 = 门关闭）列出自动化自身有
执行/供应链能力面的路径：review-pr 自身脚本/配置、CI workflow/actions、部署的
skill 定义、package.json 与常见 lockfile 等。目的是防自动化改坏自己，不是防外部
攻击——auto 批处理会 checkout 到 PR 分支再跑一部分确定性脚本 / 读取
`pr-rules.json` 配置本身，若继续让 review-pr 用可能已被这次改动改坏的自己版本去
自动审查并合并这次改动，会形成"改坏的版本审过并合入了自己"的自我损坏闭环。

命中即 `context.mjs` 的 `auto.action=security-gate`（`signoff.triggers.security`
非空），按维护者确认门（signoff）执行 hold——**不再静默 skip**（三门空转 = 命中
无动作，正是 2026-08-09 要接通的缺陷）：挂 `awaiting-discussion` 标签 + 开讨论
issue + 发状态评论，等 admins 名单成员（`admins`）显式 Approve 放行
（`signoff.adminsApprovedCurrentHead=true` 时本门不拦）。放行按门类持久：security
门已有放行标记后作者再 push 不重新亮门，未确认过的新门类首次触发仍拦（见 3.4；Approve 绑定
当前 head、不跨 commit 持久）。放行前不自动审、不
自动合；放行后按 `auto.fallback` 继续原走向。优先级仅次于 3.7 的 loop 托管排除，
压过产品门/架构门/格式门/前置门，同样让位于安全与隐私门硬命中。是否启用、纳入
哪些路径由目标仓库自己按贡献者可信度模型配置。**保证等级如实声明**：本门是
T1（防疏忽/漂移）——把「命中安全面改动却无人确认」这个大概率疏忽变成显式等待；
不冒充 T2（防恶意伪造），恶意者总能改掉配置本身，那不属于本门能力面。

**唯一例外**：有 `/approve-merge` 授权时 `auto.action=review-complete-hold-merge`
（见 5.1「授权快速合并通道」）——auto **仍不合**，只把「人工已过的凭证」写入汇总，
等交互/人手合。`mergeAuthorization.breakGlassApprovers` 名单成员发出的
`/approve-merge <当前 head 完整 40 位 SHA>`（head 绑定，见 5.1）本身就是「人工已过的凭证」，
不需要 review-pr 再转一次人工。泄密硬门（`security.hardHits`）仍优先级最高，本门
与授权通道谁都压不过它。

### 3.9 审查规则文档门（rules 确认门）

`pr-rules.json` 的 `ruleFiles.required`（缺省为空 = 门关闭）列出审查规则文档
（AGENTS.md、CLAUDE.md、docs/dev-rules/ 等）——规则文档是后续所有审查的判据来源，
改它等于改审查标准本身，需要 admins 确认。

命中即 `context.mjs` 的 `auto.action=rules-gate`（`signoff.triggers.rules` 非空），
按维护者确认门（signoff）执行 hold（`signoff-hold.mjs --kind rules`），口径与 3.8
完全一致：挂标签 + 开讨论 issue + 状态评论，admins Approve 即放行（放行按门类持久——
跨 commit 靠放行标记，Approve 绑定当前 head，见 3.4；放行前不自动审、不自动合，放行后按
`auto.fallback` 继续）。优先级低于 security
门（命中 securityReviewPaths 时不走本门），不覆盖已包裹的 product-gate / arch-gate；
`ruleFiles.required` 未配置时本门永不出现。`ruleFiles.ruleMap`（规则文档 → 管辖
路径映射）命中明细随 `signoff.triggers.ruleMapHits` 带出，供编排辅助定性，不单独
构成触发。保证等级同 3.8：T1（防疏忽/漂移），不冒充 T2。

### 3.10 thread 清理（triage）：代 reply / 条件 resolve 白名单 bot 意见

分支保护开了 `Require conversation resolution` 时，thread 不 resolve 就 GitHub 层面
合不了；而 bot（greptile 等）从不回来点 resolve，作者修完也常忘点——「threads
unresolved 连续多轮整轮空转、停滞十几天」的 PR 就是这个原因（#251 型）。auto 模式
在扫描后、合并判定前执行本清理；交互模式先把可处理清单（路径 + 拟回复）展示给
用户、确认后执行。

**设计（2026-08-09 三轮收敛，回复优先）**：「意见是否已被处理」是 LLM 语义活，
字符串分析证明不了——diff 里新增两行普通埋点 + 一句 justification 即可绕过任何
token 共现判据（PR #13 R2 blocker 实测成立），原 `assessThreadEvidence` 判据（及其
`extractThreadTokens` 词表）已删除。因此本机制的价值在**回复**（把对话推进下去，
可纠正），不在**关闭**。对 `context.history.reviewThreads` 里未 resolve 的 thread
逐条：

1. **reply 无条件**：白名单 bot thread 且 thread 内无白名单外参与者时，按调用方
   payload 发回复（回复引用修复 commit 与位置，供人复核；文案不声称机器已验证修复
   正确性——本动作是 T1 防遗漏收口）。只认白名单 bot——`pr-rules.json` 的
   `threadTriage.extraBots` 登录名单（首配 `greptile-apps`；未配置 = 整套机制关闭，
   一条都不动）。白名单校验不止查位置首条评论：**同一 thread 里任何一条评论的作者
   若不在白名单内**（真人参与讨论），该 thread 永不处理；**唯一豁免是本脚本自己
   （viewer 身份）的评论**——marker 形状的评论若作者不是 viewer，照常参与白名单
   校验（文本谁都能复制，身份不能）；
2. **resolve 默认不执行**，只在**机器可核实**条件下才做（由 `resolve-threads.mjs`
   执行层判定，不依赖调用方 payload 里 `justification` 的内容——非空字符串对
   不可逆的对外 resolve 动作不构成充分条件）：
   - 线程已是 resolved（幂等，`already-resolved`）；
   - **上一轮己方已 reply 同一 headSha**：thread 评论里有 viewer 身份作者的本脚本
     marker（`state=replied`、`sha` 与本次 `headSha` 一致）、**marker 年龄 ≥ 人工
     反对窗口**（`MIN_MARKER_AGE_MS`，默认 10 分钟，从评论 `createdAt`——GitHub 侧
     字段——推导，不引入本地时间状态），且白名单复核仍通过（回复后无真人异议）→
     resolve，成功后再追加 `state=resolved` marker；
   - 己方 marker `state=resolved` 但线程又变 unresolved → 人工翻案
     （`skipped-reopened-after-triage`），**永久留人工**，不与人拉锯。
   其余情况一律只回复不关闭；
   **年龄门保护的是人工反对窗口，不是防抖动**：D1 之所以允许 auto-resolve 存在，
   靠的是「回复与关闭之间存在一段人可以介入反对的时间」。若双实例重叠（定时巡审 +
   手动运行）时窗口塌成 0，两阶段就退化成单轮自动 resolve——故 marker 必须在窗口期
   之后才允许 resolve；窗口期内重新运行只 `replied-only`，不重复回复。

   **年龄门 env 校验（R4）**：`MIN_MARKER_AGE_MS` 可用环境变量
   `REVIEW_PR_MIN_MARKER_AGE_MS` 覆盖（ms 单位），但执行层会显式校验——解析失败 /
   负值 / 低于下限 60000ms（1 分钟 = "人来得及看见"的最小可感知窗口，更小在语义上
   退化成"无窗口"，几乎必然是单位/量级配置错误）一律回落默认 10 分钟，并在 stderr
   与输出 JSON 的 `warnings` 字段双通道警告。**禁止用"把年龄设成奇怪数字"关闭年龄
   门**（`-1`/`0` 曾可悄悄关掉守着不可逆动作的这道门）——要关闭只能显式设
   `REVIEW_PR_DISABLE_MARKER_AGE_GATE=1`（仅用于运维一次性批量清理积压 thread），
   执行层会大声输出"年龄门已关闭，本轮 resolve 不保留人工反对窗口"。门关闭只豁免
   年龄条件；marker 缺 `createdAt` 的保守不 resolve 不豁免。
3. **marker 可信度 = 评论作者身份**（执行层 GraphQL `viewer { login }` 比对），pr
   号 / thread id / sha 都是公开信息，文本形状可被任何有评论权限的账号复制，身份
   不可伪造。**状态全部在 GitHub 侧（评论 + 线程 resolve 状态），无本地回执**——
   tmp 清理 / 换机器 / 无状态 CI runner 都不影响下一轮判定；
4. **三种终态必须可区分**：`replied-only`（已回复未关闭）/ `resolved` /
   `skipped-<reason>`（拒绝原因，如 `skipped-non-whitelisted-comment-present` /
   `skipped-reopened-after-triage` / `skipped-resolve-failed` / `skipped-reply-failed` /
   `skipped-thread-not-found` / `skipped-lock-busy`）。resolve 失败不重发回复（reply
   上一轮已发），下一轮同 headSha 自动重试 resolve。

> **启用前提（D7，未满足前不得配置 `threadTriage`）**：本机制默认关闭
> （`pr-rules.json` 不含 `threadTriage` key）。三轮对抗复审给出的 blocker（字符串
> 判据可被普通埋点绕过、并发至多一次、bot 白名单覆盖全部评论、marker 身份绑定、
> 回执跨运行持久性）全部关闭验证通过之前，禁止新增该 config key 启用本机制；
> 启用只能由后续独立评审确认全部验收条件后进行，不得借本节文档改动顺带打开。
>
> **自动 resolve 目前不提供**。要在将来启用，以下两项都必须先满足（缺一不可）：
> 1) 一个能**机器核验「缺陷确实被修复」**的判据。已尝试并被实测否决的方案：
>    token 子串命中、≥2 独立 token 共现、共现（必要）+ 编排层 justification
>    （充分）。否决理由：两行普通埋点（如 `telemetry.increment("X")` /
>    `trace.debug("Y")`）即可让未修复的意见判定为可 resolve（PR #13 R2 blocker
>    实测）；且执行层不接收 diff，无法独立复核。
> 2) 生产者→判据的形状适配（context 导出 `lastComment`/`isBot`，判据消费
>    `body`/`authorType`），并配一条**从真实 context 输出出发**的端到端契约测试。
> 当前两项均不满足。仅提供 auto-reply（可纠正），不提供 auto-resolve。

**执行**：把可处理清单逐条生成 reply payload（回复必须引用修复 commit 与位置，供人
复核；文案不声称机器已验证修复正确性——本动作是 T1 防遗漏收口）。每条附上
`justification`（编排层对「为什么这段 diff 回应了这条 claim」的说明——**契约字段，
非 resolve 判据**：resolve 由执行层按上面的机器可核实条件决定），调：

```bash
node "<SKILL_ROOT>/scripts/resolve-threads.mjs" <PR> --payload-file - <<'JSON'
{
  "threads": [ { "id": "<history.reviewThreads[].id>", "reply": "已在 <sha> 处理(<修复位置>);有异议可 reopen", "justification": "<为什么这段 diff 回应了这条 claim 的说明>" } ],
  "allowedBots": ["<pr-rules.json threadTriage.extraBots 登录名单>"],
  "headSha": "<sha>"
}
JSON
```

（脚本只执行调用方给定的 payload，不自选 thread——**不接编排则 #251 型停滞仍会
skip**，这正是本节的接线职责。`allowedBots` 缺失或为空、或某条 thread 缺
`justification` 时脚本执行层 fail-closed，一条都不动，即使 payload 里给了 thread id
也不例外。）

**回流与汇总**：消费脚本输出的 `results[]`——`outcome: resolved`（含
`already-resolved`）计入已 resolve；`replied-only` 计入已回复（下一轮同 headSha
重跑时脚本将自动 resolve，若期间有真人异议则白名单复核会拦住）；`skipped-<reason>`
逐条显式进轮次汇总，不得静默混为一谈：**可重试**（`skipped-thread-not-found` /
`skipped-reply-failed` / `skipped-resolve-failed` / `skipped-lock-busy`）下一轮可再次
尝试；**永久**（`skipped-reopened-after-triage`）不再重试，永久留人工。resolved 后
对涉及该 PR 的合并判定**重算 threads 阻断**（重新拉 `mergeStateStatus`，或按「未
resolve thread 计数归零」处理），不凭清理前的旧计数判定。回复会通知原 reviewer，
对方可一键 unresolve（unresolve 后按 `skipped-reopened-after-triage` 永久留人工）。
**幂等**：脚本对已 resolve / 已回复过的 thread 不重复动作（双并发下每 thread 至多
一次 reply + 条件 resolve，靠脚本内查当前状态 + 持久锁兑 TOCTOU 窗口）。
