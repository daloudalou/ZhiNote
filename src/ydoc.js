/**
 * ydoc.js —— 合并账本工具箱（CRDT 大改 阶段1：可复用引擎，暂不接线）
 *
 * 把 crdt.bundle.js（Yjs + y-prosemirror）封装成几个高层函数，供 storage.js / webdav-sync.js
 * 在后续阶段调用：把一篇笔记的 doc(JSON) 维护成一份 Yjs「账本」，两端账本可自动合并。
 *
 * 关键约定（已在 build/verify-migration.js 实测）：
 *   - updateYFragment 的 meta 必须是 { mapping:Map, isOMark:Map }；缺 isOMark 处理带格式文字会报错。
 *   - 两端要正确合并，必须基于「同一份」账本（build 一次后各端 applyUpdate 叠加），不能各自 build。
 *     故账本的「首次创建」由同步层在加锁下完成（阶段2），本模块只提供纯函数，不决定何时建。
 *
 * 全部为纯函数 + 懒解析 window.__crdtBundle / 编辑器 schema，未就绪时抛清晰错误，绝不静默改数据。
 */
(function () {
  'use strict';

  function bundle() {
    const cb = window.__crdtBundle;
    if (!cb || !cb.Y) throw new Error('ydoc: __crdtBundle 未就绪');
    return cb;
  }

  function defaultSchema() {
    const ed = window.editor && window.editor.instance && window.editor.instance();
    if (!ed || !ed.schema) throw new Error('ydoc: 编辑器 schema 未就绪');
    return ed.schema;
  }

  // Uint8Array ⇄ base64（分块避免大数组爆栈）
  function bytesToB64(u8) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    // 容错：有些网盘/代理会给 base64 掺进换行或空白，先剥掉再解（否则 atob 直接抛错、整轮同步失败）
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  const META = () => ({ mapping: new Map(), isOMark: new Map() });

  /** 由 doc(ProseMirror JSON) 全新构建「确定化创世账本」→ base64。仅在「首次建账本」时用。
   *  关键：固定 clientID=0 建创世——同一篇 doc 在任何设备各自独立建出的账本**逐字节相同**（同根），
   *  之后各端的修改用各自（随机）作者号叠加，故无需中心协调即可正确合并、不重复（已实测增删改并发）。
   *  注意：不要用 cb.prosemirrorJSONToYDoc（它内部 new Y.Doc() 用随机 clientID → 创世不确定 → 合并会重复）。 */
  function build(doc, schema) {
    const cb = bundle();
    const sc = schema || defaultSchema();
    const yd = new cb.Y.Doc();
    yd.clientID = 0;
    const frag = yd.getXmlFragment('prosemirror');
    yd.transact(function () {
      cb.updateYFragment(yd, frag, sc.nodeFromJSON(doc), META());
    });
    const out = cb.Y.encodeStateAsUpdate(yd);
    if (yd.destroy) yd.destroy();
    return bytesToB64(out);
  }

  /** 把本次 doc 叠加进已有账本（自动算最小增量）→ 新 base64。保存正文后调用。 */
  function update(b64, doc, schema) {
    const cb = bundle();
    const sc = schema || defaultSchema();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(b64));
    const frag = yd.getXmlFragment('prosemirror');
    yd.transact(function () {
      cb.updateYFragment(yd, frag, sc.nodeFromJSON(doc), META());
    });
    const out = cb.Y.encodeStateAsUpdate(yd);
    if (yd.destroy) yd.destroy();
    return bytesToB64(out);
  }

  /** 合并两份账本（同步时双向叠加）→ 融合后的 base64。CRDT 保证无重复、无丢失、确定性。 */
  function merge(b64a, b64b) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(b64a));
    cb.Y.applyUpdate(yd, b64ToBytes(b64b));
    const out = cb.Y.encodeStateAsUpdate(yd);
    if (yd.destroy) yd.destroy();
    return bytesToB64(out);
  }

  /** 账本 → doc(ProseMirror JSON)。合并后回写 note.doc 用。 */
  function toDoc(b64, schema) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(b64));
    const json = cb.yDocToProsemirrorJSON(yd, 'prosemirror');
    if (yd.destroy) yd.destroy();
    return json;
  }

  /** 引擎是否可用（__crdtBundle + 编辑器 schema 均就绪）。调用方据此决定走账本还是退回旧路径。 */
  function ready() {
    try { bundle(); defaultSchema(); return true; } catch (e) { return false; }
  }

  // ── 增量直推工具（t19 即时同步 C2）────────────────────────────────────────
  /** 账本(base64) 的状态指纹（state vector → base64）。发送端记住“上次发到哪”用。 */
  function sv(b64) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(b64));
    const v = cb.Y.encodeStateVector(yd);
    if (yd.destroy) yd.destroy();
    return bytesToB64(v);
  }

  /** 相对指纹的最小增量：账本(base64) 里「持有 svB64 指纹的一方还没有的部分」→ 增量(base64)。
   *  svB64 为空 = 全量。增量通常只有几十字节（对比整本账几 KB～几百 KB）。 */
  function diff(b64, svB64) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    cb.Y.applyUpdate(yd, b64ToBytes(b64));
    const u = svB64 ? cb.Y.encodeStateAsUpdate(yd, b64ToBytes(svB64)) : cb.Y.encodeStateAsUpdate(yd);
    if (yd.destroy) yd.destroy();
    return bytesToB64(u);
  }

  /** 合并多份「增量/全量」载荷为一份（Y.mergeUpdates：纯载荷级合并，不需要基线、
   *  不丢“依赖还没到”的部分——与 merge() 不同，merge 走 Doc 会把缺依赖的增量静默丢掉）。 */
  function mergeUpdates(b64list) {
    const cb = bundle();
    const arr = [];
    for (let i = 0; i < b64list.length; i++) if (b64list[i]) arr.push(b64ToBytes(b64list[i]));
    if (!arr.length) return '';
    if (arr.length === 1) return bytesToB64(arr[0]);
    return bytesToB64(cb.Y.mergeUpdates(arr));
  }

  /** 把增量并入账本(base64)：返回 { b64, pending }。
   *  pending=true = 增量引用了本端没见过的历史（中间漏了包）——合并结果**不含**这份增量，
   *  调用方必须向对端索要全量，绝不能把 b64 当完整结果落库。 */
  function applyDiff(baseB64, diffB64) {
    const cb = bundle();
    const yd = new cb.Y.Doc();
    if (baseB64) cb.Y.applyUpdate(yd, b64ToBytes(baseB64));
    cb.Y.applyUpdate(yd, b64ToBytes(diffB64));
    const pending = !!(yd.store && yd.store.pendingStructs);
    const out = bytesToB64(cb.Y.encodeStateAsUpdate(yd));
    if (yd.destroy) yd.destroy();
    return { b64: out, pending };
  }

  window.__ydoc = { ready, build, update, merge, toDoc, bytesToB64, b64ToBytes, sv, diff, mergeUpdates, applyDiff };
})();
