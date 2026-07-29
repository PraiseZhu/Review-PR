# review-pr 自进化台账

自动生成:由 `scripts/evolution-note.mjs` 从 `evolution/ledger.json` 再生成,**手改本文件会被覆盖**。
条目按根因 fingerprint 去重;分类与落地规则见 SKILL.md 第 8 节。

## 待维护者拍板(扩权类提案,永不自动落地)

- `nonrequired-thirdparty-ai-check-blocks-merge` **非 required 的第三方 AI 审查 App check FAILURE 与真正 CI 失败同归 ci-failed** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: open
  - 现象:本轮 PR 318:分支保护的 9 项 required check 全部 SUCCESS,唯一 FAILURE 来自非 required 的第三方 AI 审查 App(check-run)。SKILL 3.5 第 4 条规定「所有已上报检查」失败即 gate 未过,所以阻断本身是设计如此;问题在归类与汇总口径——blockClass 统一记 ci-failed,owner 从汇总看不出是「构建/测试挂了」还是「AI 审查 App 给了 FAILURE 结论」,两者的处置动作完全不同(前者改代码,后者读意见或决定是否纳入阻断集)。
  - 提案:两个方向请 owner 拍板:① 仅改汇总口径(低风险):在 skip 行文里点出失败 check 是否属 required,不新增 blockClass 值,不改任何 gate 判定;② 放宽阻断集(扩权类,须显式授权):在 pr-rules.json 增加 nonBlockingCheckAllowlist,命中的非 required check 失败不计入前置门。②会放宽 gate,永不自动落地。
- `ui-evidence-false-positive-on-nonvisual-src-paths` **uiPaths 用 src/ 前缀判 UI 面,把纯函数/Agent 动词模块也判成 UI,uiEvidenceMissing 误报** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: open
  - 现象:mivo-canvas#325 命中:uiCodeFiles = src/agent/{snapshotRegion,canvasAgentVerbs}.ts 等纯函数与 Agent 动词模块(零 React、零 JSX、零 CSS、零用户可见文案),因 uiPaths 含 'src/' 前缀被判 UI 面 → uiEvidenceMissing=true。本轮因 auto.ownPr=true 抑制了提醒评论,没造成实际噪音;若作者不是本流程账号,就会收到一条要求给纯函数 PR 补截图的评论。审查 agent 独立判定为误报。
  - 提案:目标仓 pr-rules.json 的 uiExcludePaths 增补非可视路径前缀(如 ^src/agent/、^src/model/、^src/render/ 中的纯契约资产),或把 uiPaths 从 'src/' 收窄到真正的 UI 目录(src/app/、src/canvas/、public/、index.html)。属目标仓配置、由 owner 拍板,不自动落地。
- `stale-mergeable-after-same-round-merge` **同一轮内合并后,GitHub 的 mergeable/MERGEABLE 对余下候选是过期结论,pre-merge-check 直接采信** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: open
  - 现象:本轮合并 #319、#334 后,#325 的 pre-merge-check 仍报 mergeable=MERGEABLE、blockClass=structural-check(看起来可 admin bypass 合)。我手动跑 git merge-tree --write-tree origin/main <pr-head> 才发现真冲突(src/agent/canvasAgentVerbs.test.ts,与本轮落地的 #334 相撞)。GitHub 重算 mergeability 有延迟,期间 UNKNOWN 或沿用旧值;若照采信就会对一个实际冲突的 PR 走合并路径。
  - 提案:pre-merge-check 增一道本地交叉校验:当 PR 的 base 在其最后一次 CI 之后前进过(或 mergeable 为 UNKNOWN)时,跑 git merge-tree --write-tree <base> <head> 实测,冲突则把 blockClass 定成 conflict、不采信 GitHub 的 MERGEABLE。纯读操作、不新增写权限。
- `review-agent-pr-checkout-worktree-conflict` **审查 agent 用 gh pr checkout 会在 PR 分支已被其他 worktree 占用时失败** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: open
  - 现象:PR #335 审查：主流程自己在 /private/tmp 用同名分支开了 worktree,阶段二审查 agent 在隔离 worktree 里跑 gh pr checkout 335 直接失败(cannot checkout: branch used by worktree)。agent 自行 workaround 成 git fetch + git checkout --detach <headRefOid> 才拿到码。这不是 skill 判定缺陷,只是审查 agent 模板没有预案,每次都要靠 agent 自己临场绕。
  - 提案:在 SKILL.md 第 4 节的审查 agent 任务模板里,把「gh pr checkout <N>」改为优先 detached checkout：git fetch origin <headRefOid> && git checkout --detach <headRefOid>(主 agent 已从 context.meta.headRefOid 拿到确切 sha,不依赖分支名是否被占用),并说明 gh pr checkout 仅作退路。
