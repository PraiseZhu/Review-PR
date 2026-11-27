function toTokens(text) {
  JSON.parse(text);
  return Array.from(text.matchAll(/"(?:[^"\\]|\\.)*"|[^\s,:\[\]{}"]+|[,:\[\]{}]/g), (match) =>
    ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

function toTree(text) {
  const tokens = toTokens(text);
  let next = 0;
  function parse() {
    const token = tokens[next++];
    if (token.text === '{' || token.text === '[') {
      const isObject = token.text === '{';
      const close = isObject ? '}' : ']';
      const entries = new Map();
      while (tokens[next].text !== close) {
        const keyToken = isObject ? tokens[next++] : null;
        if (keyToken) next++;
        const name = keyToken ? JSON.parse(keyToken.text) : entries.size;
        if (entries.has(name)) throw new Error('JSON 字段重复：' + name);
        entries.set(name, { keyToken, node: parse() });
        if (tokens[next].text === ',') next++;
      }
      const end = tokens[next++];
      return { start: token.start, end: end.end, entries, isObject };
    }
    return { ...token, value: JSON.parse(token.text) };
  }
  return parse();
}

export function toJsonEditor(text) {
  const root = toTree(text);
  const edits = [];
  const find = (keys) => {
    let node = root;
    for (const key of keys) node = node?.entries?.get(key)?.node;
    if (!node) throw new Error('缺少 JSON 字段 ' + keys.join('.'));
    return node;
  };
  function replace(node, next) {
    edits.push({ start: node.start, end: node.end, value: JSON.stringify(next) });
  }
  return {
    field(keys, before, after) {
      const node = find(keys);
      if (node.value === after) return;
      if (node.value !== before) throw new Error('JSON 字段 ' + keys.join('.') + ' 不符合预期');
      replace(node, after);
    },
    key(keys, before, after) {
      const node = find(keys);
      if (!node.isObject) throw new Error('JSON 字段 ' + keys.join('.') + ' 不是对象');
      const prior = node.entries.get(before);
      if (node.entries.has(after)) {
        if (!prior) return;
        throw new Error('JSON 对象同时含新、旧仓键：' + keys.join('.'));
      }
      if (!prior) throw new Error('JSON 对象缺少旧仓键：' + keys.join('.'));
      replace(prior.keyToken, after);
    },
    array(keys, before, after, { retain = false } = {}) {
      const node = find(keys);
      if (!node.entries || node.isObject) throw new Error('JSON 字段 ' + keys.join('.') + ' 不是数组');
      const entries = Array.from(node.entries.values(), (entry) => entry.node);
      const oldEntries = entries.filter((entry) => entry.value === before);
      const newEntries = entries.filter((entry) => entry.value === after);
      if (oldEntries.length > 1 || newEntries.length > 1) throw new Error('JSON 仓白名单含重复项：' + keys.join('.'));
      if (newEntries.length && (retain || !oldEntries.length)) return;
      if (newEntries.length || !oldEntries.length) throw new Error('JSON 仓白名单不符合预期：' + keys.join('.'));
      if (!retain) {
        replace(oldEntries[0], after);
        return;
      }
      const last = entries.at(-1);
      const lineBreak = text.lastIndexOf('\n', last.start);
      const leadingSpace = text.slice(lineBreak + 1, last.start);
      const separator = lineBreak >= node.start && /^\s*$/.test(leadingSpace)
        ? (text[lineBreak - 1] === '\r' ? '\r\n' : '\n') + leadingSpace
        : (text[last.end] === ' ' ? ' ' : '');
      edits.push({ start: last.end, end: last.end, value: ',' + separator + JSON.stringify(after) });
    },
    finish() {
      let next = text;
      for (const edit of edits.sort((left, right) => right.start - left.start)) {
        next = next.slice(0, edit.start) + edit.value + next.slice(edit.end);
      }
      JSON.parse(next);
      return next;
    },
  };
}
