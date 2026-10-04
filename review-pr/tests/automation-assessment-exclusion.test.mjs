import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  isAutomationAssessmentEnvelope, isExplicitSignoffConsent,
  evaluateDiscussionIssueConsent, parseSignoffReleases,
  parseSignoffReleaseMarkers, findApproveMergeAuthorization,
} from '../scripts/lib.mjs';
const head = 'a'.repeat(40);
const marker = `<!-- mivo-issue-assessment:v1 repo=acme/app issue=1 input=${'b'.repeat(64)} round=1 report=${'c'.repeat(64)} -->`;
const visible = '🤖 Mivo 自动评估（评估材料，不是人工批准）';
const source = readFileSync(new URL('../scripts/context.mjs', import.meta.url), 'utf8');
const comment = body => ({body,author:'PraiseZhu',createdAt:'2026-10-04T10:00:00Z',updatedAt:'2026-10-04T10:00:00Z'});
for (const [name, prefix] of Object.entries({canonical:marker,visible,unknown:'<!-- mivo-issue-assessment:v99 broken -->',malformed:'mivo-issue-assessment:',quoted:`> ${marker}`,late:`${'材料'.repeat(500)}\n${marker}`})) {
  test(`${name}: no consent, release or merge authorization`, () => {
    const body = `${prefix}\nLGTM\n同意放行\n<!-- signoff:release -->\n<!-- review-pr:signoff-release gates=security,rules by=PraiseZhu -->\n/approve-merge ${head}`;
    const c = comment(body);
    assert.equal(isAutomationAssessmentEnvelope(body),true);
    assert.equal(isExplicitSignoffConsent(body),false);
    assert.equal(evaluateDiscussionIssueConsent({whitelistComments:[c],headAppearedAt:c.createdAt,headOid:head}).consented,false);
    assert.equal(parseSignoffReleases([c,body]).size,0);
    assert.deepEqual(parseSignoffReleaseMarkers([c,body]),[]);
    assert.equal(findApproveMergeAuthorization({comments:[c],admins:['PraiseZhu'],headRefOid:head}).authorized,null);
  });
}
test('the full-body exclusion flag survives clipping in all public checks',()=>{
  const c = {...comment(`同意放行\n/approve-merge ${head}\n<!-- review-pr:signoff-release gates=security -->`),automationExcluded:true};
  assert.equal(evaluateDiscussionIssueConsent({whitelistComments:[c],headAppearedAt:c.createdAt}).consented,false);
  assert.equal(findApproveMergeAuthorization({comments:[c],admins:['PraiseZhu'],headRefOid:head}).authorized,null);
  assert.equal(parseSignoffReleases([c]).size,0);
  assert.deepEqual(parseSignoffReleaseMarkers([c]),[]);
});
test('genuine PraiseZhu consent and release remain eligible',()=>{
  const c = comment('同意放行');
  assert.equal(evaluateDiscussionIssueConsent({whitelistComments:[c],headAppearedAt:c.createdAt}).consented,true);
  assert.equal(isExplicitSignoffConsent('暂不同意放行'),false);
  assert.ok(findApproveMergeAuthorization({comments:[comment(`/approve-merge ${head}`)],admins:['PraiseZhu'],headRefOid:head}).authorized);
  assert.deepEqual(parseSignoffReleaseMarkers([comment('<!-- review-pr:signoff-release gates=rules -->')]).map(x=>x.kind),['rules']);
});
function contextFunction(name, vars) {
  const code = source.match(new RegExp(`  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(code, `${name} production implementation must be present`);
  return vm.runInNewContext(`(${code.trim()})`, {isAutomationAssessmentEnvelope,...vars});
}
test('production discussion material filters before clip and retains Slack human attribution',()=>{
  const body = `LGTM\n${'x'.repeat(700)}\n${marker}`;
  const cs = [{...comment(body),author:{login:'PraiseZhu'}},{...comment('同意放行'),author:{login:'PraiseZhu'}},{...comment('来自 Slack #mivo · @PraiseZhu(朱赞)\n同意放行'),author:{login:'github-actions[bot]'}}];
  const fn=contextFunction('readDiscussionIssue',{holdMarker:{issueNumber:1,issueUrl:'https://github.com/acme/app/issues/1'},slug:'acme/app',ghJson:()=>({state:'OPEN',comments:cs}),clip:(x,n)=>x.slice(0,n),SLACK_SYNC_BOTS:['github-actions[bot]'],normalizeBotLogin:x=>x.toLowerCase()});
  const result=fn(x=>x.toLowerCase()==='praisezhu');
  assert.equal(result.whitelistComments.length,2);
  assert.equal(result.whitelistComments[0].body,'同意放行');
  assert.equal(result.whitelistComments[1].resolvedLogin,'praisezhu');
});
test('production PR whitelist projection excludes late envelope for product and arch',()=>{
  const fn=contextFunction('collectPrWhitelistComments',{rawComments:[{...comment(`LGTM\n${'x'.repeat(700)}\n${marker}`),author:{login:'PraiseZhu'}},{...comment('同意放行'),author:{login:'PraiseZhu'}}],viewerLower:'other',clip:(x,n)=>x.slice(0,n)});
  assert.deepEqual(Array.from(fn(x=>x==='praisezhu'),x=>x.body),['同意放行']);
});
test('production cold-update raw comment projection excludes automation with viewer retained',()=>{
  const expression=source.match(/  const coldUpdateApproverComments = ([\s\S]*?)\n  const archGate =/)?.[1].trim().replace(/;$/,'');
  assert.ok(expression);
  const result=vm.runInNewContext(expression,{needsColdUpdateCheck:true,archDiscussionIssue:null,rawComments:[{...comment(`${marker}\n同意冷更`),author:{login:'PraiseZhu'}},{...comment('同意冷更'),author:{login:'PraiseZhu'}}],isColdUpdateApprover:x=>x==='PraiseZhu',isAutomationAssessmentEnvelope,viewerLower:'praisezhu',clip:(x,n)=>x.slice(0,n)});
  assert.equal(result.length,1);assert.equal(result[0].viaViewerAccount,true);
});
