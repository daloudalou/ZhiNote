/**
 * realtime.js —— 即时同步客户端（CRDT 大改 阶段6）
 *
 * 在网盘同步之上加一条「快车道」：两端打开同一篇笔记时，谁一保存，改动经中转约 0.5 秒到对方
 *   （仅靠网盘轮询要 10~30 秒）。网盘永远兜底，中转断开只是退回网盘、绝不丢数据。
 *
 * 颗粒度：按保存触发（存盘去抖 0.3s，端到端约 0.5s）；不动编辑器内核、零风险。逐字母实时不做。
 *
 * 设计原则（关键）：中转只是「傻瓜转发的群」，所有聪明都在本文件（随发布自动更新），
 *   中转一行都不用改 —— 故自建用户永不用升级中转。具体靠两条 WebSocket：
 *   1) 内容房间（按笔记）：走加密的账本载荷。t19 起优先发**增量**（几十字节），换篇/断线/新人加入
 *      发全量兜底；收端影子试并发现漏包 → ybreq 向对端索要全量。中转存「最近一份」给后到设备引导。
 *   2) 信令房间（按工作区）：走明文小消息——在场招呼/心跳（决定是否值得发正文）、结构变更暗号。
 *
 * 在场感知：进信令房间先喊一声，没人应就不发正文（零浪费）；有人应才互发并各推一份对齐。
 * 结构暗号：置顶/删/改名等在「本端这次改动真正写进网盘那一刻」才发一句「我改了，快同步」，
 *   对端立刻 doGet 拉网盘——数据仍走久经考验的网盘逻辑，零新增合并风险。
 *   （旧实现是「改完猜 1.5 秒」发暗号，常常暗号比上传先到 → 对端白拉一趟 → 慢/偶尔同步不上。）
 * 不打断打字：对端内容到达时若本端正在打字，先把它合进 pending 暂存，等停手再落地刷新。
 * 账本对齐：只在本端 note.ydoc 已存在（= 经存储/同步维护、同源可合并）时才走快车道，
 *   否则退回普通网盘同步，避免不同源账本合并导致重复。
 *
 * 隐私（命门）：正文发出前用同步口令加密（webdavSync.rtEncrypt）→ 中转只见密文；
 *   房间号由口令 + 网盘账号哈希得出（webdavSync.rtRoomId），他人既进不来也解不开。
 *   v5 起房间前缀换成 zhinote-room-v5:，旧版即时进不了新房间（网盘闸停了仍防中转灌旧结构）。
 */
