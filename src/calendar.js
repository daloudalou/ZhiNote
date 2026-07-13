/**
 * 日历块引擎 window.ZhiCalendar
 * ------------------------------------------------------------------
 * 职责：把「日历块」的农历/节气/节日精确计算 + 交互渲染集中在此，供 editor.js 的
 *   calendarBlock 节点（atom）挂载。数据以**规范化 JSON 字符串**存于节点 attrs.data，
 *   序列化为 ```calendar 围栏块（见 editor.js），保证 md→doc→md 往返稳定、不产生幻影编辑。
 *
 * 对外接口：
 *   ZhiCalendar.defaultData()            → 当月默认数据（规范 JSON 串）
 *   ZhiCalendar.mount(dom, dataStr, cb)  → 挂载到 dom，数据变化时 cb(newStr)；返回 {update,destroy}
 *   ZhiCalendar._pendingAutoOpen         → 插入后自动弹当月月历（一次性）
 *
 * 农历算法采用业界通用的 1900–2100 lunarInfo 表 + 天文节气偏移表（与开源日历库一致，逐日精确）。
 */
(function () {
  'use strict';

  // ===== 农历数据表（1900–2100，通用实现） =====
  var lunarInfo = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
    0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
    0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
    0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
    0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
    0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
    0x0d520,
  ];

  // 24 节气相对 1900-01-06 02:05 的分钟偏移基准表
  var sTermInfo = [
    0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
    263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758,
  ];
  var solarTerm = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
    '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];

  var Gan = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  var Zhi = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  var Animals = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
  var nStr1 = ['日', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  var monthCn = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];

  // 阳历固定节日
  var SOLAR_FEST = {
    '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '3-12': '植树节', '4-1': '愚人节',
    '5-1': '劳动节', '5-4': '青年节', '6-1': '儿童节', '7-1': '建党节', '8-1': '建军节',
    '9-10': '教师节', '10-1': '国庆', '12-24': '平安夜', '12-25': '圣诞节',
  };
  var LUNAR_FEST = {
    '1-1': '春节', '1-15': '元宵', '2-2': '龙头节', '5-5': '端午', '7-7': '七夕',
    '7-15': '中元', '8-15': '中秋', '9-9': '重阳', '12-8': '腊八', '12-23': '小年',
  };

  function leapMonth(y) { return lunarInfo[y - 1900] & 0xf; }
  function leapDays(y) { if (leapMonth(y)) return (lunarInfo[y - 1900] & 0x10000) ? 30 : 29; return 0; }
  function monthDays(y, m) { return (lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
  function lYearDays(y) {
    var i, sum = 348;
    for (i = 0x8000; i > 0x8; i >>= 1) sum += (lunarInfo[y - 1900] & i) ? 1 : 0;
    return sum + leapDays(y);
  }

  function solar2lunar(y, m, d) {
    if (y < 1900 || y > 2100) return { year: y, month: 1, day: 1, isLeap: false, ok: false };
    var offset = (Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000;
    var temp = 0, i, leap = 0, isLeap = false;
    for (i = 1900; i < 2101 && offset > 0; i++) { temp = lYearDays(i); offset -= temp; }
    if (offset < 0) { offset += temp; i--; }
    var year = i;
    leap = leapMonth(i);
    for (i = 1; i < 13 && offset > 0; i++) {
      if (leap > 0 && i === (leap + 1) && !isLeap) { --i; isLeap = true; temp = leapDays(year); }
      else { temp = monthDays(year, i); }
      if (isLeap && i === (leap + 1)) isLeap = false;
      offset -= temp;
    }
    if (offset === 0 && leap > 0 && i === leap + 1) {
      if (isLeap) { isLeap = false; } else { isLeap = true; --i; }
    }
    if (offset < 0) { offset += temp; --i; }
    return { year: year, month: i, day: offset + 1, isLeap: isLeap, ok: true };
  }

  function getTerm(y, n) {
    var off = new Date((31556925974.7 * (y - 1900) + sTermInfo[n - 1] * 60000) + Date.UTC(1900, 0, 6, 2, 5, 0));
    return off.getUTCDate();
  }
  function toChinaDay(d) {
    switch (d) {
      case 10: return '初十';
      case 20: return '二十';
      case 30: return '三十';
      default: return ['初', '十', '廿', '卅'][Math.floor(d / 10)] + nStr1[d % 10];
    }
  }
  function monthLabel(mo, isLeap) { return (isLeap ? '闰' : '') + monthCn[mo - 1] + '月'; }
  function ganzhiYear(y) { var g = (y - 4) % 10, z = (y - 4) % 12; if (g < 0) g += 10; if (z < 0) z += 12; return Gan[g] + Zhi[z]; }
  function zodiac(y) { var z = (y - 4) % 12; if (z < 0) z += 12; return Animals[z]; }

  function lunarFest(lu) {
    if (lu.isLeap) return '';
    var key = lu.month + '-' + lu.day;
    if (LUNAR_FEST[key]) return LUNAR_FEST[key];
    if (lu.month === 12 && lu.day === monthDays(lu.year, 12)) return '除夕';
    return '';
  }

  // 汇总某阳历日的农历/节气/节日信息
  function dayInfo(y, m0, d) {
    var lu = solar2lunar(y, m0 + 1, d);
    var term = '';
    if (lu.ok) {
      if (d === getTerm(y, m0 * 2 + 1)) term = solarTerm[m0 * 2];
      else if (d === getTerm(y, m0 * 2 + 2)) term = solarTerm[m0 * 2 + 1];
    }
    return {
      lunar: lu,
      lunarDay: lu.ok ? toChinaDay(lu.day) : '',
      lunarMonth: lu.ok ? monthLabel(lu.month, lu.isLeap) : '',
      isFirst: lu.ok && lu.day === 1,
      term: term,
      solarFest: SOLAR_FEST[(m0 + 1) + '-' + d] || '',
      lunarFest: lu.ok ? lunarFest(lu) : '',
      ganzhi: lu.ok ? ganzhiYear(lu.year) : '',
      zodiac: lu.ok ? zodiac(lu.year) : '',
    };
  }

  // ===== 规范化 JSON（键排序，保证往返/跨端指纹稳定） =====
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      var out = {}, ks = Object.keys(v).sort();
      for (var i = 0; i < ks.length; i++) out[ks[i]] = sortKeys(v[ks[i]]);
      return out;
    }
    return v;
  }
  function canon(obj) { try { return JSON.stringify(sortKeys(obj)); } catch (_) { return '{}'; } }

  var DEFAULT_OPTS = { startMon: true, wend: true, today: true, lunar: true, term: true, fest: true, almanac: true, compact: true, style: 'D' };
  var OPTS = [['today', '今日高亮'], ['wend', '周末标红'], ['startMon', '周一起始'], ['lunar', '显示农历'], ['term', '显示节气'], ['fest', '显示节假日'], ['almanac', '显示黄历'], ['compact', '精简记事']];
  var STYLES = [['A', '简约'], ['B', '细线'], ['C', '卡片'], ['D', '柔底']];

  // 「上次选择的显示设置」记忆：只作下一个【新建】日历的默认；不改动任何已存在日历（它们各存各的 opts）。
  // 存本地（localStorage），属本机 UI 偏好，不进笔记数据、不参与同步/序列化。
  var CAL_DEF_KEY = 'zhi-cal-default-opts';
  function loadDefOpts() {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(CAL_DEF_KEY) || '{}') || {}; } catch (_) { o = {}; }
    var opts = {};
    for (var k in DEFAULT_OPTS) {
      var dv = DEFAULT_OPTS[k];
      if (typeof dv === 'boolean') opts[k] = (typeof o[k] === 'boolean') ? o[k] : dv;
      else opts[k] = (o[k] != null) ? o[k] : dv;
    }
    if (['A', 'B', 'C', 'D'].indexOf(opts.style) < 0) opts.style = DEFAULT_OPTS.style;
    return opts;
  }
  function saveDefOpts(opts) {
    try { localStorage.setItem(CAL_DEF_KEY, JSON.stringify(opts || {})); } catch (_) {}
  }
  var WK_MON = ['一', '二', '三', '四', '五', '六', '日'];
  var WK_SUN = ['日', '一', '二', '三', '四', '五', '六'];

  // 头部图标：与笔记侧栏底部一致的线性图标（stroke=currentColor，圆角）
  var IC_TODAY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="16" rx="4"/><line x1="3.5" y1="9" x2="20.5" y2="9"/><line x1="8" y1="2.5" x2="8" y2="6"/><line x1="16" y1="2.5" x2="16" y2="6"/><circle cx="12" cy="14.5" r="2" fill="currentColor" stroke="none"/></svg>';
  // 任务勾选：白色对勾（放在填色圆内）；进度小勾用 currentColor。
  var IC_CHECK = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  var IC_CHECK_S = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  // 主题图标：复用主窗口左下角「主题」按钮的调色盘图标
  var IC_SET = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.55 0 1-.45 1-1 0-.27-.11-.52-.29-.71-.18-.18-.29-.43-.29-.71 0-.55.45-1 1-1H15c3.31 0 6-2.69 6-6 0-4.96-4.04-9-9-9z"/></svg>';

  // 记事颜色（与笔记标题颜色 COLOR_PRESETS 保持一致，见 tree.js）
  var COLOR_PRESETS = [
    { name: '无颜色', value: null },
    { name: '红色', value: '#f53f3f' },
    { name: '橙色', value: '#ff9500' },
    { name: '黄色', value: '#f7ba1e' },
    { name: '绿色', value: '#00b42a' },
    { name: '青色', value: '#14c9c9' },
    { name: '蓝色', value: '#3370ff' },
    { name: '紫色', value: '#7928ca' },
    { name: '粉色', value: '#e91e63' },
    { name: '灰色', value: '#86909c' },
  ];
  // 记事条目：无色时存字符串，有色时存 { t, c }（既省体积又向后兼容旧纯字符串数据）。
  function noteText(n) { return (typeof n === 'string') ? n : ((n && n.t) || ''); }
  function noteColor(n) { return (typeof n === 'string') ? null : ((n && n.c) || null); }
  function noteDone(n) { return !!(n && typeof n === 'object' && n.done === true); }
  // 无色无完成 → 存字符串（省体积、向后兼容）；否则存对象 { t, c?, done? }。
  function makeNote(t, c, done) {
    if (!c && !done) return t;
    var o = { t: t };
    if (c) o.c = c;
    if (done) o.done = true;
    return o;
  }

  // 存盘对象：过滤空记事、规范化条目（无色→字符串），保证不写入空条目、跨端稳定。
  function toObj(S) {
    var notes = {};
    Object.keys(S.notes || {}).forEach(function (k) {
      var arr = (S.notes[k] || [])
        .filter(function (n) { return noteText(n).trim(); })
        .map(function (n) { return makeNote(noteText(n).trim(), noteColor(n), noteDone(n)); });
      if (arr.length) notes[k] = arr;
    });
    return { v: 1, y: S.y, m: S.m, opts: S.opts, notes: notes };
  }
  function parse(str) {
    var o = {};
    try { o = JSON.parse(str || '{}') || {}; } catch (_) { o = {}; }
    var n = new Date();
    var opts = {};
    for (var k in DEFAULT_OPTS) {
      var dv = DEFAULT_OPTS[k];
      if (typeof dv === 'boolean') opts[k] = (o.opts && typeof o.opts[k] === 'boolean') ? o.opts[k] : dv;
      else opts[k] = (o.opts && o.opts[k] != null) ? o.opts[k] : dv;
    }
    // 向后兼容：旧数据存的是 startSun（周日起始），迁移成 startMon（周一起始）。
    if (o.opts && typeof o.opts.startMon !== 'boolean' && typeof o.opts.startSun === 'boolean') opts.startMon = !o.opts.startSun;
    // 向后兼容：t22 早期用过 fit(=展开)，语义反转为 compact(=精简)：compact = !fit。
    if (o.opts && typeof o.opts.compact !== 'boolean' && typeof o.opts.fit === 'boolean') opts.compact = !o.opts.fit;
    if (['A', 'B', 'C', 'D'].indexOf(opts.style) < 0) opts.style = DEFAULT_OPTS.style;
    return {
      y: Number.isFinite(o.y) ? o.y : n.getFullYear(),
      m: (o.m >= 0 && o.m <= 11) ? o.m : n.getMonth(),
      opts: opts,
      notes: (o.notes && typeof o.notes === 'object' && !Array.isArray(o.notes)) ? o.notes : {},
    };
  }
  function defaultData() {
    var n = new Date();
    // 新建日历用「上次选择的设置」作默认（首次即全局默认）。
    return canon({ v: 1, y: n.getFullYear(), m: n.getMonth(), opts: loadDefOpts(), notes: {} });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function matrix(y, m, startSun) {
    var di = new Date(y, m + 1, 0).getDate();
    var lead = new Date(y, m, 1).getDay();
    lead = startSun ? lead : (lead === 0 ? 6 : lead - 1);
    var c = [], d, i;
    for (i = 0; i < lead; i++) c.push(null);
    for (d = 1; d <= di; d++) c.push(d);
    while (c.length % 7) c.push(null);
    var r = [];
    for (i = 0; i < c.length; i += 7) r.push(c.slice(i, i + 7));
    return r;
  }

  // ===== 挂载一个日历实例 =====
  function mount(dom, dataStr, onChange) {
    var S = parse(dataStr);
    var _data = (typeof dataStr === 'string' && dataStr) ? dataStr : canon(toObj(S));
    var now = new Date();
    var TODAY = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
    var card = null, cardDay = 0, cardDocDown = null;
    var wheelLock = 0, popWheelLock = 0;
    var py = S.y, pmode = 'm'; // 月历弹层：'m'=选月 / 'y'=选年
    var openColorIdx = -1, softTimer = null, hoverTip = null;
    function scheduleSoftCommit() { if (softTimer) clearTimeout(softTimer); softTimer = setTimeout(function () { softTimer = null; commit(); }, 350); }
    function flushSoftCommit() { if (softTimer) { clearTimeout(softTimer); softTimer = null; } commit(); }

    // 简约黄历一行：干支年 + 农历月日 + 生肖（+ 节气/节日）。
    function almanacLine(d) {
      var info = dayInfo(S.y, S.m, d);
      if (!info.lunar.ok) return '';
      var s = info.ganzhi + '年' + info.lunarMonth + info.lunarDay + ' · 属' + info.zodiac;
      if (info.term) s += ' · ' + info.term;
      var fe = info.solarFest || info.lunarFest;
      if (fe) s += ' · ' + fe;
      return s;
    }

    // 悬停预览：某天有记事（≥1 条）就 hover 显示全部、完整不省略（浮层，pointer-events:none 不挡操作）。
    function showTip(d, td) {
      var arr = (S.notes[noteKey(d)] || []).filter(function (n) { return noteText(n).trim(); });
      if (arr.length < 1) { hideTip(); return; }
      if (!hoverTip) { hoverTip = document.createElement('div'); hoverTip.className = 'cal-hovertip hidden'; document.body.appendChild(hoverTip); }
      var alm = S.opts.almanac ? almanacLine(d) : '';
      hoverTip.innerHTML = '<div class="cal-hovertip-h">' + (S.m + 1) + ' 月 ' + d + ' 日 · ' + arr.length + ' 条记事</div>'
        + (alm ? '<div class="cal-hovertip-alm">' + esc(alm) + '</div>' : '')
        + arr.map(function (n) {
          var c = noteColor(n);
          return '<div class="cal-hovertip-i' + (noteDone(n) ? ' done' : '') + '"><span class="cal-n-dot' + (c ? '' : ' cal-n-dot-empty') + '"' + (c ? ' style="background:' + c + '"' : '') + '></span><span class="cal-hovertip-t">' + esc(noteText(n)) + '</span></div>';
        }).join('');
      hoverTip.classList.remove('hidden');
      var r = td.getBoundingClientRect();
      var tw = hoverTip.offsetWidth, th = hoverTip.offsetHeight;
      var left = r.left, top = r.bottom + 6;
      if (left + tw > window.innerWidth - 8) left = window.innerWidth - 8 - tw;
      if (left < 8) left = 8;
      if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 6);
      hoverTip.style.left = Math.round(left) + 'px';
      hoverTip.style.top = Math.round(top) + 'px';
    }
    function hideTip() { if (hoverTip) hoverTip.classList.add('hidden'); }

    function isToday(d) { return S.y === TODAY.y && S.m === TODAY.m && d === TODAY.d; }
    function wendCol(ci) { var startSun = !S.opts.startMon; return S.opts.wend && (startSun ? (ci === 0 || ci === 6) : (ci === 5 || ci === 6)); }
    function noteKey(d) { return S.y + '-' + (S.m + 1) + '-' + d; }
    function cellSub(d) {
      var info = dayInfo(S.y, S.m, d);
      if (S.opts.fest) { var f = info.solarFest || info.lunarFest; if (f) return { text: f, cls: 'fest' }; }
      if (S.opts.term && info.term) return { text: info.term, cls: 'term' };
      if (S.opts.lunar) return { text: info.isFirst ? info.lunarMonth : info.lunarDay, cls: 'lunar' };
      return null;
    }
    // 幂等：数据没真变就只重绘、不回写节点，避免"点开日子又离开(临时空记事增删)"触发幻影编辑判脏。
    function commit() { var next = canon(toObj(S)); render(); if (next !== _data) { _data = next; if (onChange) onChange(_data); } }

    function render() {
      dom.setAttribute('data-cal-style', S.opts.style || 'A');
      dom.setAttribute('data-cal-fit', S.opts.compact ? '0' : '1');
      var startSun = !S.opts.startMon;
      var head = startSun ? WK_SUN : WK_MON;
      var rows = matrix(S.y, S.m, startSun);
      var h = '<div class="cal-head">'
        + '<span class="cal-title" title="点击选择年月">' + S.y + ' 年 ' + (S.m + 1) + ' 月 <span class="cal-caret">▾</span></span>'
        + '<button class="cal-today" type="button" title="回到今天">' + IC_TODAY + '</button>'
        + '<button class="cal-setbtn" title="显示设置">' + IC_SET + '</button>'
        + '<div class="cal-pop cal-pop-month hidden"><div class="cal-pop-h"><button class="cal-py" type="button">‹</button><span class="cal-y"></span><button class="cal-ny" type="button">›</button></div><div class="cal-ms"></div></div>'
        + '<div class="cal-pop cal-pop-set hidden">'
        + '<div class="cal-styrow">' + STYLES.map(function (s) {
          return '<button type="button" class="cal-sty' + (S.opts.style === s[0] ? ' on' : '') + '" data-s="' + s[0] + '">' + s[1] + '</button>';
        }).join('') + '</div>'
        + '<div class="cal-pop-div"></div>'
        + OPTS.map(function (o) {
          return '<div class="cal-optrow' + (S.opts[o[0]] ? ' on' : '') + '" data-k="' + o[0] + '"><span>' + o[1] + '</span><span class="cal-sw"></span></div>';
        }).join('') + '</div>'
        + '</div>';
      // CSS Grid（而非 table）：表头独立一行、天格独立一栅格 → 皮肤可自由控制圆角/间距/描线，
      // 也彻底摆脱编辑器通用表格样式的干扰。
      h += '<div class="cal-gridwrap"><div class="cal-gridinner"><div class="cal-headrow">';
      head.forEach(function (x, ci) { h += '<div class="cal-wd' + (wendCol(ci) ? ' we' : '') + '">' + x + '</div>'; });
      h += '</div><div class="cal-body">';
      rows.forEach(function (row) {
        row.forEach(function (d, ci) {
          if (!d) { h += '<div class="cal-day cal-pad"></div>'; return; }
          var cls = ['cal-day'];
          if (wendCol(ci)) cls.push('wend');
          if (S.opts.today && isToday(d)) cls.push('today');
          var sub = cellSub(d);
          var subHtml = sub ? '<div class="cal-sub cal-sub-' + sub.cls + '">' + esc(sub.text) + '</div>' : '';
          var arr = (S.notes[noteKey(d)] || []).filter(function (n) { return noteText(n).trim(); });
          var notesHtml = '';
          if (arr.length) {
            if (!S.opts.compact) {
              // 展开模式（关闭精简）：列出全部记事、整段换行，格子按内容自动增高（不截断、无 +N）。
              notesHtml = '<div class="cal-notes cal-notes-fit">' + arr.map(function (n) {
                var c = noteColor(n), dn = noteDone(n);
                var dt = c ? '<span class="cal-n-dot" style="background:' + c + '"></span>' : '';
                return '<div class="cal-n-line' + (dn ? ' done' : '') + '">' + dt + '<span class="cal-n-txt">' + esc(noteText(n)) + '</span></div>';
              }).join('') + '</div>';
            } else {
              var fc = noteColor(arr[0]);
              var dot = fc ? '<span class="cal-n-dot" style="background:' + fc + '"></span>' : '';
              // 首条最多取 4 字（硬截断、无省略号）；下方一行进度「X/Y」（月格 B）。
              var t4 = noteText(arr[0]).slice(0, 4);
              var d0 = noteDone(arr[0]) ? ' done' : '';
              var doneN = arr.filter(function (n) { return noteDone(n); }).length;
              notesHtml = '<div class="cal-notes"><span class="cal-n-inline' + d0 + '">' + dot + '<span class="cal-n-txt">' + esc(t4) + '</span></span>'
                + '<div class="cal-prog' + (doneN === arr.length ? ' all' : '') + '">' + IC_CHECK_S + doneN + '/' + arr.length + '</div></div>';
            }
          }
          h += '<div class="' + cls.join(' ') + '" data-d="' + d + '"><div class="cal-drow"><span class="cal-dnum">' + d + '</span><span class="cal-addhint">＋</span></div>' + subHtml + notesHtml + '</div>';
        });
      });
      h += '</div></div></div>';
      dom.innerHTML = h;
      bind();
    }

    function closePops() {
      var mp = dom.querySelector('.cal-pop-month'), sp = dom.querySelector('.cal-pop-set');
      if (mp) mp.classList.add('hidden');
      if (sp) sp.classList.add('hidden');
    }
    function openMonth() {
      var mp = dom.querySelector('.cal-pop-month'), sp = dom.querySelector('.cal-pop-set');
      sp.classList.add('hidden');
      mp.classList.remove('hidden');
      py = S.y; pmode = 'm';
      drawPop();
    }
    // 月历弹层：pmode='m' 选月，pmode='y' 选年（点年份文字切换）。弹窗尺寸固定。
    function drawPop() {
      var mp = dom.querySelector('.cal-pop-month');
      if (!mp) return;
      var ylabel = mp.querySelector('.cal-y');
      var box = mp.querySelector('.cal-ms');
      box.innerHTML = '';
      if (pmode === 'm') {
        ylabel.textContent = py + ' 年';
        for (var i = 0; i < 12; i++) {
          (function (i) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = (i + 1) + '月';
            if (py === S.y && i === S.m) b.classList.add('cur');
            b.addEventListener('click', function (e) { e.stopPropagation(); S.y = py; S.m = i; commit(); });
            box.appendChild(b);
          })(i);
        }
      } else {
        var base = Math.floor(py / 12) * 12;
        ylabel.textContent = base + ' - ' + (base + 11);
        for (var j = 0; j < 12; j++) {
          (function (y) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = y;
            if (y === py) b.classList.add('cur');
            b.addEventListener('click', function (e) { e.stopPropagation(); py = y; pmode = 'm'; drawPop(); });
            box.appendChild(b);
          })(base + j);
        }
      }
    }

    function bind() {
      var head = dom.querySelector('.cal-head');
      var mp = head.querySelector('.cal-pop-month'), sp = head.querySelector('.cal-pop-set');
      head.querySelector('.cal-title').addEventListener('click', function (e) { e.stopPropagation(); if (mp.classList.contains('hidden')) openMonth(); else mp.classList.add('hidden'); });
      head.querySelector('.cal-setbtn').addEventListener('click', function (e) { e.stopPropagation(); mp.classList.add('hidden'); sp.classList.toggle('hidden'); });
      head.querySelector('.cal-today').addEventListener('click', function (e) { e.stopPropagation(); S.y = TODAY.y; S.m = TODAY.m; commit(); });
      head.querySelector('.cal-py').addEventListener('click', function (e) { e.stopPropagation(); py += (pmode === 'm' ? -1 : -12); drawPop(); });
      head.querySelector('.cal-ny').addEventListener('click', function (e) { e.stopPropagation(); py += (pmode === 'm' ? 1 : 12); drawPop(); });
      head.querySelector('.cal-y').addEventListener('click', function (e) { e.stopPropagation(); pmode = (pmode === 'm' ? 'y' : 'm'); drawPop(); });
      // 弹层内滚轮切年：仅在弹层范围内生效，stopPropagation 阻断到日历/笔记的滚动，弹窗大小不变。
      mp.addEventListener('wheel', function (e) {
        e.preventDefault(); e.stopPropagation();
        var t = Date.now(); if (t - popWheelLock < 160) return; popWheelLock = t;
        py += (e.deltaY > 0 ? 1 : -1); drawPop();
      }, { passive: false });
      sp.querySelectorAll('.cal-optrow').forEach(function (r) {
        r.addEventListener('click', function (e) { e.stopPropagation(); S.opts[r.dataset.k] = !S.opts[r.dataset.k]; commit(); saveDefOpts(S.opts); dom.querySelector('.cal-pop-set').classList.remove('hidden'); });
      });
      sp.querySelectorAll('.cal-sty').forEach(function (b) {
        b.addEventListener('click', function (e) { e.stopPropagation(); S.opts.style = b.dataset.s; commit(); saveDefOpts(S.opts); dom.querySelector('.cal-pop-set').classList.remove('hidden'); });
      });
      dom.querySelectorAll('.cal-day[data-d]').forEach(function (el) {
        el.addEventListener('click', function () { hideTip(); openDay(+el.dataset.d, el, true); });
        el.addEventListener('mouseenter', function () { showTip(+el.dataset.d, el); });
        el.addEventListener('mouseleave', hideTip);
      });
    }

    function openDay(d, td, addNew) {
      cardDay = d;
      openColorIdx = -1;
      hideTip();
      if (!card) {
        card = document.createElement('div');
        card.className = 'cal-daycard hidden';
        document.body.appendChild(card);
        cardDocDown = function (ev) {
          if (card && !card.contains(ev.target) && !(ev.target.closest && ev.target.closest('.cal-day[data-d]'))) card.classList.add('hidden');
        };
        document.addEventListener('mousedown', cardDocDown, true);
      }
      // 点日子即在最上方新建一条空记事并聚焦；空的失焦自动删除，不留垃圾。
      // 注意：这里不能调用会触发 render() 的提交——render 会重建网格、把传进来的 td 变成游离节点，
      // 之后 getBoundingClientRect() 归零、卡片会错位到左上角。上一条的编辑已由其 blur 提交，无需再 flush。
      if (addNew) { var k0 = noteKey(d); (S.notes[k0] = S.notes[k0] || []).unshift(''); }
      // 必须先显示再 drawCard：textarea 自动增高靠 scrollHeight，display:none 时测得 0 会塌成一条线。
      card.classList.remove('hidden');
      drawCard(addNew ? 0 : undefined);
      // 用 DOM 里当前活着的同一天格子测量，避免拿到被 render 重建后游离的旧节点（归零→错位）。
      var live = dom.querySelector('.cal-day[data-d="' + d + '"]');
      var r = (live || td).getBoundingClientRect();
      var w = 268, left = r.right + 8, top = r.top;
      if (left + w > window.innerWidth - 10) left = r.left - w - 6;
      if (left < 10) left = 10;
      var ch = card.offsetHeight || 200;
      if (top + ch > window.innerHeight - 10) top = Math.max(10, window.innerHeight - ch - 10);
      card.style.left = Math.round(left) + 'px';
      card.style.top = Math.round(top) + 'px';
    }

    function drawCard(focusIdx) {
      var d = cardDay;
      var info = dayInfo(S.y, S.m, d);
      var wd = new Date(S.y, S.m, d).getDay();
      var meta = '';
      if (S.opts.almanac && info.lunar.ok) {
        meta = '<span class="k">农历</span> ' + info.ganzhi + '年 · 属' + info.zodiac + '<br>'
          + info.lunarMonth + info.lunarDay;
        if (info.term) meta += ' · <span class="g">' + info.term + '</span>';
        var fe = info.solarFest || info.lunarFest;
        if (fe) meta += ' · <span class="r">' + fe + '</span>';
      }
      var key = noteKey(d);
      var arr = S.notes[key] || [];
      var rows;
      if (arr.length) {
        rows = arr.map(function (n, i) {
          var t = noteText(n), c = noteColor(n);
          var sw = '<span class="cal-note-sw' + (c ? ' has' : '') + '" data-i="' + i + '"' + (c ? ' style="background:' + c + '"' : '') + ' title="颜色（长按记事可拖动排序）"></span>';
          var pal = '';
          if (openColorIdx === i) {
            pal = '<div class="color-picker-row cal-pal" data-i="' + i + '">' + COLOR_PRESETS.map(function (cc) {
              return '<div class="color-dot-choice' + (cc.value ? '' : ' none') + ((c || null) === cc.value ? ' selected' : '') + '" data-c="' + (cc.value || '') + '"' + (cc.value ? ' style="background:' + cc.value + '"' : '') + ' title="' + cc.name + '"></div>';
            }).join('') + '</div>';
          }
          var dn = noteDone(n);
          // 圆形勾选框，边框=记事颜色；勾选→整圆填色+白勾。点它=完成/取消。
          var ck = '<span class="cal-note-ck' + (dn ? ' on' : '') + '" data-i="' + i + '"' + (c ? ' style="--ck:' + c + '"' : '') + ' title="完成/取消">' + IC_CHECK + '</span>';
          return '<div class="cal-note-row' + (dn ? ' done' : '') + '" data-i="' + i + '">' + ck + '<textarea class="cal-edit" rows="1" data-i="' + i + '" placeholder="写点什么…">' + esc(t) + '</textarea>' + sw + '<span class="del" data-i="' + i + '">×</span></div>' + pal;
        }).join('');
      } else {
        rows = '<div class="cal-empty">还没有记事</div>';
      }
      card.innerHTML = '<div class="dt">' + (S.m + 1) + ' 月 ' + d + ' 日 · 周' + '日一二三四五六'[wd] + '</div>'
        + (meta ? '<div class="meta">' + meta + '</div>' : '')
        + '<div class="cal-addrow"><button type="button" class="cal-addbtn">＋ 添加记事</button></div>'
        + '<div class="cal-notelist">' + rows + '</div>';

      // 「添加记事」：顶部插入一条空记事并聚焦（不再用底部输入框，避免抓错框的老 bug）
      var addbtn = card.querySelector('.cal-addbtn');
      addbtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
      addbtn.addEventListener('click', function () {
        flushSoftCommit();
        (S.notes[key] = S.notes[key] || []).unshift('');
        openColorIdx = -1;
        drawCard(0);
      });
      // 记事可直接编辑：多行、自动增高；Enter 换行，点别处/Esc 收尾并落盘；空的失焦自动删除。
      function autoGrow(el) { el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px'; }
      card.querySelectorAll('.cal-edit').forEach(function (inp) {
        autoGrow(inp);
        inp.addEventListener('input', function () {
          var i = +inp.dataset.i;
          var a = S.notes[key] || [];
          a[i] = makeNote(inp.value, noteColor(a[i]), noteDone(a[i]));
          autoGrow(inp);
          scheduleSoftCommit();
        });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); inp.blur(); } });
        inp.addEventListener('blur', function () {
          var i = +inp.dataset.i;
          var a = S.notes[key] || [];
          if (a[i] !== undefined && !noteText(a[i]).trim()) { a.splice(i, 1); if (!a.length) delete S.notes[key]; commit(); drawCard(); }
          else { flushSoftCommit(); }
        });
      });
      // 删除、颜色开关、选色：用 mousedown/preventDefault，避免抢走输入框焦点导致重排错乱。
      card.querySelectorAll('.del').forEach(function (x) {
        x.addEventListener('mousedown', function (e) { e.preventDefault(); });
        x.addEventListener('click', function () {
          var a = S.notes[key] || [];
          a.splice(+x.dataset.i, 1);
          if (!a.length) delete S.notes[key];
          openColorIdx = -1;
          commit(); drawCard();
        });
      });
      card.querySelectorAll('.cal-note-sw').forEach(function (sw) {
        sw.addEventListener('mousedown', function (e) { e.preventDefault(); });
        sw.addEventListener('click', function () {
          var i = +sw.dataset.i;
          openColorIdx = (openColorIdx === i ? -1 : i);
          drawCard();
        });
      });
      // 勾选框：切换完成，已完成沉底（稳定分区，保留各自相对顺序）。
      card.querySelectorAll('.cal-note-ck').forEach(function (ck) {
        ck.addEventListener('mousedown', function (e) { e.preventDefault(); });
        ck.addEventListener('click', function () {
          var i = +ck.dataset.i;
          var a = S.notes[key] || [];
          if (a[i] === undefined) return;
          a[i] = makeNote(noteText(a[i]), noteColor(a[i]), !noteDone(a[i]));
          var u = a.filter(function (n) { return !noteDone(n); });
          var dn2 = a.filter(function (n) { return noteDone(n); });
          S.notes[key] = u.concat(dn2);
          openColorIdx = -1;
          commit(); drawCard();
        });
      });
      card.querySelectorAll('.cal-pal .color-dot-choice').forEach(function (dot) {
        dot.addEventListener('mousedown', function (e) { e.preventDefault(); });
        dot.addEventListener('click', function () {
          var i = +dot.parentNode.dataset.i;
          var a = S.notes[key] || [];
          a[i] = makeNote(noteText(a[i]), dot.dataset.c || null, noteDone(a[i]));
          openColorIdx = -1;
          commit(); drawCard();
        });
      });

      // 长按拖动排序：按住记事约 300ms 进入拖动；快速点/拖不触发（不影响点选文字与编辑）。
      card.querySelectorAll('.cal-note-row').forEach(function (row) {
        row.addEventListener('pointerdown', function (e) {
          if (e.button !== undefined && e.button !== 0) return;
          if (e.target.closest('.del') || e.target.closest('.cal-note-sw') || e.target.closest('.cal-note-ck') || e.target.closest('.color-dot-choice')) return;
          var from = +row.dataset.i;
          var sx = e.clientX, sy = e.clientY, pid = e.pointerId;
          var dragging = false, curTo = from;
          var timer = setTimeout(begin, 300);
          function begin() {
            dragging = true;
            try { row.setPointerCapture(pid); } catch (_) {}
            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            row.classList.add('cal-dragging');
            document.body.style.userSelect = 'none';
          }
          function move(ev) {
            if (!dragging) {
              if (Math.abs(ev.clientX - sx) > 6 || Math.abs(ev.clientY - sy) > 6) { clearTimeout(timer); end(ev, false); }
              return;
            }
            ev.preventDefault();
            var rs = [].slice.call(card.querySelectorAll('.cal-note-row'));
            var to = rs.length;
            for (var i = 0; i < rs.length; i++) {
              var r = rs[i].getBoundingClientRect();
              if (ev.clientY < r.top + r.height / 2) { to = i; break; }
            }
            curTo = to;
            rs.forEach(function (r, i) { r.classList.toggle('cal-drop', i === to); });
          }
          function end(ev, wasDragging) {
            clearTimeout(timer);
            document.removeEventListener('pointermove', move, true);
            document.removeEventListener('pointerup', up, true);
            if (!wasDragging) return;
            document.body.style.userSelect = '';
            var a = S.notes[key] || [];
            var to = curTo, insertAt = (to > from) ? to - 1 : to;
            if (insertAt !== from && from < a.length) {
              var item = a.splice(from, 1)[0];
              a.splice(insertAt, 0, item);
              commit();
            }
            drawCard();
          }
          function up(ev) { end(ev, dragging); }
          document.addEventListener('pointermove', move, true);
          document.addEventListener('pointerup', up, true);
        });
      });

      if (typeof focusIdx === 'number') {
        var inps = card.querySelectorAll('.cal-edit');
        var fel = inps[focusIdx];
        if (fel) { fel.focus(); try { var L = fel.value.length; fel.setSelectionRange(L, L); } catch (_) {} }
      }
    }

    // 滚轮切月：仅当鼠标悬在左上角「年月按钮」(.cal-title)上滚动才切月——避免在日历正文上滚动误改月份
    // （之前整块都能滚切月，很容易误操作月份变来变去）。不在按钮上时不拦截，滚轮正常滚动页面。节流：一次滚动一个月。
    function onWheel(e) {
      if (!(e.target.closest && e.target.closest('.cal-title'))) return;
      e.preventDefault();
      var t = Date.now();
      if (t - wheelLock < 200) return;
      wheelLock = t;
      S.m += (e.deltaY > 0 ? 1 : -1);
      if (S.m < 0) { S.m = 11; S.y--; }
      if (S.m > 11) { S.m = 0; S.y++; }
      commit();
    }
    dom.addEventListener('wheel', onWheel, { passive: false });

    // 点击任意「非弹层、非切换按钮」处都关闭弹层——含日历自身区域（之前只有点日历外部才关）。
    var onDocDown = function (e) {
      var mp = dom.querySelector('.cal-pop-month'), sp = dom.querySelector('.cal-pop-set');
      var inPop = (mp && !mp.classList.contains('hidden') && mp.contains(e.target))
        || (sp && !sp.classList.contains('hidden') && sp.contains(e.target));
      var onToggle = e.target.closest && (e.target.closest('.cal-title') || e.target.closest('.cal-setbtn'));
      if (!inPop && !onToggle) closePops();
    };
    document.addEventListener('mousedown', onDocDown, true);

    render();
    if (api._pendingAutoOpen) { api._pendingAutoOpen = false; setTimeout(function () { try { openMonth(); } catch (_) {} }, 0); }

    return {
      update: function (str) {
        if (str === _data) return;
        _data = str;
        S = parse(str);
        py = S.y;
        render();
      },
      destroy: function () {
        if (softTimer) { try { clearTimeout(softTimer); } catch (_) {} softTimer = null; }
        if (hoverTip) { try { hoverTip.remove(); } catch (_) {} hoverTip = null; }
        try { dom.removeEventListener('wheel', onWheel); } catch (_) {}
        try { document.removeEventListener('mousedown', onDocDown, true); } catch (_) {}
        if (card) {
          try { document.removeEventListener('mousedown', cardDocDown, true); } catch (_) {}
          try { card.remove(); } catch (_) {}
          card = null;
        }
      },
    };
  }

  var api = { mount: mount, defaultData: defaultData, canon: canon, dayInfo: dayInfo, _pendingAutoOpen: false };
  window.ZhiCalendar = api;
})();
