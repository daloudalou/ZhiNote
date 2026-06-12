/**
 * search.js — 全文搜索
 *
 * 职责：
 * - 根据输入的查询词对 storage 进行全文搜索
 * - 命中时在树节点上高亮标题匹配
 * - 展示搜索结果列表（带内容片段）
 */

const search = (() => {
  let _active = false;
  let _debounce = null;
  let _closing = false;

  const TREE_OPEN_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
  const SEARCH_OPEN_MS = 220;
  const SEARCH_CLOSE_MS = 180;

  let _matchIndex = -1;
  let _matchRanges = [];
  let _currentQuery = '';

  /** 在纯文本里找出 query 的所有「连续命中」区间，返回 [[start,end(含)], ...]。
   *  供编辑区高亮、侧栏摘要、命令面板内容导航共用（统一检索能力）。 */
  function findMatches(text, query) {
    const ts = window.textSearch;
    if (!ts || !text || !query) return [];
    const results = [];
    let offset = 0;
    while (offset < text.length) {
      const sub = text.slice(offset);
      const ranges = ts(sub, query);
      if (!ranges || ranges.length === 0) break;
      let consecutive = true;
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i][0] > ranges[i - 1][1] + 1) { consecutive = false; break; }
      }
      if (consecutive) {
        const matchStart = offset + ranges[0][0];
        const matchEnd = offset + ranges[ranges.length - 1][1];
        results.push([matchStart, matchEnd]);
        offset = matchEnd + 1;
      } else {
        offset += ranges[0][0] + 1;
      }
    }
    return results;
  }

  /** 取某处命中的「前后文摘要」并把 query 高亮。点3（侧栏跟随）与点4（命令面板）共用。
   *  非对称：命中词前只留少量上文（让关键词靠前、在两行裁剪内必可见），后文多留些。 */
  function buildContextSnippet(fullText, matchStart, matchLen, query, before, after) {
    before = before == null ? 12 : before;
    after = after == null ? 64 : after;
    const len = matchLen || (query || '').length;
    const from = Math.max(0, matchStart - before);
    const to = Math.min(fullText.length, matchStart + len + after);
    let s = fullText.slice(from, to).replace(/\s+/g, ' ').trim();
    s = (from > 0 ? '…' : '') + s + (to < fullText.length ? '…' : '');
    return highlightHtml(s, query);
  }

  function activate() {
    if (_active || _closing) return;
    _active = true;
    // 进入搜索会重建 tree-container，先清空多选，避免底部多选栏残留（看不到选中行、栏却还在）
    if (window.tree?.clearSelection) window.tree.clearSelection();
    if (window.editor?.flushSave) window.editor.flushSave();
    const box = document.getElementById('search-box');
    const input = document.getElementById('search-input');
    box.classList.remove('hidden');
    void box.offsetHeight;
    box.classList.add('is-open');
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) {
      input.value = sel.toString().trim();
    }
    input.focus();
    input.select();
    if (input.value.trim()) {
      doSearch(input.value.trim());
    }
  }

  function deactivate() {
    if (!_active && !document.getElementById('search-box')?.classList.contains('is-open')) return;
    _active = false;
    const box = document.getElementById('search-box');
    const input = document.getElementById('search-input');
    if (!box || _closing) return;
    _closing = true;
    box.classList.remove('is-open');
    input.value = '';
    tree.setSearchHighlight('');
    restoreTreeView();
    clearEditorHighlight();
    const floatEl = document.querySelector('.search-nav-float');
    if (floatEl) floatEl.remove();
    setTimeout(() => {
      box.classList.add('hidden');
      _closing = false;
    }, SEARCH_CLOSE_MS);
  }

  function handleInput(e) {
    if (_debounce) clearTimeout(_debounce);
    const q = e.target.value.trim();
    _debounce = setTimeout(() => doSearch(q), 150);
  }

  function doSearch(q) {
    if (!q) {
      tree.setSearchHighlight('');
      restoreTreeView();
      clearEditorHighlight();
      return;
    }
    // 每次搜索前再次刷新一下，保证最新输入也能被搜到
    if (window.editor?.flushSave) window.editor.flushSave();
    _currentQuery = q;
    const hits = storage.searchAll(q);
    if (typeof window.__SEARCH_DEBUG === 'function') window.__SEARCH_DEBUG(q, hits);
    tree.setSearchHighlight(q, { skipRender: true });
    renderResults(hits, q);
    // 同步给编辑区做持续高亮（不修改 DOM，用 CSS Custom Highlight API）
    applyEditorHighlight(q);
    updateSearchNavFloat();
  }

  /** 用 CSS Custom Highlight API 在编辑区高亮所有匹配项；不修改 DOM */
  function applyEditorHighlight(query) {
    if (!query || !window.CSS || !CSS.highlights) return;
    try {
      const root = document.getElementById('editor');
      if (!root) return;
      const editable = root.querySelector('.ProseMirror');
      if (!editable) return;
      const ranges = [];
      const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.tagName === 'STYLE' || p.tagName === 'SCRIPT') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent;
        if (!text) continue;
        const matches = findMatches(text, query);
        for (const [start, end] of matches) {
          const r = document.createRange();
          r.setStart(node, start);
          r.setEnd(node, end + 1);
          ranges.push(r);
        }
      }
      _matchRanges = ranges;
      _matchIndex = -1;
      if (ranges.length === 0) {
        CSS.highlights.delete('md-search-hits');
      } else {
        const hi = new Highlight(...ranges);
        CSS.highlights.set('md-search-hits', hi);
      }
      updateMatchCounter();
    } catch (e) {
      console.warn('[search applyEditorHighlight]', e);
    }
  }

  function clearEditorHighlight() {
    try { if (window.CSS && CSS.highlights) CSS.highlights.delete('md-search-hits'); } catch (_) {}
    try { if (window.CSS && CSS.highlights) CSS.highlights.delete('md-search-current'); } catch (_) {}
    _matchRanges = [];
    _matchIndex = -1;
    _detachLocatedClearer();
    updateMatchCounter();
  }

  // 「定位高亮」持续标记：点击编辑区（或在编辑区按键）后清除——
  // 同时清掉"全部命中"的黄色标记（md-search-hits），否则从命令面板打开笔记后，
  // 像「的」这种高频词全篇被标黄、只有切换笔记才消失。
  let _locatedClearer = null;
  function _detachLocatedClearer() {
    if (!_locatedClearer) return;
    document.removeEventListener('mousedown', _locatedClearer, true);
    document.removeEventListener('keydown', _locatedClearer, true);
    _locatedClearer = null;
  }
  function setLocatedHighlight(range) {
    try {
      if (!window.CSS || !CSS.highlights) return;
      CSS.highlights.set('md-search-current', new Highlight(range));
      _detachLocatedClearer();
      _locatedClearer = (e) => {
        const ed = document.getElementById('editor');
        const inEditor = ed && (e.type === 'mousedown' ? ed.contains(e.target) : ed.contains(document.activeElement));
        if (inEditor) {
          try { CSS.highlights.delete('md-search-current'); } catch (_) {}
          try { CSS.highlights.delete('md-search-hits'); } catch (_) {}
          _detachLocatedClearer();
        }
      };
      // 延迟挂载，避免「打开/定位这一次的点击」立刻把高亮清掉
      setTimeout(() => {
        if (!_locatedClearer) return;
        document.addEventListener('mousedown', _locatedClearer, true);
        document.addEventListener('keydown', _locatedClearer, true);
      }, 0);
    } catch (_) {}
  }

  function updateMatchCounter() {
    const el = document.getElementById('search-match-count');
    if (!el) return;
    if (_matchRanges.length === 0) {
      el.textContent = '';
    } else {
      el.textContent = _matchIndex >= 0
        ? `${_matchIndex + 1} / ${_matchRanges.length}`
        : `${_matchRanges.length} 处`;
    }
    updateSearchNavFloat();
  }

  // 旧的「行内绝对定位浮动导航条」已被每行的逐行预览导航（.search-result-nav）取代，
  // 这里只负责清理可能残留的旧浮层。编辑区逐个跳转仍由头部按钮 / Enter → scrollToMatch 完成。
  function updateSearchNavFloat() {
    const floatEl = document.querySelector('.search-nav-float');
    if (floatEl) floatEl.remove();
  }

  function goNextMatch() {
    if (!_matchRanges.length) return;
    _matchIndex = (_matchIndex + 1) % _matchRanges.length;
    scrollToMatch(_matchIndex);
  }

  function goPrevMatch() {
    if (!_matchRanges.length) return;
    _matchIndex = (_matchIndex - 1 + _matchRanges.length) % _matchRanges.length;
    scrollToMatch(_matchIndex);
  }

  function scrollToMatch(idx) {
    const r = _matchRanges[idx];
    if (!r) return;
    try {
      // 持久标记（跟随滚动、点击编辑区后才消失），与点搜索结果定位同一套
      setLocatedHighlight(r);
      const rect = r.getBoundingClientRect();
      const scroller = document.getElementById('editor');
      if (scroller && rect.height >= 0) {
        const cr = scroller.getBoundingClientRect();
        const pad = Math.min(scroller.clientHeight * 0.22, 140);
        let targetTop = rect.top - cr.top + scroller.scrollTop - pad;
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        targetTop = Math.max(0, Math.min(targetTop, maxScroll));
        scroller.scrollTo({ top: targetTop, behavior: 'smooth' });
      }
      updateMatchCounter();
      updateActiveRowSnippet(idx);
    } catch (_) {}
  }

  /** 在「已打开」的编辑区里：高亮全部命中 + 精确定位到第 hitIdx 个（持久标记，点编辑区后消失）。
   *  统一供 点搜索结果 / 命令面板打开 复用——比旧的字面 indexOf 更稳（含拼音/模糊命中、单命中也生效）。 */
  function locateInOpenEditor(q, hitIdx) {
    if (!q) return;
    applyEditorHighlight(q);
    if (_matchRanges.length) {
      _matchIndex = Math.min(Math.max(0, hitIdx || 0), _matchRanges.length - 1);
      scrollToMatch(_matchIndex);
    } else {
      // 正文无命中（纯标题命中）：滚到顶部即可，无可高亮目标
      const ed = document.getElementById('editor');
      if (ed) ed.scrollTop = 0;
    }
  }

  /** 点3：编辑区导航到第 idx 个命中时，同步「当前高亮行」的前后文摘要 + ‹n/m› 计数。
   *  优先用该行的逐行导航状态（与 hover 切命中同一来源，保持一致）；无状态时退回 DOM range 上下文。 */
  function updateActiveRowSnippet(idx) {
    try {
      const row = document.querySelector('#tree-container .search-result-row.active');
      if (!row) return;
      if (row._state && row._state.matches && row._state.matches.length) {
        const st = row._state;
        st.hitIdx = Math.max(0, Math.min(idx, st.matches.length - 1));
        const snip = row.querySelector('.search-result-snippet');
        if (snip) snip.innerHTML = rowSnippetHtml(st);
        const cnt = row.querySelector('.cmd-hit-count');
        if (cnt) cnt.textContent = `${st.hitIdx + 1}/${st.matches.length}`;
        return;
      }
      const r = _matchRanges[idx];
      if (!r) return;
      const node = r.startContainer;
      const txt = (node && node.textContent) || '';
      const len = Math.max(1, (r.endOffset - r.startOffset) || _currentQuery.length);
      let snip = row.querySelector('.search-result-snippet');
      if (!snip) {
        snip = document.createElement('div');
        snip.className = 'search-result-snippet';
        (row.querySelector('.srr-main') || row).appendChild(snip);
      }
      snip.innerHTML = buildContextSnippet(txt, r.startOffset, len, _currentQuery);
    } catch (_) {}
  }
  // ===== 搜索结果行·逐行预览导航（与命令面板同款；复用 findMatches/buildContextSnippet）=====
  let _rows = [];  // 每行的状态 { id, q, plainText, matches, hitIdx, el }

  /** 取一篇笔记纯文本 + query 的全部命中（与命令面板 computeItemMatches 同款）。 */
  function noteMatches(note, q) {
    let text = '';
    try { text = note.doc ? (window.editor?.docToPlainText(note.doc) || '') : (note.content || ''); }
    catch (_) { text = note.content || ''; }
    return { text, matches: findMatches(text, q) };
  }

  /** 某行当前命中的前后文摘要 HTML：有正文命中用 buildContextSnippet，否则退回 searchAll 的 snippet。 */
  function rowSnippetHtml(state) {
    if (state.matches && state.matches.length) {
      const m = state.matches[state.hitIdx || 0];
      return buildContextSnippet(state.plainText, m[0], m[1] - m[0] + 1, state.q);
    }
    return state.fallback ? highlightHtml(state.fallback, state.q) : '';
  }

  function rowNavHtml(total, hitIdx) {
    if (total > 1) {
      return `<div class="search-result-nav cmd-item-nav">
        <span class="cmd-hit-badge toggleable">${total} 处</span>
        <div class="cmd-hit-ctrl">
          <button type="button" class="cmd-hit-btn srr-hit-prev" title="上一处命中" tabindex="-1"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
          <span class="cmd-hit-count">${(hitIdx || 0) + 1}/${total}</span>
          <button type="button" class="cmd-hit-btn srr-hit-next" title="下一处命中" tabindex="-1"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
        </div>
      </div>`;
    } else if (total === 1) {
      return `<div class="search-result-nav cmd-item-nav"><span class="cmd-hit-badge">1 处</span></div>`;
    }
    return '';
  }

  /** 在某行的多个命中间切换：就地更新摘要与 n/m，不重渲、不打开；若该笔记已打开则编辑区实时滚动+定位。 */
  function cycleRowHit(state, dir) {
    const total = state.matches ? state.matches.length : 0;
    if (total < 2) return;
    state.hitIdx = ((state.hitIdx || 0) + dir + total) % total;
    const row = state.el;
    if (row) {
      const snip = row.querySelector('.search-result-snippet');
      if (snip) snip.innerHTML = rowSnippetHtml(state);
      const cnt = row.querySelector('.cmd-hit-count');
      if (cnt) cnt.textContent = `${state.hitIdx + 1}/${total}`;
    }
    // 该笔记已打开：用编辑区里第 hitIdx 个 DOM 命中精确定位（顺序一致），
    // 走 scrollToMatch → 平滑滚动 + 持久标记跟随 + 脉冲，比按纯文本偏移找最近更准、能跟随。
    if (editor.currentId && editor.currentId() === state.id) {
      if (_matchRanges.length) {
        _matchIndex = Math.min(state.hitIdx, _matchRanges.length - 1);
        scrollToMatch(_matchIndex);
      } else {
        highlightInEditor(state.q, state.matches[state.hitIdx][0]);
      }
    }
  }

  /** ←→ 键：切换「当前选中行」的命中（供 app.js 在输入框光标处于末尾时调用）。 */
  function navActiveHit(dir) {
    const row = document.querySelector('#tree-container .search-result-row.active');
    if (row && row._state && row._state.matches && row._state.matches.length > 1) {
      cycleRowHit(row._state, dir);
      return true;
    }
    return false;
  }

  // 暴露给 editor.js 在切换笔记后重新应用
  window.search = window.search || {};
  setTimeout(() => {
    if (window.search) {
      window.search.applyEditorHighlight = applyEditorHighlight;
      window.search.clearEditorHighlight = clearEditorHighlight;
    }
  }, 0);

  function renderResults(hits, q) {
    const container = document.getElementById('tree-container');
    container.innerHTML = '';
    if (!hits.length) {
      // 列出当前空间前 5 个笔记 + 拼音转换结果，让用户知道"为什么没匹配"
      let debugHtml = '';
      try {
        const all = storage.getAll();
        const wsId = storage.getSetting('activeWorkspace') || 'ws-default';
        const sample = Object.values(all.notes || {})
          .filter(n => n.workspaceId === wsId && !n.deleted)
          .slice(0, 5);
        if (sample.length && typeof window.pinyinPro?.pinyin === 'function') {
          debugHtml = '<div style="margin-top:8px;padding:8px;background:var(--bg-secondary);border-radius:6px;font-size:11px;opacity:0.8;text-align:left;">'
            + '<div style="font-weight:600;margin-bottom:4px;color:var(--text-secondary);">已存在笔记的拼音参考：</div>'
            + sample.map(n => {
                const t = n.title || '无标题';
                const full = window.pinyinPro.pinyin(t, { toneType:'none', type:'string', nonZh:'consecutive' }).replace(/\s+/g,'').toLowerCase();
                const first = window.pinyinPro.pinyin(t, { pattern:'first', toneType:'none', type:'string', nonZh:'consecutive' }).replace(/\s+/g,'').toLowerCase();
                return `<div>· ${escapeHtml(t)} → <code>${first}</code> / <code>${full}</code></div>`;
              }).join('')
            + '</div>';
        }
      } catch (_) {}
      container.innerHTML = `<div class="tree-empty">未找到「${escapeHtml(q)}」<br><span style="font-size:11px;opacity:.7">支持中文、英文、拼音首字母 / 全拼 / 子序列</span>${debugHtml}</div>`;
      return;
    }

    let _autoSelected = false;
    const titleHits = hits.filter(h => h.titleMatch).length;
    const contentHits = hits.length - titleHits;
    const header = document.createElement('div');
    header.style.cssText = 'padding:8px 12px;font-size:12px;color:var(--text-tertiary);';
    header.textContent = `${hits.length} 条 · 标题 ${titleHits} · 正文 ${contentHits}`;
    container.appendChild(header);

    _rows = [];
    for (const h of hits) {
      const note = storage.get(h.id) || {};
      const { text: plainText, matches } = noteMatches(note, q);
      const state = { id: h.id, q, plainText, matches, hitIdx: 0, fallback: h.snippet || '' };

      const item = document.createElement('div');
      item.className = 'tree-row search-result-row' + (matches.length ? ' has-nav' : '');
      item._state = state;
      state.el = item;

      // 主体（标题 / 路径 / 摘要）竖排，导航条放右侧
      const main = document.createElement('div');
      main.className = 'srr-main';

      const titleLine = document.createElement('div');
      titleLine.className = 'search-result-title';
      const iconEl = document.createElement('span');
      iconEl.className = 'tree-note-icon';
      const _hasBody = note.doc
        ? !(window.editor && window.editor.docIsEmpty(note.doc))
        : !!(note.content && note.content.trim());
      const defaultIcon = _hasBody ? '📝' : '📄';
      iconEl.textContent = note.icon || defaultIcon;
      if (note.color) {
        iconEl.classList.add('has-color');
        iconEl.style.setProperty('--note-color-dot', note.color);
      }
      const titleText = document.createElement('span');
      titleText.className = 'search-result-title-text';
      titleText.innerHTML = highlightHtml(h.title || '无标题', q);
      titleLine.appendChild(iconEl);
      titleLine.appendChild(titleText);

      const meta = document.createElement('div');
      meta.className = 'search-result-meta';
      const ancestors = storage.getAncestors(h.id).slice(0, -1).map(x => x.title || '无标题').join(' / ');
      meta.innerHTML = `<span class="search-result-path">${escapeHtml(ancestors || '顶级')}</span>` +
        (h.titleMatch ? '' : '<span class="search-result-tag">正文</span>');

      main.appendChild(titleLine);
      main.appendChild(meta);

      const snipHtml = rowSnippetHtml(state);
      if (snipHtml) {
        const snippet = document.createElement('div');
        snippet.className = 'search-result-snippet';
        snippet.innerHTML = snipHtml;
        main.appendChild(snippet);
      }

      item.appendChild(main);

      const navHtml = rowNavHtml(matches.length, 0);
      if (navHtml) {
        const navWrap = document.createElement('div');
        navWrap.innerHTML = navHtml;
        const navEl = navWrap.firstElementChild;
        item.appendChild(navEl);
        const prev = navEl.querySelector('.srr-hit-prev');
        const next = navEl.querySelector('.srr-hit-next');
        if (prev) prev.addEventListener('click', (e) => { e.stopPropagation(); cycleRowHit(state, -1); });
        if (next) next.addEventListener('click', (e) => { e.stopPropagation(); cycleRowHit(state, 1); });
      }

      item.addEventListener('click', () => {
        container.querySelectorAll('.search-result-row.active').forEach(r => r.classList.remove('active'));
        item.classList.add('active');
        const hitIdx = state.hitIdx || 0;
        editor.open(h.id).then(() => {
          setTimeout(() => locateInOpenEditor(q, hitIdx), 90);
        });
        expandAncestors(h.id);
      });
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof tree.showContextMenu === 'function') {
          tree.showContextMenu(e, h.id);
        }
      });
      container.appendChild(item);

      if (editor.currentId && editor.currentId() === h.id && !_autoSelected) {
        _autoSelected = true;
        item.classList.add('active');
      }
    }
  }

  /** 在编辑器内查找 query 第一处出现，滚动到该位置并临时高亮 1.5s */
  function highlightInEditor(query, hintPos) {
    if (!query) return;
    setTimeout(() => {
      try {
        const root = document.getElementById('editor');
        if (!root) return;
        const editable = root.querySelector('.ProseMirror');
        if (!editable) return;

        // 遍历所有文本节点；累计偏移，结合 hintPos（正文纯文本里的命中位置）
        // 选出"离 hintPos 最近的那一处"匹配，而不是永远第一处
        const lower = query.toLowerCase();
        const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT, null);
        let node, running = 0;
        let hitNode = null, hitOffset = -1, bestDist = Infinity;
        const wantPos = (hintPos != null && hintPos >= 0) ? hintPos : 0;
        while ((node = walker.nextNode())) {
          const txt = node.textContent;
          const lowerTxt = txt.toLowerCase();
          let from = 0, idx;
          while ((idx = lowerTxt.indexOf(lower, from)) >= 0) {
            const globalPos = running + idx;
            const dist = Math.abs(globalPos - wantPos);
            if (dist < bestDist) { bestDist = dist; hitNode = node; hitOffset = idx; }
            from = idx + Math.max(1, lower.length);
          }
          running += txt.length;
          // 已经找到且越过 hintPos 较多，可提前结束（命中只会越来越远）
          if (hitNode && running > wantPos + query.length && bestDist === 0) break;
        }
        if (!hitNode) {
          editable.scrollTop = 0;
          return;
        }

        // 创建一个临时 span 包裹匹配文字
        const range = document.createRange();
        range.setStart(hitNode, hitOffset);
        range.setEnd(hitNode, hitOffset + query.length);
        const rect = range.getBoundingClientRect();
        const erRect = editable.getBoundingClientRect();
        // 滚动到匹配位置（垂直居中）
        editable.scrollTop += (rect.top - erRect.top) - editable.clientHeight / 3;

        // 持续标记：跟随滚动、点击编辑区后才消失（唯一的定位视觉，无动画）
        setLocatedHighlight(range);
      } catch (e) {
        console.warn('[search highlightInEditor]', e);
      }
    }, 220);
  }

  function expandAncestors(id) {
    const chain = storage.getAncestors(id);
    for (const n of chain.slice(0, -1)) {
      storage.setExpanded(n.id, true);
    }
  }

  function restoreTreeView() { tree.render(); }

  function highlightHtml(text, query) {
    if (!query) return escapeHtml(text);
    const ts = window.textSearch;
    if (ts) {
      const ranges = ts(text, query);
      if (ranges && ranges.length > 0) {
        let consecutive = true;
        for (let i = 1; i < ranges.length; i++) {
          if (ranges[i][0] > ranges[i - 1][1] + 1) { consecutive = false; break; }
        }
        if (consecutive) {
          let result = '';
          let lastEnd = 0;
          for (const [start, end] of ranges) {
            result += escapeHtml(text.slice(lastEnd, start));
            result += '<span class="search-highlight">' + escapeHtml(text.slice(start, end + 1)) + '</span>';
            lastEnd = end + 1;
          }
          result += escapeHtml(text.slice(lastEnd));
          return result;
        }
      }
    } else {
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx >= 0) {
        return escapeHtml(text.slice(0, idx))
          + '<span class="search-highlight">' + escapeHtml(text.slice(idx, idx + query.length)) + '</span>'
          + escapeHtml(text.slice(idx + query.length));
      }
    }
    return escapeHtml(text);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  return {
    activate, deactivate, handleInput,
    isActive: () => _active,
    applyEditorHighlight, clearEditorHighlight,
    goNextMatch, goPrevMatch, navActiveHit,
    findMatches, buildContextSnippet, highlightInEditor, locateInOpenEditor,
  };
})();

window.search = search;
