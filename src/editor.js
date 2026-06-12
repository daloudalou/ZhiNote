/**
 * editor.js — Tiptap-based WYSIWYG Markdown editor (local bundle version)
 */
(function() {

const {
  Editor, StarterKit, BubbleMenu, Highlight,
  Table, TableRow, TableCell, TableHeader,
  Image, TaskList, TaskItem, Underline,
  Placeholder, Link, Markdown, Node, Extension, mergeAttributes,
  CodeBlock,
  Plugin, PluginKey, Decoration, DecorationSet,
} = window.__tiptapBundle;

/**
 * TextAlign — 段落/标题对齐（左/居中/右/两端）。内核 bundle 未打包官方扩展，这里按官方实现自写：
 * 用 addGlobalAttributes 给 paragraph/heading 加 textAlign 属性（无需改动 StarterKit 节点），
 * renderHTML 输出 inline style:text-align，存进 doc(JSON) 全保真。导出 .md 无对齐语法→丢失（同高亮重叠的取舍）。
 */
const TextAlign = Extension.create({
  name: 'textAlign',
  addOptions() {
    return {
      types: ['paragraph', 'heading'],
      alignments: ['left', 'center', 'right', 'justify'],
      defaultAlignment: null,
    };
  },
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        textAlign: {
          default: this.options.defaultAlignment,
          parseHTML: (el) => {
            const a = el.style.textAlign || el.getAttribute('align') || null;
            return this.options.alignments.includes(a) ? a : this.options.defaultAlignment;
          },
          renderHTML: (attrs) => (attrs.textAlign ? { style: `text-align: ${attrs.textAlign}` } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      setTextAlign: (alignment) => ({ commands }) => {
        if (!this.options.alignments.includes(alignment)) return false;
        return this.options.types.every((type) => commands.updateAttributes(type, { textAlign: alignment }));
      },
      unsetTextAlign: () => ({ commands }) =>
        this.options.types.every((type) => commands.resetAttributes(type, 'textAlign')),
    };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-l': () => this.editor.commands.setTextAlign('left'),
      'Mod-Shift-e': () => this.editor.commands.setTextAlign('center'),
      'Mod-Shift-r': () => this.editor.commands.setTextAlign('right'),
      'Mod-Shift-j': () => this.editor.commands.setTextAlign('justify'),
    };
  },
});

/**
 * 图片 data-URL 缓存（模块级，供 renderHTML 和 rehydrate 共用）
 * key = hash（zhinote://img/ 之后的部分），value = data:image/... URL
 */
const _imgDataCache = new Map();

const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      latex: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-math-inline]', getAttrs: el => ({ latex: el.getAttribute('data-latex') || '' }) }];
  },
  renderHTML({ node }) {
    return ['span', { 'data-math-inline': '', 'data-latex': node.attrs.latex, class: 'math-node math-node-inline' }];
  },
  renderMarkdown(node) {
    return `$${node.attrs.latex}$`;
  },
  addStorage() {
    return { clipboardTextSerializer: node => `$${node.attrs.latex}$` };
  },
  addNodeView() {
    return ({ node, getPos, editor: ed }) => {
      const dom = document.createElement('span');
      dom.className = 'math-node math-node-inline';
      dom.contentEditable = 'false';
      if (typeof katex !== 'undefined') {
        try { katex.render(node.attrs.latex, dom, { displayMode: false, throwOnError: false, strict: 'ignore' }); }
        catch (_) { dom.textContent = `$${node.attrs.latex}$`; }
      } else {
        dom.textContent = `$${node.attrs.latex}$`;
      }
      dom.addEventListener('mousedown', (e) => {
        if (e.button === 2) {
          const pos = getPos();
          ed.commands.setNodeSelection(pos);
        }
      });
      dom.addEventListener('click', (e) => {
        e.preventDefault();
        const pos = getPos();
        if (typeof window.editMathFormula === 'function') {
          window.editMathFormula(node.attrs.latex, false, pos, pos + node.nodeSize);
        }
      });
      return { dom };
    };
  },
});

const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      latex: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-math-block]', getAttrs: el => ({ latex: el.getAttribute('data-latex') || '' }) }];
  },
  renderHTML({ node }) {
    return ['div', { 'data-math-block': '', 'data-latex': node.attrs.latex, class: 'math-node math-node-block' }];
  },
  renderMarkdown(node) {
    return `$$${node.attrs.latex}$$`;
  },
  addStorage() {
    return { clipboardTextSerializer: node => `$$${node.attrs.latex}$$` };
  },
  addNodeView() {
    return ({ node, getPos, editor: ed }) => {
      const dom = document.createElement('div');
      dom.className = 'math-node math-node-block';
      dom.contentEditable = 'false';
      if (typeof katex !== 'undefined') {
        try { katex.render(node.attrs.latex, dom, { displayMode: true, throwOnError: false, strict: 'ignore' }); }
        catch (_) { dom.textContent = `$$${node.attrs.latex}$$`; }
      } else {
        dom.textContent = `$$${node.attrs.latex}$$`;
      }
      dom.addEventListener('mousedown', (e) => {
        if (e.button === 2) {
          const pos = getPos();
          ed.commands.setNodeSelection(pos);
        }
      });
      dom.addEventListener('click', (e) => {
        e.preventDefault();
        const pos = getPos();
        if (typeof window.editMathFormula === 'function') {
          window.editMathFormula(node.attrs.latex, true, pos, pos + node.nodeSize);
        }
      });
      return { dom };
    };
  },
});

/**
 * CustomTable — 表格序列化为 HTML（而非有损的 GFM 管道表格）
 *
 * 背景：默认 Markdown 序列化把表格转成 GFM，会丢失列宽(colwidth)、
 * 合并单元格(colspan/rowspan)、表头开关、以及单元格内多段落/复杂标记。
 * 切换笔记后（getMarkdown → setContent）这些就被还原成"初始样式"。
 *
 * 经验证：把表格写成原始 <table> HTML 后，Markdown 解析器（setContent
 * contentType:'markdown'）能完整解析回 colwidth / colspan / rowspan / align。
 * 因此这里复写 renderMarkdown：复杂表格输出 HTML，简单表格保留 GFM（导出更通用）。
 */
// 注意：renderMarkdown 收到的 node 是「纯 JSON 结构」（.type 为字符串、
// .content 为数组、.attrs 为对象、marks 为 [{type, attrs}]），不是 ProseMirror Node。
function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 行内 JSON 节点数组 → HTML（保留常见标记） */
function _inlineNodesToHtml(nodes) {
  if (!Array.isArray(nodes)) return '';
  let out = '';
  for (const child of nodes) {
    if (child.type === 'text') {
      let t = _escHtml(child.text || '');
      const marks = child.marks || [];
      for (const m of marks) {
        const n = m.type;
        if (n === 'bold') t = `<strong>${t}</strong>`;
        else if (n === 'italic') t = `<em>${t}</em>`;
        else if (n === 'underline') t = `<u>${t}</u>`;
        else if (n === 'strike') t = `<s>${t}</s>`;
        else if (n === 'code') t = `<code>${t}</code>`;
        else if (n === 'highlight') {
          const c = m.attrs && m.attrs.color;
          t = c ? `<mark data-color="${_escHtml(c)}" style="background-color:${_escHtml(c)};color:inherit">${t}</mark>` : `<mark>${t}</mark>`;
        } else if (n === 'link') {
          const href = (m.attrs && m.attrs.href) || '';
          t = `<a href="${_escHtml(href)}">${t}</a>`;
        }
      }
      out += t;
    } else if (child.type === 'hardBreak') {
      out += '<br>';
    } else if (child.type === 'mathInline') {
      const lx = (child.attrs && child.attrs.latex) || '';
      out += `<span data-math-inline data-latex="${_escHtml(lx)}">$${_escHtml(lx)}$</span>`;
    } else if (child.content) {
      out += _inlineNodesToHtml(child.content);
    }
  }
  return out;
}

/** 整个单元格内容 → HTML（多段落用 <br> 连接） */
function _cellContentToHtml(cell) {
  const blocks = cell.content || [];
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'paragraph' || block.type === 'heading') {
      parts.push(_inlineNodesToHtml(block.content || []));
    } else if (block.content) {
      parts.push(_inlineNodesToHtml(block.content));
    }
  }
  return parts.join('<br>');
}

/** 判断表格是否"复杂"（需要 HTML 以无损保存） */
function _isComplexTable(node) {
  const rows = node.content || [];
  let complex = false;
  let firstRow = true;
  for (const row of rows) {
    const cells = row.content || [];
    let allHeader = true;
    let anyHeader = false;
    for (const cell of cells) {
      const a = cell.attrs || {};
      if ((a.colspan && a.colspan > 1) || (a.rowspan && a.rowspan > 1)) complex = true;
      if (a.colwidth && a.colwidth.length) complex = true;
      const nonEmptyBlocks = (cell.content || []).filter((b) => b.content && b.content.length);
      if (nonEmptyBlocks.length > 1) complex = true; // 多段落单元格
      if (cell.type === 'tableHeader') anyHeader = true; else allHeader = false;
    }
    if (firstRow) { if (!allHeader) complex = true; } // 首行非全表头 → GFM 无法表达
    else if (anyHeader) complex = true;               // 表头出现在非首行
    firstRow = false;
  }
  return complex;
}

