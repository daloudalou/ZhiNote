/* 小枝 AI 引擎 —— OpenAI 兼容的对话内核。
 * 只负责「配置 + 联网对话」，形象/面板在 mascot.js，两者通过 window.aiChat 协作。
 *
 * 设计要点：
 *  - 服务商/模型/接口地址存普通设置（会随云同步跟着走）；API key 存本机、名字带 `_` 前缀（绝不上云）。
 *  - 对话走 OpenAI 兼容的 /chat/completions 流式接口，一套接大多数（DeepSeek/通义/智谱/Kimi/OpenAI…）。
 *  - 桌面 Quicker(WebView2) 直连即可；网页宿主多半被 CORS 挡，报友好提示。
 *  - 不碰笔记序列化：只在用户点「插入笔记」时才通过 editor.pasteText 写入。
 */
(function () {
  'use strict';

  // ===== 服务商预设（base 为 OpenAI 兼容地址；custom 由用户自填）=====
  var PROVIDERS = [
    { id: 'deepseek', name: 'DeepSeek 深度求索', base: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-v4-flash'],
      keyUrl: 'https://platform.deepseek.com/api_keys', note: '性价比高、推理强' },
    { id: 'qwen', name: '通义千问 Qwen（阿里）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen-plus', 'qwen-max', 'qwen-flash', 'qwen-turbo'],
      keyUrl: 'https://bailian.console.aliyun.com/', note: '全能、生态丰富' },
    { id: 'glm', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-4.6', 'glm-4.5-air', 'glm-4-flash', 'glm-4-plus'],
      keyUrl: 'https://bigmodel.cn/usercenter/apikeys', note: '中英均衡，glm-4-flash 免费' },
    { id: 'kimi', name: 'Kimi 月之暗面', base: 'https://api.moonshot.cn/v1',
      models: ['kimi-latest', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
      keyUrl: 'https://platform.moonshot.cn/console/api-keys', note: '超长上下文' },
    { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1',
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-4o'],
      keyUrl: 'https://platform.openai.com/api-keys', note: '需海外网络' },
    { id: 'claude', name: 'Anthropic Claude', base: 'https://api.anthropic.com/v1',
      models: ['claude-sonnet-5', 'claude-opus-4.8'],
      keyUrl: 'https://console.anthropic.com/', note: '写作/长文强（需海外网络）' },
    { id: 'gemini', name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
      models: ['gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-2.5-flash'],
      keyUrl: 'https://aistudio.google.com/apikey', note: '兼容端点（需海外网络）' },
    { id: 'custom', name: '自定义（其它兼容 OpenAI 的服务）', base: '',
      models: [], keyUrl: '', note: '自己填接口地址和模型名' },
  ];
  function provOf(id) { for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i]; return PROVIDERS[0]; }

  // ===== 设置存取 =====
  var SK = { provider: 'aiProvider', model: 'aiModel', base: 'aiBaseUrl', temp: 'aiTemp', key: '_aiKey', sysPrompt: 'aiSysPrompt' };
  function gs(k, d) { try { var v = window.storage && window.storage.getSetting(k); return (v == null || v === '') ? d : v; } catch (_) { return d; } }
  function ss(k, v) { try { window.storage && window.storage.setSetting(k, v); } catch (_) {} }

  // API key 本机保存：base64 轻混淆（不进云；名字带 `_` 前缀，_extractSharedSettings 会跳过）
  function encKey(s) { try { return s ? btoa(unescape(encodeURIComponent('zk:' + s))) : ''; } catch (_) { return ''; } }
  function decKey(b) { try { if (!b) return ''; var t = decodeURIComponent(escape(atob(b))); return t.indexOf('zk:') === 0 ? t.slice(3) : ''; } catch (_) { return ''; } }

  // key 按服务商分开存（_aiKeys = { 服务商id: 混淆key }）——切服务商时各用各的，不串
  //（用户实测反馈：换服务商后 key 框里还是上一家的）。旧版单条 _aiKey 自动当作当前服务商的迁移进来。
  function _keyMap() {
    var m = {};
    try { var o = JSON.parse(gs('_aiKeys', '{}')); if (o && typeof o === 'object') m = o; } catch (_) {}
    var legacy = gs(SK.key, '');
    if (legacy) { // 一次性迁移：老的单条 key 归到当前服务商名下
      var pid = gs(SK.provider, 'deepseek');
      if (!m[pid]) { m[pid] = legacy; ss('_aiKeys', JSON.stringify(m)); }
      ss(SK.key, '');
    }
    return m;
  }
  function getKeyFor(pid) { return decKey(_keyMap()[pid] || ''); }
  function getKey() { return getKeyFor(gs(SK.provider, 'deepseek')); }
  function setKey(s) {
    var m = _keyMap(); var pid = gs(SK.provider, 'deepseek');
    s = (s || '').trim();
    if (s) m[pid] = encKey(s); else delete m[pid];
    ss('_aiKeys', JSON.stringify(m));
    syncKeyUp();
  }
  function hasKey() { return !!getKey(); }

  // ===== 跨设备同步 key（不新增密码）=====
  // 原理：key 用「网盘密码」派生的密钥加密后存进会同步的设置 aiKeyEnc；
  // 换设备时本来就要输一次网盘密码配同步，配好即可自动解出 key。
  // 没开云同步 → 不上传；网盘密码不一致/密文损坏 → 静默忽略，key 仍只在本机。
  function _b64(buf) { var s = ''; for (var i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]); return btoa(s); }
  function _unb64(b) { var s = atob(b), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function _webdavPassPlain() {
    try {
      var enc = window.storage && window.storage.getSetting('webdavPass');
      if (!enc || !window.webdavSync || !window.webdavSync.aesDecrypt) return Promise.resolve('');
      return window.webdavSync.aesDecrypt(enc).catch(function () { return ''; });
    } catch (_) { return Promise.resolve(''); }
  }
  function _deriveAes(pass) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode('zhinote-aikey:' + pass), 'PBKDF2', false, ['deriveKey'])
      .then(function (km) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: enc.encode('zhinote-aikey-salt-v1'), iterations: 100000, hash: 'SHA-256' },
          km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }
  function _aesEnc(pass, plain) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return _deriveAes(pass).then(function (k) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(plain));
    }).then(function (ct) {
      var u = new Uint8Array(ct), buf = new Uint8Array(iv.length + u.length);
      buf.set(iv, 0); buf.set(u, iv.length); return _b64(buf);
    });
  }
  function _aesDec(pass, b64) {
    var buf = _unb64(b64);
    return _deriveAes(pass).then(function (k) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, k, buf.slice(12));
    }).then(function (pt) { return new TextDecoder().decode(pt); });
  }
  /** key 变更后：有网盘密码就把「全部服务商的 key」打包加密写进同步设置（全空时清云端密文） */
  function syncKeyUp() {
    var m = _keyMap(), plain = {}, any = false;
    for (var pid in m) { var k = decKey(m[pid]); if (k) { plain[pid] = k; any = true; } }
    _webdavPassPlain().then(function (pass) {
      if (!pass) return;
      if (!any) { ss('aiKeyEnc', ''); return; }
      _aesEnc(pass, JSON.stringify(plain)).then(function (b64) { ss('aiKeyEnc', b64); }).catch(function () {});
    });
  }
  /** 云端有密文：用网盘密码解出，把本机还没有的服务商 key 并进来（绝不覆盖本机已有）。有新增时回调。 */
  function trySyncKeyDown(cb) {
    var b64 = gs('aiKeyEnc', '');
    if (!b64) return;
    _webdavPassPlain().then(function (pass) {
      if (!pass) return;
      _aesDec(pass, b64).then(function (plain) {
        if (!plain) return;
        var incoming = {};
        if (plain.charAt(0) === '{') { try { incoming = JSON.parse(plain) || {}; } catch (_) { return; } }
        else incoming[gs(SK.provider, 'deepseek')] = plain; // 旧版密文是单条 key
        var m = _keyMap(), added = false;
        for (var pid in incoming) {
          if (!m[pid] && incoming[pid]) { m[pid] = encKey(incoming[pid]); added = true; }
        }
        if (added) { ss('_aiKeys', JSON.stringify(m)); cb && cb(); }
      }).catch(function () {});
    });
  }

  function getConfig() {
    var pid = gs(SK.provider, 'deepseek');
    var p = provOf(pid);
    var base = gs(SK.base, '') || p.base;
    var model = gs(SK.model, '') || (p.models[0] || '');
    return { providerId: pid, provider: p, base: base, model: model, key: getKey(),
      temp: parseFloat(gs(SK.temp, '0.6')) || 0.6, sysPrompt: gs(SK.sysPrompt, '') };
  }
  function setProvider(pid) {
    var p = provOf(pid);
    ss(SK.provider, pid);
    if (pid !== 'custom') { ss(SK.base, p.base); if (p.models.length) ss(SK.model, p.models[0]); }
  }
  function setModel(m) { ss(SK.model, m); }
  function setBase(b) { ss(SK.base, (b || '').trim()); }
  function isConfigured() { var c = getConfig(); return !!(c.base && c.model && c.key); }

  // ===== 记忆卡 =====
  // 设计见 docs/小枝AI功能设计与灵感.md 第六节：默认不记（总开关默认关）；
  // 记忆是很短的卡片（上限 50 条，超出丢最旧）；存哪由用户选——
  // 本机（_aiMemory，带 _ 前缀不上云）或云同步（aiMemory，随设置同步）。
  // 开关与位置选择本身随云同步，保证多设备行为一致。
  // 「深度思考」显示开关（推理型模型的思考流；关了就完全不显示，思考内容从不写进笔记）。
  // 默认关：思考流是模型的原始草稿，常会讨论设定/提示词等幕后内容，容易出戏（用户反馈）；想看的在设置里打开。
  function showThink() { return gs('aiShowThink', '0') === '1'; }
  function setShowThink(v) { ss('aiShowThink', v ? '1' : '0'); }

  var MEM_MAX = 50;
  function memEnabled() { return gs('aiMemOn', '') === '1'; }
  function memSetEnabled(v) { ss('aiMemOn', v ? '1' : ''); }
  function memCloud() { return gs('aiMemCloud', '') === '1'; }
  function _memKey() { return memCloud() ? 'aiMemory' : '_aiMemory'; }
  function memList() {
    try { var a = JSON.parse(gs(_memKey(), '[]')); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  function _memSave(a) { ss(_memKey(), JSON.stringify(a.slice(-MEM_MAX))); }
  function memAdd(t) {
    t = String(t || '').replace(/\s+/g, ' ').trim(); if (!t) return false;
    var a = memList();
    for (var i = 0; i < a.length; i++) if (a[i].t === t) return false;
    a.push({ t: t.slice(0, 200), d: Date.now() });
    _memSave(a); return true;
  }
  function memUpdate(idx, t) {
    var a = memList(); if (idx < 0 || idx >= a.length) return;
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (!t) a.splice(idx, 1); else a[idx].t = t.slice(0, 200);
    _memSave(a);
  }
  function memRemove(idx) { var a = memList(); if (idx >= 0 && idx < a.length) { a.splice(idx, 1); _memSave(a); } }
  function memClear() { ss('aiMemory', ''); ss('_aiMemory', ''); }
  /** 切换存储位置：把现有记忆搬到新位置，旧位置清空（转本机时同时删掉云端那份） */
  function memSetCloud(v) {
    var cards = memList();
    ss('aiMemCloud', v ? '1' : '');
    _memSave(cards);
    ss(v ? '_aiMemory' : 'aiMemory', '');
  }
  // ===== 自定义常用语（分组 + 图标）=====
  // 一句话指令（如「总结一下」「帮我润色」），一键调用省打字。数据随设置云同步（aiQuickCmds）。
  // v2 结构：{ v:2, groups:[{ n:分组名, items:[{ e:图标emoji, n:短名(可空), t:指令文本 }] }] }。
  // 预置组来自原「问小枝」右键菜单的动作（润色/续写/总结/整理/翻译），当普通常用语一样可删可改。
  var CMD_GMAX = 20, CMD_MAX = 200, MY_GROUP = '我的常用语';
  function _cmdDefaults() {
    return [
      { n: '写作', items: [
        { e: '✨', n: '润色', t: '请在保持原意和语言的前提下润色下面这段文字，使其更通顺自然、简洁得体，只输出润色后的文本' },
        { e: '✍️', n: '续写', t: '请顺着下面这段文字的语气和主题自然续写一段，只输出续写的内容' },
      ] },
      { n: '整理', items: [
        { e: '📌', n: '总结', t: '请用简洁的要点总结下面这段内容，只输出总结' },
        { e: '🧭', n: '整理', t: '请把下面这段内容整理成条理清晰的结构（标题+要点/列表），用 Markdown 输出' },
      ] },
      { n: '翻译', items: [
        { e: '🌐', n: '翻译', t: '请翻译下面这段文字：中文译为英文，其它语言译为中文。只输出译文' },
      ] },
    ];
  }
  function _cmdClean(it) {
    return { e: String(it.e || '⚡').slice(0, 8), n: String(it.n || '').replace(/\s+/g, ' ').trim().slice(0, 20), t: String(it.t || '').replace(/\s+/g, ' ').trim().slice(0, 300) };
  }
  function cmdGroups() {
    var raw = gs('aiQuickCmds', '');
    if (!raw) { var d = _cmdDefaults(); _cmdSaveGroups(d); return d; } // 首次：写入预置，之后随便删改
    try {
      var o = JSON.parse(raw);
      if (Array.isArray(o)) { // v1 平铺数组 → 预置组 + 归入「我的常用语」
        var g = _cmdDefaults();
        var mine = o.map(function (c) { return _cmdClean({ e: '⚡', t: c.t }); }).filter(function (i) { return i.t; });
        if (mine.length) g.push({ n: MY_GROUP, items: mine });
        _cmdSaveGroups(g); return g;
      }
      if (o && o.v === 2 && Array.isArray(o.groups)) return o.groups;
    } catch (_) {}
    return _cmdDefaults();
  }
  function _cmdSaveGroups(g) {
    g = (g || []).slice(0, CMD_GMAX);
    var total = 0;
    g.forEach(function (grp) { grp.items = (grp.items || []).filter(function (it) { total++; return total <= CMD_MAX; }); });
    ss('aiQuickCmds', JSON.stringify({ v: 2, groups: g }));
  }
  /** 平铺所有词条（带组内定位），给快捷条/右键菜单等用 */
  function cmdItems() {
    var out = [];
    cmdGroups().forEach(function (grp, gi) {
      (grp.items || []).forEach(function (it, ii) { out.push({ e: it.e || '⚡', n: it.n || '', t: it.t || '', gi: gi, ii: ii }); });
    });
    return out;
  }
  /** 快存一条（面板/块的「把当前输入存为常用语」）：进「我的常用语」组，没有就建 */
  function cmdAdd(t) {
    var it = _cmdClean({ e: '⚡', t: t }); if (!it.t) return false;
    var g = cmdGroups();
    for (var i = 0; i < g.length; i++) for (var j = 0; j < (g[i].items || []).length; j++) if (g[i].items[j].t === it.t) return false;
    var mine = null;
    for (var k = 0; k < g.length; k++) if (g[k].n === MY_GROUP) { mine = g[k]; break; }
    if (!mine) { mine = { n: MY_GROUP, items: [] }; g.push(mine); }
    mine.items.push(it);
    _cmdSaveGroups(g); return true;
  }
  function cmdAddItem(gi, it) { var g = cmdGroups(); if (!g[gi]) return; it = _cmdClean(it); if (!it.t) return; (g[gi].items = g[gi].items || []).push(it); _cmdSaveGroups(g); }
  function cmdUpdateItem(gi, ii, patch) {
    var g = cmdGroups(); var grp = g[gi]; if (!grp || !grp.items || !grp.items[ii]) return;
    var it = grp.items[ii];
    var merged = _cmdClean({ e: patch.e != null ? patch.e : it.e, n: patch.n != null ? patch.n : it.n, t: patch.t != null ? patch.t : it.t });
    if (!merged.t) grp.items.splice(ii, 1); else grp.items[ii] = merged;
    _cmdSaveGroups(g);
  }
  function cmdRemoveItem(gi, ii) { var g = cmdGroups(); if (g[gi] && g[gi].items && g[gi].items[ii]) { g[gi].items.splice(ii, 1); _cmdSaveGroups(g); } }
  function cmdAddGroup(name) {
    name = String(name || '').trim().slice(0, 12) || '新分组';
    var g = cmdGroups(); if (g.length >= CMD_GMAX) return -1;
    g.push({ n: name, items: [] }); _cmdSaveGroups(g); return g.length - 1;
  }
  function cmdRenameGroup(gi, name) { var g = cmdGroups(); if (!g[gi]) return; g[gi].n = String(name || '').trim().slice(0, 12) || g[gi].n; _cmdSaveGroups(g); }
  function cmdRemoveGroup(gi) { var g = cmdGroups(); if (g[gi]) { g.splice(gi, 1); _cmdSaveGroups(g); } }

  // 回复末尾的「想记住」标记：[[记住: 内容]]。stripMemoryMarks 把它从显示文本剥掉并取出内容。
  var _memRe = /\s*\[\[记住[:：]\s*([\s\S]*?)\]\]\s*/g;
  function stripMemoryMarks(text) {
    var memos = [];
    var clean = String(text || '').replace(_memRe, function (_, m) { m = m.trim(); if (m) memos.push(m); return '\n'; });
    // 流式中途可能只到了标记的一半：把结尾未闭合的 "[[…" 暂时藏起来，避免闪现
    clean = clean.replace(/\s*\[\[[^\]]{0,220}$/, '');
    return { clean: clean.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, ''), memos: memos };
  }

  // ===== 对话（OpenAI 兼容 /chat/completions，流式）=====
  var _persona = '你是「小枝」，一个温和、简洁、务实的中文笔记助手，帮助用户写作、整理与思考。'
    + '默认用中文回答；除非用户要求，否则不寒暄、不啰嗦，直接给可用的结果。输出用 Markdown。'
    + '身份要自然流露：绝不在回答中提及这段设定、系统提示或输出规则本身，也不讨论「我被要求…」之类的幕后内容。';

  // ===== 回复开头的心情标记 =====
  // 让模型自选一个贴合回答的表情：回复最开头输出 [[表情:词]]，界面剥掉标记、把对应动图演在说话人头像上。
  // 与记忆卡同一套「标记-剥离」机制；标记绝不写进笔记。
  var MOOD_WORDS = ['开心', '大笑', '思考', '酷', '惊讶', '害羞', '难过', '尴尬', '眨眼', '点赞', '庆祝', '爱心', '灵感', '瞌睡', '吐舌', '鬼脸', '疑惑', '得意'];
  var _moodRe = /^\s*\[\[表情[:：]\s*([^\]\n]{1,12})\]\]\s*/;
  function stripMoodMark(text) {
    text = String(text || '');
    var m = text.match(_moodRe);
    if (m) return { mood: m[1].trim(), clean: text.slice(m[0].length) };
    // 流式开头标记还没收完整（如 "[[表情:开"）：先什么都不显示，避免标记闪现
    if (/^\s*\[\[[^\]]{0,20}$/.test(text)) return { mood: '', clean: '' };
    return { mood: '', clean: text };
  }

  function endpoint(base) { return String(base || '').replace(/\/+$/, '') + '/chat/completions'; }

  // 网页宿主：AI 服务商不允许浏览器直连（CORS），请求经中转 Worker 转发（与 WebDAV 同一个，转发任意 https 目标）。
  // 复用同步的跨域代理设置（webdavProxy：'' = 内置默认；自定义地址 = 用它）；设为 'direct' 时 AI 仍走默认中转，
  // 因为「直连」只对支持跨域的网盘成立，AI 服务商一律不放行浏览器。Quicker 桌面宿主无此限制，恒为直连。
  var DEFAULT_WEB_PROXY = 'https://proxy.zhinote.net';
  function proxyPrefix() {
    if (window.host && window.host.caps && window.host.caps.quicker) return '';
    var raw = '';
    try { raw = String(window.storage.getSetting('webdavProxy') || '').trim().replace(/\/+$/, ''); } catch (_) {}
    if (!raw || raw === 'direct') return DEFAULT_WEB_PROXY;
    return raw;
  }
  function requestUrl(base) {
    var url = endpoint(base);
    var px = proxyPrefix();
    return px ? px + '/' + url : url;
  }

  /** 笔记全文（Markdown，截断），供「选择笔记」上下文用。不带 id = 当前打开的笔记（取编辑器实时内容）。 */
  var NOTE_CTX_MAX = 12000;
  function _clipCtx(md, title) {
    md = String(md || '')
      // 图片（尤其 base64）对模型无用还爆 token，剥掉只留占位。
      // 注意：调过尺寸的图片序列化成 HTML <img> 标签而非 ![...](...)（editor.js MdImage.renderMarkdown），
      // 之前漏掉它 → 模型收到 zhinote:// 链接后纠结「无法访问本地协议」（用户实测截图）。
      .replace(/<img\b[^>]*>/gi, '[图片]')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
      .replace(/data:image\/[^;\s)]+;base64,[A-Za-z0-9+/=]+/g, '[图片]')
      .replace(/zhinote:\/\/[^\s)"'<>]+/g, '[图片]')
      // 笔记里嵌的小枝对话块（JSON 围栏）是历史问答，不是正文——原样发过去又长又误导模型
      .replace(/```zhichat[\s\S]*?```/g, '[此处是一个小枝问答块，略]');
    var head = '【笔记' + (title ? '《' + title + '》' : '');
    if (!md.trim()) return head + '】\n（这篇笔记里没有可读的文字内容，只有图片等无法直接读取的元素。）';
    var clipped = md.length > NOTE_CTX_MAX;
    if (clipped) md = md.slice(0, NOTE_CTX_MAX);
    return head + '全文' + (clipped ? '（太长，已截取开头部分）' : '') + '】\n' + md;
  }
  function getNoteContext(id) {
    try {
      var curId = window.editor && window.editor.currentId ? window.editor.currentId() : null;
      if (!id || id === curId) {
        var md = window.editor && window.editor.getValue ? String(window.editor.getValue() || '') : '';
        var title = '';
        try { title = (document.getElementById('title-input') || {}).value || ''; } catch (_) {}
        return _clipCtx(md, title);
      }
      var n = window.storage && window.storage.get ? window.storage.get(id) : null;
      if (!n) return '';
      var md2 = '';
      if (n.doc && window.editor && window.editor.serializeDocToMd) md2 = window.editor.serializeDocToMd(n.doc) || '';
      if (!md2) md2 = n.content || '';
      return _clipCtx(md2, n.title || '');
    } catch (_) { return ''; }
  }

  /** 流式对话。opts: { messages:[{role,content}], noteContext:bool|string（true=当前笔记；字符串=现成的上下文文本）,
   *  onDelta(piece,full), onThink(piece,fullThink)（思考型模型的推理流，可选）, onDone(full), onError(err), signal } */
  function chat(opts) {
    var c = getConfig();
    if (!c.base || !c.model) { opts.onError && opts.onError(new Error('还没配置模型，请到设置 → 小枝 填接口地址和模型')); return; }
    if (!c.key) { opts.onError && opts.onError(new Error('还没填 API key，请到设置 → 小枝 填入')); return; }

    var sys = (c.sysPrompt && c.sysPrompt.trim()) ? c.sysPrompt.trim() : _persona;
    // 记忆卡：开了总开关才注入已有记忆、并允许 AI 提议新记忆（标记会被界面剥掉转成确认卡，见 mascot.js）
    if (memEnabled() && !opts.plain) {
      var cards = memList();
      if (cards.length) sys += '\n\n关于这位用户你记得这些（供参考，别复述）：\n' + cards.map(function (m) { return '- ' + m.t; }).join('\n');
      sys += '\n\n若本轮对话透露了值得长期记住的用户信息（职业、习惯、稳定偏好），在回答最后另起一行输出 [[记住: 一句话概括]]（最多一条，不确定就不输出）。';
    }
    // 心情标记（界面会剥掉并演成动图表情；quiet 场景如后台生成不需要）
    if (!opts.plain) {
      sys += '\n\n每次回答的最开头，先单独输出一个心情标记，格式 [[表情:词]]，词从以下挑一个最贴合本次回答的：'
        + MOOD_WORDS.join('、') + '。输出完标记就正常回答，绝不提及或解释这个标记。';
    }
    var messages = [{ role: 'system', content: sys }].concat(opts.messages || []);
    // 笔记上下文并进「最后一条用户消息」而非 system 消息：推理型模型（deepseek-reasoner/R1 等）
    // 官方建议不用系统提示、实测会忽略它——之前放 system 导致「带上本篇」形同虚设、模型声称
    // 看不到笔记（用户两轮实测反馈）。放进用户消息对所有模型都成立。
    if (opts.noteContext) {
      var ctx = typeof opts.noteContext === 'string' ? opts.noteContext : getNoteContext();
      if (ctx) {
        for (var mi = messages.length - 1; mi >= 0; mi--) {
          if (messages[mi].role === 'user') {
            // 换成新对象，不动调用方持有的历史记录
            messages[mi] = { role: 'user', content: '【随问题附上的笔记资料，回答以此为准】\n' + ctx + '\n\n【我的问题】\n' + messages[mi].content };
            break;
          }
        }
      }
    }
    var body = { model: c.model, messages: messages, stream: true, temperature: c.temp };
    // 联网检索：有服务端开关的服务商默认打开（能用就用，不做开关——用户拍板）。
    // 通义兼容口用 enable_search；智谱用 web_search 工具。其它家没有这种"一个参数就联网"的
    // 服务端开关（Kimi 的要多轮工具调用），乱塞参数会被严格接口拒收，所以不加。
    if (c.providerId === 'qwen') body.enable_search = true;
    else if (c.providerId === 'glm') body.tools = [{ type: 'web_search', web_search: { enable: true } }];

    fetch(requestUrl(c.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key },
      body: JSON.stringify(body),
      signal: opts.signal,
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          var msg = _friendlyErr(resp.status, t);
          throw new Error(msg);
        });
      }
      if (!resp.body || !resp.body.getReader) {
        // 不支持流：退回一次性读取
        return resp.text().then(function (t) { var full = _parseNonStream(t); opts.onDelta && opts.onDelta(full); opts.onDone && opts.onDone(full); });
      }
      return _readStream(resp.body.getReader(), opts);
    }).catch(function (e) {
      if (e && e.name === 'AbortError') { opts.onAbort && opts.onAbort(); return; }
      opts.onError && opts.onError(_wrapNetErr(e));
    });
  }

  function _readStream(reader, opts) {
    var dec = new TextDecoder();
    var buf = '', full = '', think = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) { opts.onDone && opts.onDone(full); return; }
        buf += dec.decode(r.value, { stream: true });
        var lines = buf.split('\n');
        buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || line.indexOf('data:') !== 0) continue;
          var data = line.slice(5).trim();
          if (data === '[DONE]') { opts.onDone && opts.onDone(full); return; }
          try {
            var j = JSON.parse(data);
            var d = j.choices && j.choices[0] && j.choices[0].delta;
            var piece = d && (d.content || '');
            // 思考型模型（deepseek-reasoner 等）的推理流：单独回调，界面可实时展示「思考过程」
            var rz = d && (d.reasoning_content || d.reasoning || '');
            if (rz) { think += rz; opts.onThink && opts.onThink(rz, think); }
            if (piece) { full += piece; opts.onDelta && opts.onDelta(piece, full); }
          } catch (_) {}
        }
        return pump();
      });
    }
    return pump();
  }

  function _parseNonStream(t) {
    try { var j = JSON.parse(t); return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''; }
    catch (_) { return ''; }
  }
  function _friendlyErr(status, t) {
    var detail = '';
    try { var j = JSON.parse(t); detail = (j.error && (j.error.message || j.error.code)) || j.message || ''; } catch (_) { detail = (t || '').slice(0, 160); }
    if (status === 401 || status === 403) return 'API key 无效或没权限（' + status + '）：' + detail;
    if (status === 402) return '余额不足或未开通（402）：' + detail;
    if (status === 404) return '接口地址或模型名不对（404）：' + detail;
    if (status === 429) return '请求太频繁 / 额度用尽（429）：' + detail;
    if (status >= 500) return '服务商暂时出错（' + status + '），稍后再试';
    return '请求失败（' + status + '）：' + detail;
  }
  function _wrapNetErr(e) {
    var m = (e && e.message) || '';
    if (/Failed to fetch|NetworkError|CORS|Load failed/i.test(m)) {
      var web = !(window.host && window.host.caps && window.host.caps.quicker);
      return new Error(web
        ? '连不上（中转服务不可达或网络异常）。请检查网络；自定义过跨域代理的，确认其为新版（支持 AI 转发）。'
        : '连不上服务商，请检查网络与接口地址是否正确。');
    }
    return e instanceof Error ? e : new Error(String(m || '未知错误'));
  }

  // （原「选中文字动作」ACTIONS 已并入常用语预置组 _cmdDefaults：润色/续写/翻译/总结/整理，可删可改）

  /** 读取编辑器当前选中的纯文本（没有则空串）。只读，不改文档。 */
  function getSelectionText() {
    try {
      var ed = window.editor && window.editor.instance && window.editor.instance();
      if (!ed) return '';
      var sel = ed.state.selection;
      if (!sel || sel.empty) return '';
      return ed.state.doc.textBetween(sel.from, sel.to, '\n', '\n') || '';
    } catch (_) { return ''; }
  }
  /** 把文本插入到编辑器光标处（走 pasteText，按 Markdown 解析）。 */
  function insertToEditor(text) {
    try { if (window.editor && window.editor.pasteText) { window.editor.focus && window.editor.focus(); window.editor.pasteText(String(text || '')); return true; } } catch (_) {}
    return false;
  }

  window.aiChat = {
    PROVIDERS: PROVIDERS, provOf: provOf,
    getConfig: getConfig, isConfigured: isConfigured, hasKey: hasKey,
    getKey: getKey, getKeyFor: getKeyFor, setKey: setKey,
    syncKeyUp: syncKeyUp, trySyncKeyDown: trySyncKeyDown,
    setProvider: setProvider, setModel: setModel, setBase: setBase,
    setTemp: function (t) { ss(SK.temp, String(t)); },
    setSysPrompt: function (s) { ss(SK.sysPrompt, (s || '').trim()); },
    chat: chat,
    getSelectionText: getSelectionText, insertToEditor: insertToEditor,
    getNoteContext: getNoteContext,
    showThink: showThink, setShowThink: setShowThink,
    memEnabled: memEnabled, memSetEnabled: memSetEnabled,
    memCloud: memCloud, memSetCloud: memSetCloud,
    memList: memList, memAdd: memAdd, memUpdate: memUpdate, memRemove: memRemove, memClear: memClear,
    cmdGroups: cmdGroups, cmdItems: cmdItems, cmdAdd: cmdAdd,
    cmdAddItem: cmdAddItem, cmdUpdateItem: cmdUpdateItem, cmdRemoveItem: cmdRemoveItem,
    cmdAddGroup: cmdAddGroup, cmdRenameGroup: cmdRenameGroup, cmdRemoveGroup: cmdRemoveGroup,
    stripMemoryMarks: stripMemoryMarks,
    stripMoodMark: stripMoodMark, MOOD_WORDS: MOOD_WORDS,
  };
})();
