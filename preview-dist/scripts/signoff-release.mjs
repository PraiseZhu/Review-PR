#!/usr/bin/env node
// signoff-release.mjs — 安全/规则门放行后的写入路径:摘 awaiting-discussion,并按
// decideCloseOnRelease 关闭讨论 issue。不把普通「同意」写成跨 commit 持久标记。
//
// 判定与执行解耦:关 issue / 摘标签失败不回头改 released。
//
// 跑:node scripts/signoff-release.mjs --scan-json <path|-> [--dry-run]
//   scan-json 必须含 signoff.released / signoff.closeOnRelease / signoff.label / number。

import { readFileSync } from 'node:fs';
import { parseRepo, gh, print, fail, SIGNOFF_LABEL_DEFAULT, syncSignoffLabel, performIssueClose } from './lib.mjs';

function readScanJson(src) {
  const raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
  return JSON.parse(raw);
}

export function planSignoffReleaseWrite(scan, { trustedLogins = [] } = {}) {
  const signoff = scan?.signoff ?? {};
  const released = signoff.released === true;
  const close = signoff.closeOnRelease ?? { shouldClose: false, reason: 'no-decision' };
  return {
    released,
    shouldRemoveLabel: released,
    label: (signoff.label ?? SIGNOFF_LABEL_DEFAULT).trim() || SIGNOFF_LABEL_DEFAULT,
    close,
    trustedLogins,
  };
}

export function applySignoffReleaseWrite(plan, {
  slug,
  pr,
  currentLabels = [],
  ghFn,
  dryRun = false,
} = {}) {
  const labelResult = plan.shouldRemoveLabel
    ? syncSignoffLabel({
      owner: slug.split('/')[0],
      repo: slug.split('/')[1],
      pr,
      label: plan.label,
      want: false,
      current: currentLabels,
      ghFn,
      dryRun,
    })
    : { changed: false, dryRun, skipped: true };
  let closeResult = { closed: false, reason: plan.close?.reason ?? 'no-decision' };
  if (plan.close?.shouldClose === true && plan.close.issueNumber != null) {
    closeResult = performIssueClose({
      slug,
      issueNumber: plan.close.issueNumber,
      ghFn,
      dryRun,
    });
  }
  return {
    released: plan.released,
    label: labelResult,
    close: closeResult,
  };
}

const isCLI = process.argv[1] && import.meta.url.endsWith(process.argv[1].slice(process.argv[1].lastIndexOf('/') >= 0 ? process.argv[1].lastIndexOf('/') : 0));

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('signoff-release.mjs')) {
  try {
    const argv = process.argv.slice(2);
    const jsonIdx = argv.indexOf('--scan-json');
    if (jsonIdx < 0 || !argv[jsonIdx + 1]) fail('缺少 --scan-json');
    const dryRun = argv.includes('--dry-run');
    const scan = readScanJson(argv[jsonIdx + 1]);
    const { owner, repo } = parseRepo();
    const slug = `${owner}/${repo}`;
    const plan = planSignoffReleaseWrite(scan);
    const applied = applySignoffReleaseWrite(plan, {
      slug,
      pr: scan.number ?? scan.pr,
      currentLabels: (scan.labels ?? []).map((l) => l.name ?? l),
      gh,
      dryRun,
    });
    print({ ok: true, ...applied });
  } catch (e) {
    fail(String(e?.message ?? e));
  }
}