function _tableToHtml(node) {
  let html = '<table>';
  for (const row of (node.content || [])) {
    html += '<tr>';
    for (const cell of (row.content || [])) {
      const tag = cell.type === 'tableHeader' ? 'th' : 'td';
      const a = cell.attrs || {};
      const attrs = [];
      if (a.colspan && a.colspan > 1) attrs.push(`colspan="${a.colspan}"`);
      if (a.rowspan && a.rowspan > 1) attrs.push(`rowspan="${a.rowspan}"`);
      if (a.colwidth && a.colwidth.length) attrs.push(`colwidth="${a.colwidth.join(',')}"`);
      if (a.align) attrs.push(`align="${_escHtml(a.align)}"`);
      html += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${_cellContentToHtml(cell)}</${tag}>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}

/** 简单表格 → GFM 管道表格（行内标记由引擎 renderChildren 处理） */
function _tableToGfm(node, helpers) {
  const rows = [];
  for (const row of (node.content || [])) {
    const cells = [];
    for (const cell of (row.content || [])) {
      let md = '';
      try { md = helpers.renderChildren(cell.content || []); } catch (_) { md = ''; }
      md = (md || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
      cells.push({ text: md, align: (cell.attrs && cell.attrs.align) || null, header: cell.type === 'tableHeader' });
    }
    rows.push(cells);
  }
  if (!rows.length) return '';
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const header = rows[0];
  const aligns = [];
  for (let i = 0; i < cols; i++) aligns[i] = (header[i] && header[i].align) || null;
  const line = (cells) => `| ${Array.from({ length: cols }, (_, i) => (cells[i] && cells[i].text) || '').join(' | ')} |`;
  const sep = `| ${aligns.map((al) => al === 'left' ? ':---' : al === 'right' ? '---:' : al === 'center' ? ':---:' : '---').join(' | ')} |`;
  const out = [line(header), sep];
  for (let r = 1; r < rows.length; r++) out.push(line(rows[r]));
  return out.join('\n');
}

let CustomTable = Table.extend({
  renderMarkdown(node, helpers) {
    try {
      return _isComplexTable(node) ? _tableToHtml(node) : _tableToGfm(node, helpers);
    } catch (e) {
      try { return _tableToHtml(node); } catch (_) { return ''; }
    }
  },
});

/** 列表项数组 → HTML <li> */
function _listItemsToHtml(items) {
  let h = '';
  for (const it of (items || [])) h += `<li>${_blocksToHtml(it.content || [])}</li>`;
  return h;
}
function _taskItemsToHtml(items) {
  let h = '';
  for (const it of (items || [])) {
    const checked = it.attrs && it.attrs.checked;
    h += `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}">${_blocksToHtml(it.content || [])}</li>`;
  }
  return h;
}

/**
 * 把「纯 JSON 节点数组」序列化为标准 HTML（供复制到剪贴板用）。
 * 块级结构正确闭合，避免粘贴到其它软件时段落被合并/多行变一行。
 */
function _blocksToHtml(nodes) {
  if (!Array.isArray(nodes)) return '';
  let html = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        html += `<p>${_inlineNodesToHtml(n.content || [])}</p>`;
        break;
      case 'heading': {
        const l = (n.attrs && n.attrs.level) || 1;
        html += `<h${l}>${_inlineNodesToHtml(n.content || [])}</h${l}>`;
        break;
      }
      case 'blockquote':
        html += `<blockquote>${_blocksToHtml(n.content || [])}</blockquote>`;
        break;
      case 'bulletList':
        html += `<ul>${_listItemsToHtml(n.content || [])}</ul>`;
        break;
      case 'orderedList': {
        const start = n.attrs && n.attrs.start;
        html += `<ol${start && start !== 1 ? ` start="${start}"` : ''}>${_listItemsToHtml(n.content || [])}</ol>`;
        break;
      }
      case 'taskList':
        html += `<ul data-type="taskList">${_taskItemsToHtml(n.content || [])}</ul>`;
        break;
      case 'listItem':
        html += `<li>${_blocksToHtml(n.content || [])}</li>`;
        break;
      case 'codeBlock': {
        const lang = n.attrs && n.attrs.language;
        const code = _escHtml((n.content || []).map((t) => t.text || '').join(''));
        html += `<pre><code${lang ? ` class="language-${_escHtml(lang)}"` : ''}>${code}</code></pre>`;
        break;
      }
      case 'horizontalRule':
        html += '<hr>';
        break;
      case 'table':
        html += _tableToHtml(n);
        break;
      case 'image':
        html += `<img src="${_escHtml(n.attrs && n.attrs.src)}" alt="${_escHtml((n.attrs && n.attrs.alt) || '')}">`;
        break;
      case 'mathBlock': {
        const lx = (n.attrs && n.attrs.latex) || '';
        html += `<div data-math-block data-latex="${_escHtml(lx)}">$$${_escHtml(lx)}$$</div>`;
        break;
      }
      case 'text':
      case 'mathInline':
      case 'hardBreak':
        html += _inlineNodesToHtml([n]);
        break;
      default:
        if (n.content) html += _blocksToHtml(n.content);
    }
  }
  return html;
}

/**
 * CustomCodeBlock — 基于 NodeView 的代码块
 * 顶部栏（非 sticky）：语言标签、运行、复制
 * 折叠/展开通过右键菜单触发
 */
const _codeBlockFoldState = new Map();

function _runJavaScript(codeText, outputEl) {
  outputEl.innerHTML = '';
  outputEl.parentElement.style.display = '';
  const logs = [];
  const fakeConsole = {};
  ['log','warn','error','info'].forEach(m => {
    fakeConsole[m] = (...args) => logs.push({ type: m, text: args.map(a => {
      if (a === null) return 'null';
      if (a === undefined) return 'undefined';
      if (typeof a === 'object') try { return JSON.stringify(a, null, 2); } catch(_) { return String(a); }
      return String(a);
    }).join(' ') });
  });
  try {
    const fn = new Function('console', codeText);
    const result = fn(fakeConsole);
    if (result !== undefined && !logs.length) logs.push({ type: 'log', text: '\u2190 ' + String(result) });
  } catch (e) {
    logs.push({ type: 'error', text: e.name + ': ' + e.message });
  }
  if (!logs.length) logs.push({ type: 'log', text: '(no output)' });
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  outputEl.innerHTML = logs.map(l => `<div class="code-output-line code-output-${l.type}">${esc(l.text)}</div>`).join('');
}

function _animateFold(pre, folding) {
  if (folding) {
    pre.style.maxHeight = pre.scrollHeight + 'px';
    pre.style.transition = 'none';
    pre.offsetHeight;
    pre.style.transition = 'max-height 0.25s ease-out';
    pre.style.maxHeight = 'calc(3 * 1.6em + 16px)';
  } else {
    const target = pre.scrollHeight + 'px';
    pre.style.transition = 'max-height 0.25s ease-out';
    pre.style.maxHeight = target;
    const onEnd = () => { pre.style.maxHeight = ''; pre.style.transition = ''; pre.removeEventListener('transitionend', onEnd); };
    pre.addEventListener('transitionend', onEnd);
  }
}

/* ===== 代码块轻量语法高亮（基于 ProseMirror decoration，不改文档、不影响 markdown 存储） ===== */
const _CODE_KEYWORDS = {
  cstyle: 'break case catch class const continue default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while yield async await of as from get set yield static readonly namespace declare type abstract is keyof',
  python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self',
  sql: 'select from where insert update delete create drop alter table join left right inner outer on group by order having limit offset union all as distinct into values set index view primary key foreign references null not and or like in between case when then end asc desc count sum avg min max',
  bash: 'if then else elif fi for while do done case esac function in select until return echo export local readonly declare set unset source alias',
  rust: 'fn let mut const struct enum impl trait pub use mod match if else loop while for in return self Self super crate move ref where async await dyn box true false as type',
  go: 'func var const package import return if else for range switch case default type struct interface map chan go defer select break continue fallthrough true false nil',
  css: '',
};
function _langGroup(lang) {
  lang = (lang || '').toLowerCase();
  if (['js','javascript','jsx','ts','typescript','tsx','java','c','cpp','c++','cs','csharp','php','swift','kotlin','scala','json','json5','dart'].includes(lang)) return 'cstyle';
  if (['py','python'].includes(lang)) return 'python';
  if (['sql','mysql','pgsql','postgres','sqlite'].includes(lang)) return 'sql';
  if (['sh','bash','shell','zsh'].includes(lang)) return 'bash';
  if (['rs','rust'].includes(lang)) return 'rust';
  if (['go','golang'].includes(lang)) return 'go';
  if (['css','scss','less','sass'].includes(lang)) return 'css';
  if (['html','xml','svg','vue'].includes(lang)) return 'html';
  return 'cstyle';
}
function _commentStyle(group) {
  if (group === 'python' || group === 'bash') return { line: /#[^\n]*/y, block: null };
  if (group === 'sql') return { line: /--[^\n]*/y, block: /\/\*[\s\S]*?\*\//y };
  if (group === 'html') return { line: null, block: /<!--[\s\S]*?-->/y };
  if (group === 'css') return { line: null, block: /\/\*[\s\S]*?\*\//y };
  return { line: /\/\/[^\n]*/y, block: /\/\*[\s\S]*?\*\//y };
}
function _tokenizeCode(text, lang) {
  const group = _langGroup(lang);
  const cmt = _commentStyle(group);
  const kw = new Set((_CODE_KEYWORDS[group] || '').split(/\s+/).filter(Boolean));
  const literals = new Set(['true','false','null','none','nil','undefined','True','False','None']);
  const tokens = [];
  const n = text.length;
  let i = 0;
  const tryAt = (re) => { if (!re) return null; re.lastIndex = i; const m = re.exec(text); return (m && m.index === i) ? m[0] : null; };
  const idRe = /[A-Za-z_$][\w$]*/y;
  const numRe = /\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  while (i < n) {
    const ch = text[i];
    // 注释
    let m = tryAt(cmt.block);
    if (m) { tokens.push({ s: i, e: i + m.length, c: 'hl-comment' }); i += m.length; continue; }
    m = tryAt(cmt.line);
    if (m) { tokens.push({ s: i, e: i + m.length, c: 'hl-comment' }); i += m.length; continue; }
    // 字符串
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && text[j] !== ch) { if (text[j] === '\\') j++; j++; }
      j = Math.min(j + 1, n);
      tokens.push({ s: i, e: j, c: 'hl-string' }); i = j; continue;
    }
    // 数字
    m = tryAt(numRe);
    if (m) { tokens.push({ s: i, e: i + m.length, c: 'hl-number' }); i += m.length; continue; }
    // 标识符 / 关键字
    idRe.lastIndex = i; const im = idRe.exec(text);
    if (im && im.index === i) {
      const w = im[0];
      if (literals.has(w)) tokens.push({ s: i, e: i + w.length, c: 'hl-literal' });
      else if (kw.has(w)) tokens.push({ s: i, e: i + w.length, c: 'hl-keyword' });
      i += w.length; continue;
    }
    i++;
  }
  return tokens;
}
const _codeHighlightKey = new PluginKey('codeSyntaxHighlight');
function _buildCodeDecorations(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true;
    const text = node.textContent || '';
    if (text) {
      const toks = _tokenizeCode(text, node.attrs.language || '');
      for (const t of toks) decos.push(Decoration.inline(pos + 1 + t.s, pos + 1 + t.e, { class: t.c }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

const CustomCodeBlock = CodeBlock.extend({
  // 新增 title 属性：代码块顶栏可编辑标题。不渲染到 HTML（rendered:false），
  // 仅通过下面的 Markdown 序列化/解析持久化进围栏信息串。
  addAttributes() {
    return {
      ...(this.parent?.() || {}),
      title: { default: null, rendered: false },
    };
  },
  // 序列化为围栏信息串：```语言 标题。标题存在但无语言时用 text 占位，
  // 保证「首词=语言、其后=标题」可逆，避免标题被当成语言。
  renderMarkdown(node, helpers) {
    const lang = (node.attrs && node.attrs.language) || '';
    const title = (node.attrs && node.attrs.title) || '';
    const info = title ? `${lang || 'text'} ${title}` : lang;
    if (node.content) {
      return ['```' + info, helpers.renderChildren(node.content), '```'].join('\n');
    }
    return '```' + info + '\n\n```';
  },
  // 解析：把围栏信息串拆成 语言 + 标题（首个空格分隔）。
  parseMarkdown(token, helpers) {
    const raw = token.raw || '';
    if (!raw.startsWith('```') && !raw.startsWith('~~~') && token.codeBlockStyle !== 'indented') return [];
    const info = (token.lang || '').trim();
    let language = null, title = null;
    if (info) {
      const sp = info.indexOf(' ');
      if (sp === -1) { language = info; }
      else { language = info.slice(0, sp); title = info.slice(sp + 1).trim() || null; }
      if (language === 'text' && title) language = null;  // text 仅是占位语言
    }
    return helpers.createNode(
      'codeBlock',
      { language, title },
      token.text ? [helpers.createTextNode(token.text)] : []
    );
  },
  addProseMirrorPlugins() {
    const parent = this.parent?.() || [];
    return [
      ...parent,
      new Plugin({
        key: _codeHighlightKey,
        state: {
          init: (_, { doc }) => _buildCodeDecorations(doc),
          apply: (tr, old) => tr.docChanged ? _buildCodeDecorations(tr.doc) : old,
        },
        props: { decorations(state) { return _codeHighlightKey.getState(state); } },
      }),
    ];
  },
  addNodeView() {
    return ({ node, editor: ed, getPos }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      const toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';
      toolbar.contentEditable = 'false';

      const copySvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
      const checkSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
      const runSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="6,4 20,12 6,20"/></svg>';
      const foldSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
      const unfoldSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>';

      const langLabel = document.createElement('span');
      langLabel.className = 'code-lang-label';
      langLabel.textContent = node.attrs.language || 'text';

      // 可编辑标题：方便辨认这段代码是什么（如文件名）。空时显示占位提示。
      const titleEl = document.createElement('span');
      titleEl.className = 'code-title-input';
      titleEl.contentEditable = 'true';
      titleEl.spellcheck = false;
      titleEl.textContent = node.attrs.title || '';
      let _titleCommitTimer = null;
      const commitTitle = (immediate) => {
        const apply = () => {
          const pos = typeof getPos === 'function' ? getPos() : null;
          if (pos == null) return;
          const cur = ed.state.doc.nodeAt(pos);
          if (!cur || cur.type.name !== 'codeBlock') return;
          const val = (titleEl.textContent || '').trim() || null;
          if ((cur.attrs.title || null) === val) return;
          ed.chain().command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...cur.attrs, title: val });
            return true;
          }).run();
        };
        clearTimeout(_titleCommitTimer);
        if (immediate) apply();
        else _titleCommitTimer = setTimeout(apply, 300);
      };
      titleEl.addEventListener('input', () => commitTitle(false));
      titleEl.addEventListener('blur', () => commitTitle(true));
      titleEl.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); titleEl.blur(); }
      });

      const lineCount = (node.textContent || '').split('\n').length;
      const textLen = (node.textContent || '').length;
      const shouldFold = lineCount > 3 || textLen > 200;

      const actions = document.createElement('span');
      actions.className = 'code-toolbar-actions';

      const foldBtn = document.createElement('span');
      foldBtn.className = 'code-fold-btn';
      foldBtn.title = '折叠/展开';
      if (!shouldFold) foldBtn.style.display = 'none';

      const runBtn = document.createElement('span');
      runBtn.className = 'code-run-btn';
      runBtn.innerHTML = runSvg;
      runBtn.title = '运行';

      const copyBtn = document.createElement('span');
      copyBtn.className = 'code-copy-btn';
      copyBtn.innerHTML = copySvg;
      copyBtn.title = '复制';

      actions.appendChild(foldBtn);
      actions.appendChild(runBtn);
      actions.appendChild(copyBtn);
      toolbar.appendChild(langLabel);
      toolbar.appendChild(titleEl);
      toolbar.appendChild(actions);

      const pre = document.createElement('pre');
      pre.style.position = 'relative';
      const code = document.createElement('code');
      if (node.attrs.language) code.className = `language-${node.attrs.language}`;
      pre.appendChild(code);

      const outputWrap = document.createElement('div');
      outputWrap.className = 'code-output-wrap';
      outputWrap.style.display = 'none';
      outputWrap.contentEditable = 'false';
      const outputHeader = document.createElement('div');
      outputHeader.className = 'code-output-header';
      outputHeader.innerHTML = '<span>\u8f93\u51fa</span><span class="code-output-close">\u00d7</span>';
      const outputContent = document.createElement('pre');
      outputContent.className = 'code-output-content';
      outputWrap.appendChild(outputHeader);
      outputWrap.appendChild(outputContent);

      wrapper.appendChild(toolbar);
      wrapper.appendChild(pre);
      wrapper.appendChild(outputWrap);

      // Fold state
      let folded = false;
      if (shouldFold) {
        const noteId = window._currentNoteId || '';
        const key = `${noteId}:${getPos()}`;
        folded = _codeBlockFoldState.has(key) ? _codeBlockFoldState.get(key) : true;
      }

      const syncFoldUI = (animate) => {
        foldBtn.innerHTML = folded ? unfoldSvg : foldSvg;
        wrapper.classList.toggle('code-block-folded', folded);
        if (animate) {
          _animateFold(pre, folded);
          if (folded) {
            setTimeout(() => {
              const rect = wrapper.getBoundingClientRect();
              if (rect.top < 0) {
                wrapper.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }
            }, 280);
          }
        }
      };
      syncFoldUI(false);

      // Expose fold toggle for right-click menu (only for foldable blocks)
      if (shouldFold) {
        wrapper._toggleFold = () => {
          folded = !folded;
          const noteId = window._currentNoteId || '';
          const key = `${noteId}:${getPos()}`;
          _codeBlockFoldState.set(key, folded);
          syncFoldUI(true);
        };
      }

      // Event handling
      toolbar.addEventListener('pointerdown', (e) => {
        // 标题输入框需要获得焦点，故不阻止其默认行为（其余工具栏区域照旧阻止以免影响选区）
        if (!(e.target && e.target.closest && e.target.closest('.code-title-input'))) {
          e.preventDefault();
        }
        e.stopPropagation();
      }, true);

      toolbar.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        const tgt = e.target;
        if (tgt.closest('.code-fold-btn')) {
          if (wrapper._toggleFold) wrapper._toggleFold();
        } else if (tgt.closest('.code-run-btn')) {
          const curLang = langLabel.textContent || '';
          if (/^(javascript|js|typescript|ts)$/i.test(curLang)) {
            _runJavaScript(code.textContent || '', outputContent);
          } else {
            outputContent.innerHTML = '<div class="code-output-line code-output-warn">\u4ec5\u652f\u6301\u8fd0\u884c JavaScript \u4ee3\u7801</div>';
            outputWrap.style.display = '';
          }
        } else if (tgt.closest('.code-copy-btn')) {
          const text = code.textContent || '';
          navigator.clipboard?.writeText(text).then(() => {
            copyBtn.innerHTML = checkSvg;
            copyBtn.classList.add('copied');
            setTimeout(() => { copyBtn.innerHTML = copySvg; copyBtn.classList.remove('copied'); }, 1500);
          }).catch(() => {});
        } else if (tgt.closest('.code-lang-label')) {
          _showCodeLangPicker(langLabel, wrapper, ed, getPos);
        }
      }, true);

      outputWrap.addEventListener('pointerup', (e) => {
        if (e.target.closest('.code-output-close')) {
          outputWrap.style.display = 'none';
          outputContent.innerHTML = '';
        }
      }, true);
      outputWrap.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, true);

      return {
        dom: wrapper,
        contentDOM: code,
        update(updatedNode) {
          if (updatedNode.type.name !== 'codeBlock') return false;
          langLabel.textContent = updatedNode.attrs.language || 'text';
          // 标题正在编辑时不要回写，以免打断光标
          if (document.activeElement !== titleEl) {
            const t = updatedNode.attrs.title || '';
            if (titleEl.textContent !== t) titleEl.textContent = t;
          }
          if (updatedNode.attrs.language) {
            code.className = `language-${updatedNode.attrs.language}`;
          } else {
            code.className = '';
          }
          const newLineCount = (updatedNode.textContent || '').split('\n').length;
          const newTextLen = (updatedNode.textContent || '').length;
          const nowShouldFold = newLineCount > 3 || newTextLen > 200;
          if (nowShouldFold && foldBtn.style.display === 'none') {
            foldBtn.style.display = '';
            foldBtn.innerHTML = foldSvg;
            wrapper._toggleFold = () => {
              folded = !folded;
              const noteId = window._currentNoteId || '';
              const key = `${noteId}:${getPos()}`;
              _codeBlockFoldState.set(key, folded);
              syncFoldUI(true);
            };
          }
          return true;
        },
        destroy() {},
        ignoreMutation(mutation) {
          if (!code.contains(mutation.target)) return true;
          return false;
        },
        stopEvent(event) {
          if (event.target && event.target.closest && (event.target.closest('.code-toolbar') || event.target.closest('.code-output-wrap'))) {
            return true;
          }
          return false;
        },
      };
    };
  },
});

function _showCodeLangPicker(anchor, wrapper, ed, getPos) {
  document.querySelector('.code-lang-picker')?.remove();
  const langs = ['plaintext','javascript','typescript','python','java','c','cpp','csharp','go','rust','html','css','sql','json','yaml','xml','bash','shell','markdown','php','ruby','swift','kotlin'];
  const picker = document.createElement('div');
  picker.className = 'code-lang-picker';
  for (const lang of langs) {
    const item = document.createElement('div');
    item.className = 'code-lang-item';
    item.textContent = lang;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      picker.remove();
      const pos = typeof getPos === 'function' ? getPos() : null;
      if (pos == null) return;
      const newLang = lang === 'plaintext' ? null : lang;
      ed.chain().focus().command(({ tr }) => {
        const node = tr.doc.nodeAt(pos);
        if (node && node.type.name === 'codeBlock') {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: newLang });
        }
        return true;
      }).run();
      anchor.textContent = lang;
    });
    picker.appendChild(item);
  }
  const rect = anchor.getBoundingClientRect();
  document.body.appendChild(picker);
  // 钳进视口：默认贴 anchor 下方；下方放不下就翻到上方，避免长语言列表底部被裁。
  {
    const margin = 8, vw = window.innerWidth, vh = window.innerHeight;
    const maxH = vh - margin * 2;
    if (picker.offsetHeight > maxH) { picker.style.maxHeight = maxH + 'px'; picker.style.overflowY = 'auto'; }
    const pw = picker.offsetWidth, ph = Math.min(picker.offsetHeight, maxH);
    let left = Math.max(margin, Math.min(rect.left, vw - pw - margin));
    let top = rect.bottom + 4;
    if (top + ph > vh - margin) top = Math.max(margin, rect.top - ph - 4);
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
  }
  const dismiss = (ev) => {
    if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener('mousedown', dismiss, true); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
}

