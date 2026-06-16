(function () {
  'use strict';

  // ─── 配置 ────────────────────────────────────────────────────────────────────
  const FETCH_TIMEOUT_MS = 20_000;
  const PUT_DEBOUNCE_MS = 2_000;
  const BLUR_PUT_COOLDOWN_MS = 5_000;
  const GET_COOLDOWN_MS = 5_000;
  const SILENCE_TIMEOUT_MS = 2 * 60_000;
  // 墓碑保留期：原 30 天太短——陈旧/离线设备久违回来时墓碑已被清，"本地有/云端无"会被误判为
  // "本地新建"而复活上传（曾发生）。墓碑仅 {id:ts} 极小，延长到 1 年几乎不占空间，大幅压缩复活窗口。
  // 与 _detectLocallyNewerNotes 的基准判断配合（墓碑过期后由基准兜底，绝不复活）。
  const DELETED_RETENTION_MS = 365 * 24 * 60 * 60_000;
  const BASE_DIR = 'ZhiNote';

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
  let _paused = false;
  let _pauseResumeTimer = null;
  let _backoffMs = 30_000;
  let _started = false;
  let _stopped = false;
  let _pendingPut = false;
  let _pendingGet = false;
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

  // 上传最小间隔 / 轮询间隔也按服务商差异化：坚果云频控严（官方约 30 分钟 600 次）取保守值；
  // Koofr 等普通服务商放宽，缩短"编辑 → 其它设备看到"的端到端延迟。
  let _putMinIntervalMs = 5_000;
  let _pollIntervalMs = 10_000;

  function _applyProviderTuning(provider) {
    if (provider === 'jianguoyun') {
      _maxConcurrency = 4; _pacingMs = 100;
      _putMinIntervalMs = 30_000; _pollIntervalMs = 30_000;
    } else {
      _maxConcurrency = 6; _pacingMs = 0;
      _putMinIntervalMs = 5_000; _pollIntervalMs = 10_000;
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
    const timeoutMs = Math.min(120_000, FETCH_TIMEOUT_MS + Math.floor(bodyBytes / 50));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // credentials:'omit' 关键：阻止浏览器在收到 401 时弹出原生"登录以访问此站点"对话框，
    // 让 401 直接作为响应交回脚本，由我们自己处理（我们已手动带 Authorization 头）。
    return fetch(url, { ...options, credentials: 'omit', signal: controller.signal })
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

  function _buildUrl(path) {
    if (!_config) throw new Error('WebDAV 未配置');
    let base = _config.url.replace(/\/+$/, '');
    const fullPath = `${BASE_DIR}/${path}`.replace(/\/+/g, '/');
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
    return webdavGetJson('manifest.json', { allow404: true });
  }

  /**
   * 写 manifest.json 并立即读回校验（防 0 字节/截断）。
   * manifest 是同步的"总账本"，一旦在云端变成空文件，所有设备读取都会失败、同步卡死
   * （Koofr 实际发生过：PUT 被中断后留下 0 字节文件）。
   * 校验只要求"非空且是合法 JSON"——读回内容可能已被别的设备更新，不做逐字节比对。
   * 重传一次仍失败则抛错（不标 transient），让上层如实显示"同步出错"。
   */
  async function _putManifestVerified(manifest, ifMatch) {
    const body = JSON.stringify(manifest, null, 2);
    // CAS：带 If-Match 原子写。被抢先（412）时 webdavPut 抛 PreconditionFailedError，
    // 直接穿出本函数（不在下方 try 内、不重试）——由 doPut 重新读取合并后再试，绝不盲覆盖。
    const extraHeaders = ifMatch ? { 'If-Match': ifMatch } : null;
    let lastDetail = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      await webdavPut('manifest.json', body, 'application/json; charset=utf-8', extraHeaders);
      try {
        const resp = await webdavGet('manifest.json');
        const text = resp ? await resp.text() : '';
        if (text && text.trim()) {
          const rb = JSON.parse(text); // 仍校验为合法 JSON（防 0 字节/截断）
          // 读回正是本机刚写入的版本（间隙无人抢写）→ 记下其 ETag，供下次轮询发 If-None-Match 命中 304；
          // 若读回已是别的设备的更新 → 不记，保持旧 etag，下一轮会照常拉到对方变更，绝不漏。
          if (rb && rb.updatedAt === manifest.updatedAt && rb.deviceId === manifest.deviceId) {
            const et = resp.headers.get('ETag') || resp.headers.get('etag') || '';
            _lastManifestEtag = (et && !et.startsWith('W/')) ? et : '';
          }
          return;
        }
        lastDetail = '读回为空文件';
      } catch (e) {
        lastDetail = e.message || String(e);
      }
      console.warn(`[webdav] manifest 写入校验未通过（${lastDetail}），重传 #${attempt + 1}`);
      await sleep(500);
    }
    throw new Error(`云端清单（manifest.json）写入校验失败：${lastDetail}。本次上传未生效，已保留本地改动，稍后会自动重试`);
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
          if (!/\.json$/i.test(name)) continue;
          const id = name.replace(/\.json$/i, '');
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
            const resp = await webdavGet(`notes/${id}.json`, { allow404: true });
            if (!resp) continue;
            const text = (await resp.text()).trim();
            if (!text || text.startsWith('<')) continue;   // 限流/拦截页：换一篇
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
          const resp = await webdavGet(`notes/${id}.json`, { allow404: true });
          if (!resp) continue;
          const text = (await resp.text()).trim();
          if (!text || text.startsWith('<')) continue;  // 限流/拦截页：换一篇
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
    const binary = atob(b64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return buf;
  }

  // ─── clientId 管理 ──────────────────────────────────────────────────────────
  function _ensureClientId() {
    if (_clientId) return _clientId;
    const key = 'zhinote-webdav-clientId';
    _clientId = localStorage.getItem(key);
    if (!_clientId) {
      _clientId = 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(key, _clientId);
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
  function _loadSyncBase() {
    if (_syncBase) return _syncBase;
    _syncBase = {};
    try {
      const raw = localStorage.getItem(SYNC_BASE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        // 账号不一致（切换了服务商/账号）→ 丢弃旧基准，从零开始（安全：退回时间戳逻辑）
        if (obj && obj.account === _accountTag() && obj.map) _syncBase = obj.map;
      }
    } catch (_) {}
    return _syncBase;
  }
  function _flushSyncBase() {
    if (!_syncBaseDirty) return;
    _syncBaseDirty = false;
    try { localStorage.setItem(SYNC_BASE_KEY, JSON.stringify({ account: _accountTag(), map: _syncBase || {} })); } catch (_) {}
  }
  function _getBase(id) { return _loadSyncBase()[id] || null; }
  function _setBase(id, hash, ts) { _loadSyncBase(); _syncBase[id] = { h: hash, t: ts || 0 }; _syncBaseDirty = true; }
  function _delBase(id) { _loadSyncBase(); if (_syncBase[id]) { delete _syncBase[id]; _syncBaseDirty = true; } }

  // ─── epoch 权威世代（authoritative snapshot）────────────────────────────────
  // manifest.epoch 是"权威世代号"。「覆盖云端」会 +1 并写权威全集；
  // 其它已初始化设备发现 remoteEpoch > 本地 adoptedEpoch 时进入「采纳模式」：
  // 以云端为准，本地不在权威清单里的笔记 → 留底后移除、且本次不反向上传，
  // 从根上避免「旧设备把本地多余笔记涌回云端 / 全挤进一个本子」。
  // adoptedEpoch 按账号隔离持久化；首次遇到某账号时不采纳（只记录），仅当世代真正跳变才采纳。
  const ADOPTED_EPOCH_KEY = 'zhinote-webdav-epoch';
  function _getAdoptedEpoch() {
    try {
      const raw = localStorage.getItem(ADOPTED_EPOCH_KEY);
      if (raw) { const o = JSON.parse(raw); if (o && o.account === _accountTag() && typeof o.epoch === 'number') return o.epoch; }
    } catch (_) {}
    return null; // null = 本账号从未记录过（首次遇到）
  }
  function _setAdoptedEpoch(epoch) {
    try { localStorage.setItem(ADOPTED_EPOCH_KEY, JSON.stringify({ account: _accountTag(), epoch: epoch || 1 })); } catch (_) {}
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
  // 笔记内容指纹：标题 + 正文，归一化掉行尾空格/行尾空行/换行符差异，避免序列化抖动误判
  function _noteHash(note) {
    if (!note) return '';
    const t = note.title || '';
    // doc 为事实来源时用其稳定 JSON 串做指纹（getJSON/JSON.parse 往返键序稳定、跨设备一致）。
    // ⚠️ 必须含 doc：否则迁移删 content 后所有笔记退化成"仅标题"指纹 →
    //    编辑正文不改变指纹、不同笔记同标题撞车 → 同步冲突检测/留底全部失效。
    let c;
    if (note.doc) {
      try { c = JSON.stringify(note.doc); } catch (_) { c = ''; }
    } else {
      c = (note.content || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
    }
    return _strHash(t + '\u0000' + c);
  }

  // ─── 数据格式版本闸（dataFormatVersion）────────────────────────────────────────
  // 本客户端支持的最高数据格式版本。v2 = 笔记内容 JSON 化（note.doc）。
  // 云端 manifest.dataFormatVersion 高于此值 → 说明有更新的客户端升级了云端格式，
  // 本（旧）客户端必须停止同步并提示更新，绝不下载/上传，以免污染或丢失新格式数据。
  const SUPPORTED_DATA_FORMAT = 2;
  function _localDataFormat() {
    try { return (window.storage.getDataFormatVersion && window.storage.getDataFormatVersion()) || 1; }
    catch (_) { return 1; }
  }
  function _remoteFormatTooNew(manifest) {
    return !!manifest && (manifest.dataFormatVersion || 1) > SUPPORTED_DATA_FORMAT;
  }

  // ─── 覆盖前留底（终极兜底）────────────────────────────────────────────────────
  // 任何"用远端覆盖/删除本地笔记"的动作之前，先把本地旧内容存进本地留底区。
  // 即使冲突判断有 bug 误覆盖，被覆盖的内容也 100% 可从这里找回 —— 数据物理上不丢。
  const BACKUP_KEY = 'zhinote-overwrite-backup';
  const BACKUP_MAX_ENTRIES = 40;
  const BACKUP_MAX_BYTES = 1_500_000;

  function _readBackups() {
    try { const raw = localStorage.getItem(BACKUP_KEY); return raw ? JSON.parse(raw) : []; }
    catch (_) { return []; }
  }
  function _writeBackups(list) {
    // 先按条数截断，再按总体积截断（都保留最新的，丢最旧的）
    let arr = list.slice(0, BACKUP_MAX_ENTRIES);
    while (arr.length > 1 && JSON.stringify(arr).length > BACKUP_MAX_BYTES) arr.pop();
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify(arr)); } catch (_) {}
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
      window.storage._webdavApplyNote(newId, note);
      const d = window.storage.getAll();
      if (d.rootOrder && !d.rootOrder.includes(newId)) d.rootOrder.push(newId);
      if (window.storage.markNotesDirtyByIds) window.storage.markNotesDirtyByIds([newId]);
      window.storage.save({ immediate: true });
      return newId;
    } catch (e) { console.warn('[webdav] 还原留底失败', e); return null; }
  }
  function clearLocalBackups() { try { localStorage.removeItem(BACKUP_KEY); } catch (_) {} }

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
    // 重载配置（含改口令后）即解除"口令不一致"上传闸，让新口令重新接受 doGet 检验
    _decMismatch = false;
    _decFailRounds = 0;
    _skipBadNotes = {}; // 换口令/重载配置后僵尸名单作废，全部重试一遍
    return true;
  }

  // ─── 事件发射 ────────────────────────────────────────────────────────────────
  function _emit(event, payload) {
    if (window.storage && window.storage._emitCloudSync) {
      window.storage._emitCloudSync(payload);
    }
  }

  // 远端 manifest 是否真的带来了本地需要下载的变更（新增 / 更新的笔记）。
  // 用于决定是否需要弹"检测到其他设备更新"的保护条——避免内容早已同步过却仍误报。
  function _hasIncomingChanges(manifest) {
    if (!manifest || !manifest.notes) return false;
    const data = window.storage.getAll();
    const trash = data.trash || {};
    for (const id in manifest.notes) {
      if (manifest.deleted && manifest.deleted[id]) continue; // 云端墓碑：不会下载
      const remoteTs = manifest.notes[id].updatedAt || 0;
      if (_isKnownBadNote(id, remoteTs)) continue; // 僵尸笔记反正下载不了，不算"有新内容"
      const localNote = data.notes[id];
      if (!localNote) {
        if (!trash[id]) return true; // 云端有、本地没有（也不在回收站）→ 会下载
        continue;
      }
      const localTs = new Date(localNote.updatedAt || 0).getTime();
      if (remoteTs > localTs + 1000) return true; // 云端更新 → 会下载
    }
    return false;
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

  function _handleTransient(e, kind, retryFn) {
    // 断网期间失败是预期行为：不计熔断、不报错。恢复时 online 事件会强拉一次并 drain 待传数据。
    if (!navigator.onLine) {
      _transientFailStreak = 0;
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'retry-transient', silent: true });
      console.warn(`[webdav] ${kind}失败但当前离线，等待网络恢复:`, e.message);
      return;
    }
    _transientFailStreak++;
    if (_transientFailStreak >= TRANSIENT_FAIL_LIMIT) {
      const hint = /manifest\.json/.test(e.message || '') && /空内容|空文件|解析失败/.test(e.message || '')
        ? '云端清单文件（manifest.json）疑似已损坏。可在云同步菜单选「修复云端清单」一键重建，或到网盘删除 manifest.json 后重启应用。'
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

  // ─── GET（下载检查）────────────────────────────────────────────────────────────
  // strict：手动同步专用——错误除了走常规处理（重试/熔断/提示）外还会原样上抛，
  // 让"立即同步"按钮如实显示失败，而不是把错误内部消化后假装"同步完成"。
  async function doGet({ force = false, silent = false, adopt = false, strict = false } = {}) {
    if (!_config || _stopped) return;
    if (_syncing) { _pendingGet = true; return; }
    if (_paused && !force) return;
    if (!force && (Date.now() - _lastGetTime < GET_COOLDOWN_MS)) return;
    if (!navigator.onLine) return;
    // 存储未就绪硬闸：storage.init() 抛错或尚未水合时 _data 为 null（getAll() 返回 null）。
    // 此时绝不能进同步——否则会拿"空库"去判断、甚至触发 _firstSync 清零云端清单。
    // 注意：水合成功但确实没有笔记时 getAll() 是空骨架对象（truthy），不受此闸影响，仍可正常下载采纳。
    if (!window.storage.getAll()) {
      console.warn('[webdav] 本地存储未就绪（getAll 为 null），本轮同步跳过');
      if (force) _emit('cloud-sync', { type: 'webdav-sync-fail', error: '本地数据未加载完成或加载失败，已暂停同步以防误清空云端；请重启应用后再试' });
      return;
    }

    _syncing = true;
    _emit('cloud-sync', { type: 'webdav-sync-start', detail: 'get', silent });
    try {
      // 条件 GET：仅轮询/常规下行带 If-None-Match（force/adopt 要全量，不带）。无变化时服务器回 304，
      // 省下整份 manifest 的下载与解析（手机端/大库尤其值）。无 etag 或服务器不支持则照常全量。
      const condEtag = (!force && !adopt && _lastManifestEtag) ? _lastManifestEtag : '';
      let manifest = await webdavGetJson('manifest.json', { allow404: true, ifNoneMatch: condEtag });
      _lastGetTime = Date.now();
      _transientFailStreak = 0; // 读到了（含 404/304）：清空熔断计数

      if (manifest === NOT_MODIFIED) {
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-unchanged', silent });
        return;
      }

      // 404 二次确认：规避服务器加锁/限流期间的假 404 被误判成"清单丢失"（会触发空清单重建）
      if (!manifest) manifest = await _recheckManifest();

      if (!manifest) {
        const data = window.storage.getAll() || {};
        const hasLocalNotes = data.notes && Object.keys(data.notes).length > 0;
        if (hasLocalNotes || _hasDirtyData()) await _firstSync();
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-empty', silent });
        return;
      }

      if (typeof manifest !== 'object' || !manifest.version) {
        throw new Error('云端清单（manifest.json）内容异常。可在云同步菜单选「修复云端清单」一键重建，或到网盘删除 manifest.json 后重启应用');
      }

      // 数据格式版本闸：云端格式比本客户端新 → 停止同步并提示更新，绝不下载/上传。
      if (_remoteFormatTooNew(manifest)) {
        console.warn('[webdav] 云端数据格式版本', manifest.dataFormatVersion, '高于本客户端支持', SUPPORTED_DATA_FORMAT, '；已停止同步，请更新枝记');
        _emit('cloud-sync', { type: 'webdav-version-block', remoteFmt: manifest.dataFormatVersion, supported: SUPPORTED_DATA_FORMAT });
        return;
      }

      // adopt：用户在「切换服务商」里选了"下载云端（覆盖本地）"，必须强制下载并采纳，
      // 不能因"manifest 未变"早退，也不依赖 epoch 比较。
      if (!adopt && manifest.updatedAt === _lastKnownManifestUpdatedAt) {
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'get-unchanged', silent });
        return;
      }

      // 只有"确实有新内容要下载"才弹保护条；仅仅是云端上次由别的设备写过（内容早已同步过）不算。
      const isOtherDevice = manifest.deviceId && manifest.deviceId !== _ensureClientId();
      if (isOtherDevice && _hasIncomingChanges(manifest)) {
        _emit('cloud-sync', { type: 'sync-protection-start' });
      }

      // epoch 闸门：远端世代比本地已采纳的更高 → 采纳模式（云端权威，本地多余项留底后移除，不反向上传）。
      // 首次遇到本账号（stored===null）不采纳，只记录，避免老用户升级首次同步误删本地笔记。
      // adopt 强制采纳：本地多余笔记留底后移除，使本地与云端一致（"下载覆盖"语义）。
      const remoteEpoch = manifest.epoch || 1;
      const storedEpoch = _getAdoptedEpoch();
      const adoptMode = adopt || ((storedEpoch !== null) && (remoteEpoch > storedEpoch));

      await _applyRemoteChanges(manifest, { adoptMode });
      // 有笔记因解密失败被跳过时不记录基准：下轮"manifest 未变"不会早退，被跳过的笔记会重试
      if (!_skippedDecryptCount) _lastKnownManifestUpdatedAt = manifest.updatedAt;
      _backoffMs = 30_000;
      _setAdoptedEpoch(remoteEpoch); // 应用成功后对齐世代

      // Bug A: 扫描本地比远端新的笔记，标记为 dirty（处理重启后丢失 dirtyIds 的场景）。
      // 采纳模式下绝不上传本地多余笔记（它们已被留底移除），否则会把"被权威淘汰的内容"再涌回云端。
      if (!adoptMode) _detectLocallyNewerNotes(manifest);

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
        const n = await webdavGetNote(`notes/${id}.json`, { allow404: true });
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
    _lastDownloadedIds = new Set();

    // 第一遍：算出需要下载的 id（顺便给"未下载且无基准"的本地笔记回填基准）。
    const toDownload = [];
    for (const id in manifest.notes) {
      if (manifest.deleted && manifest.deleted[id]) continue; // 已删除（墓碑）→ 绝不重新下载
      const remoteTs = manifest.notes[id].updatedAt || 0;
      const localNote = data.notes[id];
      const localTs = localNote ? new Date(localNote.updatedAt || 0).getTime() : 0;
      if (remoteTs > localTs + 1000) {
        if (_isKnownBadNote(id, remoteTs)) continue; // 已确认拉不下来的僵尸笔记：不再重试
        toDownload.push(id);
      } else if (localNote && !_getBase(id)) {
        const dn = window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : [];
        if (!dn.includes(id)) _setBase(id, _noteHash(localNote), remoteTs);
      }
    }

    // 并发预取需要下载的笔记正文（并发上限由请求池控制）。下载是 IO，串行往返才是慢的根因。
    const _fetched = new Map();
    if (toDownload.length) {
      const { errors } = await _runPool(toDownload, async (id) => {
        const note = await webdavGetNote(`notes/${id}.json`, { allow404: true });
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
            const lts = new Date(ln.updatedAt || 0).getTime();
            const rts = (manifest.notes[id] && manifest.notes[id].updatedAt) || 0;
            return lts >= rts;
          });
          if (healIds.length && window.storage.markNotesDirtyByIds) {
            window.storage.markNotesDirtyByIds(healIds);
            setTimeout(() => { try { schedulePut(); } catch (_) {} }, 2000);
          }
          // 本地无副本可自愈的：记入僵尸名单。计数只算"还会重试"的，
          // 连续 2 轮失败转为永久跳过（不再阻塞 manifest 基准、不再每轮重试）
          const restIds = dec.map(d => d.item).filter(id => !healIds.includes(id));
          let stillRetry = 0;
          const nowPermanent = [];
          for (const id of restIds) {
            const rts = (manifest.notes[id] && manifest.notes[id].updatedAt) || 0;
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
          setTimeout(() => { try { schedulePut(); } catch (_) {} }, 2000);
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
      const remoteTs = manifest.notes[id].updatedAt || 0;
      const localNote = data.notes[id];
      const base = _getBase(id);
      {
        const remoteNote = _fetched.get(id);
        if (!remoteNote) { console.warn('[webdav] 下载笔记返回 null:', id); continue; }
        const dirtyNow = window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : [];
        const remoteHash = _noteHash(remoteNote);
        // 本地相对"上次同步基准"是否改过：有基准就按指纹比，没基准退回 dirty 标记
        const localDiverged = localNote
          ? (base ? (_noteHash(localNote) !== base.h) : dirtyNow.includes(id))
          : false;
        // 本地与远端内容其实一致 → 不算冲突，直接采纳，不产生副本
        const sameContent = localNote ? (_noteHash(localNote) === remoteHash) : false;

        if (localDiverged && !sameContent) {
          // 真冲突：本地相对基准有改动，且与远端内容不同 → 两份都不丢。
          // 把"本地版本"另存为冲突副本，本体采用远端较新版本，
          // 使所有设备最终收敛到同一份（业界 conflicted-copy 标准做法）。
          const copyId = _saveConflictCopy(id, localNote);
          window.storage._webdavApplyNote(id, remoteNote);
          // 只有"顶级笔记"才进 rootOrder：子笔记若被塞进 rootOrder，会同时按
          // 「父节点的子项」和「顶级项」渲染两次（同 id 重复节点，删一个两个都消失）。
          if (remoteNote.parentId == null && !data.rootOrder.includes(id)) data.rootOrder.push(id);
          if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
          _setBase(id, remoteHash, remoteTs);
          _lastDownloadedIds.add(id);
          if (copyId) _lastDownloadedIds.add(copyId);
          hasDownloads = true;
          _emit('cloud-sync', { type: 'webdav-conflict', noteId: id, noteTitle: localNote?.title || id, copyMade: !!copyId });
          continue;
        }
        // 干净下载（或内容本就一致，无需建副本）。
        // 兜底：内容确实不同就先留底，哪怕"判为干净"是误判，旧内容也能找回。
        if (localNote && !sameContent) _backupBeforeOverwrite(id, localNote, 'clean-download');
        window.storage._webdavApplyNote(id, remoteNote);
        if (remoteNote.parentId == null && !data.rootOrder.includes(id)) data.rootOrder.push(id);
        if (sameContent && window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
        _setBase(id, remoteHash, remoteTs);
        _lastDownloadedIds.add(id);
        hasDownloads = true;
      }
    }

    // 处理远端删除（带时间戳保护，也实时检查 dirty）
    for (const id in manifest.deleted) {
      if (data.notes[id]) {
        const currentDirty = window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : [];
        if (currentDirty.includes(id)) continue;
        const deleteTs = _tombTs(manifest.deleted[id]);
        const localTs = new Date(data.notes[id].updatedAt || 0).getTime();
        if (deleteTs > localTs) {
          // 兜底：远端墓碑删除本地笔记前先留底，防止误删丢内容。
          _backupBeforeOverwrite(id, data.notes[id], 'remote-delete');
          window.storage._webdavRemoveNote(id);
          _delBase(id);
          hasDownloads = true;
        }
      }
    }

    // 应用全局状态（若本地无 globalDirty）
    if (!globalDirty) {
      const localData = window.storage.getAll();
      let globalChanged = false;
      if (manifest.rootOrder && JSON.stringify(manifest.rootOrder) !== JSON.stringify(localData.rootOrder)) globalChanged = true;
      if (manifest.workspaces && JSON.stringify(manifest.workspaces) !== JSON.stringify(localData.workspaces)) globalChanged = true;
      if (manifest.templates && JSON.stringify(manifest.templates) !== JSON.stringify(localData.templates)) globalChanged = true;
      // 远端有本地未知的笔记本/模板墓碑 → 需要应用（把已删除项剔除）
      if (manifest.wsDeleted) {
        const localTomb = localData.wsTombstones || {};
        for (const wid in manifest.wsDeleted) { if (!localTomb[wid]) { globalChanged = true; break; } }
      }
      if (manifest.tplDeleted) {
        const localTtomb = localData.tplTombstones || {};
        for (const tid in manifest.tplDeleted) { if (!localTtomb[tid]) { globalChanged = true; break; } }
      }
      if (globalChanged) {
        window.storage._webdavApplyGlobal({
          rootOrder: manifest.rootOrder,
          trashOrder: manifest.trashOrder,
          workspaces: manifest.workspaces,
          templates: manifest.templates,
          wsDeleted: manifest.wsDeleted,
          tplDeleted: manifest.tplDeleted,
          settings: manifest.settings,
        });
        hasDownloads = true;
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

    // 关键修复：无论本地是否 globalDirty，都先把远端「笔记本 / 模板」并入本地。
    // 否则 globalDirty 时整体全局应用被跳过，但远端笔记仍会下载，
    // 其 workspaceId 在本地不存在 → 下面的 reconcileStructure 会把它们全部塞进当前笔记本，
    // 造成"云端数据没正确归位、全挤在一个本子里"，且该错误归位还会被回传污染其它设备。
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
    if (window.storage.reconcileStructure && window.storage.reconcileStructure()) {
      hasDownloads = true;
    }

    if (hasDownloads) {
      window.storage.save({ immediate: true });
    }
    _flushSyncBase();
    if (_pendingImageDownloads.size > 0) {
      _scheduleImageDownloads();
    }
  }

  /** 把本地未上传的版本另存为一篇独立的"本地冲突副本"笔记，确保它不被远端覆盖丢失。
   *  副本被标脏 → 下次 PUT 会上传，让其它设备也能看到这份副本。返回新 id 或 null。 */
  function _saveConflictCopy(baseId, sourceNote) {
    try {
      if (!sourceNote) return null;
      const newId = baseId + '__cf-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const copy = { ...sourceNote };
      copy.id = newId;
      copy.parentId = null; // 提到顶层，避免挂到可能不存在的父节点
      copy.workspaceId = sourceNote.workspaceId || undefined;
      const baseTitle = (sourceNote.title || '无标题').replace(/（本地冲突副本[^）]*）\s*$/, '');
      const when = new Date().toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      copy.title = `${baseTitle}（本地冲突副本 ${when}）`;
      copy.updatedAt = new Date().toISOString();
      window.storage._webdavApplyNote(newId, copy);
      const d = window.storage.getAll();
      if (d.rootOrder && !d.rootOrder.includes(newId)) d.rootOrder.push(newId);
      if (window.storage.markNotesDirtyByIds) window.storage.markNotesDirtyByIds([newId]);
      return newId;
    } catch (e) {
      console.warn('[webdav] 生成冲突副本失败', e);
      return null;
    }
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
  async function _guardUploadConflicts(dirtyIds, data, manifest) {
    if (!manifest || !manifest.notes) return;
    const adopted = new Set();
    for (const id of Array.from(dirtyIds)) {
      const localNote = data.notes[id];
      if (!localNote) continue;                 // 删除/回收站项不在此防护
      const remoteEntry = manifest.notes[id];
      if (!remoteEntry) continue;               // 远端没有 → 本地新笔记，正常上传
      const base = _getBase(id);
      if (!base) continue;                      // 无基准 → 无从判断"远端是否变过"，保守放行（首次会建立基准）
      const remoteTs = remoteEntry.updatedAt || 0;
      if (remoteTs === base.t) continue;        // 远端自上次同步未变 → 本地权威，安全上传
      // 远端该篇已被别的设备改过：取回远端正文，避免裸覆盖。
      let remoteNote = null;
      try { remoteNote = await webdavGetNote(`notes/${id}.json`, { allow404: true }); }
      catch (e) { if (e instanceof RateLimitError) throw e; }
      if (!remoteNote) continue;                // 取不到远端正文（极少见）→ 不冒险处理，放行
      const remoteHash = _noteHash(remoteNote);
      if (_noteHash(localNote) === remoteHash) {
        // 内容其实一致（仅 manifest 时间戳不同）→ 不算冲突：对齐基准、清脏、不重复上传。
        _setBase(id, remoteHash, remoteTs);
        if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
        dirtyIds.delete(id);
        continue;
      }
      // 真冲突：留底 + 本地另存冲突副本（不丢）+ 本体采纳远端较新版本。
      _backupBeforeOverwrite(id, localNote, 'upload-conflict');
      const copyId = _saveConflictCopy(id, localNote);
      window.storage._webdavApplyNote(id, remoteNote);
      if (remoteNote.parentId == null && data.rootOrder && !data.rootOrder.includes(id)) data.rootOrder.push(id);
      if (window.storage.removeDirtyNoteIds) window.storage.removeDirtyNoteIds([id]);
      dirtyIds.delete(id);
      _setBase(id, remoteHash, remoteTs);
      adopted.add(id);
      _emit('cloud-sync', { type: 'webdav-conflict', noteId: id, noteTitle: localNote.title || id, copyMade: !!copyId });
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

  /** Bug A: 重启后 dirtyIds 丢失 —— GET 成功后扫描本地比远端新的笔记，标记为 dirty */
  function _detectLocallyNewerNotes(manifest) {
    if (!window.storage || !window.storage.markNotesDirtyByIds) return;
    const data = window.storage.getAll();
    const base = _loadSyncBase();
    const dirtySet = new Set(window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : []);
    const needUpload = [];
    for (const id in data.notes) {
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
        const localTs = new Date(data.notes[id].updatedAt || 0).getTime();
        const remoteTs = remoteEntry.updatedAt || 0;
        if (localTs > remoteTs + 1000) {
          needUpload.push(id);
        }
      }
    }
    if (needUpload.length > 0) {
      window.storage.markNotesDirtyByIds(needUpload);
      schedulePut();
    }
  }

  // ─── PUT（上传变更）────────────────────────────────────────────────────────────
  // strict 含义同 doGet：手动同步时错误原样上抛
  async function doPut({ force = false, strict = false } = {}) {
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
    _emit('cloud-sync', { type: 'webdav-sync-start', detail: 'put' });
    try {
      const data = window.storage.getAll();
      let dirtyIds = new Set(window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : []);
      const globalDirty = window.storage.isGlobalDirty ? window.storage.isGlobalDirty() : false;

      if (dirtyIds.size === 0 && !globalDirty) {
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-nothing' });
        return;
      }

      // 先取云端 manifest：既用于「上传前单篇冲突防护」(Fix A)，也作为后续 read-modify-write 的基底。
      let manifest = await webdavGetJson('manifest.json', { allow404: true });
      _transientFailStreak = 0; // 读到了（含 404）：清空熔断计数
      // 404 二次确认：manifest 是总账本，假 404 误判成"清单丢失"会把云端清空（曾发生）
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

      // Fix A：上传前的单篇冲突防护（覆盖远端前必须留底）。会把"远端已被别的设备改过"的脏笔记
      // 从本次上传中剔除（留底+冲突副本+采纳远端），避免裸覆盖云端较新版本而丢数据。
      await _guardUploadConflicts(dirtyIds, data, manifest);
      // 防护可能新增了冲突副本(脏)、移除了被采纳的 id → 重算本次实际待上传集合。
      dirtyIds = new Set(window.storage.getDirtyNoteIds ? window.storage.getDirtyNoteIds() : []);
      if (dirtyIds.size === 0 && !globalDirty) {
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-resolved-conflicts' });
        return;
      }

      // 上传脏笔记（并发，受请求池限速）
      {
        const { errors } = await _runPool(dirtyIds, async (id) => {
          const note = data.notes[id];
          if (!note) {
            if (data.trash && data.trash[id]) {
              const body = await _prepareNoteBody(data.trash[id]);
              await webdavPut(`trash/${id}.json`, body);
            }
            return;
          }
          const body = await _prepareNoteBody(note);
          await webdavPut(`notes/${id}.json`, body);
        });
        // 上传失败必须上抛：否则会误更新 manifest/基准，导致"看似成功实则没传上去"。
        const rl = errors.find(e => e.error instanceof RateLimitError);
        if (rl) throw rl.error;
        if (errors.length) throw errors[0].error;
      }

      // 上传新图片（外置后从内存缓存取；等后端载入完成，避免漏传）
      if (window.storage.imagesReady) await window.storage.imagesReady();
      const localImages = (window.storage.getImageMap && window.storage.getImageMap()) || data.localImages || {};
      // 条件写基准：记下此刻云端 manifest 的 updatedAt；最终写回前会再确认它没被别的设备改过。
      const _manifestBaseTs = manifest.updatedAt || 0;
      const remoteImages = manifest.images || {};
      manifest.images = manifest.images || {};
      {
        const imgHashes = Object.keys(localImages).filter(h => !remoteImages[h]);
        const { errors } = await _runPool(imgHashes, async (hash) => {
          const dataUrl = localImages[hash];
          const { ext, binary } = _dataUrlToBlob(dataUrl);
          if (binary.length > 0) {
            await webdavPut(`images/${hash}`, binary, _extToMime(ext));
            manifest.images[hash] = ext;
          }
        });
        const rl = errors.find(e => e.error instanceof RateLimitError);
        if (rl) throw rl.error;
        if (errors.length) throw errors[0].error;
      }

      // 更新 manifest
      for (const id of dirtyIds) {
        const note = data.notes[id];
        if (note) {
          manifest.notes[id] = { updatedAt: new Date(note.updatedAt || 0).getTime(), title: note.title || '', parentId: note.parentId == null ? null : note.parentId };
          // 这篇此刻是"活的"（被显式编辑/导入而标脏）→ 清掉它残留的删除墓碑，
          // 让"找回/导入"权威生效并同步到其它设备，避免被旧墓碑再次抹掉。
          if (manifest.deleted && manifest.deleted[id]) delete manifest.deleted[id];
        } else if (data.trash && data.trash[id]) {
          manifest.trash = manifest.trash || {};
          manifest.trash[id] = { updatedAt: new Date(data.trash[id].updatedAt || data.trash[id].deletedAt || 0).getTime() };
          delete manifest.notes[id];
          manifest.deleted = manifest.deleted || {};
          manifest.deleted[id] = Date.now();
        } else {
          // 彻底删除：notes 与 trash 都已无此 id → 记墓碑 + 清 manifest + 删云端文件。
          // 不做这步的话，manifest.notes[id] 残留，下次启动同步会把它重新下载回列表（顽固复活 bug）。
          delete manifest.notes[id];
          if (manifest.trash) delete manifest.trash[id];
          manifest.deleted = manifest.deleted || {};
          manifest.deleted[id] = Date.now();
          try { await webdavDelete(`notes/${id}.json`); } catch (_) {}
          try { await webdavDelete(`trash/${id}.json`); } catch (_) {}
        }
      }

      if (globalDirty) {
        // 合并而非覆盖：本地在前（本机的顺序/重命名生效），但云端 manifest 里已有、
        // 本机却没有的笔记 id 一律保留，绝不删除。
        // —— 这是数据丢失的根治点：避免"另一台设备刚建的笔记"被本次上传从 rootOrder 抹掉而消失。
        const delMap = manifest.deleted || {};
        manifest.rootOrder = _mergeIdOrderUp(data.rootOrder, manifest.rootOrder).filter(id => !delMap[id]);
        manifest.trashOrder = _mergeIdOrderUp(data.trashOrder, manifest.trashOrder).filter(id => !delMap[id]);
        // 笔记本墓碑：合并本地+云端墓碑，并据此剔除已删除的笔记本，使删除经云端生效
        manifest.wsDeleted = { ...(manifest.wsDeleted || {}), ...(data.wsTombstones || {}) };
        manifest.workspaces = _mergeByIdUp(data.workspaces, manifest.workspaces).filter(w => !manifest.wsDeleted[w.id]);
        // 模板墓碑：同笔记本，合并墓碑并剔除已删除模板，使删除经云端生效
        manifest.tplDeleted = { ...(manifest.tplDeleted || {}), ...(data.tplTombstones || {}) };
        manifest.templates = _mergeByIdUp(data.templates, manifest.templates).filter(t => !manifest.tplDeleted[t.id]);
        manifest.settings = _extractSharedSettings(data.settings);
      }

      // 顺手把 manifest 里所有"本地已知"的笔记补/刷新标题与层级（取自本地，无额外请求）。
      // 让"云端数据管理"扫描一次即可拿到全部标题和父子关系，无需逐篇读取。
      for (const id in manifest.notes) {
        const ln = data.notes[id];
        if (ln) {
          manifest.notes[id].title = ln.title || '';
          manifest.notes[id].parentId = ln.parentId == null ? null : ln.parentId;
        }
      }

      // 30 天清理 deleted
      _purgeOldDeleted(manifest);

      // 条件写：写回前再确认云端 manifest 没被别的设备抢先改过（乐观并发控制）。
      // 若已变化 → 放弃本次写（不清 dirty、不立基准），稍后基于新 manifest 重新合并重试，
      // 避免用我们手里的旧 manifest 覆盖掉对方刚写入的更新而丢数据。
      const _freshManifest = await webdavGetJson('manifest.json', { allow404: true });
      if (_freshManifest && (_freshManifest.updatedAt || 0) !== _manifestBaseTs) {
        _pendingPut = true;
        setTimeout(() => schedulePut(), 1500);
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-deferred-concurrent' });
        return;
      }

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

      await _putManifestVerified(manifest, manifestEtag);
      _casFailStreak = 0; _casForceUnconditional = false; // 原子写成功：复位被抢先计数
      _lastKnownManifestUpdatedAt = manifest.updatedAt;
      _lastPutTime = Date.now();

      // 立基准：本机这些笔记刚成功上云，记下它们的内容指纹 + 写入的远端时间戳
      for (const id of dirtyIds) {
        const note = data.notes[id];
        if (note && manifest.notes[id]) _setBase(id, _noteHash(note), manifest.notes[id].updatedAt || 0);
        else _delBase(id); // 已删除/入回收站 → 清掉基准
      }
      _flushSyncBase();

      // 只清除已上传的 dirtyIds
      if (window.storage.removeDirtyNoteIds) {
        window.storage.removeDirtyNoteIds(dirtyIds);
      } else if (window.storage.clearDirtyNoteIds) {
        window.storage.clearDirtyNoteIds();
      }
      if (globalDirty && window.storage.clearGlobalDirty) window.storage.clearGlobalDirty();

      _backoffMs = 30_000;
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put' });

    } catch (e) {
      if (e instanceof RateLimitError) {
        _handleRateLimit();
      } else if (e instanceof PreconditionFailedError) {
        // 被抢先：manifest 在"读→改"间被别的设备更新。不清 dirty（清 dirty 的代码在 PUT 成功之后，
        // 本次未执行到）、不立基准、不报错；下一轮重新读取合并后重试。连续被抢则退化为普通写避免空转。
        _casFailStreak++;
        if (_casFailStreak >= 2) _casForceUnconditional = true;
        _pendingPut = true;
        _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'put-retry-cas' });
        console.warn('[webdav] manifest 被其它设备抢先更新（412），重新合并后重试（streak=' + _casFailStreak + '）');
        schedulePut(); // 受 _putMinIntervalMs(默认 5s) 节流，不会请求风暴
      } else if (e && (e.transient || _isNetFlavorError(e))) {
        // 瞬时错误（并发写期间读到空/截断的 manifest）：保留 dirty、少量自动重试；连续失败则熔断报错
        _pendingPut = true;
        _handleTransient(e, '上传', () => schedulePut());
      } else {
        _emit('cloud-sync', { type: 'webdav-sync-fail', error: e.message });
        console.error('[webdav] PUT 错误:', e);
      }
      // 手动同步：如实上抛真实结果；但 412 是"已自动重排重试"的良性信号，不当失败上报。
      if (strict && !(e instanceof PreconditionFailedError)) throw e;
    } finally {
      _syncing = false;
      _drainPending();
    }
  }

  // ─── 首次同步 ────────────────────────────────────────────────────────────────
  async function _firstSync() {
    _emit('cloud-sync', { type: 'webdav-sync-start', detail: 'first' });
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
        const body = await _prepareNoteBody(note);
        await webdavPut(`notes/${id}.json`, body);
        manifest.notes[id] = { updatedAt: new Date(note.updatedAt || note.createdAt || 0).getTime(), title: note.title || '', parentId: note.parentId == null ? null : note.parentId };
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
    manifest.updatedAt = Date.now();
    manifest.deviceId = _ensureClientId();

    await _putManifestVerified(manifest);
    _lastKnownManifestUpdatedAt = manifest.updatedAt;
    _lastPutTime = Date.now();
    _setAdoptedEpoch(manifest.epoch || 1); // 本机建立了云端，对齐世代，避免日后误采纳自己

    // 立基准：首次同步把本地所有笔记当作"已同步"的基准点
    for (const id in data.notes) {
      if (manifest.notes[id]) _setBase(id, _noteHash(data.notes[id]), manifest.notes[id].updatedAt || 0);
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
    return { version: 2, epoch: 1, dataFormatVersion: _localDataFormat(), updatedAt: 0, deviceId: _ensureClientId(), notes: {}, trash: {}, images: {}, deleted: {}, wsDeleted: {}, tplDeleted: {} };
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
  function schedulePut() {
    if (!_config || _paused || _stopped) return;
    if (!_hasDirtyData()) return;
    clearTimeout(_putTimer);
    _putTimer = setTimeout(() => {
      if (_syncing) {
        // 如果正在同步，延后重试
        _putTimer = setTimeout(() => schedulePut(), 2000);
        return;
      }
      const elapsed = Date.now() - _lastPutTime;
      if (elapsed < _putMinIntervalMs) {
        _putTimer = setTimeout(() => doPut(), _putMinIntervalMs - elapsed);
      } else {
        doPut();
      }
    }, PUT_DEBOUNCE_MS);
  }

  function flushPutOnBlur() {
    if (!_config || _stopped || !_hasDirtyData()) return;
    if (Date.now() - _lastBlurPutTime < BLUR_PUT_COOLDOWN_MS) return;
    if (_syncing) { _pendingPut = true; return; }
    clearTimeout(_putTimer);
    _lastBlurPutTime = Date.now();
    doPut();
  }

  function flushPutOnHide() {
    if (!_config || _stopped || !_hasDirtyData()) return;
    if (_syncing) { _pendingPut = true; return; }
    clearTimeout(_putTimer);
    doPut();
  }

  // ─── 手动同步 ────────────────────────────────────────────────────────────────
  async function manualSync() {
    if (!_config) { console.warn('[webdav] manualSync: _config 为空，同步未启动'); return; }
    if (_stopped) { console.warn('[webdav] manualSync: 模块已停止'); return; }
    _skipBadNotes = {}; // 手动同步是用户主动行为：僵尸名单清空，给所有跳过的笔记一次重试机会
    if (_syncing) await _waitSyncDone();
    const wasPaused = _paused;
    _paused = false;
    try {
      // 先拉后推：先把云端变更合并下来（同篇冲突会生成"冲突副本"，谁都不丢），
      // 再上传本地改动。避免"先推"把另一台设备的同篇更新静默覆盖。
      // strict：失败必须上抛——以前 doGet 把错误内部消化掉，"立即同步"明明失败却显示"同步完成"，
      // 用户因此以为同步没问题、错误提示是误报。
      await doGet({ force: true, strict: true });
      if (_hasDirtyData()) {
        await doPut({ force: true, strict: true });
      }
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
      doGet();
    }
    _resetSilenceTimer();
  }

  // 窗口被唤起 / 获焦 / 恢复网络时：强制拉一次云端，确保"切回来就能看到最新"。
  // 用 2 秒去重，避免 focus + visibilitychange 同时触发导致重复请求。
  let _lastWakeGetTime = 0;
  function _wakeGet() {
    const now = Date.now();
    if (now - _lastWakeGetTime < 2000) return;
    _lastWakeGetTime = now;
    _resetSilenceTimer();
    doGet({ force: true });
  }

  // ─── 事件监听器管理 ──────────────────────────────────────────────────────────
  let _boundHandlers = null;

  function _registerListeners() {
    if (_boundHandlers) return;
    _boundHandlers = {
      visibility: () => {
        if (_stopped) return;
        if (!document.hidden) _wakeGet();
        else flushPutOnHide();
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
    setTimeout(() => doGet({ force: true }), 1000);
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
      doGet({ silent: true }); // 非强制：受 GET_COOLDOWN_MS 节流，无变更时早退、不闪徽标
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
      if (_hasDirtyData()) schedulePut();
    }, _backoffMs);
  }

  // ─── 排队与等待 ──────────────────────────────────────────────────────────────
  function _drainPending() {
    if (_pendingPut) {
      _pendingPut = false;
      if (_hasDirtyData()) {
        _pendingGet = false;
        setTimeout(() => doPut(), 100);
        return;
      }
    }
    if (_pendingGet) {
      _pendingGet = false;
      setTimeout(() => doGet(), 100);
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
    return dirtyIds.length > 0 || globalDirty;
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
    const LOCAL_ONLY = ['theme', 'fontSize', 'fontFamily', 'noteTransition',
      'sidebarCollapsed', 'outlineCollapsed', 'showTrashBadge', 'syncMethod',
      'editorPadding', 'sidebarWidth', 'outlineOpen',
      'activeWorkspace', 'lastOpenedId', 'recent', 'imagesDir',
      'webdavUrl', 'webdavUser', 'webdavPass', 'webdavProvider', 'webdavEncryptNotes', 'webdavProxy', 'webdavCryptoPass'];
    const LOCAL_PREFIX = ['webdav_', '_'];
    const shared = {};
    for (const k in settings) {
      if (LOCAL_ONLY.includes(k)) continue;
      if (LOCAL_PREFIX.some(p => k.startsWith(p))) continue;
      shared[k] = settings[k];
    }
    return shared;
  }

  async function _prepareNoteBody(note) {
    const json = JSON.stringify(note);
    if (_config && _config.encryptNotes) return await notesEncrypt(json);
    return json;
  }

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
    const binary = _base64ToBuf(match[2]);
    return { ext, binary };
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
        if (!/\.json$/i.test(name)) continue;
        const id = name.replace(/\.json$/i, '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        totalSize += (e.size || 0);
        let mtime = '';
        if (e.mtime) { const d = new Date(e.mtime); if (!isNaN(d.getTime())) mtime = d.toISOString(); }
        let status = 'missing';
        if (data.notes && data.notes[id]) status = 'local';        // 本地已有
        else if (data.trash && data.trash[id]) status = 'trash';   // 回收站已有
        else if (deleted[id]) status = 'deleted';                  // 墓碑（已删除记录）
        // 标题与层级直接取自 manifest（上传时已写入），无需逐篇读取
        const meta = (manifest && manifest.notes && manifest.notes[id]) || null;
        const hasTitleMeta = !!(meta && typeof meta.title === 'string');
        const item = {
          id,
          title: hasTitleMeta ? meta.title : '',
          parentId: meta && ('parentId' in meta) ? meta.parentId : null,
          updatedAt: mtime, size: e.size, _note: null,
          _titleLoaded: hasTitleMeta, status,
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
      const note = await webdavGetNote(`notes/${it.id}.json`, { allow404: true });
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
          note = await webdavGetNote(`notes/${it.id}.json`, { allow404: true });
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
      schedulePut();
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
    try {
      if (_syncing) await _waitSyncDone();
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
            if (!/\.json$/i.test(name)) continue;
            const id = name.replace(/\.json$/i, '');
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
        await _putManifestVerified(manifest);
        _lastKnownManifestUpdatedAt = manifest.updatedAt;
        _setAdoptedEpoch(manifest.epoch); // 本机就是权威发起方，对齐到新世代，避免自己又去"采纳"
      } finally {
        _syncing = false;
      }

      // 把本地全部标脏并上传，确保云端拿到本地完整内容。
      // strict：上传失败必须上抛——否则 doPut 内部吞掉错误后这里会误报 ok，用户以为覆盖成功
      _decMismatch = false; // 镜像覆盖 = 用当前口令整体重新加密云端，正是"口令不一致"的修复动作，解除上传闸
      _decFailRounds = 0;
      if (window.storage.markAllNotesDirty) window.storage.markAllNotesDirty();
      await doPut({ force: true, strict: true });
      return { ok: true, removed };
    } catch (e) {
      _syncing = false;
      if (e instanceof RateLimitError) return { ok: false, error: '服务器限流（503），请稍后重试' };
      return { ok: false, error: e.message };
    }
  }

  /** 修复云端清单：删除（疑似损坏的）manifest.json，按本机数据完整重建（走首次同步）。
   *  ⚠️ 清单以本机数据为准重建：云端独有、本机没有的笔记不会进入新清单
   *  （其文件仍保留在云端 notes/ 目录，可用「扫描云端恢复」找回）。
   *  适用场景：云端 manifest.json 变成 0 字节/损坏 JSON，所有设备同步卡死。 */
  async function repairManifest() {
    if (!_config) { const ok = await loadConfig(); if (!ok) return { ok: false, error: '同步未配置' }; }
    if (_syncing) await _waitSyncDone();
    _syncing = true;
    try {
      // 本地无任何笔记时从本地重建只会得到空清单 → 反把云端清空。拒绝并明确提示。
      const d = window.storage.getAll() || {};
      const hasLocal = (d.notes && Object.keys(d.notes).length > 0) || (d.trash && Object.keys(d.trash).length > 0);
      if (!hasLocal) {
        return { ok: false, error: '本地没有笔记，无法从本地重建清单。请在保有完整笔记的设备上执行修复。' };
      }
      // 不再 DELETE manifest.json：部分 WebDAV 服务器对加锁文件回 423 Locked（用户实测过），
      // 且没必要——_firstSync 用 PUT 直接覆盖重写清单（内容寻址的图片/已存在笔记文件会跳过，开销很小）。
      await _firstSync();
      _transientFailStreak = 0;
      _emit('cloud-sync', { type: 'webdav-sync-ok', detail: 'repair-manifest' });
      return { ok: true };
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
    loadConfig,
    startAutoSync,
    stop,
    schedulePut,
    flushPutOnBlur,
    flushPutOnHide,
    doGet,
    doPut,
    manualSync,
    scanCloudNotes,
    loadCloudTitles,
    recoverCloudNotes,
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

    isSyncing: () => _syncing,
    isPaused: () => _paused,
    getClientId: () => _ensureClientId(),
    getPendingImageDownloads: () => [..._pendingImageDownloads],
  };

})();
