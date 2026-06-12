/**
 * palette.js — 命令面板（Ctrl+P）
 *
 * 职责：
 * - 模糊搜索所有笔记标题（含路径）
 * - 支持 ">" 前缀切换到命令模式（执行系统命令如新建、切换主题等）
 * - 键盘上下选择 + Enter 打开
 */

const palette = (() => {
  let _activeIndex = 0;
  let _items = [];
  let _opened = false;
  let _mode = 'note';  // 'note' = 搜笔记（含正文）；'cmd' = 命令模式。Tab 切换，或开头打 > 进命令模式。
  let _query = '';     // 当前生效的查询词（已去掉模式前缀），供打开时定位高亮用。

  const COMMANDS = [
    { id: 'cmd-new', label: '新建笔记', kbd: 'Ctrl+Alt+N', icon: '+', run: () => {
      const n = storage.create({ parentId: null, title: '无标题' });
      tree.render(); editor.open(n.id);
    }},
    { id: 'cmd-search', label: '全文搜索…', kbd: 'Ctrl+F', icon: '🔍', run: () => search.activate() },
    { id: 'cmd-toggle-theme', label: '切换深浅主题', icon: '◐', run: () => {
      const cur = storage.getSetting('theme') || 'light';
      editor.setTheme(cur === 'light' ? 'dark' : 'light');
    }},
    { id: 'cmd-toggle-readonly', label: '切换 编辑/阅读 模式', kbd: 'Ctrl+Shift+E', icon: '✎', run: () => window.toggleReadonlyMode?.() },
    { id: 'cmd-toggle-outline', label: '切换大纲面板', kbd: 'Ctrl+Shift+O', icon: '☰', run: () => window.toggleOutline?.() },
    { id: 'cmd-toggle-sidebar', label: '切换侧边栏', kbd: 'Ctrl+\\', icon: '⊟', run: () => window.toggleSidebar?.() },
    { id: 'cmd-trash', label: '打开回收站', icon: '🗑', run: () => tree.showTrash() },
    { id: 'cmd-templates', label: '管理模板', icon: '⌗', run: () => template.openManager() },
    { id: 'cmd-export', label: '导出为 Markdown 文件夹', icon: '⇣', run: () => window.requestExport?.() },
    { id: 'cmd-import', label: '从 Markdown 文件夹导入', icon: '⇡', run: () => window.requestImport?.() },
    { id: 'cmd-collapse', label: '折叠所有笔记节点', icon: '◢', run: () => { tree.collapseAllAnimated(); } },
    { id: 'cmd-expand', label: '展开所有笔记节点', icon: '◣', run: () => { tree.expandAllAnimated(); } },
  ];

  const PALETTE_MS = 180;

  function open() {
    _opened = true;
    _mode = 'note';
    const overlay = document.getElementById('cmd-palette-overlay');
    const panel = document.getElementById('cmd-palette');
    overlay.classList.remove('hidden', 'is-closing');
    panel?.classList.remove('is-closing');
    const input = document.getElementById('cmd-palette-input');
    input.value = '';
    input.focus();
    updateModeUI();
    render();

    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown, true);
    input.addEventListener('input', onInput);
  }

  /** 切换 笔记/命令 模式（Tab）。切回笔记模式时去掉残留的前缀 >。 */
  function setMode(m) {
    if (_mode === m) return;
    _mode = m;
    const input = document.getElementById('cmd-palette-input');
    if (input && _mode === 'note' && input.value.startsWith('>')) {
      input.value = input.value.replace(/^\s*>\s?/, '');
    }
    updateModeUI();
    render();
  }

  function updateModeUI() {
    const wrap = document.querySelector('.cmd-palette-input-wrap');
    const input = document.getElementById('cmd-palette-input');
    if (!wrap || !input) return;
    let chip = wrap.querySelector('#cmd-mode-chip');
    if (_mode === 'cmd') {
      if (!chip) {
        chip = document.createElement('span');
        chip.id = 'cmd-mode-chip';
        chip.className = 'cmd-mode-chip';
        chip.textContent = '命令';
        wrap.insertBefore(chip, input);
      }
      input.placeholder = '执行命令…（Tab 返回搜笔记）';
    } else {
      if (chip) chip.remove();
      input.placeholder = '搜索笔记标题/正文，或按 Tab 切换命令模式';
    }
  }

  function close() {
    if (!_opened) return;
    _opened = false;
    const overlay = document.getElementById('cmd-palette-overlay');
    const panel = document.getElementById('cmd-palette');
    overlay.removeEventListener('click', onOverlayClick);
    document.removeEventListener('keydown', onKeyDown, true);
    document.getElementById('cmd-palette-input').removeEventListener('input', onInput);
    if (overlay.classList.contains('hidden')) return;
    overlay.classList.add('is-closing');
    panel?.classList.add('is-closing');
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('is-closing');
      panel?.classList.remove('is-closing');
    }, PALETTE_MS);
  }

  function onOverlayClick(e) {
    if (e.target.id === 'cmd-palette-overlay') close();
  }

  function onInput(e) {
    // 开头打 > 自动进入命令模式（保留老习惯）
    if (_mode === 'note' && e.target.value.startsWith('>')) { setMode('cmd'); return; }
    render();
  }

  function onKeyDown(e) {
    if (!_opened) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      setMode(_mode === 'cmd' ? 'note' : 'cmd');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _activeIndex = Math.min(_items.length - 1, _activeIndex + 1);
      updateActive(); ensureVisible();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _activeIndex = Math.max(0, _activeIndex - 1);
      updateActive(); ensureVisible();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // 在当前笔记的多个命中之间切换（不打开笔记，缩略前后文随之变化）。
      // 守卫：仅当输入光标在末尾（无文字编辑意图）时接管 ←→，否则放行给输入框移动光标。
      const item = _items[_activeIndex];
      const input = document.getElementById('cmd-palette-input');
      const atEnd = input && input.selectionStart === input.selectionEnd
        && input.selectionStart === (input.value || '').length;
      if (atEnd && item && item.type === 'note' && item.matches && item.matches.length > 1) {
        e.preventDefault();
        cycleHit(_activeIndex, e.key === 'ArrowLeft' ? -1 : 1);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = _items[_activeIndex];
      if (!item) return;
      executeItem(item, { pin: e.ctrlKey || e.metaKey });
    }
  }

  function executeItem(item, opts = {}) {
    const q = _query;
    close();
    if (item.type === 'note') {
      tree.expandAncestors?.(item.id);
      // 命中定位：打开后跳到当前选中的那处命中并临时高亮关键词（复用 search.highlightInEditor）
      const m = (item.matches && item.matches.length) ? item.matches[item.hitIdx || 0] : null;
      const ret = editor.open(item.id);
      const hitIdx = item.hitIdx || 0;
      const after = () => {
        tree.render();
        setTimeout(() => tree.scrollToNote?.(item.id), 50);
        if (q) {
          // 优先走「高亮全部命中 + 定位第 hitIdx 个」的 DOM 路径（含拼音/模糊命中、单命中也生效）
          if (window.search?.locateInOpenEditor) setTimeout(() => window.search.locateInOpenEditor(q, hitIdx), 90);
          else if (window.search?.highlightInEditor) setTimeout(() => window.search.highlightInEditor(q, m ? m[0] : 0), 90);
        }
      };
      if (ret && typeof ret.then === 'function') ret.then(after); else after();
      if (opts.pin) togglePin(item.id);
    } else if (item.type === 'cmd') {
      try { item.run(); } catch (err) { console.error(err); }
    }
  }

  /** 取一篇笔记的纯文本 + query 的全部命中（复用 search 的 findMatches）。 */
  function computeItemMatches(note, q) {
    let text = '';
    try {
      text = note.doc ? (window.editor?.docToPlainText(note.doc) || '') : (note.content || '');
    } catch (_) { text = note.content || ''; }
    const matches = (q && window.search?.findMatches) ? window.search.findMatches(text, q) : [];
    return { text, matches };
  }

  /** 命中摘要 HTML：优先用本地命中上下文（复用 search.buildContextSnippet，与点3同款），
   *  没有正文命中时退回 searchAll 给的 snippet。 */
  function itemSnippetHtml(it) {
    if (it.matches && it.matches.length) {
      const m = it.matches[it.hitIdx || 0];
      if (window.search?.buildContextSnippet) {
        return window.search.buildContextSnippet(it.plainText, m[0], m[1] - m[0] + 1, _query);
      }
    }
    return it.fallbackSnippet ? escapeHtml(it.fallbackSnippet) : '';
  }

  function render() {
    const list = document.getElementById('cmd-palette-list');
    const input = document.getElementById('cmd-palette-input');
    list.innerHTML = '';
    _items = [];
    _activeIndex = 0;

    let raw = (input?.value || '');
    if (_mode === 'cmd' && raw.startsWith('>')) raw = raw.slice(1);
    const q = raw.trim();
    _query = q;

    if (_mode === 'cmd') {
      const cq = q.toLowerCase();
      const matches = COMMANDS.filter(c => !cq || c.label.toLowerCase().includes(cq));
      if (!matches.length) {
        list.innerHTML = '<div class="cmd-palette-empty">无匹配命令</div>';
        return;
      }
      matches.forEach(c => { _items.push({ type: 'cmd', ...c }); });
    } else {
      const allNotes = Object.values(storage.getAll().notes || {});
      const pinned = storage.getSetting('pinned') || [];
      const recent = storage.getSetting('recent') || [];

      let candidates = allNotes;
      const snippetMap = {};
      if (q) {
        // 复用 Ctrl+F 同款全文引擎（storage.searchAll）：标题命中(100)+正文命中(80)。
        const hits = storage.searchAll(q);
        const idSet = new Set(hits.map(h => h.id));
        candidates = hits.map(h => storage.get(h.id)).filter(Boolean);
        hits.forEach(h => { if (h.snippet) snippetMap[h.id] = h.snippet; });
        // 兜底：若拼音未命中但标题直接包含，也加入
        const ql = q.toLowerCase();
        for (const n of allNotes) {
          if (!idSet.has(n.id) && (n.title || '').toLowerCase().includes(ql)) {
            candidates.push(n); idSet.add(n.id);
          }
        }
      } else {
        const recentNotes = recent.map(id => storage.get(id)).filter(Boolean);
        const pinnedNotes = pinned.map(id => storage.get(id)).filter(Boolean);
        const seen = new Set();
        candidates = [];
        for (const n of [...pinnedNotes, ...recentNotes]) {
          if (seen.has(n.id)) continue;
          seen.add(n.id);
          candidates.push(n);
          if (candidates.length >= 12) break;
        }
        if (!candidates.length) candidates = allNotes.slice(0, 12);
      }

      candidates = candidates.slice(0, 30);

      if (!candidates.length) {
        list.innerHTML = '<div class="cmd-palette-empty">还没有笔记<br>按 Ctrl+Alt+N 新建一条</div>';
        return;
      }

      const pinnedSet = new Set(pinned);
      candidates.forEach(n => {
        const path = storage.getAncestors(n.id).slice(0, -1).map(x => x.title).join(' / ');
        const { text, matches } = q ? computeItemMatches(n, q) : { text: '', matches: [] };
        _items.push({
          type: 'note', id: n.id, title: n.title || '无标题',
          path, pinned: pinnedSet.has(n.id),
          icon: n.icon || '',
          plainText: text, matches, hitIdx: 0,
          fallbackSnippet: snippetMap[n.id] || '',
        });
      });
    }

    _items.forEach((it, i) => {
      const el = document.createElement('div');
      el.className = 'cmd-item' + (i === 0 ? ' active' : '');
      it.el = el;
      if (it.type === 'note') {
        const iconHtml = it.icon ? escapeHtml(it.icon) : (it.pinned ? '📌' : '📄');
        const pinPrefix = (it.pinned && it.icon) ? '📌 ' : '';
        const pathInline = it.path ? `<span class="cmd-item-path-inline">${escapeHtml(it.path)}</span>` : '';
        const snipHtml = itemSnippetHtml(it);
        const snippetLine = snipHtml ? `<div class="cmd-item-snippet">${snipHtml}</div>` : '';
        const total = it.matches ? it.matches.length : 0;
        let navHtml = '';
        if (total > 1) {
          navHtml = `<div class="cmd-item-nav">
            <span class="cmd-hit-badge toggleable">${total} 处</span>
            <div class="cmd-hit-ctrl">
              <button type="button" class="cmd-hit-btn cmd-hit-prev" title="上一处命中" tabindex="-1"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
              <span class="cmd-hit-count">${(it.hitIdx || 0) + 1}/${total}</span>
              <button type="button" class="cmd-hit-btn cmd-hit-next" title="下一处命中" tabindex="-1"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
            </div>
          </div>`;
        } else if (total === 1) {
          navHtml = `<div class="cmd-item-nav"><span class="cmd-hit-badge">1 处</span></div>`;
        }
        el.innerHTML = `
          <span class="cmd-item-icon">${iconHtml}</span>
          <div class="cmd-item-main">
            <div class="cmd-item-title">${pinPrefix}<span class="cmd-item-name">${escapeHtml(it.title)}</span>${pathInline}</div>
            ${snippetLine}
          </div>
          ${navHtml}
        `;
        const prev = el.querySelector('.cmd-hit-prev');
        const next = el.querySelector('.cmd-hit-next');
        if (prev) prev.addEventListener('click', (e) => { e.stopPropagation(); cycleHit(i, -1); });
        if (next) next.addEventListener('click', (e) => { e.stopPropagation(); cycleHit(i, 1); });
      } else {
        el.innerHTML = `
          <span class="cmd-item-icon">${it.icon || '⌘'}</span>
          <div class="cmd-item-main">
            <div class="cmd-item-title">${escapeHtml(it.label)}</div>
          </div>
          ${it.kbd ? `<kbd class="cmd-kbd">${escapeHtml(it.kbd)}</kbd>` : ''}
        `;
      }
      el.addEventListener('click', () => executeItem(it));
      el.addEventListener('mouseenter', () => {
        _activeIndex = i;
        updateActive();
      });
      list.appendChild(el);
    });
  }

  /** 在某条笔记的多个命中之间切换：就地更新该行的摘要与 n/m 计数，不重渲整列、不打开笔记。 */
  function cycleHit(i, dir) {
    const it = _items[i];
    if (!it || it.type !== 'note' || !it.matches || it.matches.length < 2) return;
    const total = it.matches.length;
    it.hitIdx = ((it.hitIdx || 0) + dir + total) % total;
    if (!it.el) return;
    const snipEl = it.el.querySelector('.cmd-item-snippet');
    if (snipEl) snipEl.innerHTML = itemSnippetHtml(it);
    const cntEl = it.el.querySelector('.cmd-hit-count');
    if (cntEl) cntEl.textContent = `${it.hitIdx + 1}/${total}`;
    _activeIndex = i;
    updateActive();
  }

  function updateActive() {
    const list = document.getElementById('cmd-palette-list');
    list.querySelectorAll('.cmd-item').forEach((el, i) => {
      el.classList.toggle('active', i === _activeIndex);
    });
  }

  function ensureVisible() {
    const list = document.getElementById('cmd-palette-list');
    const active = list.querySelector('.cmd-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function togglePin(id) {
    const pinned = storage.getSetting('pinned') || [];
    const idx = pinned.indexOf(id);
    if (idx >= 0) pinned.splice(idx, 1);
    else pinned.unshift(id);
    storage.setSetting('pinned', pinned);
    tree.render();
    if (editor.currentId() === id) {
      document.getElementById('btn-pin')?.classList.toggle('active', idx < 0);
    }
    toast(idx >= 0 ? '已取消置顶' : '已置顶', 'success');
  }

  function pushRecent(id) {
    const recent = (storage.getSetting('recent') || []).filter(x => x !== id);
    recent.unshift(id);
    storage.setSetting('recent', recent.slice(0, 20));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  return { open, close, togglePin, pushRecent };
})();

window.palette = palette;
