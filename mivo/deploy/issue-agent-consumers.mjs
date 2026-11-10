// 换版本后同步 issue-agent 的放行版本哈希(PraiseZhu/Review-PR#165)。
//
// Mini 上的 issue-agent 以 PraiseZhu 身份给 Mivo issue 发评估评论。它在发布前核对审查机两个文件
// (`review-pr/scripts/context.mjs`、`lib.mjs`)的整文件哈希(runtime 配置的 `reviewConsumers`),
// 对不上就只停发布,防止新版审查机把它的评论当成维护者「同意放行」。换版本会改这两个文件,
// 以前没人更新哈希,发布被拦了 23 天。
//
// 这里在换版本之后对新检出直接跑这条性质的检查(放行契约):带 issue-agent 标记的维护者评论,
// 即使有一整行「同意放行」,也不产生确认 issue 放行和受保护路径放行;去掉标记的同一条评论必须
// 产生放行(对照,防止检查空转)。通过才把两份配置里的哈希改成检出里文件的现哈希,别的字段一个字节都不动。
// 契约测不到的残余风险:context.mjs 在 lib.mjs 之外新增别的放行来源。
//
// 用法(在 Mini 上):
//   node issue-agent-consumers.mjs [--skill-dir <审查机检出>] [--issue-agent-dir <runtime 配置所在目录>] [--dry-run]
// 退出码:0 哈希本来一致或已更新(dry-run 时为「可以更新」);1 契约没过、配置读不了等,没写任何文件。
// stdout 一行给人看的结果(哈希本来一致时为空)。auto-update.mjs 整组换好后调用它。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { toCliArgs } from './tuple-lib.mjs';

export const DEFAULT_SKILL_DIR = path.join(os.homedir(), 'mivo-prereview/skill');
export const DEFAULT_ISSUE_AGENT_DIR = path.join(os.homedir(), 'AI-Agent/Claude/projects/Project Mivo Canvas-Plugin/history/loops/issue-agent');
export const RUNTIME_NAMES = ['runtime-primary.json', 'runtime-fallback.json'];
// issue-agent 发布的 GitHub 评论首行(Mivo scripts/loops/issue-agent/protocol.mjs 的 marker)。
export const ISSUE_AGENT_MARKER = `<!-- mivo-issue-assessment:v1 repo=xindong/mivo-canvas-plugin issue=1 input=${'a'.repeat(64)} round=1 report=${'b'.repeat(64)} -->`;
const HEX64 = /^[0-9a-f]{64}$/;
const USAGE = `用法:node issue-agent-consumers.mjs [--skill-dir <审查机检出>] [--issue-agent-dir <目录>] [--dry-run]
  --skill-dir         审查机检出,默认 ~/mivo-prereview/skill
  --issue-agent-dir   issue-agent 的 runtime-primary.json / runtime-fallback.json 所在目录
  --dry-run           只判断、不写文件
`;
const CONTRACT_PR = 4242;

// helpers
export const toSha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isInside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// 放行契约。lib 是审查机检出里 review-pr/scripts/lib.mjs 的模块对象;返回没通过的条目(空数组 = 通过)。
export function toContractFailures(lib) {
  const missing = ['selectDiscussionIssueReleases', 'latestIssueRelease', 'evaluateProtectedPathRelease']
    .filter((name) => typeof lib?.[name] !== 'function');
  if (missing.length) return [`lib.mjs 缺少 ${missing.join('、')}`];
  const pr = CONTRACT_PR;
  const prCreatedAt = '2026-01-01T00:00:00Z';
  const at = '2026-01-02T00:00:00Z';
  const maintainers = ['PraiseZhu', 'dashhuang'];
  const authorLogin = 'contract-author';
  const releasesOf = (body) => {
    const issue = {
      title: `维护者确认 · PR #${pr} 涉及的改动`,
      body: `放行契约用的确认 issue。\n\n---\n本 issue 由 review-pr 流程自动创建。关联 PR:#${pr}`,
      comments: [{ id: 1, author: { login: 'PraiseZhu' }, body, createdAt: at, isMinimized: false }],
    };
    const d = lib.selectDiscussionIssueReleases({ issue, pr, maintainers, authorLogin, commentEnabled: true, slackEnabled: true, prCreatedAt });
    const issueRelease = lib.latestIssueRelease(d?.slackRelease, d?.issueCommentRelease);
    const p = lib.evaluateProtectedPathRelease({
      protectedFiles: ['.github/workflows/ci.yml'], reviews: [], maintainers: maintainers.map((m) => m.toLowerCase()),
      latestCommitDate: at, issueRelease, authorLogin, authorExempt: false,
    });
    return { issue: issueRelease, protected: p?.released ?? null };
  };
  const failures = [];
  try {
    const marked = releasesOf(`${ISSUE_AGENT_MARKER}\n同意放行`);
    const control = releasesOf('同意放行');
    if (marked.issue) failures.push('带 issue-agent 标记的维护者评论被当成了确认 issue 放行');
    if (marked.protected) failures.push('带 issue-agent 标记的维护者评论被当成了受保护路径放行');
    if (!control.issue) failures.push('对照没放行:不带标记的「同意放行」没产生确认 issue 放行,契约测不到放行路径');
    if (!control.protected) failures.push('对照没放行:不带标记的「同意放行」没产生受保护路径放行,契约测不到放行路径');
  } catch (error) {
    failures.push(`跑契约时出错:${error.message}`);
  }
  return failures;
}