function missingImagePlaceholderDataUrl(width, height) {
  const w = Math.min(Math.max(parseInt(width, 10) || 320, 80), 1600);
  const h = Math.min(Math.max(parseInt(height, 10) || 200, 60), 1200);
  const iconSize = Math.min(32, Math.floor(w / 8));
  const fs = Math.min(12, Math.floor(w / 22));
  const cx = w / 2, cy = h / 2 - 8;
  const syncMethod = window.storage?.getSetting?.('syncMethod') || 'none';
  const label = (syncMethod === 'webdav' && window.webdavSync) ? '图片同步中…' : '图片存于其他设备';
  const cs = getComputedStyle(document.body);
  const bgColor = cs.getPropertyValue('--bg-tertiary').trim() || '#f8f8f7';
  const borderColor = cs.getPropertyValue('--border-strong').trim() || 'rgba(15,15,15,0.12)';
  const textColor = cs.getPropertyValue('--text-tertiary').trim() || cs.getPropertyValue('--text-secondary').trim() || '#999';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect fill="${bgColor}" width="100%" height="100%" rx="6"/>
    <g transform="translate(${cx - iconSize/2},${cy - iconSize/2})" fill="none" stroke="${textColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5">
      <rect x="2" y="2" width="${iconSize-4}" height="${iconSize-4}" rx="3"/>
      <circle cx="${iconSize*0.7}" cy="${iconSize*0.3}" r="${iconSize*0.1}"/>
      <path d="M2,${iconSize*0.75} L${iconSize*0.35},${iconSize*0.5} L${iconSize*0.55},${iconSize*0.65} L${iconSize*0.8},${iconSize*0.4} L${iconSize-2},${iconSize*0.75}"/>
    </g>
    <text x="50%" y="${cy + iconSize/2 + fs + 8}" text-anchor="middle" fill="${textColor}" font-family="system-ui,sans-serif" font-size="${fs}" opacity="0.6">${label}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * MdImage — 带尺寸持久化的图片扩展
 *
 * 核心策略：
 * 1. renderHTML 的 src 直接从 _imgDataCache 取 dataUrl，
 *    这样剪贴板/拖拽序列化出的 HTML 就已经是可显示的 dataUrl。
 * 2. renderMarkdown 读 node.attrs.src（始终是 zhinote://img/...），
 *    保证持久化的 Markdown 里保存的是引用而非巨大的 base64。
 * 3. addNodeView 完全控制屏幕渲染，直接输出缓存 dataUrl 或 SVG 占位图，
 *    DOM 中永远不会出现 zhinote:// src，从根本上消除破碎图标。
 */
const MdImage = Image.extend({
  draggable: true,

  addAttributes() {
    const parent = this.parent?.() || {};
    return {
      ...parent,
      src: {
        ...(parent.src || {}),
        renderHTML: (attrs) => ({ src: attrs.src || '' }),
      },
      width: {
        default: null,
        renderHTML: a => a.width ? { width: a.width } : {},
        parseHTML: el => el.getAttribute('width') || null,
      },
      height: {
        default: null,
        renderHTML: a => a.height ? { height: a.height } : {},
        parseHTML: el => el.getAttribute('height') || null,
      },
      align: {
        default: null,
        renderHTML: (attrs) => {
          if (!attrs.align || attrs.align === 'center') return {};
          return { 'data-align': attrs.align };
        },
        parseHTML: (el) => el.getAttribute('data-align') || null,
      },
    };
  },
  renderMarkdown(node) {
    const a = node.attrs || {};
    const src = a.src || '';
    const alt = a.alt || '';
    const title = a.title || '';
    const w = a.width;
    const h = a.height;
    const align = a.align;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    if (w || h || align) {
      let html = `<img src="${esc(src)}" alt="${esc(alt)}"`;
      if (title) html += ` title="${esc(title)}"`;
      if (w) html += ` width="${esc(w)}"`;
      if (h) html += ` height="${esc(h)}"`;
      if (align && align !== 'center') html += ` data-align="${esc(align)}"`;
      html += ' />';
      return html;
    }
    if (title) return `![${alt}](${src} "${String(title).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
    return `![${alt}](${src})`;
  },
  addNodeView() {
    return ({ node, getPos, editor: ed }) => {
      const img = document.createElement('img');
      img.draggable = true;

      function resolveAndSetSrc(attrs) {
        const src = attrs.src || '';
        if (src.startsWith('zhinote://local-image-omitted')) {
          img.src = missingImagePlaceholderDataUrl(attrs.width, attrs.height);
          return;
        }
        if (src.startsWith('zhinote://img/')) {
          const hash = src.replace('zhinote://img/', '').replace(/#.*$/, '');
          const cached = _imgDataCache.get(hash);
          if (cached) { img.src = cached; return; }
          const local = window.storage?.getLocalImage?.(hash);
          if (local) { _imgDataCache.set(hash, local); img.src = local; return; }
          img.src = missingImagePlaceholderDataUrl(attrs.width, attrs.height);
          if (window.webdavSync?.downloadImage) {
            window.webdavSync.downloadImage(hash).then(result => {
              if (result) { _imgDataCache.set(hash, result); img.src = result; }
            }).catch(() => {});
          }
          return;
        }
        img.src = src;
      }

      function applyAttrs(attrs) {
        resolveAndSetSrc(attrs);
        if (attrs.width) {
          img.setAttribute('width', attrs.width);
          img.style.width = String(attrs.width).includes('%') ? attrs.width : attrs.width + 'px';
        } else {
          img.removeAttribute('width');
          img.style.width = '';
        }
        if (attrs.height) {
          img.setAttribute('height', attrs.height);
          // 有宽度时高度交给浏览器按原始比例算：小屏上 max-width:100% 压缩宽度后，
          // 固定像素高度会把图压扁/拉窄（height 属性保留用于序列化与加载占位）
          img.style.height = attrs.width ? 'auto' : (String(attrs.height).includes('%') ? attrs.height : attrs.height + 'px');
        } else {
          img.removeAttribute('height');
          img.style.height = '';
        }
        if (attrs.alt) img.setAttribute('alt', attrs.alt);
        else img.removeAttribute('alt');
        if (attrs.title) img.setAttribute('title', attrs.title);
        else img.removeAttribute('title');
        if (attrs.align && attrs.align !== 'center') img.dataset.align = attrs.align;
        else delete img.dataset.align;
      }

      applyAttrs(node.attrs);

      return {
        dom: img,
        update(updatedNode) {
          if (updatedNode.type.name !== 'image') return false;
          applyAttrs(updatedNode.attrs);
          return true;
        },
        // 图片是原子节点：异步加载改 img.src / width 等属性时，
        // 让 ProseMirror 忽略这些 DOM 变更，避免触发多余事务、丢失选区
        ignoreMutation() { return true; },
      };
    };
  },
});

const editor = (() => {
  let _editor = null;
  let _currentId = null;
  let _saveTimer = null;
  let _suppressInput = false;
  // 双击空格跳出续写：记录上一次空格的时间与「插入后光标位置」，
  // 只有「窗口内、原地连按第二下空格、且当前光标处有激活的行内格式」才触发。
  const DOUBLE_SPACE_WINDOW = 200;  // ms，短一些，避免误吃正常双空格
  let _lastSpaceAt = 0;
  let _lastSpacePos = -1;
  // 「打开时的文档基线」：记录笔记刚加载完时 getJSON() 的稳定序列化（JSON 字符串）。
  // flushSave 以此判脏——只有当前 doc 与基线不同（= 用户真的改了）才保存。
  // doc(JSON) 由 getJSON() 输出，结构/顺序确定、往返稳定、零序列化抖动，
  // 从架构上杜绝「打开即标脏 → 顶 updatedAt → 跨设备同步反向覆盖」（详见 docs/SYNC.md「打开即标脏」）。
  let _openedDoc = null;
  const _scrollPos = {}; // { [noteId]: 上次滚动位置 scrollTop }，用于「回到上次位置」
  let _imgClickTimer = null;
  let _imgResizeLayer = null;
  let _internalImgDrag = false;

  function currentId() { return _currentId; }

  function preprocessMathMarkdown(md) {
    if (!md || !md.includes('$')) return md;
    const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const parts = [];
    const codeBlockRe = /(```[\s\S]*?```|`[^`\n]+`)/g;
    let last = 0;
    let m;
    while ((m = codeBlockRe.exec(md)) !== null) {
      if (m.index > last) parts.push({ text: md.slice(last, m.index), process: true });
      parts.push({ text: m[0], process: false });
      last = m.index + m[0].length;
    }
    if (last < md.length) parts.push({ text: md.slice(last), process: true });
    return parts.map(p => {
      if (!p.process) return p.text;
      let t = p.text;
      t = t.replace(/\$\$([^$]+?)\$\$/gs, (_, latex) =>
        `<div data-math-block data-latex="${esc(latex.trim())}"></div>`
      );
      // 行内公式用「词边界」收紧规则（类 Pandoc），减少误判：
      //  - 开符 $ 不能紧跟在单词字符/下划线后（排除 a$x$、_$yyyy...$ 这类文件名/标识符）
      //  - 开符 $ 后不能是空白/$；闭符 $ 前不能是空白/$
      //  - 闭符 $ 后不能是单词字符/下划线（排除 $10-$20 价格、$VAR 变量等）
      // 例：%title%_$yyyy-MM-dd_HH-mm-ss$.png —— 开符前是 _，不再被当公式。
      t = t.replace(/(?<![\w$])\$(?![\s$])([^$\n]+?)(?<![\s$])\$(?![\w$])/g, (_, latex) =>
        `<span data-math-inline data-latex="${esc(latex)}"></span>`
      );
      return t;
    }).join('');
  }

  function initEditor() {
    if (_editor) return _editor;

    const bubbleMenuEl = document.getElementById('bubble-menu');
    // 触屏：iOS 系统选择菜单固定出现在选区上方且无法屏蔽，浮动条改到选区下方错位共存
    const _coarsePtr = window.matchMedia('(pointer: coarse)').matches;
    const editorEl = document.getElementById('editor');
    if (!editorEl) { console.warn('[editor] #editor element not found'); return null; }

    let _lastMouseUp = { x: 0, y: 0 };
    let _bubbleLocked = false;
    // 浮动菜单"抑制"状态：用闭包布尔量 + 在「保留的元素引用」上切 class。
    // ⚠️ Tiptap 的 BubbleMenu.hide() 会把元素从 DOM 中 remove() 掉（detach），
    // 此时 document.getElementById('bubble-menu') 返回 null，旧代码靠它清 class 会清不掉，
    // 导致 md-bubble-hidden 永久卡在被 detach 的元素上 → 浮动菜单"再也不出现、重开也无效"。
    // 这里统一改为：抑制状态存布尔量（shouldShow 读它），class 始终切在 bubbleMenuEl 引用上。
    let _bubbleSuppressed = false;
    window.setBubbleSuppressed = (v) => {
      _bubbleSuppressed = !!v;
      if (bubbleMenuEl) bubbleMenuEl.classList.toggle('md-bubble-hidden', !!v);
    };
    window.isBubbleSuppressed = () => _bubbleSuppressed;
    // 触屏：浮动条与键盘工具条同槽互斥——浮动条（选中文字时）出现就藏键盘工具条，
    // 键盘上方永远只有一条。BubbleMenu 的显示/隐藏 = 挂载/摘除 DOM，用 MutationObserver 跟踪。
    if (_coarsePtr) {
      const updBubbleOpen = () => {
        const open = !!bubbleMenuEl && bubbleMenuEl.isConnected && !bubbleMenuEl.classList.contains('md-bubble-hidden');
        document.body.classList.toggle('md-bubble-open', open);
      };
      new MutationObserver(updBubbleOpen).observe(document.body, { childList: true, subtree: true });
    }
    editorEl.addEventListener('mouseup', (e) => {
      if (!_bubbleLocked) _lastMouseUp = { x: e.clientX, y: e.clientY };
    });
    editorEl.addEventListener('mousedown', (e) => {
      if (e.button === 2 && _editor) {
        // 右键时只要存在非空选区，就阻止默认行为（避免浏览器把光标移到点击处而清掉选区），
        // 这样右键菜单/浮动菜单始终能作用在已选中的文本上——无论右键点在选区内还是选区外
        const { from, to } = _editor.state.selection;
        if (from !== to) {
          e.preventDefault();
        }
      }
    });

    _editor = new Editor({
      element: editorEl,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          codeBlock: false,
          link: false,
          underline: false,
        }),
        CustomCodeBlock.configure({
          languageClassPrefix: 'language-',
          HTMLAttributes: { class: 'code-block' },
          enableTabIndentation: true,   // 代码块内 Tab=插入空格、Shift+Tab=反缩进
          tabSize: 2,
        }),
        // priority 拉高 → highlight 在 schema 里排到 bold/italic 之前，成为"外层" mark，
        // 这样"高亮文字里夹着加粗/斜体"或跨软换行时不会被拆成多个 <mark>（修复连续高亮被拆块、挖空逐块）
        Highlight.extend({
          priority: 1000,
          // 序列化为 HTML <mark> 而非 ==…==，统一与表格/列表 HTML 路径一致（见 _inlineNodesToHtml）：
          //  ① 颜色随 data-color 持久化——==…== 没有颜色位，旧实现一切换笔记就丢色变回默认黄；
          //  ② 与加粗 ** 重叠时不再生成 ==**…**== 这种与 marked 分词器撞车、往返后漏出字面 ** 的结构。
          // 解析端：multicolor 的 parseHTML 读 data-color/style；旧 ==…== 的输入分词器保留 → 旧笔记仍可读。
          // 该序列化器仅用于导出 .md / 旧 md 派生；内部存储已走 doc(JSON)，显示不再经 markdown 往返。
          renderMarkdown(node, helpers) {
            const inner = helpers.renderChildren(node);
            const color = node && node.attrs && node.attrs.color;
            if (color) {
              const c = _escHtml(color);
              return `<mark data-color="${c}" style="background-color: ${c}; color: inherit">${inner}</mark>`;
            }
            return `<mark>${inner}</mark>`;
          },
        }).configure({ multicolor: true }),
        Underline,
        TextAlign.configure({ types: ['paragraph', 'heading'], alignments: ['left', 'center', 'right', 'justify'] }),
        Link.extend({ inclusive() { return false; } }).configure({
          openOnClick: false,
          autolink: true,
          protocols: ['http', 'https', 'mailto', 'tel', { scheme: 'file', optionalSlashes: true }],
          validate: () => true,
        }),
        MdImage.configure({ inline: true, allowBase64: true }),
        CustomTable.configure({ resizable: true }),
        TableRow,
        TableCell,
        TableHeader,
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder: '开始写作吧… 输入 / 可插入常用片段' }),
        Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
        MathInline,
        MathBlock,
        BubbleMenu.configure({
          element: bubbleMenuEl,
          shouldShow: ({ editor: ed, state }) => {
            if (_bubbleSuppressed) return false;
            if (document.querySelector('.md-editor-ctx')) return false;
            const { from, to } = state.selection;
            if (from === to) return false;
            if (ed.isActive('image')) return false;
            if (state.selection.node) return false;
            return true;
          },
          getReferencedVirtualElement: () => {
            // 以「选区第一行的真实矩形」作为锚点：浮动菜单稳定地落在选区上方起点，
            // 而不是整段宽度的中心点（那样多行选中时会飘到页面中央，显得随意）。
            // 定位算法本身用的是 Tiptap 内置的 Floating UI（业界主流开源方案），
            // 这里只负责给它一个更合理的参照矩形。
            const sel = window.getSelection();
            let rect = null;
            if (sel && sel.rangeCount) {
              try {
                const range = sel.getRangeAt(0);
                const rects = range.getClientRects();
                // 桌面锚选区首行（菜单在上方）；触屏锚末行（菜单在下方，避开系统菜单）
                if (rects && rects.length) rect = _coarsePtr ? rects[rects.length - 1] : rects[0];
                if (!rect || (!rect.width && !rect.height)) rect = range.getBoundingClientRect();
              } catch (_) {}
            }
            if ((!rect || (!rect.width && !rect.height)) && _editor) {
              try {
                const c = _editor.view.coordsAtPos(_editor.state.selection.from);
                if (c) rect = new DOMRect(c.left, c.top, 1, Math.max(1, c.bottom - c.top));
              } catch (_) {}
            }
            if (!rect || (!rect.width && !rect.height)) {
              const x = Math.max(60, Math.min(_lastMouseUp.x || 100, window.innerWidth - 60));
              const y = _lastMouseUp.y > 0 ? _lastMouseUp.y : 100;
              rect = new DOMRect(x - 1, y - 1, 2, 2);
            }
            const r = rect;
            return { getBoundingClientRect: () => r, getClientRects: () => [r] };
          },
          updateDelay: 80,
          options: {
            placement: _coarsePtr ? 'bottom' : 'top',
            offset: { mainAxis: _coarsePtr ? 14 : 8 },
            flip: { fallbackPlacements: [_coarsePtr ? 'top' : 'bottom'] },
            shift: { padding: 8 },
          },
          tippyOptions: {
            duration: [150, 100],
            animation: 'shift-away-subtle',
            moveTransition: 'transform 0.15s cubic-bezier(.2,0,.4,1)',
          },
        }),
      ],
      editorProps: {
        attributes: { class: 'tiptap-editor' },
        scrollThreshold: 100,
        scrollMargin: 100,
        // Tab 键：列表/表格/代码块交给各自默认键位（缩进、跳格、插空格）；
        // 普通文本块里 Tab=插入 2 空格、Shift+Tab=删光标前最多 2 空格，并阻止焦点跳到工具栏图标。
        handleKeyDown: (view, event) => {
          // 双击空格跳出续写：仅当「光标处有激活的行内格式」且「两次空格在窗口内原地连按」时，
          // 吞掉第二个空格 + 清除该空格上的格式 + 清空 storedMarks（下一字不再续写）。
          // 无格式时双空格照常输出，不影响正常输入；链接不参与。
          if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
            const { state } = view;
            if (state.selection.empty) {
              const now = performance.now();
              const pos = state.selection.from;
              const fast = (now - _lastSpaceAt) <= DOUBLE_SPACE_WINDOW && _lastSpacePos === pos;
              const marks = state.storedMarks || state.selection.$from.marks();
              const hasFmt = marks.some((m) => m.type.name !== 'link');
              if (fast && hasFmt && pos >= 1) {
                event.preventDefault();
                const tr = state.tr;
                Object.values(state.schema.marks).forEach((mt) => {
                  if (mt.name === 'link') return;
                  tr.removeMark(pos - 1, pos, mt);  // 把刚输入的那个空格变成纯空格
                });
                tr.setStoredMarks([]);
                view.dispatch(tr);
                _lastSpaceAt = 0; _lastSpacePos = -1;
                return true;
              }
              _lastSpaceAt = now;
              _lastSpacePos = pos + 1;  // 空格插入后光标位置
            }
            return false;  // 正常插入空格
          }
          // 跳出续写 / 清除格式（Ctrl+\）：空选区→清空 storedMarks，下一个输入不再续写前面的
          // 加粗/斜体/删除线/高亮/代码；有选区→清除选区上的所有行内格式。链接非续写、不受影响。
          if ((event.key === '\\' || event.code === 'Backslash') && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            const { state } = view;
            if (state.selection.empty) {
              view.dispatch(state.tr.setStoredMarks([]));
            } else {
              const { from, to } = state.selection;
              const tr = state.tr;
              Object.values(state.schema.marks).forEach((markType) => tr.removeMark(from, to, markType));
              view.dispatch(tr);
            }
            return true;
          }
          if (event.key !== 'Tab') return false;
          const { state } = view;
          const { $from } = state.selection;
          for (let d = $from.depth; d > 0; d--) {
            const name = $from.node(d).type.name;
            if (name === 'listItem' || name === 'taskItem' || name === 'tableCell' || name === 'tableHeader' || name === 'codeBlock') {
              // 先 preventDefault 阻止焦点跳到工具栏图标（即使到顶层无法再缩进也不会跳焦点），
              // 再返回 false 交给各自默认键位完成缩进/跳格/插空格。
              event.preventDefault();
              return false;
            }
          }
          event.preventDefault();
          const { from } = state.selection;
          if (event.shiftKey) {
            const start = $from.start();
            const before = state.doc.textBetween(start, from, '\n', '\n');
            let del = 0;
            for (let i = before.length - 1; i >= 0 && before[i] === ' ' && del < 2; i--) del++;
            if (del > 0) view.dispatch(state.tr.delete(from - del, from).scrollIntoView());
          } else {
            view.dispatch(state.tr.insertText('  ').scrollIntoView());
          }
          return true;
        },
        clipboardTextSerializer: (slice) => {
          let text = '';
          slice.content.descendants((node) => {
            if (node.type.name === 'mathInline') {
              text += `$${node.attrs.latex}$`;
              return false;
            }
            if (node.type.name === 'mathBlock') {
              text += `$$${node.attrs.latex}$$\n`;
              return false;
            }
            if (node.isText) text += node.text || '';
            if (node.type.name === 'paragraph' || node.type.name === 'heading') text += '\n';
            if (node.type.name === 'hardBreak') text += '\n';
          });
          return text;
        },
        handlePaste: (view, event) => {
          const { $from } = view.state.selection;
          if ($from.parent.type.name === 'codeBlock') {
            // 代码块内：强制只插入纯文本，避免剪贴板里的 text/html 被解析成段落/表格而"跑出"代码块
            const plain = event.clipboardData?.getData('text/plain');
            if (plain) {
              const normalized = plain.replace(/\r\n?/g, '\n');
              view.dispatch(view.state.tr.insertText(normalized).scrollIntoView());
              return true;
            }
            return false;
          }
          const text = event.clipboardData?.getData('text/plain');
          if (!text || !text.includes('$')) return false;
          const html = event.clipboardData?.getData('text/html');
          if (html && html.includes('data-math-')) return false;
          if (/\$\$[^$]+?\$\$|\$[^$\n]+?\$/.test(text)) {
            const processed = preprocessMathMarkdown(text);
            if (processed !== text) {
              _editor.commands.insertContent(processed, { parseOptions: { preserveWhitespace: false } });
              return true;
            }
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        if (_suppressInput) return;
        _scrubForeignImageSrcs();
        scheduleSave(null);
      },
    });

    _ensureMarkedPatched();

    if (bubbleMenuEl) {
      const headingTrigger = document.getElementById('bubble-heading-trigger');
      const headingDropdown = bubbleMenuEl.querySelector('.bubble-heading-dropdown');
      const listTrigger = document.getElementById('bubble-list-trigger');
      const listDropdown = bubbleMenuEl.querySelector('.bubble-list-dropdown');
      const codeTrigger = document.getElementById('bubble-code-trigger');
      const codeDropdown = bubbleMenuEl.querySelector('.bubble-code-dropdown');
      const highlightTrigger = document.getElementById('bubble-highlight-trigger');
      const highlightDropdown = bubbleMenuEl.querySelector('.bubble-highlight-dropdown');
      const alignTrigger = document.getElementById('bubble-align-trigger');
      const alignDropdown = bubbleMenuEl.querySelector('.bubble-align-dropdown');
      const allDropdowns = [headingDropdown, listDropdown, codeDropdown, highlightDropdown, alignDropdown].filter(Boolean);
      const triggerMap = [
        [headingTrigger, headingDropdown],
        [listTrigger, listDropdown],
        [codeTrigger, codeDropdown],
        [highlightTrigger, highlightDropdown],
        [alignTrigger, alignDropdown],
      ];

      const hideAllDropdowns = (except) => {
        for (const dd of allDropdowns) { if (dd !== except) dd.classList.add('hidden'); }
        document.documentElement.style.removeProperty('--hl-preview');
        document.body.classList.remove('hl-previewing');
      };
      // 清除"应用高亮后只显示高亮"的预览态（在编辑区新交互、或气泡消失后恢复正常选区配色）
      const clearHlAppliedPreview = () => {
        document.body.classList.remove('hl-applied-preview', 'hl-previewing');
        document.documentElement.style.removeProperty('--hl-preview');
      };
      editorEl.addEventListener('mousedown', clearHlAppliedPreview, true);

      // 悬停高亮色块 → 实时把该颜色预览到当前选区上
      if (highlightDropdown) {
        highlightDropdown.querySelectorAll('button[data-cmd="setHighlight"]').forEach((sw) => {
          sw.addEventListener('mouseenter', () => {
            const c = sw.dataset.color || '#fef08a';
            document.documentElement.style.setProperty('--hl-preview', c);
            document.body.classList.add('hl-previewing');
            document.body.classList.remove('hl-applied-preview');
          });
          sw.addEventListener('mouseleave', () => {
            document.body.classList.remove('hl-previewing');
            document.documentElement.style.removeProperty('--hl-preview');
          });
        });
        const _unset = highlightDropdown.querySelector('button[data-cmd="unsetHighlight"]');
        if (_unset) _unset.addEventListener('mouseenter', () => {
          document.body.classList.remove('hl-previewing');
          document.documentElement.style.removeProperty('--hl-preview');
        });
      }

      bubbleMenuEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        _bubbleLocked = true;
      });

      let _activeDropdown = null;
      let _bubbleLeaveTimer = null;
      for (const [trigger, dropdown] of triggerMap) {
        if (!trigger || !dropdown) continue;
        const wrap = trigger.closest('.bubble-dropdown-wrap');
        if (wrap) {
          wrap.addEventListener('mouseenter', () => {
            clearTimeout(_bubbleLeaveTimer);
            if (_activeDropdown && _activeDropdown !== dropdown) {
              _activeDropdown.classList.add('hidden');
            }
            dropdown.classList.remove('hidden');
            _activeDropdown = dropdown;
            // 打开高亮下拉时不再隐藏选区（以前会让人误以为丢了选中）；预览改为悬停色块时实时显示
          });
        }
        dropdown.addEventListener('mouseenter', () => {
          clearTimeout(_bubbleLeaveTimer);
        });
      }
      bubbleMenuEl.addEventListener('mouseenter', () => {
        clearTimeout(_bubbleLeaveTimer);
      });
      bubbleMenuEl.addEventListener('mouseleave', () => {
        _bubbleLeaveTimer = setTimeout(() => {
          hideAllDropdowns();
          _activeDropdown = null;
        }, 400);
      });
      // 悬停到其他按钮上时关闭展开的子菜单
      const nonDropBtns = bubbleMenuEl.querySelectorAll('button:not(.bubble-dd-item)');
      for (const btn of nonDropBtns) {
        if (btn.closest('.bubble-dropdown-wrap')) continue;
        btn.addEventListener('mouseenter', () => {
          if (_activeDropdown) {
            hideAllDropdowns();
            _activeDropdown = null;
          }
        });
      }

      bubbleMenuEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-cmd]');
        if (!btn) return;
        const cmd = btn.dataset.cmd;
        if (cmd === 'copySelection') {
          document.execCommand('copy');
        } else if (cmd === 'setHighlight') {
          const color = btn.dataset.color || '';
          execCommand(cmd, color);
          // 应用后：本次气泡未消失前，选区只显示高亮色（透出 mark，不被选区色盖住），方便预览效果
          document.body.classList.remove('hl-previewing');
          document.documentElement.style.removeProperty('--hl-preview');
          document.body.classList.add('hl-applied-preview');
        } else if (cmd === 'unsetHighlight') {
          execCommand(cmd);
          document.body.classList.remove('hl-applied-preview', 'hl-previewing');
        } else if (cmd === 'setTextAlign') {
          execCommand(cmd, btn.dataset.align || 'left');
        } else {
          const opts = btn.dataset.level ? { level: parseInt(btn.dataset.level) } : undefined;
          execCommand(cmd, opts);
        }
        hideAllDropdowns();
        _activeDropdown = null;
        setTimeout(() => { _bubbleLocked = false; }, 300);
      });
      document.addEventListener('click', (e) => {
        if (!bubbleMenuEl.contains(e.target)) { hideAllDropdowns(); _activeDropdown = null; }
      });
    }

    const pm = editorEl.querySelector('.ProseMirror');
    (pm || editorEl).addEventListener('paste', (e) => {
      if (!_editor) return;
      const { $from } = _editor.state.selection;
      if ($from.parent.type.name === 'codeBlock') return;
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) return;
        }
      }
      const html = (e.clipboardData?.getData('text/html') || '').trim();
      const text = e.clipboardData?.getData('text/plain');
      if (!text || html) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // 纯文本粘贴：按 Markdown 解析，让 **加粗**、*斜体*、`代码`、列表、标题等源码
      // 直接变成对应格式，避免把 Markdown 源码原样当作字面文本插入（出现 **文字**）。
      // 先跑数学预处理保留 $...$；再用 marked 转 HTML。
      // 若整段只是「单个段落」（纯行内内容），剥掉外层 <p> 以行内方式插入，
      // 这样在已有文字中间粘贴 **重点** 不会把当前段落拆成多段。
      const processed = preprocessMathMarkdown(text);
      const marked = _editor.storage?.markdown?.manager?.markedInstance;
      let parsedHtml = '';
      if (marked) { try { parsedHtml = String(marked.parse(processed) || '').trim(); } catch (_) {} }
      if (parsedHtml) {
        const pCount = (parsedHtml.match(/<p>/g) || []).length;
        const hasBlock = /<(ul|ol|h[1-6]|blockquote|pre|table|hr)\b/i.test(parsedHtml);
        const singlePara = pCount === 1 && !hasBlock && /^<p>[\s\S]*<\/p>$/.test(parsedHtml);
        const payload = singlePara
          ? parsedHtml.replace(/^<p>/, '').replace(/<\/p>$/, '')
          : parsedHtml;
        _editor.commands.insertContent(payload, {
          contentType: 'html',
          parseOptions: { preserveWhitespace: false },
        });
      } else {
        // 兜底：拿不到 markdown 解析器时，退回按行插入纯文本
        const paragraphs = text.split(/\n{2,}/);
        const nodes = [];
        for (const p of paragraphs) {
          const lines = p.split('\n');
          const content = [];
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) content.push({ type: 'hardBreak' });
            if (lines[i]) content.push({ type: 'text', text: lines[i] });
          }
          nodes.push(content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
        }
        _editor.commands.insertContent(nodes);
      }
    }, true);
    const handleCopyEvent = (e) => {
      if (!_editor || !e.clipboardData) return;
      const sel = _editor.state.selection;
      if (sel.empty) return;
      e.preventDefault();

      // Ctrl+C / 剪切：复制为「纯文本」——去掉 Markdown 标记与富文本 HTML，粘到任何地方都是纯文字。
      // （右键菜单的「复制」走 navigator.clipboard，不经此事件，保持原行为，不受影响。）
      // 数学公式仍以 $...$ / $$...$$ 表示，块级之间用换行分隔。
      const { from, to } = sel;
      let text = '';
      _editor.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === 'mathInline') { text += `$${node.attrs.latex}$`; return false; }
        if (node.type.name === 'mathBlock') { text += `$$${node.attrs.latex}$$\n`; return false; }
        if (node.isText) {
          const s = Math.max(from, pos) - pos;
          const en = Math.min(to, pos + node.nodeSize) - pos;
          text += (node.text || '').slice(s, en);
        }
        if (node.type.name === 'paragraph' || node.type.name === 'heading') { if (pos > from) text += '\n'; }
        if (node.type.name === 'hardBreak') text += '\n';
      });
      e.clipboardData.setData('text/plain', text);
      // 不设置 text/html → 富文本编辑器粘贴也只得到纯文本
    };
    editorEl.addEventListener('copy', handleCopyEvent);
    editorEl.addEventListener('cut', (e) => {
      handleCopyEvent(e);
      if (_editor) _editor.commands.deleteSelection();
    });
    editorEl.addEventListener('paste', (e) => {
      const cd = e.clipboardData;
      if (!cd) return;
      // 代码块内不做数学公式处理，保持原始文本
      if (_editor) {
        const { $from } = _editor.state.selection;
        if ($from.parent.type.name === 'codeBlock') return;
      }
      const html = cd.getData('text/html');
      if (html && html.includes('data-math-')) {
        e.preventDefault();
        e.stopPropagation();
        _editor.commands.insertContent(html, { parseOptions: { preserveWhitespace: false } });
        return;
      }
      const text = cd.getData('text/plain');
      if (text && text.includes('$') && /\$\$[^$]+?\$\$|\$[^$\n]+?\$/.test(text)) {
        const processed = preprocessMathMarkdown(text);
        if (processed !== text) {
          e.preventDefault();
          e.stopPropagation();
          _editor.commands.insertContent(processed, { parseOptions: { preserveWhitespace: false } });
          return;
        }
      }
    }, true);
    editorEl.addEventListener('paste', handleImagePaste);
    editorEl.addEventListener('paste', handleFilePaste);

    // Inline code hover copy button (floating overlay, not injected into code element)
    let _inlineCopyBtn = null;
    let _inlineCopyTarget = null;
    let _inlineCopyHideTimer = null;
    const _inlineCopySvg = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    const _inlineCheckSvg = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';

    function _ensureInlineCopyBtn() {
      if (_inlineCopyBtn) return _inlineCopyBtn;
      _inlineCopyBtn = document.createElement('span');
      _inlineCopyBtn.className = 'inline-code-copy-btn';
      _inlineCopyBtn.innerHTML = _inlineCopySvg;
      _inlineCopyBtn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const text = _inlineCopyTarget?.textContent || '';
        navigator.clipboard?.writeText(text).then(() => {
          _inlineCopyBtn.innerHTML = _inlineCheckSvg;
          _inlineCopyBtn.classList.add('copied');
          setTimeout(() => { _inlineCopyBtn.innerHTML = _inlineCopySvg; _inlineCopyBtn.classList.remove('copied'); }, 1200);
        }).catch(() => {});
      });
      _inlineCopyBtn.addEventListener('mouseenter', () => {
        clearTimeout(_inlineCopyHideTimer);
      });
      _inlineCopyBtn.addEventListener('mouseleave', () => {
        _scheduleHideInlineCopy();
      });
      editorEl.appendChild(_inlineCopyBtn);
      return _inlineCopyBtn;
    }

    function _positionInlineCopy(codeEl) {
      const btn = _ensureInlineCopyBtn();
      const editorRect = editorEl.getBoundingClientRect();
      const codeRect = codeEl.getBoundingClientRect();
      btn.style.top = (codeRect.top - editorRect.top + editorEl.scrollTop + (codeRect.height - 20) / 2) + 'px';
      btn.style.left = (codeRect.right - editorRect.left + editorEl.scrollLeft - 22) + 'px';
      btn.style.display = 'flex';
    }

    function _hideInlineCopy() {
      if (_inlineCopyBtn) _inlineCopyBtn.style.display = 'none';
      _inlineCopyTarget = null;
    }

    function _scheduleHideInlineCopy() {
      clearTimeout(_inlineCopyHideTimer);
      _inlineCopyHideTimer = setTimeout(_hideInlineCopy, 200);
    }

    editorEl.addEventListener('mouseover', (e) => {
      const codeEl = e.target.closest?.('code:not(pre code)');
      if (!codeEl || !editorEl.contains(codeEl)) return;
      if (_inlineCopyTarget === codeEl) { clearTimeout(_inlineCopyHideTimer); return; }
      clearTimeout(_inlineCopyHideTimer);
      _inlineCopyTarget = codeEl;
      _positionInlineCopy(codeEl);
    });
    editorEl.addEventListener('mouseout', (e) => {
      const codeEl = e.target.closest?.('code:not(pre code)');
      if (!codeEl) return;
      const related = e.relatedTarget;
      if (related && (related === _inlineCopyBtn || _inlineCopyBtn?.contains(related))) return;
      if (related && codeEl.contains(related)) return;
      _scheduleHideInlineCopy();
    });
    editorEl.addEventListener('drop', handleImageDrop);

    async function _openLocalFile(href) {
      const path = decodeURIComponent(href.replace(/^file:\/\/\//, ''));
      if (window.host?.caps.file) {
        try {
          await window.host.file.op({ mode: 'open', path });
          return;
        } catch (e) {
          console.warn('[FileOp open] subprogram failed:', e);
        }
      }
      try {
        await navigator.clipboard.writeText(path);
        window.toast?.('文件路径已复制到剪贴板', 'info');
      } catch (_) {
        window.toast?.('无法打开本地文件', 'warning');
      }
    }

    // 在 mousedown 阶段拦截 Ctrl+Click 链接，防止 WebView2 默认打开新窗口
    editorEl.addEventListener('mousedown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const link = e.target.closest('a[href]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    editorEl.addEventListener('dragstart', (e) => {
      if (e.target && e.target.tagName === 'IMG') {
        _internalImgDrag = true;
        return;
      }
      e.preventDefault();
    });
    editorEl.addEventListener('dragend', () => { _internalImgDrag = false; });

    editorEl.addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        const href = link.getAttribute('href') || '';
        if (href.startsWith('file:///') || href.startsWith('file:\\\\')) {
          if (e.ctrlKey || e.metaKey) {
            _openLocalFile(href);
          } else {
            openLinkDialog();
          }
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          window.open(link.href, '_blank');
        } else {
          openLinkDialog();
        }
        return;
      }
      const img = e.target.closest('img');
      if (!img) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        openImageGallery(img);
        return;
      }
      e.preventDefault();
      clearTimeout(_imgClickTimer);
      _imgClickTimer = setTimeout(() => {
        _imgClickTimer = null;
        selectImageNode(img);
      }, 320);
    });

    editorEl.addEventListener('dblclick', (e) => {
      const img = e.target.closest('img');
      if (!img) return;
      e.preventDefault();
      clearTimeout(_imgClickTimer);
      _imgClickTimer = null;
      // 触屏端连点图片多为误触（本意常是唤菜单/选中），改弹图片菜单；「查看大图」是菜单第一项。
      // 桌面端保持双击直接看大图。
      if (window.matchMedia('(pointer: coarse)').matches) {
        img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY }));
        return;
      }
      openImageGallery(img);
    });

    // 触屏：自实现图片双击检测——iOS 对触摸双击经常不派发 dblclick，上面的处理在 iPhone 上时灵时不灵。
    // 两次单指轻点（<350ms、位移<30px）落在同一图片 → 弹图片菜单，并阻止合成 click/dblclick。
    let _imgTap = { t: 0, x: 0, y: 0 };
    editorEl.addEventListener('touchend', (e) => {
      if (e.touches.length || e.changedTouches.length !== 1) { _imgTap.t = 0; return; }
      const t = e.changedTouches[0];
      const img = e.target.closest && e.target.closest('img');
      if (!img) { _imgTap.t = 0; return; }
      const now = Date.now();
      if (now - _imgTap.t < 350 && Math.hypot(t.clientX - _imgTap.x, t.clientY - _imgTap.y) < 30) {
        _imgTap.t = 0;
        if (e.cancelable) e.preventDefault();
        clearTimeout(_imgClickTimer);
        _imgClickTimer = null;
        img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: t.clientX, clientY: t.clientY }));
      } else {
        _imgTap = { t: now, x: t.clientX, y: t.clientY };
      }
    }, { passive: false });

    // iOS：聚焦编辑区里长按的原生行为是"放大镜移光标"而非选词（安卓是选词），键盘弹出后几乎没法选字。
    // 自实现长按选词：单指按住 420ms 位移 <10px → 程序化选中按点处的词（Intl.Segmenter 分词，
    // 中文也能选出词组），DOM 选区一出系统自动配手柄，可继续拖动扩选。仅 iOS 启用，不动安卓原生选词。
    const _isIOSSel = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (_isIOSSel && _coarsePtr) {
      let _lpTimer = null, _lpStart = null, _lpSel = null;
      const _lpCancel = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } };
      const _wordRangeAt = (x, y) => {
        const view = _editor && _editor.view;
        if (!view) return null;
        const hit = view.posAtCoords({ left: x, top: y });
        if (!hit) return null;
        const $pos = view.state.doc.resolve(hit.pos);
        if (!$pos.parent.isTextblock) return null;
        // 非文本叶子（公式/图片等）占 1 位，用占位符对齐"字符偏移 ↔ 文档位置"
        const text = $pos.parent.textBetween(0, $pos.parent.content.size, '\u0000', '\u0000');
        let off = Math.min($pos.parentOffset, Math.max(0, text.length - 1));
        if (!text.length) return null;
        let from = -1, to = -1;
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
          try {
            for (const s of new Intl.Segmenter('zh-Hans', { granularity: 'word' }).segment(text)) {
              if (off >= s.index && off < s.index + s.segment.length) {
                if (s.segment.trim() && s.segment !== '\u0000') { from = s.index; to = s.index + s.segment.length; }
                break;
              }
            }
          } catch (_) {}
        }
        if (from < 0) { // 兜底：按"字母数字/汉字"连续段向两侧扩
          const isW = (ch) => /[A-Za-z0-9_\u4e00-\u9fff]/.test(ch);
          if (!isW(text[off])) return null;
          from = off; to = off + 1;
          while (from > 0 && isW(text[from - 1])) from--;
          while (to < text.length && isW(text[to])) to++;
        }
        const base = $pos.start();
        return { from: base + from, to: base + to };
      };
      editorEl.addEventListener('touchstart', (e) => {
        _lpCancel(); _lpSel = null;
        if (e.touches.length !== 1 || e.target.closest('img')) return;
        const t = e.touches[0];
        _lpStart = { x: t.clientX, y: t.clientY };
        _lpTimer = setTimeout(() => {
          _lpTimer = null;
          const r = _wordRangeAt(_lpStart.x, _lpStart.y);
          if (!r || r.to <= r.from) return;
          _lpSel = r;
          try { _editor.chain().focus().setTextSelection(r).run(); } catch (_) {}
        }, 420);
      }, { passive: true });
      editorEl.addEventListener('touchmove', (e) => {
        if (!_lpTimer || !_lpStart) return;
        const t = e.touches[0];
        if (Math.hypot(t.clientX - _lpStart.x, t.clientY - _lpStart.y) > 10) _lpCancel();
      }, { passive: true });
      editorEl.addEventListener('touchend', (e) => {
        _lpCancel();
        if (_lpSel) {
          // 松手时压掉 iOS 默认的"把光标挪到按点"——否则刚做出的选区立刻被清掉
          if (e.cancelable) e.preventDefault();
          const r = _lpSel; _lpSel = null;
          setTimeout(() => { try { _editor.chain().setTextSelection(r).run(); } catch (_) {} }, 0);
        }
      }, { passive: false });
      editorEl.addEventListener('touchcancel', () => { _lpCancel(); _lpSel = null; }, { passive: true });
    }

    _editor.on('selectionUpdate', () => {
      requestAnimationFrame(syncImageResizeOverlay);
      // 选区变化且没有右键菜单时，解除浮动菜单抑制（自愈，避免卡死）
      if (!document.querySelector('.md-editor-ctx')) window.setBubbleSuppressed?.(false);
    });

    return _editor;
  }

  function collectEditorImages() {
    if (!_editor) return [];
    const imgs = [];
    _editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return;
      const src = node.attrs.src || '';
      if (!src || src.includes('local-image-omitted')) return;
      if (src.startsWith('zhinote://img/')) {
        const hash = src.replace('zhinote://img/', '').replace(/#.*$/, '');
        if (!_imgDataCache.has(hash)) return;
      } else if (!src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('blob:')) {
        return;
      }
      const dom = _editor.view.nodeDOM(pos);
      if (dom && dom.tagName === 'IMG') {
        dom.dataset.zhinoteGalleryPos = String(pos);
        imgs.push(dom);
      }
    });
    return imgs;
  }

  function openImageGallery(startImg) {
    const list = collectEditorImages();
    let idx = list.indexOf(startImg);
    if (idx < 0) idx = 0;

    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.innerHTML = `
      <div class="lightbox-shell">
        <div class="lightbox-toolbar">
          <span class="lightbox-counter"></span>
          <button type="button" class="lightbox-close icon-btn" title="关闭" aria-label="关闭">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <button type="button" class="lightbox-nav lightbox-prev icon-btn" aria-label="上一张"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
        <div class="lightbox-stage">
          <img class="lightbox-img" alt="" decoding="async" />
        </div>
        <button type="button" class="lightbox-nav lightbox-next icon-btn" aria-label="下一张"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
      </div>`;

    const imgEl = overlay.querySelector('.lightbox-img');
    const counter = overlay.querySelector('.lightbox-counter');
    const btnPrev = overlay.querySelector('.lightbox-prev');
    const btnNext = overlay.querySelector('.lightbox-next');
    const btnClose = overlay.querySelector('.lightbox-close');

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function showAt(i) {
      if (!list.length) return;
      idx = (i + list.length) % list.length;
      const srcImg = list[idx];
      imgEl.src = srcImg.currentSrc || srcImg.src;
      imgEl.alt = srcImg.alt || '';
      counter.textContent = `${idx + 1} / ${list.length}`;
      btnPrev.style.visibility = list.length > 1 ? 'visible' : 'hidden';
      btnNext.style.visibility = list.length > 1 ? 'visible' : 'hidden';
    }

    const close = () => {
      document.body.style.overflow = prevOverflow;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    };

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); showAt(idx - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); showAt(idx + 1); }
    }

    let _scale = 1;
    let _lastNavTime = 0;

    btnClose.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); close(); });
    btnPrev.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); _lastNavTime = Date.now(); _scale = 1; _rotation = 0; applyTransform(); showAt(idx - 1); });
    btnNext.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); _lastNavTime = Date.now(); _scale = 1; _rotation = 0; applyTransform(); showAt(idx + 1); });
    for (const btn of [btnPrev, btnNext, btnClose]) {
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('mouseup', (e) => e.stopPropagation());
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    imgEl.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      _lastNavTime = Date.now();
      _scale = _scale > 1 ? 1 : 2;
      applyTransform();
    });
    imgEl.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      _scale = Math.min(5, Math.max(0.2, _scale + (e.deltaY < 0 ? 0.15 : -0.15)));
      applyTransform();
    }, { passive: false });
    let _rotation = 0;
    const applyTransform = () => {
      const t = [];
      if (_scale !== 1) t.push(`scale(${_scale})`);
      if (_rotation) t.push(`rotate(${_rotation}deg)`);
      imgEl.style.transform = t.length ? t.join(' ') : '';
      imgEl.classList.toggle('zoomed', _scale > 1);
    };
    overlay.addEventListener('click', (e) => {
      if (Date.now() - _lastNavTime < 300) return;
      const t = e.target;
      if (t.closest('.lightbox-nav, .lightbox-close, .lightbox-img, .lightbox-ctx, .lightbox-toolbar, .lightbox-stage')) return;
      if (t === overlay || (t.classList && t.classList.contains('lightbox-shell'))) {
        close();
      }
    });
    overlay.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      overlay.querySelector('.lightbox-ctx')?.remove();
      const menu = document.createElement('div');
      menu.className = 'lightbox-ctx md-editor-ctx';
      const actions = [
        { label: '转到图片位置', icon: '⌖', action: () => {
          const srcImg = list[idx];
          close();
          if (srcImg?.isConnected) {
            srcImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
            srcImg.classList.add('img-locate-flash');
            setTimeout(() => srcImg.classList.remove('img-locate-flash'), 1800);
          }
        }},
        { label: '顺时针旋转', icon: '↻', action: () => { _rotation = (_rotation + 90) % 360; applyTransform(); } },
        { label: '逆时针旋转', icon: '↺', action: () => { _rotation = (_rotation - 90 + 360) % 360; applyTransform(); } },
        { label: '重置', icon: '⟲', action: () => { _scale = 1; _rotation = 0; applyTransform(); } },
        { label: '复制图片', icon: '⎘', action: () => {
          const c = document.createElement('canvas');
          const ctx2 = c.getContext('2d');
          c.width = imgEl.naturalWidth; c.height = imgEl.naturalHeight;
          ctx2.drawImage(imgEl, 0, 0);
          c.toBlob(b => { if (b) navigator.clipboard.write([new ClipboardItem({ [b.type]: b })]).catch(()=>{}); });
        }},
      ];
      for (const a of actions) {
        const row = document.createElement('div');
        row.className = 'md-ctx-item';
        row.innerHTML = `<span class="md-ctx-icon" style="font-size:15px">${a.icon}</span><span class="md-ctx-label">${a.label}</span>`;
        row.addEventListener('click', (ev) => { ev.stopPropagation(); menu.remove(); a.action(); });
        menu.appendChild(row);
      }
      overlay.appendChild(menu);
      _clampFloatingMenu(menu, e.clientX, e.clientY);
      const dismiss = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener('mousedown', dismiss, true);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
    });

    document.body.appendChild(overlay);
    showAt(idx);
    document.addEventListener('keydown', onKey, true);
  }

  function removeImageResizeOverlay() {
    if (!_imgResizeLayer) return;
    _imgResizeLayer._cleanup?.();
    _imgResizeLayer.remove();
    _imgResizeLayer = null;
  }

  function syncImageResizeOverlay() {
    if (!_editor) return;
    if (_imgResizeLayer?._isDragging?.()) return;
    removeImageResizeOverlay();
    const sel = _editor.state.selection;
    const snode = sel.node;
    if (!snode || snode.type.name !== 'image') return;

    const pos = sel.from;
    const dom = _editor.view.nodeDOM(pos);
    const img = dom && dom.nodeName === 'IMG' ? dom : dom?.querySelector?.('img');
    if (!img) return;

    const rect = img.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    const ratio = rect.width / Math.max(rect.height, 1);

    const layer = document.createElement('div');
    layer.className = 'md-img-resize-layer';

    const reposition = () => {
      const r = img.getBoundingClientRect();
      layer.style.left = `${r.left}px`;
      layer.style.top = `${r.top}px`;
      layer.style.width = `${r.width}px`;
      layer.style.height = `${r.height}px`;
    };
    reposition();

    let _dragging = false;
    ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
      const h = document.createElement('div');
      h.className = `md-img-resize-handle md-img-resize-${corner}`;
      // Pointer Events 统一鼠标/触屏：手柄 CSS 已设 touch-action:none，触屏拖动不会被滚动抢走
      h.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        _dragging = true;
        const obs = _editor?.view?.domObserver;
        if (obs) obs.stop();
        try { h.setPointerCapture(ev.pointerId); } catch (_) {}
        const startX = ev.clientX;
        const startW = img.getBoundingClientRect().width;
        const onMove = (e) => {
          const dx = e.clientX - startX;
          let newW = (corner === 'se' || corner === 'ne') ? startW + dx : startW - dx;
          newW = Math.round(Math.max(48, newW));
          const newH = Math.round(newW / ratio);
          img.style.width = `${newW}px`;
          img.style.height = `${newH}px`;
          reposition();
        };
        const onUp = () => {
          h.removeEventListener('pointermove', onMove);
          h.removeEventListener('pointerup', onUp);
          h.removeEventListener('pointercancel', onUp);
          _dragging = false;
          const finalW = Math.round(img.getBoundingClientRect().width);
          const finalH = Math.round(img.getBoundingClientRect().height);
          img.style.width = '';
          img.style.height = '';
          if (obs) obs.start();
          _editor.chain().focus().updateAttributes('image', { width: `${finalW}`, height: `${finalH}` }).run();
          requestAnimationFrame(() => {
            syncImageResizeOverlay();
          });
        };
        h.addEventListener('pointermove', onMove);
        h.addEventListener('pointerup', onUp);
        h.addEventListener('pointercancel', onUp);
      });
      layer.appendChild(h);
    });

    document.body.appendChild(layer);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    layer._isDragging = () => _dragging;
    layer._cleanup = () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
    _imgResizeLayer = layer;
  }

  function handleImagePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) insertImageFile(file);
        return;
      }
    }
  }

  async function handleFilePaste(e) {
    if (!window.host?.caps.file) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) return;
    }
    const hasFile = e.clipboardData.types.includes('Files');
    if (!hasFile) return;
    e.preventDefault();
    e.stopPropagation();
    const pasteNoteId = _currentId;
    try {
      const sp = await window.host.file.op({ mode: 'clipboardFiles' });
      // await 期间用户可能已切换笔记，避免把链接插到错误的文档里
      if (_currentId !== pasteNoteId) return;
      const raw = sp?.result || sp?.paths || '';
      if (!raw) return;
      const paths = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(paths) || !paths.length) return;
      for (const p of paths) {
        if (!p) continue;
        const href = _encodeFileHref(p);
        const label = p.split(/[\\/]/).pop();
        _editor.chain().focus().insertContent({
          type: 'text',
          text: label,
          marks: [{ type: 'link', attrs: { href, target: null } }],
        }).insertContent({ type: 'text', text: ' ' }).run();
      }
    } catch (err) {
      console.warn('[handleFilePaste]', err);
    }
  }

  function _encodeFileHref(rawPath) {
    const normalized = rawPath.replace(/\\/g, '/');
    return 'file:///' + encodeURI(normalized).replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  function handleImageDrop(e) {
    if (_internalImgDrag) { _internalImgDrag = false; return; }
    const files = e.dataTransfer?.files;
    // iOS Safari 从截图缩略图/照片拖入时 files 常为空，文件在 items 里（文件承诺）。
    // 必须在这里拦下：放过去的话 WebKit 默认行为会插入 blob:/临时 URL 的 <img>，
    // 本机当场能看、序列化进 Markdown 同步出去后所有设备都是碎图（已发生过）。
    if (!files?.length) {
      const items = e.dataTransfer?.items;
      if (!items?.length) return;
      const imgItems = Array.from(items).filter(it => it.kind === 'file' && it.type.startsWith('image/'));
      if (!imgItems.length) return;
      e.preventDefault();
      let got = false;
      for (const it of imgItems) {
        const file = it.getAsFile();
        if (file) { got = true; insertImageFile(file); }
      }
      if (!got) window.toast?.('未能读取拖入的图片，请改用复制 → 粘贴插入', 'warning');
      return;
    }
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        e.preventDefault();
        insertImageFile(file);
        return;
      }
    }
    // 非图片文件：插入文件名链接（无完整路径）
    e.preventDefault();
    for (const file of files) {
      if (file.type.startsWith('image/')) continue;
      const label = file.name || 'file';
      const href = _encodeFileHref(label);
      _editor.chain().focus().insertContent({
        type: 'text',
        text: label,
        marks: [{ type: 'link', attrs: { href, target: null } }],
      }).run();
    }
    window.toast?.('提示：复制文件后粘贴可插入完整路径链接', 'info');
  }

  function insertImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      insertImageFromDataUrl(reader.result, file.name?.replace(/\.[^.]+$/, '') || 'image');
    };
    reader.readAsDataURL(file);
  }

  /** 兜底清洗：把混进文档的 blob:/webkit 临时图片地址抢救入库，替换为 zhinote://img 引用。
   *  这类地址只在产生它的会话内有效，序列化同步出去就是碎图（iOS 拖拽曾绕过入口混入）。
   *  只在 blob 还活着（fetch 成功）时替换；取不到的不动它——可能是别的设备产生的，
   *  那台设备还有机会自愈，这里改成占位符反而会把它救回来的版本覆盖掉。 */
  const _scrubInFlight = new Set();
  function _scrubForeignImageSrcs() {
    if (!_editor) return;
    const found = new Set();
    _editor.state.doc.descendants((node) => {
      if (node.type.name !== 'image') return;
      const src = node.attrs.src || '';
      if ((src.startsWith('blob:') || src.startsWith('webkit-fake-url:')) && !_scrubInFlight.has(src)) found.add(src);
    });
    found.forEach(async (src) => {
      _scrubInFlight.add(src);
      try {
        const blob = await fetch(src).then(r => r.blob());
        if (!blob || !blob.type.startsWith('image/')) return;
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = rej;
          r.readAsDataURL(blob);
        });
        const ref = window.storage?.ingestImageDataUrl?.(dataUrl);
        if (!ref || !_editor) return;
        _imgDataCache.set(ref.replace('zhinote://img/', '').replace(/#.*$/, ''), dataUrl);
        // 异步期间文档可能已变，按 src 重新定位再替换
        const tr = _editor.state.tr;
        let changed = false;
        _editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'image' && node.attrs.src === src) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: ref });
            changed = true;
          }
        });
        if (changed) _editor.view.dispatch(tr);
      } catch (_) {
        // blob 已失效（跨会话/跨设备）：保持原样，不破坏可能被源设备救回的内容
      } finally {
        _scrubInFlight.delete(src);
      }
    });
  }

  /** 用 data URL 插入图片（入库 + 缓存 + setImage） */
  function insertImageFromDataUrl(dataUrl, alt = 'image') {
    if (!dataUrl || !_editor) return;
    const ref = window.storage?.ingestImageDataUrl?.(dataUrl);
    if (!ref) return;
    const hash = ref.replace('zhinote://img/', '').replace(/#.*$/, '');
    _imgDataCache.set(hash, dataUrl);
    _editor.chain().focus().setImage({ src: ref, alt }).run();
  }

  function selectImageNode(img) {
    if (!_editor) return;
    const { state } = _editor;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') {
        const dom = _editor.view.nodeDOM(pos);
        if (dom === img || (dom && dom.querySelector && dom.querySelector('img') === img)) {
          _editor.commands.setNodeSelection(pos);
          return false;
        }
      }
    });
  }

  // 把已 append 到 DOM 的浮层菜单钳进视口：用 offsetWidth/offsetHeight（布局尺寸，
  // 不受 mdPopIn 等 transform 动画影响——getBoundingClientRect 会偏小导致钳制失效被裁）。
  // 超过视口高度则限高+滚动。返回钳制后的左上角坐标。
  function _clampFloatingMenu(menu, x, y) {
    const margin = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const maxH = vh - margin * 2;
    if (menu.offsetHeight > maxH) { menu.style.maxHeight = maxH + 'px'; menu.style.overflowY = 'auto'; }
    const mw = menu.offsetWidth;
    const mh = Math.min(menu.offsetHeight, maxH);
    let fx = Math.max(margin, Math.min(x, vw - mw - margin));
    let fy = Math.max(margin, Math.min(y, vh - mh - margin));
    menu.style.left = fx + 'px';
    menu.style.top = fy + 'px';
  }

  function showImageContextMenu(e, img) {
    document.querySelectorAll('.md-editor-ctx').forEach(m => m.remove());
    selectImageNode(img);
    window.setBubbleSuppressed?.(true);
    const menu = document.createElement('div');
    menu.className = 'md-editor-ctx';
    const natW = img.naturalWidth || img.width || 320;
    const natH = img.naturalHeight || img.height || 200;
    const ratio = natW / Math.max(natH, 1);
    const setSize = (pct) => {
      const w = Math.round(natW * pct / 100);
      const h = Math.round(w / ratio);
      _editor?.chain().focus().updateAttributes('image', { width: `${w}`, height: `${h}` }).run();
      requestAnimationFrame(() => syncImageResizeOverlay());
    };
    const curAlign = _editor?.state?.selection?.node?.attrs?.align || null;
    const isFloating = curAlign === 'left' || curAlign === 'right';
    const setAlign = (val) => {
      _editor?.chain().focus().updateAttributes('image', { align: val }).run();
      removeImageResizeOverlay();
    };
    const items = [
      { label: '查看大图', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>', action: () => openImageGallery(img) },
      { label: '复制图片', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>', action: () => {
        const canvas = document.createElement('canvas');
        const ctx2 = canvas.getContext('2d');
        canvas.width = natW;
        canvas.height = natH;
        ctx2.drawImage(img, 0, 0);
        canvas.toBlob(blob => {
          if (blob) navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]).catch(() => {});
        });
      }},
      { label: isFloating ? '默认布局' : '浮动', icon: isFloating
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><rect x="6" y="9" width="12" height="7" rx="1"/><line x1="3" y1="19" x2="21" y2="19"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="8" height="6" rx="1"/><line x1="14" y1="6" x2="21" y2="6"/><line x1="14" y1="9" x2="21" y2="9"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="17" x2="21" y2="17"/></svg>',
        action: () => setAlign(isFloating ? null : 'left') },
      { sep: true },
      { label: '25%', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M15 9l-6 6M9 9h.01M15 15h.01"/></svg>', action: () => setSize(25) },
      { label: '50%', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M15 9l-6 6M9 9h.01M15 15h.01"/></svg>', action: () => setSize(50) },
      { label: '75%', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M15 9l-6 6M9 9h.01M15 15h.01"/></svg>', action: () => setSize(75) },
      { label: '100%', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M15 9l-6 6M9 9h.01M15 15h.01"/></svg>', action: () => setSize(100) },
      { sep: true },
      { label: '删除图片', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>', action: () => { _editor?.commands.deleteSelection(); }, danger: true },
    ];
    let dismiss;
    let dismissKey;
    const cleanup = () => {
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', dismissKey, true);
      window.setBubbleSuppressed?.(false);
    };
    dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); cleanup(); } };
    dismissKey = (ev) => { if (ev.key === 'Escape') { menu.remove(); cleanup(); } };
    for (const item of items) {
      if (item.sep) { const d = document.createElement('div'); d.className = 'md-ctx-sep'; menu.appendChild(d); continue; }
      const row = document.createElement('div');
      row.className = 'md-ctx-item' + (item.danger ? ' danger' : '');
      row.innerHTML = `<span class="md-ctx-icon">${item.icon}</span><span class="md-ctx-label">${item.label}</span>`;
      row.addEventListener('click', () => { menu.remove(); cleanup(); item.action(); });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    // 先 append 再按真实尺寸钳进视口（菜单项多时高度远超旧写死的 180 → 之前底部被裁）
    _clampFloatingMenu(menu, e.clientX, e.clientY);
    setTimeout(() => { document.addEventListener('mousedown', dismiss, true); document.addEventListener('keydown', dismissKey, true); }, 0);
  }

  function execCommand(cmd, opts) {
    if (!_editor) return;
    switch (cmd) {
      case 'toggleBold': _editor.chain().focus().toggleBold().run(); break;
      case 'toggleItalic': _editor.chain().focus().toggleItalic().run(); break;
      case 'toggleStrike': _editor.chain().focus().toggleStrike().run(); break;
      case 'toggleHighlight': _editor.chain().focus().toggleHighlight().run(); break;
      case 'setHighlight': {
        const color = opts;
        // 用 setHighlight（设置而非切换）：选不同色块就换色，不会因为已高亮而被切掉
        if (color) {
          _editor.chain().focus().setHighlight({ color }).run();
        } else {
          _editor.chain().focus().setHighlight().run();
        }
        break;
      }
      case 'unsetHighlight': _editor.chain().focus().unsetHighlight().run(); break;
      case 'setTextAlign': _editor.chain().focus().setTextAlign(opts).run(); break;
      case 'unsetTextAlign': _editor.chain().focus().unsetTextAlign().run(); break;
      case 'toggleCode': _editor.chain().focus().toggleCode().run(); break;
      case 'toggleUnderline': _editor.chain().focus().toggleUnderline().run(); break;
      case 'toggleLink':
        openLinkDialog();
        break;
      case 'unsetAllMarks': {
        const { from, to } = _editor.state.selection;
        if (from === to) {
          // 未选中：清空光标所在行（含块级格式 → 普通段落）
          _editor.chain().focus().selectParentNode().unsetAllMarks().setParagraph().run();
        } else {
          // 已选中：只清除选中文字的格式（不改变整行/块级类型）
          _editor.chain().focus().unsetAllMarks().run();
        }
        break;
      }
      case 'toggleHeading':
        _editor.chain().focus().toggleHeading({ level: opts?.level || 1 }).run(); break;
      case 'setParagraph': _editor.chain().focus().setParagraph().run(); break;
      case 'toggleBulletList': _editor.chain().focus().toggleBulletList().run(); break;
      case 'toggleOrderedList': _editor.chain().focus().toggleOrderedList().run(); break;
      case 'toggleTaskList': _editor.chain().focus().toggleTaskList().run(); break;
      case 'toggleBlockquote': {
        // 列表项内部不能单独塞引用：折叠光标 / 部分选中时直接 toggleBlockquote 会无效。
        // 若光标落在列表（无序/有序/任务）内，先把选区扩展到整个列表再包裹 → 引用整列表。
        // 已在引用内则走普通切换（取消引用），不做列表扩展，避免重复包裹。
        const { $from } = _editor.state.selection;
        let listDepth = -1, quoteDepth = -1;
        for (let d = $from.depth; d > 0; d--) {
          const nm = $from.node(d).type.name;
          if (nm === 'blockquote') quoteDepth = d;
          if (nm === 'bulletList' || nm === 'orderedList' || nm === 'taskList') listDepth = d;
        }
        if (quoteDepth > 0) {
          // 取消引用：选中整个引用块内容再切换，避免只 lift 一行把列表拆乱
          _editor.chain().focus()
            .setTextSelection({ from: $from.start(quoteDepth), to: $from.end(quoteDepth) })
            .toggleBlockquote()
            .run();
        } else if (listDepth > 0) {
          // 加引用：把选区扩展到整个列表再包裹
          _editor.chain().focus()
            .setTextSelection({ from: $from.before(listDepth), to: $from.after(listDepth) })
            .toggleBlockquote()
            .run();
        } else {
          _editor.chain().focus().toggleBlockquote().run();
        }
        break;
      }
      case 'toggleCodeBlock': {
        const { empty, from, to } = _editor.state.selection;
        if (!empty) {
          const text = _editor.state.doc.textBetween(from, to, '\n');
          _editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, {
            type: 'codeBlock',
            attrs: { language: null },
            content: text ? [{ type: 'text', text }] : [],
          }).run();
        } else {
          _editor.chain().focus().toggleCodeBlock().run();
        }
        break;
      }
      case 'setHorizontalRule': {
        const { state } = _editor;
        const { empty, to } = state.selection;
        if (!empty) {
          // 有选区：在选区所在块之后插入，不删除选中文字
          const $to = state.doc.resolve(to);
          let insertPos = to;
          for (let d = $to.depth; d > 0; d--) {
            const node = $to.node(d);
            if (node.isBlock && !node.isTextblock && node.type.name !== 'doc') {
              insertPos = $to.after(d);
              break;
            }
          }
          _editor.chain().focus()
            .insertContentAt(insertPos, { type: 'horizontalRule' })
            .run();
        } else {
          _editor.chain().focus().setHorizontalRule().run();
        }
        break;
      }
      case 'insertTable':
        _editor.chain().focus().insertTable({
          rows: opts?.rows || 3, cols: opts?.cols || 3, withHeaderRow: true
        }).run(); break;
      case 'addRowBefore': _editor.chain().focus().addRowBefore().run(); break;
      case 'addRowAfter': _editor.chain().focus().addRowAfter().run(); break;
      case 'addColumnBefore': _editor.chain().focus().addColumnBefore().run(); break;
      case 'addColumnAfter': _editor.chain().focus().addColumnAfter().run(); break;
      case 'deleteRow': _editor.chain().focus().deleteRow().run(); break;
      case 'deleteColumn': _editor.chain().focus().deleteColumn().run(); break;
      case 'deleteTable': _editor.chain().focus().deleteTable().run(); break;
      case 'mergeCells': _editor.chain().focus().mergeCells().run(); break;
      case 'splitCell': _editor.chain().focus().splitCell().run(); break;
      case 'toggleHeaderRow': _editor.chain().focus().toggleHeaderRow().run(); break;
      case 'toggleHeaderColumn': _editor.chain().focus().toggleHeaderColumn().run(); break;
      case 'selectAll': _editor.chain().focus().selectAll().run(); break;
      case 'selectAllSmart': {
        // 代码块内：第一次 Ctrl+A 只选块内文字；已全选块内文字（或不在代码块）再全选整篇。
        const state = _editor.state;
        const $from = state.selection.$from;
        if ($from.parent.type.name === 'codeBlock') {
          const start = $from.start();
          const end = $from.end();
          const sel = state.selection;
          if (!(sel.from === start && sel.to === end)) {
            _editor.chain().focus().setTextSelection({ from: start, to: end }).run();
            break;
          }
        }
        _editor.chain().focus().selectAll().run();
        break;
      }
      default:
        console.warn('[editor] unknown command:', cmd);
    }
  }

  function openLinkDialog() {
    if (!_editor) return;
    const isActive = _editor.isActive('link');
    const existingHref = isActive ? _editor.getAttributes('link').href || '' : '';
    const { from, to } = _editor.state.selection;
    let selectedText = _editor.state.doc.textBetween(from, to, ' ');
    let linkFrom = from, linkTo = to;

    if (isActive) {
      const $pos = _editor.state.selection.$from;
      let start = $pos.pos, end = $pos.pos;
      $pos.parent.forEach((child, offset) => {
        const childStart = $pos.start() + offset;
        const childEnd = childStart + child.nodeSize;
        if (child.marks.some(m => m.type.name === 'link' && m.attrs.href === existingHref)) {
          if (childStart <= $pos.pos && $pos.pos <= childEnd) {
            start = childStart;
            end = childEnd;
          }
        }
      });
      linkFrom = start;
      linkTo = end;
      if (!selectedText) {
        selectedText = _editor.state.doc.textBetween(linkFrom, linkTo, ' ');
      }
    }

    const hasQuicker = !!window.host?.caps.file;
    const body = document.createElement('div');
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:13px;color:var(--text-secondary);display:block;margin-bottom:4px;">显示文本</label>
          <input id="link-text-input" type="text" value="${(selectedText || '').replace(/"/g, '&quot;')}"
            placeholder="链接文本" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text);outline:none;">
        </div>
        <div>
          <label style="font-size:13px;color:var(--text-secondary);display:block;margin-bottom:4px;">链接地址</label>
          <div style="display:flex;gap:6px;align-items:stretch;">
            <input id="link-url-input" type="text" value="${existingHref.replace(/"/g, '&quot;')}"
              placeholder="https:// 或本地路径" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text);outline:none;min-width:0;">
            ${hasQuicker ? `<button id="link-pick-file" type="button" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--bg-secondary);color:var(--text-secondary);cursor:pointer;white-space:nowrap;line-height:1;">浏览…</button>` : ''}
          </div>
        </div>
      </div>`;
    const footerBtns = [];
    if (isActive) {
      footerBtns.push({ label: '移除链接', class: 'danger-btn', onClick: () => {
        _editor.chain().focus()
          .setTextSelection({ from: linkFrom, to: linkTo })
          .unsetLink()
          .run();
        window.closeModal();
      }});
      footerBtns.push({ label: '打开链接', class: 'secondary-btn', onClick: () => {
        if (existingHref) {
          if (existingHref.startsWith('file:///')) {
            _openLocalFile(existingHref);
          } else {
            window.open(existingHref, '_blank');
          }
        }
      }});
    }
    footerBtns.push({ label: '取消', class: 'secondary-btn', onClick: () => window.closeModal() });
    footerBtns.push({ label: isActive ? '更新' : '插入', class: 'primary-btn', onClick: () => {
      let url = body.querySelector('#link-url-input').value.trim();
      const text = body.querySelector('#link-text-input').value.trim();
      if (!url) return;
      if (/^[A-Z]:\\/i.test(url) || url.startsWith('/')) {
        url = _encodeFileHref(url);
      } else if (url.startsWith('file:///') && decodeURIComponent(url) === url) {
        url = _encodeFileHref(decodeURIComponent(url.slice(8)));
      }

      if (isActive) {
        _editor.chain().focus()
          .setTextSelection({ from: linkFrom, to: linkTo })
          .deleteSelection()
          .insertContent({
            type: 'text',
            text: text || selectedText || url,
            marks: [{ type: 'link', attrs: { href: url, target: null } }],
          }).run();
      } else if (text) {
        if (from !== to) {
          _editor.chain().focus().setLink({ href: url }).run();
        } else {
          _editor.chain().focus().insertContent({
            type: 'text',
            text,
            marks: [{ type: 'link', attrs: { href: url, target: null } }],
          }).run();
        }
      } else {
        const label = url.split(/[\\/]/).pop() || url;
        _editor.chain().focus().insertContent({
          type: 'text',
          text: label,
          marks: [{ type: 'link', attrs: { href: url, target: null } }],
        }).run();
      }
      window.closeModal();
    }});
    window.openModal({ title: isActive ? '编辑链接' : '插入链接', body, footer: footerBtns });
    setTimeout(() => {
      const inp = body.querySelector('#link-url-input');
      inp?.focus(); inp?.select();
      const pickFile = body.querySelector('#link-pick-file');
      if (pickFile) {
        pickFile.addEventListener('click', async () => {
          try {
            const sp = await window.host.file.op({
              mode: 'openDialog', filter: '所有文件|*.*', isBinary: 'false', multiSelect: 'false'
            });
            const raw = sp?.result || '';
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const fileData = Array.isArray(parsed) ? parsed[0] : parsed;
            const filePath = fileData.name || '';
            if (!filePath) return;
            const urlInput = body.querySelector('#link-url-input');
            const textInput = body.querySelector('#link-text-input');
            urlInput.value = _encodeFileHref(filePath);
            if (!textInput.value) textInput.value = filePath.split(/[\\/]/).pop();
          } catch (e) { console.warn('[link-pick-file]', e); }
        });
      }
    }, 100);
  }

  function scheduleSave(md) {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => flushSave(), 1500);
    if (window.updateWordCount) window.updateWordCount();
    const statusEl = document.getElementById('save-status');
    if (statusEl) { statusEl.classList.remove('saved'); statusEl.classList.add('saving'); statusEl.title = '未保存'; }
  }

  /** 文档是否「实质为空」：无文字，且不含表格/图片/公式/分割线等无文字但有内容的节点。
   *  用于区分「用户真的清空了笔记」(允许保存) 与「序列化抖动导致 md 变空但文档其实还在」(拒绝保存)。 */
  function _isDocEffectivelyEmpty() {
    try {
      const doc = _editor.state.doc;
      if (doc.textContent && doc.textContent.trim().length > 0) return false;
      let hasAtom = false;
      doc.descendants((node) => {
        if (hasAtom) return false;
        const n = node.type.name;
        if (n === 'image' || n === 'table' || n === 'mathInline' || n === 'mathBlock' || n === 'horizontalRule') {
          hasAtom = true; return false;
        }
        return true;
      });
      return !hasAtom;
    } catch (_) { return false; }
  }

  // 预热本地图片缓存：doc 笔记遍历图片节点取 hash；旧 md 笔记扫文本。
  // （MutationObserver 在 DOM 层把 <img src="zhinote://…"> 实时换成真 base64，缓存命中更快。）
  function _prewarmNoteImages(note) {
    if (!note) return;
    const warm = (hash) => {
      if (!hash || _imgDataCache.has(hash)) return;
      const d = window.storage?.getLocalImage?.(hash);
      if (d) _imgDataCache.set(hash, d);
    };
    try {
      if (note.doc) {
        walkDocImages(note.doc, (src) => {
          const mm = /zhinote:\/\/img\/([a-z0-9]+)/i.exec(src || '');
          if (mm) warm(mm[1]);
        });
      } else {
        const re = /zhinote:\/\/img\/([a-z0-9]+)/gi; let m;
        while ((m = re.exec(note.content || '')) !== null) warm(m[1]);
      }
    } catch (_) {}
  }

  // 把笔记灌进编辑器：有 doc(JSON) 走零往返 JSON 路径（全保真、无抖动）；
  // 旧笔记（仅 content/md，尚未迁移）退回 markdown 解析路径，保证存量笔记照常打开。
  function _loadNoteIntoEditor(note) {
    if (!_editor || !note) return;
    if (note.doc) {
      try {
        _editor.commands.setContent(note.doc, { emitUpdate: false });
        return;
      } catch (e) {
        console.warn('[editor] setContent(doc) 失败，退回 markdown 路径', e);
      }
    }
    const md = preprocessMathMarkdown(note.content || '');
    _editor.commands.setContent(md, { emitUpdate: false, contentType: 'markdown' });
    if ((note.content || '').trim().length > 10 && _editor.state.doc.textContent.trim().length === 0) {
      console.warn('[editor] setContent(markdown) 可能失败，重试');
      _editor.commands.clearContent();
      _editor.commands.setContent(md, { emitUpdate: false, contentType: 'markdown' });
    }
  }

  function flushSave() {
    clearTimeout(_saveTimer);
    if (!_currentId || !_editor) return;
    try {
      const doc = _editor.getJSON();
      const docStr = JSON.stringify(doc);
      const note = window.storage?.get(_currentId);
      if (!note) return;
      // 判脏：与「打开时的 doc 基线」比较。doc(JSON) 往返稳定、无序列化抖动 →
      // 没编辑过的笔记 docStr 必然等于基线 → 不会打开即标脏 → 不会跨设备误覆盖。
      if (_openedDoc != null && docStr === _openedDoc) {
        const okEl = document.getElementById('save-status');
        if (okEl) { okEl.classList.remove('saving'); okEl.classList.add('saved'); okEl.title = '已保存'; }
        return;
      }
      // 防误清空兜底：doc 判空但编辑器实际仍有内容（理论上 doc 路径两者一致，极端态保险）。
      // 用户主动全选删除时两者都为空 → 不拦，允许清空。
      if (docIsEmpty(doc) && !_isDocEffectivelyEmpty()) {
        console.warn('[editor.flushSave] 拒绝保存：doc 判空但编辑器仍有内容（疑似异常态）');
        return;
      }
      window.storage.updateDoc(_currentId, doc);
      window.storage.save({ immediate: true });
      // 保存成功后把基线推进到当前 doc，后续无新编辑则不再重复标脏。
      _openedDoc = docStr;
      const statusEl = document.getElementById('save-status');
      if (statusEl) { statusEl.classList.remove('saving'); statusEl.classList.add('saved'); statusEl.title = '已保存'; }
    } catch (err) {
      console.error('[editor.flushSave]', err);
    }
  }

  // 把空列表项（仅有空 listItem、无段落）补回一个空段落，
  // 否则序列化成 markdown 后会被丢弃，导致「空的第 N 点」「空行」切换/同步后消失。
  function _normalizeEmptyListItems() {
    if (!_editor) return;
    try {
      const state = _editor.state;
      const para = state.schema.nodes.paragraph;
      if (!para) return;
      const inserts = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name === 'listItem' || node.type.name === 'taskItem') {
          if (node.content.size === 0) inserts.push(pos + 1);
        }
      });
      if (!inserts.length) return;
      let tr = state.tr;
      for (let i = inserts.length - 1; i >= 0; i--) tr = tr.insert(inserts[i], para.create());
      tr.setMeta('addToHistory', false);
      _editor.view.dispatch(tr);
    } catch (_) {}
  }

  // 切换笔记的过渡动画预设（可在「设置 → 外观 → 切换动画」中选择）。
  const NOTE_TRANSITIONS = {
    none:    'none',
    fade:    'mdNoteFade 0.18s ease',
    up:      'mdNoteFadeUp 0.24s cubic-bezier(.22,.61,.36,1)',
    scale:   'mdNoteScale 0.22s cubic-bezier(.22,.61,.36,1)',
    blur:    'mdNoteBlur 0.26s ease',
  };
  function _noteSwitchAnim() {
    const pref = window.storage?.getSetting?.('noteTransition') || 'none';
    return NOTE_TRANSITIONS[pref] || NOTE_TRANSITIONS.none;
  }

  // 清空撤销/重做历史：切换笔记后，避免撤销跨笔记串到上一篇内容。
  function _resetHistory() {
    if (!_editor) return;
    try {
      const EditorState = _editor.state.constructor;
      const ns = EditorState.create({
        doc: _editor.state.doc,
        plugins: _editor.state.plugins,
        schema: _editor.state.schema,
      });
      _editor.view.updateState(ns);
    } catch (_) {}
  }

  async function open(id, opts = {}) {
    if (_currentId === id && _editor) return;
    flushSave();
    const note = window.storage?.get(id);
    if (!note) return;

    // 记住离开的笔记的滚动位置（用于「回到上次位置」）
    if (_editor && _currentId && _currentId !== id) {
      try { _scrollPos[_currentId] = document.getElementById('editor')?.scrollTop || 0; } catch (_) {}
    }

    _currentId = id;
    window._currentNoteId = id;
    if (!_editor) initEditor();
    if (!_editor) { console.warn('[editor] Cannot open note: editor not available'); return; }

    _prewarmNoteImages(note);

    // setContent 前先失焦：编辑器聚焦状态下 setContent 会把选区重置到文首并保持聚焦，
    // 表现为"切换笔记后光标出现在文首"。先失焦让 ProseMirror 在非聚焦态完成内容替换。
    if (!(opts && opts.forceBody)) {
      try { if (_editor.isFocused) _editor.commands.blur(); } catch (_) {}
      try {
        const ae = document.activeElement;
        if (ae && ae.blur && ae.closest && ae.closest('#editor')) ae.blur();
      } catch (_) {}
    }

    _suppressInput = true;
    _loadNoteIntoEditor(note);
    _normalizeEmptyListItems();
    _resetHistory();
    // 记录「打开时的 doc 基线」：之后 flushSave 据此判断是否有真实编辑。
    try { _openedDoc = JSON.stringify(_editor.getJSON()); } catch (_) { _openedDoc = null; }
    requestAnimationFrame(() => { _suppressInput = false; });

    // 定位：默认不把光标放进正文（避免一打开就进入编辑态），只恢复上次的滚动位置。
    // pref='restore' 回到上次位置；'top' 每次回到顶部。标题栏聚焦是唯一例外（见 focusTitle）。
    const scrollPref = (opts && opts.cursor) || window.storage?.getSetting?.('scrollOnOpen') || 'restore';
    const restoreScroll = () => {
      try {
        const el = document.getElementById('editor');
        if (!el) return;
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        let top = 0;
        if (scrollPref === 'restore') { const s = _scrollPos[id]; if (typeof s === 'number') top = s; }
        else if (scrollPref === 'bottom') { top = maxScroll; }
        el.scrollTop = Math.min(Math.max(0, top), maxScroll);
      } catch (_) {}
    };

    const titleInput = document.getElementById('title-input');
    const focusTitle = !!(titleInput && !note.title && !(opts && opts.forceBody));
    if (titleInput) { titleInput.value = note.title || ''; titleInput.disabled = false; }

    const wrap = document.getElementById('editor-wrap');
    const empty = document.getElementById('empty-state');
    if (wrap) wrap.classList.remove('hidden');   // 先显示，保证 placeCursor 能拿到正确布局
    if (empty) empty.classList.add('hidden');

    const editorEl = document.getElementById('editor');
    const pm = editorEl?.querySelector('.ProseMirror');

    // 先把滚动位置定位好（同步），再播放淡入动画 →
    // 这样切换是「一气呵成」的，不会出现"内容先出现、再滚动"的割裂感。
    // 注意：不主动 focus 正文，光标不进编辑区，避免一打开就进入编辑态。
    if (!focusTitle) { try { restoreScroll(); } catch (_) {} }

    // 切换笔记时主动让正文失焦：否则若切换前编辑器已聚焦，setContent 会把选区重置到
    // 文档开头、焦点仍在编辑器 → 光标停在文首（与阅读位置脱节）。非聚焦标题/强制进正文才失焦。
    if (!focusTitle && !(opts && opts.forceBody)) {
      try { _editor.commands.blur(); } catch (_) {}
      try { document.activeElement && document.activeElement.blur && pm && pm.contains(document.activeElement) && document.activeElement.blur(); } catch (_) {}
      // 兜底：个别路径（动画/异步聚焦）会在本帧之后把焦点还回编辑器，再补一次失焦
      requestAnimationFrame(() => {
        try { if (_editor && _editor.isFocused && _currentId === id) _editor.commands.blur(); } catch (_) {}
      });
    }

    if (pm) {
      pm.style.animation = 'none';
      pm.offsetHeight;
      const anim = _noteSwitchAnim();
      clearTimeout(pm._animClr);
      if (anim && anim !== 'none') {
        pm.style.animation = anim;
        // 播完即清除内联 animation：否则它会残留在元素上，
        // 窗口最大化/还原触发重排重组合时，浏览器会把这条残留动画重播一次。
        pm._animClr = setTimeout(() => { pm.style.animation = ''; }, 400);
      } else {
        pm.style.animation = '';
      }
    }
    // 新建 / 无标题笔记：聚焦标题栏（保留原有体验）
    if (focusTitle) setTimeout(() => titleInput.focus(), 50);

    window.storage?.setSetting('lastOpenedId', id);
    if (window.palette?.pushRecent) window.palette.pushRecent(id);
    refreshOutline();
    if (window.updateWordCount) window.updateWordCount();
    if (window.tree?.setActive) window.tree.setActive(id);
    if (window.tree?.scrollToNote) window.tree.scrollToNote(id);

    const pinned = window.storage?.getSetting('pinned') || [];
    document.getElementById('btn-pin')?.classList.toggle('active', pinned.includes(id));
  }

  function close() {
    if (_editor && _currentId) { try { _scrollPos[_currentId] = document.getElementById('editor')?.scrollTop || 0; } catch (_) {} }
    flushSave();
    _currentId = null;
    const wrap = document.getElementById('editor-wrap');
    const empty = document.getElementById('empty-state');
    if (wrap) wrap.classList.add('hidden');
    if (empty) { empty.classList.remove('hidden'); empty.style.display = ''; }
    const titleInput = document.getElementById('title-input');
    if (titleInput) { titleInput.value = ''; titleInput.disabled = true; }
    refreshOutline();
    if (window.updateWordCount) window.updateWordCount();
  }

  function getValue() {
    return _editor ? _editor.getMarkdown() : '';
  }

  function focus() {
    _editor?.commands.focus();
  }

  function instance() {
    return _editor;
  }

  function setReadonly(on) {
    if (!_editor) return;
    _editor.setEditable(!on);
  }

  function setTheme(theme) {
    if (!_editor) return;
    _editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return;
      const src = node.attrs.src || '';
      if (!src.startsWith('zhinote://')) return;
      if (src.startsWith('zhinote://img/')) {
        const hash = src.replace('zhinote://img/', '').replace(/#.*$/, '');
        if (_imgDataCache.has(hash)) return;
      }
      const dom = _editor.view.nodeDOM(pos);
      if (dom && dom.tagName === 'IMG') {
        dom.src = missingImagePlaceholderDataUrl(node.attrs.width, node.attrs.height);
      }
    });
  }

  function insertAtCursor(text) {
    if (!_editor) return;
    _editor.chain().focus().insertContent(text, { contentType: 'markdown' }).run();
  }

  function refreshOutline() {
    const el = document.getElementById('outline-content');
    if (!el) return;
    el.innerHTML = '';
    if (!_currentId || !_editor) {
      el.innerHTML = '<div class="tree-empty">无内容</div>';
      return;
    }
    const md = _editor.getMarkdown();
    const lines = md.split('\n');
    let insideCode = false;
    let headingIndex = 0; // 渲染出的标题序号（与 DOM 里的 h1~h6 顺序一致，已跳过代码块）
    lines.forEach((line) => {
      if (/^```/.test(line.trim())) { insideCode = !insideCode; return; }
      if (insideCode) return;
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (!m) return;
      const level = m[1].length;
      const text = m[2].trim();
      const idx = headingIndex++;
      const item = document.createElement('div');
      item.className = `outline-item h${level}`;
      item.textContent = text;
      item.title = text;
      item.addEventListener('click', () => scrollToHeading(idx));
      el.appendChild(item);
    });
    if (!el.children.length) {
      el.innerHTML = '<div class="tree-empty">无标题</div>';
    }
  }

  /** headingIndex：0 基的标题序号，与 refreshOutline 渲染顺序、DOM 中 h1~h6 顺序一致 */
  function scrollToHeading(headingIndex) {
    if (!_editor) return;
    const editorEl = document.getElementById('editor');
    if (!editorEl) return;
    const headings = editorEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const target = headings[headingIndex];
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('outline-flash');
    setTimeout(() => target.classList.remove('outline-flash'), 1200);
  }

  function reloadCurrent() {
    if (!_currentId) return;
    clearTimeout(_saveTimer);
    const note = window.storage?.get(_currentId);
    if (!note) { close(); return; }
    _prewarmNoteImages(note);
    _suppressInput = true;
    _loadNoteIntoEditor(note);
    _normalizeEmptyListItems();
    _resetHistory();
    // 同 open()：重载后刷新 doc 基线，避免下行同步刚覆盖内容又被 flushSave 误判为本地编辑。
    try { _openedDoc = JSON.stringify(_editor.getJSON()); } catch (_) { _openedDoc = null; }
    requestAnimationFrame(() => { _suppressInput = false; });
    refreshOutline();
  }

  // ============================================================
  // JSON 存储迁移 · 阶段1 基础设施（纯新增，不改现有行为）
  //   方案见 docs/JSON存储迁移方案.md。doc = ProseMirror 文档 JSON。
  // ============================================================

  /** doc JSON → 干净 Markdown（用编辑器的 markdown manager，可转任意 doc，不依赖当前在编辑的文档）。 */
  // 一次性补丁 marked：关闭「4 空格缩进代码块」。缩进文本回退为普通段落（仍按行内 markdown 解析），
  // 只认 ``` / ~~~ 围栏式代码块——符合笔记软件直觉，避免导入 .md 时 4 空格被误判成代码块。
  let _markedPatched = false;
  function _ensureMarkedPatched() {
    if (_markedPatched) return;
    try {
      const mk = _editor && _editor.storage && _editor.storage.markdown
        && _editor.storage.markdown.manager && _editor.storage.markdown.manager.markedInstance;
      if (mk && typeof mk.use === 'function') {
        mk.use({ tokenizer: { code() { return undefined; } } }); // 返回 undefined→该规则不匹配，落到段落
        _markedPatched = true;
      }
    } catch (_) {}
  }

  // 导出 .md 时修复「加粗/斜体/删除线 与 高亮重叠」处：Markdown 的 flanking 规则下，
  // ** 紧邻 <mark> 会退化成字面 **。策略：若某个 **…**（或 *…* / ~~…~~）片段内部含 <mark>，
  // 则整段改用 HTML 标签（<strong>/<em>/<s>）——只命中重叠处，普通加粗仍保留 **，最干净又不丢真。
  // 内联 HTML 在 GitHub/Obsidian/Typora/pandoc 等主流 md 软件均能正常渲染。
  function _robustifyMarkdownOverlap(md) {
    if (!md) return md;
    // 清掉「空强调」残留：空加粗会序列化成 **** 或 ** **（导入后显示成字面 ****，即 212121qweq 前那串）。
    md = md.replace(/\*\*\*\*/g, '').replace(/\*\*\s+\*\*/g, '').replace(/<strong>\s*<\/strong>/g, '');
    if (md.indexOf('<mark') === -1) return md;
    // 加粗（先于斜体处理，避免 ** 被单星规则误伤）
    md = md.replace(/\*\*([^\n*]*?<mark\b[\s\S]*?<\/mark>[^\n]*?)\*\*/g, '<strong>$1</strong>');
    // 删除线
    md = md.replace(/~~([^\n~]*?<mark\b[\s\S]*?<\/mark>[^\n]*?)~~/g, '<s>$1</s>');
    // 斜体（单星，且两侧不是 *，避免与已处理的 ** 冲突）
    md = md.replace(/(^|[^*])\*([^\n*]*?<mark\b[\s\S]*?<\/mark>[^\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
    return md;
  }

  function serializeDocToMd(doc) {
    if (!doc) return '';
    try {
      const mgr = _editor && _editor.markdown;
      if (mgr && typeof mgr.serialize === 'function') return _robustifyMarkdownOverlap(mgr.serialize(doc) || '');
    } catch (e) { console.warn('[serializeDocToMd]', e); }
    return '';
  }

  /** Markdown → doc JSON（含 math 预处理，与 open() 保持一致）。失败兜底返回空文档。 */
  function parseMdToDoc(md) {
    try {
      const mgr = _editor && _editor.markdown;
      if (mgr && typeof mgr.parse === 'function') return mgr.parse(preprocessMathMarkdown(md || ''));
    } catch (e) { console.warn('[parseMdToDoc]', e); }
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }

  // 块级节点：遍历纯文本时在其后补换行，便于分词/摘要
  const _BLOCK_TYPES = new Set([
    'paragraph', 'heading', 'blockquote', 'listItem', 'taskItem',
    'codeBlock', 'mathBlock', 'tableRow', 'tableCell', 'tableHeader', 'horizontalRule',
  ]);

  /** doc JSON → 纯文本（供搜索/判空/去重；图片跳过，mathInline 取 latex，hardBreak→\n）。 */
  function docToPlainText(doc) {
    if (!doc || typeof doc !== 'object') return '';
    const parts = [];
    const visit = (node) => {
      if (!node) return;
      const t = node.type;
      if (t === 'text') { parts.push(node.text || ''); return; }
      if (t === 'hardBreak') { parts.push('\n'); return; }
      if (t === 'mathInline') { parts.push((node.attrs && node.attrs.latex) || ''); return; }
      if (t === 'mathBlock') { parts.push((node.attrs && node.attrs.latex) || ''); parts.push('\n'); return; }
      if (t === 'image') return; // 跳过图片
      if (Array.isArray(node.content)) node.content.forEach(visit);
      if (_BLOCK_TYPES.has(t)) parts.push('\n');
    };
    if (Array.isArray(doc.content)) doc.content.forEach(visit);
    else visit(doc);
    return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 遍历 doc 里所有图片节点，回调 (src, node)。供图片 GC / 还原。 */
  function walkDocImages(doc, cb) {
    if (!doc || typeof cb !== 'function') return;
    const visit = (node) => {
      if (!node) return;
      if (node.type === 'image' && node.attrs && node.attrs.src) cb(node.attrs.src, node);
      if (Array.isArray(node.content)) node.content.forEach(visit);
    };
    visit(doc);
  }

  /** doc 是否「等价空文档」（无任何文字/媒体）。供判空、防误清空。 */
  function docIsEmpty(doc) {
    if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return true;
    let hasContent = false;
    const MEDIA = new Set(['image', 'mathInline', 'mathBlock', 'horizontalRule', 'codeBlock', 'table']);
    const visit = (node) => {
      if (hasContent || !node) return;
      if (node.type === 'text' && (node.text || '').trim()) { hasContent = true; return; }
      if (MEDIA.has(node.type)) { hasContent = true; return; }
      if (Array.isArray(node.content)) node.content.forEach(visit);
    };
    doc.content.forEach(visit);
    return !hasContent;
  }

  return {
    initEditor, open, close, reloadCurrent,
    flushSave, scheduleSave, setTheme, setReadonly, refreshOutline,
    currentId, getValue, focus, insertAtCursor, instance, execCommand,
    insertImageFromDataUrl,
    showImageContextMenu,
    // 阶段1 基础设施
    serializeDocToMd, parseMdToDoc, docToPlainText, walkDocImages, docIsEmpty,
  };
})();

window.editor = editor;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => editor.initEditor());
} else {
  editor.initEditor();
}

console.log('[editor.js] Tiptap editor module loaded (local bundle)');
})();
