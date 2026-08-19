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
 *   ZhiCalendar.listAgenda(dataStr)      → 近期生日/纪念日 + 记事（不含例假预测），供铃铛消息页
 *   ZhiCalendar._pendingAutoOpen         → 插入后自动弹当月月历（一次性）
 *   ZhiCalendar._pendingGoto             → {y,m,d} 打开笔记时翻到该月（只改视图，不写入正文）
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

  // 农历→公历：在公历某年里扫出「农历 lm 月 ld 日（非闰月）」对应的那天。找不到返回 null。
  function lunarToSolar(gy, lm, ld) {
    for (var mm = 1; mm <= 12; mm++) {
      var dim = new Date(gy, mm, 0).getDate();
      for (var dd = 1; dd <= dim; dd++) {
        var lu = solar2lunar(gy, mm, dd);
        if (lu.ok && !lu.isLeap && lu.month === lm && lu.day === ld) return new Date(gy, mm - 1, dd);
      }
    }
    return null;
  }
  // 重复事件(生日/纪念日)在某公历年的发生日：农历按当年换算；公历遇 2/29 平年落到 2/28。返回 Date 或 null。
  function occurInYear(ev, y) {
    if (ev.lunar) return lunarToSolar(y, ev.m, ev.d);
    var dim = new Date(y, ev.m, 0).getDate();
    return new Date(y, ev.m - 1, Math.min(ev.d, dim));
  }
  // 到某年时的年龄/第几年（生日=岁数，纪念日=第几年）；无起始年返回 null。
  function ageAt(ev, y) { return (ev.y0 && ev.y0 <= y) ? (y - ev.y0) : null; }
  // 展示用文案：生日「N 岁」、纪念日「N 周年」；起始年当年(0)不显示（0岁/第0年无意义）。
  function ageText(ev, y) {
    var a = ageAt(ev, y);
    if (a == null || a <= 0) return '';
    return ev.ty === 'birth' ? (a + ' 岁') : (a + ' 周年');
  }
  // 生日的生肖：按出生年月日的农历年推算（公历生日先换算成农历年，正确处理"春节前属上一生肖"）。需已填起始年。
  function birthZodiac(ev) {
    if (!ev || ev.ty !== 'birth' || !ev.y0) return '';
    var ly = ev.y0;
    if (!ev.lunar) { var lu = solar2lunar(ev.y0, ev.m, ev.d); if (lu && lu.ok) ly = lu.year; }
    return '属' + zodiac(ly);
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
  // 「精简记事」已从设置面板挪到头部独立按钮（cal-compactbtn），此处不再列出。
  var OPTS = [['today', '今日高亮'], ['wend', '周末标红'], ['startMon', '周一起始'], ['lunar', '显示农历'], ['term', '显示节气'], ['fest', '显示节假日'], ['almanac', '显示黄历']];
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
  // 精简模式：圆角卡片 + 两行（浓缩列表）——与「今天日历/汇总」同属圆角矩形家族，不割裂。
  var IC_COMPACT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="4"/><line x1="7" y1="10" x2="17" y2="10"/><line x1="7" y1="14" x2="14" y2="14"/></svg>';
  // 上/下月小箭头（圆头 chevron）
  var IC_CHEVL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="14.5 6 8.5 12 14.5 18"/></svg>';
  var IC_CHEVR = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9.5 6 15.5 12 9.5 18"/></svg>';
  var IC_X = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>';
  var IC_TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.5 6 20.5 6"/><path d="M8.5 6V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V6"/><path d="M6 6l1 13.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 6"/><line x1="10" y1="10" x2="10" y2="17"/><line x1="14" y1="10" x2="14" y2="17"/></svg>';
  // 「改类型」固定图标：标签(tag)形，表示"分类/类型"，点它换类型。风格与类型线性图标统一。
  var IC_TYPE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11.6 3.5H5.5a2 2 0 0 0-2 2v6.1a2 2 0 0 0 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l6.1-6.1a2 2 0 0 0 0-2.8L13 4.1a2 2 0 0 0-1.4-.6z"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/></svg>';
  var IC_CARET = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

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
  // ===== 事件类型（甲案：类型决定图标+颜色；默认「个人」不写入 ty → 老数据序列化字节不变，不误判脏、不触发同步） =====
  var TYPE_ICONS = {
    person: '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c0-3.4 2.9-5.4 6.5-5.4s6.5 2 6.5 5.4"/>',
    task: '<line x1="5" y1="7" x2="5.01" y2="7"/><line x1="5" y1="12" x2="5.01" y2="12"/><line x1="5" y1="17" x2="5.01" y2="17"/><line x1="9" y1="7" x2="19.5" y2="7"/><line x1="9" y1="12" x2="19.5" y2="12"/><line x1="9" y1="17" x2="19.5" y2="17"/>',
    work: '<rect x="3" y="7.5" width="18" height="12" rx="2.2"/><path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5"/><line x1="3" y1="12.8" x2="21" y2="12.8"/>',
    birth: '<path d="M5 20.5h14v-7.5H5z"/><path d="M5 13c1.3 0 1.3-1.5 2.6-1.5S8.9 13 10.2 13s1.3-1.5 2.6-1.5S14.1 13 15.4 13s1.3-1.5 2.6-1.5S19 13 19 13"/><line x1="8" y1="6.5" x2="8" y2="9"/><line x1="12" y1="5.5" x2="12" y2="9"/><line x1="16" y1="6.5" x2="16" y2="9"/>',
    anniv: '<path d="M12 20.3S3.8 15.4 3.8 9.4C3.8 6.6 6 4.8 8.2 4.8c1.6 0 3 1 3.8 2.3.8-1.3 2.2-2.3 3.8-2.3 2.2 0 4.4 1.8 4.4 4.6 0 6-8.2 10.9-8.2 10.9z"/>',
    period: '<path d="M12 3.5s6 6.3 6 10.5a6 6 0 0 1-12 0C6 9.8 12 3.5 12 3.5z"/>'
  };
  var NOTE_TYPES = {
    person: { name: '个人', color: null },
    task: { name: '任务', color: '#3b9edb' },
    work: { name: '工作', color: '#12a1a1' },
    birth: { name: '生日', color: '#e8983a' },
    anniv: { name: '纪念日', color: '#8b5cf6' },
    period: { name: '例假', color: '#e26a8d' }
  };
  var TYPE_ORDER = ['person', 'task', 'work', 'birth', 'anniv', 'period'];
  var NOTE_PICK = ['person', 'task', 'work'];   // 按天记事可选的类型（生日/纪念日/月经属"事件"，走＋事件菜单）
  var IS_TOUCH = (typeof window !== 'undefined') && (('ontouchstart' in window) || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));
  function typeIconSvg(ty, size) {
    size = size || 16;
    var p = TYPE_ICONS[ty] || TYPE_ICONS.person;
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }
  function typeColorOf(ty) { var m = NOTE_TYPES[ty] || NOTE_TYPES.person; return m.color; }

  // 记事条目：默认「个人」无完成 → 存字符串；否则存 { t, ty?, done?, c? }。ty=类型(非 person 才写)，c=老手动色(仅个人时保留)。
  function noteText(n) { return (typeof n === 'string') ? n : ((n && n.t) || ''); }
  function noteType(n) { return (n && typeof n === 'object' && n.ty && NOTE_TYPES[n.ty]) ? n.ty : 'person'; }
  function noteDone(n) { return !!(n && typeof n === 'object' && n.done === true); }
  function noteSpan(n) { var s = (n && typeof n === 'object') ? Math.round(+n.sp) : 1; return (s >= 2 && s <= 60) ? s : 1; }  // 持续天数(默认1)，存于起点那天
  // 跨天记事的「每天完成」清单：offset 从 0(起点当天) 到 sp-1。返回排序去重后的合法 offset 数组。
  // 兼容老数据：跨天且带整体 done:true → 视作全部天已完成。
  function noteDoneList(n) {
    var sp = noteSpan(n); if (sp <= 1) return noteDone(n) ? [0] : [];
    var out = [];
    if (n && typeof n === 'object' && Array.isArray(n.dl)) {
      n.dl.forEach(function (v) { v = Math.round(+v); if (v >= 0 && v < sp && out.indexOf(v) < 0) out.push(v); });
    } else if (noteDone(n)) { for (var i = 0; i < sp; i++) out.push(i); }
    out.sort(function (a, b) { return a - b; });
    return out;
  }
  function dayDone(n, off) { var sp = noteSpan(n); if (sp <= 1) return noteDone(n); return noteDoneList(n).indexOf(off) >= 0; }
  function noteAllDone(n) { var sp = noteSpan(n); return sp <= 1 ? noteDone(n) : (noteDoneList(n).length >= sp); }
  function noteProg(n) { var sp = noteSpan(n); return sp <= 1 ? null : { done: noteDoneList(n).length, total: sp }; }
  function allOffsets(sp) { var r = []; for (var i = 0; i < sp; i++) r.push(i); return r; }
  function toggleOffset(list, off) { var r = list.slice(), k = r.indexOf(off); if (k >= 0) r.splice(k, 1); else r.push(off); return r; }
  function rawColor(n) { return (n && typeof n === 'object' && n.c) ? n.c : null; }  // 老手动色(原样，不含类型色)
  // 显示色：非 person 用类型色；person 回落到老手动色（老数据外观不变）。
  function noteColor(n) { var ty = noteType(n); return (ty !== 'person') ? typeColorOf(ty) : rawColor(n); }
  // 无类型(个人)、无完成、无老色、单天 → 存字符串（与旧数据字节一致）；否则存对象。设了类型即以类型色为准、丢弃老手动色。
  // 单天：完成用 done:true。跨天(sp>1)：完成用 dl(每天 offset 清单)，不写 done。
  function makeNote(t, ty, done, c, span, dl) {
    var typed = ty && ty !== 'person' && NOTE_TYPES[ty];
    var sp = (span >= 2 && span <= 60) ? Math.round(span) : 1;
    if (!typed && !done && !c && sp <= 1) return t;
    var o = { t: t };
    if (typed) o.ty = ty;
    if (sp > 1) {
      o.sp = sp;
      var ds = [];
      if (Array.isArray(dl)) dl.forEach(function (v) { v = Math.round(+v); if (v >= 0 && v < sp && ds.indexOf(v) < 0) ds.push(v); });
      if (ds.length) { ds.sort(function (a, b) { return a - b; }); o.dl = ds; }
    } else if (done) o.done = true;
    if (c && !typed) o.c = c;
    return o;
  }
  // 月格/悬停里的记事标记：有类型→彩色类型图标；个人有老色→圆点；否则空。
  function noteMark(n, size) {
    var ty = noteType(n);
    if (ty !== 'person') return '<span class="cal-n-tyic" style="color:' + typeColorOf(ty) + '">' + typeIconSvg(ty, size || 11) + '</span>';
    var c = rawColor(n);
    return c ? '<span class="cal-n-dot" style="background:' + c + '"></span>' : '';
  }
  // 单条记事右侧「改类型」控件：固定标签图标（不随当前类型变），点击展开类型选择器。
  function typeCtrlHtml(di) {
    return '<span class="cal-note-ty"' + (di || '') + ' title="改类型 · 设持续天数">' + IC_TYPE + '</span>';
  }
  // 记事左侧标记：彩色圆角框 + 白色类型图标（与日程一致）；已完成显示白色对勾。点它=完成/取消。
  // dnOverride 可传该"某一天"的完成态（跨天按天勾）；不传则用整体完成态。
  function noteBoxHtml(n, di, dnOverride) {
    var ty = noteType(n), dn = (dnOverride == null) ? noteAllDone(n) : !!dnOverride, col = noteColor(n) || '#3fae6b';
    return '<span class="cal-note-ck' + (dn ? ' on' : '') + '"' + (di || '') + ' style="background:' + col + '" title="完成/取消">' + (dn ? IC_CHECK : typeIconSvg(ty, 12)) + '</span>';
  }
  // 跨天完成度小条：进度条 + k/N 文字（点日期卡里每天各自打勾累计）。
  function progHtml(n) {
    var p = noteProg(n); if (!p) return '';
    var pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    return '<span class="cal-note-prog" title="已完成 ' + p.done + '/' + p.total + ' 天"><span class="cal-prog-bar"><i style="width:' + pct + '%"></i></span><span class="cal-prog-txt">' + p.done + '/' + p.total + '</span></span>';
  }
  // 记事「改类型」选择器：与底部「添加事件」格子同款（彩色图标框 + 名）。记事只有 个人/任务/工作 三类，
  // 生日/纪念日/月经属"事件"，从卡片底部的「＋ 添加事件」加，不在记事类型里。
  function typePickerHtml(curTy, di) {
    return '<div class="cal-typepick"' + (di || '') + '>'
      + '<div class="cal-tp-types">' + NOTE_PICK.map(function (ty) {
        var col = typeColorOf(ty) || '#3fae6b';
        return '<button type="button" class="cal-type-choice' + (curTy === ty ? ' selected' : '') + '" data-ty="' + ty + '">'
          + '<span class="cal-tb-i" style="background:' + col + '">' + typeIconSvg(ty, 12) + '</span>' + NOTE_TYPES[ty].name + '</button>';
      }).join('') + '</div>'
      + '</div>';
  }
  // 行内「持续天数」：数字可直接输入（大数字不必狂点），两侧 ± 微调。
  // 单天(sp=1)默认藏起，hover/编辑该行才现；跨天(sp>1)常显。
  function spanFieldHtml(sp) {
    return '<button type="button" class="cal-note-spb" data-sp="-1" tabindex="-1">－</button>'
      + '<input class="cal-note-spv" type="text" inputmode="numeric" maxlength="2" value="' + sp + '">'
      + '<i class="cal-note-spu">天</i>'
      + '<button type="button" class="cal-note-spb" data-sp="1" tabindex="-1">＋</button>';
  }
  function spanCtrlHtml(n, di) {
    var sp = noteSpan(n);
    return '<span class="cal-note-sp' + (sp <= 1 ? ' cal-note-sp-one' : '') + '"' + (di || '') + ' title="持续天数（可直接输入）">'
      + spanFieldHtml(sp) + '</span>';
  }
  // 读某个 .cal-note-sp 里输入框的当前天数（1..60），非法回退到 fallback。
  function spvOf(scEl, fallback) { var inp = scEl.querySelector('.cal-note-spv'); var v = inp ? parseInt(inp.value, 10) : NaN; return (v >= 1 && v <= 60) ? v : fallback; }

  // 存盘对象：过滤空记事、规范化条目（无色→字符串），保证不写入空条目、跨端稳定。
  function toObj(S) {
    var notes = {};
    Object.keys(S.notes || {}).forEach(function (k) {
      var arr = (S.notes[k] || [])
        .filter(function (n) { return noteText(n).trim(); })
        .map(function (n) { return makeNote(noteText(n).trim(), noteType(n), noteDone(n), rawColor(n), noteSpan(n), noteDoneList(n)); });
      if (arr.length) notes[k] = arr;
    });
    var out = { v: 1, y: S.y, m: S.m, opts: S.opts, notes: notes };
    // 重复事件(生日/纪念日)：规范化 + 仅在非空时写入 → 无重复事件的老日历序列化字节不变。
    var recur = (S.recur || []).filter(function (ev) {
      return ev && (ev.ty === 'birth' || ev.ty === 'anniv') && ev.m >= 1 && ev.m <= 12 && ev.d >= 1 && ev.d <= 31;
    }).map(function (ev) {
      var o = { ty: ev.ty, m: ev.m, d: ev.d };
      var nm = (ev.name || '').trim(); if (nm) o.name = nm;
      if (ev.lunar) o.lunar = true;
      if (ev.y0 && ev.y0 >= 1000 && ev.y0 <= 9999) o.y0 = ev.y0;
      return o;
    });
    if (recur.length) out.recur = recur;
    // 月经追踪：仅在「已启用」或「有记录」时写入（否则整键省略 → 老日历字节不变）。日志按日期排序保证输出确定。
    if (S.period && (S.period.on || (S.period.logs && S.period.logs.length))) {
      var pl = (S.period.logs || []).filter(function (l) {
        return l && typeof l.s === 'string' && l.s.split('-').length === 3;
      }).map(function (l) {
        var len = +l.len; if (!(len >= 1 && len <= 15)) len = 5;
        return { s: l.s, len: len };
      }).sort(function (a, b) { return dParse(a.s) - dParse(b.s); });
      var po = {};
      if (S.period.on) po.on = true;
      if (pl.length) po.logs = pl;
      if (S.period.cyc >= 15 && S.period.cyc <= 60) po.cyc = S.period.cyc;
      if (S.period.len >= 1 && S.period.len <= 15) po.len = S.period.len;
      if (S.period.ovu === false) po.ovu = false;   // 排卵日预测默认开，仅"关"时写入（老数据字节不变）
      if (po.on || (po.logs && po.logs.length)) out.period = po;
    }
    return out;
  }
  // 'Y-M-D' → 当地零点 Date（月经日志用）。
  function dParse(s) { var p = String(s).split('-'); return new Date(+p[0], (+p[1]) - 1, +p[2]); }
  function dKey(dt) { return dt.getFullYear() + '-' + (dt.getMonth() + 1) + '-' + dt.getDate(); }
  function dAdd(dt, n) { var x = new Date(dt); x.setDate(x.getDate() + n); return x; }
  function dSame(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
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
    var recur = [];
    if (Array.isArray(o.recur)) o.recur.forEach(function (ev) {
      if (!ev || (ev.ty !== 'birth' && ev.ty !== 'anniv')) return;
      var m = +ev.m, d = +ev.d;
      if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return;
      var e = { ty: ev.ty, m: m, d: d, name: (typeof ev.name === 'string' ? ev.name : ''), lunar: ev.lunar === true };
      var y0 = +ev.y0; if (y0 >= 1000 && y0 <= 9999) e.y0 = y0;
      recur.push(e);
    });
    var period = null;
    if (o.period && typeof o.period === 'object') {
      var logs = [];
      if (Array.isArray(o.period.logs)) o.period.logs.forEach(function (l) {
        if (!l) return; var pp = String(l.s || '').split('-');
        if (pp.length !== 3) return; var yy = +pp[0], mm = +pp[1], dd = +pp[2];
        if (!(yy >= 1900 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return;
        var len = +l.len; if (!(len >= 1 && len <= 15)) len = 5;
        logs.push({ s: yy + '-' + mm + '-' + dd, len: len });
      });
      var on = o.period.on === true;
      if (on || logs.length) {
        period = { on: on, logs: logs };
        var cyc = +o.period.cyc; if (cyc >= 15 && cyc <= 60) period.cyc = cyc;
        var plen = +o.period.len; if (plen >= 1 && plen <= 15) period.len = plen;
        if (o.period.ovu === false) period.ovu = false;
      }
    }
    return {
      y: Number.isFinite(o.y) ? o.y : n.getFullYear(),
      m: (o.m >= 0 && o.m <= 11) ? o.m : n.getMonth(),
      opts: opts,
      notes: (o.notes && typeof o.notes === 'object' && !Array.isArray(o.notes)) ? o.notes : {},
      recur: recur,
      period: period,
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
    if (api._pendingGoto) {
      var g = api._pendingGoto;
      api._pendingGoto = null;
      if (g && typeof g.y === 'number' && typeof g.m === 'number') { S.y = g.y; S.m = g.m; }
    }
    var now = new Date();
    var TODAY = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
    var card = null, cardMask = null, cardDay = 0;
    var wheelLock = 0, popWheelLock = 0;
    var py = S.y, pmode = 'm'; // 月历弹层：'m'=选月 / 'y'=选年
    var openColorIdx = -1, softTimer = null, hoverTip = null;
    var openSumColorKey = null;               // 汇总里正在展开选色的条目 'day-idx'（如 '13-0'）
    var _cardPopOutside = null, _sumPopOutside = null;   // 类型/天数弹层的"点外部收起"监听（每次重绘先撤旧再挂新，防泄漏）
    var _addOutside = null;                                // 汇总「添加记事」的"点外部落定/收起"监听（替代易在触屏误触发的失焦收起）
    var sumAddOpen = false;                    // 底部添加行是否已展开（点＋后显示日期+内容输入）
    var sumAddTy = 'person', sumAddSpan = 1;   // 汇总添加行：待添加记事的类型/持续天数
    var pendingNewMove = null;                 // 拖到"新日期投放区"后待填日期的搬移 { fromD, fromI }
    var editHlDay = null;                       // 正在编辑的汇总记事所属日期：借用「今日高亮」点亮那天
    var editDateDay = null;                      // 正在改「日期」的那天（点日期数字进入，改完移动当天全部记事）
    var panelTab = 'sum';                        // 右侧面板：'sum'=汇总 / 'agenda'=日程(含洞察)
    var insightOpen = false;                     // 日程页顶部「洞察」是否展开（默认收成一条摘要）
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
      var s = info.ganzhi + '年' + info.lunarMonth + info.lunarDay + ' · ' + info.zodiac + '年';
      if (info.term) s += ' · ' + info.term;
      var fe = info.solarFest || info.lunarFest;
      if (fe) s += ' · ' + fe;
      return s;
    }

    // 悬停预览：某天有记事（≥1 条）就 hover 显示全部、完整不省略（浮层，pointer-events:none 不挡操作）。
    function showTip(d, td) {
      var arr = (S.notes[noteKey(d)] || []).filter(function (n) { return noteText(n).trim(); });
      var revs = recurOn(d);
      var conts = spanInto(new Date(S.y, S.m, d));
      if (arr.length + revs.length + conts.length < 1) { hideTip(); return; }
      if (!hoverTip) { hoverTip = document.createElement('div'); hoverTip.className = 'cal-hovertip hidden'; document.body.appendChild(hoverTip); }
      var alm = S.opts.almanac ? almanacLine(d) : '';
      var recurHtml = revs.map(function (ev) {
        var col = typeColorOf(ev.ty) || 'var(--text-tertiary, #999)';
        return '<div class="cal-hovertip-i"><span class="cal-n-tyic" style="color:' + col + '">' + typeIconSvg(ev.ty, 12) + '</span><span class="cal-hovertip-t">' + esc(recurLabel(ev, true)) + '</span></div>';
      }).join('');
      var contHtml = conts.map(function (x) {
        var col = chipColor(noteType(x.n), x.n);
        return '<div class="cal-hovertip-i' + (dayDone(x.n, x.day - 1) ? ' done' : '') + '"><span class="cal-n-tyic" style="color:' + col + '">' + typeIconSvg(noteType(x.n), 12) + '</span><span class="cal-hovertip-t">' + esc(noteText(x.n).trim()) + ' · 第 ' + x.day + '/' + x.sp + ' 天</span></div>';
      }).join('');
      var cnt = arr.length + revs.length + conts.length;
      hoverTip.innerHTML = '<div class="cal-hovertip-h">' + (S.m + 1) + ' 月 ' + d + ' 日 · ' + cnt + ' 条</div>'
        + (alm ? '<div class="cal-hovertip-alm">' + esc(alm) + '</div>' : '')
        + recurHtml
        + arr.map(function (n) {
          var mk = noteMark(n, 12) || '<span class="cal-n-dot cal-n-dot-empty"></span>';
          var pr = noteProg(n);
          var spTxt = pr ? ' · ' + pr.done + '/' + pr.total + ' 天' : '';
          return '<div class="cal-hovertip-i' + ((noteSpan(n) > 1 ? dayDone(n, 0) : noteDone(n)) ? ' done' : '') + '">' + mk + '<span class="cal-hovertip-t">' + esc(noteText(n)) + spTxt + '</span></div>';
        }).join('')
        + contHtml;
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
    // 跨天记事：某个日期上「起点在更早某天、持续到此」的记事（不含起点当天本身）。
    // 做法A：起点那天正常显示/可编辑，被覆盖的后续天只读延续显示。
    function spanInto(dt) {
      var out = [];
      Object.keys(S.notes || {}).forEach(function (k) {
        var sd; try { sd = dParse(k); } catch (_) { return; } if (isNaN(sd)) return;
        (S.notes[k] || []).forEach(function (n, i) {
          if (!noteText(n).trim()) return;
          var sp = noteSpan(n); if (sp <= 1) return;
          if (dt > sd && dt < dAdd(sd, sp)) out.push({ n: n, key: k, i: i, start: sd, sp: sp, day: Math.round((dt - sd) / 86400000) + 1 });
        });
      });
      return out;
    }
    // 当前视图月里，某天今年发生的重复事件（生日/纪念日）。
    function recurOn(d) {
      var out = [];
      (S.recur || []).forEach(function (ev) {
        var oc = occurInYear(ev, S.y);
        if (oc && oc.getFullYear() === S.y && oc.getMonth() === S.m && oc.getDate() === d) out.push(ev);
      });
      return out;
    }
    // 重复事件的显示名（无名用类型名）+ 年龄/第几年后缀。
    function recurLabel(ev, withAge) {
      var nm = (ev.name || '').trim() || NOTE_TYPES[ev.ty].name;
      if (withAge) { var at = ageText(ev, S.y); if (at) nm += ' · ' + at; }
      return nm;
    }
    // 月格事件小胶囊颜色：类型色；个人回落到老手动色，再回落到柔和绿（与 demo 一致）。
    function chipColor(ty, n) {
      if (ty && ty !== 'person') return typeColorOf(ty);
      var rc = n ? rawColor(n) : null;
      return rc || '#3fae6b';
    }
    // 做法B：跨天记事走「连续横条」（见 barbandHtml / computeLanes），不进小胶囊。
    // 月经不占胶囊/横条（走整格底色高亮）。
    // 全月跨天记事的「排道」：同一条记事在它覆盖的所有天里固定占同一条 lane，横向才能对齐成连续横条。
    // 贪心区间调度：按 起点↑ / 天数↓ / key 稳定排序，给每条分配"能放下的最小 lane"。
    function computeLanes() {
      var ms = [];
      Object.keys(S.notes || {}).forEach(function (k) {
        var sd; try { sd = dParse(k); } catch (_) { return; } if (isNaN(sd)) return;
        (S.notes[k] || []).forEach(function (n, i) {
          if (!noteText(n).trim()) return;
          var sp = noteSpan(n); if (sp <= 1) return;
          ms.push({ key: k, i: i, start: sd, end: dAdd(sd, sp), sp: sp });
        });
      });
      ms.sort(function (a, b) { return (a.start - b.start) || (b.sp - a.sp) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (a.i - b.i); });
      var laneEnds = [], laneOf = {};
      ms.forEach(function (m) {
        var lane = 0;
        while (lane < laneEnds.length && laneEnds[lane] > m.start) lane++;
        laneEnds[lane] = m.end;
        laneOf[m.key + '#' + m.i] = lane;
      });
      return laneOf;
    }
    // 某天覆盖到的所有跨天记事（起点当天 off=0 + 之前起、延续到今天的）。
    function barsOn(d) {
      var dt = new Date(S.y, S.m, d), out = [];
      (S.notes[noteKey(d)] || []).forEach(function (n, i) {
        if (noteText(n).trim() && noteSpan(n) > 1) out.push({ key: noteKey(d), i: i, n: n, off: 0, sp: noteSpan(n) });
      });
      spanInto(dt).forEach(function (x) { out.push({ key: x.key, i: x.i, n: x.n, off: x.day - 1, sp: x.sp }); });
      return out;
    }
    // 某天的横条带：按 lane 铺满 laneCount 行（该 lane 有条就画段、没有就占位空行，保证跨格对齐）。
    // ci=该天在本周的列号（0=周首）：周首那格重新标出文字，视觉断行处也能认出是哪条。
    function barbandHtml(d, ci, laneOf, laneCount) {
      if (laneCount <= 0) return '';
      var occ = {};
      barsOn(d).forEach(function (b) { occ[laneOf[b.key + '#' + b.i]] = b; });
      var html = '<div class="cal-barband">';
      for (var L = 0; L < laneCount; L++) {
        var b = occ[L];
        if (!b) { html += '<div class="cal-bar cal-bar-empty"></div>'; continue; }
        var n = b.n, sp = b.sp, off = b.off, ty = noteType(n);
        // 名称显示在每段"可见起点"：真起点 / 周首(断周处) / 本月首日(跨月延续进来的第一天)
        var isStart = off === 0, isEnd = off === sp - 1, label = isStart || ci === 0 || d === 1;
        var doneDay = dayDone(n, off), col = chipColor(ty, n);
        var cls = ['cal-bar'];
        if (isStart) cls.push('is-start'); if (isEnd) cls.push('is-end');
        if (doneDay) cls.push('done'); if (noteAllDone(n)) cls.push('all-done');
        var txt = noteText(n).trim();
        var inner = label ? ('<span class="cal-bar-i">' + typeIconSvg(ty, 11) + '</span><span class="cal-bar-t">' + esc(txt) + '</span>') : '';
        html += '<div class="' + cls.join(' ') + '" style="background:' + col + '" data-key="' + b.key + '" data-i="' + b.i + '" data-off="' + off + '" title="' + esc(txt) + '（第 ' + (off + 1) + '/' + sp + ' 天 · 点这天打勾/取消）">' + inner + '</div>';
      }
      return html + '</div>';
    }
    // 月格里当天的「事件小胶囊」：重复事件(生日/纪念日) + 单天记事(个人/任务/工作)。跨天记事走横条、不进这里。
    // 精简模式最多 2 条 + 「+N」（N 含被折叠的横条数 extraHidden）；展开模式全列。
    function dayChipsHtml(d, compact, extraHidden) {
      extraHidden = extraHidden || 0;
      var items = [];
      recurOn(d).forEach(function (ev) {
        items.push({ col: typeColorOf(ev.ty) || '#e8983a', icon: ev.ty, name: (ev.name || '').trim() || NOTE_TYPES[ev.ty].name, done: false });
      });
      var kk = noteKey(d);
      (S.notes[kk] || []).forEach(function (n, i) {
        var t = noteText(n).trim(); if (!t) return;
        if (noteSpan(n) > 1) return;   // 跨天走横条
        items.push({ col: chipColor(noteType(n), n), icon: noteType(n), name: t, done: noteDone(n), key: kk, i: i });
      });
      if (!items.length && !extraHidden) return '';
      var max = compact ? 2 : items.length;
      var shown = items.slice(0, max), hidden = (items.length - shown.length) + extraHidden;
      var html = '<div class="cal-chips' + (compact ? '' : ' cal-chips-fit') + '">';
      shown.forEach(function (it) {
        var ck = (it.key != null);   // 记事胶囊可点勾；生日/纪念日胶囊不可勾
        var attr = ck ? (' data-key="' + it.key + '" data-i="' + it.i + '" title="点这条打勾/取消"') : '';
        html += '<div class="cal-chip' + (it.done ? ' done' : '') + (ck ? ' cal-chip-ck' : '') + '"' + attr + ' style="background:' + it.col + '">'
          + '<span class="cal-chip-i">' + typeIconSvg(it.icon, 11) + '</span>'
          + '<span class="cal-chip-t">' + esc(it.name) + '</span></div>';
      });
      if (compact && hidden > 0) html += '<span class="cal-chip-more">+' + hidden + '</span>';
      return html + '</div>';
    }
    // 月格里的重复事件小行（图标+名，精简模式截 4 字）。
    function recurChipsHtml(d, compact) {
      var revs = recurOn(d);
      if (!revs.length) return '';
      return '<div class="cal-recur">' + revs.map(function (ev) {
        var col = typeColorOf(ev.ty) || 'var(--text-tertiary, #999)';
        var nm = recurLabel(ev, !compact);
        if (compact) nm = ((ev.name || '').trim() || NOTE_TYPES[ev.ty].name).slice(0, 4);
        return '<div class="cal-recur-i"><span class="cal-n-tyic" style="color:' + col + '">' + typeIconSvg(ev.ty, compact ? 11 : 12) + '</span><span class="cal-recur-t">' + esc(nm) + '</span></div>';
      }).join('') + '</div>';
    }
    // ===== 月经模型（只存日志，周期/经期长度靠算，可手动覆盖；越记越准） =====
    // 功能默认常开：不写任何开关字段，没有记录就不显示、不占空间、不入库（同步安全）。
    function pOn() { return true; }
    function pLogs() { return (S.period && Array.isArray(S.period.logs)) ? S.period.logs : []; }
    function pStarts() { return pLogs().map(function (l) { return dParse(l.s); }).sort(function (a, b) { return a - b; }); }
    function pAutoCyc() { var s = pStarts(); if (s.length < 2) return 28; var g = 0; for (var i = 1; i < s.length; i++) g += Math.round((s[i] - s[i - 1]) / 86400000); return Math.round(g / (s.length - 1)) || 28; }
    function pAutoLen() { var L = pLogs(); if (!L.length) return 5; var t = 0; L.forEach(function (l) { t += (l.len || 5); }); return Math.round(t / L.length) || 5; }
    function effCyc() { return (S.period && S.period.cyc) ? S.period.cyc : pAutoCyc(); }
    function effLen() { return (S.period && S.period.len) ? S.period.len : pAutoLen(); }
    function predStarts() { var s = pStarts(); if (!s.length) return []; var last = s[s.length - 1], r = []; for (var k = 1; k <= 6; k++) r.push(dAdd(last, effCyc() * k)); return r; }
    // 某天的经期状态：'real'（记录内）/'pred'（预测内）/'ovu'（预测排卵日≈提前14天）/null。
    function ovuOn() { return !(S.period && S.period.ovu === false); }   // 排卵日预测默认开
    // 排卵日只是按记录推算的大概日子，tooltip 里简短中性地说明。
    var OVU_TIP = '根据记录推算的预测值，仅供参考，实际会有出入。';
    function periodState(dt) {
      if (!pOn()) return null;
      var L = pLogs();
      for (var i = 0; i < L.length; i++) { var st = dParse(L[i].s); if (dt >= st && dt < dAdd(st, L[i].len || effLen())) return 'real'; }
      var ps = predStarts();
      for (var k = 0; k < ps.length; k++) { if (dt >= ps[k] && dt < dAdd(ps[k], effLen())) return 'pred'; if (ovuOn() && dSame(dt, dAdd(ps[k], -14))) return 'ovu'; }
      return null;
    }
    function pStartIdx(dt) { var L = pLogs(); for (var i = 0; i < L.length; i++) if (dSame(dParse(L[i].s), dt)) return i; return -1; }
    // 这天落在哪次已记录例假里 → 返回 {day: 第几天(从1起), len}；不在任何一次里返回 null。
    function periodRealInfo(dt) {
      var L = pLogs();
      for (var i = 0; i < L.length; i++) {
        var st = dParse(L[i].s), len = L[i].len || effLen();
        if (dt >= st && dt < dAdd(st, len)) return { day: Math.round((dt - st) / 86400000) + 1, len: len };
      }
      return null;
    }

    // 这天落在哪条已记录例假里（含起点），返回日志下标；不在任何一次里返回 -1。
    function pContainIdx(dt) {
      var L = pLogs();
      for (var i = 0; i < L.length; i++) { var st = dParse(L[i].s); if (dt >= st && dt < dAdd(st, L[i].len || effLen())) return i; }
      return -1;
    }
    // 标记这天为例假开始：单人使用、按距离自动判定「纠正 vs 新的一次」。
    // 附近已有记录（约半周期内、封顶 12 天）→ 纠正：把最近那条的开始日移到这天，不新增；否则视为新的一次累积历史。
    function pMarkStart(dt) {
      S.period = S.period || { logs: [] };
      if (!Array.isArray(S.period.logs)) S.period.logs = [];
      var L = S.period.logs, key = dKey(dt);
      var nearIdx = -1, nearDist = 1e9;
      for (var i = 0; i < L.length; i++) { var dd = Math.abs(Math.round((dParse(L[i].s) - dt) / 86400000)); if (dd < nearDist) { nearDist = dd; nearIdx = i; } }
      var thresh = Math.max(6, Math.min(12, Math.round(effCyc() * 0.5)));
      if (nearIdx >= 0 && nearDist === 0) return;                 // 已是这天，无需重复
      if (nearIdx >= 0 && nearDist <= thresh) { L[nearIdx].s = key; } // 纠正：移动开始日
      else { L.push({ s: key, len: effLen() }); }                 // 新的一次
      L.sort(function (a, b) { return dParse(a.s) - dParse(b.s); });
    }
    // 例假行里的「周期± / 长度±」小控件（日期卡上也能调，不必去洞察）。
    function periodCfgHtml(len) {
      return '<div class="cal-p-cfg">'
        + '<span class="cal-p-cfg-i"><span class="lb">周期</span><button type="button" class="cal-p-cdec" title="减一天">－</button><b class="v">' + effCyc() + '</b><button type="button" class="cal-p-cinc" title="加一天">＋</button><span class="u">天</span></span>'
        + '<span class="cal-p-cfg-i"><span class="lb">长度</span><button type="button" class="cal-p-ldec" title="减一天">－</button><b class="v cal-p-len">' + len + '</b><button type="button" class="cal-p-linc" title="加一天">＋</button><span class="u">天</span></span>'
        + '</div>';
    }
    // 日期卡片的「例假」一行：仅当这天与例假有关（记录起点/例假中/预测/排卵）才显示；平时不占地方。
    function periodStatusHtml(d) {
      var dt = new Date(S.y, S.m, d), si = pStartIdx(dt), pst = periodState(dt);
      var col = typeColorOf('period'), ic = '<span class="cal-p-ic" style="background:' + col + '">' + typeIconSvg('period', 12) + '</span>';
      var main, cfg = '';
      var delBtn = '<button type="button" class="cal-ev-del cal-p-del" title="删除这次例假记录">' + IC_TRASH + '</button>';
      if (si >= 0) {
        var len = S.period.logs[si].len || effLen();
        main = ic + '<span class="cal-p-t">例假开始 · 约 <b class="cal-p-len">' + len + '</b> 天</span>' + delBtn;
        cfg = periodCfgHtml(len);
      } else if (pst === 'real') {
        var ri = periodRealInfo(dt);
        main = ic + '<span class="cal-p-t">例假中' + (ri ? ' · 第 <b class="cal-p-len">' + ri.day + '</b> 天' : '') + '</span>' + delBtn;
      } else if (pst === 'pred') {
        main = ic + '<span class="cal-p-t">例假（预测 · 周期约 ' + effCyc() + ' 天）</span>'
          + '<button type="button" class="cal-p-confirm" title="其实这天来了？记为真实开始">记为开始</button>';
      } else if (pst === 'ovu') {
        main = '<span class="cal-p-ic" style="background:' + typeColorOf('anniv') + '">' + typeIconSvg('anniv', 12) + '</span><span class="cal-p-t" title="' + OVU_TIP + '">排卵日（预测）</span>';
      } else {
        return '';
      }
      return '<div class="cal-p-sec"><div class="cal-p-main">' + main + '</div>' + cfg + '</div>';
    }
    function bindPeriod(d) {
      var sec = card.querySelector('.cal-p-sec');
      if (!sec) return;
      var dt = new Date(S.y, S.m, d);
      var mdown = function (e) { e.preventDefault(); };
      var del = sec.querySelector('.cal-p-del');
      if (del) { del.addEventListener('mousedown', mdown); del.addEventListener('click', function () {
        var i = pStartIdx(dt); if (i < 0) i = pContainIdx(dt);   // 期内任意一天都能删掉整段
        if (i >= 0) S.period.logs.splice(i, 1);
        if (S.period && !(S.period.logs && S.period.logs.length)) S.period = null;
        commit(); drawCard();
      }); }
      // 长度：起点行改「这条记录」的长度；预测行没有具体记录，改的是全局默认长度 period.len。
      var lbump = function (delta) {
        var i = pStartIdx(dt);
        if (i >= 0) { var l = S.period.logs[i]; var v = (l.len || effLen()) + delta; l.len = Math.max(2, Math.min(10, v)); }
        else { S.period = S.period || { logs: [] }; S.period.len = Math.max(2, Math.min(10, effLen() + delta)); }
        commit(); drawCard();
      };
      var cbump = function (delta) { S.period = S.period || { logs: [] }; S.period.cyc = Math.max(20, Math.min(45, effCyc() + delta)); commit(); drawCard(); };
      var bind = function (selInc, selDec, fn) {
        var a = sec.querySelector(selInc), b = sec.querySelector(selDec);
        if (a) { a.addEventListener('mousedown', mdown); a.addEventListener('click', function () { fn(1); }); }
        if (b) { b.addEventListener('mousedown', mdown); b.addEventListener('click', function () { fn(-1); }); }
      };
      bind('.cal-p-linc', '.cal-p-ldec', lbump);
      bind('.cal-p-cinc', '.cal-p-cdec', cbump);
      var conf = sec.querySelector('.cal-p-confirm');
      if (conf) { conf.addEventListener('mousedown', mdown); conf.addEventListener('click', function () { pMarkStart(dt); commit(); drawCard(); }); }
    }

    // 日期卡片里的「重复事件」区：只列当天已有的生日/纪念日（可改名/切农历/填起始年/删）。
    // 没有就返回空——添加入口收进底部「＋ 事件」菜单，卡片默认保持干净。
    function recurEventsHtml(d) {
      var revs = recurOn(d);
      if (!revs.length) return '';
      var list = revs.map(function (ev) {
        var gi = S.recur.indexOf(ev);
        var col = typeColorOf(ev.ty) || 'var(--text-tertiary, #999)';
        var ageTxt = ageText(ev, S.y);
        var zodTxt = birthZodiac(ev);
        var tail = ageTxt;
        if (zodTxt) tail = tail ? (tail + ' · ' + zodTxt) : zodTxt;
        return '<div class="cal-recur-row" data-g="' + gi + '">'
          + '<span class="cal-recur-ic" style="background:' + col + '" title="' + NOTE_TYPES[ev.ty].name + '">' + typeIconSvg(ev.ty, 12) + '</span>'
          + '<input class="cal-recur-name" data-g="' + gi + '" placeholder="' + NOTE_TYPES[ev.ty].name + '名称" value="' + esc(ev.name || '') + '">'
          + '<button type="button" class="cal-recur-lunar' + (ev.lunar ? ' on' : '') + '" data-g="' + gi + '" title="按农历每年重复">农历</button>'
          + '<input class="cal-recur-y0" data-g="' + gi + '" inputmode="numeric" maxlength="4" placeholder="起始年" value="' + (ev.y0 || '') + '">'
          + (tail ? '<span class="cal-recur-age">' + tail + '</span>' : '')
          + '<button type="button" class="cal-ev-del cal-recur-del" data-g="' + gi + '" title="删除这个' + NOTE_TYPES[ev.ty].name + '">' + IC_TRASH + '</button></div>';
      }).join('');
      return '<div class="cal-recur-sec"><div class="cal-recur-list">' + list + '</div></div>';
    }

    // 底部「＋ 添加事件」类型格（仿 demo）：6 类型一目了然，点哪个就加哪种。
    //  个人/任务/工作 → 加一条可编辑记事；生日/纪念日 → 加一条重复事件；月经 → 标记这天开始。
    function footerGridHtml(d) {
      // 固定 6 个类型，数量不随已加内容变化（点经期时若当天已有记录，算法内跳过、不重复添加）。
      var btns = TYPE_ORDER.map(function (k) {
        var t = NOTE_TYPES[k], col = typeColorOf(k) || '#3fae6b';
        return '<button type="button" class="cal-typebtn" data-ty="' + k + '">'
          + '<span class="cal-tb-i" style="background:' + col + '">' + typeIconSvg(k, 12) + '</span>' + t.name + '</button>';
      }).join('');
      return '<div class="cal-dc-f"><div class="cal-dc-ph">＋ 添加事件</div><div class="cal-typegrid">' + btns + '</div></div>';
    }
    function bindFooterGrid(d) {
      var f = card.querySelector('.cal-dc-f');
      if (!f) return;
      var dt = new Date(S.y, S.m, d), key = noteKey(d);
      f.querySelectorAll('.cal-typebtn').forEach(function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () {
          var ty = b.dataset.ty;
          if (ty === 'period') {
            pMarkStart(dt);
            commit(); drawCard();
          } else if (ty === 'birth' || ty === 'anniv') {
            S.recur = S.recur || [];
            S.recur.push({ ty: ty, name: '', m: S.m + 1, d: d, lunar: false });
            commit(); drawCard();
            var names = card.querySelectorAll('.cal-recur-name');
            var last = names[names.length - 1];
            if (last) { try { last.focus({ preventScroll: true }); } catch (_) { last.focus(); } }
          } else {
            (S.notes[key] = S.notes[key] || []).push(makeNote('', ty));
            openColorIdx = -1;
            commit(); drawCard((S.notes[key].length - 1));
          }
        });
      });
    }
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
      var t = noteText(n), dn = noteAllDone(n), ty = noteType(n);
      var kk = d + '-' + i;
      var di = ' data-d="' + d + '" data-i="' + i + '"';
      var ck = noteBoxHtml(n, di);
      var tyc = typeCtrlHtml(di);
      var spc = spanCtrlHtml(n, di);
      var pal = (openSumColorKey === kk) ? typePickerHtml(ty, di) : '';
      return '<div class="cal-sum-i' + (dn ? ' done' : '') + '"' + di + '>'
        + ck
        + '<textarea class="cal-sum-edit" rows="1"' + di + ' placeholder="写点什么…">' + esc(t) + '</textarea>'
        + progHtml(n) + spc + tyc + '<span class="del"' + di + ' title="删除">' + IC_TRASH + '</span></div>' + pal;
    }

    // 汇总标签页正文（本月记事，按天分组，可编辑/拖动/改日期/加）。
    function buildSumBody() {
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
      var addRow;
      if (sumAddOpen) {
        var tyBtns = NOTE_PICK.map(function (ty) {
          var col = typeColorOf(ty) || '#3fae6b';
          return '<button type="button" class="cal-add-ty' + (sumAddTy === ty ? ' on' : '') + '" data-ty="' + ty + '" title="' + NOTE_TYPES[ty].name + '"><span class="cal-tb-i" style="background:' + col + '">' + typeIconSvg(ty, 12) + '</span></button>';
        }).join('');
        addRow = '<div class="cal-sum-add open">'
          + '<div class="cal-sum-add-r1">'
          + '<input class="cal-sum-add-d" type="text" inputmode="numeric" maxlength="2" placeholder="日" value="' + (TODAY.y === S.y && TODAY.m === S.m ? TODAY.d : '') + '">'
          + '<span class="cal-add-tys">' + tyBtns + '</span>'
          + '<span class="cal-note-sp cal-add-sp" title="持续天数（可直接输入）">' + spanFieldHtml(sumAddSpan) + '</span>'
          + '</div>'
          + '<textarea class="cal-sum-add-t" rows="1" placeholder="写点什么…"></textarea></div>';
      } else {
        addRow = '<div class="cal-sum-add"><span class="cal-sum-addplus" title="添加记事">＋</span><span class="cal-sum-addhint">添加记事…</span></div>';
      }
      var zone;
      if (pendingNewMove) {
        zone = '<div class="cal-sum-newzone active"><span class="cal-sum-nzhint">移到</span><input class="cal-sum-newdate" type="text" inputmode="numeric" maxlength="2" placeholder="日" autofocus><span class="cal-sum-nzhint">日（回车确认）</span></div>';
      } else {
        zone = '<div class="cal-sum-newzone"><span class="cal-sum-nzhint">拖到这里 → 移到新日期</span></div>';
      }
      return body + zone + addRow;
    }

    function buildSummaryHtml() {
      var isAg = panelTab === 'agenda';
      // 置顶区：年月(切月手势) + 切换条(切标签手势) + 复制键(仅汇总有，用占位保持两页布局一致、不跳动)
      // 置顶区：年月(切月) + 切换条(切标签) + 洞察摘要(两页共用、常驻可见、可展开)
      var head = '<div class="cal-summary-top">'
        + '<div class="cal-summary-h"><span class="cal-summary-ym" title="在此滚轮切换月份">' + ymLabel() + '</span>'
        + '<button type="button" class="cal-sum-copy' + (isAg ? ' hide' : '') + '" title="复制本月记事">' + IC_COPY + '</button></div>'
        + '<div class="cal-seg" title="在此滚动切换汇总/日程">'
        + '<button type="button" class="cal-seg-b' + (!isAg ? ' on' : '') + '" data-tab="sum">汇总</button>'
        + '<button type="button" class="cal-seg-b' + (isAg ? ' on' : '') + '" data-tab="agenda">日程</button></div>'
        + insightStripHtml()
        + '</div>';
      return '<div class="cal-summary">' + head
        + '<div class="cal-summary-body">' + insightBodyHtml() + (isAg ? buildAgendaHtml() : buildSumBody()) + '</div></div>';
    }

    // ===== 日程 / 洞察（全靠算，不落盘；预测用记录估算，周期/经期天数可手动覆盖并存 period.cyc/len） =====
    function upcomingItems() {
      var out = [], today = new Date(TODAY.y, TODAY.m, TODAY.d);
      (S.recur || []).forEach(function (ev) {
        var oc = null;
        for (var k = 0; k < 3; k++) { var t = occurInYear(ev, TODAY.y + k); if (t && t >= today) { oc = t; break; } }
        if (!oc) return;
        var dd = Math.round((oc - today) / 86400000);
        if (dd >= 0 && dd <= 380) out.push({ ty: ev.ty, name: (ev.name || '').trim() || NOTE_TYPES[ev.ty].name, date: oc, dd: dd, ageTxt: ageText(ev, oc.getFullYear()), lunar: ev.lunar });
      });
      Object.keys(S.notes || {}).forEach(function (kk) {
        var dt; try { dt = dParse(kk); } catch (_) { return; }
        if (isNaN(dt)) return;
        var dd = Math.round((new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()) - today) / 86400000);
        if (dd < 0 || dd > 90) return;
        (S.notes[kk] || []).forEach(function (n) { var t = noteText(n).trim(); if (t) { var pr = noteProg(n); out.push({ ty: noteType(n), name: t, date: dt, dd: dd, done: noteAllDone(n), span: noteSpan(n), prog: pr }); } });
      });
      predStarts().forEach(function (p) { var dd = Math.round((p - today) / 86400000); if (dd >= 0 && dd <= 90) out.push({ ty: 'period', name: '例假（预测）', date: p, dd: dd, pred: true }); });
      out.sort(function (a, b) { return a.dd - b.dd; });
      return out;
    }
    // 洞察一行摘要（下次例假/最近生日纪念日还有几天）。返回置顶「常驻栏」；点开后完整卡片走滚动区(insightBodyHtml)，
    // 不放进 sticky 顶栏——否则顶栏比面板还高会盖住列表、还和内层滚动打架(这是之前展开卡死的根因)。
    function insightBits() {
      var bits = [], today = new Date(TODAY.y, TODAY.m, TODAY.d);
      var ps = predStarts();
      if (pLogs().length && ps.length) {
        var dd = Math.round((ps[0] - today) / 86400000);
        bits.push('<span class="cal-is-b" style="color:' + typeColorOf('period') + '">' + typeIconSvg('period', 13) + '例假 ' + (dd <= 0 ? '预计已开始' : dd + ' 天') + '</span>');
      }
      var rec = upcomingItems().filter(function (it) { return it.ty === 'birth' || it.ty === 'anniv'; });
      if (rec.length) {
        var r = rec[0];
        bits.push('<span class="cal-is-b" style="color:' + NOTE_TYPES[r.ty].color + '">' + typeIconSvg(r.ty, 13) + esc(r.name) + ' ' + (r.dd === 0 ? '今天' : r.dd + ' 天') + '</span>');
      }
      return bits;
    }
    function insightStripHtml() {
      var bits = insightBits();
      if (!bits.length) return '';
      return '<div class="cal-insight">'
        + '<button type="button" class="cal-insight-h' + (insightOpen ? ' open' : '') + '"><span class="cal-is-row">' + bits.join('') + '</span><span class="cal-is-caret">' + IC_CARET + '</span></button>'
        + '</div>';
    }
    function insightBodyHtml() {
      if (!insightOpen || !insightBits().length) return '';
      return '<div class="cal-insight-body">' + insightHtml() + '</div>';
    }
    // 已记录例假清单（洞察卡内）：任意一条都能直接删，不必翻回记录那个月份。
    function periodRecordsHtml() {
      var L = pLogs(); if (!L.length) return '';
      var recs = L.map(function (l, i) { return { i: i, d: dParse(l.s), len: l.len || effLen() }; }).sort(function (a, b) { return b.d - a.d; });
      return '<div class="cal-prec"><div class="cal-prec-h">已记录 ' + recs.length + ' 次</div>'
        + recs.slice(0, 8).map(function (r) {
          var ylab = (r.d.getFullYear() === TODAY.y) ? '' : (r.d.getFullYear() + ' 年 ');
          return '<div class="cal-prec-i"><span class="cal-prec-d">' + ylab + (r.d.getMonth() + 1) + ' 月 ' + r.d.getDate() + ' 日</span>'
            + '<span class="cal-prec-len">约 ' + r.len + ' 天</span>'
            + '<button type="button" class="cal-ev-del cal-prec-del" data-i="' + r.i + '" title="删除这次记录">' + IC_TRASH + '</button></div>';
        }).join('') + '</div>';
    }
    // 生日/纪念日清单（洞察卡内）：任意一条都能直接删，不必翻回它所在的日期。
    function recurRecordsHtml() {
      var evs = (S.recur || []).map(function (ev, i) { return { i: i, ev: ev }; })
        .filter(function (x) { return x.ev && (x.ev.ty === 'birth' || x.ev.ty === 'anniv'); });
      if (!evs.length) return '';
      return '<div class="cal-prec"><div class="cal-prec-h">已记录 ' + evs.length + ' 个</div>'
        + evs.map(function (x) {
          var ev = x.ev, nm = (ev.name || '').trim() || NOTE_TYPES[ev.ty].name;
          return '<div class="cal-prec-i"><span class="cal-tic" style="color:' + NOTE_TYPES[ev.ty].color + '">' + typeIconSvg(ev.ty, 13) + '</span>'
            + '<span class="cal-prec-d">' + esc(nm) + '</span>'
            + '<span class="cal-prec-len">' + (ev.lunar ? '农历 ' : '') + ev.m + ' 月 ' + ev.d + ' 日</span>'
            + '<button type="button" class="cal-ev-del cal-recrec-del" data-i="' + x.i + '" title="删除">' + IC_TRASH + '</button></div>';
        }).join('') + '</div>';
    }
    function insightHtml() {
      var h = '';
      var ps = predStarts();
      if (pLogs().length && ps.length) {
        var today = new Date(TODAY.y, TODAY.m, TODAY.d);
        var next = ps[0], dd = Math.round((next - today) / 86400000);
        var ov = dAdd(next, -14), ovdd = Math.round((ov - today) / 86400000);
        h += '<div class="cal-icard"><div class="cal-ic-bar" style="background:' + typeColorOf('period') + '"></div>'
          + '<div class="cal-ic-top"><span class="cal-tic" style="color:' + typeColorOf('period') + '">' + typeIconSvg('period', 17) + '</span>下次例假</div>'
          + '<div class="cal-ic-main">' + (dd <= 0 ? '预计已开始' : '还有 ' + dd + ' 天') + '</div>'
          + '<div class="cal-ic-sub">预计 ' + (next.getMonth() + 1) + ' 月 ' + next.getDate() + ' 日 · 平均周期 ' + effCyc() + ' 天 · 例假约 ' + effLen() + ' 天</div>'
          + (ovuOn() && ovdd >= 0 ? '<div class="cal-ic-sub" style="color:' + typeColorOf('anniv') + '" title="' + OVU_TIP + '">排卵日约 ' + (ov.getMonth() + 1) + ' 月 ' + ov.getDate() + ' 日（还有 ' + ovdd + ' 天）· 仅供参考</div>' : '')
          + '<div class="cal-setrow"><span class="lb">平均周期</span><div class="cal-stepper"><button type="button" data-k="cyc" data-s="-1">－</button><span class="val">' + effCyc() + '</span><button type="button" data-k="cyc" data-s="1">＋</button></div></div>'
          + '<div class="cal-setrow"><span class="lb">默认天数</span><div class="cal-stepper"><button type="button" data-k="len" data-s="-1">－</button><span class="val">' + effLen() + '</span><button type="button" data-k="len" data-s="1">＋</button></div></div>'
          + '<div class="cal-setrow"><span class="lb" title="' + OVU_TIP + '">排卵日预测 <span class="cal-help">?</span></span><button type="button" class="cal-ptoggle' + (ovuOn() ? ' on' : '') + '" data-k="ovu" role="switch" aria-checked="' + (ovuOn() ? 'true' : 'false') + '"><span class="dot"></span></button></div>'
          + '<div class="cal-set-note">默认天数按记录自动估算，越记越准；每次例假也可单独改长度。</div>'
          + periodRecordsHtml() + '</div>';
      }
      var rec = upcomingItems().filter(function (it) { return it.ty === 'birth' || it.ty === 'anniv'; });
      if (rec.length) {
        var top = rec[0], t = NOTE_TYPES[top.ty];
        h += '<div class="cal-icard"><div class="cal-ic-bar" style="background:' + t.color + '"></div>'
          + '<div class="cal-ic-top"><span class="cal-tic" style="color:' + t.color + '">' + typeIconSvg(top.ty, 17) + '</span>最近' + t.name + '</div>'
          + '<div class="cal-ic-main">' + (top.dd === 0 ? '就是今天' : '还有 ' + top.dd + ' 天') + '</div>'
          + '<div class="cal-ic-sub">' + esc(top.name) + ' · ' + (top.date.getMonth() + 1) + ' 月 ' + top.date.getDate() + ' 日'
          + (top.ageTxt ? ' · ' + top.ageTxt : '') + '</div>'
          + '<div class="cal-mini-list">' + rec.slice(1, 4).map(function (r) {
            return '<div class="cal-mli"><span class="cal-tic" style="color:' + NOTE_TYPES[r.ty].color + '">' + typeIconSvg(r.ty, 14) + '</span><span class="nm">' + esc(r.name) + '</span><span class="rt">' + (r.dd === 0 ? '今天' : r.dd + '天') + '</span></div>';
          }).join('') + '</div>' + recurRecordsHtml() + '</div>';
      }
      return h;
    }
    function buildAgendaHtml() {
      var items = upcomingItems();
      function grp(dd) { if (dd === 0) return '今天'; if (dd <= 7) return '本周'; if (dd <= 31) return '本月内'; return '后续'; }
      var order = ['今天', '本周', '本月内', '后续'], groups = {};
      items.forEach(function (it) { (groups[grp(it.dd)] = groups[grp(it.dd)] || []).push(it); });
      var h = '';
      order.forEach(function (g) {
        if (!groups[g]) return;
        h += '<div class="cal-ag-group"><div class="cal-ag-h">' + g + '</div>';
        groups[g].forEach(function (it) {
          var t = NOTE_TYPES[it.ty], col = t.color || '#3fae6b';
          var meta = (it.date.getMonth() + 1) + ' 月 ' + it.date.getDate() + ' 日';
          if (it.prog) meta += ' · 完成 ' + it.prog.done + '/' + it.prog.total + ' 天';
          else if (it.span > 1) meta += ' · 共 ' + it.span + ' 天';
          if (it.ageTxt) meta += ' · ' + it.ageTxt;
          if (it.pred) meta += ' · 预测';
          h += '<div class="cal-ag-item" data-go="' + it.date.getFullYear() + '-' + (it.date.getMonth() + 1) + '-' + it.date.getDate() + '">'
            + '<div class="cal-ai-icn" style="background:' + col + '">' + typeIconSvg(it.ty, 15) + '</div>'
            + '<div class="cal-ai-t"><div class="cal-ai-name' + (it.done ? ' done' : '') + '">' + esc(it.name) + '</div><div class="cal-ai-meta">' + meta + '</div></div>'
            + '<div class="cal-ai-rt"><div class="cal-ai-days">' + (it.dd === 0 ? '今天' : it.dd + '天') + '</div><div class="cal-ai-date">' + t.name + '</div></div></div>';
        });
        h += '</div>';
      });
      return (h || '<div class="cal-sum-empty">近期暂无安排<br>点日历某天加一个</div>');
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
    // 切换汇总/日程：重画正文并加一次性淡入过渡（切换时不再花眼）。
    function switchTab(tab) {
      if (panelTab === tab) return;
      panelTab = tab;
      renderSumOnly();
      var body = dom.querySelector('.cal-summary-body');
      if (body) body.classList.add('cal-fade');
    }
    function buildSummaryText() {
      var lines = ['汇总事项 ' + ymLabel()];
      var days = monthDays();
      if (!days.length) { lines.push('本月暂无记事'); }
      else days.forEach(function (it) {
        lines.push(it.d + ' 日：' + it.arr.map(function (n) { var pr = noteProg(n); return noteText(n).trim() + (noteAllDone(n) ? '（已完成）' : (pr ? '（' + pr.done + '/' + pr.total + '）' : '')); }).join('；'));
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
      // 保住滚动位置：下面把 height 清空的一瞬间容器不可滚、scrollTop 归零——
      // 聚焦记事会触发 refreshCalOnly→本函数，列表若被弹回顶部，正在编辑的那条就跑出视野
      var st = sumEl.scrollTop || 0;
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
      if (st) sumEl.scrollTop = st;
    }

    // 只构建日历卡内部（头部 + 网格）HTML；外层 .calendar-block 由 render/refreshCalOnly 提供。
    function buildCalInner() {
      var startSun = !S.opts.startMon;
      var head = startSun ? WK_SUN : WK_MON;
      var rows = matrix(S.y, S.m, startSun);
      var h = '<div class="cal-head">'
        + '<span class="cal-title" title="点击选择年月 · 在此滚轮切换月份">' + S.y + ' 年 ' + (S.m + 1) + ' 月 <span class="cal-caret">▾</span></span>'
        + '<span class="cal-nav">'
        + '<button class="cal-navm cal-navm-prev" type="button" title="上个月" aria-label="上个月">' + IC_CHEVL + '</button>'
        + '<button class="cal-today" type="button" title="回到今天">今天</button>'
        + '<button class="cal-navm cal-navm-next" type="button" title="下个月" aria-label="下个月">' + IC_CHEVR + '</button>'
        + '</span>'
        + '<button class="cal-setbtn" title="显示设置">' + IC_SET + '</button>'
        + '<button class="cal-compactbtn' + (S.opts.compact ? ' on' : '') + '" type="button" title="精简记事">' + IC_COMPACT + '</button>'
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
      // 做法B：先算好全月排道，再按周渲染。横条带紧跟日期行(高度固定)、位于农历/胶囊之上，保证同周各格横条对齐。
      var laneOf = computeLanes();
      var MAX_LANES = 3;   // 精简模式一格最多 3 道横条，多出并入「+N」
      rows.forEach(function (row) {
        var weekMax = -1;
        row.forEach(function (d) { if (d) barsOn(d).forEach(function (b) { var L = laneOf[b.key + '#' + b.i]; if (L > weekMax) weekMax = L; }); });
        var laneCount = weekMax < 0 ? 0 : (S.opts.compact ? Math.min(weekMax + 1, MAX_LANES) : weekMax + 1);
        row.forEach(function (d, ci) {
          if (!d) { h += '<div class="cal-day cal-pad"></div>'; return; }
          var cls = ['cal-day'];
          if (wendCol(ci)) cls.push('wend');
          // 编辑汇总某条时，把「今日高亮」临时借给正在编辑的那天（此时今日格不高亮）；否则正常高亮今日。
          if (editHlDay != null) { if (d === editHlDay) cls.push('today'); }
          else if (S.opts.today && isToday(d)) cls.push('today');
          var pst = periodState(new Date(S.y, S.m, d));
          if (pst) cls.push('cal-p-' + pst);
          var sub = cellSub(d);
          var subHtml = sub ? '<div class="cal-sub cal-sub-' + sub.cls + '">' + esc(sub.text) + '</div>' : '';
          var barsHtml = barbandHtml(d, ci, laneOf, laneCount);
          var hiddenBars = S.opts.compact ? barsOn(d).filter(function (b) { return laneOf[b.key + '#' + b.i] >= laneCount; }).length : 0;
          var chipsHtml = dayChipsHtml(d, S.opts.compact, hiddenBars);
          h += '<div class="' + cls.join(' ') + '" data-d="' + d + '"><div class="cal-drow"><span class="cal-dnum">' + d + '</span><span class="cal-addhint">＋</span></div>' + barsHtml + subHtml + chipsHtml + '</div>';
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
      var navPrev = head.querySelector('.cal-navm-prev'); if (navPrev) navPrev.addEventListener('click', function (e) { e.stopPropagation(); stepMonth(-1); });
      var navNext = head.querySelector('.cal-navm-next'); if (navNext) navNext.addEventListener('click', function (e) { e.stopPropagation(); stepMonth(1); });
      var compactbtn = head.querySelector('.cal-compactbtn');
      if (compactbtn) compactbtn.addEventListener('click', function (e) { e.stopPropagation(); S.opts.compact = !S.opts.compact; saveDefOpts(S.opts); commit(); });
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
      sp.querySelectorAll('.cal-optrow[data-k]').forEach(function (r) {
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
        el.addEventListener('click', function () { hideTip(); openDay(+el.dataset.d); });
        el.addEventListener('mouseenter', function () { showTip(+el.dataset.d, el); });
        el.addEventListener('mouseleave', hideTip);
      });
      // 横条：点这天的横条段 = 这天打勾/取消（不触发打开日期卡）
      dom.querySelectorAll('.cal-bar[data-key]').forEach(function (bar) {
        bar.addEventListener('click', function (e) {
          e.stopPropagation(); hideTip();
          var k = bar.dataset.key, ci = +bar.dataset.i, off = +bar.dataset.off, a = S.notes[k] || [];
          if (a[ci] === undefined) return;
          a[ci] = makeNote(noteText(a[ci]), noteType(a[ci]), false, rawColor(a[ci]), noteSpan(a[ci]), toggleOffset(noteDoneList(a[ci]), off));
          commit();
        });
      });
      // 单天胶囊：点它 = 打勾/取消（与横条一致，不触发打开日期卡）
      dom.querySelectorAll('.cal-chip[data-key]').forEach(function (chip) {
        chip.addEventListener('click', function (e) {
          e.stopPropagation(); hideTip();
          var k = chip.dataset.key, i = +chip.dataset.i, a = S.notes[k] || [];
          if (a[i] === undefined) return;
          a[i] = makeNote(noteText(a[i]), noteType(a[i]), !noteDone(a[i]), rawColor(a[i]), 1, null);
          commit();
        });
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
      // 汇总/日程切换（点按钮）+ 切换淡入过渡
      sumEl.querySelectorAll('.cal-seg-b').forEach(function (b) {
        b.addEventListener('click', function (e) { e.stopPropagation(); switchTab(b.dataset.tab); });
      });
      // 「洞察」摘要条：点开/收起完整卡片
      var isb = sumEl.querySelector('.cal-insight-h');
      if (isb) isb.addEventListener('click', function (e) { e.stopPropagation(); insightOpen = !insightOpen; renderSumOnly(); });
      // 已记录例假清单：任意一条直接删（不用翻回那个月份）
      sumEl.querySelectorAll('.cal-prec-del').forEach(function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var i = +b.dataset.i;
          if (S.period && S.period.logs && S.period.logs[i] != null) { S.period.logs.splice(i, 1); if (!S.period.logs.length) S.period = null; }
          commit(); renderSumOnly();
        });
      });
      // 生日/纪念日清单：任意一条直接删
      sumEl.querySelectorAll('.cal-recrec-del').forEach(function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var i = +b.dataset.i;
          if (S.recur && S.recur[i] != null) S.recur.splice(i, 1);
          commit(); renderSumOnly();
        });
      });
      // 排卵日预测开关（放洞察卡内，不打扰不需要的人）
      var ptg = sumEl.querySelector('.cal-ptoggle[data-k="ovu"]');
      if (ptg) ptg.addEventListener('click', function (e) {
        e.stopPropagation();
        S.period = S.period || { logs: [] };
        S.period.ovu = !ovuOn();
        commit(); renderSumOnly(); refreshCalOnly();
      });
      // 日程·洞察：周期/经期天数步进（写入 period.cyc/len，随笔记同步）
      sumEl.querySelectorAll('.cal-stepper button').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var k = b.dataset.k, s = +b.dataset.s;
          S.period = S.period || { logs: [] };
          if (k === 'cyc') { var v = Math.max(20, Math.min(45, effCyc() + s)); S.period.cyc = v; }
          else { var w = Math.max(2, Math.min(10, effLen() + s)); S.period.len = w; }
          commit(); renderSumOnly();
        });
      });
      // 日程项：点一下跳到那天并打开日期卡
      sumEl.querySelectorAll('.cal-ag-item').forEach(function (it) {
        it.addEventListener('click', function () {
          var p = String(it.dataset.go).split('-'); if (p.length < 3) return;
          var yy = +p[0], mm = +p[1] - 1, dd = +p[2];
          if (yy === S.y && mm === S.m) { openDay(dd); return; }
          S.y = yy; S.m = mm; commit(); setTimeout(function () { openDay(dd); }, 0);
        });
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
          a[i] = makeNote(inp.value, noteType(a[i]), noteDone(a[i]), rawColor(a[i]), noteSpan(a[i]), noteDoneList(a[i]));
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
          // 汇总里跨天记事：整条一键完成/取消；单天照旧。
          if (noteSpan(a[i]) > 1) {
            var full = noteAllDone(a[i]);
            var nd = full ? [] : allOffsets(noteSpan(a[i]));
            a[i] = makeNote(noteText(a[i]), noteType(a[i]), false, rawColor(a[i]), noteSpan(a[i]), nd);
          } else {
            a[i] = makeNote(noteText(a[i]), noteType(a[i]), !noteDone(a[i]), rawColor(a[i]), 1, null);
          }
          var u = a.filter(function (n) { return !noteAllDone(n); }), dn = a.filter(function (n) { return noteAllDone(n); });
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

      // 类型标记：开/收类型选择器（只重画汇总）；选类型后落盘并整体重画（换类型即换色）。
      sumEl.querySelectorAll('.cal-note-ty').forEach(function (sw) {
        sw.addEventListener('mousedown', function (e) { e.preventDefault(); });
        sw.addEventListener('click', function () {
          var kk = sw.dataset.d + '-' + sw.dataset.i;
          openSumColorKey = (openSumColorKey === kk ? null : kk);
          renderSumOnly();
        });
      });
      // 行内「持续天数」：± 微调 + 直接输入
      var setSumSpan = function (sc, sp) {
        var d = +sc.dataset.d, i = +sc.dataset.i, a = S.notes[noteKey(d)] || [];
        if (a[i] === undefined) return;
        sp = Math.max(1, Math.min(60, sp || noteSpan(a[i])));
        if (sp === noteSpan(a[i])) { renderSumOnly(); return; }
        a[i] = makeNote(noteText(a[i]), noteType(a[i]), noteDone(a[i]), rawColor(a[i]), sp, noteDoneList(a[i]));
        commit(); renderSumOnly();
      };
      sumEl.querySelectorAll('.cal-sum-i .cal-note-sp .cal-note-spb').forEach(function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () {
          var sc = b.closest('.cal-note-sp'), d = +sc.dataset.d, i = +sc.dataset.i;
          setSumSpan(sc, spvOf(sc, noteSpan((S.notes[noteKey(d)] || [])[i] || 0)) + (+b.dataset.sp));
        });
      });
      sumEl.querySelectorAll('.cal-sum-i .cal-note-sp .cal-note-spv').forEach(function (inp) {
        inp.addEventListener('focus', function () { try { inp.select(); } catch (_) {} });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
        inp.addEventListener('change', function () { setSumSpan(inp.closest('.cal-note-sp'), parseInt(inp.value, 10)); });
      });
      sumEl.querySelectorAll('.cal-typepick .cal-type-choice').forEach(function (dot) {
        dot.addEventListener('mousedown', function (e) { e.preventDefault(); });
        dot.addEventListener('click', function () {
          var pal = dot.closest('.cal-typepick'), d = +pal.dataset.d, i = +pal.dataset.i, a = S.notes[noteKey(d)] || [];
          if (a[i] !== undefined) a[i] = makeNote(noteText(a[i]), dot.dataset.ty || 'person', noteDone(a[i]), rawColor(a[i]), noteSpan(a[i]), noteDoneList(a[i]));
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
        // 点输入框以外任意处即收起并落定：面板内很多元素 mousedown 都 preventDefault(保焦点)，
        // 不会触发上面的 blur，所以补一个全局捕获监听，点到别处就提交。
        var outside = function (e) {
          if (editDateDay == null) { document.removeEventListener('mousedown', outside, true); return; }
          if (e.target === dedit || (e.target.closest && e.target.closest('.cal-sum-dedit'))) return;
          document.removeEventListener('mousedown', outside, true);
          commitDate();
        };
        setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);
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
          sumAddTy = 'person'; sumAddSpan = 1;
          sumAddOpen = true; renderSumOnly();
          var t = dom.querySelector('.cal-sum-add-t'); if (t) { try { t.focus({ preventScroll: true }); } catch (_) { t.focus(); } }
          // 添加行在最底部：滚到底确保新输入框可见（覆盖 renderSumOnly 还原的旧滚动位置）
          var se = dom.querySelector('.cal-summary'); if (se) se.scrollTop = se.scrollHeight;
        });
      } else if (add) {
        var dInp = add.querySelector('.cal-sum-add-d'), tInp = add.querySelector('.cal-sum-add-t');
        autoGrow(tInp);
        var dropAddOutside = function () { if (_addOutside) { document.removeEventListener('pointerdown', _addOutside, true); _addOutside = null; } };
        var addDone = false;   // 落定/取消只允许发生一次，杜绝回车+失焦/多次触发重复生成
        var commitAdd = function () {
          if (addDone) return; addDone = true;
          dropAddOutside();
          var day = parseInt(dInp.value, 10), txt = (tInp.value || '').trim();
          if (!txt) { sumAddOpen = false; renderSumOnly(); return; }
          if (!(day >= 1 && day <= dim(S.y, S.m))) day = (TODAY.y === S.y && TODAY.m === S.m ? TODAY.d : 1);
          var key = noteKey(day); (S.notes[key] = S.notes[key] || []).push(makeNote(txt, sumAddTy, false, null, sumAddSpan, null));
          sumAddOpen = false; commit();
        };
        var cancelAdd = function () { if (addDone) return; addDone = true; dropAddOutside(); sumAddOpen = false; renderSumOnly(); };
        // 添加行：类型选择
        add.querySelectorAll('.cal-add-ty').forEach(function (b) {
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () {
            sumAddTy = b.dataset.ty || 'person';
            add.querySelectorAll('.cal-add-ty').forEach(function (x) { x.classList.toggle('on', x === b); });
          });
        });
        // 添加行：持续天数 ± + 直接输入（改 sumAddSpan，不重绘以免丢失正在输入的文本）
        var addSpvEl = add.querySelector('.cal-add-sp .cal-note-spv');
        var syncAddSpv = function () { if (addSpvEl) addSpvEl.value = sumAddSpan; };
        add.querySelectorAll('.cal-add-sp .cal-note-spb').forEach(function (b) {
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () {
            var cur = addSpvEl ? (parseInt(addSpvEl.value, 10) || sumAddSpan) : sumAddSpan;
            sumAddSpan = Math.max(1, Math.min(60, cur + (+b.dataset.sp)));
            syncAddSpv();
          });
        });
        if (addSpvEl) {
          addSpvEl.addEventListener('focus', function () { try { addSpvEl.select(); } catch (_) {} });
          addSpvEl.addEventListener('input', function () { var v = parseInt(addSpvEl.value, 10); if (v >= 1 && v <= 60) sumAddSpan = v; });
          addSpvEl.addEventListener('blur', function () { sumAddSpan = Math.max(1, Math.min(60, parseInt(addSpvEl.value, 10) || 1)); syncAddSpv(); });
        }
        tInp.addEventListener('input', function () { autoGrow(tInp); });
        tInp.addEventListener('keydown', function (e) {
          // 回车＝换行（记事可多行，与日/汇总里编辑记事一致）；点此框以外任意处即落定保存。
          if (e.key === 'Escape') { e.preventDefault(); cancelAdd(); }
        });
        dInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tInp.focus(); } });
        // 点添加行以外任意处 → 落定并收起（替代"失焦即收起"：触屏上焦点站不稳会误触发导致闪退）
        dropAddOutside();
        _addOutside = function (e) { if (e.target.closest && e.target.closest('.cal-sum-add')) return; commitAdd(); };
        setTimeout(function () { if (_addOutside && sumAddOpen) document.addEventListener('pointerdown', _addOutside, true); }, 0);
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

      // 类型/天数弹层：点弹层以外任意处即收起
      if (_sumPopOutside) { document.removeEventListener('mousedown', _sumPopOutside, true); _sumPopOutside = null; }
      if (openSumColorKey != null) {
        _sumPopOutside = function (e) {
          if (e.target.closest && (e.target.closest('.cal-typepick') || e.target.closest('.cal-note-ty') || e.target.closest('.cal-note-sp'))) return;
          openSumColorKey = null; renderSumOnly();
        };
        setTimeout(function () { if (_sumPopOutside) document.addEventListener('mousedown', _sumPopOutside, true); }, 0);
      }
    }

    // 汇总长按拖动：排序 / 跨天移动 / 拖到「新日期投放区」。落点提示线复用侧栏视觉(drag-above/drag-below)。
    function summaryDragStart(e, row) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('.del') || e.target.closest('.cal-note-ty') || e.target.closest('.cal-note-ck') || e.target.closest('.cal-type-choice') || e.target.closest('.cal-note-sp')) return;
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

    // 清掉某天的空记事（空条目本就不入库，但内存里若残留会让卡片多出空行）。静默处理，不触发提交/重画。
    function purgeEmpty(d) {
      var k = noteKey(d), a = S.notes[k];
      if (!a) return;
      var b = a.filter(function (n) { return noteText(n).trim(); });
      if (b.length === a.length) return;
      if (b.length) S.notes[k] = b; else delete S.notes[k];
    }
    // 日期卡片改为「居中弹层」（仿 demo）：遮罩 + 卡片，点遮罩/关闭按钮/Esc 关闭。
    function ensureCard() {
      if (card) return;
      cardMask = document.createElement('div');
      cardMask.className = 'cal-daycard-mask hidden';
      card = document.createElement('div');
      card.className = 'cal-daycard';
      cardMask.appendChild(card);
      document.body.appendChild(cardMask);
      cardMask.addEventListener('mousedown', function (ev) { if (ev.target === cardMask) closeCard(); });
      document.addEventListener('keydown', cardEsc, true);
      // 触屏/iOS：输入框获得焦点时滚到可见位置，避免被软键盘遮挡（仅触屏；桌面 scrollIntoView 会滚外层容器造成跳动）
      card.addEventListener('focusin', function (ev) {
        if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
        var t = ev.target; if (!t || !t.matches || !t.matches('input,textarea')) return;
        setTimeout(function () { try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }, 60);
      });
    }
    function cardEsc(e) { if (e.key === 'Escape' && cardMask && !cardMask.classList.contains('hidden')) { e.preventDefault(); closeCard(); } }
    function closeCard() { if (!cardMask) return; flushSoftCommit(); purgeEmpty(cardDay); cardMask.classList.add('hidden'); commit(); }
    function openDay(d) {
      cardDay = d;
      openColorIdx = -1;
      hideTip();
      ensureCard();
      purgeEmpty(d);
      // 触屏：关掉可能残留的软键盘（打开日期卡本身不需要输入）
      if (document.activeElement && document.activeElement.blur) { try { document.activeElement.blur(); } catch (_) {} }
      cardMask.classList.remove('hidden');
      drawCard();
      // 触屏：防"点开瞬间手指落点穿透到卡片输入框"误聚焦弹键盘——短暂禁用卡片内交互，只想看不想打字时不弹键盘
      if (IS_TOUCH && card) { card.style.pointerEvents = 'none'; setTimeout(function () { if (card) card.style.pointerEvents = ''; }, 350); }
    }

    // 日期卡片「重复事件」区的交互：改名/切农历/起始年/删除/新增。改结构即 commit(重画月格)+drawCard。
    function bindRecur(d) {
      var sec = card.querySelector('.cal-recur-sec');
      if (!sec) return;
      sec.querySelectorAll('.cal-recur-name').forEach(function (inp) {
        inp.addEventListener('input', function () {
          var g = +inp.dataset.g; if (!S.recur[g]) return;
          S.recur[g].name = inp.value; scheduleSoftCommit();
        });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); inp.blur(); } });
        inp.addEventListener('blur', function () { flushSoftCommit(); });
      });
      sec.querySelectorAll('.cal-recur-y0').forEach(function (inp) {
        inp.addEventListener('input', function () {
          var g = +inp.dataset.g; if (!S.recur[g]) return;
          var y0 = parseInt(inp.value, 10);
          if (y0 >= 1000 && y0 <= 9999) S.recur[g].y0 = y0; else delete S.recur[g].y0;
          scheduleSoftCommit();
        });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); inp.blur(); } });
        inp.addEventListener('blur', function () { flushSoftCommit(); drawCard(); });
      });
      sec.querySelectorAll('.cal-recur-lunar').forEach(function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () {
          var g = +b.dataset.g, ev = S.recur[g]; if (!ev) return;
          if (!ev.lunar) { var lu = solar2lunar(S.y, S.m + 1, d); if (lu.ok && !lu.isLeap) { ev.lunar = true; ev.m = lu.month; ev.d = lu.day; } }
          else { var oc = occurInYear(ev, S.y); if (oc) { ev.lunar = false; ev.m = oc.getMonth() + 1; ev.d = oc.getDate(); } }
          commit(); drawCard();
        });
      });
      sec.querySelectorAll('.cal-recur-del').forEach(function (x) {
        x.addEventListener('mousedown', function (e) { e.preventDefault(); });
        x.addEventListener('click', function () {
          var g = +x.dataset.g; if (g >= 0 && g < S.recur.length) S.recur.splice(g, 1);
          commit(); drawCard();
        });
      });
    }

    function drawCard(focusIdx) {
      var d = cardDay;
      var info = dayInfo(S.y, S.m, d);
      var wd = new Date(S.y, S.m, d).getDay();
      var lunLine = '';
      if (info.lunar.ok) {
        lunLine = '农历' + info.lunarMonth + info.lunarDay;
        if (S.opts.almanac) lunLine = info.ganzhi + '年·' + info.zodiac + '年 · ' + info.lunarMonth + info.lunarDay;
        if (info.term) lunLine += ' · ' + info.term;
        var fe = info.solarFest || info.lunarFest;
        if (fe) lunLine += ' · ' + fe;
      }
      var key = noteKey(d);
      var arr = S.notes[key] || [];
      var rows = '';
      if (arr.length) {
        rows = arr.map(function (n, i) {
          var t = noteText(n), ty = noteType(n);
          var di = ' data-i="' + i + '"';
          var tyc = typeCtrlHtml(di);
          var pal = (openColorIdx === i) ? typePickerHtml(ty, di) : '';
          var sp = noteSpan(n);
          var dn = (sp > 1) ? dayDone(n, 0) : noteDone(n);   // 起点那天 = offset 0
          var spc = spanCtrlHtml(n, di);
          var ck = noteBoxHtml(n, di, sp > 1 ? dn : null);
          return '<div class="cal-note-row' + (dn ? ' done' : '') + '" data-i="' + i + '">' + ck + '<textarea class="cal-edit" rows="1" data-i="' + i + '" placeholder="写点什么…">' + esc(t) + '</textarea>' + progHtml(n) + spc + tyc + '<span class="del" data-i="' + i + '" title="删除">' + IC_TRASH + '</span></div>' + pal;
        }).join('');
      }
      var conts = spanInto(new Date(S.y, S.m, d));
      var contRows = conts.map(function (x) {
        var col = chipColor(noteType(x.n), x.n), off = x.day - 1, done = dayDone(x.n, off);
        var sm = x.start.getMonth() + 1, sd = x.start.getDate();
        return '<div class="cal-cont-row" data-key="' + x.key + '" data-i="' + x.i + '" data-sm="' + sm + '" data-sd="' + sd + '" title="点击去 ' + sm + ' 月 ' + sd + ' 日（可编辑）">'
          + '<span class="cal-note-ck cal-cont-ck' + (done ? ' on' : '') + '" data-key="' + x.key + '" data-i="' + x.i + '" data-off="' + off + '" style="background:' + col + '" title="这天完成/取消">' + (done ? IC_CHECK : typeIconSvg(noteType(x.n), 12)) + '</span>'
          + '<span class="cal-cont-t' + (done ? ' done' : '') + '">' + esc(noteText(x.n).trim()) + '</span>'
          + '<span class="cal-cont-day">第 ' + x.day + '/' + x.sp + ' 天</span>'
          + '<span class="del cal-cont-del" title="删除整条">' + IC_TRASH + '</span></div>';
      }).join('');
      var emptyHint = (!arr.length && !conts.length && !recurOn(d).length && !periodStatusHtml(d))
        ? '<div class="cal-dc-empty">这天还没有安排</div>' : '';
      card.innerHTML = '<div class="cal-dc-h">'
        + '<div class="cal-dc-d">' + (S.m + 1) + ' 月 ' + d + ' 日 · 周' + nStr1[wd] + '</div>'
        + (lunLine ? '<div class="cal-dc-l">' + lunLine + '</div>' : '')
        + '<button type="button" class="cal-dc-x" title="关闭">' + IC_X + '</button>'
        + '</div>'
        + '<div class="cal-dc-b">'
        + periodStatusHtml(d)
        + recurEventsHtml(d)
        + (contRows ? '<div class="cal-contlist">' + contRows + '</div>' : '')
        + (arr.length ? '<div class="cal-notelist">' + rows + '</div>' : '')
        + emptyHint
        + '</div>'
        + footerGridHtml(d);
      bindRecur(d);
      bindPeriod(d);
      bindFooterGrid(d);
      var xb = card.querySelector('.cal-dc-x');
      if (xb) { xb.addEventListener('mousedown', function (e) { e.preventDefault(); }); xb.addEventListener('click', closeCard); }

      // 记事可直接编辑：多行、自动增高；Enter 换行，点别处/Esc 收尾并落盘；空的失焦自动删除。
      function autoGrow(el) { el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px'; }
      card.querySelectorAll('.cal-edit').forEach(function (inp) {
        autoGrow(inp);
        inp.addEventListener('input', function () {
          var i = +inp.dataset.i;
          var a = S.notes[key] || [];
          a[i] = makeNote(inp.value, noteType(a[i]), noteDone(a[i]), rawColor(a[i]), noteSpan(a[i]), noteDoneList(a[i]));
          autoGrow(inp);
          scheduleSoftCommit();
        });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); inp.blur(); } });
        inp.addEventListener('blur', function () {
          // 由重绘(改类型/勾选等)导致的失焦：此时输入框已被移出 DOM，不能当成"真失焦"去删空记事，
          // 否则会把刚点开类型选择器的那条空记事顺手删掉 → 看起来"点了没反应"。
          if (!inp.isConnected) return;
          var i = +inp.dataset.i;
          var a = S.notes[key] || [];
          if (a[i] !== undefined && !noteText(a[i]).trim()) { a.splice(i, 1); if (!a.length) delete S.notes[key]; commit(); drawCard(); }
          else { flushSoftCommit(); }
        });
      });
      // 删除、颜色开关、选色：用 mousedown/preventDefault，避免抢走输入框焦点导致重排错乱。
      // 只选记事列表内的 .del（重复事件/经期各有自己的删除键，别用宽泛 .del 误删第 0 条记事）。
      card.querySelectorAll('.cal-notelist .del').forEach(function (x) {
        x.addEventListener('mousedown', function (e) { e.preventDefault(); });
        x.addEventListener('click', function () {
          var a = S.notes[key] || [];
          a.splice(+x.dataset.i, 1);
          if (!a.length) delete S.notes[key];
          openColorIdx = -1;
          commit(); drawCard();
        });
      });
      card.querySelectorAll('.cal-note-ty').forEach(function (sw) {
        sw.addEventListener('mousedown', function (e) { e.preventDefault(); });
        sw.addEventListener('click', function () {
          var i = +sw.dataset.i;
          openColorIdx = (openColorIdx === i ? -1 : i);
          drawCard();
        });
      });
      // 行内「持续天数」：± 微调 + 直接输入。起点那天设，覆盖到的后续天自动只读延续显示。
      var setSpanDay = function (i, sp) {
        var a = S.notes[key] || [];
        if (a[i] === undefined) return;
        sp = Math.max(1, Math.min(60, sp || noteSpan(a[i])));
        if (sp === noteSpan(a[i])) { drawCard(); return; }
        a[i] = makeNote(noteText(a[i]), noteType(a[i]), noteDone(a[i]), rawColor(a[i]), sp, noteDoneList(a[i]));
        commit(); drawCard();
      };
      card.querySelectorAll('.cal-notelist .cal-note-sp .cal-note-spb').forEach(function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () {
          var sc = b.closest('.cal-note-sp'), i = +sc.dataset.i;
          setSpanDay(i, spvOf(sc, noteSpan((S.notes[key] || [])[i] || 0)) + (+b.dataset.sp));
        });
      });
      card.querySelectorAll('.cal-notelist .cal-note-sp .cal-note-spv').forEach(function (inp) {
        inp.addEventListener('focus', function () { try { inp.select(); } catch (_) {} });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
        inp.addEventListener('change', function () { setSpanDay(+inp.closest('.cal-note-sp').dataset.i, parseInt(inp.value, 10)); });
      });
      // 延续行的「这天完成」勾选框（跨天按天累计进度）
      card.querySelectorAll('.cal-cont-ck').forEach(function (ck) {
        ck.addEventListener('mousedown', function (e) { e.preventDefault(); });
        ck.addEventListener('click', function (e) {
          e.stopPropagation();
          var ckKey = ck.dataset.key, ci = +ck.dataset.i, off = +ck.dataset.off, a = S.notes[ckKey] || [];
          if (a[ci] === undefined) return;
          a[ci] = makeNote(noteText(a[ci]), noteType(a[ci]), false, rawColor(a[ci]), noteSpan(a[ci]), toggleOffset(noteDoneList(a[ci]), off));
          commit(); drawCard();
        });
      });
      // 勾选框：切换完成，已完成沉底（稳定分区，保留各自相对顺序）。仅记事列表内，别误连延续行。
      card.querySelectorAll('.cal-notelist .cal-note-ck').forEach(function (ck) {
        ck.addEventListener('mousedown', function (e) { e.preventDefault(); });
        ck.addEventListener('click', function () {
          var i = +ck.dataset.i;
          var a = S.notes[key] || [];
          if (a[i] === undefined) return;
          // 起点那天 = offset 0：跨天按天勾这天，单天照旧切完成。
          if (noteSpan(a[i]) > 1) {
            a[i] = makeNote(noteText(a[i]), noteType(a[i]), false, rawColor(a[i]), noteSpan(a[i]), toggleOffset(noteDoneList(a[i]), 0));
          } else {
            a[i] = makeNote(noteText(a[i]), noteType(a[i]), !noteDone(a[i]), rawColor(a[i]), 1, null);
          }
          var u = a.filter(function (n) { return !noteAllDone(n); });
          var dn2 = a.filter(function (n) { return noteAllDone(n); });
          S.notes[key] = u.concat(dn2);
          openColorIdx = -1;
          commit(); drawCard();
        });
      });
      card.querySelectorAll('.cal-typepick .cal-type-choice').forEach(function (dot) {
        dot.addEventListener('mousedown', function (e) { e.preventDefault(); });
        dot.addEventListener('click', function () {
          var i = +dot.closest('.cal-typepick').dataset.i;
          var a = S.notes[key] || [];
          a[i] = makeNote(noteText(a[i]), dot.dataset.ty || 'person', noteDone(a[i]), rawColor(a[i]), noteSpan(a[i]), noteDoneList(a[i]));
          openColorIdx = -1;
          commit(); drawCard();
        });
      });
      // 延续行：点整行跳到起点那天（可编辑）；垃圾桶删整条记事。
      card.querySelectorAll('.cal-cont-del').forEach(function (x) {
        x.addEventListener('mousedown', function (e) { e.preventDefault(); });
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          var row = x.closest('.cal-cont-row'), ck = row.dataset.key, ci = +row.dataset.i;
          var a = S.notes[ck] || [];
          if (a[ci] !== undefined) { a.splice(ci, 1); if (!a.length) delete S.notes[ck]; }
          commit(); drawCard();
        });
      });
      card.querySelectorAll('.cal-cont-row').forEach(function (row) {
        row.addEventListener('click', function () {
          var sm = +row.dataset.sm - 1, sd = +row.dataset.sd, ck = row.dataset.key;
          var sy = +String(ck).split('-')[0];
          if (sy === S.y && sm === S.m) { openDay(sd); return; }
          S.y = sy; S.m = sm; commit(); setTimeout(function () { openDay(sd); }, 0);
        });
      });

      // 长按拖动排序：按住记事约 300ms 进入拖动；快速点/拖不触发（不影响点选文字与编辑）。
      card.querySelectorAll('.cal-note-row').forEach(function (row) {
        row.addEventListener('pointerdown', function (e) {
          if (e.button !== undefined && e.button !== 0) return;
          if (e.target.closest('.del') || e.target.closest('.cal-note-ty') || e.target.closest('.cal-note-ck') || e.target.closest('.cal-type-choice') || e.target.closest('.cal-note-sp')) return;
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
      // 类型/天数弹层：点弹层以外任意处即收起（先撤旧监听再挂新，避免重绘泄漏）
      if (_cardPopOutside) { document.removeEventListener('mousedown', _cardPopOutside, true); _cardPopOutside = null; }
      if (openColorIdx >= 0) {
        _cardPopOutside = function (e) {
          if (e.target.closest && (e.target.closest('.cal-typepick') || e.target.closest('.cal-note-ty') || e.target.closest('.cal-note-sp'))) return;
          openColorIdx = -1; drawCard();
        };
        setTimeout(function () { if (_cardPopOutside) document.addEventListener('mousedown', _cardPopOutside, true); }, 0);
      }
    }

    // 滚轮切月：仅当鼠标悬在「年月文字」上（日历 .cal-title / 汇总 .cal-summary-ym）滚动才切月——
    // 其余任何位置（按钮、正文、记事、页面）都不拦截，滚轮照常滚动页面。节流：一次滚动一个月。
    // 切月统一入口（滚轮 / 箭头 / 触屏滑动共用）：跨年回卷后重绘。
    function stepMonth(delta) {
      S.m += delta;
      if (S.m < 0) { S.m = 11; S.y--; }
      if (S.m > 11) { S.m = 0; S.y++; }
      commit();
    }
    function onWheel(e) {
      // Ctrl/⌘ + 滚轮留给「日历字体缩放」（app.js 全局处理），这里不切月。
      if (e.ctrlKey || e.metaKey) return;
      if (!e.target.closest) return;
      // 在「切换条」上滚动 → 切换汇总/日程（限定这一小条），不切月。
      if (e.target.closest('.cal-seg')) {
        e.preventDefault(); e.stopPropagation();
        var ts = Date.now(); if (ts - wheelLock < 220) return; wheelLock = ts;
        switchTab(e.deltaY > 0 ? 'agenda' : 'sum');
        return;
      }
      // 仅在「年月文字」上滚动 → 切月，其余处（含头部按钮/正文/记事）一律正常滚动。
      if (!(
        e.target.closest('.cal-title') ||
        e.target.closest('.cal-summary-ym')
      )) return;
      e.preventDefault(); e.stopPropagation();
      var t = Date.now();
      if (t - wheelLock < 200) return;
      wheelLock = t;
      stepMonth(e.deltaY > 0 ? 1 : -1);
    }
    dom.addEventListener('wheel', onWheel, { passive: false });

    // 触屏：在月格网格上左右滑动切月（左滑=下月、右滑=上月）。仅横向为主的快滑才算，
    // 不影响上下滚动、点日期、长按拖动排序；切月后吞掉紧随的一次点击，避免误开日期卡。
    if (IS_TOUCH) {
      var swX = 0, swY = 0, swT = 0, swActive = false, swSwallow = false;
      dom.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1 || !e.target.closest || !e.target.closest('.cal-gridwrap')) { swActive = false; return; }
        swActive = true; swX = e.touches[0].clientX; swY = e.touches[0].clientY; swT = Date.now();
      }, { passive: true });
      dom.addEventListener('touchend', function (e) {
        if (!swActive) return; swActive = false;
        var tch = e.changedTouches && e.changedTouches[0]; if (!tch) return;
        var dx = tch.clientX - swX, dy = tch.clientY - swY;
        if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.6 && (Date.now() - swT) < 600) {
          swSwallow = true; setTimeout(function () { swSwallow = false; }, 500);
          stepMonth(dx < 0 ? 1 : -1);
        }
      }, { passive: true });
      dom.addEventListener('click', function (e) {
        if (swSwallow && e.target.closest && e.target.closest('.cal-gridwrap')) { swSwallow = false; e.preventDefault(); e.stopPropagation(); }
      }, true);
    }

    // 右键菜单指令（由 app.js 的编辑器右键菜单派发到日历外壳，动作留在日历内实现）。
    dom.addEventListener('zhinote:cal-cmd', function (ev) {
      var cmd = ev.detail && ev.detail.cmd; if (!cmd) return;
      if (cmd === 'today') { S.y = TODAY.y; S.m = TODAY.m; commit(); }
      else if (cmd === 'goto') {
        var gy = ev.detail.y, gm = ev.detail.m;
        if (typeof gy === 'number' && typeof gm === 'number') { S.y = gy; S.m = gm; render(); }
      }
      else if (cmd === 'compact') { S.opts.compact = !S.opts.compact; saveDefOpts(S.opts); commit(); }
      else if (cmd === 'copyText') { try { navigator.clipboard.writeText(buildSummaryText()); } catch (_) {} }
      else if (cmd === 'copySource') { try { navigator.clipboard.writeText('```calendar\n' + canon(toObj(S)) + '\n```'); } catch (_) {} }
    });
    // 触屏/iOS：汇总/日程里输入框获得焦点时滚到可见位置，避免被软键盘遮挡（挂在常驻容器上、只挂一次）。
    // 必须仅触屏生效：scrollIntoView 会连外层 overflow:hidden 容器一起滚，桌面端点记事时
    // 造成滚轮跳动、甚至整窗内容被顶上去且不复原（用户实测踩过）
    dom.addEventListener('focusin', function (ev) {
      if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
      var t = ev.target; if (!t || !t.matches || !t.matches('.cal-summary input, .cal-summary textarea')) return;
      setTimeout(function () { try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }, 60);
    });

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
        try { document.removeEventListener('keydown', cardEsc, true); } catch (_) {}
        if (cardMask) {
          try { cardMask.remove(); } catch (_) {}
          cardMask = null; card = null;
        }
      },
    };
  }

  function listAgenda(dataStr) {
    var S = parse(dataStr);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var out = [];
    (S.recur || []).forEach(function (ev) {
      var oc = null;
      for (var k = 0; k < 3; k++) {
        var t = occurInYear(ev, today.getFullYear() + k);
        if (t && t >= today) { oc = t; break; }
      }
      if (!oc) return;
      var dd = Math.round((oc - today) / 86400000);
      if (dd >= 0 && dd <= 380) {
        out.push({
          ty: ev.ty,
          name: (ev.name || '').trim() || NOTE_TYPES[ev.ty].name,
          date: oc,
          dd: dd
        });
      }
    });
    Object.keys(S.notes || {}).forEach(function (kk) {
      var dt;
      try { dt = dParse(kk); } catch (_) { return; }
      if (isNaN(dt)) return;
      var day = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      var dd = Math.round((day - today) / 86400000);
      if (dd < 0 || dd > 180) return;
      (S.notes[kk] || []).forEach(function (n) {
        var t = noteText(n).trim();
        if (!t) return;
        out.push({ ty: noteType(n), name: t, date: day, dd: dd, done: noteAllDone(n) });
      });
    });
    out.sort(function (a, b) { return a.dd - b.dd; });
    return out;
  }

  var api = { mount: mount, defaultData: defaultData, canon: canon, dayInfo: dayInfo, listAgenda: listAgenda, typeIconSvg: typeIconSvg, typeColorOf: typeColorOf, NOTE_TYPES: NOTE_TYPES, _pendingAutoOpen: false, _pendingGoto: null };
  window.ZhiCalendar = api;
})();