// 要改哪些哈希。configs: [{file, text}];hashOf(path) 返回文件现哈希(读不到抛错);realpathOf(path) 返回解开符号链接后的
// 真实路径(调用方传 fs.realpathSync,读不到抛错),检出内的符号链接指向检出外也算「检出之外」。不写文件。
// 返回 {error} 或 {changes:[{file, path, from, to}], next:[{file, text}]}(next 只含要改的配置)。
export function toConsumerPlan({ configs, skillDir, hashOf, realpathOf = (p) => path.resolve(p) }) {
  const scriptsDir = realpathOf(path.join(skillDir, 'review-pr/scripts'));
  const changes = [];
  const next = [];
  for (const { file, text } of configs) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: `${file} 不是合法 JSON` };
    }
    const consumers = json?.reviewConsumers;
    if (!Array.isArray(consumers) || consumers.length === 0) return { error: `${file} 没有 reviewConsumers` };
    let nextText = text;
    for (const item of consumers) {
      if (typeof item?.path !== 'string' || !HEX64.test(String(item?.hash))) return { error: `${file} 的 reviewConsumers 格式不对` };
      if (!isInside(realpathOf(item.path), scriptsDir)) return { error: `${file} 的 reviewConsumers 指向检出之外的文件 ${item.path}` };
      const to = hashOf(item.path);
      if (to === item.hash) continue;
      // 只替换这一处哈希串:同一个旧哈希在文件里出现不止一次就不动,交给人看。
      if (nextText.split(item.hash).length !== 2) return { error: `${file} 里旧哈希 ${item.hash.slice(0, 8)} 出现不止一次,不自动改` };
      nextText = nextText.replace(item.hash, to);
      changes.push({ file, path: item.path, from: item.hash, to });
    }
    if (nextText === text) continue;
    // 改完再读一遍:除了这几个 hash,其他字段必须原样。
    const expected = { ...json, reviewConsumers: consumers.map((item) => ({ ...item, hash: hashOf(item.path) })) };
    if (JSON.stringify(JSON.parse(nextText)) !== JSON.stringify(expected)) return { error: `${file} 改哈希后其他字段变了,不写` };
    next.push({ file, text: nextText });
  }
  return { changes, next };
}

// 给换版结果用的一句话。outcome: {changes} | {error} | {failures}。哈希本来一致时为空串。
export function toConsumerNote(outcome) {
  const how = '处理:确认新版审查机仍不把 issue-agent 的评论当成「同意放行」后,在 Mini 上跑 '
    + '`node ~/mivo-prereview/skill/mivo/deploy/issue-agent-consumers.mjs`(见 mivo/README.md「每天自动换版本」)。';
  if (outcome.failures?.length) {
    return `issue 评估的发布被拦:新版审查机没通过放行契约(${outcome.failures.join(';')}),issue-agent 配置里的哈希没改。${how}`;
  }
  if (outcome.error) return `issue 评估的发布被拦:issue-agent 的放行版本哈希没更新成(${outcome.error})。${how}`;
  if (!outcome.changes?.length) return '';
  const files = [...new Set(outcome.changes.map((c) => path.basename(c.path)))].join('、');
  const configs = [...new Set(outcome.changes.map((c) => path.basename(c.file)))].join('、');
  return `issue-agent 的放行版本哈希已随换版更新(${files};${configs}),放行契约通过。`;
}

// auto-update 调用本脚本(子进程)后给换版结果的那一句。r 是 spawnSync 的结果;被拦的写法以「issue 评估的发布」开头。
export function toConsumerStepNote(r) {
  const how = '在 Mini 上跑 `node ~/mivo-prereview/skill/mivo/deploy/issue-agent-consumers.mjs` 看原因(见 mivo/README.md「每天自动换版本」)。';
  if (r?.error) return `issue 评估的发布可能被拦:同步放行版本哈希的脚本没跑起来(${r.error.message})。${how}`;
  const out = String(r?.stdout ?? '').trim();
  if (r?.status === 0) return out;
  if (out.startsWith('issue 评估的发布')) return out;
  const detail = out || String(r?.stderr ?? '').trim().slice(0, 300);
  return `issue 评估的发布可能被拦:同步放行版本哈希的脚本退出码 ${r?.status}(${detail})。${how}`;
}

