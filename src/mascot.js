/* 小枝 —— AI 助手形象系统（第一步：形象 + 唤出，暂不含真正的 AI 对话）。
 * 形象用谷歌开源动画 emoji（矢量版 lottie.json），播放器与表情都「在线按需下载 + 本地永久缓存」，
 * 安装包基本不变大；离线或加载失败时自动退回系统静态 emoji 字形，保证总能显示。
 * 唤出：Alt+A（app.js 里注册）、正文输入 @（智能触发、绝不挡打字）、命令面板项。
 * 暴露 window.mascot：init / toggle / openPanel / closePanel / setMood / setResident / isEnabled / mountSettings。
 */
(function () {
  'use strict';

  var K = {
    enabled: 'zhinote.mascot.enabled',   // '0' 关闭；其它/缺省 = 开
    resident: 'zhinote.mascot.resident', // '1' 常驻右下角
    avatar: 'zhinote.mascot.avatar',     // 常驻形象（emoji 字符）
  };
  // 常驻形象可选项（静态 emoji；对话里说话的动图表情与此无关）
  var AVATARS = [
    '🌱','🌿','☘️','🍀','🪴','🌵','🌻','🌸','🌷','🍄','🍂','🌈','⭐','🌙','☀️','🔥','💡','🎈','🍵','🫧','💎','🎐',
    '🙂','😊','😀','😄','😁','😉','😌','🤔','😎','🤗','🥰','🤩','🥳','😇','😋','😴','🤓','🥸','🫠','😺',
    '🤖','👻','👽','🐣','🐱','🐶','🐼','🦊','🐰','🐻','🐨','🐯','🦁','🐸','🐵','🐳','🐬','🦉','🦜','🐢','🐙','🦄',
  ];
  function avatarGlyph() { var v = lget(K.avatar); return (v && AVATARS.indexOf(v) >= 0) ? v : '🌱'; }
  function lget(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  function isEnabled() { return lget(K.enabled) !== '0'; }
  function isResident() { return lget(K.resident) === '1'; }

  // 话题/状态 -> emoji 码点（可持续扩充；用到才下载，不占空间；加载失败自动退回静态字形）
  // idle = 🌱：对话里说话人头像没有特殊表情时回到原始形象（用户指定）
  var MOODS = {
    idle: '1f331', hi: '1f44b', happy: '1f604', think: '1f914', idea: '1f4a1',
    done: '1f973', oops: '1f605', focus: '1f60e', wow: '1f929', love: '1f60d',
    sleep: '1f634', ok: '1f44d',
    laugh: '1f923', shy: '1f60a', sad: '1f622', wink: '1f609', tongue: '1f61c',
    zany: '1f92a', hmm: '1f9d0', smug: '1f60f', dizzy: '1f635', hot: '1f975',
    cold: '1f976', upside: '1f643', shush: '1f92b', yawn: '1f971', halo: '1f607',
    relieved: '1f60c', surprise: '1f62f', drool: '1f924', mask: '1f637', nerd: '1f913',
  };
  // AI 回复开头 [[表情:词]] 里的词 → MOODS 键（词表见 ai.js MOOD_WORDS）
  var WORD2MOOD = {
    '开心': 'happy', '大笑': 'laugh', '思考': 'think', '酷': 'focus', '惊讶': 'surprise',
    '害羞': 'shy', '难过': 'sad', '尴尬': 'oops', '眨眼': 'wink', '点赞': 'ok',
    '庆祝': 'done', '爱心': 'love', '灵感': 'idea', '瞌睡': 'sleep', '吐舌': 'tongue',
    '鬼脸': 'zany', '疑惑': 'hmm', '得意': 'smug',
  };
  // 闲时随机小表情池（常驻按钮偶尔演一下，制造点惊喜）
  var IDLE_SET = ['sleep', 'yawn', 'hmm', 'smug', 'dizzy', 'hot', 'cold', 'upside', 'shush', 'halo', 'relieved', 'tongue', 'zany', 'wink', 'focus', 'think', 'idea', 'happy', 'drool', 'nerd'];
  function cpToGlyph(cp) {
    try { return String.fromCodePoint.apply(null, cp.split('-').map(function (h) { return parseInt(h, 16); })); }
    catch (_) { return '\uD83D\uDE42'; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ===== 本地缓存（浏览器自带仓库 IndexedDB；桌面 WebView2 与网页端通用）=====
  var _db = null, _dbP = null;
  function db() {
    if (_db) return Promise.resolve(_db);
    if (_dbP) return _dbP;
    _dbP = new Promise(function (res) {
      try {
        var r = indexedDB.open('zhinote-mascot', 1);
        r.onupgradeneeded = function () { try { r.result.createObjectStore('emoji'); } catch (_) {} };
        r.onsuccess = function () { _db = r.result; res(_db); };
        r.onerror = function () { res(null); };
      } catch (_) { res(null); }
    });
    return _dbP;
  }
  function idbGet(cp) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (res) {
        try { var t = d.transaction('emoji', 'readonly').objectStore('emoji').get(cp); t.onsuccess = function () { res(t.result || null); }; t.onerror = function () { res(null); }; }
        catch (_) { res(null); }
      });
    });
  }
  function idbPut(cp, val) {
    db().then(function (d) { if (!d) return; try { d.transaction('emoji', 'readwrite').objectStore('emoji').put(val, cp); } catch (_) {} });
  }

  var _mem = {};
  function getData(cp) {
    if (_mem[cp]) return Promise.resolve(_mem[cp]);
    return idbGet(cp).then(function (s) {
      if (s) { try { var o = JSON.parse(s); _mem[cp] = o; return o; } catch (_) {} }
      return fetch('https://fonts.gstatic.com/s/e/notoemoji/latest/' + cp + '/lottie.json')
        .then(function (r) { if (!r.ok) throw 0; return r.text(); })
        .then(function (txt) { idbPut(cp, txt); var o = JSON.parse(txt); _mem[cp] = o; return o; });
    });
  }

  // ===== 播放器（lottie-web）在线加载一次，浏览器自动缓存 =====
  var _lottieP = null;
  function loadLottie() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (_lottieP) return _lottieP;
    _lottieP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js';
      s.async = true;
      s.onload = function () { res(window.lottie); };
      s.onerror = function () { rej(0); };
      document.head.appendChild(s);
    });
    return _lottieP;
  }

  // ===== DOM =====
  var _root = null, _avatar = null, _panel = null, _moodToken = 0, _curMood = 'idle';
  var _visible = false, _panelOpen = false, _idleBackTimer = null;
  // 说话人头像：动图 emoji 长在对话气泡旁（最新一条回复），常驻按钮固定是 🌱
  var _chatAva = null, _chatAnim = null;

  function ensureDom() {
    if (_root) return;
    _root = document.getElementById('mascot-root');
    if (!_root) { _root = document.createElement('div'); _root.id = 'mascot-root'; document.body.appendChild(_root); }
    _root.innerHTML =
      '<div class="mascot-panel" id="mascot-panel" role="dialog" aria-label="小枝">'
      + '<div class="mascot-panel-head">'
      + '<span class="mascot-panel-name"><span class="mascot-panel-em">🌱</span>小枝</span>'
      + '<button type="button" class="mascot-model" id="mascot-model" title="切换 AI / 模型"></button>'
      + '<button type="button" class="mascot-panel-mini" id="mascot-hist" title="会话历史" aria-label="会话历史">'
      + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button>'
      + '<button type="button" class="mascot-panel-mini" id="mascot-gear" title="小枝设置" aria-label="小枝设置">'
      + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>'
      + '<button type="button" class="mascot-panel-mini" id="mascot-clear" title="新对话" aria-label="新对话">'
      + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 12h10l1-12"/></svg></button>'
      + '<button type="button" class="mascot-panel-close" id="mascot-close" title="关闭" aria-label="关闭">'
      + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>'
      + '</div>'
      + '<div class="mascot-chat" id="mascot-chat"></div>'
      + '<div class="mascot-quick" id="mascot-quick"></div>'
    + '<div class="mascot-input">'
    + '<button type="button" class="mascot-ctx" id="mascot-ctx" title="选择随问题带上的笔记" aria-label="选择笔记">📄<span class="mascot-ctx-t"></span></button>'
    + '<textarea id="mascot-ta" rows="1" placeholder="问小枝…（Enter 发送）"></textarea>'
      + '<button type="button" class="mascot-send" id="mascot-send" title="发送" aria-label="发送">'
      + '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg></button>'
      + '</div>'
      + '</div>'
      + '<button type="button" class="mascot-avatar" id="mascot-avatar" aria-label="小枝">' // 不放 title：原生提示框会遮住碎碎念气泡
      + '<span class="mascot-fallback">' + avatarGlyph() + '</span></button>';
    _avatar = _root.querySelector('#mascot-avatar');
    _panel = _root.querySelector('#mascot-panel');
    _avatar.addEventListener('click', function () {
      var opening = !_panelOpen;
      toggle();
      // 点开时打个招呼（换个表情），别只干巴巴弹窗
      if (opening) playAvatarMood(['hi', 'happy', 'wink', 'love', 'done'][Math.floor(Math.random() * 5)]);
    });
    // 右键：不弹窗，换个表情 + 冒句碎碎念（纯互动）
    _avatar.addEventListener('contextmenu', function (e) {
      e.preventDefault(); e.stopPropagation();
      playAvatarMood();
      showQuip(true);
    });
    _root.querySelector('#mascot-close').addEventListener('click', function () { closePanel(); });
    _root.querySelector('#mascot-clear').addEventListener('click', function () { newChat(); });
    _root.querySelector('#mascot-gear').addEventListener('click', function () { openMascotSettings(); });
    _root.querySelector('#mascot-hist').addEventListener('click', function (e) { openHistory(e.currentTarget); });
    bindChat();
  }

  function applyState() {
    ensureDom();
    _root.classList.toggle('mascot-disabled', !isEnabled());
    _root.classList.toggle('mascot-visible', _visible && isEnabled());
    _root.classList.toggle('mascot-panel-open', _panelOpen && _visible && isEnabled());
    try { document.body.classList.toggle('mascot-off', !isEnabled()); } catch (_) {} // 悬浮工具栏的 🌱 按钮随开关显隐
  }

  // ===== 表情切换（带竞态保护 + 离线兜底）=====
  // 动图 emoji 演在「对话里最新一条小枝消息」的头像上（说话的人）；常驻按钮固定 🌱 不动。
  function setChatAvatar(el) {
    if (_chatAva === el) return;
    try { if (_chatAnim) { _chatAnim.destroy(); _chatAnim = null; } } catch (_) {}
    _chatAva = el;
    if (el) setMood(_curMood || 'idle');
  }
  function setMood(name) {
    var cp = MOODS[name] || (/^[0-9a-f-]+$/i.test(name) ? name : MOODS.idle);
    _curMood = name;
    var host = _chatAva;
    if (!host || !host.isConnected) return;
    var token = ++_moodToken;
    host.textContent = cpToGlyph(cp); // 先立即给静态字形，动图加载好再替换（离线时它就是最终形态）
    Promise.all([loadLottie(), getData(cp)]).then(function (r) {
      if (token !== _moodToken || host !== _chatAva || !host.isConnected) return;
      var lot = r[0], data = r[1];
      try { if (_chatAnim) { _chatAnim.destroy(); _chatAnim = null; } } catch (_) {}
      var box = document.createElement('div'); box.className = 'mascot-lottie';
      host.textContent = ''; host.appendChild(box);
      try { _chatAnim = lot.loadAnimation({ container: box, renderer: 'svg', loop: true, autoplay: true, animationData: data }); }
      catch (_) { host.textContent = cpToGlyph(cp); }
    }).catch(function () {});
  }

  // 短暂表演一个表情后回到待命
  function flashMood(name, ms) {
    clearTimeout(_idleBackTimer);
    setMood(name);
    _idleBackTimer = setTimeout(function () { setMood('idle'); }, ms || 1600);
  }

  /** 在任意元素里播动图 emoji（面板头像之外的场景用：对话块说话人、常驻闲时小表情）。
   *  返回 { stop(freeze) }：stop 销毁动画；freeze !== false 时留下静态字形。 */
  function animEmoji(host, moodOrCp) {
    var cp = MOODS[moodOrCp] || (/^[0-9a-f-]+$/i.test(moodOrCp) ? moodOrCp : MOODS.idle);
    var stopped = false, anim = null;
    host.textContent = cpToGlyph(cp); // 先给静态字形，动图就绪再替换（离线时它就是最终形态）
    Promise.all([loadLottie(), getData(cp)]).then(function (r) {
      if (stopped || !host.isConnected) return;
      var box = document.createElement('div'); box.className = 'mascot-lottie';
      host.textContent = ''; host.appendChild(box);
      try { anim = r[0].loadAnimation({ container: box, renderer: 'svg', loop: true, autoplay: true, animationData: r[1] }); }
      catch (_) { host.textContent = cpToGlyph(cp); }
    }).catch(function () {});
    return {
      stop: function (freeze) {
        stopped = true;
        try { if (anim) { anim.destroy(); anim = null; } } catch (_) {}
        if (freeze !== false && host.isConnected) host.textContent = cpToGlyph(cp);
      },
    };
  }
  function moodOfWord(w) { return WORD2MOOD[String(w || '').trim()] || ''; }

  // ===== 显示 / 隐藏 / 面板 =====
  function showAvatar(mood) {
    if (!isEnabled()) return;
    _visible = true; applyState();
    setMood(mood || _curMood || 'idle');
  }
  function hideAvatar() {
    if (isResident() && isEnabled()) { _panelOpen = false; applyState(); return; }
    _visible = false; _panelOpen = false; applyState();
  }
  function openPanel() {
    if (!isEnabled()) return;
    _visible = true; _panelOpen = true; applyState();
    try { hideQuip(); } catch (_) {}
    refreshChat();
    var ta = taEl(); if (ta) setTimeout(function () { try { ta.focus(); } catch (_) {} }, 60);
    var c = chatEl();
    if (!(c && c.querySelector('.mascot-msg'))) flashMood('happy', 1200);
  }
  function closePanel() {
    _panelOpen = false; applyState(); closePicker();
    if (!isResident()) { _visible = false; applyState(); }
  }
  // 页面卸载前把没归档的当前会话存下（正常归档时机是「新对话」按钮）
  try { window.addEventListener('pagehide', function () { try { histSaveCurrent(); } catch (_) {} }); } catch (_) {}
  function toggle() { if (_panelOpen) closePanel(); else openPanel(); }

  // ===== @ 智能触发（正文里输入 @ 冒出小提示，不挡打字）=====
  var _chip = null, _atQuery = '';
  var _pendingBlockQ = '';   // @ 确认时预填给新对话块输入框的文字（挂载时取走）
  function ensureChip() {
    if (_chip) return;
    _chip = document.createElement('div');
    _chip.id = 'mascot-atchip';
    _chip.className = 'mascot-atchip hidden';
    _chip.innerHTML = '<span class="mascot-atchip-em">🌱</span><span>问小枝</span><kbd>Tab</kbd>';
    document.body.appendChild(_chip);
    _chip.addEventListener('mousedown', function (e) { e.preventDefault(); });
    _chip.addEventListener('click', function () { confirmAt(); });
  }
  function showChip(range) {
    if (!isEnabled()) return;
    ensureChip();
    var rect = range.getBoundingClientRect();
    _chip.style.left = Math.round(rect.left) + 'px';
    _chip.style.top = Math.round(rect.bottom + 6) + 'px';
    _chip.classList.remove('hidden');
  }
  function chipShown() { return _chip && !_chip.classList.contains('hidden'); }
  function hideChip() { if (_chip) _chip.classList.add('hidden'); _atQuery = ''; }
  // @ 确认 → 把刚打的「@带的字」就地换成笔记内对话块，带的字预填进块的输入框（Enter 即问）。
  function confirmAt() {
    var q = _atQuery; hideChip();
    var ed = window.editor && window.editor.instance && window.editor.instance();
    if (ed && ed.isEditable) {
      try {
        var from = ed.state.selection.from;
        var start = from - ((q ? q.length : 0) + 1); // 「@」+ 后面跟打的字
        _pendingBlockQ = q || '';
        ed.chain().focus().deleteRange({ from: start, to: from })
          .insertContent({ type: 'zhichatBlock', attrs: { data: JSON.stringify({ v: 1, items: [] }) } }).run();
        return;
      } catch (_) { _pendingBlockQ = ''; }
    }
    // 兜底（编辑器不可用时）：退回旧行为开面板
    openPanel();
    var ta = taEl();
    if (ta) { ta.value = q || ''; autoGrow(ta); setTimeout(function () { try { ta.focus(); var n = ta.value.length; ta.setSelectionRange(n, n); } catch (_) {} }, 80); }
  }

  function tryAt() {
    if (!isEnabled()) { hideChip(); return; }
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) { hideChip(); return; }
    var range = sel.getRangeAt(0);
    if (!range.collapsed) { hideChip(); return; }
    var node = range.startContainer;
    var target = node.nodeType === 3 ? node.parentElement : node;
    if (!target || !target.closest || !target.closest('#editor .ProseMirror') || target.closest('pre, code')) { hideChip(); return; }
    if (node.nodeType !== 3) { hideChip(); return; }
    var before = node.textContent.slice(0, range.startOffset).replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, '');
    // 行首或空白后的 @ 才算唤出；紧贴在字符后的 @（如邮箱 a@b）不触发
    var m = before.match(/(^|\s)@([^\s@]{0,30})$/);
    if (m) { _atQuery = m[2]; showChip(range); } else hideChip();
  }

  function installTrigger() {
    document.addEventListener('input', tryAt, true);
    document.addEventListener('keydown', function (e) {
      if (!chipShown()) return;
      if (e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); confirmAt(); }
      else if (e.key === 'Escape') { e.preventDefault(); hideChip(); }
    }, true);
    document.addEventListener('mousedown', function (e) {
      if (chipShown() && _chip && !_chip.contains(e.target)) hideChip();
    }, true);
  }

  // ===== 对话（调用 window.aiChat）=====
  var _messages = [];        // 发给模型的真实上下文 [{role,content}]
  var _streaming = false, _abort = null;
  // 「选择笔记」上下文：默认带上当前打开的这篇；可换成任意一篇或不带（每次会话重置，不持久）
  var _ctxPick = { mode: 'current' };
  var _selText = '', _selFrom = 0, _selTo = 0;

  /** 把选择结果换算成 chat() 的 noteContext 参数：false / true(当前) / 现成文本(指定笔记) */
  function pickToCtx(pick) {
    if (!pick || pick.mode === 'off') return false;
    if (pick.mode === 'current') return true;
    return (ai() && ai().getNoteContext(pick.id)) || false;
  }
  function ctxPickCtx() { return pickToCtx(_ctxPick); }
  function pickLabel(pick) {
    if (!pick || pick.mode === 'off') return '';
    if (pick.mode === 'current') return '本篇';
    var t = pick.title || '无标题';
    return t.length > 8 ? t.slice(0, 8) + '…' : t;
  }

  // ===== 选笔记浮层（面板与对话块共用；搜索复用 storage.searchAll 全文引擎）=====
  var _picker = null;
  function closePicker() { if (_picker) { _picker.remove(); _picker = null; } }
  function openNotePicker(anchor, cur, onPick) {
    closePicker();
    var pop = document.createElement('div'); pop.className = 'mascot-picker';
    pop.innerHTML = '<input type="text" class="mascot-picker-inp" placeholder="搜标题或内容…">'
      + '<div class="mascot-picker-list"></div>';
    document.body.appendChild(pop); _picker = pop;
    var inp = pop.querySelector('.mascot-picker-inp');
    var list = pop.querySelector('.mascot-picker-list');

    function position() {
      var r = anchor.getBoundingClientRect();
      var w = pop.offsetWidth, h = pop.offsetHeight;
      var x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
      var y = r.top - h - 8;                      // 优先在按钮上方
      if (y < 8) y = Math.min(r.bottom + 8, window.innerHeight - h - 8);
      pop.style.left = Math.round(x) + 'px';
      pop.style.top = Math.round(Math.max(8, y)) + 'px';
    }
    function pick(p) { closePicker(); onPick(p); }
    function itemHtml(icon, title, sub, extra) {
      return '<span class="mascot-picker-ico">' + icon + '</span><span class="mascot-picker-m"><span class="mascot-picker-t">'
        + esc(title) + '</span>' + (sub ? '<span class="mascot-picker-s">' + esc(sub) + '</span>' : '') + '</span>' + (extra || '');
    }
    // 全部笔记（不删的），最近改过的排前面；跨笔记本也列出（副标题标明在哪个本子）
    function allNotes() {
      var arr = [];
      try {
        var notes = window.storage.getAll().notes || {};
        for (var id in notes) { var n = notes[id]; if (n && !n.deletedAt) arr.push(n); }
        arr.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
      } catch (_) {}
      return arr;
    }
    function wsName(wsId) {
      try {
        if (!wsId || wsId === (window.storage.getActiveWorkspace() || {}).id) return '';
        var w = (window.storage.getWorkspaces() || []).find(function (x) { return x.id === wsId; });
        return w ? (w.name || '') : '';
      } catch (_) { return ''; }
    }
    function noteRow(n) {
      return { el: mkRow(itemHtml(n.icon || '📄', n.title || '无标题', wsName(n.workspaceId)), cur && cur.mode === 'note' && cur.id === n.id), p: { mode: 'note', id: n.id, title: n.title || '无标题' } };
    }
    function render(q) {
      list.innerHTML = '';
      var rows = [];
      var curId = null;
      try { curId = window.editor.currentId(); } catch (_) {}
      if (!q) {
        if (curId) rows.push({ el: mkRow(itemHtml('📝', '本篇（当前打开）', ''), cur && cur.mode === 'current'), p: { mode: 'current' } });
        rows.push({ el: mkRow(itemHtml('🚫', '不带笔记', '只按对话内容回答'), cur && cur.mode === 'off'), p: { mode: 'off' } });
        allNotes().forEach(function (n) {
          if (n.id === curId) return;
          rows.push(noteRow(n));
        });
      } else {
        // 全文搜索（当前笔记本）+ 标题匹配（所有笔记本）合并去重
        var seen = {};
        try {
          window.storage.searchAll(q).slice(0, 12).forEach(function (h) {
            var n = null; try { n = window.storage.get(h.id); } catch (_) {}
            if (!n || seen[n.id]) return; seen[n.id] = 1;
            rows.push({ el: mkRow(itemHtml(n.icon || '📄', n.title || '无标题', h.snippet || wsName(n.workspaceId)), cur && cur.mode === 'note' && cur.id === n.id), p: { mode: 'note', id: n.id, title: n.title || '无标题' } });
          });
        } catch (_) {}
        var ql = q.toLowerCase();
        allNotes().forEach(function (n) {
          if (seen[n.id] || rows.length >= 20) return;
          if (String(n.title || '').toLowerCase().indexOf(ql) < 0) return;
          seen[n.id] = 1; rows.push(noteRow(n));
        });
        if (!rows.length) list.innerHTML = '<div class="mascot-picker-none">没有找到相关笔记</div>';
      }
      rows.forEach(function (r) {
        r.el.addEventListener('mousedown', function (e) { e.preventDefault(); pick(r.p); });
        list.appendChild(r.el);
      });
      position();
    }
    function mkRow(html, on) {
      var d = document.createElement('div'); d.className = 'mascot-picker-row' + (on ? ' on' : ''); d.innerHTML = html; return d;
    }
    var deb = null;
    inp.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(function () { render(inp.value.trim()); }, 120); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
      else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        var first = list.querySelector('.mascot-picker-row');
        if (first) first.dispatchEvent(new MouseEvent('mousedown'));
      }
    });
    setTimeout(function () {
      document.addEventListener('mousedown', function onDoc(e) {
        if (_picker !== pop) { document.removeEventListener('mousedown', onDoc, true); return; }
        if (!pop.contains(e.target)) { closePicker(); document.removeEventListener('mousedown', onDoc, true); }
      }, true);
    }, 0);
    render('');
    setTimeout(function () { try { inp.focus(); } catch (_) {} }, 20);
  }

  function ai() { return window.aiChat || null; }
  function chatEl() { return _root && _root.querySelector('#mascot-chat'); }
  function taEl() { return _root && _root.querySelector('#mascot-ta'); }
  function quickEl() { return _root && _root.querySelector('#mascot-quick'); }

  function scrollChat() { var c = chatEl(); if (c) c.scrollTop = c.scrollHeight; }

  /** 模型切换按钮的标签（面板头 / 块输入行共用）：显示当前模型名，点开自绘菜单换 AI / 模型 */
  function modelBtnLabel(btn) {
    if (!btn || !ai()) return;
    var c = ai().getConfig();
    btn.textContent = c.model || '选择模型';
    btn.title = '切换 AI / 模型（当前：' + (c.provider ? c.provider.name : '') + '）';
  }
  function populateModel() {
    modelBtnLabel(_root && _root.querySelector('#mascot-model'));
  }

  /** 自绘「AI / 模型」两级菜单（原生 <select> 的下拉列表没法美化，且换不了服务商——用户反馈）。
   *  服务商分组可展开；点模型行 = 同时切服务商 + 模型；没填 key 的服务商有小标提示（仍可选，问的时候会引导去设置）。 */
  function openModelMenu(anchor, onPick) {
    closePicker();
    var A = ai(); if (!A) return;
    var pop = document.createElement('div'); pop.className = 'mascot-picker mascot-modelmenu';
    var list = document.createElement('div'); list.className = 'mascot-picker-list';
    pop.appendChild(list);
    var expanded = {}; expanded[A.getConfig().providerId] = true;
    function renderList() {
      list.innerHTML = '';
      var cur = A.getConfig();
      A.PROVIDERS.forEach(function (p) {
        var hasKey = !!A.getKeyFor(p.id);
        var isCur = cur.providerId === p.id;
        var head = document.createElement('div');
        head.className = 'mascot-picker-row mascot-mm-prov' + (isCur ? ' cur' : '');
        head.innerHTML = '<span class="mascot-mm-caret">' + (expanded[p.id] ? '▾' : '▸') + '</span>'
          + '<span class="mascot-picker-m"><span class="mascot-picker-t">' + esc(p.name) + '</span></span>'
          + (hasKey ? '' : '<span class="mascot-mm-nokey">未填 key</span>');
        head.addEventListener('mousedown', function (e) { e.preventDefault(); expanded[p.id] = !expanded[p.id]; renderList(); });
        list.appendChild(head);
        if (!expanded[p.id]) return;
        var models = (p.models && p.models.length) ? p.models.slice() : [];
        if (isCur && cur.model && models.indexOf(cur.model) < 0) models.unshift(cur.model);
        if (!models.length) {
          var tip = document.createElement('div'); tip.className = 'mascot-picker-row mascot-mm-model';
          tip.innerHTML = '<span class="mascot-mm-caret"></span><span class="mascot-picker-m"><span class="mascot-picker-s">去 设置 → 小枝 填接口地址和模型名</span></span>';
          tip.addEventListener('mousedown', function (e) { e.preventDefault(); closePicker(); openMascotSettings(); });
          list.appendChild(tip);
          return;
        }
        models.forEach(function (m) {
          var on = isCur && cur.model === m;
          var r = document.createElement('div'); r.className = 'mascot-picker-row mascot-mm-model' + (on ? ' on' : '');
          r.innerHTML = '<span class="mascot-mm-caret">' + (on ? '✓' : '') + '</span>'
            + '<span class="mascot-picker-m"><span class="mascot-picker-t">' + esc(m) + '</span></span>';
          r.addEventListener('mousedown', function (e) {
            e.preventDefault();
            A.setProvider(p.id); A.setModel(m);
            closePicker(); populateModel();
            onPick && onPick();
          });
          list.appendChild(r);
        });
      });
      position();
    }
    document.body.appendChild(pop); _picker = pop;
    function position() {
      var r = anchor.getBoundingClientRect();
      var w = pop.offsetWidth, h = pop.offsetHeight;
      var x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
      var y = r.bottom + 6;                               // 优先在按钮下方
      if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
      pop.style.left = Math.round(x) + 'px';
      pop.style.top = Math.round(y) + 'px';
    }
    setTimeout(function () {
      document.addEventListener('mousedown', function onDoc(e) {
        if (_picker !== pop) { document.removeEventListener('mousedown', onDoc, true); return; }
        if (!pop.contains(e.target)) { closePicker(); document.removeEventListener('mousedown', onDoc, true); }
      }, true);
    }, 0);
    renderList();
  }

  function setupCard() {
    return '<div class="mascot-setup">'
      + '<div class="mascot-setup-em">🌱</div>'
      + '<div class="mascot-setup-t">你好，我是小枝</div>'
      + '<div class="mascot-setup-d">先接入一个 AI 模型，我就能陪你写作、润色、翻译、总结啦。支持 DeepSeek、通义千问、智谱、Kimi、OpenAI 等。</div>'
      + '<button type="button" class="mascot-setup-btn" id="mascot-setup-go">去设置接入模型</button>'
      + '</div>';
  }
  function greetCard() {
    return '<div class="mascot-greet">你好，我是<b>小枝</b> 🌱 有什么想问的、想让我帮忙写或整理的，直接说～'
      + '<br><span class="mascot-greet-tip">选中正文再唤出我，可一键润色 / 翻译 / 总结。</span></div>';
  }

  function refreshChat() {
    var c = chatEl(); if (!c) return;
    populateModel();
    if (!ai() || !ai().isConfigured()) {
      if (!c.querySelector('.mascot-msg')) { c.innerHTML = setupCard(); bindSetupGo(); }
      renderQuick(); return;
    }
    if (!c.querySelector('.mascot-msg') && !c.querySelector('.mascot-greet')) c.innerHTML = greetCard();
    renderQuick();
  }
  function bindSetupGo() {
    var b = _root.querySelector('#mascot-setup-go');
    if (b) b.addEventListener('click', function () { openMascotSettings(); });
  }
  function openMascotSettings() {
    try { closePanel(); if (typeof window.openSettingsModal === 'function') window.openSettingsModal('mascot'); } catch (_) {}
  }

  function renderQuick() {
    var q = quickEl(); if (!q || !ai()) return;
    _selText = ai().getSelectionText();
    try { var ed = window.editor && window.editor.instance && window.editor.instance(); if (ed) { _selFrom = ed.state.selection.from; _selTo = ed.state.selection.to; } } catch (_) {}
    if (_selText && ai().isConfigured() && !_streaming) {
      q.innerHTML = '<span class="mascot-quick-hint">对选中的文字：</span>'
        + ai().ACTIONS.map(function (a) { return '<button type="button" class="mascot-chip" data-act="' + a.id + '">' + a.emoji + ' ' + esc(a.label) + '</button>'; }).join('');
      q.classList.add('on');
    } else { q.innerHTML = ''; q.classList.remove('on'); }
  }

  function preview(s) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 28 ? s.slice(0, 28) + '…' : s; }

  // ===== 回复的 Markdown 渲染（复用编辑器的解析器 + 消毒）=====
  function marked() {
    try { return window.editor && window.editor.instance && window.editor.instance().storage.markdown.manager.markedInstance; } catch (_) { return null; }
  }
  function sanitize(root) {
    var bad = root.querySelectorAll('script, style, iframe, object, embed, link, meta, form');
    for (var i = bad.length - 1; i >= 0; i--) bad[i].remove();
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j], attrs = el.attributes;
      for (var k = attrs.length - 1; k >= 0; k--) {
        var n = attrs[k].name, v = attrs[k].value || '';
        if (/^on/i.test(n)) el.removeAttribute(n);
        else if ((n === 'href' || n === 'src') && /^\s*(javascript|data|vbscript):/i.test(v)) el.removeAttribute(n);
      }
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    }
  }
  /** 把 Markdown 文本渲染进气泡；解析器不可用时退回纯文本。 */
  function renderMd(bubble, text) {
    var m = marked();
    if (!m) { bubble.classList.remove('mascot-md'); bubble.textContent = text || ''; return; }
    var html = '';
    try { html = String(m.parse(text || '') || ''); } catch (_) { bubble.classList.remove('mascot-md'); bubble.textContent = text || ''; return; }
    bubble.classList.add('mascot-md');
    bubble.innerHTML = html;
    sanitize(bubble);
  }

  function appendMsg(role, text, isHtml) {
    var c = chatEl(); if (!c) return null;
    var greet = c.querySelector('.mascot-greet'); if (greet) greet.remove();
    var setup = c.querySelector('.mascot-setup'); if (setup) setup.remove();
    var wrap = document.createElement('div'); wrap.className = 'mascot-msg mascot-msg-' + role;
    var bub = document.createElement('div'); bub.className = 'mascot-bubble';
    if (isHtml) bub.innerHTML = text; else bub.textContent = text || '';
    var col = wrap;
    if (role === 'assistant') {
      // 说话的人：动图 emoji 头像贴在气泡左侧（只有最新一条会动，旧的定格成静态字形）
      var old = c.querySelector('.mascot-ava-live');
      if (old) { old.classList.remove('mascot-ava-live'); old.textContent = cpToGlyph(MOODS.idle); }
      var ava = document.createElement('span'); ava.className = 'mascot-ava mascot-ava-live';
      ava.textContent = '🌱';
      wrap.appendChild(ava);
      col = document.createElement('div'); col.className = 'mascot-col';
      col.appendChild(bub);
      wrap.appendChild(col);
      setChatAvatar(ava);
    } else {
      wrap.appendChild(bub);
    }
    c.appendChild(wrap); scrollChat();
    return { wrap: wrap, bubble: bub, col: col };
  }

  /** 思考过程（deepseek-reasoner 等推理流）：气泡上方一条可折叠的小字，流式实时更新 */
  function mkThink(col, bubble) {
    var d = document.createElement('details'); d.className = 'mascot-think'; d.open = true;
    d.innerHTML = '<summary>💭 思考过程</summary>';
    var t = document.createElement('div'); t.className = 'mascot-think-t';
    d.appendChild(t);
    col.insertBefore(d, bubble);
    return { el: d, txt: t };
  }

  function addActions(wrap, getText, range, q) {
    var bar = document.createElement('div'); bar.className = 'mascot-acts';
    var copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.className = 'mascot-act'; copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', function () { try { navigator.clipboard.writeText(getText()); copyBtn.textContent = '已复制'; setTimeout(function () { copyBtn.textContent = '复制'; }, 1200); } catch (_) {} });
    var insBtn = document.createElement('button'); insBtn.type = 'button'; insBtn.className = 'mascot-act'; insBtn.textContent = '插入笔记';
    insBtn.addEventListener('click', function () { if (ai() && ai().insertToEditor(getText())) { insBtn.textContent = '已插入'; setTimeout(function () { insBtn.textContent = '插入笔记'; }, 1200); } });
    bar.appendChild(copyBtn); bar.appendChild(insBtn);
    if (range) {
      var repBtn = document.createElement('button'); repBtn.type = 'button'; repBtn.className = 'mascot-act'; repBtn.textContent = '替换原文';
      repBtn.addEventListener('click', function () {
        try {
          var ed = window.editor && window.editor.instance && window.editor.instance();
          if (ed) { ed.chain().focus().deleteRange({ from: range.from, to: range.to }).insertContent(getText(), { contentType: 'markdown' }).run(); repBtn.textContent = '已替换'; setTimeout(function () { repBtn.textContent = '替换原文'; }, 1200); }
        } catch (_) { if (ai()) ai().insertToEditor(getText()); }
      });
      bar.appendChild(repBtn);
    }
    var keepBtn = document.createElement('button'); keepBtn.type = 'button'; keepBtn.className = 'mascot-act'; keepBtn.textContent = '留在笔记';
    keepBtn.title = '把这轮问答存成笔记里的可折叠对话块，之后还能在块里继续问';
    keepBtn.addEventListener('click', function () {
      if (insertChatBlock(q || '', getText())) { keepBtn.textContent = '已留存'; setTimeout(function () { keepBtn.textContent = '留在笔记'; }, 1200); }
    });
    bar.appendChild(keepBtn);
    wrap.appendChild(bar);
  }

  // content：真正发给模型的内容；display：气泡里展示的文字（动作时更简洁）；opts.range 用于「替换原文」
  function send(content, display, opts) {
    opts = opts || {};
    if (_streaming) return;
    content = String(content || '').trim(); if (!content) return;
    if (!ai() || !ai().isConfigured()) { refreshChat(); openMascotSettings(); return; }

    appendMsg('user', display != null ? display : content);
    _messages.push({ role: 'user', content: content });
    var a = appendMsg('assistant', '');
    a.bubble.classList.add('mascot-typing'); a.bubble.textContent = '正在想…';

    _streaming = true; setSendState(true); renderQuick();
    setMood(opts.mood || 'think');
    var full = '', think = null, moodShown = false;
    _abort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    ai().chat({
      messages: _messages.slice(),
      noteContext: opts.noteCtx != null ? opts.noteCtx : ctxPickCtx(),
      signal: _abort ? _abort.signal : undefined,
      onThink: function (piece, all) {
        if (!ai().showThink()) return;
        if (!think) think = mkThink(a.col, a.bubble);
        think.txt.textContent = all; think.txt.scrollTop = think.txt.scrollHeight; scrollChat();
      },
      onDelta: function (piece, all) {
        if (think && think.el.open) think.el.open = false; // 正式回答开始，思考过程收起来（仍可点开）
        full = all;
        var mm = ai().stripMoodMark(all); // 回复开头的 [[表情:词]]：剥掉并立即演在说话人头像上
        if (mm.mood && !moodShown) { moodShown = true; setMood(moodOfWord(mm.mood) || 'think'); }
        var clean = ai().stripMemoryMarks(mm.clean).clean;
        if (!clean) return; // 开头标记还没收完整，先保持「正在想…」
        a.bubble.classList.remove('mascot-typing');
        renderMd(a.bubble, clean); scrollChat();
      },
      onDone: function (all) {
        var mm = ai().stripMoodMark(all || full);
        var aiMood = moodOfWord(mm.mood);
        var sp = ai().stripMemoryMarks(mm.clean);
        full = sp.clean;
        a.bubble.classList.remove('mascot-typing');
        if (think && think.el.open) think.el.open = false;
        if (full) renderMd(a.bubble, full); else a.bubble.textContent = '(无内容)';
        _messages.push({ role: 'assistant', content: full });
        _histDirty = true; // 有完整一轮问答 → 值得进会话历史
        addActions(a.col, function () { return full; }, opts.range || null, display != null ? display : content);
        if (sp.memos.length && ai().memEnabled()) askMemory(a.col, sp.memos[0]);
        _streaming = false; setSendState(false); scrollChat();
        if (aiMood) flashMood(aiMood, 4200); else setMood('idle'); // 没有 AI 自选表情就回到 🌱
        renderQuick();
      },
      onError: function (err) {
        a.bubble.classList.remove('mascot-typing'); a.bubble.classList.add('mascot-err'); a.bubble.textContent = (err && err.message) || '出错了';
        _messages.pop(); _streaming = false; setSendState(false); scrollChat(); flashMood('oops', 1600); renderQuick();
      },
      onAbort: function () { a.bubble.classList.remove('mascot-typing'); if (!full) a.wrap.remove(); _messages.pop(); _streaming = false; setSendState(false); renderQuick(); },
    });
  }

  function setSendState(busy) {
    var s = _root && _root.querySelector('#mascot-send'); if (!s) return;
    s.classList.toggle('busy', !!busy); s.title = busy ? '停止' : '发送';
  }

  function runAction(id) {
    var act = ai() && ai().actionOf(id); if (!act || !_selText) return;
    var range = { from: _selFrom, to: _selTo };
    send(act.prompt + _selText, act.emoji + ' ' + act.label + '：' + preview(_selText), { range: range, mood: act.mood });
  }

  function newChat() {
    if (_streaming && _abort) { try { _abort.abort(); } catch (_) {} }
    histSaveCurrent();
    _messages = []; _streaming = false; setSendState(false);
    var c = chatEl(); if (c) c.innerHTML = '';
    refreshChat();
    var ta = taEl(); if (ta) { ta.value = ''; autoGrow(ta); }
  }

  // ===== 面板会话历史：只存本机（_ 前缀不上云），最多 10 段；新对话/关面板时自动归档 =====
  var HIST_KEY = '_aiChatHist', HIST_MAX = 10, _histDirty = false;
  function histList() { try { var a = JSON.parse(lget(HIST_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  function histSaveCurrent() {
    if (!_histDirty || !_messages.length) return;
    var m = _messages.slice(0, 40).map(function (x) { return { role: x.role, content: String(x.content || '').slice(0, 6000) }; });
    var a = histList(); a.unshift({ t: Date.now(), m: m });
    lset(HIST_KEY, JSON.stringify(a.slice(0, HIST_MAX)));
    _histDirty = false;
  }
  function histRestore(sess) {
    histSaveCurrent(); // 可能往列表头插一条，下面按时间戳定位要删的那条
    var a = histList();
    for (var i = 0; i < a.length; i++) if (a[i].t === sess.t) { a.splice(i, 1); break; }
    lset(HIST_KEY, JSON.stringify(a)); // 取出来继续聊，避免归档重复
    _messages = (sess.m || []).slice(); _histDirty = true;
    _streaming = false; setSendState(false);
    var c = chatEl(); if (c) c.innerHTML = '';
    _messages.forEach(function (msg) {
      if (msg.role === 'user') appendMsg('user', msg.content);
      else { var b = appendMsg('assistant', ''); renderMd(b.bubble, msg.content); }
    });
    scrollChat();
  }
  function openHistory(anchor) {
    closePicker();
    var pop = document.createElement('div'); pop.className = 'mascot-picker';
    var list = document.createElement('div'); list.className = 'mascot-picker-list';
    pop.appendChild(list);
    var a = histList();
    if (!a.length) list.innerHTML = '<div class="mascot-picker-none">还没有归档的会话<br>点「新对话」后，聊过的会自动存这里</div>';
    function fmt(t) {
      var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; };
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    a.forEach(function (s, i) {
      var firstQ = '';
      for (var j = 0; j < (s.m || []).length; j++) if (s.m[j].role === 'user') { firstQ = s.m[j].content; break; }
      var row = document.createElement('div'); row.className = 'mascot-picker-row';
      row.innerHTML = '<span class="mascot-picker-ico">💬</span><span class="mascot-picker-m"><span class="mascot-picker-t">'
        + esc(preview(firstQ || '（空会话）')) + '</span><span class="mascot-picker-s">' + fmt(s.t) + ' · ' + Math.ceil((s.m || []).length / 2) + ' 轮</span></span>';
      row.addEventListener('mousedown', function (e) { e.preventDefault(); closePicker(); histRestore(s); });
      list.appendChild(row);
    });
    if (a.length) {
      var clr = document.createElement('div'); clr.className = 'mascot-picker-row mascot-picker-clr';
      clr.innerHTML = '<span class="mascot-picker-ico">🗑️</span><span class="mascot-picker-m"><span class="mascot-picker-t">清空历史</span></span>';
      clr.addEventListener('mousedown', function (e) { e.preventDefault(); lset(HIST_KEY, '[]'); closePicker(); });
      list.appendChild(clr);
    }
    document.body.appendChild(pop); _picker = pop;
    var r = anchor.getBoundingClientRect();
    pop.style.left = Math.round(Math.min(Math.max(8, r.right - pop.offsetWidth), window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = Math.round(Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)) + 'px';
    setTimeout(function () {
      document.addEventListener('mousedown', function onDoc(e) {
        if (_picker !== pop) { document.removeEventListener('mousedown', onDoc, true); return; }
        if (!pop.contains(e.target)) { closePicker(); document.removeEventListener('mousedown', onDoc, true); }
      }, true);
    }, 0);
  }

  function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }

  function bindChat() {
    var ta = taEl(), sendBtn = _root.querySelector('#mascot-send'), model = _root.querySelector('#mascot-model'), q = quickEl();
    if (ta) {
      ta.addEventListener('input', function () { autoGrow(ta); });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          var v = ta.value; ta.value = ''; autoGrow(ta); send(v);
        }
      });
    }
    if (sendBtn) sendBtn.addEventListener('click', function () {
      if (_streaming) { if (_abort) { try { _abort.abort(); } catch (_) {} } return; }
      if (!ta) return; var v = ta.value; ta.value = ''; autoGrow(ta); send(v);
    });
    if (model) model.addEventListener('click', function () { openModelMenu(model, populateModel); });
    if (q) q.addEventListener('click', function (e) { var b = e.target.closest('.mascot-chip'); if (b) runAction(b.dataset.act); });
    var ctx = _root.querySelector('#mascot-ctx');
    if (ctx) {
      refreshCtxBtn();
      ctx.addEventListener('click', function () {
        openNotePicker(ctx, _ctxPick, function (p) {
          _ctxPick = p; refreshCtxBtn();
          var ta = taEl(); if (ta) setTimeout(function () { try { ta.focus(); } catch (_) {} }, 20);
        });
      });
    }
  }
  function refreshCtxBtn() {
    var ctx = _root && _root.querySelector('#mascot-ctx'); if (!ctx) return;
    var lbl = pickLabel(_ctxPick);
    ctx.classList.toggle('on', !!lbl);
    var t = ctx.querySelector('.mascot-ctx-t'); if (t) t.textContent = lbl;
    ctx.title = lbl ? '随问题带上：' + (_ctxPick.mode === 'current' ? '本篇笔记' : '《' + (_ctxPick.title || '无标题') + '》') + '（点击更换）' : '选择随问题带上的笔记';
  }

  /** 小枝提议记一条记忆 → 在回复下方出确认卡（默认不记，点了才记） */
  function askMemory(wrap, memo) {
    var card = document.createElement('div'); card.className = 'mascot-memask';
    var txt = document.createElement('span'); txt.className = 'mascot-memask-t'; txt.textContent = '要我记住吗？「' + memo + '」';
    var yes = document.createElement('button'); yes.type = 'button'; yes.className = 'mascot-act'; yes.textContent = '记住';
    var no = document.createElement('button'); no.type = 'button'; no.className = 'mascot-act'; no.textContent = '不了';
    yes.addEventListener('click', function () {
      ai().memAdd(memo);
      card.innerHTML = '<span class="mascot-memask-t">🌱 记住了，可在 设置 → 小枝 → 记忆 查看</span>';
    });
    no.addEventListener('click', function () { card.remove(); });
    card.appendChild(txt); card.appendChild(yes); card.appendChild(no);
    wrap.appendChild(card);
  }

  // ===== 编辑器内「小枝对话块」（NodeView 委托；见 editor.js ZhichatBlock）=====
  // data JSON：{ v:1, items:[{q,a}] }。流式只画在显示层，答完 onChange 一次性写回文档。
  function mountChatBlock(dom, dataStr, onChange, onRemove) {
    function parseData(s) {
      try { var o = JSON.parse(s || '{}'); return { items: Array.isArray(o.items) ? o.items : [] }; }
      catch (_) { return { items: [] }; }
    }
    var st = parseData(dataStr);
    var collapsed = st.items.length > 0; // 已有内容默认收起；空块（刚插入）展开等提问
    var busy = false, abortCtl = null;
    var ctxPick = { mode: 'current' }; // 「选择笔记」：默认带上本篇（块本来就长在笔记里），可换/可不带
    var thinks = {}; // 每轮的「深度思考」内容（只留在本次会话的显示层，绝不写进笔记/同步）
    var moods = {};  // 每轮 AI 自选的心情（同样只在显示层）
    var liveAnim = null; // 正在播的说话人动图（同时只有一个）

    var head = document.createElement('div'); head.className = 'zc-head';
    var wrap = document.createElement('div'); wrap.className = 'zc-wrap'; // grid 0fr↔1fr：展开/折叠顺滑过渡（动画选样·方案A）
    var body = document.createElement('div'); body.className = 'zc-body';
    wrap.appendChild(body);
    dom.appendChild(head); dom.appendChild(wrap);
    head.addEventListener('click', function (e) {
      if (e.target.closest('.zc-gear')) { openMascotSettings(); return; }
      collapsed = !collapsed; render();
    });

    // 右键菜单动作（app.js 的 handleCtx 派发；与日历块 zhinote:cal-cmd 同一模式）
    dom.addEventListener('zhinote:zc-cmd', function (ev) {
      var cmd = ev.detail && ev.detail.cmd;
      if (cmd === 'ask') { collapsed = false; render(); setTimeout(function () { var i = body.querySelector('.zc-ask input'); if (i) try { i.focus(); } catch (_) {} }, 40); }
      else if (cmd === 'toggle') { collapsed = !collapsed; render(); }
      else if (cmd === 'copyText') {
        var t = st.items.map(function (it) { return '问：' + (it.q || '') + '\n\n' + (it.a || ''); }).join('\n\n---\n\n');
        try { navigator.clipboard.writeText(t); } catch (_) {}
      } else if (cmd === 'copySource') {
        var src = '```zhichat\n' + JSON.stringify({ v: 1, items: st.items }) + '\n```';
        try { navigator.clipboard.writeText(src); } catch (_) {}
      }
    });

    function title() {
      if (!st.items.length) return '问小枝';
      return preview(st.items[0].q || '');
    }
    function renderHead() {
      head.innerHTML = '<span class="zc-caret">' + (collapsed ? '▸' : '▾') + '</span>'
        + '<span class="zc-ico">🌱</span><span class="zc-t">小枝</span>'
        + '<span class="zc-sub">' + esc(title()) + '</span>'
        + (st.items.length > 1 ? '<span class="zc-n">' + st.items.length + ' 问</span>' : '')
        + '<span class="zc-gear" title="小枝设置" role="button">'
        + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>';
    }
    function renderBody() {
      // 折叠时内容也保留在 DOM（grid 0fr + overflow hidden 收起）——收起过程才有东西可以缩
      body.innerHTML = '';
      st.items.forEach(function (it, i) {
        var q = document.createElement('div'); q.className = 'zc-q'; q.textContent = it.q || '';
        body.appendChild(q);
        // 这轮若有思考过程（本次会话内问的），保留成收起的小折叠，想看就点开
        if (thinks[i] && ai() && ai().showThink()) {
          var td = document.createElement('details'); td.className = 'zc-think';
          td.innerHTML = '<summary>💭 思考过程</summary>';
          var tt = document.createElement('div'); tt.className = 'zc-think-t'; tt.textContent = thinks[i];
          td.appendChild(tt); body.appendChild(td);
        }
        // 回答 = 说话人头像 + 内容（和面板同一套：最新一条的头像会演 AI 自选的心情动图）
        var a = document.createElement('div'); a.className = 'zc-a';
        var av = document.createElement('span'); av.className = 'zc-ava';
        av.textContent = cpToGlyph(MOODS[moods[i]] || MOODS.idle);
        var ac = document.createElement('div'); ac.className = 'zc-a-c'; renderMd(ac, it.a || '');
        a.appendChild(av); a.appendChild(ac);
        body.appendChild(a);
      });
      var think = document.createElement('details'); think.className = 'zc-think'; think.style.display = 'none';
      think.innerHTML = '<summary>💭 思考过程</summary>';
      var thinkT = document.createElement('div'); thinkT.className = 'zc-think-t'; think.appendChild(thinkT);
      body.appendChild(think);
      var live = document.createElement('div'); live.className = 'zc-live zc-a'; live.style.display = 'none';
      var liveAva = document.createElement('span'); liveAva.className = 'zc-ava';
      var liveC = document.createElement('div'); liveC.className = 'zc-a-c';
      live.appendChild(liveAva); live.appendChild(liveC);
      body.appendChild(live);
      var ask = document.createElement('div'); ask.className = 'zc-ask';
      var ctxBtn = document.createElement('button'); ctxBtn.type = 'button'; ctxBtn.className = 'zc-ctx';
      function refreshCtx() {
        var lbl = pickLabel(ctxPick);
        ctxBtn.classList.toggle('on', !!lbl);
        ctxBtn.innerHTML = '📄' + (lbl ? '<span class="zc-ctx-t">' + esc(lbl) + '</span>' : '');
        ctxBtn.title = lbl ? '随问题带上：' + (ctxPick.mode === 'current' ? '本篇笔记' : '《' + (ctxPick.title || '无标题') + '》') + '（点击更换）' : '选择随问题带上的笔记';
      }
      refreshCtx();
      ctxBtn.addEventListener('click', function () {
        openNotePicker(ctxBtn, ctxPick, function (p) {
          ctxPick = p; refreshCtx();
          setTimeout(function () { try { inp.focus(); } catch (_) {} }, 20);
        });
      });
      var inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = st.items.length ? '继续问…' : '问小枝…（答完自动存进笔记）';
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'zc-send'; btn.textContent = '发送';
      var msel = document.createElement('button'); msel.type = 'button'; msel.className = 'zc-model'; msel.title = '切换 AI / 模型';
      modelBtnLabel(msel);
      msel.addEventListener('click', function (e) { e.stopPropagation(); openModelMenu(msel, function () { modelBtnLabel(msel); }); });
      msel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      ask.appendChild(ctxBtn); ask.appendChild(inp); ask.appendChild(btn); ask.appendChild(msel);
      body.appendChild(ask);
      function submit() {
        var q = (inp.value || '').trim();
        if (!q || busy) return;
        // 阅读模式/同步保护下不可提问（.zc-ask 已由 CSS 隐藏，这里是兜底）
        try { var ed = window.editor.instance(); if (ed && !ed.isEditable) return; } catch (_) {}
        if (!ai() || !ai().isConfigured()) { live.style.display = ''; live.classList.add('zc-err'); liveAva.textContent = ''; liveC.textContent = '还没接入模型：设置 → 小枝 → 接入模型'; return; }
        busy = true; inp.value = ''; inp.disabled = true; btn.textContent = '…';
        var qEl = document.createElement('div'); qEl.className = 'zc-q'; qEl.textContent = q;
        body.insertBefore(qEl, think);
        think.style.display = 'none'; think.open = true; thinkT.textContent = '';
        live.classList.remove('zc-err'); live.style.display = ''; liveC.textContent = '正在想…';
        if (liveAnim) liveAnim.stop(false);
        liveAnim = animEmoji(liveAva, 'think'); // 说话人头像：思考中，收到 AI 自选心情后切换
        var moodShown = false;
        var msgs = [];
        st.items.forEach(function (it) { msgs.push({ role: 'user', content: it.q || '' }); msgs.push({ role: 'assistant', content: it.a || '' }); });
        msgs.push({ role: 'user', content: q });
        abortCtl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var thinkBuf = '', moodWord = '';
        ai().chat({
          messages: msgs,
          noteContext: pickToCtx(ctxPick),
          signal: abortCtl ? abortCtl.signal : undefined,
          onThink: function (piece, all) {
            thinkBuf = all;
            if (!ai().showThink()) return;
            think.style.display = ''; thinkT.textContent = all; thinkT.scrollTop = thinkT.scrollHeight;
          },
          onDelta: function (piece, all) {
            if (think.open) think.open = false; // 正式回答开始，思考过程收起（仍可点开）
            var mm = ai().stripMoodMark(all); // 开头的 [[表情:词]]：剥掉并演在说话人头像上
            if (mm.mood && !moodShown) {
              moodShown = true; moodWord = mm.mood;
              if (liveAnim) liveAnim.stop(false);
              liveAnim = animEmoji(liveAva, moodOfWord(mm.mood) || 'think');
            }
            var clean = ai().stripMemoryMarks(mm.clean).clean;
            if (clean) renderMd(liveC, clean);
          },
          onDone: function (all) {
            busy = false; abortCtl = null;
            var mm = ai().stripMoodMark(all || '');
            if (mm.mood) moodWord = mm.mood;
            st.items.push({ q: q, a: ai().stripMemoryMarks(mm.clean).clean }); // 心情/记忆标记、思考过程都不进笔记
            var idx = st.items.length - 1;
            if (thinkBuf) thinks[idx] = thinkBuf; // 思考过程留在显示层，重开笔记即消失
            var mk = moodOfWord(moodWord); if (mk) moods[idx] = mk;
            if (liveAnim) { liveAnim.stop(false); liveAnim = null; }
            onChange(JSON.stringify({ v: 1, items: st.items })); // 唯一一次写文档
            render();
            // 最新一条回答的头像把 AI 自选的心情演几秒后定格；没有就保持 🌱 不折腾
            if (mk) {
              var avs = body.querySelectorAll('.zc-a:not(.zc-live) .zc-ava');
              var lastAva = avs.length ? avs[avs.length - 1] : null;
              if (lastAva) {
                var h = animEmoji(lastAva, mk);
                setTimeout(function () { try { h.stop(); } catch (_) {} }, 4200);
              }
            }
          },
          onError: function (err) {
            busy = false; abortCtl = null;
            think.style.display = 'none';
            if (liveAnim) { liveAnim.stop(false); liveAnim = null; }
            live.classList.add('zc-err'); liveAva.textContent = cpToGlyph(MOODS.oops);
            liveC.textContent = (err && err.message) || '出错了';
            inp.disabled = false; btn.textContent = '发送'; inp.value = q; qEl.remove();
          },
          onAbort: function () { busy = false; abortCtl = null; if (liveAnim) { liveAnim.stop(false); liveAnim = null; } },
        });
      }
      btn.addEventListener('click', submit);
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
        // 空块按 Esc = 反悔，整块删掉回到打字
        else if (e.key === 'Escape' && !st.items.length && !busy && onRemove) { e.preventDefault(); onRemove(); }
      });
      if (!st.items.length) {
        // 空块没提问就点走 → 自动消失，不留空壳（焦点还在块内或选笔记浮层里则不算「点走」）
        inp.addEventListener('blur', function () {
          setTimeout(function () {
            var f = document.activeElement;
            if (f && (dom.contains(f) || f.closest('.mascot-picker'))) return;
            if (_picker) return; // 选笔记浮层开着（可能刚点开还没聚焦）
            if (!st.items.length && !busy && !inp.value.trim() && dom.isConnected && onRemove) onRemove();
          }, 120);
        });
        if (_pendingBlockQ) { inp.value = _pendingBlockQ; _pendingBlockQ = ''; }
        setTimeout(function () { try { inp.focus(); var n = inp.value.length; inp.setSelectionRange(n, n); } catch (_) {} }, 50);
      }
    }
    function render() { dom.classList.toggle('zc-open', !collapsed); renderHead(); renderBody(); }
    render();
    if (!st.items.length) {
      // 刚被 @ / 命令面板唤出的空块：气泡冒出动画（已有内容的块是重开笔记加载的，不动）
      dom.classList.add('zc-appear');
      dom.addEventListener('animationend', function onPop(e) {
        if (e.animationName !== 'zcPop') return;
        dom.classList.remove('zc-appear'); dom.removeEventListener('animationend', onPop);
      });
    }
    return {
      update: function (s) { if (busy) return; st = parseData(s); render(); },
      destroy: function () { if (abortCtl) { try { abortCtl.abort(); } catch (_) {} } },
    };
  }

  /** 把一轮问答留进笔记（面板「留在笔记」按钮用） */
  function insertChatBlock(q, a) {
    try {
      var ed = window.editor && window.editor.instance && window.editor.instance();
      if (!ed) return false;
      var data = JSON.stringify({ v: 1, items: (q || a) ? [{ q: q || '', a: a || '' }] : [] });
      ed.chain().focus().insertContent({ type: 'zhichatBlock', attrs: { data: data } }).run();
      return true;
    } catch (_) { return false; }
  }

  // ===== 设置面板 =====
  function row(title, sub, ctrl) {
    return '<div class="mascot-row"><div class="mascot-lbl">' + esc(title)
      + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' + ctrl + '</div>';
  }
  function settingsHtml() {
    var en = isEnabled(), res = isResident();
    var h = '<div class="mascot-set">';
    h += row('启用小枝', '你的 AI 笔记助手', '<span class="mascot-sw' + (en ? ' on' : '') + '" id="mascot-sw" role="switch" tabindex="0"></span>');
    if (en) {
      h += row('唤出方式', '面板随时问；@ 就地插入对话块，问答留在笔记里', '<span class="mascot-hint"><span class="mascot-kbd">Alt</span>+<span class="mascot-kbd">A</span>，或正文输入 <span class="mascot-kbd">@</span></span>');
      h += row('常驻右下角', '关闭后平时隐藏；Alt+Shift+A 也能随时切换', '<span class="mascot-sw' + (res ? ' on' : '') + '" id="mascot-res" role="switch" tabindex="0"></span>');
      h += '<details class="mascot-row mascot-row-col mascot-avafold"><summary><span class="mascot-lbl">常驻形象<small>右下角的小家伙长什么样</small></span>'
        + '<span class="mascot-ava-cur">' + avatarGlyph() + '</span><span class="mascot-avafold-caret">▾</span></summary>'
        + '<div class="mascot-em-pick" id="mascot-ava-pick">'
        + AVATARS.map(function (e) { return '<button type="button" class="mascot-em-opt' + (e === avatarGlyph() ? ' on' : '') + '" data-em="' + e + '">' + e + '</button>'; }).join('')
        + '</div></details>';
      h += aiSettingsHtml();
    }
    return h + '</div>';
  }
  function aiSettingsHtml() {
    var A = ai(); if (!A) return '';
    var c = A.getConfig();
    var isCustom = c.providerId === 'custom';
    var models = (c.provider.models || []);
    var provOpts = A.PROVIDERS.map(function (p) { return '<option value="' + p.id + '"' + (p.id === c.providerId ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('');
    var modelCtrl = (isCustom || !models.length)
      ? '<input type="text" class="mascot-inp" id="ai-model" placeholder="模型名，如 deepseek-chat" value="' + esc(c.model) + '">'
      : '<select class="mascot-inp" id="ai-model">' + models.map(function (m) { return '<option' + (m === c.model ? ' selected' : '') + '>' + esc(m) + '</option>'; }).join('') + '</select>';
    var h = '<div class="mascot-sec">接入模型</div>';
    h += '<div class="mascot-frow"><label>服务商</label><select class="mascot-inp" id="ai-prov">' + provOpts + '</select></div>';
    if (c.provider.note) h += '<div class="mascot-note">' + esc(c.provider.note) + (c.provider.keyUrl ? ' · <a href="#" id="ai-getkey" data-url="' + esc(c.provider.keyUrl) + '">获取 API key ↗</a>' : '') + '</div>';
    h += '<div class="mascot-frow"><label>模型</label>' + modelCtrl + '</div>';
    h += '<div class="mascot-frow"><label>接口地址</label><input type="text" class="mascot-inp" id="ai-base" value="' + esc(c.base) + '"' + (isCustom ? '' : ' readonly') + '></div>';
    h += '<div class="mascot-frow"><label>API Key</label><span class="mascot-keywrap">'
      + '<input type="password" class="mascot-inp" id="ai-key" autocomplete="off" placeholder="sk-…" value="' + esc(A.getKey()) + '">'
      + '<button type="button" class="pass-eye-btn" id="ai-key-eye" title="显示/隐藏">'
      + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
      + '</button></span></div>';
    h += '<div class="mascot-frow mascot-frow-end">'
      + '<span class="mascot-status' + (A.isConfigured() ? ' ok' : '') + '" id="ai-status">' + (A.isConfigured() ? '已就绪' : '待配置') + '</span>'
      + '<button type="button" class="mascot-btn" id="ai-test">测试连接</button></div>';
    h += row('显示深度思考', '推理型模型答题前的思考过程，可随时点开/收起；关闭则只看答案', '<span class="mascot-sw' + (A.showThink() ? ' on' : '') + '" id="think-sw" role="switch" tabindex="0"></span>');
    h += memSettingsHtml(A);
    return h;
  }
  function memSettingsHtml(A) {
    var on = A.memEnabled();
    var h = '<div class="mascot-sec">记忆</div>';
    h += row('允许小枝记住我的习惯', '默认关闭。开启后小枝发现值得记的点会先问你，同意才记', '<span class="mascot-sw' + (on ? ' on' : '') + '" id="mem-sw" role="switch" tabindex="0"></span>');
    if (!on) return h;
    h += row('记忆跟着云同步', '关闭 = 只存本机（更私密）；开启 = 换设备也记得', '<span class="mascot-sw' + (A.memCloud() ? ' on' : '') + '" id="mem-cloud" role="switch" tabindex="0"></span>');
    var cards = A.memList();
    h += '<div class="mascot-memlist" id="mem-list">';
    if (!cards.length) {
      h += '<div class="mascot-note">还没有记忆。和小枝聊天时它会在合适的时机问「要我记住吗？」。</div>';
    } else {
      cards.forEach(function (m, i) {
        h += '<div class="mascot-memrow">'
          + '<input type="text" class="mascot-inp mascot-meminp" data-idx="' + i + '" value="' + esc(m.t) + '" maxlength="200">'
          + '<button type="button" class="mascot-memdel" data-idx="' + i + '" title="删除这条">'
          + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>'
          + '</div>';
      });
      h += '<div class="mascot-frow mascot-frow-end"><span class="mascot-note">共 ' + cards.length + ' 条（上限 50，改完即存）</span>'
        + '<button type="button" class="mascot-btn" id="mem-clear">全部忘记</button></div>';
    }
    h += '</div>';
    return h;
  }
  var _panelSetEl = null;
  function rerender() { if (_panelSetEl) { _panelSetEl.innerHTML = settingsHtml(); bindPanel(); } }
  function bindPanel() {
    if (!_panelSetEl) return;
    var sw = _panelSetEl.querySelector('#mascot-sw');
    if (sw) {
      var toggleEn = function () {
        lset(K.enabled, isEnabled() ? '0' : '1');
        if (!isEnabled()) { _visible = false; _panelOpen = false; applyState(); }
        else if (isResident()) showAvatar('hi');
        rerender();
      };
      sw.addEventListener('click', toggleEn);
      sw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEn(); } });
    }
    var res = _panelSetEl.querySelector('#mascot-res');
    if (res) {
      var toggleRes = function () { setResident(!isResident()); rerender(); };
      res.addEventListener('click', toggleRes);
      res.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRes(); } });
    }
    var avaPick = _panelSetEl.querySelector('#mascot-ava-pick');
    if (avaPick) avaPick.addEventListener('click', function (e) {
      var b = e.target.closest('.mascot-em-opt'); if (!b) return;
      lset(K.avatar, b.dataset.em);
      var fb = _root && _root.querySelector('#mascot-avatar .mascot-fallback');
      if (fb) fb.textContent = b.dataset.em;
      var cur = _panelSetEl.querySelector('.mascot-ava-cur');
      if (cur) cur.textContent = b.dataset.em;
      avaPick.querySelectorAll('.mascot-em-opt').forEach(function (x) { x.classList.toggle('on', x === b); });
      if (isResident()) showAvatar(); // 立即看到效果
    });
    aiBind();
  }
  function aiBind() {
    var A = ai(); if (!A || !_panelSetEl) return;
    var prov = _panelSetEl.querySelector('#ai-prov');
    if (prov) prov.addEventListener('change', function () { A.setProvider(prov.value); rerender(); });
    var model = _panelSetEl.querySelector('#ai-model');
    if (model) { var save = function () { A.setModel(model.value); populateModel(); }; model.addEventListener('change', save); if (model.tagName === 'INPUT') model.addEventListener('blur', save); }
    var base = _panelSetEl.querySelector('#ai-base');
    if (base) base.addEventListener('change', function () { A.setBase(base.value); });
    var key = _panelSetEl.querySelector('#ai-key');
    if (key) {
      var saveKey = function () { A.setKey(key.value); aiStatus(); populateModel(); };
      key.addEventListener('change', saveKey);
      key.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveKey(); key.blur(); } });
      var eye = _panelSetEl.querySelector('#ai-key-eye');
      if (eye) eye.addEventListener('click', function () { key.type = key.type === 'password' ? 'text' : 'password'; });
    }
    var getk = _panelSetEl.querySelector('#ai-getkey');
    if (getk) getk.addEventListener('click', function (e) { e.preventDefault(); try { window.open(getk.dataset.url, '_blank'); } catch (_) {} });
    var test = _panelSetEl.querySelector('#ai-test');
    if (test) test.addEventListener('click', function () { aiTest(test); });
    var tsw = _panelSetEl.querySelector('#think-sw');
    if (tsw) {
      var tt = function () { A.setShowThink(!A.showThink()); rerender(); };
      tsw.addEventListener('click', tt);
      tsw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tt(); } });
    }
    memBind(A);
  }
  function memBind(A) {
    var sw = _panelSetEl.querySelector('#mem-sw');
    if (sw) {
      var t = function () { A.memSetEnabled(!A.memEnabled()); rerender(); };
      sw.addEventListener('click', t);
      sw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t(); } });
    }
    var cl = _panelSetEl.querySelector('#mem-cloud');
    if (cl) {
      var t2 = function () { A.memSetCloud(!A.memCloud()); rerender(); };
      cl.addEventListener('click', t2);
      cl.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t2(); } });
    }
    var list = _panelSetEl.querySelector('#mem-list');
    if (list) {
      list.addEventListener('change', function (e) {
        var inp = e.target.closest('.mascot-meminp');
        if (inp) { A.memUpdate(parseInt(inp.dataset.idx, 10), inp.value); rerender(); }
      });
      list.addEventListener('click', function (e) {
        var del = e.target.closest('.mascot-memdel');
        if (del) { A.memRemove(parseInt(del.dataset.idx, 10)); rerender(); }
      });
    }
    var clear = _panelSetEl.querySelector('#mem-clear');
    if (clear) clear.addEventListener('click', function () {
      if (clear.dataset.arm) { A.memClear(); rerender(); }
      else { clear.dataset.arm = '1'; clear.textContent = '确定全部忘记？'; setTimeout(function () { if (clear.isConnected) { delete clear.dataset.arm; clear.textContent = '全部忘记'; } }, 2500); }
    });
  }
  function setStatus(cls, text) {
    var el = _panelSetEl && _panelSetEl.querySelector('#ai-status');
    if (el) { el.className = 'mascot-status' + (cls ? ' ' + cls : ''); el.textContent = text; }
  }
  function aiStatus() {
    var A = ai(); if (!A) return;
    if (A.isConfigured()) setStatus('ok', '已就绪'); else setStatus('', '待配置');
  }
  function aiTest(btn) {
    var A = ai(); if (!A) return;
    if (!A.isConfigured()) { setStatus('warn', '先填好模型和 key'); return; }
    btn.disabled = true; var old = btn.textContent; btn.textContent = '测试中…';
    setStatus('', '正在连接…');
    var got = false;
    A.chat({
      plain: true,
      messages: [{ role: 'user', content: '只回复两个字：你好' }],
      onDelta: function () { got = true; },
      onDone: function () { btn.disabled = false; btn.textContent = old; if (got) setStatus('ok', '连接成功'); else setStatus('warn', '有响应但无内容，检查模型名'); },
      onError: function (err) { btn.disabled = false; btn.textContent = old; setStatus('err', (err && err.message) || '连接失败'); },
    });
  }
  function mountSettings(el) { if (!el) return; _panelSetEl = el; el.innerHTML = settingsHtml(); bindPanel(); }

  function setResident(v) {
    lset(K.resident, v ? '1' : '0');
    if (!isEnabled()) return;
    if (v) showAvatar('idle');
    else if (!_panelOpen) hideAvatar();
  }
  /** 快捷键切常驻（Alt+Shift+A，app.js 注册）；设置面板开着时让开关同步刷新 */
  function toggleResident() {
    var v = !isResident();
    setResident(v);
    if (_panelSetEl && _panelSetEl.isConnected) { try { mountSettings(_panelSetEl); } catch (_) {} }
    return v;
  }

  // ===== 从编辑区带着选中文字进对话（正文右键 / 悬浮工具栏入口）=====
  // kind：'ask' = 只打开面板（快捷动作条会自动出现）；其余 = ai.js ACTIONS 里的动作 id（润色/翻译/总结…）
  function askSelection(kind) {
    if (!isEnabled()) return;
    try { var ed = window.editor && window.editor.instance && window.editor.instance(); if (ed) { _selFrom = ed.state.selection.from; _selTo = ed.state.selection.to; } } catch (_) {}
    var txt = ai() ? ai().getSelectionText() : '';
    openPanel(); // openPanel → refreshChat → renderQuick 会重读选区并亮出快捷动作
    if (kind && kind !== 'ask' && txt) { _selText = txt; runAction(kind); }
  }

  // ===== 常驻小动作：闲时偶尔换个表情，悬浮冒一句闲话（让它更像个活物）=====
  /** 常驻按钮临时演一个表情（不传名字 = 随机），几秒后回到用户选的常驻形象。点击/右键/碎碎念/闲时都用它。 */
  var _avatarAnim = null, _avatarAnimTimer = null;
  function playAvatarMood(name, ms) {
    var fb = _avatar && _avatar.querySelector('.mascot-fallback');
    if (!fb) return;
    clearTimeout(_avatarAnimTimer);
    if (_avatarAnim) _avatarAnim.stop(false);
    _avatarAnim = animEmoji(fb, name || IDLE_SET[Math.floor(Math.random() * IDLE_SET.length)]);
    _avatarAnimTimer = setTimeout(function () {
      if (_avatarAnim) { _avatarAnim.stop(false); _avatarAnim = null; }
      if (fb.isConnected) fb.textContent = avatarGlyph();
    }, ms || 5200);
  }
  var _idlePlayTimer = null;
  function scheduleIdlePlay() {
    clearTimeout(_idlePlayTimer);
    _idlePlayTimer = setTimeout(idlePlay, 30000 + Math.random() * 30000); // 30s~1min 随机一次（用户嫌 45s~2.5min 太冷清）
  }
  function idlePlay() {
    scheduleIdlePlay();
    if (!isEnabled() || !_visible || _panelOpen || _streaming) return;
    if (document.visibilityState !== 'visible') return;
    playAvatarMood();
  }

  // 闲话池：让 AI 一次生成一批「小枝会自言自语的话」缓存在本机，悬浮时随机冒一句——
  // 既是"AI 说的话"又不用每次悬浮都花钱联网；池空/过期(3天)时后台补货，没配 AI 前用兜底句。
  var QUIP_KEY = '_aiQuips', QUIP_V = 2, _quipEl = null, _quipLast = 0, _quipFilling = false, _quipHideTimer = null;
  // v2：生成词里明令禁止编造主人的事（v1 池子有过「昨天待办没清」这种瞎编，用户实测；升版本号让旧池作废重生成）
  var QUIP_FALLBACK = ['（哼着不成调的小曲…）', '今天写点什么好呢？', '嗯？你在看我吗 👀', '灵感等是等不来的，先写两行试试？', '我猜你现在想摸鱼。', '（悄悄给你的笔记浇了点水）'];
  function quipPool() { try { var o = JSON.parse(lget(QUIP_KEY) || 'null'); return (o && o.v === QUIP_V && Array.isArray(o.lines) && o.lines.length) ? o : null; } catch (_) { return null; } }
  function quipRefill() {
    if (_quipFilling) return;
    var A = ai(); if (!A || !A.isConfigured()) return;
    _quipFilling = true;
    A.chat({
      plain: true, // 不要心情标记
      messages: [{ role: 'user', content: '你是笔记应用里的小吉祥物「小枝」🌱。写 12 句你闲着没事时的自言自语：中文，每句不超过 20 字，口语化、俏皮、彼此风格不同（哼歌、发呆、小吐槽、写作灵感、天气心情、打招呼都可以）。重要：你并不知道主人的任何具体情况，绝不能编造他的事——不要提他的待办、日程、计划、昨天做了什么之类。一行一句，不要编号、不要引号。' }],
      onDone: function (all) {
        _quipFilling = false;
        var lines = String(all || '').split('\n')
          .map(function (s) { return s.replace(/^[\s\-\d.、）)]+/, '').trim(); })
          .filter(function (s) { return s && s.length <= 40; });
        if (lines.length >= 4) lset(QUIP_KEY, JSON.stringify({ v: QUIP_V, t: Date.now(), lines: lines.slice(0, 20) }));
      },
      onError: function () { _quipFilling = false; },
    });
  }
  function pickQuip() {
    var p = quipPool();
    if (!p || Date.now() - (p.t || 0) > 3 * 86400000) quipRefill(); // 后台补货，本次先用手头的
    return (p ? p.lines : QUIP_FALLBACK)[Math.floor(Math.random() * (p ? p.lines.length : QUIP_FALLBACK.length))];
  }
  function showQuip(force) {
    if (!isEnabled() || !_visible || _panelOpen || _streaming) return;
    var now = Date.now(); if (!force && now - _quipLast < 20000) return; // 悬浮别太话痨；右键点它 = 主动搭话不限流
    _quipLast = now;
    if (!_quipEl) { _quipEl = document.createElement('div'); _quipEl.className = 'mascot-quip'; _root.appendChild(_quipEl); }
    _quipEl.textContent = pickQuip();
    _quipEl.classList.add('on');
    playAvatarMood(); // 碎碎念时配一个表情，像真在说话
    clearTimeout(_quipHideTimer);
    _quipHideTimer = setTimeout(hideQuip, 4200);
  }
  function hideQuip() { if (_quipEl) _quipEl.classList.remove('on'); }

  // ===== 初始化 =====
  function init() {
    ensureDom();
    installTrigger();
    if (isEnabled() && isResident()) showAvatar('idle');
    else applyState();
    _avatar.addEventListener('mouseenter', function () { showQuip(false); }); // 不能直接传 showQuip：事件对象会被当成 force
    scheduleIdlePlay();
    // 云端带下来的加密 key：本机没 key 时尝试用网盘密码解出（换设备免重填）
    try { ai() && ai().trySyncKeyDown(function () { rerender(); }); } catch (_) {}
    // 设置同步可能晚于启动到达，稍后再试一次
    setTimeout(function () { try { ai() && ai().trySyncKeyDown(function () { rerender(); }); } catch (_) {} }, 15000);
  }

  window.mascot = {
    init: init,
    toggle: toggle,
    openPanel: openPanel,
    closePanel: closePanel,
    setMood: setMood,
    flashMood: flashMood,
    setResident: setResident,
    toggleResident: toggleResident,
    isResident: isResident,
    askSelection: askSelection,
    isEnabled: isEnabled,
    mountSettings: mountSettings,
    renderMdInto: renderMd,
    mountChatBlock: mountChatBlock,
    insertChatBlock: insertChatBlock,
  };
})();
