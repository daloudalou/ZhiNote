/**
 * tree.js — 左侧笔记树视图
 *
 * 职责：
 * - 基于 storage 的扁平数据渲染树形视图
 * - 点击/展开/重命名/右键菜单/拖拽调序与改变层级
 * - 颜色标记
 * - 回收站视图（模态框内）
 */

const COLOR_PRESETS = [
  { name: '无颜色', value: null },
  { name: '红色', value: '#f53f3f' },
  { name: '橙色', value: '#ff9500' },
  { name: '黄色', value: '#f7ba1e' },
  { name: '绿色', value: '#00b42a' },
  { name: '青色', value: '#14c9c9' },
  { name: '蓝色', value: '#3370ff' },
  { name: '紫色', value: '#7928ca' },
  { name: '粉色', value: '#e91e63' },
  { name: '灰色', value: '#86909c' },
];

const tree = (() => {
  let _searchHighlight = '';
  let _dragSrcId = null;
  let _dragSrcIds = null;        // 多选拖拽时的整组源 id（单选拖拽为 null）

  // ── 触屏长按拖拽 ─────────────────────────────────────────────────────────
  // HTML5 DnD 不支持触屏：长按既不会 dragstart、系统菜单又被 preventDefault 拦掉，
  // 表现为"长按拖动卡住无响应"。触屏设备改为自实现：
  // 长按 380ms 拾起（震动反馈）→ 移动跟随高亮落点 → 松手落位；长按不动松手 = 右键菜单。
  const IS_COARSE = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  let _td = null;                // { id, row, x, y, armed, moved }
  let _tdTimer = null;

  // ── 拖拽时的边缘自动滚动 ──────────────────────────────────────────────────
  // 拖到列表上/下边缘附近时自动滚动，避免长列表必须先手动滚动才能拖到目标。
  let _autoScrollRAF = null;
  let _autoScrollVy = 0;         // 当前滚动速度（px/帧），>0 向下，<0 向上
  function _autoScrollTick() {
    const c = document.getElementById('tree-container');
    if (c && _autoScrollVy) c.scrollTop += _autoScrollVy;
    _autoScrollRAF = _autoScrollVy ? requestAnimationFrame(_autoScrollTick) : null;
  }
  // 根据指针 Y 与容器边缘的距离设定滚动速度；拖拽中持续调用。
  function _updateAutoScroll(clientY) {
    const c = document.getElementById('tree-container');
    if (!c) { _autoScrollVy = 0; return; }
    const r = c.getBoundingClientRect();
    const EDGE = 36;             // 触发区高度
    const MAX = 14;              // 最大速度
    if (clientY < r.top + EDGE) {
      _autoScrollVy = -Math.ceil(MAX * (r.top + EDGE - clientY) / EDGE);
    } else if (clientY > r.bottom - EDGE) {
      _autoScrollVy = Math.ceil(MAX * (clientY - (r.bottom - EDGE)) / EDGE);
    } else {
      _autoScrollVy = 0;
    }
    if (_autoScrollVy && !_autoScrollRAF) _autoScrollRAF = requestAnimationFrame(_autoScrollTick);
  }
  function _stopAutoScroll() {
    _autoScrollVy = 0;
    if (_autoScrollRAF) { cancelAnimationFrame(_autoScrollRAF); _autoScrollRAF = null; }
  }

  // ── 拖拽悬停自动展开折叠的父节点 ──────────────────────────────────────────
  // 悬停在折叠父节点上 800ms（带摇晃提示）后自动展开，便于拖进其子层级；不易误触。
  const HOVER_EXPAND_MS = 800;
  let _hoverExpandTimer = null;
  let _hoverExpandId = null;
  function _clearHoverExpand() {
    if (_hoverExpandTimer) { clearTimeout(_hoverExpandTimer); _hoverExpandTimer = null; }
    if (_hoverExpandId) {
      document.querySelectorAll('.tree-row.drag-hover-pending').forEach(el => el.classList.remove('drag-hover-pending'));
      _hoverExpandId = null;
    }
  }
  // 拖拽悬停在折叠父节点上时调用：必要时起摇晃计时器，到点展开。
  function _maybeHoverExpand(row, id) {
    const note = storage.get(id);
    const collapsedParent = note && !note.expanded && storage.getChildren(id).length > 0 && !_dropForbidden(id);
    if (!collapsedParent) { _clearHoverExpand(); return; }
    if (_hoverExpandId === id) return;   // 已在为该节点计时，避免每次 dragover 重置
    _clearHoverExpand();
    _hoverExpandId = id;
    row.classList.add('drag-hover-pending');
    _hoverExpandTimer = setTimeout(() => {
      row.classList.remove('drag-hover-pending');
      _hoverExpandTimer = null;
      _hoverExpandId = null;
      if (!(_dragSrcId || _dragSrcIds)) return;
      const wrap = row.closest('.tree-node');
      if (wrap && storage.get(id) && !storage.get(id).expanded) expandBranchInPlace(wrap, id);
    }, HOVER_EXPAND_MS);
  }

  // ── 多选状态 ────────────────────────────────────────────────────────────
  // 用背景高亮 + 底部浮动操作条表达选择，不在行内加复选框（行已很挤）。
  const _sel = new Set();        // 已选中的笔记 id 集合
  let _selAnchor = null;         // Shift 范围选择的锚点 id
  let _selectMode = false;       // 选择模式：进入后普通单击=勾选（由空白右键「选择多项」开启）

  // 判断 targetId 是否是 ancestorId 的后代
  function isDescendant(targetId, ancestorId) {
    let p = storage.get(targetId)?.parentId;
    while (p) {
      if (p === ancestorId) return true;
      p = storage.get(p)?.parentId;
    }
    return false;
  }

  // 当前可见 .tree-node 的 id 顺序（用于 Shift 范围选择 / 整组拖拽排序）
  function _visibleNodeIds() {
    const c = document.getElementById('tree-container');
    if (!c) return [];
    return [...c.querySelectorAll('.tree-node')].map(n => n.dataset.id).filter(Boolean);
  }

  function hasSelection() { return _sel.size > 0; }

  function _applySelClasses() {
    document.querySelectorAll('.tree-row.selected').forEach(r => {
      if (!_sel.has(r.dataset.id)) r.classList.remove('selected');
    });
    _sel.forEach(id => {
      document.querySelectorAll(`.tree-row[data-id="${CSS.escape(id)}"]`).forEach(r => r.classList.add('selected'));
    });
  }

  function clearSelection(opts = {}) {
    if (!_sel.size && !_selectMode) return;
    _sel.clear();
    _selectMode = false;
    _selAnchor = null;
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    if (!opts.silent) _updateSelBar();
  }

  function _toggleSel(id) {
    if (_sel.has(id)) _sel.delete(id); else _sel.add(id);
    _selAnchor = id;
    _applySelClasses();
    _updateSelBar();
  }

  function _selectRange(toId) {
    const order = _visibleNodeIds();
    const a = order.indexOf(_selAnchor);
    const b = order.indexOf(toId);
    if (a < 0 || b < 0) { _toggleSel(toId); return; }
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) _sel.add(order[i]);
    _applySelClasses();
    _updateSelBar();
  }

  // 规范化选择集：剔除“祖先也被选中”的后代（移动祖先会带走整棵子树），按可见顺序返回
  function _normalizeSel(ids) {
    const set = new Set(ids);
    const out = ids.filter(id => {
      let p = storage.get(id)?.parentId;
      while (p) { if (set.has(p)) return false; p = storage.get(p)?.parentId; }
      return true;
    });
    const order = _visibleNodeIds();
    out.sort((x, y) => order.indexOf(x) - order.indexOf(y));
    return out;
  }

  // 行点击统一入口：Ctrl/Cmd 切换勾选、Shift 范围选、选择模式单击勾选，否则正常打开
  function handleRowClick(e, id) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); _toggleSel(id); return; }
    if (e.shiftKey && _selAnchor) { e.preventDefault(); _selectRange(id); return; }
    if (_selectMode) { _toggleSel(id); return; }
    if (_sel.size) clearSelection();
    _selAnchor = id; // 记录锚点：之后 Shift+点击可从当前打开的笔记起做范围选择
    editor.open(id);
    setActive(id);
  }

  function render() {
    const container = document.getElementById('tree-container');
    if (!container) return;
    _dragSrcId = null;
    _bindBgMenu();
    // 拖拽边缘自动滚动：用捕获阶段绑定，不受子行 stopPropagation 影响（只绑一次）
    if (!container._dndAutoScrollBound) {
      container._dndAutoScrollBound = true;
      container.addEventListener('dragover', (e) => { if (_dragSrcId || _dragSrcIds) _updateAutoScroll(e.clientY); }, true);
      container.addEventListener('drop', _stopAutoScroll, true);
    }
    container.innerHTML = '';

    const roots = storage.getChildren(null);
    const pinned = (storage.getSetting('pinned') || []).map(id => storage.get(id)).filter(Boolean);

    if (!roots.length && !pinned.length) {
      container.innerHTML = '<div class="tree-empty">还没有笔记<br>点击上方 + 创建</div>';
      return;
    }

    if (pinned.length) {
      const sec = document.createElement('div');
      sec.style.cssText = 'padding:6px 12px 4px;font-size:11px;color:var(--text-tertiary);font-weight:600;text-transform:uppercase;letter-spacing:.5px;';
      sec.textContent = '置顶';
      container.appendChild(sec);
      for (const p of pinned) {
        const n = renderPinnedRow(p);
        container.appendChild(n);
      }
      const div = document.createElement('div');
      div.style.cssText = 'height:1px;background:var(--border);margin:6px 8px;';
      container.appendChild(div);

      const allSec = document.createElement('div');
      allSec.style.cssText = sec.style.cssText;
      allSec.textContent = '全部';
      container.appendChild(allSec);
    }

    for (const r of roots) {
      container.appendChild(renderNode(r, 0));
    }

    // 底部根放置区：拖到这里=移动到根层级末尾。解决「最后一行是子笔记时无法拖成根笔记」的通病。
    container.appendChild(_makeRootDropZone());

    // 多选：剔除已不存在的 id（可能被删除/移动到别的笔记本），重画选中态与操作条
    for (const id of [..._sel]) {
      const n = storage.get(id);
      if (!n || (n.workspaceId && n.workspaceId !== storage.getActiveWorkspace()?.id)) _sel.delete(id);
    }
    _applySelClasses();
    _updateSelBar();
  }

  function renderPinnedRow(note) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    wrap.dataset.id = note.id;
    const row = document.createElement('div');
    row.className = 'tree-row is-pinned-section';
    if (editor.currentId && editor.currentId() === note.id) row.classList.add('active');
    row.dataset.id = note.id;

    const pinIcon = document.createElement('span');
    pinIcon.className = 'tree-pin-icon';
    pinIcon.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z"/></svg>';

    // 置顶行也用图标按钮，保持一致
    const iconBtn = document.createElement('span');
    iconBtn.className = 'tree-note-icon is-pinned-row';
    iconBtn.textContent = note.icon || '📝';
    if (note.color) {
      iconBtn.classList.add('has-color');
      iconBtn.style.setProperty('--note-color-dot', note.color);
    }

    const title = document.createElement('span');
    title.className = 'tree-title';
    title.textContent = note.title || '无标题';

    row.appendChild(pinIcon);
    row.appendChild(iconBtn);
    row.appendChild(title);

    row.addEventListener('click', (e) => handleRowClick(e, note.id));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, note.id); });

    // 置顶行作为拖拽目标（放入=变为该笔记的子笔记）
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (_dropForbidden(note.id)) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => { row.classList.remove('drag-over'); });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drag-over');
      const srcId = e.dataTransfer.getData('text/plain');
      const srcs = (_dragSrcIds && _dragSrcIds.length) ? _dragSrcIds : (srcId ? [srcId] : []);
      if (!srcs.length || _dropForbidden(note.id)) return;
      const srcSet = new Set(srcs);
      const children = storage.getChildren(note.id).filter(n => !srcSet.has(n.id));
      const ok = _applyDropMove(srcs, note.id, children.length);
      if (ok) render();
      else toast('不能把笔记移动到自己或子节点内', 'error');
    });

    wrap.appendChild(row);
    return wrap;
  }

  function expandAncestors(id) {
    const chain = storage.getAncestors(id);
    for (const n of chain.slice(0, -1)) storage.setExpanded(n.id, true);
  }

  function scrollToNote(id) {
    const row = document.querySelector(`.tree-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** 高亮指定笔记行（不重渲整树）。打开笔记后立即同步侧栏选中态。 */
  function setActive(id) {
    document.querySelectorAll('.tree-row.active:not(.search-result-row)').forEach(r => r.classList.remove('active'));
    if (!id) return;
    const row = document.querySelector(`.tree-row[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.add('active');
  }

  /** 局部更新某个节点的标题（顶栏改名时调用），不全树重渲，避免侧栏闪烁 */
  function updateNodeTitle(id, newTitle) {
    if (!id) return;
    const sel = `.tree-row[data-id="${CSS.escape(id)}"] .tree-title,
                 .pinned-row[data-id="${CSS.escape(id)}"] .pinned-title`;
    document.querySelectorAll(sel).forEach(el => {
      // 跳过用户正在重命名的输入框
      if (el.tagName === 'INPUT') return;
      el.textContent = newTitle || '无标题';
    });
  }

  /** 当前节点在侧栏中的深度（根笔记为 0），用于 renderNode 递归 */
  function depthForNote(id) {
    return Math.max(0, storage.getAncestors(id).length - 1);
  }

  const TREE_OPEN_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
  const TREE_DUR_OPEN = '0.22s';
  const TREE_DUR_CLOSE = '0.18s';

  /**
   * 就地展开子树（精确 height px + max-height 过渡）。
   * 说明：grid-template-rows 在 0fr↔1fr 上很多 WebView2/旧 Chromium 不插值 → 看起来「完全没动画」；max-height(px) 则普遍可过渡。
   */
  function expandBranchInPlace(nodeWrap, noteId, onDone) {
    const kids = storage.getChildren(noteId);
    if (!kids.length) { onDone?.(); return; }
    const existing = nodeWrap.querySelector(':scope > .tree-children');
    if (existing) {
      if (existing.dataset.collapsing) existing.remove();
      else { onDone?.(); return; }
    }
    storage.setExpanded(noteId, true);
    const chevron = nodeWrap.querySelector('.tree-chevron');
    if (chevron) chevron.classList.add('expanded');
    const depth = depthForNote(noteId);
    const childWrap = document.createElement('div');
    childWrap.className = 'tree-children';
    const inner = document.createElement('div');
    inner.className = 'tree-children-inner';
    for (const c of kids) inner.appendChild(renderNode(c, depth + 1));
    childWrap.appendChild(inner);
    childWrap.style.overflow = 'hidden';
    childWrap.style.maxHeight = '0px';
    childWrap.style.opacity = '0';
    nodeWrap.appendChild(childWrap);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const h = Math.max(inner.scrollHeight, 1);
        childWrap.style.transition = `max-height ${TREE_DUR_OPEN} ${TREE_OPEN_EASE}, opacity 0.22s ease`;
        childWrap.style.maxHeight = `${h}px`;
        childWrap.style.opacity = '1';
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(fb);
          childWrap.removeEventListener('transitionend', onEnd);
          childWrap.style.transition = '';
          childWrap.style.maxHeight = 'none';
          childWrap.style.opacity = '';
          childWrap.style.overflow = '';
          onDone?.();
        };
        const onEnd = (ev) => {
          if (ev.propertyName !== 'max-height') return;
          settle();
        };
        childWrap.addEventListener('transitionend', onEnd);
        const fb = setTimeout(settle, 400);
      });
    });
  }

  /** 就地折叠子树；无子 DOM 时只同步状态。折叠只做 max-height，避免 opacity 整块同时淡出。 */
  function collapseBranchInPlace(nodeWrap, noteId, onDone) {
    const childWrap = nodeWrap.querySelector(':scope > .tree-children');
    const chevron = nodeWrap.querySelector('.tree-chevron');
    storage.setExpanded(noteId, false);
    if (chevron) chevron.classList.remove('expanded');
    if (!childWrap) { onDone?.(); return; }
    childWrap.dataset.collapsing = '1';

    const inner = childWrap.querySelector('.tree-children-inner');
    const h0 = inner ? inner.scrollHeight : childWrap.scrollHeight;
    const h = Math.max(h0, 1);
    childWrap.style.opacity = '1';
    childWrap.style.overflow = 'hidden';
    childWrap.style.transition = 'none';
    childWrap.style.maxHeight = `${h}px`;
    void childWrap.offsetHeight;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        childWrap.style.transition = `max-height ${TREE_DUR_CLOSE} ${TREE_OPEN_EASE}`;
        childWrap.style.maxHeight = '0px';
      });
    });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      childWrap.removeEventListener('transitionend', onEnd);
      childWrap.remove();
      onDone?.();
    };
    const onEnd = (ev) => {
      if (ev.propertyName !== 'max-height') return;
      finish();
    };
    childWrap.addEventListener('transitionend', onEnd);
    const fallback = setTimeout(finish, 350);
  }

  /** 折叠全部：storage 先全部标记折叠（silent），然后 DOM 中可见的子树动画收起 */
  function collapseAllAnimated() {
    // silent 地标记所有节点折叠（setExpanded 的 change 事件带 silent:true），避免触发 tree.render 打断动画
    const allNotes = storage.getAll().notes || {};
    for (const id in allNotes) { if (allNotes[id].expanded) storage.setExpanded(id, false); }

    const allNodes = Array.from(document.querySelectorAll('#tree-container .tree-node'))
      .filter(el => el.dataset?.id && el.querySelector(':scope > .tree-children'));
    for (const el of allNodes) {
      const chevron = el.querySelector('.tree-chevron');
      if (chevron) chevron.classList.remove('expanded');
      const childWrap = el.querySelector(':scope > .tree-children');
      if (!childWrap) continue;
      childWrap.dataset.collapsing = '1';
      const inner = childWrap.querySelector('.tree-children-inner');
      const h0 = inner ? inner.scrollHeight : childWrap.scrollHeight;
      const h = Math.max(h0, 1);
      childWrap.style.opacity = '1';
      childWrap.style.overflow = 'hidden';
      childWrap.style.transition = 'none';
      childWrap.style.maxHeight = `${h}px`;
      void childWrap.offsetHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          childWrap.style.transition = `max-height ${TREE_DUR_CLOSE} ${TREE_OPEN_EASE}`;
          childWrap.style.maxHeight = '0px';
        });
      });
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(fb); childWrap.remove(); };
      const onEnd = (ev) => { if (ev.propertyName === 'max-height') finish(); };
      childWrap.addEventListener('transitionend', onEnd);
      const fb = setTimeout(finish, 350);
    }
  }

  /** 展开全部：记录已折叠节点 → 标记展开 → 重渲 → 新出现的子树做 max-height 动画 */
  function expandAllAnimated() {
    const allNotes = storage.getAll().notes || {};
    const wasCollapsed = new Set();
    let changed = false;
    for (const id in allNotes) {
      const hasChild = Object.values(allNotes).some(n => n.parentId === id);
      if (hasChild && !allNotes[id].expanded) { wasCollapsed.add(id); storage.setExpanded(id, true); changed = true; }
    }
    if (!changed) return;

    render();

    const container = document.getElementById('tree-container');
    if (!container) return;

    const targets = [];
    for (const nodeEl of container.querySelectorAll('.tree-node')) {
      const id = nodeEl.dataset.id;
      if (!wasCollapsed.has(id)) continue;
      const childWrap = nodeEl.querySelector(':scope > .tree-children');
      if (!childWrap) continue;
      const inner = childWrap.querySelector('.tree-children-inner');
      targets.push({ childWrap, h: Math.max((inner ? inner.scrollHeight : childWrap.scrollHeight), 1) });
    }
    if (!targets.length) return;

    for (const { childWrap } of targets) {
      childWrap.style.overflow = 'hidden';
      childWrap.style.transition = 'none';
      childWrap.style.maxHeight = '0px';
      childWrap.style.opacity = '0';
    }
    void container.offsetHeight;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const dur = '0.32s';
        for (const { childWrap, h } of targets) {
          childWrap.style.transition = `max-height ${dur} ${TREE_OPEN_EASE}, opacity 0.25s ease`;
          childWrap.style.maxHeight = `${h}px`;
          childWrap.style.opacity = '1';
          let done = false;
          const cleanup = () => {
            if (done) return; done = true;
            clearTimeout(fb);
            childWrap.removeEventListener('transitionend', onEnd);
            childWrap.style.transition = '';
            childWrap.style.maxHeight = 'none';
            childWrap.style.opacity = '';
            childWrap.style.overflow = '';
          };
          const onEnd = (ev) => { if (ev.propertyName === 'max-height') cleanup(); };
          childWrap.addEventListener('transitionend', onEnd);
          const fb = setTimeout(cleanup, 500);
        }
      });
    });
  }

  function renderNode(note, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    wrap.dataset.id = note.id;

    const row = document.createElement('div');
    row.className = 'tree-row';
    if (editor.currentId && editor.currentId() === note.id) row.classList.add('active');
    row.dataset.id = note.id;
    row.draggable = !IS_COARSE; // 触屏端禁用原生 DnD，走自实现长按拖拽

    const children = storage.getChildren(note.id);
    const hasChildren = children.length > 0;

    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron' + (note.expanded ? ' expanded' : '') + (hasChildren ? '' : ' empty');
    // 更细更现代的右向 chevron（线段而非粗实线，回避卡通风）
    chevron.innerHTML = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M4 2.5 L8.5 6 L4 9.5 Z"/></svg>';
    if (hasChildren) {
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        const live = storage.get(note.id);
        if (!live || !storage.getChildren(note.id).length) return;
        const liveWrap = e.currentTarget.closest('.tree-node') || wrap;
        if (!live.expanded) expandBranchInPlace(liveWrap, note.id);
        else collapseBranchInPlace(liveWrap, note.id);
      });
      chevron.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); });
      chevron.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    const iconBtn = document.createElement('span');
    iconBtn.className = 'tree-note-icon';
    // 判空兼容 doc：有 doc 用 docIsEmpty；否则看旧 content。
    const _hasBody = note.doc
      ? !(window.editor && window.editor.docIsEmpty(note.doc))
      : !!(note.content && note.content.trim());
    const defaultIcon = _hasBody ? '📝' : '📄';
    iconBtn.textContent = note.icon || defaultIcon;
    if (note.color) {
      iconBtn.classList.add('has-color');
      iconBtn.style.setProperty('--note-color-dot', note.color);
    }
    iconBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showIconPicker(e, note.id);
    });

    const title = document.createElement('span');
    title.className = 'tree-title';
    title.textContent = note.title || '无标题';
    if (_searchHighlight) {
      title.innerHTML = highlightHtml(note.title || '无标题', _searchHighlight);
    }

    const actions = document.createElement('span');
    actions.className = 'tree-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'tree-act-btn';
    addBtn.title = '新建子笔记';
    addBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const child = storage.create({ parentId: note.id, title: '' });
      const nodeWrap = row.closest('.tree-node');
      if (nodeWrap && !note.expanded) {
        storage.setExpanded(note.id, true);
        render();
        const newNode = document.querySelector(`.tree-node[data-id="${CSS.escape(note.id)}"]`);
        if (newNode) {
          const childWrap = newNode.querySelector(':scope > .tree-children');
          if (childWrap) {
            const inner = childWrap.querySelector('.tree-children-inner');
            const h = Math.max((inner ? inner.scrollHeight : childWrap.scrollHeight), 1);
            childWrap.style.overflow = 'hidden';
            childWrap.style.transition = 'none';
            childWrap.style.maxHeight = '0px';
            childWrap.style.opacity = '0';
            void childWrap.offsetHeight;
            requestAnimationFrame(() => {
              childWrap.style.transition = `max-height ${TREE_DUR_OPEN} ${TREE_OPEN_EASE}, opacity 0.22s ease`;
              childWrap.style.maxHeight = `${h}px`;
              childWrap.style.opacity = '1';
              const cleanup = () => {
                childWrap.style.transition = '';
                childWrap.style.maxHeight = 'none';
                childWrap.style.opacity = '';
                childWrap.style.overflow = '';
              };
              childWrap.addEventListener('transitionend', function onEnd(ev) {
                if (ev.propertyName === 'max-height') { childWrap.removeEventListener('transitionend', onEnd); cleanup(); }
              });
              setTimeout(cleanup, 400);
            });
          }
        }
      } else {
        render();
        const newNode = document.querySelector(`.tree-node[data-id="${CSS.escape(child.id)}"]`);
        if (newNode) {
          newNode.style.overflow = 'hidden';
          newNode.style.maxHeight = '0px';
          newNode.style.opacity = '0';
          newNode.style.transition = 'none';
          void newNode.offsetHeight;
          requestAnimationFrame(() => {
            const h = newNode.scrollHeight;
            newNode.style.transition = `max-height ${TREE_DUR_OPEN} ${TREE_OPEN_EASE}, opacity 0.2s ease`;
            newNode.style.maxHeight = `${h}px`;
            newNode.style.opacity = '1';
            const cleanup = () => { newNode.style.transition = ''; newNode.style.maxHeight = ''; newNode.style.opacity = ''; newNode.style.overflow = ''; };
            newNode.addEventListener('transitionend', function onEnd(ev) { if (ev.propertyName === 'max-height') { newNode.removeEventListener('transitionend', onEnd); cleanup(); } });
            setTimeout(cleanup, 400);
          });
        }
      }
      editor.open(child.id);
    });
    actions.appendChild(addBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'tree-act-btn tree-act-del';
    delBtn.title = '删除笔记 (Delete)\n右键：切换删除确认';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7"/><path d="M6 7l1 12.5a2 2 0 0 0 2 1.5h6a2 2 0 0 0 2-1.5L18 7"/></svg>';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      requestDelete(note.id, e.currentTarget);
    });
    delBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = storage.getSetting('skipDeleteConfirm') || false;
      storage.setSetting('skipDeleteConfirm', !cur);
      toast(cur ? '已开启删除确认' : '已关闭删除确认', 'info');
    });
    actions.appendChild(delBtn);

    row.appendChild(chevron);
    row.appendChild(iconBtn);
    row.appendChild(title);
    row.appendChild(actions);

    row.addEventListener('click', (e) => handleRowClick(e, note.id));
    row.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(note.id); });
    // 触屏长按期间（_td 存在）系统会补发 contextmenu：吞掉，菜单由 touchend 统一弹，避免双开
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); if (_td) return; showContextMenu(e, note.id); });

    // 拖拽
    attachDragHandlers(row, note.id);

    wrap.appendChild(row);

    if (hasChildren && note.expanded) {
      const childWrap = document.createElement('div');
      childWrap.className = 'tree-children';
      const inner = document.createElement('div');
      inner.className = 'tree-children-inner';
      for (const c of children) inner.appendChild(renderNode(c, depth + 1));
      childWrap.appendChild(inner);
      wrap.appendChild(childWrap);
    }

    return wrap;
  }

  function highlightHtml(text, query) {
    if (!query) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx))
      + '<span class="search-highlight">' + escapeHtml(text.slice(idx, idx + query.length)) + '</span>'
      + escapeHtml(text.slice(idx + query.length));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function beginRename(id) {
    const row = document.querySelector(`.tree-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const titleEl = row.querySelector('.tree-title');
    if (!titleEl) return;
    const current = storage.get(id)?.title || '';
    const input = document.createElement('input');
    input.className = 'tree-title-input';
    input.value = current;
    titleEl.replaceWith(input);
    input.select();
    input.focus();

    const commit = () => {
      const v = input.value.trim() || '无标题';
      // 先把编辑器里未落盘的正文 flush 到 storage，否则 reloadCurrent 会用旧内容覆盖
      if (editor.currentId() === id) editor.flushSave?.();
      storage.rename(id, v);
      render();
      if (editor.currentId() === id) editor.reloadCurrent();
    };
    input.addEventListener('input', () => {
      if (editor.currentId() === id) {
        const titleInput = document.getElementById('title-input');
        if (titleInput) titleInput.value = input.value;
      }
    });
    const cancel = () => render();

    const onBlur = () => {
      // 表情面板打开期间忽略 blur，否则 commit→render 会销毁 input、表情塞不进去
      const pop = document.getElementById('emoji-popover');
      if (pop && !pop.classList.contains('hidden')) {
        setTimeout(() => { if (document.body.contains(input)) input.focus(); }, 0);
        return;
      }
      commit();
    };
    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', onBlur); cancel(); }
    });
    // 在 input 内的点击/mousedown/dblclick 都不要冒泡到 tree-row（避免触发 row click → render → 摧毁 input）
    ['click', 'mousedown', 'dblclick', 'pointerdown'].forEach(ev => {
      input.addEventListener(ev, (e) => e.stopPropagation());
    });
  }

  // 拖拽落点是否非法：目标是任一源、或任一源的后代
  function _dropForbidden(targetId) {
    const srcs = _dragSrcIds && _dragSrcIds.length ? _dragSrcIds : (_dragSrcId ? [_dragSrcId] : []);
    return srcs.some(s => s === targetId || isDescendant(targetId, s));
  }

  // 把整组源移动到 (newParent, newIndex 起点)，按可见顺序保持相对次序
  function _applyDropMove(srcs, newParent, baseIndex) {
    const list = _normalizeSel(srcs);
    if (!list.length) return false;
    let ok = false;
    window._bulkImporting = true;
    let idx = baseIndex;
    for (const s of list) {
      if (storage.move(s, newParent, idx == null ? null : idx)) { ok = true; if (idx != null) idx++; }
    }
    window._bulkImporting = false;
    return ok;
  }

  // 底部根放置区：拖到这块空白=把拖动项移到根层级末尾（即使最后一行是深层子笔记也能变根笔记）。
  function _makeRootDropZone() {
    const zone = document.createElement('div');
    zone.className = 'tree-root-dropzone';
    zone.addEventListener('dragover', (e) => {
      if (!(_dragSrcId || _dragSrcIds)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('drag-over');
      _updateAutoScroll(e.clientY);
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('drag-over');
      _stopAutoScroll();
      const srcId = e.dataTransfer.getData('text/plain');
      const srcs = (_dragSrcIds && _dragSrcIds.length) ? _dragSrcIds : (srcId ? [srcId] : []);
      if (!srcs.length) return;
      const srcSet = new Set(srcs);
      const rootKids = storage.getChildren(null).filter(n => !srcSet.has(n.id));
      const ok = _applyDropMove(srcs, null, rootKids.length);
      if (ok) render();
    });
    return zone;
  }

  // ── 触屏长按拖拽实现 ──────────────────────────────────────────────────────
  function _tdRowAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const zone = el.closest('.tree-root-dropzone');
    if (zone) return { zone };
    const r = el.closest('.tree-row');
    const node = r && r.closest('.tree-node');
    return (r && node) ? { row: r, id: node.dataset.id } : null;
  }

  function _tdClearMarks() {
    document.querySelectorAll('.tree-row.drag-over, .tree-row.drag-above, .tree-row.drag-below')
      .forEach(el => el.classList.remove('drag-over', 'drag-above', 'drag-below'));
    document.querySelectorAll('.tree-root-dropzone.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function _tdCleanup() {
    document.querySelectorAll('.tree-row.dragging').forEach(r => r.classList.remove('dragging'));
    _tdClearMarks();
    _dragSrcId = null;
    _dragSrcIds = null;
  }

  function _tdCancel() {
    if (_tdTimer) { clearTimeout(_tdTimer); _tdTimer = null; }
    if (_td && _td.armed) { _stopAutoScroll(); _clearHoverExpand(); _tdCleanup(); }
    _td = null;
  }

  function _tdHover(x, y) {
    _tdClearMarks();
    const hit = _tdRowAt(x, y);
    if (!hit) return;
    if (hit.zone) { hit.zone.classList.add('drag-over'); return; }
    if (_dropForbidden(hit.id)) return;
    const rect = hit.row.getBoundingClientRect();
    const ry = y - rect.top;
    // 注意：触屏拖拽中不做"悬停自动展开"——展开会触发整树重渲染，
    // 把正在接收 touch 事件的源行从 DOM 上拆掉，行为在部分内核上不可靠。
    if (ry < rect.height * 0.25) hit.row.classList.add('drag-above');
    else if (ry > rect.height * 0.75) hit.row.classList.add('drag-below');
    else hit.row.classList.add('drag-over');
  }

  function _tdDrop(x, y) {
    const hit = _tdRowAt(x, y);
    const srcs = (_dragSrcIds && _dragSrcIds.length) ? _dragSrcIds : (_dragSrcId ? [_dragSrcId] : []);
    if (!hit || !srcs.length) return;
    const srcSet = new Set(srcs);
    if (hit.zone) {
      const rootKids = storage.getChildren(null).filter(n => !srcSet.has(n.id));
      if (_applyDropMove(srcs, null, rootKids.length)) render();
      return;
    }
    if (_dropForbidden(hit.id)) return;
    const target = storage.get(hit.id);
    if (!target) return;
    const rect = hit.row.getBoundingClientRect();
    const ry = y - rect.top;
    let newParent, newIndex;
    if (ry < rect.height * 0.25) {
      newParent = target.parentId;
      const sib = storage.getChildren(target.parentId).filter(n => !srcSet.has(n.id));
      newIndex = sib.findIndex(n => n.id === hit.id);
    } else if (ry > rect.height * 0.75) {
      newParent = target.parentId;
      const sib = storage.getChildren(target.parentId).filter(n => !srcSet.has(n.id));
      newIndex = sib.findIndex(n => n.id === hit.id) + 1;
    } else {
      newParent = hit.id;
      newIndex = storage.getChildren(hit.id).filter(n => !srcSet.has(n.id)).length;
    }
    if (_applyDropMove(srcs, newParent, newIndex)) render();
  }

  function _attachTouchDrag(row, id) {
    const LP_MS = 380, MOVE_TOL = 10;
    row.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { _tdCancel(); return; }
      const t = e.touches[0];
      _td = { id, row, x: t.clientX, y: t.clientY, armed: false, moved: false };
      if (_tdTimer) clearTimeout(_tdTimer);
      _tdTimer = setTimeout(() => {
        _tdTimer = null;
        if (!_td || _td.moved) return;
        _td.armed = true;
        _dragSrcId = id;
        _dragSrcIds = (_sel.has(id) && _sel.size > 1) ? [..._sel] : null;
        row.classList.add('dragging');
        (_dragSrcIds || []).forEach(sid => {
          const r = document.querySelector(`.tree-node[data-id="${CSS.escape(sid)}"] > .tree-row`);
          if (r) r.classList.add('dragging');
        });
        try { navigator.vibrate && navigator.vibrate(15); } catch (_) {}
      }, LP_MS);
    }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      if (!_td) return;
      const t = e.touches[0];
      if (!_td.armed) {
        // 长按未成立前明显移动 = 用户在滚列表，放弃本次判定
        if (Math.hypot(t.clientX - _td.x, t.clientY - _td.y) > MOVE_TOL) _tdCancel();
        return;
      }
      e.preventDefault(); // 拖拽中接管，不让页面跟着滚
      _td.moved = true;
      _updateAutoScroll(t.clientY);
      _tdHover(t.clientX, t.clientY);
    }, { passive: false });

    row.addEventListener('touchend', (e) => {
      if (_tdTimer) { clearTimeout(_tdTimer); _tdTimer = null; }
      const st = _td;
      _td = null;
      if (!st || !st.armed) return; // 普通点按：让 click 正常发生
      e.preventDefault();           // 阻止长按后的合成 click 误开笔记
      _stopAutoScroll();
      _clearHoverExpand();
      const t = e.changedTouches[0];
      if (st.moved) {
        _tdDrop(t.clientX, t.clientY);
        _tdCleanup();
      } else {
        _tdCleanup();
        // 长按不动松手 = 右键菜单
        showContextMenu({ clientX: t.clientX, clientY: t.clientY, preventDefault() {} }, id);
      }
    }, { passive: false });

    row.addEventListener('touchcancel', () => { _tdCancel(); }, { passive: true });
  }

  function attachDragHandlers(row, id) {
    if (IS_COARSE) _attachTouchDrag(row, id);
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      _dragSrcId = id;
      // 拖动的是已选中的行且为多选 → 整组拖拽
      _dragSrcIds = (_sel.has(id) && _sel.size > 1) ? [..._sel] : null;
      if (_dragSrcIds) _dragSrcIds.forEach(sid => {
        const r = document.querySelector(`.tree-node[data-id="${CSS.escape(sid)}"] > .tree-row`);
        if (r) r.classList.add('dragging');
      });
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      _stopAutoScroll();
      _clearHoverExpand();
      document.querySelectorAll('.tree-row.dragging').forEach(r => r.classList.remove('dragging'));
      _dragSrcId = null;
      _dragSrcIds = null;
      document.querySelectorAll('.tree-row.drag-over, .tree-row.drag-above, .tree-row.drag-below')
        .forEach(el => el.classList.remove('drag-over', 'drag-above', 'drag-below'));
      document.querySelectorAll('.tree-root-dropzone.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 不允许拖到任一源或其子树
      if (_dropForbidden(id)) {
        e.dataTransfer.dropEffect = 'none';
        row.classList.remove('drag-over', 'drag-above', 'drag-below');
        return;
      }
      e.dataTransfer.dropEffect = 'move';
      row.classList.remove('drag-over', 'drag-above', 'drag-below');
      const rect = row.getBoundingClientRect();
      const y = e.clientY - rect.top;
      if (y < rect.height * 0.25) { row.classList.add('drag-above'); _clearHoverExpand(); }
      else if (y > rect.height * 0.75) { row.classList.add('drag-below'); _clearHoverExpand(); }
      else { row.classList.add('drag-over'); _maybeHoverExpand(row, id); }
    });
    row.addEventListener('dragleave', () => {
      // 只移除落点指示类。注意：不要在这里清 hover-expand 计时器——
      // dragleave 在行内子元素（图标/文字/箭头）间移动时也会触发，
      // 若每次都清会让 800ms 计时不断重置，导致"只有动画、永不展开"。
      // 真正离开本行时，目标行/区域的 dragover 或 dragend/drop 会负责清理重排。
      row.classList.remove('drag-over', 'drag-above', 'drag-below');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _clearHoverExpand();
      row.classList.remove('drag-over', 'drag-above', 'drag-below');
      const srcId = e.dataTransfer.getData('text/plain');
      const srcs = (_dragSrcIds && _dragSrcIds.length) ? _dragSrcIds : (srcId ? [srcId] : []);
      if (!srcs.length) return;
      if (_dropForbidden(id)) return;

      const rect = row.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const target = storage.get(id);
      if (!target) return;

      const srcSet = new Set(srcs);
      let newParent, newIndex;
      if (y < rect.height * 0.25) {
        newParent = target.parentId;
        const siblings = storage.getChildren(target.parentId).filter(n => !srcSet.has(n.id));
        newIndex = siblings.findIndex(n => n.id === id);
      } else if (y > rect.height * 0.75) {
        newParent = target.parentId;
        const siblings = storage.getChildren(target.parentId).filter(n => !srcSet.has(n.id));
        newIndex = siblings.findIndex(n => n.id === id) + 1;
      } else {
        newParent = id;
        const siblings = storage.getChildren(id).filter(n => !srcSet.has(n.id));
        newIndex = siblings.length;
      }
      const ok = _applyDropMove(srcs, newParent, newIndex);
      if (ok) render();
      else toast('不能把笔记移动到自己或子节点内', 'error');
    });
  }

  // ========== 右键菜单 ==========
  // 把 items 渲染进菜单容器（支持 divider / submenu / onClick），showContextMenu 与批量菜单共用
  function _populateMenu(menu, items) {
    for (const it of items) {
      if (it.type === 'divider') {
        const d = document.createElement('div');
        d.className = 'context-menu-divider';
        menu.appendChild(d);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'context-menu-item' + (it.danger ? ' danger' : '') + (it.submenu ? ' has-submenu' : '');
      el.innerHTML = `<span class="ctx-icon-emoji">${it.icon}</span><span>${it.label}</span>`;
      if (it.submenu) {
        el.addEventListener('mouseenter', () => showSubmenu(el, it.submenu));
      } else {
        el.addEventListener('mouseenter', () => {
          clearTimeout(_submenuCloseTimer);
          const existing = document.querySelector('.context-menu.submenu');
          if (existing) { _submenuCloseTimer = setTimeout(() => existing.remove(), 300); }
        });
        if (it.onClick) {
          el.addEventListener('click', () => { hideContextMenu(); it.onClick(); });
        }
      }
      menu.appendChild(el);
    }
  }

  // 「其他」子菜单：把不常用项收纳进来，主菜单更清爽
  function _buildMoreSubmenu(id, note) {
    const more = [
      { label: '导出为 .md', icon: '💾', onClick: () => exportSingleNote(id) },
      { label: '打开文件', icon: '📂', onClick: () => openFileAsNote(id) },
      { label: '复制副本', icon: '📋', onClick: () => duplicateNote(id) },
      { label: '复制为 Markdown', icon: '📄', onClick: () => copyNoteAsMarkdown(id) },
    ];
    return {
      render() {
        const el = document.createElement('div');
        el.className = 'context-menu';
        for (const it of more) {
          const item = document.createElement('div');
          item.className = 'context-menu-item';
          item.innerHTML = `<span class="ctx-icon-emoji">${it.icon}</span><span>${it.label}</span>`;
          item.addEventListener('click', () => { hideContextMenu(); it.onClick(); });
          el.appendChild(item);
        }
        return el;
      }
    };
  }

  function showContextMenu(e, id) {
    // 多选状态下右键已选中的行 → 弹批量菜单
    if (_sel.has(id) && _sel.size > 1) { showSelectionContextMenu(e); return; }
    hideContextMenu();
    const note = storage.get(id);
    if (!note) return;
    const menu = document.getElementById('context-menu');

    menu.innerHTML = '';
    const isPinned = (storage.getSetting('pinned') || []).includes(id);
    const items = [
      { label: '新建子笔记', icon: '➕', onClick: () => {
        const child = storage.create({ parentId: id, title: '' });
        const noteData = storage.get(id);
        if (noteData && !noteData.expanded) {
          storage.setExpanded(id, true);
        }
        render();
        editor.open(child.id);
      }},
      { label: '重命名', icon: '✏️', onClick: () => beginRename(id) },
      { label: '更换图标', icon: '🖼️', onClick: () => {
        const iconEl = document.querySelector(`.tree-node[data-id="${CSS.escape(id)}"] .tree-note-icon`) || document.body;
        window.openIconPicker(iconEl, {
          currentIcon: note.icon || '', defaultIcon: '', title: '更换笔记图标',
          onPick: (icon) => { storage.setIcon(id, icon); render(); }
        });
      }},
      { label: isPinned ? '取消置顶' : '置顶', icon: '📌', onClick: () => window.palette?.togglePin(id) },
      { type: 'divider' },
      { label: '颜色标记', icon: '🎨', submenu: buildColorSubmenu(id) },
      ...(storage.getWorkspaces().length > 1 ? [{ label: '移动到笔记本', icon: '📦', submenu: buildWorkspaceSubmenu(id) }] : []),
      { label: '其他', icon: '⋯', submenu: _buildMoreSubmenu(id, note) },
      { type: 'divider' },
      { label: '删除', icon: '🗑️', danger: true, onClick: () => {
        const anchor = document.querySelector(`.tree-row[data-id="${id}"]`) || document.body;
        requestDelete(id, anchor);
      }},
    ];

    _populateMenu(menu, items);
    menu.classList.remove('hidden');
    positionMenu(menu, e.clientX, e.clientY);
  }

  // 多选批量右键菜单（#6）
  function showSelectionContextMenu(e) {
    hideContextMenu();
    const ids = [..._sel];
    if (!ids.length) return;
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    const items = [
      { label: '颜色标记', icon: '🎨', submenu: _buildBatchColorSubmenu(ids) },
      ...(storage.getWorkspaces().length > 1 ? [{ label: '移动到笔记本', icon: '📦', submenu: _buildBatchWorkspaceSubmenu(ids) }] : []),
      { label: '导出为 .md', icon: '💾', onClick: () => _batchExport() },
      { type: 'divider' },
      { label: `删除 ${ids.length} 项`, icon: '🗑️', danger: true, onClick: () => {
        const anchor = document.querySelector(`.tree-row[data-id="${CSS.escape(ids[0])}"]`) || document.body;
        _batchDelete(anchor);
      }},
    ];
    _populateMenu(menu, items);
    menu.classList.remove('hidden');
    positionMenu(menu, e.clientX, e.clientY);
  }

  // 批量颜色 / 笔记本 子菜单（供批量右键菜单复用）
  function _buildBatchColorSubmenu(ids) {
    return {
      render() {
        const el = document.createElement('div');
        el.className = 'context-menu';
        const row = document.createElement('div');
        row.className = 'color-picker-row';
        for (const c of COLOR_PRESETS) {
          const dot = document.createElement('div');
          dot.className = 'color-dot-choice' + (c.value ? '' : ' none');
          if (c.value) dot.style.background = c.value;
          dot.title = c.name;
          dot.addEventListener('click', () => {
            window._bulkImporting = true;
            for (const id of ids) storage.setColor(id, c.value);
            window._bulkImporting = false;
            hideContextMenu();
            render();
          });
          row.appendChild(dot);
        }
        el.appendChild(row);
        return el;
      }
    };
  }

  function _buildBatchWorkspaceSubmenu(ids) {
    const wss = storage.getWorkspaces();
    return {
      render() {
        const el = document.createElement('div');
        el.className = 'context-menu';
        for (const ws of wss) {
          const item = document.createElement('div');
          item.className = 'context-menu-item';
          const ic = document.createElement('span'); ic.className = 'ctx-icon-emoji'; ic.textContent = ws.icon || '📒';
          const nm = document.createElement('span'); nm.textContent = ws.name;
          item.appendChild(ic); item.appendChild(nm);
          item.addEventListener('click', () => {
            const norm = _normalizeSel(ids);
            window._bulkImporting = true;
            let moved = 0;
            for (const id of norm) { if (storage.moveToWorkspace(id, ws.id)) moved++; }
            window._bulkImporting = false;
            hideContextMenu();
            clearSelection({ silent: true });
            render();
            toast(`已移动 ${moved} 项到「${ws.name}」`, 'success');
          });
          el.appendChild(item);
        }
        return el;
      }
    };
  }

  function positionMenu(menu, x, y) {
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
    menu.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const margin = 8;
      const vw = window.innerWidth, vh = window.innerHeight;
      // 用 offset 尺寸（布局尺寸，不受 mdPopIn 的 scale 动画影响）。
      // getBoundingClientRect 在动画期间会偏小 → 钳制失效 → 边缘处被裁。
      const menuW = menu.offsetWidth;
      // 菜单比视口还高 → 限高 + 滚动，避免上/下被裁
      const maxH = vh - margin * 2;
      let menuH = menu.offsetHeight;
      if (menuH > maxH) {
        menu.style.maxHeight = maxH + 'px';
        menu.style.overflowY = 'auto';
        menuH = menu.offsetHeight;
      }
      const h = Math.min(menuH, maxH);
      let finalX = Math.min(x, vw - menuW - margin);
      let finalY = Math.min(y, vh - h - margin);
      finalX = Math.max(margin, finalX);
      finalY = Math.max(margin, finalY);
      menu.style.left = finalX + 'px';
      menu.style.top = finalY + 'px';
      menu.style.visibility = 'visible';
    });
  }

  function buildColorSubmenu(id) {
    const note = storage.get(id);
    return {
      render() {
        const el = document.createElement('div');
        el.className = 'context-menu';
        const row = document.createElement('div');
        row.className = 'color-picker-row';
        for (const c of COLOR_PRESETS) {
          const dot = document.createElement('div');
          dot.className = 'color-dot-choice' + (c.value ? '' : ' none') + ((note.color || null) === c.value ? ' selected' : '');
          if (c.value) dot.style.background = c.value;
          dot.title = c.name;
          dot.addEventListener('click', () => {
            storage.setColor(id, c.value);
            hideContextMenu();
            render();
          });
          row.appendChild(dot);
        }
        el.appendChild(row);
        return el;
      }
    };
  }

  function buildWorkspaceSubmenu(id) {
    const note = storage.get(id);
    const workspaces = storage.getWorkspaces();
    return {
      render() {
        const el = document.createElement('div');
        el.className = 'context-menu';
        for (const ws of workspaces) {
          const isCurrent = note.workspaceId === ws.id;
          const item = document.createElement('div');
          item.className = 'context-menu-item' + (isCurrent ? ' disabled' : '');
          item.innerHTML = `<span class="ctx-icon-emoji">${ws.icon || '📒'}</span><span>${ws.name}${isCurrent ? ' ✓' : ''}</span>`;
          if (!isCurrent) {
            item.addEventListener('click', () => {
              storage.moveToWorkspace(id, ws.id);
              hideContextMenu();
              render();
              toast('已移动到「' + ws.name + '」', 'success');
            });
          }
          el.appendChild(item);
        }
        return el;
      }
    };
  }

  let _submenuCloseTimer = null;
  function showSubmenu(parentItem, submenuConfig) {
    clearTimeout(_submenuCloseTimer);
    const existing = document.querySelector('.context-menu.submenu');
    if (existing) existing.remove();
    const sub = submenuConfig.render();
    sub.classList.add('submenu');
    sub.style.position = 'fixed';
    sub.style.visibility = 'hidden';
    document.body.appendChild(sub);

    const margin = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const prect = parentItem.getBoundingClientRect();
    // 子菜单尺寸用 offsetWidth/offsetHeight（布局尺寸，不受 transform 影响）来量。
    // ⚠️ 不能用 getBoundingClientRect()：.context-menu 有 mdPopIn 动画，首帧 scale(0.95)，
    //    rect 会偏小 ~5% → 钳制按偏小高度算 → 动画结束后实际更高 → 底部被窗口裁切（子菜单"被遮住"）。
    const maxH = vh - margin * 2;
    let subHRaw = sub.offsetHeight;
    if (subHRaw > maxH) {
      sub.style.maxHeight = maxH + 'px';
      sub.style.overflowY = 'auto';
      subHRaw = sub.offsetHeight;
    }
    const subW = sub.offsetWidth, subH = Math.min(subHRaw, maxH);
    // 水平：默认右侧展开，右边放不下则翻到左侧
    let left = prect.right;
    if (left + subW + margin > vw) {
      left = prect.left - subW;
      if (left < margin) left = Math.max(margin, vw - subW - margin);
    }
    // 垂直：默认与父项顶部对齐，超出底部则上移，再夹在顶部内
    let top = prect.top;
    if (top + subH + margin > vh) top = vh - subH - margin;
    if (top < margin) top = margin;
    sub.style.left = left + 'px';
    sub.style.top = top + 'px';
    sub.style.visibility = 'visible';

    parentItem.addEventListener('mouseleave', (e) => {
      if (sub.contains(e.relatedTarget)) return;
      _submenuCloseTimer = setTimeout(() => { sub.remove(); }, 400);
    });
    sub.addEventListener('mouseenter', () => clearTimeout(_submenuCloseTimer));
    sub.addEventListener('mouseleave', (e) => {
      if (parentItem.contains(e.relatedTarget)) return;
      _submenuCloseTimer = setTimeout(() => { sub.remove(); }, 400);
    });
  }

  function hideContextMenu() {
    const m = document.getElementById('context-menu');
    if (m) m.classList.add('hidden');
    document.querySelectorAll('.context-menu.submenu').forEach(e => e.remove());
  }

  function showColorPicker(e, id) {
    e.preventDefault();
    hideContextMenu();
    const note = storage.get(id);
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'color-picker-row';
    for (const c of COLOR_PRESETS) {
      const dot = document.createElement('div');
      dot.className = 'color-dot-choice' + (c.value ? '' : ' none') + ((note.color || null) === c.value ? ' selected' : '');
      if (c.value) dot.style.background = c.value;
      dot.title = c.name;
      dot.addEventListener('click', () => {
        storage.setColor(id, c.value);
        hideContextMenu();
        render();
      });
      row.appendChild(dot);
    }
    menu.appendChild(row);
    menu.classList.remove('hidden');
    positionMenu(menu, e.clientX, e.clientY);
  }

  function showIconPicker(e, id) {
    hideContextMenu();
    const note = storage.get(id);
    const currentIcon = note?.icon || '';
    const anchor = e.target.closest('.tree-note-icon') || e.target;
    window.openIconPicker(anchor, {
      currentIcon: currentIcon,
      defaultIcon: '',
      title: '更换笔记图标',
      onPick: (icon) => {
        storage.setIcon(id, icon);
        render();
      }
    });
  }

  function duplicateNote(id) {
    const note = storage.get(id);
    if (!note) return;
    const copy = storage.create({
      parentId: note.parentId,
      title: note.title + '（副本）',
      content: note.content,
      // doc 深拷贝，避免副本与原笔记共享同一文档对象（改一个会污染另一个）
      doc: note.doc ? JSON.parse(JSON.stringify(note.doc)) : null,
      insertAfterId: id,
    });
    if (note.color) storage.setColor(copy.id, note.color);
    render();
    const newNode = document.querySelector(`.tree-node[data-id="${CSS.escape(copy.id)}"]`);
    if (newNode) {
      newNode.style.overflow = 'hidden';
      newNode.style.maxHeight = '0px';
      newNode.style.opacity = '0';
      newNode.style.transition = 'none';
      void newNode.offsetHeight;
      requestAnimationFrame(() => {
        const rh = newNode.scrollHeight;
        newNode.style.transition = `max-height ${TREE_DUR_OPEN} ${TREE_OPEN_EASE}, opacity 0.2s ease`;
        newNode.style.maxHeight = `${rh}px`;
        newNode.style.opacity = '1';
        const cleanup = () => { newNode.style.transition = ''; newNode.style.maxHeight = ''; newNode.style.opacity = ''; newNode.style.overflow = ''; };
        newNode.addEventListener('transitionend', function onEnd(ev) { if (ev.propertyName === 'max-height') { newNode.removeEventListener('transitionend', onEnd); cleanup(); } });
        setTimeout(cleanup, 400);
      });
    }
    editor.open(copy.id);
  }

  function copyNoteAsMarkdown(id) {
    const note = storage.get(id);
    if (!note) return;
    let content = '';
    if (note.doc) content = window.editor?.serializeDocToMd(note.doc) || '';
    if (!content) content = note.content || '';
    if (storage.expandLocalImages) content = storage.expandLocalImages(content);
    const md = `# ${note.title}\n\n${content}`;
    navigator.clipboard?.writeText(md).then(() => toast('已复制到剪贴板', 'success'),
      () => toast('复制失败，可能浏览器不支持', 'error'));
  }

  async function exportSingleNote(id) {
    const data = storage.exportCurrentNoteMd(id);
    if (!data) { toast('笔记不存在', 'error'); return; }
    const safeTitle = (data.title || '无标题').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '无标题';
    const fileName = `${safeTitle}.md`;
    const content = data.content;
    try {
      if (storage.isQuicker()) {
        // 与 app.js requestExport 对齐：先弹保存框取路径，再写盘（旧 saveDialog 已停用）
        const pathRes = await window.host.file.op({ mode: 'savePath', fileName, filter: 'Markdown 文件|*.md' });
        const path = pathRes?.result || '';
        if (!path) return;
        await window.host.file.op({ mode: 'writeFile', path, content, isBinary: 'false' });
        toast(`已导出：${path}`, 'success');
      } else {
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast(`已导出：${fileName}`, 'success');
      }
    } catch (err) {
      toast('导出失败：' + (err?.message || err), 'error');
    }
  }

  async function openFileAsNote(parentId) {
    try {
      if (storage.isQuicker()) {
        const spResult = await window.host.file.op({
          mode: 'openDialog', filter: '支持的文件|*.md;*.txt;*.docx', isBinary: 'true', multiSelect: 'false'
        });
        const raw = spResult?.result || '';
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const fileData = Array.isArray(parsed) ? parsed[0] : parsed;
        const name = fileData.name || '';
        const ext = name.split('.').pop().toLowerCase();
        let content = '';
        let title = name.replace(/\.[^.]+$/, '') || '导入笔记';

        if (ext === 'docx' && typeof mammoth !== 'undefined') {
          const bytes = Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0));
          const result = await mammoth.convertToMarkdown({ arrayBuffer: bytes.buffer });
          content = result.value || '';
        } else {
          content = ext === 'docx'
            ? atob(fileData.content)
            : new TextDecoder().decode(Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0)));
        }

        const pid = parentId || null;
        let insertAfterId = null;
        if (!pid) {
          const rootOrder = storage.getAll().rootOrder || [];
          if (rootOrder.length) insertAfterId = rootOrder[rootOrder.length - 1];
        }
        const note = storage.create({ parentId: pid, title, content, insertAfterId });
        render();
        editor.open(note.id);
        toast(`已打开：${name}`, 'success');
      } else {
        toast('此功能需要 Quicker 环境', 'warning');
      }
    } catch (err) {
      toast('打开文件失败：' + (err?.message || err), 'error');
    }
  }

  function setSearchHighlight(q, opts = {}) {
    _searchHighlight = q || '';
    if (!opts.skipRender) render();
  }

  // ========== 回收站 ==========
  function showTrash() {
    const data = storage.getAll();
    const rootTrash = Object.values(data.trash).filter(t => !data.trash[t.parentId]);
    const body = document.createElement('div');

    // 回收站红点徽标的快捷开关，放在对话框最上方，让用户一眼能找到
    const showBadgeNow = storage.getSetting('showTrashBadge') !== false;
    const switchRow = document.createElement('label');
    switchRow.className = 'settings-switch trash-badge-switch';
    switchRow.innerHTML = `
      <input type="checkbox" id="trash-badge-switch" ${showBadgeNow ? 'checked' : ''}>
      <span class="settings-switch-slider"></span>
      <span class="settings-switch-text">显示回收站红点徽标</span>
    `;
    body.appendChild(switchRow);
    switchRow.querySelector('input').addEventListener('change', (e) => {
      storage.setSetting('showTrashBadge', e.target.checked);
      if (window.updateTrashBadge) window.updateTrashBadge();
    });

    // 彻底删除开关：开启后，之后删除的内容直接永久删除、不进回收站
    const skipNow = storage.getSetting('skipTrash') === true;
    const skipRow = document.createElement('label');
    skipRow.className = 'settings-switch trash-badge-switch';
    skipRow.innerHTML = `
      <input type="checkbox" id="trash-skip-switch" ${skipNow ? 'checked' : ''}>
      <span class="settings-switch-slider"></span>
      <span class="settings-switch-text">彻底删除（删除内容不进回收站）</span>
    `;
    body.appendChild(skipRow);
    skipRow.querySelector('input').addEventListener('change', (e) => {
      storage.setSetting('skipTrash', e.target.checked);
      if (e.target.checked) toast('已开启彻底删除：之后删除将不进回收站', 'warning');
    });

    if (!rootTrash.length) {
      const empty = document.createElement('p');
      empty.style.cssText = 'color:var(--text-tertiary);text-align:center;padding:20px 0;';
      empty.textContent = '回收站是空的';
      body.appendChild(empty);
    } else {
      for (const t of rootTrash) {
        const item = document.createElement('div');
        item.className = 'trash-list-item';
        const title = document.createElement('div');
        title.className = 'trash-list-item-title';
        title.textContent = t.title || '无标题';
        const time = document.createElement('div');
        time.className = 'trash-list-item-time';
        const dt = new Date(t.deletedAt);
        time.textContent = `${dt.getMonth()+1}月${dt.getDate()}日`;
        const actions = document.createElement('div');
        actions.className = 'trash-list-item-actions';
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'secondary-btn';
        restoreBtn.style.padding = '4px 10px';
        restoreBtn.textContent = '恢复';
        restoreBtn.addEventListener('click', () => {
          storage.restoreFromTrash(t.id);
          closeModal();
          render();
          showTrash();
        });
        const purgeBtn = document.createElement('button');
        purgeBtn.className = 'danger-btn';
        purgeBtn.style.padding = '4px 10px';
        purgeBtn.textContent = '彻底删除';
        purgeBtn.addEventListener('click', (e) => {
          confirmPopover({
            anchor: e.currentTarget,
            message: `永久删除「${t.title}」？不可恢复`,
            okText: '彻底删除',
            okDanger: true,
            onOk: () => { storage.purgeFromTrash(t.id); closeModal(); showTrash(); },
          });
        });
        actions.appendChild(restoreBtn);
        actions.appendChild(purgeBtn);
        item.appendChild(title);
        item.appendChild(time);
        item.appendChild(actions);
        body.appendChild(item);
      }
    }


    openModal({
      title: '回收站',
      body,
      footer: [
        { label: '清空回收站', class: 'danger-btn', onClick(ev) {
          if (!rootTrash.length) return;
          confirmPopover({
            anchor: ev?.target,
            message: '清空回收站？所有删除的笔记将被永久删除',
            okText: '清空',
            okDanger: true,
            onOk: () => { storage.emptyTrash(); closeModal(); },
          });
        }},
        { label: '关闭', class: 'secondary-btn', onClick: closeModal },
      ]
    });
  }

  /** 锚定确认弹窗：在指定元素旁就地展示，避免鼠标长距离移动 */
  function requestDelete(id, anchorEl) {
    const note = storage.get(id);
    if (!note) return;

    const doDelete = () => {
      storage.remove(id);
      if (editor.currentId && editor.currentId() === id) editor.close();
      render();
      toast(`已删除「${note.title || '无标题'}」`, 'success');
    };

    if (storage.getSetting('skipDeleteConfirm')) {
      doDelete();
      return;
    }

    const childCount = countDescendants(id);
    const msg = childCount > 0
      ? `删除「${note.title || '无标题'}」及 ${childCount} 条子笔记？`
      : `删除「${note.title || '无标题'}」？`;

    confirmPopover({
      anchor: anchorEl,
      message: msg,
      okText: '移入回收站',
      okDanger: true,
      showDontAsk: true,
      onOk: (dontAsk) => {
        if (dontAsk) storage.setSetting('skipDeleteConfirm', true);
        doDelete();
      },
    });
  }

  function countDescendants(id) {
    let n = 0;
    const stack = storage.getChildren(id).slice();
    while (stack.length) {
      const cur = stack.pop();
      n++;
      stack.push(...storage.getChildren(cur.id));
    }
    return n;
  }

  // 侧栏空白处右键菜单
  let _bgMenuBound = false;
  function _bindBgMenu() {
    if (_bgMenuBound) return;
    const container = document.getElementById('tree-container');
    if (!container) return;
    _bgMenuBound = true;
    container.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tree-row')) return;
      e.preventDefault();
      e.stopPropagation();
      showBackgroundMenu(e);
    });
    // 左键点空白处取消多选（不影响展开/折叠等行内交互）
    container.addEventListener('click', (e) => {
      if (e.target.closest('.tree-row')) return;
      if (_sel.size || _selectMode) clearSelection();
    });
  }

  function showBackgroundMenu(e) {
    hideContextMenu();
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    const hasSel = _sel.size > 0;
    const items = [
      { label: '新建笔记', icon: '📝', onClick: () => {
        const rootOrder = storage.getAll().rootOrder || [];
        const insertAfterId = rootOrder.length ? rootOrder[rootOrder.length - 1] : null;
        const note = storage.create({ parentId: null, title: '', insertAfterId });
        render();
        editor.open(note.id);
      }},
      { label: '打开文件', icon: '📂', onClick: () => openFileAsNote(null) },
      { type: 'divider' },
      ...(hasSel || _selectMode
        ? [{ label: '取消选择', icon: '↩️', onClick: () => clearSelection() }]
        : [{ label: '选择多项', icon: '☑️', onClick: () => enterSelectMode() }]),
      { label: '全选', icon: '✅', onClick: () => selectAllVisible() },
    ];
    _populateMenu(menu, items);
    menu.classList.remove('hidden');
    positionMenu(menu, e.clientX, e.clientY);
  }

  // ========== 多选浮动操作条 ==========
  let _selBar = null;
  function _ensureSelBar() {
    if (_selBar) return _selBar;
    const sidebar = document.getElementById('sidebar');
    const footer = sidebar?.querySelector('.sidebar-footer');
    if (!sidebar) return null;
    const bar = document.createElement('div');
    bar.id = 'tree-selbar';
    bar.className = 'tree-selbar';
    bar.innerHTML = `
      <div class="tree-selbar-info"><span class="tree-selbar-count">0</span> 项已选</div>
      <div class="tree-selbar-acts">
        <button type="button" data-act="ws" title="移动到笔记本">📦</button>
        <button type="button" data-act="color" title="颜色标记">🎨</button>
        <button type="button" data-act="export" title="导出为 .md（多篇打包 zip）">💾</button>
        <button type="button" data-act="del" class="danger" title="删除（移入回收站）">🗑️</button>
        <button type="button" data-act="cancel" class="tree-selbar-cancel" title="取消选择 (Esc)">✕</button>
      </div>`;
    if (footer) sidebar.insertBefore(bar, footer); else sidebar.appendChild(bar);
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      // 阻止冒泡到 document 的全局 click（否则会把刚弹出的颜色/笔记本菜单立刻关掉）
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'cancel') { clearSelection(); return; }
      if (act === 'del') { _batchDelete(btn); return; }
      if (act === 'color') { _batchColor(btn); return; }
      if (act === 'ws') { _batchMoveWs(btn); return; }
      if (act === 'export') { _batchExport(); return; }
    });
    _selBar = bar;
    return bar;
  }

  function _updateSelBar() {
    const bar = _ensureSelBar();
    if (!bar) return;
    const n = _sel.size;
    // 选择模式下即使 0 项也显示操作条，让用户知道已进入多选状态
    if (n > 0 || _selectMode) {
      bar.querySelector('.tree-selbar-count').textContent = String(n);
      const wsBtn = bar.querySelector('[data-act="ws"]');
      if (wsBtn) wsBtn.style.display = (storage.getWorkspaces().length > 1) ? '' : 'none';
      bar.classList.add('visible');
    } else {
      bar.classList.remove('visible');
    }
  }

  function _batchDelete(anchorEl) {
    const ids = [..._sel];
    if (!ids.length) return;
    const run = () => {
      const curId = editor.currentId?.();
      window._bulkImporting = true;
      for (const id of ids) storage.remove(id);
      window._bulkImporting = false;
      if (curId && !storage.get(curId)) editor.close();
      clearSelection({ silent: true });
      render();
      toast(`已删除 ${ids.length} 项`, 'success');
    };
    if (storage.getSetting('skipDeleteConfirm')) { run(); return; }
    confirmPopover({
      anchor: anchorEl,
      message: `删除选中的 ${ids.length} 项（含各自子笔记）？将移入回收站`,
      okText: '移入回收站',
      okDanger: true,
      showDontAsk: true,
      onOk: (dontAsk) => { if (dontAsk) storage.setSetting('skipDeleteConfirm', true); run(); },
    });
  }

  function _batchColor(anchorEl) {
    const ids = [..._sel];
    if (!ids.length) return;
    hideContextMenu();
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    const rowEl = document.createElement('div');
    rowEl.className = 'color-picker-row';
    for (const c of COLOR_PRESETS) {
      const dot = document.createElement('div');
      dot.className = 'color-dot-choice' + (c.value ? '' : ' none');
      if (c.value) dot.style.background = c.value;
      dot.title = c.name;
      dot.addEventListener('click', () => {
        window._bulkImporting = true;
        for (const id of ids) storage.setColor(id, c.value);
        window._bulkImporting = false;
        hideContextMenu();
        render();
      });
      rowEl.appendChild(dot);
    }
    menu.appendChild(rowEl);
    menu.classList.remove('hidden');
    const r = anchorEl.getBoundingClientRect();
    positionMenu(menu, r.left, r.top);
  }

  function _batchMoveWs(anchorEl) {
    const ids = _normalizeSel([..._sel]);
    if (!ids.length) return;
    const wss = storage.getWorkspaces();
    if (wss.length <= 1) { toast('只有一个笔记本', 'info'); return; }
    hideContextMenu();
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    for (const ws of wss) {
      const item = document.createElement('div');
      item.className = 'context-menu-item';
      const ic = document.createElement('span'); ic.className = 'ctx-icon-emoji'; ic.textContent = ws.icon || '📒';
      const nm = document.createElement('span'); nm.textContent = ws.name;
      item.appendChild(ic); item.appendChild(nm);
      item.addEventListener('click', () => {
        window._bulkImporting = true;
        let moved = 0;
        for (const id of ids) { if (storage.moveToWorkspace(id, ws.id)) moved++; }
        window._bulkImporting = false;
        hideContextMenu();
        clearSelection({ silent: true });
        render();
        toast(`已移动 ${moved} 项到「${ws.name}」`, 'success');
      });
      menu.appendChild(item);
    }
    menu.classList.remove('hidden');
    const r = anchorEl.getBoundingClientRect();
    positionMenu(menu, r.left, r.top);
  }

  async function _batchExport() {
    // 导出用原始选中集：每篇选中的都导出一个文件，不按父子关系剔除（导出数=选中数）
    const ids = [..._sel];
    if (!ids.length) return;
    // 单篇直接走原有单篇导出；多篇打包 zip
    if (ids.length === 1) { await exportSingleNote(ids[0]); return; }
    if (typeof JSZip === 'undefined') { toast('ZIP 库未加载，请检查网络', 'error'); return; }
    const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fileName = `notes_selected_${ts}.zip`;
    const filter = 'ZIP 压缩包|*.zip';
    try {
      const used = {};
      const makeZip = async () => {
        const zip = new JSZip();
        for (const id of ids) {
          const data = storage.exportCurrentNoteMd(id);
          if (!data) continue;
          const base = (data.title || '无标题').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '无标题';
          let fn = base + '.md', i = 2;
          while (used[fn]) fn = `${base}(${i++}).md`;
          used[fn] = true;
          zip.file(fn, data.content);
        }
        return zip;
      };
      if (storage.isQuicker()) {
        const pathRes = await window.host.file.op({ mode: 'savePath', fileName, filter });
        const path = pathRes?.result || '';
        if (!path) return;
        const content = await (await makeZip()).generateAsync({ type: 'base64' });
        await window.host.file.op({ mode: 'writeFile', path, content, isBinary: 'true' });
        toast(`已导出 ${ids.length} 项：${path}`, 'success');
      } else {
        const blob = await (await makeZip()).generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast(`已导出 ${ids.length} 项`, 'success');
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      toast('导出失败：' + (err?.message || err), 'error');
    }
  }

  // 进入选择模式并勾选某一项（从空白右键「选择多项」进入时不带初始项）
  function enterSelectMode(seedId) {
    _selectMode = true;
    if (seedId) { _sel.add(seedId); _selAnchor = seedId; }
    _applySelClasses();
    _updateSelBar();
  }

  function selectAllVisible() {
    _selectMode = true;
    for (const id of _visibleNodeIds()) _sel.add(id);
    _applySelClasses();
    _updateSelBar();
  }

  return { render, showTrash, setSearchHighlight, hideContextMenu, beginRename, expandAncestors, scrollToNote, requestDelete, setActive, updateNodeTitle, collapseAllAnimated, expandAllAnimated, showContextMenu, hasSelection, clearSelection, enterSelectMode, selectAllVisible };
})();

