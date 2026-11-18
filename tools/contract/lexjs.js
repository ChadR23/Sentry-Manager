'use strict';

// A small JavaScript lexer for the contract tools: finds every string and
// template literal (with the text of its ${…} holes) and gives back a "mask"
// of the source (same length, every literal, comment and regex blanked), so
// brackets can be matched on code alone. Not a parser: enough for this repo.

const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

function lex(src) {
  const literals = []; // { start, end, quote, parts: [text…], holes: [code…] }
  const mask = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (mask[k] !== '\n') mask[k] = ' '; };
  let i = 0;
  let lastSig = ''; // last significant character outside literals, or a word

  function readString(q) {
    const start = i;
    let text = '';
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') { text += src[i + 1] === undefined ? '' : unescape1(src[i + 1]); i += 2; continue; }
      if (src[i] === '\n') break; // broken string: stop at the line end
      text += src[i++];
    }
    i++;
    literals.push({ start, end: i, quote: q, parts: [text], holes: [] });
    blank(start + 1, i - 1);
  }

  function readTemplate() {
    const start = i;
    const parts = [''];
    const holes = [];
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { parts[parts.length - 1] += unescape1(src[i + 1]); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        const hs = i;
        skipCode('}');
        holes.push(src.slice(hs, i));
        parts.push('');
        i++; // the }
        continue;
      }
      parts[parts.length - 1] += src[i++];
    }
    i++;
    const lit = { start, end: i, quote: '`', parts, holes };
    literals.push(lit);
    blank(start + 1, i - 1);
  }

  // code until an unmatched `close` at depth 0 (inside a template hole)
  function skipCode(close) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === close && depth === 0) return;
      if (step()) continue;
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      i++;
    }
  }

  // one token that is not plain punctuation; true when it moved i
  function step() {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e === -1 ? src.length : e; blank(i, end); i = end; return true; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? src.length : e + 2; blank(i, end); i = end; return true; }
    if (c === '\'' || c === '"') { readString(c); lastSig = 'lit'; return true; }
    if (c === '`') { readTemplate(); lastSig = 'lit'; return true; }
    if (c === '/' && (REGEX_BEFORE.has(lastSig) || REGEX_AFTER_WORD.has(lastSig) || lastSig === '')) {
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] || '')) i++;
      blank(start + 1, i - 1);
      lastSig = 'lit';
      return true;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      lastSig = src.slice(i, j);
      i = j;
      return true;
    }
    if (/\d/.test(c)) { while (i < src.length && /[\w.]/.test(src[i])) i++; lastSig = 'num'; return true; }
    if (!/\s/.test(c)) lastSig = c;
    return false;
  }

  while (i < src.length) {
    if (!step()) i++;
  }
  return { literals, mask: mask.join('') };
}

function unescape1(ch) {
  return ({ n: '\n', t: '\t', r: '\r', '0': '\0' })[ch] ?? ch;
}

/** Index of the bracket that closes the one at `open` in a mask, or -1. */
function matchBracket(mask, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const want = pairs[mask[open]];
  let depth = 0;
  for (let k = open; k < mask.length; k++) {
    const c = mask[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return c === want ? k : -1;
    }
  }
  return -1;
}

/** 1-based line number of offset `pos`. */
function lineOf(src, pos) {
  let n = 1;
  for (let k = 0; k < pos && k < src.length; k++) if (src.charCodeAt(k) === 10) n++;
  return n;
}

function lineIndex(src) {
  const starts = [0];
  for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) starts.push(k + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

module.exports = { lex, matchBracket, lineOf, lineIndex };
