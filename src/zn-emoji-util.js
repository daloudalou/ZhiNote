/**
 * znEmoji 存盘编解码（纯 JSON，无 DOM）
 * 编辑器内用原子节点；落盘 / 判脏 / 同步前摊成 Unicode 文本，兼容旧笔记与旧客户端。
 */
(function (root) {
  'use strict';

  function marksKey(marks) {
    if (!marks || !marks.length) return '';
    try { return JSON.stringify(marks); } catch (_) { return ''; }
  }

  /** 把 doc(JSON) 里的 znEmoji 节点摊成 text，并合并相邻同 marks 文本 */
  function flattenZnEmojiDocJSON(doc) {
    if (!doc || typeof doc !== 'object') return doc;

    function walk(node) {
      if (!node || typeof node !== 'object') return node;
      if (node.type === 'znEmoji') {
        const text = (node.attrs && node.attrs.emoji) || '';
        if (!text) return null;
        const out = { type: 'text', text: text };
        if (node.marks && node.marks.length) out.marks = node.marks;
        return out;
      }
      if (!Array.isArray(node.content)) return node;
      const next = [];
      for (let i = 0; i < node.content.length; i++) {
        const child = walk(node.content[i]);
        if (child == null) continue;
        const last = next[next.length - 1];
        if (
          child.type === 'text' &&
          last &&
          last.type === 'text' &&
          marksKey(last.marks) === marksKey(child.marks)
        ) {
          last.text += child.text;
        } else {
          next.push(child);
        }
      }
      const copy = {};
      for (const k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k) && k !== 'content') copy[k] = node[k];
      }
      copy.content = next;
      return copy;
    }

    return walk(doc);
  }

  /** 递归 JSON 里所有表情字（znEmoji + 文本里的簇），供暖图 */
  function collectEmojisFromDocJSON(doc, looksEmoji) {
    const list = [];
    const seen = Object.create(null);
    function add(ch) {
      if (!ch || seen[ch]) return;
      if (typeof looksEmoji === 'function' && !looksEmoji(ch)) return;
      seen[ch] = 1;
      list.push(ch);
    }
    function walk(node) {
      if (!node) return;
      if (node.type === 'znEmoji') {
        add((node.attrs && node.attrs.emoji) || '');
        return;
      }
      if (node.type === 'text' && node.text && typeof looksEmoji === 'function') {
        // 粗扫：按码点交给 looksEmoji 的调用方通常用 segmenter；这里只收集整段若本身是表情
        if (looksEmoji(node.text)) add(node.text);
      }
      if (Array.isArray(node.content)) node.content.forEach(walk);
    }
    walk(doc);
    return list;
  }

  const api = {
    flattenZnEmojiDocJSON: flattenZnEmojiDocJSON,
    collectEmojisFromDocJSON: collectEmojisFromDocJSON,
  };
  root.znEmojiUtil = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
