/**
 * app.js — 应用入口与全局控制
 *
 * 职责：
 * - 启动初始化（加载数据 → 渲染树 → 打开上次笔记 → 绑定全局事件）
 * - 主题切换、侧栏宽度拖拽
 * - 与 Quicker 通信（关闭=隐藏、请求导入导出等子程序）
 * - 接收 Quicker 的 postWebMessage 广播
 * - 全局快捷键
 */

function cleanupDivAlignOnce() {
  if (storage.getSetting('_divAlignCleaned')) return;
  try {
    const all = storage.getAll();
    const notes = all?.notes || {};
    const blockRe = /<div[^>]*\balign\s*=\s*["'][^"']*["'][^>]*>\s*\n*([\s\S]*?)\n*\s*<\/div>/gi;
    let changed = false;
    for (const id of Object.keys(notes)) {
      const n = notes[id];
      if (!n.content || typeof n.content !== 'string') continue;
      if (!blockRe.test(n.content)) { blockRe.lastIndex = 0; continue; }
      blockRe.lastIndex = 0;
      const cleaned = n.content.replace(blockRe, '$1');
      if (cleaned !== n.content) {
        n.content = cleaned;
        n.updatedAt = Date.now();
        changed = true;
      }
    }
    storage.setSetting('_divAlignCleaned', true);
    if (changed) storage.save({ immediate: true });
    // cleanup done
  } catch (e) { console.warn('[cleanup] div-align 清理失败', e); }
}

// 最小窗口尺寸（逻辑像素，可调）。前端启动检测用；子程序侧用 minW/minH（物理像素）做几何。
const WIN_MIN_W = 600;
const WIN_MIN_H = 400;

async function bootstrap() {
  // 显眼的版本水印——在控制台第一行就能看到，确认 cache 是否刷新
  console.log('%c[ZhiNote] build 20260515b ✓ (Tiptap editor, local bundle, BubbleMenu)', 'background:#37352f;color:#fff;padding:2px 8px;font-weight:bold;');
  console.log('[ZhiNote] 调试开关：在控制台运行 window.__MD_DEBUG__=true 后再输入 / 或 ;; 可看判定过程');

  // 宿主标记：非 Quicker 宿主（浏览器/PWA）→ body.host-web，CSS 据此隐藏窗口控制等桌面专属 UI。
  if (!window.host.caps.quicker) {
    document.body.classList.add('host-web');
    // PWA：manifest 与 Service Worker 都只在网页宿主动态注入——
    // 桌面 Quicker（单文件 ZhiNote.html）旁边没有这些文件，静态写进 <head> 会产生 404 噪音。
    try {
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = 'manifest.webmanifest';
      document.head.appendChild(link);
    } catch (_) {}
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        // 后台更新提示：缓存优先策略下新版本要"再启动一次"才生效，这里把"再启动一次"
        // 变成一个可点的提示——新 SW 在后台装好并接管（controllerchange）后，提示一键刷新。
        // 首次安装（之前没有 controller）不提示。
        const hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadController) return;
          if (window.__swReloadPrompted) return;
          window.__swReloadPrompted = true;
          const show = () => {
            try {
              const el = toast('新版本已在后台更新完成，点击立即启用', 'info', { id: 'sw-updated', duration: 12000 });
              // 点击 = 立即重载启用新版（toast 自身的点击关闭逻辑先走，稍延迟再刷）
              if (el) el.addEventListener('click', () => setTimeout(() => location.reload(), 150));
            } catch (_) { /* toast 未就绪：下次启动自然生效 */ }
          };
          // UI 可能还没初始化完，稍等再弹
          if (document.readyState === 'complete') setTimeout(show, 1500); else window.addEventListener('load', () => setTimeout(show, 1500));
        });
      }).catch(() => {});
    }
  }

  // 窗口自愈放最前（在 storage.init() 等耗时操作之前），尽快复位，减少"一条线"残留时间。
  // isQuicker() 只看 $quicker / chrome.webview 是否注入，不依赖 storage，已可用。
  if (storage.isQuicker()) {
    // 冷启动 / 预热即「正常态打开」：复位伪最大化标记 zhinote_is_max=0。
    // 「显示已存在窗口」不重载页面、不会执行到这里，所以天然只在冷启动/预热复位（正是所需）。
    try { await windowOp('复位'); } catch (_) {}
    // 锁定原生四边缩放的最小尺寸（子程序内 WM_GETMINMAXINFO 子类化，OS 级）。一次性挂钩，子程序侧按 hWnd 去重。
    const _dpr = window.devicePixelRatio || 1;
    try {
      await windowOp('最小尺寸', { minW: Math.round(WIN_MIN_W * _dpr), minH: Math.round(WIN_MIN_H * _dpr) });
    } catch (_) {}
    // 窗口异常过小（"一条线"/被压扁/存盘尺寸损坏）时，复位到最小尺寸并在工作区内居中。
    try {
      const innerW = window.innerWidth, innerH = window.innerHeight;
      if (innerW < WIN_MIN_W - 24 || innerH < WIN_MIN_H - 24) {
        try {
          await windowOp('复位窗口', { minW: Math.round(WIN_MIN_W * _dpr), minH: Math.round(WIN_MIN_H * _dpr) });
        } catch (_) {
          // 子程序还没加「复位窗口」模式时的兜底：先最大化，至少让窗口可见可用
          try { await windowOp('最大化', { isMax: false }); _isMaximized = true; } catch (_) {}
        }
      }
    } catch (_) {}
    // 关闭 WebView2 通用自动填充（原生「保存的信息」弹窗）。反射只依赖微软 WebView2 公开 API、
    // 不碰 Quicker 内部类型；子程序未加该模式时会被吞掉、无副作用。不阻塞启动。
    try { windowOp('关闭自动填充').catch(() => {}); } catch (_) {}
  }

  try {
    await storage.init();
  } catch (err) {
    console.error('[app] 初始化失败', err);
    toast('数据加载失败：' + (err?.message || err), 'error');
  }

  // ─── 一次性 JSON 数据格式迁移（content/md → doc/JSON）────────────────────────
  // 仅当数据还是旧格式(<2)时执行：先确保编辑器（markdown manager）就绪，迁移内部强制备份、
  // 失败即中止；成功后置 dataFormatVersion=2 并标脏，首次同步会把 doc 全集推上云 + epoch++。
  try {
    if (storage.getDataFormatVersion && storage.getDataFormatVersion() < 2) {
      if (window.editor && window.editor.initEditor) { try { window.editor.initEditor(); } catch (_) {} }
      if (storage.migrateNotesToDoc) {
        const rep = await storage.migrateNotesToDoc();
        if (rep && rep.ran) {
          console.log('[app] JSON 迁移完成:', rep);
          if (rep.failed > 0) toast(`笔记格式升级完成，但 ${rep.failed} 篇未能转换（已保留原内容，可重试）`, 'warning', { duration: 8000 });
        } else if (rep && rep.reason === 'backup-failed') {
          toast('笔记格式升级前备份失败，已暂缓升级；请检查存储后重启枝记', 'error', { duration: 0 });
        }
      }
    }
  } catch (e) { console.error('[app] JSON 迁移异常', e); }

  cleanupDivAlignOnce();
  document.querySelectorAll('.readonly-badge, .cloze-indicator, .focus-indicator').forEach(el => el.remove());
  applySavedSettings();
  initEditorContextMenu();
  tree.render();
  updateTrashBadge();

  // 初始化云同步徽标状态
  const _initMethod = storage.getSetting('syncMethod') || 'none';
  if (_initMethod === 'none') {
    _setCloudSyncDot('disabled');
  } else {
    _setCloudSyncDot('synced');
  }
  if (localStorage.getItem('zhinote-cloud-badge-hidden') === '1') {
    const _dot = document.getElementById('cloud-sync-dot');
    if (_dot) _dot.style.display = 'none';
  }
  // 显示页面（防止闪白）
  requestAnimationFrame(() => document.body.classList.add('app-ready'));

  const lastId = storage.getSetting('lastOpenedId');
  if (lastId && storage.get(lastId)) {
    // 立即隐藏欢迎页，防止闪烁
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'none';
    expandAncestors(lastId);
    const tryOpen = () => {
      if (window.editor) { window.editor.open(lastId); }
      else { setTimeout(tryOpen, 50); }
    };
    tryOpen();
  } else {
    renderWelcomeRecent();
  }

  wireEvents();
  template.installSlashTrigger();
  installEmojiTrigger();
  installPaletteTrigger();
  listenQuickerMessages();
  startBackupScheduler();

  // 加载本机字体缓存；首次没缓存就异步探测一次
  loadCachedSystemFonts();
  if (!getDetectedSystemFonts().length) {
    setTimeout(() => { try { refreshDetectedSystemFonts(); } catch (_) {} }, 1500);
  }

  storage.on('change', (payload) => {
    if (!payload.silent && !window._bulkImporting) tree.render();
    updateTrashBadge();
    // 云端下载会发 type='reload'：同时把当前编辑器里的笔记内容刷新成最新
    if (payload?.type === 'reload') {
      const curId = editor.currentId?.();
      if (curId && storage.get(curId)) editor.reloadCurrent();
      else if (curId) editor.close();
    }
    // 同步/导入等批量变更：顶栏笔记本名、欢迎页"最近编辑"也要跟着刷新，避免显示陈旧
    if (payload?.type === 'reload' || payload?.type === 'global-sync') {
      try { refreshWorkspaceSwitcher(); } catch (_) {}
      try { renderWelcomeRecent(); } catch (_) {}
    }
    // 同步模块：本地数据变更 → 调度 PUT（由 storage.js markDirty 统一调度 WebDAV）
  });

  // ─── 跨设备同步编辑保护 ─────────────────────────────────────────────────────
  let _syncProtectionActive = false;
  let _syncProtectionTimer = null;
  let _syncProtectionCooldownUntil = 0;
  const SYNC_PROTECTION_TIMEOUT = 15000;
  const SYNC_PROTECTION_COOLDOWN = 60000;

  function _startSyncProtection() {
    if (_syncProtectionActive) return;
    if (Date.now() < _syncProtectionCooldownUntil) return;
    _syncProtectionActive = true;
    editor.setReadonly(true);
    document.body.classList.add('sync-protection-mode');
    refreshEditorModeBar();
    _syncProtectionTimer = setTimeout(() => {
      _endSyncProtection();
      // 不是失败：只是后台同步还没拉完，先放开编辑。但提醒：同步真正完成后可能覆盖此处改动
      toast('后台同步用时较长，已解除锁定、可继续编辑；同步完成后这里的改动可能被云端覆盖', 'info', { duration: 7000 });
    }, SYNC_PROTECTION_TIMEOUT);
  }

  function _endSyncProtection() {
    if (!_syncProtectionActive) return;
    _syncProtectionActive = false;
    clearTimeout(_syncProtectionTimer);
    _syncProtectionTimer = null;
    _syncProtectionCooldownUntil = Date.now() + SYNC_PROTECTION_COOLDOWN;
    editor.setReadonly(false);
    document.body.classList.remove('sync-protection-mode');
    refreshEditorModeBar();
  }
  window._endSyncProtection = _endSyncProtection;

  // 云同步事件 → toast 提示
  let _lastSyncFailMsg = '';
  let _lastSyncFailAt = 0;
  storage.on('cloud-sync', (payload) => {
    if (payload.type === 'webdav-sync-start') {
      // 同步前先把编辑器里未落盘的正文 flush 到 storage，
      // 否则远端较新时 reloadCurrent 会覆盖掉内存里的未保存修改
      editor.flushSave?.();
      // 静默后台轮询：不闪同步徽标（避免每 30s 抖一下）；只有真正下载/失败时才提示
      if (!payload.silent) _setCloudSyncDot('syncing');
    } else if (payload.type === 'sync-protection-start') {
      _startSyncProtection();
    } else if (payload.type === 'webdav-sync-ok') {
      if (_syncProtectionActive) _endSyncProtection();
      // 同步成功（非重试占位）→ 清掉失败去重记录，下次再失败仍会正常提示
      if (payload.detail !== 'retry-transient') { _lastSyncFailMsg = ''; _lastSyncFailAt = 0; }
      // 静默轮询且无变更（unchanged/empty）时不动徽标，保持稳定不闪
      if (!(payload.silent && (payload.detail === 'get-unchanged' || payload.detail === 'get-empty'))) {
        _setCloudSyncDot('synced');
      }
      if (payload.detail === 'first') {
        const _pn = { jianguoyun: '坚果云', koofr: 'Koofr', infinicloud: 'InfiniCLOUD' }[storage.getSetting('webdavProvider')] || 'WebDAV';
        toast(`${_pn} 首次同步完成`, 'success');
        tree.render();
        try { refreshWorkspaceSwitcher(); } catch (_) {}
        try { renderWelcomeRecent(); } catch (_) {}
      } else if (payload.detail === 'get-downloaded') {
        const curId = editor.currentId?.();
        const downloaded = payload.downloadedNoteIds;
        tree.render();
        try { refreshWorkspaceSwitcher(); } catch (_) {}
        try { renderWelcomeRecent(); } catch (_) {}
        if (curId && downloaded && downloaded.has && downloaded.has(curId)) {
          editor.reloadCurrent();
        }
      }
    } else if (payload.type === 'webdav-sync-fail') {
      if (_syncProtectionActive) _endSyncProtection();
      _setCloudSyncDot('error', payload.error);
      const _pn2 = { jianguoyun: '坚果云', koofr: 'Koofr', infinicloud: 'InfiniCLOUD' }[storage.getSetting('webdavProvider')] || 'WebDAV';
      const _ferr = /401|403/.test(payload.error || '') ? '账号或密码错误，请检查' : _zhSyncError(payload.error);
      // silent：后台慢速重试期间的同类失败只更新角标；
      // 同一条错误 5 分钟内被用户关掉后不再反复弹（轮询失败会一直触发该事件）
      const _failMsg = `${_pn2} 同步失败：` + _ferr;
      if (!payload.silent && !(_lastSyncFailMsg === _failMsg && Date.now() - _lastSyncFailAt < 5 * 60_000)) {
        _lastSyncFailMsg = _failMsg;
        _lastSyncFailAt = Date.now();
        toast(_failMsg, 'error', { id: 'webdav-fail', duration: 0 });
      }
    } else if (payload.type === 'webdav-notes-skipped') {
      // 个别云端笔记文件损坏：已跳过下载，本地有副本的会自动重传修复，无需用户操作
      const _msg = payload.healed > 0
        ? `检测到 ${payload.count} 篇云端笔记文件损坏，已用本地副本自动重传修复`
        : `检测到 ${payload.count} 篇云端笔记文件损坏且本地无副本，已跳过（可在"管理云端笔记"中查看）`;
      toast(_msg, 'warning', { id: 'webdav-skip', duration: 8000 });
    } else if (payload.type === 'webdav-version-block') {
      // 云端数据格式比本客户端新 → 已停止同步，提示更新，避免旧版污染/覆盖新格式数据
      _setCloudSyncDot('error', '云端数据格式较新');
      toast('云端数据已升级到更新版本，当前枝记过旧，已暂停同步。请更新 / 重启枝记后再同步，以免数据冲突。', 'error', { id: 'webdav-version-block', duration: 0 });
    } else if (payload.type === 'webdav-rate-limited') {
      _setCloudSyncDot('pending');
      toast('同步请求频率受限，将自动恢复', 'warning', { id: 'webdav-rate', duration: 5000 });
    } else if (payload.type === 'webdav-conflict') {
      const _msg = payload.copyMade
        ? '检测到云端对该笔记也有修改：已采用云端版本，你本地未上传的版本已另存为"（本地冲突副本）"，请对比后保留所需的一份'
        : '检测到云端也修改了该笔记，已保留本地版本';
      toast(_msg, 'warning', { id: 'webdav-conflict', duration: 0 });
    }
  });
  // 启动自动同步调度
  storage.startAutoSync().then(() => {
    // 同步配置可能被云端覆盖，重新刷新徽标状态
    const _postMethod = storage.getSetting('syncMethod') || 'none';
    if (_postMethod === 'none') _setCloudSyncDot('disabled');
  });

  refreshEditorModeBar();

  window.__appReady = true;
  if (storage.isQuicker()) {
    try {
      (async () => { (await window.$quicker).setVar('zhinote_ready', '1'); })();
    } catch (_) {}
    // 等待宿主子程序桥注入后，首次同步窗口边框色
    (function waitAndRemoveBorder(retries) {
      if (retries <= 0) return;
      if (!window.host.caps.window) {
        setTimeout(function() { waitAndRemoveBorder(retries - 1); }, 300);
        return;
      }
      var bg = getComputedStyle(document.body).getPropertyValue('--bg-secondary').trim()
            || getComputedStyle(document.body).getPropertyValue('--bg').trim()
            || '#191919';
      _lastBorderColor = bg;
      window.host.window.removeBorder(bg);
    })(20);
  }
}

/** 支持的所有主题 */
let _lastBorderColor = null;
const THEMES = [
  { id: 'light',            name: '浅色',     dark: false },
  { id: 'dark',             name: '深色',     dark: true  },
  { id: 'solarized-light',  name: '日光',     dark: false },
  { id: 'nord',             name: '极地',     dark: true  },
  { id: 'dracula',          name: '德古拉',   dark: true  },
  { id: 'gruvbox',          name: '林间',     dark: true  },
];
window.THEMES = THEMES;

// 统一用 data-href（而非 <a href>）打开外链：WebView2 下 <a href> 悬浮会在左下角弹出原生链接预览，
// 用 window.open 打开则不会出现该预览。全局委托，任何带 data-href 的元素点击即打开。
document.addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('[data-href]');
  if (!el) return;
  e.preventDefault();
  const url = el.getAttribute('data-href');
  if (url) { try { window.open(url, '_blank'); } catch (_) {} }
});

/** 主题选择 popover — 点击主题按钮弹出，统一风格 */
let _themePopover = null;
function openThemePopover(anchorEl) {
  if (!_themePopover) {
    _themePopover = document.createElement('div');
    _themePopover.id = 'theme-popover';
    _themePopover.className = 'popover hidden';
    document.body.appendChild(_themePopover);
  }
  const cur = storage.getSetting('theme') || 'light';
  const swatch = (id) => {
    const map = {
      'light':           ['#ffffff', '#2383e2', '#e8e8e8'],
      'dark':            ['#191919', '#529cca', '#333333'],
      'solarized-light': ['#fdf6e3', '#268bd2', '#eee8d5'],
      'nord':            ['#2e3440', '#88c0d0', '#3b4252'],
      'dracula':         ['#282a36', '#bd93f9', '#44475a'],
      'gruvbox':         ['#282828', '#fabd2f', '#3c3836'],
    };
    const [bg, ac, line] = map[id] || ['#fff', '#888', '#ddd'];
    return `<span class="theme-swatch" style="background:${bg};border-color:${line};">
      <span class="ts-line" style="background:${line}"></span>
      <span class="ts-line ts-short" style="background:${ac}"></span>
      <span class="ts-line" style="background:${line}"></span>
    </span>`;
  };
  _themePopover.innerHTML = `
    <div class="theme-popover-title">主题</div>
    <div class="theme-popover-list">
      ${THEMES.map(t => `
        <button class="theme-item ${t.id === cur ? 'active' : ''}" data-theme="${t.id}">
          ${swatch(t.id)}
          <span class="theme-item-name">${t.name}</span>
          ${t.id === cur ? '<svg class="theme-check" viewBox="0 0 16 16" width="14" height="14"><path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>' : ''}
        </button>
      `).join('')}
    </div>
  `;
  _themePopover.querySelectorAll('.theme-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.theme;
      storage.setSetting('theme', id);
      localStorage.setItem('zhinote-theme', id);
      applyTheme(id);
      if (editor.setTheme) editor.setTheme(id);
      closeThemePopover();
    });
  });
  _themePopover.classList.remove('hidden');
  _themePopover.style.visibility = 'hidden';
  _themePopover.style.left = '0px';
  _themePopover.style.top = '0px';
  requestAnimationFrame(() => {
    const r = anchorEl.getBoundingClientRect();
    const pw = _themePopover.offsetWidth;
    const ph = _themePopover.offsetHeight;
    let left = r.left + r.width / 2 - pw / 2;
    let top = r.top - ph - 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    if (top < 8) top = r.bottom + 8;
    _themePopover.style.left = Math.round(left) + 'px';
    _themePopover.style.top = Math.round(top) + 'px';
    _themePopover.style.visibility = 'visible';
  });
  const onDoc = (e) => {
    if (!_themePopover.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
      closeThemePopover();
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeThemePopover(); }
  };
  function closeThemePopover() {
    _themePopover.classList.add('hidden');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function applyTheme(themeId) {
  const valid = THEMES.find(t => t.id === themeId) || THEMES[0];
  for (const t of THEMES) document.body.classList.remove('theme-' + t.id);
  document.body.classList.add('theme-' + valid.id);
  // 编辑器里有些代码按 theme-dark/theme-light 区分，这里给个统一暗色 marker
  document.body.classList.toggle('theme-is-dark',  valid.dark);
  document.body.classList.toggle('theme-is-light', !valid.dark);
  // 让原生控件（数字框上下箭头 spinner、滚动条等）跟随主题明暗，避免暗色主题下露出白色控件
  try {
    const cs = valid.dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = cs;
    document.body.style.colorScheme = cs;
  } catch (_) {}

  // 关键：动态更新 <meta name="theme-color">
  // WebView2 主线程会把这个值当作 HWND 的 default background brush，
  // 窗口 resize 时 Chromium 来不及重绘的瞬间，露出的就是这个色 → 解决"右侧露白"
  // 必须取计算后的实际值（用 getComputedStyle 读 CSS 变量）
  setTimeout(() => {
    try {
      const bg = getComputedStyle(document.body).getPropertyValue('--bg-secondary').trim()
              || getComputedStyle(document.body).getPropertyValue('--bg').trim()
              || (valid.dark ? '#26282c' : '#ffffff');
      let m = document.querySelector('meta[name="theme-color"]');
      if (!m) {
        m = document.createElement('meta');
        m.setAttribute('name', 'theme-color');
        document.head.appendChild(m);
      }
      m.setAttribute('content', bg);
      // 同步 WPF 宿主窗口边框/背景色（颜色变化时才调用；非 Quicker 宿主自动 no-op）
      if (window.host?.caps.window && bg !== _lastBorderColor) {
        _lastBorderColor = bg;
        window.host.window.removeBorder(bg);
      }
    } catch (_) {}
  }, 0);
}

/** 正文字体预设（精选） */
const CONTENT_FONTS = [
  { id: '',        name: '系统默认', stack: '' },
  { id: 'song',    name: '宋体（思源宋体）', stack: '"Source Han Serif SC", "Noto Serif SC", "Songti SC", SimSun, serif' },
  { id: 'kai',     name: '楷体（霞鹜文楷）', stack: '"LXGW WenKai", "LXGW WenKai Screen", "KaiTi", "STKaiti", serif' },
  { id: 'sans',    name: '黑体（思源黑体）', stack: '"HarmonyOS Sans SC", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", sans-serif' },
  { id: 'inter',   name: 'Inter（西文）',   stack: 'Inter, "PingFang SC", sans-serif' },
  { id: 'serif',   name: 'Georgia（西文）', stack: 'Georgia, "Times New Roman", "Source Han Serif SC", serif' },
  { id: 'mono',    name: '等宽（JetBrains Mono）', stack: '"JetBrains Mono", "Fira Code", Consolas, monospace' },
];
window.CONTENT_FONTS = CONTENT_FONTS;

/** ====== 本机字体探测（canvas 字体宽度差异法，无需权限） ======
 *  常见 Windows / macOS / 中文字体候选清单，启动时探测哪些已安装，缓存到 localStorage
 *  设置面板会把"探测到的本机字体"追加到下拉的【系统字体】分组里
 */
const SYSTEM_FONT_CANDIDATES = [
  // Windows 中文
  '微软雅黑', 'Microsoft YaHei', 'Microsoft YaHei UI', '宋体', 'SimSun', 'NSimSun',
  '黑体', 'SimHei', '楷体', 'KaiTi', 'STKaiti', '仿宋', 'FangSong', 'STFangsong',
  '等线', 'DengXian', '幼圆', 'YouYuan', '华文宋体', 'STSong', '华文仿宋', 'STFangsong',
  '华文黑体', 'STHeiti', '华文楷体', 'STKaiti', '华文行楷', 'STXingkai', '方正姚体', 'FZYaoti',
  '方正舒体', 'FZShuTi', '方正粗黑宋简体', '思源黑体', 'Source Han Sans SC', 'Source Han Sans CN',
  '思源宋体', 'Source Han Serif SC', '苹方', 'PingFang SC', 'PingFang TC', 'Hiragino Sans GB',
  // macOS / iOS 中文
  '苹方-简', 'Heiti SC', 'Songti SC', 'Hannotate SC',
  // 第三方流行
  'LXGW WenKai', 'LXGW WenKai Screen', 'LXGW WenKai Mono', 'JetBrains Mono', 'Fira Code',
  'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Source Code Pro', 'Inconsolata',
  'IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono', 'IBM Plex Sans SC',
  // 西文经典
  'Arial', 'Arial Black', 'Arial Narrow', 'Helvetica', 'Helvetica Neue',
  'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri', 'Cambria', 'Candara', 'Constantia', 'Corbel',
  'Times New Roman', 'Times', 'Georgia', 'Palatino Linotype', 'Book Antiqua', 'Garamond',
  'Lucida Console', 'Lucida Sans Unicode', 'Comic Sans MS', 'Impact',
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Nunito', 'Poppins', 'Montserrat', 'Merriweather',
  'Segoe UI', 'Segoe UI Emoji', 'Segoe Print', 'Segoe Script',
];

let _detectedSystemFonts = null; // [{ name }]，懒加载

/** Canvas 字体宽度差异法（无需 Local Font Access 权限，所有 Chromium 内核都能用）
 *  原理：用基准字体（monospace）测某个字符串的宽度，再用候选字体兜底测一次，
 *       如果宽度不同 → 候选字体确实安装了；相同 → 没装，浏览器 fallback 回基准字体
 */
function fontExistsByCanvas(name) {
  const text = '中文字体测试 mwlmm M The quick brown fox 123';
  const size = 72;
  const baseFonts = ['monospace', 'sans-serif', 'serif'];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const baseWidths = baseFonts.map(b => {
    ctx.font = `${size}px "${b}"`;
    return ctx.measureText(text).width;
  });
  for (let i = 0; i < baseFonts.length; i++) {
    ctx.font = `${size}px "${name.replace(/"/g, '')}", "${baseFonts[i]}"`;
    const w = ctx.measureText(text).width;
    if (w !== baseWidths[i]) return true;
  }
  return false;
}

/** 探测一遍候选字体，返回本机已安装的列表 */
function detectSystemFonts() {
  const found = [];
  for (const name of SYSTEM_FONT_CANDIDATES) {
    if (fontExistsByCanvas(name)) found.push({ name });
  }
  // 去重（不同 alias 同一字体名）
  const seen = new Set();
  const dedup = found.filter(f => {
    const k = f.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  return dedup;
}

function loadCachedSystemFonts() {
  try {
    const raw = localStorage.getItem('zhinote-sys-fonts');
    if (raw) _detectedSystemFonts = JSON.parse(raw);
  } catch (_) {}
}
function saveCachedSystemFonts(list) {
  try { localStorage.setItem('zhinote-sys-fonts', JSON.stringify(list || [])); } catch (_) {}
}
function getDetectedSystemFonts() { return _detectedSystemFonts || []; }
function refreshDetectedSystemFonts() {
  _detectedSystemFonts = detectSystemFonts();
  saveCachedSystemFonts(_detectedSystemFonts);
  return _detectedSystemFonts;
}
window.refreshDetectedSystemFonts = refreshDetectedSystemFonts;
window.getDetectedSystemFonts = getDetectedSystemFonts;

function applyFontFamily(id) {
  // 优先按预设 id 查；没有就把 id 当作字体名直接用（系统字体走这条）
  const preset = CONTENT_FONTS.find(x => x.id === id);
  if (preset) {
    const stack = preset.stack || '';
    document.documentElement.style.setProperty('--font-content',
      stack ? stack : 'var(--font-ui)');
    return;
  }
  if (id) {
    document.documentElement.style.setProperty('--font-content',
      `"${id.replace(/"/g, '')}", var(--font-ui)`);
  } else {
    document.documentElement.style.setProperty('--font-content', 'var(--font-ui)');
  }
}

const CLOZE_COLOR_MAP = {
  black:  { mask: 'var(--text)', reveal: 'rgba(255,200,0,0.35)' },
  yellow: { mask: '#e0b62e', reveal: 'rgba(255,230,100,0.4)' },
  red:    { mask: '#e08a8a', reveal: 'rgba(255,150,150,0.32)' },
  green:  { mask: '#6cb98c', reveal: 'rgba(110,210,150,0.32)' },
  blue:   { mask: '#7aa6dd', reveal: 'rgba(130,180,255,0.32)' },
};
function applyClozeColor(id) {
  const c = CLOZE_COLOR_MAP[id] || CLOZE_COLOR_MAP.black;
  document.documentElement.style.setProperty('--cloze-mask-bg', c.mask);
  document.documentElement.style.setProperty('--cloze-reveal-bg', c.reveal);
}

/** 大纲面板位置：left（默认，main 左侧）/ right（最右）。靠 #app 上的 class + flex order 实现。 */
function applyOutlinePosition(pos) {
  const app = document.getElementById('app');
  if (app) app.classList.toggle('outline-right', pos === 'right');
}

function applySavedSettings() {
  // 优先读 localStorage（Quicker 变量异步、可能被云端覆盖；localStorage 是这台设备的"最后一选"）
  const theme = (localStorage.getItem('zhinote-theme') || storage.getSetting('theme') || 'light');
  applyTheme(theme);
  applyFontFamily(storage.getSetting('fontFamily') || localStorage.getItem('zhinote-font') || '');
  applyClozeColor(storage.getSetting('clozeColor') || 'black');
  applyOutlinePosition(storage.getSetting('outlinePosition') || 'left');

  const w = storage.getSetting('sidebarWidth');
  if (w) document.documentElement.style.setProperty('--sidebar-width', w + 'px');
  const ow = storage.getSetting('outlineWidth');
  if (ow) document.documentElement.style.setProperty('--outline-width', ow + 'px');

  const lh = parseFloat(storage.getSetting('lineHeight')) || 1.5;
  document.documentElement.style.setProperty('--editor-line-height', String(lh));

  applyEditorPadding(storage.getSetting('editorPadding') || 1);

  const fs = storage.getSetting('fontSize') || 14;
  document.documentElement.style.setProperty('--editor-font-size', fs + 'px');
  applyEditorFontSize(fs);

  // 大纲默认关闭
  const outlineOpen = storage.getSetting('outlineOpen');
  if (outlineOpen === true) {
    document.getElementById('outline-panel').classList.remove('hidden');
  }

  if (storage.getSetting('sidebarCollapsed')) {
    document.body.classList.add('sidebar-collapsed');
  }
}

function expandAncestors(id) {
  const chain = storage.getAncestors(id);
  for (const n of chain.slice(0, -1)) storage.setExpanded(n.id, true);
}

/** 屏蔽 Ctrl+滚轮缩放窗口（WebView2 默认会缩放整个 page，让 UI 错位且很难复原）
 *  改为快捷键控制编辑区字号：
 *  - Ctrl + +/=  → 编辑区字号 +1
 *  - Ctrl + -    → 编辑区字号 -1
 *  - Ctrl + 0    → 复位为 14px
 *  - Ctrl + 滚轮 → 调整编辑区字号（不缩放整个窗口）
 */
function applyEditorFontSize(px, lhOverride) {
  let style = document.getElementById('zhinote-editor-font-size');
  if (!style) {
    style = document.createElement('style');
    style.id = 'zhinote-editor-font-size';
    document.head.appendChild(style);
  }
  const lh = lhOverride != null ? lhOverride : (parseFloat(storage.getSetting('lineHeight')) || 1.5);
  style.textContent = `
    #editor .ProseMirror {
      font-size: ${px}px !important;
      line-height: ${lh} !important;
    }
  `;
}
window.applyEditorFontSize = applyEditorFontSize;

/** 应用编辑区行间距（与字号共用同一个注入 style，读取最新设置后重写） */
function applyEditorLineHeight(lh) {
  if (lh != null) storage.setSetting('lineHeight', lh);
  document.documentElement.style.setProperty('--editor-line-height', String(parseFloat(lh) || 1.5));
  const px = parseInt(storage.getSetting('fontSize') || 14, 10);
  applyEditorFontSize(px);
}
window.applyEditorLineHeight = applyEditorLineHeight;

/** 应用编辑区页边距（顶部/左/右一致，单位 em） */
function applyEditorPadding(em) {
  const v = parseFloat(em);
  document.documentElement.style.setProperty('--editor-pad', (isFinite(v) ? v : 1) + 'em');
}
window.applyEditorPadding = applyEditorPadding;

function installEditorZoomShortcuts() {
  const MIN_SIZE = 11, MAX_SIZE = 28, DEFAULT_SIZE = 14;
  const apply = (size) => {
    const v = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(size)));
    storage.setSetting('fontSize', v);
    document.documentElement.style.setProperty('--editor-font-size', v + 'px');
    applyEditorFontSize(v);
    // 用同 id 的 toast，多次按只显示一条会变文字，不会堆叠
    if (window.toast) toast(`编辑区字号 ${v}px`, 'info', { id: 'editor-zoom', duration: 1200 });
  };
  const cur = () => parseInt(storage.getSetting('fontSize') || DEFAULT_SIZE, 10);

  // 1) 屏蔽浏览器默认 Ctrl+滚轮 / Ctrl+'+' / Ctrl+'-' / Ctrl+0 整页缩放
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      apply(cur() + (e.deltaY < 0 ? 1 : -1));
    }
  }, { passive: false, capture: true });

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    // = 和 + 都触发放大；- 和 _ 都触发缩小
    if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') {
      e.preventDefault(); apply(cur() + 1);
    } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
      e.preventDefault(); apply(cur() - 1);
    } else if (e.key === '0' || e.code === 'Numpad0') {
      e.preventDefault(); apply(DEFAULT_SIZE);
    }
  }, true);
}

function wireEvents() {
  window.addEventListener('beforeunload', () => {
    try { editor.flushSave(); } catch (_) {}
  });

  installEditorZoomShortcuts();

  document.getElementById('btn-new-root').addEventListener('click', () => {
    const n = storage.create({ parentId: null, title: '' });
    tree.render();
    editor.open(n.id);
  });

  document.getElementById('btn-new-welcome').addEventListener('click', () => {
    const n = storage.create({ parentId: null, title: '' });
    tree.render();
    editor.open(n.id);
  });

  document.getElementById('btn-cmd-welcome').addEventListener('click', () => palette.open());
  document.getElementById('btn-switch-welcome')?.addEventListener('click', (e) => openWorkspaceSwitcher(e.currentTarget));
  document.getElementById('btn-template-welcome').addEventListener('click', async (e) => {
    const clickPos = { x: e.clientX, y: e.clientY };
    const n = storage.create({ parentId: null, title: '' });
    tree.render();
    await editor.open(n.id);
    setTimeout(() => template.openQuickPick(clickPos), 200);
  });
  document.getElementById('btn-cmd-palette').addEventListener('click', () => palette.open());
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('btn-readonly').addEventListener('click', toggleReadonlyMode);
  document.getElementById('btn-pin').addEventListener('click', toggleCurrentPin);

  document.getElementById('btn-search').addEventListener('click', () => {
    if (search.isActive()) search.deactivate();
    else search.activate();
  });
  document.getElementById('btn-search-close').addEventListener('click', () => search.deactivate());
  document.getElementById('search-input').addEventListener('input', (e) => search.handleInput(e));
  document.getElementById('btn-search-prev')?.addEventListener('click', () => search.goPrevMatch());
  document.getElementById('btn-search-next')?.addEventListener('click', () => search.goNextMatch());
  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) search.goPrevMatch();
      else search.goNextMatch();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // 复用命令面板的「←→ 切命中」：仅当光标在输入末尾（无文字编辑意图）时接管，
      // 切换「当前选中行」的命中（就地预览，已打开的笔记编辑区也实时滚动）。
      const input = e.target;
      const atEnd = input.selectionStart === input.selectionEnd
        && input.selectionStart === (input.value || '').length;
      if (atEnd && search.navActiveHit && search.navActiveHit(e.key === 'ArrowLeft' ? -1 : 1)) {
        e.preventDefault();
      }
    }
  });

  document.getElementById('btn-collapse-all').addEventListener('click', () => {
    if (storage.hasExpandedNodes()) tree.collapseAllAnimated();
    else tree.expandAllAnimated();
  });

  document.getElementById('btn-trash').addEventListener('click', () => tree.showTrash());
  document.getElementById('btn-trash').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const cur = storage.getSetting('showTrashBadge') !== false;
    storage.setSetting('showTrashBadge', !cur);
    if (window.updateTrashBadge) window.updateTrashBadge();
    toast(cur ? '已隐藏回收站红点' : '已显示回收站红点', 'success');
  });
  document.getElementById('workspace-switcher').addEventListener('click', (e) => {
    e.stopPropagation();
    // toggle：再次点击切换器自身 → 收起已展开的弹窗
    const open = document.querySelector('.workspace-popup');
    if (open) {
      open.remove();
      e.currentTarget.classList.remove('is-open');
      return;
    }
    openWorkspaceSwitcher(e.currentTarget);
  });
  refreshWorkspaceSwitcher();
  storage.on('change', (info) => {
    if (info.type === 'workspace' || info.type === 'workspaces') refreshWorkspaceSwitcher();
  });

  document.getElementById('btn-templates').addEventListener('click', (e) => {
    template.openQuickPick(e.currentTarget);
  });
  document.getElementById('btn-templates').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    template.openManager();
  });

  document.getElementById('btn-export').addEventListener('click', requestExport);
  document.getElementById('btn-import').addEventListener('click', requestImport);

  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-theme')?.addEventListener('click', (e) => openThemePopover(e.currentTarget));

  // 标题栏 — 关闭按钮实际行为是"隐藏窗口"，对用户透明
  document.getElementById('btn-titlebar-min').addEventListener('click', requestMinimize);
  document.getElementById('btn-titlebar-max').addEventListener('click', requestMaximize);
  document.getElementById('btn-titlebar-close').addEventListener('click', requestHideWindow);
  document.getElementById('btn-titlebar-pin')?.addEventListener('click', requestToggleTopmost);
  setupTopResizeGrip();

  // 标题栏图标 — 点击更换
  const appIconEl = document.querySelector('.titlebar-app-icon');
  if (appIconEl) {
    appIconEl.style.cursor = 'pointer';
    appIconEl.style.setProperty('-webkit-app-region', 'no-drag');
    appIconEl.title = '右键更换图标';
    const _openAppIconPicker = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openIconPicker(appIconEl, {
        currentIcon: storage.getSetting('appIcon') || '📖',
        defaultIcon: '📖',
        title: '右键更换图标',
        onPick: (icon) => {
          const v = icon || '📖';
          storage.setSetting('appIcon', v);
          appIconEl.textContent = v;
        },
      });
    };
    appIconEl.addEventListener('click', _openAppIconPicker);
    appIconEl.addEventListener('contextmenu', _openAppIconPicker);
    const saved = storage.getSetting('appIcon');
    if (saved) appIconEl.textContent = saved;
  }

  // 标题栏文字 — 点击修改自定义名称
  const appTitleEl = document.querySelector('.titlebar-title-text');
  if (appTitleEl) {
    appTitleEl.style.cursor = 'pointer';
    appTitleEl.style.setProperty('-webkit-app-region', 'no-drag');
    const savedTitle = storage.getSetting('appTitle');
    if (savedTitle) appTitleEl.textContent = savedTitle;
    appTitleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = appTitleEl.textContent;
      input.maxLength = 20;
      input.style.cssText = 'font-size:inherit;font-weight:inherit;color:inherit;background:var(--bg-tertiary);border:1px solid var(--accent);border-radius:4px;padding:0 4px;width:80px;outline:none;-webkit-app-region:no-drag;';
      appTitleEl.replaceWith(input);
      input.focus();
      input.select();
      const commit = () => {
        const v = input.value.trim() || '枝记';
        appTitleEl.textContent = v;
        storage.setSetting('appTitle', v);
        input.replaceWith(appTitleEl);
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
        if (ke.key === 'Escape') { ke.preventDefault(); input.value = appTitleEl.textContent; input.blur(); }
      });
    });
  }

  document.getElementById('btn-outline-toggle').addEventListener('click', toggleOutline);
  document.getElementById('btn-cloze').addEventListener('click', toggleClozeMode);

  // 顶栏云同步按钮：左键智能同步，右键打开菜单
  const btnCloud = document.getElementById('btn-cloud-sync');
  if (btnCloud) {
    btnCloud.addEventListener('click', smartCloudSync);
    btnCloud.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCloudSyncMenu(btnCloud);
    });
  }

  // 顶栏标题输入：实时落库改名，但**不再每次 tree.render()**
  // 原来每键都全树重渲 → 左侧侧栏疯狂闪烁，且光标位置易丢
  // 现在 storage.rename 加 silent → 不触发 storage.on('change') 监听者重渲
  // 改用 tree.updateNodeTitle 就地改写文本（无重渲、无闪烁、无滚动跳）
  const titleInput = document.getElementById('title-input');
  titleInput.addEventListener('input', (e) => {
    const id = editor.currentId();
    if (!id) return;
    const title = e.target.value || '无标题';
    storage.rename(id, title, { silent: true });
    if (window.tree?.updateNodeTitle) {
      tree.updateNodeTitle(id, title);
    }
    // 面包屑只显示路径不含当前标题，所以不用更新
  });
  // 失焦不再做整树重渲：标题在 input 阶段已通过 tree.updateNodeTitle 同步
  // 到侧栏行 + 置顶行，排序又是手动顺序（不按标题），无需重渲。
  // 之前那次 setTimeout(tree.render) 会在点击周期内重建侧栏 DOM，
  // 把刚点击的行 / 删除确认气泡的锚点销毁，造成"要点两次"。已彻底去掉。
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      editor.focus();
    }
  });

  // 右键菜单遮罩层
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu')) tree.hideContextMenu();
  });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.tree-row') && !e.target.closest('.tree-note-icon')) {
      tree.hideContextMenu();
    }
    // Suppress browser default context menu everywhere except inputs
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.target.isContentEditable) return;
    // Editor area handled by initEditorContextMenu; tree rows by tree.js
    if (e.target.closest('#editor .ProseMirror')) return;
    if (e.target.closest('.tree-row') || e.target.closest('.tree-note-icon')) return;
    // 其余区域（标题栏/工具栏/空白等）一律屏蔽系统原生右键菜单，保持氛围统一
    e.preventDefault();
  });

  // 侧栏拖拽调宽
  setupResizer();
  setupOutlineResizer();
  setupMobileLayout();

  // 防止侧栏输入时 Ctrl+Z/Y 冒泡到 Tiptap
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y')) {
        e.stopPropagation();
      }
    }, true);
  }

  // 侧边栏滚轮切换笔记
  const treeContainer = document.getElementById('tree-container');
  if (treeContainer) {
    let _wheelThrottle = 0;
    treeContainer.addEventListener('wheel', (e) => {
      const now = Date.now();
      if (now - _wheelThrottle < 60) return;
      _wheelThrottle = now;
      // 置顶区（.is-pinned-section）不参与滚轮切换：置顶笔记本来就在「全部」
      // 列表里按原位置出现一次，滚轮只走主列表即可，置顶项原地静止、不再被跳过。
      const rows = Array.from(treeContainer.querySelectorAll('.tree-row:not(.is-pinned-section)'));
      if (!rows.length) return;
      const curId = editor.currentId();
      const curIdx = rows.findIndex(r => r.dataset.id === curId);
      let nextIdx;
      if (e.deltaY > 0) nextIdx = curIdx < rows.length - 1 ? curIdx + 1 : 0;
      else nextIdx = curIdx > 0 ? curIdx - 1 : rows.length - 1;
      const nextId = rows[nextIdx]?.dataset.id;
      if (nextId && nextId !== curId) {
        // 不带 forceBody：与「点击切换」一致地走失焦逻辑，避免光标落进正文文首。
        editor.open(nextId);
        tree.render();
        // tree.render() 已重建侧栏 DOM，旧的 rows[nextIdx] 节点已脱离文档，
        // 对它调用 scrollIntoView 会失效 → 侧栏不跟随高亮项滚动。列表一长、
        // 又有置顶区占据顶部高度时，选中项很快跑出视口，表现为“卡住 / 上翻无反应”。
        // 必须按 id 重新查询新行再滚动。
        const freshRow = treeContainer.querySelector(
          `.tree-row[data-id="${CSS.escape(nextId)}"]:not(.is-pinned-section)`
        );
        freshRow?.scrollIntoView({ block: 'nearest' });
      }
      e.preventDefault();
    }, { passive: false });
  }

  // 全局快捷键（编辑区专用快捷键用捕获阶段，先于 TipTap 内置键位，走 execCommand 统一逻辑）
  document.addEventListener('keydown', onEditorShortcutKey, true);
  document.addEventListener('keydown', onGlobalKey);

  // 全局 Tab 守卫：阻止浏览器把焦点移到工具栏图标（焦点遍历）。
  // 输入框/文本域放行原生 Tab；编辑区（contentEditable）交给编辑器自己的 Tab 处理
  // （缩进/跳格/插空格，且其内部已 preventDefault 防焦点跳走），这里不插手以免吞掉插空格。
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const t = e.target;
    const tag = (t && t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (t && t.isContentEditable) return;
    if (t && t.closest && t.closest('#editor .ProseMirror')) return;
    e.preventDefault();
  }, true);
  // 记录鼠标位置：供快捷键唤出弹层（如笔记本切换）在光标附近显示
  document.addEventListener('mousemove', (e) => { _lastMousePos.x = e.clientX; _lastMousePos.y = e.clientY; }, { passive: true });
}

// 最近一次鼠标位置（快捷键唤出弹层定位用）
const _lastMousePos = { x: Math.round(window.innerWidth / 2), y: 120 };

/** 快速切换到最近打开的上一篇笔记（Ctrl+Tab）。
 *  recent[0] 通常是当前笔记，recent[1] 是上一篇。找不到则退回命令面板。 */
function quickSwitchNote() {
  const recent = (storage.getSetting('recent') || []).filter(id => storage.get(id));
  const curId = editor.currentId?.();
  const target = recent.find(id => id !== curId);
  if (target) {
    tree.expandAncestors?.(target);
    editor.open(target);
    tree.render();
    setTimeout(() => tree.scrollToNote?.(target), 50);
  } else {
    palette.open();
  }
}

/** 光标在编辑器内（用于拦截 TipTap 默认键位、改走带列表修复的 execCommand） */
function _isEditorKeyTarget() {
  const ae = document.activeElement;
  return !!(ae && ae.closest?.('.ProseMirror') && editor.instance?.());
}

/** 编辑区快捷键：引用、分割线、挖空标记（捕获阶段，优先于 TipTap 内置处理） */
function onEditorShortcutKey(e) {
  if (!_isEditorKeyTarget()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key;
  const isB = key === 'B' || key === 'b';
  const isM = key === 'M' || key === 'm';
  const isH = key === 'H' || key === 'h';
  // 引用：Ctrl+Shift+B（文档约定）与 Alt+Shift+B（用户习惯）；均走 execCommand 以支持列表
  if (isB && e.shiftKey && (ctrl || (e.altKey && !ctrl))) {
    e.preventDefault();
    e.stopImmediatePropagation();
    editor.execCommand('toggleBlockquote');
    return;
  }
  if (isH && ctrl && e.shiftKey && !e.altKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    editor.execCommand('setHorizontalRule');
    return;
  }
  if (isM && e.altKey && !ctrl && !e.shiftKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    toggleMarkOnSelection();
    return;
  }
}

/** 焦点是否落在「非主编辑区」的可输入控件上（标题栏 / 搜索框 / 命令面板输入框 / 其他 input、textarea
 *  / 不属于 .ProseMirror 的 contenteditable）。这类区域的编辑快捷键应走原生、不抢给编辑区。 */
function _isNonEditorTextTarget() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = ae.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (ae.isContentEditable && !ae.closest?.('.ProseMirror')) return true;
  return false;
}

function onGlobalKey(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === 'a' || e.key === 'A') && !e.shiftKey) {
    // 焦点在标题栏/输入框/命令面板等处 → 让原生全选作用于当前控件，不抢给编辑区
    if (_isNonEditorTextTarget()) return;
    if (editor.currentId?.()) {
      e.preventDefault();
      // 代码块内先选块内文字，再次按才全选整篇
      editor.execCommand('selectAllSmart');
    }
    return;
  }
  if (ctrl && e.key === 'Tab') {
    // 快速切换到上一篇笔记（类似 Alt+Tab）
    e.preventDefault();
    quickSwitchNote();
    return;
  }
  if (ctrl && !e.altKey && (e.key === 'p' || e.key === 'P' || e.code === 'KeyP')) {
    // 用 e.code 兜底匹配：中文输入法激活时 e.key 是 'Process'、大写锁定时是 'P'，
    // 只匹配 'p' 会漏掉 → preventDefault 没执行 → 浏览器弹出打印界面。
    e.preventDefault();
    if (!e.shiftKey) palette.open();
  } else if (ctrl && e.key === 'f') {
    e.preventDefault();
    search.activate();
  } else if (ctrl && e.altKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
    // 新建笔记：Ctrl+Alt+N（与「切换/新建笔记本」Ctrl+Shift+N 区分，避免误触）
    e.preventDefault();
    const n = storage.create({ parentId: null, title: '' });
    tree.render();
    editor.open(n.id);
  } else if (ctrl && e.key === 's') {
    e.preventDefault();
    editor.flushSave();
    toast('已保存', 'success');
  } else if (ctrl && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
    e.preventDefault();
    toggleOutline();
  } else if (ctrl && e.key === '\\') {
    e.preventDefault();
    toggleSidebar();
  } else if (ctrl && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
    // 阅读模式改用 Ctrl+Shift+E：把 Ctrl+E 让给行内代码（TipTap 的 Mod-e），避免二者同时触发
    e.preventDefault();
    toggleReadonlyMode();
  } else if (ctrl && e.key === ';') {
    e.preventDefault();
    const emojiBtn = document.querySelector('#editor');
    if (emojiBtn) toggleEmojiPicker(emojiBtn);
  } else if (ctrl && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
    // 切换 / 新建笔记本：在鼠标附近唤出（像表情窗一样跟着光标）
    e.preventDefault();
    const open = document.querySelector('.workspace-popup');
    if (open) { open.remove(); }
    else openWorkspaceSwitcher(null, { x: _lastMousePos.x, y: _lastMousePos.y });
  } else if (e.key === 'F10') {
    e.preventDefault();
    toggleFocusMode();
  } else if (e.key === 'F11') {
    e.preventDefault();
    toggleClozeMode();
  } else if (ctrl && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    e.preventDefault();
    toggleClozeMode();
  } else if (e.key === 'Delete' && !isEditing(e.target)) {
    const id = editor.currentId();
    if (id) {
      e.preventDefault();
      const anchor = document.querySelector(`.tree-row[data-id="${id}"]`)
        || document.getElementById('btn-titlebar-close');
      tree.requestDelete(id, anchor);
    }
  } else if (e.key === 'Escape') {
    if (closeAnyOverlay()) return;
    if (window.tree?.hasSelection?.()) { window.tree.clearSelection(); return; }
    if (search.isActive()) { search.deactivate(); return; }
  }
}

/** 统一的确认弹窗（替代 native confirm()，使用主 modal 风格） */
function uiConfirm({ title = '确认', message = '', okText = '确认', cancelText = '取消', okClass = 'primary-btn' } = {}) {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.style.cssText = 'padding:4px 0;color:var(--text);font-size:14px;line-height:1.6;white-space:pre-wrap;';
    body.textContent = message;
    let done = false;
    openModal({
      title, body,
      footer: [
        { label: cancelText, class: 'secondary-btn', onClick: () => { done = true; closeModal(); resolve(false); } },
        { label: okText, class: okClass, onClick: () => { done = true; closeModal(); resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}
window.uiConfirm = uiConfirm;

function _fmtBytes(b) {
  if (!b || b <= 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

/** 「从云端恢复笔记」独立浮层（不复用 modal-overlay，避免覆盖设置面板）。
 *  found: [{id,title,updatedAt,size,_note}]；done(n) 在完成/取消后回调（恢复或删除的条数） */
// 点击「管理云端笔记」后立即弹出的扫描遮罩（先有窗口+转圈，再填充内容）
function openCloudScanning() {
  const overlay = document.createElement('div');
  overlay.className = 'recover-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;min-height:100dvh;'
    + 'background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;'
    + 'z-index:100000;opacity:0;transition:opacity .16s ease;';
  // 复用管理弹窗的外框尺寸：先把框架（标题/底部按钮）显示出来，仅内容区转圈
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--bg-elevated,var(--bg));color:var(--text);width:min(560px,94vw);'
    + 'height:min(600px,82vh);display:flex;flex-direction:column;border:1px solid var(--border);'
    + 'border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.28);overflow:hidden;'
    + 'transform:translateY(6px);transition:transform .16s ease;';
  const header = document.createElement('div');
  header.style.cssText = 'padding:14px 18px;font-size:15px;font-weight:600;border-bottom:1px solid var(--border);';
  header.textContent = '云端数据管理';
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'zn-scan-card';
  bodyWrap.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;';
  const spinner = document.createElement('div'); spinner.className = 'zn-spinner';
  const text = document.createElement('div'); text.className = 'zn-scan-text'; text.textContent = '正在扫描云端…';
  bodyWrap.appendChild(spinner); bodyWrap.appendChild(text);
  const foot = document.createElement('div');
  foot.style.cssText = 'padding:10px 18px 14px;display:flex;justify-content:flex-end;border-top:1px solid var(--border);';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button'; closeBtn.className = 'secondary-btn';
  closeBtn.style.cssText = 'padding:0 16px;height:34px;font-size:13px;';
  closeBtn.textContent = '关闭';
  foot.appendChild(closeBtn);
  card.appendChild(header); card.appendChild(bodyWrap); card.appendChild(foot);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { overlay.style.opacity = '1'; card.style.transform = 'translateY(0)'; });
  let closed = false;
  const close = (instant) => {
    if (closed) return; closed = true;
    if (instant) { overlay.remove(); return; }
    overlay.style.opacity = '0'; card.style.transform = 'translateY(6px)';
    setTimeout(() => overlay.remove(), 180);
  };
  closeBtn.addEventListener('click', () => close(false));
  const setError = (msg) => {
    spinner.style.display = 'none';
    text.style.color = 'var(--danger)';
    text.textContent = msg || '扫描失败';
  };
  return { close, setError, setText: (t) => { text.textContent = t; } };
}

function openRecoverDialog(found, done, opts) {
  const onDone = typeof done === 'function' ? done : () => {};
  const onMirrorDone = (opts && typeof opts.onMirrorDone === 'function') ? opts.onMirrorDone : () => {};
  const summary = (opts && opts.summary) || null;
  // 全部云端笔记（含本地已有/回收站/墓碑）
  const allItems = (opts && Array.isArray(opts.all)) ? opts.all : found.slice();
  const remainingOf = (arr) => arr.filter(it => !it._removed);

  let currentTab = 'all';   // 'all' | 'missing' | 'overview'，默认「云端全部」
  let mode = 'all';         // 列表模式（all/missing）
  let delArmed = false, delTimer = null;
  let mirrorArmed = false, mirrorTimer = null;
  let totalRecovered = 0;
  let closed = false;
  let statusTimer = null;
  let bgDeleteChain = Promise.resolve(); // 后台删除串行队列（避免并发改写 manifest 互相覆盖）
  let bgDeleting = 0;                     // 后台待删除剩余篇数
  const collapsed = new Set();            // 已折叠的父笔记 id（像侧栏一样可展开/折叠）
  // 勾选状态挂在 item 上（it._sel），折叠后仍保留、批量操作也能覆盖被折叠隐藏的项
  const defaultSel = (it) => (it.status === 'missing' || !it.status);
  const isSel = (it) => (it._sel === undefined ? defaultSel(it) : it._sel);

  const overlay = document.createElement('div');
  overlay.className = 'recover-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;min-height:100dvh;'
    + 'background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;'
    + 'z-index:100000;opacity:0;transition:opacity .16s ease;';

  const card = document.createElement('div');
  // 固定高度：三个标签切换时弹窗大小保持一致（参考设置面板，内容在内部滚动）
  card.style.cssText = 'background:var(--bg-elevated,var(--bg));color:var(--text);width:min(560px,94vw);'
    + 'height:min(600px,82vh);display:flex;flex-direction:column;border:1px solid var(--border);'
    + 'border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.28);overflow:hidden;'
    + 'transform:translateY(6px);transition:transform .16s ease;';

  // ── 顶部：标题 + 三个标签栏 ────────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = 'padding:14px 18px 0;';
  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:12px;';
  const _provLabels = { jianguoyun: '坚果云', koofr: 'Koofr', infinicloud: 'InfiniCLOUD', custom: '自定义 WebDAV' };
  const _provName = _provLabels[storage.getSetting('webdavProvider') || ''] || '';
  titleEl.textContent = _provName ? `云端数据管理 · ${_provName}` : '云端数据管理';
  const tabbar = document.createElement('div');
  tabbar.className = 'rcv-tabs';
  const tabAll = document.createElement('button'); tabAll.className = 'rcv-tab';
  const tabMissing = document.createElement('button'); tabMissing.className = 'rcv-tab';
  const tabMaint = document.createElement('button'); tabMaint.className = 'rcv-tab';
  const tabOverview = document.createElement('button'); tabOverview.className = 'rcv-tab';
  tabAll.type = tabMissing.type = tabMaint.type = tabOverview.type = 'button';
  tabbar.appendChild(tabAll); tabbar.appendChild(tabMissing); tabbar.appendChild(tabMaint); tabbar.appendChild(tabOverview);
  header.appendChild(titleEl); header.appendChild(tabbar);

  // ── 列表区：工具条（计数 + 折叠全部 + 全选）+ 列表 ──────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'rcv-toolbar';
  const countEl = document.createElement('span'); countEl.className = 'rcv-count';
  const toolRight = document.createElement('span');
  toolRight.style.cssText = 'display:inline-flex;align-items:center;gap:10px;';
  const foldBtn = document.createElement('button');
  foldBtn.type = 'button'; foldBtn.className = 'link-btn'; foldBtn.textContent = '折叠全部';
  foldBtn.title = '展开 / 折叠全部'; foldBtn.style.fontSize = '12px';
  const selBtn = document.createElement('button');
  selBtn.type = 'button'; selBtn.className = 'link-btn'; selBtn.textContent = '全选';
  selBtn.title = '全选 / 取消全选'; selBtn.style.fontSize = '12px';
  toolRight.appendChild(foldBtn); toolRight.appendChild(selBtn);
  toolbar.appendChild(countEl); toolbar.appendChild(toolRight);
  const list = document.createElement('div');
  list.className = 'rcv-list';

  // ── 概览面板 ──────────────────────────────────────────────────
  const overviewPanel = document.createElement('div');
  overviewPanel.className = 'rcv-overview';
  overviewPanel.style.display = 'none';

  // ── 维护面板（用本地覆盖云端 + 同步留底）──────────────────────
  const maintPanel = document.createElement('div');
  maintPanel.className = 'rcv-overview';
  maintPanel.style.display = 'none';

  // ── 弹窗内状态行（始终可见，不被 toast 遮挡）────────────────────
  const statusEl = document.createElement('div');
  statusEl.className = 'rcv-status';
  statusEl.style.display = 'none';
  function setStatus(text, kind) {
    if (closed) return;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    statusEl.textContent = text || '';
    statusEl.style.display = text ? 'block' : 'none';
    statusEl.style.color = kind === 'error' ? 'var(--danger)'
      : kind === 'success' ? 'var(--success)' : 'var(--text-secondary)';
    if (text && (kind === 'success' || kind === 'info')) {
      statusTimer = setTimeout(() => { statusEl.textContent = ''; statusEl.style.display = 'none'; }, 4500);
    }
  }

  // ── 底部按钮 ──────────────────────────────────────────────────
  const foot = document.createElement('div');
  foot.style.cssText = 'padding:10px 18px 14px;display:flex;gap:8px;align-items:center;';
  const btnBase = 'margin-top:0;padding:0 16px;height:34px;line-height:1;font-size:13px;border-radius:var(--radius);'
    + 'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;white-space:nowrap;';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button'; cancelBtn.className = 'secondary-btn'; cancelBtn.style.cssText = btnBase; cancelBtn.textContent = '关闭';
  const delBtn = document.createElement('button');
  // 描边式危险按钮，弱化鲜艳度
  delBtn.type = 'button'; delBtn.className = '';
  delBtn.style.cssText = btnBase + 'margin-left:auto;background:transparent;color:var(--danger);border:1px solid var(--danger);';
  const okBtn = document.createElement('button');
  okBtn.type = 'button'; okBtn.className = 'primary-btn'; okBtn.style.cssText = btnBase;
  foot.appendChild(cancelBtn); foot.appendChild(delBtn); foot.appendChild(okBtn);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-top:1px solid var(--border);';
  body.appendChild(toolbar);
  body.appendChild(list);
  body.appendChild(maintPanel);
  body.appendChild(overviewPanel);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(statusEl);
  card.appendChild(foot);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  if (opts && opts.instant) {
    // 从「扫描中」框架无感切换：直接显示，不做淡入/位移，避免闪一下
    overlay.style.transition = 'none';
    card.style.transition = 'none';
    overlay.style.opacity = '1';
    card.style.transform = 'translateY(0)';
  } else {
    requestAnimationFrame(() => { overlay.style.opacity = '1'; card.style.transform = 'translateY(0)'; });
  }

  // ── 工具函数 ──────────────────────────────────────────────────
  const _whenStr = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const STATUS_LABEL = { local: '本地已有', trash: '回收站', deleted: '已删除' };
  const paintRow = (it) => {
    if (!it._t || !it._sub) return;
    const when = _whenStr(it.updatedAt);
    const size = _fmtBytes(it.size);
    if (it.title) {
      it._t.textContent = it.title;
      it._t.style.color = '';
      it._sub.textContent = [when, size].filter(Boolean).join(' · ');
    } else {
      it._t.textContent = it._titleLoaded ? '无标题' : (when || '（未知时间）');
      it._t.style.color = it._titleLoaded ? '' : 'var(--text)';
      it._sub.textContent = it._titleLoaded ? size : [size, '标题未读取'].filter(Boolean).join(' · ');
    }
  };

  // 依据 manifest 的 parentId，在「当前展示集合」内构建层级（父不在集合内则视为顶层）。
  // 折叠的父节点：其子树标记为已放置但不输出（隐藏），避免被当成孤儿重复列出。
  function orderTree(items) {
    const byId = new Map(items.map(it => [it.id, it]));
    const kids = new Map();
    const ROOT = '__root__';
    for (const it of items) {
      const key = (it.parentId && byId.has(it.parentId)) ? it.parentId : ROOT;
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(it);
    }
    const out = [];
    const placed = new Set();
    const visit = (it, depth, hidden) => {
      if (placed.has(it.id)) return; // 防环
      placed.add(it.id);
      const childArr = kids.get(it.id) || [];
      const hasChildren = childArr.length > 0;
      if (!hidden) out.push({ it, depth, hasChildren, childCount: childArr.length });
      const childHidden = hidden || collapsed.has(it.id);
      for (const k of childArr) visit(k, depth + 1, childHidden);
    };
    for (const r of (kids.get(ROOT) || [])) visit(r, 0, false);
    for (const it of items) if (!placed.has(it.id)) out.push({ it, depth: 0, hasChildren: kids.has(it.id), childCount: (kids.get(it.id) || []).length });
    return out;
  }

  function buildRow(it, depth, hasChildren, childCount) {
    const row = document.createElement('label');
    row.className = 'rcv-row' + (depth > 0 ? ' rcv-child' : '');
    row.style.paddingLeft = (12 + depth * 16) + 'px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'rcv-cb';
    cb.checked = isSel(it);
    cb._item = it;
    // 展开/折叠把手（照抄侧边栏 .tree-chevron：SVG 三角，展开时旋转 90°）
    const caret = document.createElement('button');
    caret.type = 'button';
    const isExpanded = hasChildren && !collapsed.has(it.id);
    caret.className = 'rcv-caret' + (hasChildren ? ' has' : '') + (isExpanded ? ' expanded' : '');
    if (hasChildren) {
      caret.innerHTML = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M4 2.5 L8.5 6 L4 9.5 Z"/></svg>';
      caret.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (collapsed.has(it.id)) collapsed.delete(it.id); else collapsed.add(it.id);
        renderList();
      });
    }
    const meta = document.createElement('div');
    meta.className = 'rcv-meta';
    const t = document.createElement('div');
    t.className = 'rcv-title';
    if (hasChildren) t.style.fontWeight = '600';
    const sub = document.createElement('div');
    sub.className = 'rcv-sub';
    meta.appendChild(t);
    meta.appendChild(sub);
    row.appendChild(caret);
    row.appendChild(cb);
    row.appendChild(meta);
    // 折叠时在父行尾部提示被收起的子项数量
    if (hasChildren && collapsed.has(it.id) && childCount) {
      const cnt = document.createElement('span');
      cnt.className = 'rcv-foldcount';
      cnt.textContent = `${childCount} 项`;
      row.appendChild(cnt);
    }
    if (mode === 'all' && it.status && it.status !== 'missing') {
      const badge = document.createElement('span');
      badge.className = 'rcv-badge';
      badge.textContent = STATUS_LABEL[it.status] || it.status;
      row.appendChild(badge);
    }
    // 行内悬浮操作：恢复 / 删除（单条）
    const acts = document.createElement('span');
    acts.className = 'rcv-actions';
    if (it.status === 'missing' || !it.status) {
      const rb = document.createElement('button');
      rb.type = 'button'; rb.className = 'rcv-act'; rb.textContent = '恢复';
      rb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); doRecover([it]); });
      acts.appendChild(rb);
    }
    const db = document.createElement('button');
    db.type = 'button'; db.className = 'rcv-act rcv-act-del'; db.textContent = '删除';
    let rowDelArmed = false, rowDelTimer = null;
    db.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!rowDelArmed) {
        rowDelArmed = true;
        db.textContent = '确认?';
        rowDelTimer = setTimeout(() => { rowDelArmed = false; db.textContent = '删除'; }, 3000);
        return;
      }
      if (rowDelTimer) { clearTimeout(rowDelTimer); rowDelTimer = null; }
      doDelete([it]);
    });
    acts.appendChild(db);
    row.appendChild(acts);
    it._row = row; it._cb = cb; it._t = t; it._sub = sub;
    paintRow(it);
    return row;
  }
  const viewItems = () => remainingOf(mode === 'all' ? allItems : found);
  // 当前视图里「在集合内还有子项」的父 id 集合（用于折叠/展开全部）
  function parentIdsInView() {
    const items = viewItems();
    const ids = new Set(items.map(it => it.id));
    const parents = new Set();
    for (const it of items) if (it.parentId && ids.has(it.parentId)) parents.add(it.parentId);
    return parents;
  }
  function refreshFoldBtn() {
    const parents = parentIdsInView();
    if (!parents.size) { foldBtn.style.display = 'none'; return; }
    foldBtn.style.display = '';
    const allCollapsed = [...parents].every(id => collapsed.has(id));
    foldBtn.textContent = allCollapsed ? '展开全部' : '折叠全部';
  }
  function renderList() {
    list.innerHTML = '';
    const items = viewItems();
    if (!items.length) {
      list.innerHTML = mode === 'all'
        ? '<div class="rcv-empty">云端没有笔记</div>'
        : '<div class="rcv-empty">本地没有缺失的笔记<br><span style="font-size:12px;">（云端笔记本地都已存在）</span></div>';
    } else {
      orderTree(items).forEach(n => list.appendChild(buildRow(n.it, n.depth, n.hasChildren, n.childCount)));
    }
    refreshFoldBtn();
    refreshCounts();
  }

  const pickedItems = () => viewItems().filter(isSel);
  selBtn.addEventListener('click', () => {
    const items = viewItems();
    const allChecked = items.length > 0 && items.every(isSel);
    items.forEach(it => { it._sel = !allChecked; });
    renderList();
  });
  foldBtn.addEventListener('click', () => {
    const parents = parentIdsInView();
    const allCollapsed = parents.size > 0 && [...parents].every(id => collapsed.has(id));
    if (allCollapsed) { parents.forEach(id => collapsed.delete(id)); }
    else { parents.forEach(id => collapsed.add(id)); }
    renderList();
  });
  list.addEventListener('change', (e) => {
    const cb = e.target;
    if (cb && cb._item) cb._item._sel = cb.checked;
    refreshCounts();
  });

  function disarmDelete() {
    delArmed = false;
    if (delTimer) { clearTimeout(delTimer); delTimer = null; }
  }
  function disarmMirror() {
    mirrorArmed = false;
    if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
  }
  function refreshCounts() {
    const totalShown = viewItems().length;
    const n = pickedItems().length;
    countEl.textContent = totalShown ? `共 ${totalShown} 篇　已选 ${n} 篇` : '';
    okBtn.textContent = n > 0 ? `恢复所选 (${n})` : '恢复所选';
    delBtn.textContent = delArmed ? `确认删除 (${n})？` : (n > 0 ? `删除所选 (${n})` : '删除所选');
    okBtn.disabled = n === 0;
    delBtn.disabled = n === 0;
    okBtn.style.opacity = okBtn.disabled ? '0.5' : '';
    delBtn.style.opacity = delBtn.disabled ? '0.5' : '';
  }
  function removeProcessed(items) {
    for (const it of items) {
      if (!it) continue;
      it._removed = true;
      if (it._row && it._row.parentNode) it._row.remove();
    }
    refreshTabLabels();
    if (!list.querySelector('label')) {
      list.innerHTML = '<div class="rcv-empty">已处理完，没有更多了</div>';
    }
    refreshCounts();
  }

  // ── 标签切换 ──────────────────────────────────────────────────
  function refreshTabLabels() {
    tabAll.textContent = `云端全部 ${remainingOf(allItems).length}`;
    tabMissing.textContent = `本地缺失 ${remainingOf(found).length}`;
    tabMaint.textContent = '维护';
    tabOverview.textContent = '概览';
    tabAll.classList.toggle('active', currentTab === 'all');
    tabMissing.classList.toggle('active', currentTab === 'missing');
    tabMaint.classList.toggle('active', currentTab === 'maint');
    tabOverview.classList.toggle('active', currentTab === 'overview');
  }
  function switchTab(tab) {
    currentTab = tab;
    const isList = (tab === 'all' || tab === 'missing');
    if (isList) mode = tab;
    disarmDelete();
    disarmMirror();
    toolbar.style.display = isList ? 'flex' : 'none';
    list.style.display = isList ? 'block' : 'none';
    overviewPanel.style.display = (tab === 'overview') ? 'block' : 'none';
    maintPanel.style.display = (tab === 'maint') ? 'block' : 'none';
    delBtn.style.display = isList ? 'inline-flex' : 'none';
    okBtn.style.display = isList ? 'inline-flex' : 'none';
    refreshTabLabels();
    if (isList) renderList();
    else if (tab === 'overview') buildOverview();
    else if (tab === 'maint') buildMaint();
  }
  tabAll.addEventListener('click', () => switchTab('all'));
  tabMissing.addEventListener('click', () => switchTab('missing'));
  tabMaint.addEventListener('click', () => switchTab('maint'));
  tabOverview.addEventListener('click', () => switchTab('overview'));

  // ── 概览面板内容 ──────────────────────────────────────────────
  function buildOverview() {
    overviewPanel.innerHTML = '';
    if (!summary) { overviewPanel.innerHTML = '<div class="rcv-empty">暂无概览数据</div>'; return; }
    const when = summary.manifestUpdatedAt
      ? new Date(summary.manifestUpdatedAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    const imgVal = summary.imageCount ? `${_fmtBytes(summary.imageSize)} · ${summary.imageCount} 张` : '0';
    const grid = document.createElement('div');
    grid.className = 'rcv-ov-grid';
    const addRow = (label, valHtml) => {
      const r = document.createElement('div');
      r.className = 'rcv-ov-row';
      r.innerHTML = `<span class="rcv-ov-k">${label}</span><span class="rcv-ov-v">${valHtml}</span>`;
      grid.appendChild(r);
      return r;
    };
    addRow('云端笔记', `${summary.cloudNotes} 篇`);
    addRow('笔记占用', _fmtBytes(summary.cloudSize));
    addRow('图片占用', imgVal);
    addRow('本地笔记', `${summary.localNotes} 篇`);
    // 已删除记录（墓碑）有 30 天自动清理，不再提供手动清理入口（手动清理会让已删笔记在其它设备复活，是 footgun）。
    addRow('已删除记录', `<span id="rcv-tomb-count">${summary.tombstones} 条</span>`);
    addRow('上次更新', when);
    overviewPanel.appendChild(grid);
  }

  // ── 维护面板内容：用本地覆盖云端 + 同步留底 ────────────────────
  function buildMaint() {
    maintPanel.innerHTML = '';

    // 维护：用本地覆盖云端
    const maint = document.createElement('div');
    maint.className = 'rcv-maint';
    maint.style.marginTop = '4px';
    const mt = document.createElement('div'); mt.className = 'rcv-maint-title'; mt.textContent = '覆盖云端';
    const md = document.createElement('div'); md.className = 'rcv-maint-desc';
    md.textContent = '以本设备为准：清掉云端多余笔记并上传本地全部。其它设备下次同步会自动对齐到这份（多余项进它们的同步留底，可找回）。';
    const mBtn = document.createElement('button');
    mBtn.type = 'button'; mBtn.className = 'rcv-btn-soft-danger';
    mBtn.textContent = '覆盖云端';
    maint.appendChild(mt); maint.appendChild(md); maint.appendChild(mBtn);
    maintPanel.appendChild(maint);

    // ── 同步留底 ──────────────────────────────────────────────
    const bk = document.createElement('div');
    bk.className = 'rcv-backup';
    const bkt = document.createElement('div'); bkt.className = 'rcv-maint-title'; bkt.textContent = '同步留底';
    const bkd = document.createElement('div'); bkd.className = 'rcv-maint-desc';
    bkd.textContent = '同步"覆盖/删除本地笔记前"会自动留底。点"还原"把旧内容作为新笔记加回列表，原笔记不受影响。';
    bk.appendChild(bkt); bk.appendChild(bkd);
    const bkList = document.createElement('div'); bkList.className = 'rcv-backup-list';
    bk.appendChild(bkList);
    maintPanel.appendChild(bk);
    const reasonText = { 'clean-download': '被云端版本覆盖', 'remote-delete': '被云端删除', 'overwrite': '被覆盖', 'adopt-reset': '被云端权威覆盖' };
    const backups = (window.webdavSync && window.webdavSync.listLocalBackups) ? window.webdavSync.listLocalBackups() : [];
    if (!backups.length) {
      const empty = document.createElement('div'); empty.className = 'rcv-backup-empty';
      empty.textContent = '暂无留底记录（同步从未覆盖过本地内容）';
      bkList.appendChild(empty);
    } else {
      backups.forEach((b) => {
        const row = document.createElement('div'); row.className = 'rcv-backup-row';
        const info = document.createElement('div'); info.className = 'bk-info';
        const when = new Date(b.savedAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        info.innerHTML = `<div class="bk-title">${escapeHtml(b.title || '无标题')}</div>`
          + `<div class="bk-sub">${when} · ${reasonText[b.reason] || b.reason} · ${b.size} 字</div>`;
        const rbtn = document.createElement('button');
        rbtn.type = 'button'; rbtn.className = 'bk-btn'; rbtn.textContent = '还原';
        rbtn.addEventListener('click', () => {
          const newId = window.webdavSync.restoreLocalBackup(b.savedAt);
          if (newId) { setStatus('已还原为新笔记，请在列表中查看', 'success'); rbtn.textContent = '已还原'; rbtn.disabled = true; }
          else setStatus('还原失败', 'error');
        });
        row.appendChild(info); row.appendChild(rbtn);
        bkList.appendChild(row);
      });
      // 清空留底：与"覆盖云端"同款按钮，放卡片底部；两次点击确认
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button'; clearBtn.className = 'rcv-btn-soft-danger'; clearBtn.textContent = '清空留底';
      let clearArmed = false, clearTimer = null;
      const clearReset = () => { clearArmed = false; clearBtn.style.color = ''; clearBtn.textContent = '清空留底'; if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; } };
      clearBtn.addEventListener('click', () => {
        if (!clearArmed) { clearArmed = true; clearBtn.style.color = 'var(--danger)'; clearBtn.textContent = '确认清空？'; clearTimer = setTimeout(clearReset, 4000); return; }
        clearReset();
        window.webdavSync?.clearLocalBackups?.();
        setStatus('已清空同步留底', 'success');
        buildMaint();
      });
      bk.appendChild(clearBtn);
    }

    // 覆盖云端（两次点击确认）
    const mReset = () => { mirrorArmed = false; mBtn.style.color = ''; mBtn.textContent = '覆盖云端'; if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; } };
    mBtn.addEventListener('click', async () => {
      if (!mirrorArmed) {
        mirrorArmed = true;
        mBtn.style.color = 'var(--danger)';
        mBtn.textContent = '确认：删冗余 + 传全部？';
        mirrorTimer = setTimeout(mReset, 4000);
        return;
      }
      mReset();
      setBusy(true);
      mBtn.disabled = true; mBtn.textContent = '处理中…';
      setStatus('正在用本地覆盖云端…');
      try {
        editor.flushSave?.();
        const res = await window.webdavSync.mirrorLocalToCloud();
        if (res && res.ok) {
          const tip = res.removed ? `清理云端 ${res.removed} 篇，` : '云端无多余，';
          setStatus(`已覆盖：${tip}已上传本地全部`, 'success');
          toast('已用本地覆盖云端', 'success');
          // 覆盖后云端 = 本地：更新概览（云端笔记数=本地数、无缺失、清理项进墓碑）。
          if (summary) {
            summary.localNotes = Object.keys(storage.getAll().notes || {}).length;
            summary.cloudNotes = summary.localNotes;
            summary.missing = 0;
            summary.tombstones = (summary.tombstones || 0) + (res.removed || 0);
            if (currentTab === 'overview') buildOverview();
          }
        } else {
          setStatus('覆盖失败：' + ((res && res.error) || '未知错误'), 'error');
        }
        onMirrorDone(res || { ok: false });
      } catch (e) {
        setStatus('覆盖失败：' + e.message, 'error');
        onMirrorDone({ ok: false, error: e.message });
      } finally {
        mBtn.disabled = false; mBtn.textContent = '覆盖云端';
        setBusy(false);
      }
    });
  }

  // ── 关闭 ──────────────────────────────────────────────────────
  const close = () => {
    if (closed) return;
    closed = true;
    disarmDelete();
    disarmMirror();
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    document.removeEventListener('keydown', onKey, true);
    overlay.style.opacity = '0';
    card.style.transform = 'translateY(6px)';
    setTimeout(() => overlay.remove(), 180);
    onDone(totalRecovered);
  };
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  cancelBtn.addEventListener('click', () => close());

  function setBusy(busy) {
    cancelBtn.disabled = busy;
    selBtn.disabled = busy;
    tabAll.disabled = tabMissing.disabled = tabMaint.disabled = tabOverview.disabled = busy;
    if (busy) { delBtn.disabled = true; okBtn.disabled = true; }
    else refreshCounts();
  }

  // ── 恢复 / 删除（批量按钮与行内单条共用）──────────────────────
  async function doRecover(items) {
    disarmDelete();
    const list0 = (items || []).filter(Boolean);
    if (!list0.length) return;
    const recoverable = list0.filter(it => it.status === 'missing' || !it.status);
    const skipped = list0.length - recoverable.length;
    if (!recoverable.length) { setStatus('所选笔记本地已存在，无需恢复', 'info'); return; }
    setBusy(true);
    okBtn.textContent = '恢复中…';
    const total = recoverable.length;
    setStatus(`正在恢复 0/${total}…`);
    try {
      await window.webdavSync.recoverCloudNotes(recoverable, (d, t) => setStatus(`正在恢复 ${d}/${t}…`));
      const ok = recoverable.filter(it => window.storage.get && window.storage.get(it.id));
      totalRecovered += ok.length;
      let msg = ok.length ? `已恢复 ${ok.length} 篇笔记` : '没有恢复成功';
      if (ok.length < recoverable.length) msg += '（部分未完成，可能触发限流，可稍后重试）';
      if (skipped) msg += `；跳过 ${skipped} 篇本地已有`;
      setStatus(msg, ok.length ? 'success' : 'error');
      removeProcessed(ok);
      // 恢复不删云端文件：仅本地数 +、缺失数 - 。更新概览数据。
      if (summary && ok.length) {
        summary.localNotes = Object.keys(storage.getAll().notes || {}).length;
        summary.missing = remainingOf(found).length;
        if (currentTab === 'overview') buildOverview();
      }
    } catch (e) {
      setStatus('恢复失败：' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  // 乐观删除：面板里立刻移除所选 → 云端在后台串行慢慢删，不阻塞继续操作。
  // 失败的会明确提示「下次扫描会再出现」，本地数据不受影响（删除只作用于云端），无丢失风险。
  function doDelete(items) {
    const picked = (items || []).filter(Boolean);
    if (!picked.length) return;
    disarmDelete();
    removeProcessed(picked);          // 立即从面板移除，给出明显反馈
    // 乐观更新概览：云端笔记数/占用减少，已删除记录增加（失败的会在下次扫描时回来并被重新计数）。
    if (summary) {
      const sz = picked.reduce((s, it) => s + (it.size || 0), 0);
      summary.cloudNotes = Math.max(0, summary.cloudNotes - picked.length);
      summary.cloudSize = Math.max(0, summary.cloudSize - sz);
      summary.tombstones = (summary.tombstones || 0) + picked.length;
      if (currentTab === 'overview') buildOverview();
    }
    bgDeleting += picked.length;
    setStatus(`正在后台删除…（剩 ${bgDeleting} 篇）`);
    bgDeleteChain = bgDeleteChain.then(async () => {
      let failed = [];
      try {
        const ids = await window.webdavSync.deleteCloudNotes(picked, () => {
          setStatus(`正在后台删除…（剩 ${bgDeleting} 篇）`);
        });
        const okSet = new Set(ids);
        failed = picked.filter(it => !okSet.has(it.id));
      } catch (e) {
        failed = picked.slice();
        setStatus('删除出错：' + e.message, 'error');
      }
      bgDeleting = Math.max(0, bgDeleting - picked.length);
      if (failed.length) {
        setStatus(`部分删除未成功（${failed.length} 篇，下次扫描会再出现，可重试）`, 'error');
      } else if (bgDeleting <= 0) {
        setStatus('已从云端删除完毕', 'success');
      } else {
        setStatus(`后台删除进行中…（剩 ${bgDeleting} 篇）`);
      }
    });
  }

  okBtn.addEventListener('click', () => doRecover(pickedItems()));
  delBtn.addEventListener('click', () => {
    const picked = pickedItems();
    if (!picked.length) return;
    if (!delArmed) {
      delArmed = true;
      refreshCounts();
      delTimer = setTimeout(() => { disarmDelete(); refreshCounts(); }, 3500);
      return;
    }
    doDelete(picked);
  });

  // 标题与层级已随 manifest 一并下发，无需手动读取。
  // 仅对极少数「旧版本上传、manifest 里没存标题」的遗留笔记，在后台静默补一次（并发、限量，不阻塞面板）。
  async function autoLoadMissingTitles() {
    const todo = allItems.filter(it => it && !it._removed && !it._titleLoaded);
    if (!todo.length || !window.webdavSync || !window.webdavSync.loadCloudTitles) return;
    const batch = todo.slice(0, 40);
    if (batch.length) setStatus(`正在补全 ${batch.length} 篇标题…`);
    try {
      const r = await window.webdavSync.loadCloudTitles(batch, (it) => paintRow(it));
      if (r.stopped) setStatus('部分标题因限流未加载，稍后再试', 'warning');
      else setStatus('');
    } catch (_) { setStatus(''); }
  }

  // ── 初始化 ────────────────────────────────────────────────────
  buildOverview();
  switchTab('all');
  autoLoadMissingTitles();
}
window.openRecoverDialog = openRecoverDialog;

/** 同步策略弹窗：立即弹出（云端数据量后台探测、原地更新），不让用户对着无反应的界面干等。
 *  probePromise 为 probeCloudState 的进行中 Promise；探测完成前「下载云端 / 上传本地」禁用（方向选择依赖云端数据量），取消随时可点。
 *  两边都为空时自动返回 'switch'（无需用户选择）。 */
function _askSyncStrategy(providerName, localCount, probePromise, opts = {}) {
  const passChanged = !!opts.passChanged;
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.style.cssText = 'padding:4px 0;color:var(--text);font-size:14px;line-height:1.7;';
    const localDesc = localCount > 0 ? `本地有 <b>${localCount}</b> 篇笔记` : `本地暂无笔记`;
    const passLine = passChanged
      ? `<span style="color:var(--text-secondary);font-size:13px;">🔑 你修改了加密口令：选「上传本地」会用新口令<b>重新加密整个云端</b>（其它设备随后需改成同一口令）。</span><br>`
      : '';
    body.innerHTML = `即将切换到 <b>${providerName}</b>：${localDesc}。<br>`
      + `<span id="strategy-cloud-line" style="color:var(--text-tertiary);">⏳ 正在检测云端数据…</span><br>`
      + `<span id="strategy-key-line"></span>`
      + passLine + `<br>`
      + `<span style="color:var(--text-tertiary);font-size:13px;">⚠ 选择任一方向将覆盖另一方数据，建议先通过"导出"功能备份；点「取消」则不切换、保持当前同步不变。</span><br><br>`
      + `请选择同步策略：`;
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    openModal({
      title: '同步策略',
      body,
      footer: [
        { label: '取消', class: 'secondary-btn', onClick: () => finish('cancel') },
        { label: '下载云端', class: 'secondary-btn', onClick: () => finish('download') },
        { label: '上传本地', class: 'primary-btn', onClick: () => finish('upload') },
      ],
      onClose: () => { if (!done) { done = true; resolve('cancel'); } },
    });
    const _btns = [...(document.getElementById('modal-footer')?.querySelectorAll('button') || [])];
    const dlBtn = _btns[1], upBtn = _btns[2];
    if (dlBtn) dlBtn.disabled = true;
    if (upBtn) upBtn.disabled = true;
    Promise.resolve(probePromise).then((cloudState) => {
      if (done) return;
      if (cloudState && cloudState.error) toast(`检测云端失败：${cloudState.error}`, 'warning');
      const cloudCount = (cloudState && cloudState.hasData) ? (cloudState.noteCount || 0) : 0;
      if (localCount === 0 && cloudCount === 0) { finish('switch'); return; } // 两边都空：直接切换
      let timeInfo = '';
      if (cloudState && cloudState.updatedAt) {
        const d = new Date(cloudState.updatedAt);
        timeInfo = `（最后更新：${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}）`;
      }
      const line = document.getElementById('strategy-cloud-line');
      if (line) {
        line.style.color = '';
        line.innerHTML = cloudCount > 0 ? `云端已有 <b>${cloudCount}</b> 篇笔记${timeInfo}` : '云端暂无笔记';
      }
      // 口令试解结果：解不开云端数据时「下载云端」必然失败，直接禁用并说明原因
      const keyLine = document.getElementById('strategy-key-line');
      const keyMismatch = cloudCount > 0 && cloudState && cloudState.keyMatch === false;
      if (keyLine) {
        if (keyMismatch) {
          keyLine.innerHTML = `<span style="color:var(--danger,#d05);font-size:13px;">🔒 当前口令<b>解不开</b>云端现有数据——`
            + (passChanged ? `请选「上传本地」重新加密云端；若想沿用云端数据，请先取消并改回原口令。` : `请检查加密口令是否与上传设备一致；强行「上传本地」会用本口令覆盖云端。`)
            + `</span><br>`;
        } else if (cloudState && cloudState.keyMatch === true) {
          keyLine.innerHTML = `<span style="color:var(--text-tertiary);font-size:13px;">🔓 当前口令可以解开云端数据。</span><br>`;
        }
      }
      if (dlBtn) dlBtn.disabled = (cloudCount === 0) || keyMismatch; // 云端为空/解不开时无"下载"可言
      if (upBtn) upBtn.disabled = false;
    });
  });
}

/** 仅改口令且新口令解不开云端时的确认：区分"输错了"和"确实要换锁"。返回是否重新加密云端。 */
function _confirmReencryptCloud() {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.style.cssText = 'padding:4px 0;color:var(--text);font-size:14px;line-height:1.7;';
    body.innerHTML = '这个口令<b>解不开云端现有笔记</b>。<br><br>'
      + '• 如果你是想输入<b>已有口令</b>（其它设备上设置过的）：多半是<b>输错了</b>，请返回检查重输；<br>'
      + '• 如果你是想<b>更换新口令</b>：确认后会用它把云端全部笔记重新加密，'
      + '<b>其它设备之后必须改成同一口令</b>才能继续同步。';
    let done = false;
    openModal({
      title: '口令解不开云端数据',
      body,
      footer: [
        { label: '返回检查', class: 'secondary-btn', onClick: () => { done = true; closeModal(); resolve(false); } },
        { label: '更换口令并重新加密云端', class: 'primary-btn', onClick: () => { done = true; closeModal(); resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/** 覆盖导入/恢复前：若开启了云同步，先确认（会同时覆盖云端）。未开同步直接放行。返回是否继续。 */
function _confirmOverwriteCloudIfSync() {
  if ((storage.getSetting('syncMethod') || 'none') !== 'webdav') return Promise.resolve(true);
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.style.cssText = 'padding:4px 0;color:var(--text);font-size:14px;line-height:1.7;';
    body.innerHTML = '你开启了云同步。<b>覆盖导入 / 恢复</b>会先替换本地，随后<b>同步覆盖云端</b>：'
      + '云端上本地没有的笔记会被删除（进「同步留底」可找回），其它设备下次同步会对齐到这份。<br><br>确定继续吗？';
    let done = false;
    openModal({
      title: '覆盖会同时覆盖云端',
      body,
      footer: [
        { label: '取消', class: 'secondary-btn', onClick: () => { done = true; closeModal(); resolve(false); } },
        { label: '继续覆盖', class: 'primary-btn', onClick: () => { done = true; closeModal(); resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/** 覆盖导入/恢复完成后：若开启云同步，用本地（导入后的结果）镜像覆盖云端，避免被替换的旧笔记从云端复活。 */
async function _mirrorAfterOverwrite() {
  if ((storage.getSetting('syncMethod') || 'none') !== 'webdav' || !window.webdavSync?.mirrorLocalToCloud) return;
  try {
    editor.flushSave?.();
    const r = await window.webdavSync.mirrorLocalToCloud();
    if (r && r.ok) {
      toast(`已同步覆盖云端${r.removed ? `，清理了 ${r.removed} 篇云端多余笔记` : ''}`, 'success');
    } else {
      toast(`云端覆盖失败：${(r && r.error) || '未知错误'}。本地已替换，可在「管理云端笔记 → 覆盖云端」重试`, 'warning', { duration: 0 });
    }
  } catch (e) {
    toast(`云端覆盖失败：${e.message}。本地已替换，可在「管理云端笔记 → 覆盖云端」重试`, 'warning', { duration: 0 });
  }
}

/** 顺序关闭最上层的浮层；返回是否关掉了任意一个 */
function closeAnyOverlay() {
  // modal
  const mo = document.getElementById('modal-overlay');
  if (mo && !mo.classList.contains('hidden')) { closeModal?.(); return true; }
  // 命令面板
  const pal = document.getElementById('palette-overlay');
  if (pal && !pal.classList.contains('hidden')) { palette?.close?.(); return true; }
  // 表情
  const ep = document.getElementById('emoji-popover');
  if (ep && !ep.classList.contains('hidden')) { ep.classList.add('hidden'); return true; }
  // 模板弹窗
  const tplPop = document.querySelector('.context-menu:not(.hidden)');
  if (tplPop) { tplPop.remove(); return true; }
  // 自定义 popover（确认/输入框）
  const cp = document.querySelector('.confirm-popover:not(.hidden), .input-popover:not(.hidden)');
  if (cp) { cp.remove(); return true; }
  // workspace switcher 等独立 popup
  const wp = document.querySelector('.workspace-popup');
  if (wp) { wp.remove(); return true; }
  return false;
}

function isEditing(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if (el.isContentEditable) return true;
  return false;
}

function setupResizer() {
  const resizer = document.getElementById('resizer');
  const sidebar = document.getElementById('sidebar');
  let startX = 0, startW = 0, dragging = false;
  let lastW = 0, rafId = 0;

  const applyWidth = () => {
    rafId = 0;
    document.documentElement.style.setProperty('--sidebar-width', lastW + 'px');
  };

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    // 拖动期间暂停侧栏 width 过渡（否则 0.25s 动画让分隔条"跟不上手"），并禁止选中
    document.body.classList.add('is-resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    lastW = Math.max(200, Math.min(500, startW + (e.clientX - startX)));
    // 用 rAF 合并高频 mousemove，避免每次同步写样式触发重排卡顿
    if (!rafId) rafId = requestAnimationFrame(applyWidth);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); applyWidth(); }
    resizer.classList.remove('dragging');
    document.body.classList.remove('is-resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'));
    storage.setSetting('sidebarWidth', w);
  });
}

/** 手机端（≤768px）：侧栏默认收起为抽屉；点遮罩/手势/打开笔记均可收起；左缘右滑拉出。 */
function setupMobileLayout() {
  const mq = window.matchMedia('(max-width: 768px)');
  document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
    document.body.classList.add('sidebar-collapsed');
    document.body.classList.remove('outline-drawer-open');
  });

  // iOS/iPadOS 识别（iPadOS 的 Safari UA 伪装成 Mac，用 maxTouchPoints 区分）：
  // 选字 touch-action 豁免、键盘工具条贴合、安装指引等都按此分支
  if (/iP(ad|hone|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    document.body.classList.add('is-ios');
  }

  // 安装为 PWA（standalone）后系统自带标题栏/无需内置标题栏 → 隐藏，避免双层。
  // 仅网页宿主：Quicker 无边框窗口里内置标题栏就是窗口标题栏，不能隐藏。
  if (!window.host.caps.window) {
    const standalone = window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches
      || window.navigator.standalone === true; // iOS Safari
    if (standalone) document.body.classList.add('pwa-standalone');
  }

  if (window.matchMedia('(pointer: coarse)').matches) setupTouchGestures(mq);

  if (!mq.matches) return;
  // 进入即看编辑区（仅本次会话，不写入设置，避免影响桌面端）
  document.body.classList.add('sidebar-collapsed');
  // 从树里打开笔记后自动收起抽屉；刚新建的笔记除外——
  // 新建后通常要在树里继续命名/整理，立刻收抽屉会打断操作（用户反馈"侧栏容易自动收缩"）
  const _origOpen = editor.open.bind(editor);
  editor.open = (...args) => {
    const r = _origOpen(...args);
    const n = storage.get(args[0]);
    const isNew = n && n.createdAt && (Date.now() - n.createdAt < 1500);
    if (!isNew) document.body.classList.add('sidebar-collapsed');
    return r;
  };

  // 抽屉手势：屏幕左缘（24px 内）右滑拉出侧栏；抽屉打开时左滑收起。
  // 只在 touchend 判定一次（水平位移 > 60px 且明显大于纵向位移），不干扰编辑区的滚动与选字。
  let _tsX = 0, _tsY = 0, _fromEdge = false;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    _tsX = t.clientX; _tsY = t.clientY;
    _fromEdge = t.clientX <= 24;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (e.touches.length > 0) return; // 多指手势由 setupTouchGestures 接管
    const t = e.changedTouches[0];
    const dx = t.clientX - _tsX, dy = t.clientY - _tsY;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.8) return;
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    if (collapsed && _fromEdge && dx > 0) {
      document.body.classList.remove('sidebar-collapsed');
    } else if (!collapsed && dx < 0) {
      document.body.classList.add('sidebar-collapsed');
    }
  }, { passive: true });
}

/**
 * 触屏手势中枢（pointer: coarse 设备）：
 * - 双指轻点         = 模拟右键（在指下元素上派发 contextmenu，树行/图片等弹各自菜单）
 * - 双指右滑         = 拉出侧栏（大纲开着则先关大纲）
 * - 双指左滑         = 拉出大纲（侧栏开着则先关侧栏）
 * - 双指上滑 / 下滑  = 下一篇 / 上一篇（按侧栏可见顺序）
 * - 双指捏合         = 调编辑区字号（11–28px，实时预览）
 * - 三指轻点         = 阅读模式开关
 * - 双击顶栏         = 编辑区回到顶部
 * - 编辑区顶部下拉    = 立即同步
 * - 摇一摇           = 撤销（仅免授权平台，iOS 需手动授权故不启用）
 */
function setupTouchGestures(mq) {
  const isMobile = () => mq.matches;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  const openSidebarDrawer = () => {
    if (document.body.classList.contains('outline-drawer-open')) {
      document.body.classList.remove('outline-drawer-open');
      return;
    }
    document.body.classList.remove('sidebar-collapsed');
  };
  const openOutlineDrawer = () => {
    if (!document.body.classList.contains('sidebar-collapsed')) {
      document.body.classList.add('sidebar-collapsed');
      return;
    }
    document.body.classList.add('outline-drawer-open');
    document.getElementById('outline-panel')?.classList.remove('hidden');
    try { editor.refreshOutline && editor.refreshOutline(); } catch (_) {}
  };
  // 点大纲条目跳转后自动收起大纲抽屉
  document.getElementById('outline-panel')?.addEventListener('click', (e) => {
    if (isMobile() && e.target.closest('.outline-item, li, a'))
      setTimeout(() => document.body.classList.remove('outline-drawer-open'), 120);
  });
  // 大纲标题行右侧加「回顶 / 关闭」两个小按钮（仅触屏注入）
  const oh = document.querySelector('#outline-panel .outline-header');
  if (oh && !oh.querySelector('.outline-header-acts')) {
    const acts = document.createElement('span');
    acts.className = 'outline-header-acts';
    acts.innerHTML = '<button type="button" data-oact="top">回顶</button><button type="button" data-oact="close">关闭</button>';
    oh.appendChild(acts);
    acts.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-oact]');
      if (!b) return;
      if (b.dataset.oact === 'top') document.getElementById('editor')?.scrollTo({ top: 0, behavior: 'smooth' });
      else document.body.classList.remove('outline-drawer-open');
    });
  }

  // 按侧栏可见顺序切换上一篇/下一篇
  const navNote = (dir) => {
    const ids = [...document.querySelectorAll('#tree-container .tree-node')].map(n => n.dataset.id).filter(Boolean);
    if (!ids.length) return;
    const cur = editor.currentId && editor.currentId();
    const i = ids.indexOf(cur);
    const ni = i === -1 ? 0 : i + dir;
    if (ni < 0 || ni >= ids.length) {
      toast(dir > 0 ? '已是最后一篇' : '已是第一篇', 'info', { id: 'note-nav', duration: 900 });
      return;
    }
    editor.open(ids[ni]);
    const n = storage.get(ids[ni]);
    toast((dir > 0 ? '下一篇 · ' : '上一篇 · ') + ((n && n.title) || '无标题'), 'info', { id: 'note-nav', duration: 1200 });
  };

  // ── 双指 / 三指手势统一判定 ──
  let g2 = null;   // 双指：{ t0, start, last, d0, fs0, mode }
  let g3 = null;   // 三指轻点：{ t0, moved }
  const FS_MIN = 11, FS_MAX = 28;

  // iOS Safari 的整页捏合缩放走专有 gesture 事件，touch-action 管不住，单独拦掉
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  document.addEventListener('touchstart', (e) => {
    window._mdTouchActive = true; // 供键盘错位纠正参考：手指按着时不要强制滚动（会打断 iOS 长按选字）
    if (e.touches.length === 2) {
      g3 = null;
      const pts = {};
      for (const t of e.touches) pts[t.identifier] = [t.clientX, t.clientY];
      const [p1, p2] = Object.values(pts);
      g2 = {
        t0: Date.now(), start: pts, last: JSON.parse(JSON.stringify(pts)),
        d0: dist(p1, p2), mode: null,
        fs0: parseInt(storage.getSetting('fontSize') || 14, 10),
        inEditor: !!(e.target.closest && e.target.closest('#editor')),
      };
      // 双指一律由我们接管：preventDefault 掐掉 iOS 原生"双指选段"手势，
      // 同时按规范阻止这次触摸序列合成 mouse/click 事件——
      // 否则双指轻点弹出菜单后，延迟合成的"幽灵点击"会正好按中菜单第一项（如「查看大图」）
      if (e.cancelable) e.preventDefault();
    } else if (e.touches.length === 3) {
      g2 = null;
      g3 = { t0: Date.now(), moved: false, pts: [...e.touches].map(t => [t.clientX, t.clientY]) };
    } else if (e.touches.length > 3) {
      g2 = null; g3 = null;
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (g3 && e.touches.length === 3) {
      for (let i = 0; i < 3; i++) {
        if (dist([e.touches[i].clientX, e.touches[i].clientY], g3.pts[i] || [0, 0]) > 28) { g3.moved = true; break; }
      }
      return;
    }
    if (!g2 || e.touches.length !== 2) return;
    // 双指期间整体接管：阻止浏览器原生双指滚动/缩放，
    // 否则双指上下滑切笔记会带动页面滚动、捏合调字号会触发整页缩放
    if (e.cancelable) e.preventDefault();
    for (const t of e.touches) {
      if (g2.last[t.identifier]) g2.last[t.identifier] = [t.clientX, t.clientY];
    }
    const ks = Object.keys(g2.start);
    if (ks.length !== 2) return;
    const a = g2.last[ks[0]], b = g2.last[ks[1]];
    const d = dist(a, b);
    const mx = ((a[0] - g2.start[ks[0]][0]) + (b[0] - g2.start[ks[1]][0])) / 2;
    const my = ((a[1] - g2.start[ks[0]][1]) + (b[1] - g2.start[ks[1]][1])) / 2;
    // 捏合判定：指距变化显著且大于整体平移 → 进入捏合模式（黏性，直到松手）
    if (!g2.mode && g2.inEditor && Math.abs(d - g2.d0) > 40 && Math.abs(d - g2.d0) > Math.hypot(mx, my)) {
      g2.mode = 'pinch';
    }
    if (g2.mode === 'pinch') {
      const size = Math.max(FS_MIN, Math.min(FS_MAX, Math.round(g2.fs0 * d / g2.d0)));
      const curPx = parseInt(storage.getSetting('fontSize') || 14, 10);
      if (size !== curPx) {
        storage.setSetting('fontSize', size);
        document.documentElement.style.setProperty('--editor-font-size', size + 'px');
        window.applyEditorFontSize && window.applyEditorFontSize(size);
        toast(`编辑区字号 ${size}px`, 'info', { id: 'editor-zoom', duration: 1200 });
      }
    }
  }, { passive: false });

  document.addEventListener('touchcancel', (e) => {
    if (e.touches.length === 0) window._mdTouchActive = false;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      window._mdTouchActive = false;
      // 手指全部离开后补一次键盘错位纠正（按压期间被暂缓的那次）
      if (window._mdKbLift) setTimeout(() => window._mdKbLift(), 50);
    }
    // 三指轻点 → 阅读模式
    if (g3 && e.touches.length === 0) {
      const ok = !g3.moved && Date.now() - g3.t0 < 350;
      g3 = null;
      if (ok) window.toggleReadonlyMode && window.toggleReadonlyMode();
      return;
    }
    if (!g2 || e.touches.length >= 2) return;
    const st = g2;
    g2 = null;
    // 双指手势收尾：再拦一次合成点击（touchstart 已 preventDefault，这里兜底首指未拦到的情况）
    if (e.cancelable) e.preventDefault();
    if (st.mode === 'pinch') return; // 捏合已实时生效
    for (const t of e.changedTouches) {
      if (st.last[t.identifier]) st.last[t.identifier] = [t.clientX, t.clientY];
    }
    const ks = Object.keys(st.start);
    if (ks.length !== 2) return;
    const a = st.last[ks[0]], b = st.last[ks[1]];
    const mx = ((a[0] - st.start[ks[0]][0]) + (b[0] - st.start[ks[1]][0])) / 2;
    const my = ((a[1] - st.start[ks[0]][1]) + (b[1] - st.start[ks[1]][1])) / 2;
    const dd = Math.abs(dist(a, b) - st.d0);
    const elapsed = Date.now() - st.t0;

    // 双指轻点 → 按落点分流：
    // 笔记行 = 多选（等价 Ctrl+点击）；编辑区图片/表格/代码块 = 各自右键菜单；
    // 编辑区空白正文 = 快捷小菜单；其余 = 原样转发 contextmenu
    if (elapsed < 350 && Math.hypot(mx, my) < 12 && dd < 12) {
      const x = (st.start[ks[0]][0] + st.start[ks[1]][0]) / 2;
      const y = (st.start[ks[0]][1] + st.start[ks[1]][1]) / 2;
      const el = document.elementFromPoint(x, y);
      if (!el) return;
      const row = el.closest('.tree-row');
      if (row) {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, clientX: x, clientY: y }));
        return;
      }
      if (el.closest('#editor')) {
        // 编辑区一律唤出统一右键菜单（含图片/表格/代码块分支）；点在正文外的留白处也转给 ProseMirror 根
        const pm = document.querySelector('#editor .ProseMirror');
        const target = (pm && pm.contains(el)) ? el : (pm || el);
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        return;
      }
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      return;
    }
    // 双指横滑 → 侧栏 / 大纲（仅手机布局有抽屉）
    if (Math.abs(mx) >= 60 && Math.abs(mx) > Math.abs(my) * 1.25) {
      if (!isMobile()) return;
      if (mx > 0) openSidebarDrawer(); else openOutlineDrawer();
      return;
    }
    // 双指纵滑 → 上一篇 / 下一篇
    if (Math.abs(my) >= 60 && Math.abs(my) > Math.abs(mx) * 1.25) {
      navNote(my < 0 ? 1 : -1); // 上滑=下一篇（翻页直觉），下滑=上一篇
    }
  }, { passive: false });

  // ── 双击顶栏 → 回到顶部 ──
  let _lastTopTap = 0;
  document.getElementById('topbar')?.addEventListener('touchend', (e) => {
    if (e.target.closest('button, input')) return;
    const now = Date.now();
    if (now - _lastTopTap < 320) {
      _lastTopTap = 0;
      document.getElementById('editor')?.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      _lastTopTap = now;
    }
  }, { passive: true });

  // ── 编辑区顶部下拉 → 立即同步 ──
  const edEl = document.getElementById('editor');
  let _ptrY = -1, _ptrFired = false;
  edEl?.addEventListener('touchstart', (e) => {
    _ptrY = (edEl.scrollTop <= 0 && e.touches.length === 1) ? e.touches[0].clientY : -1;
    _ptrFired = false;
  }, { passive: true });
  edEl?.addEventListener('touchmove', (e) => {
    if (_ptrY < 0 || _ptrFired || e.touches.length !== 1) return;
    if (edEl.scrollTop <= 0 && e.touches[0].clientY - _ptrY > 90) {
      _ptrFired = true;
      if ((storage.getSetting('syncMethod') || 'none') === 'none') return;
      toast('正在同步…', 'info', { id: 'ptr-sync', duration: 1500 });
      try { smartCloudSync(); } catch (_) {}
    }
  }, { passive: true });

  // ── 摇一摇撤销（iOS 的 devicemotion 要弹窗授权，体验差，只在免授权平台启用） ──
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission !== 'function') {
    let _lastShake = 0;
    window.addEventListener('devicemotion', (e) => {
      const acc = e.accelerationIncludingGravity;
      if (!acc) return;
      const mag = Math.hypot(acc.x || 0, acc.y || 0, acc.z || 0);
      // 静止时约 9.8（重力），阈值取 28 防走路误触
      if (mag > 28 && Date.now() - _lastShake > 1500 && !document.hidden) {
        _lastShake = Date.now();
        try {
          const ed = editor.instance && editor.instance();
          if (ed && ed.can().undo()) {
            ed.chain().focus().undo().run();
            navigator.vibrate && navigator.vibrate(20);
            toast('已撤销', 'info', { id: 'shake-undo', duration: 1000 });
          }
        } catch (_) {}
      }
    });
  }

  // ── 键盘防误唤：没有真正点按正文文字，就不让软键盘弹出 ──
  // 场景：点选图片、拖缩放手柄、菜单/面板操作后的程序化 focus（如切换笔记、命令执行的 .focus()）
  // 都会把焦点送进 contenteditable，移动端浏览器随即弹键盘，严重干扰非打字操作。
  // 规则：焦点进入编辑器时，回看最近一次 touchstart——
  //   · 落在编辑区文字上（非图片/缩放手柄）→ 用户要打字，放行；
  //   · 落在键盘工具条及其上弹下拉上 → 键盘已在用，放行；
  //   · 其余（图片、手柄、菜单项、树行、或无触摸=纯程序化聚焦）→ 立即 blur 收回键盘。
  let _lastTouchEl = null, _lastTouchAt = 0;
  document.addEventListener('touchstart', (e) => {
    _lastTouchEl = e.target; _lastTouchAt = Date.now();
  }, { capture: true, passive: true });
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('#editor .ProseMirror')) return;
    const el = (Date.now() - _lastTouchAt < 900) ? _lastTouchEl : null;
    const tapText = el && el.closest && el.closest('#editor')
      && !el.closest('img, .md-img-resize-layer, .md-img-resize-handle');
    const tapKbBar = el && el.closest && el.closest('#kb-toolbar, .bubble-heading-dropdown, .bubble-code-dropdown, .bubble-list-dropdown, .bubble-highlight-dropdown, .bubble-align-dropdown');
    // 菜单开着时的聚焦都是附带产物。注意 #context-menu 常驻 DOM 靠 .hidden 隐藏，
    // 必须排除——否则 menuOpen 恒为真，所有聚焦被收回，光标永远出不来（t74 的回归）。
    const menuSel = '.md-editor-ctx, .context-menu:not(.hidden)';
    const menuOpen = !!document.querySelector(menuSel);
    if (menuOpen || (!tapText && !tapKbBar)) {
      try { t.blur(); } catch (_) {}
      // iOS 上同步 blur 偶尔被 ProseMirror 的焦点恢复盖掉，下一帧补收一次
      requestAnimationFrame(() => {
        const ae = document.activeElement;
        if (ae && ae.closest && ae.closest('#editor .ProseMirror')
          && (menuOpen || !!document.querySelector(menuSel) || (!tapText && !tapKbBar))) {
          try { ae.blur(); } catch (_) {}
        }
      });
    }
  });

  setupMobileKbToolbar();
}

/** 触屏键盘工具条：编辑器聚焦时浮在键盘上方。
 *  只保留浮动条没有的输入辅助（撤销/重做、挖空、缩进、语音、命令面板）——
 *  格式化（加粗/高亮/标题…）由选中文本时的浮动条负责，两处不重复。
 *  mousedown 阻止默认避免抢编辑器焦点导致键盘收起。 */
function setupMobileKbToolbar() {
  if (document.getElementById('kb-toolbar')) return;
  const bar = document.createElement('div');
  bar.id = 'kb-toolbar';
  const B = (act, label, title, extra = '') => `<button type="button" data-act="${act}" title="${title}" ${extra}>${label}</button>`;
  bar.innerHTML = [
    B('undo', '↶', '撤销'),
    B('redo', '↷', '重做'),
    '<span class="kb-sep"></span>',
    B('clozeMark', '<span style="background:currentColor;border-radius:3px;padding:0 3px;"><span style="color:var(--bg-secondary);">挖</span></span>', '标记挖空（选中文字后点）'),
    B('outdent', '⇤', '减少缩进'),
    B('indent', '⇥', '增加缩进'),
    '<span class="kb-sep"></span>',
    B('voice', '🎤', '语音输入'),
    B('palette', '⌘', '命令面板'),
  ].join('');
  document.body.appendChild(bar);

  bar.addEventListener('mousedown', (e) => e.preventDefault());

  // ── 按钮（data-act）──
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'palette') { palette.open(); return; }
    if (act === 'voice') { toggleVoiceInput(btn); return; }
    if (act === 'clozeMark') { toggleMarkOnSelection(); return; }
    const ed = editor.instance && editor.instance();
    if (!ed) return;
    try {
      switch (act) {
        case 'undo': ed.chain().focus().undo().run(); break;
        case 'redo': ed.chain().focus().redo().run(); break;
        case 'indent':
          if (!ed.chain().focus().sinkListItem('taskItem').run()) ed.chain().focus().sinkListItem('listItem').run();
          break;
        case 'outdent':
          if (!ed.chain().focus().liftListItem('taskItem').run()) ed.chain().focus().liftListItem('listItem').run();
          break;
      }
    } catch (_) {}
  });

  // iOS/iPadOS：软键盘不压缩布局视口（viewport 的 resizes-content 仅 Android Chrome 支持），
  // 固定 bottom:0 的工具条会被键盘整个盖住。用 visualViewport 实时算键盘高度，把工具条顶到键盘上方。
  // 注意基准必须用 documentElement.clientHeight（布局视口）：iOS 的 window.innerHeight 跟随
  // 视觉视口（键盘弹出即变小），用它算 gap 恒为 0，工具条永远不抬升——这正是 iPad 被盖住的原因。
  // Android 上布局视口已被键盘压缩，gap 恒为 0，此逻辑自然不生效。
  const isIOS = document.body.classList.contains('is-ios');
  let lift = () => {};
  if (window.visualViewport) {
    const vv = window.visualViewport;
    lift = () => {
      const layoutH = document.documentElement.clientHeight;
      const gap = Math.max(0, layoutH - vv.height - vv.offsetTop);
      bar.style.transform = gap > 1 ? `translateY(${-gap}px)` : '';
      // 暴露键盘高度给 CSS（触屏吸附式浮动条用它悬在键盘上方）
      document.documentElement.style.setProperty('--kb-gap', (gap > 1 ? Math.round(gap) : 0) + 'px');
      // iOS：工具条的显隐直接跟着软键盘走——键盘在场(gap>60)且焦点在编辑器才显示。
      // 解决两个顽疾：① 键盘已收起但焦点未走，工具条残留在屏幕底部；
      // ② 聚焦瞬间键盘还没弹出，工具条先闪现在底部再跳到键盘上方。
      // 代价：外接实体键盘时（无软键盘）不显示工具条，可接受。
      if (isIOS) {
        const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#editor');
        bar.classList.toggle('visible', gap > 60 && !!focused);
        // 键盘在场时把 body 压到可视视口高度：iOS 键盘不压缩布局视口，
        // 不处理的话正文滚动区下半截藏在键盘后面，光标一到下方就被盖住。
        document.documentElement.style.setProperty('--vv-h', Math.round(vv.height) + 'px');
        document.body.classList.toggle('kb-open', gap > 60);
        // 防 Safari 把布局视口顶上去造成整体错位：我们是全屏应用，布局视口滚动永远应该是 0，
        // 任何残留滚动（键盘、地址栏伸缩等任意来源）都立即归零，否则顶栏/侧栏图标整体偏移跑出屏幕。
        // 但手指还按着时不纠正——iOS 长按选字过程中系统会微调滚动（放大镜跟随），
        // 这时强行拽回会打断选字手势（曾被反馈"键盘弹出后长按无法选字"）；松手后由 touchend 补一次
        if (window.scrollY && !window._mdTouchActive) window.scrollTo(0, 0);
      }
    };
    vv.addEventListener('resize', lift);
    vv.addEventListener('scroll', lift);
    lift();
  }
  window._mdKbLift = lift; // 手势层在 touchend 时补调（按压期间暂缓的滚动纠正）

  // 编辑器聚焦显示、失焦隐藏（小延迟：点工具条按钮瞬间 activeElement 会暂时跳走）
  // iOS 的"显示"交给上面的 lift 按键盘高度驱动，这里只负责非 iOS 的即时显示
  document.addEventListener('focusin', (e) => {
    if (e.target.closest && e.target.closest('#editor')) { if (!isIOS) bar.classList.add('visible'); lift(); }
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const ae = document.activeElement;
      if (!ae || !ae.closest || !ae.closest('#editor')) bar.classList.remove('visible');
    }, 120);
  });
}

/** 语音输入（Web Speech API，Chrome/Edge 安卓与桌面可用）：点一次开始连续听写，再点停止 */
let _voiceRec = null;
function toggleVoiceInput(btn) {
  if (_voiceRec) {
    try { _voiceRec.stop(); } catch (_) {}
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('当前浏览器不支持语音识别', 'error'); return; }
  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        const t = (e.results[i][0]?.transcript || '').trim();
        if (t) editor.insertAtCursor(t);
      }
    }
  };
  rec.onend = () => {
    _voiceRec = null;
    btn?.classList.remove('active');
    toast('语音输入结束', 'info', { id: 'voice-input', duration: 900 });
  };
  rec.onerror = (e) => {
    _voiceRec = null;
    btn?.classList.remove('active');
    if (e.error === 'not-allowed') toast('麦克风权限被拒绝', 'error');
    else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('语音识别出错：' + e.error, 'error');
  };
  try {
    rec.start();
    _voiceRec = rec;
    btn?.classList.add('active');
    toast('正在听写…再点 🎤 停止', 'info', { id: 'voice-input', duration: 1800 });
  } catch (_) { toast('语音识别启动失败', 'error'); }
}

/** 大纲分隔条拖拽调宽。大纲在左时拖右缘（宽 = 起始 + dx），在右时拖左缘（宽 = 起始 - dx）。 */
function setupOutlineResizer() {
  const resizer = document.getElementById('outline-resizer');
  const panel = document.getElementById('outline-panel');
  if (!resizer || !panel) return;
  let startX = 0, startW = 0, dragging = false, dir = 1;
  let lastW = 0, rafId = 0;

  const applyWidth = () => {
    rafId = 0;
    document.documentElement.style.setProperty('--outline-width', lastW + 'px');
  };

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = panel.getBoundingClientRect().width;
    dir = document.getElementById('app')?.classList.contains('outline-right') ? -1 : 1;
    resizer.classList.add('dragging');
    document.body.classList.add('is-resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    lastW = Math.max(140, Math.min(420, startW + dir * (e.clientX - startX)));
    if (!rafId) rafId = requestAnimationFrame(applyWidth);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); applyWidth(); }
    resizer.classList.remove('dragging');
    document.body.classList.remove('is-resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--outline-width'));
    if (w) storage.setSetting('outlineWidth', w);
  });
}

function toggleOutline() {
  const panel = document.getElementById('outline-panel');
  const open = panel.classList.toggle('hidden');
  storage.setSetting('outlineOpen', !open);
  document.getElementById('btn-outline-toggle')?.classList.toggle('active', !open);
  if (!open) editor.refreshOutline();
}

function toggleSidebar() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  storage.setSetting('sidebarCollapsed', collapsed);
}
window.toggleSidebar = toggleSidebar;
window.toggleOutline = toggleOutline;

/* ===== 笔记本（workspace）切换 ===== */
function animateWorkspaceSwitch(run) {
  const main = document.getElementById('main');
  if (!main) { run(); return; }
  main.style.transition = 'opacity 0.12s ease';
  main.style.opacity = '0.4';
  setTimeout(() => {
    run();
    requestAnimationFrame(() => {
      main.style.opacity = '1';
      setTimeout(() => { main.style.transition = ''; }, 140);
    });
  }, 80);
}

function refreshWorkspaceSwitcher() {
  const sw = document.getElementById('workspace-switcher');
  if (!sw) return;
  const ws = storage.getActiveWorkspace();
  if (!ws) return;
  sw.querySelector('.ws-icon').textContent = ws.icon || '📒';
  sw.querySelector('.ws-name').textContent = ws.name || '未命名';
}

function openWorkspaceSwitcher(anchorEl, opts = {}) {
  document.querySelectorAll('.workspace-popup').forEach(el => el.remove());
  const atCursor = (opts.x != null && opts.y != null);
  // 无锚点且非光标定位时，回退到笔记本切换器按钮（从按钮下方展开）
  if (!anchorEl && !atCursor) anchorEl = document.getElementById('workspace-switcher');
  anchorEl?.classList.add('is-open');
  const all = storage.getWorkspaces();
  const cur = storage.getActiveWorkspace();
  const pop = document.createElement('div');
  pop.className = 'workspace-popup';
  all.forEach(ws => {
    const it = document.createElement('div');
    it.className = 'workspace-popup-item' + (ws.id === cur.id ? ' active' : '');
    it.innerHTML = `
      <button class="ws-icon-btn" data-act="icon" title="更换图标">${ws.icon || '📒'}</button>
      <span class="ws-name">${escapeHtml(ws.name)}</span>
      <span class="ws-actions">
        <button data-act="rename" title="重命名">✎</button>
        ${all.length > 1 ? '<button data-act="del" title="删除本子">🗑</button>' : ''}
      </span>
    `;
    it.addEventListener('contextmenu', (e) => {
      const btn = e.target.closest('[data-act="icon"]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      openIconPicker(btn, {
        currentIcon: ws.icon || '📒',
        defaultIcon: '📒',
        title: '右键更换图标',
        onPick: (icon) => {
          storage.setWorkspaceIcon?.(ws.id, icon || '📒');
          refreshWorkspaceSwitcher();
          btn.textContent = icon || '📒';
        },
      });
    });
    it.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      const act = btn?.dataset?.act;
      if (act === 'icon') {
        e.stopPropagation();
        openIconPicker(btn, {
          currentIcon: ws.icon || '📒',
          defaultIcon: '📒',
          title: '右键更换图标',
          onPick: (icon) => {
            storage.setWorkspaceIcon?.(ws.id, icon || '📒');
            refreshWorkspaceSwitcher();
            btn.textContent = icon || '📒';
          },
        });
        return;
      }
      if (act === 'rename') {
        e.stopPropagation();
        pop.remove();
        promptWorkspaceEdit({ mode: 'rename', ws });
        return;
      }
      if (act === 'del') {
        e.stopPropagation();
        const noteCount = Object.values(storage.getAll().notes || {})
          .filter(n => n.workspaceId === ws.id).length;
        pop.remove();
        if (noteCount === 0) {
          storage.deleteWorkspace(ws.id, 'purge');
          tree.render();
          refreshWorkspaceSwitcher();
          toast('已删除空笔记本', 'success');
        } else {
          promptDeleteWorkspace(ws, noteCount);
        }
        return;
      }
      if (ws.id !== cur.id) {
        animateWorkspaceSwitch(() => {
          editor.flushSave();
          editor.close();
          storage.setActiveWorkspace(ws.id);
          tree.render();
          refreshWorkspaceSwitcher();
          renderWelcomeRecent();
        });
      }
      pop.remove();
    });
    pop.appendChild(it);
  });
  // 分隔线 + "新建笔记本"
  const sep = document.createElement('div');
  sep.className = 'workspace-popup-divider';
  pop.appendChild(sep);
  const newBtn = document.createElement('div');
  newBtn.className = 'workspace-popup-item';
  newBtn.innerHTML = `<span class="ws-icon">＋</span><span class="ws-name" style="color:var(--accent);">新建笔记本…</span>`;
  newBtn.addEventListener('click', () => {
    pop.remove();
    promptWorkspaceEdit({ mode: 'create' });
  });
  pop.appendChild(newBtn);

  document.body.appendChild(pop);
  let r;
  if (atCursor) {
    // 光标定位：弹窗左上角贴着鼠标右下方一点，像表情窗一样跟着光标
    r = { left: opts.x + 2, top: opts.y, bottom: opts.y + 2, right: opts.x + 2, width: 0, height: 0 };
  } else {
    r = anchorEl ? anchorEl.getBoundingClientRect() : null;
    // anchor 不可用（隐藏 / 侧栏折叠）→ 回退到左上角悬浮
    if (!r || (!r.width && !r.height)) {
      r = { left: 12, top: 52, bottom: 52, right: 12, width: 240, height: 0 };
    }
  }
  // 让弹窗与切换器同宽（看起来像"展开"），最小 240px
  const desiredW = Math.max(240, r.width);
  pop.style.minWidth = `${desiredW}px`;
  // 先放置以测量真实尺寸
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 4}px`;
  const pad = 8;
  const pw = pop.offsetWidth;
  // 笔记本很多时限制高度并内部滚动，保证不超出窗口
  const maxH = window.innerHeight - pad * 2;
  if (pop.offsetHeight > maxH) { pop.style.maxHeight = `${maxH}px`; pop.style.overflowY = 'auto'; }
  const ph = pop.offsetHeight;
  // 水平边界保护（两侧）
  let left = r.left;
  if (left + pw > window.innerWidth - pad) left = window.innerWidth - pw - pad;
  if (left < pad) left = pad;
  pop.style.left = `${Math.round(left)}px`;
  // 垂直边界保护：下方放不下则向上翻；仍放不下则贴顶
  let top = r.bottom + 4;
  if (top + ph > window.innerHeight - pad) {
    const upTop = r.top - ph - 4;
    top = upTop >= pad ? upTop : Math.max(pad, window.innerHeight - ph - pad);
  }
  pop.style.top = `${Math.round(top)}px`;

  // 关闭时清掉 anchor 的 is-open 状态（chevron 转回去）
  const cleanupOpen = () => anchorEl?.classList.remove('is-open');

  setTimeout(() => {
    const onDoc = (e) => {
      // 排除 icon picker：点击图标选择器内部不要把 ws popup 也连带关掉
      if (e.target.closest?.('.icon-picker-popover')) return;
      if (!pop.contains(e.target) && e.target !== anchorEl) {
        pop.remove();
        cleanupOpen();
        document.removeEventListener('mousedown', onDoc, true);
      }
    };
    document.addEventListener('mousedown', onDoc, true);
  }, 0);

  // 任何 .remove() 时也清状态（在关闭按钮等地方）
  const origRemove = pop.remove.bind(pop);
  pop.remove = () => { cleanupOpen(); origRemove(); };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/** 笔记本 + 笔记图标预设（共用） */
const WS_EMOJI_PRESETS = [
  // 笔记本/文件
  '📒','📓','📔','📕','📗','📘','📙','📚','📖','📝','✏️','📋','🗂️','📁','📂','💼',
  '📄','📃','📑','🗒️','🗓️','📇','📰','🏷️','✉️','📩','📨','📧','💌','📮','📬','📪',
  // 工作/学习/工具
  '💻','🖥️','⌨️','🖱️','📱','💡','🔬','🧪','🧠','🎓','🏫','🏠','🏢','🛒','💰','💳',
  '⚙️','🔧','🔨','🛠️','⛏️','🪛','🪚','📐','📏','🧮','🔩','⚖️','🧲','🔭','🔎','🔍',
  // 兴趣/娱乐
  '🎨','🎵','🎬','🎮','📷','🎤','🎸','🏃','⚽','🏀','🍎','🍳','☕','🍺','🌱','🌳',
  '🎹','🎺','🥁','🎭','🎪','🎲','🃏','🧩','🎿','🏄','🚴','🧘','🎧','📻','📺','🖼️',
  // 食物/饮品
  '🍕','🍔','🍟','🌮','🍣','🍰','🧁','🍩','🍫','🍿','🥤','🧃','🍷','🍶','🫖','🧊',
  // 自然/天气
  '☀️','🌙','⭐','🌟','🔥','⚡','❄️','🌈','🌊','🌸','🌹','🍀','🍂','🌍','🌌','✨',
  '🌺','🌻','🌷','💐','🌿','🪴','🌵','🍄','🐚','🪨','💧','🫧','☁️','🌤️','🌧️','🌪️',
  // 动物
  '🐱','🐶','🐰','🦊','🐻','🐼','🐨','🦁','🐯','🦄','🐝','🦋','🐠','🐳','🦅','🦉',
  // 标记/状态
  '🎯','🚀','💎','🏆','⚓','📌','🔖','🔑','🔒','📊','📈','📉','✅','❤️','💯','🎉',
  '⭕','❌','⚠️','🔴','🟠','🟡','🟢','🔵','🟣','⚪','🟤','💜','💙','💚','💛','🧡',
  // 交通/旅行
  '✈️','🚗','🚂','🚢','🏖️','🗻','🗼','🏰','🎡','🎢','🧳','🗺️','🧭','⛺','🏕️','🌋',
  // 符号
  '♻️','☮️','☯️','🕉️','✡️','🔯','♾️','💠','🔶','🔷','🔸','🔹','▶️','⏸️','⏹️','🔘',
];

/** 通用图标选择 popover（笔记 / 笔记本共用，浮在锚点旁边，选完即写入）
 *  @param {HTMLElement} anchorEl - 锚点元素（图标按钮本身）
 *  @param {object} opts
 *    - currentIcon: string 当前已选 emoji
 *    - defaultIcon: string 恢复默认按钮要恢复成的 icon
 *    - onPick: (icon: string) => void  选完回调
 *    - title?: string 标题文字
 */
function openIconPicker(anchorEl, { currentIcon, defaultIcon, onPick, title } = {}) {
  document.querySelectorAll('.icon-picker-popover').forEach(el => el.remove());

  const pop = document.createElement('div');
  pop.className = 'icon-picker-popover';
  pop.innerHTML = `
    ${title ? `<div class="icon-picker-title">${escapeHtml(title)}</div>` : ''}
    <div class="icon-picker-input-row">
      <input type="text" class="icon-picker-input" maxlength="4" value="${escapeHtml(currentIcon || '')}" placeholder="自定义">
      <button type="button" class="icon-picker-confirm" title="确认自定义">✓</button>
      <button type="button" class="icon-picker-reset" title="恢复默认">↺</button>
    </div>
    <div class="icon-picker-grid">
      ${WS_EMOJI_PRESETS.map(e =>
        `<button type="button" class="icon-picker-cell${e === currentIcon ? ' active' : ''}" data-e="${e}" title="${e}">${e}</button>`
      ).join('')}
    </div>
  `;
  document.body.appendChild(pop);

  // 定位：在锚点正下方居中；超出边界则调整
  const r = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = r.left + r.width / 2 - pw / 2;
  let top = r.bottom + 6;
  if (left + pw > vw - 8) left = vw - pw - 8;
  if (left < 8) left = 8;
  if (top + ph > vh - 8) top = r.top - ph - 6;
  if (top < 8) top = 8;
  if (pw > vw - 16) { pop.style.maxWidth = (vw - 16) + 'px'; left = 8; }
  // 弹层比视口还高 → 限高 + 滚动，避免底部被裁
  if (ph > vh - 16) { pop.style.maxHeight = (vh - 16) + 'px'; pop.style.overflowY = 'auto'; top = 8; }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;

  function close() {
    pop.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function pickAndClose(icon) {
    onPick?.(icon);
    close();
  }
  const onDoc = (e) => {
    if (e.target.closest('#emoji-popover')) return;
    if (!pop.contains(e.target) && e.target !== anchorEl) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  // 网格点击：直接确认
  pop.querySelector('.icon-picker-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.icon-picker-cell');
    if (!b) return;
    pickAndClose(b.dataset.e);
  });
  // 输入框 Enter / "✓" 确认按钮：用自定义值
  const input = pop.querySelector('.icon-picker-input');
  pop.querySelector('.icon-picker-confirm').addEventListener('click', () => {
    const v = input.value.trim();
    if (v) pickAndClose(v);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); if (v) pickAndClose(v); }
  });
  // 恢复默认按钮
  pop.querySelector('.icon-picker-reset').addEventListener('click', () => {
    pickAndClose(defaultIcon || '');
  });

  setTimeout(() => input.focus(), 30);
}
window.openIconPicker = openIconPicker;
function promptWorkspaceEdit({ mode, ws } = {}) {
  const isCreate = mode === 'create';
  const initIcon = ws?.icon || '📒';
  const initName = ws?.name || '';
  const body = document.createElement('div');
  body.innerHTML = `
    <label style="margin-top:0;">图标</label>
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 10px;">
      <input type="text" id="ws-icon-input" maxlength="4" value="${initIcon}" style="width:56px;text-align:center;font-size:22px;font-family:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif;line-height:1;padding:6px;">
      <span style="color:var(--text-tertiary);font-size:12px;">可输入任意 emoji 或单个文字，或从下方挑选</span>
    </div>
    <div id="ws-emoji-grid" style="display:grid;grid-template-columns:repeat(10,1fr);gap:4px;margin-bottom:14px;max-height:220px;overflow-y:auto;padding:4px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);">
      ${WS_EMOJI_PRESETS.map(e => `<button type="button" class="ws-emoji-pick" data-e="${e}" title="${e}" style="height:30px;width:30px;border:none;border-radius:6px;background:transparent;font-size:18px;cursor:pointer;font-family:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif;line-height:1;">${e}</button>`).join('')}
    </div>
    <label>名称</label>
    <input type="text" id="ws-name-input" value="${escapeHtml(initName)}" placeholder="例如：工作 / 学习 / 生活" maxlength="40">
  `;
  // 点击 emoji 网格 → 填入 input
  body.querySelector('#ws-emoji-grid').addEventListener('click', (e) => {
    const b = e.target.closest('button.ws-emoji-pick');
    if (!b) return;
    body.querySelector('#ws-icon-input').value = b.dataset.e;
    // 视觉高亮
    body.querySelectorAll('.ws-emoji-pick').forEach(x => x.style.background = 'transparent');
    b.style.background = 'var(--accent-bg)';
  });
  openModal({
    title: isCreate ? '新建笔记本' : '重命名笔记本',
    body,
    footer: [
      { label: '取消', class: 'secondary-btn', onClick: () => closeModal() },
      { label: isCreate ? '创建' : '保存', class: 'primary-btn', onClick: () => {
        const icon = body.querySelector('#ws-icon-input').value.trim() || '📒';
        const name = body.querySelector('#ws-name-input').value.trim();
        if (!name) { toast('请输入名称', 'warning'); return; }
        if (isCreate) {
          const newWs = storage.createWorkspace(name, icon);
          storage.setActiveWorkspace(newWs.id);
        } else {
          storage.renameWorkspace(ws.id, name, icon);
        }
        closeModal();
        tree.render();
        refreshWorkspaceSwitcher();
      } },
    ],
  });
  setTimeout(() => body.querySelector('#ws-name-input')?.focus(), 50);
}

/** 删除笔记本对话框：3 选 1 处理子笔记 */
function promptDeleteWorkspace(ws, noteCount) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p style="margin:0 0 12px;color:var(--text);">删除笔记本「<strong>${escapeHtml(ws.name)}</strong>」？该本子下有 <strong>${noteCount}</strong> 篇笔记，请选择如何处理：</p>
    <div class="ws-del-options">
      <label class="ws-del-opt">
        <input type="radio" name="ws-del" value="migrate" checked>
        <div>
          <div class="ws-del-title">迁移到其他笔记本</div>
          <div class="ws-del-desc">所有笔记移到第一个剩余笔记本，不会丢失（推荐）</div>
        </div>
      </label>
      <label class="ws-del-opt">
        <input type="radio" name="ws-del" value="trash">
        <div>
          <div class="ws-del-title">移到回收站</div>
          <div class="ws-del-desc">笔记进入回收站，30 天内可恢复</div>
        </div>
      </label>
      <label class="ws-del-opt">
        <input type="radio" name="ws-del" value="purge">
        <div>
          <div class="ws-del-title" style="color:var(--danger);">彻底删除</div>
          <div class="ws-del-desc">连同笔记一起永久删除，<strong>无法找回</strong></div>
        </div>
      </label>
    </div>
  `;
  openModal({
    title: '删除笔记本',
    body,
    footer: [
      { label: '取消', class: 'secondary-btn', onClick: () => closeModal() },
      { label: '确认删除', class: 'danger-btn', onClick: () => {
        const v = body.querySelector('input[name="ws-del"]:checked')?.value || 'migrate';
        const r = storage.deleteWorkspace(ws.id, v);
        closeModal();
        if (r) {
          tree.render();
          refreshWorkspaceSwitcher();
          const msg = v === 'migrate' ? `已删除并迁移 ${r.affectedCount} 篇笔记`
                    : v === 'trash'   ? `已删除并把 ${r.affectedCount} 篇笔记移到回收站`
                    :                   `已彻底删除笔记本及 ${r.affectedCount} 篇笔记`;
          toast(msg, 'success');
        }
      } },
    ],
  });
}

/* ===== Emoji 选择器 ===== */
let _emojiPicker = null;
let _emojiTargetInput = null;  // 表情触发时记住的输入框
let _emojiTargetRange = null;  // 如果是 contenteditable，记住选区
// 分号连击计时：只有「两次分号物理按键在窗口内连按」才唤出表情，
// 避免在已存在的分号后任何时候补一个分号也误触发。
const EMOJI_DOUBLE_WINDOW = 450;  // ms
let _semiKeyTimes = [];
window.toggleEmojiPicker = toggleEmojiPicker;

/** 在编辑区输入 ;; 后弹出表情选择器在光标处。
 *  选择 `;;` 而不是 `:` 是因为冒号在中文写作中（"如下："）会高频出现，容易误触。
 *  ;; 几乎不会出现在自然文字里，且双键连击容易记忆。
 *  双重监听 input + keyup，确保各模式下都能触发。 */
function installEmojiTrigger() {
  // 物理分号键计时（中英文 IME 下 e.code 都是 'Semicolon'；shift+; 是冒号，排除）
  document.addEventListener('keydown', (e) => {
    const isSemi = (e.code === 'Semicolon' && !e.shiftKey) || e.key === ';' || e.key === '；';
    if (!isSemi || e.ctrlKey || e.metaKey || e.altKey) return;
    _semiKeyTimes.push(performance.now());
    if (_semiKeyTimes.length > 2) _semiKeyTimes.shift();
  }, true);
  document.addEventListener('input', tryEmojiTrigger, true);
  document.addEventListener('keyup', (e) => {
    if (e.key === ';' || e.key === '；') tryEmojiTrigger();
  }, true);
  // 中文 IME 合成结束时也兜底（keyup 在 IME composing 时拿到的是 'Process'）
  document.addEventListener('compositionend', tryEmojiTrigger, true);
}

/* ===== 双击反引号唤起命令面板 =====
 * 窗口内任意位置快速连按两下 ` 键（英文输出 `、中文输入法输出 ·）唤起命令面板；
 * 在编辑区/输入框里会先删掉刚输入的两个字符。时间窗 200ms（与双击空格跳出格式同逻辑），
 * 慢速逐个输入 `` / ·· 不会触发，不影响正常输入代码围栏 ``` 等场景。 */
let _btKeyTimes = [];
const PALETTE_DOUBLE_WINDOW = 200; // ms

function _btDoubleInWindow() {
  return _btKeyTimes.length >= 2
    && (_btKeyTimes[_btKeyTimes.length - 1] - _btKeyTimes[_btKeyTimes.length - 2]) <= PALETTE_DOUBLE_WINDOW;
}

function installPaletteTrigger() {
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    _btKeyTimes.push(performance.now());
    if (_btKeyTimes.length > 2) _btKeyTimes.shift();
    // 焦点不在任何文本输入处（树/空白区等）：按键不会产生字符，直接在第二击唤起
    const ae = document.activeElement;
    const editable = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
    if (!editable && _btDoubleInWindow()) {
      e.preventDefault();
      _btKeyTimes = [];
      window.palette?.open();
    }
  }, true);
  document.addEventListener('input', tryPaletteTrigger, true);
  document.addEventListener('compositionend', tryPaletteTrigger, true);
}

function tryPaletteTrigger() {
  if (!_btDoubleInWindow()) return;
  const ae = document.activeElement;
  if (ae && ae.closest && ae.closest('#palette-overlay')) return; // 面板已打开：别套娃

  // —— 焦点在普通 input / textarea（标题栏、搜索框等）：删掉刚输入的两个字符再唤起
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && typeof ae.selectionStart === 'number') {
    const pos = ae.selectionStart;
    const before = (ae.value || '').slice(0, pos);
    if (!/[`·]{2}$/.test(before)) return;
    _btKeyTimes = [];
    ae.value = ae.value.slice(0, pos - 2) + ae.value.slice(pos);
    ae.selectionStart = ae.selectionEnd = pos - 2;
    ae.dispatchEvent(new Event('input', { bubbles: true }));
    window.palette?.open();
    return;
  }

  // —— 焦点在 Tiptap 编辑区
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const node = sel.getRangeAt(0).startContainer;
  const target = node.nodeType === 3 ? node.parentElement : node;
  if (!target?.closest('.ProseMirror')) return;
  if (target.closest('pre, code')) return; // 代码块/行内代码里照常输入反引号
  // 推迟到下一轮事件循环：等 ProseMirror 把刚输入的字符收进 state 再检查与删除
  setTimeout(() => {
    const inst = window.editor?.instance?.();
    if (!inst) return;
    const { state } = inst;
    const $f = state.selection.$from;
    const leftText = state.doc.textBetween($f.start(), $f.pos, '\ufffc', '\ufffc');
    if (!/[`·]{2}$/.test(leftText)) return;
    _btKeyTimes = [];
    inst.chain().focus().deleteRange({ from: $f.pos - 2, to: $f.pos }).run();
    window.palette?.open();
  }, 0);
}

/** 最近两次分号物理按键是否在连击窗口内（用于时间门：拒绝「旧分号 + 很久后再敲一个」的误触发）。 */
function _semiDoubleInWindow() {
  return _semiKeyTimes.length >= 2
    && (_semiKeyTimes[_semiKeyTimes.length - 1] - _semiKeyTimes[_semiKeyTimes.length - 2]) <= EMOJI_DOUBLE_WINDOW;
}
window.tryEmojiTrigger = tryEmojiTrigger;

function tryEmojiTrigger() {
  const ae = document.activeElement;

  // —— 分支 A：焦点在普通 input / textarea
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && typeof ae.selectionStart === 'number') {
    const pos = ae.selectionStart;
    const before = (ae.value || '').slice(0, pos);
    if (!/[;；]{2}$/.test(before)) return;
    if (!_semiDoubleInWindow()) return;
    _semiKeyTimes = [];
    ae.value = ae.value.slice(0, pos - 2) + ae.value.slice(pos);
    ae.selectionStart = ae.selectionEnd = pos - 2;
    ae.dispatchEvent(new Event('input', { bubbles: true }));
    _emojiTargetInput = ae;
    _emojiTargetRange = null;
    const ir = ae.getBoundingClientRect();
    const parentPop = ae.closest('.icon-picker-popover');
    let fakeAnchor;
    if (parentPop) {
      const pr = parentPop.getBoundingClientRect();
      const emojiW = 300;
      const spaceRight = window.innerWidth - pr.right;
      const spaceLeft = pr.left;
      if (spaceRight >= emojiW + 8) {
        fakeAnchor = { getBoundingClientRect: () => ({ left: pr.right + 4, right: pr.right + 4, top: pr.top, bottom: pr.top, width: 0, height: 0, x: pr.right + 4, y: pr.top }) };
      } else if (spaceLeft >= emojiW + 8) {
        fakeAnchor = { getBoundingClientRect: () => ({ left: pr.left - emojiW - 4, right: pr.left - 4, top: pr.top, bottom: pr.top, width: 0, height: 0, x: pr.left - emojiW - 4, y: pr.top }) };
      } else {
        fakeAnchor = { getBoundingClientRect: () => ({ left: ir.left, right: ir.right, top: pr.bottom + 4, bottom: pr.bottom + 4, width: 0, height: 0, x: ir.left, y: pr.bottom + 4 }) };
      }
    } else {
      fakeAnchor = { getBoundingClientRect: () => ({ left: ir.left + 8, right: ir.left + 8, top: ir.top, bottom: ir.bottom, width: 0, height: ir.height, x: ir.left + 8, y: ir.top }) };
    }
    const pop = document.getElementById('emoji-popover');
    if (pop && !pop.classList.contains('hidden')) pop.classList.add('hidden');
    setTimeout(() => toggleEmojiPicker(fakeAnchor), 0);
    return;
  }

  // —— 分支 A2：焦点在 contenteditable（笔记本/笔记重命名时是 div contenteditable）
  // This contenteditable is not inside the editor (e.g., rename fields)
  if (ae && ae.isContentEditable && !ae.closest?.('#editor')) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent || '';
    const offset = range.startOffset;
    const before = text.slice(Math.max(0, offset - 2), offset);
    if (before !== ';;' && before !== '；；') return;
    if (!_semiDoubleInWindow()) return;
    _semiKeyTimes = [];
    // 删掉刚输入的 ;;
    const newRange = document.createRange();
    newRange.setStart(node, offset - 2);
    newRange.setEnd(node, offset);
    sel.removeAllRanges();
    sel.addRange(newRange);
    document.execCommand('insertText', false, '');
    // 记住选区供表情插入恢复
    _emojiTargetInput = ae;
    _emojiTargetRange = sel.getRangeAt(0).cloneRange();
    // 触发位置：当前光标 rect
    let rect;
    try {
      const probe = document.createElement('span');
      probe.textContent = '\u200b';
      _emojiTargetRange.insertNode(probe);
      rect = probe.getBoundingClientRect();
      probe.remove();
    } catch (_) { rect = ae.getBoundingClientRect(); }
    const fakeAnchor = {
      getBoundingClientRect: () => ({
        left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom,
        width: 0, height: rect.height || 18, x: rect.left, y: rect.top,
      })
    };
    const pop = document.getElementById('emoji-popover');
    if (pop && !pop.classList.contains('hidden')) pop.classList.add('hidden');
    setTimeout(() => toggleEmojiPicker(fakeAnchor), 0);
    return;
  }

  // —— Branch B: focus in the Tiptap editor
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== 3 && !(node.nodeType === 1 && node.isContentEditable)) return;
  const target = node.nodeType === 3 ? node.parentElement : node;
  if (!target?.closest('.ProseMirror')) return;
  if (target.closest('pre, code')) return;

  // 中文 IME 在 IR 模式下会把 `；` 包成 marker span，第一个 ; 和第二个 ; 不一定在同一个 textNode；
  // 因此扫"段落级容器"的全文末尾，而不是只看当前 textNode
  const wrap = target.closest(
    '.ProseMirror p, .ProseMirror li, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6, .ProseMirror blockquote'
  ) || target.closest('.ProseMirror');
  if (!wrap) return;
  const all = (wrap.textContent || '').replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  if (!/[;；][;；]\s*$/.test(all)) return;
  if (!_semiDoubleInWindow()) return;
  _semiKeyTimes = [];
  if (window.__MD_DEBUG__) console.log('[;;]', JSON.stringify(all.slice(-6)));

  _emojiTargetInput = null;
  _emojiTargetRange = null;

  const pop = document.getElementById('emoji-popover');
  if (pop && !pop.classList.contains('hidden')) pop.classList.add('hidden');

  // 关键：本函数在 document 捕获阶段触发，ProseMirror 此刻常常还没把刚输入的 ; 同步进 state
  // （英文→光标停在 ;; 之前导致删错位置删到引号；中文→只收进一个 ; 导致残留）。
  // 推迟到下一轮事件循环（PM 已处理完输入），再用新鲜 state 删光标两侧相邻分号、且最多删 2 个。
  setTimeout(() => {
    const inst = window.editor?.instance?.();
    if (inst) {
      const { state } = inst;
      const $f = state.selection.$from;
      const leftText = state.doc.textBetween($f.start(), $f.pos, '\ufffc', '\ufffc');
      const rightText = state.doc.textBetween($f.pos, $f.end(), '\ufffc', '\ufffc');
      const leftN = (leftText.match(/[;；]+$/) || [''])[0].length;
      const rightN = (rightText.match(/^[;；]+/) || [''])[0].length;
      // 只删触发用的 2 个：优先光标右侧（中文光标常落在两个 ；之间），不足再从左侧补
      const needRight = Math.min(rightN, 2);
      const needLeft = Math.min(leftN, 2 - needRight);
      const from = $f.pos - needLeft;
      const to = $f.pos + needRight;
      if (to > from) inst.chain().focus().deleteRange({ from, to }).run();
    }
    const r = window.getSelection();
    const rect = getCursorRectSafe((r && r.rangeCount) ? r.getRangeAt(0) : range);
    const fakeAnchor = {
      getBoundingClientRect: () => ({
        left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom || (rect.top + 18),
        width: 0, height: rect.height || 18,
        x: rect.left, y: rect.top,
      })
    };
    toggleEmojiPicker(fakeAnchor);
  }, 0);
}

/** 取光标位置矩形；range.getBoundingClientRect() 在新建块/空块开头会返回 (0,0,0,0)，
 *  这时弹窗会飞到窗口左上角。这里逐级 fallback。 */
function getCursorRectSafe(range) {
  let rect = range.getBoundingClientRect();
  if (!rect.left && !rect.top && !rect.width && !rect.height) {
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
  if (!rect.left && !rect.top) {
    const node = range.startContainer;
    const el = node?.nodeType === 3 ? node.parentElement : node;
    if (el?.getBoundingClientRect) {
      const er = el.getBoundingClientRect();
      rect = { left: er.left, top: er.top, bottom: er.bottom, right: er.right, width: er.width, height: er.height };
    }
  }
  if (!rect.left && !rect.top) {
    const v = document.querySelector('#editor');
    if (v) {
      const er = v.getBoundingClientRect();
      const x = er.left + 80, y = er.top + 80;
      rect = { left: x, top: y, bottom: y + 20, right: x + 80, width: 80, height: 20 };
    }
  }
  return rect;
}
/** 把一个 emoji 插入到当前记住的目标（input / contenteditable / 编辑器），并记入「最近」 */
function insertEmojiUnicode(u) {
  if (!u) return;
  const t = _emojiTargetInput;
  let inserted = false;
  if (t && document.body.contains(t)) {
    if (typeof t.selectionStart === 'number' && 'value' in t) {
      const start = t.selectionStart || 0, end = t.selectionEnd || 0;
      t.value = t.value.slice(0, start) + u + t.value.slice(end);
      t.selectionStart = t.selectionEnd = start + u.length;
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.focus({ preventScroll: true });
      inserted = true;
    } else if (t.isContentEditable) {
      t.focus({ preventScroll: true });
      if (_emojiTargetRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        try { sel.addRange(_emojiTargetRange); } catch (_) {}
      }
      document.execCommand('insertText', false, u);
      t.dispatchEvent(new Event('input', { bubbles: true }));
      inserted = true;
    }
  }
  if (!inserted) {
    const v = window.editor?.instance?.();
    if (v) { v.chain().focus().insertContent(u).run(); inserted = true; }
  }
  if (inserted) recordRecentEmoji(u);
}

/** 记录最近使用的 emoji（去重、最新在前、最多 18 个） */
function recordRecentEmoji(u) {
  try {
    let list = window.storage?.getSetting('recentEmojis') || [];
    if (!Array.isArray(list)) list = [];
    list = list.filter(x => x !== u);
    list.unshift(u);
    if (list.length > 40) list = list.slice(0, 40); // 单行+横向滚动后可多存一些
    window.storage?.setSetting('recentEmojis', list);
  } catch (_) {}
  const pop = document.getElementById('emoji-popover');
  if (pop && !pop.classList.contains('hidden')) renderEmojiRecentRow(pop);
}

/** 在表情弹窗顶部渲染「最近」快捷栏；无记录时隐藏 */
function renderEmojiRecentRow(pop) {
  let row = pop.querySelector('#emoji-recent-row');
  const list = (window.storage?.getSetting('recentEmojis') || []).filter(Boolean);
  if (!row) {
    row = document.createElement('div');
    row.id = 'emoji-recent-row';
    pop.insertBefore(row, pop.firstChild);
    row.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-e]');
      if (!b) return;
      insertEmojiUnicode(b.dataset.e);
    });
    // 滚轮（纵向）→ 横向滚动，前后翻看更多最近常用
    row.addEventListener('wheel', (e) => {
      const grid = row.querySelector('.emoji-recent-grid');
      if (!grid || grid.scrollWidth <= grid.clientWidth) return;
      e.preventDefault();
      grid.scrollLeft += (e.deltaY || e.deltaX);
    }, { passive: false });
  }
  if (!list.length) { row.classList.add('hidden'); row.innerHTML = ''; return; }
  row.classList.remove('hidden');
  row.innerHTML = '<div class="emoji-recent-label">最近</div><div class="emoji-recent-grid">'
    + list.map(e => `<button type="button" data-e="${e}" title="${e}">${e}</button>`).join('')
    + '</div>';
}

// emoji-picker-element 通过 Shadow DOM 渲染，外层 CSS 变量在某些版本不生效，
// 直接读取当前主题的计算色注入 shadowRoot，保证所有主题（含 nord/dracula/gruvbox 等暗色）都一致。
function _applyEmojiPickerTheme(picker) {
  if (!picker) return;
  const isDark = document.body.classList.contains('theme-is-dark');
  picker.classList.toggle('dark', isDark);
  picker.classList.toggle('light', !isDark);
  const root = picker.shadowRoot;
  if (!root) return;
  const cs = getComputedStyle(document.body);
  const v = (name, fb) => { const x = cs.getPropertyValue(name).trim(); return x || fb; };
  const bg = v('--bg-elevated', v('--bg', isDark ? '#262934' : '#ffffff'));
  const text = v('--text', isDark ? '#e6e8eb' : '#1d1f23');
  const textSec = v('--text-secondary', text);
  const border = v('--border', isDark ? '#3a3f4d' : '#e6e8eb');
  const inputBg = v('--bg-secondary', v('--bg-tertiary', isDark ? '#1d1f23' : '#f5f6f7'));
  const hoverBg = v('--bg-tertiary', isDark ? '#3a3f4d' : '#eef0f3');
  const activeBg = v('--accent-bg', isDark ? '#3a3f4d' : '#dbe8ff');
  let style = root.querySelector('style[data-md-injected]');
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('data-md-injected', '1');
    root.appendChild(style);
  }
  style.textContent = `
    :host, .picker { background: ${bg} !important; color: ${text} !important; }
    .nav, .tabpanel, .search-row, .skintone-button, .indicator-wrapper, .message { background: ${bg} !important; color: ${text} !important; }
    .category { color: ${textSec} !important; background: ${bg} !important; }
    input.search { background: ${inputBg} !important; color: ${text} !important; border-color: ${border} !important; }
    .favorites, .pad-top { display: none !important; }
    button.emoji:hover, button.emoji:focus { background: ${hoverBg} !important; }
    button.emoji.active { background: ${activeBg} !important; }
  `;
}

function toggleEmojiPicker(anchorEl) {
  const pop = document.getElementById('emoji-popover');
  if (!pop.classList.contains('hidden')) {
    pop.classList.add('hidden');
    return;
  }
  if (!_emojiPicker) {
    _emojiPicker = document.createElement('emoji-picker');
    // 中文表情数据（含中文 keywords，可中文搜索如 "笑" "哭"）
    _emojiPicker.dataSource = 'https://cdn.jsdelivr.net/npm/emoji-picker-element-data@1/zh/emojibase/data.json';
    _emojiPicker.locale = 'zh';
    // emoji-picker-element 默认搜索是前缀匹配，对中文不友好；
    // 改成"包含匹配"：拦截搜索框 input，把搜索词拆字符做模糊 OR
    setTimeout(() => {
      const root = _emojiPicker.shadowRoot;
      const search = root?.querySelector('input.search');
      if (!search) return;
      // 给原 input 监听加一道二级过滤（库里搜不到时，我们再扫整个表情列表）
      const customFilter = () => {
        const q = (search.value || '').trim();
        if (!q) return; // 空查询不干预
        // 让库做完它的搜索后，如果结果为空，我们手动补一遍模糊匹配
        setTimeout(() => {
          const tabPanel = root.querySelector('.tabpanel');
          const noResults = root.querySelector('[part="search-empty"]') || tabPanel?.querySelector('.no-results');
          if (!noResults || noResults.style?.display === 'none') return;
          // 库已经找不到结果——我们自己用 database 模糊匹配
          if (!_emojiPicker.database) return;
          _emojiPicker.database.getAllEmoji?.().then(all => {
            const matched = all.filter(em => {
              const ka = (em.shortcodes || []).join(' ').toLowerCase();
              const kb = (em.tags || []).join(' ').toLowerCase();
              const kc = (em.annotation || '').toLowerCase();
              const kw = (em.emoticon || '') + ' ' + (em.unicode || '');
              const text = ka + ' ' + kb + ' ' + kc + ' ' + kw;
              return text.includes(q.toLowerCase());
            }).slice(0, 64);
            if (matched.length === 0) return;
            // 用一个浮层覆盖在 picker 内显示模糊匹配结果
            let custom = root.getElementById('md-fuzzy-list');
            if (!custom) {
              custom = document.createElement('div');
              custom.id = 'md-fuzzy-list';
              custom.style.cssText = 'position:absolute;left:0;right:0;top:84px;bottom:0;overflow-y:auto;background:var(--background,#fff);padding:8px;display:flex;flex-wrap:wrap;gap:4px;z-index:5;';
              root.querySelector('.picker').appendChild(custom);
            }
            custom.innerHTML = matched.map(em =>
              `<button data-u="${em.unicode}" title="${em.annotation||''}" style="font-size:22px;width:36px;height:36px;border:none;background:transparent;cursor:pointer;border-radius:6px;">${em.unicode}</button>`
            ).join('');
            custom.onclick = (e) => {
              const u = e.target?.dataset?.u;
              if (!u) return;
              _emojiPicker.dispatchEvent(new CustomEvent('emoji-click', { detail: { unicode: u } }));
              custom.remove();
            };
          }).catch(() => {});
        }, 50);
      };
      const cleanCustom = () => { root.getElementById('md-fuzzy-list')?.remove(); };
      search.addEventListener('input', () => { cleanCustom(); customFilter(); });
    }, 200);
    pop.appendChild(_emojiPicker);
    _emojiPicker.addEventListener('emoji-click', (e) => {
      const u = e.detail?.unicode;
      if (!u) return;
      insertEmojiUnicode(u);
    });
    // 等 shadowRoot 准备好（通常下一帧就有），按当前主题注入样式
    requestAnimationFrame(() => {
      _applyEmojiPickerTheme(_emojiPicker);
      setTimeout(() => _applyEmojiPickerTheme(_emojiPicker), 50);
      setTimeout(() => _applyEmojiPickerTheme(_emojiPicker), 200);
    });
  }
  // 每次打开都按当前主题刷新（覆盖所有暗色主题，并支持中途换主题）
  _applyEmojiPickerTheme(_emojiPicker);
  // 顶部「最近」快捷栏（每次打开刷新）
  renderEmojiRecentRow(pop);
  // 先显示再测量尺寸，便于精确避免出屏
  pop.style.visibility = 'hidden';
  pop.classList.remove('hidden');
  pop.style.left = '0px';
  pop.style.top = '0px';
  pop.style.right = 'auto';
  requestAnimationFrame(() => {
    let r = anchorEl.getBoundingClientRect();
    // 最终保险：anchor rect 为 0 时回退到编辑器中心，避免飞到窗口左上角
    if (!r.left && !r.top && !r.width && !r.height) {
      const v = document.querySelector('#editor') || document.body;
      const er = v.getBoundingClientRect();
      r = { left: er.left + 80, top: er.top + 80, bottom: er.top + 100, right: er.left + 80, width: 0, height: 20 };
    }
    const pw = pop.offsetWidth || 300;
    const ph = pop.offsetHeight || 320;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    if (top + ph > window.innerHeight - 8) {
      const aboveTop = r.top - ph - 6;
      if (aboveTop >= 8) {
        top = aboveTop; // 下方放不下 → 翻到光标上方
      } else {
        // 上下都放不下：贴边放置，并横向挪开，避免盖住光标所在行、看不见输入了什么
        top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
        left = (r.left + 24 + pw <= window.innerWidth - 8) ? r.left + 24 : Math.max(8, r.left - pw - 24);
      }
    }
        pop.style.left = `${Math.round(left)}px`;
        pop.style.top  = `${Math.round(top)}px`;
        pop.style.visibility = 'visible';
        // 焦点转给 picker 的搜索框（仅为支持中文搜索；不再依赖额外的方向键拦截）
        setTimeout(() => {
          const search = _emojiPicker.shadowRoot?.querySelector('input.search');
          if (search) search.focus();
        }, 50);
      });
  // 关闭逻辑：点空白 / Esc 都关，关掉时把焦点恢复给原编辑器或 input
  const closePicker = () => {
    if (pop.classList.contains('hidden')) return;
    pop.classList.add('hidden');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    if (_emojiTargetInput && document.body.contains(_emojiTargetInput)) {
      _emojiTargetInput.focus({ preventScroll: true });
    } else {
      // Avoid calling focus() here which may reset scroll position
      // ✓ 直接 focus contenteditable 元素，加 preventScroll 保证视图位置不变
      const ed = document.querySelector(
        '#editor .ProseMirror'
      );
      if (ed) {
        try { ed.focus({ preventScroll: true }); } catch (_) { ed.focus(); }
      }
    }
  };
  const onDoc = (e) => {
    if (!pop.contains(e.target) && e.target !== anchorEl) closePicker();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function refreshEditorModeBar() {
  const bar = document.getElementById('editor-mode-bar');
  document.querySelector('.focus-float-hint')?.remove();
  if (!bar) return;
  bar.style.pointerEvents = '';
  let msg = '';
  if (document.body.classList.contains('sync-protection-mode')) {
    bar.innerHTML = '检测到其他设备的更新，正在同步…（首次或内容较多时会久一些，请稍候）<span class="sync-protection-skip">仍要立即编辑</span>';
    bar.classList.remove('hidden');
    bar.style.pointerEvents = 'auto';
    bar.querySelector('.sync-protection-skip')?.addEventListener('click', () => {
      window._endSyncProtection?.();
      toast('已解除锁定；后台同步完成后，这里的改动可能被云端版本覆盖', 'info', { duration: 6000 });
    });
    return;
  } else if (document.body.classList.contains('md-focus-mode')) {
    bar.textContent = '';
    bar.classList.add('hidden');
    const hint = document.createElement('div');
    hint.className = 'focus-float-hint';
    hint.textContent = '已进入专注模式 · 按 F10 退出';
    document.body.appendChild(hint);
    setTimeout(() => hint.remove(), 4800);
    return;
  } else if (document.body.classList.contains('cloze-mode')) {
    msg = '挖空模式 · 悬停查看 · Alt+M 标记';
  } else if (document.body.classList.contains('readonly-mode')) {
    msg = '阅读模式 · 点击右上角按钮或按 Ctrl+Shift+E 退出';
  }
  if (msg) {
    bar.textContent = msg;
    bar.classList.remove('hidden');
  } else {
    bar.textContent = '';
    bar.classList.add('hidden');
  }
}
window.refreshEditorModeBar = refreshEditorModeBar;

function toggleReadonlyMode() {
  const on = document.body.classList.toggle('readonly-mode');
  if (editor.setReadonly) editor.setReadonly(on);
  document.getElementById('btn-readonly')?.classList.toggle('active', on);
  refreshEditorModeBar();
}
window.toggleReadonlyMode = toggleReadonlyMode;

function toggleCurrentPin() {
  const id = editor.currentId();
  if (!id) { toast('请先打开一条笔记', 'warning'); return; }
  palette.togglePin(id);
}

/** 把 markdown 里所有"图片相关的源码"剥掉，避免 base64 / zhinote 引用 / <img> 长串 HTML
 *  把字数统计搞成几万。剥掉的位置不是简单删除，而是用 1 个汉字"图"占位，
 *  这样字数仍然反映"这里有 1 张图"，但不被 base64 长度污染。 */
function stripImageMarkdownForCount(md) {
  if (!md) return md;
  return md
    // ![alt](src) — 不管 src 是 data:image / zhinote://img / http(s) 都剥
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '图')
    // <img ...> HTML 标签（含 base64 src / zhinote src / 任意属性）
    .replace(/<img\b[^>]*>/gi, '图')
    // 兜底：散落在外的 base64 字符串
    .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+\/=]+/gi, '图')
    .replace(/zhinote:\/\/img\/[a-z0-9]+l[a-z0-9]+/gi, '图');
}

function updateWordCount() {
  const el = document.getElementById('word-count');
  if (!el) return;
  const id = editor.currentId();
  if (!id) { el.textContent = '0 字'; el.setAttribute('data-tip', '未打开笔记'); return; }
  const raw = editor.getValue() || '';
  // 关键：先剥掉图片相关源码，再统计 → base64 / zhinote 引用 / <img> 长串都不会污染字数
  const text = stripImageMarkdownForCount(raw);
  const chars = text.replace(/\s/g, '').length;
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (text.match(/\b[a-zA-Z]+\b/g) || []).length;
  const lines = text ? text.split('\n').length : 0;
  // 顺便统计一下图片数量，写入 tip，让用户对"图"占位 1 字的逻辑有感
  const imgCount = (raw.match(/!\[[^\]]*\]\([^)]*\)/g)?.length || 0)
                 + (raw.match(/<img\b[^>]*>/gi)?.length || 0);
  el.textContent = `${chars} 字`;
  el.setAttribute('data-tip',
    `中文 ${cn}  ·  英文 ${en}  ·  共 ${chars} 字  ·  ${lines} 行` +
    (imgCount ? `  ·  图片 ${imgCount}（每张计 1 字）` : ''));
  bindAppTooltip(el);
}

/** 通用 hover tooltip：用 fixed 元素替代 native title，响应更快 */
let _tooltipEl = null;
let _tipTimer = null;
const TIP_DELAY = 180;

function showTooltipFor(el, text) {
  if (!text) return;
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'app-tooltip';
    document.body.appendChild(_tooltipEl);
  }
  _tooltipEl.textContent = text;
  _tooltipEl.classList.add('visible');
  requestAnimationFrame(() => {
    if (!_tooltipEl) return;
    const r = el.getBoundingClientRect();
    const tw = _tooltipEl.offsetWidth;
    const th = _tooltipEl.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    let top  = r.bottom + 6;
    if (left + tw > window.innerWidth - 6) left = window.innerWidth - tw - 6;
    if (left < 6) left = 6;
    if (top + th > window.innerHeight - 6) top = r.top - th - 6;
    _tooltipEl.style.left = `${Math.round(left)}px`;
    _tooltipEl.style.top  = `${Math.round(top)}px`;
  });
}

function hideTooltip() {
  clearTimeout(_tipTimer);
  _tipTimer = null;
  _tooltipEl?.classList.remove('visible');
}

function bindAppTooltip(el) {
  if (el._tipBound) return;
  if (el.closest('#bubble-menu')) return;
  el._tipBound = true;
  if (el.hasAttribute('title')) {
    el.setAttribute('data-tip', el.getAttribute('title'));
    el.removeAttribute('title');
  }
  el.addEventListener('mouseenter', () => {
    const tip = el.getAttribute('data-tip');
    if (!tip) return;
    clearTimeout(_tipTimer);
    _tipTimer = setTimeout(() => showTooltipFor(el, tip), TIP_DELAY);
  });
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('mousedown', hideTooltip);
}

/** 全局：自动为所有 [title] 元素绑定快速 tooltip（用事件委托）
 *  将 title 转为 data-tip 后永久移除 title，避免原生 tooltip 干扰 */
(function initGlobalTooltip() {
  let _hoverTarget = null;
  document.addEventListener('pointerenter', (e) => {
    // 表格单元格内的链接：伪元素提示会被 .tableWrapper 裁切，
    // 这里补一个 data-tip，让它走下面的浮动 tooltip（贴 body、不裁切）。
    const tlink = e.target.closest?.('#editor .ProseMirror .tableWrapper a');
    if (tlink && !tlink.hasAttribute('data-tip')) {
      const isFile = (tlink.getAttribute('href') || '').startsWith('file:///');
      tlink.setAttribute('data-tip', isFile ? 'Ctrl + 点击打开文件' : 'Ctrl + 点击打开');
    }
    const el = e.target.closest?.('[title], [data-tip]');
    if (!el || el._tipBound) return;
    if (el.closest('#bubble-menu')) return;
    _hoverTarget = el;
    if (el.hasAttribute('title')) {
      el.setAttribute('data-tip', el.getAttribute('title'));
      el.removeAttribute('title');
    }
    const tip = el.getAttribute('data-tip');
    if (!tip) return;
    clearTimeout(_tipTimer);
    _tipTimer = setTimeout(() => showTooltipFor(el, tip), TIP_DELAY);
  }, true);
  document.addEventListener('pointerleave', (e) => {
    const el = e.target.closest?.('[data-tip]') || _hoverTarget;
    if (!el) return;
    if (el === _hoverTarget) _hoverTarget = null;
    hideTooltip();
  }, true);
  document.addEventListener('pointerdown', hideTooltip, true);
})();
window.updateWordCount = updateWordCount;

function renderWelcomeRecent() {
  const el = document.getElementById('welcome-recent');
  if (!el) return;
  const recent = (storage.getSetting('recent') || []).slice(0, 6);
  const notes = recent.map(id => storage.get(id)).filter(Boolean);
  if (!notes.length) { el.innerHTML = ''; return; }

  el.innerHTML = '<div class="welcome-recent-title">最近编辑</div>';
  for (const n of notes) {
    const item = document.createElement('div');
    item.className = 'welcome-recent-item';
    const dt = new Date(n.updatedAt);
    item.innerHTML = `
      <span style="color:var(--text-tertiary);">📄</span>
      <span class="welcome-recent-item-title">${escapeHtml(n.title || '无标题')}</span>
      <span class="welcome-recent-item-time">${dt.getMonth()+1}/${dt.getDate()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}</span>
    `;
    item.addEventListener('click', () => editor.open(n.id));
    el.appendChild(item);
  }
}
window.renderWelcomeRecent = renderWelcomeRecent;

function toggleClozeMode() {
  const on = document.body.classList.toggle('cloze-mode');
  document.getElementById('btn-cloze')?.classList.toggle('active', on);
  refreshEditorModeBar();
}

window.toggleMarkOnSelection = toggleMarkOnSelection;
/** 标记挖空选区：用编辑器 highlight 扩展（存为 ==文字==，与彩色高亮菜单同源，但快捷键一键默认色、无需选色） */
function toggleMarkOnSelection() {
  const inst = editor.instance?.();
  if (!inst) return;
  const { empty } = inst.state.selection;
  if (empty) {
    toast('请先选中要标记的文字', 'info');
    return;
  }
  if (inst.isActive('highlight')) {
    inst.chain().focus().unsetHighlight().run();
  } else {
    inst.chain().focus().setHighlight({ color: '' }).run();
  }
  editor.flushSave?.();
}


/**
 * 窗口操作：优先尝试纯前端 API（WebView2 通常允许），失败回退到 Quicker 子程序。
 * 这样用户可以**只配置一个隐藏子程序**（HideWindow），其余三个全靠前端搞定。
 */
async function requestMinimize() {
  editor.flushSave();
  if (storage.isQuicker()) {
    try { await windowOp('最小化', { isMax: _isMaximized }); }
    catch (err) { toast('最小化失败，请检查 WindowOp 子程序', 'error'); }
  } else {
    toast('开发模式：无法最小化', 'warning');
  }
}

/** 顶边缩放把手：拖动改窗口高度（底边固定）。
 *  delta 法：每帧只把「本帧鼠标 Y 增量（物理像素）」发给子程序，C# 用「当前真实 top + delta」设置。
 *  每帧重读真实位置 → 无需起始基准、不预先查询、不漂移；最小高度由子程序钳制。
 *  单线 IPC：上一次返回后才发下一次，自动适配延迟、避免积压。 */
function setupTopResizeGrip() {
  const grip = document.getElementById('titlebar-resize-top');
  if (!grip) return;
  // 非 Quicker 宿主（浏览器/PWA）无 OS 窗口可缩放 → 隐藏把手，避免误导
  if (!window.host.caps.window) {
    grip.style.display = 'none';
    return;
  }
  let dragging = false;
  let lastScreenY = 0, dpr = 1;
  let pending = 0, inflight = false, rafId = 0;   // pending：未发送的累计增量（物理像素）

  function flush() {
    rafId = 0;
    if (inflight || pending === 0) return;
    const delta = pending; pending = 0;
    inflight = true;
    // 把全局最小高度一并传给子程序，让顶边的钳值与原生缩放/复位的最小尺寸一致，
    // 否则顶边用更小的内置钳值，到达"真实最小"后会把窗口整体往下推。
    windowOp('顶边', { delta, isMax: false, minH: Math.round(WIN_MIN_H * dpr) })
      .catch(() => {})
      .finally(() => {
        inflight = false;
        if (pending !== 0 && !rafId) rafId = requestAnimationFrame(flush);
      });
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    pending += Math.round((e.screenY - lastScreenY) * dpr);
    lastScreenY = e.screenY;
    if (!rafId) rafId = requestAnimationFrame(flush);
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    document.body.classList.remove('is-resizing');
    if (!rafId) rafId = requestAnimationFrame(flush); // 应用最后一帧增量
  }

  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (_isMaximized) return;                   // 最大化时禁用
    dragging = true;
    lastScreenY = e.screenY;
    dpr = window.devicePixelRatio || 1;
    pending = 0;
    document.body.classList.add('is-resizing');
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    e.preventDefault();
  });
}

/** 窗口置顶切换 → 子程序 WindowOp（mode=置顶），出参布尔 isTopmost，按返回值切换图标高亮，不弹提示。 */
async function requestToggleTopmost() {
  const btn = document.getElementById('btn-titlebar-pin');
  if (!window.host.caps.window) {
    if (btn) btn.classList.toggle('is-active'); // 非 Quicker 宿主仅切换视觉
    return;
  }
  try {
    const r = await windowOp('置顶', { isMax: _isMaximized });
    const v = String((r && (r.isTopmost ?? r.result)) ?? '').toLowerCase();
    const on = (v === 'true' || v === '1');
    if (btn) {
      btn.classList.toggle('is-active', on);
      btn.title = on ? '取消置顶' : '窗口置顶';
    }
  } catch (e) {
    console.warn('[ZhiNote] WindowOp 置顶 调用失败:', e);
  }
}

/** 最大化 / 还原切换 → 子程序 WindowOp。
 *  最大化：mode=最大化（isMax=false）。子程序先把当前真实位置写进 zhinote_window_rect 作还原点，再设工作区全屏。
 *  还原：  mode=还原（isMax=true）。子程序读 zhinote_window_rect 设回；isMax 守门保证全屏不污染状态。
 *  还原点全程由子程序维护，前端不再用 screenX/outerWidth 自算（杜绝累积变大）。
 */
let _isMaximized = false;

async function requestMaximize() {
  if (!storage.isQuicker()) { toast('开发模式：无 OS 窗口可最大化', 'warning'); return; }
  document.body.classList.add('is-resizing');
  try {
    if (!_isMaximized) {
      await windowOp('最大化', { isMax: false });
      _isMaximized = true;
    } else {
      await windowOp('还原', { isMax: true });
      _isMaximized = false;
    }
  } catch (err) {
    toast('最大化失败：请确认已配置 WindowOp 子程序', 'error');
    console.error('[ZhiNote] WindowOp 最大化/还原 调用失败:', err);
  } finally {
    setTimeout(() => {
      document.body.classList.remove('is-resizing');
    }, 350);
  }
}

// ========== 关于页：点赞按钮 ==========
const LIKE_STATE_KEY = 'zhinote-upvoted';

function _spawnLikeBurst(btn) {
  const burst = document.createElement('span');
  burst.className = 'about-like-burst';
  const icon = btn.querySelector('.about-like-icon');
  if (icon) icon.appendChild(burst);
  const N = 8;
  for (let i = 0; i < N; i++) {
    const dot = document.createElement('span');
    const ang = (Math.PI * 2 * i) / N + Math.random() * 0.4;
    const dist = 16 + Math.random() * 10;
    dot.style.setProperty('--bx', `${Math.cos(ang) * dist}px`);
    dot.style.setProperty('--by', `${Math.sin(ang) * dist}px`);
    burst.appendChild(dot);
  }
  setTimeout(() => burst.remove(), 700);
}

// 即时播放点赞动画（每次点击都播放，可反复欣赏，纯视觉）
// 已点赞时：先瞬时回到未点赞外观，再填充为已点赞 → 每次都能看到"从未点赞变成点赞"的过渡
function _playLikeAnim(btn) {
  const wasLiked = btn.classList.contains('liked');
  btn.classList.remove('pop');
  if (wasLiked) btn.classList.remove('liked');
  void btn.offsetWidth; // 强制 reflow，确保动画与填充过渡可重复触发
  _spawnLikeBurst(btn);
  if (wasLiked) btn.classList.add('liked');
  btn.classList.add('pop');
  setTimeout(() => btn.classList.remove('pop'), 520);
}

// 标记为已点赞（实心 + 文案 + 本机记忆），不触发动画
function _markLiked(btn) {
  btn.classList.remove('liking');
  btn.classList.add('liked');
  const txt = btn.querySelector('.about-like-text');
  if (txt) txt.textContent = '已点赞';
  localStorage.setItem(LIKE_STATE_KEY, '1');
}

// 解析 Like 子程序返回：'already'=云端已赞 | 'liked'=本次点赞成功 | 'fail'=失败
function _likeResult(r) {
  const v = String((r && (r.isUpvoted ?? r.result)) ?? '').toLowerCase();
  if (v === 'liked' || v === 'already') return 'already';
  if (v === 'true' || v === '1') return 'liked';
  return 'fail';
}

// 投喂弹层：赞赏码卡片，叠在设置弹窗之上；✕ / 点遮罩 / Esc 关闭，带淡出动画
function openDonateCard() {
  if (document.querySelector('.donate-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'donate-overlay';
  overlay.innerHTML = `
    <div class="donate-card">
      <button type="button" class="donate-close" title="关闭">✕</button>
      <div class="donate-title">☕ 请作者喝杯奶茶</div>
      <div class="donate-sub">枝记免费无广告，投喂全凭心意～</div>
      <img src="${window.__DONATE_QR__ || ''}" alt="赞赏码" draggable="false">
      <div class="donate-note">微信扫一扫 · 金额随意</div>
    </div>`;
  const close = () => {
    overlay.classList.add('is-closing');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => overlay.remove(), 180);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.donate-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
}

function setupAboutLikeButton(btn) {
  if (!btn) return;

  // 仅用本机记忆决定初始显示，不在启动时读云端（点击时才读）
  if (localStorage.getItem(LIKE_STATE_KEY) === '1') {
    _markLiked(btn);
  }

  let busy = false;
  btn.addEventListener('click', async () => {
    // 每次点击都立刻播放动画（可反复欣赏，无延迟）
    _playLikeAnim(btn);
    // 正在请求中 / 已点过 → 只播动画，不再实际操作
    if (busy || btn.classList.contains('liked')) return;
    if (!window.host.caps.quicker) {
      toast('请在枝记窗口内点赞', 'info');
      return;
    }
    busy = true;
    try {
      // 单次调用：C# 读云端 → 有记录只回 already（不重复点赞），无记录则点赞并写云端
      const r = await window.host.sp('Like');
      const kind = _likeResult(r);
      if (kind === 'liked') {
        _markLiked(btn);
        toast('点赞成功，感谢支持 ❤', 'success');
      } else if (kind === 'already') {
        _markLiked(btn);
        toast('你已经赞过啦 ❤', 'info');
      }
      // fail：保持未点赞，下次仍可点
    } catch (e) {
      console.warn('[ZhiNote] Like 子程序调用失败:', e?.message || e);
    } finally {
      busy = false;
    }
  });
}

// ========== 与 Quicker 通信 ==========

function listenQuickerMessages() {
  if (window.chrome?.webview?.addEventListener) {
    window.chrome.webview.addEventListener('message', (e) => {
      let data = e.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) {}
      }
      handleQuickerMessage(data || {});
    });
  }
}

function handleQuickerMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'show':
      document.body.style.visibility = 'visible';
      setTimeout(() => editor.focus(), 50);
      break;
    case 'reload':
      storage.init().then(() => { tree.render(); editor.reloadCurrent(); updateTrashBadge(); });
      break;
    case 'import-md-done':
      storage.init().then(() => { tree.render(); toast('导入完成', 'success'); });
      break;
    case 'export-md-done':
      toast('已导出到：' + (msg.path || '指定文件夹'), 'success');
      break;
    case 'set-theme':
      editor.setTheme(msg.value);
      break;
    case 'toast':
      toast(msg.message || '', msg.level || 'success');
      break;
  }
}

/** 统一窗口操作 → 子程序 WindowOp，用中文 mode 区分：隐藏/最小化/置顶/最大化/还原/顶边。
 *  - isMax：当前是否处于伪最大化态（前端 _isMaximized）。子程序据此守门，最大化态不写位置状态，避免全屏污染。
 *  - delta：仅 mode=顶边，本帧鼠标 Y 增量（物理像素）。子程序 newTop=当前真实 top + delta。
 *  真实矩形/工作区全屏/还原点全由子程序在物理像素空间处理；前端不读 screenX/outerWidth（WebView2 下不可靠）。
 *  运行期不轮询、不实时存：移动/缩放后的位置在隐藏/最大化等操作时由子程序统一落盘。
 */
async function windowOp(mode, extra) {
  // 经宿主适配层：Quicker 宿主走 WindowOp 子程序；非 Quicker 宿主（浏览器/PWA）静默忽略。
  return await window.host.window.op(mode, extra);
}
window.windowOp = windowOp;

/** 把同步过程中的英文报错转成中文，避免用户看到 "signal is aborted without reason" 之类看不懂的提示。 */
function _zhSyncError(err) {
  const s = String(err || '').trim();
  if (!s) return '未知错误，请重试';
  // 同步引擎给出的中文错误都是精心组织过的（含坏文件路径和修复指引），原样展示，
  // 不能被下面的关键词映射吞掉细节（如 "JSON 解析失败 (manifest.json)" 曾被笼统化成"解析失败"）
  if (/[\u4e00-\u9fa5]/.test(s)) return s;
  const low = s.toLowerCase();
  if (low.includes('aborted') || low.includes('aborterror')) return '连接超时或被中断，请重试';
  if (low.includes('failed to fetch') || low.includes('load failed') || low.includes('networkerror') || low.includes('network error')) {
    // 网页端经代理时，fetch 直接失败多半是代理不可达（断网/被拦截/代理域名没绑好）
    const viaProxy = !(window.host && window.host.isQuicker()) && window.webdavSync?.resolveProxy?.(storage.getSetting('webdavProxy')) !== '';
    if (viaProxy) return '暂时连不上同步服务（多为网络波动），会自动重试；若长时间不恢复，再考虑在设置 → 同步 → 跨域代理中更换代理';
    return '网络连接失败，请检查网络';
  }
  if (low.includes('timeout') || low.includes('timed out')) return '连接超时，请检查网络或服务器';
  if (low.includes('not found') || low.includes('404')) return '云端文件不存在（404）';
  if (low.includes('503')) return '服务器繁忙（503），请稍后重试';
  if (low.includes('500') || low.includes('502')) return '服务器错误，请稍后重试';
  if (low.includes('certificate') || low.includes('ssl') || low.includes('cert')) return '证书/加密连接异常，请检查服务器地址';
  // 纯英文的 JSON 报错：保留原文方便定位是哪个文件坏了
  if (low.includes('json')) return '云端数据解析失败（' + s + '），请重试';
  return '同步出错（' + s + '），请重试';
}

/** 云同步徽标：显示在 btn-cloud-sync 右上角 */
let _lastSyncTime = null;
function _setCloudSyncDot(state, detail) {
  const el = document.getElementById('cloud-sync-dot');
  if (!el) return;
  el.classList.remove('synced', 'syncing', 'pending', 'error', 'disabled');
  const btn = document.getElementById('btn-cloud-sync');
  switch (state) {
    case 'synced':
      el.classList.add('synced');
      _lastSyncTime = Date.now();
      if (btn) btn.title = '已同步 · 上次：刚刚';
      break;
    case 'syncing':
      el.classList.add('syncing');
      if (btn) btn.title = '同步中…';
      break;
    case 'pending':
      el.classList.add('pending');
      if (btn) btn.title = '待同步';
      break;
    case 'error':
      el.classList.add('error');
      if (btn) btn.title = '同步失败' + (detail ? '：' + detail : '');
      break;
    case 'disabled':
      el.classList.add('disabled');
      if (btn) btn.title = '未启用云同步';
      break;
  }
}

/** 定时刷新云同步按钮 tooltip 中的"上次同步"时间 */
setInterval(() => {
  if (!_lastSyncTime) return;
  const btn = document.getElementById('btn-cloud-sync');
  const dot = document.getElementById('cloud-sync-dot');
  if (!btn || !dot || !dot.classList.contains('synced')) return;
  const sec = Math.floor((Date.now() - _lastSyncTime) / 1000);
  let ago;
  if (sec < 10) ago = '刚刚';
  else if (sec < 60) ago = sec + ' 秒前';
  else if (sec < 3600) ago = Math.floor(sec / 60) + ' 分钟前';
  else ago = Math.floor(sec / 3600) + ' 小时前';
  btn.title = '已同步 · 上次：' + ago;
}, 15000);

/** 顶栏云同步图标：左键智能同步（脏就上传 + 检查云端拉取最新）*/
async function smartCloudSync() {
  const method = storage.getSetting('syncMethod') || 'none';
  if (method === 'none') {
    toast('当前已关闭云同步', 'info');
    return;
  }
  if (method === 'webdav' && window.webdavSync) {
    const btn = document.getElementById('btn-cloud-sync');
    if (btn) btn.classList.add('active');
    try {
      editor.flushSave();
      await window.webdavSync.manualSync();
    } finally {
      if (btn) setTimeout(() => btn.classList.remove('active'), 600);
    }
  }
}

/** 顶栏云同步图标：右键 → 弹出菜单（按同步方式显示不同选项） */
function openCloudSyncMenu(anchor) {
  const method = storage.getSetting('syncMethod') || 'none';
  const badgeHidden = localStorage.getItem('zhinote-cloud-badge-hidden') === '1';
  const popup = document.createElement('div');
  popup.className = 'context-menu';
  popup.style.minWidth = '180px';

  const badgeToggleHtml = `
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-act="toggle-badge">
        <span style="width:14px;color:var(--text-tertiary);">${badgeHidden ? '○' : '●'}</span>
        <span>${badgeHidden ? '显示同步徽标' : '隐藏同步徽标'}</span>
      </div>`;

  if (method === 'webdav') {
    popup.innerHTML = `
      <div class="context-menu-item" data-act="sync">
        <span style="width:14px;color:var(--accent);">⟳</span>
        <span>立即同步</span>
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-act="repair-manifest">
        <span style="width:14px;color:var(--text-tertiary);">🛠</span>
        <span>修复云端清单</span>
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-act="settings">
        <span style="width:14px;color:var(--text-tertiary);">⚙</span>
        <span>打开云同步设置</span>
      </div>${badgeToggleHtml}
    `;
  } else if (method === 'none') {
    popup.innerHTML = `
      <div class="context-menu-item" data-act="settings">
        <span style="width:14px;color:var(--text-tertiary);">⚙</span>
        <span>打开云同步设置</span>
      </div>${badgeToggleHtml}
    `;
  }

  document.body.appendChild(popup);
  const r = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.top = (r.bottom + 6) + 'px';
  popup.style.left = Math.max(8, r.right - 200) + 'px';
  popup.classList.remove('hidden');
  const close = () => { popup.remove(); document.removeEventListener('mousedown', outClick, true); };
  const outClick = (e) => { if (!popup.contains(e.target)) close(); };
  popup.querySelectorAll('[data-act]').forEach(it => {
    it.addEventListener('click', async () => {
      const act = it.dataset.act;
      close();
      if (act === 'sync') {
        if (window.webdavSync) {
          const btn = document.getElementById('btn-cloud-sync');
          if (btn) btn.classList.add('active');
          try {
            editor.flushSave();
            await window.webdavSync.manualSync();
          } finally {
            if (btn) setTimeout(() => btn.classList.remove('active'), 600);
          }
        }
      } else if (act === 'repair-manifest') {
        await runRepairManifestFlow();
      } else if (act === 'settings') {
        openSettingsModal('sync');
      } else if (act === 'toggle-badge') {
        const dot = document.getElementById('cloud-sync-dot');
        const hidden = localStorage.getItem('zhinote-cloud-badge-hidden') === '1';
        if (hidden) {
          localStorage.removeItem('zhinote-cloud-badge-hidden');
          if (dot) dot.style.display = '';
        } else {
          localStorage.setItem('zhinote-cloud-badge-hidden', '1');
          if (dot) dot.style.display = 'none';
        }
      }
    });
  });
  setTimeout(() => document.addEventListener('mousedown', outClick, true), 0);
}

/** 「修复云端清单」完整流程（确认 → 修复 → 反馈）。云同步菜单与设置页共用。 */
async function runRepairManifestFlow() {
  const ok = await uiConfirm({
    title: '修复云端清单',
    message: '用于解决"云端 manifest.json 损坏（空文件）、同步一直转圈"的问题。\n\n将删除云端清单文件，并以【本机数据】为准完整重建（重新上传全部笔记）。\n\n注意：云端独有、本机没有的笔记不会进入新清单（文件仍保留在云端，可通过「扫描云端恢复」找回）。\n\n确定继续吗？',
    okText: '开始修复',
  });
  if (!ok || !window.webdavSync || !window.webdavSync.repairManifest) return;
  toast('正在修复云端清单，请勿关闭应用…', 'info');
  try {
    editor.flushSave();
    const res = await window.webdavSync.repairManifest();
    if (res.ok) toast('云端清单已修复，同步恢复正常', 'success');
    else toast('修复失败：' + (res.error || '未知错误'), 'error');
  } catch (e) {
    toast('修复失败：' + e.message, 'error');
  }
}

/* ===== PWA 安装引导（仅网页宿主有效） ===== */
// 浏览器认为站点可安装时会触发 beforeinstallprompt；存下事件，在关于页给出"安装"按钮。
let _pwaInstallEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _pwaInstallEvt = e;
});

/* ===== 网页版二维码（设置 → 关于页） ===== */
// 网页版正式地址：Quicker 端用常量；网页端直接取当前站点（永远准确）。
const WEB_APP_URL = 'https://app.zhinote.net';
function _webAppUrl() {
  if (window.host && !window.host.caps.quicker && /^https?:$/i.test(location.protocol)) return location.origin;
  return WEB_APP_URL;
}

// 二维码生成库按需加载（约 10KB，仅打开设置时才拉取）
let _qrLibLoading = null;
function _loadQrLib() {
  if (window.qrcode) return Promise.resolve();
  if (_qrLibLoading) return _qrLibLoading;
  _qrLibLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
    s.onload = () => resolve();
    s.onerror = () => { _qrLibLoading = null; reject(new Error('二维码加载失败（需联网）')); };
    document.head.appendChild(s);
  });
  return _qrLibLoading;
}

/**
 * 美化版二维码 SVG：圆点码点 + 圆角定位框 + 中心应用图标。
 * 纠错级别 H（容错 30%），中心挖空约 6% 面积放 logo，扫码不受影响。
 */
function _buildPrettyQrSvg(url, dark = '#33312e') {
  const qr = window.qrcode(0, 'H');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const Q = 2; // 静区（模块数）
  const size = n + Q * 2;
  // 中心 logo 占据的模块跨度（奇数，约 1/4 边长）
  let span = Math.floor(n / 4); if (span % 2 === 0) span += 1;
  const lo = (n - span) / 2, hi = (n + span) / 2 - 1;
  const inFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const inLogo = (r, c) => r >= lo - 1 && r <= hi + 1 && c >= lo - 1 && c <= hi + 1;

  let dots = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c) || inFinder(r, c) || inLogo(r, c)) continue;
      dots += `<circle cx="${Q + c + 0.5}" cy="${Q + r + 0.5}" r="0.42"/>`;
    }
  }
  // 三个定位框：外 7（圆角）+ 内白 5 + 芯 3
  const finder = (x, y) => `
    <rect x="${x}" y="${y}" width="7" height="7" rx="2.2" fill="${dark}"/>
    <rect x="${x + 1}" y="${y + 1}" width="5" height="5" rx="1.5" fill="#fff"/>
    <rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="1" fill="${dark}"/>`;
  // 中心 logo：白底圆角垫片 + 应用图标（与 icon.svg 同款：墨底圆角方 + 枝字 + 绿点）
  const pad = Q + lo - 1, padSpan = span + 2;
  const iconScale = span / 512;
  const logo = `
    <rect x="${pad}" y="${pad}" width="${padSpan}" height="${padSpan}" rx="1.6" fill="#fff"/>
    <g transform="translate(${Q + lo},${Q + lo}) scale(${iconScale})">
      <rect width="512" height="512" rx="116" fill="${dark}"/>
      <text x="250" y="352" font-size="268" text-anchor="middle" fill="#f5f2ec" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-weight="700">枝</text>
      <circle cx="392" cy="138" r="26" fill="#46b97c"/>
    </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" style="width:100%;height:100%;display:block;">
    <rect width="${size}" height="${size}" fill="#fff"/>
    <g fill="${dark}">${dots}</g>
    ${finder(Q, Q)}${finder(Q + n - 7, Q)}${finder(Q, Q + n - 7)}
    ${logo}
  </svg>`;
}

/** 在关于页的占位框里生成网页版二维码 */
function renderAboutWebQr(box) {
  if (!box) return;
  _loadQrLib()
    .then(() => { box.innerHTML = _buildPrettyQrSvg(_webAppUrl()); })
    .catch((e) => { box.textContent = e.message; });
}

async function requestHideWindow() {
  editor.flushSave();
  if (storage.isQuicker()) {
    const method = storage.getSetting('syncMethod') || 'none';
    if (method === 'webdav') {
      storage.save({ immediate: true });
      if (window.webdavSync) window.webdavSync.flushPutOnHide();
    } else {
      storage.save({ immediate: true });
    }
    try {
      await windowOp('隐藏', { isMax: _isMaximized });
    } catch (err) {
      console.error('[hide]', err);
      toast('隐藏窗口失败，请检查 WindowOp 子程序是否已配置', 'error');
    }
  } else {
    toast('开发模式下无窗口可隐藏', 'warning');
  }
}

/* ===================== 定时本地备份 =====================
 * 配置存 localStorage（按设备区分，不随云同步漂移）。
 * 依赖 Quicker 子程序：EnsureDir / BackupWriteFile / ListFiles / DeleteFile（见 docs）。
 */
const BACKUP_KEYS = {
  enabled: 'zhinote_backup_enabled',
  interval: 'zhinote_backup_interval', // 分钟
  dir: 'zhinote_backup_dir',
  keep: 'zhinote_backup_keep',         // 保留份数
  last: 'zhinote_backup_last',         // 上次成功时间戳
  hash: 'zhinote_backup_hash',         // 上次备份内容指纹（去重用）
};
let _backupTimer = null;
let _backupRunning = false;

function _backupGet() {
  const ls = localStorage;
  const intRaw = parseInt(ls.getItem(BACKUP_KEYS.interval) || '', 10);
  const keepRaw = parseInt(ls.getItem(BACKUP_KEYS.keep) || '', 10);
  return {
    enabled: ls.getItem(BACKUP_KEYS.enabled) === '1',
    interval: (Number.isFinite(intRaw) && intRaw >= 1) ? intRaw : 30,
    dir: ls.getItem(BACKUP_KEYS.dir) || '',
    keep: (Number.isFinite(keepRaw) && keepRaw >= 1) ? keepRaw : 20,
    last: parseInt(ls.getItem(BACKUP_KEYS.last) || '0', 10) || 0,
    hash: ls.getItem(BACKUP_KEYS.hash) || '',
  };
}
function _backupSet(patch) {
  const ls = localStorage;
  if ('enabled' in patch) ls.setItem(BACKUP_KEYS.enabled, patch.enabled ? '1' : '0');
  if ('interval' in patch) ls.setItem(BACKUP_KEYS.interval, String(patch.interval));
  if ('dir' in patch) ls.setItem(BACKUP_KEYS.dir, patch.dir || '');
  if ('keep' in patch) ls.setItem(BACKUP_KEYS.keep, String(patch.keep));
  if ('last' in patch) ls.setItem(BACKUP_KEYS.last, String(patch.last));
  if ('hash' in patch) ls.setItem(BACKUP_KEYS.hash, patch.hash || '');
}

/** 取「笔记正文」内容指纹：只看 notes/trash/workspaces/images，忽略 settings（主题、侧栏宽度、同步时间戳等不算内容变化）。 */
function _backupSignature(jsonStr) {
  let sig = jsonStr;
  try {
    const o = JSON.parse(jsonStr);
    sig = JSON.stringify({ n: o.notes, t: o.trash, w: o.workspaces, i: o.images });
  } catch (_) {}
  // DJB2 哈希，够区分内容是否变化
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + sig.length;
}

function _backupTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function _backupJoin(dir, name) {
  if (!dir) return name;
  return dir.replace(/[\\/]+$/, '') + '\\' + name;
}

/** 执行一次本地备份：落盘 → 导出 JSON → 写文件 → 轮转清理（仅落本地，不触发云上传）。 */
async function _runLocalBackup({ manual = false } = {}) {
  if (_backupRunning) return { ok: false, error: 'busy' };
  const cfg = _backupGet();
  if (!cfg.dir) {
    if (manual) toast('请先在设置里填写备份目录', 'warning');
    return { ok: false, error: 'no-dir' };
  }
  if (!window.host.caps.file) {
    if (manual) toast('本地备份需要在 Quicker 环境中运行', 'warning');
    return { ok: false, error: 'no-quicker' };
  }
  _backupRunning = true;
  try {
    try { editor.flushSave?.(); } catch (_) {}
    const content = storage.exportJSON();
    // 内容去重：与上次备份内容一致则跳过，避免把久远有用的备份顶掉
    // （窗口隐藏时笔记不会变化，自然也命中这里跳过，无需单独判断可见性）
    const sig = _backupSignature(content);
    if (sig === cfg.hash) {
      if (manual) toast('内容无变化，已是最新备份', 'info');
      return { ok: true, skipped: true };
    }
    const fileName = `zhinote_backup_${_backupTs()}.json`;
    const fullPath = _backupJoin(cfg.dir, fileName);
    try { await window.host.file.op({ mode: 'ensureDir', path: cfg.dir }); } catch (_) {}
    await window.host.file.op({ mode: 'write', path: fullPath, content });
    _backupSet({ last: Date.now(), hash: sig });
    await _backupRotate(cfg);
    if (manual) toast(`已备份到本地：${fileName}`, 'success');
    return { ok: true, fileName };
  } catch (e) {
    if (manual) toast('备份失败：' + (e?.message || e), 'error');
    console.warn('[backup] 备份失败', e);
    return { ok: false, error: String(e?.message || e) };
  } finally {
    _backupRunning = false;
  }
}

/** 轮转清理：备份文件按时间戳命名，超过保留份数则删最早的几份。 */
async function _backupRotate(cfg) {
  try {
    const res = await window.host.file.op({ mode: 'list', dir: cfg.dir, pattern: 'zhinote_backup_*.json' });
    const raw = (res && res.result) || '';
    const files = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (files.length <= cfg.keep) return;
    files.sort(); // 文件名内嵌定宽时间戳，字典序即时间序，最早在前
    const toDelete = files.slice(0, files.length - cfg.keep);
    for (const f of toDelete) {
      try { await window.host.file.op({ mode: 'delete', path: f }); } catch (_) {}
    }
  } catch (e) {
    console.warn('[backup] 轮转清理失败', e);
  }
}

/** 按配置启动/重启定时器。隐藏不关闭，本地备份隐藏时也继续。 */
function startBackupScheduler() {
  if (_backupTimer) { clearInterval(_backupTimer); _backupTimer = null; }
  const cfg = _backupGet();
  if (!cfg.enabled) return;
  const ms = cfg.interval * 60 * 1000;
  // 追补：距上次备份超过间隔，启动后稍候补一次；否则等到下一个周期。
  const sinceLast = cfg.last ? (Date.now() - cfg.last) : Infinity;
  const firstDelay = sinceLast >= ms ? 15000 : Math.max(15000, ms - sinceLast);
  setTimeout(() => { if (_backupGet().enabled) _runLocalBackup({ manual: false }); }, firstDelay);
  _backupTimer = setInterval(() => { _runLocalBackup({ manual: false }); }, ms);
}

/**
 * 文件保存工具（参考 Excalidraw/tldraw 实现）
 * 优先使用 File System Access API，不支持时 fallback 到 <a> 下载
 */
async function fileSave(blob, opts = {}) {
  const { fileName = 'download', description = '', extensions = [] } = opts;
  const inWebView = !!(window.chrome && window.chrome.webview);

  function fallbackDownload() {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    return true;
  }

  if (!inWebView && window.showSaveFilePicker) {
    try {
      const mimeType = (blob.type || 'application/octet-stream').split(';')[0].trim();
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: extensions.length ? [{ description, accept: { [mimeType]: extensions } }] : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      return fallbackDownload();
    }
  }
  return fallbackDownload();
}

/**
 * 文件读取工具（参考 Excalidraw/tldraw 实现）
 * 优先使用 File System Access API，不支持时 fallback 到 <input type="file">
 */
function fileOpen(opts = {}) {
  const { extensions = [], multiple = false } = opts;
  const inWebView = !!(window.chrome && window.chrome.webview);

  function fallbackInput(resolve) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = extensions.join(',');
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files);
      input.remove();
      if (!files.length) { resolve(null); return; }
      resolve(multiple ? files : files[0]);
    });
    input.addEventListener('cancel', () => { input.remove(); resolve(null); });
    input.click();
  }

  const mimeMap = { '.md': 'text/markdown', '.txt': 'text/plain', '.zip': 'application/zip', '.json': 'application/json', '.zhinote': 'application/json' };
  function buildAccept(exts) {
    const grouped = {};
    for (const ext of exts) {
      const mime = mimeMap[ext.toLowerCase()] || 'application/octet-stream';
      if (!grouped[mime]) grouped[mime] = [];
      grouped[mime].push(ext);
    }
    return grouped;
  }

  return new Promise((resolve) => {
    if (!inWebView && window.showOpenFilePicker) {
      window.showOpenFilePicker({
        multiple,
        types: extensions.length ? [{ description: '选择文件', accept: buildAccept(extensions) }] : undefined,
      }).then(async (handles) => {
        const files = await Promise.all(handles.map(h => h.getFile()));
        resolve(multiple ? files : files[0]);
      }).catch((err) => {
        if (err.name === 'AbortError') { resolve(null); return; }
        fallbackInput(resolve);
      });
      return;
    }
    fallbackInput(resolve);
  });
}

function showActionMenu(anchor, items) {
  return new Promise((resolve) => {
    const popup = document.createElement('div');
    popup.className = 'context-menu';
    popup.style.position = 'fixed';
    popup.style.zIndex = '9999';
    popup.style.minWidth = '200px';

    let closed = false;
    const close = (val) => {
      if (closed) return;
      closed = true;
      popup.remove();
      document.removeEventListener('mousedown', outClick, true);
      resolve(val ? { id: val } : null);
    };
    const outClick = (e) => { if (!popup.contains(e.target) && e.target !== anchor) close(null); };

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'context-menu-item';
      el.innerHTML = `<span style="width:16px;text-align:center;">${item.icon}</span><span>${item.label}</span>`;
      el.addEventListener('click', () => close(item.id));
      popup.appendChild(el);
    }

    document.body.appendChild(popup);
    const r = anchor.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 6;
    if (top + popup.offsetHeight > window.innerHeight) top = r.top - popup.offsetHeight - 6;
    if (left + popup.offsetWidth > window.innerWidth) left = window.innerWidth - popup.offsetWidth - 8;
    if (left < 4) left = 4;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    setTimeout(() => document.addEventListener('mousedown', outClick, true), 0);
  });
}

async function requestExport() {
  editor.flushSave();
  const anchor = document.getElementById('btn-export');
  const result = await showActionMenu(anchor, [
    { id: 'current', icon: '📄', label: '导出当前笔记 (.md)' },
    { id: 'all', icon: '📦', label: '导出全部笔记 (.zip)' },
    { id: 'backup', icon: '💾', label: '完整备份 (.json)' },
    { id: 'sync-config', icon: '🔗', label: '导出同步配置' },
  ]);
  if (!result) return;
  const choice = result.id;
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  try {
    let fileName, filter, isBinary = false, makeContent;

    if (choice === 'current') {
      const id = editor.currentId?.();
      if (!id) { toast('请先打开一篇笔记', 'warning'); return; }
      const data = storage.exportCurrentNoteMd(id);
      if (!data) { toast('笔记不存在', 'error'); return; }
      fileName = `${data.title}.md`;
      filter = 'Markdown 文件|*.md';
      makeContent = () => data.content;
    } else if (choice === 'all') {
      if (typeof JSZip === 'undefined') { toast('ZIP 库未加载，请检查网络', 'error'); return; }
      fileName = `notes_${ts}.zip`;
      filter = 'ZIP 压缩包|*.zip';
      isBinary = true;
      makeContent = async () => {
        const files = storage.exportAllAsTree({ allWorkspaces: true, imagesAsFiles: true });
        if (!files.length) throw new Error('没有可导出的笔记');
        const zip = new JSZip();
        for (const f of files) zip.file(f.path, f.content, f.base64 ? { base64: true } : undefined);
        const workspaces = storage.getWorkspaces();
        if (workspaces.length > 1) {
          zip.file('.zhinote-meta.json', JSON.stringify({
            version: 1,
            workspaces: workspaces.map(w => ({ id: w.id, name: w.name, icon: w.icon }))
          }));
        }
        return await zip.generateAsync({ type: 'base64' });
      };
    } else if (choice === 'backup') {
      fileName = `notes_backup_${ts}.json`;
      filter = 'JSON 备份|*.json';
      makeContent = () => storage.exportJSON();
    } else if (choice === 'sync-config') {
      const method = storage.getSetting('syncMethod') || 'none';
      if (method === 'none') { toast('当前未配置云同步', 'warning'); return; }
      const cfg = {
        syncMethod: method,
        webdavProvider: storage.getSetting('webdavProvider') || '',
        webdavUrl: storage.getSetting('webdavUrl') || '',
        webdavUser: storage.getSetting('webdavUser') || '',
        webdavPass: storage.getSetting('webdavPass') || '',
        webdavEncryptNotes: storage.getSetting('webdavEncryptNotes') || false,
        webdavCryptoPass: storage.getSetting('webdavCryptoPass') || '',
      };
      const encrypted = await window.webdavSync.aesEncrypt(JSON.stringify(cfg));
      const configText = 'ZHINOTE_SYNC:' + encrypted;
      await navigator.clipboard.writeText(configText);
      toast('同步配置已复制到剪贴板', 'success');
      return;
    } else {
      return;
    }

    if (storage.isQuicker()) {
      // 先弹保存框拿路径：用户取消 → 不打包、零浪费
      const pathRes = await window.host.file.op({ mode: 'savePath', fileName, filter });
      const path = pathRes?.result || '';
      if (!path) return;
      const content = await makeContent();
      await window.host.file.op({ mode: 'writeFile', path, content, isBinary: String(isBinary) });
      toast(`已导出：${path}`, 'success');
    } else {
      const content = await makeContent();
      const blob = isBinary
        ? new Blob([Uint8Array.from(atob(content), c => c.charCodeAt(0))])
        : new Blob([content], { type: 'text/plain;charset=utf-8' });
      const picked = await fileSave(blob, { fileName, description: filter.split('|')[0], extensions: ['.' + fileName.split('.').pop()] });
      if (picked) toast(`已导出：${fileName}（在下载文件夹中查看）`, 'success');
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    toast('导出失败：' + (err?.message || err), 'error');
  }
}

async function requestImport() {
  const anchor = document.getElementById('btn-import');
  const result = await showActionMenu(anchor, [
    { id: 'md', icon: '📄', label: '导入 Markdown 文件 (.md)' },
    { id: 'zip', icon: '📦', label: '导入 ZIP 压缩包 (.zip)' },
    { id: 'backup', icon: '💾', label: '恢复备份 (.json / .zhinote)' },
    { id: 'sync-config', icon: '🔗', label: '导入同步配置' },
  ]);
  if (!result) return;
  const choice = result.id;

  try {
    if (choice === 'sync-config') {
      const text = (await navigator.clipboard.readText() || '').trim();
      if (!text.startsWith('ZHINOTE_SYNC:')) {
        toast('剪贴板中未找到有效的同步配置', 'warning');
        return;
      }
      const encrypted = text.slice('ZHINOTE_SYNC:'.length);
      let cfg;
      try {
        cfg = JSON.parse(await window.webdavSync.aesDecrypt(encrypted));
      } catch (e) {
        toast('配置解密失败，数据可能已损坏', 'error');
        return;
      }
      if (cfg.webdavUrl) storage.setSetting('webdavUrl', cfg.webdavUrl);
      if (cfg.webdavUser) storage.setSetting('webdavUser', cfg.webdavUser);
      if (cfg.webdavPass) storage.setSetting('webdavPass', cfg.webdavPass);
      if (cfg.webdavProvider) storage.setSetting('webdavProvider', cfg.webdavProvider);
      if (cfg.webdavEncryptNotes !== undefined) storage.setSetting('webdavEncryptNotes', cfg.webdavEncryptNotes);
      if (cfg.webdavCryptoPass !== undefined) storage.setSetting('webdavCryptoPass', cfg.webdavCryptoPass);
      if (cfg.webdavProvider) {
        const pk = 'webdav_' + cfg.webdavProvider + '_';
        if (cfg.webdavUrl) storage.setSetting(pk + 'url', cfg.webdavUrl);
        if (cfg.webdavUser) storage.setSetting(pk + 'user', cfg.webdavUser);
        if (cfg.webdavPass) storage.setSetting(pk + 'pass', cfg.webdavPass);
      }
      storage.setSetting('syncMethod', cfg.syncMethod || 'webdav');
      storage.save({ immediate: true });
      await window.webdavSync.loadConfig();
      window.webdavSync.startAutoSync();
      _setCloudSyncDot('syncing');
      toast('同步配置已导入，正在开始同步', 'success');
      return;
    }

    // 备份恢复：先选模式，再选文件
    if (choice === 'backup') {
      const modeResult = await showActionMenu(anchor, [
        { id: 'overwrite', icon: '🔄', label: '覆盖恢复（完全替换当前数据）' },
        { id: 'incremental', icon: '➕', label: '增量恢复（仅添加新笔记，保留现有）' },
      ]);
      if (!modeResult) return;

      await new Promise(r => setTimeout(r, 350));
      let text;
      if (storage.isQuicker()) {
        const spResult = await window.host.file.op({ mode: 'openDialog',
          filter: '备份文件|*.json;*.zhinote', isBinary: 'false', multiSelect: 'false'
        });
        const raw = spResult?.result || '';
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const fileData = Array.isArray(parsed) ? parsed[0] : parsed;
        text = fileData.content || '';
      } else {
        const selected = await fileOpen({ extensions: ['.json', '.zhinote'], multiple: false });
        if (!selected) return;
        text = await selected.text();
      }
      if (!text) return;
      return await _doBackupImportWithMode(text, modeResult.id);
    }

    // MD/ZIP：先选模式，再选文件
    const modeResult = await showActionMenu(anchor, [
      { id: 'overwrite', icon: '🔄', label: '覆盖导入（清空现有笔记，用导入内容替换）' },
      { id: 'incremental', icon: '➕', label: '增量导入（自动跳过已有相同内容的笔记）' },
    ]);
    if (!modeResult) return;
    const mode = modeResult.id;

    await new Promise(r => setTimeout(r, 350));
    let notesToImport = [];

    if (storage.isQuicker()) {
      let filter, isBinary = false, multiSelect = false;
      if (choice === 'md') {
        filter = 'Markdown 文件|*.md;*.txt';
        multiSelect = true;
      } else {
        filter = 'ZIP 压缩包|*.zip';
        isBinary = true;
      }

      const spResult = await window.host.file.op({ mode: 'openDialog',
        filter, isBinary: String(isBinary), multiSelect: String(multiSelect)
      });
      const raw = spResult?.result || '';
      if (!raw) return;
      const parsed = JSON.parse(raw);

      if (choice === 'md') {
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const f of list) {
          const title = (f.name || '').replace(/\.(md|txt)$/i, '') || '导入笔记';
          notesToImport.push({ title, content: f.content || '', parentPath: [] });
        }
      } else {
        if (typeof JSZip === 'undefined') { toast('ZIP 库未加载，请检查网络', 'error'); return; }
        const fileData = Array.isArray(parsed) ? parsed[0] : parsed;
        const bytes = Uint8Array.from(atob(fileData.content), c => c.charCodeAt(0));
        const zip = await JSZip.loadAsync(bytes);
        notesToImport = await _parseZipToNotes(zip);
      }
    } else {
      let extensions, multiple = false;
      if (choice === 'md') { extensions = ['.md', '.txt']; multiple = true; }
      else { extensions = ['.zip']; }

      const selected = await fileOpen({ extensions, multiple });
      if (!selected) return;

      if (choice === 'md') {
        const list = Array.isArray(selected) ? selected : [selected];
        for (const f of list) {
          const text = await f.text();
          const title = f.name.replace(/\.(md|txt)$/i, '') || '导入笔记';
          notesToImport.push({ title, content: text, parentPath: [] });
        }
      } else {
        if (typeof JSZip === 'undefined') { toast('ZIP 库未加载，请检查网络', 'error'); return; }
        const buf = await selected.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);
        notesToImport = await _parseZipToNotes(zip);
      }
    }

    if (!notesToImport.length) { toast('文件中没有可导入的笔记', 'warning'); return; }

    if (mode === 'overwrite') {
      if (!(await _confirmOverwriteCloudIfSync())) return;
      const data = storage.getAll();
      data.notes = {};
      data.rootOrder = [];
    }

    const existingContents = new Set();
    if (mode === 'incremental') {
      const allNotes = storage.getAll().notes || {};
      for (const id in allNotes) {
        const c = (allNotes[id].content || '').trim();
        if (c) existingContents.add(c);
      }
    }

    const pathMap = {};
    let imported = 0, skipped = 0;

    for (const item of notesToImport) {
      if (mode === 'incremental') {
        const contentKey = (item.content || '').trim();
        if (contentKey && existingContents.has(contentKey)) {
          skipped++;
          continue;
        }
      }

      const wsId = item.workspaceId || null;
      let parentId = null;
      let pathAccum = (wsId || '') + '|';
      for (const dir of item.parentPath) {
        pathAccum += dir + '/';
        if (pathMap[pathAccum]) {
          parentId = pathMap[pathAccum];
        } else {
          const folder = storage.create({ parentId, title: dir, workspaceId: wsId });
          pathMap[pathAccum] = folder.id;
          parentId = folder.id;
        }
      }
      storage.create({ parentId, title: item.title, content: item.content, workspaceId: wsId });
      if (mode === 'incremental') existingContents.add((item.content || '').trim());
      imported++;
    }

    tree.render();
    try { refreshWorkspaceSwitcher(); } catch (_) {}
    try { renderWelcomeRecent(); } catch (_) {}
    if (mode === 'overwrite') {
      toast(`覆盖导入完成，共 ${imported} 篇笔记`, 'success');
      await _mirrorAfterOverwrite();
    } else {
      const parts = [];
      if (imported) parts.push(`新增 ${imported} 篇`);
      if (skipped) parts.push(`跳过 ${skipped} 篇重复笔记`);
      toast(parts.join('，') || '无新增笔记', imported ? 'success' : 'info');
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    toast('导入失败：' + (err?.message || err), 'error');
  }
}

async function _parseZipToNotes(zip) {
  const notes = [];
  let wsMap = null;

  const metaFile = zip.file('.zhinote-meta.json');
  if (metaFile) {
    try {
      const metaText = await metaFile.async('string');
      const meta = JSON.parse(metaText);
      if (meta.workspaces && meta.workspaces.length > 1) {
        wsMap = {};
        const existingWs = storage.getWorkspaces();
        for (const ws of meta.workspaces) {
          const found = existingWs.find(w => w.name === ws.name);
          if (found) {
            wsMap[ws.name] = found.id;
          } else {
            const created = storage.createWorkspace(ws.name, ws.icon);
            wsMap[ws.name] = created.id;
          }
        }
      }
    } catch (_) {}
  }

  // 先读 assets/ 下的图片为 dataURL（整包导出新格式：正文用相对链接引用 assets/<hash>.<ext>）。
  // 按文件名建索引，导入时把相对链接还原回 zhinote://img/<hash>（入库去重）。
  const assetMap = {}; // basename -> dataURL
  const assetEntries = [];
  zip.forEach((p, e) => {
    if (!e.dir && /(^|\/)images\/[^/]+\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) assetEntries.push({ p, e });
  });
  for (const { p, e } of assetEntries) {
    try {
      const b64 = await e.async('base64');
      let ext = (p.split('.').pop() || 'png').toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
      const base = p.split('/').pop();
      assetMap[base] = `data:image/${mime};base64,${b64}`;
    } catch (_) {}
  }
  const hasAssets = Object.keys(assetMap).length > 0;
  const resolveAssets = (md) => {
    if (!hasAssets) return md;
    return String(md || '').replace(/(?:\.\.\/)*images\/([^)\s"'>]+)/gi, (full, fname) => {
      const base = String(fname).split('/').pop();
      const dataUrl = assetMap[base];
      if (!dataUrl) return full;
      return (storage.ingestImageDataUrl ? storage.ingestImageDataUrl(dataUrl) : dataUrl);
    });
  };

  const entries = [];
  zip.forEach((path, entry) => {
    if (!entry.dir && /\.(md|txt)$/i.test(path)) entries.push({ path, entry });
  });
  entries.sort((a, b) => a.path.localeCompare(b.path));
  // 整包把所有 .md 收在「notes/」下：若全部以「notes/」开头，则视为包裹层并剥离
  const hasNotesWrap = entries.length > 0 && entries.every(e => /^notes[\/\\]/.test(e.path));

  for (const { path, entry } of entries) {
    const text = resolveAssets(await entry.async('string'));
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (hasNotesWrap && parts[0] === 'notes') parts.shift(); // 去掉「notes/」包裹层
    const fileName = parts.pop();
    const title = fileName.replace(/\.(md|txt)$/i, '') || '无标题';

    let workspaceId = null;
    if (wsMap && parts.length > 0) {
      const topFolder = parts[0];
      if (wsMap[topFolder]) {
        workspaceId = wsMap[topFolder];
        parts.shift();
      }
    }
    notes.push({ title, content: text, parentPath: parts, workspaceId });
  }
  return notes;
}

async function _doBackupImport(text, anchor) {
  const modeResult = await showActionMenu(anchor, [
    { id: 'overwrite', icon: '🔄', label: '覆盖恢复（完全替换当前数据）' },
    { id: 'incremental', icon: '➕', label: '增量恢复（仅添加新笔记，保留现有）' },
  ]);
  if (!modeResult) return;
  await _doBackupImportWithMode(text, modeResult.id);
}

async function _doBackupImportWithMode(text, mode) {
  if (mode === 'overwrite') {
    if (!(await _confirmOverwriteCloudIfSync())) return;
    await storage.importJSON(text);
    tree.render();
    const curId = editor.currentId?.();
    if (curId) editor.open(curId);
    toast('备份恢复成功（已覆盖）', 'success');
    await _mirrorAfterOverwrite();
  } else {
    let parsed;
    const trimmed = String(text || '').trim();
    if (trimmed.startsWith('MDNOTE_LZB64:')) {
      if (typeof window.LZString === 'undefined') { toast('未加载 LZ-string 库', 'error'); return; }
      const json = window.LZString.decompressFromBase64(trimmed.slice('MDNOTE_LZB64:'.length));
      parsed = JSON.parse(json);
    } else {
      parsed = JSON.parse(trimmed);
    }

    const allNotes = storage.getAll().notes || {};
    const existingIds = new Set(Object.keys(allNotes));
    const existingContents = new Set();
    for (const id in allNotes) {
      const c = (allNotes[id].content || '').trim();
      if (c) existingContents.add(c);
    }

    const backupNotes = parsed.notes || {};
    let imported = 0, skipped = 0;
    for (const id in backupNotes) {
      const note = backupNotes[id];
      if (existingIds.has(id)) { skipped++; continue; }
      const contentKey = (note.content || '').trim();
      if (contentKey && existingContents.has(contentKey)) { skipped++; continue; }
      storage.create({ parentId: null, title: note.title || '无标题', content: note.content || '' });
      existingContents.add(contentKey);
      imported++;
    }
    tree.render();
    const parts = [];
    if (imported) parts.push(`新增 ${imported} 篇`);
    if (skipped) parts.push(`跳过 ${skipped} 篇已有笔记`);
    toast(parts.join('，') || '无新增笔记', imported ? 'success' : 'info');
  }
}

// ============================================================
// 从旧版"记事本2.0"导入数据
// ============================================================
async function _importLegacyNotes() {
  let text;
  if (storage.isQuicker()) {
    const spResult = await window.host.file.op({ mode: 'openDialog',
      filter: '记事本备份|*.txt;*.json', isBinary: 'false', multiSelect: 'false'
    });
    const raw = spResult?.result || '';
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const fileData = Array.isArray(parsed) ? parsed[0] : parsed;
    text = fileData.content || '';
  } else {
    const selected = await fileOpen({ extensions: ['.txt', '.json'], multiple: false });
    if (!selected) return;
    text = await selected.text();
  }
  if (!text) return;

  let data;
  try { data = JSON.parse(text); } catch (e) {
    toast('文件格式错误，无法解析JSON', 'error');
    return;
  }

  const dirList = data['目录列表'];
  const dict = data['词典'];
  if (!dirList || !dict) {
    toast('不是有效的记事本2.0备份文件', 'error');
    return;
  }

  // --- 解析目录树 ---
  const iconMap = {};
  for (const key in data) {
    if (key === '目录列表' || key === '词典' || key === 'API参数' || key === '角色仓库') continue;
    if (typeof data[key] === 'string') iconMap[key] = data[key];
  }

  // 解析目录列表：识别分区、笔记组、层级
  const tree_nodes = [];
  for (const line of dirList) {
    const indent = line.match(/^( *)/)[1].length / 2;
    const isSep = /^\s*\[\]\|/.test(line);
    if (isSep) continue;
    const iconMatch = line.match(/\[([^\]]*)\]/);
    const iconStr = iconMatch ? iconMatch[1] : '';
    const afterBracket = line.replace(/^\s*\[[^\]]*\]/, '');
    const parts = afterBracket.split('|');
    const name = (parts[0] || '').trim();
    const groupKey = (parts[1] || '').trim();
    const hasGroupKey = groupKey.startsWith('「') && groupKey.endsWith('」');
    tree_nodes.push({ indent, name, iconStr, groupKey: hasGroupKey ? groupKey : null });
  }

  // 统计：笔记组 → 条目列表。新版备份放在 data['目录']，旧版散落在 data['词典'] 里，两者都兼容
  const groupSource = (data['目录'] && typeof data['目录'] === 'object' && !Array.isArray(data['目录']))
    ? data['目录'] : dict;
  const groupNotes = {};
  let totalNotes = 0;
  for (const key in groupSource) {
    if (key.startsWith('「') && key.endsWith('」') && Array.isArray(groupSource[key])) {
      groupNotes[key] = groupSource[key];
      totalNotes += groupSource[key].length;
    }
  }

  // 收集孤立笔记（在词典中有内容但不在任何组映射中的）
  const mappedTimestamps = new Set();
  for (const gk in groupNotes) {
    for (const entry of groupNotes[gk]) {
      const ts = entry.split('|').slice(1).join('|');
      if (ts) mappedTimestamps.add(ts);
    }
  }
  const orphanNotes = [];
  for (const key in dict) {
    if (key.startsWith('「') && key.endsWith('」')) continue;
    if (mappedTimestamps.has(key)) continue;
    if (typeof dict[key] !== 'string') continue;
    const content = (dict[key] || '').trim();
    if (!content) continue;
    orphanNotes.push(key);
  }

  // 统计分区数
  const sections = tree_nodes.filter(n => n.indent === 0);

  // 展示预览
  const previewBody = document.createElement('div');
  previewBody.innerHTML = `
    <div style="font-size:13px;line-height:1.8;color:var(--text-secondary);">
      <p>检测到记事本2.0备份文件：</p>
      <ul style="margin:8px 0 12px 16px;padding:0;">
        <li><b>${sections.length}</b> 个分区 → 将创建为笔记本</li>
        <li><b>${Object.keys(groupNotes).length}</b> 个笔记组 → 将创建为父笔记</li>
        <li><b>${totalNotes}</b> 条笔记内容</li>
        ${orphanNotes.length ? `<li><b>${orphanNotes.length}</b> 条未归类笔记 → 放入"未分类"</li>` : ''}
      </ul>
      <p style="margin-top:10px;">导入方式：</p>
      <label style="display:block;margin:6px 0;cursor:pointer;">
        <input type="radio" name="legacy-mode" value="append" checked> 追加到现有笔记（新建笔记本，不影响已有数据）
      </label>
      <label style="display:block;margin:6px 0;cursor:pointer;">
        <input type="radio" name="legacy-mode" value="replace"> 全新开始（清空现有数据，用导入内容替换）
      </label>
      <div id="legacy-replace-warn" style="display:none;color:#e53e3e;font-size:12px;margin:4px 0 0 22px;">⚠️ 将清除所有现有笔记，此操作不可恢复！</div>
    </div>
  `;

  previewBody.querySelectorAll('input[name="legacy-mode"]').forEach(r => {
    r.addEventListener('change', () => {
      previewBody.querySelector('#legacy-replace-warn').style.display =
        previewBody.querySelector('input[name="legacy-mode"]:checked')?.value === 'replace' ? 'block' : 'none';
    });
  });

  openModal({
    title: '导入记事本2.0数据',
    body: previewBody,
    footer: [
      { label: '开始导入', class: 'primary-btn', onClick: async () => {
        const mode = previewBody.querySelector('input[name="legacy-mode"]:checked')?.value || 'append';
        if (mode === 'replace') {
          if (!confirm('确定清空所有现有笔记并替换为导入内容吗？此操作不可恢复！')) return;
        }
        closeModal();
        await _executeLegacyImport(data, tree_nodes, groupNotes, orphanNotes, iconMap, mode);
      }},
      { label: '取消', class: 'secondary-btn', onClick: closeModal },
    ],
  });
}

async function _executeLegacyImport(data, treeNodes, groupNotes, orphanNotes, iconMap, mode) {
  const dict = data['词典'];

  if (mode === 'replace') {
    const fresh = { version: 2, notes: {}, rootOrder: [], trash: {}, trashOrder: [],
      workspaces: [], settings: storage.getAll().settings || {}, templates: storage.getTemplates() };
    await storage.importJSON(JSON.stringify(fresh));
  }

  // 批量操作时抑制逐条重渲染
  window._bulkImporting = true;

  // 建立分区→笔记本映射
  const sectionWsMap = {};
  let curSection = null;

  // 先创建所有分区对应的笔记本
  const sections = treeNodes.filter(n => n.indent === 0);
  for (const sec of sections) {
    const ws = storage.createWorkspace(sec.name, '📒');
    sectionWsMap[sec.name] = ws.id;
  }

  // 创建"未分类"笔记本（如果有孤立笔记）
  let uncategorizedWsId = null;
  if (orphanNotes.length > 0) {
    const ws = storage.createWorkspace('未分类', '📋');
    uncategorizedWsId = ws.id;
  }

  // 遍历目录树，建立层级结构
  const stack = []; // [{indent, noteId, wsId}]
  let imported = 0;

  for (const node of treeNodes) {
    // 找当前所属的分区
    if (node.indent === 0) {
      curSection = node.name;
      stack.length = 0;
      continue;
    }

    const wsId = sectionWsMap[curSection] || storage.getActiveWorkspace().id;

    // 弹出比当前indent更深或相同的栈元素
    while (stack.length > 0 && stack[stack.length - 1].indent >= node.indent) {
      stack.pop();
    }

    const parentId = stack.length > 0 ? stack[stack.length - 1].noteId : null;

    if (node.groupKey) {
      // 有笔记组key：创建父笔记节点，然后创建子笔记
      const parentNote = storage.create({ parentId, title: node.name, content: '', workspaceId: wsId });
      stack.push({ indent: node.indent, noteId: parentNote.id, wsId });

      const entries = groupNotes[node.groupKey] || [];
      for (const entry of entries) {
        const pipeIdx = entry.lastIndexOf('|');
        let title = pipeIdx > 0 ? entry.substring(0, pipeIdx) : entry;
        const timestamp = pipeIdx > 0 ? entry.substring(pipeIdx + 1) : '';
        let content = '';
        if (timestamp && dict[timestamp] !== undefined && typeof dict[timestamp] === 'string') {
          content = dict[timestamp] || '';
        }
        content = content.replace(/\r\n/g, '\n');
        // 如果title就是时间戳本身，尝试从内容第一行提取标题
        if (title === timestamp && content) {
          const headingMatch = content.match(/^##?\s+(.+)/);
          if (headingMatch) title = headingMatch[1].trim();
        }
        // 去除内容开头的 "## 标题" 如果和title一致
        const headMatch = content.match(/^##\s+(.+)\n/);
        if (headMatch && headMatch[1].trim() === title.trim()) {
          content = content.replace(/^##\s+.+\n+/, '');
        }
        storage.create({ parentId: parentNote.id, title: title || '无标题', content, workspaceId: wsId });
        imported++;
      }
    } else {
      // 没有groupKey的中间层节点（如Haid）：创建为空父笔记
      const folderNote = storage.create({ parentId, title: node.name, content: '', workspaceId: wsId });
      stack.push({ indent: node.indent, noteId: folderNote.id, wsId });
    }
  }

  // 导入孤立笔记
  for (const key of orphanNotes) {
    let content = (dict[key] || '').replace(/\r\n/g, '\n');
    const headingMatch = content.match(/^##\s+(.+)\n/);
    const title = headingMatch ? headingMatch[1].trim() : (key || '无标题');
    if (headingMatch) content = content.replace(/^##\s+.+\n+/, '');
    storage.create({ parentId: null, title, content, workspaceId: uncategorizedWsId });
    imported++;
  }

  await storage.save({ immediate: true });
  window._bulkImporting = false;
  tree.render();
  toast(`导入完成：${imported} 条笔记，${sections.length} 个笔记本`, 'success');
}

// 自建跨域代理的 Cloudflare Worker 完整代码（设置面板「复制」按钮用；与 docs/webdav-proxy-worker.js 同步维护）。
// 单文件发布要求一切内联，故嵌在这里（约 2KB）。
const WEBDAV_PROXY_WORKER_CODE = `/**
 * 枝记 WebDAV 跨域代理 — Cloudflare Worker（免费版即可，10 万请求/天）
 * 部署：dash.cloudflare.com → 左侧 Compute → Workers & Pages → 右上角 Create application
 *      → 选「Start with Hello World!」→ Deploy 部署官方示例 → 进入该 Worker → 右上角 </> Edit code
 *      → 清空 worker.js 示例代码 → 粘贴本代码 → Deploy
 * 然后把 https://名字.子域.workers.dev 填到枝记网页版「设置 → 同步 → 跨域代理」。
 * 子域默认含账号信息，可在 Workers & Pages 页右侧 Account Details → Subdomain 修改。
 * 工作方式：枝记请求 https://<本代理>/<完整网盘URL>，Worker 原样转发并补 CORS 头。
 * 安全：仅转发 https 目标；不存储不记录；笔记本体是 AES 密文。
 */
const ALLOW_METHODS = 'GET,HEAD,PUT,POST,DELETE,MKCOL,PROPFIND,MOVE,COPY,OPTIONS';
const PASS_HEADERS = ['authorization', 'content-type', 'depth', 'destination', 'overwrite', 'if-match', 'if-none-match'];

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const url = new URL(request.url);
    const target = decodeURIComponent(url.pathname.slice(1)) + url.search;
    if (!/^https:\\/\\//i.test(target)) {
      return new Response('用法：https://<本代理>/<完整的 https 网盘地址>', {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    const headers = new Headers();
    for (const k of PASS_HEADERS) {
      const v = request.headers.get(k);
      if (v) headers.set(k, v);
    }
    // 部分网盘（如坚果云）会拒绝无 User-Agent / Accept 的数据中心请求（返回 520），补上浏览器头
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    if (!headers.has('Accept')) headers.set('Accept', '*/*');
    let resp;
    try {
      resp = await fetch(target, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      });
    } catch (e) {
      return new Response('代理转发失败：' + (e && e.message), { status: 502, headers: corsHeaders(request) });
    }
    const out = new Headers(resp.headers);
    const cors = corsHeaders(request);
    for (const k in cors) out.set(k, cors[k]);
    return new Response(resp.body, { status: resp.status, headers: out });
  },
};

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Type, DAV, Last-Modified',
    'Access-Control-Max-Age': '86400',
  };
}
`;

function openSettingsModal(initialTab) {
  const body = document.createElement('div');
  // 优先读 localStorage（最权威：上次保存按钮直接写过；不会被云端覆盖）
  const curTheme = (localStorage.getItem('zhinote-theme') || storage.getSetting('theme') || 'light');
  const curSize = storage.getSetting('fontSize') || 14;
  const curLineHeight = storage.getSetting('lineHeight') || 1.5;
  const curPadding = storage.getSetting('editorPadding') || 1;
  let lastTab = (typeof initialTab === 'string' && initialTab) || localStorage.getItem('zhinote-settings-tab') || 'appearance';
  if (!['appearance', 'sync', 'backup', 'shortcuts', 'about'].includes(lastTab)) lastTab = 'appearance';
  const curSyncMethod = storage.getSetting('syncMethod') || 'none';
  const curProvider = storage.getSetting('webdavProvider') || 'jianguoyun';
  body.innerHTML = `
    <div class="settings-tabs" role="tablist" id="settings-tab-seg">
      <button type="button" class="settings-tabs-btn ${lastTab==='appearance'?'active':''}" data-tab="appearance">外观</button>
      <button type="button" class="settings-tabs-btn ${lastTab==='sync'?'active':''}" data-tab="sync">同步</button>
      <button type="button" class="settings-tabs-btn ${lastTab==='backup'?'active':''}" data-tab="backup">本地</button>
      <button type="button" class="settings-tabs-btn ${lastTab==='shortcuts'?'active':''}" data-tab="shortcuts">${window.matchMedia('(pointer: coarse)').matches ? '手势' : '快捷键'}</button>
      <button type="button" class="settings-tabs-btn ${lastTab==='about'?'active':''}" data-tab="about">关于</button>
    </div>

    <div id="settings-tab-appearance" class="${lastTab!=='appearance'?'settings-tab-hidden':''}">
    <div class="settings-section">主题</div>
    <div id="set-theme-grid" class="theme-chips">
      ${THEMES.map(t => {
        const map = {
          'light':           ['#ffffff', '#2383e2'],
          'dark':            ['#191919', '#529cca'],
          'solarized-light': ['#f4edd7', '#b58900'],
          'nord':            ['#2e3440', '#88c0d0'],
          'dracula':         ['#282a36', '#bd93f9'],
          'gruvbox':         ['#282828', '#d79921'],
        };
        const [bg, ac] = map[t.id] || ['#fff', '#888'];
        const sel = t.id === curTheme ? ' active' : '';
        return `<button type="button" class="theme-grid-item theme-chip${sel}" data-theme="${t.id}" data-name="${t.name}" style="--chip-ac:${ac};">
          <span class="theme-chip-dot" aria-hidden="true" style="background:${bg};"></span>${t.name}
        </button>`;
      }).join('')}
    </div>
    <div class="settings-section">字体与排版</div>
    <div class="set-grid-2">
      <div class="set-col">
        <label>笔记字体</label>
        <div class="set-font-select-wrap">
          <button id="set-font-refresh" class="set-font-refresh-inline" title="重新扫描本机字体">⟳</button>
          <select id="set-font" class="has-inline-btn">
            ${CONTENT_FONTS.map(f => `<option value="${f.id}"${(storage.getSetting('fontFamily')||'')===f.id?' selected':''}>${f.name}</option>`).join('')}
            ${(() => {
              const sys = getDetectedSystemFonts();
              if (!sys.length) return '';
              const cur = storage.getSetting('fontFamily') || '';
              return sys.map(f => `<option value="${escapeHtml(f.name)}"${cur===f.name?' selected':''}>${escapeHtml(f.name)}</option>`).join('');
            })()}
          </select>
        </div>
      </div>
      <div class="set-col">
        <label>字号</label>
        <input type="number" id="set-size" min="12" max="22" value="${curSize}" style="width:100%;margin-top:0;">
      </div>
    </div>
    <div class="set-grid-2">
      <div class="set-col">
        <label>行间距</label>
        <select id="set-line-height" style="width:100%;margin-top:0;">
          <option value="1.3" ${Number(curLineHeight)===1.3?'selected':''}>紧凑 (1.3)</option>
          <option value="1.4" ${Number(curLineHeight)===1.4?'selected':''}>较紧 (1.4)</option>
          <option value="1.5" ${Number(curLineHeight)===1.5?'selected':''}>默认 (1.5)</option>
          <option value="1.6" ${Number(curLineHeight)===1.6?'selected':''}>较松 (1.6)</option>
          <option value="1.75" ${Number(curLineHeight)===1.75?'selected':''}>宽松 (1.75)</option>
          <option value="2" ${Number(curLineHeight)===2?'selected':''}>很宽 (2.0)</option>
        </select>
      </div>
      <div class="set-col">
        <label>页边距</label>
        <select id="set-editor-pad" style="width:100%;margin-top:0;">
          <option value="0.5" ${Number(curPadding)===0.5?'selected':''}>紧凑 (0.5em)</option>
          <option value="1" ${Number(curPadding)===1?'selected':''}>适中 (1em)</option>
          <option value="1.5" ${Number(curPadding)===1.5?'selected':''}>较宽 (1.5em)</option>
          <option value="2.5" ${Number(curPadding)===2.5?'selected':''}>宽松 (2.5em)</option>
          <option value="4" ${Number(curPadding)===4?'selected':''}>超宽 (4em)</option>
        </select>
      </div>
    </div>
    <div class="settings-section">编辑器</div>
    <div class="set-grid-2">
      <div class="set-col">
        <label>阅读位置</label>
        <select id="set-scroll-pos" style="width:100%;margin-top:0;">
          <option value="restore" ${(storage.getSetting('scrollOnOpen')||'restore')==='restore'?'selected':''}>记住上次位置</option>
          <option value="top" ${storage.getSetting('scrollOnOpen')==='top'?'selected':''}>每次回到顶部</option>
          <option value="bottom" ${storage.getSetting('scrollOnOpen')==='bottom'?'selected':''}>每次回到底部</option>
        </select>
      </div>
      <div class="set-col">
        <label>挖空遮盖色</label>
        <select id="set-cloze-color" style="width:100%;margin-top:0;">
          <option value="black" ${(storage.getSetting('clozeColor')||'black')==='black'?'selected':''}>跟随文字（默认）</option>
          <option value="yellow" ${storage.getSetting('clozeColor')==='yellow'?'selected':''}>黄色</option>
          <option value="red" ${storage.getSetting('clozeColor')==='red'?'selected':''}>红色</option>
          <option value="green" ${storage.getSetting('clozeColor')==='green'?'selected':''}>绿色</option>
          <option value="blue" ${storage.getSetting('clozeColor')==='blue'?'selected':''}>蓝色</option>
        </select>
      </div>
    </div>
    <div class="set-grid-2">
      <div class="set-col">
        <label>大纲位置</label>
        <select id="set-outline-pos" style="width:100%;margin-top:0;">
          <option value="left" ${(storage.getSetting('outlinePosition')||'left')==='left'?'selected':''}>左侧（默认）</option>
          <option value="right" ${storage.getSetting('outlinePosition')==='right'?'selected':''}>右侧</option>
        </select>
      </div>
      <div class="set-col">
        <label>切换动画</label>
        <select id="set-note-transition" style="width:100%;margin-top:0;">
          <option value="none" ${(storage.getSetting('noteTransition')||'none')==='none'?'selected':''}>无动画（默认）</option>
          <option value="up" ${storage.getSetting('noteTransition')==='up'?'selected':''}>上滑淡入</option>
          <option value="fade" ${storage.getSetting('noteTransition')==='fade'?'selected':''}>纯淡入</option>
          <option value="scale" ${storage.getSetting('noteTransition')==='scale'?'selected':''}>缩放淡入</option>
          <option value="blur" ${storage.getSetting('noteTransition')==='blur'?'selected':''}>模糊淡入</option>
        </select>
      </div>
    </div>
    </div>

    <div id="settings-tab-sync" class="${lastTab!=='sync'?'settings-tab-hidden':''}">
    <label>同步方式</label>
    <select id="set-sync-method" style="width:100%;">
      <option value="jianguoyun" ${curSyncMethod==='webdav'&&curProvider==='jianguoyun'?'selected':''} title="免费 1GB · 每月上传流量 1GB · 国内直连速度快">坚果云 (1GB)</option>
      <option value="koofr" ${curSyncMethod==='webdav'&&curProvider==='koofr'?'selected':''} title="免费 10GB · 无流量限制 · 欧洲服务器">Koofr (10GB)</option>
      <option value="infinicloud" ${curSyncMethod==='webdav'&&curProvider==='infinicloud'?'selected':''} title="免费 20GB · 无流量限制 · 日本服务器 · 注册可能需排队">InfiniCLOUD (20GB·可能排队)</option>
      <option value="custom" ${curSyncMethod==='webdav'&&curProvider==='custom'?'selected':''} title="自行搭建或其他支持 WebDAV 的服务">自定义 WebDAV</option>
      <option value="none" ${curSyncMethod==='none'?'selected':''} title="关闭所有云端同步，仅本地保存">关闭同步</option>
    </select>

    <div id="sync-panel-webdav" class="sync-panel ${curSyncMethod==='none'?'settings-tab-hidden':''}">
    ${window.host.caps.quicker ? '' : `
    <div id="webdav-web-warning" style="display:none;font-size:12px;color:var(--warning,#c77d00);margin-top:8px;line-height:1.6;">
      ⚠ 经实测，坚果云会拦截来自公共代理（Cloudflare）的请求，<b>网页端暂时无法同步坚果云</b>。请改用 Koofr / InfiniCLOUD / 自建 WebDAV，或在 Quicker 端使用坚果云。
    </div>`}
    <label>服务器地址</label>
    <input type="text" id="set-webdav-url" placeholder="https://dav.jianguoyun.com/dav/" value="${escapeHtml(storage.getSetting('webdavUrl')||'')}" style="width:100%;">
    <label>用户名</label>
    <input type="text" id="set-webdav-user" placeholder="邮箱或用户名" value="${escapeHtml(storage.getSetting('webdavUser')||'')}" style="width:100%;">
    <label>密码</label>
    <div class="pass-input-wrap" style="position:relative;">
      <input type="password" id="set-webdav-pass" placeholder="应用专用密码" style="width:100%;padding-right:36px;">
      <button type="button" id="set-webdav-pass-eye" class="pass-eye-btn" title="显示/隐藏密码">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
      </button>
    </div>
    <details style="font-size:12px;color:var(--text-tertiary);margin-top:6px;">
      <summary style="cursor:pointer;">如何获取应用密码？</summary>
      <div style="margin-top:6px;line-height:1.8;" id="webdav-help-text"></div>
    </details>
    <label style="margin-top:14px;">加密口令（可选）</label>
    <div class="pass-input-wrap" style="position:relative;">
      <input type="password" id="set-webdav-crypto-pass" placeholder="留空使用内置默认口令" value="${escapeHtml(storage.getSetting('webdavCryptoPass')||'')}" style="width:100%;padding-right:36px;">
      <button type="button" id="set-webdav-crypto-eye" class="pass-eye-btn" title="显示/隐藏口令">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
      </button>
    </div>
    <details style="font-size:12px;color:var(--text-tertiary);margin-top:6px;">
      <summary style="cursor:pointer;">加密口令是什么？忘了怎么办？</summary>
      <div style="margin-top:6px;line-height:1.8;">
        笔记上云前先用口令加密，云端/代理只见密文。留空时用应用内置口令（基础防护）；<b>自设口令</b>后只有知道口令的设备能解开，安全性更高。<br>
        · 所有设备需填<b>同一口令</b>（设置 → 同步 → 此处）；<br>
        · 改口令保存时请选「<b>上传覆盖云端</b>」，让云端用新口令重新加密；其它设备改好口令后再同步；<br>
        · 忘了口令：在任一配置过的旧设备此处点眼睛查看；<br>
        · 全部丢失：在仍有完整本地数据的设备上设个新口令、保存时选「上传覆盖云端」即可零丢失重置。
      </div>
    </details>
    ${window.host.caps.quicker ? '' : (() => {
      const rawProxy = (storage.getSetting('webdavProxy') || '').trim();
      const proxyMode = !rawProxy ? 'default' : (rawProxy === 'direct' ? 'direct' : 'custom');
      return `
    <label style="margin-top:14px;">跨域代理</label>
    <select id="set-webdav-proxy-mode" style="width:100%;">
      <option value="default" ${proxyMode==='default'?'selected':''}>内置默认代理（共用配额，量大可能限流；不支持坚果云）</option>
      <option value="custom" ${proxyMode==='custom'?'selected':''}>自定义代理（需自行部署，见下方教程）</option>
      <option value="direct" ${proxyMode==='direct'?'selected':''}>直连（需网盘放行跨域，一般不可用）</option>
    </select>
    <input type="text" id="set-webdav-proxy" placeholder="如 https://你的代理.workers.dev" value="${escapeHtml(proxyMode==='custom'?rawProxy:'')}" style="width:100%;margin-top:8px;${proxyMode==='custom'?'':'display:none;'}">
    <details style="font-size:12px;color:var(--text-tertiary);margin-top:6px;">
      <summary style="cursor:pointer;">为什么需要代理？如何免费自建？</summary>
      <div style="margin-top:6px;line-height:1.8;">
        浏览器禁止网页直接访问网盘（跨域限制），需经代理转发；Quicker 端无此限制。笔记内容加密后才经过代理，不放心可自建——代理在自己手里。<br>
        <b>免费自建（Cloudflare Worker）：</b><br>
        ① 注册/登录 <a href="https://dash.cloudflare.com" target="_blank" rel="noopener">dash.cloudflare.com</a> → 左侧 Compute → Workers &amp; Pages；<br>
        ② 右上角 Create application → 选「Start with Hello World!」→ 点 Deploy 部署官方示例；<br>
        ③ 进入该 Worker，点右上角 &lt;/&gt; Edit code → 清空 worker.js 里的示例代码，粘贴下方按钮复制的代理代码 → Deploy；<br>
        ④ 上方选「自定义代理」，把 <code>https://名字.子域.workers.dev</code> 填进输入框 → 保存。<br>
        免费额度 10 万请求/天，个人使用绰绰有余。<br>
        <b>自建代理的限制：</b><br>
        ① 网络限制：<code>workers.dev</code> 域名在国内网络常被拦截打不开，遇到时需给 Worker 绑定自己的域名（Settings → Domains &amp; Routes → Add → Custom domain）；<br>
        ② 坚果云在服务器侧屏蔽 Cloudflare 出口，Cloudflare 代理（含内置默认）都转发不了坚果云——坚果云用户请改用 Koofr / InfiniCLOUD 等网盘，或把代理部署在其它平台（如国内云函数）。<br>
        <button type="button" id="set-webdav-proxy-copy" class="link-btn" style="margin-top:6px;">📋 复制 Worker 代理代码</button>
      </div>
    </details>`;})()}
    <div style="display:flex;gap:8px;align-items:center;margin-top:16px;">
      <button id="set-webdav-test" class="link-btn" title="测试连接">测试连接</button>
      <span style="color:var(--border);">|</span>
      <button id="set-webdav-sync-now" class="link-btn" title="立即同步一次">立即同步</button>
      <span style="color:var(--border);">|</span>
      <button id="set-webdav-recover" class="link-btn" title="查看 / 恢复 / 删除云端笔记">管理云端笔记</button>
      <span style="color:var(--border);">|</span>
      <button id="set-webdav-repair" class="link-btn" title="云端清单（manifest.json）损坏、同步反复报错时使用">修复云端清单</button>
    </div>
    <div id="webdav-sync-status" style="font-size:12px;color:var(--text-tertiary);margin-top:8px;min-height:20px;line-height:1.6;"></div>
    </div>
    </div>
    <div id="settings-tab-backup" class="${lastTab!=='backup'?'settings-tab-hidden':''}">
      <div id="images-dir-block" style="display:none;margin-bottom:18px;">
        <label>图片文件夹</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="set-images-dir" readonly style="flex:1;min-width:0;" title="笔记图片的本地存放位置（文件名为内容哈希）">
          <button id="set-images-browse" class="link-btn" title="选择新文件夹并迁移全部图片">更改…</button>
          <button id="set-images-open" class="link-btn" title="在资源管理器中打开">打开</button>
        </div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;line-height:1.6;">笔记图片以独立文件存放于此（默认 文档\ZhiNote\images）；更改时自动迁移现有图片</div>
      </div>
      <label>定时备份</label>
      <select id="set-backup-enabled" style="width:100%;">
        <option value="0">关闭</option>
        <option value="1">开启</option>
      </select>
      <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;line-height:1.6;">定时把全部笔记导出为 JSON 存到本地文件夹</div>

      <div id="backup-detail">
        <label style="margin-top:14px;">备份目录</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="set-backup-dir" placeholder="如 D:\ZhiNote备份" style="flex:1;min-width:0;">
          <button id="set-backup-browse" class="link-btn" title="选择文件夹">浏览…</button>
        </div>

        <label style="margin-top:14px;">时间间隔（分钟）</label>
        <input type="number" id="set-backup-interval" min="1" step="1" style="width:100%;">

        <label style="margin-top:14px;">保留份数</label>
        <input type="number" id="set-backup-keep" min="1" step="1" style="width:100%;">
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">超出份数时自动删除时间最早的备份</div>

        <div style="display:flex;gap:8px;align-items:center;margin-top:16px;">
          <button id="set-backup-now" class="link-btn" title="立即备份一次">立即备份</button>
          <span style="color:var(--border);">|</span>
          <button id="set-backup-open" class="link-btn" title="在资源管理器中打开备份目录">打开备份文件夹</button>
        </div>
        <div id="backup-status" style="font-size:12px;color:var(--text-tertiary);margin-top:8px;min-height:20px;line-height:1.6;"></div>
      </div>
    </div>
    <div id="settings-tab-shortcuts" class="${lastTab!=='shortcuts'?'settings-tab-hidden':''}">
      ${(() => {
        const groups = [
          { title: '全局 / 笔记', items: [
            ['新建笔记', 'Ctrl+Alt+N'], ['切换 / 新建笔记本', 'Ctrl+Shift+N'], ['命令面板 / 切换笔记', 'Ctrl+P'], ['切换到上一篇笔记', 'Ctrl+Tab'],
            ['全文搜索', 'Ctrl+F'], ['手动保存', 'Ctrl+S'], ['大纲面板', 'Ctrl+Shift+O'],
            ['侧边栏', 'Ctrl+\\'], ['阅读模式', 'Ctrl+Shift+E'], ['表情符号', 'Ctrl+;'],
            ['专注模式', 'F10'], ['挖空复习模式', 'F11'], ['标记挖空选区', 'Alt+M'],
            ['放大 / 缩小 / 复位字号', 'Ctrl+= / Ctrl+- / Ctrl+0'], ['关闭弹层', 'Esc'],
          ]},
          { title: '编辑（编辑器内）', items: [
            ['加粗', 'Ctrl+B'], ['斜体', 'Ctrl+I'], ['下划线', 'Ctrl+U'], ['删除线', 'Ctrl+Shift+S'],
            ['行内代码', 'Ctrl+E'], ['引用', 'Ctrl+Shift+B / Alt+Shift+B'], ['分割线', 'Ctrl+Shift+H'], ['无序列表', 'Ctrl+Shift+8'],
            ['有序列表', 'Ctrl+Shift+7'], ['一级~六级标题', 'Ctrl+Alt+1 … 6'], ['软换行', 'Shift+Enter'],
            ['撤销 / 重做', 'Ctrl+Z / Ctrl+Y'],
          ]},
        ];
        const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
        const kbd = (k) => k.split(' / ').map(p => p.split('+').map(x => `<kbd class="sc-key">${esc(x)}</kbd>`).join('<span class="sc-plus">+</span>')).join('<span class="sc-or">或</span>');
        // 快捷键图标（复用 feather 风格描边图标，与工具栏/气泡菜单同源）
        const SC_ICON_PATHS = {
          '新建笔记': '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6M9 15h6"/>',
          '切换 / 新建笔记本': '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>',
          '命令面板 / 切换笔记': '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
          '切换到上一篇笔记': '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>',
          '全文搜索': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
          '手动保存': '<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
          '大纲面板': '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
          '侧边栏': '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>',
          '阅读模式': '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>',
          '表情符号': '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
          '专注模式': '<path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3"/>',
          '挖空复习模式': '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
          '标记挖空选区': '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/>',
          '放大 / 缩小 / 复位字号': '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
          '关闭弹层': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
          '加粗': '<path d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z"/><path d="M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z"/>',
          '斜体': '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
          '下划线': '<path d="M6 3v7a6 6 0 0012 0V3"/><line x1="4" y1="21" x2="20" y2="21"/>',
          '删除线': '<path d="M16 4H9a3 3 0 00-2.83 4"/><path d="M14 12a4 4 0 010 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>',
          '行内代码': '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
          '引用': '<line x1="6" y1="4" x2="6" y2="20"/><line x1="10" y1="7" x2="20" y2="7"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="17" x2="16" y2="17"/>',
          '无序列表': '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
          '有序列表': '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 4v4M3 8h2M3 13h2l-2 3h2"/>',
          '一级~六级标题': '<path d="M6 4v16M18 4v16M6 12h12"/>',
          '软换行': '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 01-4 4H4"/>',
          '撤销 / 重做': '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',
        };
        const scIco = (label) => {
          const p = SC_ICON_PATHS[label] || '<circle cx="12" cy="12" r="2.5"/>';
          return `<span class="sc-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg></span>`;
        };
        const renderGroups = (gs) => gs.map(g => `
          <div class="sc-group-title">${g.title}</div>
          <div class="sc-list">
            ${g.items.map(([label, k]) => `<div class="sc-row"><span class="sc-label">${scIco(label)}${esc(label)}</span><span class="sc-keys">${kbd(k)}</span></div>`).join('')}
          </div>
        `).join('');

        const shortcutsHtml = renderGroups(groups)
          + `<div style="font-size:12px;color:var(--text-tertiary);margin-top:14px;line-height:1.7;">编辑类快捷键在编辑器获得焦点时生效；目前快捷键暂不支持自定义。</div>`;

        // 触屏手势清单（与 setupTouchGestures / tree.js 长按拖拽实现一一对应）
        const gestureGroups = [
          { title: '浏览 / 导航', items: [
            ['拉出侧栏', '左缘右滑 / 双指右滑'],
            ['收起侧栏', '侧栏上左滑 / 点遮罩'],
            ['拉出大纲', '双指左滑'],
            ['下一篇 / 上一篇', '双指上滑 / 双指下滑'],
            ['回到顶部', '双击顶栏'],
            ['立即同步', '编辑区顶部下拉'],
            ['阅读模式', '三指轻点'],
            ['命令面板', '键盘工具条 ⌘'],
          ]},
          { title: '笔记树', items: [
            ['多选笔记', '双指轻点行'],
            ['笔记菜单', '长按不动松手'],
            ['拖拽排序 / 改层级', '长按拾起后拖动'],
          ]},
          { title: '编辑', items: [
            ['选中文字', '长按拖选（系统原生）'],
            ['右键菜单', '双指轻点正文'],
            ['图片菜单', '双击图片 / 双指轻点'],
            ['表格菜单', '双指轻点表格'],
            ['调整字号', '编辑区双指捏合'],
            ['撤销', '摇一摇（安卓）'],
            ['格式工具条', '聚焦输入时自动浮于键盘上方'],
            ['语音输入', '键盘工具条 🎤'],
            ['标记挖空', '选中文字 → 工具条「挖」'],
          ]},
        ];
        const gesturesHtml = renderGroups(gestureGroups);

        // 两节统一做成可折叠：设备的主输入方式那节默认展开，另一节收起。
        // 触屏为主（手机/平板）→ 手势展开、键盘快捷键收起（外接键盘的二合一/平板仍用得上）；
        // 鼠标为主 → 快捷键展开；有触屏（any-pointer: coarse，触屏笔记本）才显示手势节。
        const sum = (t) => `<summary style="cursor:pointer;font-size:13px;color:var(--text-secondary);margin:4px 0 6px;font-weight:600;">${t}</summary>`;
        const sec = (title, html, open) => `<details${open ? ' open' : ''} style="margin-bottom:10px;">${sum(title)}${html}</details>`;
        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        const hasTouch = window.matchMedia('(any-pointer: coarse)').matches;
        if (isTouch) {
          return sec('👆 触屏手势', gesturesHtml, true)
               + sec('⌨️ 键盘快捷键（外接键盘时可用）', shortcutsHtml, false);
        }
        if (hasTouch) {
          return sec('⌨️ 键盘快捷键', shortcutsHtml, true)
               + sec('👆 触屏手势（触屏操作时可用）', gesturesHtml, false);
        }
        return sec('⌨️ 键盘快捷键', shortcutsHtml, true);
      })()}
    </div>
    <div id="settings-tab-about" class="${lastTab!=='about'?'settings-tab-hidden':''}">
      <div class="about-hero">
        <div class="about-logo">📖</div>
        <div class="about-title">枝记 ZhiNote</div>
        <div class="about-subtitle">轻量 Markdown 笔记工具</div>
        <div class="about-version" title="运行版本标记">版本 ${escapeHtml(window.__MD_VER__ || '未知')}</div>
      </div>
      <div class="about-web-card">
        <div class="about-web-qr" id="about-web-qr">生成中…</div>
        <div class="about-web-info">
          <div class="about-web-name">网页版</div>
          <div class="about-web-url" data-href="${escapeHtml(_webAppUrl())}" title="点击打开">${escapeHtml(_webAppUrl().replace(/^https?:\/\//, ''))}</div>
          <div class="about-web-desc">枝记网页版 · 扫码或在浏览器输入网址即可使用</div>
          <div class="about-web-actions">
            <button type="button" class="link-btn" id="about-web-copy" title="复制网页版链接">复制链接</button>
            <button type="button" class="link-btn" id="about-pwa-install" style="display:none;">📲 安装到主屏幕</button>
          </div>
        </div>
      </div>
      <div class="about-bottom-row">
        <div class="about-footer">
          <button type="button" class="about-text-link" data-href="https://getquicker.net/User/Actions/76824-dalou" title="访问作者的 Quicker 主页">作者主页</button>
          <span class="about-footer-sep">·</span>
          <button type="button" class="about-text-link" data-href="https://getquicker.net/Sharedaction?code=b5091d78-12cc-4fb9-bd01-08debb8a5d21&amp;fromMyShare=true" title="枝记动作的分享页">动作链接</button>
          <span class="about-footer-sep">·</span>
          <button type="button" class="about-text-link" data-href="https://github.com/daloudalou/ZhiNote" title="开源仓库（AGPL-3.0）：源码、自托管部署与单文件下载">GitHub 开源</button>
          <span class="about-footer-sep">·</span>
          <button type="button" class="about-text-link" id="set-import-legacy" title="从记事本 2.0 导入旧数据">数据迁移</button>
        </div>
        <div class="about-support-group">
          <button id="about-donate-btn" class="about-donate-btn" title="请作者喝杯奶茶">☕ 投喂</button>
          <button id="about-like-btn" class="about-like-btn" title="给枝记点个赞，鼓励作者继续更新">
            <span class="about-like-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M2 21h4V9H2v12zm20-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13.17 1 6.59 7.59C6.22 7.95 6 8.45 6 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>
            </span>
            <span class="about-like-text">点赞</span>
          </button>
        </div>
      </div>
    </div>
  `;

  openModal({
    title: '设置',
    body,
    dialogClass: 'settings-modal',
    onClose: () => {
      const savedTheme = localStorage.getItem('zhinote-theme') || storage.getSetting('theme') || 'light';
      if (savedTheme !== (body.querySelector('#set-theme-grid .theme-grid-item.active')?.dataset.theme || 'light')) {
        applyTheme(savedTheme);
        if (editor.setTheme) editor.setTheme(savedTheme);
      }
      // 还原行间距/字号的实时预览（未点保存则不持久化）
      const savedSize = parseInt(storage.getSetting('fontSize') || 14, 10);
      const savedLh = parseFloat(storage.getSetting('lineHeight')) || 1.5;
      document.documentElement.style.setProperty('--editor-font-size', savedSize + 'px');
      document.documentElement.style.setProperty('--editor-line-height', String(savedLh));
      applyEditorFontSize(savedSize, savedLh);
      applyEditorPadding(storage.getSetting('editorPadding') || 1);
    },
    footer: [
      { label: '保存', class: 'primary-btn', onClick: async () => {
        const size = parseInt(body.querySelector('#set-size').value) || 14;
        const fontFamily = body.querySelector('#set-font')?.value || '';
        const themeId = body.querySelector('#set-theme-grid .theme-grid-item.active')?.dataset.theme || 'light';
        storage.setSetting('fontSize', size);
        storage.setSetting('fontFamily', fontFamily);
        storage.setSetting('theme', themeId);
        const lineHeight = parseFloat(body.querySelector('#set-line-height')?.value) || 1.5;
        storage.setSetting('lineHeight', lineHeight);
        applyEditorLineHeight(lineHeight);
        const editorPad = parseFloat(body.querySelector('#set-editor-pad')?.value) || 1;
        storage.setSetting('editorPadding', editorPad);
        applyEditorPadding(editorPad);
        const clozeColor = body.querySelector('#set-cloze-color')?.value || 'black';
        storage.setSetting('clozeColor', clozeColor);
        applyClozeColor(clozeColor);
        const scrollPos = body.querySelector('#set-scroll-pos')?.value || 'restore';
        storage.setSetting('scrollOnOpen', scrollPos);
        const noteTransition = body.querySelector('#set-note-transition')?.value || 'none';
        storage.setSetting('noteTransition', noteTransition);
        const outlinePos = body.querySelector('#set-outline-pos')?.value || 'left';
        storage.setSetting('outlinePosition', outlinePos);
        applyOutlinePosition(outlinePos);
        try { localStorage.setItem('zhinote-font', fontFamily); } catch (_) {}
        try { localStorage.setItem('zhinote-theme', themeId); } catch (_) {}
        applyFontFamily(fontFamily);
        applyTheme(themeId);
        if (editor.setTheme) editor.setTheme(themeId);
        document.documentElement.style.setProperty('--editor-font-size', size + 'px');
        applyEditorFontSize(size);

        // 同步方式切换 — 仅在实际变化时执行
        const selectedMethod = body.querySelector('#set-sync-method')?.value || 'none';
        const providerNames = { jianguoyun: '坚果云', koofr: 'Koofr', infinicloud: 'InfiniCLOUD', custom: '自定义 WebDAV' };
        const newUrl = (body.querySelector('#set-webdav-url')?.value || '').trim();
        const newUser = (body.querySelector('#set-webdav-user')?.value || '').trim();
        const newPass = body.querySelector('#set-webdav-pass')?.value || '';
        // 加密口令（阶段C）：本机设置，改了 → 云端需用新口令重新加密 → 走切换流程（建议选"上传覆盖云端"）
        const newCryptoPass = (body.querySelector('#set-webdav-crypto-pass')?.value || '').trim();
        const cryptoPassChanged = newCryptoPass !== (storage.getSetting('webdavCryptoPass') || '').trim();
        // 跨域代理（仅网页宿主有此控件）：独立于"同步方式切换"保存，变更后刷新运行中配置。
        // 存储语义：'' = 内置默认代理；'direct' = 直连；其余 = 自定义地址。
        if (body.querySelector('#set-webdav-proxy-mode')) {
          const newProxy = _readProxySetting();
          if (newProxy !== (storage.getSetting('webdavProxy') || '')) {
            storage.setSetting('webdavProxy', newProxy);
            try { await window.webdavSync?.loadConfig(); } catch (_) {}
          }
        }

        const syncChanged = (() => {
          if (selectedMethod === 'none') return curSyncMethod !== 'none';
          if (curSyncMethod !== 'webdav') return true;
          if (selectedMethod !== curProvider) return true;
          if (cryptoPassChanged) return true; // 口令变了：云端密文要换钥，必须重走策略弹窗
          const savedUrl = storage.getSetting('webdavUrl') || '';
          const savedUser = storage.getSetting('webdavUser') || '';
          if (newUrl !== savedUrl || newUser !== savedUser) return true;
          if (newPass && newPass !== _initialPassValue) return true;
          return false;
        })();
        // 同步未启用时改口令：无云端密文可换，静默保存即可（启用同步后自动生效）
        if (cryptoPassChanged && (selectedMethod === 'none' || !syncChanged)) {
          storage.setSetting('webdavCryptoPass', newCryptoPass);
        }

        // 仅改口令（服务商/地址/账号/密码都没动）：方向是确定的，不弹"上传/下载"策略弹窗——
        // ① 新口令能解开云端（其它设备已换好锁，这台补口令）→ 直接生效；
        // ② 解不开 → 要么输错、要么是要给云端换锁：明确确认后才整体重新加密上传；
        // ③ 云端没数据 → 直接保存。
        const passOnlyChange = cryptoPassChanged && curSyncMethod === 'webdav' && selectedMethod === curProvider
          && newUrl === (storage.getSetting('webdavUrl') || '')
          && newUser === (storage.getSetting('webdavUser') || '')
          && !(newPass && newPass !== _initialPassValue);
        if (passOnlyChange) {
          const oldCryptoPass = storage.getSetting('webdavCryptoPass') || '';
          try {
            const res = await window.webdavSync.checkCloudKey(newCryptoPass);
            if (!res.hasData || res.keyMatch === true) {
              storage.setSetting('webdavCryptoPass', newCryptoPass);
              await window.webdavSync.loadConfig(); // 新钥即时生效 + 解除"口令不一致"上传闸
              toast(res.keyMatch === true ? '加密口令已生效（与云端数据一致）' : '加密口令已保存', 'success');
            } else {
              const go = await _confirmReencryptCloud();
              if (!go) { openSettingsModal('sync'); return; } // 返回检查：不保存口令，重开设置页
              window.webdavSync.stop(); // 重加密期间不让轮询/上传抢跑
              storage.setSetting('webdavCryptoPass', newCryptoPass);
              await window.webdavSync.loadConfig();
              const r = await window.webdavSync.mirrorLocalToCloud();
              if (r && r.ok) {
                toast('已用新口令重新加密云端全部笔记；其它设备请改成同一口令', 'success');
              } else {
                // 失败回滚口令：云端若已写入少量新钥文件，旧钥下的"解密自愈"会用本地副本重传洗回来
                storage.setSetting('webdavCryptoPass', oldCryptoPass);
                await window.webdavSync.loadConfig();
                toast('重新加密失败：' + (r ? r.error : '未知错误') + '；口令未更换，请稍后重试', 'error');
              }
              await window.webdavSync.startAutoSync();
            }
          } catch (e) {
            toast('口令检查失败：' + _zhSyncError(e?.message || e), 'error');
            return;
          }
          await storage.save({ immediate: true });
          closeModal();
          return;
        }

        if (syncChanged) {
        if (selectedMethod === 'none') {
          if (storage.getSetting('syncMethod') !== 'none') {
            try {
              await storage.switchSyncMethod('none', {});
              toast('已关闭云同步', 'info');
              _setCloudSyncDot('disabled');
            } catch (e) {
              toast('关闭同步失败：' + _zhSyncError(e?.message || e), 'error');
              return;
            }
          }
        } else {
          if (!newUrl || !newUser || !newPass) {
            toast('请填写所有字段', 'warning');
            return;
          }
          const provider = selectedMethod;
          const providerName = providerNames[provider] || provider;
          try {
            // 先用新凭证探测云端（不提交切换）。这样"取消"时当前同步保持原样、不会被关掉。
            // 探测不 await：策略弹窗立即出现（占位"正在检测云端…"），探测完成后原地更新内容。
            const localNoteCount = Object.keys(storage.getAll().notes || {}).length;
            const probePromise = window.webdavSync.probeCloudState({
              url: newUrl, user: newUser, pass: newPass,
              proxy: window.webdavSync.resolveProxy(_readProxySetting()),
              testCryptoPass: newCryptoPass, // 用（可能是新的）口令试解云端，弹窗据此提示该选哪边
            });
            const choice = await _askSyncStrategy(providerName, localNoteCount, probePromise, { passChanged: cryptoPassChanged });

            if (choice === 'cancel') {
              // 取消：不切换、不动当前同步。策略弹窗与设置弹窗共用同一 overlay，
              // closeModal 后设置页已被替换掉，需要重新打开设置页（同步标签），还原服务商选择。
              await storage.save({ immediate: true }); // 仍持久化本次外观等改动
              toast('已取消切换，未改动当前同步', 'info');
              openSettingsModal('sync');
              return;
            }

            // 用户确认了方向，才真正提交切换。
            storage.setSetting('webdavCryptoPass', newCryptoPass); // 先落口令：后续加解密即用新钥
            const encPass = await window.webdavSync.aesEncrypt(newPass);
            await storage.switchSyncMethod('webdav', {
              webdavUrl: newUrl, webdavUser: newUser, webdavPass: encPass,
              webdavProvider: provider, webdavEncryptNotes: true, autoStart: false,
            });
            _draftCache.clear();
            await window.webdavSync.loadConfig();
            _setCloudSyncDot('syncing');

            if (choice === 'upload') {
              // 真正的「覆盖云端」：删云端本地已没有的多余笔记 + epoch+1（其它设备对齐），再传本地全部。
              // 注意顺序：先镜像（重新加密）完成，再 startAutoSync——否则改口令时轮询会抢先
              // 用新口令去拉旧口令加密的云端，弹出误导性的"口令不一致"。
              const r = await window.webdavSync.mirrorLocalToCloud();
              await window.webdavSync.startAutoSync(); // 清掉 switchSyncMethod 里 stop() 置的 _stopped
              if (r && r.ok) toast(`已用本地覆盖云端${r.removed ? `，清理了 ${r.removed} 篇云端多余笔记` : ''}`, 'success');
              else toast(`上传失败：${r ? r.error : '未知错误'}`, 'error');
            } else if (choice === 'download') {
              await window.webdavSync.startAutoSync();
              // 真正的「下载云端覆盖本地」：强制采纳云端为权威，本地多余笔记进「同步留底」后移除。
              try {
                await window.webdavSync.doGet({ force: true, adopt: true });
                toast(`已从云端下载并覆盖本地`, 'success');
              } catch (e) { toast(`下载失败：${e.message}`, 'error'); }
            } else {
              await window.webdavSync.startAutoSync();
              toast(`已保存并切换到 ${providerName} 同步`, 'success');
            }
          } catch (e) {
            toast(`${providerName} 切换失败：` + e.message, 'error');
            return;
          }
        }
        } // end if (syncChanged)

        await storage.save({ immediate: true });
        closeModal();
      }},
      { label: '取消', class: 'secondary-btn', onClick: closeModal },
    ],
  });

  // ========== 顶级标签页切换（外观 / 同步）==========
  const SETTINGS_TAB_ORDER = ['appearance', 'sync', 'backup', 'shortcuts', 'about'];
  function activateSettingsTab(tab) {
    if (!SETTINGS_TAB_ORDER.includes(tab)) return;
    body.querySelectorAll('#settings-tab-seg .settings-tabs-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    try { localStorage.setItem('zhinote-settings-tab', tab); } catch (_) {}
    SETTINGS_TAB_ORDER.forEach(id => {
      const el = body.querySelector('#settings-tab-' + id);
      if (el) el.classList.toggle('settings-tab-hidden', id !== tab);
    });
  }
  body.querySelectorAll('#settings-tab-seg .settings-tabs-btn').forEach(btn => {
    btn.addEventListener('click', () => activateSettingsTab(btn.dataset.tab));
  });
  // 滚轮在标签栏上切换标签
  const _settingsTabSeg = body.querySelector('#settings-tab-seg');
  if (_settingsTabSeg) {
    let _tabWheelThrottle = 0;
    _settingsTabSeg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const now = Date.now();
      if (now - _tabWheelThrottle < 120) return;
      _tabWheelThrottle = now;
      const cur = body.querySelector('#settings-tab-seg .settings-tabs-btn.active')?.dataset.tab || 'appearance';
      let idx = SETTINGS_TAB_ORDER.indexOf(cur);
      idx = e.deltaY > 0 ? (idx + 1) % SETTINGS_TAB_ORDER.length : (idx - 1 + SETTINGS_TAB_ORDER.length) % SETTINGS_TAB_ORDER.length;
      activateSettingsTab(SETTINGS_TAB_ORDER[idx]);
    }, { passive: false });
  }

  // ========== 旧版数据导入 ==========
  body.querySelector('#set-import-legacy')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeModal();
    setTimeout(() => _importLegacyNotes(), 300);
  });


  // ========== 点赞按钮 ==========
  setupAboutLikeButton(body.querySelector('#about-like-btn'));

  // ========== 投喂（赞赏码）==========
  body.querySelector('#about-donate-btn')?.addEventListener('click', openDonateCard);

  // ========== 关于页：网页版二维码 ==========
  renderAboutWebQr(body.querySelector('#about-web-qr'));
  body.querySelector('#about-web-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(_webAppUrl()); toast('已复制网页版链接', 'success'); }
    catch (_) { toast('复制失败', 'error'); }
  });

  // PWA 安装按钮：仅当浏览器给出 beforeinstallprompt（网页宿主 + 未安装过）时显示
  const _pwaBtn = body.querySelector('#about-pwa-install');
  if (_pwaBtn && _pwaInstallEvt) {
    _pwaBtn.style.display = '';
    _pwaBtn.addEventListener('click', async () => {
      try {
        _pwaInstallEvt.prompt();
        await _pwaInstallEvt.userChoice;
        _pwaInstallEvt = null;
        _pwaBtn.style.display = 'none';
      } catch (_) {}
    });
  } else if (_pwaBtn && document.body.classList.contains('is-ios')
    && !window.host.isQuicker() && !document.body.classList.contains('pwa-standalone')) {
    // iOS/iPadOS 没有 beforeinstallprompt，只能手动"添加到主屏幕"——给出指引
    _pwaBtn.style.display = '';
    _pwaBtn.addEventListener('click', () => {
      toast('在 Safari 中：点工具栏「分享」按钮（□↑）→ 下拉找到「添加到主屏幕」→ 添加', 'info', { id: 'ios-pwa', duration: 7000 });
    });
  }

  // ========== 同步方式下拉切换 ==========
  const syncMethodSelect = body.querySelector('#set-sync-method');
  const panelWebdav = body.querySelector('#sync-panel-webdav');

  // ========== WebDAV 面板逻辑 ==========
  const urlInput = body.querySelector('#set-webdav-url');
  const helpText = body.querySelector('#webdav-help-text');
  const webdavStatus = body.querySelector('#webdav-sync-status');
  const userInput = body.querySelector('#set-webdav-user');
  const passInput = body.querySelector('#set-webdav-pass');

  const providerDefaults = {
    jianguoyun: { url: 'https://dav.jianguoyun.com/dav/', placeholder: 'https://dav.jianguoyun.com/dav/', help: '1. 登录坚果云网页版<br>2. 右上角"账户信息" → "安全选项"<br>3. 找到"第三方应用管理" → "添加应用密码"<br>4. 输入名称（如"笔记同步"）→ 生成密码<br>5. 将生成的密码填入上方"密码"栏<br><br>服务器地址固定为：<code>https://dav.jianguoyun.com/dav/</code><br><br><b>限制：</b>免费 1GB 存储 · 每月上传流量 1GB · 国内直连速度快' },
    koofr: { url: 'https://app.koofr.net/dav/Koofr', placeholder: 'https://app.koofr.net/dav/Koofr', help: '1. 访问 <a class="ext-link" data-href="https://app.koofr.net/signup">app.koofr.net/signup</a> 注册并登录<br>2. 点击右上角头像 → 首选项<br>3. 左侧菜单选择 密码<br>4. 滚动到 "应用密码" 区域<br>5. 在 "生成新密码" 输入名称（如"笔记同步"）→ 点击 生成<br>6. <b>立即复制密码</b>（之后无法再次查看）<br>7. 用户名为注册邮箱<br><br>服务器地址固定为：<code>https://app.koofr.net/dav/Koofr</code><br><br><b>限制：</b>免费 10GB · 无流量限制 · 欧洲服务器（国内速度偏慢）' },
    infinicloud: { url: '', placeholder: 'https://your-username.teracloud.jp/dav/', help: '1. 访问 <a class="ext-link" data-href="https://infini-cloud.net/en/">infini-cloud.net</a> 注册账号<br>2. 登录后进入 Settings → Apps Connection<br>3. 勾选 "Enable apps connection"<br>4. 点击 "Create new apps password"<br>5. WebDAV URL 格式：https://你的用户名.teracloud.jp/dav/<br>6. 用户名为注册邮箱，密码为刚生成的 Apps Password<br><br><b>限制：</b>免费 20GB · 无流量限制 · 日本服务器<br><b>注意：</b>注册时可能需要排队等待审批，时间不确定' },
    custom: { url: '', placeholder: 'https://your-server.com/dav/', help: '请填写你的 WebDAV 服务器地址，确保支持 Basic Auth 认证。' },
  };

  const _initDropVal = syncMethodSelect.value;
  let _currentProvider = (_initDropVal === 'none')
    ? (storage.getSetting('webdavProvider') || 'jianguoyun')
    : _initDropVal;
  const _draftCache = new Map();
  let _lastSyncSelect = syncMethodSelect.value;
  let _initialPassValue = '';
  let _initialPassCaptured = false;

  function _stashWebdavDraft() {
    if (!_currentProvider || _currentProvider === 'none') return;
    _draftCache.set(_currentProvider, {
      url: urlInput.value,
      user: userInput.value,
      pass: passInput.value,
    });
  }

  // 网页宿主 + 坚果云 → 显示"坚果云拦截公共代理"警示（实测 Cloudflare Workers 出口被 IP 级屏蔽）
  const _webWarn = body.querySelector('#webdav-web-warning');
  function _toggleWebWarn(provider) {
    if (_webWarn) _webWarn.style.display = (provider === 'jianguoyun') ? '' : 'none';
  }
  _toggleWebWarn(_currentProvider);

  async function _switchWebdavProvider(provider) {
    if (_currentProvider !== provider) _stashWebdavDraft();
    _currentProvider = provider;
    const def = providerDefaults[provider] || providerDefaults.custom;
    urlInput.placeholder = def.placeholder || '';
    helpText.innerHTML = def.help;
    webdavStatus.innerHTML = '';
    _toggleWebWarn(provider);

    if (_draftCache.has(provider)) {
      const d = _draftCache.get(provider);
      urlInput.value = d.url || def.url;
      userInput.value = d.user || '';
      passInput.value = d.pass || '';
      return;
    }

    const pk = 'webdav_' + provider + '_';
    const savedUrl = storage.getSetting(pk + 'url');
    const savedUser = storage.getSetting(pk + 'user');
    const savedEncPass = storage.getSetting(pk + 'pass');

    if (savedUrl || savedUser || savedEncPass) {
      urlInput.value = savedUrl || def.url;
      userInput.value = savedUser || '';
      let decPass = '';
      if (savedEncPass && window.webdavSync) {
        try { decPass = await window.webdavSync.aesDecrypt(savedEncPass); } catch (_) {}
      }
      if (_currentProvider !== provider) return;
      passInput.value = decPass;
      return;
    }

    if (_currentProvider !== provider) return;
    urlInput.value = def.url;
    userInput.value = '';
    passInput.value = '';
  }

  function _updateSyncPanels() {
    const v = syncMethodSelect.value;
    const wasWebdav = _lastSyncSelect !== 'none';
    if (v === 'none') {
      if (wasWebdav) _stashWebdavDraft();
      panelWebdav.classList.add('settings-tab-hidden');
    } else {
      panelWebdav.classList.remove('settings-tab-hidden');
      _switchWebdavProvider(v).then(() => {
        if (!_initialPassCaptured) {
          _initialPassValue = passInput.value;
          _initialPassCaptured = true;
        }
      });
    }
    _lastSyncSelect = v;
  }
  syncMethodSelect.addEventListener('change', _updateSyncPanels);
  _updateSyncPanels();

  // 是否改动了同步设置但还没保存（服务商或地址/账号变了）。
  // 「立即同步 / 管理云端笔记」作用于已保存的配置，未保存时操作会指向旧服务商，需先拦截避免误解。
  function _hasUnsavedSyncChange() {
    const savedMethod = storage.getSetting('syncMethod') || 'none';
    const savedProvider = savedMethod === 'webdav' ? (storage.getSetting('webdavProvider') || 'none') : 'none';
    const sel = syncMethodSelect.value;
    if (sel !== savedProvider) return true;
    if (sel !== 'none') {
      const pk = 'webdav_' + sel + '_';
      if (urlInput.value.trim() !== (storage.getSetting(pk + 'url') || '')) return true;
      if (userInput.value.trim() !== (storage.getSetting(pk + 'user') || '')) return true;
    }
    return false;
  }

  // 密码/口令可见性切换（共用一套眼睛逻辑）
  const _bindEye = (eyeId, inputId) => {
    body.querySelector(eyeId)?.addEventListener('click', () => {
      const inp = body.querySelector(inputId);
      const isHidden = inp.type === 'password';
      inp.type = isHidden ? 'text' : 'password';
      const btn = body.querySelector(eyeId);
      btn.innerHTML = isHidden
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    });
  };
  _bindEye('#set-webdav-pass-eye', '#set-webdav-pass');
  _bindEye('#set-webdav-crypto-eye', '#set-webdav-crypto-pass');

  // 读取代理 UI 的存储语义值：'' = 内置默认代理；'direct' = 直连；其余 = 自定义地址
  function _readProxySetting() {
    const mode = body.querySelector('#set-webdav-proxy-mode')?.value || 'default';
    if (mode === 'direct') return 'direct';
    if (mode === 'custom') return (body.querySelector('#set-webdav-proxy')?.value || '').trim().replace(/\/+$/, '');
    return '';
  }
  // 代理模式切换：仅"自定义"显示地址输入框
  const _proxyModeSel = body.querySelector('#set-webdav-proxy-mode');
  _proxyModeSel?.addEventListener('change', () => {
    const inp = body.querySelector('#set-webdav-proxy');
    if (inp) inp.style.display = _proxyModeSel.value === 'custom' ? '' : 'none';
  });

  // 复制自建代理 Worker 代码（仅网页宿主渲染此按钮；与 docs/webdav-proxy-worker.js 保持同步）
  body.querySelector('#set-webdav-proxy-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(WEBDAV_PROXY_WORKER_CODE);
      toast('已复制，粘贴进 Cloudflare Worker 编辑器并部署即可', 'success');
    } catch (_) {
      toast('复制失败，请重试', 'error');
    }
  });

  // 测试连接
  body.querySelector('#set-webdav-test').addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const user = body.querySelector('#set-webdav-user').value.trim();
    const pass = body.querySelector('#set-webdav-pass').value;
    if (!url || !user || !pass) { webdavStatus.innerHTML = '<span style="color:var(--danger)">请填写所有字段</span>'; return; }
    const provider = syncMethodSelect.value;
    const urlMismatch = {
      jianguoyun: url.includes('jianguoyun.com') ? '' : '坚果云地址应包含 jianguoyun.com',
      koofr: url.includes('koofr.net') ? '' : 'Koofr 地址应包含 koofr.net',
      infinicloud: url.includes('teracloud.jp') ? '' : 'InfiniCLOUD 地址应包含 teracloud.jp',
    }[provider] || '';
    if (urlMismatch) { webdavStatus.innerHTML = `<span style="color:var(--warning)">⚠ ${urlMismatch}，请检查</span>`; return; }
    webdavStatus.innerHTML = '<span style="color:var(--text-tertiary)">⏳ 测试中…</span>';
    const proxy = window.webdavSync.resolveProxy(_readProxySetting());
    // 经代理时先单测代理可达性（no-cors 只验网络通断），失败能直接定位是代理/网络问题而非网盘问题
    let proxyOk = !proxy;
    if (proxy) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        await fetch(proxy + '/', { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
        clearTimeout(timer);
        proxyOk = true;
      } catch (_) {
        webdavStatus.innerHTML = `<span style="color:var(--danger)">代理不可达（${escapeHtml(proxy)}），请检查网络或更换代理</span>`;
        return;
      }
    }
    const result = await window.webdavSync.testConnection({ url, user, pass, provider, proxy });
    if (result.ok) {
      webdavStatus.innerHTML = '<span style="color:var(--success)">连接成功 ✓</span>';
    } else {
      const side = (proxy && proxyOk) ? '（代理正常，问题在网盘侧或账号）' : '';
      webdavStatus.innerHTML = `<span style="color:var(--danger)">失败：${escapeHtml(result.error)}${side}</span>`;
    }
  });

  // 立即同步
  body.querySelector('#set-webdav-sync-now')?.addEventListener('click', async () => {
    if (!window.webdavSync) { toast('WebDAV 未配置', 'warning'); return; }
    if (_hasUnsavedSyncChange()) { toast('你改动了同步设置但尚未保存，请先点「保存」再同步', 'warning'); return; }
    const btn = body.querySelector('#set-webdav-sync-now');
    btn.disabled = true;
    btn.textContent = '同步中…';
    try {
      editor.flushSave();
      await window.webdavSync.manualSync();
      toast('同步完成', 'success');
    } catch (e) {
      toast('同步失败：' + _zhSyncError(e?.message || e), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '立即同步';
    }
  });

  // 修复云端清单（与右上角云同步菜单同一流程；放设置页里更容易被发现）
  body.querySelector('#set-webdav-repair')?.addEventListener('click', async () => {
    if (!window.webdavSync) { toast('WebDAV 未配置', 'warning'); return; }
    if (_hasUnsavedSyncChange()) { toast('你改动了同步设置但尚未保存，请先点「保存」再修复', 'warning'); return; }
    const btn = body.querySelector('#set-webdav-repair');
    btn.disabled = true;
    try { await runRepairManifestFlow(); }
    finally { btn.disabled = false; }
  });

  // 管理云端笔记（扫描恢复 + 删除云端 + 用本地覆盖云端，统一在一个弹窗内）
  body.querySelector('#set-webdav-recover')?.addEventListener('click', async () => {
    if (!window.webdavSync) { toast('WebDAV 未配置', 'warning'); return; }
    if (_hasUnsavedSyncChange()) { toast('你改动了同步设置但尚未保存，请先点「保存」再管理云端', 'warning'); return; }
    const btn = body.querySelector('#set-webdav-recover');
    btn.disabled = true;
    btn.textContent = '扫描中…';
    // 先弹出窗口（带转圈），再后台扫描，扫描完再填充内容
    const scanning = openCloudScanning();
    try {
      // 不再扫描前 await enrichCloudManifest：它会占 _syncing 锁 + 额外 GET/PUT/读回校验，
      // 经代理时动辄十几秒，且与 scan 读 manifest 重复。清单补全改到面板打开后后台跑。
      scanning.setText('正在扫描云端笔记列表…');
      const res = await window.webdavSync.scanCloudNotes();
      if (!res.ok) {
        const err = res.error || '';
        const hint = /aborted|timeout|timed out/i.test(err) ? '（连接超时，请检查网络或代理域名是否已绑定）' : '';
        scanning.setError('扫描失败：' + err + hint);
        return;
      }
      openRecoverDialog(res.found, (n) => {
        webdavStatus.innerHTML = n > 0
          ? `<span style="color:var(--success)">已恢复 ${n} 篇笔记 ✓</span>`
          : '';
      }, {
        instant: true,
        summary: res.summary,
        all: res.all,
        onMirrorDone: (res) => {
          if (res && res.ok) {
            const tip = res.removed ? `清理云端 ${res.removed} 篇，` : '云端无多余，';
            webdavStatus.innerHTML = `<span style="color:var(--success)">完成：${tip}已上传本地全部 ✓</span>`;
          } else {
            webdavStatus.innerHTML = `<span style="color:var(--danger)">失败：${escapeHtml((res && res.error) || '')}</span>`;
          }
        },
      });
      // 面板已打开后再后台补 manifest 标题（不阻塞扫描结果展示）
      if (window.webdavSync.enrichCloudManifest) {
        window.webdavSync.enrichCloudManifest().catch(() => {});
      }
      // 管理弹窗已盖在扫描框上方，瞬间移除扫描框（无淡出）→ 内容原地替换，无闪烁
      scanning.close(true);
    } catch (e) {
      scanning.setError('扫描失败：' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = '管理云端笔记';
    }
  });

  // ========== 定时本地备份（标签页内配置）==========
  const bkEnabled = body.querySelector('#set-backup-enabled');
  const bkDir = body.querySelector('#set-backup-dir');
  const bkInterval = body.querySelector('#set-backup-interval');
  const bkKeep = body.querySelector('#set-backup-keep');
  const bkStatus = body.querySelector('#backup-status');
  if (bkEnabled && bkDir && bkInterval && bkKeep) {
    const cfg0 = _backupGet();
    bkEnabled.value = cfg0.enabled ? '1' : '0';
    bkDir.value = cfg0.dir;
    bkInterval.value = String(cfg0.interval);
    bkKeep.value = String(cfg0.keep);
    const bkDetail = body.querySelector('#backup-detail');
    const renderBkDetail = () => { if (bkDetail) bkDetail.style.display = bkEnabled.value === '1' ? '' : 'none'; };
    renderBkDetail();
    const renderBkStatus = () => {
      const c = _backupGet();
      if (!c.enabled) { bkStatus.textContent = ''; return; }
      const last = c.last ? new Date(c.last).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未备份';
      bkStatus.textContent = `每 ${c.interval} 分钟备份一次，保留 ${c.keep} 份。上次：${last}`;
    };
    renderBkStatus();
    // 配置改动即时保存到本地并重启调度器（本地备份配置按设备存，不入云同步）
    bkEnabled.addEventListener('change', () => { _backupSet({ enabled: bkEnabled.value === '1' }); startBackupScheduler(); renderBkStatus(); renderBkDetail(); });
    bkDir.addEventListener('change', () => { _backupSet({ dir: bkDir.value.trim() }); renderBkStatus(); });
    bkInterval.addEventListener('change', () => {
      let v = parseInt(bkInterval.value, 10); if (!Number.isFinite(v) || v < 1) v = 30;
      bkInterval.value = String(v); _backupSet({ interval: v }); startBackupScheduler(); renderBkStatus();
    });
    bkKeep.addEventListener('change', () => {
      let v = parseInt(bkKeep.value, 10); if (!Number.isFinite(v) || v < 1) v = 20;
      bkKeep.value = String(v); _backupSet({ keep: v }); renderBkStatus();
    });
    body.querySelector('#set-backup-browse')?.addEventListener('click', async () => {
      if (!window.host.caps.file) { toast('选择文件夹需要在 Quicker 环境中运行', 'warning'); return; }
      try {
        const r = await window.host.file.op({ mode: 'pickFolder' });
        const picked = (r && r.result || '').trim();
        if (picked) { bkDir.value = picked; _backupSet({ dir: picked }); renderBkStatus(); }
      } catch (e) { toast('选择文件夹失败：' + (e?.message || e), 'error'); }
    });
    body.querySelector('#set-backup-now')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; const old = btn.textContent; btn.textContent = '备份中…';
      try { await _runLocalBackup({ manual: true }); renderBkStatus(); }
      finally { btn.disabled = false; btn.textContent = old; }
    });
    body.querySelector('#set-backup-open')?.addEventListener('click', async () => {
      const dir = bkDir.value.trim();
      if (!dir) { toast('请先填写备份目录', 'warning'); return; }
      if (!window.host.caps.file) { toast('打开文件夹需要在 Quicker 环境中运行', 'warning'); return; }
      try { await window.host.file.op({ mode: 'open', path: dir }); }
      catch (e) { toast('打开失败：' + (e?.message || e), 'error'); }
    });

    // 图片文件夹（阶段A 图片外置；仅 Quicker file 后端就绪后显示）
    {
      const block = body.querySelector('#images-dir-block');
      const dirInput = body.querySelector('#set-images-dir');
      const refreshImgDir = () => {
        const info = storage.getImagesBackendInfo?.();
        if (info && info.backend === 'file' && block) {
          block.style.display = '';
          if (dirInput) dirInput.value = info.dir || '';
        }
      };
      refreshImgDir();
      storage.imagesReady?.().then(refreshImgDir);
      body.querySelector('#set-images-browse')?.addEventListener('click', async (e) => {
        try {
          const r = await window.host.file.op({ mode: 'pickFolder' });
          const picked = ((r && r.result) || '').trim();
          if (!picked) return;
          const btn = e.currentTarget; btn.disabled = true; const old = btn.textContent; btn.textContent = '迁移中…';
          try {
            const moved = await storage.setImagesDir(picked);
            refreshImgDir();
            toast(moved ? '图片文件夹已迁移' : '目录未变化', moved ? 'success' : 'info');
          } finally { btn.disabled = false; btn.textContent = old; }
        } catch (err) { toast('更改图片文件夹失败：' + (err?.message || err), 'error'); }
      });
      body.querySelector('#set-images-open')?.addEventListener('click', async () => {
        const dir = (dirInput?.value || '').trim();
        if (!dir) return;
        try { await window.host.file.op({ mode: 'open', path: dir }); }
        catch (err) { toast('打开失败：' + (err?.message || err), 'error'); }
      });
    }
  }

  // 主题胶囊点击 — 立即预览（名字就在胶囊里，无需另行更新）
  body.querySelectorAll('.theme-grid-item').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.theme-grid-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const id = btn.dataset.theme;
      applyTheme(id);
      if (editor.setTheme) editor.setTheme(id);
    });
  });

  // 行间距下拉 — 立即预览
  const lineHeightSel = body.querySelector('#set-line-height');
  if (lineHeightSel) {
    lineHeightSel.addEventListener('change', () => {
      const lh = parseFloat(lineHeightSel.value) || 1.5;
      document.documentElement.style.setProperty('--editor-line-height', String(lh));
      const px = parseInt(storage.getSetting('fontSize') || 14, 10);
      applyEditorFontSize(px, lh);
    });
  }

  // 页边距下拉 — 立即预览
  const padSel = body.querySelector('#set-editor-pad');
  if (padSel) {
    padSel.addEventListener('change', () => {
      applyEditorPadding(parseFloat(padSel.value) || 1);
    });
  }

  // 字号输入 — 立即预览
  const sizeInput = body.querySelector('#set-size');
  if (sizeInput) {
    sizeInput.addEventListener('input', () => {
      const v = parseInt(sizeInput.value) || 14;
      document.documentElement.style.setProperty('--editor-font-size', v + 'px');
      const lh = parseFloat(body.querySelector('#set-line-height')?.value) || 1.5;
      applyEditorFontSize(v, lh);
    });
  }

  // 字体刷新按钮：重新扫描本机已安装字体并重建下拉
  const btnFontRefresh = body.querySelector('#set-font-refresh');
  if (btnFontRefresh) {
    btnFontRefresh.addEventListener('click', () => {
      const original = btnFontRefresh.textContent;
      btnFontRefresh.disabled = true;
      btnFontRefresh.textContent = '⏳';
      setTimeout(() => {
        try {
          const list = refreshDetectedSystemFonts();
          const sel = body.querySelector('#set-font');
          if (sel) {
            // 删除非预设的 option（预设字体数量固定）
            const presetCount = CONTENT_FONTS.length;
            while (sel.options.length > presetCount) sel.options[sel.options.length - 1].remove();
            if (list.length) {
              const cur = storage.getSetting('fontFamily') || '';
              list.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.name;
                opt.textContent = f.name;
                if (cur === f.name) opt.selected = true;
                sel.appendChild(opt);
              });
            }
          }
          toast(`扫描到 ${list.length} 款本机字体`, 'success');
        } catch (e) { toast('字体扫描失败：' + e.message, 'error'); }
        finally { btnFontRefresh.disabled = false; btnFontRefresh.textContent = original; }
      }, 30);
    });
  }

  setTimeout(() => {
    const fontSel = body.querySelector('#set-font');
    if (fontSel) fontSel.value = (storage.getSetting('fontFamily') || localStorage.getItem('zhinote-font') || '');
    body.querySelectorAll('select').forEach(s => upgradeSelect(s));
  }, 0);
}

/** 把一个原生 <select> 升级为自定义下拉。
 *  - 原生 select 仍保留（隐藏，作为数据载体），onchange 事件保持一致
 *  - 自定义触发器显示当前选中项 + chevron
 *  - 点击触发器弹自定义面板，带 fade + slight slide 动画
 *  - 支持 <optgroup> 分组、键盘 ↑↓ Enter Esc */
function upgradeSelect(select) {
  if (!select || select._upgraded) return;
  select._upgraded = true;

  // 收集 options（含分组）
  const groups = [];
  const flat = [];
  Array.from(select.children).forEach(child => {
    if (child.tagName === 'OPTGROUP') {
      const opts = Array.from(child.children).map(o => ({
        value: o.value, label: o.textContent.trim(), disabled: o.disabled, title: o.title || '',
      }));
      groups.push({ label: child.label, options: opts });
      flat.push(...opts);
    } else if (child.tagName === 'OPTION') {
      const opt = { value: child.value, label: child.textContent.trim(), disabled: child.disabled, title: child.title || '' };
      groups.push({ label: '', options: [opt] });
      flat.push(opt);
    }
  });

  // 包裹器：把 select 隐藏在内，外面套 trigger
  const wrap = document.createElement('div');
  wrap.className = 'md-select';
  // 保留原 select 的 width 行为（默认占满父容器）
  select.parentNode.insertBefore(wrap, select);
  // 把原 select 移进 wrap，但隐藏。它仍然持有 value 状态
  select.style.display = 'none';
  wrap.appendChild(select);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'md-select-trigger';
  trigger.innerHTML = `
    <span class="md-select-label"></span>
    <svg class="md-select-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  `;
  wrap.appendChild(trigger);

  const labelEl = trigger.querySelector('.md-select-label');
  const sync = () => {
    const cur = flat.find(o => o.value === select.value);
    labelEl.textContent = cur?.label || flat[0]?.label || '';
  };
  sync();

  let panel = null;

  function close() {
    if (!panel) return;
    panel.classList.remove('is-open');
    setTimeout(() => { panel?.remove(); panel = null; }, 140);
    trigger.classList.remove('is-open');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onDoc(e) {
    if (panel && !panel.contains(e.target) && !trigger.contains(e.target)) close();
  }
  function onKey(e) {
    if (!panel) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const items = Array.from(panel.querySelectorAll('.md-select-item:not(.is-disabled)'));
    const cur = panel.querySelector('.md-select-item.is-active');
    let idx = items.indexOf(cur);
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); cur?.click(); return; }
    else return;
    items.forEach(it => it.classList.remove('is-active'));
    items[idx]?.classList.add('is-active');
    items[idx]?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (panel) { close(); return; }
    panel = document.createElement('div');
    panel.className = 'md-select-panel';
    panel.innerHTML = groups.map(g => {
      const head = g.label ? `<div class="md-select-group">${escapeHtml(g.label)}</div>` : '';
      return head + g.options.map(o =>
        `<div class="md-select-item${o.value === select.value ? ' is-active' : ''}${o.disabled ? ' is-disabled' : ''}" data-value="${escapeHtml(o.value)}"${o.title ? ` title="${escapeHtml(o.title)}"` : ''}>
          <span class="md-select-item-label">${escapeHtml(o.label)}</span>
          ${o.value === select.value ? '<span class="md-select-item-check">✓</span>' : ''}
        </div>`
      ).join('');
    }).join('');
    document.body.appendChild(panel);

    // 定位：触发器正下方，超出底则改向上
    const r = trigger.getBoundingClientRect();
    panel.style.left = `${r.left}px`;
    panel.style.minWidth = `${r.width}px`;
    panel.style.maxWidth = `${Math.max(r.width, 280)}px`;
    panel.style.top = `${r.bottom + 4}px`;
    const ph = panel.offsetHeight;
    if (r.bottom + 4 + ph > window.innerHeight - 12) {
      panel.style.top = `${r.top - ph - 4}px`;
    }
    // 边界
    const pw = panel.offsetWidth;
    if (r.left + pw > window.innerWidth - 8) {
      panel.style.left = `${Math.max(8, window.innerWidth - pw - 8)}px`;
    }
    requestAnimationFrame(() => panel?.classList.add('is-open'));
    trigger.classList.add('is-open');

    // 事件
    panel.addEventListener('click', (e) => {
      const item = e.target.closest('.md-select-item');
      if (!item || item.classList.contains('is-disabled')) return;
      const v = item.dataset.value;
      if (v !== select.value) {
        select.value = v;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
      }
      close();
    });
    setTimeout(() => {
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
      // 滚动到当前项
      const cur = panel.querySelector('.md-select-item.is-active');
      cur?.scrollIntoView({ block: 'nearest' });
    }, 0);
  }

  trigger.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(); });
  // 当其它代码改了 select.value，同步触发器显示
  select.addEventListener('change', sync);
}
window.upgradeSelect = upgradeSelect;

// ========== 通用 UI 辅助 ==========

let _modalOnClose = null;
let _modalClosing = false;
const OVERLAY_MS = 180;

function openModal({ title, body, footer, onClose, dialogClass }) {
  const overlay = document.getElementById('modal-overlay');
  const dialog = document.getElementById('modal-dialog');
  const titleEl = document.getElementById('modal-title');
  const bodyEl = document.getElementById('modal-body');
  const footEl = document.getElementById('modal-footer');
  _modalClosing = false;
  // 每次打开都重置弹窗自定义类（不影响 id 选择器的基础样式）
  if (dialog) dialog.className = dialogClass || '';
  titleEl.textContent = title || '';
  bodyEl.innerHTML = '';
  if (body instanceof Node) bodyEl.appendChild(body);
  else bodyEl.innerHTML = body || '';
  footEl.innerHTML = '';
  (footer || []).forEach(b => {
    const btn = document.createElement('button');
    btn.className = b.class || 'secondary-btn';
    btn.textContent = b.label;
    btn.addEventListener('click', b.onClick || (() => {}));
    footEl.appendChild(btn);
  });
  _modalOnClose = onClose || null;
  overlay.classList.remove('hidden', 'is-closing');
  dialog?.classList.remove('is-closing');
  overlay.addEventListener('click', onOverlayClick);
}

function onOverlayClick(e) {
  // 不再通过点击遮罩关闭设置面板，防止误触丢失输入
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  const dialog = document.getElementById('modal-dialog');
  if (!overlay || overlay.classList.contains('hidden') || _modalClosing) return;
  _modalClosing = true;
  overlay.classList.add('is-closing');
  dialog?.classList.add('is-closing');
  overlay.removeEventListener('click', onOverlayClick);
  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('is-closing');
    dialog?.classList.remove('is-closing');
    _modalClosing = false;
    if (typeof _modalOnClose === 'function') {
      const cb = _modalOnClose; _modalOnClose = null;
      try { cb(); } catch (_) {}
    }
  }, OVERLAY_MS);
}

window.openModal = openModal;
window.closeModal = closeModal;

/** 云端有冲突更新 → 弹统一 modal（仅在本地有未上传改动时调用） */
/** 显示 toast。
 *  支持 opts.id：指定相同 id 的会替换旧的（避免高频操作如调字号时 toast 堆叠）
 */
function toast(text, level = 'success', durationOrOpts = 2200) {
  const opts = typeof durationOrOpts === 'object' ? durationOrOpts : { duration: durationOrOpts };
  const duration = opts.duration ?? 2200;
  const id = opts.id;
  const c = document.getElementById('toast-container');

  // duration <= 0 视为"常驻"：不自动消失，需点击关闭（用于冲突/失败等重要提示，避免一闪而过看不清）
  const sticky = !(duration > 0);
  const _dismiss = (el) => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.2s';
    el._removeTimer = setTimeout(() => el.remove(), 200);
  };
  const _arm = (el) => {
    if (el._hideTimer) clearTimeout(el._hideTimer);
    if (el._removeTimer) clearTimeout(el._removeTimer);
    el.style.opacity = '';
    el.style.transition = '';
    if (!sticky) el._hideTimer = setTimeout(() => _dismiss(el), duration);
  };

  // 如果已有同 id 的 toast，复用它（覆盖文本 + 重置消失计时器），不要新加一条
  if (id) {
    const existing = c.querySelector(`.toast[data-toast-id="${id}"]`);
    if (existing) {
      existing.textContent = text + (sticky ? '　（点击关闭）' : '');
      existing.className = 'toast ' + level + (sticky ? ' toast-sticky' : '');
      existing.dataset.toastId = id;
      _arm(existing);
      return existing;
    }
  }

  const el = document.createElement('div');
  el.className = 'toast ' + level + (sticky ? ' toast-sticky' : '');
  el.textContent = text + (sticky ? '　（点击关闭）' : '');
  if (id) el.dataset.toastId = id;
  // 所有 toast 都支持点击立即关闭
  el.style.cursor = 'pointer';
  el.addEventListener('click', () => _dismiss(el));
  c.appendChild(el);
  _arm(el);
  return el;
}
window.toast = toast;

// ============================================================
// 工具栏功能（浮动格式条 + 右键菜单）
// ============================================================

// Floating toolbar removed — Tiptap BubbleMenu handles this natively
// ============================================================
// 编辑区右键菜单（替代 WebView2 默认右键菜单）
// ============================================================

/** 解析 FileOp openDialog 返回（JSON: {name, content} 或数组） */
function parseFileOpBinaryResult(spResult) {
  const raw = spResult?.result || '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (_) {
    return { name: spResult?.fileName || 'image.png', content: raw };
  }
}

function mimeFromFileName(name) {
  const ext = (name || '').split('.').pop()?.toLowerCase() || 'png';
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' };
  return mimeMap[ext] || 'image/png';
}

function fileReadContentToDataUrl(fileData, fallbackName) {
  const name = fileData?.name || fallbackName || 'image.png';
  let content = fileData?.content || '';
  if (!content) return null;
  if (content.startsWith('data:')) return content;
  return `data:${mimeFromFileName(name)};base64,${content}`;
}

/** 从文件选择器插入图片 — 优先用 Quicker SP, 否则 input[type=file] */
async function insertImageFromPicker() {
  if (!editor.instance?.()) return;

  if (storage.isQuicker()) {
    try {
      const spResult = await window.host.file.op({ mode: 'openDialog',
        filter: '图片文件|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.svg', isBinary: 'true', multiSelect: 'false'
      });
      const fileData = parseFileOpBinaryResult(spResult);
      if (!fileData) return;
      const dataUrl = fileReadContentToDataUrl(fileData, spResult?.fileName);
      if (!dataUrl) return;
      const alt = (fileData.name || '').replace(/\.[^.]+$/, '') || 'image';
      editor.insertImageFromDataUrl?.(dataUrl, alt);
    } catch (e) { toast('插入图片失败：' + (e.message || e), 'error'); }
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const alt = file.name?.replace(/\.[^.]+$/, '') || 'image';
        editor.insertImageFromDataUrl?.(reader.result, alt);
      };
      reader.readAsDataURL(file);
    });
    input.click();
  }
}

/** 公式符号面板（分 tab，参考常见 LaTeX 面板，非一比一复刻） */
const MATH_SYMBOL_TABS = [
  {
    id: 'basic', label: '基础',
    items: [
      { t: 'x²', v: 'x^{2}' }, { t: 'xⁿ', v: 'x^{n}' }, { t: 'xₙ', v: 'x_{n}' },
      { t: 'a/b', v: '\\frac{a}{b}' }, { t: '√', v: '\\sqrt{x}' }, { t: 'ⁿ√', v: '\\sqrt[n]{x}' },
      { t: '∑', v: '\\sum_{i=1}^{n}' }, { t: '∏', v: '\\prod_{i=1}^{n}' }, { t: '∞', v: '\\infty' },
    ],
  },
  {
    id: 'ops', label: '运算符',
    items: [
      { t: '±', v: '\\pm' }, { t: '×', v: '\\times' }, { t: '÷', v: '\\div' },
      { t: '≤', v: '\\leq' }, { t: '≥', v: '\\geq' }, { t: '≠', v: '\\neq' },
      { t: '≈', v: '\\approx' }, { t: '∫', v: '\\int_{a}^{b}' }, { t: '∂', v: '\\partial' },
      { t: '→', v: '\\rightarrow' }, { t: '←', v: '\\leftarrow' }, { t: '⇔', v: '\\Leftrightarrow' },
    ],
  },
  {
    id: 'brackets', label: '括号',
    items: [
      { t: '()', v: '\\left( \\right)' }, { t: '[]', v: '\\left[ \\right]' },
      { t: '{}', v: '\\left\\{ \\right\\}' }, { t: '||', v: '\\left| \\right|' },
      { t: '⌊⌋', v: '\\left\\lfloor x \\right\\rfloor' }, { t: '⌈⌉', v: '\\left\\lceil x \\right\\rceil' },
    ],
  },
  {
    id: 'greek', label: '希腊字母',
    items: [
      { t: 'α', v: '\\alpha' }, { t: 'β', v: '\\beta' }, { t: 'γ', v: '\\gamma' },
      { t: 'δ', v: '\\delta' }, { t: 'ε', v: '\\epsilon' }, { t: 'θ', v: '\\theta' },
      { t: 'λ', v: '\\lambda' }, { t: 'μ', v: '\\mu' }, { t: 'π', v: '\\pi' },
      { t: 'σ', v: '\\sigma' }, { t: 'φ', v: '\\phi' }, { t: 'ω', v: '\\omega' },
      { t: 'Δ', v: '\\Delta' }, { t: 'Σ', v: '\\Sigma' }, { t: 'Ω', v: '\\Omega' },
    ],
  },
  {
    id: 'adv', label: '高级',
    items: [
      { t: '矩阵()', v: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
      { t: '矩阵[]', v: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}' },
      { t: '方程组', v: '\\begin{cases} x+y=1 \\\\ x-y=0 \\end{cases}' },
      { t: '极限', v: '\\lim_{x \\to 0} f(x)' },
      { t: '向量', v: '\\vec{v}' },
      { t: '导数', v: "f'(x)" },
      { t: '二阶导', v: "f''(x)" },
      { t: '微分', v: '\\mathrm{d}x' },
    ],
  },
];

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  textarea.value = val.slice(0, start) + text + val.slice(end);
  const pos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = pos;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
}

/** 插入/编辑公式 — 行内/块级、输入、预览、分 tab 符号面板 */
function insertMathFormula(opts) {
  const inst = editor.instance?.();
  if (!inst) return;

  const editLatex = opts?.latex || '';
  const editDisplay = opts?.display || false;
  const editFrom = opts?.from;
  const editTo = opts?.to;
  const isEdit = editFrom != null && editTo != null;

  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const body = document.createElement('div');
  body.className = 'math-form-body';
  const tabBtns = MATH_SYMBOL_TABS.map((t, i) =>
    `<button type="button" class="math-tab${i === 0 ? ' active' : ''}" data-tab="${esc(t.id)}">${esc(t.label)}</button>`
  ).join('');
  const firstItems = MATH_SYMBOL_TABS[0].items.map(it =>
    `<button type="button" class="math-sym" data-v="${esc(it.v)}" title="${esc(it.v)}">${esc(it.t)}</button>`
  ).join('');

  body.innerHTML = `
    <div class="math-mode-seg" role="tablist">
      <button type="button" class="math-mode-btn active" data-mode="inline">行内公式</button>
      <button type="button" class="math-mode-btn" data-mode="block">块级公式</button>
    </div>
    <textarea id="math-form-input" class="math-form-input" rows="3" placeholder="输入 LaTeX，如 x^2 + y^2 = z^2"></textarea>
    <div id="math-form-preview" class="math-form-preview"><span class="math-form-preview-empty">预览</span></div>
    <div class="math-tabs">${tabBtns}</div>
    <div class="math-sym-grid">${firstItems}</div>
  `;

  const input = body.querySelector('#math-form-input');
  const preview = body.querySelector('#math-form-preview');
  const symGrid = body.querySelector('.math-sym-grid');
  const modeBtns = body.querySelectorAll('.math-mode-btn');
  let mathMode = editDisplay ? 'block' : 'inline';

  if (editDisplay) {
    modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === 'block'));
  }

  if (editLatex) {
    input.value = editLatex;
  }

  const isBlock = () => mathMode === 'block';

  const setMode = (mode) => {
    mathMode = mode;
    modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    updatePreview();
  };
  modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  const bindSymButtons = () => {
    symGrid.querySelectorAll('.math-sym').forEach(btn => {
      btn.addEventListener('click', () => {
        insertTextAtCursor(input, btn.dataset.v || '');
        updatePreview();
      });
    });
  };

  const renderTab = (tabId) => {
    const tab = MATH_SYMBOL_TABS.find(t => t.id === tabId) || MATH_SYMBOL_TABS[0];
    symGrid.innerHTML = tab.items.map(it =>
      `<button type="button" class="math-sym" data-v="${esc(it.v)}" title="${esc(it.v)}">${esc(it.t)}</button>`
    ).join('');
    bindSymButtons();
  };

  body.querySelectorAll('.math-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.math-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTab(btn.dataset.tab);
    });
  });
  bindSymButtons();

  const updatePreview = () => {
    const latex = input.value.trim();
    if (!latex) {
      preview.innerHTML = '<span class="math-form-preview-empty">预览</span>';
      return;
    }
    if (typeof katex !== 'undefined') {
      try {
        katex.render(latex, preview, { displayMode: isBlock(), throwOnError: false, strict: 'ignore' });
        return;
      } catch (_) {}
    }
    preview.textContent = latex;
  };

  input.addEventListener('input', updatePreview);
  updatePreview();

  const doInsert = () => {
    const formula = input.value.trim();
    if (!formula) return;
    closeModal();
    const displayMode = isBlock();
    const nodeType = displayMode ? 'mathBlock' : 'mathInline';
    if (isEdit) {
      inst.chain().focus()
        .command(({ tr }) => {
          const node = inst.state.schema.nodes[nodeType].create({ latex: formula });
          tr.replaceWith(editFrom, editTo, node);
          return true;
        })
        .run();
    } else {
      inst.chain().focus().insertContent({ type: nodeType, attrs: { latex: formula } }).run();
    }
  };

  openModal({
    title: isEdit ? '编辑数学公式' : '插入数学公式',
    body,
    footer: [
      { label: '取消', class: 'secondary-btn', onClick: closeModal },
      { label: isEdit ? '保存' : '插入', class: 'primary-btn', onClick: doInsert },
    ],
  });
  setTimeout(() => input.focus(), 80);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doInsert(); }
  });
}

window.editMathFormula = function(latex, display, from, to) {
  insertMathFormula({ latex, display, from, to });
};

function showTableDialog() {
  document.querySelector('.md-table-dialog')?.remove();
  const inst = editor.instance?.();
  if (!inst) return;

  const dialog = document.createElement('div');
  dialog.className = 'md-table-dialog';
  dialog.innerHTML = `
    <div class="md-table-dialog-inner">
      <div class="md-table-dialog-title">插入表格</div>
      <div class="md-table-dialog-row">
        <label>行数</label>
        <input type="number" id="md-table-rows" value="3" min="2" max="50">
      </div>
      <div class="md-table-dialog-row">
        <label>列数</label>
        <input type="number" id="md-table-cols" value="3" min="1" max="20">
      </div>
      <div class="md-table-dialog-actions">
        <button class="md-table-cancel">取消</button>
        <button class="md-table-confirm">插入</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  const rowsInput = dialog.querySelector('#md-table-rows');
  const colsInput = dialog.querySelector('#md-table-cols');
  rowsInput.focus();
  rowsInput.select();

  let closing = false;
  const close = () => {
    if (closing || !dialog.isConnected) return;
    closing = true;
    dialog.classList.add('is-closing');
    setTimeout(() => dialog.remove(), OVERLAY_MS);
  };
  dialog.querySelector('.md-table-cancel').addEventListener('click', close);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  const doInsert = () => {
    const rows = Math.max(2, Math.min(50, parseInt(rowsInput.value) || 3));
    const cols = Math.max(1, Math.min(20, parseInt(colsInput.value) || 3));
    close();
    editor.execCommand('insertTable', { rows, cols });
  };

  dialog.querySelector('.md-table-confirm').addEventListener('click', doInsert);
  rowsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doInsert(); });
  colsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doInsert(); });
}

let _sidebarWasCollapsed = false;
function toggleFocusMode() {
  const isFocus = document.body.classList.toggle('md-focus-mode');
  if (isFocus) {
    _sidebarWasCollapsed = document.body.classList.contains('sidebar-collapsed');
    document.body.classList.add('sidebar-collapsed');
  } else {
    if (!_sidebarWasCollapsed) {
      document.body.classList.remove('sidebar-collapsed');
    }
  }
  refreshEditorModeBar();
}

function showTableContextMenu(e) {
  document.querySelectorAll('.md-editor-ctx').forEach(m => m.remove());
  window.setBubbleSuppressed?.(true);

  const menu = document.createElement('div');
  menu.className = 'md-editor-ctx';
  const items = [
    { label: '粘贴', action: async () => { try { const t = await navigator.clipboard.readText(); if (t && /\$\$[^$]+?\$\$|\$[^$\n]+?\$/.test(t)) { const inst = editor.instance?.(); if (inst) { const processed = t.replace(/\$\$([^$]+?)\$\$/gs, (_,l) => `<div data-math-block data-latex="${l.trim().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}"></div>`).replace(/(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g, (_,l) => `<span data-math-inline data-latex="${l.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}"></span>`); inst.commands.insertContent(processed, { parseOptions: { preserveWhitespace: false } }); return; } } if (t) editor.insertAtCursor(t); } catch(_) { document.execCommand('paste'); } } },
    { sep: true },
    { label: '上方插入行', action: () => editor.execCommand('addRowBefore') },
    { label: '下方插入行', action: () => editor.execCommand('addRowAfter') },
    { label: '左侧插入列', action: () => editor.execCommand('addColumnBefore') },
    { label: '右侧插入列', action: () => editor.execCommand('addColumnAfter') },
    { sep: true },
    { label: '合并单元格', action: () => editor.execCommand('mergeCells') },
    { label: '拆分单元格', action: () => editor.execCommand('splitCell') },
    { sep: true },
    { label: '首行表头', action: () => editor.execCommand('toggleHeaderRow') },
    { label: '首列表头', action: () => editor.execCommand('toggleHeaderColumn') },
    { sep: true },
    { label: '删除当前行', action: () => editor.execCommand('deleteRow') },
    { label: '删除当前列', action: () => editor.execCommand('deleteColumn') },
    { label: '删除整个表格', action: () => editor.execCommand('deleteTable') },
  ];
  for (const item of items) {
    if (item.sep) { const hr = document.createElement('div'); hr.className = 'md-ctx-sep'; menu.appendChild(hr); continue; }
    const row = document.createElement('div');
    row.className = 'md-ctx-item';
    row.textContent = item.label;
    row.addEventListener('click', () => { menu.remove(); cleanup(); item.action(); });
    menu.appendChild(row);
  }
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.addEventListener('mousedown', (ev) => ev.preventDefault());
  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth - 8) menu.style.left = Math.max(8, e.clientX - mr.width) + 'px';
    if (mr.bottom > window.innerHeight - 8) menu.style.top = Math.max(8, e.clientY - mr.height) + 'px';
  });
  let dismiss;
  let dismissKey;
  const cleanup = () => {
    document.removeEventListener('mousedown', dismiss, true);
    document.removeEventListener('keydown', dismissKey, true);
    window.setBubbleSuppressed?.(false);
  };
  dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); cleanup(); } };
  dismissKey = (ev) => { if (ev.key === 'Escape') { menu.remove(); cleanup(); } };
  setTimeout(() => { document.addEventListener('mousedown', dismiss, true); document.addEventListener('keydown', dismissKey, true); }, 0);
}


function initEditorContextMenu() {
  const handleCtx = async (e) => {
    const editable = document.querySelector('#editor .ProseMirror');
    if (!editable || !editable.contains(e.target)) return;

    // 触屏端：真实长按（isTrusted，安卓长按文字会原生触发 contextmenu）让位给系统选字——
    // 长按=选词+拖手柄是所有移动端的肌肉记忆，被自定义菜单劫持后文字几乎没法选（曾被反馈）。
    // 自定义右键菜单专走双指轻点（合成事件 isTrusted=false）；图片例外（原生菜单只有"下载图片"，没用）。
    if (e.isTrusted && window.matchMedia('(pointer: coarse)').matches && !e.target.closest('img')) return;

    const imgHit = e.target.closest('img');
    if (imgHit && editable.contains(imgHit)) {
      e.preventDefault();
      e.stopPropagation();
      editor.showImageContextMenu(e, imgHit);
      return;
    }

    const td = e.target.closest('td, th');
    if (td && td.closest('table')) {
      e.preventDefault();
      e.stopPropagation();
      showTableContextMenu(e);
      return;
    }

    e.preventDefault();
    document.querySelectorAll('.md-editor-ctx').forEach(m => m.remove());
    window.setBubbleSuppressed?.(true);

    const menu = document.createElement('div');
    menu.className = 'md-editor-ctx';
    // 触屏端没有 hover：子菜单改为行内折叠展开（点父项展开/收起），不再侧边飞出（曾飞出屏幕外看不到）
    const _touchMode = window.matchMedia('(pointer: coarse)').matches;

    const _copyAction = () => {
      const inst = editor.instance?.();
      if (!inst) return;
      const { from, to } = inst.state.selection;
      if (from === to) {
        try {
          const md = inst.getMarkdown?.() || '';
          navigator.clipboard?.writeText(md);
        } catch (_) { document.execCommand('copy'); }
        return;
      }
      let text = '';
      inst.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === 'mathInline') {
          text += `$${node.attrs.latex}$`;
          return false;
        }
        if (node.type.name === 'mathBlock') {
          text += `$$${node.attrs.latex}$$\n`;
          return false;
        }
        if (node.isText) {
          const start = Math.max(from, pos) - pos;
          const end = Math.min(to, pos + node.nodeSize) - pos;
          text += (node.text || '').slice(start, end);
        }
        if (node.type.name === 'paragraph' || node.type.name === 'heading') {
          if (pos > from) text += '\n';
        }
        if (node.type.name === 'hardBreak') text += '\n';
      });
      try { navigator.clipboard?.writeText(text); } catch (_) { document.execCommand('copy'); }
    };
    const _pasteAction = async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (t && /\$\$[^$]+?\$\$|\$[^$\n]+?\$/.test(t)) {
          const inst = editor.instance?.();
          if (inst) {
            const processed = t.replace(/\$\$([^$]+?)\$\$/gs, (_, latex) => `<div data-math-block data-latex="${latex.trim().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}"></div>`)
              .replace(/(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)/g, (_, latex) => `<span data-math-inline data-latex="${latex.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}"></span>`);
            inst.commands.insertContent(processed, { parseOptions: { preserveWhitespace: false } });
            return;
          }
        }
        if (t) editor.insertAtCursor(t);
      } catch(_) { document.execCommand('paste'); }
    };
    let _hasClip = true;

    const _inCodeBlock = editor.instance?.()?.isActive('codeBlock') || e.target.closest('.code-block-wrapper');
    const _codeWrapper = (() => { let w = e.target.closest('.code-block-wrapper'); if (w) return w; const inst = editor.instance(); if (!inst) return null; const { $from } = inst.state.selection; for (let d = $from.depth; d >= 0; d--) { if ($from.node(d).type.name === 'codeBlock') { const dom = inst.view.nodeDOM($from.before(d)); return dom?.closest?.('.code-block-wrapper') || dom; } } return null; })();
    const items = [
      ...(_inCodeBlock && _codeWrapper?._toggleFold ? [{ label: _codeWrapper.classList.contains('code-block-folded') ? '展开代码块' : '折叠代码块', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>', action: () => { _codeWrapper._toggleFold(); } }] : []),
      ...(_inCodeBlock && _codeWrapper ? [{ label: '复制全部代码', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>', action: () => { const code = _codeWrapper.querySelector('code'); if (code) navigator.clipboard?.writeText(code.textContent || ''); } }, { label: '删除代码块', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>', action: () => { const inst = editor.instance(); if (!inst) return; const { $from } = inst.state.selection; for (let d = $from.depth; d >= 0; d--) { if ($from.node(d).type.name === 'codeBlock') { const pos = $from.before(d); const node = $from.node(d); inst.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run(); break; } } } }, { sep: true }] : []),
      { label: '复制', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 6V3C7 2.45 7.45 2 8 2H20C20.55 2 21 2.45 21 3V17C21 17.55 20.55 18 20 18H17V21C17 21.55 16.55 22 16 22H4C3.45 22 3 21.55 3 21V7C3 6.45 3.45 6 4 6H7ZM9 6H16C16.55 6 17 6.45 17 7V16H19V4H9V6ZM5 8V20H15V8H5Z"/></svg>', action: _copyAction },
      ...(_hasClip ? [{ label: '粘贴', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4V2H17V4H20C20.55 4 21 4.45 21 5V21C21 21.55 20.55 22 20 22H4C3.45 22 3 21.55 3 21V5C3 4.45 3.45 4 4 4H7ZM7 6H5V20H19V6H17V8H7V6ZM9 4V6H15V4H9Z"/></svg>', action: _pasteAction }, { sep: true }] : [{ sep: true }]),
      { label: '标题', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M13 20H11V13H4V20H2V4H4V11H11V4H13V20ZM21 8V20H19L19 10.2L17 10.74V8.67L19.5 8H21Z"/></svg>', submenu: [
        { label: 'H1 一级标题', action: () => editor.execCommand('toggleHeading', { level: 1 }) },
        { label: 'H2 二级标题', action: () => editor.execCommand('toggleHeading', { level: 2 }) },
        { label: 'H3 三级标题', action: () => editor.execCommand('toggleHeading', { level: 3 }) },
        { label: 'H4 四级标题', action: () => editor.execCommand('toggleHeading', { level: 4 }) },
        { label: 'H5 五级标题', action: () => editor.execCommand('toggleHeading', { level: 5 }) },
        { label: 'H6 六级标题', action: () => editor.execCommand('toggleHeading', { level: 6 }) },
        { label: '正文', action: () => editor.execCommand('setParagraph') },
      ]},
      { label: '对齐', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 4H21V6H3V4ZM3 19H21V21H3V19ZM3 14H15V16H3V14ZM3 9H15V11H3V9Z"/></svg>', submenu: [
        { label: '左对齐', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 4H21V6H3V4ZM3 19H21V21H3V19ZM3 14H15V16H3V14ZM3 9H15V11H3V9Z"/></svg>', action: () => editor.execCommand('setTextAlign', 'left') },
        { label: '居中', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 4H21V6H3V4ZM3 19H21V21H3V19ZM5 14H19V16H5V14ZM5 9H19V11H5V9Z"/></svg>', action: () => editor.execCommand('setTextAlign', 'center') },
        { label: '右对齐', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 4H21V6H3V4ZM3 19H21V21H3V19ZM9 14H21V16H9V14ZM9 9H21V11H9V9Z"/></svg>', action: () => editor.execCommand('setTextAlign', 'right') },
        { label: '两端对齐', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 4H21V6H3V4ZM3 19H21V21H3V19ZM3 14H21V16H3V14ZM3 9H21V11H3V9Z"/></svg>', action: () => editor.execCommand('setTextAlign', 'justify') },
      ]},
      { label: '列表', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 4H21V6H8V4ZM4.5 6.5C3.67 6.5 3 5.83 3 5S3.67 3.5 4.5 3.5 6 4.17 6 5 5.33 6.5 4.5 6.5ZM4.5 13.5C3.67 13.5 3 12.83 3 12S3.67 10.5 4.5 10.5 6 11.17 6 12 5.33 13.5 4.5 13.5ZM4.5 20.4C3.67 20.4 3 19.73 3 18.9S3.67 17.4 4.5 17.4 6 18.07 6 18.9 5.33 20.4 4.5 20.4ZM8 11H21V13H8V11ZM8 18H21V20H8V18Z"/></svg>', submenu: [
        { label: '无序列表', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 4H21V6H8V4ZM4.5 6.5C3.67 6.5 3 5.83 3 5S3.67 3.5 4.5 3.5 6 4.17 6 5 5.33 6.5 4.5 6.5ZM4.5 13.5C3.67 13.5 3 12.83 3 12S3.67 10.5 4.5 10.5 6 11.17 6 12 5.33 13.5 4.5 13.5ZM4.5 20.4C3.67 20.4 3 19.73 3 18.9S3.67 17.4 4.5 17.4 6 18.07 6 18.9 5.33 20.4 4.5 20.4ZM8 11H21V13H8V11ZM8 18H21V20H8V18Z"/></svg>', action: () => editor.execCommand('toggleBulletList') },
        { label: '有序列表', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 4H21V6H8V4ZM5 3V6H6V7H3V6H4V4H3V3H5ZM3 14V11.5H5V11H3V10H6V12.5H4V13H6V14H3ZM5 19.5H3V18.5H5V18H3V17H6V21H3V20H5V19.5ZM8 11H21V13H8V11ZM8 18H21V20H8V18Z"/></svg>', action: () => editor.execCommand('toggleOrderedList') },
        { label: '任务列表', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4 3H20C20.55 3 21 3.45 21 4V20C21 20.55 20.55 21 20 21H4C3.45 21 3 20.55 3 20V4C3 3.45 3.45 3 4 3ZM5 5V19H19V5H5ZM11.003 16.007L6.76 11.76L8.174 10.346L11.003 13.175L16.659 7.519L18.073 8.933L11.003 16.007Z"/></svg>', action: () => editor.execCommand('toggleTaskList') },
      ]},
      { label: '引用 / 代码', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4.58 17.32C3.55 16.23 3 15 3 13.01C3 9.51 5.46 6.37 9.03 4.82L9.92 6.2C6.59 8.01 5.94 10.35 5.68 11.82C6.21 11.54 6.92 11.45 7.6 11.51C9.41 11.68 10.83 13.16 10.83 15C10.83 16.93 9.26 18.5 7.33 18.5C6.26 18.5 5.23 18.01 4.58 17.32ZM14.58 17.32C13.55 16.23 13 15 13 13.01C13 9.51 15.46 6.37 19.03 4.82L19.92 6.2C16.59 8.01 15.94 10.35 15.68 11.82C16.21 11.54 16.92 11.45 17.6 11.51C19.41 11.68 20.83 13.16 20.83 15C20.83 16.93 19.26 18.5 17.33 18.5C16.26 18.5 15.23 18.01 14.58 17.32Z"/></svg>', submenu: [
        { label: '引用', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4.58 17.32C3.55 16.23 3 15 3 13.01 3 9.51 5.46 6.37 9.03 4.82L9.92 6.2C6.59 8.01 5.94 10.35 5.68 11.82 6.21 11.54 6.92 11.45 7.6 11.51 9.41 11.68 10.83 13.16 10.83 15 10.83 16.93 9.26 18.5 7.33 18.5 6.26 18.5 5.23 18.01 4.58 17.32Z"/></svg>', action: () => editor.execCommand('toggleBlockquote') },
        { label: '行内代码', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16.95 8.46L18.36 7.05 23.31 12 18.36 16.95 16.95 15.54 20.49 12 16.95 8.46ZM7.05 8.46L3.51 12 7.05 15.54 5.64 16.95.69 12 5.64 7.05 7.05 8.46Z"/></svg>', action: () => editor.execCommand('toggleCode') },
        { label: '代码块', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 3H21C21.55 3 22 3.45 22 4V20C22 20.55 21.55 21 21 21H3C2.45 21 2 20.55 2 20V4C2 3.45 2.45 3 3 3ZM4 5V19H20V5H4ZM20 12L16.46 15.54 15.05 14.12 17.17 12 15.05 9.88 16.46 8.46 20 12ZM6.83 12L8.95 14.12 7.54 15.54 4 12 7.54 8.46 8.95 9.88 6.83 12Z"/></svg>', action: () => editor.execCommand('toggleCodeBlock') },
      ]},
      { label: '插入', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M11 11V5H13V11H19V13H13V19H11V13H5V11H11Z"/></svg>', submenu: [
        { label: '表格', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M13 10V14H19V10H13ZM11 10H5V14H11V10ZM13 19H19V16H13V19ZM11 19V16H5V19H11ZM13 5V8H19V5H13ZM11 5H5V8H11V5ZM4 3H20C20.55 3 21 3.45 21 4V20C21 20.55 20.55 21 20 21H4C3.45 21 3 20.55 3 20V4C3 3.45 3.45 3 4 3Z"/></svg>', action: () => showTableDialog() },
        { label: '图片', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4.828 21L3 19.172V4.828L4.828 3H19.172L21 4.828V19.172L19.172 21H4.828ZM5 19H19V5H5V19ZM15.5 11L19 16H5L8.5 11.5L11 14.5L15.5 11Z"/></svg>', action: () => insertImageFromPicker() },
        { label: '链接', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.36 15.54L16.95 14.12 18.36 12.71C20.32 10.75 20.32 7.59 18.36 5.64 16.41 3.68 13.25 3.68 11.29 5.64L9.88 7.05 8.46 5.64 9.88 4.22C12.61 1.49 17.04 1.49 19.78 4.22 22.51 6.96 22.51 11.39 19.78 14.12L18.36 15.54ZM15.54 18.36L14.12 19.78C11.39 22.51 6.96 22.51 4.22 19.78 1.49 17.04 1.49 12.61 4.22 9.88L5.64 8.46 7.05 9.88 5.64 11.29C3.68 13.25 3.68 16.41 5.64 18.36 7.59 20.32 10.75 20.32 12.71 18.36L14.12 16.95 15.54 18.36ZM14.83 7.76L16.24 9.17 9.17 16.24 7.76 14.83 14.83 7.76Z"/></svg>', action: () => editor.execCommand('toggleLink') },
        { label: '分割线', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M2 11H22V13H2V11Z"/></svg>', action: () => editor.execCommand('setHorizontalRule') },
        { label: '公式', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 11.5L5 17H3L6.5 10 3 3H5L8 8.5 11 3H13L9.5 10 13 17H11L8 11.5ZM18 7H20V17H18V7ZM14 10H22V12H14V10Z"/></svg>', action: () => insertMathFormula() },
      ]},
      { sep: true },
      { label: '表情符号', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 22C6.48 22 2 17.52 2 12S6.48 2 12 2 22 6.48 22 12 17.52 22 12 22ZM12 20C16.42 20 20 16.42 20 12S16.42 4 12 4 4 7.58 4 12 7.58 20 12 20ZM8 14H16C16 16.21 14.21 18 12 18S8 16.21 8 14ZM8 10C7.17 10 6.5 9.33 6.5 8.5S7.17 7 8 7 9.5 7.67 9.5 8.5 8.83 10 8 10ZM16 10C15.17 10 14.5 9.33 14.5 8.5S15.17 7 16 7 17.5 7.67 17.5 8.5 16.83 10 16 10Z"/></svg>', action: () => {
        const inst = editor.instance?.();
        if (inst) editor.focus();
        const anchor = {
          getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 1, 1)
        };
        if (typeof window.toggleEmojiPicker === 'function') window.toggleEmojiPicker(anchor);
      }},
      { label: '清除格式', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12.65 14.07L11.6 20H9.57L10.92 12.34L3.51 4.93L4.93 3.51L20.49 19.07L19.07 20.49L12.65 14.07ZM11.77 7.53L12.04 6H10.24L8.24 4H20V6H14.07L13.5 9.26L11.77 7.53Z"/></svg>', action: () => {
        const inst = editor.instance?.();
        if (!inst) return;
        const { from, to } = inst.state.selection;
        if (from === to) {
          // 未选中：清空光标所在行（含块级格式 → 普通段落）
          inst.chain().focus().selectParentNode().unsetAllMarks().setParagraph().run();
        } else {
          // 已选中：只清除选中文字的格式（不改变整行/块级类型）
          inst.chain().focus().unsetAllMarks().run();
        }
      }},
      { sep: true },
      { label: '专注模式', icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M21 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14V4zM3 2.99C3 2.44 3.45 2 4 2h16c.55 0 1 .45 1 1v18c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V2.99zM9 6h8v2H9V6zm0 4h8v2H9v-2zm0 4h5v2H9v-2z"/></svg>', action: () => toggleFocusMode() },
    ];

    for (const item of items) {
      if (item.sep) {
        const hr = document.createElement('div');
        hr.className = 'md-ctx-sep';
        menu.appendChild(hr);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'md-ctx-item';
      const iconHtml = item.icon ? `<span class="md-ctx-icon">${item.icon}</span>` : '<span class="md-ctx-icon"></span>';

      if (item.submenu) {
        row.classList.add('has-submenu');
        row.innerHTML = iconHtml + `<span class="md-ctx-label">${item.label}</span><span class="md-ctx-arrow">▸</span>`;
        const sub = document.createElement('div');
        sub.className = 'md-ctx-submenu';
        for (const si of item.submenu) {
          if (si.sep) {
            const sep = document.createElement('div');
            sep.className = 'md-ctx-sep';
            sub.appendChild(sep);
            continue;
          }
          const srow = document.createElement('div');
          srow.className = 'md-ctx-item';
          const siIcon = si.icon ? `<span class="md-ctx-icon">${si.icon}</span>` : '';
          srow.innerHTML = siIcon + `<span class="md-ctx-label">${si.label}</span>`;
          srow.addEventListener('click', () => { menu.remove(); window.setBubbleSuppressed?.(false); si.action(); });
          sub.appendChild(srow);
        }
        row.appendChild(sub);

        if (_touchMode) {
          // 行内手风琴：点父项切换展开；同时只展开一个，收起其它
          sub.classList.add('md-ctx-submenu-inline');
          row.addEventListener('click', (ev) => {
            if (sub.contains(ev.target)) return; // 点的是子项，交给子项自己的 click
            const opening = sub.style.display !== 'block';
            menu.querySelectorAll('.md-ctx-submenu').forEach(s => { s.style.display = 'none'; });
            menu.querySelectorAll('.md-ctx-item.has-submenu').forEach(r => r.classList.remove('submenu-open'));
            if (opening) {
              sub.style.display = 'block';
              row.classList.add('submenu-open');
              // 展开后若整体超出视口底部，菜单内部滚动到可见
              requestAnimationFrame(() => { sub.scrollIntoView({ block: 'nearest' }); });
            }
          });
          menu.appendChild(row);
          continue;
        }

        /* ---- 三角安全区域算法 (aim-aware submenu, 参考 Amazon/Ben Kamens) ----
         * 跟踪鼠标移动方向：如果鼠标正朝着子菜单方向移动，延迟关闭；
         * 否则立即切换子菜单。
         */
        let _lastMouse = null;
        let _subCloseTimer = null;
        const CLOSE_DELAY = 500;

        function isAimingAtSub(mx, my) {
          if (!_lastMouse) return false;
          const sr = sub.getBoundingClientRect();
          if (sr.width === 0) return false;
          const isLeft = sub.classList.contains('md-ctx-submenu-left');
          const targetTop = { x: isLeft ? sr.right : sr.left, y: sr.top };
          const targetBot = { x: isLeft ? sr.right : sr.left, y: sr.bottom };
          const dx = mx - _lastMouse.x;
          const dy = my - _lastMouse.y;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return true;
          const crossTop = (targetTop.x - _lastMouse.x) * dy - (targetTop.y - _lastMouse.y) * dx;
          const crossBot = (targetBot.x - _lastMouse.x) * dy - (targetBot.y - _lastMouse.y) * dx;
          if (isLeft) return crossTop >= 0 || crossBot <= 0;
          return crossTop <= 0 || crossBot >= 0;
        }

        function cancelClose() {
          if (_subCloseTimer) { clearTimeout(_subCloseTimer); _subCloseTimer = null; }
        }
        function scheduleClose() {
          cancelClose();
          _subCloseTimer = setTimeout(() => { sub.style.display = 'none'; _subCloseTimer = null; }, CLOSE_DELAY);
        }

        function onRowMouseMove(e) {
          const aim = isAimingAtSub(e.clientX, e.clientY);
          _lastMouse = { x: e.clientX, y: e.clientY };
          if (aim) { cancelClose(); } else { scheduleClose(); }
        }

        row.addEventListener('mouseenter', (e) => {
          cancelClose();
          _lastMouse = { x: e.clientX, y: e.clientY };
          menu.querySelectorAll('.md-ctx-submenu').forEach(s => { if (s !== sub) s.style.display = 'none'; });
          menu._activeSubmenuRow = row;
          sub.classList.remove('md-ctx-submenu-left');
          const rr = row.getBoundingClientRect();
          sub.style.top = '-4px';
          sub.style.left = (rr.width + 4) + 'px';
          sub.style.right = 'auto';
          sub.style.bottom = 'auto';
          sub.style.display = 'block';
          const sr = sub.getBoundingClientRect();
          if (sr.right > window.innerWidth - 8) {
            sub.style.left = 'auto';
            sub.style.right = (rr.width + 4) + 'px';
            sub.classList.add('md-ctx-submenu-left');
          }
          if (sr.bottom > window.innerHeight - 8) {
            sub.style.top = 'auto';
            sub.style.bottom = '0px';
          }
          row.addEventListener('mousemove', onRowMouseMove);
        });
        row.addEventListener('mouseleave', (e) => {
          row.removeEventListener('mousemove', onRowMouseMove);
          const related = e.relatedTarget;
          if (sub.contains(related)) { cancelClose(); return; }
          scheduleClose();
        });
        sub.addEventListener('mouseenter', cancelClose);
        sub.addEventListener('mouseleave', (e) => {
          const related = e.relatedTarget;
          if (row.contains(related)) return;
          scheduleClose();
        });
      } else {
        row.innerHTML = iconHtml + `<span class="md-ctx-label">${item.label}</span>`;
        row.addEventListener('mouseenter', () => {
          if (menu._activeSubmenuRow && menu._activeSubmenuRow !== row) {
            menu.querySelectorAll('.md-ctx-submenu').forEach(s => { s.style.display = 'none'; });
            menu._activeSubmenuRow = null;
          }
        });
        row.addEventListener('click', () => { menu.remove(); window.setBubbleSuppressed?.(false); item.action(); });
      }
      menu.appendChild(row);
    }

    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    document.body.appendChild(menu);

    requestAnimationFrame(() => {
      // 用 offsetWidth/Height（mdPopIn 有 scale 动画，getBoundingClientRect 会偏小）
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      let left = e.clientX, top = e.clientY;
      if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - mw);
      if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - mh);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    });

    const restoreBubble = () => { window.setBubbleSuppressed?.(false); };
    let dismiss;
    let dismissKey;
    const cleanup = () => {
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('touchstart', dismiss, true);
      document.removeEventListener('keydown', dismissKey, true);
    };
    dismiss = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); restoreBubble(); cleanup(); }
    };
    dismissKey = (ev) => {
      if (ev.key === 'Escape') { menu.remove(); restoreBubble(); cleanup(); }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', dismiss, true);
      document.addEventListener('touchstart', dismiss, true);
      document.addEventListener('keydown', dismissKey, true);
    }, 0);
  };

  document.addEventListener('contextmenu', handleCtx, true);

  // 全局兜底：点到任何右键菜单之外、或按 Esc，都清掉残留的 .md-editor-ctx 并恢复气泡菜单。
  // 这样即使某个菜单因异常路径没走自己的 cleanup，气泡也不会"永久消失、必须重开笔记"。
  document.addEventListener('mousedown', (ev) => {
    if (ev.target.closest?.('.md-editor-ctx')) return;
    const stray = document.querySelectorAll('.md-editor-ctx');
    if (stray.length) stray.forEach(m => m.remove());
    if (window.isBubbleSuppressed?.() && !document.querySelector('.md-editor-ctx')) {
      window.setBubbleSuppressed(false);
    }
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!document.querySelector('.md-editor-ctx')) return;
    document.querySelectorAll('.md-editor-ctx').forEach(m => m.remove());
    window.setBubbleSuppressed?.(false);
  }, true);
}

// enhanceTableContextMenu, doTableAction, enhanceImageButton removed — Tiptap handles these natively

// 滚动条「贴近才显示」：仅当鼠标靠近滚动条所在的边缘（右侧竖条 / 底部横条）时
// 给容器加 .sb-show 显示 thumb；离开该区域即隐藏。比 :hover 伪类在 WebView2 下更可靠，
// 也比"容器内任意移动就显示"更克制（正是用户要的：在滚轮位置才出现，移开就消失）。
function initScrollbarAutoHide() {
  const ZONE = 16; // 命中区宽度（略大于滚动条 12px，靠近时即显示，便于抓取）
  const HIDE_DELAY = 300; // 移开后短延迟再隐藏，避免拖动 thumb 时鼠标轻微漂移就闪掉
  const sels = ['#editor', '#tree-container'];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el || el.__sbHook) continue;
    el.__sbHook = true;
    let hideTimer = null;
    const scheduleHide = () => {
      if (hideTimer) return;
      hideTimer = setTimeout(() => { el.classList.remove('sb-show'); hideTimer = null; }, HIDE_DELAY);
    };
    const show = () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      el.classList.add('sb-show');
    };
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      const nearV = el.scrollHeight > el.clientHeight && (r.right - e.clientX) >= -2 && (r.right - e.clientX) <= ZONE;
      const nearH = el.scrollWidth > el.clientWidth && (r.bottom - e.clientY) >= -2 && (r.bottom - e.clientY) <= ZONE;
      if (nearV || nearH) show(); else scheduleHide();
    }, { passive: true });
    el.addEventListener('mouseleave', scheduleHide);
  }
}

// 启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { bootstrap(); initScrollbarAutoHide(); });
} else {
  bootstrap();
  initScrollbarAutoHide();
}

