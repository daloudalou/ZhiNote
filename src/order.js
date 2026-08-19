/**
 * order.js —— 「顺序」的唯一权威（从 storage.js 抽出，便于单测 + 收口）
 *
 * 背景（修「笔记从未移动却莫名变序」的根因）：以前顺序有两个来源——网盘 manifest 里的 rootOrder、
 *   和账本里每篇的 frac 位置。`_webdavApplyGlobal` 按「账本引擎这一周期是否就绪」二选一，
 *   就绪用 frac、没就绪用 manifest。两者一旦不一致，顺序就随时机跳来跳去 = 偶发乱序。
 *
 * 收口：顺序**只认 frac**（缺失退 order，最后 id 兜底），是 frac 的确定性纯函数——
 *   与「谁先到、本地历史 rootOrder 是什么」完全无关 → 同一批笔记+frac 在任何设备、任何到达顺序下
 *   都算出同一个顺序，乱序这一类从根上不可能发生。
 *
 * 纯函数：只操作传入的 data，不依赖 storage 内部状态；fractional-indexing 取自 window.__crdtBundle
 *   （call 时读取，不依赖脚本加载先后）。可在 Node 里单测（见 tools/同步自测.mjs）。
 */
(function () {
  'use strict';

  function _fi() {
    const cb = (typeof window !== 'undefined' ? window.__crdtBundle : null);
    return (cb && typeof cb.generateKeyBetween === 'function') ? cb : null;
  }
  const _rootWs = (n) => (n && n.workspaceId) || 'ws-default';

  /** 同级排序比较器：有 frac 优先按 frac；缺失退回 order；最后 id 兜底（全程确定性）。
   *  frac 撞车（两端并发各算出同一值）→ 直接按 id 兜底（id 全局唯一、两端一致），绝不退回会变的 order。 */
  function cmpSib(a, b) {
    const fa = (a && typeof a.frac === 'string') ? a.frac : '';
    const fb = (b && typeof b.frac === 'string') ? b.frac : '';
    if (fa && fb) {
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    if (fa && !fb) return -1;               // 无 frac 排同级末尾（新篇文件曾不带位置；排最前会把新笔记顶到最上并写死）
    if (!fa && fb) return 1;
    const d = (a.order || 0) - (b.order || 0); if (d) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /** 把整库每个同级组缺失的 frac 确定性补齐（迁移/自愈）。返回是否有改动。
   *  排序输入用 cmpSib(frac,order,id) → 两端从同一份已同步的 order/id 各自补出的 frac 逐字节一致 → 收敛。 */
  function backfillFrac(data) {
    const fi = _fi(); if (!fi) return false;
    const d = data; if (!d || !d.notes) return false;
    let changed = false;
    const groups = new Map();
    for (const id in d.notes) {
      const n = d.notes[id]; if (!n) continue;
      const key = (n.parentId == null) ? ('r:' + _rootWs(n)) : ('p:' + n.parentId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    for (const list of groups.values()) {
      list.sort(cmpSib);
      let i = 0;
      while (i < list.length) {
        if (typeof list[i].frac === 'string' && list[i].frac) { i++; continue; }
        let j = i; while (j < list.length && !(typeof list[j].frac === 'string' && list[j].frac)) j++;
        const prev = i > 0 ? list[i - 1].frac : null;
        const next = j < list.length ? list[j].frac : null;
        let keys = null;
        try { keys = fi.generateNKeysBetween(prev || null, next || null, j - i); } catch (_) { keys = null; }
        if (keys) { for (let k = i; k < j; k++) { list[k].frac = keys[k - i]; changed = true; } }
        i = j;
      }
    }
    return changed;
  }

  /** rootOrder 的唯一推导：所有顶级笔记按 (workspaceId, frac, id) 确定性排序，返回 id 数组。
   *  纯 frac 函数 → 与到达顺序/本地历史 rootOrder 无关 → 不可能「莫名变序」。 */
  function deriveRootOrder(data) {
    const notes = (data && data.notes) || {};
    const roots = Object.keys(notes).filter(id => notes[id] && notes[id].parentId == null);
    roots.sort((a, b) => {
      const na = notes[a], nb = notes[b];
      const wa = _rootWs(na), wb = _rootWs(nb);
      if (wa !== wb) return wa < wb ? -1 : 1;
      return cmpSib(na, nb);
    });
    return roots;
  }

  if (typeof window !== 'undefined') window.__order = { cmpSib, backfillFrac, deriveRootOrder };
})();
