#!/usr/bin/env node
// notify-author-resolve.mjs — auto 模式因「未 resolve thread」或「与 base 冲突」跳过
// 某 PR 时,在该 PR 上发一条评论 @作者,催其去处理。带去重:同一批未 resolve thread /
// 同一 headRefOid 只评一次。评论措辞固定为 SKILL.md「对外话术与人格边界」模板 C
// (人格淡、不施压、给出退路),本脚本直接拼好文案发送,不留给 agent 现场编。
//
// 为什么单独成脚本(而非塞进 context.mjs):
//   - context.mjs 是「只读 + 客观判定」核心,绝不发评论 / 不改外部状态;发评论是对外
//     写操作,集中在这里,职责清晰。
//   - 去重 + 发评论 + 记录指纹必须原子绑定:评论真发出去了才记「已催」,发失败则下轮重试,
//     不会因为提前记状态而漏催。把这套逻辑放一个脚本里最稳。
//
// 去重粒度(= 未 resolve thread 集合指纹):指纹 = 当前未 resolve thread 的 GraphQL id
// 排序拼接。持久化在 Skill 外部状态目录的 reminded.json,每条记录为
// `{ fingerprint, notifiedAt }`(旧版本只存裸字符串指纹;`storedFingerprint()` 兼容
// 读两种格式的指纹做比较,**指纹相同就不重发**,不靠"再发一次评论"去迁移格式——
// 旧字符串记录没有 notifiedAt,天然不参与下面说的跨通道抑制,下次指纹变化时自然
// 写成新格式)。
//   - 指纹与上次记录相同(新旧格式都认) → 这批 thread 已经催过 → 静默不发(posted=false)。
//   - 指纹变了(作者新增 thread / 部分 resolve / 首次)→ 发评论 + 记新指纹与时间。
//   - 没有任何未 resolve thread → 不发,清掉该 PR 状态(下次再卡会重新催)。
//
// notifiedAt 同时供 remind-stale-author.mjs 读取,作为「停滞私聊(模板 B)」与本脚本
// 「催 resolve/冲突提醒(模板 C)」的跨通道去重依据(staleAuthorReminder.
// crossChannelSuppressHours,默认 24h 内已被本脚本公开评论提醒过的 PR,不再私聊提醒),
// 防止同一 PR 同一时间收到两条催办。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段(posted / reason),不靠退出码分流,
// 让 auto 轮转能继续跑下一候选。
//
// 跑:node <skill-root>/scripts/notify-author-resolve.mjs <PR...> [--conflict] [--dry-run]
//   --dry-run:打印将发的评论与判定,但不真发评论、不写状态(供调试 / 自测)。
//   --conflict:冲突提醒模式——auto 因「与 base 冲突」跳过时,提醒作者去解冲突。
//     脚本自查 mergeable 确为 CONFLICTING 才发(UNKNOWN/MERGEABLE 不发);去重指纹 =
//     headRefOid(作者 push 新 commit 后仍冲突会再提醒一次,合理:他动过了),状态键
//     `<PR>#conflict` 与 thread 模式互不干扰。
//   两种模式都跳过 selfFixAuthors 的 PR(自己的 PR 走 SKILL 5.4 跟进会话,不催本人)。
//   多个 PR 号:批量模式,逐个 spawn 自身聚合输出 { batch:true, results:[…] }——
//   核心判定 / 去重逻辑零改动(就是跑单 PR 模式),单 PR 输出保持原样完全兼容。
//   批量**必须串行**(mapPool 并发 1):共享 reminded.json 去重状态,并发会读写竞态。

