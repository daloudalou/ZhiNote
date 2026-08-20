(function () {
  'use strict';

  // ─── 配置 ────────────────────────────────────────────────────────────────────
  const FETCH_TIMEOUT_MS = 20_000;
  const FETCH_PUT_TIMEOUT_MS = 45_000;
  const PUT_DEBOUNCE_MS = 2_000;
  const BLUR_PUT_COOLDOWN_MS = 5_000;
  const GET_COOLDOWN_MS = 5_000;
  const SILENCE_TIMEOUT_MS = 2 * 60_000;
  // 墓碑保留期：原 30 天太短——陈旧/离线设备久违回来时墓碑已被清，"本地有/云端无"会被误判为
  // "本地新建"而复活上传（曾发生）。墓碑仅 {id:ts} 极小，延长到 1 年几乎不占空间，大幅压缩复活窗口。
  // 与 _detectLocallyNewerNotes 的基准判断配合（墓碑过期后由基准兜底，绝不复活）。
  const DELETED_RETENTION_MS = 365 * 24 * 60 * 60_000;
  const BASE_DIR = 'ZhiNote';
  // 搬家备份：升 v4 前把总目录/总账拷到旁边这份。图仍在 ZhiNote/images，不重复拷。程序不自动删。
  const BAK_DIR = 'ZhiNote-bak';

  // AES-GCM
  const AES_SALT = new Uint8Array([109, 100, 110, 111, 116, 101, 50, 48, 50, 54, 115, 97, 108, 116, 107, 121]);
  const AES_PASSPHRASE = 'zhinote-webdav-enc-2026';

  // ─── 状态 ────────────────────────────────────────────────────────────────────
  let _config = null;
  let _clientId = null;
  let _aesKey = null;
  let _lastKnownManifestUpdatedAt = 0;
  // CAS（manifest 原子写）：记下最近一次读到的 manifest 的 ETag，写回时作 If-Match。
  // 服务器不返回 ETag（自建/不支持）→ 留空 → 自动退回普通写，行为与从前一致。
  let _lastManifestEtag = '';
  // 最近一次真正读到的清单（304 时内存里可能还有），供「清单未变仍补传本机更新」用。
  let _lastManifestObj = null;
  let _lastCursorDeviceId = '';
  // 清单游标持久化：冷启动可「清单未变 → 早退」，避免无改动仍按篇狂下（20260807t1）
  const MANIFEST_CURSOR_KEY = 'zhinote-webdav-manifest-cursor';
  // 同步健康记录（按账号）：上次同步成功、上次慢核对的时刻。
  // 慢核对 = 每天一次、后台静默、只挑空闲时跑的完整核对（不走任何跳过近路），兜住快路万一算错。
  // 久闲闸 = 连续 7 天没同步过的设备（天天用永远碰不到），先完整核对云端（先下后对），核对完成前绝不上传，防旧账灌回。
  const HEALTH_KEY = 'zhinote-webdav-health';
  const FULL_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
  const STALE_DEVICE_MS = 7 * 24 * 60 * 60_000;
  // 久闲闸判定（纯函数，本机测试可抽）。无健康记录：有笔记库/库未就绪 → 当久闲（旧端升级典型）；空库才是新装。
  // 切勿把无记录写成「从现在起算」——那会让刚升级的闲设备立刻上传旧账（2026-08-20 iPad 事故）。
  function _evalStaleGate(lastOkAt, now, hasLocalLib, windowMs) {
    const win = (typeof windowMs === 'number' && isFinite(windowMs) && windowMs > 0) ? windowMs : STALE_DEVICE_MS;
    if (!lastOkAt) return hasLocalLib !== false;
    return (now - lastOkAt) > win;
  }
  function _hasLocalLibrary() {
    try {
      const data = window.storage && window.storage.getAll && window.storage.getAll();
      if (!data) return null;
      if (data.notes && Object.keys(data.notes).length > 0) return true;
      if (data.trash && Object.keys(data.trash).length > 0) return true;
      return false;
    } catch (_) { return null; }
  }
  let _lastSyncOkAt = 0;
  let _lastSyncOkPersistAt = 0;
  let _lastFullCheckAt = 0;
  let _staleGate = false;
  let _staleGetAt = 0;
  let _fullCheckTimer = null;
  let _casFailStreak = 0;            // 连续被 412（抢先）次数
  let _casForceUnconditional = false; // 连续 412 达阈值 → 下一轮退化为普通写，避免弱校验服务器空转
  // 条件 GET 哨兵：webdavGet 带 If-None-Match 命中 304（内容未变）时返回它，调用方据此早退，
  // 省下整份 manifest 的下载与解析。与"文件不存在"的 null 严格区分。
  const NOT_MODIFIED = Symbol('webdav-not-modified');
  let _lastGetTime = 0;
  let _lastPutTime = 0;
  let _lastBlurPutTime = 0;
  let _putTimer = null;
  let _silenceTimer = null;
  let _pollTimer = null;
  let _isSilent = false;
  let _syncing = false;
  let _uiSyncing = false; // 徽标在动：大动作转圈，或后台真的在下篇时呼吸
  let _uiHeavy = false;   // 大动作（刚开 / 立即同步 / 覆盖云端 / 久闲核对）：绿点立刻转圈
  let _heavyUntilIdle = false; // 大动作这一轮随后排队的上传也转圈，打字上传不沾
  let _paused = false;
  let _pauseResumeTimer = null;
  let _backoffMs = 30_000;
  let _started = false;
  let _stopped = false;
  let _pendingPut = false;
  let _pendingGet = false;
  let _pendingManifestImages = {};
  let _authFailCount = 0;
  const AUTH_FAIL_LIMIT = 3;

  // ─── 有限并发请求池 ──────────────────────────────────────────────────────────
  // 旧实现是"串行队列 + 每请求 100ms 间隔"，批量同步（首次上传/下载全部/覆盖）会逐个往返、
  // 零重叠，极慢。改为按服务商设并发上限：坚果云较敏感（4 + 相邻请求最小间隔），
  // 其它放高（6，无间隔）；遇 503 自动降档，配合既有退避。
  let _lastRequestTime = 0;
  let _requestCount = 0;
  let _requestWindowStart = 0;
  let _maxConcurrency = 6;   // 当前并发上限
  let _pacingMs = 0;         // 相邻请求最小间隔（仅坚果云用）
  let _activeCount = 0;      // 在飞请求数
  let _lastDispatchTime = 0;
  const _poolWaiters = [];

  // 上传去抖 / 上传最小间隔 / 轮询间隔都按服务商差异化：
  // 坚果云频控严（官方约 30 分钟 600 次）取保守值；Koofr/自建等不被服务端限速，
  // 收紧去抖与最小间隔，做到"改完即传"，缩短"编辑 → 其它设备看到"的端到端延迟。
  let _putDebounceMs = PUT_DEBOUNCE_MS;
  let _putMinIntervalMs = 5_000;
  let _pollIntervalMs = 10_000;

  function _applyProviderTuning(provider) {
    if (provider === 'jianguoyun') {
      _maxConcurrency = 4; _pacingMs = 100;
      _putDebounceMs = 2_000; _putMinIntervalMs = 30_000; _pollIntervalMs = 30_000;
    } else {
      _maxConcurrency = 6; _pacingMs = 0;
      _putDebounceMs = 600; _putMinIntervalMs = 2_000; _pollIntervalMs = 10_000;
    }
  }

  function _acquireSlot() {
    if (_activeCount < _maxConcurrency) { _activeCount++; return Promise.resolve(); }
    return new Promise(resolve => _poolWaiters.push(resolve)); // 等待槽位（由 _releaseSlot 直接交接）
  }
  function _releaseSlot() {
    const next = _poolWaiters.shift();
    if (next) next();        // 槽位交接给等待者，_activeCount 不变
    else _activeCount--;
  }

  async function enqueue(fn) {
    if (_stopped) throw new Error('WebDAV sync stopped');
    await _acquireSlot();
    try {
      if (_pacingMs > 0) {
        const wait = _pacingMs - (Date.now() - _lastDispatchTime);
        if (wait > 0) await sleep(wait);
        _lastDispatchTime = Date.now();
      }
      if (_stopped) throw new Error('WebDAV sync stopped');
      const result = await fn();
      _lastRequestTime = Date.now();
      _trackRequest();
      return result;
    } finally {
      _releaseSlot();
    }
  }

  // 有限并发地跑一批任务（并发上限即请求池上限，靠 enqueue 内的信号量自然限速）。
  // 返回 { results, errors }，errors 为 [{ item, error }]。
  async function _runPool(items, taskFn) {
    const list = Array.from(items || []); // 兼容 Set / 数组等任意可迭代
    const errors = [];
    const results = [];
    await Promise.all(list.map(async (item) => {
      try { results.push(await taskFn(item)); }
      catch (e) { errors.push({ item, error: e }); }
    }));
    return { results, errors };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _trackRequest() {
    const now = Date.now();
    if (now - _requestWindowStart > 30 * 60_000) {
      _requestCount = 0;
      _requestWindowStart = now;
    }
    _requestCount++;
  }

  // ─── HTTP 封装 ───────────────────────────────────────────────────────────────
  function _fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    // 大请求体（图片等）按体积放宽超时：固定 20s 会让慢网/经代理的大文件永远传不完、
    // 每次都在半路被中止 → 无限瞬时重试。按 ≈50KB/s 的保守带宽追加，上限 120s。
    const bodyBytes = typeof options.body === 'string' ? options.body.length
      : (options.body && (options.body.byteLength || options.body.size)) || 0;
    const method = String(options.method || 'GET').toUpperCase();
    const baseMs = (method === 'PUT' || method === 'MKCOL' || method === 'DELETE')
      ? FETCH_PUT_TIMEOUT_MS : FETCH_TIMEOUT_MS;
    const timeoutMs = Math.min(120_000, baseMs + Math.floor(bodyBytes / 50));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // credentials:'omit' 关键：阻止浏览器在收到 401 时弹出原生"登录以访问此站点"对话框，
    // 让 401 直接作为响应交回脚本，由我们自己处理（我们已手动带 Authorization 头）。
    // cache:'no-store'：写后读回若走浏览器/WebView 缓存，会「校验像成功、网盘文件其实没变」（Koofr 已实锤）。
    return fetch(url, { ...options, credentials: 'omit', cache: 'no-store', signal: controller.signal })
      .catch((e) => {
        // 超时中止 / 网络层失败都是瞬时网络问题（经代理时偶发）：标 transient 走静默重试通道，
        // 由 _handleTransient 熔断（连续多轮失败才报错），不再每次超时都向用户弹"同步失败"。
        const s = String((e && e.name) || '') + ' ' + String((e && e.message) || '');
        if (/abort/i.test(s) || /failed to fetch|networkerror|load failed/i.test(s)) e.transient = true;
        throw e;
      })
      .finally(() => clearTimeout(timer));
  }

  // ─── 跨域代理（仅网页宿主）────────────────────────────────────────────────
  // 内置默认代理：官方部署的 Cloudflare Worker（开源转发、不记录；笔记本体是密文）。
  // webdavProxy 设置语义：'' / 未设置 = 用内置默认；'direct' = 直连；其余 = 自定义代理地址。
  // Quicker 宿主无 CORS 限制，恒为直连。
  const DEFAULT_WEB_PROXY = 'https://proxy.zhinote.net';
  function resolveProxy(raw) {
    if (window.host && window.host.isQuicker()) return '';
    const v = (raw || '').trim().replace(/\/+$/, '');
    if (!v) return DEFAULT_WEB_PROXY;
    if (v === 'direct') return '';
    return v;
  }

  // ─── 实时同步中转（可选；Quicker / 网页都可用）────────────────────────────────
  // webdavRealtime 语义：''/未设置/'builtin' = 官方内置默认中转（默认开启）；'off' = 关闭；其余 = 自建地址。
  const DEFAULT_RELAY = 'wss://relay.zhinote.net';
  function resolveRelay(raw) {
    const v = (raw || '').trim();
    if (v === 'off') return '';
    if (!v || v === 'builtin') return DEFAULT_RELAY;
    let u = v.replace(/\/+$/, '').replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    if (!/^wss?:/i.test(u)) u = 'wss://' + u;
    return u;
  }
  // 房间号：由「网盘账号(URL+用户名) + 用户口令(无则内置) + 种子(workspaceId:noteId)」哈希得出。
  // 关键：并入网盘账号 → 不同用户账号必然不同，即使口令相同也落入不同房间，100% 不串；
  // 同一用户的多台设备账号/口令/笔记编号都相同 → 进同一房间。不可逆、不可猜。
  async function rtRoomId(seed) {
    const pass = _userCryptoPass() || AES_PASSPHRASE;
    // 【闸】配置未加载完（启动竞态：realtime 先跑 / aesDecrypt 慢 / 解密失败）时绝不派生房间号：
    //   否则账号按空串参与哈希 → 不同网盘账号（坚果云 vs Koofr）甚至不同用户（都用内置口令时
    //   密文互可解！）会落进同一"默认房间"，互亮紫点、互收结构直推——正是用户报过的
    //   "两台设备服务商不同还进即时同步"。抛错让调用方（_ensureSignal/_ensureRoom 均 catch）
    //   本轮放弃连接；配置就绪后由 applyConfig / 看门狗（6s 周期）自动重连，只慢几秒、不落错房。
    if (!_config) throw new Error('WebDAV 配置未加载，拒绝派生房间号');
    const acct = (_config.url || '') + '|' + (_config.user || '');
    // v5 换房间前缀：旧版即时走 zhinote-room: / v4，碰不到新版，避免网盘已停仍经中转灌旧结构。
    // v5 换房间：旧版走 v4 前缀，碰不到新版。
    const data = new TextEncoder().encode('zhinote-room-v5:' + acct + ':' + pass + ':' + (seed || ''));
    const digest = await crypto.subtle.digest('SHA-256', data);
    const u8 = new Uint8Array(digest);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    // base64url，截断到 32 字符（足够防碰撞，符合服务端 [A-Za-z0-9_-]{1,128}）
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
  }
  // 实时载荷加解密：复用「笔记内容密钥」（用户口令优先）。明文是账本的 base64 串。
  function rtEncrypt(plainB64) { return notesEncrypt(plainB64); }
  function rtDecrypt(cipherB64) { return notesDecrypt(cipherB64); }

  function _buildUrl(path) {
    return _buildUrlIn(BASE_DIR, path);
  }

  function _buildUrlIn(rootDir, path) {
    if (!_config) throw new Error('WebDAV 未配置');
    let base = _config.url.replace(/\/+$/, '');
    const rel = (path || '').replace(/^\/+/, '');
    const fullPath = (rel ? `${rootDir}/${rel}` : rootDir).replace(/\/+/g, '/');
    const real = `${base}/${fullPath}`;
    // 代理前缀模式（网页端跨域用）：请求发往 <proxy>/<完整目标URL>，由代理转发并补 CORS 头。
    // 代理只经手密文（笔记本体已 AES 加密）；桌面 Quicker 端无 CORS 限制，通常不配置。
    if (_config.proxy) return _config.proxy.replace(/\/+$/, '') + '/' + real;
    return real;
  }

  function _authHeader() {
    if (!_config) throw new Error('WebDAV 未配置');
    return 'Basic ' + btoa(unescape(encodeURIComponent(_config.user + ':' + _config.pass)));
  }

  async function webdavPut(path, body, contentType = 'application/json; charset=utf-8', extraHeaders = null) {
    return enqueue(async () => {
      const _headers = () => Object.assign({ 'Authorization': _authHeader(), 'Content-Type': contentType }, extraHeaders || {});
      let resp = await _fetchWithTimeout(_buildUrl(path), {
        method: 'PUT',
        headers: _headers(),
        body,
      });
      if (resp.status === 404 || resp.status === 409) {
        const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
        await _ensureDirectories(dir);
        resp = await _fetchWithTimeout(_buildUrl(path), {
          method: 'PUT',
          headers: _headers(),
          body,
        });
      }
      // If-Match 未命中：仅 manifest 写会带 If-Match，故 412 必为"被抢先"。让上层重新合并重试。
      if (resp.status === 412) throw new PreconditionFailedError();
      if (resp.status === 503 || resp.status === 429) throw new RateLimitError();
      if (resp.status === 423) throw await _lockedError('PUT', path, resp);
      if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
        throw new WebDAVError('PUT', path, resp.status, await resp.text().catch(() => ''));
      }
      _authFailCount = 0;
      return resp;
    });
  }

  async function _ensureDirectories(subPath) {
    const parts = subPath ? subPath.split('/') : [];
    let cur = '';
    await _mkcolRaw('');
    for (const p of parts) {
      cur += (cur ? '/' : '') + p;
      await _mkcolRaw(cur);
    }
  }

  async function _mkcolRaw(path) {
    const resp = await _fetchWithTimeout(_buildUrl(path), {
      method: 'MKCOL',
      headers: { 'Authorization': _authHeader() },
    });
    if (resp.status === 405 || resp.status === 301 || resp.status === 201 || resp.ok) return;
  }

  async function webdavGet(path, options = {}) {
    return enqueue(async () => {
      const headers = { 'Authorization': _authHeader() };
      if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;
      const resp = await _fetchWithTimeout(_buildUrl(path), {
        method: 'GET',
        headers,
      });
      // 条件请求命中：内容未变，服务器回 304 空体 → 返回哨兵，省下整份下载/解析。
      // 服务器若忽略 If-None-Match 会照常回 200，走下方常规流程，行为同从前。
      if (resp.status === 304) { _authFailCount = 0; return NOT_MODIFIED; }
      if (resp.status === 404) {
        if (options.allow404) return null;
        throw new WebDAVError('GET', path, 404, 'Not Found');
      }
      if (resp.status === 503 || resp.status === 429) throw new RateLimitError();
      if (resp.status === 423) throw await _lockedError('GET', path, resp);
      if (!resp.ok) {
        throw new WebDAVError('GET', path, resp.status, await resp.text().catch(() => ''));
      }
      _authFailCount = 0;
      return resp;
    });
  }

  async function webdavGetJson(path, options = {}) {
    // 空响应 / 截断的 JSON 多为服务端在并发写入期间返回的瞬时结果（Koofr/坚果云都遇到过）。
    // 短暂重试几次；仍失败则抛"可重试"错误（标 transient），由调用方静默重试，
    // 绝不当成 null —— 否则会被误判为"云端无数据"而触发首次同步、重传全部，风险极高。
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await webdavGet(path, options);
      if (resp === NOT_MODIFIED) return NOT_MODIFIED; // 条件 GET 未变：上抛哨兵给调用方早退
      if (!resp) return null; // 404 / allow404：文件确实不存在
      if (path === 'manifest.json') {
        // 弱 ETag（W/ 前缀）多数服务器对 If-Match 走强比较会一律 412，留空以退回普通写，避免空转。
        const et = resp.headers.get('ETag') || resp.headers.get('etag') || '';
        _lastManifestEtag = (et && !et.startsWith('W/')) ? et : '';
      }
      const text = await resp.text();
      if (text == null || text.trim() === '') {
        lastErr = new Error(`JSON 解析失败 (${path}): 服务器返回空内容`);
        if (attempt < 2) { await sleep(400 * (attempt + 1)); continue; }
        lastErr.transient = true;
        throw lastErr;
      }
      // 代理/网盘被限流或拦截时会回 HTML 错误页（状态码可能还是 200），
      // 直接 JSON.parse 只会报晦涩的"Unexpected token <"——识别出来按瞬时错误重试
      if (text.trim().startsWith('<')) {
        lastErr = new Error(`服务器/代理返回了网页而非数据 (${path})，可能被限流或拦截，稍后自动重试`);
        if (attempt < 2) { await sleep(400 * (attempt + 1)); continue; }
        lastErr.transient = true;
        throw lastErr;
      }
      try { return JSON.parse(text); }
      catch (e) {
        lastErr = new Error(`JSON 解析失败 (${path}): ${e.message}`);
        if (attempt < 2) { await sleep(400 * (attempt + 1)); continue; }
        lastErr.transient = true;
        throw lastErr;
      }
    }
    throw lastErr;
  }

  // manifest.json 是同步的"总账本"：读到 404(null) 多半是真的不存在，但部分 WebDAV 服务器在
  // 资源被锁/限流期间偶尔会吐假 404。一旦误判"清单丢失"，空库设备就会用空清单去重建、把云端
  // 清单清零（已发生）。故 404 后延时再确认一次，仍为 null 才认定真的没有。返回 manifest 或 null。
  async function _recheckManifest() {
    await sleep(800);
    return webdavGetJson(MANIFEST_PATH, { allow404: true });
  }

  // 清单路径
  const MANIFEST_PATH = 'manifest.json';
  // 结构总账外置：独立文件；清单保持瘦索引。总账仅在结构/设置脏时维护上传。
  const STRUCT_LEDGER_PATH = 'struct-ledger.json';
  const STRUCT_TAIL_PATH = 'struct-tail.json';
  const STRUCT_TAIL_MAX = 80 * 1024;
  const STRUCT_SNAP_SV_KEY = 'zhinote-struct-snap-sv';
  const CATALOG_CONFIRM_KEY = 'zhinote-catalog-confirm';       // 旧散账键，仅升级迁移时读
  const SKIP_IDLE_GET_MS = 90_000;
  const CATALOG_FLUSH_MS = 15_000;
  const PENDING_NOTE_VERS_KEY = 'zhinote-pending-note-vers';   // 旧散账键，仅升级迁移时读
  let _catalogFlushTimer = null;
  let _manifestWriting = false; // 本机正在写清单：读空视为中间态，禁止自动自愈
  // 旧垫子早已不写。再 DELETE 一次，盘上没有时浏览器会红 404。不再扫。
  async function _dropLegacySidecars() {}

  function _svOfLedger(led) {
    const W = window.__wsdoc;
    if (!W || !W.stateVector || !led) return '';
    try { return W.stateVector(led); } catch (_) { return ''; }
  }
  let _structSnapSVMem = '';
  function _saveStructSnapSV(sv) {
    const tag = _accountTag();
    if (!tag || !sv) return;
    _structSnapSVMem = sv;
    try { _ssSet('_webdavStructSnapSV', STRUCT_SNAP_SV_KEY, JSON.stringify({ account: tag, sv: sv })); } catch (_) {}
  }
  function _loadStructSnapSV() {
    if (_structSnapSVMem) return _structSnapSVMem;
    try {
      const raw = _ssGet('_webdavStructSnapSV', STRUCT_SNAP_SV_KEY);
      if (!raw) return '';
      const o = JSON.parse(raw);
      if (o && o.account === _accountTag() && typeof o.sv === 'string' && o.sv) {
        _structSnapSVMem = o.sv;
        return o.sv;
      }
    } catch (_) {}
    return '';
  }
  // ─── 本机同步账本（一本账，20260818t15）─────────────────────────────────────
  // 把四份散账收拢成一本，一处读写、一处对账号：
  //   pendingVers    已传未交的按篇版本（正文已上云、名单稍后交）
  //   catalogConfirm 名单「写下了、还没读回对」的回执
  //   cursor         上次见到的云端名单版本 / 标记 / 写名单的设备
  //   health         上次同步成功、上次慢核对的时刻、正式版已真读过的号
  // 换账号自动换账本（_ledger 里对账号），绝不残留上个账号的账——散账时代四处各自对账号、
  // 内存值不清，正是「换号残留 / 覆盖后旧账顶新云端」这类洞的温床。
  const ACCT_LEDGER_KEY = 'zhinote-webdav-acct-ledger';
  let _acct = null;
  function _emptyAcct(tag) {
    return { account: tag, pendingVers: {}, catalogConfirm: null,
      cursor: { rev: 0, etag: '', deviceId: '' }, health: { okAt: 0, fullAt: 0, checkedVer: '' },
      sweep: null };   // 云端旧格式清扫进度：null=还没扫 {pend:[{i,y}],at,done,removed,converted,skipped}
  }
  function _ledger() {
    const tag = _accountTag();
    if (_acct && _acct.account === tag) return _acct;
    _acct = _emptyAcct(tag);
    if (!tag) return _acct;                       // 配置未就绪：临时空账，不落盘
    try {
      const raw = _ssGet('_webdavAcctLedger', ACCT_LEDGER_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && o.account === tag) {
          if (o.pendingVers && typeof o.pendingVers === 'object') _acct.pendingVers = o.pendingVers;
          if (o.catalogConfirm && typeof o.catalogConfirm === 'object') _acct.catalogConfirm = o.catalogConfirm;
          Object.assign(_acct.cursor, (o.cursor && typeof o.cursor === 'object') ? o.cursor : {});
          Object.assign(_acct.health, (o.health && typeof o.health === 'object') ? o.health : {});
          if (o.sweep && typeof o.sweep === 'object') _acct.sweep = o.sweep;
          return _acct;
        }
      }
    } catch (_) {}
    _migrateLegacyLedger(tag);
    return _acct;
  }
  function _saveLedger() {
    if (!_acct || !_acct.account) return;
    try { _ssSet('_webdavAcctLedger', ACCT_LEDGER_KEY, JSON.stringify(_acct)); } catch (_) {}
  }
  /** 老包升级：第一次没有一本账时，从四份旧散账各自搬进来（都带账号核对，不搬别人的账）。旧键留着不删，便于退回旧包。 */
  function _migrateLegacyLedger(tag) {
    try {
      const raw = _ssGet('_webdavPendingNoteVers', PENDING_NOTE_VERS_KEY);
      if (raw) { const o = JSON.parse(raw); if (o && o.account === tag && o.map && typeof o.map === 'object') _acct.pendingVers = o.map; }
    } catch (_) {}
    try {
      const raw = _ssGet('_webdavCatalogConfirm', CATALOG_CONFIRM_KEY);
      if (raw) { const o = JSON.parse(raw); if (o && o.account === tag) _acct.catalogConfirm = { rev: o.rev, updatedAt: o.updatedAt, deviceId: o.deviceId }; }
    } catch (_) {}
    try {
      const raw = _ssGet('_webdavManifestCursor', MANIFEST_CURSOR_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && o.account === tag) {
          _acct.cursor = {
            rev: Number(o.updatedAt) || 0,
            etag: (typeof o.etag === 'string' && o.etag) ? o.etag : '',
            deviceId: (typeof o.deviceId === 'string' && o.deviceId) ? o.deviceId : '',
          };
        }
      }
    } catch (_) {}
    try {
      const raw = _ssGet('_webdavHealth', HEALTH_KEY);
      if (raw) { const o = JSON.parse(raw); if (o && o.account === tag) _acct.health = { okAt: Number(o.okAt) || 0, fullAt: Number(o.fullAt) || 0 }; }
    } catch (_) {}
    _saveLedger();
  }

  function _savePendingCatalogConfirm(o) {
    const led = _ledger();
    led.catalogConfirm = o ? { rev: o.rev, updatedAt: o.updatedAt, deviceId: o.deviceId } : null;
    _saveLedger();
  }
  function _loadPendingCatalogConfirm() {
    return _ledger().catalogConfirm || null;
  }
  /** 打开/强制拉时核对上次「写下了」是否真在云上。没对上就标脏重写。 */
  function _confirmOrRetryCatalog(manifest) {
    const p = _loadPendingCatalogConfirm();
    if (!p || !manifest) return;
    const cloudRev = Number(_catalogRev(manifest) || 0);
    const pendingRev = Number(p.rev || 0);
    const same = cloudRev === pendingRev
      && Number(manifest.updatedAt || 0) === Number(p.updatedAt || 0)
      && String(manifest.deviceId || '') === String(p.deviceId || '');
    if (same || cloudRev > pendingRev) {
      _savePendingCatalogConfirm(null);
      return;
    }
    console.warn('[webdav] 上次名单未落到云端，将重写', 'cloudRev=', cloudRev, 'pendingRev=', pendingRev);
    _savePendingCatalogConfirm(null);
    if (window.storage.markGlobalDirty) window.storage.markGlobalDirty();
    try { schedulePut('catalog-confirm-miss'); } catch (_) {}
  }
  function _peerPresent() {
    try {
      const st = window.realtime && window.realtime.status && window.realtime.status();
      return !!(st && st.active);
    } catch (_) { return false; }
  }
  function _pendingVers() { return _ledger().pendingVers; }
  function _rememberPendingVer(id, v) {
    if (!id || !v) return;
    _pendingVers()[id] = v;
    _saveLedger();
  }
  /** 慢核对用：把「已传未交」的本机账和云端名单对一遍——
   *  云端已记上 → 销账；云端已立删除标记 → 听删除、直接销账（绝不催交把删掉的篇写回）；还欠着 → 标脏补交名单。 */
  function _repairPendingVers(manifest) {
    if (!manifest || !manifest.notes) return { cleared: false, owed: false };
    const pend = _pendingVers();
    let cleared = false, owed = false;
    for (const id in pend) {
      if (manifest.deleted && manifest.deleted[id]) { delete pend[id]; cleared = true; continue; }
      const pv = Number(pend[id] || 0);
      const mv = _noteVer(manifest.notes[id]);
      if (mv >= pv) { delete pend[id]; cleared = true; }
      else owed = true;
    }
    if (cleared) _saveLedger();
    if (owed) {
      try { console.log('[sync-get] 慢核对：名单还欠着已传篇的版本，安排补交'); } catch (_) {}
      if (window.storage.markIndexDirty) window.storage.markIndexDirty();
      try { schedulePut('full-check-catalog-owed'); } catch (_) {}
    }
    return { cleared, owed };
  }
  function _applyPendingVers(manifest) {
    if (!manifest) return;
    if (!manifest.notes) manifest.notes = {};
    const pend = _pendingVers();
    let changed = false;
    for (const id in pend) {
      // 墓碑说了算：这篇已被记为删除（本机或别台在正文上云到交名单的空当里删的），
      // 绝不因「已传未交」把它写回名单——那等于复活已删笔记。账直接销掉。
      if (manifest.deleted && manifest.deleted[id]) { delete pend[id]; changed = true; continue; }
      const pv = Number(pend[id] || 0);
      if (pv > _noteVer(manifest.notes[id])) {
        const prev = manifest.notes[id] || {};
        manifest.notes[id] = Object.assign({}, prev, { v: pv });
        delete manifest.notes[id].empty;
      }
    }
    if (changed) _saveLedger();
  }
  function _clearPendingVers() {
    _ledger().pendingVers = {};
    _saveLedger();
  }
  function _scheduleDeferredCatalog() {
    if (_catalogFlushTimer) clearTimeout(_catalogFlushTimer);
    _catalogFlushTimer = setTimeout(() => {
      _catalogFlushTimer = null;
      if (window.storage && window.storage.isIndexDirty && window.storage.isIndexDirty()) {
        try { flushIndex(); } catch (_) {}
      }
    }, CATALOG_FLUSH_MS);
  }
  /** 刚是自己写的、对面不在：空转不必再拉整份名单。 */
  function _canSkipIdleGet() {
    if (_staleGate) return false;
    if (!_lastPutTime || (Date.now() - _lastPutTime) > SKIP_IDLE_GET_MS) return false;
    if (!_lastWriterIsUs()) return false;
    if (_peerPresent()) return false;
    return true;
  }
  function _lastWriterIsUs() {
    const id = (_lastManifestObj && _lastManifestObj.deviceId) || _lastCursorDeviceId || '';
    return !!(id && String(id) === _ensureClientId());
  }
  /** 对面在、或上次名单不是自己写的：必须真读名单。自己写的且对面不在：带旧标记即可，不必整份重下。 */
  function _shouldForceCatalogGet() {
    if (_peerPresent()) return true;
    if (_lastWriterIsUs()) return false;
    return true;
  }
  /** 给人看的正式号是 v1.2.3；试看包是 20260820t9 或 v1.2.3-dev+…，不算换正式版。 */
  function _appVer() {
    try { return String((typeof window !== 'undefined' && window.__MD_VER__) || ''); } catch (_) { return ''; }
  }
  function _isFormalAppVer(v) {
    return /^v\d+\.\d+\.\d+$/.test(String(v || '').trim());
  }
  /** 这台刚换正式版、还没真读过名单：丢掉旧标记，防缓存假 304。不是整库核对。 */
  function _needFreshCatalogOnce() {
    if (!_accountTag()) return false;
    const v = _appVer();
    if (!_isFormalAppVer(v)) return false;
    const seen = (_ledger().health && _ledger().health.checkedVer) || '';
    return seen !== v;
  }
  function _markCatalogFreshForVer() {
    const v = _appVer();
    if (!_isFormalAppVer(v)) return;
    const led = _ledger();
    if (!led.health) led.health = { okAt: 0, fullAt: 0, checkedVer: '' };
    if (led.health.checkedVer === v) return;
    led.health.checkedVer = v;
    _saveLedger();
  }
  /** 开门/唤醒/排队后的那一拉怎么拉——一处决策（开门决策收拢点）：
   *  ① 久闲超 7 天 → 完整核对（full）；② 正式版第一次打开 → 真读名单（不带旧标记，不做 full）；
   *  ③ 对面在 / 上次名单不是自己写 → 真读名单；④ 自己写的且对面不在 → 带旧标记轻问（cond）。 */
  function _openGetOpts() {
    if (_staleGate) return { force: true, silent: true, full: true };
    if (_needFreshCatalogOnce()) return { force: true, silent: true };
    if (_shouldForceCatalogGet()) return { force: true, silent: true };
    return { force: true, silent: true, cond: true };
  }

  /** 名单没变时不会去读整本。绿了且本机没待交的目录改动，才补记「上次整本」进度针。
   *  云端已有小段时，本机总账已经叠过，不能当整本针（否则下一小段会盖掉上一小段）。 */
  async function _seedStructSnapSVFromLocal(manifest) {
    if (_loadStructSnapSV()) return;
    try {
      if (window.storage.isGlobalDirty && window.storage.isGlobalDirty()) return;
      const m = manifest || _lastManifestObj;
      if (!m) return;
      if (m.structTail || m.structTailUpd) return;
      const led = window.storage._structLedger && window.storage._structLedger();
      const sv = _svOfLedger(led);
      if (sv) _saveStructSnapSV(sv);
    } catch (_) {}
  }

  /** 读云端结构总账：整本优先，名单说有小段再叠上。旧云端回退清单内嵌。 */
  async function _loadCloudStructLedger(manifest) {
    let snap = null;
    try {
      const obj = await webdavGetJson(STRUCT_LEDGER_PATH, { allow404: true });
      if (obj && typeof obj.ledger === 'string' && obj.ledger) snap = obj.ledger;
    } catch (e) {
      if (!(e && e.transient)) console.warn('[webdav] 读结构总账文件失败（将回退清单内嵌）', e && e.message);
    }
    if (!snap && manifest && typeof manifest.structLedger === 'string' && manifest.structLedger) {
      snap = manifest.structLedger;
    }
    if (snap) {
      const sv = _svOfLedger(snap);
      if (sv) _saveStructSnapSV(sv);
    }
    let led = snap;
    let tailUpd = '';
    if (led && manifest && typeof manifest.structTailUpd === 'string' && manifest.structTailUpd) {
      tailUpd = manifest.structTailUpd;
    } else if (led && manifest && manifest.structTail) {
      try {
        const tail = await webdavGetJson(STRUCT_TAIL_PATH, { allow404: true });
        if (tail && typeof tail.upd === 'string' && tail.upd) tailUpd = tail.upd;
      } catch (e) {
        console.warn('[webdav] 读结构小段失败（只用整本）', e && e.message);
      }
    }
    if (led && tailUpd && window.__wsdoc && window.__wsdoc.merge) {
      try { led = window.__wsdoc.merge(led, tailUpd); } catch (_) {}
    }
    return led;
  }

  /** 总账写入独立文件，并从 manifest 去掉内嵌字段（清单瘦身）。失败则保留/写回内嵌，绝不丢总账。 */
  /**
   * 把结构总账写到独立文件，并从清单去掉内嵌。
   * - ledger 有值：上传该总账
   * - ledger 为空且 migrateEmbed：若清单仍内嵌旧总账则外置上传（迁移/覆盖云端用）
   * - 否则：只删内嵌字段，绝不 PUT（打字/纯正文路径必须走这里，防误盖云端总账）
   */
  async function _persistStructLedgerExternal(manifest, ledger, opts) {
    const migrateEmbed = !!(opts && opts.migrateEmbed);
    const forceFull = !!(opts && opts.forceFull) || migrateEmbed;
    const led = (ledger != null && ledger !== '')
      ? ledger
      : (migrateEmbed && manifest && manifest.structLedger) || null;
    if (!led) {
      if (manifest && manifest.structLedger) delete manifest.structLedger;
      return false;
    }
    const writeFull = async function (why) {
      const body = JSON.stringify({
        v: 1,
        updatedAt: Date.now(),
        deviceId: _ensureClientId(),
        ledger: led,
      });
      await webdavPut(STRUCT_LEDGER_PATH, body, 'application/json; charset=utf-8');
      if (manifest) {
        delete manifest.structLedger;
        delete manifest.structTailUpd;
        manifest.structTail = 0;
      }
      const sv = _svOfLedger(led);
      if (sv) _saveStructSnapSV(sv);
      try { console.log('[sync-put-run] structure：传整本', why || ''); } catch (_) {}
      return true;
    };
    try {
      if (!forceFull) {
        const W = window.__wsdoc;
        const sv = _loadStructSnapSV();
        if (!sv) return await writeFull('还没有进度针');
        if (W && W.diffFromSV) {
          const upd = W.diffFromSV(led, sv);
          if (upd) {
            const tailBody = JSON.stringify({
              v: 1,
              updatedAt: Date.now(),
              deviceId: _ensureClientId(),
              upd: upd,
            });
            const tailBytes = _utf8Len(tailBody);
            const fullBytes = _utf8Len(JSON.stringify({ v: 1, ledger: led }));
            if (tailBytes < STRUCT_TAIL_MAX && tailBytes < Math.max(2048, fullBytes * 0.45)) {
              await webdavPut(STRUCT_TAIL_PATH, tailBody, 'application/json; charset=utf-8');
              if (manifest) {
                delete manifest.structLedger;
                delete manifest.structTailUpd;
                manifest.structTail = 1;
              }
              try { console.log('[sync-put-run] structure：只传一小段', tailBytes, '/', fullBytes); } catch (_) {}
              return true;
            }
            return await writeFull('小段太大 ' + tailBytes + '/' + fullBytes);
          }
        }
      }
      return await writeFull(forceFull ? '覆盖/建库' : '改走整本');
    } catch (e) {
      console.warn('[webdav] 结构总账外置写入失败，本次仍内嵌于清单', e && e.message);
      if (manifest) manifest.structLedger = led;
      return false;
    }
  }

  function _utf8Len(s) {
    return (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(s).length : s.length;
  }

  /** 在已持有的请求槽内：PUT 一份 JSON（无嵌套 enqueue）。 */
  async function _putJsonRaw(path, body, ifMatch) {
    const headers = Object.assign({
      'Authorization': _authHeader(),
      'Content-Type': 'application/json; charset=utf-8',
    }, ifMatch ? { 'If-Match': ifMatch } : {});
    let putResp = await _fetchWithTimeout(_buildUrl(path), { method: 'PUT', headers, body });
    if (putResp.status === 404 || putResp.status === 409) {
      await _ensureDirectories('');
      putResp = await _fetchWithTimeout(_buildUrl(path), { method: 'PUT', headers, body });
    }
    if (putResp.status === 412) throw new PreconditionFailedError();
    if (putResp.status === 503 || putResp.status === 429) throw new RateLimitError();
    if (putResp.status === 423) throw await _lockedError('PUT', path, putResp);
    if (!putResp.ok && putResp.status !== 201 && putResp.status !== 204) {
      throw new WebDAVError('PUT', path, putResp.status, await putResp.text().catch(() => ''));
    }
    const et = putResp.headers.get('ETag') || putResp.headers.get('etag') || '';
    return (et && !et.startsWith('W/')) ? et : '';
  }

  /** 在已持有的请求槽内：读回并核对体积 + updatedAt/deviceId。 */
  async function _getVerifyManifestRaw(path, body, bodyBytes, manifest) {
    const getResp = await _fetchWithTimeout(_buildUrl(path), {
      method: 'GET',
      headers: {
        'Authorization': _authHeader(),
      },
    });
    if (getResp.status === 404) return { ok: false, detail: path + ' 读回 404' };
    if (!getResp.ok) return { ok: false, detail: path + ' 读回 HTTP ' + getResp.status };
    const text = await getResp.text();
    if (!text || !text.trim()) return { ok: false, detail: path + ' 读回为空文件(0字节)' };
    if (text.trim().startsWith('<')) return { ok: false, detail: path + ' 读回为网页' };
    const textBytes = _utf8Len(text);
    const slack = Math.max(512, Math.floor(bodyBytes * 0.05));
    if (Math.abs(textBytes - bodyBytes) > slack) {
      return { ok: false, detail: path + ' 读回体积 ' + textBytes + ' ≠ 写入 ' + bodyBytes };
    }
    let rb;
    try { rb = JSON.parse(text); }
    catch (pe) { return { ok: false, detail: path + ' 读回无法解析' }; }
    if (!rb || !rb.version) return { ok: false, detail: path + ' 读回无 version' };
    if (Number(rb.updatedAt || 0) !== Number(manifest.updatedAt || 0)) {
      return { ok: false, detail: path + ' updatedAt 不一致' };
    }
    if (String(rb.deviceId || '') !== String(manifest.deviceId || '')) {
      return { ok: false, detail: path + ' deviceId 不一致' };
    }
    const et = getResp.headers.get('ETag') || getResp.headers.get('etag') || '';
    return { ok: true, textBytes, etag: (et && !et.startsWith('W/')) ? et : '' };
  }

  /** 列目录取某文件体积；找不到返回 null；明确 0 也返回 0（调用方必须把 0 当失败）。 */
  async function _propfindFileSizeRaw(fileName) {
    const pfResp = await _fetchWithTimeout(_buildUrl(''), {
      method: 'PROPFIND',
      headers: {
        'Authorization': _authHeader(),
        'Depth': '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
    });
    if (!(pfResp.ok || pfResp.status === 207)) return null;
    const entries = _parsePropfind(await pfResp.text());
    for (const e of entries) {
      let name = e.href || '';
      try { name = decodeURIComponent(name); } catch (_) {}
      name = name.replace(/\/+$/, '').split('/').pop() || '';
      if (name === fileName) return e.size;
    }
    return null;
  }

  /**
   * 写清单：覆盖 manifest.json，读回 + 列目录体积必须 >0 且≈写入。
   * 列目录为 0 = 失败。合法空库清单也有 version 等字段，绝不会是 0 字节。
   */
  async function _putManifestVerified(manifest, ifMatch) {
    if ((manifest.dataFormatVersion || 1) >= 4) _slimManifestNotes(manifest);
    const body = JSON.stringify(manifest);
    const bodyBytes = _utf8Len(body);
    // 防清空：正常清单（哪怕 notes 为空）也远大于此；0/极小 = 逻辑错误，禁止上传
    if (bodyBytes < 32) {
      throw new Error('拒绝写入过小的清单（' + bodyBytes + ' 字节），以防清空云端');
    }
    const isKoofr = (_config && _config.provider) === 'koofr';
    const slack = Math.max(512, Math.floor(bodyBytes * 0.05));
    _manifestWriting = true;
    let lastDetail = '';
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const outcome = await enqueue(async () => {
            const waitMs = attempt === 0 ? (isKoofr ? 900 : 400) : 1200;

            const useMatch = !!(attempt === 0 && ifMatch && !isKoofr && !_casForceUnconditional);
            await _putJsonRaw(MANIFEST_PATH, body, useMatch ? ifMatch : null);
            await sleep(waitMs);
            const mainOk = await _getVerifyManifestRaw(MANIFEST_PATH, body, bodyBytes, manifest);
            if (!mainOk.ok) {
              try {
                await _putJsonRaw(MANIFEST_PATH, body, null);
                await sleep(1000);
                const retryOk = await _getVerifyManifestRaw(MANIFEST_PATH, body, bodyBytes, manifest);
                if (!retryOk.ok) return { ok: false, detail: mainOk.detail + '；重写仍失败: ' + retryOk.detail };
                Object.assign(mainOk, retryOk);
              } catch (re) {
                return { ok: false, detail: mainOk.detail + '；重写异常' };
              }
            }

            // ③ 列目录：0 必须失败（这是网盘列表显示 0B 的根因缺口）
            let cloudSize = null;
            try { cloudSize = await _propfindFileSizeRaw('manifest.json'); }
            catch (_) { cloudSize = null; }
            if (cloudSize === 0) {
              return { ok: false, detail: '列目录体积为 0（正式清单未真正落盘）' };
            }
            if (cloudSize == null && isKoofr) {
              return { ok: false, detail: '列目录未找到 manifest.json' };
            }
            if (cloudSize != null && Math.abs(cloudSize - bodyBytes) > slack) {
              return {
                ok: false,
                detail: '列目录体积 ' + cloudSize + ' ≠ 写入 ' + bodyBytes,
              };
            }

            return {
              ok: true,
              etag: mainOk.etag || '',
              textBytes: mainOk.textBytes,
              cloudSize,
            };
          });

          if (outcome && outcome.ok) {
            _lastManifestEtag = outcome.etag || '';
            _authFailCount = 0;
            console.log('[webdav] 清单云端已确认', outcome.textBytes, '字节',
              outcome.cloudSize != null ? ('列目录=' + outcome.cloudSize) : '');
            await _dropLegacySidecars();
            return;
          }
          lastDetail = (outcome && outcome.detail) || '未知';
          console.warn('[webdav] 清单写入校验未通过（' + lastDetail + '），重传 #' + (attempt + 1));
        } catch (e) {
          if (e instanceof PreconditionFailedError) throw e;
          if (e instanceof RateLimitError) throw e;
          lastDetail = e.message || String(e);
          console.warn('[webdav] 清单写入异常：', lastDetail);
        }
        await sleep(500);
      }
      throw new Error('云端清单（manifest.json）写入校验失败：' + lastDetail + '。本次上传未生效，已保留本地改动，稍后会自动重试');
    } finally {
      _manifestWriting = false;
    }
  }

  /** 日常交目录：写正式文件即结束。读回对放到下次打开/强制拉。
   *  首次同步/修复/覆盖云端仍走完整核对。 */
  async function _putManifestCheap(manifest) {
    if (manifest && typeof manifest.structTailUpd === 'string' && manifest.structTailUpd) {
      try {
        await webdavPut(STRUCT_TAIL_PATH, JSON.stringify({
          v: 1, updatedAt: Date.now(), deviceId: _ensureClientId(), upd: manifest.structTailUpd,
        }), 'application/json; charset=utf-8');
        manifest.structTail = 1;
        delete manifest.structTailUpd;
      } catch (_) {}
    }
    if ((manifest.dataFormatVersion || 1) >= 4) _slimManifestNotes(manifest);
    const body = JSON.stringify(manifest);
    const bodyBytes = _utf8Len(body);
    if (bodyBytes < 32) {
      throw new Error('拒绝写入过小的清单（' + bodyBytes + ' 字节），以防清空云端');
    }
    _manifestWriting = true;
    try {
      const putEtag = await enqueue(async () => {
        return await _putJsonRaw(MANIFEST_PATH, body, null);
      });
      _lastManifestEtag = putEtag || '';
      _authFailCount = 0;
      _lastManifestObj = manifest;
      _lastGetTime = Date.now();
      _savePendingCatalogConfirm({
        rev: _catalogRev(manifest),
        updatedAt: manifest.updatedAt,
        deviceId: manifest.deviceId,
      });
      await _dropLegacySidecars();
      _rememberManifestCursor(manifest);
      try { console.log('[webdav] 名单已写', bodyBytes, '字节（核对留到下次打开）'); } catch (_) {}
    } finally {
      _manifestWriting = false;
    }
  }

  async function webdavGetNote(path, options = {}) {
    const resp = await webdavGet(path, options);
    if (!resp) return null;
    const text = await resp.text();
    if (text.trim().startsWith('<')) {
      // 代理/网盘限流或拦截时返回的 HTML 错误页：按瞬时错误处理，不能当坏文件去"修复"
      const err = new Error(`服务器/代理返回了网页而非数据 (${path})，可能被限流或拦截`);
      err.transient = true;
      throw err;
    }
    if (_config && _config.encryptNotes) {
      let json;
      try {
        json = await notesDecrypt(text);
      } catch (e) {
        // 解密失败 ≈ 加密口令不一致：绝不能标记重传"修复"（会用本地旧版覆盖云端新数据）
        const err = new Error(`笔记解密失败 (${path})：请确认各设备的加密口令一致（设置 → 同步 → 加密口令）`);
        err.decryptFail = true;
        throw err;
      }
      return _parseNoteJson(json, path);
    }
    return _parseNoteJson(text, path);
  }

  function _parseNoteJson(text, path) {
    try { return JSON.parse(text); }
    catch (e) {
      // 标记为"单文件损坏"：上层据此跳过该文件并用本地副本重传修复，而不是让整轮同步死循环
      const err = new Error(`笔记文件解析失败 (${path}): ${e.message}`);
      err.parseFail = true;
      throw err;
    }
  }

  function _hydrateYbin(note) {
    if (!note || !note.ydoc) return note;
    try {
      const Y = window.__ydoc;
      if (Y && Y.ready && Y.ready()) {
        const doc = Y.toDoc(note.ydoc);
        if (doc && doc.type === 'doc') note.doc = doc;
      }
    } catch (_) {}
    // C3（t21）：云端包不再带正文副本。账本在、正文却没能还原（引擎未就绪/异常）且包里无兜底 →
    //   本轮按瞬时错误跳过这篇，绝不把「没正文的半份」落进本地盖掉正文；引擎就绪后自然补上。
    if (!note.doc && !(note.content || '').trim()) {
      const err = new Error('账本正文还原未就绪，本轮跳过');
      err.transient = true;
      throw err;
    }
    return note;
  }
  function _noteFileOrder(id) {
    const h = _hintOf(id);
    if (h && h.k === 'j') return ['j', 'y'];
    return ['y', 'j'];
  }
  async function _getNoteCipherText(id) {
    const kinds = _noteFileOrder(id);
    for (let i = 0; i < kinds.length; i++) {
      const path = kinds[i] === 'y' ? ('notes/' + id + '.ybin') : ('notes/' + id + '.json');
      try {
        const resp = await webdavGet(path, { allow404: true });
        if (!resp) continue;
        const text = (await resp.text()).trim();
        if (!text || text.startsWith('<')) continue;
        return text;
      } catch (_) {}
    }
    return null;
  }
  async function _fetchNoteById(id, ver) {
    const v = Number(ver) || 0;
    if (_isGoneNote(id, v)) return null;
    const tryKind = async (kind) => {
      const path = kind === 'y' ? ('notes/' + id + '.ybin') : ('notes/' + id + '.json');
      try {
        const n = await webdavGetNote(path, { allow404: true });
        return n ? _hydrateYbin(n) : null;
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
        if (e && (e.decryptFail || e.parseFail || e.transient)) throw e;
        return null;
      }
    };
    const order = _noteFileOrder(id);
    for (let i = 0; i < order.length; i++) {
      const n = await tryKind(order[i]);
      if (n) { _setHint(id, order[i], v); return n; }
    }
    _setHint(id, 'x', v);
    return null;
  }

  async function webdavGetBinary(path, options = {}) {
    const resp = await webdavGet(path, options);
    if (!resp) return null;
    // 限流/拦截时返回的 HTML 错误页若被当成图片字节存下来，图片会永久损坏——识别出来按瞬时错误丢弃
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) {
      const err = new Error(`服务器/代理返回了网页而非文件 (${path})，可能被限流或拦截`);
      err.transient = true;
      throw err;
    }
    return resp;
  }

  async function webdavMkcol(path) {
    return enqueue(async () => {
      const resp = await _fetchWithTimeout(_buildUrl(path), {
        method: 'MKCOL',
        headers: { 'Authorization': _authHeader() },
      });
      if (resp.status === 405 || resp.status === 301) return resp;
      if (resp.status === 503 || resp.status === 429) throw new RateLimitError();
      if (resp.status === 423) throw await _lockedError('MKCOL', path, resp);
      if (!resp.ok && resp.status !== 201) {
        throw new WebDAVError('MKCOL', path, resp.status, await resp.text().catch(() => ''));
      }
      _authFailCount = 0;
      return resp;
    });
  }

  async function webdavDelete(path) {
    return enqueue(async () => {
      const resp = await _fetchWithTimeout(_buildUrl(path), {
        method: 'DELETE',
        headers: { 'Authorization': _authHeader() },
      });
      if (resp.status === 404) return resp;
      if (resp.status === 503 || resp.status === 429) throw new RateLimitError();
      if (resp.status === 423) throw await _lockedError('DELETE', path, resp);
      if (!resp.ok && resp.status !== 204) {
        throw new WebDAVError('DELETE', path, resp.status, await resp.text().catch(() => ''));
      }
      return resp;
    });
  }

  // ─── PROPFIND（列目录，用于"扫描云端恢复"）──────────────────────────────────
  async function webdavPropfind(path) {
    return enqueue(async () => {
      const resp = await _fetchWithTimeout(_buildUrl(path), {
        method: 'PROPFIND',
        headers: {
          'Authorization': _authHeader(),
          'Depth': '1',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
      });
      if (resp.status === 404) return [];
      if (resp.status === 503 || resp.status === 429) throw new RateLimitError();
      if (resp.status === 423) throw await _lockedError('PROPFIND', path, resp);
      if (!resp.ok && resp.status !== 207) {
        throw new WebDAVError('PROPFIND', path, resp.status, await resp.text().catch(() => ''));
      }
      _authFailCount = 0;
      return _parsePropfind(await resp.text());
    });
  }

  /** 解析 PROPFIND 的 multistatus XML，返回 [{ href, size, mtime }]，对命名空间大小写宽容 */
  function _parsePropfind(xml) {
    const out = [];
    let doc;
    try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch (_) { return out; }
    if (!doc) return out;
    const all = doc.getElementsByTagName('*');
    const responses = [];
    for (let i = 0; i < all.length; i++) {
      if ((all[i].localName || '').toLowerCase() === 'response') responses.push(all[i]);
    }
    for (const r of responses) {
      let href = '', size = 0, mtime = '';
      const kids = r.getElementsByTagName('*');
      for (let i = 0; i < kids.length; i++) {
        const ln = (kids[i].localName || '').toLowerCase();
        if (ln === 'href' && !href) href = kids[i].textContent || '';
        else if (ln === 'getcontentlength') size = parseInt(kids[i].textContent || '0', 10) || 0;
        else if (ln === 'getlastmodified') mtime = kids[i].textContent || '';
      }
      if (href) out.push({ href, size, mtime });
    }
    return out;
  }

  // ─── 错误类型 ────────────────────────────────────────────────────────────────
  class WebDAVError extends Error {
    constructor(method, path, status, body) {
      super(`WebDAV ${method} ${path} → ${status}: ${body.slice(0, 200)}`);
      this.name = 'WebDAVError'; this.status = status;
      // 429 已在各 HTTP 封装里转为 RateLimitError（限流退避），不属于认证失败，不能误触"请检查账号密码"
      if (status === 401 || status === 403) {
        _authFailCount++;
        if (_authFailCount === AUTH_FAIL_LIMIT && !_paused) {
          _paused = true;
          _emit('cloud-sync', { type: 'webdav-sync-fail', error: '认证连续失败，已暂停同步。请检查账号密码。' });
          console.warn('[webdav] 认证连续失败 ' + _authFailCount + ' 次，自动暂停');
        }
      }
    }
  }
  class RateLimitError extends Error {
    constructor() { super('WebDAV 服务器返回 503（请求过于频繁）'); this.name = 'RateLimitError'; }
  }
  // If-Match 条件写失败：manifest 在"读→改"期间被别的设备改过（服务器返回 412）。
  // 不是错误，是"被抢先"信号——上层据此放弃本次写、保留 dirty、重新读取合并后重试。
  class PreconditionFailedError extends Error {
    constructor() { super('manifest 已被其它设备更新（412），本次写入放弃，将重新合并后重试'); this.name = 'PreconditionFailedError'; }
  }
  // 423 Locked：Koofr 等 WebDAV 服务器对"加锁中"的文件返回（多为并发写同一文件时的临时锁，
  // 尤其 v3 真冲突合并后两端短时间内重写同一篇）。标 transient → 走静默重试通道
  // （_handleTransient：递增延迟 2/8/30s 自动重试，连续 4 轮才提示一次，转 60s 慢速重试，绝不丢数据），
  // 不再一遇 423 就弹硬错误红条。
  async function _lockedError(method, path, resp) {
    const e = new WebDAVError(method, path, 423, await resp.text().catch(() => ''));
    e.transient = true;
    return e;
  }

  // ─── 连接测试 ────────────────────────────────────────────────────────────────
  async function testConnection(config) {
    // 互斥：测试期间临时替换了 _config，若后台轮询此刻触发 doGet，
    // 会用"被测试的配置"去拉云端并应用到本地（可能是另一个账号的数据）——必须挡住
    if (_syncing) await _waitSyncDone();
    _syncing = true;
    const prev = _config;
    const prevFailCount = _authFailCount;
    _config = config;
    try {
      await webdavMkcol('');
      await webdavPut('_test.txt', 'ok', 'text/plain');
      const resp = await webdavGet('_test.txt');
      const text = await resp.text();
      if (text !== 'ok') throw new Error('读取验证失败：内容不匹配');
      await webdavDelete('_test.txt');
      return { ok: true };
    } catch (e) {
      if (e instanceof RateLimitError) return { ok: false, error: '服务器限流（503），请稍后重试' };
      if (e && (e.status === 401 || e.status === 403)) return { ok: false, error: '账号或密码错误，请检查' };
      if (e && e.name === 'AbortError') return { ok: false, error: '连接超时，请检查服务器地址和网络' };
      if (e && e.status === 404) return { ok: false, error: '服务器地址不存在（404），请检查网址' };
      if (e && e.status >= 500) return { ok: false, error: `服务器出错（${e.status}），请稍后重试` };
      const msg = String((e && e.message) || '');
      if (/failed to fetch|networkerror|load failed|fetch/i.test(msg)) {
        return { ok: false, error: '无法连接服务器，请检查网址和网络是否正常' };
      }
      return { ok: false, error: msg || '连接失败，请检查配置' };
    } finally {
      _config = prev;
      _authFailCount = prevFailCount;
      _syncing = false;
      _drainPending();
    }
  }

  // ─── AES-GCM 加密/解密 ──────────────────────────────────────────────────────

  async function probeCloudState(config) {
    // 互斥原因同 testConnection：探测期间 _config 被临时替换，不能让后台同步用错配置
    if (_syncing) await _waitSyncDone();
    _syncing = true;
    const prev = _config;
    const prevFailCount = _authFailCount;
    const prevStopped = _stopped;
    _config = config;
    _stopped = false; // 切换服务商时 switchSyncMethod 先 stop() 了，这里探测必须临时解除，否则 enqueue 会抛 "WebDAV sync stopped"
    try {
      // manifest 与笔记列表并行探测（原先串行两轮往返，经代理时白等一倍时间）
      const [mRes, eRes] = await Promise.allSettled([
        webdavGetJson('manifest.json', { allow404: true }),
        webdavPropfind('notes'),
      ]);
      const manifest = mRes.status === 'fulfilled' ? mRes.value : null;
      // 与「管理云端笔记」口径一致：以 notes/ 目录里实际的 .json 文件数为准
      // （manifest.notes 可能含陈旧/已删除条目，数量会偏大、和扫描对不上）。
      let noteCount = 0;
      let propfindOk = false;
      if (eRes.status === 'fulfilled') {
        propfindOk = true;
        const seen = new Set();
        for (const e of eRes.value) {
          if (!e.href || /\/$/.test(e.href)) continue;
          let name = e.href; try { name = decodeURIComponent(name); } catch (_) {}
          name = name.replace(/[#?].*$/, '');
          name = name.substring(name.lastIndexOf('/') + 1);
          if (!/\.(json|ybin)$/i.test(name)) continue;
          const id = name.replace(/\.(json|ybin)$/i, '');
          if (id) seen.add(id);
        }
        noteCount = seen.size;
      } else {
        noteCount = manifest && manifest.notes ? Object.keys(manifest.notes).length : 0; // PROPFIND 失败退回 manifest 计数
      }
      const hasData = !!manifest || (propfindOk && noteCount > 0);
      if (!hasData) return { hasData: false };
      // 口令试解（可选）：用指定口令试解 1-2 篇云端笔记，告知调用方"这把口令解不解得开云端数据"。
      // keyMatch: true=解得开 / false=解不开 / null=无法判断（无笔记、明文存储或网络问题）
      let keyMatch = null;
      if (config.testCryptoPass !== undefined && manifest && manifest.notes) {
        const ids = Object.keys(manifest.notes).filter(id => !(manifest.deleted && manifest.deleted[id]));
        for (const id of ids.slice(0, 2)) {
          try {
            const text = await _getNoteCipherText(id);
            if (!text) continue;
            if (text.startsWith('{')) break;               // 明文存储（未加密）：无口令可言
            const pass = (config.testCryptoPass || '').trim();
            const keyP = pass ? _deriveAesKey('zhinote-user:' + pass) : _getAesKey();
            try { await _aesDecryptWith(keyP, text); keyMatch = true; }
            catch (_) { keyMatch = false; }
            break;
          } catch (_) { /* 网络抖动：换下一篇 */ }
        }
      }
      return { hasData: true, noteCount, updatedAt: (manifest && manifest.updatedAt) || 0, keyMatch };
    } catch (e) {
      return { hasData: false, error: e.message };
    } finally {
      _config = prev;
      _authFailCount = prevFailCount;
      _stopped = prevStopped;
      _syncing = false;
      _drainPending();
    }
  }

  /** 用指定口令试解云端现有笔记（沿用当前已保存的连接配置，与 probeCloudState 的临时配置不同）。
   *  仅改口令的保存流程用它判断方向：解得开=口令对上直接生效；解不开=输错或要换锁。
   *  返回 { hasData, keyMatch }：keyMatch true=解得开 / false=解不开 / null=无法判断（明文存储/网络问题） */
  async function checkCloudKey(testPass) {
    if (!_config) { const ok = await loadConfig(); if (!ok) return { hasData: false, keyMatch: null }; }
    if (_syncing) await _waitSyncDone();
    _syncing = true;
    const prevStopped = _stopped;
    _stopped = false;
    try {
      const manifest = await webdavGetJson('manifest.json', { allow404: true });
      const ids = manifest && manifest.notes
        ? Object.keys(manifest.notes).filter(id => !(manifest.deleted && manifest.deleted[id]))
        : [];
      if (!ids.length) return { hasData: false, keyMatch: null };
      let keyMatch = null;
      for (const id of ids.slice(0, 2)) {
        try {
          const text = await _getNoteCipherText(id);
          if (!text) continue;
          if (text.startsWith('{')) break;              // 明文存储（未加密）：无口令可言
          const pass = (testPass || '').trim();
          const keyP = pass ? _deriveAesKey('zhinote-user:' + pass) : _getAesKey();
          try { await _aesDecryptWith(keyP, text); keyMatch = true; }
          catch (_) { keyMatch = false; }
          break;
        } catch (_) { /* 网络抖动：换下一篇 */ }
      }
      return { hasData: true, keyMatch };
    } catch (e) {
      return { hasData: false, keyMatch: null, error: e.message };
    } finally {
      _stopped = prevStopped;
      _syncing = false;
      _drainPending();
    }
  }
  async function _deriveAesKey(pass) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: AES_SALT, iterations: 100000, hash: 'SHA-256' },
      keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }
  /** 内置固定密钥：本机存储的 WebDAV 密码、同步配置导出用（与用户口令无关，保证本机凭证永远可解） */
  async function _getAesKey() {
    if (_aesKey) return _aesKey;
    _aesKey = await _deriveAesKey(AES_PASSPHRASE);
    return _aesKey;
  }
  /** 笔记内容密钥（阶段C）：用户设了加密口令则由口令派生，否则退回内置固定密钥（向后兼容）。
   *  缓存按口令字符串失效——口令一改下次加解密自动用新钥。 */
  let _notesKeyCache = null; // { pass, key }
  function _userCryptoPass() {
    try { return (window.storage.getSetting('webdavCryptoPass') || '').trim(); } catch (_) { return ''; }
  }
  async function _getNotesKey() {
    const pass = _userCryptoPass();
    if (!pass) return _getAesKey();
    if (_notesKeyCache && _notesKeyCache.pass === pass) return _notesKeyCache.key;
    const key = await _deriveAesKey('zhinote-user:' + pass);
    _notesKeyCache = { pass, key };
    return key;
  }

  async function _aesEncryptWith(keyPromise, plaintext) {
    const key = await keyPromise;
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    const buf = new Uint8Array(iv.length + ct.byteLength);
    buf.set(iv, 0); buf.set(new Uint8Array(ct), iv.length);
    return _bufToBase64(buf);
  }
  async function _aesDecryptWith(keyPromise, cipherBase64) {
    const key = await keyPromise;
    const buf = _base64ToBuf(cipherBase64);
    const iv = buf.slice(0, 12);
    const ct = buf.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }
  // 内置固定密钥版（本机凭证 / 配置导出）
  function aesEncrypt(plaintext) { return _aesEncryptWith(_getAesKey(), plaintext); }
  function aesDecrypt(cipherBase64) { return _aesDecryptWith(_getAesKey(), cipherBase64); }
  // 笔记内容版（用户口令优先）
  function notesEncrypt(plaintext) { return _aesEncryptWith(_getNotesKey(), plaintext); }
  function notesDecrypt(cipherBase64) { return _aesDecryptWith(_getNotesKey(), cipherBase64); }

  function _bufToBase64(buf) {
    let binary = '';
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    return btoa(binary);
  }
  function _base64ToBuf(b64) {
    // 容错：剥掉 base64 里可能混入的换行/空白（部分网盘/代理传输会加），防 atob 抛错
    const binary = atob(String(b64 || '').replace(/\s+/g, ''));
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return buf;
  }

  // ─── 本机同步状态持久化（双存）──────────────────────────────────────────────
  // clientId / 三方基准 / 已采纳世代 / 覆盖留底原先只存 localStorage：Quicker 端网页缓存
  // 不可靠（预热建窗/进程被杀可能整体清空——小枝设置曾因此重置，20260729t1）。这些状态一旦丢：
  //   基准缺失 → 上传防护 _guardUploadConflicts "无基准保守放行"，防裸覆盖的闸门失效；
  //   世代标记缺失 → 错过采纳模式，被权威淘汰的本地笔记会涌回云端复活；
  //   留底蒸发 → "误覆盖 100% 可找回"的终极兜底不成立；clientId 重生 → 误弹他机保护条。
  // 故改为主存 storage 设置（'_webdav…'，'_' 前缀=只存本机不上云；Quicker 端随动作状态
  // 变量 zhinote_data 落盘，重启/清缓存不丢）。localStorage 保留为旧值迁移来源 + 兜底双写。
  // 注意：这些键已在 storage.exportJSON 里排除（'_webdav' 前缀），不进备份文件。
  function _ssGet(key, lsKey) {
    try {
      const v = window.storage && window.storage.getSetting ? window.storage.getSetting(key) : undefined;
      if (v !== undefined && v !== null) return String(v);
    } catch (_) {}
    let lv = null;
    try { lv = localStorage.getItem(lsKey); } catch (_) {}
    // 旧数据一次性迁移（storage 未就绪时其内部为 no-op，下次读到再迁）
    if (lv !== null) { try { window.storage && window.storage.setSetting && window.storage.setSetting(key, lv); } catch (_) {} }
    return lv;
  }
  function _ssSet(key, lsKey, val) {
    try { window.storage && window.storage.setSetting && window.storage.setSetting(key, val); } catch (_) {}
    try { localStorage.setItem(lsKey, val); } catch (_) {}
  }

  // ─── clientId 管理 ──────────────────────────────────────────────────────────
  function _ensureClientId() {
    if (_clientId) return _clientId;
    const key = 'zhinote-webdav-clientId';
    _clientId = _ssGet('_webdavClientId', key);
    if (!_clientId) {
      _clientId = 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      _ssSet('_webdavClientId', key, _clientId);
    }
    return _clientId;
  }

  // ─── 基准版本（3-way base）────────────────────────────────────────────────────
  // 记录每篇笔记"上次成功同步时的内容指纹 + 远端时间戳"，本地持久化、不上云。
  // 用途：即使重启后 dirty 标记丢失，也能据基准判断本地是否真的改过，
  // 从而把"本地改动 + 远端改动"准确识别为真冲突（两份都留），避免静默覆盖丢数据。
  const SYNC_BASE_KEY = 'zhinote-webdav-syncbase';
  let _syncBase = null;       // { [id]: { h: contentHash, t: remoteTs } }
  let _syncBaseDirty = false;

  function _accountTag() {
    try { return _config ? (_config.url + '|' + _config.user) : ''; } catch (_) { return ''; }
  }
  // 按账号加载；空对象也算已加载（用 _syncBaseLoadedFor 区分，禁止 if (_syncBase) 把 {} 永久锁死）
  let _syncBaseLoadedFor = null;
  function _invalidateSyncBaseCache() {
    _syncBase = null;
    _syncBaseLoadedFor = null;
    _noteFileHint = null;
    _noteFileHintFor = null;
  }

  // 记住每篇云端文件是账本还是旧文件、或两边都没有。避免每轮先问不存在的文件（浏览器会红 404）。
  const NOTE_FILE_HINT_KEY = 'zhinote-note-file-hint';
  let _noteFileHint = null;
  let _noteFileHintFor = null;
  let _noteFileHintDirty = false;
  function _loadNoteFileHint() {
    const tag = _accountTag();
    if (!tag) return {};
    if (_noteFileHint !== null && _noteFileHintFor === tag) return _noteFileHint;
    _noteFileHint = {};
    _noteFileHintFor = tag;
    try {
      const raw = _ssGet('_webdavNoteFileHint', NOTE_FILE_HINT_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && o.account === tag && o.map && typeof o.map === 'object') _noteFileHint = o.map;
      }
    } catch (_) {}
    return _noteFileHint;
  }
  function _flushNoteFileHint() {
    if (!_noteFileHintDirty) return;
    _noteFileHintDirty = false;
    const tag = _accountTag();
    if (!tag) return;
    try { _ssSet('_webdavNoteFileHint', NOTE_FILE_HINT_KEY, JSON.stringify({ account: tag, map: _noteFileHint || {} })); } catch (_) {}
  }
  function _hintOf(id) {
    const h = _loadNoteFileHint()[id];
    return h && typeof h === 'object' ? h : null;
  }
  function _setHint(id, k, v) {
    _loadNoteFileHint();
    if (!_accountTag()) return;
    _noteFileHint[id] = { k: k, v: Number(v) || 0 };
    _noteFileHintDirty = true;
  }
  function _clearHint(id) {
    _loadNoteFileHint();
    if (_noteFileHint[id]) { delete _noteFileHint[id]; _noteFileHintDirty = true; }
  }
  function _isGoneNote(id, ver) {
    const h = _hintOf(id);
    if (!h || h.k !== 'x') return false;
    const v = Number(ver) || 0;
    return !v || h.v === v;
  }
  function _loadSyncBase() {
    const tag = _accountTag();
    // 配置未就绪：绝不缓存空表（否则 loadConfig 前误读一次 → 整会话基准全空 → 冷启动按篇狂下）
    if (!tag) return {};
    if (_syncBase !== null && _syncBaseLoadedFor === tag) return _syncBase;
    _syncBase = {};
    _syncBaseLoadedFor = tag;
    try {
      const raw = _ssGet('_webdavSyncBase', SYNC_BASE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        // 账号不一致（切换了服务商/账号）→ 丢弃旧基准，从零开始（安全：退回时间戳逻辑）
        if (obj && obj.account === tag && obj.map && typeof obj.map === 'object') _syncBase = obj.map;
      }
    } catch (_) {}
    return _syncBase;
  }
  function _flushSyncBase() {
    if (_syncBaseDirty) {
      _syncBaseDirty = false;
      const tag = _accountTag();
      if (tag) {
        try { _ssSet('_webdavSyncBase', SYNC_BASE_KEY, JSON.stringify({ account: tag, map: _syncBase || {} })); } catch (_) {}
      }
    }
    _flushNoteFileHint();
  }
  function _getBase(id) { return _loadSyncBase()[id] || null; }
  function _setBase(id, hash, ver) {
    _loadSyncBase();
    if (!_accountTag()) return;
    const v = Number(ver) || 0;
    _syncBase[id] = { h: hash, v: v, t: v };
    _syncBaseDirty = true;
  }
  function _baseVer(base) {
    if (!base) return 0;
    if (typeof base.v === 'number' && isFinite(base.v)) return base.v;
    return _noteTs(base.t);
  }
  function _delBase(id) { _loadSyncBase(); if (_syncBase[id]) { delete _syncBase[id]; _syncBaseDirty = true; } }

  function _loadPersistedManifestCursor() {
    // 从一本账取上次云端名单的落脚点。只存进独立变量，绝不用它拼「半份名单」塞给 _lastManifestObj——
    // 缺 notes/deleted 的假名单流进 _detectLocallyNewerNotes 会把云端已删的篇当「云上没有」顶回去。
    const c = _ledger().cursor || {};
    _lastKnownManifestUpdatedAt = Number(c.rev) || 0;
    _lastManifestEtag = (typeof c.etag === 'string') ? c.etag : '';
    _lastCursorDeviceId = (typeof c.deviceId === 'string') ? c.deviceId : '';
  }
  function _loadHealth() {
    const h = _ledger().health || {};
    _lastSyncOkAt = Number(h.okAt) || 0;
    _lastFullCheckAt = Number(h.fullAt) || 0;
  }
  function _persistHealth() {
    const led = _ledger();
    if (!led.account) return;
    const prev = led.health || {};
    led.health = { okAt: _lastSyncOkAt, fullAt: _lastFullCheckAt, checkedVer: prev.checkedVer || '' };
    _saveLedger();
  }
  function _markSyncOk() {
    _lastSyncOkAt = Date.now();
    if (_lastSyncOkAt - _lastSyncOkPersistAt > 60_000) {
      _lastSyncOkPersistAt = _lastSyncOkAt;
      _persistHealth();
    }
    // 同步顺利收尾后，避开主流程悄悄清一小口云端旧格式残留（清完后 done=1，此处零开销）
    setTimeout(() => { _autoSweepTick(); }, 8000);
  }
  function _markFullCheckDone() {
    _lastFullCheckAt = Date.now();
    if (_staleGate) {
      _staleGate = false;
      _scrubStaleDirtyAgainstManifest(_lastManifestObj);
      try { console.log('[webdav] 久闲设备完整核对完成，恢复上传'); } catch (_) {}
      if (_hasDirtyData()) { try { schedulePut('stale-gate-open'); } catch (_) {} }
    }
    _persistHealth();
  }
  /** 久闲对完云端后：云端已有或已删的篇不要再拿本机旧正文回灌；只留云端没有的本机独有篇。 */
  function _scrubStaleDirtyAgainstManifest(manifest) {
    if (!manifest || !manifest.notes || !window.storage) return;
    const dirty = window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : [];
    const drop = [];
    for (let i = 0; i < dirty.length; i++) {
      const id = dirty[i];
      if (window.storage.isRevivedFromBackup && window.storage.isRevivedFromBackup(id)) continue;
      if (manifest.deleted && manifest.deleted[id]) { drop.push(id); continue; }
      if (manifest.notes[id]) drop.push(id);
    }
    if (drop.length && window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds(drop);
    const data = window.storage.getAll && window.storage.getAll();
    const notes = (data && data.notes) || {};
    let localOnly = false;
    for (const id in notes) {
      if (manifest.deleted && manifest.deleted[id]) continue;
      if (!manifest.notes[id]) { localOnly = true; break; }
    }
    if (!localOnly && window.storage.clearGlobalDirty) window.storage.clearGlobalDirty();
  }
  /** 下行并入云端总账：采纳或久闲 → 整本听云端（禁止把本机旧标题叠上去）；日常 → 合并/认领。 */
  function _applyCloudStructOnGet(cloudLed, adoptMode) {
    if (!cloudLed || !window.storage) return null;
    if ((adoptMode || _staleGate) && window.storage._webdavReplaceStructLedger) {
      return window.storage._webdavReplaceStructLedger(cloudLed, { skipOrphan: true });
    }
    if (window.storage._webdavApplyStructLedger) {
      return window.storage._webdavApplyStructLedger(cloudLed, { skipMaintain: true, skipOrphan: true });
    }
    return null;
  }
  function _persistManifestCursor() {
    const led = _ledger();
    if (!led.account || !Number(_lastKnownManifestUpdatedAt || 0)) return;
    const deviceId = (_lastManifestObj && _lastManifestObj.deviceId) || _lastCursorDeviceId || '';
    if (deviceId) _lastCursorDeviceId = deviceId;
    led.cursor = { rev: Number(_lastKnownManifestUpdatedAt) || 0, etag: _lastManifestEtag || '', deviceId: deviceId };
    _saveLedger();
  }
  function _catalogRev(manifest) {
    if (!manifest) return 0;
    const r = Number(manifest.rev);
    if (r > 0) return r;
    return Number(manifest.updatedAt || 0);
  }
  function _rememberManifestCursor(manifest) {
    if (!manifest) return;
    const rev = _catalogRev(manifest);
    if (!rev) return;
    _lastKnownManifestUpdatedAt = rev;
    _persistManifestCursor();
  }

  // ─── epoch 权威世代（authoritative snapshot）────────────────────────────────
  // manifest.epoch 是"权威世代号"。「覆盖云端」会 +1 并写权威全集；
  // 其它已初始化设备发现 remoteEpoch > 本地 adoptedEpoch 时进入「采纳模式」：
  // 以云端为准，本地不在权威清单里的笔记 → 留底后移除、且本次不反向上传，
  // 从根上避免「旧设备把本地多余笔记涌回云端 / 全挤进一个本子」。
  // adoptedEpoch 按账号隔离持久化；首次遇到某账号时不采纳（只记录），仅当世代真正跳变才采纳。
  const ADOPTED_EPOCH_KEY = 'zhinote-webdav-epoch';
  function _getAdoptedEpoch() {
    try {
      const raw = _ssGet('_webdavEpoch', ADOPTED_EPOCH_KEY);
      if (raw) { const o = JSON.parse(raw); if (o && o.account === _accountTag() && typeof o.epoch === 'number') return o.epoch; }
    } catch (_) {}
    return null; // null = 本账号从未记录过（首次遇到）
  }
  function _setAdoptedEpoch(epoch) {
    try { _ssSet('_webdavEpoch', ADOPTED_EPOCH_KEY, JSON.stringify({ account: _accountTag(), epoch: epoch || 1 })); } catch (_) {}
  }

  // cyrb53：快速、低碰撞的字符串哈希
  function _strHash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  // 笔记**正文**指纹：只认正文(doc/content)，**不含标题**——标题已收归「结构总账」为唯一权威(Stage B2)，
  //   不再走按篇通道，改名不该被当成正文冲突。归一化行尾空格/空行/换行差异，避免序列化抖动误判。
  // ⚠️ 必须含 doc：否则正文指纹失效(编辑正文不改变指纹)。两篇不同笔记正文恰好相同 → 指纹相同无妨：
  //    本函数只做「同一 id 的本地↔远端」比对，从不跨笔记比对(全部用法见文件内 _noteHash 调用处)。
  // 规范化 doc 结构：递归按键名排序、丢弃「空的 content/marks 数组」。
  //   只做**语义无损**的整理（JSON 键顺序、空数组本就无意义）——绝不动文字/属性，
  //   所以两篇真不同的正文不会被误判成相同（不丢改动），而同一篇正文无论经哪条路
  //   （实时逐字 / 网盘下载 / 账本合并）落地，规范化结果都一致。
  //   根治「文字一模一样、内部 JSON 字段顺序/空段落写法不同 → 指纹不同 → 假冲突」。
  function _canonJson(v) {
    if (Array.isArray(v)) return v.map(_canonJson);
    if (v && typeof v === 'object') {
      const out = {};
      const keys = Object.keys(v).sort();
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]; const val = v[k];
        if ((k === 'content' || k === 'marks') && Array.isArray(val) && val.length === 0) continue; // 空=无
        out[k] = _canonJson(val);
      }
      return out;
    }
    return v;
  }
  function _noteHash(note) {
    if (!note) return '';
    // doc 为事实来源时用其**规范化**后的 JSON 串做指纹（跨路径/跨设备稳定，见 _canonJson）。
    let c;
    if (note.doc) {
      try { c = JSON.stringify(_canonJson(note.doc)); } catch (_) { c = ''; }
    } else {
      c = (note.content || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
    }
    return _strHash(c);
  }

  // 元数据（非正文）字段：随「谁 updatedAt 更晚谁生效」(LWW) 合并，与正文(Yjs 账本)解耦。
  // 关键修复：置顶(pinnedAt)/颜色/图标/移动(parentId,order)/换笔记本(workspaceId)/改名(title)
  // 这些「只改属性、不动正文」的变更，_noteHash 看不见，旧逻辑会因「正文指纹一致」误判
  // 「无变化」而丢弃本地脏标记 → 置顶传不上去（本次根因）。这里把元数据单独按时间 LWW 合并。
  // 注意：**不含 frac、也不含 order**。日常排序权威 = 结构总账。文件可以带 frac，但只给「对端还没有这篇」落座用；
  //   已有笔记由 _webdavApplyNote 保留本地 frac，不走按篇时间 LWW（t33/t34：两套裁判会反复重排）。
  // 注意：**不含 title**（Stage B2 起标题也收归结构总账权威，不走按篇 LWW；正文指纹也已不含标题）。
  //   也不含 frac/order（见上）。这些字段在 storage._webdavApplyNote 里被「保留本地」，按篇通道一律不仲裁。
  const _META_FIELDS = ['pinnedAt', 'color', 'icon', 'parentId', 'workspaceId', 'expanded'];
  function _metaSig(note) {
    if (!note) return '';
    return _META_FIELDS.map(k => k + '=' + JSON.stringify(note[k] === undefined ? null : note[k])).join('|');
  }
  function _noteTime(note) {
    const t = note && note.updatedAt ? new Date(note.updatedAt).getTime() : 0;
    return isNaN(t) ? 0 : t;
  }
  /** 取两端元数据字段：谁 updatedAt 更晚采用谁的（本地并列时本地优先）。返回字段对象。 */
  function _mergeMeta(localNote, remoteNote) {
    const winner = _noteTime(localNote) >= _noteTime(remoteNote) ? localNote : remoteNote;
    const out = {};
    for (const k of _META_FIELDS) out[k] = winner[k];
    return out;
  }

  // ─── 数据格式版本闸（dataFormatVersion）────────────────────────────────────────
  // 本客户端支持的最高数据格式版本。
  //   v2 = 笔记内容 JSON 化（note.doc）。
  //   v3 = 在 v2 基础上每篇带「合并账本」(note.ydoc)，真冲突自动合并而非冒副本。
  //   v4 = 收口搬家：总目录不再写标题/父子（只认结构总账）；升版前先备份到 ZhiNote-bak。
  //   v5 = 最终收口：名单只记版本；正文以账本文件 notes/<id>.ybin 为准；不再用钟决定下不下。
  // 云端 manifest.dataFormatVersion 高于此值 → 旧客户端停止同步并提示更新，绝不下载/上传。
  const SUPPORTED_DATA_FORMAT = 5;
  function _localDataFormat() {
    try { return (window.storage.getDataFormatVersion && window.storage.getDataFormatVersion()) || 1; }
    catch (_) { return 1; }
  }
  function _remoteFormatTooNew(manifest) {
    return !!manifest && (manifest.dataFormatVersion || 1) > SUPPORTED_DATA_FORMAT;
  }

  function _noteVer(entry) {
    if (entry == null) return 0;
    if (typeof entry === 'number' && isFinite(entry)) return entry > 0 ? entry : 0;
    if (typeof entry === 'object') {
      if (typeof entry.v === 'number' && isFinite(entry.v) && entry.v > 0) return entry.v;
      return _noteTs(entry.updatedAt) || 0;
    }
    return _noteTs(entry) || 0;
  }
  function _slimManifestNotes(manifest) {
    if (!manifest || !manifest.notes) return;
    for (const id in manifest.notes) {
      const v = _noteVer(manifest.notes[id]) || 1;
      const empty = !!(manifest.notes[id] && manifest.notes[id].empty);
      manifest.notes[id] = empty ? { v: v, empty: 1 } : { v: v };
    }
  }

  async function _mkcolRoot(rootDir) {
    return enqueue(async () => {
      const resp = await _fetchWithTimeout(_buildUrlIn(rootDir, ''), {
        method: 'MKCOL',
        headers: { 'Authorization': _authHeader() },
      });
      if (resp.status === 405 || resp.status === 301 || resp.status === 201 || resp.ok) return;
    });
  }

  async function _putInRoot(rootDir, path, body) {
    return enqueue(async () => {
      const headers = {
        'Authorization': _authHeader(),
        'Content-Type': 'application/json; charset=utf-8',
      };
      let resp = await _fetchWithTimeout(_buildUrlIn(rootDir, path), { method: 'PUT', headers, body });
      if (resp.status === 404 || resp.status === 409) {
        await _fetchWithTimeout(_buildUrlIn(rootDir, ''), {
          method: 'MKCOL',
          headers: { 'Authorization': _authHeader() },
        });
        resp = await _fetchWithTimeout(_buildUrlIn(rootDir, path), { method: 'PUT', headers, body });
      }
      if (resp.status === 503 || resp.status === 429) throw new RateLimitError();
      if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
        throw new WebDAVError('PUT', rootDir + '/' + path, resp.status, await resp.text().catch(() => ''));
      }
    });
  }

  async function _getJsonInRoot(rootDir, path) {
    return enqueue(async () => {
      const resp = await _fetchWithTimeout(_buildUrlIn(rootDir, path), {
        method: 'GET',
        headers: { 'Authorization': _authHeader() },
      });
      if (resp.status === 404) return null;
      if (resp.status === 503 || resp.status === 429) throw new RateLimitError();
      if (!resp.ok) return null;
      const text = await resp.text();
      if (!text || !text.trim() || text.trim().charAt(0) === '<') return null;
      try { return JSON.parse(text); } catch (_) { return null; }
    });
  }

  async function _copyLiveToBak(relPath) {
    const resp = await webdavGet(relPath, { allow404: true });
    if (!resp || resp === NOT_MODIFIED) return false;
    const text = await resp.text();
    if (!text || !text.trim() || text.trim().charAt(0) === '<') return false;
    await _putInRoot(BAK_DIR, relPath, text);
    return true;
  }

  let _v4MigratePromise = null;
  async function _ensureV3BackupAndV4Gate(manifest) {
    if (!manifest || typeof manifest !== 'object') return manifest;
    if ((manifest.dataFormatVersion || 1) >= 4) return manifest;
    if (_v4MigratePromise) return _v4MigratePromise;
    _v4MigratePromise = (async () => {
      let marker = null;
      try { marker = await _getJsonInRoot(BAK_DIR, 'backup.json'); } catch (_) { marker = null; }
      if (!(marker && marker.ok)) {
        await _mkcolRoot(BAK_DIR);
        const copied = [];
        const files = ['manifest.json', 'manifest.bak.json', 'struct-ledger.json'];
        for (let i = 0; i < files.length; i++) {
          try {
            if (await _copyLiveToBak(files[i])) copied.push(files[i]);
          } catch (e) {
            console.warn('[webdav] 备份失败', files[i], e && e.message);
          }
        }
        if (copied.indexOf('manifest.json') < 0) {
          throw new Error('无法备份云端总目录到 ZhiNote-bak，已中止升级，以免无法退回');
        }
        const meta = {
          ok: true,
          v: 1,
          fromFormat: manifest.dataFormatVersion || 1,
          toFormat: 4,
          at: Date.now(),
          files: copied,
          note: '旧库备份。图仍在 ZhiNote/images。两端都换新包并对齐后，可手动删除本文件夹。程序不会自动删。',
        };
        await _putInRoot(BAK_DIR, 'backup.json', JSON.stringify(meta));
        try { console.log('[webdav] 已备份旧库到 ZhiNote-bak', copied.join(',')); } catch (_) {}
      }
      manifest.dataFormatVersion = 4;
      manifest.updatedAt = Date.now();
      manifest.deviceId = _ensureClientId();
      _slimManifestNotes(manifest);
      await _putManifestCheap(manifest);
      _emit('cloud-sync', { type: 'webdav-v4-migrated' });
      return manifest;
    })().finally(() => { _v4MigratePromise = null; });
    return _v4MigratePromise;
  }

  let _v5MigratePromise = null;
  async function _ensureV5Index(manifest) {
    if (!manifest || typeof manifest !== 'object') return manifest;
    if ((manifest.dataFormatVersion || 1) >= 5) {
      _slimManifestNotes(manifest);
      return manifest;
    }
    if ((manifest.dataFormatVersion || 1) < 4) return manifest;
    if (_v5MigratePromise) return _v5MigratePromise;
    _v5MigratePromise = (async () => {
      _slimManifestNotes(manifest);
      manifest.dataFormatVersion = 5;
      manifest.rev = (Number(manifest.rev) || 0) + 1;
      manifest.updatedAt = Date.now();
      manifest.deviceId = _ensureClientId();
      await _putManifestCheap(manifest);
      _emit('cloud-sync', { type: 'webdav-v5-migrated' });
      return manifest;
    })().finally(() => { _v5MigratePromise = null; });
    return _v5MigratePromise;
  }

  // ─── 覆盖前留底（终极兜底）────────────────────────────────────────────────────
  // 任何"用远端覆盖/删除本地笔记"的动作之前，先把本地旧内容存进本地留底区。
  // 即使冲突判断有 bug 误覆盖，被覆盖的内容也 100% 可从这里找回 —— 数据物理上不丢。
  const BACKUP_KEY = 'zhinote-overwrite-backup';
  const BACKUP_MAX_ENTRIES = 40;
  const BACKUP_MAX_BYTES = 1_500_000;

  function _readBackups() {
    try { const raw = _ssGet('_webdavBackups', BACKUP_KEY); return raw ? JSON.parse(raw) : []; }
    catch (_) { return []; }
  }
  function _writeBackups(list) {
    // 先按条数截断，再按总体积截断（都保留最新的，丢最旧的）
    let arr = list.slice(0, BACKUP_MAX_ENTRIES);
    while (arr.length > 1 && JSON.stringify(arr).length > BACKUP_MAX_BYTES) arr.pop();
    try { _ssSet('_webdavBackups', BACKUP_KEY, JSON.stringify(arr)); } catch (_) {}
  }
  /** 覆盖/删除本地笔记前留底。note 为本地旧笔记对象，reason 说明触发原因。 */
  function _backupBeforeOverwrite(id, note, reason) {
    try {
      if (!note) return;
      const content = note.content || '';
      // v2 笔记的正文事实来源是 doc(JSON)，content 可能为空/陈旧；两者皆空且无标题才视为空笔记
      const doc = note.doc ? JSON.parse(JSON.stringify(note.doc)) : undefined;
      if (!content && !doc && !(note.title || '')) return; // 空笔记不值得留底
      const list = _readBackups();
      list.unshift({
        savedAt: Date.now(),
        id,
        title: note.title || '无标题',
        content,
        doc,
        ydoc: note.ydoc || undefined,  // 合并账本随留底一起保存，还原后账本仍完整（v3）
        parentId: note.parentId == null ? null : note.parentId,
        workspaceId: note.workspaceId || undefined,
        updatedAt: note.updatedAt || null,
        reason: reason || 'overwrite',
      });
      _writeBackups(list);
    } catch (e) { console.warn('[webdav] 留底失败', e); }
  }
  /** 列出留底（仅元信息，不含正文，避免占内存）。 */
  function listLocalBackups() {
    return _readBackups().map(b => ({ savedAt: b.savedAt, id: b.id, title: b.title, reason: b.reason, size: (b.content || '').length || (b.doc ? JSON.stringify(b.doc).length : 0), updatedAt: b.updatedAt }));
  }
  /** 把某条留底作为一篇新笔记还原回笔记列表，返回新 id 或 null。 */
  function restoreLocalBackup(savedAt) {
    try {
      const b = _readBackups().find(x => x.savedAt === savedAt);
      if (!b || !window.storage || !window.storage._webdavApplyNote) return null;
      const newId = b.id + '__bk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const when = new Date(b.savedAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const note = {
        id: newId,
        title: `${(b.title || '无标题').replace(/（覆盖留底[^）]*）\s*$/, '')}（覆盖留底 ${when}）`,
        content: b.content || '',
        parentId: null,
        workspaceId: b.workspaceId,
        updatedAt: new Date().toISOString(),
      };
      if (b.doc) note.doc = JSON.parse(JSON.stringify(b.doc));
      if (b.ydoc) note.ydoc = b.ydoc;  // 还原合并账本（v3）
      window.storage._webdavApplyNote(newId, note);
      const d = window.storage.getAll();
      if (d.rootOrder && !d.rootOrder.includes(newId)) d.rootOrder.push(newId);
      if (window.storage.markNotesDirtyByIds) window.storage.markNotesDirtyByIds([newId]);
      window.storage.save({ immediate: true });
      return newId;
    } catch (e) { console.warn('[webdav] 还原留底失败', e); return null; }
  }
  function clearLocalBackups() {
    try { _ssSet('_webdavBackups', BACKUP_KEY, ''); } catch (_) {}
    try { localStorage.removeItem(BACKUP_KEY); } catch (_) {}
  }

  // ─── 配置加载 ────────────────────────────────────────────────────────────────
  async function loadConfig() {
    if (!window.storage) return false;
    const url = window.storage.getSetting('webdavUrl');
    const user = window.storage.getSetting('webdavUser');
    const encPass = window.storage.getSetting('webdavPass');
    if (!url || !user || !encPass) return false;
    let pass;
    try { pass = await aesDecrypt(encPass); }
    catch (e) { console.warn('[webdav] 密码解密失败:', e.message); return false; }
    _config = {
      url: url.replace(/\/+$/, '') + '/',
      user, pass,
      provider: window.storage.getSetting('webdavProvider') || 'custom',
      encryptNotes: window.storage.getSetting('webdavEncryptNotes') === true,
      // 跨域代理前缀（仅网页宿主需要；本机专属设置，不上云）
      proxy: resolveProxy(window.storage.getSetting('webdavProxy')),
    };
    _applyProviderTuning(_config.provider);
    _ensureClientId();
    // 换账号/重载后按新账号重载基准与一本账（禁止沿用上一账号的内存残值）
    _invalidateSyncBaseCache();
    _acct = null;              // 一本账重取：_ledger() 会按新账号自动加载
    _structSnapSVMem = '';
    _lastManifestObj = null;
    _loadPersistedManifestCursor();
    _loadHealth();
    const hasLib = _hasLocalLibrary();
    _staleGate = _evalStaleGate(_lastSyncOkAt, Date.now(), hasLib);
    if (!_lastSyncOkAt && hasLib === false) {
      // 空库新装：从现在起算。有库或库未就绪不当新装——否则闲设备升级后立刻灌旧账。
      _lastSyncOkAt = Date.now();
      _persistHealth();
    }
    if (_staleGate) console.warn('[webdav] 本机太久没同步或刚从旧版升上来：先完整核对云端，核对完成前不上传');
    // 重载配置（含改口令后）即解除"口令不一致"上传闸，让新口令重新接受 doGet 检验
    _decMismatch = false;
    _decFailRounds = 0;
    _skipBadNotes = {}; // 换口令/重载配置后僵尸名单作废，全部重试一遍
    // 配置就绪即连（t20）：即时层启动时常因 _config 未就绪连不上、要干等 6s 看门狗兜底重试
    //   （= 用户感知"打开后紫点亮得慢"）。此刻配置刚就绪 → 主动通知即时层立刻连（幂等，已连则零开销早退）。
    try { window.realtime && window.realtime.applyConfig && window.realtime.applyConfig(); } catch (_) {}
    return true;
  }

  // ─── 事件发射 ────────────────────────────────────────────────────────────────
  function _emit(event, payload) {
    if (payload && payload.type === 'webdav-sync-ok') _markSyncOk();
    if (window.storage && window.storage._emitCloudSync) {
      window.storage._emitCloudSync(payload);
    }
  }

  // 清单/笔记时间戳统一成毫秒数字（兼容旧端写入的 ISO 字符串；字符串与数字直接比会恒假）。
  function _noteTs(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) {
      const n = Number(v);
      return isFinite(n) ? n : 0;
    }
    const t = new Date(v || 0).getTime();
    return isFinite(t) ? t : 0;
  }

  // 是否应下载该篇（下载闸唯一谓词；保护条与 _applyRemoteChanges 共用）。
  // 20260814t6：按「这篇有没有比本地新」下，不按「目录时间跟记号不一致就整库下」。
  // 没打开的笔记只要云端这篇时间更新，一样会下——不是只同步当前篇。
  function _isEmptyBody(note) {
    if (!note) return true;
    try {
      if (note.doc && note.doc.content) {
        const c = note.doc.content;
        if (!c.length) return true;
        if (c.length === 1 && c[0] && c[0].type === 'paragraph' && !(c[0].content && c[0].content.length)) return true;
        return false;
      }
    } catch (_) {}
    return !(note.content || '').trim();
  }
  function _shouldDownloadNote(id, manifest, data) {
    if (!manifest || !manifest.notes || !manifest.notes[id]) return false;
    if (manifest.deleted && manifest.deleted[id]) return false;
    if (window.storage.isNoteDeleted && window.storage.isNoteDeleted(id)) return false;
    const remoteV = _noteVer(manifest.notes[id]);
    if (_isKnownBadNote(id, remoteV)) return false;
    const localNote = data.notes && data.notes[id];
    const trash = data.trash || {};
    if (manifest.notes[id].empty && !localNote) return false;
    if (!localNote) return !trash[id];
    const pendingV = Number(_pendingVers()[id] || 0);
    if (pendingV && pendingV >= remoteV) return false;
    const base = _getBase(id);
    const localV = _baseVer(base);
    if (base && localV > remoteV && _noteHash(localNote) === base.h) return false;
    if (_isEmptyBody(localNote)) {
      if (!base) return true;
      if (remoteV !== localV) return true;
      if (_noteHash(localNote) !== base.h) return true;
    }
    if (base && localV === remoteV && _noteHash(localNote) === base.h) return false;
    if (remoteV !== localV) return true;
    return false;
  }

  // 远端 manifest 是否真的带来了本地需要下载的变更（新增 / 更新的笔记）。
  function _hasIncomingChanges(manifest) {
    return _listNotesToDownload(manifest).length > 0;
  }
  function _listNotesToDownload(manifest) {
    if (!manifest || !manifest.notes) return [];
    const data = window.storage.getAll();
    const ids = [];
    for (const id in manifest.notes) {
      if (_shouldDownloadNote(id, manifest, data)) ids.push(id);
    }
    return ids;
  }
  /** 是否值得弹只读保护条（宁可不弹也不误挡打字）：
   *  - 采纳/权威对齐：仍弹
   *  - 一次待下 ≥5 篇：仍弹
   *  - 小改（含当前篇）：不弹，后台静默合并 */
  function _shouldShowSyncProtection(manifest, opts) {
    const adoptMode = !!(opts && opts.adoptMode);
    if (adoptMode) return true;
    return _listNotesToDownload(manifest).length >= 5;
  }

  // ─── 瞬时错误熔断 ─────────────────────────────────────────────────────────────
  // webdavGetJson 内部已各重试 3 次；到这里每 +1 相当于又一整轮失败。
  // 连续多轮仍失败（如云端 manifest 已是 0 字节坏文件）就不能再装"同步中"无限快速重试：
  // 如实报错 + 给修复指引，并退避到慢速重试，避免死循环。
  let _transientFailStreak = 0;
  const TRANSIENT_FAIL_LIMIT = 4;

  // 网络味错误识别（兜底）：transient 标记可能在错误被重新包装时丢失（如 new Error 转抛），
  // 这里按错误文案再认一次，确保纯网络问题永远不会以原始英文直接弹给用户。
  function _isNetFlavorError(e) {
    const s = String((e && e.name) || '') + ' ' + String((e && e.message) || '');
    return /abort|failed to fetch|networkerror|network error|load failed|timed? ?out/i.test(s);
  }

  // 回前台宽限：刚从后台回来的几秒内，网络味失败（Failed to fetch）不计熔断——
  // 浏览器/代理醒神期的空枪不该弹「连续多次失败」（用户实测：放后台再开就误报，关掉后徽标又绿）。
  let _wakeGraceUntil = 0;
  const WAKE_GRACE_MS = 5000;
  const WAKE_GET_DELAY_MS = 1000;
  // 后台失败或回前台延迟拉时仍 hidden：记一笔「待补拉」，可见/show/联网后再强制拉。
  // 绝不靠「后台不重试」省 toast——重试与弹窗要拆开（见变更日志 20260803t1）。
  let _pendingWakeGet = false;

  function _handleTransient(e, kind, retryFn) {
    // 断网期间失败是预期行为：不计熔断、不报错。恢复时 online 事件会强拉一次并 drain 待传数据。
    if (!navigator.onLine) {
      _transientFailStreak = 0;
      _pendingWakeGet = true;
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'retry-transient', silent: true });
      console.warn(`[webdav] ${kind}失败但当前离线，等待网络恢复:`, e.message);
      return;
    }
    // 页在后台：不计熔断、不弹错；记待补拉（回前台 / Quicker show / online 再拉）
    if (typeof document !== 'undefined' && document.hidden) {
      _pendingWakeGet = true;
      console.warn(`[webdav] ${kind}失败但页面在后台，已记待补拉、等回前台再拉:`, e.message);
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'retry-transient', silent: true });
      return;
    }
    // 回前台宽限期内的网络味错误：静默短延迟重试，不累计熔断
    if (Date.now() < _wakeGraceUntil && _isNetFlavorError(e)) {
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'retry-transient', silent: true });
      console.warn(`[webdav] ${kind}失败仍在回前台宽限内，不计熔断:`, e.message);
      setTimeout(retryFn, 1500);
      return;
    }
    _transientFailStreak++;
    if (_transientFailStreak >= TRANSIENT_FAIL_LIMIT) {
      const hint = /manifest\.json/.test(e.message || '') && /空内容|空文件|解析失败/.test(e.message || '')
        ? '云端清单文件（manifest.json）疑似已损坏。将自动尝试轻量修复；仍失败时请在云同步菜单点「修复云端清单」。'
        : '请检查网络或网盘服务是否正常，稍后会自动重试。';
      // 只在"首次越过熔断阈值"时弹错误提示；之后慢速重试期间只更新角标，不再反复弹同样的错误
      if (_transientFailStreak === TRANSIENT_FAIL_LIMIT) {
        _emit('cloud-sync', { type: 'webdav-sync-fail', error: `连续多次${kind}失败：${e.message}。${hint}` });
      } else {
        _emit('cloud-sync', { type: 'webdav-sync-fail', error: `连续多次${kind}失败：${e.message}。${hint}`, silent: true });
      }
      console.error(`[webdav] ${kind}瞬时错误已连续 ${_transientFailStreak} 轮，转入慢速重试:`, e.message);
      setTimeout(retryFn, 60_000);
    } else {
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'retry-transient', silent: true });
      console.warn(`[webdav] ${kind}瞬时错误，稍后重试:`, e.message);
      // 递增间隔（2s/8s/30s）：原先固定 2s，4 轮 8 秒就报错——手机切换 Wi-Fi/蜂窝、
      // 过电梯等正常波动都会触发"换代理"级别的误报。现在容忍约 40s 持续失败才告警。
      const delays = [2000, 8000, 30000];
      setTimeout(retryFn, delays[Math.min(_transientFailStreak - 1, delays.length - 1)]);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 清单损坏路径（20260805t1/t2）——与上方「正常同步」严格隔离
  // · 正常 doGet/doPut：清单可读 → 只走合并/上传，绝不因「有入站更新」去重建清单
  // · 仅当连续确认仍「空内容/解析失败」或结构无 version 时，才进入本段
  // · 本机 _manifestWriting 时读空 → 绝不自愈（t2：防单设备写入中间态触发修风暴）
  // · 修复权威：云端 notes/ 文件列表 + 时间戳只升不降；不 bump epoch；修时期暂停即时入口
  // · 记录见 docs/清单损坏与修复.md
  // ═══════════════════════════════════════════════════════════════════════════
  let _manifestRepairing = false;
  let _manifestAutoHealCount = 0;
  let _manifestAutoHealAt = 0;
  const MANIFEST_AUTO_HEAL_MAX = 2;
  const MANIFEST_AUTO_HEAL_COOLDOWN_MS = 3 * 60_000;

  function _isManifestCorruptError(e) {
    const m = String((e && e.message) || '');
    return m.indexOf('manifest.json') >= 0 && /空内容|空文件|解析失败|Unexpected end|Unexpected token/.test(m);
  }

  function _propfindNameId(href) {
    const name = String(href || '').replace(/\/+$/, '').split('/').pop() || '';
    // v5 后正文文件是 <id>.ybin，.json 是搬家前残留与回收站文件——两种都得认。
    //   曾只认 .json：全 .ybin 的云端会被"修复清单"数成 0 篇，云端独有笔记被挤出重建清单（t22 修）。
    if (!name || !/\.(json|ybin)$/i.test(name)) return null;
    if (name === 'manifest.json' || name === 'manifest.json.tmp') return null;
    return name.replace(/\.(json|ybin)$/i, '');
  }

  /**
   * 轻量修复：只重写清单，不重传笔记正文。
   * auto=true：静默自愈（限频）；auto=false：用户一键。
   */
  async function _repairManifestLight(opts) {
    const auto = !!(opts && opts.auto);
    if (_manifestRepairing) return { ok: false, error: '清单修复正在进行' };
    if (!_config) return { ok: false, error: '同步未配置' };
    _manifestRepairing = true;
    let rtGate = false;
    try {
      try {
        if (window.realtime && window.realtime.beginAuthoritativeReset) {
          window.realtime.beginAuthoritativeReset();
          rtGate = true;
        }
      } catch (_) {}

      const data = window.storage.getAll() || {};
      let noteEntries = [];
      let trashEntries = [];
      try {
        noteEntries = await webdavPropfind('notes');
      } catch (e) {
        return { ok: false, error: '无法列出云端笔记目录（未写入清单，防误救）：' + (e.message || e) };
      }
      try { trashEntries = await webdavPropfind('trash'); } catch (_) { trashEntries = []; }

      const cloudNotes = {};
      for (const ent of noteEntries) {
        const id = _propfindNameId(ent.href);
        if (!id) continue;
        // 同一 id 可能 .ybin 与残留 .json 并存 → 取较新的 mtime
        cloudNotes[id] = Math.max(cloudNotes[id] || 0, _noteTs(ent.mtime));
      }
      const cloudTrash = {};
      for (const ent of trashEntries) {
        const id = _propfindNameId(ent.href);
        if (!id) continue;
        cloudTrash[id] = Math.max(cloudTrash[id] || 0, _noteTs(ent.mtime));
      }

      const localNoteIds = Object.keys(data.notes || {});
      const localTrashIds = Object.keys(data.trash || {});
      if (!Object.keys(cloudNotes).length && !localNoteIds.length && !localTrashIds.length && !Object.keys(cloudTrash).length) {
        return { ok: false, error: '云端与本机都没有笔记，无法重建清单' };
      }

      const manifest = _createEmptyManifest();
      const adopted = _getAdoptedEpoch();
      manifest.epoch = (typeof adopted === 'number' && adopted > 0) ? adopted : 1; // 不 bump

      const allLive = new Set([...Object.keys(cloudNotes), ...localNoteIds]);
      const localOnly = [];
      for (const id of allLive) {
        if (cloudTrash[id] && !(data.notes && data.notes[id])) continue;
        const local = data.notes && data.notes[id];
        const cloudMt = cloudNotes[id] || 0;
        const localTs = local ? _noteTs(local.updatedAt) : 0;
        if (!local && !cloudMt) continue;
        if (local && !cloudNotes[id]) localOnly.push(id);
        // 时间戳只升不降：max(本机, 云端文件 mtime)
        const updatedAt = Math.max(localTs, cloudMt, 0) || Date.now();
        manifest.notes[id] = {
          updatedAt,
          title: (local && local.title) || '',
          parentId: local ? (local.parentId == null ? null : local.parentId) : null,
        };
      }
      for (const id of new Set([...Object.keys(cloudTrash), ...localTrashIds])) {
        const local = data.trash && data.trash[id];
        const cloudMt = cloudTrash[id] || 0;
        const localTs = local ? _noteTs(local.updatedAt || local.deletedAt) : 0;
        manifest.trash[id] = { updatedAt: Math.max(localTs, cloudMt, 0) || Date.now() };
      }

      manifest.rootOrder = Array.isArray(data.rootOrder) ? data.rootOrder.slice() : [];
      manifest.trashOrder = Array.isArray(data.trashOrder) ? data.trashOrder.slice() : [];
      manifest.wsDeleted = { ...(data.wsTombstones || {}) };
      manifest.workspaces = (data.workspaces || []).filter(w => w && w.id && !manifest.wsDeleted[w.id]);
      manifest.tplDeleted = { ...(data.tplTombstones || {}) };
      manifest.templates = (data.templates || []).filter(t => t && t.id && !manifest.tplDeleted[t.id]);
      manifest.settings = _extractSharedSettings(data.settings || {});
      try {
        if (window.storage._webdavGetStructLedger) {
          const led = window.storage._webdavGetStructLedger();
          if (led) await _persistStructLedgerExternal(manifest, led, { forceFull: true });
        }
      } catch (_) {}
      // 图片：只记本机已知 hash→ext，不重传
      if (window.storage.imagesReady) await window.storage.imagesReady();
      const localImages = (window.storage.getImageMap && window.storage.getImageMap()) || data.localImages || {};
      manifest.images = {};
      for (const hash of Object.keys(localImages)) {
        const { ext } = _dataUrlToBlob(localImages[hash]);
        if (ext) manifest.images[hash] = ext;
      }

      manifest.updatedAt = Date.now();
      manifest.deviceId = _ensureClientId();
      manifest.dataFormatVersion = _localDataFormat();

      // 正式写：无 If-Match（损坏文件 ETag 不可信）
      await _putManifestVerified(manifest, null);
      _lastManifestEtag = '';
      _rememberManifestCursor(manifest);
      _transientFailStreak = 0;
      _setAdoptedEpoch(manifest.epoch);

      if (localOnly.length && window.storage.markNotesDirtyByIds) {
        window.storage.markNotesDirtyByIds(localOnly);
        try { schedulePut('manifest-heal-localOnly'); } catch (_) {}
      }

      if (auto) {
        _manifestAutoHealCount++;
        _manifestAutoHealAt = Date.now();
      }
      console.warn('[webdav] 清单损坏路径：轻量修复成功', {
        auto, notes: Object.keys(manifest.notes).length, trash: Object.keys(manifest.trash).length, localOnly: localOnly.length,
      });
      _emit('cloud-sync', {
        type: 'webdav-manifest-healed',
        auto, noteCount: Object.keys(manifest.notes).length,
      });
      return { ok: true, noteCount: Object.keys(manifest.notes).length, auto };
    } catch (e) {
      console.error('[webdav] 清单损坏路径：轻量修复失败', e);
      return { ok: false, error: e.message || String(e) };
    } finally {
      if (rtGate) {
        try { window.realtime && window.realtime.endAuthoritativeReset && window.realtime.endAuthoritativeReset(); } catch (_) {}
      }
      _manifestRepairing = false;
    }
  }

  async function _tryAutoHealCorruptManifest() {
    if (_manifestRepairing || _manifestWriting) return { ok: false, error: 'busy' };
    if (_manifestAutoHealCount >= MANIFEST_AUTO_HEAL_MAX) {
      console.warn('[webdav] 清单损坏路径：本会话自动修复已达上限，改由用户一键修复');
      return { ok: false, error: 'auto-heal-limit' };
    }
    if (_manifestAutoHealCount > 0 && (Date.now() - _manifestAutoHealAt) < MANIFEST_AUTO_HEAL_COOLDOWN_MS) {
      console.warn('[webdav] 清单损坏路径：自动修复冷却中，跳过');
      return { ok: false, error: 'auto-heal-cooldown' };
    }
    return _repairManifestLight({ auto: true });
  }

  /**
   * 正常同步读清单入口：可读则原样返回（含 404→null、304→哨兵）。
   * 正式清单空/坏时限频自愈。
   */
  async function _loadManifestForSync(options) {
    try {
      return await webdavGetJson(MANIFEST_PATH, options || {});
    } catch (e) {
      if (!_isManifestCorruptError(e)) throw e;
      if (_manifestWriting || _manifestRepairing) {
        console.warn('[webdav] 清单读空但本机正在写入/修复，跳过自愈');
        throw e;
      }
      let lastErr = e;
      for (let i = 0; i < 2; i++) {
        await sleep(800);
        if (_manifestWriting || _manifestRepairing) throw lastErr;
        try {
          return await webdavGetJson(MANIFEST_PATH, { allow404: true });
        } catch (e2) {
          if (!_isManifestCorruptError(e2)) throw e2;
          lastErr = e2;
        }
      }
      console.warn('[webdav] 清单损坏路径：连续确认仍失败，尝试限频自愈 —', lastErr.message);
      const heal = await _tryAutoHealCorruptManifest();
      if (!heal.ok) throw lastErr;
      return await webdavGetJson(MANIFEST_PATH, { allow404: true });
    }
  }

  // ─── GET（下载检查）────────────────────────────────────────────────────────────
  // strict：手动同步专用——错误除了走常规处理（重试/熔断/提示）外还会原样上抛，
  // 让"立即同步"按钮如实显示失败，而不是把错误内部消化后假装"同步完成"。
  // full：慢核对/久闲核对——不走任何跳过近路（不带旧标记、名单未变也补拉补对、销「已传未交」的账）。
  // cond：force 跳过冷却/暂停，但仍带旧标记问「有没有变」（上次名单是自己写的时省整份下载）。
  /** 绿点两档：heavy=立刻转圈；仅 _uiSyncing=延迟呼吸。打字上传两者都不开。 */
  function _beginUiBusy(heavy) {
    if (heavy) _heavyUntilIdle = true;
    _uiHeavy = !!(heavy || _heavyUntilIdle);
    if (_uiHeavy) _uiSyncing = true;
  }
  function _endUiBusy() {
    if (_pendingPut && _heavyUntilIdle) return; // 大动作还要接着传：灯先留着，避免中间闪一下
    _uiSyncing = false;
    _uiHeavy = false;
    _heavyUntilIdle = false;
  }

  async function doGet({ force = false, silent = false, adopt = false, strict = false, full = false, cond = false, heavy = false } = {}) {
    if (!_config || _stopped) {
      if (strict) throw new Error('同步未配置或未启动');
      return;
    }
    // 正在传时不打断，拉排到传完再做（新开一轮仍先拉后传）。
    if (_syncing) {
      _pendingGet = true;
      return;
    }
    if (_paused && !force) return;
    if (!force && (Date.now() - _lastGetTime < GET_COOLDOWN_MS)) return;
    if (!force && !adopt && !strict && silent && _canSkipIdleGet()) {
      try { console.log('[sync-get] 刚写过且对面不在，跳过空转'); } catch (_) {}
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-unchanged', silent });
      return;
    }
    if (!navigator.onLine) {
      if (strict) throw new Error('当前离线，无法同步');
      return;
    }
    // 存储未就绪硬闸：storage.init() 抛错或尚未水合时 _data 为 null（getAll() 返回 null）。
    // 此时绝不能进同步——否则会拿"空库"去判断、甚至触发 _firstSync 清零云端清单。
    // 注意：水合成功但确实没有笔记时 getAll() 是空骨架对象（truthy），不受此闸影响，仍可正常下载采纳。
    if (!window.storage.getAll()) {
      console.warn('[webdav] 本地存储未就绪（getAll 为 null），本轮同步跳过');
      const msg = '本地数据未加载完成或加载失败，已暂停同步以防误清空云端；请重启应用后再试';
      if (force) _emit('cloud-sync', { type: 'webdav-sync-fail', error: msg });
      if (strict) throw new Error(msg);
      return;
    }

    _syncing = true;
    _beginUiBusy(!!(heavy || strict || adopt || (full && !silent)));
    if (!silent) _uiSyncing = true;
    const _tGet = Date.now();
    const catalogBumpVer = _needFreshCatalogOnce();
    _emit('cloud-sync', { type: 'webdav-sync-start', detail: 'get', silent: silent, heavy: _uiHeavy });
    try {
      // 条件 GET：后台轮询、或「上次名单是自己写的」的唤醒拉（cond）才带 If-None-Match。
      // 采纳/慢核对/立即同步必须读到真目录——代理回假 304 会把「另一端刚写的小改」当成没变；
      // 慢核对每天一次不带标记整份读，就是给这类假 304 兜底。
      // 正式版第一次打开同样不带旧标记（catalogBumpVer），防换包后被缓存骗过。
      const allowCond = !catalogBumpVer && !adopt && !strict && !full && (cond || !force);
      const condEtag = (allowCond && _lastManifestEtag) ? _lastManifestEtag : '';
      if (catalogBumpVer) {
        try { console.log('[sync-get] 正式版首次打开，真读名单（不带旧标记）'); } catch (_) {}
      }
      // 正常路径读清单（损坏时才 internally 自愈，见 _loadManifestForSync）
      let manifest = await _loadManifestForSync({ allow404: true, ifNoneMatch: condEtag });
      _lastGetTime = Date.now();
      _transientFailStreak = 0; // 读到了（含 404/304）：清空熔断计数

      if (manifest === NOT_MODIFIED) {
        _persistManifestCursor();
        await _seedStructSnapSVFromLocal(_lastManifestObj);
        _healUnsyncedLocalNotes(_lastManifestObj);
        if (strict && !adopt) {
          try { await _reconcileOpenNote(); } catch (_) {}
        }
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-unchanged', silent });
        if (catalogBumpVer) _markCatalogFreshForVer();
        return;
      }
      // 404 二次确认：规避服务器加锁/限流期间的假 404 被误判成"清单丢失"（会触发空清单重建）
      // 注意：404=文件不存在 → 走首次同步；0 字节空文件不会走这里（那是损坏路径）
      if (!manifest) manifest = await _recheckManifest();

      if (!manifest) {
        const data = window.storage.getAll() || {};
        const hasLocalNotes = data.notes && Object.keys(data.notes).length > 0;
        if (hasLocalNotes || _hasDirtyData()) await _firstSync();
        if (full) _markFullCheckDone();
        if (catalogBumpVer) _markCatalogFreshForVer();
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-empty', silent });
        return;
      }

      if (typeof manifest !== 'object' || !manifest.version) {
        // 非空但结构坏：走损坏路径轻量修复（与正常合并隔离）
        console.warn('[webdav] 清单损坏路径：内容异常无 version，尝试轻量修复');
        const heal = await _tryAutoHealCorruptManifest();
        if (heal.ok) {
          manifest = await webdavGetJson(MANIFEST_PATH, { allow404: true });
        }
        if (!manifest || typeof manifest !== 'object' || !manifest.version) {
          throw new Error('云端清单（manifest.json）内容异常。请在云同步菜单点「修复云端清单」');
        }
      }

      // 数据格式版本闸：云端格式比本客户端新 → 停止同步并提示更新，绝不下载/上传。
      if (_remoteFormatTooNew(manifest)) {
        console.warn('[webdav] 云端数据格式版本', manifest.dataFormatVersion, '高于本客户端支持', SUPPORTED_DATA_FORMAT, '；已停止同步，请更新枝记');
        _emit('cloud-sync', { type: 'webdav-version-block', remoteFmt: manifest.dataFormatVersion, supported: SUPPORTED_DATA_FORMAT });
        return;
      }
      manifest = await _ensureV3BackupAndV4Gate(manifest);
      manifest = await _ensureV5Index(manifest);

      // adopt：用户在「切换服务商」里选了"下载云端（覆盖本地）"，必须强制下载并采纳，
      // 不能因"manifest 未变"早退，也不依赖 epoch 比较。
      // 游标已持久化：冷启动也能早退（禁止因内存归零而整库按篇重下）。
      if (!adopt && Number(_lastKnownManifestUpdatedAt || 0) > 0
          && _catalogRev(manifest) === Number(_lastKnownManifestUpdatedAt)) {
        _lastManifestObj = manifest;
        _persistManifestCursor();
        _confirmOrRetryCatalog(manifest);
        await _seedStructSnapSVFromLocal(manifest);
        try {
          console.log('[sync-get] 名单版本未变，跳过按篇下载；仍检查本机是否待上传与空篇', 'rev=', _lastKnownManifestUpdatedAt);
        } catch (_) {}
        _healUnsyncedLocalNotes(manifest);
        if (full) {
          // 慢核对：名单未变也把该对的都对一遍（销已传未交的账、补拉版本对不上的篇、对当前篇）。
          // 真修了笔记才提示（webdav-full-check-fixed → toast），什么都没发现保持无声。
          const dl0 = _lastDownloadedIds ? _lastDownloadedIds.size : 0;
          _repairPendingVers(manifest);
          try { await _pullVersionMismatchedNotes(manifest); } catch (_) {}
          const fixedNotes = Math.max(0, (_lastDownloadedIds ? _lastDownloadedIds.size : 0) - dl0);
          if (silent && fixedNotes > 0) {
            _emit('cloud-sync', { type: 'webdav-full-check-fixed', notes: fixedNotes });
          }
        } else if (_lastWriterIsUs() || String(manifest.deviceId || '') === _ensureClientId()) {
          try { console.log('[sync-get] 名单仍是自己写的，不补拉'); } catch (_) {}
        } else {
          try { await _pullVersionMismatchedNotes(manifest); } catch (_) {}
        }
        if ((strict || full) && !adopt) {
          try { await _reconcileOpenNote(); } catch (_) {}
        }
        if (full) _markFullCheckDone();
        if (catalogBumpVer) _markCatalogFreshForVer();
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-unchanged', silent });
        return;
      }

      // epoch 闸门：远端世代比本地已采纳的更高 → 采纳模式（云端权威，本地多余项留底后移除，不反向上传）。
      // 首次遇到本账号（stored===null）不采纳，只记录，避免老用户升级首次同步误删本地笔记。
      // adopt 强制采纳：本地多余笔记留底后移除，使本地与云端一致（"下载覆盖"语义）。
      const remoteEpoch = manifest.epoch || 1;
      const storedEpoch = _getAdoptedEpoch();
      const adoptMode = adopt || ((storedEpoch !== null) && (remoteEpoch > storedEpoch));

      // 保护条（谨慎）：静默轮询 / 即时同步在场 → 不弹；小改且非当前篇 → 不弹；采纳/当前篇/批量仍弹。
      const isOtherDevice = manifest.deviceId && manifest.deviceId !== _ensureClientId();
      if (!silent && (adoptMode || isOtherDevice)) {
        let rtLive = false;
        try { rtLive = !!(window.realtime && window.realtime.status && window.realtime.status().active); } catch (_) {}
        if (!rtLive && _shouldShowSyncProtection(manifest, { adoptMode })) {
          _emit('cloud-sync', { type: 'sync-protection-start' });
        }
      }

      await _applyRemoteChanges(manifest, { adoptMode });
      if (force && !adopt) {
        try { await _reconcileOpenNote(); } catch (_) {}
      }
      _lastManifestObj = manifest;
      // 有笔记因解密失败被跳过时不记录游标：下轮"manifest 未变"不会早退，被跳过的笔记会重试
      if (!_skippedDecryptCount) _rememberManifestCursor(manifest);
      _confirmOrRetryCatalog(manifest);
      await _seedStructSnapSVFromLocal(manifest);
      _backoffMs = 30_000;
      _setAdoptedEpoch(remoteEpoch); // 应用成功后对齐世代
      // 采纳云端后旧账作废：绝不拿采纳前的「已传未交 / 名单回执」去顶新的权威云端
      if (adoptMode) { _clearPendingVers(); _savePendingCatalogConfirm(null); }

      // Bug A: 扫描本地比远端新的笔记，标记为 dirty（处理重启后丢失 dirtyIds 的场景）。
      // 采纳模式下绝不上传本地多余笔记（它们已被留底移除），否则会把"被权威淘汰的内容"再涌回云端。
      if (!adoptMode) _detectLocallyNewerNotes(manifest);
      if (full) { _repairPendingVers(manifest); _markFullCheckDone(); }
      if (catalogBumpVer) _markCatalogFreshForVer();

      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-downloaded', downloadedNoteIds: _lastDownloadedIds });

    } catch (e) {
      if (e instanceof RateLimitError) {
        _handleRateLimit();
      } else if (e && (e.transient || _isNetFlavorError(e))) {
        // 瞬时错误（如并发写期间读到空/截断的 manifest）：少量自动重试；连续失败则熔断报错
        _pendingGet = true;
        _handleTransient(e, '读取云端', () => doGet({ force: true, silent: true }));
      } else {
        _emit('cloud-sync', { type: 'webdav-sync-fail', error: e.message });
        console.error('[webdav] GET 错误:', e);
      }
      if (strict) throw e; // 手动同步：如实上抛，让调用方显示真实结果
    } finally {
      const _msGet = Date.now() - _tGet;
      try {
        if (window.__MD_DEBUG__ || !silent || _msGet >= 2000) {
          console.log('[sync-get] 结束', _msGet + 'ms', silent ? '(后台)' : '');
        }
      } catch (_) {}
      _endUiBusy();
      _syncing = false;
      _drainPending();
    }
  }

  let _lastDownloadedIds = new Set();
  let _decFailRounds = 0;        // 连续"整批解密全失败"的轮数（区分口令错 vs 瞬时损坏）
  let _skippedDecryptCount = 0;  // 本轮因解密失败被跳过的笔记数（>0 时不记录 manifest 基准，下轮重试）
  let _decMismatch = false;      // 已确认口令与云端不一致：禁止上传笔记正文，防止把另一把钥匙的密文写上云端（混钥污染）

  // 僵尸云端笔记记忆：旧口令残留密文 / 损坏文件，且本地无副本可自愈 → 永远拉不下来。
  // 按"manifest 时间戳"记忆，连续 2 轮失败后本会话不再重试下载，否则会：
  // ① 每轮白费 1-3 个请求（含抽样试解）刷屏报错；② _skippedDecryptCount 一直 >0 导致
  // manifest 基准永不记录，每轮全量重处理；③ "云端有、本地没有"被计入"有新内容要下载"，
  // 保护条每次打开都弹（用户误以为每次都在首次同步——曾发生）。
  // 时间戳变了（作者设备重新上传过）会自动重试；改口令/手动同步时整体清空重试。
  let _skipBadNotes = {}; // { id: { t: manifestTs, n: 连续失败轮数 } }
  function _isKnownBadNote(id, remoteTs) {
    const e = _skipBadNotes[id];
    return !!(e && e.t === remoteTs && e.n >= 2);
  }
  function _markBadNote(id, remoteTs) {
    const e = _skipBadNotes[id];
    if (e && e.t === remoteTs) e.n++;
    else _skipBadNotes[id] = { t: remoteTs, n: 1 };
    return _skipBadNotes[id].n;
  }

  /** 抽样试解：从 manifest 里挑 1-2 篇"本轮失败集合之外"的笔记试着解密，
   *  区分「口令真不对」（样本也解不开）和「恰好只拉到旧口令残留密文」（样本解得开）。 */
  async function _sampleKeyCheck(manifest, excludeIds) {
    const ids = Object.keys(manifest.notes || {}).filter(id =>
      !excludeIds.has(id) && !(manifest.deleted && manifest.deleted[id]));
    for (const id of ids.slice(0, 2)) {
      try {
        const n = await _fetchNoteById(id);
        if (n) return true;
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
        if (e.decryptFail) return false;
        // transient / parseFail：换下一篇试
      }
    }
    return null; // 没有可供判断的样本
  }

  async function _applyRemoteChanges(manifest, opts = {}) {
    const adoptMode = !!opts.adoptMode;
    _skippedDecryptCount = 0;
    const data = window.storage.getAll();
    const globalDirty = window.storage.isGlobalDirty ? window.storage.isGlobalDirty() : false;
    let hasDownloads = false;
    let _mergedAnyThisGet = false;  // 本轮有 v3 账本自动合并 → 末尾排一次上传让云端收敛
    _lastDownloadedIds = new Set();

    // 第一遍：算出需要下载的 id（谓词见 _shouldDownloadNote；禁止无基准假立指纹）。
    const toDownload = [];
    for (const id in manifest.notes) {
      const ver = _noteVer(manifest.notes[id]);
      if (_isGoneNote(id, ver)) continue;
      if (_shouldDownloadNote(id, manifest, data)) toDownload.push(id);
    }
    try {
      const baseMap = _loadSyncBase();
      const baseN = baseMap ? Object.keys(baseMap).length : 0;
      if (toDownload.length > 0) {
        console.log('[sync-get] 需下载笔记', toDownload.length, '篇；本机基准', baseN, '条',
          baseN === 0 ? '（基准空：只下本地没有的或云端明显更新的）' : '');
      }
    } catch (_) {}

    const ledgerP = _loadCloudStructLedger(manifest);

    // 并发预取需要下载的笔记正文（并发上限由请求池控制）。下载是 IO，串行往返才是慢的根因。
    const _fetched = new Map();
    if (toDownload.length) {
      if (!_uiSyncing) {
        _uiSyncing = true;
        _emit('cloud-sync', { type: 'webdav-sync-start', detail: 'get', heavy: false });
      }
      const { errors } = await _runPool(toDownload, async (id) => {
        const note = await _fetchNoteById(id, _noteVer(manifest.notes && manifest.notes[id]));
        if (note) _fetched.set(id, note);
      });
      const rl = errors.find(e => e.error instanceof RateLimitError);
      if (rl) throw rl.error; // 命中限流：整体上抛，让上层退避并降档
      // 解密失败的判定与自愈：
      // ① 本轮有笔记解密成功（或抽样可解）→ 钥匙没问题，失败的是旧口令残留密文（换口令期间
      //    另一台设备用旧钥上传过）。本地副本不旧于云端的 → 标脏用当前钥重新加密上传（自愈）；
      //    本地没有/更旧的 → 跳过且不记 manifest 基准，下轮重试，不弹"口令不一致"。
      // ② 全军覆没且抽样也解不开 → 口令真不一致：报错让用户核对，并锁死上传（防止把本设备
      //    这把钥匙的密文写上云端，造成新旧混钥、所有设备反复误报——曾发生）。
      const dec = errors.filter(e => e.error && e.error.decryptFail);
      if (dec.length) {
        let keyOk = _fetched.size > 0;
        if (!keyOk) {
          const failedIds = new Set(dec.map(d => d.item));
          const sample = await _sampleKeyCheck(manifest, failedIds);
          keyOk = sample === true;
          if (sample === null) {
            // 无样本可判（云端几乎只剩这些失败文件）：保守按口令不一致处理
            keyOk = false;
          }
        }
        if (!keyOk) {
          _decFailRounds += 1;
          if (dec.length >= 2 || _decFailRounds >= 2) {
            _decMismatch = true;
            throw new Error('云端笔记解密失败：本设备的同步加密口令与云端数据不一致，请到 设置 → 同步 核对口令（核对一致前已暂停上传，避免污染云端）');
          }
          _skippedDecryptCount = dec.length;
        } else {
          _decFailRounds = 0;
          _decMismatch = false;
          // 自愈：本地副本不旧于云端记录的 → 用当前钥重新加密上传，逐步洗掉旧钥残留
          const healIds = dec.map(d => d.item).filter(id => {
            const ln = data.notes[id];
            if (!ln) return false;
            const lts = _noteTs(ln.updatedAt);
            const rts = _noteVer(manifest.notes[id]);
            return lts >= rts;
          });
          if (healIds.length && window.storage.markNotesDirtyByIds) {
            window.storage.markNotesDirtyByIds(healIds);
            setTimeout(() => { try { schedulePut('reencrypt-heal'); } catch (_) {} }, 2000);
          }
          // 本地无副本可自愈的：记入僵尸名单。计数只算"还会重试"的，
          // 连续 2 轮失败转为永久跳过（不再阻塞 manifest 基准、不再每轮重试）
          const restIds = dec.map(d => d.item).filter(id => !healIds.includes(id));
          let stillRetry = 0;
          const nowPermanent = [];
          for (const id of restIds) {
            const rts = _noteVer(manifest.notes[id]);
            const n = _markBadNote(id, rts);
            if (n === 2) nowPermanent.push(id);
            if (n < 2) stillRetry++;
          }
          _skippedDecryptCount = stillRetry;
          if (nowPermanent.length) {
            console.warn('[webdav] 以下云端笔记用当前口令解不开且本地无副本，本会话不再重试（可在"管理云端笔记"中删除）:', nowPermanent);
            _emit('cloud-sync', { type: 'webdav-notes-unreadable', count: nowPermanent.length, ids: nowPermanent });
          }
          console.warn(`[webdav] ${dec.length} 篇为旧口令残留密文（当前口令已验证可解其余笔记）：`
            + `${healIds.length} 篇用本地副本重新加密上传自愈${restIds.length ? `，${restIds.length} 篇本地无副本/较旧，跳过待其作者设备自愈` : ''}`);
        }
      } else {
        _decFailRounds = 0;
        _decMismatch = false;
      }
      // 瞬时错误（限流页/超时等）：上抛让整轮稍后重试，避免这些笔记被悄悄跳过
      const tr = errors.find(e => e.error && e.error.transient);
      if (tr) throw tr.error;
      // 单篇笔记文件损坏/解析失败：跳过该篇（不让整轮同步失败），
      // 本地有副本的标记 dirty 重传，用好的本地版本覆盖修复云端坏文件
      const bad = errors.filter(e => e.error && e.error.parseFail);
      if (bad.length) {
        const healIds = bad.map(b => b.item).filter(id => data.notes[id]);
        if (healIds.length && window.storage.markNotesDirtyByIds) {
          window.storage.markNotesDirtyByIds(healIds);
          setTimeout(() => { try { schedulePut('parseFail-heal'); } catch (_) {} }, 2000);
        }
        // 本地无副本可修复的损坏文件：同样记入僵尸名单，避免每轮重试下载
        for (const b of bad) {
          if (data.notes[b.item]) continue;
          const rts = (manifest.notes[b.item] && manifest.notes[b.item].updatedAt) || 0;
          _markBadNote(b.item, rts);
        }
        console.warn(`[webdav] ${bad.length} 篇云端笔记文件损坏已跳过（${healIds.length} 篇将用本地副本重传修复）:`,
          bad.map(b => `${b.item}: ${b.error.message}`));
        _emit('cloud-sync', { type: 'webdav-notes-skipped', count: bad.length, healed: healIds.length });
      }
    }

    // 第二遍：顺序应用（冲突/留底逻辑保持不变，仅 remoteNote 改取自预取结果）。
    for (const id of toDownload) {
      const remoteTs = _noteVer(manifest.notes[id]);
      const remoteNote = _fetched.get(id);
      if (!remoteNote) continue;
      const r = _applyFetchedNote(id, remoteNote, remoteTs, data, 'download');
      if (r && r.touched) {
        _lastDownloadedIds.add(id);
        hasDownloads = true;
      }
      if (r && r.merged) _mergedAnyThisGet = true;
    }

    // 远端墓碑是正向删除证据：听删除。本机待传、本机时间较新，都不得顶掉。
    // 改过的字先留底（同步留底里可找回）。名单上找不到文件 ≠ 墓碑，绝不走这里。
    for (const id in manifest.deleted) {
      if (!data.notes[id]) continue;
      if (window.storage.isRevivedFromBackup && window.storage.isRevivedFromBackup(id)) continue;
      _backupBeforeOverwrite(id, data.notes[id], 'remote-delete');
      window.storage._webdavRemoveNote(id);
      _delBase(id);
      if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
      hasDownloads = true;
    }

    // 结构总账：有总账则本子/标题/位置只听总账，名单不再先排一遍（一棵树·网盘第一刀）。
    // 无总账才回退名单上的本子/模板。设置、回收站顺序、名单墓碑仍可从名单补。
    let cloudLed = null;
    let ledgerMissing = [];
    try {
      cloudLed = await ledgerP;
      if (cloudLed) {
        const ledRes = _applyCloudStructOnGet(cloudLed, adoptMode);
        if (ledRes && Array.isArray(ledRes.missing)) ledgerMissing = ledRes.missing;
      }
    } catch (e) { console.warn('[webdav] 结构总账下载并入失败（忽略，不影响主同步）', e); }

    if (!globalDirty) {
      const localData = window.storage.getAll();
      let globalChanged = false;
      if (!cloudLed) {
        if (manifest.rootOrder && JSON.stringify(manifest.rootOrder) !== JSON.stringify(localData.rootOrder)) globalChanged = true;
        if (manifest.workspaces && JSON.stringify(manifest.workspaces) !== JSON.stringify(localData.workspaces)) globalChanged = true;
        if (manifest.templates && JSON.stringify(manifest.templates) !== JSON.stringify(localData.templates)) globalChanged = true;
      }
      if (manifest.wsDeleted) {
        const localTomb = localData.wsTombstones || {};
        for (const wid in manifest.wsDeleted) { if (!localTomb[wid]) { globalChanged = true; break; } }
      }
      if (manifest.tplDeleted) {
        const localTtomb = localData.tplTombstones || {};
        for (const tid in manifest.tplDeleted) { if (!localTtomb[tid]) { globalChanged = true; break; } }
      }
      if (globalChanged) {
        const g = {
          trashOrder: manifest.trashOrder,
          wsDeleted: manifest.wsDeleted,
          tplDeleted: manifest.tplDeleted,
          settings: manifest.settings,
        };
        if (!cloudLed) {
          g.rootOrder = manifest.rootOrder;
          g.workspaces = manifest.workspaces;
          g.templates = manifest.templates;
        }
        window.storage._webdavApplyGlobal(g);
        hasDownloads = true;
      }
    }

    const extraIds = [];
    const extraSeen = new Set(toDownload);
    for (let i = 0; i < ledgerMissing.length; i++) {
      const id = ledgerMissing[i];
      if (!id || extraSeen.has(id)) continue;
      if (data.notes[id] || (data.trash && data.trash[id])) continue;
      if (window.storage.isNoteDeleted && window.storage.isNoteDeleted(id)) continue;
      if (!(manifest.notes && manifest.notes[id])) continue;
      const extraTs = _noteVer(manifest.notes[id]);
      if (_isKnownBadNote(id, extraTs)) continue;
      if (_isGoneNote(id, extraTs)) continue;
      extraIds.push(id);
      extraSeen.add(id);
    }
    if (extraIds.length) {
      if (!_uiSyncing) {
        _uiSyncing = true;
        _emit('cloud-sync', { type: 'webdav-sync-start', detail: 'get', heavy: false });
      }
      try { console.log('[sync-get] 目录有、清单未下', extraIds.length, '篇，补拉正文'); } catch (_) {}
      const { errors } = await _runPool(extraIds, async (id) => {
        const note = await _fetchNoteById(id, _noteVer(manifest.notes && manifest.notes[id]));
        if (note) _fetched.set(id, note);
      });
      const extraRl = errors.find(e => e.error instanceof RateLimitError);
      if (extraRl) throw extraRl.error;
      for (const id of extraIds) {
        const remoteNote = _fetched.get(id);
        if (!remoteNote) continue;
        const remoteTs = _noteVer(manifest.notes && manifest.notes[id]) || _noteTs(remoteNote.updatedAt);
        const r = _applyFetchedNote(id, remoteNote, remoteTs, data, 'download');
        if (r && r.touched) {
          _lastDownloadedIds.add(id);
          hasDownloads = true;
        }
        if (r && r.merged) _mergedAnyThisGet = true;
      }
      if (cloudLed) {
        try { _applyCloudStructOnGet(cloudLed, adoptMode); } catch (_) {}
      }
    }

    // 标记待下载图片（图片仓库已外置：经 storage.getImageMap 取内存缓存，等后端载入完成再比对，
    // 否则启动早期缓存为空会把"本地其实有"的图片全部误判为待下载）
    if (window.storage.imagesReady) await window.storage.imagesReady();
    const localImages = (window.storage.getImageMap && window.storage.getImageMap()) || data.localImages || {};
    const remoteImages = manifest.images || {};
    for (const hash in remoteImages) {
      if (!localImages[hash]) {
        _pendingImageDownloads.add(hash);
        _pendingImageExts[hash] = remoteImages[hash];
      }
    }

    // 有总账后：本子名字/顺序已由总账定。这里只补「名单上有、总账还没写上」的本子，
    // 免得刚下的篇找不到本子被塞进当前本。本地优先，不拿名单盖总账。
    if (window.storage._webdavMergeWorkspaces) {
      if (window.storage._webdavMergeWorkspaces(manifest.workspaces, manifest.wsDeleted, manifest.templates, manifest.tplDeleted)) {
        hasDownloads = true;
      }
    }

    // epoch 采纳模式：本地存在、却不在云端权威清单(manifest.notes)里的笔记 → 留底后从本地移除。
    // 这是「覆盖云端」权威分发的落地点：让旧设备干净对齐云端，且本次不会反向上传这些被淘汰项。
    // 安全：每条移除前都已 _backupBeforeOverwrite，可在「同步留底」里找回。
    if (adoptMode) {
      for (const id of Object.keys(data.notes)) {
        if (manifest.notes && manifest.notes[id]) continue;        // 在权威清单里 → 保留
        if (_lastDownloadedIds.has(id)) continue;                  // 本次刚下载 → 保留
        _backupBeforeOverwrite(id, data.notes[id], 'adopt-reset');
        delete data.notes[id];
        data.rootOrder = (data.rootOrder || []).filter(x => x !== id);
        _delBase(id);
        if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
        hasDownloads = true;
      }
    }

    // 兜底自愈：每次应用远端后，确保没有笔记掉出 rootOrder / 挂在不存在的笔记本上。
    // （_webdavApplyGlobal 内部已会自愈一次；这里覆盖"本地有 globalDirty 而跳过全局应用"的路径。）
    if (window.storage.reconcileStructure && window.storage.reconcileStructure({ skipDirty: true })) {
      hasDownloads = true;
    }

    if (hasDownloads) {
      window.storage.save({ immediate: true });
    }
    _flushSyncBase();
    if (_pendingImageDownloads.size > 0) {
      _scheduleImageDownloads();
    }
    // v3 账本合并产生了"待上传的融合版" → 排一次上传，让云端尽快收敛到合并结果（debounce，安全可重入）。
    if (_mergedAnyThisGet) schedulePut('ydoc-merged');
  }

  /** 把已取回的云端一篇落到本地（下载 / 手动对当前篇共用）。
   *  返回 { changed, touched }：changed=正文可见变化；touched=对齐过基准（含内容本就相同）。 */
  function _applyFetchedNote(id, remoteNote, remoteTs, data, src) {
    if (!remoteNote || !data) return { changed: false, touched: false };
    const localNote = data.notes && data.notes[id];
    const base = _getBase(id);
    const dirtyNow = window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : [];
    const remoteHash = _noteHash(remoteNote);
    const localDiverged = localNote
      ? (base ? (_noteHash(localNote) !== base.h) : dirtyNow.indexOf(id) >= 0)
      : false;
    const sameContent = localNote ? (_noteHash(localNote) === remoteHash) : false;
    const mergeReason = src === 'reconcile' ? 'merge-reconcile' : 'merge-download';
    const cleanReason = src === 'reconcile' ? 'clean-reconcile' : 'clean-download';
    if (localDiverged && !sameContent) {
      const merged = _tryLedgerMerge(localNote, remoteNote);
      if (merged) {
        _backupBeforeOverwrite(id, localNote, mergeReason);
        window.storage._webdavApplyNote(id, merged);
        if (merged.parentId == null && data.rootOrder && !data.rootOrder.includes(id)) data.rootOrder.push(id);
        if (window.storage.markNotesDirtyByIds) window.storage.markNotesDirtyByIds([id]);
        const appliedM = data.notes && data.notes[id];
        _setBase(id, appliedM ? _noteHash(appliedM) : remoteHash, remoteTs);
        return { changed: true, touched: true, merged: true };
      }
      const res = _resolveUnmergeableSilently(id, localNote, remoteNote, remoteHash, remoteTs, data);
      if (res.localWins) {
        if (window.storage.markNotesDirtyByIds) window.storage.markNotesDirtyByIds([id]);
      } else if (window.storage.removeDirtyNoteIds) {
        window.storage.removeDirtyNoteIds([id]);
      }
      return { changed: true, touched: true };
    }
    if (localNote && !sameContent) _backupBeforeOverwrite(id, localNote, cleanReason);
    window.storage._webdavApplyNote(id, remoteNote);
    if (remoteNote.parentId == null && data.rootOrder && !data.rootOrder.includes(id)) data.rootOrder.push(id);
    if (sameContent && window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
    const applied = data.notes && data.notes[id];
    _setBase(id, applied ? _noteHash(applied) : remoteHash, remoteTs);
    return { changed: !sameContent, touched: true };
  }

  /** 手动同步：无视清单早退，把当前打开的这篇和云端文件对一次（只多 1 次按篇请求）。 */
  async function _reconcileOpenNote() {
    let id = null;
    try { id = window.editor && window.editor.currentId && window.editor.currentId(); } catch (_) {}
    if (!id) return false;
    const data = window.storage.getAll();
    if (!data) return false;
    if (window.storage.isNoteDeleted && window.storage.isNoteDeleted(id)) return false;
    let manifest = _lastManifestObj;
    if (!manifest || !manifest.notes) {
      try { manifest = await _loadManifestForSync({ allow404: true }); } catch (_) { return false; }
      if (manifest && manifest.version) _lastManifestObj = manifest;
    }
    if (!manifest || !manifest.notes || !manifest.notes[id]) return false;
    if (manifest.deleted && manifest.deleted[id]) return false;
    let remoteNote = null;
    try { remoteNote = await _fetchNoteById(id); }
    catch (e) {
      if (e instanceof RateLimitError) throw e;
      return false;
    }
    if (!remoteNote) return false;
    const remoteTs = _noteVer(manifest.notes[id]) || _noteTs(remoteNote.updatedAt);
    const r = _applyFetchedNote(id, remoteNote, remoteTs, data, 'reconcile');
    if (!r || !r.touched) return false;
    if (r.changed) {
      if (window.storage.reconcileStructure) window.storage.reconcileStructure({ skipDirty: true });
      window.storage.save({ immediate: true });
      _flushSyncBase();
      const ids = new Set([id]);
      _lastDownloadedIds = ids;
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-downloaded', downloadedNoteIds: ids });
      if (r.merged) schedulePut('ydoc-merged');
    } else {
      _flushSyncBase();
    }
    return !!r.changed;
  }

  async function _pullVersionMismatchedNotes(manifest) {
    if (!manifest || !manifest.notes) return;
    const data = window.storage.getAll();
    if (!data) return;
    const ids = [];
    for (const id in manifest.notes) {
      if (_shouldDownloadNote(id, manifest, data)) ids.push(id);
    }
    if (!ids.length) return;
    try { console.log('[sync-get] 名单未变仍补拉', ids.length, '篇（空篇或版本对不上）'); } catch (_) {}
    const { errors } = await _runPool(ids, async (id) => {
      const note = await _fetchNoteById(id);
      if (!note) return;
      const remoteV = _noteVer(manifest.notes[id]);
      const r = _applyFetchedNote(id, note, remoteV, data, 'download');
      if (r && r.touched) _lastDownloadedIds.add(id);
    });
    const rl = errors.find(e => e.error instanceof RateLimitError);
    if (rl) throw rl.error;
    if (_lastDownloadedIds && _lastDownloadedIds.size) {
      if (window.storage.reconcileStructure) window.storage.reconcileStructure({ skipDirty: true });
      window.storage.save({ immediate: true });
      _flushSyncBase();
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-downloaded', downloadedNoteIds: _lastDownloadedIds });
    }
  }

  /** v3 账本自动合并：两端都带 ydoc 账本时，融合两份账本得到合并正文，替代"冒冲突副本"。
   *  返回融合后的 note 或 null（任一端无账本 / 引擎不可用 / 合并异常 → 调用方退回旧的冲突副本路径）。
   *  以远端为基底（title/parentId 等沿用远端，与旧策略"采纳远端"一致），正文与账本用融合结果。 */
  function _tryLedgerMerge(localNote, remoteNote) {
    try {
      const Y = window.__ydoc;
      if (!Y || !Y.ready()) return null;
      if (!localNote || !remoteNote || !localNote.ydoc || !remoteNote.ydoc) return null;
      const mergedBytes = Y.merge(localNote.ydoc, remoteNote.ydoc);
      const mergedDoc = Y.toDoc(mergedBytes);
      if (!mergedDoc || mergedDoc.type !== 'doc') return null;
      // 正文用账本融合；元数据(置顶/颜色/图标/位置/标题等)按 updatedAt LWW，绝不被无脑取远端而丢。
      const meta = _mergeMeta(localNote, remoteNote);
      const note = Object.assign({}, remoteNote, meta, {
        doc: mergedDoc,
        ydoc: mergedBytes,
        updatedAt: new Date().toISOString(),
      });
      delete note.content; // 正文以合并后的 doc 为准，清掉可能陈旧的 md 兜底
      return note;
    } catch (e) { console.warn('[webdav] 账本合并失败，退回冲突副本', e); return null; }
  }

  // 说明：历史上的「本地冲突副本」生成器(_saveConflictCopy)已彻底移除。
  //   v3 起真冲突一律走账本自动合并(_tryLedgerMerge)或静默留底(_resolveUnmergeableSilently)，
  //   任何路径都不再在笔记树里冒出带「（本地冲突副本）」后缀的可见副本、也不再弹提示。
  //   现存的历史副本可用 window.storage.purgeConflictCopies() 一次性清理，清后不会再生。

  /** 真冲突且无法自动合并（极罕见：某端确实没账本）→ **静默**处理，不再另存可见的"本地冲突副本"、不弹提示。
   *  按 updatedAt 保留较新的一份为正本，较旧的一份存入「同步留底」（可在留底里找回，零丢失）。
   *  返回 { localWins }：调用方据此决定是保持脏（本地较新→上传本地）还是清脏（远端较新→采纳远端）。 */
  function _resolveUnmergeableSilently(id, localNote, remoteNote, remoteHash, remoteTs, data) {
    const localWins = _noteTime(localNote) >= _noteTime(remoteNote);
    const winner = localWins ? localNote : remoteNote;
    const loser = localWins ? remoteNote : localNote;
    try { _backupBeforeOverwrite(id, loser, 'silent-conflict'); } catch (_) {} // 较旧版进留底，可找回
    window.storage._webdavApplyNote(id, winner);
    if (winner && winner.parentId == null && data && data.rootOrder && !data.rootOrder.includes(id)) data.rootOrder.push(id);
    _setBase(id, remoteHash, remoteTs); // 对齐云端现版指纹；本地较新时下次 PUT 会把本地推上去收敛
    return { localWins: localWins };
  }

  /**
   * Fix A：上传前的「单篇冲突防护」（红线对称补齐——覆盖远端前必须留底）。
   *
   * 背景：doPut 原本对脏笔记是「裸覆盖」——只在写整本 manifest 时比对整体 updatedAt，
   * 从不检查「这一篇云端是否已被别的设备改成更新的版本」。一旦本地某篇因任何原因
   * （序列化抖动误标脏、两台机器时钟偏差、重启丢 dirty 后被时间戳误判）显得"较新"，
   * GET 会跳过下载它、PUT 又把本地旧内容上传，把云端较新版本覆盖且无留底 → 丢数据。
   *
   * 判据用三方基准 _syncBase（不依赖墙钟）：若云端该篇 manifest.updatedAt ≠ 本地基准 t，
   * 说明云端自我们上次同步后已被别的设备改过 → 绝不裸覆盖：
   *   - 内容其实一致 → 仅对齐基准、清脏、不上传；
   *   - 真冲突 → 留底 + 本地另存「冲突副本」(不丢) + 本体采纳远端较新版本，与下行同策略收敛。
   * 处理过的 id 会被移出 dirty（不再上传覆盖）；冲突副本是新笔记，仍会正常上传。
   */
  // 本轮上传因「取不到云端正文」而暂缓的 id：保留 storage 脏标记，但从本次 dirtyIds 剔除，防裸盖。
  let _deferUploadIds = new Set();

  async function _guardUploadConflicts(dirtyIds, data, manifest) {
    if (!manifest || !manifest.notes) return;
    const adopted = new Set();
    _deferUploadIds = new Set();
    for (const id of Array.from(dirtyIds)) {
      const localNote = data.notes[id];
      if (!localNote) continue;                 // 删除/回收站项不在此防护
      const remoteEntry = manifest.notes[id];
      if (!remoteEntry) continue;               // 远端没有 → 本地新笔记，正常上传
      const base = _getBase(id);
      const remoteV = _noteVer(remoteEntry);
      if (base && _baseVer(base) === remoteV && _noteHash(localNote) === base.h) continue;
      if (base && _baseVer(base) === remoteV && String(manifest.deviceId || '') === _ensureClientId()) continue;
      // 无基准，或云端相对基准已变：必须先取回远端正文，禁止保守放行裸盖（20260804t1）
      let remoteNote = null;
      try { remoteNote = await _fetchNoteById(id); }
      catch (e) { if (e instanceof RateLimitError) throw e; }
      if (!remoteNote) {
        dirtyIds.delete(id);
        _deferUploadIds.add(id);
        console.warn('[webdav] 上传前取不到云端正文，本轮跳过该篇以免裸盖:', id);
        continue;
      }
      const remoteHash = _noteHash(remoteNote);
      const remoteTs = remoteV;
      if (_noteHash(localNote) === remoteHash) {
        if (_metaSig(localNote) === _metaSig(remoteNote)) {
          // 正文 + 元数据都一致（仅名单版本不同）→ 不算冲突：对齐基准、清脏、不重复上传。
          _setBase(id, remoteHash, remoteTs);
          if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
          dirtyIds.delete(id);
          continue;
        }
        // 正文一致、仅元数据不同（典型：置顶/颜色/图标/移动/换笔记本）→ 绝不丢弃，按时间 LWW 合并。
        const meta = _mergeMeta(localNote, remoteNote);
        const localWins = _noteTime(localNote) >= _noteTime(remoteNote);
        const mergedNote = Object.assign({}, localNote, meta);
        window.storage._webdavApplyNote(id, mergedNote);
        if (mergedNote.parentId == null && data.rootOrder && !data.rootOrder.includes(id)) data.rootOrder.push(id);
        _setBase(id, remoteHash, remoteTs);
        adopted.add(id);
        if (localWins) {
          // 本地元数据更新 → 保持脏，本次 PUT 直接上传融合版让云端/其它设备收敛（不移出 dirtyIds）。
        } else {
          // 远端元数据更新 → 采纳远端、清脏（云端已是该版，无需重传）。
          if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
          dirtyIds.delete(id);
        }
        continue;
      }
      // 真冲突：【v3 优先】两端都有账本 → 合并成一份，保持脏让本次 PUT 直接上传融合版，云端收敛。
      const merged = _tryLedgerMerge(localNote, remoteNote);
      if (merged) {
        _backupBeforeOverwrite(id, localNote, 'merge-upload'); // 仍留底，极端情况下可找回合并前本地版
        window.storage._webdavApplyNote(id, merged);
        if (merged.parentId == null && data.rootOrder && !data.rootOrder.includes(id)) data.rootOrder.push(id);
        _setBase(id, remoteHash, remoteTs); // 对齐云端现版；上传成功后 doPut 会再更新为融合版指纹
        adopted.add(id);
        // 注意：不从 dirtyIds 移除——本次 PUT 继续上传融合结果。
        continue;
      }
      // 【兜底·静默】无账本、无法自动合并（极罕见）：静默按时间保留较新的一份，较旧的一份进「同步留底」
      //   （可找回、零丢失），**不再冒可见的"本地冲突副本"、不弹提示**。
      const res = _resolveUnmergeableSilently(id, localNote, remoteNote, remoteHash, remoteTs, data);
      adopted.add(id);
      if (res.localWins) {
        // 本地较新 → 保持脏，本次 PUT 继续上传本地版让云端收敛（不移出 dirtyIds）。
      } else {
        if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
        dirtyIds.delete(id);
      }
    }
    if (adopted.size) {
      // 自愈结构（doPut 路径没有 reconcile）：防止采纳远端后出现"子笔记混进 rootOrder"等结构异常
      if (window.storage.reconcileStructure) window.storage.reconcileStructure();
      window.storage.save({ immediate: true });
      _flushSyncBase();
      // 让编辑器/侧栏刷新成采纳后的远端内容（复用下行的「已下载」事件，当前打开的笔记会自动重载）。
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-downloaded', downloadedNoteIds: adopted });
    }
  }

  /** 清单未变早退时仍补传本机已改正文（不下载、不改游标）。
   *  有清单走完整「本地比云端新」扫描；仅 304、手里没有清单时，只比同步基准指纹。 */
  function _healUnsyncedLocalNotes(manifest) {
    if (manifest && typeof manifest === 'object') {
      _detectLocallyNewerNotes(manifest);
      return;
    }
    if (!window.storage || !window.storage.markNotesDirtyByIds) return;
    const data = window.storage.getAll();
    if (!data || !data.notes) return;
    const base = _loadSyncBase();
    const dirtySet = new Set(window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : []);
    const needUpload = [];
    for (const id in data.notes) {
      if (dirtySet.has(id)) continue;
      const b = base[id];
      // 无基准不在此路径放行（避免基准未加载时整库误传）；有基准且正文相对基准变过 → 补传
      if (b && _noteHash(data.notes[id]) !== b.h) needUpload.push(id);
    }
    if (needUpload.length > 0) {
      window.storage.markNotesDirtyByIds(needUpload);
      schedulePut('heal-unchanged:' + needUpload.length);
    }
  }

  /** Bug A: 重启后 dirtyIds 丢失 —— GET 成功后扫描本地比远端新的笔记，标记为 dirty */
  function _detectLocallyNewerNotes(manifest) {
    if (!window.storage || !window.storage.markNotesDirtyByIds) return;
    // 硬闸：必须是带 notes 的真名单。缺 notes/deleted 的半份名单会把「云端已删」误判成「云上没有」→ 复活上传。
    if (!manifest || !manifest.notes) return;
    const data = window.storage.getAll();
    const base = _loadSyncBase();
    const dirtySet = new Set(window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : []);
    const needUpload = [];
    const pend = _pendingVers();
    for (const id in data.notes) {
      if (pend[id]) continue;
      if (window.storage.isRevivedFromBackup && window.storage.isRevivedFromBackup(id)) {
        needUpload.push(id);
        continue;
      }
      if (manifest.deleted && manifest.deleted[id]) continue; // 已被远端删除（墓碑）→ 不要重新上传复活
      const remoteEntry = manifest.notes && manifest.notes[id];
      if (!remoteEntry) {
        // 云端清单既无条目、也无墓碑——三方对账区分两种情况（不靠墙钟）：
        //  · 基准里有这条 + 本地没动过(非 dirty) → 曾成功同步过、如今云端没了 = 远端已删
        //    （墓碑可能已被保留期/GC 清掉）→ 绝不当"本地新建"复活上传，跳过。
        //    这里只"不上传"、不基于"缺失"删本地：WebDAV 最终一致性下偶发漏读会误判，
        //    删本地风险高；本地对齐删除交给"远端墓碑"这条正向证据路径（墓碑保留期已延长到 1 年）。
        //  · 基准没有(本地真新建、从没传过) 或 本地已编辑/找回(dirty) → 才是该上传的新内容。
        if (base[id] && !dirtySet.has(id)) continue;
        needUpload.push(id);
      } else {
        const b = base[id];
        if (b && _noteHash(data.notes[id]) !== b.h) needUpload.push(id);
      }
    }
    if (needUpload.length > 0) {
      window.storage.markNotesDirtyByIds(needUpload);
      let needStruct = false;
      for (let i = 0; i < needUpload.length; i++) {
        const id = needUpload[i];
        const note = data.notes[id];
        const remoteEntry = manifest.notes && manifest.notes[id];
        if (!note) { needStruct = true; break; }
        if (!remoteEntry) { needStruct = true; break; }
        if ((manifest.dataFormatVersion || 1) < 4) {
          const lp = note.parentId == null ? null : note.parentId;
          const rp = remoteEntry.parentId == null ? null : remoteEntry.parentId;
          if (lp !== rp || (note.title || '') !== (remoteEntry.title || '')) { needStruct = true; break; }
        }
      }
      if (needStruct && window.storage.markGlobalDirty) window.storage.markGlobalDirty();
      schedulePut('detect-locally-newer:' + needUpload.length);
    }
  }

  // ─── PUT（上传变更）────────────────────────────────────────────────────────────
  // strict 含义同 doGet：手动同步时错误原样上抛
  async function doPut({ force = false, strict = false, freshLedger = false, flushIndex = false, _schedReason = '' } = {}) {
    if (!_config || _stopped) return;
    // 口令不一致闸：确认与云端口令不符后绝不上传笔记正文——否则会把本设备这把钥匙的密文
    // 写上云端，造成新旧混钥，所有设备从此反复误报"口令不一致"且无法自愈（曾发生）。
    // 改动留在本地脏集合里，口令核对一致（doGet 成功）后自动恢复上传。
    if (_decMismatch) {
      console.warn('[webdav] 加密口令与云端不一致，暂停上传（待口令核对一致后自动恢复）');
      _emit('cloud-sync', { type: 'webdav-sync-error', error: '加密口令与云端不一致，已暂停上传' });
      if (strict) throw new Error('加密口令与云端数据不一致，已暂停上传：请到 设置 → 同步 核对口令');
      return;
    }
    // 久闲设备闸：连续 7 天没同步过的设备，先完整核对云端（先下后对），核对完成前绝不上传——
    // 防它把旧内容/旧结构灌回云端（「久闲设备新旧掺杂」的挂账债）。改动留在本地脏集合里不丢。
    if (_staleGate) {
      _pendingPut = true;
      if (Date.now() - _staleGetAt > 30_000) {
        _staleGetAt = Date.now();
        console.warn('[webdav] 本机太久没同步，先完整核对云端再上传（改动已留在本机，核对完自动补传）');
        if (!_syncing) doGet({ force: true, silent: true, full: true, heavy: true });
      }
      return;
    }
    if (_syncing) { _pendingPut = true; return; }
    if (!_hasDirtyData() && !force) return;
    if (_paused && !force) return;
    if (!navigator.onLine) return;
    // 存储未就绪硬闸（同 doGet）：_data 为 null 时绝不上传——否则空库 + false-404 会清零云端清单。
    if (!window.storage.getAll()) {
      console.warn('[webdav] 本地存储未就绪（getAll 为 null），本轮上传跳过');
      if (force) _emit('cloud-sync', { type: 'webdav-sync-fail', error: '本地数据未加载完成或加载失败，已暂停同步以防误清空云端；请重启应用后再试' });
      return;
    }

    _syncing = true;
    _beginUiBusy(!!(force || strict || freshLedger));
    const _tPut = Date.now();
    _emit('cloud-sync', { type: 'webdav-sync-start', detail: 'put', silent: !_uiSyncing, heavy: _uiHeavy });
    try {
      const data = window.storage.getAll();
      let dirtyIds = new Set(window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : []);
      let globalDirty = window.storage.isGlobalDirty ? window.storage.isGlobalDirty() : false;
      let indexDirty = !!(window.storage.isIndexDirty && window.storage.isIndexDirty());
      try {
        console.log('[sync-put-run]', _schedReason || (force ? 'force' : '?'),
          'globalDirty=', globalDirty, 'indexDirty=', indexDirty, 'dirtyNotes=', dirtyIds.size);
      } catch (_) {}

      if (dirtyIds.size === 0 && !globalDirty && !indexDirty) {
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-nothing' });
        return;
      }
      const startedWithNotes = dirtyIds.size > 0;

      // 刚拉过的总目录直接用，打字不必每次再读一遍。超过 8 秒或覆盖云端才重读。
      let manifest = null;
      const canReuse = !freshLedger && _lastManifestObj && _lastManifestObj.version
        && (Date.now() - _lastGetTime) < 8000;
      if (canReuse) {
        manifest = _lastManifestObj;
        try { console.log('[sync-put-run] 复用刚拉过的总目录'); } catch (_) {}
      } else {
        manifest = await _loadManifestForSync({ allow404: true });
        _transientFailStreak = 0;
      }
      if (!manifest) manifest = await _recheckManifest();
      if (!manifest) {
        // 云端 manifest 确实不存在（被删除 / 还未建立）：仅在本地确有内容时才重建，
        // 避免"空库 + globalDirty（改设置/切笔记本即置位）"把云端清单清零。
        // —— 这是"清单莫名变 0"的主路径：doPut 旧实现无条件 _firstSync，空库即清零。
        // _firstSync 内还有一道空库护栏兜底（双保险）。
        const d = window.storage.getAll() || {};
        const hasLocal = (d.notes && Object.keys(d.notes).length > 0) || (d.trash && Object.keys(d.trash).length > 0);
        if (hasLocal) await _firstSync();
        else _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-skip-empty-local' });
        return;
      }

      // CAS：当场快照这次读到的 manifest 的 ETag（存进局部变量，避免后续 await 期间被其它读覆盖）。
      // _casForceUnconditional：连续被 412 后退化为普通写（容忍弱校验服务器），由成功写入复位。
      const manifestEtag = _casForceUnconditional ? '' : _lastManifestEtag;

      // 数据格式版本闸：云端格式比本客户端新 → 绝不上传（否则旧格式会覆盖新格式数据）。
      if (_remoteFormatTooNew(manifest)) {
        console.warn('[webdav] 云端数据格式版本高于本客户端，停止上传，请更新枝记');
        _emit('cloud-sync', { type: 'webdav-version-block', remoteFmt: manifest.dataFormatVersion, supported: SUPPORTED_DATA_FORMAT });
        return;
      }
      manifest = await _ensureV3BackupAndV4Gate(manifest);
      manifest = await _ensureV5Index(manifest);

      // 重开后脏记号可能只剩按篇：清单里还没有这篇 = 新建，必须走目录账。
      // v4 起标题/位置只认总账，不再用清单字段判断改名/移动。
      if (!globalDirty && dirtyIds.size > 0) {
        for (const id of dirtyIds) {
          const note = data.notes[id];
          if (!note) { globalDirty = true; break; }
          const m = manifest.notes && manifest.notes[id];
          if (!m) { globalDirty = true; break; }
        }
      }

      // 一篇一篇过关：先只核对本篇，再传本篇。成功立刻清这篇脏、记下「目录还没交卷」。
      // 失败不连坐已传成功的篇。上传前防盖只读正在传的这篇，不先扫完全部脏篇。
      const uploadedIds = new Set();
      const failedIds = [];
      let skippedNotes = 0;
      for (const id of Array.from(dirtyIds)) {
        if (_stopped) break;
        const one = new Set([id]);
        try {
          await _guardUploadConflicts(one, data, manifest);
        } catch (e) {
          if (e instanceof RateLimitError) throw e;
          failedIds.push(id);
          console.warn('[webdav] 上传前核对失败，本篇稍后重试:', id, e && e.message);
          continue;
        }
        if (!one.has(id) || _deferUploadIds.has(id)) {
          skippedNotes++;
          continue;
        }
        try {
          const note = data.notes[id];
          if (note) {
            // 日常上传不得擦墓碑、不得把已删篇再传上去。「覆盖云端」除外（本机就是权威）。
            // 增量恢复拉回的篇：用户明确要重新出现并上云，擦掉名单删除记录再传。
            const revived = !!(window.storage.isRevivedFromBackup && window.storage.isRevivedFromBackup(id));
            if (!freshLedger && !revived && manifest.deleted && manifest.deleted[id]) {
              _backupBeforeOverwrite(id, note, 'remote-delete');
              window.storage._webdavRemoveNote(id);
              _delBase(id);
              if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
              try { window.storage.save({ immediate: true }); } catch (_) {}
              skippedNotes++;
              continue;
            }
            if (revived && manifest.deleted && manifest.deleted[id]) delete manifest.deleted[id];
            if (revived && manifest.trash) delete manifest.trash[id];
            const nextV = _noteVer(manifest.notes && manifest.notes[id]) + 1;
            const isNew = !(manifest.notes && manifest.notes[id]) || !_getBase(id);
            if (!freshLedger && _isEmptyBody(note) && isNew) {
              uploadedIds.add(id);
              if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
              if (window.storage.markIndexDirty) window.storage.markIndexDirty(id);
              indexDirty = true;
              if (!manifest.notes) manifest.notes = {};
              manifest.notes[id] = { v: nextV, empty: 1 };
              _rememberPendingVer(id, nextV);
              _setBase(id, _noteHash(note), nextV);
              try { console.log('[sync-put-run] notes：空篇不传正文', id); } catch (_) {}
            } else {
              const body = await _prepareYbin(note);
              await webdavPut(`notes/${id}.ybin`, body);
              _setHint(id, 'y', nextV);
              uploadedIds.add(id);
              if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
              if (window.storage.markIndexDirty) window.storage.markIndexDirty(id);
              indexDirty = true;
              if (!manifest.notes) manifest.notes = {};
              manifest.notes[id] = { v: nextV };
              _rememberPendingVer(id, nextV);
              _setBase(id, _noteHash(note), nextV);
            }
          } else if (data.trash && data.trash[id]) {
            if (freshLedger) {
              const body = await _prepareNoteBody(data.trash[id]);
              await webdavPut(`trash/${id}.json`, body);
            } else {
              try { console.log('[sync-put-run] notes：回收站不传整篇', id); } catch (_) {}
            }
            uploadedIds.add(id);
            if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
            if (window.storage.markIndexDirty) window.storage.markIndexDirty(id);
            indexDirty = true;
            _delBase(id);
          } else {
            uploadedIds.add(id);
            if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
            if (window.storage.markIndexDirty) window.storage.markIndexDirty(id);
            indexDirty = true;
            _delBase(id);
          }
        } catch (e) {
          if (e instanceof RateLimitError) throw e;
          failedIds.push(id);
          console.warn('[webdav] 单篇上传失败，已过关的不重传:', id, e && e.message);
        }
      }
      _flushSyncBase();
      try {
        console.log('[sync-put-run] notes：逐篇过关 成功=', uploadedIds.size,
          '失败=', failedIds.length, '跳过=', skippedNotes);
      } catch (_) {}

      // 上传新图片（外置后从内存缓存取；等后端载入完成，避免漏传）
      if (window.storage.imagesReady) await window.storage.imagesReady();
      const localImages = (window.storage.getImageMap && window.storage.getImageMap()) || data.localImages || {};
      // 条件写基准：记下此刻云端 manifest 的 updatedAt；最终写回前会再确认它没被别的设备改过。
      const _manifestBaseTs = manifest.updatedAt || 0;
      const remoteImages = manifest.images || {};
      manifest.images = manifest.images || {};
      let imagesUploaded = false;
      {
        const imgHashes = Object.keys(localImages).filter(h => !remoteImages[h]);
        const { errors } = await _runPool(imgHashes, async (hash) => {
          const dataUrl = localImages[hash];
          const { ext, binary } = _dataUrlToBlob(dataUrl);
          if (binary.length > 0) {
            await webdavPut(`images/${hash}`, binary, _extToMime(ext));
            manifest.images[hash] = ext;
            _pendingManifestImages[hash] = ext;
            imagesUploaded = true;
          }
        });
        const rl = errors.find(e => e.error instanceof RateLimitError);
        if (rl) throw rl.error;
        if (errors.length) throw errors[0].error;
      }

      indexDirty = indexDirty || !!(window.storage.isIndexDirty && window.storage.isIndexDirty());
      if (window.storage.getIndexPendingIds) {
        for (const id of window.storage.getIndexPendingIds()) uploadedIds.add(id);
      }

      for (const h in _pendingManifestImages) {
        manifest.images = manifest.images || {};
        manifest.images[h] = _pendingManifestImages[h];
      }
      const needManifest = uploadedIds.size > 0 || globalDirty || indexDirty || imagesUploaded || Object.keys(_pendingManifestImages).length > 0;
      if (!needManifest) {
        if (failedIds.length) {
          _pendingPut = true;
          setTimeout(() => schedulePut('put-partial-retry'), 2000);
          _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-partial' });
        } else {
          _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-resolved-conflicts' });
        }
        return;
      }

      // 更新清单：只登记本轮已过关的篇。失败的篇不写进目录，以免对端以为有文件。
      for (const id of uploadedIds) {
        const note = data.notes[id];
        if (note) {
          if (!manifest.notes[id] || !_noteVer(manifest.notes[id])) {
            manifest.notes[id] = { v: 1 };
          }
          // 只有「覆盖云端」或增量恢复拉回的篇才允许本机活篇擦掉云端墓碑；日常上传绝不复活。
          if ((freshLedger || (window.storage.isRevivedFromBackup && window.storage.isRevivedFromBackup(id)))
              && manifest.deleted && manifest.deleted[id]) delete manifest.deleted[id];
          if (window.storage.isRevivedFromBackup && window.storage.isRevivedFromBackup(id) && manifest.trash) {
            delete manifest.trash[id];
          }
        } else if (data.trash && data.trash[id]) {
          manifest.trash = manifest.trash || {};
          manifest.trash[id] = { updatedAt: new Date(data.trash[id].updatedAt || data.trash[id].deletedAt || 0).getTime() };
          delete manifest.notes[id];
          manifest.deleted = manifest.deleted || {};
          manifest.deleted[id] = Date.now();
        } else {
          // 彻底删除：notes 与 trash 都已无此 id → 记墓碑 + 清 manifest + 删云端文件。
          // 不做这步的话，manifest.notes[id] 残留，下次启动同步会把它重新下载回列表（顽固复活 bug）。
          // 仅删「索引里曾经有过」的路径：两边都没有时再 DELETE 必 404，浏览器控制台会红字刷屏（文件多半早已不在）。
          const hadNote = !!(manifest.notes && manifest.notes[id]);
          const hadTrash = !!(manifest.trash && manifest.trash[id]);
          delete manifest.notes[id];
          if (manifest.trash) delete manifest.trash[id];
          manifest.deleted = manifest.deleted || {};
          manifest.deleted[id] = Date.now();
          if (hadNote) {
            const h = _hintOf(id);
            if (h && h.k === 'j') {
              try { await webdavDelete(`notes/${id}.json`); } catch (_) {}
            } else {
              try { await webdavDelete(`notes/${id}.ybin`); } catch (_) {}
            }
            _clearHint(id);
          }
          if (hadTrash) { try { await webdavDelete(`trash/${id}.json`); } catch (_) {} }
        }
      }

      // 方案 A：有脏笔记或结构脏都立刻写清单（打字写瘦清单，不再延后 45 秒）
      if (globalDirty) {
        // 合并而非覆盖：本地在前（本机的顺序/重命名生效），但云端 manifest 里已有、
        // 本机却没有的笔记 id 一律保留，绝不删除。
        // —— 这是数据丢失的根治点：避免"另一台设备刚建的笔记"被本次上传从 rootOrder 抹掉而消失。
        const delMap = manifest.deleted || {};
        manifest.rootOrder = _mergeIdOrderUp(data.rootOrder, manifest.rootOrder).filter(id => !delMap[id]);
        manifest.trashOrder = _mergeIdOrderUp(data.trashOrder, manifest.trashOrder).filter(id => !delMap[id]);
        if (freshLedger) {
          // 权威覆盖（覆盖恢复/覆盖云端）：丢弃云端旧的笔记本/模板删除标记与云端独有项，
          //   manifest 以本地导入结果为准，其它设备靠 epoch 进采纳模式对齐到这份干净全集。
          manifest.wsDeleted = { ...(data.wsTombstones || {}) };
          manifest.workspaces = (data.workspaces || []).filter(w => !manifest.wsDeleted[w.id]);
          manifest.tplDeleted = { ...(data.tplTombstones || {}) };
          manifest.templates = (data.templates || []).filter(t => !manifest.tplDeleted[t.id]);
        } else {
          // 笔记本墓碑：合并本地+云端墓碑，并据此剔除已删除的笔记本，使删除经云端生效
          manifest.wsDeleted = { ...(manifest.wsDeleted || {}), ...(data.wsTombstones || {}) };
          if (window.storage.isRevivedFromBackup) {
            for (const wid in manifest.wsDeleted) {
              if (window.storage.isRevivedFromBackup(wid)) delete manifest.wsDeleted[wid];
            }
          }
          manifest.workspaces = _mergeByIdUp(data.workspaces, manifest.workspaces).filter(w => !manifest.wsDeleted[w.id]);
          // 模板墓碑：同笔记本，合并墓碑并剔除已删除模板，使删除经云端生效
          manifest.tplDeleted = { ...(manifest.tplDeleted || {}), ...(data.tplTombstones || {}) };
          manifest.templates = _mergeByIdUp(data.templates, manifest.templates).filter(t => !manifest.tplDeleted[t.id]);
        }
        // 设置并集：本机可同步键覆盖同名；云端有、本机没有的键保留（防 globalDirty 时抹掉它机 aiKeyEnc 等）
        manifest.settings = _mergeSharedSettingsUp(
          _extractSharedSettings(data.settings),
          manifest.settings
        );

        // v4：标题/父子只认结构总账，清单不再写这两项。

        // 结构总账：合并后写入独立文件，清单不再内嵌大块（20260806t1）。
        let ledgerOut = null;
        try {
          if (window.storage._webdavGetStructLedger) {
            if (freshLedger) {
              ledgerOut = window.storage._webdavGetStructLedger();
            } else if (String(manifest.deviceId || '') === _ensureClientId()) {
              // 总目录还是自己写的：不必先读云端总账，直接传本地这一本（删/建/改名提速）。
              ledgerOut = window.storage._webdavGetStructLedger();
              if (!ledgerOut && window.storage._webdavMarkStructLedgerRooted) {
                window.storage._webdavMarkStructLedgerRooted();
                ledgerOut = window.storage._webdavGetStructLedger();
              }
              try { console.log('[sync-put-run] structure：跳过读云端总账（仍是本机目录）'); } catch (_) {}
            } else {
              const cloudLedger = await _loadCloudStructLedger(manifest);
              if (cloudLedger && window.storage._webdavApplyStructLedger) {
                window.storage._webdavApplyStructLedger(cloudLedger);
              } else if (!cloudLedger && window.storage._webdavMarkStructLedgerRooted) {
                window.storage._webdavMarkStructLedgerRooted();
              }
              ledgerOut = window.storage._webdavGetStructLedger();
            }
          }
        } catch (e) { console.warn('[webdav] 结构总账上传处理失败（忽略，不影响主同步）', e); }
        await _persistStructLedgerExternal(manifest, ledgerOut, { forceFull: !!freshLedger });
        _purgeOldDeleted(manifest);
        try { console.log('[sync-put-run] structure：写瘦清单+结构（整本或一小段）'); } catch (_) {}
      } else {
        // 纯正文/图片：只剥内嵌总账字段，绝不 PUT struct-ledger.json
        await _persistStructLedgerExternal(manifest, null);
        const deferCatalog = !freshLedger && !flushIndex && !imagesUploaded && uploadedIds.size > 0
          && ![...uploadedIds].some(id => window.storage.isRevivedFromBackup && window.storage.isRevivedFromBackup(id));
        if (deferCatalog) {
          _lastManifestObj = manifest;
          _lastPutTime = Date.now();
          for (const id of uploadedIds) {
            const note = data.notes[id];
            if (note && manifest.notes[id]) _setBase(id, _noteHash(note), _noteVer(manifest.notes[id]));
            else _delBase(id);
          }
          _flushSyncBase();
          if (window.storage.save) window.storage.save({ immediate: true });
          _scheduleDeferredCatalog();
          if (failedIds.length) {
            _pendingPut = true;
            setTimeout(() => schedulePut('put-partial-retry'), 2000);
          }
          try { console.log('[sync-put-run] content：只传正文（名单稍后交）', 'uploaded=', uploadedIds.size); } catch (_) {}
          _emit('cloud-sync', { type: 'webdav-sync-ok', detail: failedIds.length ? 'put-partial' : 'put-content', uploaded: uploadedIds.size });
          return;
        }
        try { console.log('[sync-put-run] content：写瘦清单（不重写结构总账）'); } catch (_) {}
      }

      if (!freshLedger) {
        // 日常交目录不再先读一遍防抢先：写完立刻读回对；覆盖云端仍走完整核对。
      } else {
        const _freshManifest = await webdavGetJson('manifest.json', { allow404: true });
        if (_freshManifest && Number(_freshManifest.updatedAt || 0) !== Number(_manifestBaseTs || 0)) {
          _pendingPut = true;
          setTimeout(() => schedulePut('put-deferred-concurrent'), 1500);
          _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-deferred-concurrent' });
          return;
        }
      }

      manifest.rev = (Number(manifest.rev) || 0) + 1;
      if (!manifest.epoch) manifest.epoch = 1;
      // 数据格式版本：本机为 v2(JSON)。若云端还停在旧格式(<本机) → 本机是首个推送 JSON 全集的设备：
      // 提升 manifest.dataFormatVersion 并 epoch++，使其它设备进入「采纳模式」对齐到 JSON 全集
      // （没更新的旧设备靠 epoch 兜底：覆盖前留底→采纳云端→不反向覆盖，最坏显示异常、重启恢复，不丢数据）。
      // 仅首推一次：之后云端已是 v2，条件不再成立。
      const _localFmt = _localDataFormat();
      const _remoteFmt = manifest.dataFormatVersion || 1;
      if (_localFmt > _remoteFmt) {
        manifest.dataFormatVersion = _localFmt;
        manifest.epoch = (manifest.epoch || 1) + 1;
        _setAdoptedEpoch(manifest.epoch);  // 本机是发起方，对齐新世代，避免自己又去采纳
        console.warn('[webdav] 首次推送 JSON 数据格式 v' + _localFmt + '，epoch→' + manifest.epoch);
      }
      manifest.updatedAt = Date.now();
      manifest.deviceId = _ensureClientId();
      if (!manifest.version) manifest.version = 2;
      _applyPendingVers(manifest);

      if (freshLedger) {
        await _putManifestVerified(manifest, manifestEtag);
      } else {
        try {
          await _putManifestCheap(manifest);
        } catch (cheapErr) {
          console.warn('[webdav] 便宜核对失败，改走完整核对', cheapErr && cheapErr.message);
          await _putManifestVerified(manifest, '');
        }
      }
      _casFailStreak = 0; _casForceUnconditional = false;
      _rememberManifestCursor(manifest);
      _lastPutTime = Date.now();
      const revivedDone = [];
      for (const id of uploadedIds) {
        if (data.notes[id] && window.storage.isRevivedFromBackup && window.storage.isRevivedFromBackup(id)) revivedDone.push(id);
      }
      if (revivedDone.length && window.storage.clearRevivedFromBackup) window.storage.clearRevivedFromBackup(revivedDone);
      try {
        console.log('[sync-put-ok] 清单已写入', freshLedger ? '完整核对' : '日常不立刻对',
          'globalDirty=', globalDirty, 'uploaded=', uploadedIds.size, 'failed=', failedIds.length);
      } catch (_) {}

      for (const id of uploadedIds) {
        const note = data.notes[id];
        if (note && manifest.notes[id]) _setBase(id, _noteHash(note), _noteVer(manifest.notes[id]));
        else _delBase(id);
      }
      _flushSyncBase();

      _pendingManifestImages = {};
      if (globalDirty && window.storage.clearGlobalDirty) window.storage.clearGlobalDirty();
      if (window.storage.clearIndexDirty) window.storage.clearIndexDirty();
      _clearPendingVers();
      if (_catalogFlushTimer) { clearTimeout(_catalogFlushTimer); _catalogFlushTimer = null; }
      if (window.storage.save) window.storage.save({ immediate: true });

      if (failedIds.length) {
        _pendingPut = true;
        setTimeout(() => schedulePut('put-partial-retry'), 2000);
      }

      _backoffMs = 30_000;
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: failedIds.length ? 'put-partial' : 'put', uploaded: uploadedIds.size });

    } catch (e) {
      if (e instanceof RateLimitError) {
        _handleRateLimit();
      } else if (e instanceof PreconditionFailedError) {
        // 被抢先：目录没写成。已过关的正文不清回脏；目录脏留下，下一轮重交卷。
        _casFailStreak++;
        if (_casFailStreak >= 2) _casForceUnconditional = true;
        _pendingPut = true;
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-retry-cas' });
        console.warn('[webdav] manifest 被其它设备抢先更新（412），重新合并后重试（streak=' + _casFailStreak + '）');
        schedulePut('put-retry-cas'); // 受 _putMinIntervalMs(默认 5s) 节流，不会请求风暴
      } else if (e && (e.transient || _isNetFlavorError(e))) {
        // 瞬时错误（并发写期间读到空/截断的 manifest）：保留 dirty、少量自动重试；连续失败则熔断报错
        _pendingPut = true;
        _handleTransient(e, '上传', () => schedulePut('put-retry-transient'));
      } else {
        _emit('cloud-sync', { type: 'webdav-sync-fail', error: e.message });
        console.error('[webdav] PUT 错误:', e);
      }
      // 手动同步：如实上抛真实结果；但 412 是"已自动重排重试"的良性信号，不当失败上报。
      if (strict && !(e instanceof PreconditionFailedError)) throw e;
    } finally {
      try { console.log('[sync-put] 结束', (Date.now() - _tPut) + 'ms'); } catch (_) {}
      _endUiBusy();
      _syncing = false;
      _drainPending();
    }
  }

  // ─── 首次同步 ────────────────────────────────────────────────────────────────
  async function _firstSync() {
    _beginUiBusy(true);
    _emit('cloud-sync', { type: 'webdav-sync-start', detail: 'first', heavy: true });
    // 空库护栏（数据安全总闸，无条件）：本地 0 笔记 0 回收站时绝不发布清单——不管云端读到什么。
    // 根因：清零 = false-404（服务器把"其实存在的清单"瞬时回 404）+ 本地恰为空 → _firstSync 拿空库
    // 覆盖云端真实清单。空库本就没东西可发布；真·新用户等"有了第一篇笔记"再建清单，零代价。
    // 不再"先探云端是否非空"——那次探测本身也可能 false-404，护栏会失效；直接无条件跳过最稳。
    {
      const d0 = window.storage.getAll() || {};
      const nCount = d0.notes ? Object.keys(d0.notes).length : 0;
      const tCount = d0.trash ? Object.keys(d0.trash).length : 0;
      if (nCount === 0 && tCount === 0) {
        console.warn('[webdav] 本地空库，跳过首次同步（不发布空清单，防 false-404 清零云端）');
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'first-skip-empty-local' });
        return;
      }
    }
    await webdavMkcol('');
    await webdavMkcol('notes');
    await webdavMkcol('trash');
    await webdavMkcol('images');

    const data = window.storage.getAll();
    const manifest = _createEmptyManifest();
    const uploadedNoteIds = new Set();

    {
      const { errors } = await _runPool(Object.keys(data.notes), async (id) => {
        const note = data.notes[id];
        const body = await _prepareYbin(note);
        await webdavPut(`notes/${id}.ybin`, body);
        manifest.notes[id] = { v: 1 };
        uploadedNoteIds.add(id);
      });
      const rl = errors.find(e => e.error instanceof RateLimitError);
      if (rl) throw rl.error;
      if (errors.length) throw errors[0].error;
    }
    {
      const { errors } = await _runPool(Object.keys(data.trash), async (id) => {
        const note = data.trash[id];
        const body = await _prepareNoteBody(note);
        await webdavPut(`trash/${id}.json`, body);
        manifest.trash[id] = { updatedAt: new Date(note.updatedAt || note.deletedAt || 0).getTime() };
      });
      const rl = errors.find(e => e.error instanceof RateLimitError);
      if (rl) throw rl.error;
      if (errors.length) throw errors[0].error;
    }
    // 图片并发上传 + 跳过云端已存在的（内容寻址：文件名即内容 hash，同名必同内容，无需重传）。
    // 一次 PROPFIND 列目录换掉大量盲传请求——"修复云端清单"等重建场景图片几乎秒过。
    if (window.storage.imagesReady) await window.storage.imagesReady();
    const localImages = (window.storage.getImageMap && window.storage.getImageMap()) || data.localImages || {};
    let _existingImgs = new Set();
    try {
      _existingImgs = new Set(
        (await webdavPropfind('images')).map(e => (e.href || '').replace(/\/+$/, '').split('/').pop()).filter(Boolean)
      );
    } catch (_) { /* 列不到就退回全传，不影响正确性 */ }
    {
      const { errors } = await _runPool(Object.keys(localImages), async (hash) => {
        const { ext, binary } = _dataUrlToBlob(localImages[hash]);
        if (binary.length === 0) return;
        if (!_existingImgs.has(hash)) {
          await webdavPut(`images/${hash}`, binary, _extToMime(ext));
        }
        manifest.images[hash] = ext;
      });
      const rl = errors.find(e => e.error instanceof RateLimitError);
      if (rl) throw rl.error;
      if (errors.length) throw errors[0].error;
    }

    manifest.rootOrder = data.rootOrder || [];
    manifest.trashOrder = data.trashOrder || [];
    manifest.wsDeleted = { ...(manifest.wsDeleted || {}), ...(data.wsTombstones || {}) };
    manifest.workspaces = (data.workspaces || []).filter(w => !manifest.wsDeleted[w.id]);
    manifest.tplDeleted = { ...(manifest.tplDeleted || {}), ...(data.tplTombstones || {}) };
    manifest.templates = (data.templates || []).filter(t => !manifest.tplDeleted[t.id]);
    manifest.settings = _extractSharedSettings(data.settings);
    // 结构总账：首次同步本机即基线，外置独立文件并标记扎根（清单保持瘦）。
    try {
      if (window.storage._webdavGetStructLedger) {
        const merged = window.storage._webdavGetStructLedger();
        if (merged) {
          if (window.storage._webdavMarkStructLedgerRooted) window.storage._webdavMarkStructLedgerRooted();
          await _persistStructLedgerExternal(manifest, merged, { forceFull: true });
        }
      }
    } catch (e) { console.warn('[webdav] 首次同步结构总账写入失败（忽略）', e); }
    manifest.rev = 1;
    manifest.updatedAt = Date.now();
    manifest.deviceId = _ensureClientId();

    await _putManifestVerified(manifest);
    _rememberManifestCursor(manifest);
    _lastPutTime = Date.now();
    _setAdoptedEpoch(manifest.epoch || 1); // 本机建立了云端，对齐世代，避免日后误采纳自己

    // 立基准：首次同步把本地所有笔记当作"已同步"的基准点
    for (const id in data.notes) {
      if (manifest.notes[id]) _setBase(id, _noteHash(data.notes[id]), _noteVer(manifest.notes[id]));
    }
    _flushSyncBase();

    // 只清除首次同步上传的笔记 ID，保留期间新增的编辑
    if (window.storage.removeDirtyNoteIds) {
      window.storage.removeDirtyNoteIds(uploadedNoteIds);
    }
    if (window.storage.clearGlobalDirty) window.storage.clearGlobalDirty();

    _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'first' });
  }

  function _createEmptyManifest() {
    return { version: 2, epoch: 1, rev: 0, dataFormatVersion: _localDataFormat(), updatedAt: 0, deviceId: _ensureClientId(), notes: {}, trash: {}, images: {}, deleted: {}, wsDeleted: {}, tplDeleted: {} };
  }

  /** 墓碑时间戳归一化：规范是毫秒数字，但历史版本曾误写 ISO 字符串，这里统一转数字兼容旧数据 */
  function _tombTs(v) {
    if (typeof v === 'number') return v;
    const t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  }

  function _purgeOldDeleted(manifest) {
    if (!manifest.deleted) return;
    const now = Date.now();
    for (const id in manifest.deleted) {
      if (now - _tombTs(manifest.deleted[id]) > DELETED_RETENTION_MS) {
        delete manifest.deleted[id];
      }
    }
  }

  // ─── 调度层：PUT debounce + 间隔控制 ──────────────────────────────────────────
  function schedulePut(reason) {
    if (!_config || _paused || _stopped) return;
    if (!_hasDirtyData()) return;
    try {
      if (window.__MD_DEBUG__) {
        const ids = window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : [];
        const g = window.storage.isGlobalDirty ? window.storage.isGlobalDirty() : false;
        console.log('[sync-put-sched]', reason || '?', 'globalDirty=', g,
          'dirtyNotes=', ids.length, ids.length ? ids.slice(0, 8) : []);
      }
    } catch (_) {}
    clearTimeout(_putTimer);
    _putTimer = setTimeout(() => {
      _putTimer = null;
      if (_syncing) {
        // 如果正在同步，延后重试
        _putTimer = setTimeout(() => schedulePut(reason || 'retry-busy'), 2000);
        return;
      }
      const elapsed = Date.now() - _lastPutTime;
      if (elapsed < _putMinIntervalMs) {
        _putTimer = setTimeout(() => doPut({ _schedReason: reason }), _putMinIntervalMs - elapsed);
      } else {
        doPut({ _schedReason: reason });
      }
    }, _putDebounceMs);
  }

  function flushIndex() {
    if (!_config || _stopped || !_hasDirtyData()) return;
    if (_syncing) { _pendingPut = true; return; }
    clearTimeout(_putTimer);
    doPut({ flushIndex: true, _schedReason: 'flush-index' });
  }

  function flushPutOnBlur() {
    if (!_config || _stopped || !_hasDirtyData()) return;
    if (Date.now() - _lastBlurPutTime < BLUR_PUT_COOLDOWN_MS) return;
    if (_syncing) { _pendingPut = true; return; }
    clearTimeout(_putTimer);
    _lastBlurPutTime = Date.now();
    doPut({ flushIndex: true, _schedReason: 'blur' });
  }

  async function flushPutOnHide() {
    if (!_config || _stopped || !_hasDirtyData()) return;
    if (_syncing) { _pendingPut = true; return; }
    clearTimeout(_putTimer);
    await doPut({ flushIndex: true, _schedReason: 'hide' });
  }

  // ─── 手动同步 ────────────────────────────────────────────────────────────────
  async function manualSync() {
    // 急救：未启动则尝试拉起；仍不行则抛错，让顶栏/设置必有失败提示（禁止静默 return）
    if (!_config || _stopped) {
      await startAutoSync();
      if (!_config || _stopped) throw new Error('同步未配置或未启动，请到设置 → 同步检查');
    }
    if (!navigator.onLine) throw new Error('当前离线，无法同步');
    _skipBadNotes = {}; // 手动同步是用户主动行为：僵尸名单清空，给所有跳过的笔记一次重试机会
    _pendingWakeGet = false;
    _transientFailStreak = 0;
    if (_syncing) await _waitSyncDone();
    const wasPaused = _paused;
    _paused = false;
    let downloaded = 0;
    try {
      // 先拉后推：先把云端变更合并下来（同篇冲突会生成"冲突副本"，谁都不丢），
      // 再上传本地改动。避免"先推"把另一台设备的同篇更新静默覆盖。
      // strict：失败必须上抛——以前 doGet 把错误内部消化掉，"立即同步"明明失败却显示"同步完成"，
      // 用户因此以为同步没问题、错误提示是误报。
      // full：手动同步 = 最彻底的一次核对（整份读名单、名单未变也补拉补对、销已传未交的账、对当前篇）。
      // 核对本身只多花本地比对功夫；只有真发现不一致才会去下载那几篇，账都对得上时就一两秒。
      await doGet({ force: true, strict: true, full: true });
      downloaded = (_lastDownloadedIds && _lastDownloadedIds.size) || 0;
      if (_hasDirtyData()) {
        await doPut({ force: true, strict: true, flushIndex: true });
      }
      return { downloaded };
    } finally {
      if (wasPaused) _paused = wasPaused;
    }
  }

  // ─── 沉默状态管理 ────────────────────────────────────────────────────────────
  function _resetSilenceTimer() {
    _isSilent = false;
    clearTimeout(_silenceTimer);
    _silenceTimer = setTimeout(() => { _isSilent = true; }, SILENCE_TIMEOUT_MS);
  }

  function _onUserInteraction() {
    if (_isSilent) {
      _isSilent = false;
      doGet({ silent: true });
    }
    _resetSilenceTimer();
  }

  // 窗口被唤起 / 获焦 / 恢复网络 / Quicker show 时：强制拉一次云端。
  // 用 2 秒去重，避免 focus + visibilitychange 同时触发导致重复请求。
  // 延迟 1s 再拉 + 清空熔断计数 + 开宽限：避开浏览器/代理刚醒时的 Failed to fetch 误报。
  // 若延迟到期仍 hidden：保留 _pendingWakeGet，绝不默默丢弃（Quicker 藏窗常见）。
  let _lastWakeGetTime = 0;
  let _wakeGetTimer = null;
  function _wakeGet(opts) {
    const forcePending = !!(opts && opts.force);
    const now = Date.now();
    // 有待补拉或显式 force：打破 2s 去重，确保一定会排一次强制拉
    if (!forcePending && !_pendingWakeGet && now - _lastWakeGetTime < 2000) return;
    _lastWakeGetTime = now;
    _resetSilenceTimer();
    _transientFailStreak = 0;
    _wakeGraceUntil = now + WAKE_GRACE_MS;
    if (_wakeGetTimer) clearTimeout(_wakeGetTimer);
    _wakeGetTimer = setTimeout(() => {
      _wakeGetTimer = null;
      if (_stopped) return;
      // 仍 hidden：只记待补拉，不在后台空枪（除非 Quicker show 显式 force——其 visibility 常不准）
      if (typeof document !== 'undefined' && document.hidden && !forcePending) {
        _pendingWakeGet = true;
        return;
      }
      _pendingWakeGet = false;
      // 新开一轮先拉后传。正在传时 doGet 会排队，不打断上传。怎么拉由 _openGetOpts 一处决策。
      doGet(_openGetOpts());
    }, WAKE_GET_DELAY_MS);
  }

  // ─── 事件监听器管理 ──────────────────────────────────────────────────────────
  let _boundHandlers = null;

  function _registerListeners() {
    if (_boundHandlers) return;
    _boundHandlers = {
      visibility: () => {
        if (_stopped) return;
        if (!document.hidden) _wakeGet();
        else {
          // 进后台：取消尚未发出的回前台拉取，瞬时熔断计数清零（后台空枪不攒阈值）
          if (_wakeGetTimer) { clearTimeout(_wakeGetTimer); _wakeGetTimer = null; }
          _transientFailStreak = 0;
          flushPutOnHide();
        }
      },
      blur: () => { if (!_stopped) flushPutOnBlur(); },
      focus: () => { if (!_stopped) _wakeGet(); },
      online: () => { if (!_stopped) { _paused = false; _wakeGet(); } },
      mousedown: _onUserInteraction,
      keydown: _onUserInteraction,
    };
    document.addEventListener('visibilitychange', _boundHandlers.visibility);
    window.addEventListener('blur', _boundHandlers.blur);
    window.addEventListener('focus', _boundHandlers.focus);
    window.addEventListener('online', _boundHandlers.online);
    document.addEventListener('mousedown', _boundHandlers.mousedown);
    document.addEventListener('keydown', _boundHandlers.keydown);
  }

  function _removeListeners() {
    if (!_boundHandlers) return;
    document.removeEventListener('visibilitychange', _boundHandlers.visibility);
    window.removeEventListener('blur', _boundHandlers.blur);
    window.removeEventListener('focus', _boundHandlers.focus);
    window.removeEventListener('online', _boundHandlers.online);
    document.removeEventListener('mousedown', _boundHandlers.mousedown);
    document.removeEventListener('keydown', _boundHandlers.keydown);
    _boundHandlers = null;
  }

  // ─── 启动 / 停止 ─────────────────────────────────────────────────────────────
  async function startAutoSync() {
    if (_started && !_stopped) return;
    const loaded = await loadConfig();
    if (!loaded) {
      console.warn('[webdav] 配置不完整，WebDAV 同步未启动');
      return;
    }
    _ensureClientId();
    _stopped = false;
    _started = true;
    _authFailCount = 0;
    _transientFailStreak = 0; // 换账号/重启同步后从零计数，避免残留计数直接触发熔断提示

    _registerListeners();
    _resetSilenceTimer();
    _startPolling();
    setTimeout(() => doGet(Object.assign(_openGetOpts(), { heavy: true })), 1000); // 刚开这一拉绿点转圈；怎么拉仍由 _openGetOpts
    _scheduleFullCheck(3 * 60_000);                        // 每日慢核对：打开约 3 分钟后挑空闲跑，绝不挡打开
  }

  // ─── 每日慢核对：后台静默、只挑空闲时跑 ─────────────────────────────────────
  // 快路（跳过空转、名单稍后交、自己写的不补拉）省下的核对，由这条慢路每天兜一遍：
  // 不带旧标记整份读名单、名单未变也补拉补对、销「已传未交」的账。跑一次约几秒、全程后台，不影响使用。
  function _scheduleFullCheck(delayMs) {
    clearTimeout(_fullCheckTimer);
    _fullCheckTimer = setTimeout(_maybeFullCheck, delayMs);
  }
  function _maybeFullCheck() {
    if (_stopped || !_config) return;
    _scheduleFullCheck(60 * 60_000);                       // 页面常驻：不管这次跑不跑，一小时后再看
    if (Date.now() - _lastFullCheckAt < FULL_CHECK_INTERVAL_MS) return;
    const busy = _paused || _syncing || !navigator.onLine
      || (typeof document !== 'undefined' && document.hidden)
      || _hasDirtyData();
    if (busy) { _scheduleFullCheck(10 * 60_000); return; } // 正忙/有待传/在后台：10 分钟后再试
    try { console.log('[sync-get] 每日慢核对（后台静默）'); } catch (_) {}
    doGet({ force: true, silent: true, full: true });
  }

  // 周期性后台轮询：即使窗口一直处于前台、用户也没切走，也能定期拉取云端变更。
  // 这是"切回来才同步、平时心里没谱"的根治点——让两台设备始终基于较新的数据编辑，
  // 显著降低"各自改了同一旧版本"导致冲突的概率。静默执行（不闪同步徽标）。
  let _lastIdlePollAt = 0;
  const IDLE_POLL_INTERVAL_MS = 60_000;

  function _startPolling() {
    _stopPolling();
    _pollTimer = setInterval(() => {
      if (_stopped || _paused || _syncing) return;
      if (typeof document !== 'undefined' && document.hidden) return; // 隐藏时不轮询，靠 focus/visibility 唤醒
      if (!navigator.onLine) return;
      // 静默期（2 分钟无键鼠操作）降频到 60s 一次：人不在跟前没必要全速拉云端，
      // 大幅节省代理请求配额；一有操作 _onUserInteraction 会立即补拉一次，不影响体感。
      if (_isSilent) {
        const now = Date.now();
        if (now - _lastIdlePollAt < IDLE_POLL_INTERVAL_MS) return;
        _lastIdlePollAt = now;
      }
      doGet({ silent: true }); // 非强制；刚写过且对面不在会跳过空转
    }, _pollIntervalMs);
  }
  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  function stop() {
    _stopped = true;
    _started = false;
    _paused = false;
    clearTimeout(_putTimer);
    clearTimeout(_silenceTimer);
    clearTimeout(_pauseResumeTimer);
    clearTimeout(_fullCheckTimer); _fullCheckTimer = null;
    _stopPolling();
    if (_imageDownloadTimer) { clearTimeout(_imageDownloadTimer); _imageDownloadTimer = null; }
    _removeListeners();
    _config = null;
  }

  // ─── 限流处理 ────────────────────────────────────────────────────────────────
  function _handleRateLimit() {
    _paused = true;
    // 自适应降档：被限流就把并发减半（最低 2）并加一点间隔，本次会话生效（下次 loadConfig 按服务商重置）。
    _maxConcurrency = Math.max(2, Math.floor(_maxConcurrency / 2));
    _pacingMs = Math.max(_pacingMs, 150);
    _emit('cloud-sync', { type: 'webdav-rate-limited', backoffMs: _backoffMs });
    clearTimeout(_pauseResumeTimer);
    _pauseResumeTimer = setTimeout(() => {
      _paused = false;
      _backoffMs = Math.min(_backoffMs * 2, 10 * 60_000);
      // 暂停期间积压的本地改动恢复后立即补传（否则要等下一次编辑/失焦才会触发上传）
      if (_hasDirtyData()) schedulePut('rate-limit-resume');
    }, _backoffMs);
  }

  // ─── 排队与等待 ──────────────────────────────────────────────────────────────
  // 新开一轮先拉后传。正在传时进来的拉只排队，传完再拉，拉完再传剩下的。
  function _drainPending() {
    if (_pendingGet) {
      _pendingGet = false;
      if (_canSkipIdleGet()) {
        if (_pendingPut && _hasDirtyData()) setTimeout(() => doPut(), 100);
        return;
      }
      setTimeout(() => doGet(_openGetOpts()), 100);
      return;
    }
    if (_pendingPut) {
      _pendingPut = false;
      if (_hasDirtyData()) setTimeout(() => doPut(), 100);
    }
  }

  function _waitSyncDone() {
    if (!_syncing) return Promise.resolve();
    return new Promise(resolve => {
      const check = () => {
        if (!_syncing) return resolve();
        setTimeout(check, 200);
      };
      setTimeout(check, 200);
    });
  }

  // ─── 图片按需下载 ──────────────────────────────────────────────────────────
  let _pendingImageDownloads = new Set();
  let _pendingImageExts = {};
  let _imageDownloadTimer = null;

  function _scheduleImageDownloads() {
    if (_imageDownloadTimer) return;
    _imageDownloadTimer = setTimeout(async () => {
      _imageDownloadTimer = null;
      // 等同步操作完成后再下载图片
      if (_syncing) { _scheduleImageDownloads(); return; }
      await _downloadPendingImages();
    }, 500);
  }

  async function downloadImage(hash, ext) {
    // 图片外置后：启动早期本地后端可能还在载入，先等它完成并查本地，
    // 命中就直接返回——避免编辑器占位图触发不必要的云端下载。
    if (window.storage?.imagesReady) {
      await window.storage.imagesReady();
      const local = window.storage.getLocalImage?.(hash);
      if (local) return local;
    }
    if (!_config || _stopped) return null;
    if (!ext) ext = _pendingImageExts[hash];
    if (!ext) {
      const manifest = await webdavGetJson('manifest.json', { allow404: true });
      if (!manifest || !manifest.images || !manifest.images[hash]) return null;
      ext = manifest.images[hash];
    }
    const resp = await webdavGetBinary(`images/${hash}`, { allow404: true });
    if (!resp) return null;
    const blob = await resp.blob();
    const mime = _extToMime(ext);
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        if (window.storage && window.storage._webdavStoreImage) {
          window.storage._webdavStoreImage(hash, dataUrl);
        }
        _pendingImageDownloads.delete(hash);
        delete _pendingImageExts[hash];
        resolve(dataUrl);
      };
      reader.readAsDataURL(new Blob([blob], { type: mime }));
    });
  }

  async function _downloadPendingImages() {
    const hashes = [..._pendingImageDownloads];
    // 并发下载（控制并发数，避免触发服务端限流）：图片是正文之外的独立文件，
    // 正文已先行下载并显示占位，这里并发拉取图片字节可显著缩短整体等待。
    const CONCURRENCY = 4;
    let idx = 0;
    async function worker() {
      while (idx < hashes.length && !_stopped) {
        const hash = hashes[idx++];
        if (!_pendingImageDownloads.has(hash)) continue;
        try { await downloadImage(hash); }
        catch (e) { console.warn('[webdav] 图片下载失败:', hash, e.message); }
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, hashes.length) }, worker);
    await Promise.all(workers);
  }

  // ─── 辅助函数 ────────────────────────────────────────────────────────────────
  function _hasDirtyData() {
    if (!window.storage) return false;
    const dirtyIds = window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : [];
    const globalDirty = window.storage.isGlobalDirty ? window.storage.isGlobalDirty() : false;
    const indexDirty = !!(window.storage.isIndexDirty && window.storage.isIndexDirty());
    return dirtyIds.length > 0 || globalDirty || indexDirty;
  }

  /** 上传合并：本地在前，追加仅远端有的 id，去重（绝不丢远端 id） */
  function _mergeIdOrderUp(localArr, remoteArr) {
    const out = []; const seen = new Set();
    for (const id of (localArr || [])) { if (id != null && !seen.has(id)) { seen.add(id); out.push(id); } }
    for (const id of (remoteArr || [])) { if (id != null && !seen.has(id)) { seen.add(id); out.push(id); } }
    return out;
  }
  /** 上传合并（按 id 的对象数组）：本地优先（同 id 用本地版本），保留仅远端有的 */
  function _mergeByIdUp(localArr, remoteArr) {
    const out = []; const seen = new Set();
    for (const it of (localArr || [])) { if (it && it.id != null && !seen.has(it.id)) { seen.add(it.id); out.push(it); } }
    for (const it of (remoteArr || [])) { if (it && it.id != null && !seen.has(it.id)) { seen.add(it.id); out.push(it); } }
    return out;
  }

  function _extractSharedSettings(settings) {
    if (!settings) return {};
    // 与 storage.js 的 LOCAL_ONLY_SETTINGS 保持一致：每台设备各自的偏好 / UI 状态不上云。
    // 铃铛 `bellMsgAcks`（跟笔记走的勾删）要上云，不要列入 LOCAL_ONLY。
    const LOCAL_ONLY = ['theme', 'fontSize', 'fontFamily', 'noteTransition',
      'sidebarCollapsed', 'outlineCollapsed', 'showTrashBadge', 'syncMethod',
      'editorPadding', 'sidebarWidth', 'outlineOpen',
      'activeWorkspace', 'lastOpenedId', 'startupNoteId', 'recent', 'recentEmojis', 'imagesDir',
      'webdavUrl', 'webdavUser', 'webdavPass', 'webdavProvider', 'webdavEncryptNotes', 'webdavProxy', 'webdavRealtime', 'webdavCryptoPass', 'pinned',
      'urlOpenInBrowser', 'urlOpenBrowser'];
    const LOCAL_PREFIX = ['webdav_', '_'];
    const shared = {};
    for (const k in settings) {
      if (LOCAL_ONLY.includes(k)) continue;
      if (LOCAL_PREFIX.some(p => k.startsWith(p))) continue;
      shared[k] = settings[k];
    }
    return shared;
  }

  /** 上传设置：本机共享键覆盖；云端独有键保留（含显式空串覆盖，便于清密钥）。 */
  function _mergeSharedSettingsUp(localShared, cloudSettings) {
    const out = _extractSharedSettings(cloudSettings || {});
    const local = localShared || {};
    for (const k in local) out[k] = local[k];
    return out;
  }

  async function _prepareNoteBody(note) {
    // 位置跟着新建走：对端还没有这篇时用文件里的 frac 落座（含子笔记「在父笔记下」的位置）。
    // 已有笔记仍由总账覆盖（_webdavApplyNote 保留本地 frac），不把文件当第二套裁判。
    const json = JSON.stringify(note);
    if (_config && _config.encryptNotes) return await notesEncrypt(json);
    return json;
  }
  async function _prepareYbin(note) {
    let ydoc = note && note.ydoc;
    let doc = (note && note.doc) || null;
    if (!ydoc && doc) {
      try {
        const Y = window.__ydoc;
        if (Y && Y.ready && Y.ready()) ydoc = Y.build(doc);
      } catch (_) {}
    }
    // 只有 content(markdown) 的笔记（导入后从未打开）：就地解析成 doc 再建账本一起上传。
    // 否则包里 doc/ydoc 双空，对端收到只有标题的空正文；对端再一改还会反盖掉本机原文（t18 堵洞）。
    // parseMdToDoc + 创世 clientID=0 均确定性——本机日后首开建的账本与这份同根，合并不重复。
    if (!ydoc && !doc && note && (note.content || '').trim()) {
      try {
        const Y = window.__ydoc;
        const p = window.editor && window.editor.parseMdToDoc;
        if (Y && Y.ready && Y.ready() && typeof p === 'function') {
          const d = p(note.content);
          if (d && d.type === 'doc') { doc = d; ydoc = Y.build(d); }
        }
      } catch (_) {}
    }
    // ── C3（t21）：有账本 → 云端只存账本，正文不再重复入包（体积约减半）──────────────
    //   收端 _hydrateYbin 一直是「有账本就从账本重算正文、扔掉包里那份」，故包里的 doc 本来就没人用。
    //   上传前顺手对账：账本还原的正文若与手头正文不一致（极老失修账本），把正文并入**现有**账本
    //   （__ydoc.update 保留历史，绝不重建创世 → 不会与对端账本分家造成重复）后再传。
    //   注意：自愈只改「包里」的账本、不回写本地（上传中 _setNoteYdoc 会再标脏 → 幻影上传循环）；
    //   本地失修账本待该篇下次打开由 _maintainLedger 归正。引擎未就绪则保守带上正文（行为同旧版）。
    if (ydoc && doc) {
      try {
        const Y = window.__ydoc;
        if (Y && Y.ready && Y.ready()) {
          // 规范化比较（经 schema 往返）——账本还原的 JSON 与编辑器 JSON 可能仅键序/默认值形态不同，
          //   语义相同不算失修，防止每次上传都误触自愈。规范化不可用才退回原样比较。
          const a = _canonDocStr(doc), b = _canonDocStr(Y.toDoc(ydoc));
          const mismatch = (a != null && b != null) ? (a !== b) : (JSON.stringify(Y.toDoc(ydoc)) !== JSON.stringify(doc));
          if (mismatch) {
            ydoc = Y.update(ydoc, doc);
            if (!_healWarned[note.id]) { _healWarned[note.id] = 1; console.warn('[webdav] 上传前对账：账本与正文不一致，已把正文并入账本随包自愈', note.id); }
          }
          doc = null; // 云端只存账本
        }
      } catch (_) {}
    }
    const payload = {
      id: note && note.id,
      ydoc: ydoc || '',
      doc,       // C3 后：引擎就绪时恒为 null（云端只存账本）；引擎未就绪保守带上，行为同旧版
      content: (!ydoc && note && note.content) ? note.content : undefined,
      updatedAt: note && note.updatedAt,
    };
    const json = JSON.stringify(payload);
    if (_config && _config.encryptNotes) return await notesEncrypt(json);
    return json;
  }

  /** 规范化正文 JSON（经编辑器 schema 往返）以便语义比较；不可用时返回 null（调用方跳过比较）。 */
  function _canonDocStr(doc) {
    try {
      const ed = window.editor && window.editor.instance && window.editor.instance();
      if (!ed || !ed.schema || !doc) return null;
      return JSON.stringify(ed.schema.nodeFromJSON(doc).toJSON());
    } catch (_) { return null; }
  }
  let _healWarned = Object.create(null); // 上传自愈告警：每篇每会话至多一次，防刷屏

  async function _decodeNoteBody(raw) {
    if (typeof raw === 'string' && _config && _config.encryptNotes) {
      const json = await notesDecrypt(raw);
      return JSON.parse(json);
    }
    return raw;
  }

  function _dataUrlToBlob(dataUrl) {
    const match = dataUrl.match(/^data:image\/([a-z+]+);base64,(.+)$/i);
    if (!match) return { ext: 'bin', binary: new Uint8Array(0) };
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    try {
      return { ext, binary: _base64ToBuf(match[2]) };
    } catch (e) {
      // 坏图（base64 残缺，曾见速记录入被截断的图片）：跳过这一张继续传，绝不拖垮整轮 PUT
      console.warn('[webdav] 图片 base64 损坏，跳过上传:', String(dataUrl).slice(0, 48) + '…', e && e.message);
      return { ext: 'bin', binary: new Uint8Array(0) };
    }
  }

  function _extToMime(ext) {
    const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
    return map[ext] || 'application/octet-stream';
  }

  // ─── 扫描云端恢复 ────────────────────────────────────────────────────────────
  /** 扫描云端 notes/ 目录，找出"云端有、本地（含回收站）都没有、且未被标记删除"的笔记。
   *  返回 { ok, found:[{id,title,updatedAt,size,_note}] } 或 { ok:false, error } */
  async function scanCloudNotes() {
    if (!_config) { const ok = await loadConfig(); if (!ok) return { ok: false, error: '同步未配置' }; }
    try {
      // 三路并行：原先串行 3 次往返（notes 列表 + 图片列表 + manifest），经代理时每多 1 秒都是白等
      const [entries, imgEntries, manifest] = await Promise.all([
        webdavPropfind('notes'),
        webdavPropfind('images').catch(() => []),
        webdavGetJson('manifest.json', { allow404: true }),
      ]);
      const deleted = (manifest && manifest.deleted) || {};
      const data = window.storage.getAll();
      // 标题/层级来源（t23 修）：v4 起清单只记版本号、v5 正文包也无 title 字段，
      //   真身在结构总账——本地笔记直接读，本地没有的查本机结构总账（结构总在正文之前同步到）。
      //   两处都查不到的才留给逐篇读正文兜底（只对老 .json 包有效）。
      let led = null;
      try {
        const W = window.__wsdoc;
        const b64 = window.storage._webdavGetStructLedger && window.storage._webdavGetStructLedger();
        if (W && W.ready && W.ready() && b64) led = W.toData(b64);
      } catch (_) { led = null; }
      const _metaOf = (id) => {
        const ln = data.notes && data.notes[id];
        if (ln) return { title: ln.title || '', parentId: ln.parentId == null ? null : ln.parentId };
        const tn = data.trash && data.trash[id];
        if (tn) return { title: tn.title || '', parentId: tn.parentId == null ? null : tn.parentId };
        const le = led && ((led.notes && led.notes[id]) || (led.trash && led.trash[id]));
        if (le) return { title: le.title || '', parentId: le.parentId == null ? null : le.parentId };
        return null;
      };
      const found = [];   // 仅"本地缺失且未删除"——可恢复
      const all = [];     // 云端全部笔记（带状态），供"查看全部"用
      const seen = new Set();
      let totalSize = 0;
      for (const e of entries) {
        if (!e.href || /\/$/.test(e.href)) continue;
        let name = e.href;
        try { name = decodeURIComponent(name); } catch (_) {}
        name = name.replace(/[#?].*$/, '');
        name = name.substring(name.lastIndexOf('/') + 1);
        if (!/\.(json|ybin)$/i.test(name)) continue;
        const id = name.replace(/\.(json|ybin)$/i, '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        totalSize += (e.size || 0);
        let mtime = '';
        if (e.mtime) { const d = new Date(e.mtime); if (!isNaN(d.getTime())) mtime = d.toISOString(); }
        let status = 'missing';
        if (data.notes && data.notes[id]) status = 'local';        // 本地已有
        else if (data.trash && data.trash[id]) status = 'trash';   // 回收站已有
        else if (deleted[id]) status = 'deleted';                  // 墓碑（已删除记录）
        // 老清单（<v4）还随清单带 title/parentId，先取；新云端走 _metaOf（本地/结构总账）
        const meta = (manifest && manifest.notes && manifest.notes[id]) || null;
        const hasTitleMeta = !!(meta && typeof meta.title === 'string');
        const m = hasTitleMeta ? { title: meta.title, parentId: ('parentId' in meta) ? meta.parentId : null } : _metaOf(id);
        const item = {
          id,
          title: (m && m.title) || '',
          parentId: m ? m.parentId : null,
          updatedAt: mtime, size: e.size, _note: null,
          _titleLoaded: !!m, status,
        };
        all.push(item);
        if (status === 'missing') found.push(item); // 同一对象引用，两个视图共享
      }
      const byTime = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
      found.sort(byTime);
      all.sort(byTime);
      // 图片占用统计
      let imageSize = 0, imageCount = 0;
      for (const e of imgEntries) {
        if (!e.href || /\/$/.test(e.href)) continue;
        let nm = e.href;
        try { nm = decodeURIComponent(nm); } catch (_) {}
        nm = nm.replace(/[#?].*$/, '');
        nm = nm.substring(nm.lastIndexOf('/') + 1);
        if (!nm) continue;
        imageSize += (e.size || 0);
        imageCount++;
      }
      const summary = {
        cloudNotes: seen.size,
        cloudSize: totalSize,
        imageCount,
        imageSize,
        tombstones: Object.keys(deleted).length,
        manifestUpdatedAt: (manifest && manifest.updatedAt) || 0,
        localNotes: data.notes ? Object.keys(data.notes).length : 0,
        missing: found.length,
      };
      return { ok: true, found, all, summary };
    } catch (e) {
      if (e instanceof RateLimitError) return { ok: false, error: '服务器限流，请稍后重试' };
      if (e && e.name === 'AbortError') return { ok: false, error: '连接超时（20 秒），请检查网络或代理是否可用' };
      return { ok: false, error: e.message };
    }
  }

  /** 按需逐篇读取标题（节流，命中限流即停，保留已读到的）。
   *  onEach(item) 在每篇成功后回调以更新 UI；返回 { loaded, stopped } */
  async function loadCloudTitles(items, onEach) {
    if (!_config || !Array.isArray(items)) return { loaded: 0, stopped: false };
    const todo = items.filter(it => it && !it._titleLoaded);
    if (!todo.length) return { loaded: 0, stopped: false };
    let loaded = 0;
    const { errors } = await _runPool(todo, async (it) => {
      const note = await _fetchNoteById(it.id);
      it._titleLoaded = true;
      if (note && typeof note === 'object') {
        it._note = note;
        it.title = (note.title || '').trim();
        if (!it.updatedAt) it.updatedAt = note.updatedAt || note.createdAt || '';
        loaded++;
        if (typeof onEach === 'function') { try { onEach(it); } catch (_) {} }
      }
    });
    const rl = errors.find(e => e.error instanceof RateLimitError);
    if (rl) return { loaded, stopped: true };
    return { loaded, stopped: false };
  }

  // ─── 云端清扫（E1；t22 上线，t23 改全自动静默）────────────────────────────────
  // 清掉 notes/ 目录里 v5 搬家前残留的按篇旧格式文件 <id>.json：
  //   - 同 id 已有 .ybin（搬家已重传）或 id 是墓碑 → 旧文件纯属残留，直接删；
  //   - 仅剩 .json 的活笔记 → 先读云端这份 → 转打成 .ybin 上传 → 再删 .json（先立新再拆旧，中途断了也不丢）；
  //   - 读不出的（口令不一致/文件损坏）一律跳过不删，绝不冒险。
  // 只动 notes/ 目录；trash/<id>.json 是回收站现行格式，不算残留。
  // 自动路径：每次同步成功后 _autoSweepTick 悄悄清一小口（限流友好），进度记一本账 sweep 字段；
  //   清完记 done=1，此后零开销。换账号自动重头扫（_acct 随账号重建）。
  const SWEEP_CHUNK = 30;                 // 每口最多处理的文件数（每个 1~3 个请求）
  const SWEEP_TICK_GAP_MS = 5 * 60_000;   // 两口之间至少间隔
  let _sweepBusy = false;

  /** 列目录建残留清单：返回 [{i:id, y:是否已有新格式}]；无残留返回 []。 */
  async function _sweepScan() {
    const entries = await webdavPropfind('notes');
    const jsonIds = new Set(), ybinIds = new Set();
    for (const e of entries) {
      if (!e.href || /\/$/.test(e.href)) continue;
      let name = e.href;
      try { name = decodeURIComponent(name); } catch (_) {}
      name = name.replace(/[#?].*$/, '');
      name = name.substring(name.lastIndexOf('/') + 1);
      if (name === 'manifest.json' || name === 'manifest.json.tmp') continue;
      if (/\.ybin$/i.test(name)) ybinIds.add(name.replace(/\.ybin$/i, ''));
      else if (/\.json$/i.test(name)) jsonIds.add(name.replace(/\.json$/i, ''));
    }
    return [...jsonIds].map((id) => ({ i: id, y: ybinIds.has(id) ? 1 : 0 }));
  }

  /** 处理清单前 limit 项（就地从 items 移除已处理项）。返回 { removed, converted, skipped, rateLimited }。 */
  async function _sweepProcess(items, limit, onProgress, progressBase, progressTotal) {
    let manifest = null;
    try { manifest = await webdavGetJson('manifest.json', { allow404: true }); } catch (_) {}
    const deleted = (manifest && manifest.deleted) || {};
    let removed = 0, converted = 0, skipped = 0;
    for (let n = 0; n < limit && items.length; n++) {
      const it = items[0];
      if (typeof onProgress === 'function') { try { onProgress(progressBase + n + 1, progressTotal); } catch (_) {} }
      try {
        if (!it.y && !deleted[it.i]) {
          // 活笔记只剩旧格式文件：以云端这份为准转成新格式（不掺本地状态，避免盖掉云端较新内容）
          const note = await webdavGetNote('notes/' + it.i + '.json', { allow404: true });
          if (!note) { items.shift(); removed++; continue; } // 文件已不在，视作清完
          await webdavPut('notes/' + it.i + '.ybin', await _prepareYbin(note));
          _setHint(it.i, 'y', (manifest && manifest.notes && manifest.notes[it.i] && manifest.notes[it.i].v) || 0);
          converted++;
        }
        await webdavDelete('notes/' + it.i + '.json');
        items.shift();
        removed++;
      } catch (e) {
        if (e instanceof RateLimitError) return { removed, converted, skipped, rateLimited: true };
        items.shift();
        skipped++; // 解不开/写失败：留在云端不删（本轮不再重试，避免死循环）
      }
    }
    return { removed, converted, skipped, rateLimited: false };
  }

  /** 自动清扫：每次同步成功后被叫一下，静默清一小口。全部完成后 done=1 永不再扫。 */
  async function _autoSweepTick() {
    if (_sweepBusy || _stopped || !_config || _paused || _syncing) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (!navigator.onLine) return;
    const led = _ledger();
    if (!led.account) return;
    const sw = led.sweep;
    if (sw && sw.done) return;
    if (sw && Date.now() - (sw.at || 0) < SWEEP_TICK_GAP_MS) return;
    _sweepBusy = true;
    try {
      const s = led.sweep || (led.sweep = { removed: 0, converted: 0, skipped: 0 });
      s.at = Date.now();
      if (!Array.isArray(s.pend)) {
        s.pend = await _sweepScan();
        if (!s.pend.length) {
          s.done = 1; s.pend = null; _saveLedger();
          console.log('[webdav] 云端无旧格式残留，清扫收官');
          return;
        }
        console.log('[webdav] 云端旧格式残留 ' + s.pend.length + ' 个，开始后台分批清扫');
      }
      _saveLedger();
      const r = await _sweepProcess(s.pend, SWEEP_CHUNK);
      s.removed += r.removed; s.converted += r.converted; s.skipped += r.skipped;
      if (!s.pend.length) {
        s.done = 1; s.pend = null;
        console.log('[webdav] 云端清扫完成：删旧文件 ' + s.removed + '，其中转新格式 ' + s.converted + '，跳过 ' + s.skipped);
      }
      _saveLedger();
    } catch (e) {
      console.warn('[webdav] 自动清扫本口失败（下口再试）', e && e.message);
      _saveLedger();
    } finally {
      _sweepBusy = false;
    }
  }

  /** 手动/调试入口：一口气扫到完（自动路径见 _autoSweepTick）。返回 { ok, total, removed, converted, skipped, partial? }。 */
  async function sweepLegacyCloudFiles(onProgress) {
    if (!_config) return { ok: false, error: '同步未配置' };
    let items;
    try { items = await _sweepScan(); }
    catch (e) { return { ok: false, error: '无法列出云端笔记目录：' + (e.message || e) }; }
    const total = items.length;
    if (!total) {
      const led = _ledger();
      if (led.account) { led.sweep = { done: 1, removed: 0, converted: 0, skipped: 0 }; _saveLedger(); }
      return { ok: true, total: 0, removed: 0, converted: 0, skipped: 0 };
    }
    let removed = 0, converted = 0, skipped = 0;
    while (items.length) {
      const r = await _sweepProcess(items, items.length, onProgress, total - items.length, total);
      removed += r.removed; converted += r.converted; skipped += r.skipped;
      if (r.rateLimited) {
        return { ok: true, partial: true, total, removed, converted, skipped, error: '服务器限流，本次清扫了一部分，稍后自动继续' };
      }
    }
    const led = _ledger();
    if (led.account) { led.sweep = { done: 1, removed, converted, skipped }; _saveLedger(); }
    return { ok: true, total, removed, converted, skipped };
  }

  /** 把选中的云端笔记写回本地，并触发结构自愈 + 上传同步，返回成功条数 */
  async function recoverCloudNotes(items, onProgress) {
    if (!_config || !Array.isArray(items) || !items.length) return 0;
    const total = items.length;
    let done = 0;
    let n = 0;
    let limited = false;
    for (const it of items) {
      let note = it && it._note; // 若已通过"读取标题"缓存内容，则直接复用，省一次请求
      if (!note && it) {
        try {
          note = await _fetchNoteById(it.id);
        } catch (e) {
          if (e instanceof RateLimitError) { limited = true; break; } // 命中限流即停，保留已恢复的
          done++; if (typeof onProgress === 'function') { try { onProgress(done, total); } catch (_) {} }
          continue;
        }
      }
      done++;
      if (note && typeof note === 'object') {
        note.id = it.id;
        window.storage._webdavApplyNote(it.id, note);
        n++;
      }
      if (typeof onProgress === 'function') { try { onProgress(done, total); } catch (_) {} }
    }
    if (n > 0) {
      // 复用空的 _webdavApplyGlobal：触发结构自愈（把恢复的笔记接回 rootOrder/笔记本）+ 落盘 + 通知 UI 重渲
      window.storage._webdavApplyGlobal({});
      schedulePut('recover-cloud-notes');
    }
    if (limited) console.warn('[webdav] 恢复时命中限流，已恢复 ' + n + ' 篇后停止，请稍后再试剩余的');
    return n;
  }

  /** 永久删除云端笔记文件，并在 manifest 里记墓碑（防止重新出现 / 跨设备同步删除），返回成功删除的 id 数组 */
  async function deleteCloudNotes(items, onProgress) {
    if (!_config || !Array.isArray(items) || !items.length) return [];
    // 与后台同步互斥：这里要读改写 manifest，若与 doPut 并发会互相覆盖对方刚写入的内容
    if (_syncing) await _waitSyncDone();
    _syncing = true;
    try {
      return await _deleteCloudNotesInner(items, onProgress);
    } finally {
      _syncing = false;
      _drainPending();
    }
  }

  async function _deleteCloudNotesInner(items, onProgress) {
    let manifest = null;
    try { manifest = await webdavGetJson('manifest.json', { allow404: true }); } catch (_) {}
    // ⚠️ 必须是毫秒数字：墓碑时间戳全引擎统一用 Date.now()。
    // 之前误用 ISO 字符串，导致其他设备应用墓碑时 "字符串 > 数字" 恒为 false——
    // 云端管理里删掉的笔记别的设备永远删不掉、还会被重新上传复活；30 天墓碑清理也失效。
    const now = Date.now();
    const deletedIds = [];
    const total = items.length;
    let done = 0;
    for (const it of items) {
      const id = it && it.id;
      if (!id) { done++; continue; }
      try {
        try { await webdavDelete(`notes/${id}.ybin`); } catch (_) {}
        await webdavDelete(`notes/${id}.json`);
        deletedIds.push(id);
        if (manifest) {
          if (manifest.notes) delete manifest.notes[id];
          if (Array.isArray(manifest.rootOrder)) manifest.rootOrder = manifest.rootOrder.filter(x => x !== id);
          if (Array.isArray(manifest.trashOrder)) manifest.trashOrder = manifest.trashOrder.filter(x => x !== id);
          manifest.deleted = manifest.deleted || {};
          manifest.deleted[id] = now;
        }
      } catch (_) { /* 单条失败跳过，不阻断其余 */ }
      done++;
      if (typeof onProgress === 'function') { try { onProgress(done, total); } catch (_) {} }
    }
    if (deletedIds.length && manifest) {
      manifest.updatedAt = now;
      try { await _putManifestVerified(manifest); } catch (_) {}
    }
    return deletedIds;
  }

  /** 把本地已知笔记的标题/层级补写进云端 manifest（仅 1 次 GET + 1 次 PUT，不重传笔记正文）。
   *  用于「管理云端笔记」打开前补全旧数据的标题与父子关系。返回 { ok, updated } 或 { ok:false, error } */
  async function enrichCloudManifest() {
    if (!_config) { const ok = await loadConfig(); if (!ok) return { ok: false, error: '同步未配置' }; }
    // 与后台同步互斥：读改写 manifest，避免与 doPut 竞态互相覆盖
    if (_syncing) await _waitSyncDone();
    _syncing = true;
    try {
      const manifest = await webdavGetJson('manifest.json', { allow404: true });
      if (!manifest || !manifest.notes) return { ok: true, updated: 0 };
      if ((manifest.dataFormatVersion || 1) >= 4) return { ok: true, updated: 0 };
      const data = window.storage.getAll();
      let updated = 0;
      for (const id in manifest.notes) {
        const ln = data.notes && data.notes[id];
        if (!ln) continue;
        const title = ln.title || '';
        const parentId = ln.parentId == null ? null : ln.parentId;
        const m = manifest.notes[id];
        if (m.title !== title || m.parentId !== parentId) {
          m.title = title;
          m.parentId = parentId;
          updated++;
        }
      }
      if (updated > 0) {
        manifest.updatedAt = Date.now(); // 统一毫秒数字，绝不能写 ISO 字符串
        await _putManifestVerified(manifest);
      }
      return { ok: true, updated };
    } catch (e) {
      if (e instanceof RateLimitError) return { ok: false, error: '服务器限流（503），请稍后重试' };
      return { ok: false, error: e.message };
    } finally {
      _syncing = false;
      _drainPending();
    }
  }

  /** 用本地内容覆盖云端（镜像）：删除云端上"本地已没有"的笔记文件 + 孤儿文件，
   *  然后把本地全部上传。⚠️ 破坏性，适合"覆盖导入/单设备恢复"后让云端与本地一致。
   *  返回 { ok, removed } 或 { ok:false, error } */
  async function mirrorLocalToCloud(opts) {
    const dryRun = !!(opts && opts.dryRun);
    if (!_config) { const ok = await loadConfig(); if (!ok) return { ok: false, error: '同步未配置' }; }
    // 镜像覆盖是用户主动发起的修复动作，允许在 stop() 之后、startAutoSync 之前执行
    // （切换/改口令流程先完成重加密再启动自动同步，避免轮询用新口令拉旧口令云端而误报）
    _stopped = false;
    // 权威覆盖期间：让即时层暂不接收对端「结构/整篇」直推，堵死「落后设备把旧结构回灌、删掉刚恢复笔记」的空窗。
    if (!dryRun) { try { window.realtime && window.realtime.beginAuthoritativeReset && window.realtime.beginAuthoritativeReset(); } catch (_) {} }
    try {
      if (_syncing) await _waitSyncDone();
      if (!dryRun) {
        _beginUiBusy(true);
        _emit('cloud-sync', { type: 'webdav-sync-start', detail: 'mirror', heavy: true });
      }
      const data = window.storage.getAll();
      const liveIds = new Set([
        ...Object.keys(data.notes || {}),
        ...Object.keys(data.trash || {}),
      ]);
      // 先算出云端「本地已没有」的多余 id 集合（去重计数，不立即删除）
      const extra = new Set();
      _syncing = true;
      let manifest;
      try {
        manifest = await webdavGetJson('manifest.json', { allow404: true });
        manifest = manifest || _createEmptyManifest();
        manifest.deleted = manifest.deleted || {};

        for (const id of Object.keys(manifest.notes || {})) {
          if (!liveIds.has(id)) extra.add(id);
        }
        for (const id of Object.keys(manifest.trash || {})) {
          if (!liveIds.has(id)) extra.add(id);
        }
        // 云端目录里残留、manifest 都没记录的孤儿文件（PROPFIND 一次）
        try {
          const entries = await webdavPropfind('notes');
          for (const e of entries) {
            if (!e.href || /\/$/.test(e.href)) continue;
            let name = e.href; try { name = decodeURIComponent(name); } catch (_) {}
            name = name.replace(/[#?].*$/, '');
            name = name.substring(name.lastIndexOf('/') + 1);
            if (!/\.(json|ybin)$/i.test(name)) continue; // 曾只认 .json，v5 后 .ybin 孤儿漏删（t22 修）
            const id = name.replace(/\.(json|ybin)$/i, '');
            if (id && !liveIds.has(id)) extra.add(id);
          }
        } catch (_) { /* PROPFIND 失败不阻断主流程 */ }
      } finally {
        _syncing = false;
      }

      // dry-run：只回报多余数量，不做任何删除/上传
      if (dryRun) return { ok: true, extra: extra.size };

      let removed = 0;
      _syncing = true;
      try {
        const now = Date.now();
        await _runPool([...extra], async (id) => {
          try { await webdavDelete(`notes/${id}.ybin`); } catch (_) {}
          try { await webdavDelete(`notes/${id}.json`); } catch (_) {}
          try { await webdavDelete(`trash/${id}.json`); } catch (_) {}
          if (manifest.notes) delete manifest.notes[id];
          if (manifest.trash) delete manifest.trash[id];
          manifest.deleted[id] = now;
          removed++;
        });
        // 权威覆盖：epoch +1，宣告"本设备此刻的全集为权威"。其它设备下次同步会进入采纳模式对齐。
        manifest.epoch = (manifest.epoch || 1) + 1;
        manifest.updatedAt = now;
        manifest.deviceId = _ensureClientId();
        if (!manifest.version) manifest.version = 2;
        // 若清单仍内嵌总账，先外置再写瘦清单（完整总账由随后 doPut freshLedger 覆盖）
        try { await _persistStructLedgerExternal(manifest, null, { migrateEmbed: true }); } catch (_) {}
        await _putManifestVerified(manifest);
        _rememberManifestCursor(manifest);
        _setAdoptedEpoch(manifest.epoch); // 本机就是权威发起方，对齐到新世代，避免自己又去"采纳"
        // 覆盖云端 = 从零重传全部：覆盖前的「已传未交 / 名单回执」旧账作废
        _clearPendingVers();
        _savePendingCatalogConfirm(null);
      } finally {
        _syncing = false;
      }

      // 把本地全部标脏并上传，确保云端拿到本地完整内容。
      // strict：上传失败必须上抛——否则 doPut 内部吞掉错误后这里会误报 ok，用户以为覆盖成功
      _decMismatch = false; // 镜像覆盖 = 用当前口令整体重新加密云端，正是"口令不一致"的修复动作，解除上传闸
      _decFailRounds = 0;
      if (window.storage.markAllNotesDirty) window.storage.markAllNotesDirty();
      // 权威覆盖：用本地实际内容重建一份零删除标记的结构总账，doPut 以「替换」方式推云
      //   （否则云端旧删除标记会在下次同步把恢复的笔记删掉——覆盖恢复丢笔记的根治点）。
      try { if (window.storage._webdavRebuildStructLedgerFresh) window.storage._webdavRebuildStructLedgerFresh(); } catch (_) {}
      await doPut({ force: true, strict: true, freshLedger: true });
      return { ok: true, removed };
    } catch (e) {
      _syncing = false;
      if (e instanceof RateLimitError) return { ok: false, error: '服务器限流（503），请稍后重试' };
      return { ok: false, error: e.message };
    } finally {
      if (!dryRun) { try { window.realtime && window.realtime.endAuthoritativeReset && window.realtime.endAuthoritativeReset(); } catch (_) {} }
    }
  }

  /** 修复云端清单（一键）：轻量重建索引，不重传全部笔记正文。
   *  权威=云端 notes/ 文件列表 + 时间戳只升不降；详规 docs/清单损坏与修复.md */
  async function repairManifest() {
    if (!_config) { const ok = await loadConfig(); if (!ok) return { ok: false, error: '同步未配置' }; }
    if (_syncing) await _waitSyncDone();
    _syncing = true;
    try {
      const res = await _repairManifestLight({ auto: false });
      if (res.ok) {
        _transientFailStreak = 0;
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'repair-manifest' });
      }
      return res;
    } catch (e) {
      if (e instanceof RateLimitError) return { ok: false, error: '服务器限流（503），请稍后重试' };
      return { ok: false, error: e.message };
    } finally {
      _syncing = false;
      _drainPending();
    }
  }

  // ─── 公共 API ───────────────────────────────────────────────────────────────
  window.webdavSync = {
    testConnection,
    probeCloudState,
    checkCloudKey,
    resolveProxy,
    resolveRelay,
    rtRoomId,
    rtEncrypt,
    rtDecrypt,
    loadConfig,
    startAutoSync,
    stop,
    schedulePut,
    flushPutOnBlur,
    flushPutOnHide,
    flushIndex,
    doGet,
    doPut,
    manualSync,
    wakeGet: _wakeGet,
    scanCloudNotes,
    loadCloudTitles,
    recoverCloudNotes,
    sweepLegacyCloudFiles,
    deleteCloudNotes,
    enrichCloudManifest,
    mirrorLocalToCloud,
    repairManifest,
    downloadImage,
    aesEncrypt,
    aesDecrypt,
    notesEncrypt,
    notesDecrypt,

    listLocalBackups,
    restoreLocalBackup,
    clearLocalBackups,
    backupBeforeOverwrite: _backupBeforeOverwrite, // 供 storage 总账落地永久删除前留底
    getAdoptedEpoch: _getAdoptedEpoch, // 供即时层「结构入口世代闸」判定对端是否落后（null=本账号首次未记录）

    // 测试探针（C3 / 久闲闸本机测试用，业务代码勿用）
    _prepareYbin, _hydrateYbin,
    _evalStaleGate, _hasLocalLibrary, _scrubStaleDirtyAgainstManifest,
    isStaleGate: () => !!_staleGate,

    isSyncing: () => _syncing,
    isUiSyncing: () => !!_uiSyncing,
    isUiHeavy: () => !!_uiHeavy,
    isBusy: () => !!_syncing,
    isPaused: () => _paused,
    getClientId: () => _ensureClientId(),
    getPendingImageDownloads: () => [..._pendingImageDownloads],
  };

})();
