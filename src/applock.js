/* 应用锁（软锁）——只挡界面、内容不加密；密码只存本机、不随云同步。
 * 触发上锁：冷启动（已开启时）、点右上角叉的瞬间、Ctrl+L、空闲超时（时长可设）。
 * 忘记密码：设了「密保问题」才有兜底重置入口；没设则只能清本机设置解除。
 * 暴露 window.appLock：init / isEnabled / isLocked / lock / mountSettings。
 */
(function () {
  'use strict';

  var K = {
    enabled: 'zhinote.applock.enabled', // '1' / 其它
    salt: 'zhinote.applock.salt',
    hash: 'zhinote.applock.hash',       // 密码指纹
    idle: 'zhinote.applock.idle',       // 空闲自动上锁（分钟）0=关
    secq: 'zhinote.applock.secq',       // 密保问题（明文）
    sech: 'zhinote.applock.sech',       // 密保答案指纹
  };

  function lget(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function ldel(k) { try { localStorage.removeItem(k); } catch (_) {} }

  function isEnabled() { return lget(K.enabled) === '1' && !!lget(K.hash); }
  function idleMin() { var n = parseInt(lget(K.idle) || '0', 10); return (n > 0 && n <= 1440) ? n : 0; }
  function hasSecq() { return !!lget(K.secq) && !!lget(K.sech); }
  function norm(s) { return String(s == null ? '' : s).trim(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function rndSalt() {
    try { var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
    catch (_) { return String(Date.now()) + Math.random().toString(16).slice(2); }
  }
  function hash(txt, salt) {
    var s = (salt || '') + '\u0001' + (txt || '');
    return Promise.resolve().then(function () {
      if (window.crypto && crypto.subtle && crypto.subtle.digest) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        });
      }
      var h = 5381; for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; } return 'f' + h.toString(16);
    });
  }

  // —— 轻量提示（不依赖 app.js 的 toast）——
  function note(msg) {
    var d = document.createElement('div'); d.className = 'applock-note'; d.textContent = msg;
    document.body.appendChild(d);
    requestAnimationFrame(function () { d.classList.add('show'); });
    setTimeout(function () { d.classList.remove('show'); setTimeout(function () { try { d.remove(); } catch (_) {} }, 250); }, 1800);
  }

  // —— 小对话框：返回 Promise（确定→值对象，取消→null）；hint 为可选的提醒文字 ——
  function dialog(title, rows, okText, hint) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div'); mask.className = 'applock-dlg-mask';
      var rowsHtml = rows.map(function (r) {
        return '<label class="applock-dlg-row"><span>' + esc(r.label) + '</span>'
          + '<input data-id="' + r.id + '" type="' + (r.type || 'text') + '" autocomplete="off" spellcheck="false"></label>';
      }).join('');
      mask.innerHTML = '<div class="applock-dlg" role="dialog"><div class="applock-dlg-t">' + esc(title) + '</div>'
        + rowsHtml
        + (hint ? '<div class="applock-dlg-note">' + esc(hint) + '</div>' : '')
        + '<div class="applock-dlg-btns"><button type="button" class="applock-dlg-cancel">取消</button>'
        + '<button type="button" class="applock-dlg-ok">' + esc(okText || '确定') + '</button></div></div>';
      document.body.appendChild(mask);
      var inputs = mask.querySelectorAll('input');
      var done = false;
      function close(v) { if (done) return; done = true; try { mask.remove(); } catch (_) {} resolve(v); }
      function submit() { var out = {}; inputs.forEach(function (i) { out[i.dataset.id] = i.value; }); close(out); }
      mask.querySelector('.applock-dlg-ok').addEventListener('click', submit);
      mask.querySelector('.applock-dlg-cancel').addEventListener('click', function () { close(null); });
      mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(null); });
      inputs.forEach(function (i, idx) {
        i.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); if (idx < inputs.length - 1) inputs[idx + 1].focus(); else submit(); }
          else if (e.key === 'Escape') { e.preventDefault(); close(null); }
        });
      });
      setTimeout(function () { try { if (inputs[0]) inputs[0].focus(); } catch (_) {} }, 40);
    });
  }

  // ===== 锁屏遮罩 =====
  var _locked = false, _idleTimer = null, _wired = false;
  function overlay() { return document.getElementById('applock-overlay'); }

  function showOverlay() {
    document.documentElement.classList.add('applock-showing');
    var i = document.getElementById('applock-input'); if (i) { i.type = 'password'; i.value = ''; }
    var e = document.getElementById('applock-err'); if (e) e.textContent = '';
    var f = document.getElementById('applock-forgot'); if (f) f.hidden = !hasSecq();
    setTimeout(function () { try { if (i) i.focus(); } catch (_) {} }, 60);
  }
  function hideOverlay() {
    document.documentElement.classList.remove('applock-showing');
    var ov = overlay(); if (ov) ov.classList.remove('applock-wrong');
  }

  function lock() { if (!isEnabled() || _locked) return; _locked = true; stopIdle(); showOverlay(); }
  function isLocked() { return _locked; }

  function tryUnlock(pw) {
    return hash(pw, lget(K.salt) || '').then(function (h) {
      if (h === lget(K.hash)) { _locked = false; hideOverlay(); startIdle(); return true; }
      return false;
    });
  }

  // 空闲自动上锁
  function stopIdle() { if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; } }
  function startIdle() { stopIdle(); var m = idleMin(); if (!isEnabled() || _locked || m <= 0) return; _idleTimer = setTimeout(lock, m * 60000); }
  function bumpIdle() { if (_locked || !isEnabled() || idleMin() <= 0) return; startIdle(); }

  function wireOverlay() {
    if (_wired) return; var ov = overlay(); if (!ov) return; _wired = true;
    var input = document.getElementById('applock-input');
    var btn = document.getElementById('applock-unlock');
    var eye = document.getElementById('applock-eye');
    var err = document.getElementById('applock-err');
    var forgot = document.getElementById('applock-forgot');
    function attempt() {
      tryUnlock(input ? input.value : '').then(function (ok) {
        if (!ok) {
          if (err) err.textContent = '密码不对';
          ov.classList.add('applock-wrong'); setTimeout(function () { ov.classList.remove('applock-wrong'); }, 420);
          if (input) { input.select(); }
        }
      });
    }
    if (btn) btn.addEventListener('click', attempt);
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); attempt(); } });
    if (eye) eye.addEventListener('click', function () { if (!input) return; input.type = input.type === 'password' ? 'text' : 'password'; input.focus(); });
    if (forgot) forgot.addEventListener('click', onForgot);
  }

  function onForgot() {
    if (!hasSecq()) return;
    dialog('忘记密码', [{ id: 'a', label: lget(K.secq), type: 'text' }], '验证').then(function (r) {
      if (!r) return;
      hash(norm(r.a).toLowerCase(), lget(K.salt) || '').then(function (h) {
        if (h !== lget(K.sech)) { note('密保答案不对'); return; }
        dialog('设置新密码', [{ id: 'p1', label: '新密码', type: 'password' }, { id: 'p2', label: '再输一遍', type: 'password' }], '保存').then(function (np) {
          if (!np) return;
          if (!norm(np.p1)) { note('密码不能为空'); return; }
          if (np.p1 !== np.p2) { note('两次输入不一致'); return; }
          setPassword(np.p1).then(function () { _locked = false; hideOverlay(); startIdle(); note('密码已重置'); });
        });
      });
    });
  }

  function setPassword(pw) {
    var salt = rndSalt();
    return hash(pw, salt).then(function (h) { lset(K.salt, salt); lset(K.hash, h); lset(K.enabled, '1'); });
  }

  // ===== 设置面板 =====
  function idleInputHtml(cur) {
    return '<span class="applock-num">'
      + '<input type="number" class="applock-num-i" id="applock-idle" min="0" max="1440" step="1" inputmode="numeric" value="' + (cur > 0 ? cur : '') + '" placeholder="0">'
      + '<span class="applock-num-u">分钟</span></span>';
  }
  function row(title, sub, ctrl) {
    return '<div class="applock-row"><div class="applock-lbl">' + esc(title)
      + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' + ctrl + '</div>';
  }
  function settingsHtml() {
    var on = isEnabled();
    var h = '<div class="applock-set">';
    h += row('启用应用锁', '仅锁定界面，不加密笔记内容', '<span class="applock-sw' + (on ? ' on' : '') + '" id="applock-sw" role="switch" tabindex="0"></span>');
    if (on) {
      h += row('修改密码', '', '<button type="button" class="applock-btn" id="applock-chpw">修改</button>');
      h += row('空闲自动锁定', '多少分钟无操作后自动锁定，0 = 关闭', idleInputHtml(idleMin()));
      h += row('密保问题', hasSecq() ? '已设置，可用于找回密码' : '可选，用于忘记密码时重置', '<button type="button" class="applock-btn" id="applock-secq">' + (hasSecq() ? '修改 / 清除' : '设置') + '</button>');
      h += row('立即锁定', '', '<span class="applock-hint"><span class="applock-kbd">Ctrl</span>+<span class="applock-kbd">L</span></span>');
    }
    return h + '</div>';
  }

  var _panelEl = null;
  function rerender() { if (_panelEl) { _panelEl.innerHTML = settingsHtml(); bindPanel(); } }

  function enableFlow() {
    dialog('设置密码', [{ id: 'p1', label: '密码', type: 'password' }, { id: 'p2', label: '再输一遍', type: 'password' }], '开启',
      '请牢记此密码。一旦忘记且未设置密保问题，将无法进入笔记（软锁无法被强制解开）。').then(function (r) {
      if (!r) { rerender(); return; }
      if (!norm(r.p1)) { note('密码不能为空'); rerender(); return; }
      if (r.p1 !== r.p2) { note('两次输入不一致'); rerender(); return; }
      setPassword(r.p1).then(function () { startIdle(); note('应用锁已开启'); rerender(); });
    });
  }
  function disableFlow() {
    dialog('关闭应用锁', [{ id: 'p', label: '输入当前密码', type: 'password' }], '关闭').then(function (r) {
      if (!r) { rerender(); return; }
      hash(r.p, lget(K.salt) || '').then(function (hh) {
        if (hh !== lget(K.hash)) { note('密码不对'); rerender(); return; }
        ldel(K.enabled); ldel(K.hash); ldel(K.salt); ldel(K.secq); ldel(K.sech); stopIdle();
        note('应用锁已关闭'); rerender();
      });
    });
  }
  function changePwFlow() {
    dialog('修改密码', [{ id: 'c', label: '当前密码', type: 'password' }, { id: 'p1', label: '新密码', type: 'password' }, { id: 'p2', label: '再输一遍', type: 'password' }], '保存').then(function (r) {
      if (!r) return;
      hash(r.c, lget(K.salt) || '').then(function (hh) {
        if (hh !== lget(K.hash)) { note('当前密码不对'); return; }
        if (!norm(r.p1)) { note('新密码不能为空'); return; }
        if (r.p1 !== r.p2) { note('两次输入不一致'); return; }
        setPassword(r.p1).then(function () { note('密码已修改'); });
      });
    });
  }
  function secqFlow() {
    if (hasSecq()) {
      dialog('密保问题', [{ id: 'q', label: '问题（留空=清除密保）', type: 'text' }, { id: 'a', label: '答案（留空=清除密保）', type: 'text' }], '保存').then(function (r) {
        if (!r) return;
        if (!norm(r.q) || !norm(r.a)) { ldel(K.secq); ldel(K.sech); note('已清除密保'); rerender(); return; }
        hash(norm(r.a).toLowerCase(), lget(K.salt) || '').then(function (h) { lset(K.secq, norm(r.q)); lset(K.sech, h); note('密保已更新'); rerender(); });
      });
    } else {
      dialog('设置密保问题', [{ id: 'q', label: '问题', type: 'text' }, { id: 'a', label: '答案', type: 'text' }], '保存').then(function (r) {
        if (!r) return;
        if (!norm(r.q) || !norm(r.a)) { note('问题和答案都要填'); return; }
        hash(norm(r.a).toLowerCase(), lget(K.salt) || '').then(function (h) { lset(K.secq, norm(r.q)); lset(K.sech, h); note('密保已设置'); rerender(); });
      });
    }
  }

  function bindPanel() {
    if (!_panelEl) return;
    var sw = _panelEl.querySelector('#applock-sw');
    if (sw) {
      var toggle = function () { if (isEnabled()) disableFlow(); else enableFlow(); };
      sw.addEventListener('click', toggle);
      sw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    var chpw = _panelEl.querySelector('#applock-chpw'); if (chpw) chpw.addEventListener('click', changePwFlow);
    var secq = _panelEl.querySelector('#applock-secq'); if (secq) secq.addEventListener('click', secqFlow);
    var idle = _panelEl.querySelector('#applock-idle');
    if (idle) {
      var saveIdle = function () {
        var v = parseInt(idle.value, 10); if (!(v >= 0)) v = 0; if (v > 1440) v = 1440;
        lset(K.idle, String(v)); startIdle();
        idle.value = v > 0 ? v : '';
      };
      idle.addEventListener('change', saveIdle);
      idle.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); idle.blur(); } });
    }
  }

  function mountSettings(el) { if (!el) return; _panelEl = el; el.innerHTML = settingsHtml(); bindPanel(); }

  function focusInput() {
    var i = document.getElementById('applock-input');
    if (i) { try { i.focus(); } catch (_) {} }
  }
  // 锁定时窗口重新获得焦点/变可见后，把焦点抢回密码框——Quicker 显示窗口时会 editor.focus()，
  // 否则用户看到锁屏却打不了字。延时略久，压过 app.js 那边 50ms 的 editor.focus()。
  function refocusIfLocked() { if (_locked) setTimeout(focusInput, 80); }

  // 触屏设备（手机/平板）：切走 App / 息屏 / 切标签就锁；电脑端不受影响（沿用点叉即锁 + Ctrl+L）。
  var IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  // 选文件/选图会临时把页面切到系统选择器，不能因此误锁：触发文件选择器时挂个时间窗，期间隐藏不上锁。
  var _pickUntil = 0;
  function isPicking() { return Date.now() < _pickUntil; }

  // ===== 初始化 =====
  function init() {
    wireOverlay();
    // 锁定时拦截所有键盘事件，防止 Ctrl+P 等全局快捷键在锁屏背后触发；只放行锁屏/其内对话框里的输入。
    // 用捕获阶段并最先注册，才能 stopImmediatePropagation 掉 app.js 后注册的监听。
    document.addEventListener('keydown', function (e) {
      if (!_locked) return;
      var t = e.target;
      if (t && t.closest && (t.closest('#applock-overlay') || t.closest('.applock-dlg-mask'))) return;
      e.stopImmediatePropagation(); e.preventDefault();
    }, true);
    window.addEventListener('focus', function () { refocusIfLocked(); if (_pickUntil) setTimeout(function () { _pickUntil = 0; }, 800); });
    // 文件选择器打开：给一个较长的时间窗（点系统选择器可能停留很久），从选择器返回时再解除。
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('input[type="file"]')) _pickUntil = Date.now() + 5 * 60 * 1000;
    }, true);
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.matches && t.matches('input[type="file"]')) setTimeout(function () { _pickUntil = 0; }, 800);
    }, true);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        // 手机/平板：真正切走/息屏就锁（选文件那种一瞬切换不算）
        if (IS_TOUCH && isEnabled() && !_locked && !isPicking()) { try { lock(); } catch (_) {} }
      } else {
        refocusIfLocked();
      }
    });
    if (isEnabled()) { _locked = true; showOverlay(); }
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
      document.addEventListener(ev, bumpIdle, true);
    });
    if (isEnabled() && !_locked) startIdle();
  }

  window.appLock = {
    init: init,
    isEnabled: isEnabled,
    isLocked: isLocked,
    lock: lock,
    focusInput: focusInput,
    mountSettings: mountSettings,
  };
})();
