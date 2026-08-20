/**
 * wsdoc.js —— 工作区「结构底稿」工具箱（方案2 第1步：可复用引擎，先不接线）
 *
 * 把一个工作区的「结构 + 每篇笔记的元数据」维护成一份 Yjs 账本，两端可自动合并：
 *   - 正文(doc/ydoc)仍由 ydoc.js 按篇维护（子文档）；本模块只管「父账本」=结构层。
 *   - 颗粒度：字段级自动合并（A 改颜色、B 改标题并发 → 两者都保留；同字段并发由 Yjs 确定性裁决）。
 *
 * 通用集合模型（父 Y.Doc 顶层）：
 *   notes      : Y.Map  id -> Y.Map{ title,pinnedAt,color,icon,parentId,workspaceId,order,expanded,createdAt,updatedAt, deleted,deletedAt }
 *                ——「回收站」不另设集合：笔记始终在这一个集合里，靠 deleted 开关区分在不在回收站。
 *                  删到回收站 = deleted:true（可反复来回，还原天然无副作用）；
 *                  彻底清空/永久删除 = 打 tombstone（永不复活）。
 *   workspaces : Y.Map  id -> Y.Map{ name,icon,order }
 *   templates  : Y.Map  id -> Y.Map{ name,content,order }
 *   settings   : Y.Map  key -> value（可同步的设置子集）
 *   tombstones : Y.Map  "coll:id" -> ts（永久删除墓碑：清空回收站/删笔记本/删模板）
 *
 * 关键约定（同 ydoc.js）：
 *   - 首次创建用固定 clientID=0「确定化创世」——同一份结构在各端独立建出的账本逐字节相同（同根），
 *     之后各端改动用各自作者号叠加，无需中心协调即可正确合并、不重复。
 *   - 纯函数 + 懒解析 window.__crdtBundle；未就绪抛清晰错误，绝不静默改数据。
 *   - order 用数值字段（沿用现有语义），插入取中点；并发同位由 id 兜底，LWW 由 Yjs 裁决。
 */
