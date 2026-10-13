# Mivo 补丁清单

本仓的 `review-pr/` 与 `review-pr-auto/` 等于 lizi 上游 `makecindy/cindy-lizi-skills` 的同名目录，
再叠加下面这些补丁。上游版本记在 `tools/lizi-sync.json`（当前 `7b882cf`）。

- 核对：`node tools/sync-lizi.mjs --check`。差异只能来自本清单登记的文件，否则退出码 1。
- 升级：`node tools/sync-lizi.mjs --to <新 SHA>`。没补丁的文件直接换新；有补丁的文件三方合并，冲突会列出。
- 代码里每处补丁都带 `[MIVO-PATCH <编号>]` 注释，方便升级时对照。

## 不导入的上游内容

| 路径 | 原因 |
|---|---|
| `review-pr/history/` | Cindy 自己的运行归档（约 1000 个文件、446 MB） |
| `review-pr/EVOLUTION.md`、`review-pr/evolution/`、`scripts/evolution-note*.mjs` | 自进化台账。每轮登记会让流程越来越长，Mivo 不用 |
| `scripts/sync-skill-repo.mjs`、`scripts/skill-sync.test.mjs` | 台账和 skill 自动回推 main。Mivo 按钉住的 SHA 运行，不自动回推 |
| `review-pr/docs/` | 上游开发文档（飞书汇总历史的设计稿） |

文档里的台账步骤一并删掉：`review-pr-auto/SKILL.md` 第 5 节、第 4 节开头的台账登记、
`references/coordinator.md` 的台账段、`review-pr/SKILL.md` 第 7 节的「记台账」、`internal-gates.md` 的脚本表。

## 补丁