// 写一个独占的临时文件(不复用已有文件),权限显式设成 mode;设权限、写入、落盘、关闭任一步失败都删掉它再抛错。
// 关闭只调一次:关闭报错时 fd 已释放,再关可能关到别处新开的同号 fd。
function writeTemp(file, data, mode, { fchmod, close }) {
  const tmp = `${file}.${randomUUID()}.pending`;
  const fd = fs.openSync(tmp, 'wx', mode);
  let open = true;
  try {
    fchmod(fd, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    open = false;
    close(fd);
  } catch (error) {
    if (open) {
      try { close(fd); } catch { /* 抛出的是原错误,关不上不另报 */ }
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return tmp;
}

// 写文件:先全部写临时文件,再逐个改名,保留原权限。中途失败时删掉本次的临时文件,
// 已经改名换上的配置换回原文,两份配置要么都是新哈希、要么都是原样;换不回时保留原文副本并在错误里给出路径。
// rename、fchmod、close 可注入,测试用来造故障。
export function writeConfigs(next, { rename = fs.renameSync, fchmod = fs.fchmodSync, close = fs.closeSync } = {}) {
  const staged = [];
  try {
    for (const { file, text } of next) {
      const mode = fs.statSync(file).mode & 0o777;
      staged.push({ file, mode, original: fs.readFileSync(file), tmp: writeTemp(file, text, mode, { fchmod, close }) });
    }
  } catch (error) {
    for (const s of staged) fs.rmSync(s.tmp, { force: true });
    throw error;
  }
  const replaced = [];
  try {
    for (const s of staged) {
      rename(s.tmp, s.file);
      replaced.push(s);
    }
  } catch (error) {
    for (const s of staged) if (!replaced.includes(s)) fs.rmSync(s.tmp, { force: true });
    const notRestored = [];
    for (const s of replaced) {
      let copy = null;
      try {
        copy = writeTemp(s.file, s.original, s.mode, { fchmod, close });
        rename(copy, s.file);
      } catch {
        notRestored.push(`${path.basename(s.file)}(原文${copy ? `副本在 ${copy}` : '没能另存'})`);
      }
    }
    if (notRestored.length) throw new Error(`${error.message};${notRestored.join('、')} 已换成新哈希、没能换回原文`);
    throw new Error(`${error.message};已换上的配置已换回原文`);
  }
}

export async function syncIssueAgentConsumers({ skillDir = DEFAULT_SKILL_DIR, issueAgentDir = DEFAULT_ISSUE_AGENT_DIR, dryRun = false, importLib, rename, fchmod, close } = {}) {
  const files = RUNTIME_NAMES.map((name) => path.join(issueAgentDir, name));
  let configs;
  try {
    configs = files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
  } catch (error) {
    return { error: `读不了 issue-agent 配置:${error.message}` };
  }
  const hashes = new Map();
  const hashOf = (file) => {
    if (!hashes.has(file)) hashes.set(file, toSha256(fs.readFileSync(file)));
    return hashes.get(file);
  };
  let plan;
  try {
    plan = toConsumerPlan({ configs, skillDir, hashOf, realpathOf: fs.realpathSync });
  } catch (error) {
    return { error: `读不了审查机文件:${error.message}` };
  }
  if (plan.error || plan.changes.length === 0) return plan;
  let lib;
  try {
    const libFile = path.join(skillDir, 'review-pr/scripts/lib.mjs');
    lib = importLib ? await importLib(libFile) : await import(pathToFileURL(libFile).href);
  } catch (error) {
    return { failures: [`加载 lib.mjs 失败:${error.message}`] };
  }
  const failures = toContractFailures(lib);
  if (failures.length) return { failures };
  if (!dryRun) {
    try {
      writeConfigs(plan.next, { rename, fchmod, close });
    } catch (error) {
      return { error: `写配置失败:${error.message}` };
    }
  }
  return { changes: plan.changes, dryRun };
}

async function main() {
  const cli = toCliArgs(process.argv.slice(2), { flags: ['dry-run'], values: ['skill-dir', 'issue-agent-dir'] });
  if (cli.help || cli.error) {
    process[cli.help ? 'stdout' : 'stderr'].write(`${cli.error ? `${cli.error}\n` : ''}${USAGE}`);
    process.exitCode = cli.help ? 0 : 1;
    return;
  }
  const outcome = await syncIssueAgentConsumers({
    skillDir: cli.values.get('skill-dir') ?? DEFAULT_SKILL_DIR,
    issueAgentDir: cli.values.get('issue-agent-dir') ?? DEFAULT_ISSUE_AGENT_DIR,
    dryRun: cli.flags.has('dry-run'),
  });
  const note = toConsumerNote(outcome);
  process.stdout.write(note ? `${outcome.dryRun ? '[dry-run,没写文件] ' : ''}${note}\n` : '');
  process.exitCode = outcome.error || outcome.failures?.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