(function () {
  'use strict';

  const COLLS = ['notes', 'workspaces', 'templates'];

  function bundle() {
    const cb = window.__crdtBundle;
    if (!cb || !cb.Y) throw new Error('wsdoc: __crdtBundle 未就绪');
    return cb;
  }

  function bytesToB64(u8) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    return btoa(s);
  }
  function b64ToBytes(b64) {
    // 容错：剥掉 base64 里可能混入的换行/空白（同 ydoc.js，防 atob 抛错拖垮整轮同步）
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /** 把一条记录对象的字段写进/更新进一个 Y.Map（只在不同的字段上写，减少冗余 op）。 */
  function _applyRecord(Y, ymap, rec) {
    for (const k in rec) {
      if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
      const v = rec[k] === undefined ? null : rec[k];
      if (ymap.get(k) !== v) ymap.set(k, v);
    }
  }

  /** 把一张集合表（id->记录）协调进父文档的某个顶层 Y.Map。 */
  function _applyColl(Y, doc, name, table, tomb, revive) {
    let coll = doc.getMap(name);
    const tmap = doc.getMap('tombstones');
    for (const id in table) {
      if (!Object.prototype.hasOwnProperty.call(table, id)) continue;
      const tombKey = '' + name + ':' + id;
      if (revive && revive[tombKey]) {
        if (tmap.has(tombKey)) tmap.delete(tombKey);
      } else {
        if (tomb && tomb[tombKey]) continue; // 本次叠入自带墓碑 → 不复活
        if (tmap.get(tombKey) != null) continue; // 账本里已有墓碑（云端已删）→ 闲设备旧目录不得叠回去
      }
      let rec = coll.get(id);
      if (!(rec instanceof Y.Map)) { rec = new Y.Map(); coll.set(id, rec); }
      _applyRecord(Y, rec, table[id]);
    }
  }

  /** 写入/更新父文档（用现有的 yd），把整份 structure 协调进去。tombstone 的记录从集合删除。 */
  function _ingest(Y, doc, structure) {
    const s = structure || {};
    const tomb = s.tombstones || {};
    const revive = s.revive || {};
    doc.transact(function () {
      // 墓碑：先记墓碑、再从对应集合删除其记录
      const tmap = doc.getMap('tombstones');
      for (const key in tomb) {
        if (!Object.prototype.hasOwnProperty.call(tomb, key)) continue;
        if (revive[key]) continue; // 用户增量拉回：不得再写下删除
        if (tmap.get(key) == null) tmap.set(key, tomb[key]);
        const i = key.indexOf(':');
        if (i > 0) {
          const coll = key.slice(0, i), id = key.slice(i + 1);
          if (COLLS.indexOf(coll) >= 0) { const c = doc.getMap(coll); if (c.has(id)) c.delete(id); }
        }
      }
      for (const key in revive) {
        if (!Object.prototype.hasOwnProperty.call(revive, key)) continue;
        if (tmap.has(key)) tmap.delete(key);
      }
      // 笔记：活跃 + 回收站 合并进同一个 notes 集合，用 deleted 开关区分
      //   （活跃强制 deleted:false/deletedAt:null；回收站强制 deleted:true。其余元数据字段原样保留，
      //     不在回收站记录里出现的字段不清空 → 还原后完整恢复。）
      const noteTable = {};
      const an = s.notes || {};
      for (const id in an) { if (Object.prototype.hasOwnProperty.call(an, id)) noteTable[id] = Object.assign({}, an[id], { deleted: false, deletedAt: null }); }
      const tn = s.trash || {};
      for (const id in tn) { if (Object.prototype.hasOwnProperty.call(tn, id)) noteTable[id] = Object.assign({}, tn[id], { deleted: true }); }
      _applyColl(Y, doc, 'notes', noteTable, tomb, revive);
      _applyColl(Y, doc, 'workspaces', s.workspaces || {}, tomb, revive);
      _applyColl(Y, doc, 'templates', s.templates || {}, tomb, revive);
      // settings：扁平 key->value
      const set = doc.getMap('settings');
      const ss = s.settings || {};
      for (const k in ss) {
        if (!Object.prototype.hasOwnProperty.call(ss, k)) continue;
        const v = ss[k] === undefined ? null : ss[k];
        if (set.get(k) !== v) set.set(k, v);
      }
    });
  }

  /** 由 structure 全新构建「确定化创世账本」→ base64。仅首次建账本用（固定 clientID=0）。 */
  function build(structure) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    yd.clientID = 0;
    _ingest(cb.Y, yd, structure);
    const out = cb.Y.encodeStateAsUpdate(yd);
    if (yd.destroy) yd.destroy();
    return bytesToB64(out);
  }

  /** 把当前 structure 叠加进已有父账本 → 新 base64。结构变更后调用。 */
  function update(b64, structure) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(b64));
    _ingest(cb.Y, yd, structure);
    const out = cb.Y.encodeStateAsUpdate(yd);
    if (yd.destroy) yd.destroy();
    return bytesToB64(out);
  }

  /** 合并两份父账本 → 融合后的 base64。CRDT 保证无重复、确定性。 */
  function merge(b64a, b64b) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(b64a));
    cb.Y.applyUpdate(yd, b64ToBytes(b64b));
    const out = cb.Y.encodeStateAsUpdate(yd);
    if (yd.destroy) yd.destroy();
    return bytesToB64(out);
  }

  function _readColl(doc, name, tmap) {
    const out = {};
    const coll = doc.getMap(name);
    coll.forEach(function (rec, id) {
      if (tmap.get(name + ':' + id) != null) return;     // 墓碑过滤
      out[id] = (rec && rec.toJSON) ? rec.toJSON() : {};
    });
    return out;
  }

  /** 父账本 → structure 对象（合并/落地后回写本地结构用）。墓碑已过滤。 */
  function toData(b64) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(b64));
    const tmap = yd.getMap('tombstones');
    // 单一 notes 集合 → 按 deleted 开关拆回 notes(活跃) / trash(回收站)
    const allNotes = _readColl(yd, 'notes', tmap);
    const notes = {}, trash = {};
    for (const id in allNotes) {
      if (!Object.prototype.hasOwnProperty.call(allNotes, id)) continue;
      const r = allNotes[id] || {};
      if (r.deleted) { delete r.deleted; trash[id] = r; }
      else { delete r.deleted; delete r.deletedAt; notes[id] = r; }
    }
    const data = {
      notes: notes,
      workspaces: _readColl(yd, 'workspaces', tmap),
      templates: _readColl(yd, 'templates', tmap),
      trash: trash,
      settings: yd.getMap('settings').toJSON(),
      tombstones: tmap.toJSON(),
    };
    if (yd.destroy) yd.destroy();
    return data;
  }

  /** 引擎是否可用（__crdtBundle 就绪）。结构层不依赖编辑器 schema。 */
  function ready() {
    try { bundle(); return true; } catch (e) { return false; }
  }

  /** 账本当前进度针（很小）。增量相对「上次整本」算，针不能跟着小段走。 */
  function stateVector(b64) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(b64));
    const out = cb.Y.encodeStateVector(yd);
    if (yd.destroy) yd.destroy();
    return bytesToB64(out);
  }

  /** 从进度针到当前账本的一小段。对端先套整本再套这一段。 */
  function diffFromSV(currentB64, svB64) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(currentB64));
    const out = cb.Y.encodeStateAsUpdate(yd, b64ToBytes(svB64));
    if (yd.destroy) yd.destroy();
    return bytesToB64(out);
  }

  window.__wsdoc = { ready, build, update, merge, toData, bytesToB64, b64ToBytes, stateVector, diffFromSV };
})();