/**
 * 通用就地确认弹窗（替代 native confirm()）
 * - 锚定在 anchor 元素旁，最长不超过 vw/vh 边界
 * - Esc 取消，Enter 确认
 * 全局可用：confirmPopover({ anchor, message, okText?, cancelText?, okDanger?, onOk?, onCancel? })
 */
function confirmPopover(opts) {
  document.querySelectorAll('.confirm-popover, .confirm-popover-mask').forEach(el => el.remove());

  const mask = document.createElement('div');
  mask.className = 'confirm-popover-mask';

  const pop = document.createElement('div');
  pop.className = 'confirm-popover';
  const dontAskHtml = opts.showDontAsk
    ? `<label class="confirm-popover-dontask"><input type="checkbox" class="confirm-dontask-cb"> 不再提示</label>`
    : '';
  pop.innerHTML = `
    <div class="confirm-popover-msg">${escapeHtml(opts.message || '确认操作？')}</div>
    ${dontAskHtml}
    <div class="confirm-popover-actions">
      <button class="confirm-popover-cancel">${escapeHtml(opts.cancelText || '取消')}</button>
      <button class="confirm-popover-ok ${opts.okDanger ? 'danger' : ''}">${escapeHtml(opts.okText || '确定')}</button>
    </div>
  `;

  document.body.appendChild(mask);
  document.body.appendChild(pop);

  // 锚定定位
  const r = opts.anchor?.getBoundingClientRect?.();
  let left = window.innerWidth / 2 - 130;
  let top = window.innerHeight / 2 - 60;
  if (r) {
    left = r.right + 8;
    top = r.top;
    const popW = 260, popH = 92;
    if (left + popW > window.innerWidth - 8) left = r.left - popW - 8;
    if (left < 8) left = 8;
    if (top + popH > window.innerHeight - 8) top = window.innerHeight - popH - 8;
    if (top < 8) top = 8;
  }
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  const close = () => { mask.remove(); pop.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); ok(); }
  };
  const ok = () => {
    const dontAsk = pop.querySelector('.confirm-dontask-cb')?.checked || false;
    close();
    opts.onOk?.(dontAsk);
  };
  const cancel = () => { close(); opts.onCancel?.(); };

  pop.querySelector('.confirm-popover-ok').addEventListener('click', ok);
  pop.querySelector('.confirm-popover-cancel').addEventListener('click', cancel);
  mask.addEventListener('click', cancel);
  document.addEventListener('keydown', onKey, true);

  setTimeout(() => pop.querySelector('.confirm-popover-ok').focus(), 30);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
}
window.confirmPopover = confirmPopover;