- `own-pr-has-no-merge-path-when-selffix-empty` **自有 PR 在 auto 模式下无任何合并路径(selfFixAuthors 空 + 不能自批准)** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: open
  - 现象:mivo-canvas 首轮 5 个候选里 4 个是 owner(PraiseZhu)自己开的。GitHub 禁止同账号 approve 自己的 PR,所以 reviewDecision 恒为空;internal-gates 要求 structural-check 的 admin bypass 必须 reviewDecision=APPROVED;selfFixAuthors 留空又关掉了 selfMergeAvailable 的 admin self-merge 路径。结果 #319(CI 全绿、thread 全 resolve、唯一阻断是永不上报的 code_scanning/code_quality 门、账号 canBypass=always)也只能跳过转人工。自有 PR 的未 resolve thread(#324/#325)同理只能作者本人处理。auto 模式对该仓 owner 的 PR 实际退化为纯审查。
  - 提案:两条路,均属扩权类须 owner 拍板:(A) 把 owner 加进 pr-rules.json 的 selfFixAuthors,启用现成的 selfMergeAvailable admin self-merge 路径(条件仍要求零 P0/P1、无冲突、thread 全 resolve);(B) 为 structural-check 的 admin bypass 增加「viewer==author 时豁免 reviewDecision=APPROVED」的例外。倾向 A——A 复用已有且已被审计过的路径,B 会放宽一条通用安全条件。
