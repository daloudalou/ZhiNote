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

  // summary=右侧/下方「汇总事项」面板开关（头部图标切换，不在设置弹层里，默认开）。
  var DEFAULT_OPTS = { startMon: true, wend: true, today: true, lunar: true, term: true, fest: true, almanac: true, compact: true, summary: true, style: 'D' };
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
  // 汇总面板开关：右侧带列表线的面板图标（示意「侧栏汇总」）
  var IC_SUM = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><line x1="13.5" y1="4.5" x2="13.5" y2="19.5"/><line x1="16" y1="9" x2="18" y2="9"/><line x1="16" y1="12.2" x2="18" y2="12.2"/><line x1="16" y1="15.4" x2="18" y2="15.4"/></svg>';
  // 复制图标
  var IC_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>';

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
    var openSumColorKey = null;               // 汇总里正在展开选色的条目 'day-idx'（如 '13-0'）
    var sumAddOpen = false;                    // 底部添加行是否已展开（点＋后显示日期+内容输入）
    var pendingNewMove = null;                 // 拖到"新日期投放区"后待填日期的搬移 { fromD, fromI }
    var editHlDay = null;                       // 正在编辑的汇总记事所属日期：借用「今日高亮」点亮那天
    var editDateDay = null;                      // 正在改「日期」的那天（点日期数字进入，改完移动当天全部记事）
    var persistTimer = null;
    function scheduleSoftCommit() { if (softTimer) clearTimeout(softTimer); softTimer = setTimeout(function () { softTimer = null; commit(); }, 350); }
    function flushSoftCommit() { if (softTimer) { clearTimeout(softTimer); softTimer = null; } commit(); }
    // 只落盘、不重绘（供汇总里就地编辑文字用：重绘会毁掉正在输入的输入框、丢焦点）。
    function persist() { var next = canon(toObj(S)); if (next !== _data) { _data = next; if (onChange) onChange(_data); } }
    function schedulePersist() { if (persistTimer) clearTimeout(persistTimer); persistTimer = setTimeout(function () { persistTimer = null; persist(); }, 350); }
    function flushPersist() { if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; } persist(); }
    // 只重画左侧日历卡（不动汇总面板 DOM）：汇总里改文字时实时更新日历圆点，又不打断输入。
    function refreshCalOnly() {
      var cardEl = dom.querySelector('.calendar-block');
      if (!cardEl) { render(); return; }
      cardEl.setAttribute('data-cal-style', S.opts.style || 'A');
      cardEl.setAttribute('data-cal-fit', S.opts.compact ? '0' : '1');
      cardEl.innerHTML = buildCalInner();
      bindCal();
      layoutSummary();
    }

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

    // ===== 汇总事项面板 =====
    function ymLabel() { return S.y + ' 年 ' + (S.m + 1) + ' 月'; }
    // 收集本月「有非空记事」的日子（按日期升序），供面板与复制复用。
    function monthDays() {
      var out = [];
      for (var d = 1; d <= 31; d++) {
        var arr = (S.notes[noteKey(d)] || []).filter(function (n) { return noteText(n).trim(); });
        if (arr.length) out.push({ d: d, arr: arr });
      }
      return out;
    }
    // 单条汇总记事行（可编辑）：勾选框 + 文本框 + 颜色标记 + 删除；data-d/data-i 指回 S.notes 原始下标。
    function sumRowHtml(d, i, n) {
      var t = noteText(n), c = noteColor(n), dn = noteDone(n);
      var kk = d + '-' + i;
      var di = ' data-d="' + d + '" data-i="' + i + '"';
      var ck = '<span class="cal-note-ck' + (dn ? ' on' : '') + '"' + di + (c ? ' style="--ck:' + c + '"' : '') + ' title="完成/取消">' + IC_CHECK + '</span>';
      var sw = '<span class="cal-note-sw' + (c ? ' has' : '') + '"' + di + (c ? ' style="background:' + c + '"' : '') + ' title="颜色标记（长按记事可拖动）"></span>';
      var pal = '';
      if (openSumColorKey === kk) {
        pal = '<div class="color-picker-row cal-pal cal-sum-pal"' + di + '>' + COLOR_PRESETS.map(function (cc) {
          return '<div class="color-dot-choice' + (cc.value ? '' : ' none') + ((c || null) === cc.value ? ' selected' : '') + '" data-c="' + (cc.value || '') + '"' + (cc.value ? ' style="background:' + cc.value + '"' : '') + ' title="' + cc.name + '"></div>';
        }).join('') + '</div>';
      }
      return '<div class="cal-sum-i' + (dn ? ' done' : '') + '"' + di + '>'
        + ck
        + '<textarea class="cal-sum-edit" rows="1"' + di + ' placeholder="写点什么…">' + esc(t) + '</textarea>'
        + sw + '<span class="del"' + di + ' title="删除">×</span></div>' + pal;
    }

    function buildSummaryHtml() {
      var days = [];
      for (var d = 1; d <= 31; d++) {
        var raw = S.notes[noteKey(d)] || [];
        var has = raw.some(function (n) { return noteText(n).trim(); });
        if (has) days.push({ d: d, raw: raw });
      }
      var body;
      if (!days.length) { body = '<div class="cal-sum-empty">本月暂无记事，在下方添加一条</div>'; }
      else {
        body = days.map(function (it) {
          var items = it.raw.map(function (n, i) {
            return noteText(n).trim() ? sumRowHtml(it.d, i, n) : '';
          }).join('');
          var dcol = (editDateDay === it.d)
            ? '<input class="cal-sum-dedit" type="text" inputmode="numeric" maxlength="2" value="' + it.d + '">'
            : '<span class="cal-sum-d" data-d="' + it.d + '" title="点击改日期（移动当天全部记事到新日期）">' + it.d + '</span>';
          return '<div class="cal-sum-day" data-d="' + it.d + '"><div class="cal-sum-dcol">' + dcol + '</div><div class="cal-sum-items">' + items + '</div></div>';
        }).join('');
      }
      // 底部添加行：默认「＋ 添加记事…」，＋ 占据最左侧的日期位；点＋后该位变成日期输入框 + 文本框。
      var addRow;
      if (sumAddOpen) {
        addRow = '<div class="cal-sum-add open">'
          + '<input class="cal-sum-add-d" type="text" inputmode="numeric" maxlength="2" placeholder="日" value="' + (TODAY.y === S.y && TODAY.m === S.m ? TODAY.d : '') + '">'
          + '<textarea class="cal-sum-add-t" rows="1" placeholder="写点什么…"></textarea></div>';
      } else {
        addRow = '<div class="cal-sum-add"><span class="cal-sum-addplus" title="添加记事">＋</span><span class="cal-sum-addhint">添加记事…</span></div>';
      }
      // 新日期投放区：仅拖动时显形；若正等待填日期(pendingNewMove)，显示内联「几号」输入框。
      var zone;
      if (pendingNewMove) {
        zone = '<div class="cal-sum-newzone active"><span class="cal-sum-nzhint">移到</span><input class="cal-sum-newdate" type="text" inputmode="numeric" maxlength="2" placeholder="日" autofocus><span class="cal-sum-nzhint">日（回车确认）</span></div>';
      } else {
        zone = '<div class="cal-sum-newzone"><span class="cal-sum-nzhint">拖到这里 → 移到新日期</span></div>';
      }
      return '<div class="cal-summary">'
        + '<div class="cal-summary-h"><span class="cal-summary-title">汇总事项</span><span class="cal-summary-ym">' + ymLabel() + '</span>'
        + '<button type="button" class="cal-sum-copy" title="复制本月记事">' + IC_COPY + '</button></div>'
        + '<div class="cal-summary-body">' + body + zone + addRow + '</div></div>';
    }

    // 只重画右侧汇总面板（不动左侧日历卡）：用于汇总内的结构性变化（选色开关等）。
    function renderSumOnly() {
      var sumEl = dom.querySelector('.cal-summary');
      if (!S.opts.summary) { if (sumEl) { sumEl.remove(); } dom.classList.remove('has-summary', 'side', 'below'); return; }
      if (!sumEl) { render(); return; }
      var st = sumEl.scrollTop;               // 重建 DOM 会把内部滚动位置清零→保存后还原，避免"乱跳到顶再跳回"
      sumEl.outerHTML = buildSummaryHtml();
      bindSum();
      layoutSummary();
      var neo = dom.querySelector('.cal-summary'); if (neo) neo.scrollTop = st;
    }
    function buildSummaryText() {
      var lines = ['汇总事项 ' + ymLabel()];
      var days = monthDays();
      if (!days.length) { lines.push('本月暂无记事'); }
      else days.forEach(function (it) {
        lines.push(it.d + ' 日：' + it.arr.map(function (n) { return noteText(n).trim() + (noteDone(n) ? '（已完成）' : ''); }).join('；'));
      });
      return lines.join('\n');
    }
    // 布局：宽度够→汇总放右侧(与日历齐高，内部滚动)；不够→放下方(与日历同宽，实时跟随)。
    // 先切到「非并排」量日历自然宽度，再据可用宽决定并排/下方，避免并排时日历被设定宽而量不准。
    var SUM_MIN = 230, SUM_GAP = 14, _lastShellW = -1;
    function layoutSummary() {
      var sumEl = dom.querySelector('.cal-summary');
      var calCard = dom.querySelector('.calendar-block');
      if (!sumEl || !calCard) { dom.classList.remove('has-summary', 'side', 'below'); return; }
      dom.classList.add('has-summary');
      dom.classList.remove('side');
      sumEl.style.width = '';
      sumEl.style.height = '';
      var availW = dom.clientWidth || 0;
      _lastShellW = Math.round(availW);
      var calW = calCard.offsetWidth || 0;
      var side = (availW - calW - SUM_GAP) >= SUM_MIN;
      dom.classList.toggle('side', side);
      dom.classList.toggle('below', !side);
      // 右侧：固定为日历高度（内容多则内部滚动），与日历齐平；下方：只锁宽度、不限高度。
      if (side) sumEl.style.height = (calCard.offsetHeight || 0) + 'px';
      else sumEl.style.width = (calCard.offsetWidth || 0) + 'px';
    }

    // 只构建日历卡内部（头部 + 网格）HTML；外层 .calendar-block 由 render/refreshCalOnly 提供。
    function buildCalInner() {
      var startSun = !S.opts.startMon;
      var head = startSun ? WK_SUN : WK_MON;
      var rows = matrix(S.y, S.m, startSun);
      var h = '<div class="cal-head">'
        + '<span class="cal-title" title="点击选择年月">' + S.y + ' 年 ' + (S.m + 1) + ' 月 <span class="cal-caret">▾</span></span>'
        + '<button class="cal-today" type="button" title="回到今天">' + IC_TODAY + '</button>'
        + '<button class="cal-setbtn" title="显示设置">' + IC_SET + '</button>'
        + '<button class="cal-sumbtn' + (S.opts.summary ? ' on' : '') + '" type="button" title="汇总事项">' + IC_SUM + '</button>'
        + '<div class="cal-pop cal-pop-month hidden"><div class="cal-pop-h"><button class="cal-py" type="button">‹</button><span class="cal-y"></span><button class="cal-ny" type="button">›</button></div><div class="cal-ms"></div></div>'
        + '<div class="cal-pop cal-pop-set hidden">'
        + '<div class="cal-styrow">' + STYLES.map(function (s) {
          return '<button type="button" class="cal-sty' + (S.opts.style === s[0] ? ' on' : '') + '" data-s="' + s[0] + '">' + s[1] + '</button>';
        }).join('') + '</div>'
        + '<div class="cal-pop-div"></div>'
        + OPTS.map(function (o) {
          return '<div class="cal-optrow' + (S.opts[o[0]] ? ' on' : '') + '" data-k="' + o[0] + '"><span>' + o[1] + '</span><span class="cal-sw"></span></div>';
        }).join('')
        + '<div class="cal-pop-div"></div>'
        + '<div class="cal-fsrow"><span>日历字号</span><div class="cal-fsctrl"><button type="button" class="cal-fsdec" title="缩小（也可 Ctrl+滚轮）">－</button><span class="cal-fsval">' + calPct() + '%</span><button type="button" class="cal-fsinc" title="放大（也可 Ctrl+滚轮）">＋</button></div></div>'
        + '</div>'
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
          // 编辑汇总某条时，把「今日高亮」临时借给正在编辑的那天（此时今日格不高亮）；否则正常高亮今日。
          if (editHlDay != null) { if (d === editHlDay) cls.push('today'); }
          else if (S.opts.today && isToday(d)) cls.push('today');
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
      return h;
    }

    function render() {
      var oldSum = dom.querySelector('.cal-summary');
      var st = oldSum ? oldSum.scrollTop : 0;   // 保住汇总内部滚动位置，重建后还原（勾选/删除/加记事等 commit 都会走这里）
      // 日历卡（.calendar-block）承载全部日历样式/数据属性；汇总面板作为兄弟节点由外壳(.cal-shell)排布。
      var cardHtml = '<div class="calendar-block" data-cal-style="' + (S.opts.style || 'A') + '" data-cal-fit="' + (S.opts.compact ? '0' : '1') + '">' + buildCalInner() + '</div>';
      dom.innerHTML = cardHtml + (S.opts.summary ? buildSummaryHtml() : '');
      bind();
      layoutSummary();
      growSumEdits();
      var neo = dom.querySelector('.cal-summary'); if (neo) neo.scrollTop = st;
      // 首次挂载/切笔记时编辑区可能还没完成布局，textarea 测高会得 0（文字被压成一条看不见）；
      // 下一帧布局稳定后再量一次高度、重排汇总，修复"文字空白、切月切回才显示"。
      if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(function () { layoutSummary(); growSumEdits(); var n2 = dom.querySelector('.cal-summary'); if (n2) n2.scrollTop = st; });
    }

    // 汇总里可换行的输入按内容自动增高；布局未稳时 scrollHeight 可能为 0，需在布局稳定后再量。
    function growSumEdits() {
      var sumEl = dom.querySelector('.cal-summary');
      if (!sumEl) return;
      sumEl.querySelectorAll('.cal-sum-edit, .cal-sum-add-t').forEach(function (el) {
        el.style.height = 'auto';
        el.style.height = (el.scrollHeight + 2) + 'px';
      });
    }

    function calFont() { return (typeof window !== 'undefined' && window.__calFont) ? window.__calFont : null; }
    function calPct() { var f = calFont(); return f ? Math.round(f.get() * 100) : 100; }

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

    function bind() { bindCal(); bindSum(); }

    function bindCal() {
      var head = dom.querySelector('.cal-head');
      if (!head) return;
      var mp = head.querySelector('.cal-pop-month'), sp = head.querySelector('.cal-pop-set');
      head.querySelector('.cal-title').addEventListener('click', function (e) { e.stopPropagation(); if (mp.classList.contains('hidden')) openMonth(); else mp.classList.add('hidden'); });
      head.querySelector('.cal-setbtn').addEventListener('click', function (e) { e.stopPropagation(); mp.classList.add('hidden'); sp.classList.toggle('hidden'); });
      head.querySelector('.cal-today').addEventListener('click', function (e) { e.stopPropagation(); S.y = TODAY.y; S.m = TODAY.m; commit(); });
      var sumbtn = head.querySelector('.cal-sumbtn');
      if (sumbtn) sumbtn.addEventListener('click', function (e) { e.stopPropagation(); S.opts.summary = !S.opts.summary; saveDefOpts(S.opts); commit(); });
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
      // 日历字号 −/＋（全局比例，与 Ctrl+滚轮共用）：改完不重绘，只更新数字并触发汇总重排（保持弹层打开）。
      var fsval = sp.querySelector('.cal-fsval');
      var bumpFs = function (dir) { var f = calFont(); if (!f) return; var v = f.set(f.get() + dir * (f.STEP || 0.1)); if (fsval) fsval.textContent = Math.round(v * 100) + '%'; };
      var fsdec = sp.querySelector('.cal-fsdec'), fsinc = sp.querySelector('.cal-fsinc');
      if (fsdec) fsdec.addEventListener('click', function (e) { e.stopPropagation(); bumpFs(-1); });
      if (fsinc) fsinc.addEventListener('click', function (e) { e.stopPropagation(); bumpFs(1); });
      dom.querySelectorAll('.cal-day[data-d]').forEach(function (el) {
        el.addEventListener('click', function () { hideTip(); openDay(+el.dataset.d, el, true); });
        el.addEventListener('mouseenter', function () { showTip(+el.dataset.d, el); });
        el.addEventListener('mouseleave', hideTip);
      });
    }

    function dim(y, m) { return new Date(y, m + 1, 0).getDate(); }

    function bindSum() {
      var sumEl = dom.querySelector('.cal-summary');
      if (!sumEl) return;
      var copyBtn = sumEl.querySelector('.cal-sum-copy');
      if (copyBtn) copyBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var done = function () { copyBtn.classList.add('ok'); setTimeout(function () { try { copyBtn.classList.remove('ok'); } catch (_) {} }, 1100); };
        try { navigator.clipboard.writeText(buildSummaryText()).then(done, function () {}); } catch (_) {}
      });

      function arrOf(d) { return S.notes[noteKey(d)] || []; }
      function autoGrow(el) { el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px'; }

      // 文本就地编辑：只改数据 + 只重画左侧日历圆点（不动汇总 DOM，保住焦点/光标）；空的失焦删除。
      // 编辑时（获得焦点）才把左侧日历对应那天点亮，失焦复位——避免 hover 快速划过时高亮乱闪。
      sumEl.querySelectorAll('.cal-sum-edit').forEach(function (inp) {
        autoGrow(inp);
        inp.addEventListener('focus', function () { editHlDay = +inp.dataset.d; refreshCalOnly(); });
        inp.addEventListener('input', function () {
          var d = +inp.dataset.d, i = +inp.dataset.i, a = arrOf(d);
          if (a[i] === undefined) return;
          a[i] = makeNote(inp.value, noteColor(a[i]), noteDone(a[i]));
          autoGrow(inp);
          refreshCalOnly();
          schedulePersist();
        });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); inp.blur(); } });
        inp.addEventListener('blur', function () {
          var d = +inp.dataset.d, i = +inp.dataset.i, a = arrOf(d);
          editHlDay = null;
          if (a[i] !== undefined && !noteText(a[i]).trim()) { a.splice(i, 1); if (!a.length) delete S.notes[noteKey(d)]; commit(); }
          else { flushPersist(); refreshCalOnly(); }
        });
      });

      // 勾选完成：已完成沉底（本天内稳定分区）
      sumEl.querySelectorAll('.cal-note-ck').forEach(function (ck) {
        ck.addEventListener('mousedown', function (e) { e.preventDefault(); });
        ck.addEventListener('click', function () {
          var d = +ck.dataset.d, key = noteKey(d), a = S.notes[key] || [], i = +ck.dataset.i;
          if (a[i] === undefined) return;
          a[i] = makeNote(noteText(a[i]), noteColor(a[i]), !noteDone(a[i]));
          var u = a.filter(function (n) { return !noteDone(n); }), dn = a.filter(function (n) { return noteDone(n); });
          S.notes[key] = u.concat(dn);
          openSumColorKey = null; commit();
        });
      });

      // 删除
      sumEl.querySelectorAll('.del').forEach(function (x) {
        x.addEventListener('mousedown', function (e) { e.preventDefault(); });
        x.addEventListener('click', function () {
          var d = +x.dataset.d, key = noteKey(d), a = S.notes[key] || [];
          a.splice(+x.dataset.i, 1); if (!a.length) delete S.notes[key];
          openSumColorKey = null; commit();
        });
      });

      // 颜色标记：开/收调色板（只重画汇总）；选色后落盘并整体重画。
      sumEl.querySelectorAll('.cal-note-sw').forEach(function (sw) {
        sw.addEventListener('mousedown', function (e) { e.preventDefault(); });
        sw.addEventListener('click', function () {
          var kk = sw.dataset.d + '-' + sw.dataset.i;
          openSumColorKey = (openSumColorKey === kk ? null : kk);
          renderSumOnly();
        });
      });
      sumEl.querySelectorAll('.cal-sum-pal .color-dot-choice').forEach(function (dot) {
        dot.addEventListener('mousedown', function (e) { e.preventDefault(); });
        dot.addEventListener('click', function () {
          var pal = dot.parentNode, d = +pal.dataset.d, i = +pal.dataset.i, a = S.notes[noteKey(d)] || [];
          if (a[i] !== undefined) a[i] = makeNote(noteText(a[i]), dot.dataset.c || null, noteDone(a[i]));
          openSumColorKey = null; commit();
        });
      });

      // 长按拖动
      sumEl.querySelectorAll('.cal-sum-i').forEach(function (row) {
        row.addEventListener('pointerdown', function (e) { summaryDragStart(e, row); });
      });

      // 直接改日期：点日期数字 → 变输入框 → 回车/失焦把当天全部记事移到新日期（新日期若已有记事则合并追加）。
      sumEl.querySelectorAll('.cal-sum-d').forEach(function (sp) {
        sp.addEventListener('click', function (e) {
          e.stopPropagation();
          editDateDay = +sp.dataset.d; renderSumOnly();
          var inp = dom.querySelector('.cal-sum-dedit');
          if (inp) { try { inp.focus({ preventScroll: true }); inp.select(); } catch (_) { try { inp.focus(); } catch (__) {} } }
        });
      });
      var dedit = sumEl.querySelector('.cal-sum-dedit');
      if (dedit && editDateDay != null) {
        var commitDate = function () {
          var oldD = editDateDay, newD = parseInt(dedit.value, 10);
          editDateDay = null;
          if (!(newD >= 1 && newD <= dim(S.y, S.m)) || newD === oldD || !S.notes[noteKey(oldD)]) { renderSumOnly(); return; }
          var ok = noteKey(oldD), nk = noteKey(newD);
          S.notes[nk] = (S.notes[nk] || []).concat(S.notes[ok]);
          delete S.notes[ok];
          commit();
        };
        dedit.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); commitDate(); }
          else if (e.key === 'Escape') { e.preventDefault(); editDateDay = null; renderSumOnly(); }
        });
        dedit.addEventListener('blur', function () { if (editDateDay != null) commitDate(); });
      }

      // 底部添加行
      var add = sumEl.querySelector('.cal-sum-add');
      if (add && !sumAddOpen) {
        // 阻止 mousedown 抢焦点：否则正在编辑的输入框会先 blur→重排，导致点击丢失或视图乱跳
        add.addEventListener('mousedown', function (e) { e.preventDefault(); });
        add.addEventListener('click', function () {
          // 清掉可能残留的空记事（原本靠输入框 blur 清理，这里已阻止 blur）
          Object.keys(S.notes).forEach(function (k) {
            var a = (S.notes[k] || []).filter(function (n) { return noteText(n).trim(); });
            if (a.length) S.notes[k] = a; else delete S.notes[k];
          });
          editHlDay = null;
          sumAddOpen = true; renderSumOnly();
          var t = dom.querySelector('.cal-sum-add-t'); if (t) { try { t.focus({ preventScroll: true }); } catch (_) { t.focus(); } }
          // 添加行在最底部：滚到底确保新输入框可见（覆盖 renderSumOnly 还原的旧滚动位置）
          var se = dom.querySelector('.cal-summary'); if (se) se.scrollTop = se.scrollHeight;
        });
      } else if (add) {
        var dInp = add.querySelector('.cal-sum-add-d'), tInp = add.querySelector('.cal-sum-add-t');
        autoGrow(tInp);
        var commitAdd = function () {
          var day = parseInt(dInp.value, 10), txt = (tInp.value || '').trim();
          if (!txt) { sumAddOpen = false; renderSumOnly(); return; }
          if (!(day >= 1 && day <= dim(S.y, S.m))) day = (TODAY.y === S.y && TODAY.m === S.m ? TODAY.d : 1);
          var key = noteKey(day); (S.notes[key] = S.notes[key] || []).push(makeNote(txt, null, false));
          sumAddOpen = false; commit();
        };
        tInp.addEventListener('input', function () { autoGrow(tInp); });
        tInp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitAdd(); }
          else if (e.key === 'Escape') { e.preventDefault(); sumAddOpen = false; renderSumOnly(); }
        });
        tInp.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement === dInp) return; commitAdd(); }, 0); });
        dInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tInp.focus(); } });
      }

      // 新日期投放：内联「几号」输入
      var nd = sumEl.querySelector('.cal-sum-newdate');
      if (nd && pendingNewMove) {
        try { nd.focus({ preventScroll: true }); } catch (_) { try { nd.focus(); } catch (__) {} }
        var confirmMove = function () {
          var day = parseInt(nd.value, 10), pm = pendingNewMove; pendingNewMove = null;
          if (!pm) { render(); return; }
          var fk = noteKey(pm.fromD), fa = S.notes[fk] || [];
          if (fa[pm.fromI] === undefined || !(day >= 1 && day <= dim(S.y, S.m))) { render(); return; }
          var item = fa.splice(pm.fromI, 1)[0]; if (!fa.length) delete S.notes[fk];
          var tk = noteKey(day); (S.notes[tk] = S.notes[tk] || []).push(item); commit();
        };
        nd.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); confirmMove(); }
          else if (e.key === 'Escape') { e.preventDefault(); pendingNewMove = null; render(); }
        });
        nd.addEventListener('blur', function () { setTimeout(function () { if (pendingNewMove) { pendingNewMove = null; render(); } }, 0); });
      }
    }

    // 汇总长按拖动：排序 / 跨天移动 / 拖到「新日期投放区」。落点提示线复用侧栏视觉(drag-above/drag-below)。
    function summaryDragStart(e, row) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('.del') || e.target.closest('.cal-note-sw') || e.target.closest('.cal-note-ck') || e.target.closest('.color-dot-choice')) return;
      var fromD = +row.dataset.d, fromI = +row.dataset.i;
      var sx = e.clientX, sy = e.clientY, pid = e.pointerId;
      var sumEl = dom.querySelector('.cal-summary');
      var dragging = false, target = null;
      var timer = setTimeout(begin, 300);
      function begin() {
        dragging = true;
        try { row.setPointerCapture(pid); } catch (_) {}
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        row.classList.add('cal-dragging');
        document.body.style.userSelect = 'none';
        if (sumEl) sumEl.classList.add('cal-sum-dragging');
      }
      function clearInd() {
        if (!sumEl) return;
        sumEl.querySelectorAll('.drag-above,.drag-below').forEach(function (el) { el.classList.remove('drag-above', 'drag-below'); });
        var nz = sumEl.querySelector('.cal-sum-newzone'); if (nz) nz.classList.remove('drag-over');
      }
      function move(ev) {
        if (!dragging) {
          if (Math.abs(ev.clientX - sx) > 6 || Math.abs(ev.clientY - sy) > 6) { clearTimeout(timer); cleanup(); }
          return;
        }
        ev.preventDefault();
        clearInd(); target = null;
        var el = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!el) return;
        var nz = el.closest && el.closest('.cal-sum-newzone');
        if (nz && sumEl.contains(nz)) { nz.classList.add('drag-over'); target = { newzone: true }; return; }
        var hit = el.closest && el.closest('.cal-sum-i');
        if (hit && sumEl.contains(hit)) {
          var r = hit.getBoundingClientRect();
          var below = ev.clientY > r.top + r.height / 2;
          hit.classList.add(below ? 'drag-below' : 'drag-above');
          target = { day: +hit.dataset.d, idx: +hit.dataset.i, below: below };
          return;
        }
        var grp = el.closest && el.closest('.cal-sum-day');
        if (grp && sumEl.contains(grp)) { target = { day: +grp.dataset.d, tail: true }; return; }
      }
      function finishDrag() {
        document.body.style.userSelect = '';
        if (sumEl) sumEl.classList.remove('cal-sum-dragging');
        clearInd();
      }
      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', up, true);
      }
      function up(ev) {
        cleanup();
        if (!dragging) return;
        finishDrag();
        applySummaryMove(fromD, fromI, target);
      }
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', up, true);
    }

    // 用「引用对象」定位插入点，规避删除后下标漂移的差一 bug。
    function applySummaryMove(fromD, fromI, target) {
      if (!target) { render(); return; }
      var fromKey = noteKey(fromD), fromArr = S.notes[fromKey] || [], item = fromArr[fromI];
      if (item === undefined) { render(); return; }
      if (target.newzone) { pendingNewMove = { fromD: fromD, fromI: fromI }; renderSumOnly(); return; }
      var toKey = noteKey(target.day);
      var refNote = (!target.tail) ? (S.notes[toKey] || [])[target.idx] : null;
      if (refNote === item) { render(); return; }
      fromArr.splice(fromI, 1); if (!fromArr.length) delete S.notes[fromKey];
      var toArr = S.notes[toKey] = S.notes[toKey] || [];
      var insertAt;
      if (refNote == null) insertAt = toArr.length;
      else { var ri = toArr.indexOf(refNote); insertAt = ri < 0 ? toArr.length : (target.below ? ri + 1 : ri); }
      toArr.splice(insertAt, 0, item);
      commit();
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

    // 滚轮切月：鼠标悬在日历「顶栏」(.cal-head，含年月/按钮，排除弹层) 或汇总「标题栏」上滚动才切月——
    // 避免在日历正文/记事上滚动误改月份。不在顶栏时不拦截，滚轮正常滚动页面。节流：一次滚动一个月。
    function onWheel(e) {
      // Ctrl/⌘ + 滚轮留给「日历字体缩放」（app.js 全局处理），这里不切月。
      if (e.ctrlKey || e.metaKey) return;
      // 在「日历整条顶栏(.cal-head，排除其中弹层)」或「汇总面板顶部标题栏」上滚动才切月，其余处正常滚动。
      if (!(e.target.closest && (
        (e.target.closest('.cal-head') && !e.target.closest('.cal-pop')) ||
        e.target.closest('.cal-summary-h')
      ))) return;
      e.preventDefault(); e.stopPropagation();
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

    // 编辑区宽度变化（窗口/侧栏）时重排汇总面板；只在「宽度」变化时触发，避免并排↔下方切换改变高度引起自反馈循环。
    var _ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      _ro = new ResizeObserver(function () {
        if (Math.round(dom.clientWidth) === _lastShellW) return;
        layoutSummary();
        growSumEdits();
      });
      try { _ro.observe(dom); } catch (_) { _ro = null; }
    }

    // 日历字号变化（Ctrl+滚轮 / 弹层 −＋）→ 字变高，汇总在右侧时高度要跟随日历重排。
    var onCalFont = function () { layoutSummary(); growSumEdits(); };
    window.addEventListener('zhinote:calfont', onCalFont);

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
        if (_ro) { try { _ro.disconnect(); } catch (_) {} _ro = null; }
        if (hoverTip) { try { hoverTip.remove(); } catch (_) {} hoverTip = null; }
        try { dom.removeEventListener('wheel', onWheel); } catch (_) {}
        try { window.removeEventListener('zhinote:calfont', onCalFont); } catch (_) {}
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