import { parseRepo, parsePR, gh, ghJson, ghGraphql, print, fail, spawnScriptJson, mapPool, stateFile, loadRules } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── 批量驱动(见文件头)──
{
  const prArgs = process.argv.slice(2).filter((a) => /^#?\d+$/.test(a));
  if (prArgs.length > 1) {
    const flags = process.argv.slice(2).filter((a) => !/^#?\d+$/.test(a)); // --dry-run 等原样透传
    const SELF = fileURLToPath(import.meta.url);
    const results = await mapPool(prArgs, 1, (p) => spawnScriptJson(SELF, [p, ...flags]));
    print({ ok: true, batch: true, count: results.length, results });
    process.exit(0);
  }
}

const REMIND_FILE = stateFile('reminded.json');

// 只拉 review thread(id / isResolved / path)+ 作者,够算指纹和 @人 即可,轻量。
const GQL = `
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        author{ login }
        reviewThreads(first:100){ nodes{ id isResolved path } }
      }
    }
  }`;

function readState() {
  try {
    return JSON.parse(readFileSync(REMIND_FILE, 'utf8')) || {};
  } catch {
    return {}; // 文件不存在 / 损坏都按空状态起步
  }
}

function writeState(state) {
  try {
    writeFileSync(REMIND_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* best-effort:写失败最多下轮重复催一次,不影响主流程 */
  }
}

/** 兼容旧格式(裸字符串指纹)与新格式(`{ fingerprint, notifiedAt }`)读出指纹,
 * 不因格式升级而在指纹未变时误判"没催过"再重发一次评论。旧字符串记录没有
 * notifiedAt,天然不参与 remind-stale-author.mjs 的跨通道抑制,不需要在这里迁移
 * 格式——下次指纹变化时自然会写成新格式。 */
function storedFingerprint(entry) {
  return typeof entry === 'string' ? entry : entry?.fingerprint;
}

/** 发评论(body 走 stdin 防引号问题);成功返回 true。 */
function postComment(slug, prKey, body) {
  const r = gh(['pr', 'comment', prKey, '--repo', slug, '--body-file', '-'], {
    input: body,
    allowFail: true,
  });
  return { ok: r.ok, error: r.ok ? null : (r.stderr || '').trim().slice(0, 300) };
}

/** selfFixAuthors 的 PR 不催本人(走 SKILL 5.4 跟进会话);名单读取失败按空处理。 */
function isSelfFixAuthor(author) {
  try {
    return (loadRules().selfFixAuthors ?? []).some((a) => a.toLowerCase() === (author ?? '').toLowerCase());
  } catch {
    return false;
  }
}

/** 核心贡献者豁免(staleAuthorReminder.exemptAuthors,大小写不敏感):命中直接跳过 resolve
 * 催办,thread/conflict 两种模式同样检查。配置缺失(exemptAuthors 为空)= 无豁免,行为
 * 与此前完全一致。名单读取失败按空处理。 */
function isExemptAuthor(author) {
  try {
    return (loadRules().staleAuthorReminder?.exemptAuthors ?? []).some((a) => a.toLowerCase() === (author ?? '').toLowerCase());
  } catch {
    return false;
  }
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const prKey = String(pr);
  const dryRun = process.argv.includes('--dry-run');
  const conflictMode = process.argv.includes('--conflict');
  const slug = `${owner}/${repo}`;

  // ── 冲突提醒模式(与 thread 模式互斥的独立分支,状态键 `<PR>#conflict`)──
  if (conflictMode) {
    const meta = ghJson(['pr', 'view', prKey, '--repo', slug, '--json', 'author,mergeable,headRefOid,baseRefName']);
    const author = meta?.author?.login ?? '';
    const conflictKey = `${prKey}#conflict`;
    const state = readState();
    if (isExemptAuthor(author)) {
      if (state[conflictKey] !== undefined && !dryRun) {
        delete state[conflictKey];
        writeState(state);
      }
      print({ ok: true, pr, mode: 'conflict', posted: false, reason: 'exempt-author', author });
    } else if (isSelfFixAuthor(author)) {
      print({ ok: true, pr, mode: 'conflict', posted: false, reason: 'self-fix-author', author });
    } else if (meta?.mergeable !== 'CONFLICTING') {
      // 已不冲突(或 GitHub 还在重算 UNKNOWN)→ 不发;确认不冲突时清状态,下次再冲突会重新提醒
      if (meta?.mergeable === 'MERGEABLE' && state[conflictKey] !== undefined && !dryRun) {
        delete state[conflictKey];
        writeState(state);
      }
      print({ ok: true, pr, mode: 'conflict', posted: false, reason: `mergeable=${meta?.mergeable ?? 'null'}`, author });
    } else if (storedFingerprint(state[conflictKey]) === meta.headRefOid) {
      print({ ok: true, pr, mode: 'conflict', posted: false, reason: 'already-commented', author, fingerprint: meta.headRefOid });
    } else {
      const mention = author ? `@${author} ` : '';
      const body =
        `${mention}#${pr} 和 \`${meta.baseRefName}\` 有冲突,卡着合不了 🤨\n\n` +
        `在本地 merge 最新的 \`origin/${meta.baseRefName}\` 解掉冲突后 push 一下,我这边就能接着走。`;
      if (dryRun) {
        print({ ok: true, pr, mode: 'conflict', posted: false, reason: 'dry-run', author, fingerprint: meta.headRefOid, body });
      } else {
        const r = postComment(slug, prKey, body);
        if (r.ok) {
          state[conflictKey] = { fingerprint: meta.headRefOid, notifiedAt: new Date().toISOString() };
          writeState(state);
          print({ ok: true, pr, mode: 'conflict', posted: true, author, fingerprint: meta.headRefOid });
        } else {
          print({ ok: true, pr, mode: 'conflict', posted: false, reason: 'comment-failed', author, error: r.error });
        }
      }
    }
    process.exit(0);
  }

  const data = ghGraphql(GQL, { owner, repo, num: pr })?.data?.repository?.pullRequest ?? {};
  const author = data.author?.login ?? '';
  const threads = data.reviewThreads?.nodes ?? [];
  const unresolved = threads.filter((t) => !t.isResolved);

  const state = readState();

  if (isExemptAuthor(author)) {
    if (state[prKey] !== undefined && !dryRun) {
      delete state[prKey];
      writeState(state);
    }
    print({ ok: true, pr, posted: false, reason: 'exempt-author', author });
  } else if (isSelfFixAuthor(author)) {
    print({ ok: true, pr, posted: false, reason: 'self-fix-author', author });
  } else if (unresolved.length === 0) {
    // 没有未 resolve thread:无需催,清掉本 PR 状态(让下次再卡时重新催)
    if (state[prKey] !== undefined && !dryRun) {
      delete state[prKey];
      writeState(state);
    }
    print({ ok: true, pr, posted: false, reason: 'no-unresolved-threads', author });
  } else {
    const fingerprint = unresolved.map((t) => t.id).sort().join(',');

    // 同一批 thread 已催过 → 静默
    if (storedFingerprint(state[prKey]) === fingerprint) {
      print({ ok: true, pr, posted: false, reason: 'already-commented', author, fingerprint });
    } else {
      const paths = [...new Set(unresolved.map((t) => t.path).filter(Boolean))];
      const pathHint = paths.length
        ? `(${paths.slice(0, 5).join(' / ')}${paths.length > 5 ? ' 等' : ''})`
        : '';
      const mention = author ? `@${author} ` : '';
      const body =
        `${mention}#${pr} 还有 ${unresolved.length} 条 conversation 没 resolve${pathHint},卡着合不了 🤨\n\n` +
        `看过了、改过了、或者觉得不用改都行 —— 点一下 Resolve,我这边就能往下走。`;

      if (dryRun) {
        print({ ok: true, pr, posted: false, reason: 'dry-run', author, fingerprint, body });
      } else {
        // 发评论:body 走 stdin(--body-file -),避免中文 / 特殊字符的命令行引号问题
        const r = gh(['pr', 'comment', prKey, '--repo', slug, '--body-file', '-'], {
          input: body,
          allowFail: true,
        });
        if (r.ok) {
          state[prKey] = { fingerprint, notifiedAt: new Date().toISOString() };
          writeState(state);
          print({ ok: true, pr, posted: true, author, fingerprint, unresolvedCount: unresolved.length });
        } else {
          // 发失败不记状态,下轮重试
          print({ ok: true, pr, posted: false, reason: 'comment-failed', author, error: (r.stderr || '').trim().slice(0, 300) });
        }
      }
    }
  }
} catch (e) {
  fail(e);
}
