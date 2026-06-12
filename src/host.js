/* host.js — 宿主能力适配层（多端基础设施）
 *
 * 目的：把"运行环境相关"的调用（窗口控制 / 本地文件 / 原生存储桥 / 宿主消息）统一收口，
 * 让同一份前端既能跑在 Quicker(WebView2) 桌面宿主，也能跑在普通浏览器 / PWA。
 *
 * 设计：
 *  - `host.caps`：能力探测。Quicker 宿主有窗口/文件/原生存储/消息能力；浏览器宿主都没有。
 *    UI 用它隐藏网页端用不到的按钮（窗口控制、本地导入导出等）。
 *  - 窗口/边框类调用在非 Quicker 宿主下变为安全 no-op（浏览器/系统自管窗口）。
 *  - 文件类调用在非 Quicker 宿主下抛错——调用方应先判 `host.caps.file`，改走浏览器下载/上传。
 *
 * 现阶段（阶段0）：host 只是对现有 `window.$quickerSp` 的一层薄封装，桌面行为完全不变。
 * 后续逐步把散落的 FileOp/WindowOp 调用迁移到 host，再据 caps 做网页端降级。
 */
(function () {
  'use strict';

  function hasSp() { return typeof window.$quickerSp === 'function'; }

  // 与 storage.js 的 isQuicker 同口径：存在 $quicker 桥 + chrome.webview。
  function isQuicker() {
    if (typeof window.$quicker === 'undefined' && typeof window.$quickerSync === 'undefined') return false;
    if (typeof window.chrome === 'undefined' || !window.chrome.webview) return false;
    return true;
  }

  // 能力探测（用 getter 实时取值：$quickerSp 是异步注入的，启动早期可能还没就绪）。
  var caps = {
    get quicker() { return isQuicker(); },
    get window() { return hasSp(); },     // 窗口控制：最小化/最大化/复位/最小尺寸/去边框
    get file() { return hasSp(); },       // 本地文件读写 / 系统对话框
    get nativeStore() { return isQuicker(); }, // $quicker getVar/setVar 原生持久化
    get messages() { return !!(window.chrome && window.chrome.webview); }, // 宿主→前端消息
  };

  // 通用子程序直通（Quicker 专属）。非 Quicker 宿主下抛错。
  function sp(name, args) {
    if (!hasSp()) return Promise.reject(new Error('host: 子程序不可用（非 Quicker 宿主）：' + name));
    return window.$quickerSp(name, args || {});
  }
  // 安全直通：非 Quicker 宿主或失败时静默返回 null（用于 fire-and-forget）。
  function spSafe(name, args) {
    if (!hasSp()) return Promise.resolve(null);
    return window.$quickerSp(name, args || {}).catch(function () { return null; });
  }

  var win = {
    available: function () { return hasSp(); },
    // 统一窗口操作 → 子程序 WindowOp（中文 mode）。非 Quicker 宿主静默忽略（返回 null）。
    op: function (mode, extra) {
      if (!hasSp()) return Promise.resolve(null);
      return window.$quickerSp('WindowOp', Object.assign({ mode: mode }, extra || {}));
    },
    // 同步窗口边框色（仅 Quicker 无边框窗口需要）。非 Quicker 宿主无操作。
    removeBorder: function (color) { return spSafe('RemoveBorder', { color: color }); },
  };

  var file = {
    available: function () { return hasSp(); },
    // 直通 FileOp 各模式；非 Quicker 宿主抛错（调用方应先判 host.caps.file）。
    op: function (args) {
      if (!hasSp()) return Promise.reject(new Error('host: 文件能力不可用（非 Quicker 宿主）'));
      return window.$quickerSp('FileOp', args || {});
    },
  };

  window.host = {
    isQuicker: isQuicker,
    caps: caps,
    sp: sp,
    spSafe: spSafe,
    window: win,
    file: file,
  };
})();
