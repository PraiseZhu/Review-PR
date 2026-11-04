// [MIVO-PATCH reviewer-app] 「这条评论是不是审查账号写的」:按审查身份集合判,兼容旧的 reviewer 字符串。
// reviewerIdentity 是 review-pr/scripts/reviewer-identity.mjs 的 createReviewIdentity 结果(可 JSON 往返);没传就用 reviewer 字符串当单账号集合。
// 作者可以是 {login, __typename|type} 或字符串;GraphQL 的 Bot 登录名不带 [bot],靠 __typename 与同名 User 区分。
import { toReviewIdentity, isReviewIdentity } from '../../review-pr/scripts/reviewer-identity.mjs';

export function toReviewerIdentity(reviewer, reviewerIdentity) {
  return toReviewIdentity(reviewerIdentity ?? reviewer);
}

export function hasReviewer(reviewer, reviewerIdentity) {
  return toReviewerIdentity(reviewer, reviewerIdentity).logins.length > 0;
}

export function toReviewerMatcher(reviewer, reviewerIdentity) {
  const identity = toReviewerIdentity(reviewer, reviewerIdentity);
  return (author) => isReviewIdentity(author, identity);
}
