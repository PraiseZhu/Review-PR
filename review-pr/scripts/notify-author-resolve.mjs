#!/usr/bin/env node
// notify-author-resolve.mjs — auto 模式因「未 resolve thread」跳过某 PR 时,在该 PR 上
// 发一条评论 @作者,催其去 GitHub 点 Resolve。带去重:同一批未 resolve thread 只评一次。
//
// 为什么单独成脚本(而非塞进 context.mjs):
//   - context.mjs 是「只读 + 客观判定」核心,绝不发评论 / 不改外部状态;发评论是对外
//     写操作,集中在这里,职责清晰。
//   - 去重 + 发评论 + 记录指纹必须原子绑定:评论真发出去了才记「已催」,发失败则下轮重试,
//     不会因为提前记状态而漏催。把这套逻辑放一个脚本里最稳。
//
// 去重粒度(= 未 resolve thread 集合指纹):指纹 = 当前未 resolve thread 的 GraphQL id
// 排序拼接。持久化在 Skill 外部状态目录的 reminded.json。
//   - 指纹与上次记录相同 → 这批 thread 已经催过 → 静默不发(posted=false)。
//   - 指纹变了(作者新增 thread / 部分 resolve / 首次)→ 发评论 + 记新指纹。
//   - 没有任何未 resolve thread → 不发,清掉该 PR 状态(下次再卡会重新催)。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段(posted / reason),不靠退出码分流,
// 让 auto 轮转能继续跑下一候选。
//
// 跑:node <skill-root>/scripts/notify-author-resolve.mjs <PR...>
//     [--conflict] [--stale-rebase] [--protected-path] [--review-only] [--dry-run]
//     [--lock-token <token> --expected-head <SHA> --expected-authority-digest <digest>]
//   --dry-run:打印将发的评论与判定,但不真发评论、不写状态(供调试 / 自测)。
//   --conflict:冲突提醒模式——auto 因「与 base 冲突」跳过时,提醒作者去解冲突。
//     脚本自查 mergeable 确为 CONFLICTING 才发(UNKNOWN/MERGEABLE 不发);去重指纹 =
//     headRefOid(作者 push 新 commit 后仍冲突会再提醒一次,合理:他动过了),状态键
//     `<PR>#conflict` 与 thread 模式互不干扰。
//   --stale-rebase:stale-rebase 提醒模式——auto 因「分支落后 base 太久」跳过时,
//     提醒作者 rebase。脚本用 compare API 自查 behind_by > 0 才发(已经 rebase 的
//     不发);去重指纹 = merge base 时间。同一次落后期间即使作者推送普通 commit 也只提醒一次;
//     真正 rebase 后状态清除,未来再次超过阈值才会重新提醒。状态键 `<PR>#stale-rebase`
//     与 conflict / thread 模式互不干扰。评论还带 marker,本机状态丢失后会核验当前 viewer
//     留下的历史评论并恢复去重状态。
//   --protected-path:受保护路径提醒模式——auto 因「改动受保护路径(.github/** 等)」
//     跳过时,评论告知作者改了哪个文件、会开确认 issue 转人工审核、三种放行方式。脚本自查
//     当前确实命中受保护路径才发(已经撤销全部受保护改动的清状态);去重指纹 = 受保护
//     文件集合排序拼接(同一批文件只提醒一次,改了别的受保护文件会再提醒),状态键
//     `<PR>#protected-path` 与其它模式互不干扰。
//   --review-only:通知文案明确本轮仍会审核,但不会主动执行 Merge,避免让作者误以为
//     处理卡点后系统会自行合入。
//   --target-branch:给因 stacked 依赖/retarget 跳过的 PR 说明最终需进入默认分支；
//     按 base 与父 PR 状态的评论 marker 去重。此类不走修复 session，包含自有 PR。
//   四种提醒类型都跳过 selfFixAuthors 的 PR(正常模式走跟进会话;review-only 只进汇总,
//   都不催本人)。
//   多个 PR 号:批量模式,逐个 spawn 自身聚合输出 { batch:true, results:[…] }——
//   核心判定 / 去重逻辑零改动(就是跑单 PR 模式),单 PR 输出保持原样完全兼容。
//   批量**必须串行**(mapPool 并发 1):共享 reminded.json 去重状态,并发会读写竞态。

