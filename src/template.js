/**
 * template.js — 笔记模板
 *
 * 职责：
 * - 在编辑器中通过输入 "/" 弹出模板快选面板
 * - 支持模板变量替换：{{date}} {{time}} {{datetime}} {{title}} {{year}} {{month}} {{day}}
 * - 模板管理（CRUD）模态框
 */

const template = (() => {
  let _popupEl = null;
  let _activeIndex = 0;
  let _currentFilter = '';
  let _slashInserted = false;

  /** 模板模糊匹配：直接子串 / 拼音全拼 / 拼音首字母 / 字符子序列。空查询返回全部 */
  function matchTemplates(list, query) {
    if (!query) return list.slice();
    const q = query.toLowerCase();
    const scored = [];
    for (const t of list) {
      const name = (t.name || '').toLowerCase();
      let score = 0;
      if (name.includes(q)) score = 100;
      else if (typeof window.pinyinPro?.pinyin === 'function') {
        try {
          const full = window.pinyinPro.pinyin(t.name, { toneType: 'none', type: 'string', nonZh: 'consecutive' }).replace(/\s+/g, '').toLowerCase();
          const first = window.pinyinPro.pinyin(t.name, { pattern: 'first', toneType: 'none', type: 'string', nonZh: 'consecutive' }).replace(/\s+/g, '').toLowerCase();
          if (full.includes(q)) score = 60;
          else if (first.includes(q)) score = 50;
        } catch (_) {}
      }
      if (!score) {
        // 字符子序列
        let i = 0;
        for (let j = 0; j < name.length && i < q.length; j++) {
          if (name[j] === q[i]) i++;
        }
        if (i === q.length) score = 20;
      }
      if (score > 0) scored.push({ t, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => x.t);
  }

  function applyVariables(content, { title }) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return content
      .replace(/{{date}}/g, date)
      .replace(/{{time}}/g, time)
      .replace(/{{datetime}}/g, `${date} ${time}`)
      .replace(/{{year}}/g, now.getFullYear())
      .replace(/{{month}}/g, pad(now.getMonth()+1))
      .replace(/{{day}}/g, pad(now.getDate()))
      .replace(/{{title}}/g, title || '');
  }

  function installSlashTrigger() {
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('input', tryTrigger, true);
    document.addEventListener('keyup', onKeyUp, true);
    // 点击弹窗外部任意位置关闭
    document.addEventListener('mousedown', (e) => {
      if (!_popupEl || _popupEl.classList.contains('hidden')) return;
      if (_popupEl.contains(e.target)) return;
      hidePopup();
    }, true);
  }

  /** keyup 兜底：用户按下任意可能影响 / 检测的键时主动检查一次 */
  function onKeyUp(e) {
    // 跳过功能键 / 弹窗导航键（导航键由 onKeyDown 处理）
    if (['ArrowDown','ArrowUp','Enter','Escape','Tab'].includes(e.key)) return;
    tryTrigger();
  }

  /** 真正的触发判定。
   *  策略（彻底简化）：只看光标前的局部文字，不再尝试找 block 容器、不依赖整段判定。
   *  这样编辑器的任何装饰字符都不会影响判定。
   *
   *  匹配规则（严格）：当前段落级块的整段内容（清洗零宽字符 + trim）形如 `/xxx`
   *  - 空行打 `/` → 块文本就是 "/" → 匹配，弹出
   *  - 继续打 `/abc` → 块文本是 "/abc" → 匹配，按 abc 筛选
   *  - "笔记 /abc" → 块文本不是 / 开头 → 不匹配，避免行内误触
   */
  function tryTrigger() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const target = node.nodeType === 3 ? node.parentElement : node;
    if (!target?.closest('#editor .ProseMirror')) { hideIfShown(); return; }
    if (target.closest('pre, code')) { hideIfShown(); return; }

    // 找当前段落块；取整段文本判定（必须以 / 起头，后面任意字符都允许，让用户能继续打字筛选）
    const block = findLineBlock(node);
    const blockText = (block?.textContent ?? node.textContent ?? '')
      .replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, '');
    const trimmed = blockText.trim();

    if (window.__MD_DEBUG__) console.log('[/] block=', JSON.stringify(trimmed));

    // 必须以 / 起头且不跨行；filter 非空时若没有任何匹配则自动关闭（避免一直挡视线）
    if (trimmed.startsWith('/') && !trimmed.includes('\n')) {
      const filter = trimmed.slice(1);
      if (filter && matchTemplates(storage.getTemplates(), filter).length === 0) {
        hideIfShown();
        return;
      }
      _currentFilter = filter;
      clearTimeout(_pendingTimer);
      _pendingTimer = setTimeout(() => {
        const sel2 = window.getSelection();
        if (sel2 && sel2.rangeCount) showPopup(sel2.getRangeAt(0));
      }, 60);
    } else {
      hideIfShown();
    }
  }

  /** 找最近的"段落级块容器"。遇到 ProseMirror 外壳就 stop。 */
  function findLineBlock(node) {
    let el = node.parentElement;
    while (el) {
      if (el.classList) {
        if (el.classList.contains('ProseMirror')
         || el.id === 'editor'
         || el.tagName === 'BODY') return null;
      }
      if (/^(P|LI|H[1-6]|BLOCKQUOTE|TD|TH|FIGCAPTION|DT|DD)$/i.test(el.tagName)) return el;
      el = el.parentElement;
    }
    return null;
  }

  let _pendingTimer = null;
  function hideIfShown() {
    if (_popupEl && !_popupEl.classList.contains('hidden')) {
      clearTimeout(_pendingTimer);
      hidePopup();
    }
  }

  function onKeyDown(e) {
    if (!_popupEl) return;
    const items = _popupEl.querySelectorAll('.tpl-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); _activeIndex = (_activeIndex + 1) % items.length; updateActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _activeIndex = (_activeIndex - 1 + items.length) % items.length; updateActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); items[_activeIndex]?.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); hidePopup(); }
  }

  function updateActive() {
    const items = _popupEl?.querySelectorAll('.tpl-item') || [];
    items.forEach((it, i) => it.classList.toggle('active', i === _activeIndex));
  }

  function showPopup(range) {
    const templates = storage.getTemplates();
    const filtered = matchTemplates(templates, _currentFilter);

    if (!_popupEl) {
      _popupEl = document.createElement('div');
      _popupEl.className = 'context-menu';
      _popupEl.style.minWidth = '200px';
      document.body.appendChild(_popupEl);
    }
    _popupEl.innerHTML = '';
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:6px 12px;font-size:11px;color:var(--text-tertiary);background:var(--bg-tertiary);';
    hint.textContent = _currentFilter
      ? `「${_currentFilter}」 · ${filtered.length} 条匹配（支持拼音/首字母）`
      : `共 ${filtered.length} 条 · 输入字符筛选（支持拼音）`;
    _popupEl.appendChild(hint);

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px;color:var(--text-tertiary);font-size:12px;text-align:center;';
      empty.textContent = '未匹配到模板';
      _popupEl.appendChild(empty);
    } else {
      filtered.forEach((tpl, i) => {
        const it = document.createElement('div');
        it.className = 'context-menu-item tpl-item' + (i === 0 ? ' active' : '');
        it.innerHTML = `<span style="width:14px;color:var(--accent);">⌗</span><span>${escapeHtml(tpl.name)}</span>`;
        it.addEventListener('click', () => {
          insertTemplate(tpl);
          hidePopup();
        });
        _popupEl.appendChild(it);
      });
      _activeIndex = 0;
    }

    const rect = getCursorRect(range);
    _popupEl.classList.remove('hidden');
    _popupEl.style.left = rect.left + 'px';
    _popupEl.style.top = (rect.bottom + 4) + 'px';
  }

  /** 获取光标位置矩形。range.getBoundingClientRect() 在新建块开头/空块里
   *  会返回 (0,0,0,0)，导致弹窗飞到窗口左上角。这里逐级 fallback，保证至少
   *  落在编辑器里。 */
  function getCursorRect(range) {
    let rect = range.getBoundingClientRect();
    if (rect.left === 0 && rect.top === 0 && rect.width === 0 && rect.height === 0) {
      // fallback 1：在 cursor 位置插一个零宽 span，量它的 rect，再删掉
      try {
        const probe = document.createElement('span');
        probe.textContent = '\u200b';
        const r2 = range.cloneRange();
        r2.collapse(true);
        r2.insertNode(probe);
        rect = probe.getBoundingClientRect();
        probe.remove();
      } catch (_) {}
    }
    if (rect.left === 0 && rect.top === 0) {
      // fallback 2：用 startContainer 的父元素 rect
      const node = range.startContainer;
      const el = node?.nodeType === 3 ? node.parentElement : node;
      if (el?.getBoundingClientRect) {
        const er = el.getBoundingClientRect();
        rect = { left: er.left, top: er.top, bottom: er.bottom, right: er.right, width: er.width, height: er.height };
      }
    }
    if (rect.left === 0 && rect.top === 0) {
      // fallback 3：编辑器中心
      const v = document.querySelector('#editor');
      if (v) {
        const er = v.getBoundingClientRect();
        const x = er.left + 80, y = er.top + 80;
        rect = { left: x, top: y, bottom: y + 20, right: x + 80, width: 80, height: 20 };
      }
    }
    return rect;
  }

  function hidePopup() {
    if (_popupEl) {
      _popupEl.classList.add('hidden');
      _popupEl.innerHTML = '';
    }
    _currentFilter = '';
  }

  function insertTemplate(tpl) {
    const id = editor.currentId();
    if (!id) return;
    const note = storage.get(id);
    const content = applyVariables(tpl.content || '', { title: note?.title });

    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === 3) {
        const text = node.textContent || '';
        const pos = range.startOffset;
        const beforeCaret = text.slice(0, pos);
        const match = /(^|[\s\n>])\/([a-zA-Z\u4e00-\u9fa5]*)$/.exec(beforeCaret);
        if (match) {
          const delStart = pos - match[2].length - 1;
          const newRange = document.createRange();
          newRange.setStart(node, delStart);
          newRange.setEnd(node, pos);
          newRange.deleteContents();
        }
      }
    }
    editor.insertAtCursor(content);
  }

  // ========== 模板管理 UI ==========
  function openManager() {
    const templates = storage.getTemplates();
    const body = document.createElement('div');
    const list = document.createElement('div');
    list.style.cssText = 'max-height:50vh;overflow-y:auto;margin-top:8px;';

    function rerender() {
      list.innerHTML = '';
      for (const t of storage.getTemplates()) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;';
        const name = document.createElement('div');
        name.style.cssText = 'flex:1;font-weight:500;';
        name.textContent = t.name;
        const editBtn = document.createElement('button');
        editBtn.className = 'secondary-btn';
        editBtn.style.padding = '4px 10px';
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', () => editTemplate(t, rerender));
        const delBtn = document.createElement('button');
        delBtn.className = 'danger-btn';
        delBtn.style.padding = '4px 10px';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', async () => {
          const ok = await (window.uiConfirm
            ? window.uiConfirm({ title: '删除模板', message: `确定删除模板「${t.name}」吗？`, okText: '删除', okClass: 'danger-btn' })
            : Promise.resolve(confirm(`删除模板「${t.name}」？`)));
          if (!ok) return;
          storage.deleteTemplate(t.id);
          rerender();
        });
        row.appendChild(name);
        row.appendChild(editBtn);
        row.appendChild(delBtn);
        list.appendChild(row);
      }
      if (!storage.getTemplates().length) {
        list.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:20px 0;">暂无模板</p>';
      }
    }
    rerender();

    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--text-tertiary);font-size:12px;margin-top:8px;';
    hint.innerHTML = '支持的变量：<code>{{date}}</code> <code>{{time}}</code> <code>{{datetime}}</code> <code>{{title}}</code> <code>{{year}}</code> <code>{{month}}</code> <code>{{day}}</code>。在编辑器中输入 <code>/</code> 可快速插入。';

    body.appendChild(list);
    body.appendChild(hint);

    openModal({
      title: '模板管理',
      body,
      footer: [
        { label: '新建模板', class: 'primary-btn', onClick: () => editTemplate({ id: '', name: '', content: '' }, rerender) },
        { label: '关闭', class: 'secondary-btn', onClick: closeModal },
      ],
    });
  }

  function editTemplate(tpl, onSaved) {
    const body = document.createElement('div');
    body.innerHTML = `
      <label>名称</label>
      <input type="text" id="tpl-name" value="${escapeHtml(tpl.name || '')}" placeholder="模板名称">
      <label>内容</label>
      <textarea id="tpl-content" rows="10" style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(tpl.content || '')}</textarea>
    `;
    openModal({
      title: tpl.id ? '编辑模板' : '新建模板',
      body,
      footer: [
        { label: '保存', class: 'primary-btn', onClick() {
          const name = body.querySelector('#tpl-name').value.trim();
          const content = body.querySelector('#tpl-content').value;
          if (!name) { toast('请输入名称', 'warning'); return; }
          storage.saveTemplate({ id: tpl.id, name, content });
          closeModal();
          onSaved && onSaved();
          toast('模板已保存', 'success');
        }},
        { label: '取消', class: 'secondary-btn', onClick: closeModal },
      ],
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /** 快速插入面板：从任意位置弹出，列出全部模板，点击立即插入到当前编辑器 */
  function openQuickPick(anchorEl) {
    if (!editor.currentId()) {
      if (window.toast) toast('请先打开一条笔记再插入模板', 'warning');
      return;
    }
    const list = storage.getTemplates();
    const pop = document.createElement('div');
    pop.className = 'context-menu tpl-quickpick';
    pop.style.minWidth = '220px';
    pop.style.maxHeight = '400px';
    pop.style.overflowY = 'auto';

    if (!list.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:18px;color:var(--text-tertiary);font-size:12px;text-align:center;';
      empty.textContent = '暂无模板，点击下方"管理"创建';
      pop.appendChild(empty);
    } else {
      const header = document.createElement('div');
      header.style.cssText = 'padding:6px 12px;font-size:11px;color:var(--text-tertiary);background:var(--bg-tertiary);';
      header.textContent = '点击插入到当前光标位置';
      pop.appendChild(header);
      list.forEach(tpl => {
        const it = document.createElement('div');
        it.className = 'context-menu-item';
        it.innerHTML = `<span style="width:16px;color:var(--accent);">⌗</span><span style="flex:1;">${escapeHtml(tpl.name)}</span><span style="color:var(--text-tertiary);font-size:11px;">↵</span>`;
        it.addEventListener('click', () => {
          insertTemplate(tpl);
          remove();
        });
        pop.appendChild(it);
      });
    }
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid var(--border);';
    pop.appendChild(sep);
    const manageBtn = document.createElement('div');
    manageBtn.className = 'context-menu-item';
    manageBtn.innerHTML = `<span style="width:16px;">⚙</span><span>管理模板…</span>`;
    manageBtn.addEventListener('click', () => { remove(); openManager(); });
    pop.appendChild(manageBtn);

    document.body.appendChild(pop);
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left, top;
    if (anchorEl && anchorEl.x !== undefined && anchorEl.y !== undefined) {
      left = anchorEl.x;
      top = anchorEl.y + 4;
    } else if (anchorEl && anchorEl.getBoundingClientRect) {
      const r = anchorEl.getBoundingClientRect();
      left = r.left;
      top = r.bottom + 4;
    } else {
      left = window.innerWidth / 2 - pw / 2;
      top = window.innerHeight / 2 - ph / 2;
    }
    if (top + ph > window.innerHeight - 8) top = Math.max(8, top - ph - 8);
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top  = `${Math.round(top)}px`;
    pop.classList.remove('hidden');

    // 键盘导航：让弹窗自身持有焦点来接收方向键（绕开全局 keydown 竞争）。
    // 插入仍走 editor.insertAtCursor（内部 .focus() 会回到编辑器并用其选区），不受焦点转移影响。
    pop.tabIndex = -1;
    const navItems = Array.from(pop.querySelectorAll('.context-menu-item'));
    let qpIndex = navItems.length ? 0 : -1;
    const syncQpActive = () => navItems.forEach((it, i) => it.classList.toggle('active', i === qpIndex));
    syncQpActive();
    pop.addEventListener('mousemove', (e) => {
      // 鼠标移到某项时让键盘高亮跟随，避免键鼠两套高亮打架
      const it = e.target.closest('.context-menu-item');
      if (it) { const i = navItems.indexOf(it); if (i >= 0 && i !== qpIndex) { qpIndex = i; syncQpActive(); } }
    });
    function onQpKey(e) {
      if (!navItems.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); qpIndex = (qpIndex + 1) % navItems.length; syncQpActive(); navItems[qpIndex].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); qpIndex = (qpIndex - 1 + navItems.length) % navItems.length; syncQpActive(); navItems[qpIndex].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); navItems[qpIndex]?.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); remove(); }
    }
    pop.addEventListener('keydown', onQpKey);

    function remove() {
      pop.remove();
      document.removeEventListener('mousedown', onDoc, true);
    }
    function onDoc(e) {
      if (!pop.contains(e.target)) remove();
    }
    setTimeout(() => {
      document.addEventListener('mousedown', onDoc, true);
      try { pop.focus({ preventScroll: true }); } catch (_) {}
    }, 0);
  }

  return { installSlashTrigger, openManager, hidePopup, openQuickPick };
})();

window.template = template;