- `structural-bypass-approved-vs-repo-without-required-approval` **结构性 BLOCKED 的 admin bypass 条件含 reviewDecision=APPROVED，在不要求 approve 的仓库里永不可达，导致 context.mjs 判的 bypass-structural-block 实际无法落地** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: open
  - 现象:mivo-canvas 分支保护不要求 approve,reviewDecision 恒为空(历史 #295/#283/#314 全部以 reviewDecision="" 合并)。code_scanning/code_quality 两个必需检查从不上报结果,PR 恒为 structural-check BLOCKED。context.mjs 给 auto.action=bypass-structural-block(理由写「自动 admin bypass 合并」)、pre-merge-check 给 structuralBypassAvailable=true,但 SKILL 5.1 把 --admin 授权交给 internal-gates.md 177-180,后者要求 reviewDecision=APPROVED,该条在本仓无法满足 → 每个 PR 都卡在合并 gate。本轮 PR #316(审查 0 P0/P1、14 项 CI 全绿、无未 resolve thread)因此按「跳过并报告」处理,未合并。SKILL 5.3 的表述里没有 APPROVED 这一条,与 internal-gates 不一致,是两处文本的口径漂移。
  - 提案:需 owner 拍板二选一:①(推荐)把 internal-gates 177-180 的 reviewDecision 条件改为「reviewDecision 不是 CHANGES_REQUESTED,且若仓库要求 approve 则必须为 APPROVED」——即区分「approve 是门」与「approve 不是门」两类仓库,并同步 SKILL 5.3 措辞;②保持现状,则本仓所有 PR 的最终合并动作固定转人工,应在 pr-rules.json 里显式关掉自动合并,避免每轮都产生一条「等你拍板」的噪音。属放宽 admin bypass 条件,扩权类,不自动落地。
- `changelog-data-file-hits-uipaths` **public/changelog.json 是纯数据文件却命中 uiPaths,每日误报 UI 证据缺口** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: open
  - 现象:mivo 仓 uiPaths 含前缀 public/,uiExcludePaths 为空,于是每日 changelog 补扫 PR 都被判 uiEvidenceMissing=true。该文件是 Change Log 面板的数据源,改动确实会让面板多一行文案,但截图证据价值极低(渲染结构/组件/样式零改动),要求截图属噪音。
  - 提案:在目标仓 agent-use/docs/pr-rules.json 的 uiExcludePaths 增 public/changelog\\.json。注意该文件在 securityReviewPaths(^agent-use/)内,且本仓禁止直推 main,改动须走 PR + 人工审查,不能自动落地。
- `own-pr-structural-block-no-approval-path` **本流程账号自有 PR 撞结构性 BLOCKED 时无任何放行路径,会永久堆积** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: open
  - 现象:结构门自动 admin bypass 的安全前提含 reviewDecision=APPROVED(internal-gates「作者侧与仓库侧 gate」)。当 ownPr=true(viewer=作者)时该前提永远拿不到:GitHub 禁止自批准(422),而唯一豁免 approval 的 selfMergeAvailable 路径要求作者在 selfFixAuthors 名单内。xindong/mivo-canvas 的 selfFixAuthors 首周故意留空,于是每日 chore 更新日志补扫 PR(作者=本流程账号)审查全过、CI 全绿、0 未 resolve thread,仍只能跳过,需人工合并,不合就逐日累积。
  - 提案:扩权类,须 owner 拍板,二选一:(A) 把该账号加入 selfFixAuthors,走既有 selfMergeAvailable=true 的 --admin 自合并路径(该路径本就设计为豁免 approval);(B) 在结构门 bypass 的安全前提里,对 ownPr=true 的 PR 用「独立审查零 P0/P1 + 已跑 CI 无失败 + 0 未 resolve thread + 命中检查类型全在 structuralBypassAllowlist」替代 reviewDecision=APPROVED。两者都放宽了署名/合并边界,不自动落地。
- `worktree-cleanup-pr-n-branch-naming` **fix-worktree-cleanup 只按 PR head 分支名解析,pr-<N> 命名的托管 worktree 永不被回收** — 出现 1 次,首见 2026-07-28,最近 2026-07-28,status: open
  - 现象:本轮 --scan 在 .claude/worktrees 下发现 2 个托管 worktree(分支 pr-301 / pr-303)与 3 个 worktree-agent-* 分支,全部因 '查不到对应 PR' 跳过;但 gh 实查 PR 301/303 均为 MERGED。原因:judge() 用 gh pr list --head <branch> 解析,只认与 PR headRefName 同名的分支(gh pr checkout 的产物),而 Claude Code 的 Agent isolation:worktree / create-pr 流程建出的分支名是 pr-<N> 或 worktree-agent-<hash>,永远匹配不上,这类 worktree 会无限累积(含 node_modules)。
  - 提案:考虑在 judge() 增加一条确定性解析:分支名严格匹配 ^pr-(\d+)$ 时,用捕获到的编号走 gh pr view <N> 判状态(仍要求非 OPEN + 30 分钟宽限 + 托管目录三重条件);worktree-agent-<hash> 无编号线索,保持不动。注意这是放宽销毁类操作的识别面,按扩权类处理,须 owner 拍板后再落地。
- `node-debug-env-pollutes-script-stdout` **本地 shell 环境变量 NODE_DEBUG 会污染 review-pr 脚本的 JSON stdout** — 出现 1 次,首见 2026-07-28,最近 2026-07-28,status: open
  - 现象:运行环境的 NODE_DEBUG=http,https,net,tls(疑似操作者 shell profile 全局设置,与本 skill 无关)会让 context.mjs/notify-*.mjs 等所有走 node 网络模块(gh api 走的是 fetch/GraphQL 助手)的脚本在 stdout 混入海量调试行,把本该是纯 JSON 的输出弄脏,主 agent 本轮靠手工加 env -u NODE_DEBUG 前缀绕过。若未来某次无人值守调度环境恰好继承了同一 shell 配置,会直接破坏 run-log/summary 的 JSON 解析。
  - 提案:评估是否在 lib.mjs 顶部(所有脚本的唯一入口)加一行 delete process.env.NODE_DEBUG,或在 spawnScriptJson/mapPool 派生子进程时显式清空该变量;需先确认 Node 的 util.debuglog 是否在 net/http/tls 模块 import 时已经lazy读取过该值(ESM 静态 import 提升,可能来不及在业务代码执行前清掉),必要时改用 spawn 时传 env 覆盖而非进程内 delete。不确定是否所有部署环境都会复现,故先记提案不自动落地。
- `stale-dm-requires-human-confirm` **模板B停滞私聊在 auto 模式无法自动发送:lark-cli messages-send 的安全约束要求逐条人工确认收件人/内容/身份** — 出现 1 次,首见 2026-07-28,最近 2026-07-28,status: open
  - 现象:PR #251(zhongxingtian-ai)remind-stale-author.mjs 判定 shouldRemind=true,resolve-author-feishu.mjs 已匹配到收件人(钟行天),但发送私聊唯一可用通道是 lark-cli im +messages-send,其技能文档明确写「Do not send messages without explicit user approval」,与 auto 模式设计的自动私聊(模板B)假设冲突。本轮已跳过发送,只记录判定结果,未私聊。
  - 提案:方案A:为 auto 模式配置一条不要求逐条确认的专用发送通道(如受限 webhook/机器人群公告代替私聊);方案B:模板B在 --auto 下永久降级为仅记录判定+汇总点名,私聊仅在交互模式下由用户确认发送;需 owner 拍板选哪种,不由 skill 自行决定放宽发送工具的安全约束
- `bot-threads-after-scan-block-merge` **Bot review threads created after scan block merge of approved PRs** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: open
  - 现象:PR #449 was approved and ready to merge, but Copilot and Codex bot reviews created new unresolved threads between scan and merge. One thread (Codex DCO) was factually incorrect. Auto mode cannot resolve threads.
  - 提案:Allow auto-resolving bot threads when: (1) thread author is a known bot, (2) the claim is verifiably false (e.g. DCO signed but bot says not), OR (3) thread is a P2/style suggestion that doesn't block. This is privilege expansion (new resolve action).
- `product-hold-missing-payload` **product-hold.mjs 返回 missing-payload 未能自动 hold** — 出现 2 次,首见 2026-07-24,最近 2026-07-25,status: open
  - 现象:PR #397 triggered product-gate. Ran product-hold.mjs 397 with scan result on stdin but got held=false reason=missing-payload. Script likely expects a different payload format (possibly the full non-scan context). The PR was also blocked by 14 threads, so practical impact was nil this round.
  - 提案:Investigate product-hold.mjs expected stdin format and document it, or make the script self-fetch context when not piped
- `skip-notice-never-wired` **notify-author-resolve.mjs 从未接线进 auto 流程,gate 跳过对作者完全静默** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: adopted,commit `bfae5f3`
  - 现象:脚本早已存在(thread 催办+指纹去重)但 SKILL.md §6 无调用指令,所有状态目录均无 reminded.json,#304/#359 等 PR 被 skip 9-17 小时作者零感知
  - 提案:SKILL.md §6 阶段 1 接线 thread/冲突两类 skip 的批量提醒;脚本增 --conflict 模式与 selfFixAuthors 排除
  - 备注:维护者 2026-07-25 当场拍板同意新增评论写操作,已落地 commit bfae5f3
- `format-gate-false-positive-audio-renderer-files` **格式门 uiPaths 对 renderer 下纯音频/逻辑文件误报** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: adopted
  - 现象:PR #373 的 WebMicAudioEngine.ts、useVoiceInput.ts(hook)、vite-env.d.ts 等纯音频生命周期逻辑文件位于 renderer 目录,触发了 UI 证据要求;作者明确说明无视觉变化后仍被推回 3 次。类似 pattern 还包括非渲染 hook、类型声明文件等。
  - 提案:在 pr-rules.json 的 uiExcludePaths 中增加 **/vite-env.d.ts、**/*AudioEngine*、renderer/**/use*.ts(仅 hook 文件)等排除模式,或增加「作者在 UI 变化栏明确写明不涉及时不重复推回」的逻辑。需维护者确认排除范围。
  - 备注:维护者 2026-07-25 拍板保守落地:仅排除 .d.ts(commit bfae5f3);AudioEngine/hook 命名类未采纳;renderer 下 __tests__ 测试文件仍会误报,留作后续候选

## 已自动落地(automatable-gap)

- `blocked-structural-check-ignores-thirdparty-check-runs` **BLOCKED→structural-check 分类只信 actions/runs,漏掉第三方 App check-run 失败,会被 auto admin bypass 合并** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: landed,commit `5178e64`
  - 现象:classifyHeadChecks 走 actions/runs,看不到第三方 App 的 check-run 与 commit status;BLOCKED 分支落进 structural-check 前未查 statusCheckRollup 全集。实测 mivo-canvas#318:Greptile Review conclusion=failure(置信度 3/5 低于本仓要求 4/5),gate 却报「review 与已跑 CI 均无问题」并给出 bypass-structural-block。UNSTABLE 分支早已用 rollup 处理同一类问题,BLOCKED 分支漏了。
  - 提案:BLOCKED 分支在落进 structural-check 前补查 classifyStatusRollup:null→ci-unknown(fail-closed 不可 bypass);failed 非空→ci-failed;pending 非空→ci-pending。纯收紧方向,不新增写操作、不放宽 gate。
- `typecheck-merged-hardcoded-project-path` **typecheck-merged 硬编码 apps/desktop/tsconfig.json,非该布局的仓库健康检查恒为假阴性** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: landed,commit `0630de2`
  - 现象:在 mivo-canvas 跑 --current 得 pass:false / errors:[] / totalErrors:0。根因两层:tsc 报 TS5058(路径不存在)退 1,而该诊断无 'file(line,col): ' 前缀被 ': error TS' 过滤掉。已改为按 pr-rules.json typecheckProject(s) → apps/desktop 探测 → 根 tsconfig 的 references 展开解析,并放宽错误提取正则。实测正向 pass:true、注入类型错误后 pass:false 且给出真实错误行。
- `ui-evidence-notice-hardcodes-design-md` **uiEvidenceNotice 硬编码 DESIGN.md,uiRequired 为空时提醒指向不存在的文件** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: landed,commit `c6e83d6`
  - 现象:本轮 #322(mivo-canvas)命中 UI 路径需发证据提醒,但本仓 ruleFiles.uiRequired 为空、无 DESIGN.md;生成的文案仍写「便于确认界面符合 DESIGN.md 设计规范」,主 agent 只能手工改写才能发出。
  - 提案:context.mjs 按 prRules.ruleFiles.uiRequired 实际配置渲染该半句:配了列真实文件名,没配退化为「便于确认界面呈现符合预期」。
- `ui-evidence-notice-no-recipient-on-own-pr` **ownPr=true 时 UI 证据提醒评论没有收件人,等于在自己 PR 上刷噪音** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: landed,commit `bc30805`
  - 现象:SKILL 3.2 无条件在 uiEvidenceMissing=true 时发提醒评论,未排除 viewer=作者的情形。xindong/mivo-canvas 每日 changelog 补扫 PR(作者=本流程账号,改 public/changelog.json 命中 uiPaths 的 public/ 前缀)每天命中一次。
  - 提案:3.2 增一句 ownPr=true 时不发本评论,证据缺口照常进报告与汇总,gate 结论不变。只减写操作,非扩权。
- `ui-evidence-blob-links-not-detected` **context.mjs 的 UI 证据检测未识别 GitHub blob 链接到图片文件** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: landed
  - 现象:PR #413 作者在 body 表格里用 GitHub blob URL 链接了 3 张 .webp 截图（因私有仓库无法内嵌渲染），但 bodyUiEvidenceKinds 仍为空，导致 uiEvidenceMissing=true。实际证据充分，主 agent 判断不发误导性提醒评论
  - 提案:context.mjs 的证据检测增加对 github.com/.../blob/...\.(webp|png|jpg|jpeg|gif|svg) 格式链接的识别，识别到即视为有效 image 类证据
- `scan-bot-thread-soft-flag-vs-premerge` **scan 把 bot 未 resolve thread 计为 softFlag 而非 blocker，与 pre-merge-check 不一致** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: open
  - 现象:PR #402 scan 输出 unresolvedThreadCount=0 + softFlags 含 bot 评论，但 pre-merge-check 正确把同一 thread 计为 unresolved→canMerge=false。导致主 agent 无谓走了完整 review+approve 流程后才发现不能 merge。
  - 提案:context.mjs 的 unresolvedThreadCount 应与 pre-merge-check 口径一致：bot thread 只要未 resolve 就计入 blockers（不论是否 bot），softFlags 保留用于「已 resolve 但内容可能需要人判断」的场景。或在 gate.pass=true 但 softFlags 含 unresolved bot thread 时降级为 gate.pass=false。
- `state-dir-worktree-fragmentation` **状态目录按 cwd 哈希,worktree 轮次导致锁/指纹/去重全碎片化** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: landed,commit `a179c3b`
  - 现象:scheduler useWorktree 每轮新建 worktree,锁/空转指纹/fix-session/催办去重按 cwd 哈希落进不同临时目录:两把锁并存互斥失效、pre-check 探测目录与会话写入目录不一致、last-scan 缓存从未命中(空转轮全额烧 token)。已修:lib.mjs 状态锚点改用 git-common-dir,主仓库与全部 worktree 共享同一状态目录

## 无法自动化(by-design,只计数观察)

- `threads-unresolved-needs-human` **未 resolve 的 review conversation 只能由人点 Resolve,自动化不代劳** — 出现 1 次,首见 2026-07-29,最近 2026-07-29,status: tracked
  - 现象:本轮 #318(2 条)、#324(1 条)、#333(3 条)因此跳过。作者在 exemptAuthors 白名单内,催 resolve 与停滞私聊均按豁免跳过,不发通知。属署名/决策类,只计数观察,不因出现多次就放开代 resolve。
- `by-design-threads-unresolved` **PR 因 unresolved thread 或冲突无法合并,等作者处理** — 出现 4 次,首见 2026-07-24,最近 2026-07-28,status: tracked
  - 现象:PR #251 命中同一模式,1 条 conversation 未 resolve,提醒已在 crossChannelSuppressHours 窗口内去重(未重发)
- `mivo-canvas-structural-check-codescan-quality-gap` **mivo-canvas 仓库缺 CodeQL/code-quality 工具接线,org ruleset 的 code_scanning/code_quality/required_status_checks 三项永不上报,导致 review 通过的 PR 仍卡在结构性 BLOCKED** — 出现 2 次,首见 2026-07-28,最近 2026-07-28,status: tracked
  - 现象:本轮(2026-07-28)候选 #296/#301/#303 均命中 blockClass=structural-check,requiredCheckRules=[code_scanning,code_quality,required_status_checks],required_status_checks 不在 allowlist 内不自动 bypass。#296 审查已通过(PraiseZhu APPROVE)仍卡在此门。连续多轮同一根因,建议 owner 尽快裁定处置方案。
- `structural-check-not-in-bypass-allowlist` **required_status_checks 未上报结果不在 structuralBypassAllowlist,按设计跳过不 admin bypass** — 出现 1 次,首见 2026-07-28,最近 2026-07-28,status: tracked
  - 现象:PR #303 mergeStateStatus=BLOCKED,命中的必需检查类型含 required_status_checks(范围太宽,pr-rules.json 注释已说明只允许 code_scanning/code_quality 默认放行),当前配置正确跳过、不打回、不 admin merge
- `ci-checks-unreadable` **无法读取 CI check 状态（token 权限 statusCheckRollup 403）** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:gh pr checks 和 statusCheckRollup GraphQL 均返回 Resource not accessible by personal access token，无法判定 CI 是 pass/fail/pending。PR #397 approve 后 merge 被 branch policy 拒绝，无法确认原因。
- `all-candidates-blocked-by-author-side` **所有候选均因冲突/未 resolve thread 被跳过** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:7 个非 draft PR 全部因为作者侧原因(conflict 或 unresolved thread)被 skip;这是设计上就该人来处理的
- `bot-threads-race-undetected-at-scan` **Bot reviews posted between scan and pre-merge-check cause thread-unresolved block** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #451: scan classified as gate-pass (fallback=review), but 4 bot review threads were posted during review agent execution. Pre-merge-check correctly caught them. This is the expected safety-net behavior — not a gap.
- `worktree-dep-resolution` **审查 worktree 内缺跨包依赖导致部分测试无法运行** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR#402 审查中 collabSendOutcome.test.ts 和 plugin-registry.test.ts 因 worktree 缺少 @cindy/maker-core 等跨包依赖而失败；属于 worktree 隔离环境天然局限
- `scan-gate-bot-thread-softflag` **Scan 模式将 bot unresolved thread 归为 softFlag 而非 blocker，full context 验证时正确拦截** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #402 被 scan 归为 review(bot thread 是 softFlag)，但 full context 发现 gatePass=false（正确行为）。scan 分类是 hint，实际验证在 full context 阶段兜住。
- `all-prs-blocked-no-action` **所有 11 个候选 PR 均因作者侧问题被 skip（冲突/未 resolve thread/已打回/hold 中）** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:本轮无任何 PR 可处理到合并。10 个 skip + 1 个 skip-stale-pushback。3 个 held draft 无白名单同意。属正常等待周期，不需要进化
- `toctou-bot-thread-post-scan` **Bot thread appeared between scan and merge — pre-merge-check correctly blocked** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #402 scanned with 0 unresolved threads, but copilot-reviewer posted a new thread before merge attempt. pre-merge-check caught it. By-design TOCTOU protection.
- `pr-closed-during-processing` **PR 在扫描后被作者关闭，无法合并** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR#434 在 scan 时为 OPEN，审查通过后发现已被作者 close（非 merge）。属正常外部事件，不可自动化。
- `worktree-branch-delete-fail-on-review-wt` **review worktree 占用的本地分支在 merge 后无法自动删除** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:gh pr merge --delete-branch 删不掉被 review worktree 占用的本地分支,属正常行为(worktree 结束后分支自然消失),不需要修复
- `many-threads-unresolved-by-design` **大量 PR 被 unresolved threads 卡住属设计上需人处理** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:本轮 17 个候选中 13 个因 unresolved threads 被 skip，均属作者需自行操作的流程项
- `bot-threads-posted-after-scan` **Bot review threads posted between scan and pre-merge-check** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #393 和 #430 在 scan 时无 blocker，但 pre-merge-check 时已有 bot 新发 thread。系统正确：scan 快照 + pre-merge-check 兜底是设计，非缺口。
- `unresolved-threads-majority-block` **大量 PR 被未 resolve 的 review thread 阻塞** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:本轮 15 候选中 13 个因 unresolved threads 被 skip，这是设计上正确的——review 意见需要作者确认解决。
- `skip-all-unresolved-threads` **本轮 14/18 候选因 conversation 未 resolve 被 skip** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #254(25),#291(6),#304(1),#314(4),#389(12),#396(2),#398(9),#402(6),#403(6),#409(8),#417(4),#420(2),#423(5),#429(1) 均因未 resolve thread 被跳过。需作者或 reviewer 处理。
- `ci-status-403-no-visibility` **PAT 无法读取 GitHub App check runs 导致 CI 状态不可见** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #420 审查通过但 mergeStateStatus=BLOCKED，gh pr checks 和 check-runs API 均返回 403。commit status 为 pending+0 statuses，说明 CI 由 GitHub App 驱动而非 commit status。当前 PAT 权限无法读取 App check runs，只能跳过等 CI 自然通过后下轮合并。
- `all-blocked-by-unresolved-threads` **本轮绝大多数 PR 被 unresolved review threads 阻断** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:18 候选中 15 个因 conversation 未 resolve 跳过,属设计上需人类处理
- `bot-threads-block-after-scan-pass` **Bot review threads posted between scan and merge block otherwise-clean PR** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #410 passed independent review (0 P0/P1) and was approved, but pre-merge-check found 3 unresolved bot threads (copilot-pull-request-reviewer, chatgpt-codex-connector) that appeared after context.mjs scan. Resolving external reviewers threads = privilege expansion. Author must resolve; next round will merge if threads cleared.
- `already-merged-during-scan` **PRs merged by maintainer during scan window** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #387 and #407 were merged by MagicLizi between scan start and agent launch. Review agents still confirmed code quality. Timing artifact, not a gap.
- `all-blocked-unresolved-threads` **本轮 11/12 PR 全被未 resolve thread 卡住** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #254(25),#291(6),#304(1),#314(4),#329(7),#387(4),#389(11),#396(4),#398(18),#402(9),#403(9) — 均因 conversation 未 resolve 无法进入审查;唯一可审的 #393 因测试 P1 走 fix-handoff
- `worktree-cleanup-orphan-cap-30` **孤儿分支清理每轮上限 30 条，大量积压需多轮清理** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:本轮 fix-worktree-cleanup 扫描到近百条孤儿分支/worktree，受 30 条/轮 API 实查上限只处理了部分，其余下轮继续。属设计上的防 API 过载保护，不需改。
- `bot-review-race-at-merge` **Bot reviewer 在审查期间新增 thread 导致 merge 时发现未 resolve** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #393 scan 时 unresolvedThreadCount=0，审查 agent 运行期间 chatgpt-codex-connector 提交了 3 条 P1 review thread。pre-merge-check 正确捕获，走 fix-handoff。
- `pr375-merged-during-review` **PR 在审查期间被他人合并** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #375 完成独立审查(pass)后发现已被外部合并,审查耗时约 4.5 分钟期间 head 变化并被合并。属正常并发——多人有合并权限时时序竞争不可避免
- `bot-threads-post-scan-race` **Bot review threads appearing between scan and merge attempt block approved PRs** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #338: scan showed 0 unresolved threads (gatePass=true), review passed, self-approved, but 5 bot threads (copilot + chatgpt-codex-connector) appeared during the ~7min review window. Branch protection blocks merge with unresolved threads regardless of source. This is by-design: bots are external actors, we cannot control their timing, and the rule 'bot 也不能因是bot而自动忽略' is correct. The practical mitigation is faster processing or resolving bot threads after evaluation.
- `bot-review-race-between-scan-and-merge` **Bot review threads appearing between scan and pre-merge-check is by-design** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR #248: scan showed 0 unresolved threads, but by merge time chatgpt-codex-connector had posted 7 P1 threads. pre-merge-check correctly caught this and prevented merge. No gap — safety net worked as intended.
- `arch-gate-other-blockers-skip` **Arch/product gate PRs with prior blockers (CHANGES_REQUESTED/threads) deferred** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PRs #304,#359,#365,#373,#375,#379 triggered arch/product gate but also have prior review blockers; semantic assessment deferred since hold would be redundant on already-blocked PRs. When threads resolve and reviews pass, next round will reassess.
- `no-actionable-all-blocked` **本轮 18 个候选全部被 gate/stale-pushback 阻断，无一进入审查** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:10 个 skip-stale-pushback(格式已打回等作者), 4 个 threads-unresolved, 2 个 pushback-format(新打回), 1 个 product-hold, 1 个 conflict。全部属 by-design：等作者修复格式/resolve thread/rebase 后才能审查
- `format-gate-no-visual-change-claim` **作者声称 UI 文件改动无视觉差异时格式门仍打回** — 出现 1 次,首见 2026-07-25,最近 2026-07-25,status: tracked
  - 现象:PR#373 改了 VoiceInputOverlay.tsx 但作者说是纯 lifecycle fix 无渲染变化。格式门按路径命中打回是 by-design:作者需明确解释为何改 tsx 不产生视觉变化
- `no-new-evolution-this-round` **本轮无新进化项：skip 全是 stale-pushback 或 gate 阻断(设计如此)** — 出现 1 次,首见 2026-07-24,最近 2026-07-24,status: tracked
- `all-skip-no-actionable` **本轮所有候选均被前置门或 stale-pushback 拦住，无可审查项** — 出现 1 次,首见 2026-07-24,最近 2026-07-24,status: tracked
  - 现象:15 个候选中 9 个 stale-pushback（等作者修格式）、5 个 gate 未过（thread 未 resolve / 冲突 / CHANGES_REQUESTED）、1 个新格式打回。2 个 held draft 白名单未回复。by-design：都在等人。
- `all-skipped-no-evolution` **本轮15个候选中14个因格式打回/thread未resolve/冲突跳过** — 出现 1 次,首见 2026-07-24,最近 2026-07-24,status: tracked
  - 现象:PR #371是唯一可处理候选(docs-only)。其余均为作者侧问题(未回应格式打回/未resolve thread/未处理冲突)——设计上就该等作者响应
- `product-gate-held-not-draft-rehold` **已 held 但未 draft 的 PR 需要 re-draft** — 出现 1 次,首见 2026-07-24,最近 2026-07-24,status: tracked
  - 现象:PR #354 有 product hold issue 但 heldDraft=false，需要重新执行 product-hold 将其转 draft。这是设计预期：白名单成员可随时标回 Ready，auto 轮次需检查并重新 hold
- `product-gate-bugfix-semantic-ok` **产品/架构 gate 对 fix 类型 PR 仍触发语义定性——设计如此** — 出现 1 次,首见 2026-07-24,最近 2026-07-24,status: tracked
  - 现象:本轮 #298/#304/#341 均为 fix 类 PR，因路径/行数命中 gate 阈值触发语义定性；人工判定为 bugfix 后使用 fallback。gate 从严设计正确，不需自动放行 fix 类型
- `product-hold-payload-stdin-newline` **product-hold.mjs payload via stdin requires single-line JSON or temp file** — 出现 1 次,首见 2026-07-24,最近 2026-07-24,status: tracked
  - 现象:heredoc with embedded newlines in JSON values causes parse error; writing to temp file works. This is by-design (JSON spec, not a script bug).

## 已否决的提案(留档防止重复提出)

- `bot-threads-block-review-entry` Copilot/Codex/Greptile 的未 resolve thread 让 PR 进不了首次审查 — 维护者 2026-07-25 拍板维持现状:bot thread 必须 resolve 才进审查;以 skip-notice 催办评论(skip-notice-never-wired)替代,不再重复提出