(function () {
  'use strict';

  const SIGNAL_SEED = '__zhinote_signal__';
  // 心跳自适应：账号内有别的设备在线 → 5s 快心跳维持在场（对端 TTL 13s 内）；独自一人 → 30s 慢心跳，
  //   仅作保活/NAT 维持。新设备加入靠事件驱动的 hi/yo 即时发现，不依赖心跳，故独自时放慢不影响发现。
  //   这是免费中转额度的大头（独自挂机也每 5s 发 → 放慢可省 5~6 倍）。
  const HEARTBEAT_PEER_MS = 5000;   // 有别的设备在线：快心跳
  const HEARTBEAT_ALONE_MS = 30000; // 独自一人：慢心跳
  const PEER_TTL_MS = 13000;     // 超过此时间没收到「同篇」对端信令 → 视为无人同看本篇（容 2 次丢心跳 + 余量）
  const RECONNECT_MAX = 30000;
  // 账号级在场（账号级信令房间里任何对端消息都刷新）：用于「即时同步紫点 + 心跳提速 + 结构直推门控」。
  //   只要账号内有别的设备在线（不论看哪篇/没开笔记/只改结构）就算「正在即时同步」。对端在场时双方都走 5s 快心跳，
  //   故与 note 级同用 13s TTL 即可跟手；异常断线约 13s 内熄灭，正常切后台/关闭由 wsbye 立即熄灭。
  const SIG_PEER_TTL_MS = 13000;
  const STRUCT_DEBOUNCE_MS = 150; // 结构变更去抖：连改多项只推一次最新总账（压到 150ms，向正文同步速度看齐）
  const STRUCT_REPLY_DEBOUNCE_MS = 150; // 切入接力回应去抖：多端同时索要 → 合并成一次广播
  const SYNC_PULSE_MS = 1800; // 「正在传数据」脉冲时长：发/收正文或结构后这段时间内紫点呼吸，过后转常亮

  // 【2026-06-25 t7 大改：即时同步快车道重新启用】t6 曾整层睡眠止血；现按用户要求做"结构提速 + 字符级实时"，
  //   重新开启本层（结构变更经信令房间 ~150ms 直推，远快于网盘轮询的 10~30s；正文经内容房间/账号级直推）。
  //   绿点狂转已在 t6 于 app.js 单独修好（与本层无关）；本层睡眠期间网盘同步照常，恢复后网盘仍兜底。
  const _DISABLED = false;

  let _enabled = false;
  let _base = '';
  let _activeId = null;
  let _sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  // 设备形态：手机/平板/Quicker客户端/网页；每次发送时现取（host 可能稍后就绪）。展示不含本机、不含「枝记」。
  function _currentDevKind() {
    try {
      const ua = navigator.userAgent || '';
      const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      const short = Math.min(screen.width || 0, screen.height || 0);
      const isQuicker = !!(window.host && typeof window.host.isQuicker === 'function' && window.host.isQuicker());
      // 触控短边优先：手机端 Quicker WebView 的 UA 常不像 Mobile，勿先打成「客户端」
      if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua) || (coarse && short >= 600 && short < 1100)) return 'tablet';
      if (/Mobi|iPhone|iPod|Android.*Mobile|Phone/i.test(ua) || (coarse && short > 0 && short < 600)) return 'phone';
      if (isQuicker && coarse) return short >= 600 ? 'tablet' : 'phone';
      if (isQuicker) return 'quicker';
    } catch (_) {}
    return 'web';
  }
  // 对端在场表：sid → { kind, at }；旧端无 dev → other
  let _peers = Object.create(null);

  // 内容房间
  let _ws = null;
  let _roomId = null;
  let _connectAt = 0;            // 内容房间本次 connect 发起时刻 → 看门狗据此判「卡在半连接」强制重连
  let _applyingRemote = false;
  let _pendingYb = null;         // 打字期间暂存的对端载荷（增量/全量混合，Y.mergeUpdates 级联，不丢缺依赖部分）
  let _pendingTimer = null;
  let _reconnectTimer = null;
  let _reconnectDelay = 2000;

  // ── 增量直推（t19 C2）：发端记「上次发到哪」的指纹，此后只发新增几笔（几十字节 vs 整本几 KB+）──
  //   指纹失效（换篇/断线/新设备加入）→ 退回发全量。收端见「中间漏包」→ ybreq 向对端要全量。
  let _sentSV = null, _sentSVNote = null;          // 内容房间：上次发出后的账本指纹（同篇同连接内有效）
  let _sigSentSV = Object.create(null);            // 账号级直推：id → 指纹（对端进出/重连即清空 → 回全量）
  let _ybReqAt = Object.create(null);              // 全量索要节流：id → 上次索要时刻（3s 一次防风暴）
  function _resetContentSV() { _sentSV = null; _sentSVNote = null; }
  function _resetSigSV() { _sigSentSV = Object.create(null); }

  // 信令房间
  let _sig = null;
  let _sigRoomId = null;
  let _sigConnectAt = 0;         // 信令房间本次 connect 发起时刻 → 看门狗据此判「卡在半连接」强制重连
  let _sigReconnectTimer = null;
  let _sigReconnectDelay = 2000;
  let _hbTimer = null;
  let _peerSeenAt = 0;           // 最近一次见到「同看本篇」对端的时刻
  let _sigPeerSeenAt = 0;        // 最近一次收到「账号内」任意对端信令的时刻（结构直推门控）
  let _structSendTimer = null;   // 结构总账直推去抖
  let _structReplyTimer = null;  // 切入接力回应去抖（合并多端同时索要）
  let _lastSentLedger = '';      // 上次发出的结构总账（去重：内容没变不重发）
  let _lastSentAt = 0;           // 上次发出结构总账的时刻（force 回应也据此短时去重，压制重连风暴）
  let _offline = false;          // 显式离线：宿主隐藏/最小化/关闭、或页面不可见 → 主动断开两房间；看门狗不自愈，直到显式恢复。
  let _byeTimer = null;          // 离线消抖：短暂失焦不立刻断（防抖动）；恢复即取消。
  // 服务器实报在场：中转在有人进/出房间时广播 {__zr:'occ',n}（含本端）。这是在场状态的**权威来源**，
  //   即时又可靠 → 取代心跳超时猜测。收到过即置 _occSupported=true 改用实报人数；
  //   旧中转不发此消息 → _occSupported 保持 false，退回心跳 TTL 兜底（向后兼容，不影响旧中转用户）。
  let _occSupported = false;
  let _sigOcc = 0;               // 信令(账号级)房间人数(含本端) → 紫点「在场」权威
  let _wsOcc = 0;                // 内容(按篇)房间人数(含本端) → 「是否值得发正文」门控权威
  let _syncPulseAt = 0;          // 最近一次「真正传数据」（发/收正文或结构）的时刻 → 紫点呼吸窗口
  let _syncPulseTimer = null;

  function _setting() {
    try { return (window.storage.getSetting('webdavRealtime') || '').trim(); } catch (_) { return ''; }
  }

  // 在场判定：服务器实报人数可用时以它为准（≥2 = 有别的设备，即时可靠）；否则退回心跳 TTL 兜底（旧中转）。
  function _peerPresent() { return _occSupported ? (_wsOcc >= 2) : ((Date.now() - _peerSeenAt) < PEER_TTL_MS); }
  function _sigPeerPresent() { return _occSupported ? (_sigOcc >= 2) : ((Date.now() - _sigPeerSeenAt) < SIG_PEER_TTL_MS); }
  /** 诊断日志（默认静默）：控制台执行 window.__RT_DIAG__=true 打开，排查同步用。 */
  function _D() { try { if (window.__RT_DIAG__) console.log.apply(console, ['[rt]'].concat([].slice.call(arguments))); } catch (_) {} }
  /** 通知界面刷新「即时同步」指示灯（紫点）。 */
  function _notifyStatus() { try { window.dispatchEvent(new CustomEvent('zhinote-rt-status')); } catch (_) {} }

  function _normDev(d) {
    if (d === 'phone' || d === 'tablet' || d === 'quicker' || d === 'web' || d === 'pc') return d;
    if (d === '客户端') return 'quicker';
    if (d === '网页') return 'web';
    if (d === '电脑') return 'pc'; // 旧版未区分客户端/网页
    if (d === '手机') return 'phone';
    if (d === '平板') return 'tablet';
    return 'other';
  }
  function _devZh(k) {
    if (k === 'quicker') return '客户端';
    if (k === 'web') return '网页';
    if (k === 'pc') return '电脑'; // 仅旧端
    if (k === 'phone') return '手机';
    if (k === 'tablet') return '平板';
    return '其他';
  }
  function _prunePeers() {
    const now = Date.now();
    for (const sid in _peers) {
      if (now - (_peers[sid].at || 0) > SIG_PEER_TTL_MS) delete _peers[sid];
    }
  }
  function _touchPeer(sid, dev) {
    if (!sid || sid === _sid) return;
    const prev = _peers[sid];
    // 无 dev：只续命，不新建「其他」（人数先到、形态后到时曾误显示「其他」）
    if (dev == null || dev === '') {
      if (prev) prev.at = Date.now();
      else _peers[sid] = { kind: null, at: Date.now() };
      return;
    }
    const kind = _normDev(dev);
    if (kind === 'other') {
      if (prev) { prev.at = Date.now(); if (!prev.kind) prev.kind = null; }
      else _peers[sid] = { kind: null, at: Date.now() };
      return;
    }
    _peers[sid] = { kind: kind, at: Date.now() };
  }
  function _clearPeers() { _peers = Object.create(null); }
  /** 仅对端已知形态：例「客户端 · 网页2」。不补「其他」、不含本机。 */
  function _presenceInfo() {
    _prunePeers();
    const kinds = [];
    const seen = Object.keys(_peers);
    for (let i = 0; i < seen.length; i++) {
      const k = _peers[seen[i]].kind;
      if (k && k !== 'other') kinds.push(k);
    }
    let otherN = seen.length;
    if (_occSupported && (_sigOcc | 0) >= 1) otherN = Math.max(0, (_sigOcc | 0) - 1);
    const order = ['quicker', 'web', 'pc', 'phone', 'tablet'];
    const counts = Object.create(null);
    for (let i = 0; i < kinds.length; i++) counts[kinds[i]] = (counts[kinds[i]] || 0) + 1;
    const parts = [];
    for (let i = 0; i < order.length; i++) {
      const k = order[i];
      const n = counts[k] | 0;
      if (!n) continue;
      const zh = _devZh(k);
      parts.push(n > 1 ? (zh + n) : zh);
    }
    return {
      others: otherN,
      text: parts.join(' · '),
      self: _devZh(_currentDevKind()),
    };
  }
  /** 标记「正在传数据」：刷新呼吸窗口并即时通知界面；窗口结束再通知一次，让紫点准时转回常亮。 */
  function _pulse() {
    _syncPulseAt = Date.now();
    _notifyStatus();
    clearTimeout(_syncPulseTimer);
    _syncPulseTimer = setTimeout(_notifyStatus, SYNC_PULSE_MS + 50);
  }

  /** 即时同步是否「具备启用条件」：必须选了网盘且填了地址+用户名。
   *  关键（隐私/正确性）：房间号由「网盘账号 + 口令」哈希得出，未配网盘时账号为空，
   *  会让不同用户落入同一默认房间、互收对方加密结构（默认口令可解）。故无网盘一律不启用。 */
  function _webdavConfigured() {
    try {
      if (window.storage.getSetting('syncMethod') !== 'webdav') return false;
      return !!((window.storage.getSetting('webdavUrl') || '').trim() && (window.storage.getSetting('webdavUser') || '').trim());
    } catch (_) { return false; }
  }

  /** 读设置 → 决定开关与中转地址，并据此连/断当前笔记。设置变更后由 app.js 调用。 */
  function applyConfig() {
    if (_DISABLED) { try { _leaveSig(); } catch (_) {} _enabled = false; _disconnect(); _sigDisconnect(); _notifyStatus(); return; }
    try { _base = window.webdavSync.resolveRelay(_setting()); } catch (_) { _base = ''; }
    const on = !!_base && _webdavConfigured();
    if (!on) { _leaveSig(); _enabled = false; _disconnect(); _sigDisconnect(); _notifyStatus(); return; }
    _enabled = true;
    _ensureSignal();
    if (_activeId) _ensureRoom(_activeId);
    _notifyStatus();
  }

  /** 编辑器打开/关闭笔记时调用（editor.open/close 里接线）。 */
  function onActiveNote(id) {
    if (id === _activeId) return;
    if (_activeId) _sigSend({ rt: 'bye', sid: _sid, note: _activeId }); // 告诉同看者：我离开这篇了 → 对端收起「同篇」在场（仍在工作区）
    const hadNote = !!_activeId;
    _activeId = id || null;
    _peerSeenAt = 0;                       // 换篇 → 同篇在场重新探测
    _pendingYb = null;
    _resetContentSV();                     // 换篇 → 增量指纹作废，下次先发全量
    if (!_enabled) return;
    if (!_activeId) {                      // 关掉所有笔记：仅关内容房间；信令(账号级在场+结构)继续连着
      _disconnect();                       // → 本端仍在线，紫点不灭、结构照旧即时
      _peerSeenAt = 0; _notifyStatus();    // 同篇在场清空（正文互推停），账号级在场不变
      _ensureSignal();                     // 确保信令仍连（防之前未连上）
      return;
    }
    _ensureSignal();
    _ensureRoom(_activeId);
    _sigSend({ rt: 'hi', sid: _sid, note: _activeId }); // 进新笔记 → 招呼，让同看者推一份给我
  }

  // ── 内容房间 ───────────────────────────────────────────────────────────────
  async function _ensureRoom(id) {
    if (!_enabled || !id) return;
    if (_offline) return; // 显式离线（隐藏/最小化）期间，任何入口都不得把内容房间建回来；恢复统一走 _goOnline
    const note = window.storage && window.storage.get(id);
    if (!note) { _disconnect(); return; }
    let roomId;
    try { roomId = await window.webdavSync.rtRoomId((note.workspaceId || '') + ':' + id); }
    catch (_) { return; }
    if (id !== _activeId) return;
    if (_ws && _roomId === roomId && _ws.readyState <= 1) return;
    _disconnect();
    _roomId = roomId;
    _connect();
  }

  function _connect() {
    if (!_base || !_roomId) return;
    const url = _base + '/room/' + encodeURIComponent(_roomId);
    let ws;
    try { ws = new WebSocket(url); } catch (_) { _scheduleReconnect(); return; }
    _ws = ws;
    _connectAt = Date.now();
    const myRoom = _roomId;
    ws.onopen = function () { _reconnectDelay = 2000; };
    ws.onmessage = function (ev) { if (_ws === ws) _onContent(ev.data); };
    ws.onclose = function () {
      // 尊重显式离线：宿主隐藏/最小化期间内容房间断了**绝不**自己重连（与信令房间 _sigConnect 一致），
      //   否则隐藏后这条 socket 可能僵尸式复活、紫点该灭不灭。恢复由 _goOnline 统一接管。
      if (_ws === ws) { _ws = null; if (_enabled && !_offline && _activeId && _roomId === myRoom) _scheduleReconnect(); }
    };
    ws.onerror = function () { if (ws.readyState === 1) { try { ws.close(); } catch (_) {} } };
  }

  function _scheduleReconnect() {
    clearTimeout(_reconnectTimer);
    const delay = _reconnectDelay;
    _reconnectTimer = setTimeout(function () { if (_enabled && !_offline && _activeId) _ensureRoom(_activeId); }, delay);
    _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX);
  }

  function _quietClose(ws) {
    if (!ws) return;
    try {
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === 1) ws.close();
      else if (ws.readyState === 0) ws.onopen = function () { try { ws.close(); } catch (_) {} };
    } catch (_) {}
  }

  function _disconnect() {
    clearTimeout(_reconnectTimer); _reconnectTimer = null;
    clearTimeout(_pendingTimer); _pendingTimer = null;
    _pendingYb = null;
    _resetContentSV();           // 断开 → 指纹作废（重连后对端可能换过人/漏过包），下次先发全量
    _wsOcc = 0;                  // 内容房间断开 → 本篇在场人数清零
    if (_ws) {
      _quietClose(_ws);
      _ws = null;
    }
    _roomId = null;
  }

  /** 把本端当前笔记的账本发往内容房间。仅在「有人同看 + 账本已存在」时才发。
   *  t19 增量直推：有上次指纹 → 只发新增几笔（信封 {__zn:'u',m:'d'}）；否则发全量（m:'f'）。
   *  指纹在发送成功后才推进——发失败下次仍从旧指纹起算，对端不缺包；真缺包也有 ybreq 全量兜底。 */
  async function _sendLocal(id) {
    if (!_ws || _ws.readyState !== 1 || !id || id !== _activeId) return;
    if (!_peerPresent()) return;            // 没人同看 → 不发，零浪费
    const note = window.storage && window.storage.get(id);
    if (!note || !note.ydoc) return;        // 账本未建（同源未定）→ 退回网盘，不走快车道
    try {
      let mode = 'f', payload = note.ydoc;
      try {
        if (_sentSVNote === id && _sentSV) {
          const d = window.__ydoc.diff(note.ydoc, _sentSV);
          if (d && d.length < payload.length) { payload = d; mode = 'd'; }
        }
      } catch (_) { mode = 'f'; payload = note.ydoc; }
      const cipher = await window.webdavSync.rtEncrypt(payload);
      if (_ws && _ws.readyState === 1 && id === _activeId) {
        _ws.send(JSON.stringify({ __zn: 'u', m: mode, yb: cipher }));
        try { _sentSV = window.__ydoc.sv(note.ydoc); _sentSVNote = id; } catch (_) { _resetContentSV(); }
        _pulse();
        _D('发正文(内容房)', mode === 'd' ? '增量' : '全量', cipher.length, '字节');
      }
    } catch (_) {}
  }

  /** #2 跨笔记即时：把本端当前编辑这篇的账本(加密)经**账号级信令房间**直推给所有在线设备——
   *  无论对端此刻是否同看本篇。对端收到后：在看本篇→即时落地重载；没看本篇→后台并入本地存储，
   *  于是它一切过去就是最新的。仅在「账号内有别的设备在场」时才发（独自则不发，零浪费、单设备无影响）。
   *  与内容房间(_sendLocal)互补：内容房间走「同看对端」的快路；这条覆盖「没同看的对端」。
   *  二者对同一篇可能各送一份，但落地是幂等的(账本相同→_realtimeApply 返回 false 不重载)，不会重复出问题。 */
  async function _broadcastNoteUpd(id) {
    if (!_sig || _sig.readyState !== 1 || !id) return;
    if (!_sigPeerPresent()) return;                       // 账号内没别的设备 → 不发
    const note = window.storage && window.storage.get(id);
    if (!note || !note.ydoc) return;                      // 账本未建（同源未定）→ 退回网盘，不走快车道
    try {
      // t19 增量直推：对这篇发过且期间无设备进出 → 只发新增几笔；否则全量。收端漏包有 ybreq 兜底。
      let mode = 'f', payload = note.ydoc;
      try {
        const known = _sigSentSV[id];
        if (known) {
          const d = window.__ydoc.diff(note.ydoc, known);
          if (d && d.length < payload.length) { payload = d; mode = 'd'; }
        }
      } catch (_) { mode = 'f'; payload = note.ydoc; }
      const cipher = await window.webdavSync.rtEncrypt(payload);
      if (_sig && _sig.readyState === 1) {
        _sigSend({ rt: 'noteupd', sid: _sid, id: id, m: mode, yb: cipher });
        try { _sigSentSV[id] = window.__ydoc.sv(note.ydoc); } catch (_) { delete _sigSentSV[id]; }
        _pulse();
        _D('发正文(账号级)', mode === 'd' ? '增量' : '全量', cipher.length, '字节');
      }
    } catch (_) {}
  }
  /** 收到账号级直推的正文载荷（增量或全量，收端统一处理、自动识别漏包）：
   *  当前打开这篇→走 _ingestActiveYb（含打字暂存/重载）；否则后台并入存储。 */
  async function _onNoteUpd(id, cipher) {
    if (!id || !cipher) return;
    let plainYb;
    try { plainYb = await window.webdavSync.rtDecrypt(cipher); } catch (_) { return; } // 口令不符/非本人 → 忽略
    if (!plainYb) return;
    if (id === _activeId) _ingestActiveYb(id, plainYb);
    else _applyRemoteBackground(id, plainYb);
  }

  // ── 漏包兜底：收端发现载荷缺依赖（中间丢过消息）→ 向账号内对端索要一份全量账本 ────────
  function _requestYbFull(id) {
    if (!id || !_sig || _sig.readyState !== 1) return;
    const now = Date.now();
    if (_ybReqAt[id] && now - _ybReqAt[id] < 3000) return;   // 3s 节流：pending 期间可能连收多条增量
    _ybReqAt[id] = now;
    _sigSend({ rt: 'ybreq', sid: _sid, id: id });
    _D('缺依赖(中间漏包) → 索要全量', id);
  }
  /** 对端喊「我缺账」→ 把本端这篇的整本账（加密）经 noteupd(m:'f') 发回。 */
  async function _replyYbFull(id) {
    if (!_sig || _sig.readyState !== 1 || !id) return;
    const note = window.storage && window.storage.get(id);
    if (!note || !note.ydoc) return;
    try {
      const cipher = await window.webdavSync.rtEncrypt(note.ydoc);
      if (_sig && _sig.readyState === 1) { _sigSend({ rt: 'noteupd', sid: _sid, id: id, m: 'f', yb: cipher }); _pulse(); _D('回发全量账本', id); }
    } catch (_) {}
  }

  function _abToStr(buf) {
    try {
      const u8 = new Uint8Array(buf); let s = '';
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return s;
    } catch (_) { return ''; }
  }

  /** 收到内容房间的消息：解密 → 按「是否正在打字」决定立即落地或暂存。
   *  t19 起本端发的是 JSON 信封 {__zn:'u',m:'d'|'f',yb:密文}；旧端裸密文（=全量）仍兼容收。 */
  async function _onContent(data) {
    const raw = (typeof data === 'string') ? data : _abToStr(data);
    if (!raw) return;
    let cipher = raw;
    // 明文 JSON 以 '{'(123) 开头；密文 base64 不会。两类 JSON：服务器在场广播 __zr / 本端信封 __zn。
    if (raw.charCodeAt(0) === 123) {
      try {
        const c = JSON.parse(raw);
        if (c && c.__zr === 'occ') { _occSupported = true; _wsOcc = c.n | 0; _notifyStatus(); return; }
        if (c && c.__zn === 'u' && c.yb) cipher = c.yb;
        else return;                                     // 不认识的 JSON → 忽略
      } catch (_) { return; }
    }
    const id = _activeId;
    if (!id) return;
    let plainYb;
    try { plainYb = await window.webdavSync.rtDecrypt(cipher); } catch (_) { return; } // 非本人/口令不符 → 忽略
    if (!plainYb || id !== _activeId) return;
    _ingestActiveYb(id, plainYb);
  }

  /** 落地「当前打开这篇」的对端账本：正在打字则先暂存合并、停手再落地（不打断输入）；否则即时落地重载。
   *  内容房间(_onContent)与账号级直推(_onNoteUpd 命中当前篇)共用，逻辑单一。 */
  function _ingestActiveYb(id, plainYb) {
    if (!plainYb || id !== _activeId) return;
    const note = window.storage && window.storage.get(id);
    if (!note) return;
    // 本端无账本 → 不再绕去云端重拉（那样会和对端的上传抢跑、扑空），改为「后到设备领用」：
    //   直接收下对端账本作同源基线，第一推就能即时落地（见 _applyRemote）。
    // 正在打字：先合进 pending、不动编辑器，停手后再落地（避免打断输入 / 误删对端改动）。
    //   t19：改用 mergeUpdates（载荷级合并）——增量/全量混合都不丢；旧 merge() 走 Doc 会把缺依赖的增量静默丢掉。
    const busy = (() => { try { return !!(window.editor && window.editor.isBusyTyping && window.editor.isBusyTyping()); } catch (_) { return false; } })();
    if (busy) {
      try { _pendingYb = _pendingYb ? window.__ydoc.mergeUpdates([_pendingYb, plainYb]) : plainYb; } catch (_) { _pendingYb = plainYb; }
      _scheduleApplyPending();
      return;
    }
    _applyRemote(id, plainYb);
  }

  /** 后台落地「当前没打开的那篇」的对端载荷（增量/全量）：与 _applyRemote 同等的冲突安全策略
   *  （影子试并防漏包 / 同源合并 / 无账本领用 / 有未上传脏改动且无账本 → 退网盘安全合并），
   *  唯一区别是不重载编辑器（这篇没开着）。单设备无对端时根本不会被调用，日常网盘同步零影响。 */
  function _applyRemoteBackground(id, plainYb) {
    const note = window.storage && window.storage.get(id);
    if (!note) return;                                   // 本端没有这篇 → 由 structreq/notereq 的「建出」通道处理，这里不造笔记
    if (!note.ydoc) {
      // 安全闸：本篇有未上传的本地改动且无账本 → 不直接领用（会盖掉本地改动），退回网盘走冲突安全合并
      let dirty = false;
      try { dirty = window.storage.getDirtyNoteIds().indexOf(id) >= 0; } catch (_) {}
      if (dirty) { try { window.webdavSync.doGet({ force: true, silent: true }); } catch (_) {} return; }
    }
    try {
      // 影子试并：增量若缺依赖（中间漏过包）→ 不落地、向对端要全量；全量载荷永不缺依赖，行为同旧版。
      const r = window.__ydoc.applyDiff(note.ydoc || '', plainYb);
      if (r.pending) { _requestYbFull(id); return; }
      const merged = r.b64;
      const mergedDoc = window.__ydoc.toDoc(merged);
      _applyingRemote = true;
      const changed = window.storage._realtimeApply(id, mergedDoc, merged);
      _applyingRemote = false;
      if (changed) _pulse();                             // 后台并入对端正文 → 紫点呼吸（无需重载，这篇没开着）
    } catch (_) {
      _applyingRemote = false;
      try { window.webdavSync.doGet({ force: true, silent: true }); } catch (_) {} // 账本引擎异常 → 退回网盘兜底
    }
  }

  function _scheduleApplyPending() {
    clearTimeout(_pendingTimer);
    _pendingTimer = setTimeout(function () {
      const id = _activeId;
      if (!id || !_pendingYb) { _pendingYb = null; return; }
      let busy = false;
      try { busy = !!(window.editor && window.editor.isBusyTyping && window.editor.isBusyTyping()); } catch (_) {}
      if (busy) { _scheduleApplyPending(); return; }      // 还在打 → 继续等
      try { if (window.editor && window.editor.flushSaveNow) window.editor.flushSaveNow(); } catch (_) {} // 先并入本端最新
      const yb = _pendingYb; _pendingYb = null;
      _applyRemote(id, yb);
    }, 600);
  }

  /** 落地对端载荷（增量/全量统一）→ 当前笔记则就地打补丁/重载（保光标）。
   *  t19 顺序：①影子试并防漏包（缺依赖 → 要全量、本次不落地）；②直绑就把**原始载荷**并入活账本
   *  （Y.applyUpdate 对增量/全量同样适用，活账本 ⊇ 影子基线，影子通过则活账本必通过）；
   *  ③非直绑走存储合并。本端尚无账本 → 领用（没账本=没改过本地，领用不盖本地改动）。 */
  function _applyRemote(id, plainYb) {
    const note = window.storage && window.storage.get(id);
    if (!note) return;
    // ① 影子试并：不动真实数据。pending=增量缺依赖（中间漏包）→ 要全量，本次不落地。
    //   全量载荷永不 pending → 行为与旧版一致。领用场景（本端无账本）：增量必 pending → 自动转全量索要。
    let merged;
    try {
      const r = window.__ydoc.applyDiff(note.ydoc || '', plainYb);
      if (r.pending) { _requestYbFull(id); return; }
      merged = r.b64;
    } catch (_) {
      try { window.webdavSync.doGet({ force: true, silent: true }); } catch (_) {} // 账本引擎异常 → 退回网盘兜底
      return;
    }
    // ② 阶段 C 绑定模式 + 这篇正打开着 → 原始载荷并入编辑器活账本：ySync 就地打补丁，
    //   光标不跳、不整篇重载、不打断输入法。落地后由编辑器把 note.doc/ydoc 持久化+标脏。
    try {
      if (window.editor && window.editor.isCrdtBound && window.editor.isCrdtBound()
          && window.editor.currentId && window.editor.currentId() === id
          && window.editor.applyRemoteUpdate) {
        _applyingRemote = true;
        const ok = window.editor.applyRemoteUpdate(id, plainYb);
        _applyingRemote = false;
        if (ok) { _pulse(); return; }
      }
    } catch (_) { _applyingRemote = false; }
    if (!note.ydoc) {
      // 安全闸：本端无账本但本篇有未上传的本地改动 → 不直接领用（会盖掉本地改动），退回网盘走冲突安全合并
      let dirty = false;
      try { dirty = window.storage.getDirtyNoteIds().indexOf(id) >= 0; } catch (_) {}
      if (dirty) { try { window.webdavSync.doGet({ force: true, silent: true }); } catch (_) {} return; }
    }
    // ③ 非直绑：落地影子合并结果
    try {
      const mergedDoc = window.__ydoc.toDoc(merged);
      _applyingRemote = true;
      const changed = window.storage._realtimeApply(id, mergedDoc, merged);
      _applyingRemote = false;
      if (changed) _pulse();                               // 收到并落地对端正文 → 紫点呼吸
      if (changed && window.editor && window.editor.currentId && window.editor.currentId() === id) {
        try { window.editor.reloadCurrent(); } catch (_) {}
      }
    } catch (_) {
      _applyingRemote = false;
      try { window.webdavSync.doGet({ force: true, silent: true }); } catch (_) {} // 账本引擎异常 → 退回网盘兜底
    }
  }

  // ── 信令房间（在场感知 + 结构暗号）────────────────────────────────────────
  async function _ensureSignal() {
    if (!_enabled) return;                          // 账号级：开 App 即连，不再要求先打开某篇笔记
    if (_offline) return;                           // 显式离线期间不得建回信令（对端会重新看到紫点）；恢复统一走 _goOnline
    let roomId;
    // 账号级在场/结构房间：只按账号(网盘账号+口令)派生，与笔记本/笔记无关 →
    //   任意设备一上线就互相可见、任意笔记本的结构改动都即时送达每台在线设备。
    try { roomId = await window.webdavSync.rtRoomId(SIGNAL_SEED); }
    catch (_) { return; }
    if (_sig && _sigRoomId === roomId && _sig.readyState <= 1) return;
    _sigDisconnect();
    _sigRoomId = roomId;
    _sigConnect();
  }

  function _sigConnect() {
    if (!_base || !_sigRoomId) return;
    const url = _base + '/room/' + encodeURIComponent(_sigRoomId);
    let ws;
    try { ws = new WebSocket(url); } catch (_) { _sigScheduleReconnect(); return; }
    _sig = ws;
    _sigConnectAt = Date.now();
    const myRoom = _sigRoomId;
    ws.onopen = function () {
      _sigReconnectDelay = 2000;
      if (_sig === ws) {                                 // 连上即招呼+索要结构（无论是否已打开笔记）
        _sigSend({ rt: 'hi', sid: _sid, note: _activeId || null });
        _sigSend({ rt: 'structreq', sid: _sid });        // 切入接力：上线即索要一份最新结构总账
      }
      _startHeartbeat();
    };
    ws.onmessage = function (ev) { if (_sig === ws) _onSignal(ev.data); };
    ws.onclose = function () {
      // 招呼房间是「账号级」的（与开不开笔记无关）：只要 App 启用中且没被隐藏就必须自愈重连，
      //   绝不再绑死在 _activeId 上——否则一旦在「没开笔记」时断一下，就永不重连 → 对端对你彻底隐身，
      //   直到你碰巧切回窗口/点开笔记才"莫名其妙"亮起紫点（=用户报的"找不到规律"）。显式离线时不重连，恢复由 _goOnline 接。
      if (_sig === ws) { _sig = null; _stopHeartbeat(); _sigOcc = 0; if (_enabled && !_offline && _sigRoomId === myRoom) _sigScheduleReconnect(); }
    };
    ws.onerror = function () { if (ws.readyState === 1) { try { ws.close(); } catch (_) {} } };
  }

  function _sigScheduleReconnect() {
    clearTimeout(_sigReconnectTimer);
    const delay = _sigReconnectDelay;
    _sigReconnectTimer = setTimeout(function () { if (_enabled && !_offline) _ensureSignal(); }, delay);
    _sigReconnectDelay = Math.min(_sigReconnectDelay * 2, RECONNECT_MAX);
  }

  function _sigDisconnect() {
    clearTimeout(_sigReconnectTimer); _sigReconnectTimer = null;
    clearTimeout(_structSendTimer); _structSendTimer = null;
    clearTimeout(_structReplyTimer); _structReplyTimer = null;
    _sigOcc = 0;                 // 信令房间断开 → 账号级在场人数清零
    _resetSigSV();               // 重连后对端可能漏过包 → 账号级增量指纹作废，先发全量
    _clearPeers();
    _stopHeartbeat();
    if (_sig) {
      _quietClose(_sig);
      _sig = null;
    }
    _sigRoomId = null;
  }

  function _sigSend(obj) {
    try {
      if (_sig && _sig.readyState === 1) {
        // 每条信令带设备形态，供对端展示「电脑/手机/平板」（旧端忽略未知字段）
        _sig.send(JSON.stringify(Object.assign({ dev: _currentDevKind() }, obj)));
      }
    } catch (_) {}
  }

  /** 告诉同工作区对端「我离开了」→ 对端立即收起在场（紫点立刻熄灭），不必等 13s 超时。
   *  用于：关掉所有笔记 / 切后台隐藏 / 关闭即时同步。异常断线（直接杀进程）发不出，仍由 TTL 兜底。 */
  function _leaveSig() { _sigSend({ rt: 'wsbye', sid: _sid }); }

  // 自调度心跳：每次按「当前是否有人同看」决定下次间隔（快 5s / 慢 30s）。
  function _startHeartbeat() {
    _stopHeartbeat();
    const tick = function () {
      if (_offline) return;                                // 离线期间不发（连接也已断），避免无谓动作
      _sigSend({ rt: 'hb', sid: _sid, note: _activeId || null }); // 即使没开笔记也保活在场（账号级）
      _hbTimer = setTimeout(tick, _sigPeerPresent() ? HEARTBEAT_PEER_MS : HEARTBEAT_ALONE_MS);
    };
    _hbTimer = setTimeout(tick, _sigPeerPresent() ? HEARTBEAT_PEER_MS : HEARTBEAT_ALONE_MS);
  }
  function _stopHeartbeat() { if (_hbTimer) { clearTimeout(_hbTimer); _hbTimer = null; } }

  /** 见到「同看本篇」的对端：刷新在场时刻；若由「无人」转「有人」，推一份账本给对方对齐，
   *  并立即转快心跳 + 补发一拍，确保对端 TTL(13s) 内持续收到本端在场。 */
  function _markPeer() {
    const was = _peerPresent();
    _peerSeenAt = Date.now();
    if (!was) {
      _sendLocal(_activeId);
      if (_activeId) _sigSend({ rt: 'hb', sid: _sid, note: _activeId }); // 立即保活，不等下一拍
      _startHeartbeat();                                                  // 重排为快心跳
      _notifyStatus();                                                    // 由「无人→有人」→ 点亮紫点
    }
  }

  function _onSignal(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : _abToStr(data)); } catch (_) { return; }
    if (msg && msg.__zr === 'occ') {                    // 服务器实报账号级房间人数 → 紫点在场权威
      const prevOcc = _sigOcc;
      _occSupported = true; _sigOcc = msg.n | 0; _prunePeers(); _notifyStatus();
      if (_sigOcc !== prevOcc) _resetSigSV();           // 有设备进出 → 账号级增量指纹作废，下次发全量（新设备没有前情）
      return;
    }
    if (!msg || msg.sid === _sid) return;               // 忽略自己的回声
    if (msg.rt !== 'hb') _D('收到信令', msg.rt);          // 心跳太密不打印，其余都记
    if (msg.rt === 'wsbye') {                            // 对端离开工作区（切后台/关笔记/关同步）→ 立即收起在场
      if (msg.sid) delete _peers[msg.sid];
      _sigPeerSeenAt = 0; _peerSeenAt = 0; _notifyStatus(); // 多端时剩余对端的下一拍心跳(≤5s)会自动恢复
      return;
    }
    if (msg.rt === 'sync') {                             // 旧结构暗号（兜底保留）：对端改了结构未走快车道 → 拉一次网盘
      try { window.webdavSync.doGet({ force: true, silent: true }); } catch (_) {}
      return;
    }
    _touchPeer(msg.sid, msg.dev);
    const _wasWsPeer = _sigPeerPresent();
    _sigPeerSeenAt = Date.now();                        // 收到任意对端信令 → 账号内有设备在场（紫点 + 心跳提速 + 结构门控）
    if (!_wasWsPeer) {                                  // 由「独自→有对端」
      _startHeartbeat(); _notifyStatus();               // 点亮紫点 + 转快心跳
      // 拉一次网盘，把对端（或本端）独自/离线期间攒下的全部改动快速对齐，之后转入即时
      try { window.webdavSync && window.webdavSync.doGet && window.webdavSync.doGet({ silent: true }); } catch (_) {}
    } else {
      _notifyStatus();                                  // 刷新人数/设备形态展示
    }
    if (msg.rt === 'hi') {
      _sigSend({ rt: 'yo', sid: _sid, note: _activeId }); // 一律回应（含跨篇）→ 对端立刻知道我在、秒点亮
      _resetSigSV();                                      // 新对端上线（或重连）→ 它没有前情，账号级下次发全量
      if (msg.note && msg.note === _activeId) {           // 同看本篇 → 互推正文
        _resetContentSV();                                //   内容房间同理：给它的第一份必须是全量
        const wasP = _peerPresent();
        _markPeer();                                      //   无人→有人 时 _markPeer 自己会推一份（全量）
        if (wasP) _sendLocal(_activeId);                  //   已有人在场（第 2+ 台加入）→ 补推一份全量给新来的
      }
      _scheduleStructReply();                             // 切入接力：补推一份结构总账（多端同时来则合并）
    } else if (msg.rt === 'yo' || msg.rt === 'hb') {
      if (msg.note && msg.note === _activeId) _markPeer();
    } else if (msg.rt === 'bye') {
      // 对端只是离开本篇（仍在工作区）→ 收起「同篇」在场（停正文互推），紫点不变（工作区仍有人）
      if (msg.note && msg.note === _activeId) _peerSeenAt = 0;
    } else if (msg.rt === 'struct') {
      _onStructSignal(msg.yb, msg.ep);                    // 结构快车道：并入 + 落地（秒级一致；网盘兜底；带世代闸防陈旧删除）
    } else if (msg.rt === 'structreq') {
      _scheduleStructReply();                             // 切入接力：把本端当前总账推给刚进来的设备
    } else if (msg.rt === 'notereq') {
      _replyNotes(msg.ids);                               // 对端缺笔记 → 把本端有的整篇发回
    } else if (msg.rt === 'ybreq') {
      _replyYbFull(msg.id);                               // 对端漏包缺账 → 回发这篇的全量账本
    } else if (msg.rt === 'note') {
      _onNoteSignal(msg.id, msg.yb);                      // 收到整篇 → 本端缺则就地建出（秒级出现）
    } else if (msg.rt === 'noteupd') {
      _onNoteUpd(msg.id, msg.yb);                          // #2 账号级正文直推 → 当前篇落地重载 / 其它篇后台并入
    }
  }

  // ── 结构快车道：把本端结构总账（加密）经信令房间即时推给同工作区对端 ──────────────
  /** 推一份本端最新结构总账。
   *  force=true（回应 structreq/hi 的「切入接力」）：必发，确保后到设备能拿到（哪怕内容与上次相同）。
   *  force=false（结构变更广播）：内容与上次广播相同则跳过，避免重复发整份总账浪费额度。 */
  // ── 权威恢复闸：覆盖恢复 /「覆盖云端」期间，临时拒收对端的「结构 / 整篇笔记」直推 ──────────
  //   背景：A 恢复后到「覆盖云端」把世代号升上去之间有几秒空窗。落后的 B 若抢在此刻把它的旧结构
  //   （带着旧删除记录）经快车道推回 A，会把 A 刚恢复的笔记又删掉（世代闸还没生效）。
  //   恢复期间一律拒收这两类「会改变笔记集合」的入站，彻底堵死回灌；正文(noteupd)非破坏性，不拦。
  //   用计数（可嵌套：app 包住「导入+镜像」、镜像内部再包一层），带 120s 安全超时绝不卡死。
  let _authResetDepth = 0;
  let _authResetTimer = null;
  function beginAuthoritativeReset() {
    _authResetDepth++;
    if (_authResetTimer) clearTimeout(_authResetTimer);
    _authResetTimer = setTimeout(function () { _authResetDepth = 0; _authResetTimer = null; _D('权威恢复闸 安全超时自动归零'); }, 120_000);
    _D('权威恢复闸 +1 =', _authResetDepth);
  }
  function endAuthoritativeReset() {
    _authResetDepth = Math.max(0, _authResetDepth - 1);
    _D('权威恢复闸 -1 =', _authResetDepth);
    if (_authResetDepth === 0) {
      if (_authResetTimer) { clearTimeout(_authResetTimer); _authResetTimer = null; }
      // 恢复完成 → 主动把本端「新权威结构」推给在场对端（force 必发）：B 收到后自身世代较低，
      //   会经世代闸去拉网盘按新世代采纳，从而对齐到 A，而不会反过来污染 A。
      try { _scheduleStructReply(); } catch (_) {}
    }
  }

  // 本端已采纳的权威世代号（覆盖云端/恢复会 +1 并对齐本机）。null=本账号首次未记录/未配同步。
  // 用于「结构入口世代闸」：随结构直推一起带上，让对端判断我们是否落后。
  function _myEpoch() {
    try { const e = window.webdavSync && window.webdavSync.getAdoptedEpoch && window.webdavSync.getAdoptedEpoch(); return (typeof e === 'number') ? e : null; } catch (_) { return null; }
  }
  async function _pushStruct(force) {
    if (!_enabled || _offline || !_sig || _sig.readyState !== 1) { _D('推结构 跳过: enabled=', _enabled, 'offline=', _offline, 'sig=', _sig && _sig.readyState); return; }
    let b64;
    try { b64 = window.storage._webdavGetStructLedger && window.storage._webdavGetStructLedger(); } catch (_) { b64 = null; }
    if (!b64) { _D('推结构 跳过: 总账为空(引擎未就绪?)'); return; }
    if (!force && b64 === _lastSentLedger) { _D('推结构 跳过: 与上次相同(去重)'); return; }
    // 注意：force 回应(structreq/hi)**绝不去重**——它是对端「我要正确结构」的明确请求，
    //   哪怕同一份也必须回发，否则对端会卡在错误/陈旧状态无法和解（structreq 已由 _scheduleStructReply 150ms 去抖合并，不会风暴）。
    try {
      const cipher = await window.webdavSync.rtEncrypt(b64);
      if (_sig && _sig.readyState === 1) { _sigSend({ rt: 'struct', sid: _sid, ep: _myEpoch(), yb: cipher }); _lastSentLedger = b64; _lastSentAt = Date.now(); _pulse(); _D('推结构 已发送 字节=', cipher.length, 'force=', !!force); }
    } catch (e) { _D('推结构 加密失败', e); }
  }
  /** 结构变更后去抖直推（仅在「同工作区有对端在场」时才发，独自则省额度、留给网盘兜底）。 */
  function _scheduleStructBroadcast() {
    clearTimeout(_structSendTimer);
    _structSendTimer = setTimeout(function () {
      if (!_sigPeerPresent()) { _D('广播定时器: 无对端在场, 不发(留给网盘)'); return; }
      _pushStruct(false);                                 // 广播：去重
    }, STRUCT_DEBOUNCE_MS);
  }
  /** 回应「切入接力」（structreq/hi）：去抖合并多端同时索要，最终只广播一次（必发）。 */
  function _scheduleStructReply() {
    clearTimeout(_structReplyTimer);
    _structReplyTimer = setTimeout(function () { _pushStruct(true); }, STRUCT_REPLY_DEBOUNCE_MS);
  }
  /** 收到对端结构总账：按「创世/认领」规则并入并落地（落地只动元数据、不碰正文、不造空壳）。
   *  网盘仍兜底；不回推（避免 ping-pong），对端各自变更时各推各的，靠 structreq 接力补齐。 */
  async function _onStructSignal(cipher, peerEp) {
    if (_authResetDepth > 0) { _D('收结构 忽略: 权威恢复进行中(防旧结构回灌)'); return; }
    if (!cipher) { _D('收结构 空'); return; }
    // ── 结构入口世代闸：只接受「同世代 / 任一方世代未知」的对端结构直推 ──────────────────
    //   背景：覆盖云端/恢复会把权威世代号 +1。落后的设备仍带着旧墓碑（删除记录），若让它经此
    //   快车道把陈旧结构直接并进本端权威账本，会"隔空删除"刚恢复的笔记（R1/R2 数据风险）。
    //   • 对端世代更低（落后）→ 忽略，绝不并入；它自己会经网盘按新世代「采纳」对齐。
    //   • 对端世代更高（本端落后）→ 不乱并它（可能是半成品），改为受限拉一次网盘按世代整体采纳（安全路）。
    //   • 任一方世代未知（老客户端/未配同步/首账号）→ 维持原合并，向后兼容、不破坏既有秒级体验。
    const myEp = _myEpoch();
    if (typeof peerEp === 'number' && typeof myEp === 'number' && peerEp !== myEp) {
      if (peerEp < myEp) { _D('收结构 忽略: 对端世代落后', peerEp, '<', myEp, '(防陈旧删除)'); return; }
      _D('收结构 对端世代更高', peerEp, '>', myEp, '→ 拉网盘按世代采纳(不直并)');
      _scheduleLedgerPull();
      return;
    }
    let b64;
    try { b64 = await window.webdavSync.rtDecrypt(cipher); } catch (e) { _D('收结构 解密失败(口令不符?)', e); return; } // 口令不符/非本人 → 忽略
    if (!b64) { _D('收结构 解密为空'); return; }
    try {
      const res = window.storage._webdavApplyStructLedger(b64);
      _D('收结构 已落地 changed=', res && res.changed, 'removed=', res && res.removed && res.removed.length, 'missing=', res && res.missing);
      if (res && res.changed) _pulse();                    // 收到并落地对端结构变更 → 紫点呼吸
      // 总账提到本端还没有的笔记（如对端刚新建）→ ①直接向对端索要整篇正文，秒级建出；②同时拉网盘兜底。
      if (res && res.missing && res.missing.length) { _D('收结构 缺笔记→索要', res.missing); _requestNotes(res.missing); _scheduleLedgerPull(); }
    } catch (e) { _D('收结构 落地失败', e); }
  }

  // 总账引用了本端缺失的笔记 → 受限地拉一次网盘补正文（至多 ~5s 一次，避免请求风暴）。
  let _ledgerPullTimer = null, _lastLedgerPull = 0;
  function _scheduleLedgerPull() {
    if (_ledgerPullTimer) return;
    const since = Date.now() - _lastLedgerPull;
    const wait = since > 5000 ? 300 : (5000 - since);
    _ledgerPullTimer = setTimeout(function () {
      _ledgerPullTimer = null; _lastLedgerPull = Date.now();
      try { window.webdavSync.doGet({ silent: true }); } catch (_) {}
    }, wait);
  }

  // ── 缺失笔记「点对点」补全：对端新建/本端缺的笔记，直接向在线对端索要整篇正文，不干等网盘 ──────
  /** 向账号内对端广播：我缺这些笔记的正文，谁有谁发我。 */
  function _requestNotes(ids) {
    if (!_sig || _sig.readyState !== 1 || !ids || !ids.length) return;
    const uniq = [];
    for (let i = 0; i < ids.length; i++) { const id = ids[i]; if (id && uniq.indexOf(id) < 0) uniq.push(id); }
    if (uniq.length) _sigSend({ rt: 'notereq', sid: _sid, ids: uniq });
  }
  /** 收到对端索要 → 把本端拥有的这些笔记整篇(加密)逐条发回，供对端就地建出。 */
  async function _replyNotes(ids) {
    if (!_sig || _sig.readyState !== 1 || !Array.isArray(ids)) return;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]; if (!id) continue;
      let note;
      try { note = window.storage && window.storage.get(id); } catch (_) { note = null; }
      if (!note) { _D('被索要但本端也没有', id); continue; } // 本端也没有 → 跳过（别的在线设备可能有）
      try {
        const cipher = await window.webdavSync.rtEncrypt(JSON.stringify(note));
        if (_sig && _sig.readyState === 1) { _sigSend({ rt: 'note', sid: _sid, id: id, yb: cipher }); _D('回发整篇', id, '字节=', cipher.length); }
      } catch (e) { _D('回发整篇失败', id, e); }
    }
  }
  /** 收到对端发来的整篇笔记 → 仅当本端确实缺失(未墓碑)时就地建出并按总账归位（秒级出现）。 */
  async function _onNoteSignal(id, cipher) {
    if (_authResetDepth > 0) { _D('收整篇 忽略: 权威恢复进行中'); return; }
    if (!id || !cipher) return;
    let json;
    try { json = await window.webdavSync.rtDecrypt(cipher); } catch (_) { return; } // 口令不符/非本人 → 忽略
    if (!json) return;
    let note;
    try { note = JSON.parse(json); } catch (_) { return; }
    try { const ok = window.storage._realtimeMaterializeNote(id, note); _D('收到整篇', id, ok ? '→已建出' : '→跳过(已存在/已删)'); if (ok) _pulse(); } catch (e) { _D('建出失败', id, e); }
  }

  // ── 本地变更入口 ─────────────────────────────────────────────────────────
  // 会改「笔记本结构」、需要其它设备尽快感知的变更类型（即时直推结构总账）。
  //   workspaces：笔记本增删改名换图标（统一发 type:'workspaces'）——漏了它，改本子永远走不了快车道，只能等网盘慢同步；
  //   expanded/collapseAll/expandAll：折叠展开——漏了它，折叠状态只能"被别的即时同步顺带捎过去"（用户报的"被激活"）。
  const STRUCT_TYPES = { create: 1, rename: 1, pinned: 1, color: 1, icon: 1, move: 1, template: 1,
                         delete: 1, restore: 1, purge: 1, emptyTrash: 1,
                         workspaces: 1, expanded: 1, collapseAll: 1, expandAll: 1 };

  function _onStorageChange(p) {
    if (!_enabled) return;
    if (!p) return;
    if (p.type === 'content') {
      if (_applyingRemote || p.id !== _activeId) return;
      _sendLocal(p.id);                                  // 正文改动 → 内容房间（同看对端走这条，自带「有人才发」门控）
      _broadcastNoteUpd(p.id);                           // #2：同时经账号级信令推给「没同看」的在线设备，使其后台跟上
    } else if (STRUCT_TYPES[p.type]) {
      _D('本地结构变更', p.type, '→ 计划广播');
      _scheduleStructBroadcast();                        // 快车道：去抖把最新结构总账即时推给账号内在线设备
      // 注：旧「PUT 成功后发 sync 暗号催对端拉网盘」已去除——结构直推 + structreq 接力已覆盖，
      //   且暗号只会被同信令房间（即已收到直推）的对端收到，纯属冗余请求。接收端仍兼容旧端 sync。
    }
  }

  // 显式恢复（窗口显示/聚焦/页面可见）：清离线态、重连两房间。连上后 onopen 会自动招呼+索要结构，
  //   故无需在此重发；幂等（已连上时 _ensureSignal/_ensureRoom 早退）。
  //   可由 focus/pointerdown/pointermove/keydown/visibilitychange 等高频事件调用 → 在线时必须**零开销**早退。
  //   fromHost=true 仅由 notifyShown 传入（事件监听传的是 Event 对象，恒非 true）：
  //   宿主按钮「隐藏」后的 1.5 秒内，拖尾的鼠标/聚焦噪声不许把离线顶回来（曾致「隐藏了对面紫点还亮」——
  //   点完隐藏鼠标一动，pointermove 就把 800ms 消抖断开取消了）；notifyShown 与 1.5 秒后的交互不受限。
  function _goOnline(fromHost) {
    if (fromHost === true) _hostHiddenAt = 0;
    else if (_hostHiddenAt && (Date.now() - _hostHiddenAt) < 1500) return;
    if (_byeTimer) { clearTimeout(_byeTimer); _byeTimer = null; } // 短暂失焦又回来/手一动 → 取消待执行的离线断开
    if (_offline) {                                        // 从离线恢复：重连两房间（onopen 自动招呼+索要结构）
      _offline = false;
      if (!_enabled) return;
      _ensureSignal();                                     // 账号级信令：无论是否开着笔记都恢复
      if (_activeId) _ensureRoom(_activeId);
      _notifyStatus();
      _D('显式恢复（聚焦/交互/可见）→ 重连两房间');
      return;
    }
    // 未离线但信令连接意外掉了 → 顺手自愈一次（不发状态事件，避免高频事件刷爆 UI）。在线且已连 → 纯早退。
    if (_enabled && (!_sig || _sig.readyState > 1)) _ensureSignal();
  }
  // 显式离线（窗口隐藏/最小化/关闭、页面不可见）：主动断开两房间。
  //   断开即让中转服务器侧 webSocketClose 触发 → 对端实报人数 -1、紫点即时熄灭（不靠对端等心跳超时）。
  //   置 _offline=true 让看门狗/重连都不再自愈，直到显式恢复——这才是「隐藏=暂时断开」的可靠实现。
  //   系统可见性事件走 800ms 消抖（防短暂失焦/偶发事件反复断连）；
  //   宿主按钮「隐藏/最小化」是明确意图 → immediate 立即断开（消抖窗口曾被拖尾 pointermove 取消，见 _goOnline）。
  let _hostHiddenAt = 0;
  function _goOffline(opts) {
    if (_offline) return;
    clearTimeout(_byeTimer);
    const run = function () {
      _byeTimer = null;
      _offline = true;
      try { _leaveSig(); } catch (_) {}                    // 礼貌告知对端（旧中转兜底）；新中转靠 socket 关闭即报
      _disconnect();                                        // 关内容房间
      _sigDisconnect();                                     // 关信令房间 → 服务器广播人数 -1
      _peerSeenAt = 0; _sigPeerSeenAt = 0;
      _notifyStatus();                                      // 本端紫点灭（connected=false）
      _D('显式离线（隐藏/最小化/不可见）→ 断开两房间，看门狗不自愈直到恢复');
    };
    if (opts && opts.immediate) run();
    else _byeTimer = setTimeout(run, 800);
  }

  // 看门狗：每隔几秒兜底自愈**意外**掉线（网络抖动、中转踢连、退避被卡住…）。
  //   显式离线（宿主隐藏/页面不可见）时**尊重离线、绝不自愈**——这正是修掉旧 bug 的关键：
  //   旧逻辑见 visibilityState='visible' 就强行唤醒，把按钮触发的隐藏又顶回在线，造成「隐藏了紫点还亮/反复抖」。
  //   _ensureSignal/_ensureRoom 在已连上时会早退（幂等），空转开销可忽略。
  // 「卡在半连接」判定：socket 处于 CONNECTING(readyState 0) 超过此时长仍没 open/close → 视为僵死，强制重连。
  //   这是修 #1 冷启动的关键：某次连接握手悬住时，onopen/onclose 都不触发，旧看门狗只看 readyState>1（已关）
  //   而 _ensureSignal/_ensureRoom 又对 readyState<=1（含 0）一律早退 → 该 socket 永不恢复，直到用户切笔记偶然顶开。
  const STUCK_CONNECTING_MS = 6000;
  function _stuck(ws, since) { return ws && ws.readyState === 0 && (Date.now() - since) > STUCK_CONNECTING_MS; }
  function _watchdog() {
    if (!_enabled || _offline) return;                             // 显式离线 → 不自愈
    // 信令房间：已关(>1) 或 卡在半连接(0 且超时) → 自愈。卡死的先 _sigDisconnect 清掉(置 _sig=null)，否则 _ensureSignal 会早退。
    if (!_sig || _sig.readyState > 1 || _stuck(_sig, _sigConnectAt)) {
      if (_sig && _sig.readyState === 0) _sigDisconnect();
      _ensureSignal();
    }
    // 内容房间（仅在开着笔记时）：同理处理已关 / 卡半连接。
    if (_activeId && (!_ws || _ws.readyState > 1 || _stuck(_ws, _connectAt))) {
      if (_ws && _ws.readyState === 0) _disconnect();
      _ensureRoom(_activeId);
    }
  }

  function init() {
    if (!window.storage || !window.webdavSync || !window.__ydoc) { setTimeout(init, 300); return; }
    try { window.storage.on('change', _onStorageChange); } catch (_) {}
    applyConfig();
    try { setInterval(_watchdog, 6000); } catch (_) {}
    try {
      const cur = window.editor && window.editor.currentId && window.editor.currentId();
      if (cur) onActiveNote(cur);
    } catch (_) {}
    try {
      window.addEventListener('focus', _goOnline);             // 窗口聚焦 = 已显示 → 重连
      // 交互兜底（关键）：WebView2 被宿主隐藏/显示时不一定补发 focus/visibility，但「看到窗口后总会动一下」。
      //   任何交互都触发恢复；在线时 _goOnline 零开销早退，故高频事件无负担、也不会乱断。
      ['pointerdown', 'pointermove', 'keydown'].forEach(function (evt) {
        try { window.addEventListener(evt, _goOnline, { passive: true }); } catch (_) { try { window.addEventListener(evt, _goOnline); } catch (_) {} }
      });
      window.addEventListener('pagehide', function () {        // 真正卸载/关闭 → 立即宣告离开（此刻 setTimeout 已无法执行，必须同步发）
        clearTimeout(_byeTimer); _byeTimer = null;
        try { _leaveSig(); } catch (_) {}
        _offline = true; _stopHeartbeat();
        try { _sigDisconnect(); _disconnect(); } catch (_) {}
      });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') _goOffline(); else _goOnline();  // 隐藏走消抖断开；显示即重连
      });
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.realtime = {
    applyConfig: applyConfig,
    onActiveNote: onActiveNote,
    isOn: function () { return _enabled; },
    // 权威覆盖（恢复/「覆盖云端」）期间暂停接收对端结构/整篇直推，防落后设备回灌删除刚恢复的笔记。
    beginAuthoritativeReset: beginAuthoritativeReset,
    endAuthoritativeReset: endAuthoritativeReset,
    // 宿主（Quicker）隐藏/最小化/关闭窗口时主动告知——WebView2 被宿主隐藏时不一定上报页面可见性，
    //   故由「隐藏/最小化」按钮直接调 notifyHidden（→ 断开，对端即时熄灭）；窗口重新显示时：
    //   ① 前端 focus 事件兜底，② 宿主「显示窗口」动作里执行一行 window.realtime.notifyShown() 最可靠。两者都幂等。
    notifyHidden: function () { try { _hostHiddenAt = Date.now(); _goOffline({ immediate: true }); } catch (_) {} },
    notifyShown: function () { try { _goOnline(true); } catch (_) {} },
    /** 即时同步指示灯用：on=具备并已启用；connected=信令已连（断开即灭，诚实反映真实连接）；
     *  active=账号内有别的设备在场（服务器实报人数≥2，旧中转退回心跳）→ 紫点常亮；
     *  syncing=刚发/收过正文或结构（呼吸窗口内）→ 紫点呼吸；
     *  presence=在线台数与电脑/手机/平板文案（含本机）。 */
    status: function () {
      const connected = !!(_sig && _sig.readyState === 1);
      const active = _enabled && connected && _sigPeerPresent();
      const presence = _presenceInfo();
      return {
        on: _enabled,
        connected: connected,
        active: active,
        syncing: active && (Date.now() - _syncPulseAt) < SYNC_PULSE_MS,
        presence: presence,
      };
    },
    _debug: function () {
      return {
        enabled: _enabled, offline: _offline, base: _base, activeId: _activeId,
        room: _ws && _ws.readyState, sig: _sig && _sig.readyState,
        occ: _occSupported, sigOcc: _sigOcc, wsOcc: _wsOcc,
        peer: _peerPresent(), sigPeer: _sigPeerPresent(),
        deviceKind: _currentDevKind(), peers: Object.assign({}, _peers), presence: _presenceInfo(),
      };
    },
  };
})();
