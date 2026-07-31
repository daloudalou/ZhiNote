/* 第二套图标：Twemoji 统一画风（除小枝动图外）。
 * - Quicker：权威在「我的文档\ZhiNote\twemoji」（清单+图+meta）；网页库只是加速
 * - 网页版：权威在 IndexedDB；重启浏览器一般不用重下
 * - 显示：本机优先 → CDN → 系统脸兜底（勿永久灰块）；blob 会话内不 revoke
 * 暴露 window.emojiUi
 */
(function () {
  'use strict';

  var DATA_URL = 'https://cdn.jsdelivr.net/npm/emoji-picker-element-data@1/zh/emojibase/data.json';
  // 15.1 缺 Unicode 16/17 新表情（眼袋/虎鲸/萨克旗等）；升到 17.x 后 CDN 均有图
  var TWEMOJI_VER = '17.0.3';
  var TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@' + TWEMOJI_VER + '/assets/svg/';
  var LIST_KEY = 'list:emojibase-zh@3';
  var PACK_META_KEY = 'pack:meta@' + TWEMOJI_VER;
  var ATTR = '图标 Twemoji © Twitter · CC-BY 4.0';

  var GROUP_LABELS = {
    '0': '表情', '1': '人物', '3': '动物自然', '4': '饮食',
    '5': '出行', '6': '活动', '7': '物品', '8': '符号', '9': '旗帜',
  };
  var HIDDEN_GROUPS = { '2': 1 };

  var _data = null;
  var _dataP = null;
  var _byGroup = null;   // 分类 → 列表（切标签免全表过滤）
  var _groupOrder = null;
  var _pop = null;
  var _cat = '';
  var _q = '';
  var _opts = null;
  var _onDoc = null;
  var _onKey = null;
  var _scroll = { grid: 0, cats: 0, recent: 0 };
  var _anchorEl = null; // 用于插入后跟随光标重定位
  var _gridList = [];    // 当前过滤结果
  var _gridShown = 0;    // 已渲染条数（分页）
  var PAGE = 64;         // 约一屏（8×8），滚动再补

  // 本机包进度（仅选择器脚注用）
  var _pack = { total: 0, have: 0, running: false, done: false, downloading: false };
  var _packMetaReady = false;
  var _packMetaP = null;
  var _failHard = Object.create(null); // hex → true 确认 CDN/本机都无
  var _failSoft = Object.create(null); // hex → 连续失败次数
  var _memUrl = Object.create(null);   // hex → blob: URL（离线显示）
  var _ensuring = Object.create(null);

  // ===== IndexedDB =====
  var _db = null, _dbP = null;
  function db() {
    if (_db) return Promise.resolve(_db);
    if (_dbP) return _dbP;
    _dbP = new Promise(function (res) {
      try {
        var r = indexedDB.open('zhinote-emoji-ui', 1);
        r.onupgradeneeded = function () {
          try { r.result.createObjectStore('kv'); } catch (_) {}
        };
        r.onsuccess = function () { _db = r.result; res(_db); };
        r.onerror = function () { res(null); };
      } catch (_) { res(null); }
    });
    return _dbP;
  }
  function idbGet(key) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (res) {
        try {
          var t = d.transaction('kv', 'readonly').objectStore('kv').get(key);
          t.onsuccess = function () { res(t.result != null ? t.result : null); };
          t.onerror = function () { res(null); };
        } catch (_) { res(null); }
      });
    });
  }
  function idbPut(key, val) {
    return db().then(function (d) {
      if (!d) return;
      return new Promise(function (res) {
        try {
          var t = d.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
          t.onsuccess = function () { res(); };
          t.onerror = function () { res(); };
        } catch (_) { res(); }
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function groupKey(g) {
    if (g == null || g === '') return '其它';
    var k = String(g);
    return GROUP_LABELS[k] || k;
  }

  function normalizeRaw(raw) {
    return (Array.isArray(raw) ? raw : []).map(function (em) {
      var g = em.group;
      if (g == null && em.category != null) g = em.category;
      if (HIDDEN_GROUPS[String(g)]) return null;
      return {
        unicode: em.emoji || em.unicode,
        annotation: em.annotation || em.name || '',
        tags: em.tags || [],
        shortcodes: em.shortcodes || [],
        group: groupKey(g),
      };
    }).filter(function (em) { return em && em.unicode; });
  }

  function toDashHex(u, keepFe0f) {
    var cps = [], i, cp;
    for (i = 0; i < u.length; i++) {
      cp = u.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp === 0xfe0f && !keepFe0f) continue;
      cps.push(cp.toString(16));
    }
    return cps.join('-');
  }
  function twemojiUrl(u) { return TWEMOJI_BASE + toDashHex(u, false) + '.svg'; }
  function twemojiUrlFe0f(u) { return TWEMOJI_BASE + toDashHex(u, true) + '.svg'; }
  function svgKey(u) { return 'svg:' + toDashHex(u, false); }

  /**
   * CDN 文件名：有的必须带 fe0f（如 😶‍🌫️ / 🙂‍↕），有的带了反而 404（如 ❤）。
   * ZWJ 组合优先试带 fe0f；其余先试不带。命中后写入 _cdnHit，避免 background 404 后永不换图。
   */
  var _cdnHit = Object.create(null); // hex → 已验证可下的 CDN url
  function twemojiCandidates(u) {
    var a = twemojiUrl(u);
    var b = twemojiUrlFe0f(u);
    if (a === b) return [a];
    if (u.indexOf('\u200d') >= 0) return [b, a];
    return [a, b];
  }

  function isOnline() {
    try { return navigator.onLine !== false; } catch (_) { return true; }
  }

  function svgTextToUrl(text) {
    try {
      return URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    } catch (_) { return ''; }
  }

  /** 同步：内存里的本机 blob */
  function localUrlSync(u) {
    var h = toDashHex(u, false);
    return _memUrl[h] || '';
  }

  /**
   * 主显示：本机包优先 → 已验证的 CDN →（可选）猜一个 CDN → 空。
   * opts.body：正文装饰专用——绝不瞎猜 CDN（猜错 404 后 CSS 底图不重试，表现为一直空白）。
   */
  function displayUrl(u, opts) {
    if (!u) return '';
    var loc = localUrlSync(u);
    if (loc) return loc;
    var h = toDashHex(u, false);
    if (_cdnHit[h]) return _cdnHit[h];
    if (opts && opts.body) return '';
    if (!isOnline()) return '';
    return twemojiCandidates(u)[0] || '';
  }

  /** 本机图刚进内存时，通知正文重画装饰（打开笔记时 CDN 空白 → 落库后补脸） */
  var _cachedNotifyTimer = null;
  function notifyBodyRefresh() {
    if (_cachedNotifyTimer) return;
    _cachedNotifyTimer = setTimeout(function () {
      _cachedNotifyTimer = null;
      try {
        if (typeof window.__znTwemojiOnCached === 'function') window.__znTwemojiOnCached();
      } catch (_) {}
    }, 50);
  }

  /** 会话内同一表情固定同一 blob，绝不 revoke（避免切标签把图「作废」裂开） */
  function rememberSvg(u, text) {
    if (!text || text.indexOf('<svg') < 0) return '';
    var h = toDashHex(u, false);
    if (_memUrl[h]) return _memUrl[h];
    var url = svgTextToUrl(text);
    if (url) {
      _memUrl[h] = url;
      notifyBodyRefresh();
    }
    return url;
  }

  /** 把一批表情暖进内存：先网页库，Quicker 再补磁盘 */
  function warmMany(unicodes) {
    var need = [];
    var seen = Object.create(null);
    (unicodes || []).forEach(function (u) {
      if (!u || seen[u] || localUrlSync(u)) return;
      seen[u] = 1;
      need.push(u);
    });
    if (!need.length) return Promise.resolve();
    return db().then(function (d) {
      if (!d) return;
      return new Promise(function (res) {
        var finished = false;
        function finish() { if (!finished) { finished = true; res(); } }
        try {
          var tx = d.transaction('kv', 'readonly');
          var st = tx.objectStore('kv');
          var left = need.length;
          need.forEach(function (u) {
            var req = st.get(svgKey(u));
            req.onsuccess = function () {
              var v = req.result;
              if (typeof v === 'string' && v.indexOf('<svg') >= 0) rememberSvg(u, v);
              if (--left <= 0) finish();
            };
            req.onerror = function () { if (--left <= 0) finish(); };
          });
        } catch (_) { finish(); }
      });
    }).then(function () {
      if (!isQuickerHost()) return;
      var still = need.filter(function (u) { return !localUrlSync(u); });
      if (!still.length) return;
      var i = 0;
      var conc = 4;
      var active = 0;
      return new Promise(function (res) {
        function tick() {
          while (active < conc && i < still.length) {
            (function (u) {
              active++;
              var h = toDashHex(u, false);
              diskReadSvg(h).then(function (t) {
                if (t) {
                  rememberSvg(u, t);
                  idbPut(svgKey(u), t);
                }
                active--;
                if (i >= still.length && active === 0) res();
                else tick();
              });
            })(still[i++]);
          }
          if (i >= still.length && active === 0) res();
        }
        tick();
      });
    });
  }

  /** 拉一张进本机库。返回 'mem'|'idb'|'net'|'' */
  function ensureCached(u) {
    if (!u || !looksLikeEmoji(u)) return Promise.resolve('');
    var h = toDashHex(u, false);
    if (_failHard[h]) return Promise.resolve('');
    if (_memUrl[h]) return Promise.resolve('mem');
    if (_ensuring[h]) return _ensuring[h];
    _ensuring[h] = idbGet(svgKey(u)).then(function (cached) {
      if (typeof cached === 'string' && cached.indexOf('<svg') >= 0) {
        rememberSvg(u, cached);
        delete _failSoft[h];
        // Quicker：网页库命中时顺带落盘，防重启清库后再全量下
        diskWriteSvg(h, cached);
        return 'idb';
      }
      return diskReadSvg(h).then(function (diskText) {
        if (diskText) {
          rememberSvg(u, diskText);
          idbPut(svgKey(u), diskText);
          delete _failSoft[h];
          return 'disk';
        }
        if (!isOnline()) return '';
        var urls = twemojiCandidates(u);
        var i = 0;
        function next() {
          if (i >= urls.length) return '';
          var url = urls[i++];
          return fetch(url).then(function (r) {
            if (!r.ok) return next();
            return r.text().then(function (text) {
              if (!text || text.indexOf('<svg') < 0) return next();
              _cdnHit[h] = url;
              rememberSvg(u, text);
              diskWriteSvg(h, text);
              return idbPut(svgKey(u), text).then(function () {
                delete _failSoft[h];
                return 'net';
              });
            });
          }).catch(function () { return next(); });
        }
        return next();
      });
    }).then(function (src) {
      delete _ensuring[h];
      if (!src) {
        _failSoft[h] = (_failSoft[h] || 0) + 1;
        if (_failSoft[h] >= 3) _failHard[h] = true;
      }
      return src || '';
    }, function () {
      delete _ensuring[h];
      return '';
    });
    return _ensuring[h];
  }

  function clearSoftFails() {
    _failSoft = Object.create(null);
    _cdnHit = Object.create(null);
  }
  function retryHardAgain() {
    _failHard = Object.create(null);
    _failSoft = Object.create(null);
  }

  function packHintText() {
    if (_pack.done || (_pack.total > 0 && _pack.have >= _pack.total)) {
      return ATTR;
    }
    // 仅真正从网上拉新图时才提示百分比（本机已有时静默扫过，避免「又备份一遍」）
    if (_pack.running && _pack.downloading && _pack.total > 0) {
      var pct = Math.min(99, Math.floor((_pack.have / _pack.total) * 100));
      var verb = isQuickerHost() ? '下载到本机 ' : '本机缓存 ';
      return verb + pct + '% · 现在可照常选用 · ' + ATTR;
    }
    if (!isOnline() && !_pack.done) {
      return '离线模式 · 未下载的格需联网补全 · ' + ATTR;
    }
    return ATTR;
  }

  function refreshPackHint() {
    if (!_pop) return;
    var foot = _pop.querySelector('.eui-foot');
    if (foot) foot.textContent = packHintText();
  }

  function applyPackMeta(m) {
    if (!m || typeof m !== 'object') return;
    // 旧版 Twemoji 的「已下完」不能沿用——缺新表情图
    if (m.ver && m.ver !== TWEMOJI_VER) {
      _pack.done = false;
      _pack.have = 0;
      _pack.total = m.total | 0;
      return;
    }
    if (!m.ver) {
      _pack.done = false;
      _pack.have = 0;
      _pack.total = m.total | 0;
      return;
    }
    _pack.done = !!m.done;
    _pack.have = m.have | 0;
    _pack.total = m.total | 0;
  }

  // ===== Quicker 磁盘表情包（重启清网页库也不丢）=====
  var _packDir = '';
  var _pendingPackMeta = null;
  var _diskOk = Object.create(null); // 本会话已确认落盘的 hex，避免重复写
  function isQuickerHost() {
    return typeof window.$quickerSp === 'function';
  }
  function fileOp(mode, extra) {
    if (!isQuickerHost()) return Promise.resolve(null);
    return window.$quickerSp('FileOp', Object.assign({ mode: mode }, extra || {})).then(function (r) {
      return r && r.result !== undefined ? r.result : r;
    }).catch(function () { return null; });
  }
  function resolvePackDir() {
    if (_packDir) return Promise.resolve(_packDir);
    if (!isQuickerHost()) return Promise.resolve('');
    return fileOp('readFile', { path: '::documents::', isBinary: 'false' }).then(function (docs) {
      if (typeof docs !== 'string' || !docs) return '';
      _packDir = docs.replace(/[\\/]+$/, '') + '\\ZhiNote\\twemoji';
      return _packDir;
    });
  }
  function diskWriteSvg(hex, text) {
    if (!hex || !text || _diskOk[hex]) return Promise.resolve();
    return resolvePackDir().then(function (dir) {
      if (!dir) return;
      return fileOp('ensureDir', { path: dir }).then(function () {
        return fileOp('writeFile', { path: dir + '\\' + hex + '.svg', content: text, isBinary: 'false' });
      }).then(function () { _diskOk[hex] = 1; });
    }).catch(function () {});
  }
  function diskReadSvg(hex) {
    if (!hex) return Promise.resolve(null);
    if (_diskOk[hex] === 0) return Promise.resolve(null);
    return resolvePackDir().then(function (dir) {
      if (!dir) return null;
      return fileOp('readFile', { path: dir + '\\' + hex + '.svg', isBinary: 'false' }).then(function (t) {
        if (typeof t === 'string' && t.indexOf('<svg') >= 0) {
          _diskOk[hex] = 1;
          return t;
        }
        return null;
      });
    }).catch(function () { return null; });
  }
  function diskWriteMeta(payload) {
    return resolvePackDir().then(function (dir) {
      if (!dir) return;
      return fileOp('ensureDir', { path: dir }).then(function () {
        return fileOp('writeFile', {
          path: dir + '\\pack-meta.json',
          content: JSON.stringify(payload),
          isBinary: 'false',
        });
      });
    }).catch(function () {});
  }
  function diskReadMeta() {
    return resolvePackDir().then(function (dir) {
      if (!dir) return null;
      return fileOp('readFile', { path: dir + '\\pack-meta.json', isBinary: 'false' }).then(function (t) {
        if (typeof t !== 'string' || !t) return null;
        try { return JSON.parse(t); } catch (_) { return null; }
      });
    }).catch(function () { return null; });
  }
  function diskWriteList(jsonText) {
    if (!jsonText) return Promise.resolve();
    return resolvePackDir().then(function (dir) {
      if (!dir) return;
      return fileOp('ensureDir', { path: dir }).then(function () {
        return fileOp('writeFile', {
          path: dir + '\\pack-list.json',
          content: jsonText,
          isBinary: 'false',
        });
      });
    }).catch(function () {});
  }
  function diskReadList() {
    return resolvePackDir().then(function (dir) {
      if (!dir) return null;
      return fileOp('readFile', { path: dir + '\\pack-list.json', isBinary: 'false' }).then(function (t) {
        return (typeof t === 'string' && t.length > 20) ? t : null;
      });
    }).catch(function () { return null; });
  }
  function parseListText(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
      var parsed = JSON.parse(text);
      return (Array.isArray(parsed) && parsed.length) ? parsed : null;
    } catch (_) { return null; }
  }
  function persistList(list) {
    if (!list || !list.length) return;
    var text = JSON.stringify(list);
    try { idbPut(LIST_KEY, text); } catch (_) {}
    diskWriteList(text);
  }

  function svgExistsAnywhere(u) {
    var h = toDashHex(u, false);
    if (_memUrl[h]) return Promise.resolve(true);
    return idbGet(svgKey(u)).then(function (v) {
      if (typeof v === 'string' && v.indexOf('<svg') >= 0) return true;
      return diskReadSvg(h).then(function (t) { return !!t; });
    });
  }

  /** 多点抽查：至少命中 1 个才算包还在（避免首条失败就误判重下） */
  function verifyPackPresent(list) {
    if (!list || !list.length) return Promise.resolve(false);
    var idxs = [0, Math.floor(list.length * 0.1), Math.floor(list.length * 0.5), Math.floor(list.length * 0.9), list.length - 1];
    var samples = [];
    var seen = Object.create(null);
    idxs.forEach(function (i) {
      var u = list[i] && list[i].unicode;
      if (!u || seen[u]) return;
      seen[u] = 1;
      samples.push(u);
    });
    var i = 0;
    function next() {
      if (i >= samples.length) return Promise.resolve(false);
      var u = samples[i++];
      return svgExistsAnywhere(u).then(function (ok) { return ok ? true : next(); });
    }
    return next();
  }

  function pickBestMeta(candidates) {
    var best = null;
    (candidates || []).forEach(function (m) {
      if (!m || typeof m !== 'object') return;
      if (!best) { best = m; return; }
      if (!!m.done && !best.done) { best = m; return; }
      if (!!m.done === !!best.done && (m.t | 0) > (best.t | 0)) best = m;
    });
    return best;
  }

  function loadPackMeta() {
    if (_packMetaReady) return Promise.resolve();
    if (_packMetaP) return _packMetaP;
    _packMetaP = Promise.all([
      idbGet(PACK_META_KEY).catch(function () { return null; }),
      Promise.resolve().then(function () {
        try {
          return window.storage && window.storage.getSetting
            ? window.storage.getSetting('_emojiPackMeta')
            : null;
        } catch (_) { return null; }
      }),
      diskReadMeta(),
    ]).then(function (arr) {
      applyPackMeta(pickBestMeta(arr));
    }).then(function () {
      if (!_pack.done) return;
      return loadData().then(function (list) {
        return verifyPackPresent(list).then(function (ok) {
          if (ok) return;
          _pack.done = false;
          _pack.have = 0;
        });
      });
    }).catch(function () {}).then(function () {
      _packMetaReady = true;
      flushPendingPackMeta();
    });
    return _packMetaP;
  }

  function flushPendingPackMeta() {
    if (!_pendingPackMeta) return;
    try {
      if (!window.storage || !window.storage.setSetting) return;
      // storage 未 init 时 setSetting 会静默丢掉；用 getSetting 探一下
      if (window.storage.getSetting('theme') === undefined &&
          window.storage.getSetting('lastOpenedId') === undefined) {
        return;
      }
      window.storage.setSetting('_emojiPackMeta', _pendingPackMeta);
      _pendingPackMeta = null;
    } catch (_) {}
  }

  function savePackMeta() {
    var payload = {
      ver: TWEMOJI_VER,
      done: !!_pack.done,
      have: _pack.have | 0,
      total: _pack.total | 0,
      t: Date.now(),
    };
    idbPut(PACK_META_KEY, payload);
    diskWriteMeta(payload);
    _pendingPackMeta = payload;
    flushPendingPackMeta();
  }

  function syncBusy() {
    try {
      return !!(window.webdavSync && typeof window.webdavSync.isSyncing === 'function' && window.webdavSync.isSyncing());
    } catch (_) { return false; }
  }

  /** 后台限流下载全包到本机；须等元数据就绪，已完成则静默跳过 */
  function startPackDownload() {
    if (_pack.running) return;
    if (!_packMetaReady) {
      loadPackMeta().then(function () { startPackDownload(); });
      return;
    }
    if (_pack.done) return;
    if (!isOnline()) return;
    _pack.running = true;
    loadData().then(function (list) {
      var seen = Object.create(null);
      var queue = [];
      (list || []).forEach(function (em) {
        var u = em.unicode;
        if (!u || seen[u]) return;
        seen[u] = 1;
        queue.push(u);
      });
      recentList().forEach(function (u) {
        if (!u || seen[u]) return;
        seen[u] = 1;
        queue.push(u);
      });
      _pack.total = queue.length;
      if (_pack.total > 0 && _pack.have >= _pack.total) {
        _pack.done = true;
        _pack.running = false;
        savePackMeta();
        refreshPackHint();
        return;
      }
      var idx = 0;
      var conc = 2; // 降低并发，少抢同步网络
      var active = 0;
      var finished = 0;
      _pack.downloading = false;

      function tick() {
        if (!isOnline()) {
          _pack.running = false;
          _pack.have = Math.max(_pack.have, finished);
          savePackMeta();
          refreshPackHint();
          return;
        }
        // 同步进行中则让路，稍后再继续（减轻 Failed to fetch）
        if (syncBusy()) {
          setTimeout(function () { if (_pack.running) tick(); }, 1200);
          return;
        }
        while (active < conc && idx < queue.length) {
          (function (u) {
            active++;
            ensureCached(u).then(function (src) {
              active--;
              finished++;
              if (src === 'net') _pack.downloading = true;
              _pack.have = finished;
              if (_pack.downloading && finished % 16 === 0) {
                savePackMeta();
                refreshPackHint();
              }
              if (idx >= queue.length && active === 0) {
                _pack.running = false;
                _pack.downloading = false;
                _pack.done = true;
                _pack.have = _pack.total;
                savePackMeta();
                refreshPackHint();
                return;
              }
              tick();
            });
          })(queue[idx++]);
        }
      }
      refreshPackHint();
      tick();
    }).catch(function () {
      _pack.running = false;
      _pack.downloading = false;
    });
  }

  function rebuildGroups() {
    _byGroup = Object.create(null);
    _groupOrder = [];
    if (!_data || !_data.length) return;
    var seen = Object.create(null);
    for (var i = 0; i < _data.length; i++) {
      var em = _data[i];
      var g = em.group || '其它';
      if (!_byGroup[g]) {
        _byGroup[g] = [];
        if (!seen[g]) { seen[g] = 1; _groupOrder.push(g); }
      }
      _byGroup[g].push(em);
    }
    var order = Object.keys(GROUP_LABELS).map(function (k) { return GROUP_LABELS[k]; }).concat(['其它']);
    _groupOrder.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia < 0) ia = 999;
      if (ib < 0) ib = 999;
      return ia - ib || (a < b ? -1 : a > b ? 1 : 0);
    });
  }

  function setData(list) {
    _data = list;
    rebuildGroups();
    return _data;
  }

  function loadData() {
    if (_data) {
      if (!_byGroup) rebuildGroups();
      return Promise.resolve(_data);
    }
    if (_dataP) return _dataP;
    // Quicker：本机文件夹优先 → 网页库 → 联网下载并落盘；网页版：网页库 → 联网
    _dataP = Promise.resolve().then(function () {
      return isQuickerHost() ? diskReadList() : null;
    }).then(function (diskText) {
      var list = parseListText(diskText);
      if (list) return setData(list);
      return idbGet(LIST_KEY).then(function (cached) {
        list = parseListText(cached);
        if (list) {
          if (isQuickerHost()) diskWriteList(cached);
          return setData(list);
        }
        return idbGet('list:emojibase-zh@2').then(function (old) {
          list = parseListText(old);
          if (list) {
            persistList(list);
            return setData(list);
          }
          if (!isOnline()) throw new Error('emoji-data-offline');
          return fetch(DATA_URL)
            .then(function (r) { if (!r.ok) throw 0; return r.json(); })
            .then(function (raw) {
              list = normalizeRaw(raw);
              persistList(list);
              return setData(list);
            });
        });
      });
    }).catch(function () {
      _dataP = null;
      throw new Error('emoji-data');
    });
    return _dataP;
  }

  function prefetch() {
    loadPackMeta().then(function () {
      return loadData();
    }).then(function () {
      startPackDownload();
    }).catch(function () {});
  }

  function recentList() {
    try {
      var list = window.storage && window.storage.getSetting ? window.storage.getSetting('recentEmojis') : null;
      return Array.isArray(list) ? list.filter(Boolean) : [];
    } catch (_) { return []; }
  }
  function recordRecent(u) {
    try {
      var list = recentList().filter(function (x) { return x !== u; });
      list.unshift(u);
      if (list.length > 64) list = list.slice(0, 64);
      if (window.storage && window.storage.setSetting) window.storage.setSetting('recentEmojis', list);
      ensureCached(u);
    } catch (_) {}
  }

  function vh() {
    return (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  }

  function saveScroll() {
    if (!_pop) return;
    var g = _pop.querySelector('.eui-grid');
    var c = _pop.querySelector('.eui-cats');
    var r = _pop.querySelector('.eui-recent-grid');
    if (g) _scroll.grid = g.scrollTop;
    if (c) _scroll.cats = c.scrollLeft;
    if (r) _scroll.recent = r.scrollLeft;
  }
  function restoreScroll() {
    if (!_pop) return;
    var g = _pop.querySelector('.eui-grid');
    var c = _pop.querySelector('.eui-cats');
    var r = _pop.querySelector('.eui-recent-grid');
    if (g) g.scrollTop = _scroll.grid;
    if (c) c.scrollLeft = _scroll.cats;
    if (r) r.scrollLeft = _scroll.recent;
  }

  function close() {
    if (!_pop) return;
    saveScroll();
    _pop.classList.add('hidden');
    _pop.innerHTML = '';
    _pop.style.maxHeight = '';
    if (_onDoc) document.removeEventListener('mousedown', _onDoc, true);
    if (_onKey) document.removeEventListener('keydown', _onKey, true);
    _onDoc = _onKey = null;
    var o = _opts;
    _opts = null;
    _anchorEl = null;
    if (o && o.onClose) try { o.onClose(); } catch (_) {}
  }

  function groupsOf() {
    if (_groupOrder && _groupOrder.length) return _groupOrder.slice();
    return [];
  }

  function filtered() {
    var qq = (_q || '').trim().toLowerCase();
    // 无搜索：按当前分类翻（切标签 O(1)）
    if (!qq) {
      if (_cat && _byGroup && _byGroup[_cat]) return _byGroup[_cat];
      return _data || [];
    }
    // 有搜索：搜全部（emoji-mart / emoji-picker-element 同款），不限当前标签
    var base = _data || [];
    return base.filter(function (em) {
      var hay = ((em.annotation || '') + ' ' + (em.tags || []).join(' ') + ' ' + (em.shortcodes || []).join(' ')).toLowerCase();
      return hay.indexOf(qq) >= 0 || (em.unicode || '').indexOf(qq) >= 0;
    });
  }

  /** 格子：Twemoji 图；失败则格子里显示系统脸（.eui-ph 放字符）。可视区 eager */
  function cellHtml(u, title) {
    var src = displayUrl(u);
    var img = src
      ? ('<img width="22" height="22" loading="eager" decoding="async" alt="" data-u="' + esc(u) + '"'
        + ' src="' + esc(src) + '" data-fb="' + esc(twemojiUrlFe0f(u)) + '">')
      : '';
    return '<button type="button" class="eui-cell' + (src ? '' : ' eui-miss') + '" data-e="' + esc(u) + '" title="' + esc(title || u) + '">'
      + img
      + '<span class="eui-ph" aria-hidden="true">' + esc(u) + '</span>'
      + '</button>';
  }

  function onImgError(img) {
    if (!img || !img.getAttribute) return;
    var u = img.getAttribute('data-u') || '';
    var step = img.getAttribute('data-err') || '0';
    var cell = img.parentElement;

    if (step === '0') {
      // 先试带/不带 fe0f 的另一候选（candidates 顺序可能已试过第一个）
      var alts = twemojiCandidates(u);
      var cur = img.getAttribute('src') || '';
      var next = '';
      for (var i = 0; i < alts.length; i++) {
        if (alts[i] && alts[i] !== cur) { next = alts[i]; break; }
      }
      if (next) {
        img.setAttribute('data-err', '1');
        img.src = next;
        return;
      }
      img.setAttribute('data-err', '1');
    }

    if (step === '1' || img.getAttribute('data-err') === '1') {
      img.setAttribute('data-err', '2');
      ensureCached(u).then(function (ok) {
        var loc = localUrlSync(u);
        if (ok && loc && img.isConnected) {
          img.classList.remove('eui-gone');
          if (cell) cell.classList.remove('eui-miss');
          img.src = loc;
          return;
        }
        if (cell) cell.classList.add('eui-miss');
        try { img.classList.add('eui-gone'); } catch (_) {}
      });
      return;
    }

    if (cell) cell.classList.add('eui-miss');
    try { img.classList.add('eui-gone'); } catch (_) {}
  }

  function bindHScroll(el) {
    if (!el) return;
    el.addEventListener('wheel', function (e) {
      if (el.scrollWidth <= el.clientWidth + 1) return;
      e.preventDefault();
      el.scrollLeft += (e.deltaY || e.deltaX);
    }, { passive: false });
  }

  function syncHFade(wrap, scroller) {
    if (!wrap || !scroller) return;
    var max = scroller.scrollWidth - scroller.clientWidth;
    var can = max > 4;
    wrap.classList.toggle('fade-l', can && scroller.scrollLeft > 2);
    wrap.classList.toggle('fade-r', can && scroller.scrollLeft < max - 2);
    wrap.classList.toggle('can-scroll', can);
  }
  function bindHFade(wrap, scroller) {
    if (!wrap || !scroller) return;
    bindHScroll(scroller);
    var tick = function () { syncHFade(wrap, scroller); };
    scroller.addEventListener('scroll', tick, { passive: true });
    requestAnimationFrame(tick);
  }

  function caretRect() {
    try {
      var sel = window.getSelection();
      if (sel && sel.rangeCount) {
        var range = sel.getRangeAt(0).cloneRange();
        if (!range.collapsed) range.collapse(false);
        var rects = range.getClientRects();
        if (rects && rects.length) return rects[rects.length - 1];
        var br = range.getBoundingClientRect();
        if (br && (br.top || br.left || br.width || br.height)) return br;
      }
    } catch (_) {}
    try {
      var ed = window.editor;
      if (ed && ed.view) {
        var c = ed.view.coordsAtPos(ed.state.selection.from);
        if (c) {
          return {
            left: c.left, right: c.right, top: c.top, bottom: c.bottom,
            width: Math.max(0, c.right - c.left), height: Math.max(1, c.bottom - c.top),
          };
        }
      }
    } catch (_) {}
    return null;
  }

  function position(anchorEl) {
    if (anchorEl) _anchorEl = anchorEl;
    var pop = _pop;
    if (!pop) return;
    var pad = 8;
    var gap = 6;
    var r = null;
    // 插入模式优先跟光标，避免挡住刚输入的表情
    if (_opts && _opts.mode === 'insert') r = caretRect();
    if (!r && _anchorEl && _anchorEl.getBoundingClientRect) r = _anchorEl.getBoundingClientRect();
    if (!r || (!r.left && !r.top && !r.width && !r.height && !r.bottom)) {
      var edEl = document.querySelector('#editor .ProseMirror') || document.querySelector('#editor') || document.body;
      var er = edEl.getBoundingClientRect();
      r = { left: er.left + 80, top: er.top + 80, bottom: er.top + 100, right: er.left + 80, width: 0, height: 20 };
    }
    var spaceBelow = vh() - r.bottom - pad - gap;
    var spaceAbove = r.top - pad - gap;
    var placeAbove = spaceAbove > spaceBelow;
    var maxH = Math.max(160, Math.min(420, placeAbove ? spaceAbove : spaceBelow));
    pop.style.maxHeight = Math.round(maxH) + 'px';
    var pw = pop.offsetWidth || 320;
    var ph = Math.min(pop.offsetHeight || maxH, maxH);
    var left = r.left;
    if (left + pw > window.innerWidth - pad) left = window.innerWidth - pw - pad;
    if (left < pad) left = pad;
    var top;
    if (placeAbove) {
      top = r.top - gap - ph;
      if (top < pad) top = pad;
    } else {
      top = r.bottom + gap;
      if (top + ph > vh() - pad) top = Math.max(pad, vh() - ph - pad);
    }
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  }

  var _renderGen = 0;

  function moreHtml() {
    if (_gridShown >= _gridList.length) return '';
    return '<div class="eui-more">向下滚动加载更多 · 已显示 ' + _gridShown + ' / ' + _gridList.length + '</div>';
  }

  function gridHtml(slice) {
    return slice.map(function (em) {
      return cellHtml(em.unicode, em.annotation || em.unicode);
    }).join('') + moreHtml();
  }

  /** 只暖当前屏 + 最近，避免一次暖几百个拖慢 */
  function warmVisible(slice, recent) {
    var list = (slice || []).map(function (em) { return em.unicode; }).concat(recent || []);
    return warmMany(list).then(function () {
      list.forEach(function (u) { ensureCached(u); });
    });
  }

  function cellsHtml(slice) {
    return (slice || []).map(function (em) {
      return cellHtml(em.unicode, em.annotation || em.unicode);
    }).join('');
  }

  function bindGridScroll() {
    var grid = _pop && _pop.querySelector('.eui-grid');
    if (!grid || grid._euiScrollBound) return;
    grid._euiScrollBound = 1;
    grid.addEventListener('scroll', function () {
      if (!_pop || !_opts) return;
      if (_gridShown >= _gridList.length) return;
      if (grid.scrollTop + grid.clientHeight < grid.scrollHeight - 48) return;
      var prev = _gridShown;
      _gridShown = Math.min(_gridList.length, _gridShown + PAGE);
      var add = _gridList.slice(prev, _gridShown);
      if (!add.length) return;
      var tip = grid.querySelector('.eui-more');
      if (tip) tip.remove();
      var gen = _renderGen;
      grid.insertAdjacentHTML('beforeend', cellsHtml(add) + moreHtml());
      warmVisible(add, []).then(function () {
        if (gen !== _renderGen || !_pop) return;
        patchImgsToLocal(grid);
      });
    }, { passive: true });
  }

  function syncCatButtons() {
    if (!_pop) return;
    _pop.querySelectorAll('.eui-cat').forEach(function (b) {
      b.classList.toggle('on', (b.getAttribute('data-cat') || '') === _cat);
    });
  }

  function fillRecentDom() {
    var host = _pop && _pop.querySelector('.eui-recent-slot');
    if (!host) return;
    var recent = recentList();
    if (!recent.length) {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.innerHTML = '<div class="eui-recent"><div class="eui-recent-label">最近</div>'
      + '<div class="eui-hfade"><div class="eui-recent-grid">'
      + recent.map(function (u) { return cellHtml(u, u); }).join('')
      + '</div></div></div>';
    var recentGrid = host.querySelector('.eui-recent-grid');
    if (recentGrid) bindHFade(recentGrid.parentElement, recentGrid);
  }

  function bindShellHandlers() {
    if (!_pop || _pop._euiShellBound) return;
    _pop._euiShellBound = 1;
    _pop.addEventListener('input', function (e) {
      if (!e.target || !e.target.classList.contains('eui-q')) return;
      var qEl = e.target;
      _q = qEl.value;
      clearTimeout(qEl._t);
      qEl._t = setTimeout(function () {
        renderBody({ onlyGrid: true, resetGridScroll: true });
      }, 100);
    });
    _pop.addEventListener('click', function (e) {
      var cat = e.target.closest('.eui-cat');
      if (cat && _pop.contains(cat)) {
        var next = cat.getAttribute('data-cat') || '';
        if (next === _cat && !_q) return;
        _cat = next;
        _q = '';
        var qEl = _pop.querySelector('.eui-q');
        if (qEl) qEl.value = '';
        renderBody({ onlyGrid: true, resetGridScroll: true });
        return;
      }
      var actBtn = e.target.closest('[data-act]');
      if (actBtn && _pop.contains(actBtn)) {
        var act = actBtn.getAttribute('data-act');
        var custom = _pop.querySelector('.eui-custom');
        if (act === 'custom' && custom) {
          var v = custom.value.trim();
          if (v) pick(v);
        } else if (act === 'reset') {
          pick(_opts.defaultIcon || '');
        }
      }
    });
    _pop.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (!e.target || !e.target.classList.contains('eui-custom')) return;
      e.preventDefault();
      var v = e.target.value.trim();
      if (v) pick(v);
    });
  }

  /**
   * @param {{ focusSearch?: boolean, resetGridScroll?: boolean, onlyGrid?: boolean, refreshRecent?: boolean }} flags
   */
  function renderBody(flags) {
    if (!_pop || !_data || !_opts) return;
    flags = flags || {};
    saveScroll();
    if (flags.resetGridScroll) _scroll.grid = 0;
    clearSoftFails();

    var groups = groupsOf();
    if (!_cat && groups.length) _cat = groups[0];
    _gridList = filtered();
    // 切分类/搜索/首开：只画一屏；滚动再补
    if (!flags.onlyGrid || flags.resetGridScroll || !_gridShown) {
      _gridShown = Math.min(PAGE, _gridList.length);
    } else {
      _gridShown = Math.min(Math.max(_gridShown, PAGE), _gridList.length);
    }
    var slice = _gridList.slice(0, _gridShown);
    var recent = recentList();
    var gen = ++_renderGen;

    function paint() {
      if (gen !== _renderGen || !_pop || !_opts) return;

      if (flags.onlyGrid && _pop.querySelector('.eui-grid')) {
        syncCatButtons();
        var grid = _pop.querySelector('.eui-grid');
        grid.innerHTML = gridHtml(slice);
        if (flags.refreshRecent) fillRecentDom();
        restoreScroll();
        refreshPackHint();
        bindGridScroll();
        startPackDownload();
        return;
      }

      var pickBar = '';
      if (_opts.mode === 'pick') {
        pickBar = '<div class="eui-pickbar">'
          + '<input type="text" class="eui-custom" maxlength="8" value="' + esc(_opts.currentIcon || '') + '" placeholder="自定义字符">'
          + '<button type="button" class="eui-btn" data-act="custom" title="确认自定义">✓</button>'
          + '<button type="button" class="eui-btn" data-act="reset" title="恢复默认">↺</button>'
          + '</div>';
      }
      var catsHtml = '<div class="eui-hfade eui-cats-wrap"><div class="eui-cats">' + groups.map(function (g) {
        return '<button type="button" class="eui-cat' + (g === _cat ? ' on' : '') + '" data-cat="' + esc(g) + '">' + esc(g) + '</button>';
      }).join('') + '</div></div>';

      _pop.innerHTML =
        '<div class="eui-head">'
        + (_opts.title ? '<div class="eui-title">' + esc(_opts.title) + '</div>' : '')
        + '<input type="search" class="eui-q" placeholder="搜索全部：笑 / 猫 / heart…" value="' + esc(_q) + '" autocomplete="off">'
        + '</div>'
        + pickBar
        + '<div class="eui-recent-slot"></div>'
        + catsHtml
        + '<div class="eui-grid">' + gridHtml(slice) + '</div>'
        + '<div class="eui-foot" title="署名与许可">' + esc(packHintText()) + '</div>';

      _pop._euiShellBound = 0;
      bindShellHandlers();
      fillRecentDom();
      restoreScroll();
      bindGridScroll();
      var cats = _pop.querySelector('.eui-cats');
      if (cats) bindHFade(cats.parentElement, cats);

      if (flags.focusSearch) {
        var qEl = _pop.querySelector('.eui-q');
        if (qEl) setTimeout(function () { try { qEl.focus(); } catch (_) {} }, 30);
      }

      startPackDownload();
    }

    // 立刻上屏；只暖当前屏+最近
    paint();
    warmVisible(slice, flags.onlyGrid ? [] : recent).then(function () {
      if (gen !== _renderGen || !_pop) return;
      patchImgsToLocal(_pop.querySelector('.eui-grid'));
      if (!flags.onlyGrid) patchImgsToLocal(_pop.querySelector('.eui-recent-slot'));
    });
  }

  /** 把仍指向 CDN 的 img 换成会话内稳定 blob（不整表重建，避免闪） */
  function patchImgsToLocal(root) {
    if (!root) return;
    root.querySelectorAll('img[data-u]').forEach(function (img) {
      var u = img.getAttribute('data-u');
      var loc = localUrlSync(u);
      if (!loc) return;
      var cur = img.getAttribute('src') || '';
      if (cur.indexOf('blob:') === 0) return;
      img.src = loc;
    });
  }

  function pick(u) {
    if (!_opts) return;
    var mode = _opts.mode;
    var onPick = _opts.onPick;
    ensureCached(u);
    if (mode === 'insert') {
      recordRecent(u);
      if (onPick) onPick(u);
      // 插入后光标下移，窗口跟随，避免挡住刚插入的内容
      requestAnimationFrame(function () {
        if (_pop && _opts && _opts.mode === 'insert') position(_anchorEl);
      });
      // 只刷新最近栏，不动网格
      warmMany([u]).then(function () { fillRecentDom(); });
    } else {
      recordRecent(u);
      close();
      if (onPick) onPick(u);
    }
  }

  function open(anchorEl, opts) {
    opts = opts || {};
    close();
    _opts = opts;
    _anchorEl = anchorEl || null;
    _q = '';
    _cat = '';
    _scroll = { grid: 0, cats: 0, recent: 0 };
    // 每次打开：硬失败再给一次机会
    retryHardAgain();
    var pop = document.getElementById('emoji-popover');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'emoji-popover';
      document.body.appendChild(pop);
    }
    _pop = pop;
    pop.className = 'eui-pop';
    pop.classList.remove('hidden');
    pop.style.visibility = 'hidden';

    if (_data) {
      renderBody({ focusSearch: true, resetGridScroll: true });
      requestAnimationFrame(function () {
        position(anchorEl);
        pop.style.visibility = 'visible';
      });
    } else {
      pop.innerHTML = '<div class="eui-loading">加载表情清单…</div>';
      loadData().then(function () {
        if (_opts !== opts) return;
        renderBody({ focusSearch: true, resetGridScroll: true });
        requestAnimationFrame(function () {
          position(anchorEl);
          pop.style.visibility = 'visible';
        });
      }).catch(function () {
        pop.innerHTML = '<div class="eui-loading">表情清单未就绪。请先联网一次下载到本机，之后离线也可使用。</div>';
        pop.style.visibility = 'visible';
        position(anchorEl);
      });
    }

    pop.onclick = function (e) {
      var cell = e.target.closest('.eui-cell');
      if (!cell || !_pop.contains(cell)) return;
      var u = cell.getAttribute('data-e');
      if (u) pick(u);
    };
    if (!pop._euiErrBound) {
      pop._euiErrBound = 1;
      pop.addEventListener('error', function (e) {
        var t = e.target;
        if (t && t.tagName === 'IMG' && t.getAttribute('data-u') && pop.contains(t)) onImgError(t);
      }, true);
    }

    _onDoc = function (e) {
      if (!_pop) return;
      if (_pop.contains(e.target)) return;
      if (anchorEl && (e.target === anchorEl || (anchorEl.contains && anchorEl.contains(e.target)))) return;
      close();
    };
    _onKey = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    setTimeout(function () {
      document.addEventListener('mousedown', _onDoc, true);
      document.addEventListener('keydown', _onKey, true);
    }, 0);
  }

  function openInsert(anchorEl, onInsert, onClose) {
    open(anchorEl, {
      mode: 'insert',
      title: '',
      onPick: onInsert,
      onClose: onClose,
    });
  }

  function openPick(anchorEl, opts) {
    open(anchorEl, {
      mode: 'pick',
      title: (opts && opts.title) || '选择图标',
      currentIcon: (opts && opts.currentIcon) || '',
      defaultIcon: (opts && opts.defaultIcon) || '',
      onPick: opts && opts.onPick,
      onClose: opts && opts.onClose,
    });
  }

  function isOpen() {
    return !!( _pop && !_pop.classList.contains('hidden') );
  }

  // ===== 侧栏/图标：Twemoji 底图，文字透明（绝不露系统脸）=====
  var ICON_SEL = '.tree-note-icon, .ws-icon, .ws-icon-btn, .ws-icon-pick-btn, .titlebar-app-icon, .mascot-picker-ico, .ctx-icon-emoji, .cmd-item-icon, .zn-twemoji-icon';

  function looksLikeEmoji(s) {
    if (!s || typeof s !== 'string') return false;
    var t = s.trim();
    // 组合表情（家庭/职业等）UTF-16 长度可超过 16
    if (!t || t.length > 48) return false;
    try {
      return /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}\u{1F000}-\u{1F0FF}]/u.test(t);
    } catch (_) {
      return /[^\x00-\x7f]/.test(t);
    }
  }

  function paintIcon(el, ch) {
    if (!el) return;
    var u = ch == null ? (el.getAttribute('data-emoji') || el.textContent || '') : String(ch);
    u = u.trim();
    el.textContent = u;
    if (!looksLikeEmoji(u)) {
      el.classList.remove('zn-twemoji-icon', 'is-native');
      el.removeAttribute('data-emoji');
      try { el.style.removeProperty('background-image'); } catch (_) {}
      return;
    }
    el.setAttribute('data-emoji', u);
    function showTwemoji(url) {
      el.classList.add('zn-twemoji-icon');
      el.classList.remove('is-native');
      el.style.setProperty('background-image', 'url("' + url + '")', 'important');
    }
    function showNative() {
      // Twemoji 实在没有：露系统脸，总比永久灰块强
      el.classList.remove('zn-twemoji-icon');
      el.classList.add('is-native');
      try { el.style.removeProperty('background-image'); } catch (_) {}
    }
    var url = displayUrl(u);
    if (url) showTwemoji(url);
    else showNative();
    ensureCached(u).then(function (ok) {
      if (!el.isConnected) return;
      if (!ok) { showNative(); return; }
      var loc = localUrlSync(u) || displayUrl(u);
      if (loc) showTwemoji(loc);
      else showNative();
    });
  }

  function paintAll(root) {
    try {
      var scope = root && root.querySelectorAll ? root : document;
      scope.querySelectorAll(ICON_SEL).forEach(function (el) {
        paintIcon(el, el.getAttribute('data-emoji') || el.textContent);
      });
    } catch (_) {}
  }

  function iconHtml(ch, className) {
    var u = ch == null ? '' : String(ch);
    var cls = (className || '').trim();
    if (!looksLikeEmoji(u)) {
      return '<span class="' + esc(cls) + '">' + esc(u) + '</span>';
    }
    var url = displayUrl(u) || localUrlSync(u);
    var style = url
      ? ' style="background-image:url(\'' + url.replace(/'/g, '%27') + '\')"'
      : '';
    ensureCached(u);
    return '<span class="' + esc(cls + ' zn-twemoji-icon') + '" data-emoji="' + esc(u) + '"' + style + '>' + esc(u) + '</span>';
  }

  window.emojiUi = {
    openInsert: openInsert,
    openPick: openPick,
    close: close,
    isOpen: isOpen,
    prefetch: prefetch,
    twemojiUrl: twemojiUrl,
    displayUrl: displayUrl,
    ensureCached: ensureCached,
    warmMany: warmMany,
    paintIcon: paintIcon,
    paintAll: paintAll,
    iconHtml: iconHtml,
    looksLikeEmoji: looksLikeEmoji,
    ATTR: ATTR,
  };

  /** 钉版本日常用；远程有更新时只抬版本并补缺图，绝不碰笔记同步 */
  function _semverParts(v) {
    return String(v || '').replace(/^v/i, '').split(/[.+-]/).map(function (x) { return parseInt(x, 10) || 0; });
  }
  function _semverGt(a, b) {
    var pa = _semverParts(a), pb = _semverParts(b), i;
    for (i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  }
  function applyTwemojiVer(ver) {
    ver = String(ver || '').replace(/^v/i, '');
    if (!ver || ver === TWEMOJI_VER || !_semverGt(ver, TWEMOJI_VER)) return false;
    TWEMOJI_VER = ver;
    TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@' + TWEMOJI_VER + '/assets/svg/';
    PACK_META_KEY = 'pack:meta@' + TWEMOJI_VER;
    _failHard = Object.create(null);
    _failSoft = Object.create(null);
    _cdnHit = Object.create(null);
    _pack.done = false;
    _pack.running = false;
    _packMetaReady = false;
    _packMetaP = null;
    // 已有本机图继续用；ensureCached 只补新版才有的缺图。元数据本机 _ 前缀，不上云。
    loadPackMeta().then(function () { startPackDownload(); });
    return true;
  }
  var _twCheckAt = 0;
  function checkTwemojiRemoteUpdate() {
    if (!isOnline()) return;
    if (syncBusy()) {
      setTimeout(checkTwemojiRemoteUpdate, 10000);
      return;
    }
    var now = Date.now();
    if (_twCheckAt && now - _twCheckAt < 12 * 3600 * 1000) return;
    _twCheckAt = now;
    fetch('https://data.jsdelivr.com/v1/packages/gh/jdecked/twemoji', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j.versions)) return;
        var best = TWEMOJI_VER;
        j.versions.forEach(function (item) {
          var v = item && item.version;
          if (v && _semverGt(v, best)) best = String(v).replace(/^v/i, '');
        });
        if (_semverGt(best, TWEMOJI_VER)) applyTwemojiVer(best);
      })
      .catch(function () {});
  }

  function schedulePrefetch() {
    var run = function () { setTimeout(prefetch, 800); };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(function () { prefetch(); }, { timeout: 3000 });
    } else if (document.readyState === 'complete') {
      run();
    } else {
      window.addEventListener('load', run);
    }
    window.addEventListener('online', function () {
      _pack.running = false;
      startPackDownload();
      checkTwemojiRemoteUpdate();
      if (_pop) renderBody({ onlyGrid: true, resetGridScroll: false });
    });
    // 闲时查图源更新（让路同步）；只补新图、不上传笔记
    setTimeout(function () { checkTwemojiRemoteUpdate(); }, 12000);
    // storage 晚于表情脚本 init 时，补写被暂存的备份元数据
    var n = 0;
    var metaTimer = setInterval(function () {
      flushPendingPackMeta();
      if (++n >= 30 || !_pendingPackMeta) clearInterval(metaTimer);
    }, 1000);
  }
  schedulePrefetch();
})();