/** 输入弹窗：和 confirmPopover 同款风格，但带输入框
 *  inputPopover({ anchor, message, defaultValue, placeholder, okText, onOk(value), onCancel })
 */
function inputPopover(opts) {
  document.querySelectorAll('.confirm-popover, .confirm-popover-mask').forEach(el => el.remove());

  const mask = document.createElement('div');
  mask.className = 'confirm-popover-mask';

  const pop = document.createElement('div');
  pop.className = 'confirm-popover input-popover';
  pop.innerHTML = `
    <div class="confirm-popover-msg">${escapeHtmlLocal(opts.message || '请输入')}</div>
    <input type="text" class="input-popover-input" placeholder="${escapeHtmlLocal(opts.placeholder || '')}" value="${escapeHtmlLocal(opts.defaultValue || '')}">
    <div class="confirm-popover-actions">
      <button class="confirm-popover-cancel">${escapeHtmlLocal(opts.cancelText || '取消')}</button>
      <button class="confirm-popover-ok">${escapeHtmlLocal(opts.okText || '确定')}</button>
    </div>
  `;
  document.body.appendChild(mask);
  document.body.appendChild(pop);

  const r = opts.anchor?.getBoundingClientRect?.();
  let left = window.innerWidth / 2 - 140;
  let top = window.innerHeight / 2 - 60;
  if (r) {
    left = r.right + 8;
    top = r.top;
    const popW = 280, popH = 120;
    if (left + popW > window.innerWidth - 8) left = r.left - popW - 8;
    if (left < 8) left = 8;
    if (top + popH > window.innerHeight - 8) top = window.innerHeight - popH - 8;
    if (top < 8) top = 8;
  }
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  const input = pop.querySelector('.input-popover-input');
  const close = () => { mask.remove(); pop.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); ok(); }
  };
  const ok = () => { const v = input.value.trim(); close(); opts.onOk?.(v); };
  const cancel = () => { close(); opts.onCancel?.(); };
  pop.querySelector('.confirm-popover-ok').addEventListener('click', ok);
  pop.querySelector('.confirm-popover-cancel').addEventListener('click', cancel);
  mask.addEventListener('click', cancel);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => { input.focus(); input.select(); }, 30);

  function escapeHtmlLocal(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
}
window.inputPopover = inputPopover;

window.tree = tree;

function updateTrashBadge() {
  const el = document.getElementById('trash-count');
  if (!el) return;
  const showBadge = storage.getSetting('showTrashBadge') !== false;
  const count = Object.keys(storage.getAll().trash || {}).length;
  if (showBadge && count > 0) {
    el.textContent = count > 99 ? '99+' : count;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

window.updateTrashBadge = updateTrashBadge;
