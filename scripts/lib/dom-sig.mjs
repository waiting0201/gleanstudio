/**
 * DOM 正規化簽章 —— Level B 比對的核心。
 *
 * 排序屬性、收斂無意義空白，把兩份 HTML 化簡成可以直接字串比對的形狀。
 * `scripts/parity-diff.mjs`（比 golden）與 `scripts/parity-contact.mjs`
 * （比 tests/derived/）共用同一份，避免兩邊的「相等」定義漂移。
 */
import { parse } from 'parse5';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// 這些元素裡的空白有意義，不收斂
const PRE = new Set(['pre', 'textarea', 'script', 'style']);

export function serialize(node, inPre = false) {
  if (node.nodeName === '#text') {
    const t = inPre ? node.value : node.value.replace(/\s+/g, ' ');
    return t.trim() === '' ? '' : t;
  }
  if (node.nodeName === '#comment') return `<!--${node.data.trim()}-->`;
  if (node.nodeName === '#documentType') return '<!doctype>';
  if (!node.tagName) return (node.childNodes ?? []).map((c) => serialize(c, inPre)).join('');

  const attrs = (node.attrs ?? [])
    .map((a) => [a.name, a.name === 'class' ? a.value.trim().split(/\s+/).sort().join(' ') : a.value.trim()])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([n, v]) => `${n}="${v}"`)
    .join(' ');

  const open = `<${node.tagName}${attrs ? ' ' + attrs : ''}>`;
  if (VOID.has(node.tagName)) return open;
  const nextPre = inPre || PRE.has(node.tagName);
  const inner = (node.childNodes ?? []).map((c) => serialize(c, nextPre)).join('');
  return `${open}${inner}</${node.tagName}>`;
}

export const domSig = (html) => serialize(parse(html));

/** 找出兩個字串第一個不同的位置，並附上上下文。 */
export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const from = Math.max(0, i - 70);
  return {
    index: i,
    expected: JSON.stringify(a.slice(from, i + 70)),
    actual: JSON.stringify(b.slice(from, i + 70)),
  };
}
