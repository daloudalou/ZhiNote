/**
 * 引用 / 链接：@ 菜单 + 胶囊 / 通栏 插入与互转。
 * 节点定义在 editor.js（znMention / znPageLink）；本文件管选择器、悬停卡、打开、互转。
 */
(function () {
  'use strict';

  var _pick = null;
  var _items = [];
  var _hi = 0;
  var _query = '';
  var _asBlock = false;
  var _rangeFrom = 0;
  var _rangeTo = 0;
  var _hasRange = false;
  var _hover = null;
  var _hoverTimer = 0;
  var _hoverLeave = 0;
  var _browse = false;
  var _browseWs = '';
  var _replacePos = null;
  var _ogCache = {};
  var _pickLockH = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ed() {
    try { return window.editor && window.editor.instance && window.editor.instance(); } catch (_) { return null; }
  }
  function mascotOn() {
    try { return !!(window.mascot && window.mascot.isEnabled && window.mascot.isEnabled()); } catch (_) { return false; }
  }
  function hostOf(href) {
    try { return new URL(href).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }
  function urlShowHost() {
    try { return !!(window.storage && window.storage.getSetting && window.storage.getSetting('urlShowHost')); }
    catch (_) { return false; }
  }
  function urlOpenTarget() {
    var v = '';
    try { v = (window.storage && window.storage.getSetting && window.storage.getSetting('urlOpenBrowser')) || ''; }
    catch (_) { v = ''; }
    if (v === 'app') return { kind: 'app' };
    if (v === 'webview') return { kind: 'webview' };
    if (v === 'default') return { kind: 'default' };
    if (v) return { kind: 'exe', exe: v };
    try {
      if (window.storage && window.storage.getSetting && window.storage.getSetting('urlOpenInBrowser')) {
        return { kind: 'default' };
      }
    } catch (_) {}
    return { kind: canOpenInSysBrowser() ? 'webview' : 'app' };
  }
  function canOpenInSysBrowser() {
    return !!(window.host && window.host.caps && window.host.caps.file);
  }
  function sameExe(a, b) {
    return String(a || '').replace(/\//g, '\\').toLowerCase() === String(b || '').replace(/\//g, '\\').toLowerCase();
  }
  function fileOpResult(sp) {
    if (sp == null) return '';
    if (typeof sp === 'string') return sp;
    if (sp.result != null) return String(sp.result);
    return '';
  }
  var _webHist = [];
  var _webIdx = -1;
  var _webBound = false;
  var _webTimer = 0;
  function webEls() {
    var pane = document.getElementById('zn-web-pane');
    if (!pane) return null;
    return {
      pane: pane,
      frame: pane.querySelector('.zn-web-frame'),
      url: pane.querySelector('.zn-web-url'),
      fail: pane.querySelector('.zn-web-fail'),
      back: pane.querySelector('[data-web="back"]'),
      fwd: pane.querySelector('[data-web="fwd"]')
    };
  }
  function isWebPaneOpen() {
    var pane = document.getElementById('zn-web-pane');
    return !!(pane && !pane.classList.contains('hidden'));
  }
  function syncWebNav() {
    var els = webEls();
    if (!els) return;
    if (els.back) els.back.disabled = _webIdx <= 0;
    if (els.fwd) els.fwd.disabled = _webIdx < 0 || _webIdx >= _webHist.length - 1;
  }
  function showWebFail(on) {
    var els = webEls();
    if (!els || !els.fail) return;
    els.fail.classList.toggle('hidden', !on);
    /* 拦了只提示，不自动用浏览器打开 */
  }
  function currentWebHref() {
    return _webIdx >= 0 ? (_webHist[_webIdx] || '') : '';
  }
  function loadWebFrame(href, push) {
    href = String(href || '').trim();
    if (!href) return;
    if (!/^https?:\/\//i.test(href)) {
      if (/^www\./i.test(href)) href = 'https://' + href;
      else if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i.test(href)) href = 'https://' + href;
      else return;
    }
    var els = webEls();
    if (!els || !els.frame) return;
    if (push) {
      if (!(_webIdx >= 0 && _webHist[_webIdx] === href)) {
        _webHist = _webHist.slice(0, _webIdx + 1);
        _webHist.push(href);
        if (_webHist.length > 40) _webHist.shift();
        _webIdx = _webHist.length - 1;
      }
    }
    if (els.url) els.url.value = href;
    showWebFail(false);
    if (_webTimer) { clearTimeout(_webTimer); _webTimer = 0; }
    _webTimer = setTimeout(function () {
      _webTimer = 0;
      if (!isWebPaneOpen()) return;
      try {
        var loc = els.frame.contentWindow && els.frame.contentWindow.location.href;
        if (!loc || loc === 'about:blank') showWebFail(true);
      } catch (_) {}
    }, 8000);
    els.frame.src = href;
    syncWebNav();
  }
  function openOutside(href) {
    href = String(href || currentWebHref() || '').trim();
    if (!href) return;
    if (!canOpenInSysBrowser()) {
      try { window.open(href, '_blank'); } catch (_) {}
      return;
    }
    window.host.file.op({ mode: 'openUrl', path: href, exe: '', fileName: '' }).then(function (sp) {
      if (fileOpResult(sp)) return;
      return window.host.file.op({ mode: 'open', path: href });
    }).catch(function () {
      try { window.open(href, '_blank'); } catch (_) {}
    });
  }
  function closeWebPane() {
    var els = webEls();
    if (!els) return;
    if (_webTimer) { clearTimeout(_webTimer); _webTimer = 0; }
    els.pane.classList.add('hidden');
    els.pane.setAttribute('aria-hidden', 'true');
    try { els.frame.src = 'about:blank'; } catch (_) {}
    showWebFail(false);
  }
  function webGoBack() {
    if (!isWebPaneOpen()) return false;
    if (_webIdx > 0) {
      _webIdx--;
      loadWebFrame(_webHist[_webIdx], false);
      return true;
    }
    closeWebPane();
    return true;
  }
  function bindWebPane() {
    if (_webBound) return;
    var els = webEls();
    if (!els) return;
    _webBound = true;
    els.pane.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-web]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-web');
      if (act === 'back') webGoBack();
      else if (act === 'fwd') {
        if (_webIdx < _webHist.length - 1) {
          _webIdx++;
          loadWebFrame(_webHist[_webIdx], false);
        }
      } else if (act === 'reload') {
        var u = currentWebHref();
        if (u) {
          try { els.frame.contentWindow.location.reload(); }
          catch (_) { els.frame.src = u; }
        }
      } else if (act === 'ext' || act === 'ext2') openOutside();
      else if (act === 'close') closeWebPane();
    });
    els.url.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      loadWebFrame(els.url.value, true);
    });
    els.frame.addEventListener('load', function () {
      if (_webTimer) { clearTimeout(_webTimer); _webTimer = 0; }
      if (!isWebPaneOpen()) return;
      var blocked = false;
      try {
        var loc = els.frame.contentWindow && els.frame.contentWindow.location.href;
        if (!loc || loc === 'about:blank') blocked = true;
        else if (els.url && loc.indexOf('http') === 0) els.url.value = loc;
      } catch (_) {
        blocked = false;
      }
      showWebFail(blocked);
    });
  }
  function openInApp(href) {
    href = String(href || '').trim();
    if (!href) return;
    bindWebPane();
    var els = webEls();
    if (!els) {
      try { window.open(href, '_blank'); } catch (_) {}
      return;
    }
    els.pane.classList.remove('hidden');
    els.pane.setAttribute('aria-hidden', 'false');
    loadWebFrame(href, true);
  }
  function openInWebView(href) {
    href = String(href || '').trim();
    if (!href) return;
    try { window.open(href, '_blank'); } catch (_) {}
  }
  function openWebHref(href) {
    href = String(href || '').trim();
    if (!href) return;
    if (!/^https?:\/\//i.test(href)) {
      try { window.open(href, '_blank'); } catch (_) {}
      return;
    }
    var t = urlOpenTarget();
    if (!canOpenInSysBrowser()) {
      openInApp(href);
      return;
    }
    if (t.kind === 'app') {
      openInApp(href);
      return;
    }
    if (t.kind === 'webview') {
      openInWebView(href);
      return;
    }
    var args = { mode: 'openUrl', path: href, exe: '', fileName: '' };
    if (t.kind === 'exe' && t.exe) {
      args.exe = t.exe;
      args.fileName = t.exe;
    }
    window.host.file.op(args).then(function (sp) {
      if (fileOpResult(sp)) return;
      if (t.kind === 'exe') {
        if (window.toast) window.toast('无法用这个浏览器打开', 'warning');
        return;
      }
      return window.host.file.op({ mode: 'open', path: href });
    }).catch(function () {
      if (t.kind === 'exe') {
        if (window.toast) window.toast('无法用这个浏览器打开', 'warning');
        return;
      }
      window.host.file.op({ mode: 'open', path: href }).catch(function () {
        try { window.open(href, '_blank'); } catch (_) {}
      });
    });
  }

  var BROWSER_ICO = {
    chrome: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#EA4335"/><path fill="#FBBC05" d="M12 12l9.8-3.5A10 10 0 0 0 12 2z"/><path fill="#34A853" d="M12 12l-3.2 9.4A10 10 0 0 0 21.8 8.5z"/><circle cx="12" cy="12" r="4.4" fill="#fff"/><circle cx="12" cy="12" r="2.7" fill="#4285F4"/></svg>',
    edge: '<svg viewBox="0 0 24 24"><path fill="#33C3F0" d="M4 12.2C5.2 6.8 9.4 3.2 15 4.6c3.2.8 5.8 3.6 6 6.9-2.2-3.4-6.4-4.6-10.1-2.7C8.4 10.2 7 13 7.4 16c.2 1.4 1 2.6 2.1 3.4C6.6 18.4 4.4 15.6 4 12.2z"/><path fill="#0C63C8" d="M8.2 18.8c2.4 2.4 6.6 3 9.6.4 1.8-1.6 2.4-3.8 2.2-6.1-2.6 4.2-8.4 4.6-11.8 1.7z"/></svg>',
    firefox: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#FF7139"/><path fill="#FFDA2D" d="M7 14c1.2-4 4.2-6.2 8.2-5.4 1.4.3 2.6 1.2 3.2 2.4-1.8-2-4.8-2.6-7.4-1.2C9.2 10.8 8 12.4 7.6 14.2z"/><circle cx="13" cy="12.2" r="3.2" fill="#0060DF"/></svg>',
    opera: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#FF1B2D"/><ellipse cx="12" cy="12" rx="4.2" ry="7.2" fill="#fff"/></svg>',
    brave: '<svg viewBox="0 0 24 24"><path fill="#FB542B" d="M12 2l3.2 2.2 3.6-.4-.2 3.6L22 10l-2.2 3.2.4 3.6-3.6.2L14 20.8 12 22l-2-1.2-2.6-3.8-3.6-.2.4-3.6L2 10l3.4-2.6L5.2 3.8l3.6.4z"/><path fill="#fff" d="M12 6.2l2.4 1.6v3.4L12 17.2 9.6 11.2V7.8z"/></svg>',
    vivaldi: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#EF3939"/><path fill="#fff" d="M7 10.2c1.6 3.4 3.2 6.6 5 6.6s3.4-3.2 5-6.6c-.8 1.2-2.2 2-3.6 1.4-.6 1.4-1.4 2.4-1.4 2.4s-.8-1-1.4-2.4C9.2 12.2 7.8 11.4 7 10.2z"/></svg>',
    arc: '<svg viewBox="0 0 24 24"><path fill="none" stroke="#F26430" stroke-width="2.2" stroke-linecap="round" d="M6 16.5a7.5 7.5 0 0 1 12 0"/><path fill="none" stroke="#1B73E8" stroke-width="2.2" stroke-linecap="round" d="M4.5 13a9.5 9.5 0 0 1 15 0"/></svg>',
    ie: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1EBBEE"/><ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="#fff" stroke-width="1.6"/><rect x="8" y="10.4" width="8" height="3.2" rx="1" fill="#0B5EA8"/></svg>',
    chromium: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#8CB4FF"/><circle cx="12" cy="12" r="4.2" fill="#fff"/><circle cx="12" cy="12" r="2.6" fill="#4B8BFF"/></svg>',
    '360': '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#22A861"/><circle cx="12" cy="12" r="5.2" fill="none" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="1.6" fill="#fff"/></svg>',
    qq: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#12B7F5"/><ellipse cx="12" cy="13.2" rx="5.4" ry="4.6" fill="#fff"/><circle cx="10" cy="10.4" r="1.1" fill="#111"/><circle cx="14" cy="10.4" r="1.1" fill="#111"/></svg>',
    sogou: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#FB6022"/><path fill="#fff" d="M8 12.2c0-2.4 1.8-4.2 4-4.2 1.6 0 3 .8 3.6 2.1h-2.2A2 2 0 0 0 12 9.8c-1.3 0-2.2 1-2.2 2.4S10.7 14.6 12 14.6c.8 0 1.4-.3 1.8-.8h2.2A4 4 0 0 1 12 16.4c-2.2 0-4-1.8-4-4.2z"/></svg>',
    liebao: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#FF7A00"/><path fill="#fff" d="M7.5 15.2c1.6-4.4 3.4-7.4 4.5-7.4s2.9 3 4.5 7.4c-1.2-1.6-2.8-2.5-4.5-2.5s-3.3.9-4.5 2.5z"/></svg>',
    uc: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#FF6A00"/><path fill="#fff" d="M8 8.5h2.2v5.2c0 1.4 1 2.3 2.8 2.3s2.8-.9 2.8-2.3V8.5H18v5.2c0 2.6-2 4.4-5 4.4s-5-1.8-5-4.4z"/></svg>',
    whale: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1ED760"/><path fill="#fff" d="M6.5 13.5c2.2 3.2 8.8 3.2 11 0-2 .8-4.2 1.2-5.5 1.2s-3.5-.4-5.5-1.2z"/></svg>',
    yandex: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#FC3F1D"/><path fill="#fff" d="M10.2 6.8h2.4c2 0 3.4 1.1 3.4 3.1 0 1.5-.8 2.5-2 3l2.4 4.3h-2.6l-2.1-3.9h-.3v3.9H10.2z m2.2 4.4c.9 0 1.4-.5 1.4-1.3s-.5-1.3-1.4-1.3h-.6v2.6z"/></svg>',
    maxthon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1E88E5"/><path fill="#fff" d="M7 16.2L12 6.8l5 9.4h-2.2l-1-2.1h-3.6l-1 2.1zM11.2 12h1.6L12 9.4z"/></svg>',
    quark: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#00C2B3"/><path fill="#fff" d="M9.2 8.2h3.1c2.1 0 3.5 1.2 3.5 3.1 0 1.5-.8 2.6-2.1 3l1.8 2.7h-2.3l-1.6-2.5H11v2.5H9.2zm2.8 4.5c.9 0 1.5-.5 1.5-1.4s-.6-1.4-1.5-1.4H11v2.8z"/></svg>',
    generic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>',
    webview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 8.5h17"/><circle cx="6.4" cy="6.5" r="0.7" fill="currentColor" stroke="none"/><circle cx="8.8" cy="6.5" r="0.7" fill="currentColor" stroke="none"/></svg>',
    app: ''
  };
  var ZHINOTE_ICON = '📖';
  function paintZnIco(el) {
    if (!el) return;
    el.classList.add('is-app');
    el.textContent = ZHINOTE_ICON;
    try { if (window.emojiUi && window.emojiUi.paintIcon) window.emojiUi.paintIcon(el, ZHINOTE_ICON); } catch (_) {}
  }
  function fillBrowserIco(el, brand, png) {
    if (!el) return;
    if (brand === 'app') { paintZnIco(el); return; }
    if (brand === 'webview') {
      el.classList.remove('is-app');
      el.innerHTML = BROWSER_ICO.webview;
      return;
    }
    el.classList.remove('is-app');
    png = String(png || '').replace(/\s/g, '');
    if (png && /^[A-Za-z0-9+/=]+$/.test(png)) {
      el.innerHTML = '<img alt="" src="data:image/png;base64,' + png + '">';
      return;
    }
    el.innerHTML = browserIco(brand);
  }
  function browserBrand(name, exe) {
    var s = (String(name || '') + ' ' + String(exe || '')).toLowerCase();
    if (/360/.test(s)) return '360';
    if (/qqbrowser|qq浏览器/.test(s)) return 'qq';
    if (/sogou|搜狗/.test(s)) return 'sogou';
    if (/liebao|猎豹/.test(s)) return 'liebao';
    if (/ucbrowser|uc浏览器/.test(s)) return 'uc';
    if (/quark|夸克/.test(s)) return 'quark';
    if (/opera/.test(s)) return 'opera';
    if (/brave/.test(s)) return 'brave';
    if (/vivaldi/.test(s)) return 'vivaldi';
    if (/\barc\b/.test(s)) return 'arc';
    if (/firefox|waterfox|librewolf/.test(s)) return 'firefox';
    if (/msedge|microsoft edge|\\edge\\|\/edge\//.test(s)) return 'edge';
    if (/iexplore|internet explorer/.test(s)) return 'ie';
    if (/chromium/.test(s)) return 'chromium';
    if (/chrome/.test(s)) return 'chrome';
    if (/whale|naver/.test(s)) return 'whale';
    if (/yandex/.test(s)) return 'yandex';
    if (/maxthon|傲游/.test(s)) return 'maxthon';
    return 'generic';
  }
  function browserIco(brand) {
    return BROWSER_ICO[brand] || BROWSER_ICO.generic;
  }
  function parseBrowserResult(sp) {
    var raw = sp && (sp.result != null ? sp.result : sp);
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    var s = String(raw).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) { return null; }
  }
  function loadBrowserList() {
    if (!canOpenInSysBrowser()) return Promise.resolve(null);
    return window.host.file.op({ mode: 'listBrowsers' }).then(parseBrowserResult).catch(function () { return null; });
  }
  function mountBrowserSelect(hostEl) {
    if (!hostEl) return;
    var t = urlOpenTarget();
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'zn-url-browser-btn';
    hostEl.appendChild(trigger);
    var panel = null;
    var rows = [];

    function paintTrigger(item) {
      if (!item) return;
      trigger.innerHTML = '<span class="zn-url-browser-ico"></span>'
        + '<span class="zn-url-browser-label">' + esc(item.label) + '</span>'
        + '<svg class="md-select-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
      fillBrowserIco(trigger.querySelector('.zn-url-browser-ico'), item.brand, item.icon);
    }
    function isOn(item) {
      var cur = urlOpenTarget();
      if (!item) return false;
      if (item.value === 'app') return cur.kind === 'app';
      if (item.value === 'webview') return cur.kind === 'webview';
      if (item.value === 'default') return cur.kind === 'default';
      if (item.value === 'exe') return cur.kind === 'exe' && sameExe(item.exe, cur.exe);
      return false;
    }
    function currentItem() {
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].sep && isOn(rows[i])) return rows[i];
      }
      return rows.filter(function (x) { return x && !x.sep; })[0] || { brand: 'webview', label: 'WebView2打开', value: 'webview' };
    }
    function pick(item) {
      close();
      if (!item || !window.storage || !window.storage.setSetting) return;
      if (item.value === 'app') window.storage.setSetting('urlOpenBrowser', 'app');
      else if (item.value === 'webview') window.storage.setSetting('urlOpenBrowser', 'webview');
      else if (item.value === 'default') window.storage.setSetting('urlOpenBrowser', 'default');
      else window.storage.setSetting('urlOpenBrowser', item.exe || '');
      try { window.storage.setSetting('urlOpenInBrowser', item.value !== 'app' && item.value !== 'webview'); } catch (_) {}
      paintTrigger(item);
    }
    function close() {
      if (!panel) return;
      panel.remove();
      panel = null;
      trigger.classList.remove('is-open');
      document.removeEventListener('mousedown', onDoc, true);
    }
    function onDoc(e) {
      if (panel && !panel.contains(e.target) && !trigger.contains(e.target)) close();
    }
    function open() {
      if (panel) { close(); return; }
      if (!rows.length) return;
      panel = document.createElement('div');
      panel.className = 'md-select-panel zn-url-browser-panel is-open';
      var html = '';
      for (var i = 0; i < rows.length; i++) {
        var it = rows[i];
        if (it.sep) { html += '<div class="zn-url-browser-sep"></div>'; continue; }
        var on = isOn(it);
        html += '<div class="md-select-item' + (on ? ' is-active' : '') + '" data-i="' + i + '">'
          + '<span class="zn-url-browser-ico"></span>'
          + '<span class="md-select-item-label">' + esc(it.label) + '</span>'
          + (on ? '<span class="md-select-item-check">✓</span>' : '')
          + '</div>';
      }
      panel.innerHTML = html;
      var icos = panel.querySelectorAll('.md-select-item');
      for (var j = 0; j < icos.length; j++) {
        var idx = parseInt(icos[j].getAttribute('data-i'), 10);
        if (rows[idx] && !rows[idx].sep) fillBrowserIco(icos[j].querySelector('.zn-url-browser-ico'), rows[idx].brand, rows[idx].icon);
      }
      document.body.appendChild(panel);
      var r = trigger.getBoundingClientRect();
      var w = Math.max(r.width, 220);
      panel.style.minWidth = w + 'px';
      panel.style.left = Math.min(r.left, window.innerWidth - w - 8) + 'px';
      var top = r.bottom + 4;
      if (top + panel.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - panel.offsetHeight - 4);
      panel.style.top = top + 'px';
      trigger.classList.add('is-open');
      panel.querySelectorAll('.md-select-item').forEach(function (el) {
        el.addEventListener('click', function () {
          var idx = parseInt(el.getAttribute('data-i'), 10);
          if (rows[idx] && !rows[idx].sep) pick(rows[idx]);
        });
      });
      document.addEventListener('mousedown', onDoc, true);
    }
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      open();
    });

    paintTrigger({ brand: 'generic', label: '读取浏览器…', value: 'app' });
    loadBrowserList().then(function (data) {
      var items = (data && data.items) || [];
      var def = null;
      var rest = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        if (it.isDefault && !def) def = it;
        else if (!def || !sameExe(it.exe, def.exe)) rest.push(it);
      }
      var next = [];
      next.push({ brand: 'app', label: '在枝记里打开', value: 'app' });
      next.push({ brand: 'webview', label: 'WebView2打开', value: 'webview' });
      next.push({ sep: true });
      if (def && def.name) {
        next.push({
          brand: browserBrand(def.name, def.exe),
          label: def.name + '（默认）',
          value: 'default',
          exe: def.exe || '',
          icon: def.icon || ''
        });
      } else {
        next.push({ brand: 'generic', label: '系统默认（默认）', value: 'default', exe: '' });
      }
      rest.forEach(function (it) {
        next.push({
          brand: browserBrand(it.name, it.exe),
          label: it.name || '浏览器',
          value: 'exe',
          exe: it.exe || '',
          icon: it.icon || ''
        });
      });
      rows = next;
      paintTrigger(currentItem());
    });
  }
  function looksUrl(q) {
    q = String(q || '').trim();
    if (!q) return '';
    if (/^https?:\/\//i.test(q)) return q;
    if (/^www\./i.test(q)) return 'https://' + q;
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}([/:?#].*)?$/i.test(q)) return 'https://' + q;
    return '';
  }
  function encodeFileHref(rawPath) {
    var normalized = String(rawPath || '').replace(/\\/g, '/');
    return 'file:///' + encodeURI(normalized).replace(/\(/g, '%28').replace(/\)/g, '%29');
  }
  function hrefToWinPath(href) {
    var p = String(href || '');
    if (/^file:/i.test(p)) p = p.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
    try { p = decodeURIComponent(p); } catch (_) {}
    return p.replace(/\//g, '\\');
  }
  function isAbsWinPath(p) {
    p = String(p || '');
    return /^[a-zA-Z]:\\/.test(p) || p.indexOf('\\\\') === 0;
  }
  function dialogFilePath(fileData) {
    if (!fileData) return '';
    return String(fileData.path || fileData.fullPath || fileData.name || '');
  }
  function fileName(href) {
    var p = String(href || '').replace(/^file:\/\/\//, '');
    try { p = decodeURIComponent(p); } catch (_) {}
    var parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }
  function filePathDisplay(href) {
    var p = String(href || '').replace(/^file:\/\/\//i, '');
    try { p = decodeURIComponent(p); } catch (_) {}
    if (/^[A-Za-z]:/.test(p) || p.indexOf('\\') >= 0) p = p.replace(/\//g, '\\');
    return p;
  }
  function copyTextOf(attrs) {
    var a = liveAttrs(attrs || {});
    if (a.kind === 'url') return a.href || a.title || '';
    if (a.kind === 'file') return filePathDisplay(a.href) || a.title || '';
    return a.title || '';
  }
  function liveAttrs(attrs) {
    var a = {
      kind: (attrs && attrs.kind) || 'note',
      id: (attrs && attrs.id) || '',
      href: (attrs && attrs.href) || '',
      title: (attrs && attrs.title) || '',
      icon: (attrs && attrs.icon) || '',
      hideHost: !!(attrs && (attrs.hideHost === true || attrs.hideHost === '1' || attrs.hideHost === 1)),
    };
    if (a.kind === 'note' && a.id && window.storage) {
      var n = window.storage.get(a.id);
      if (n) {
        a.title = n.title || '无标题';
        a.icon = n.icon || '📄';
      } else {
        if (!a.title) a.title = '已删除的笔记';
      }
    }
    if (!a.title) {
      if (a.kind === 'url') a.title = hostOf(a.href) || a.href || '网址';
      else if (a.kind === 'file') a.title = fileName(a.href) || '文件';
      else a.title = '笔记';
    }
    if (!a.icon) {
      a.icon = a.kind === 'url' ? '🌐' : (a.kind === 'file' ? '📁' : '📄');
    }
    return a;
  }
  function wsNameOf(note) {
    if (!note || !window.storage || !window.storage.getWorkspaces) return '';
    var id = note.workspaceId || 'ws-default';
    var list = window.storage.getWorkspaces() || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i].name || '';
    }
    return '';
  }
  function pathOf(id) {
    if (!id || !window.storage) return '';
    try {
      var note = window.storage.get ? window.storage.get(id) : null;
      var parts = [];
      var wn = wsNameOf(note);
      if (wn) parts.push(wn);
      var chain = (window.storage.getAncestors && window.storage.getAncestors(id)) || [];
      chain.slice(0, -1).forEach(function (n) {
        if (n && n.title) parts.push(n.title);
      });
      return parts.join(' / ');
    } catch (_) { return ''; }
  }
  function excerptOf(id) {
    if (!id || !window.storage) return '';
    var n = window.storage.get(id);
    if (!n) return '';
    var t = '';
    try {
      t = n.doc && window.editor && window.editor.docToPlainText
        ? window.editor.docToPlainText(n.doc)
        : (n.content || '');
    } catch (_) { t = n.content || ''; }
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  }
  function paintIco(el, ch) {
    el.textContent = ch || '';
    try { if (window.emojiUi && window.emojiUi.paintIcon) window.emojiUi.paintIcon(el, ch); } catch (_) {}
  }
  function fetchOg(href, cb) {
    if (!href || href.indexOf('http') !== 0) return;
    if (_ogCache[href]) { cb(_ogCache[href]); return; }
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (_) {} }, 2800);
    fetch('https://api.microlink.io/?url=' + encodeURIComponent(href), { signal: ctrl && ctrl.signal })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(t);
        var d = (j && j.data) || {};
        var img = d.image && (d.image.url || d.image);
        var rec = { img: typeof img === 'string' ? img : '', title: d.title || '' };
        _ogCache[href] = rec;
        cb(rec);
      })
      .catch(function () {
        clearTimeout(t);
        _ogCache[href] = { img: '', title: '' };
      });
  }

  function paintMention(dom, attrs) {
    if (!dom) return;
    var a = liveAttrs(attrs);
    dom.className = 'zn-mention';
    dom.setAttribute('data-zn-mention', '');
    dom.setAttribute('data-kind', a.kind);
    if (a.id) dom.setAttribute('data-id', a.id); else dom.removeAttribute('data-id');
    if (a.href) dom.setAttribute('data-href', a.href); else dom.removeAttribute('data-href');
    dom.setAttribute('data-title', a.title);
    dom.setAttribute('data-icon', a.icon);
    if (a.kind === 'url' && !urlShowHost()) dom.setAttribute('data-hide-host', '1'); else dom.removeAttribute('data-hide-host');
    dom.innerHTML = '';
    var ico = document.createElement('span');
    ico.className = 'zn-mn-ico';
    paintIco(ico, a.icon);
    var t = document.createElement('span');
    t.className = 'zn-mn-t';
    t.textContent = a.title;
    dom.appendChild(ico);
    dom.appendChild(t);
    if (a.kind === 'url' && urlShowHost()) {
      var host = hostOf(a.href);
      if (host) {
        var ext = document.createElement('span');
        ext.className = 'zn-mn-ext';
        ext.textContent = host;
        dom.appendChild(ext);
      }
    }
  }
  function paintPageLink(dom, attrs) {
    if (!dom) return;
    var a = liveAttrs(attrs);
    dom.className = 'zn-pagelink';
    dom.setAttribute('data-zn-pagelink', '');
    dom.setAttribute('data-kind', a.kind);
    if (a.id) dom.setAttribute('data-id', a.id); else dom.removeAttribute('data-id');
    if (a.href) dom.setAttribute('data-href', a.href); else dom.removeAttribute('data-href');
    dom.setAttribute('data-title', a.title);
    dom.setAttribute('data-icon', a.icon);
    if (a.kind === 'url' && !urlShowHost()) dom.setAttribute('data-hide-host', '1'); else dom.removeAttribute('data-hide-host');
    dom.innerHTML = '';
    var ico = document.createElement('span');
    ico.className = 'zn-pl-ico';
    paintIco(ico, a.icon);
    var body = document.createElement('span');
    body.className = 'zn-pl-body';
    var t = document.createElement('span');
    t.className = 'zn-pl-t';
    t.textContent = a.title;
    body.appendChild(t);
    var path = a.kind === 'note' ? pathOf(a.id)
      : (a.kind === 'url' ? (urlShowHost() ? hostOf(a.href) : '') : (a.kind === 'file' ? fileName(a.href) : ''));
    if (path) {
      var s = document.createElement('span');
      s.className = 'zn-pl-path';
      s.textContent = path;
      body.appendChild(s);
    }
    dom.appendChild(ico);
    dom.appendChild(body);
  }
  function refreshLive() {
    document.querySelectorAll('.zn-mention').forEach(function (el) {
      paintMention(el, {
        kind: el.getAttribute('data-kind') || 'note',
        id: el.getAttribute('data-id') || '',
        href: el.getAttribute('data-href') || '',
        title: el.getAttribute('data-title') || '',
        icon: el.getAttribute('data-icon') || '',
        hideHost: el.getAttribute('data-hide-host') === '1',
      });
    });
    document.querySelectorAll('.zn-pagelink').forEach(function (el) {
      paintPageLink(el, {
        kind: el.getAttribute('data-kind') || 'note',
        id: el.getAttribute('data-id') || '',
        href: el.getAttribute('data-href') || '',
        title: el.getAttribute('data-title') || '',
        icon: el.getAttribute('data-icon') || '',
        hideHost: el.getAttribute('data-hide-host') === '1',
      });
    });
  }

  function attrsFromDom(el) {
    if (!el) return null;
    var hit = el.closest ? (el.closest('.zn-mention') || el.closest('.zn-pagelink')) : null;
    if (!hit) return null;
    return {
      kind: hit.getAttribute('data-kind') || 'note',
      id: hit.getAttribute('data-id') || '',
      href: hit.getAttribute('data-href') || '',
      title: hit.getAttribute('data-title') || '',
      icon: hit.getAttribute('data-icon') || '',
      hideHost: hit.getAttribute('data-hide-host') === '1',
    };
  }

  function openTarget(attrs) {
    hideHover();
    var a = liveAttrs(attrs || {});
    if (a.kind === 'note' && a.id) {
      if (!window.storage || !window.storage.get(a.id) || (window.storage.isNoteDeleted && window.storage.isNoteDeleted(a.id))) {
        if (window.toast) window.toast('这篇笔记已经不在了', 'warning');
        return;
      }
      try {
        if (window.tree && window.tree.expandAncestors) window.tree.expandAncestors(a.id);
        window.editor.open(a.id, { fromLink: true });
      } catch (_) {}
      return;
    }
    var href = a.href || '';
    if (a.kind === 'file' || href.indexOf('file:') === 0) {
      var path = hrefToWinPath(href);
      if (!isAbsWinPath(path)) {
        if (window.toast) window.toast('没有完整路径，请删掉后重新插入这个文件', 'warning');
        return;
      }
      if (window.host && window.host.caps && window.host.caps.file) {
        window.host.file.op({ mode: 'open', path: path }).catch(function () {
          if (window.toast) window.toast('无法打开这个文件', 'warning');
        });
      } else if (window.toast) {
        window.toast('网页版请在电脑客户端打开本地文件', 'info');
      }
      return;
    }
    if (href) openWebHref(href);
  }

  function fileHrefOf(attrs) {
    var a = liveAttrs(attrs || {});
    var href = a.href || '';
    if (a.kind === 'file' || href.indexOf('file:') === 0) return href;
    return '';
  }
  function revealHref(href) {
    hideHover();
    var path = hrefToWinPath(href);
    if (!isAbsWinPath(path)) {
      if (window.toast) window.toast('没有完整路径，请删掉后重新插入这个文件', 'warning');
      return;
    }
    if (!(window.host && window.host.caps && window.host.caps.file)) {
      if (window.toast) window.toast('网页版无法在资源管理器中定位', 'info');
      return;
    }
    window.host.file.op({ mode: 'reveal', path: path }).catch(function () {
      if (window.toast) window.toast('定位失败。请在 Quicker 的 FileOp 里加上 reveal（在资源管理器中定位文件）', 'warning');
    });
  }
  function revealTarget(attrs) {
    var href = fileHrefOf(attrs);
    if (href) revealHref(href);
  }
  function revealSelected() {
    var inst = ed();
    var hit = findSelectedRef(inst);
    if (!hit) return false;
    revealTarget(liveAttrs(hit.node.attrs));
    return true;
  }

  function hideHover() {
    clearTimeout(_hoverTimer);
    clearTimeout(_hoverLeave);
    if (_hover) { _hover.remove(); _hover = null; }
  }
  function showHover(anchor, attrs) {
    hideHover();
    var a = liveAttrs(attrs || {});
    _hover = document.createElement('div');
    _hover.className = 'zn-mn-hover';
    var path = a.kind === 'note' ? pathOf(a.id)
      : (a.kind === 'url' ? hostOf(a.href) : (a.kind === 'file' ? hrefToWinPath(a.href) : ''));
    var ex = a.kind === 'note' ? excerptOf(a.id) : '';
    _hover.innerHTML = '<div class="zn-mn-hover-h">'
      + '<span class="zn-mn-hover-ico"></span>'
      + '<div class="zn-mn-hover-m"><div class="zn-mn-hover-t"></div>'
      + (path ? '<div class="zn-mn-hover-path"></div>' : '')
      + '</div></div>'
      + (ex ? '<div class="zn-mn-hover-ex"></div>' : '');
    var icoEl = _hover.querySelector('.zn-mn-hover-ico');
    paintIco(icoEl, a.icon);
    _hover.querySelector('.zn-mn-hover-t').textContent = a.title;
    if (path) _hover.querySelector('.zn-mn-hover-path').textContent = path;
    if (ex) _hover.querySelector('.zn-mn-hover-ex').textContent = ex;
    document.body.appendChild(_hover);
    function place() {
      if (!_hover || !anchor) return;
      var r = anchor.getBoundingClientRect();
      var w = _hover.offsetWidth, h = _hover.offsetHeight;
      var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      var top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
      _hover.style.left = Math.round(left) + 'px';
      _hover.style.top = Math.round(top) + 'px';
    }
    place();
    _hover.addEventListener('mouseenter', function () { clearTimeout(_hoverLeave); });
    _hover.addEventListener('mouseleave', scheduleHideHover);
    if (a.kind === 'url' && a.href) {
      fetchOg(a.href, function (og) {
        if (!_hover) return;
        if (og.img && !_hover.querySelector('.zn-mn-hover-shot')) {
          var img = document.createElement('img');
          img.className = 'zn-mn-hover-shot';
          img.alt = '';
          img.src = og.img;
          img.addEventListener('error', function () { if (img.parentNode) img.remove(); });
          img.addEventListener('load', place);
          _hover.appendChild(img);
          place();
        }
      });
    }
  }
  function scheduleHover(anchor, attrs) {
    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(function () { showHover(anchor, attrs); }, 380);
  }
  function scheduleHideHover() {
    clearTimeout(_hoverLeave);
    _hoverLeave = setTimeout(hideHover, 160);
  }

  function bindChipEvents(dom, getAttrs, getPos, editorInst, asBlock) {
    if (!dom) return;
    dom.contentEditable = 'false';
    dom.addEventListener('dragstart', function (e) { e.preventDefault(); });
    dom.addEventListener('mousedown', function (e) {
      if (e.button === 2) {
        var p = getPos();
        if (typeof p === 'number') editorInst.commands.setNodeSelection(p);
      }
    });
    dom.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      hideHover();
      openTarget(getAttrs());
    });
    dom.addEventListener('mouseenter', function () {
      if (isOpen()) return;
      scheduleHover(dom, getAttrs());
    });
    dom.addEventListener('mouseleave', function () {
      clearTimeout(_hoverTimer);
      scheduleHideHover();
    });
  }

  function scoreTitle(title, q) {
    if (!q) return 1;
    var name = String(title || '').toLowerCase();
    q = q.toLowerCase();
    if (name.indexOf(q) >= 0) return 100;
    if (typeof window.pinyinPro === 'object' && typeof window.pinyinPro.pinyin === 'function') {
      try {
        var full = window.pinyinPro.pinyin(title, { toneType: 'none', type: 'string', nonZh: 'consecutive' }).replace(/\s+/g, '').toLowerCase();
        var first = window.pinyinPro.pinyin(title, { pattern: 'first', toneType: 'none', type: 'string', nonZh: 'consecutive' }).replace(/\s+/g, '').toLowerCase();
        if (full.indexOf(q) >= 0) return 60;
        if (first.indexOf(q) >= 0) return 50;
      } catch (_) {}
    }
    var i = 0;
    for (var j = 0; j < name.length && i < q.length; j++) {
      if (name[j] === q[i]) i++;
    }
    return i === q.length ? 20 : 0;
  }
  function noteItem(n) {
    return {
      type: 'note',
      title: n.title || '无标题',
      sub: pathOf(n.id) || '笔记',
      icon: n.icon || '📄',
      attrs: { kind: 'note', id: n.id, href: '', title: n.title || '无标题', icon: n.icon || '📄' },
    };
  }
  function listNotes(query) {
    if (!window.storage) return [];
    var data = window.storage.getAll() || {};
    var notes = data.notes || {};
    var curId = window.editor && window.editor.currentId ? window.editor.currentId() : '';
    var recent = (window.storage.getSetting && window.storage.getSetting('recent')) || [];
    if (!query) {
      var out = [];
      recent.forEach(function (id) {
        if (out.length >= 3) return;
        var n = notes[id];
        if (!n || id === curId) return;
        if (window.storage.isNoteDeleted && window.storage.isNoteDeleted(id)) return;
        out.push(n);
      });
      return out;
    }
    var scored = [];
    Object.keys(notes).forEach(function (id) {
      var n = notes[id];
      if (!n) return;
      if (id === curId) return;
      if (window.storage.isNoteDeleted && window.storage.isNoteDeleted(id)) return;
      var s = scoreTitle(n.title || '无标题', query);
      if (!s) return;
      scored.push({ n: n, score: s });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 8).map(function (x) { return x.n; });
  }
  function buildBrowseItems() {
    var items = [];
    items.push({ type: 'back', title: '返回最近', icon: '←' });
    var data = (window.storage && window.storage.getAll && window.storage.getAll()) || {};
    var notes = data.notes || {};
    var curId = window.editor && window.editor.currentId ? window.editor.currentId() : '';
    var groups = {};
    Object.keys(notes).forEach(function (id) {
      var n = notes[id];
      if (!n || id === curId) return;
      if (window.storage.isNoteDeleted && window.storage.isNoteDeleted(id)) return;
      var wid = n.workspaceId || 'ws-default';
      (groups[wid] = groups[wid] || []).push(n);
    });
    var wss = [];
    try { wss = window.storage.getWorkspaces() || []; } catch (_) {}
    var known = {};
    wss.forEach(function (w) { known[w.id] = 1; });
    wss.forEach(function (w) {
      var list = groups[w.id] || [];
      if (!list.length) return;
      var open = _browseWs === w.id;
      items.push({ type: 'ws', wsId: w.id, title: w.name || '未命名', icon: w.icon || '📒', n: list.length, open: open });
      if (open) {
        list.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
        list.forEach(function (n) {
          var it = noteItem(n);
          it.ind = true;
          items.push(it);
        });
      }
    });
    Object.keys(groups).forEach(function (wid) {
      if (known[wid]) return;
      groups[wid].forEach(function (n) { items.push(noteItem(n)); });
    });
    return items;
  }

  function buildItems(query) {
    if (_browse && !query) return buildBrowseItems();
    var items = [];
    if (!_asBlock && mascotOn()) {
      items.push({ type: 'ask', title: '问小枝', sub: query ? ('问：' + query) : '把这句话交给小枝', icon: '🌱' });
    }
    var notes = listNotes(query);
    if (!query && notes.length) items.push({ type: 'cap', title: '最近' });
    notes.forEach(function (n) { items.push(noteItem(n)); });
    var url = looksUrl(query);
    if (url) {
      items.push({
        type: 'url',
        title: query.replace(/^https?:\/\//i, ''),
        sub: hostOf(url) || '网址',
        icon: '🌐',
        attrs: { kind: 'url', id: '', href: url, title: hostOf(url) || query, icon: '🌐', hideHost: true },
      });
    }
    items.push({ type: 'sep' });
    if (!query) items.push({ type: 'browse', title: '全部笔记', sub: '按笔记本翻', icon: '📖' });
    items.push({ type: 'url-prompt', title: '粘贴网址…', sub: '网页', icon: '🌐' });
    items.push({ type: 'file', title: '选择文件…', sub: '本机文件', icon: '📁' });
    return items;
  }

  function skipHi(it) {
    return !it || it.type === 'sep' || it.type === 'cap';
  }
  function defaultHi(items, query) {
    if (!items.length) return 0;
    var i, it;
    if (query) {
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (it.type === 'note' || it.type === 'url') return i;
      }
    }
    for (i = 0; i < items.length; i++) if (!skipHi(items[i])) return i;
    return 0;
  }

  function isOpen() { return !!(_pick && !_pick.classList.contains('hidden')); }
  function hidePicker() {
    hideHover();
    if (_pick) _pick.classList.add('hidden');
    _items = [];
    _query = '';
    _hasRange = false;
    _asBlock = false;
    _browse = false;
    _browseWs = '';
    _replacePos = null;
    _pickLockH = 0;
    if (_pick) {
      _pick.style.maxHeight = '';
      _pick.style.height = '';
    }
  }
  function liveRange() {
    var hit = readAtTrigger();
    if (hit) return { from: hit.from, to: hit.to };
    if (_hasRange) return { from: _rangeFrom, to: _rangeTo };
    return null;
  }
  function takeSession() {
    var bag = { range: liveRange(), query: _query, asBlock: _asBlock, replacePos: _replacePos };
    hidePicker();
    return bag;
  }
  function deleteRange(inst, range) {
    if (!inst || !range || range.to <= range.from) return;
    try { inst.chain().focus().deleteRange({ from: range.from, to: range.to }).run(); } catch (_) {}
  }

  function placePicker(rect) {
    if (!_pick || !rect) return;
    var expanded = _browse && !!_browseWs;
    if (!expanded) {
      _pick.style.maxHeight = '';
      _pick.style.height = '';
      _pick.style.overflowY = '';
    }
    var margin = 8;
    var visH = (window.visibleViewportH ? window.visibleViewportH() : window.innerHeight);
    var pw = _pick.offsetWidth, ph = _pick.offsetHeight;
    var left = rect.left, top = rect.bottom + 6;
    if (left + pw > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - pw - margin);
    if (left < margin) left = margin;
    if (top + ph > visH - margin) {
      var upTop = rect.top - ph - 6;
      top = upTop >= margin ? upTop : Math.max(margin, visH - ph - margin);
    }
    _pick.style.left = Math.round(left) + 'px';
    _pick.style.top = Math.round(top) + 'px';
  }

  var _lastRect = null;
  function isBadRect(r) {
    if (!r) return true;
    var l = r.left || 0, t = r.top || 0, w = r.width || 0, h = r.height || 0;
    return (l < 4 && t < 4 && w < 2 && h < 2);
  }
  function caretClientRect() {
    var inst = ed();
    if (inst) {
      try {
        var c = inst.view.coordsAtPos(inst.state.selection.from);
        var r = { left: c.left, top: c.top, right: c.right, bottom: c.bottom, width: 0, height: Math.max(1, c.bottom - c.top) };
        if (!isBadRect(r)) { _lastRect = r; return r; }
      } catch (_) {}
    }
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var gr = sel.getRangeAt(0).getBoundingClientRect();
      if (!isBadRect(gr)) { _lastRect = gr; return gr; }
    }
    if (_lastRect) return _lastRect;
    var box = document.querySelector('#editor');
    if (box) {
      var er = box.getBoundingClientRect();
      return { left: er.left + 72, top: er.top + 72, right: er.left + 72, bottom: er.top + 92, width: 0, height: 20 };
    }
    return { left: 72, top: 72, right: 72, bottom: 92, width: 0, height: 20 };
  }

  function renderPicker() {
    if (!_pick) {
      _pick = document.createElement('div');
      _pick.className = 'zn-mn-pick hidden';
      document.body.appendChild(_pick);
      _pick.addEventListener('mousedown', function (e) { e.preventDefault(); });
    }
    _pick.innerHTML = '';
    var list = document.createElement('div');
    list.className = 'zn-mn-pick-list';
    if (!_items.length) {
      var empty = document.createElement('div');
      empty.className = 'zn-mn-pick-empty';
      empty.textContent = _query ? '没有匹配的笔记' : '没有可引用的笔记';
      list.appendChild(empty);
    } else {
      _items.forEach(function (it, i) {
        if (it.type === 'sep') {
          var hr = document.createElement('div');
          hr.className = 'zn-mn-pick-sep';
          list.appendChild(hr);
          return;
        }
        if (it.type === 'cap') {
          var cap = document.createElement('div');
          cap.className = 'zn-mn-pick-cap';
          cap.textContent = it.title;
          list.appendChild(cap);
          return;
        }
        var row = document.createElement('div');
        row.className = 'zn-mn-pick-item' + (i === _hi ? ' on' : '') + (it.ind ? ' ind' : '');
        row.setAttribute('data-i', String(i));
        if (it.type === 'ws') {
          var chev = document.createElement('span');
          chev.className = 'zn-mn-pick-chev';
          chev.textContent = it.open ? '▾' : '▸';
          row.appendChild(chev);
        }
        var ico = document.createElement('span');
        ico.className = 'zn-mn-pick-ico';
        paintIco(ico, it.icon);
        var m = document.createElement('span');
        m.className = 'zn-mn-pick-m';
        var t = document.createElement('span');
        t.className = 'zn-mn-pick-t';
        t.textContent = it.title;
        var s = document.createElement('span');
        s.className = 'zn-mn-pick-s';
        s.textContent = it.sub || '';
        m.appendChild(t);
        if (it.sub) m.appendChild(s);
        row.appendChild(ico);
        row.appendChild(m);
        if (it.type === 'ws' && it.n != null) {
          var nn = document.createElement('span');
          nn.className = 'zn-mn-pick-n';
          nn.textContent = String(it.n);
          row.appendChild(nn);
        }
        if (it.type === 'note' && !_asBlock && !_replacePos) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'zn-mn-pick-block';
          btn.textContent = '通栏';
          btn.title = '插入通栏入口（Shift+回车）';
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            confirmItem(it, true);
          });
          row.appendChild(btn);
        }
        row.addEventListener('click', function () { confirmItem(it, _asBlock); });
        row.addEventListener('mouseenter', function () { _hi = i; syncHi(); });
        list.appendChild(row);
      });
    }
    _pick.appendChild(list);
    var hint = document.createElement('div');
    hint.className = 'zn-mn-pick-hint';
    hint.textContent = _asBlock
      ? '回车插入通栏 · Esc 取消'
      : (mascotOn()
        ? '回车 胶囊 · Shift+回车 通栏 · Tab 问小枝 · Esc 取消'
        : '回车 胶囊 · Shift+回车 通栏 · Esc 取消');
    _pick.appendChild(hint);
    _pick.classList.remove('hidden');
  }
  function syncHi() {
    if (!_pick) return;
    var on = null;
    _pick.querySelectorAll('.zn-mn-pick-item').forEach(function (el) {
      var hit = Number(el.getAttribute('data-i')) === _hi;
      el.classList.toggle('on', hit);
      if (hit) on = el;
    });
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
  function moveHi(dir) {
    if (!_items.length) return;
    var i = _hi;
    for (var n = 0; n < _items.length; n++) {
      i = (i + dir + _items.length) % _items.length;
      if (_items[i] && !skipHi(_items[i])) { _hi = i; break; }
    }
    syncHi();
  }

  function insertNode(attrs, asBlock, range) {
    var inst = ed();
    if (!inst || !inst.isEditable) return false;
    var a = liveAttrs(attrs);
    deleteRange(inst, range);
    var type = asBlock ? 'znPageLink' : 'znMention';
    try {
      return inst.chain().focus().insertContent({ type: type, attrs: a }).run();
    } catch (_) { return false; }
  }
  function replaceAt(pos, attrs) {
    var inst = ed();
    if (!inst || !inst.isEditable || typeof pos !== 'number') return false;
    return inst.chain().focus().command(function (_ref) {
      var tr = _ref.tr, state = _ref.state, dispatch = _ref.dispatch;
      var node = state.doc.nodeAt(pos);
      if (!node || (node.type.name !== 'znMention' && node.type.name !== 'znPageLink')) return false;
      tr.setNodeMarkup(pos, undefined, liveAttrs(attrs));
      if (dispatch) dispatch(tr);
      return true;
    }).run();
  }
  function applyRef(attrs, asBlock, range, replacePos) {
    if (replacePos != null) return replaceAt(replacePos, attrs);
    return insertNode(attrs, asBlock, range);
  }
  function patchSelected(partial) {
    var inst = ed();
    var hit = findSelectedRef(inst);
    if (!inst || !hit) return false;
    return inst.chain().focus().command(function (_ref) {
      var tr = _ref.tr, state = _ref.state, dispatch = _ref.dispatch;
      var node = state.doc.nodeAt(hit.pos);
      if (!node || (node.type.name !== 'znMention' && node.type.name !== 'znPageLink')) return false;
      tr.setNodeMarkup(hit.pos, undefined, liveAttrs(Object.assign({}, node.attrs, partial || {})));
      if (dispatch) dispatch(tr);
      return true;
    }).run();
  }
  function pickSelectedIcon(anchor) {
    var inst = ed();
    var hit = findSelectedRef(inst);
    if (!hit) return false;
    var kind = hit.node.attrs.kind || 'note';
    if (kind === 'note') return false;
    var fallback = kind === 'file' ? '📁' : '🌐';
    var cur = hit.node.attrs.icon || fallback;
    if (!window.openIconPicker) return false;
    window.openIconPicker(anchor || document.body, {
      currentIcon: cur,
      defaultIcon: fallback,
      title: '更换图标',
      onPick: function (icon) { patchSelected({ icon: icon || fallback }); }
    });
    return true;
  }
  function toggleHideHost() {
    var inst = ed();
    var hit = findSelectedRef(inst);
    if (!hit) return false;
    if ((hit.node.attrs.kind || '') !== 'url') return false;
    return patchSelected({ hideHost: !hit.node.attrs.hideHost });
  }
  function refreshPicker() {
    _items = buildItems(_query);
    _hi = defaultHi(_items, _query);
    renderPicker();
    var expanded = _browse && !!_browseWs;
    if (expanded && _pickLockH > 8) {
      _pick.style.maxHeight = _pickLockH + 'px';
      _pick.style.height = _pickLockH + 'px';
    }
    placePicker(caretClientRect());
    if (!expanded && _pick) _pickLockH = _pick.offsetHeight;
  }

  function askMascot() {
    var bag = takeSession();
    var inst = ed();
    if (inst && inst.isEditable) {
      deleteRange(inst, bag.range);
      if (window.mascot && typeof window.mascot.askInline === 'function') {
        window.mascot.askInline(bag.query || '');
        return;
      }
    }
    try { if (window.mascot && window.mascot.summon) window.mascot.summon(); } catch (_) {}
  }

  function confirmItem(it, asBlock) {
    if (!it || it.type === 'cap') return;
    if (it.type === 'browse') { _browse = true; _browseWs = ''; refreshPicker(); return; }
    if (it.type === 'back') { _browse = false; _browseWs = ''; refreshPicker(); return; }
    if (it.type === 'ws') {
      _browseWs = (_browseWs === it.wsId) ? '' : it.wsId;
      refreshPicker();
      return;
    }
    if (it.type === 'ask') { askMascot(); return; }
    var bag = takeSession();
    if (it.type === 'url-prompt') {
      openUrlCard(!!asBlock, bag.range, { replacePos: bag.replacePos });
      return;
    }
    if (it.type === 'file') {
      pickFile(!!asBlock, bag.range, { replacePos: bag.replacePos });
      return;
    }
    if (it.attrs) applyRef(it.attrs, !!asBlock, bag.range, bag.replacePos);
  }

  function openUrlCard(asBlock, range, extra) {
    extra = extra || {};
    var initIcon = extra.icon || '🌐';
    var showHost = urlShowHost();
    var sysBrowser = canOpenInSysBrowser();
    var body = document.createElement('div');
    body.className = 'zn-url-card-body';
    body.innerHTML =
      '<div class="zn-url-pane is-on" data-pane="edit">'
      + '<div><label style="font-size:13px;color:var(--text-secondary);display:block;margin:0 0 6px;">图标</label>'
      + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
      + '<button type="button" id="zn-url-icon" class="ws-icon-pick-btn" title="选择图标">' + esc(initIcon) + '</button>'
      + '<input type="hidden" id="zn-url-icon-input" value="' + esc(initIcon) + '">'
      + '<span style="color:var(--text-tertiary);font-size:12px;">点击图标打开表情库</span></div></div>'
      + '<div><label style="font-size:13px;color:var(--text-secondary);display:block;margin:0 0 4px;">网址</label>'
      + '<input id="zn-url-href" type="url" placeholder="https://" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text);outline:none;box-sizing:border-box;"></div>'
      + '<div><label style="font-size:13px;color:var(--text-secondary);display:block;margin:0 0 4px;">显示名称<span style="color:var(--text-tertiary);font-weight:400;">（选填，空白则用网站名）</span></label>'
      + '<input id="zn-url-title" type="text" placeholder="例如：维基百科" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text);outline:none;box-sizing:border-box;"></div>'
      + '</div>'
      + '<div class="zn-url-pane" data-pane="global">'
      + '<div class="zn-url-showhost-row"><span class="zn-url-showhost-text">显示域名</span>'
      + '<label class="zn-switch">'
      + '<input type="checkbox" id="zn-url-show-host"' + (showHost ? ' checked' : '') + '>'
      + '<i></i></label></div>'
      + (sysBrowser
        ? ('<div class="zn-url-open-row"><div class="zn-url-open-label">打开方式</div><div id="zn-url-browser-wrap"></div></div>')
        : '')
      + '</div>';
    var globalPane0 = body.querySelector('.zn-url-pane[data-pane="global"]');
    if (globalPane0 && 'inert' in globalPane0) globalPane0.inert = true;
    var iconBtn = body.querySelector('#zn-url-icon');
    var iconInp = body.querySelector('#zn-url-icon-input');
    if (iconBtn && iconInp) {
      iconBtn.addEventListener('click', function () {
        if (!window.openIconPicker) return;
        window.openIconPicker(iconBtn, {
          title: '选择图标',
          currentIcon: iconInp.value || '🌐',
          defaultIcon: '🌐',
          onPick: function (icon) {
            var v = icon || '🌐';
            iconInp.value = v;
            try { window.emojiUi && window.emojiUi.paintIcon && window.emojiUi.paintIcon(iconBtn, v); }
            catch (_) { iconBtn.textContent = v; }
          }
        });
      });
      try { window.emojiUi && window.emojiUi.paintIcon && window.emojiUi.paintIcon(iconBtn, iconInp.value || '🌐'); } catch (_) {}
    }
    var showEl = body.querySelector('#zn-url-show-host');
    if (showEl) {
      showEl.addEventListener('change', function () {
        if (window.storage && window.storage.setSetting) window.storage.setSetting('urlShowHost', !!showEl.checked);
        refreshLive();
      });
    }
    mountBrowserSelect(body.querySelector('#zn-url-browser-wrap'));
    if (typeof window.openModal !== 'function') return;
    window.openModal({
      title: (extra.replacePos != null || extra.edit) ? '修改网址' : '粘贴网址',
      dialogClass: 'zn-url-card-modal',
      body: body,
      footer: [
        { label: '取消', class: 'secondary-btn', onClick: function () { window.closeModal(); } },
          { label: (extra.replacePos != null || extra.edit) ? '保存' : (asBlock ? '插入通栏' : '插入'), class: 'primary-btn', onClick: function () {
          var href = (body.querySelector('#zn-url-href').value || '').trim();
          var title = (body.querySelector('#zn-url-title').value || '').trim();
          if (!href) return;
          if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href) && href.indexOf('file:') !== 0) href = 'https://' + href;
          var icon = ((body.querySelector('#zn-url-icon-input') || {}).value || '').trim() || '🌐';
          applyRef({
            kind: 'url', href: href, title: title || hostOf(href) || href, icon: icon,
            hideHost: (extra.replacePos != null || extra.edit) ? !!extra.hideHost : true,
          }, !!asBlock, range, extra.replacePos);
          window.closeModal();
        } },
      ],
    });
    var titleEl = document.getElementById('modal-title');
    if (titleEl) {
      var editName = (extra.replacePos != null || extra.edit) ? '修改网址' : '粘贴网址';
      titleEl.innerHTML = '<button type="button" class="zn-url-tab is-on" data-pane="edit">' + esc(editName) + '</button>'
        + '<button type="button" class="zn-url-tab" data-pane="global">全局设置</button>';
      titleEl.querySelectorAll('.zn-url-tab').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var pane = btn.getAttribute('data-pane');
          titleEl.querySelectorAll('.zn-url-tab').forEach(function (b) { b.classList.toggle('is-on', b === btn); });
          body.querySelectorAll('.zn-url-pane').forEach(function (p) {
            var on = p.getAttribute('data-pane') === pane;
            p.classList.toggle('is-on', on);
            if ('inert' in p) p.inert = !on;
          });
        });
      });
    }
    setTimeout(function () {
      var inp = body.querySelector('#zn-url-href');
      var titleInp = body.querySelector('#zn-url-title');
      if (inp) {
        inp.value = extra.href || 'https://';
        inp.focus();
        if (!extra.href) inp.select();
      }
      if (titleInp && extra.title) titleInp.value = extra.title;
    }, 50);
  }

  async function pickFile(asBlock, range, extra) {
    extra = extra || {};
    if (!(window.host && window.host.caps && window.host.caps.file)) {
      if (window.toast) window.toast('选择本机文件请用电脑客户端', 'info');
      return;
    }
    try {
      var sp = await window.host.file.op({
        mode: 'openDialog', filter: '所有文件|*.*', isBinary: 'false', multiSelect: 'false',
      });
      var raw = (sp && sp.result) || '';
      if (!raw) return;
      var parsed = JSON.parse(raw);
      var fileData = Array.isArray(parsed) ? parsed[0] : parsed;
      var filePath = dialogFilePath(fileData);
      if (!isAbsWinPath(filePath)) {
        if (window.toast) window.toast('没有拿到完整路径。请在 Quicker 的 FileOp 里给 openDialog 加上 path（完整路径）', 'warning');
        return;
      }
      var href = encodeFileHref(filePath);
      var name = filePath.split(/[\\/]/).pop() || filePath;
      applyRef({ kind: 'file', href: href, title: name, icon: '📁' }, !!asBlock, range, extra.replacePos);
    } catch (e) { console.warn('[mention-file]', e); }
  }

  function confirmHi(asBlock) {
    if (!_items.length) { hidePicker(); return; }
    var it = _items[_hi];
    if (!it || skipHi(it)) {
      for (var i = 0; i < _items.length; i++) {
        if (!skipHi(_items[i])) { it = _items[i]; break; }
      }
    }
    if (!it || skipHi(it)) { hidePicker(); return; }
    confirmItem(it, asBlock);
  }

  function showPicker(opts) {
    opts = opts || {};
    hideHover();
    _asBlock = !!opts.asBlock;
    _query = opts.query || '';
    if (_query) { _browse = false; _browseWs = ''; }
    _replacePos = (opts.replacePos != null) ? opts.replacePos : null;
    _hasRange = opts.from != null && opts.to != null;
    _rangeFrom = opts.from || 0;
    _rangeTo = opts.to || 0;
    refreshPicker();
  }

  function readAtTrigger() {
    var inst = ed();
    if (!inst || !inst.isEditable) return null;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    var node = range.startContainer;
    var target = node.nodeType === 3 ? node.parentElement : node;
    if (!target || !target.closest || !target.closest('#editor .ProseMirror') || target.closest('pre, code')) return null;
    var $from = inst.state.selection.$from;
    if (!$from.parent.isTextblock) return null;
    var left = inst.state.doc.textBetween($from.start(), $from.pos, '\n', '\ufffc');
    var vis = left.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
    var m = /(^|[\s\n>])@([^\s@]{0,40})$/.exec(vis);
    if (!m) return null;
    var q = m[2] || '';
    var atIdx = left.lastIndexOf('@');
    if (atIdx < 0) return null;
    var from = $from.start() + atIdx;
    if (from >= $from.pos) return null;
    return { query: q, from: from, to: $from.pos };
  }

  function handleAtTrigger() {
    var hit = readAtTrigger();
    if (!hit) { hidePicker(); return; }
    showPicker({ query: hit.query, from: hit.from, to: hit.to, rect: caretClientRect(), asBlock: false });
  }

  function findClassicLinkRange(inst) {
    if (!inst) return null;
    var state = inst.state;
    var type = state.schema.marks.link;
    if (!type) return null;
    var pos = state.selection.from;
    var $pos = state.doc.resolve(pos);
    var mark = type.isInSet($pos.marks());
    if (!mark && pos > 0) mark = type.isInSet(state.doc.resolve(pos - 1).marks());
    if (!mark && $pos.nodeBefore && $pos.nodeBefore.marks) mark = type.isInSet($pos.nodeBefore.marks);
    if (!mark || !mark.attrs || !mark.attrs.href) return null;
    var href = mark.attrs.href;
    var start = $pos.start();
    var runs = [];
    var cur = null;
    $pos.parent.forEach(function (child, offset) {
      var cs = start + offset;
      var ce = cs + child.nodeSize;
      var has = !!(child.marks && child.marks.some(function (m) {
        return m.type === type && m.attrs && m.attrs.href === href;
      }));
      if (has) {
        if (cur && cur.to === cs) cur.to = ce;
        else { cur = { from: cs, to: ce }; runs.push(cur); }
      } else cur = null;
    });
    var run = null;
    var i;
    for (i = 0; i < runs.length; i++) {
      if (runs[i].from <= pos && pos <= runs[i].to) { run = runs[i]; break; }
    }
    if (!run && pos > 0) {
      for (i = 0; i < runs.length; i++) {
        if (runs[i].from <= pos - 1 && pos - 1 <= runs[i].to) { run = runs[i]; break; }
      }
    }
    if (!run) return null;
    var icon = (mark.attrs && mark.attrs.icon) || '';
    var from = run.from;
    var $r = state.doc.resolve(run.from);
    var before = $r.nodeBefore;
    if (before && before.isText && /^\s+$/.test(before.text || '')) {
      from = run.from - before.nodeSize;
      $r = state.doc.resolve(from);
      before = $r.nodeBefore;
    }
    if (before && before.type.name === 'znEmoji') {
      if (!icon) icon = (before.attrs && before.attrs.emoji) || '';
      from = from - before.nodeSize;
    }
    if (!icon) {
      var shown = String(state.doc.textBetween(run.from, run.to, '') || '');
      icon = leadingEmoji(shown);
    }
    return { from: from, to: run.to, href: href, icon: icon };
  }

  function leadingEmoji(text) {
    text = String(text || '').replace(/^\s+/, '');
    if (!text || /^[A-Za-z0-9./:\\]/.test(text)) return '';
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        var it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]();
        var first = it.next();
        var s = first && first.value && first.value.segment;
        if (s && !/^[A-Za-z0-9./:\\]/.test(s)) return s;
      }
    } catch (_) {}
    if (text.charCodeAt(0) >= 0xD800 && text.charCodeAt(0) <= 0xDBFF) return text.slice(0, 2);
    if (text.charCodeAt(0) > 127) return text.charAt(0);
    return '';
  }

  function convertClassicLink() {
    var inst = ed();
    if (!inst) return false;
    var pos = inst.state.selection.from;
    if (window.editor && typeof window.editor.convertClassicLinks === 'function') {
      return !!window.editor.convertClassicLinks(pos);
    }
    return convertThisLink(false);
  }

  function convertThisLink(asBlock) {
    var inst = ed();
    if (!inst) return false;
    var range = findClassicLinkRange(inst);
    if (!range) return false;
    var href = range.href;
    var kind = href.indexOf('file:') === 0 ? 'file' : 'url';
    var icon = range.icon || (kind === 'file' ? '📁' : '🌐');
    var title = kind === 'file' ? (fileName(href) || '文件') : (hostOf(href) || href);
    var attrs = liveAttrs({
      kind: kind, id: '', href: href, title: title, icon: icon,
      hideHost: kind === 'url',
    });
    var ok = inst.chain().focus().command(function (_ref) {
      var tr = _ref.tr, state = _ref.state, dispatch = _ref.dispatch;
      var type = state.schema.nodes.znMention;
      if (!type) return false;
      tr.replaceWith(range.from, range.to, type.create(attrs));
      if (dispatch) dispatch(tr);
      return true;
    }).run();
    if (!ok) return false;
    try { inst.commands.setNodeSelection(range.from); } catch (_) {}
    if (asBlock) return convertToPageLink();
    return true;
  }

  function restoreSelected() {
    var inst = ed();
    var hit = findSelectedRef(inst);
    if (!inst || !hit) return false;
    var a = liveAttrs(hit.node.attrs);
    if (a.kind === 'note') return false;
    var href = String(a.href || '').trim();
    if (!href) return false;
    var display = a.kind === 'file' ? (filePathDisplay(href) || a.title || href) : href;
    if (!display) return false;
    var icon = a.icon || (a.kind === 'file' ? '📁' : '🌐');
    var asBlock = hit.node.type.name === 'znPageLink';
    return inst.chain().focus().command(function (_ref) {
      var tr = _ref.tr, state = _ref.state, dispatch = _ref.dispatch;
      var node = state.doc.nodeAt(hit.pos);
      if (!node) return false;
      var schema = state.schema;
      var linkType = schema.marks.link;
      if (!linkType) return false;
      var label = icon ? (icon + ' ' + display) : display;
      var linked = schema.text(label, [linkType.create({ href: href, plain: true, icon: icon })]);
      if (asBlock) {
        tr.replaceWith(hit.pos, hit.pos + node.nodeSize, schema.nodes.paragraph.create(null, linked));
      } else {
        tr.replaceWith(hit.pos, hit.pos + node.nodeSize, linked);
      }
      if (dispatch) dispatch(tr);
      return true;
    }).run();
  }

  function copySelected() {
    var inst = ed();
    var text = '';
    var hit = findSelectedRef(inst);
    if (hit) text = copyTextOf(hit.node.attrs);
    else {
      var range = findClassicLinkRange(inst);
      if (!range) return false;
      text = copyTextOf({
        kind: range.href.indexOf('file:') === 0 ? 'file' : 'url',
        href: range.href,
        title: '',
      });
    }
    if (!text) return false;
    try { navigator.clipboard.writeText(text); } catch (_) { return false; }
    return true;
  }

  function deleteSelected() {
    var inst = ed();
    if (!inst) return false;
    var hit = findSelectedRef(inst);
    if (hit) {
      return inst.chain().focus().deleteRange({ from: hit.pos, to: hit.pos + hit.node.nodeSize }).run();
    }
    var range = findClassicLinkRange(inst);
    if (!range) return false;
    return inst.chain().focus().deleteRange({ from: range.from, to: range.to }).run();
  }

  function openSelected() {
    var inst = ed();
    var hit = findSelectedRef(inst);
    if (!hit) return false;
    openTarget(liveAttrs(hit.node.attrs));
    return true;
  }

  function openUrlFromToolbar() {
    var inst = ed();
    if (!inst || !inst.isEditable) return;
    if (findSelectedRef(inst)) {
      editSelected();
      return;
    }
    var href = '';
    var title = '';
    var from, to;
    if (inst.isActive && inst.isActive('link')) {
      href = ((inst.getAttributes('link') || {}).href) || '';
      from = inst.state.selection.from;
      to = inst.state.selection.to;
      var $pos = inst.state.selection.$from;
      $pos.parent.forEach(function (child, offset) {
        var childStart = $pos.start() + offset;
        var childEnd = childStart + child.nodeSize;
        var hit = child.marks && child.marks.some(function (m) {
          return m.type.name === 'link' && m.attrs.href === href;
        });
        if (hit && childStart <= $pos.pos && $pos.pos <= childEnd) {
          if (childStart < from) from = childStart;
          if (childEnd > to) to = childEnd;
        }
      });
      title = String(inst.state.doc.textBetween(from, to, ' ') || '').trim();
    } else {
      var sel = inst.state.selection;
      if (!sel.empty) {
        from = sel.from;
        to = sel.to;
        var text = String(inst.state.doc.textBetween(from, to, ' ') || '').trim();
        var url = looksUrl(text);
        if (url) href = url;
        else title = text;
      }
    }
    var range = (from != null && to != null && to > from) ? { from: from, to: to } : null;
    openUrlCard(false, range, { href: href, title: title });
  }

  function openPicker(opts) {
    opts = opts || {};
    var inst = ed();
    if (!inst || !inst.isEditable) return;
    if (findSelectedRef(inst)) {
      editSelected();
      return;
    }
    if (inst.isActive && inst.isActive('link') && convertClassicLink()) return;
    var query = opts.query || '';
    var from, to;
    var sel = inst.state.selection;
    if (sel.empty) {
      from = undefined;
      to = undefined;
    } else {
      from = sel.from;
      to = sel.to;
      if (!query) query = String(inst.state.doc.textBetween(from, to, ' ') || '').trim();
    }
    var url = looksUrl(query);
    if (url && from != null && to != null && to > from) {
      applyRef({ kind: 'url', href: url, title: hostOf(url) || query, icon: '🌐', hideHost: true }, !!opts.asBlock, { from: from, to: to }, null);
      return;
    }
    showPicker({
      query: query,
      asBlock: !!opts.asBlock,
      from: from,
      to: to,
    });
  }

  function findSelectedRef(inst) {
    if (!inst) return null;
    var sel = inst.state.selection;
    if (sel.node && (sel.node.type.name === 'znMention' || sel.node.type.name === 'znPageLink')) {
      return { pos: sel.from, node: sel.node };
    }
    var $from = sel.$from;
    for (var d = $from.depth; d >= 0; d--) {
      var n = $from.node(d);
      if (n && (n.type.name === 'znMention' || n.type.name === 'znPageLink')) {
        var p = d === 0 ? $from.pos : $from.before(d);
        return { pos: p, node: n };
      }
    }
    var pos = sel.from;
    var at = inst.state.doc.nodeAt(pos) || inst.state.doc.nodeAt(Math.max(0, pos - 1));
    if (at && (at.type.name === 'znMention' || at.type.name === 'znPageLink')) {
      return { pos: at === inst.state.doc.nodeAt(pos) ? pos : pos - 1, node: at };
    }
    return null;
  }

  function convertToPageLink() {
    var inst = ed();
    if (!inst) return false;
    var hit = findSelectedRef(inst);
    if (!hit || hit.node.type.name !== 'znMention') return false;
    var attrs = liveAttrs(hit.node.attrs);
    return inst.chain().focus().command(function (_ref) {
      var tr = _ref.tr, state = _ref.state, dispatch = _ref.dispatch;
      var node = state.doc.nodeAt(hit.pos);
      if (!node || node.type.name !== 'znMention') return false;
      var $pos = state.doc.resolve(hit.pos);
      var pageLink = state.schema.nodes.znPageLink.create(attrs);
      var parent = $pos.parent;
      if (!parent.isTextblock) {
        tr.replaceWith(hit.pos, hit.pos + node.nodeSize, pageLink);
        if (dispatch) dispatch(tr);
        return true;
      }
      var blockFrom = $pos.before($pos.depth);
      var blockTo = $pos.after($pos.depth);
      var start = $pos.start($pos.depth);
      var offset = hit.pos - start;
      var beforeCut = parent.cut(0, offset);
      var afterCut = parent.cut(offset + node.nodeSize, parent.content.size);
      var isolating = !!(parent.type.spec && parent.type.spec.isolating);
      var pieces = [];
      if (beforeCut.content.size) pieces.push(parent.type.create(parent.attrs, beforeCut.content));
      pieces.push(pageLink);
      if (afterCut.content.size) pieces.push(parent.type.create(parent.attrs, afterCut.content));
      if (isolating || parent.type.name === 'toggleSummary') {
        tr.delete(hit.pos, hit.pos + node.nodeSize);
        tr.insert(tr.mapping.map(blockTo), pageLink);
      } else {
        tr.replaceWith(blockFrom, blockTo, pieces);
      }
      if (dispatch) dispatch(tr);
      return true;
    }).run();
  }

  function convertToMention() {
    var inst = ed();
    if (!inst) return false;
    var hit = findSelectedRef(inst);
    if (!hit || hit.node.type.name !== 'znPageLink') return false;
    var attrs = liveAttrs(hit.node.attrs);
    return inst.chain().focus().command(function (_ref) {
      var tr = _ref.tr, state = _ref.state, dispatch = _ref.dispatch;
      var node = state.doc.nodeAt(hit.pos);
      if (!node || node.type.name !== 'znPageLink') return false;
      var mention = state.schema.nodes.znMention.create(attrs);
      var $pos = state.doc.resolve(hit.pos);
      var parent = $pos.parent;
      var idx = $pos.index();
      var prev = idx > 0 ? parent.child(idx - 1) : null;
      var next = idx < parent.childCount - 1 ? parent.child(idx + 1) : null;
      var canPrev = !!(prev && prev.isTextblock);
      var canNext = !!(next && next.isTextblock);
      if (canPrev && canNext && prev.type !== next.type) canNext = false;
      var json = [];
      function takeContent(n) {
        var c = n.content && n.content.toJSON();
        if (!c) return;
        if (Array.isArray(c)) json = json.concat(c);
        else json.push(c);
      }
      if (canPrev) takeContent(prev);
      json.push(mention.toJSON());
      if (canNext) takeContent(next);
      var typeName = canPrev ? prev.type.name : (canNext ? next.type.name : 'paragraph');
      var mergedAttrs = canPrev ? prev.attrs : (canNext ? next.attrs : {});
      var from = hit.pos - (canPrev ? prev.nodeSize : 0);
      var to = hit.pos + node.nodeSize + (canNext ? next.nodeSize : 0);
      var merged;
      try {
        merged = state.schema.nodeFromJSON({ type: typeName, attrs: mergedAttrs, content: json });
      } catch (_) {
        merged = state.schema.nodes.paragraph.create(null, mention);
        from = hit.pos;
        to = hit.pos + node.nodeSize;
      }
      tr.replaceWith(from, to, merged);
      if (dispatch) dispatch(tr);
      return true;
    }).run();
  }

  function editSelected() {
    var inst = ed();
    var hit = findSelectedRef(inst);
    if (hit) {
      var a = liveAttrs(hit.node.attrs);
      var asBlock = hit.node.type.name === 'znPageLink';
      if (a.kind === 'url') {
        openUrlCard(asBlock, null, { replacePos: hit.pos, href: a.href, title: a.title, icon: a.icon, hideHost: a.hideHost });
        return true;
      }
      if (a.kind === 'file') {
        pickFile(asBlock, null, { replacePos: hit.pos });
        return true;
      }
      showPicker({ asBlock: asBlock, replacePos: hit.pos });
      return true;
    }
    var range = findClassicLinkRange(inst);
    if (!range) return false;
    if (range.href.indexOf('file:') === 0) {
      pickFile(false, { from: range.from, to: range.to }, { edit: true });
      return true;
    }
    openUrlCard(false, { from: range.from, to: range.to }, {
      edit: true, href: range.href, title: hostOf(range.href) || '', icon: range.icon || '🌐',
    });
    return true;
  }

  function onKeyDown(e) {
    if (!isOpen()) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (mascotOn() && !_asBlock) askMascot();
      else confirmHi(_asBlock);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      confirmHi(_asBlock || e.shiftKey);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      moveHi(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      moveHi(-1);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      hidePicker();
      return;
    }
    if (e.key === 'Backspace') {
      setTimeout(function () { if (!readAtTrigger()) hidePicker(); }, 0);
    }
  }

  function init() {
    bindWebPane();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('compositionend', handleAtTrigger, true);
    document.addEventListener('keyup', function (e) {
      if (e.key === 'Backspace' || e.key === 'Delete') handleAtTrigger();
    }, true);
    document.addEventListener('mousedown', function (e) {
      if (isOpen() && _pick && !_pick.contains(e.target)) hidePicker();
    }, true);
    if (window.storage && typeof window.storage.on === 'function') {
      window.storage.on('change', function (ev) {
        var t = ev && ev.type;
        if (t === 'rename' || t === 'icon' || t === 'delete' || t === 'restore' || t === 'purge' || t === 'global-sync') {
          refreshLive();
        }
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.mentionUi = {
    handleAtTrigger: handleAtTrigger,
    openPicker: openPicker,
    isOpen: isOpen,
    hide: hidePicker,
    paintMention: paintMention,
    paintPageLink: paintPageLink,
    bindChipEvents: bindChipEvents,
    liveAttrs: liveAttrs,
    openTarget: openTarget,
    openWebHref: openWebHref,
    closeWebPane: closeWebPane,
    isWebPaneOpen: isWebPaneOpen,
    webGoBack: webGoBack,
    revealHref: revealHref,
    revealTarget: revealTarget,
    revealSelected: revealSelected,
    convertToPageLink: convertToPageLink,
    convertToMention: convertToMention,
    editSelected: editSelected,
    pickSelectedIcon: pickSelectedIcon,
    toggleHideHost: toggleHideHost,
    convertClassicLink: convertClassicLink,
    convertThisLink: convertThisLink,
    restoreSelected: restoreSelected,
    copySelected: copySelected,
    deleteSelected: deleteSelected,
    openUrlFromToolbar: openUrlFromToolbar,
    openSelected: openSelected,
    refreshLive: refreshLive,
    attrsFromEl: attrsFromDom,
    openFromEl: function (el) { openTarget(attrsFromDom(el)); },
    revealFromEl: function (el) {
      if (!el) return;
      if (el.tagName === 'A') { revealHref(el.getAttribute('href') || ''); return; }
      revealTarget(attrsFromDom(el));
    },
  };
})();
