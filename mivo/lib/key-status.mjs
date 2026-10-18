// key-status.mjs — Mini 从服务器结果包推断模型网关 key 的状态(规则见 server/keys.mjs),纯函数:
//   primary  主 key 能用;backup  主 key 不能用,正在用备用 key;down  在用的那把(或没有备用时的主 key)也报 key 错误。
// 推不出来(冷却期里只用了备用 key、网关 5xx、没调模型)返回 null,Mini 保持原状态不写。
// 状态变化时 Mini 写仓库变量 MIVO_REVIEW_KEY_STATUS,Mivo 的看门狗据此发 Slack;reason 只写错误类别,不带任何 key 内容。

export const KEY_STATES = ['primary', 'backup', 'down'];
const KIND_TEXT = { auth: '认证失败', budget: '额度或预算用完', access: '没有该模型的权限', 'rate-limit': '被限流' };
const kindText = (failure) => (failure ? `${KIND_TEXT[failure.kind] ?? failure.kind}${failure.status ? `(${failure.status})` : ''}` : '');

/** credential:结果包 mivo.codex.credential;attempts:mivo.codex.attempts。 */
export function toKeyStatus(credential, attempts = []) {
  if (!credential || typeof credential !== 'object') return null;
  const last = Array.isArray(attempts) ? attempts.at(-1) : null;
  if (credential.down) return 'down';
  if (last?.keyFailure && (last.credential === 'backup' || !credential.backupConfigured)) return 'down';
  if (credential.switched || (credential.startedOn === 'backup' && !credential.preferBackup)) return 'backup';
  if (credential.primaryOk) return 'primary';
  return null;
}

/** 给人看的一句原因(进 MIVO_REVIEW_KEY_STATUS 与 Slack)。 */
export function toKeyStatusReason(status, credential, attempts = []) {
  const last = Array.isArray(attempts) ? attempts.at(-1) : null;
  if (status === 'primary') return '主 key 正常';
  if (status === 'down' && credential?.down?.phase === 'verify') {
    return credential.backupConfigured
      ? `核对员调用时备用 key 也报 key 错误:${kindText(credential.down) || '未知'};本轮主审结果照常发布,下一轮先试主 key`
      : `核对员调用时主 key 报 key 错误:${kindText(credential.down) || '未知'},没有配置备用 key;本轮主审结果照常发布`;
  }
  if (status === 'down') {
    const failure = last?.keyFailure ?? credential?.down;
    return credential?.backupConfigured
      ? `备用 key 也报 key 错误:${kindText(failure) || '未知'};Mini 暂停审查 60 分钟后再试`
      : `主 key 报 key 错误:${kindText(failure) || '未知'},没有配置备用 key;Mini 暂停审查 60 分钟后再试`;
  }
  if (credential?.switched) {
    return `主 key ${kindText(credential.switched) || '报 key 错误'}${credential.switched.midRun ? '(审到一半)' : ''},已自动改用备用 key`;
  }
  return '主 key 凭据不可用,已自动改用备用 key';
}
