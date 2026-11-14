const maxRecoveryBytes = 2 * 1024 * 1024;
const whitespace = /[\t\n\r ]/;
const badReply = () => new SyntaxError('Expected a single valid JSON object');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function wrapper(text) {
  const trimmed = text.trim();
  return !trimmed || (!/[{}\[\]`]/.test(trimmed) && /\p{L}/u.test(trimmed));
}

function fenced(text) {
  if (text.startsWith('```') && text.endsWith('```') && text.length >= 6) {
    const content = text.slice(3, -3).replace(/^json(?=\s|\{)/i, '');
    return {text: content, surrounding: false};
  }

  const marker = /^[ \t]*\x60{3}(json)?[ \t]*\r?$/gim;
  const open = marker.exec(text);
  if (!open) return undefined;
  const close = marker.exec(text);
  if (!close || close[1] || marker.exec(text)) throw badReply();
  const before = text.slice(0, open.index);
  const after = text.slice(close.index + close[0].length);
  if (!wrapper(before) || !wrapper(after)) throw badReply();
  return {text: text.slice(open.index + open[0].length, close.index), surrounding: Boolean(before.trim() || after.trim())};
}

function afterString(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  throw badReply();
}

function withoutComments(text) {
  const parts = [];
  let from = 0;
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') {
      i = afterString(text, i);
      continue;
    }
    const start = i++;
    if (text[start] !== '/') continue;
    if (text[i] === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
    } else if (text[i] === '*') {
      i = text.indexOf('*/', i + 1);
      if (i < 0) throw badReply();
      i += 2;
    } else continue;
    parts.push(text.slice(from, start), ' ');
    from = i;
  }
  return parts.length ? {text: parts.join('') + text.slice(from), removed: true} : {text, removed: false};
}

function balancedObject(text, allowProse) {
  const first = text.indexOf('{');
  if (first < 0 || !wrapper(text.slice(0, first))) throw badReply();

  const stack = [];
  for (let i = first; i < text.length;) {
    const ch = text[i];
    if (ch === '"') {
      i = afterString(text, i);
      continue;
    }
    i++;
    if (ch === '{' || ch === '[') stack.push(ch);
    if (ch === '}' || ch === ']') {
      if (stack.pop() !== (ch === '}' ? '{' : '[')) throw badReply();
      if (!stack.length) {
        const after = text.slice(i);
        const surrounding = Boolean(text.slice(0, first).trim() || after.trim());
        if (!wrapper(after) || (!allowProse && surrounding)) throw badReply();
        return {text: text.slice(first, i), surrounding};
      }
    }
  }
  throw badReply();
}

function withoutTrailingCommas(text) {
  const parts = [];
  let from = 0;
  let previous;
  for (let i = 0; i < text.length;) {
    const ch = text[i++];
    if (ch === '"') i = afterString(text, i - 1);
    else if (ch === ',' && !['{', '[', ':', ','].includes(previous)) {
      const comma = i - 1;
      while (i < text.length && whitespace.test(text[i])) i++;
      if (text[i] === '}' || text[i] === ']') {
        parts.push(text.slice(from, comma));
        from = i;
      }
    }
    if (!whitespace.test(ch)) previous = ch;
  }
  return parts.length ? {text: parts.join('') + text.slice(from), removed: true} : {text, removed: false};
}

export function parseModelJSON(text) {
  if (typeof text !== 'string') throw badReply();
  const cleaned = text.trim();
  let strict;
  try {
    strict = JSON.parse(cleaned);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (strict !== undefined) {
    if (!object(strict)) throw badReply();
    return {value: strict, repairs: []};
  }
  if (cleaned.length > maxRecoveryBytes || Buffer.byteLength(cleaned) > maxRecoveryBytes) throw badReply();

  const fence = fenced(cleaned);
  const comments = withoutComments(fence?.text ?? cleaned);
  const candidate = balancedObject(comments.text, !fence);
  const commas = withoutTrailingCommas(candidate.text);
  const value = JSON.parse(commas.text);
  if (!object(value)) throw badReply();
  const repairs = [];
  if (fence) repairs.push('markdown_fence');
  if (fence?.surrounding || candidate.surrounding) repairs.push('surrounding_text');
  if (comments.removed) repairs.push('comments');
  if (commas.removed) repairs.push('trailing_commas');
  return {value, repairs};
}
