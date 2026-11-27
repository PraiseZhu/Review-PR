import fs from 'node:fs';
import path from 'node:path';
import { toManualTasks, toManifest } from './cutover-lib.mjs';

const journalName = 'journal.json';
export const backupRoot = 'mivo-prereview/cutover-backup';

export function localPath(home, relative, { missing = false } = {}) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) ||
      relative.split('/').some((piece) => !piece || piece === '.' || piece === '..')) {
    throw new Error('不安全的相对路径：' + relative);
  }
  let current = home;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('不跟随符号链接：' + current);
    } catch (error) {
      if (!missing || error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}

function saveJournal(directory, record) {
  const file = path.join(directory, journalName);
  const temporary = file + '.next';
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const rollbackHint = (directory, home, installer) =>
  'node mivo/deploy/cutover.mjs --rollback ' + quote(directory) + ' --home ' + quote(home) +
  (installer ? ' --install-mini ' + quote(installer) : '');

export function runApply({ manifest, segment, home, steps, yes, installer, execute, prepare = (step) => step.undo, preview }) {
  console.log('# 换仓 ' + segment + '：' + manifest.oldRepo + ' → ' + manifest.newRepo);
  console.log(yes ? '确认执行' : '只演示，未写入（需要 --yes）');
  for (const step of steps) {
    console.log((step.skip ? '跳过' : '执行') + ' ' + step.action + ' ' + step.target + '：' +
      JSON.stringify(step.before) + ' → ' + JSON.stringify(step.after) + (step.note ? '；' + step.note : ''));
  }
  console.log('\n# Cindy 与仓外人工项\n' + toManualTasks(manifest).join('\n'));
  if (!yes) return 0;

  const changes = steps.filter((step) => !step.skip);
  if (changes.length === 0) {
    console.log('\n执行完成：0 步写入，未创建备份。');
    return preview();
  }
  const root = localPath(home, backupRoot, { missing: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const directory = fs.mkdtempSync(path.join(root, timestamp + '-'));
  const record = { version: 1, manifest, segment, home, completed: [], pending: null };
  saveJournal(directory, record);
  console.log('\n备份：' + directory);
  for (const [index, step] of changes.entries()) {
    const target = step.action + ' ' + step.target;
    try {
      const undo = prepare(step, directory, index);
      record.pending = { target, undo: segment === 'mini' ? undo : null };
      saveJournal(directory, record);
      const result = execute(step.operation);
      let completedUndo = undo;
      if (undo?.responseId) {
        const id = result?.[undo.responseId];
        if (!Number.isSafeInteger(id) || id < 1) throw new Error('写入返回缺少 ID，需人工核对本步结果');
        completedUndo = { method: undo.method, endpoint: undo.endpoint + '/' + id };
      }
      record.completed.push({ target, undo: completedUndo });
      record.pending = null;
      saveJournal(directory, record);
      console.log('完成 ' + (index + 1) + '/' + changes.length + '：' + target);
    } catch (error) {
      if (segment === 'github' && Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500 &&
          error.httpStatus !== 408) {
        record.pending = null;
        saveJournal(directory, record);
      }
      console.error('失败于 ' + target + '：' + error.message + '；已确认 ' + record.completed.length + ' 步，后续未执行。');
      if (record.pending && segment === 'github') console.error('本步写入结果不确定，回滚前请人工核对该项。');
      console.error('回滚：' + rollbackHint(directory, home, installer));
      return 1;
    }
  }
  console.log('\n执行完成：' + changes.length + ' 步写入。');
  console.log('回滚：' + rollbackHint(directory, home, installer));
  return preview();
}

export function readJournal(directory, home) {
  const root = localPath(home, backupRoot);
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== root || resolved !== path.resolve(directory)) {
    throw new Error('备份目录必须是 --home 下 ' + backupRoot + ' 的直接子目录，不跟随符号链接');
  }
  const record = JSON.parse(fs.readFileSync(localPath(resolved, journalName), 'utf8'));
  if (record.version !== 1 || record.home !== home || !['github', 'mini'].includes(record.segment) ||
      !Array.isArray(record.completed)) throw new Error('备份目录的记录版本、类型或 --home 不符');
  record.manifest = toManifest(JSON.stringify(record.manifest));
  if (record.manifest.oldRepo.toLowerCase() === record.manifest.newRepo.toLowerCase()) throw new Error('备份的新旧仓不能相同');
  return { directory: resolved, record };
}

export function runRollback({ directory, record, undo }) {
  if (record.pending && record.segment === 'github') throw new Error('上次写入结果不确定，请人工核对：' + record.pending.target);
  const pending = record.pending;
  if (pending?.undo && pending.undo.type !== 'installer') {
    undo(pending.undo, directory);
    record.pending = null;
    saveJournal(directory, record);
    console.log('已还原未完成步骤：' + pending.target);
  }
  while (record.completed.length) {
    const index = record.completed.findLastIndex(({ undo: step }) => step.type !== 'installer');
    const position = index === -1 ? record.completed.length - 1 : index;
    const last = record.completed[position];
    undo(last.undo, directory);
    record.completed.splice(position, 1);
    saveJournal(directory, record);
    console.log('已还原：' + last.target);
  }
  if (record.pending?.undo?.type === 'installer') {
    undo(record.pending.undo, directory);
    record.pending = null;
    saveJournal(directory, record);
    console.log('已还原未完成步骤：' + pending.target);
  }
  console.log('回滚完成。');
}