| 编号 | 改了什么 | 文件 | 为什么 |
|---|---|---|---|
| config | 取值换成 Mivo；去掉 Cindy 的人名、群 ID、名录仓 | `config/pr-rules.json` | Mivo 自己的路径、名单和门槛 |
| maintainer-allowlist | `maintainerSource=allowlist` 时维护者只取 `maintainerAllowlist`，不读 CODEOWNERS；每个成员都要核实对仓库有 write 及以上权限，digest 绑定成员和权限 | `scripts/lib.mjs` | Mivo 的 CODEOWNERS 根 Team（`@xindong/art-support`）与维护者对不上 |
| exempt-authors | 新增 `signoffGate.exemptAuthors`：名单作者免审查前的维护者确认门，不给放行权；hold 写操作同样拒绝 | `scripts/lib.mjs`、`scripts/context.mjs`、`scripts/pr-write-guard.mjs` | 豁免名单（含 zhongxingtian-ai）和放行名单要分开 |
| self-review | 维护者确认门只看维护者本人的表态：审查账号（viewer）自动提交的 review（门禁打回带 `<!-- review-pr:` 标记，审查结论带「Mivo 自动审查」报告头）不传给 `evaluateMaintainerReview`；维护者本人手动的 review 照常计入 | `scripts/lib.mjs`（`isAutomatedViewerReview`）、`scripts/context.mjs` | Mivo 的审查账号也是维护者。上游 Approve 后紧接着合并，不会再有新 head；Mivo 是 review-only，PR 在自动 Approve 后继续开着：自动 Approve 会放行之后才出现的确认门，自动打回会让确认门判「等作者改」，作者只补描述时不再往下审（2026-10-12 评估 F1/F2） |
| slack-release | Slack 讨论串回复「同意放行」视为放行。三条同时满足才算：评论作者是同步 bot 且带 `slack-inbound` 标记；署名 `@login` 是维护者且不是 PR 作者；回复有一整行是同意短语且没有否定词。按 release 标记口径持久有效；状态回帖写两种通过方式 | `scripts/lib.mjs`、`scripts/context.mjs`、`scripts/signoff-hold.mjs` | Mivo 要求 Slack 和 GitHub 都能放行。上游只把 Slack 留言当参考 |
| ui-evidence | `signoffGate.product.enabled=false` 时产品/UI 门不触发（feat 类型和 UI 路径都不再等维护者确认）；`requireUiEvidence=non-exempt` 时，维护者与 `exemptAuthors` 以外的作者改了界面却没附截图/录屏或 HTML，缺证据记进 `formatIssues`，按格式门打回；`all` 对所有作者生效；缺省不要求（上游行为）；`acceptNotApplicable=true` 时作者在「效果展示」第一行写「不涉及」也算过 | `scripts/lib.mjs`、`scripts/context.mjs` | 维护者 2026-10-12 决定：改界面不拦，只要求作者提供 HTML 或截图验证；只改逻辑或注释、看不出界面变化的，写「不涉及」即可 |
| protected-contact | 受保护路径提醒里的人工处理人改为可配置（`protectedPaths.contact`），缺省仍是上游的 Lizi | `scripts/notify-author-resolve.mjs` | Mivo 联系 PraiseZhu |
| ci-ignore | `ciIgnoreContexts` 里的 check（Mivo 的 `review-pr`）和 `ciIgnoreWorkflows` 里的 workflow（新审查自己的 `review-pr.yml`、切换后退役的旧三席 `code-review.yml`）不计入作者 CI 判定；`ciIgnoreBotChecks` 里的评审 bot check（Greptile 的信心阈值检查 `Greptile Review`，低于 4/5 会判 failure）同样不计入，它的具体意见以 thread 出现、由 thread 门拦；GitHub 报 `UNSTABLE` 而原因只是这些被忽略的 check 没通过时，不再判「CI 状态读取不完整」；必需检查核对仍用原始数据。BLOCKED 只因 `review-pr` 这个必需检查还没上报或没通过时，不算结构性卡点 | `scripts/lib.mjs`、`scripts/context.mjs`、`scripts/pre-merge-check.mjs` | `review-pr` 是本流程自己写的结果，不能反过来拦住自己（否则送审前就被它卡死）；旧三席留在 PR 上的历史失败也不是作者的 CI |
| bot-check-settle | 机器人静默期把「机器人在当前 head 上的 check 跑完」也算作表态（`botReviewSettle.checkNames`，Mivo 配 `greptile-apps → Greptile Review`）；仍要再静默 `quietMinutes` | `scripts/lib.mjs`（`botCheckActivity`）、`scripts/context.mjs`、`scripts/pre-merge-check.mjs` | Greptile 没有意见时只发总结评论、不提交 review，上游只看 review 和行内评论，认不出它已审完，干净的 PR 每次都要等满 30 分钟超时 |
| auto-notices | `reviewOnlyNotices=auto` 时，review-only 轮的目标分支提醒用 auto 措辞 | `scripts/notify-round-targets.mjs` | Mivo 以 review-only 模式运行，但会自动重审，「请重新运行 review-only」的说法不对 |
| no-summary | 没配汇总群时，轮次收尾接受 `status=disabled` 的通知回执 | `scripts/review-queue.mjs` | Mivo 不发每轮汇总（2026-10-11 决定） |
| rule-map | 整份换成 Mivo 的规则导航（来源：Mivo `AGENTS.md`「改什么，先读哪里」） | `references/rule-map.md` | 上游是 Cindy 仓的映射 |
| test-rules | 上游的配置取值测试改读 `REVIEW_PR_RULES_FILE`；上游测试用 `tools/fixtures/upstream-pr-rules.json` 运行 | `scripts/approval-policy.test.mjs` | 生产配置换成了 Mivo 的值，上游用例仍要验证上游行为 |

只改配置、不改代码的部分：bot 静默期只等 `greptile-apps`（静默 5 分钟，最多 30 分钟）；
Git 历史推送只对 `makecindy/cindy` 生效，对 Mivo 天然不触发；飞书卡片只生成不发送。

## 新增文件

| 文件 | 作用 |
|---|---|
| `review-pr/scripts/mivo-patches.test.mjs` | 上面补丁的回归测试 |
| `tools/sync-lizi.mjs`、`tools/sync-lizi.test.mjs`、`tools/lizi-sync.json` | 上游同步与差异核对 |
| `tools/fixtures/upstream-pr-rules.json` | 上游配置夹具（群 ID 换成占位值），只给上游测试用 |
| `mivo/` | Mivo 的拆分运行胶水：Mini 前置审查、服务器后置审查。见 `mivo/README.md` |
| `.gitleaks.toml` | 只放行上游 `maintainer-authority.test.mjs` 里的假锁 token（`12345678-abcd`），其余沿用 gitleaks 默认规则 |

## 测试

```bash
# 上游自带测试，按上游配置运行
REVIEW_PR_RULES_FILE="$PWD/tools/fixtures/upstream-pr-rules.json" node --test review-pr/scripts/*.test.mjs
# Mivo 补丁与胶水测试，按 Mivo 配置运行
node --test review-pr/scripts/mivo-patches.test.mjs tools/*.test.mjs mivo/**/*.test.mjs
```

`review-worktree.test.mjs` 在符号链接或路径映射过的临时目录里有 5 个用例会因路径别名失败，
在普通文件系统（Mini、审查服务器、GitHub Actions）上通过。