import { parseRepo, parsePR, gh, ghJson, ghGraphql, print, fail, spawnScriptJson, mapPool, stateFile, loadRules, matchPathPatterns, fetchRestPages } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { fetchStaleRebase, fetchAllReviewThreads, atomicWriteJson } from './lib.mjs';
import { fileURLToPath } from 'node:url';
import { hasTrustedRebaseReminder, rebaseReminderFingerprint, rebaseReminderMarker } from './rebase-reminder.mjs';
import { createPrWriteGuard } from './pr-write-guard.mjs';
import { notifyTargetBranch } from './target-branch-reminder.mjs';

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
    atomicWriteJson(REMIND_FILE, state);
  } catch {
    /* best-effort:写失败最多下轮重复催一次,不影响主流程 */
  }
}

/** 发评论(body 走 stdin 防引号问题);成功返回 true。 */
function postComment(slug, prKey, body, ghFn = gh) {
  const r = ghFn(['pr', 'comment', prKey, '--repo', slug, '--body-file', '-'], {
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

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const prKey = String(pr);
  const dryRun = process.argv.includes('--dry-run');
  const conflictMode = process.argv.includes('--conflict');
  const reviewOnly = process.argv.includes('--review-only');
  const slug = `${owner}/${repo}`;
  const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? '' : String(process.argv[i + 1] ?? ''); };
  const binding = { owner, repo, pr, lockToken: arg('--lock-token'), expectedHead: arg('--expected-head'),
    expectedBaseRef: arg('--expected-base-ref'),
    expectedAuthorityDigest: arg('--expected-authority-digest'), purpose: 'author-notice' };
  const writeGh = binding.lockToken || binding.expectedHead || binding.expectedAuthorityDigest ? createPrWriteGuard(binding) : gh;

  // This prerequisite has no self-fix handoff: all authors receive the same
  // actionable notice, including selfFixAuthors. No retarget or merge is performed.
  if (process.argv.includes('--target-branch')) {
    const result = notifyTargetBranch({ ...binding, reviewOnly, dryRun }, { ghJson, fetchRestPages, writeGh });
    print(result);
    process.exit(result.ok ? 0 : 1);
  }

  // ── stale-rebase 提醒模式(状态键 `<PR>#stale-rebase`)──
  const staleRebaseMode = process.argv.includes('--stale-rebase');
  if (staleRebaseMode) {
    const meta = ghJson(['pr', 'view', prKey, '--repo', slug, '--json', 'author,headRefOid,headRefName,baseRefName']);
    const author = meta?.author?.login ?? '';
    const staleKey = `${prKey}#stale-rebase`;
    const state = readState();
    if (isSelfFixAuthor(author)) {
      print({ ok: true, pr, mode: 'stale-rebase', posted: false, reason: 'self-fix-author', author });
    } else {
      // behind_by > 0 + merge base 距今 > 阈值 → 催 rebase
      const staleRebase = fetchStaleRebase({ slug, baseRef: meta.baseRefName,
        headSha: meta.headRefOid, cfg: loadRules().staleRebase ?? {} });
      const { behindBy, daysSinceRebase } = staleRebase;
      if (!staleRebase.verified) {
        print({ ok: false, pr, mode: 'stale-rebase', posted: false, reason: staleRebase.reason, author });
        process.exit(1);
      }
      if (!staleRebase.blocking) {
        if (state[staleKey] !== undefined && !dryRun) {
          delete state[staleKey];
          writeState(state);
        }
        print({ ok: true, pr, mode: 'stale-rebase', posted: false, reason: staleRebase.reason, author });
      } else {
        const fingerprint = rebaseReminderFingerprint(staleRebase.mergeBaseDate);
        const marker = rebaseReminderMarker(fingerprint);
        let alreadyCommented = state[staleKey] === fingerprint;
        if (!alreadyCommented && state[staleKey] === meta.headRefOid) {
          // 旧版按 head 去重的本机状态：当前 head 未变，说明这次卡点已经提醒过。
          alreadyCommented = true;
        }
        if (!alreadyCommented) {
          const viewer = ghJson(['api', 'user'])?.login ?? '';
          const comments = fetchRestPages(`repos/${slug}/issues/${prKey}/comments`);
          alreadyCommented = hasTrustedRebaseReminder(comments, {
            viewer, fingerprint, mergeBaseDate: staleRebase.mergeBaseDate,
          });
        }
        if (alreadyCommented && !dryRun && state[staleKey] !== fingerprint) {
          state[staleKey] = fingerprint;
          writeState(state);
        }
        if (alreadyCommented) {
          print({ ok: true, pr, mode: 'stale-rebase', posted: false, reason: 'already-commented', author, fingerprint });
          process.exit(0);
        }
        const mention = author ? `@${author} ` : '';
        const message = reviewOnly
          ? `${mention}👋 这个 PR 已经有 ${Math.round(daysSinceRebase)} 天没有 rebase 了。\n\n` +
            `为了避免合入后出现 CI 未曾验证过的新问题,请在本地 rebase 最新的 \`origin/${meta.baseRefName}\` 后重新推送。` +
            `rebase 后 CI 会自动重跑,全部通过后可重新运行 review-pr-auto --review-only 复审。该模式不会主动执行 Merge。`
          : `${mention}👋 这个 PR 已经有 ${Math.round(daysSinceRebase)} 天没有 rebase 了。\n\n` +
            `为了避免合入后出现 CI 未曾验证过的新问题,请在本地 rebase 最新的 \`origin/${meta.baseRefName}\` 后重新推送。` +
            `rebase 后 CI 会自动重跑,全部通过后 auto-review 会在下一轮继续处理。`;
        const body = `${message}\n\n${marker}`;
        if (dryRun) {
          print({ ok: true, pr, mode: 'stale-rebase', reviewOnly, posted: false, reason: 'dry-run', author, fingerprint, body });
        } else {
          const r = postComment(slug, prKey, body, writeGh);
          if (r.ok) {
            state[staleKey] = fingerprint;
            writeState(state);
            print({ ok: true, pr, mode: 'stale-rebase', posted: true, author, fingerprint, behindBy });
          } else {
            print({ ok: true, pr, mode: 'stale-rebase', posted: false, reason: 'comment-failed', author, error: r.error });
          }
        }
      }
    }
    process.exit(0);
  }

  // ── 冲突提醒模式(与 thread 模式互斥的独立分支,状态键 `<PR>#conflict`)──
  if (conflictMode) {
    const meta = ghJson(['pr', 'view', prKey, '--repo', slug, '--json', 'author,mergeable,headRefOid,baseRefName']);
    const author = meta?.author?.login ?? '';
    const conflictKey = `${prKey}#conflict`;
    const state = readState();
    if (isSelfFixAuthor(author)) {
      print({ ok: true, pr, mode: 'conflict', posted: false, reason: 'self-fix-author', author });
    } else if (meta?.mergeable !== 'CONFLICTING') {
      // 已不冲突(或 GitHub 还在重算 UNKNOWN)→ 不发;确认不冲突时清状态,下次再冲突会重新提醒
      if (meta?.mergeable === 'MERGEABLE' && state[conflictKey] !== undefined && !dryRun) {
        delete state[conflictKey];
        writeState(state);
      }
      print({ ok: true, pr, mode: 'conflict', posted: false, reason: `mergeable=${meta?.mergeable ?? 'null'}`, author });
    } else if (state[conflictKey] === meta.headRefOid) {
      print({ ok: true, pr, mode: 'conflict', posted: false, reason: 'already-commented', author, fingerprint: meta.headRefOid });
    } else {
      const mention = author ? `@${author} ` : '';
      const body = reviewOnly
        ? `${mention}👋 这个 PR 目前与 \`${meta.baseRefName}\` 有合并冲突,review-only 因此暂时跳过、无法完成本轮审查。\n\n` +
          `请在本地 merge 最新的 \`origin/${meta.baseRefName}\` 解决冲突后推送;` +
          `冲突解除后可重新运行 review-pr-auto --review-only 复审。该模式不会主动执行 Merge。`
        : `${mention}👋 这个 PR 目前与 \`${meta.baseRefName}\` 有合并冲突,auto-review 因此暂时跳过、没法继续审查 / 合并。\n\n` +
          `请在本地 merge 最新的 \`origin/${meta.baseRefName}\` 解决冲突后推送;` +
          `冲突解除后,下一轮 auto-review 会自动重新处理这个 PR。`;
      if (dryRun) {
        print({ ok: true, pr, mode: 'conflict', reviewOnly, posted: false, reason: 'dry-run', author, fingerprint: meta.headRefOid, body });
      } else {
        const r = postComment(slug, prKey, body, writeGh);
        if (r.ok) {
          state[conflictKey] = meta.headRefOid;
          writeState(state);
          print({ ok: true, pr, mode: 'conflict', posted: true, author, fingerprint: meta.headRefOid });
        } else {
          print({ ok: true, pr, mode: 'conflict', posted: false, reason: 'comment-failed', author, error: r.error });
        }
      }
    }
    process.exit(0);
  }

  // ── 受保护路径提醒模式(状态键 `<PR>#protected-path`)──
  // auto 因「改动受保护路径(.github/** 等)」跳过该 PR 时,评论告知作者改了哪个文件、
  // 会开确认 issue 转人工审核、三种放行方式。去重指纹 = 受保护文件集合排序拼接(同一批文件
  // 只提醒一次;改了别的受保护文件 / 撤销全部受保护改动会重新评估)。
  const protectedPathMode = process.argv.includes('--protected-path');
  if (protectedPathMode) {
    const meta = ghJson(['pr', 'view', prKey, '--repo', slug, '--json', 'author,headRefOid,files']);
    const author = meta?.author?.login ?? '';
    const head = meta?.headRefOid ?? '';
    const protectedFiles = matchPathPatterns(
      (meta?.files ?? []).map((f) => f.path),
      (loadRules().protectedPaths?.paths) ?? [],
    );
    const ppKey = `${prKey}#protected-path`;
    const state = readState();
    const fingerprint = protectedFiles.slice().sort().join(',');
    if (isSelfFixAuthor(author)) {
      print({ ok: true, pr, mode: 'protected-path', posted: false, reason: 'self-fix-author', author, head });
    } else if (protectedFiles.length === 0) {
      if (state[ppKey] !== undefined && !dryRun) {
        delete state[ppKey];
        writeState(state);
      }
      print({ ok: true, pr, mode: 'protected-path', posted: false, reason: 'no-protected-files', author, head });
    } else if (state[ppKey] === fingerprint) {
      print({ ok: true, pr, mode: 'protected-path', posted: false, reason: 'already-commented', author, head, fingerprint });
    } else {
      const hit = protectedFiles.slice(0, 5).join(' / ');
      const more = protectedFiles.length > 5 ? ' 等' : '';
      const mention = author ? `@${author} ` : '';
      const modeNotice = reviewOnly
        ? '本轮是 review-only，不会自动合并。'
        : '自动流程不会合并、也不会自动审查。';
      const body =
        `${mention}👋 这个 PR 改动了受保护的路径(${hit}${more})。${modeNotice}\n\n` +
        '审查机会开确认 issue，转人工审核。维护者可用这三种方式放行：在确认 issue 上回复「同意放行」、在对应 Slack 讨论回复「同意放行」，或在本 PR 上 Approve。';
      if (dryRun) {
        print({ ok: true, pr, mode: 'protected-path', posted: false, reason: 'dry-run', author, head, fingerprint, body });
      } else {
        const r = postComment(slug, prKey, body, writeGh);
        if (r.ok) {
          state[ppKey] = fingerprint;
          writeState(state);
          print({ ok: true, pr, mode: 'protected-path', posted: true, author, head, fingerprint, protectedFiles });
        } else {
          print({ ok: true, pr, mode: 'protected-path', posted: false, reason: 'comment-failed', author, head, error: r.error });
        }
      }
    }
    process.exit(0);
  }

  const data = ghGraphql(GQL, { owner, repo, num: pr })?.data?.repository?.pullRequest ?? {};
  const author = data.author?.login ?? '';
  const threadResult = fetchAllReviewThreads(owner, repo, pr);
  if (!threadResult.verified) throw new Error(`thread 未完整读取:${threadResult.errors.join('; ')}`);
  const threads = threadResult.threads;
  const unresolved = threads.filter((t) => !t.isResolved);

  const state = readState();

  if (isSelfFixAuthor(author)) {
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
    if (state[prKey] === fingerprint) {
      print({ ok: true, pr, posted: false, reason: 'already-commented', author, fingerprint });
    } else {
      const paths = [...new Set(unresolved.map((t) => t.path).filter(Boolean))];
      const pathHint = paths.length
        ? `(${paths.slice(0, 5).join(' / ')}${paths.length > 5 ? ' 等' : ''})`
        : '';
      const mention = author ? `@${author} ` : '';
      const body = reviewOnly
        ? `${mention}👋 这个 PR 还有 ${unresolved.length} 条 review conversation 没 resolve${pathHint},` +
          `review-only 因此暂时跳过、无法完成本轮审查。\n\n` +
          `如果你已经按评论改完或回应了,请到对应 thread 上点 **Resolve conversation**;` +
          `全部 resolve 后可重新运行 review-pr-auto --review-only 复审。该模式不会主动执行 Merge。`
        : `${mention}👋 这个 PR 还有 ${unresolved.length} 条 review conversation 没 resolve${pathHint},` +
          `auto-review 因此暂时跳过、没法继续审查 / 合并。\n\n` +
          `如果你已经按评论改完或回应了,请到对应 thread 上点 **Resolve conversation**;` +
          `全部 resolve 后,下一轮 auto-review 会自动重新审查这个 PR。`;

      if (dryRun) {
        print({ ok: true, pr, reviewOnly, posted: false, reason: 'dry-run', author, fingerprint, body });
      } else {
        // 发评论:body 走 stdin(--body-file -),避免中文 / 特殊字符的命令行引号问题
        const r = writeGh(['pr', 'comment', prKey, '--repo', slug, '--body-file', '-'], {
          input: body,
          allowFail: true,
        });
        if (r.ok) {
          state[prKey] = fingerprint;
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
