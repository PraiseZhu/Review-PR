// deploy-tuple.mjs 命令行测试共用的夹具(不是测试文件,不被 *.test.mjs 通配符收进去)。
// 临时 HOME 当作 Mini:里面有一个 git 检出(旧提交在 HEAD,新提交已取到)、空的 launchd(launchctl 替身什么都不打印,
// 前置审查算「已停用」)、假的 gh(带状态)和一个一被调用就失败的 ssh(换版本只该连 Mini,这里 --on mini 就是本机)。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.join(HERE, 'deploy-tuple.mjs');
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// 只有 workflow_dispatch 触发的最小 workflow(两份内容不同,哈希不同)。
export const WORKFLOW_NEW = 'name: review-pr\n# 触发器\non:\n  workflow_dispatch:\n    inputs:\n      pr:\n        required: true\n';
export const WORKFLOW_OLD = 'name: review-pr\non:\n  workflow_dispatch:\n    inputs:\n      pr:\n        required: false\n';
export const WF_PATH = '.github/workflows/review-pr.yml';
export const PR_NUMBER = '5';
export const PR_HEAD = 'b'.repeat(40);
export const WF_NEW = sha256(WORKFLOW_NEW);
export const WF_OLD = sha256(WORKFLOW_OLD);

// gh 替身:状态放在 state.json。variable get/set 读写 MIVO_REVIEW_SKILL_SHA(给了 variableSeq 就按它依次回答 get,最后一项重复);
// 读 main 上的 review-pr.yml 时按 workflows 依次回答(最后一项重复),读 PR head 上的只回答 prHeadWorkflow;MIVO_REVIEW_MODE 按 modeSeq 依次回答;
// workflowApi、rules 为 null 表示那个接口 404。
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.FAKE_GH_STATE;
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const a = args.join(' ');
const out = (v) => process.stdout.write(String(v) + '\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(s));
if (a.startsWith('variable get MIVO_REVIEW_SKILL_SHA -R xindong/mivo-canvas-plugin')) {
  if (s.variableSeq) { out(s.variableSeq[Math.min(s.variableReads, s.variableSeq.length - 1)]); s.variableReads += 1; save(); } else out(s.variable);
}
else if (a.startsWith('variable set MIVO_REVIEW_SKILL_SHA -R xindong/mivo-canvas-plugin --body ')) { s.variable = args[args.length - 1]; s.sets.push(s.variable); save(); }
else if (a.startsWith('variable get MIVO_REVIEW_MODE -R xindong/mivo-canvas-plugin')) {
  out(s.modeSeq[Math.min(s.modeReads, s.modeSeq.length - 1)]); s.modeReads += 1; save();
}
else if (a === 'api repos/xindong/mivo-canvas-plugin/actions/workflows/review-pr.yml') {
  if (s.workflowApi === null) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
  out(JSON.stringify(s.workflowApi));
}
else if (a === 'api repos/xindong/mivo-canvas-plugin/contents/agent-use/docs/pr-rules.json?ref=main') {
  if (s.rules === null) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
  out(JSON.stringify(s.rules));
}
else if (a.startsWith('pr view ')) out(JSON.stringify(s.pr));
else if (a.startsWith('api repos/PraiseZhu/Review-PR/commits/') && a.endsWith('--jq .sha')) out(s.newSkill);
else if (a.startsWith('api repos/PraiseZhu/Review-PR/compare/')) out(JSON.stringify({ status: 'identical', aheadBy: 0, messages: [] }));
else if (a.includes('contents/.github/workflows/review-pr.yml')) {
  // 按 ?ref= 回答:main 按 workflows 依次回答;PR head 只回答 prHeadWorkflow;别的 ref 一律失败(读错 ref 的回归会变红)。
  const ref = (/[?]ref=([^ ]+)/.exec(a) || [])[1];
  let text;
  if (ref === 'main') { text = s.workflows[Math.min(s.contentReads, s.workflows.length - 1)]; s.contentReads += 1; save(); }
  else if (ref === s.prHead && typeof s.prHeadWorkflow === 'string') text = s.prHeadWorkflow;
  else { process.stderr.write('gh 替身没准备这个 ref 的 workflow: ' + ref); process.exit(1); }
  out(Buffer.from(text).toString('base64'));
} else { process.stderr.write('gh 替身没准备这个调用: ' + a); process.exit(1); }
`;
// ssh 替身:任何调用都记下来并失败,模拟 Air 离线。
const FAKE_SSH = `#!/bin/sh
echo "$@" >> "$FAKE_SSH_LOG"
echo "ssh: Connection timed out during banner exchange" >&2
exit 255
`;
// launchctl 替身:什么都不打印、退出 1,launchState() 读到 absent(前置审查已停用)。
const FAKE_LAUNCHCTL = `#!/bin/sh
exit 1
`;

const PR_RULES = { type: 'file', encoding: 'base64', content: Buffer.from('{"version":1}').toString('base64') };
const WORKFLOW_API = { id: 381252611, path: WF_PATH, state: 'active' };

export function setupFixture(t, { variable, variableSeq, workflows = [WORKFLOW_NEW], mode = ['live'], workflowApi = WORKFLOW_API, rules = PR_RULES, prHeadWorkflow } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-deploy-tuple-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const skill = path.join(home, 'mivo-prereview/skill');
  fs.mkdirSync(skill, { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', skill, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'old');
  const oldSkill = git('rev-parse', 'HEAD').stdout.trim();
  git('commit', '-q', '--allow-empty', '-m', 'new');
  const newSkill = git('rev-parse', 'HEAD').stdout.trim();
  git('-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', oldSkill);
  assert.match(oldSkill, /^[0-9a-f]{40}$/);
  assert.match(newSkill, /^[0-9a-f]{40}$/);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const [name, text] of [['gh', FAKE_GH], ['ssh', FAKE_SSH], ['launchctl', FAKE_LAUNCHCTL]]) {
    fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
  }
  const statePath = path.join(root, 'gh-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ variable: variable ?? oldSkill, variableSeq: variableSeq?.({ oldSkill, newSkill }), variableReads: 0, newSkill, workflows, contentReads: 0, sets: [],
    modeSeq: Array.isArray(mode) ? mode : [mode], modeReads: 0, workflowApi, rules,
    pr: { state: 'OPEN', headRefOid: PR_HEAD, statusCheckRollup: [] }, prHead: PR_HEAD, prHeadWorkflow }));
  const sshLog = path.join(root, 'ssh.log');
  const recordDir = path.join(root, 'records');
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: statePath, FAKE_SSH_LOG: sshLog };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 120_000 });
  const deploy = ({ oldWf = WF_OLD, newWf = WF_NEW, extra = [] } = {}) => run('--on', 'mini', '--old-skill', oldSkill, '--new-skill', newSkill,
    '--old-wf', oldWf, '--new-wf', newWf, '--stop', 'hold', '--max-wait-min', '1', '--record-dir', recordDir, ...extra);
  return {
    home, root, oldSkill, newSkill, run, deploy, sshLog, recordDir,
    ghState: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    checkoutHead: () => git('rev-parse', 'HEAD').stdout.trim(),
    exists: (rel) => fs.existsSync(path.join(home, rel)),
    records: () => (fs.existsSync(recordDir) ? fs.readdirSync(recordDir).filter((n) => n.endsWith('.record.json')) : [])
      .map((n) => JSON.parse(fs.readFileSync(path.join(recordDir, n), 'utf8'))),
  };
}
