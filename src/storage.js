/**
 * storage.js — 笔记数据读写层
 *
 * 数据结构：
 * {
 *   version: 1,
 *   notes: { [id]: NoteNode },       // 扁平字典，树形靠 parentId + order
 *   rootOrder: [id, id, ...],        // 根节点顺序（顶级笔记 id 列表）
 *   trash: { [id]: TrashNode },      // 回收站（保存完整笔记快照）
 *   trashOrder: [id, ...],
 *   settings: { theme, fontSize, sidebarWidth, lastOpenedId, ... },
 *   templates: [{ id, name, content }]
 * }
 *
 * NoteNode: { id, parentId, title, content, color, expanded, order, createdAt, updatedAt }
 */

const QK_VAR_DATA = 'zhinote_data';
const QK_STORAGE_DEV_KEY = 'zhinote_data_dev';
// 阶段B 分片持久化（2026-06-11）：
//   网页端：IDB kv store 内 META_KEY + NOTE_KEY_PREFIX+<id>，单事务原子提交；旧整库 key 保留 30 天作回滚。
//   Quicker 端：主库(QK_VAR_DATA)仍是权威，高频内容编辑只写 journal 分片（小变量），
//               结构/设置变化或 30s 合并定时器才全量写主库——零迁移、可随时回退。
const PS_META_KEY = 'zhinote_meta';
const PS_NOTE_PREFIX = 'zhinote_note_';
const QK_VAR_JOURNAL = 'zhinote_journal';

const DEFAULT_DATA = () => ({
  version: 2,
  notes: {},
  rootOrder: [],
  trash: {},
  trashOrder: [],
  // 笔记本（多分区）：每条笔记的 workspaceId 决定属于哪个本子
  workspaces: [
    { id: 'ws-default', name: '默认笔记本', icon: '📒' },
  ],
  settings: {
    theme: 'light',
    fontSize: 14,
    editorPadding: 1,
    noteTransition: 'none',
    sidebarWidth: 260,
    lastOpenedId: null,
    outlineOpen: false,
    sidebarCollapsed: false,
    showTrashBadge: true,
    activeWorkspace: 'ws-default',
    pinned: [],
    recent: [],
  },
  templates: [
    {
      id: 'tpl-daily',
      name: '每日日记',
      content: '# {{date}}\n\n## 今日要事\n\n- \n\n## 记录\n\n',
    },
    {
      id: 'tpl-meeting',
      name: '会议记录',
      content: '# 会议：{{title}}\n\n- 时间：{{datetime}}\n- 参与人：\n- 地点：\n\n## 议题\n\n\n\n## 结论与待办\n\n- [ ] \n',
    },
  ],
});

const storage = (() => {
  let _data = null;
  let _saveTimer = null;
  let _saveInFlight = false;
  let _pendingSave = false;
  let _listeners = [];

  const isQuicker = () => {
    if (typeof window.$quicker === 'undefined' && typeof window.$quickerSync === 'undefined') return false;
    if (typeof window.chrome === 'undefined' || !window.chrome.webview) return false;
    return true;
  };

  // Quicker 桥接对象解包：$quicker 是 Promise，需要 await 后才能拿到真正的代理
  let _bridgeCache = null;
  async function bridge() {
    if (_bridgeCache) return _bridgeCache;
    _bridgeCache = await window.$quicker;
    return _bridgeCache;
  }

  // ─── IndexedDB 后端（非 Quicker 宿主：浏览器 / PWA）─────────────────────────
  // localStorage 容量上限 ~5MB，真实笔记库（含本地图片仓库）轻易超过 → 网页宿主用 IndexedDB。
  // 旧 localStorage 开发数据首次读取时自动迁移；IndexedDB 不可用（如隐私模式）时退回 localStorage。
  const IDB_NAME = 'zhinote';
  const IDB_STORE = 'kv';
  const IDB_IMG_STORE = 'images'; // 阶段A：图片外置——独立 store，hash → dataUrl，不再混进主 JSON
  let _idbCache = null;
  function idbOpen() {
    if (_idbCache) return Promise.resolve(_idbCache);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        if (!db.objectStoreNames.contains(IDB_IMG_STORE)) db.createObjectStore(IDB_IMG_STORE);
      };
      req.onsuccess = () => { _idbCache = req.result; resolve(_idbCache); };
      req.onerror = () => reject(req.error);
    });
  }
  async function idbImgAll() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const store = db.transaction(IDB_IMG_STORE, 'readonly').objectStore(IDB_IMG_STORE);
      const out = {};
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { out[cur.key] = cur.value; cur.continue(); }
        else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }
  async function idbImgSet(hash, val) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_IMG_STORE, 'readwrite');
      tx.objectStore(IDB_IMG_STORE).put(val, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbImgGet(hash) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const req = db.transaction(IDB_IMG_STORE, 'readonly').objectStore(IDB_IMG_STORE).get(hash);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbImgDel(hash) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_IMG_STORE, 'readwrite');
      tx.objectStore(IDB_IMG_STORE).delete(hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  /** 读出 kv store 里 NOTE 前缀下的全部分片：{ key: val } */
  async function idbGetNoteShards() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const store = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE);
      const range = IDBKeyRange.bound(PS_NOTE_PREFIX, PS_NOTE_PREFIX + '\uffff');
      const out = {};
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { out[cur.key] = cur.value; cur.continue(); }
        else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }
  /** 单事务批量提交（原子）：puts = {key:val}，dels = [key] */
  async function idbBatch(puts, dels) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const st = tx.objectStore(IDB_STORE);
      for (const k in puts) st.put(puts[k], k);
      for (const k of (dels || [])) st.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb tx aborted'));
    });
  }

  function genId() {
    return 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function now() { return Date.now(); }

  /* ─── 阶段B 分片持久化状态 ─── */
  let _psNoteCache = {};       // id -> 上次成功落盘的 note JSON 串（diff 依据，唯一可靠的"哪片脏了"判定）
  let _psMetaCache = '';       // 上次成功落盘的 meta JSON 串
  let _psWebSharded = false;   // 网页端：当前是否走分片存储
  let _qkJournal = {};         // Quicker journal 内存镜像：id -> updatedAt
  let _qkMonoTimer = null;     // Quicker 30s 合并全量落盘定时器
  let _qkConsolidateOnInit = false; // 启动时 journal 非空 → init 末尾全量合并一次

  /** meta = 整库去掉 notes 本体（再附 noteIds 供分片装载/清理）。也用作"结构是否变化"的判定串。 */
  function _psMetaString(data) {
    const meta = {};
    for (const k in data) { if (k !== 'notes') meta[k] = data[k]; }
    meta.noteIds = Object.keys(data.notes || {});
    return JSON.stringify(meta);
  }
  /** 与上次落盘比对：返回变化的 note 分片 / 被删的 note 分片 / meta 是否变化。
   *  diff 法不依赖任何调用方自觉标脏 → 不可能漏写（与旧全量写同等可靠），只是少写。 */
  function _psDiff() {
    const changed = []; // [id, json]
    const removed = [];
    for (const id in _data.notes) {
      const s = JSON.stringify(_data.notes[id]);
      if (_psNoteCache[id] !== s) changed.push([id, s]);
    }
    for (const id in _psNoteCache) { if (!_data.notes[id]) removed.push(id); }
    const metaS = _psMetaString(_data);
    return { changed, removed, metaS, metaChanged: metaS !== _psMetaCache };
  }
  function _psCommitCaches(diff) {
    for (const [id, s] of diff.changed) _psNoteCache[id] = s;
    for (const id of diff.removed) delete _psNoteCache[id];
    _psMetaCache = diff.metaS;
  }
  /** 装载后以当前内存态初始化 diff 基线（之后第一次 flush 只写真正变化的片） */
  function _psSeedCaches() {
    _psNoteCache = {};
    for (const id in _data.notes) _psNoteCache[id] = JSON.stringify(_data.notes[id]);
    _psMetaCache = _psMetaString(_data);
  }

  async function rawLoad() {
    if (isQuicker()) {
      try {
        const v = await bridge();
        const raw = await v.getVar(QK_VAR_DATA);
        let data = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : DEFAULT_DATA();
        // journal 覆盖：上次会话只写了分片还没来得及全量合并（或中途崩溃）→ 把更新的内容找回来。
        // 只覆盖主库里已存在的笔记（不凭 journal 复活已删笔记），且分片 updatedAt 不旧于主库才采用。
        // getVar 对不存在的变量会抛"变量不存在"——首次运行属预期，静默当空处理。
        const getVarSafe = async (name) => { try { return await v.getVar(name); } catch (_) { return ''; } };
        const jraw = await getVarSafe(QK_VAR_JOURNAL);
        if (jraw && typeof jraw === 'string' && jraw.trim()) {
          try {
            const journal = JSON.parse(jraw);
            for (const id of Object.keys(journal || {})) {
              try {
                const sraw = await getVarSafe(PS_NOTE_PREFIX + id);
                if (!sraw || typeof sraw !== 'string') continue;
                const note = JSON.parse(sraw);
                const cur = data.notes && data.notes[note.id];
                if (cur && (note.updatedAt || 0) >= (cur.updatedAt || 0)) data.notes[note.id] = note;
              } catch (e) { console.warn('[storage] journal 分片解析失败，忽略', id, e); }
            }
            _qkJournal = journal || {};
            _qkConsolidateOnInit = true; // init 末尾全量合并进主库并清 journal
          } catch (e) { console.warn('[storage] journal 解析失败，忽略', e); }
        }
        return data;
      } catch (err) {
        console.error('[storage] 读取 Quicker 变量失败', err);
        return DEFAULT_DATA();
      }
    } else {
      // 网页宿主：优先读分片（meta + note 分片）；没有 meta 则读旧整库并就地迁移成分片。
      try {
        const metaRaw = await idbGet(PS_META_KEY);
        if (metaRaw) {
          const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
          const noteIds = new Set(meta.noteIds || []);
          delete meta.noteIds;
          const shards = await idbGetNoteShards();
          const notes = {};
          const orphans = [];
          for (const key in shards) {
            const id = key.slice(PS_NOTE_PREFIX.length);
            if (!noteIds.has(id)) { orphans.push(key); continue; } // meta 是权威：不在清单的分片不装载（防复活）
            try { notes[id] = JSON.parse(shards[key]); } catch (e) { console.error('[storage] note 分片损坏', id, e); }
          }
          if (orphans.length) idbBatch({}, orphans).catch(() => {});
          meta.notes = notes;
          // 旧整库回滚保险已超 30 天 → 清理
          if (meta._monolithKeptAt && Date.now() - meta._monolithKeptAt > 30 * 24 * 3600 * 1000) {
            idbBatch({}, [QK_VAR_DATA]).catch(() => {});
            delete meta._monolithKeptAt;
          }
          _psWebSharded = true;
          return meta;
        }
        // 无 meta：读旧整库（或全新用户）
        const raw = await idbGet(QK_VAR_DATA);
        if (raw) {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          await _psMigrateWeb(data); // 整库 → 分片（单事务原子，旧 key 保留 30 天）
          return data;
        }
      } catch (e) {
        console.warn('[storage] IndexedDB 读取失败，退回 localStorage', e);
      }
      const raw = localStorage.getItem(QK_STORAGE_DEV_KEY);
      return raw ? JSON.parse(raw) : DEFAULT_DATA();
    }
  }

  /** 网页端一次性迁移：整库拆片写入（meta + 全部 note 分片，单事务原子）。
   *  旧整库 key 原样保留 30 天作回滚保险（删 PS_META_KEY 即回到旧读取路径）。 */
  async function _psMigrateWeb(data) {
    try {
      const puts = {};
      for (const id in (data.notes || {})) puts[PS_NOTE_PREFIX + id] = JSON.stringify(data.notes[id]);
      data._monolithKeptAt = Date.now();
      puts[PS_META_KEY] = _psMetaString(data);
      await idbBatch(puts, []);
      const check = await idbGet(PS_META_KEY); // 回读校验
      if (!check) throw new Error('meta 回读为空');
      _psWebSharded = true;
      console.log('[storage] 分片迁移完成：' + Object.keys(data.notes || {}).length + ' 篇（旧整库保留 30 天回滚）');
    } catch (e) {
      _psWebSharded = false; // 迁移失败 → 本次会话沿用整库写，下次启动再试
      console.error('[storage] 分片迁移失败，沿用整库存储', e);
    }
  }

  /** full=true：Quicker 端强制全量写主库并清 journal（结构变化 / 定时合并 / 启动合并 / 页面隐藏时） */
  async function rawSave(data, { full = false } = {}) {
    if (isQuicker()) {
      const v = await bridge();
      const diff = _psDiff();
      const structural = full || diff.metaChanged || diff.removed.length > 0;
      if (structural) {
        await v.setVar(QK_VAR_DATA, JSON.stringify(data));
        // 主库已含全部最新内容 → 先清 journal 清单（防崩溃后用旧分片覆盖/复活），再清残留分片变量
        const jIds = Object.keys(_qkJournal);
        if (jIds.length) {
          await v.setVar(QK_VAR_JOURNAL, '');
          for (const id of jIds) { try { await v.setVar(PS_NOTE_PREFIX + id, ''); } catch (_) {} }
          _qkJournal = {};
        }
        if (_qkMonoTimer) { clearTimeout(_qkMonoTimer); _qkMonoTimer = null; }
      } else if (diff.changed.length) {
        // 纯内容编辑：只写变化分片 + journal 清单（写放大从整库降到单篇）
        for (const [id, s] of diff.changed) {
          await v.setVar(PS_NOTE_PREFIX + id, s);
          _qkJournal[id] = (data.notes[id] && data.notes[id].updatedAt) || Date.now();
        }
        await v.setVar(QK_VAR_JOURNAL, JSON.stringify(_qkJournal));
        // 预约合并：30s 后把分片收进主库（崩溃也有 journal 兜底）
        if (!_qkMonoTimer) {
          _qkMonoTimer = setTimeout(() => { _qkMonoTimer = null; _flush({ full: true }); }, 30000);
        }
      }
      _psCommitCaches(diff);
      return;
    }
    // 网页端
    if (_psWebSharded) {
      const diff = _psDiff();
      if (!diff.changed.length && !diff.removed.length && !diff.metaChanged) return; // 没变化不打盘
      const puts = {};
      for (const [id, s] of diff.changed) puts[PS_NOTE_PREFIX + id] = s;
      if (diff.metaChanged) puts[PS_META_KEY] = diff.metaS;
      await idbBatch(puts, diff.removed.map(id => PS_NOTE_PREFIX + id)); // 单事务 → 原子
      _psCommitCaches(diff);
      return;
    }
    // 网页端整库兜底（分片迁移失败时）
    const json = JSON.stringify(data);
    try {
      await idbSet(QK_VAR_DATA, json);
      return;
    } catch (e) {
      console.warn('[storage] IndexedDB 写入失败，退回 localStorage（容量约 5MB，可能不够）', e);
    }
    localStorage.setItem(QK_STORAGE_DEV_KEY, json);
  }

  async function init() {
    _data = await rawLoad();
    migrate(_data);
    _psSeedCaches(); // 装载后立基线：之后每次 flush 只写真正变化的分片
    // 启动即自愈：把早期同步缺陷导致从 rootOrder 掉出 / 笔记本丢失而"消失"的笔记重新接回并落盘。
    // 这些笔记的数据其实仍在本地 _data.notes（以及云端 notes/*.json）里，只是没挂在可见的顺序上。
    try { if (reconcileStructure()) await save({ immediate: true }); }
    catch (e) { console.warn('[storage] 启动自愈失败', e); }
    // 上次会话留有 journal（崩溃/未及合并）→ 已在 rawLoad 覆盖到内存，这里全量合并进主库并清 journal
    if (_qkConsolidateOnInit) {
      _qkConsolidateOnInit = false;
      try { await _flush({ full: true }); } catch (e) { console.warn('[storage] journal 合并失败，留待下次', e); }
    }
    // Quicker 端页面隐藏时若有未合并 journal → 立即全量合并（窗口"隐藏而非关闭"，这是最后的可靠时机）
    if (isQuicker()) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && (Object.keys(_qkJournal).length || _qkMonoTimer)) {
          _flush({ full: true });
        }
      });
    }
    // 图片后端后台启动（不阻塞首屏）：编辑器先显示占位图，images-ready 后由 NodeView 异步补取归位
    _imgInit();
    return _data;
  }

  function migrate(data) {
    if (!data.version) data.version = 1;
    // 数据格式版本（内容 JSON 化）：旧数据无此字段=1；实际 md→doc 迁移在 migrateNotesToDoc() 做
    // （需编辑器 markdown manager 就绪，故在 bootstrap 编辑器初始化后调用，而非这里）。
    data.dataFormatVersion ??= 1;
    // v2(已 JSON 化) → v3(账本可用)：本构建是「账本感知」客户端，把已 JSON 化的数据声明为 v3。
    // 不批量标脏、不在此建账本（账本随编辑/合并按需懒建）；声明 v3 仅用于版本闸（旧客户端见之暂停）。
    // v1 未 JSON 化的数据保持 1，待 migrateNotesToDoc() 一次性升到 3。
    if (data.dataFormatVersion === 2) data.dataFormatVersion = 3;
    data.notes ??= {};
    data.rootOrder ??= [];
    data.trash ??= {};
    data.trashOrder ??= [];
    data.settings ??= DEFAULT_DATA().settings;
    data.templates ??= [];
    // v3 迁移：本地图片仓库
    //   - 上传时把 base64 → zhinote://img/<hash>，节省带宽
    //   - 本地永久保留 _data.localImages = { <hash>: 'data:image/...;base64,...' }
    //   - 编辑器渲染前把 zhinote://img/<hash> 替换回真实 dataURL，B 端没仓库就显示占位符
    //   - 这样无论同步多少次，本设备的本地图片永不丢失
    data.localImages ??= {};
    data.wsTombstones ??= {}; // 已彻底删除的笔记本墓碑（id → 时间戳），防止同步把删掉的笔记本拉回
    data.tplTombstones ??= {}; // 已删除模板墓碑，防止同步把删掉的模板拉回
    data.noteTombstones ??= {}; // 已永久删除笔记墓碑（id→时间戳）：由真实删除动作显式写入，供结构总账携带；
                                // 取代旧「按总账有/本地无」推断（那分不清"已删"与"正文未同步"，曾误删新建笔记）。
    if (!Array.isArray(data.workspaces) || !data.workspaces.length) {
      data.workspaces = [{ id: 'ws-default', name: '默认笔记本', icon: '📒' }];
    }
    data.settings.activeWorkspace ??= data.workspaces[0].id;
    // 一次性迁移：旧版默认切换动画是「上滑淡入(up)」，现默认改为「无动画」。
    // V2：早期 up 值经云端 settings 合并被反复拉回，noteTransition 现已改为本地独有设置，
    // 这里再强制重置一次仍是 up 的旧值为 none（之后用户可再自由选择 up）。
    if (!data.settings._noteTransResetV2) {
      if (data.settings.noteTransition === 'up') data.settings.noteTransition = 'none';
      data.settings._noteTransResetV2 = true;
    }
    // 历史残留清理：旧版「编辑模式（所见即所得/即时渲染/分屏预览）」三模式早已废弃，
    // editorMode 设置不再有任何读取方；删除该死键，避免它长期残留并误入共享同步。
    delete data.settings.editorMode;
    const needV3Migration = (data.version || 0) < 3;
    for (const id in data.notes) {
      const n = data.notes[id];
      n.expanded ??= false;
      n.color ??= null;
      n.order ??= 0;
      n.content ??= '';
      n.title ??= '无标题';
      n.parentId ??= null;
      n.createdAt ??= now();
      n.updatedAt ??= n.createdAt;
      n.workspaceId ??= 'ws-default';
      n.pinnedAt ??= null;
    }
    // 置顶从 settings.pinned（整份列表、易覆盖丢项）迁到 note.pinnedAt（随笔记同步，对齐以后按篇合并）。
    if (!data.settings._pinnedNoteFieldV1) {
      const oldList = Array.isArray(data.settings.pinned) ? data.settings.pinned : [];
      if (oldList.length) {
        const base = Date.now();
        oldList.forEach((id, i) => {
          const n = data.notes[id];
          if (n && !n.pinnedAt) n.pinnedAt = new Date(base - i * 1000).toISOString();
        });
      }
      data.settings.pinned = [];
      data.settings._pinnedNoteFieldV1 = true;
    }
    if (needV3Migration) {
      // 一次性把所有笔记里已有的 base64 入仓库（不写 _data 引用，因为闭包还没建立）
      // 借用一个本地 inline ingest 把 base64 收进图片仓库
      const repo = data.localImages;
      const ingest = (dataUrl) => {
        let h = 5381;
        for (let i = 0; i < dataUrl.length; i++) h = (h * 33) ^ dataUrl.charCodeAt(i);
        const id2 = (h >>> 0).toString(36) + 'l' + dataUrl.length.toString(36);
        if (!repo[id2]) repo[id2] = dataUrl;
        return `zhinote://img/${id2}`;
      };
      for (const id in data.notes) {
        let c = data.notes[id].content || '';
        c = c.replace(/!\[([^\]]*)\]\((data:image\/[a-z]+;base64,[A-Za-z0-9+\/=]+)(\s+"[^"]*")?\)/gi,
          (_, alt, dataUrl, title) => `![${alt}](${ingest(dataUrl)}${title || ''})`);
        c = c.replace(/<img\b([^>]*?)\bsrc=["'](data:image\/[a-z]+;base64,[A-Za-z0-9+\/=]+)["']([^>]*)>/gi,
          (_, before, dataUrl, after) => `<img${before} src="${ingest(dataUrl)}"${after}>`);
        data.notes[id].content = c;
      }
    }
    // v4 迁移：移除 Quicker 同步，切换到 'none'
    if (data.settings && data.settings.syncMethod === 'quicker') {
      data.settings.syncMethod = 'none';
    }
    data.version = 3;
  }

  /* ========== 本地图片仓库 ==========
     用稳定 hash 给本地 base64 图片建索引，云端只存 zhinote://img/<hash> 引用。
     阶段A（2026-06，图片外置）：内存缓存 _imgCache 是唯一真源，持久化走独立后端：
       - file（Quicker）：<图片目录>/<hash>.<ext> 真实文件，默认 文档\ZhiNote\images，
         可自定义（settings.imagesDir）。依赖 FileOp 新 mode `readFile`；
         探测不到该分支 → 降级 legacy（沿用主 JSON 内嵌），功能不受损只是没有外置收益。
       - idb（网页）：IndexedDB 独立 store 'images'。
       - legacy：_imgCache 直接引用 _data.localImages（同一对象），行为与外置前完全一致。
     收益：主 JSON 不再携带 base64 → 每次保存的序列化/写入量骤降。 */

  let _imgCache = {};        // hash -> dataUrl（启动时从后端载入）
  let _imgBackend = 'legacy'; // 'file' | 'idb' | 'legacy'
  let _imgDir = '';           // file 后端的图片目录
  let _imgReadyResolve;
  const _imgReadyPromise = new Promise((r) => { _imgReadyResolve = r; });
  // primary-ready：仅「上次打开的那篇笔记」的图就绪（启动会自动打开它），比全库 ready 早得多。
  // 启动自动打开等它（而非等全库）→ 图文一起出现、不冒泡，又不被全库预读拖慢。
  let _imgPrimaryReadyResolve;
  const _imgPrimaryReadyPromise = new Promise((r) => { _imgPrimaryReadyResolve = r; });
  const _imgResolvePrimary = () => { if (_imgPrimaryReadyResolve) { _imgPrimaryReadyResolve(); _imgPrimaryReadyResolve = null; } };

  /** 取一篇笔记里引用到的所有外置图 hash（doc 走 JSON 串、旧 md 走文本）。 */
  function _noteImageHashes(note) {
    const set = new Set();
    if (!note) return set;
    try {
      const txt = note.doc ? JSON.stringify(note.doc) : (note.content || '');
      const re = /zhinote:\/\/img\/([a-z0-9]+)/gi; let m;
      while ((m = re.exec(txt)) !== null) set.add(m[1]);
    } catch (_) {}
    return set;
  }

  /** 简单的 djb2 hash，对长 base64 字符串足够稳定且快 */
  function quickHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    // 转成正数 + 36 进制 + 长度后缀，避免短串撞 hash
    return (h >>> 0).toString(36) + 'l' + s.length.toString(36);
  }

  function _imgExtOf(dataUrl) {
    let ext = ((String(dataUrl).match(/^data:image\/([a-z0-9+.-]+);base64,/i) || [])[1] || 'png').toLowerCase();
    if (ext === 'jpeg') ext = 'jpg'; else if (ext === 'svg+xml') ext = 'svg';
    return ext;
  }
  function _imgMimeOf(ext) {
    const e = String(ext || '').toLowerCase();
    if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
    if (e === 'svg') return 'image/svg+xml';
    return 'image/' + (e || 'png');
  }
  async function _imgFileOp(mode, extra) {
    return await window.$quickerSp('FileOp', Object.assign({ mode }, extra || {}));
  }

  /** Quicker file 后端初始化：探测 readFile 分支 → 解析目录 → 载入全部图片到缓存。
   *  返回 false = 动作端尚未添加 readFile 分支，降级 legacy。 */
  async function _imgInitQuicker() {
    let docs = '';
    try {
      const r = await _imgFileOp('readFile', { path: '::documents::', isBinary: 'false' });
      docs = ((r && r.result) || '').toString().trim();
    } catch (_) { return false; }
    if (!/^[a-z]:\\/i.test(docs) || /[\r\n]/.test(docs)) return false; // 不是合法路径 = 分支未配置
    _imgDir = (_data.settings.imagesDir || '').trim() || (docs.replace(/[\\/]+$/, '') + '\\ZhiNote\\images');
    await _imgFileOp('ensureDir', { path: _imgDir });
    // 后端类型 + 目录尽早就绪：这样下面"逐张全量载入"还在跑时，loadImage 已能直接读单张文件，
    // 笔记打开不必等全量读完（解决"每次打开先占位、之后才显示"）。
    _imgBackend = 'file';
    let lines = [];
    try {
      const r = await _imgFileOp('list', { dir: _imgDir, pattern: '*.*' });
      lines = ((r && r.result) || '').toString().split(/\r?\n/).filter(Boolean);
    } catch (_) {}
    const entries = [];
    for (const p of lines) {
      const fname = (p.split(/[\\/]/).pop() || '');
      const m = fname.match(/^([a-z0-9]+l[a-z0-9]+)\.([a-z0-9]+)$/i);
      if (m) entries.push({ hash: m[1], ext: m[2], path: p });
    }
    // 优先：上次打开的那篇笔记的图先读（启动会自动打开它）。其余全库随后分批预读。
    let priSet = new Set();
    try {
      const lastId = (_data.settings && _data.settings.lastOpenedId) || '';
      priSet = _noteImageHashes(lastId && _data.notes ? _data.notes[lastId] : null);
    } catch (_) {}
    const priChunk = entries.filter(e => priSet.has(e.hash));
    const rest = entries.filter(e => !priSet.has(e.hash));
    // 优先批：桥接队列的第一批、单独成批且较小 → 启动那篇笔记尽快备齐，随后放行 primary-ready。
    if (priChunk.length) await _imgPreloadChunk(priChunk);
    _imgResolvePrimary();
    // 其余全库预读：每 40 个一批走 readMany（一趟多张），N 次 readFile 压成几次 readMany。
    // 同步比对/上传依赖「全量内存缓存」，故仍把所有图灌满缓存。
    const PRELOAD_BATCH = 40;
    for (let i = 0; i < rest.length; i += PRELOAD_BATCH) {
      await _imgPreloadChunk(rest.slice(i, i + PRELOAD_BATCH));
    }
    return true;
  }

  /** 预读一批图：先 readMany 一趟批量取，readMany 分支缺失/个别没返回的按已知路径逐张 readFile 兜底。 */
  async function _imgPreloadChunk(chunk) {
    let got = null;
    try {
      const r = await _imgFileOp('readMany', { dir: _imgDir, hashes: chunk.map(e => e.hash).join(',') });
      try { got = JSON.parse(((r && r.result) || '[]').toString() || '[]'); } catch (_) { got = null; }
    } catch (_) { got = null; }
    if (Array.isArray(got)) {
      for (const it of got) {
        if (it && it.hash && it.content) _imgCache[it.hash] = 'data:' + _imgMimeOf(it.ext || 'png') + ';base64,' + it.content;
      }
    }
    for (const e of chunk) {
      if (_imgCache[e.hash]) continue;
      try {
        const rr = await _imgFileOp('readFile', { path: e.path, isBinary: 'true' });
        const b64 = ((rr && rr.result) || '').toString();
        if (b64) _imgCache[e.hash] = 'data:' + _imgMimeOf(e.ext) + ';base64,' + b64;
      } catch (err) { console.warn('[storage] 图片文件读取失败', e.path, err); }
    }
  }

  /** 把一张图写进持久后端（file/idb）。legacy 后端写主 JSON（与外置前行为一致）。 */
  function _imgPersist(hash, dataUrl) {
    if (_imgBackend === 'file') {
      const b64 = String(dataUrl).split(',')[1] || '';
      return _imgFileOp('writeFile', { path: _imgDir + '\\' + hash + '.' + _imgExtOf(dataUrl), content: b64, isBinary: 'true' });
    }
    if (_imgBackend === 'idb') return idbImgSet(hash, dataUrl);
    if (!_data.localImages) _data.localImages = {};
    _data.localImages[hash] = dataUrl;
    save({ immediate: true });
    return Promise.resolve();
  }
  /** 持久化失败兜底：回落主 JSON，保证图片绝不只存在于内存里。 */
  function _imgPersistSafe(hash, dataUrl) {
    Promise.resolve()
      .then(() => _imgPersist(hash, dataUrl))
      .catch((e) => {
        console.error('[storage] 图片持久化失败，回落主库内嵌', hash, e);
        if (!_data.localImages) _data.localImages = {};
        _data.localImages[hash] = dataUrl;
        save({ immediate: true });
      });
  }
  function _imgRemoveBackend(hash, dataUrl) {
    try {
      if (_imgBackend === 'file') {
        _imgFileOp('delete', { path: _imgDir + '\\' + hash + '.' + _imgExtOf(dataUrl) }).catch(() => {});
      } else if (_imgBackend === 'idb') {
        idbImgDel(hash).catch(() => {});
      }
      // legacy：调用方已从 _imgCache（=_data.localImages）删除，save 由调用方负责
    } catch (_) {}
  }

  /** 一次性迁移：主 JSON 里内嵌的图片搬到新后端。全部写成功并验证后才清空主库（绝不先删后写）。 */
  async function _imgMigrate() {
    const legacy = _data.localImages;
    if (!legacy) return;
    const hashes = Object.keys(legacy);
    if (!hashes.length) return;
    let ok = 0;
    for (const h of hashes) {
      try {
        if (!_imgCache[h]) { await _imgPersist(h, legacy[h]); _imgCache[h] = legacy[h]; }
        ok++;
      } catch (e) { console.error('[storage] 图片迁移失败（保留主库原件，下次再试）', h, e); }
    }
    if (ok !== hashes.length) return;
    let verified = true;
    if (_imgBackend === 'file') {
      try {
        const r = await _imgFileOp('list', { dir: _imgDir, pattern: '*.*' });
        const names = new Set(((r && r.result) || '').toString().split(/\r?\n/)
          .map(s => (s.split(/[\\/]/).pop() || '').replace(/\.[^.]+$/, '')).filter(Boolean));
        verified = hashes.every(h => names.has(h));
      } catch (_) { verified = false; }
    }
    if (!verified) { console.warn('[storage] 图片迁移校验未通过，主库原件保留'); return; }
    _data.localImages = {};
    await save({ immediate: true });
    console.log('[storage] 图片外置迁移完成：' + ok + ' 张 → ' + (_imgBackend === 'file' ? _imgDir : 'IndexedDB'));
  }

  /** 图片后端初始化（init 末尾后台启动，不阻塞应用首屏）。 */
  async function _imgInit() {
    try {
      if (isQuicker()) {
        _imgBackend = (await _imgInitQuicker()) ? 'file' : 'legacy';
        if (_imgBackend === 'legacy') console.warn('[storage] FileOp 缺少 readFile 分支，图片沿用主库内嵌（请更新 Quicker 动作以启用图片外置）');
      } else {
        _imgBackend = 'idb'; // 先置位，使 loadImage 在 idbImgAll 全量载入期间也能走单张读取
        _imgCache = await idbImgAll();
      }
    } catch (e) {
      _imgBackend = 'legacy';
      console.warn('[storage] 图片后端初始化失败，沿用主库内嵌', e);
    }
    if (_imgBackend === 'legacy') {
      if (!_data.localImages) _data.localImages = {};
      _imgCache = _data.localImages; // 同一引用：缓存改动即主库改动，save 即持久
    } else {
      try { await _imgMigrate(); } catch (e) { console.error('[storage] 图片迁移异常', e); }
    }
    _imgResolvePrimary(); // file 后端已在 _imgInitQuicker 内提前放行；这里兜底 legacy/idb/异常路径
    _imgReadyResolve();
    emit('images-ready', { backend: _imgBackend, count: Object.keys(_imgCache).length });
  }

  /** 更换图片目录（仅 file 后端）：先全量写入新目录并校验，成功后才切换并清理旧目录。 */
  async function setImagesDir(newDirRaw) {
    if (_imgBackend !== 'file') throw new Error('当前环境不支持自定义图片目录');
    const newDir = String(newDirRaw || '').trim().replace(/[\\/]+$/, '');
    if (!newDir) throw new Error('目录无效');
    if (newDir.toLowerCase() === _imgDir.toLowerCase()) return false;
    await _imgFileOp('ensureDir', { path: newDir });
    const hashes = Object.keys(_imgCache);
    for (const h of hashes) {
      const b64 = String(_imgCache[h]).split(',')[1] || '';
      await _imgFileOp('writeFile', { path: newDir + '\\' + h + '.' + _imgExtOf(_imgCache[h]), content: b64, isBinary: 'true' });
    }
    const r = await _imgFileOp('list', { dir: newDir, pattern: '*.*' });
    const names = new Set(((r && r.result) || '').toString().split(/\r?\n/)
      .map(s => (s.split(/[\\/]/).pop() || '').replace(/\.[^.]+$/, '')).filter(Boolean));
    for (const h of hashes) if (!names.has(h)) throw new Error('迁移校验失败，已保留原目录');
    const oldDir = _imgDir;
    _imgDir = newDir;
    _data.settings.imagesDir = newDir;
    await save({ immediate: true });
    for (const h of hashes) {
      try { await _imgFileOp('delete', { path: oldDir + '\\' + h + '.' + _imgExtOf(_imgCache[h]) }); } catch (_) {}
    }
    return true;
  }

  /** 单张 base64 dataURL 入仓库，返回 zhinote://img/<hash> 引用
   *  供编辑器在用户粘贴/拖入图片时调用，编辑器不直接接触 base64 */
  function ingestImageDataUrl(dataUrl) {
    if (!dataUrl) return dataUrl;
    if (!dataUrl.startsWith('data:')) return dataUrl;
    const h = quickHash(dataUrl);
    if (!_imgCache[h]) {
      _imgCache[h] = dataUrl;
      _imgPersistSafe(h, dataUrl);
    }
    markDirty();
    return `zhinote://img/${h}`;
  }

  /** 把 markdown 里所有 zhinote://img/<hash>(#frag) 替换回 base64（用于导出/复制）
   *  fragment 部分（编辑器自用的 #w248-h121-acenter 元数据）整个去掉 */
  function rehydrateLocalImages(md) {
    if (!md) return md;
    return md.replace(/zhinote:\/\/img\/([a-z0-9]+l[a-z0-9]+)(?:#[\w-]*)?/gi, (full, h) => {
      return _imgCache[h] || full;
    });
  }

  /** 垃圾回收：扫所有笔记内容里引用的 hash，仓库里没被引用的清掉 */
  function gcLocalImages() {
    const referenced = new Set();
    const re = /zhinote:\/\/img\/([a-z0-9]+l[a-z0-9]+)(?:#[\w-]*)?/gi;
    const hashRe = /zhinote:\/\/img\/([a-z0-9]+l[a-z0-9]+)/i;
    for (const id in _data.notes) {
      const note = _data.notes[id];
      if (!note) continue;
      // 并集：同时扫旧 content(md) 与 doc 里的引用，宁可多留也不误删（图片误删不可逆）。
      const c = note.content || '';
      let m; while ((m = re.exec(c))) referenced.add(m[1]);
      if (note.doc && window.editor?.walkDocImages) {
        window.editor.walkDocImages(note.doc, (src) => {
          const mm = hashRe.exec(src || '');
          if (mm) referenced.add(mm[1]);
        });
      }
    }
    let removed = 0;
    for (const h of Object.keys(_imgCache)) {
      if (!referenced.has(h)) {
        const dataUrl = _imgCache[h];
        delete _imgCache[h]; // legacy 后端下 _imgCache 即 _data.localImages，删除随 save 落盘
        _imgRemoveBackend(h, dataUrl);
        removed++;
      }
    }
    return removed;
  }

  /* ========== 笔记本（多分区） ========== */
  function getWorkspaces() { return _data.workspaces.slice(); }
  function getActiveWorkspace() {
    const id = _data.settings.activeWorkspace || _data.workspaces[0].id;
    return _data.workspaces.find(w => w.id === id) || _data.workspaces[0];
  }
  function setActiveWorkspace(id) {
    if (!_data.workspaces.find(w => w.id === id)) return;
    _data.settings.activeWorkspace = id;
    save();
    emit('change', { type: 'workspace' });
  }
  function createWorkspace(name, icon) {
    const ws = { id: 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), name: name || '新笔记本', icon: icon || '📓' };
    _data.workspaces.push(ws);
    save();
    emit('change', { type: 'workspaces' });
    return ws;
  }
  function renameWorkspace(id, newName, newIcon) {
    const ws = _data.workspaces.find(w => w.id === id);
    if (!ws) return;
    if (newName) ws.name = newName;
    if (newIcon) ws.icon = newIcon;
    save();
    emit('change', { type: 'workspaces' });
  }
  function setWorkspaceIcon(id, icon) {
    const ws = _data.workspaces.find(w => w.id === id);
    if (!ws) return;
    ws.icon = icon || '📓';
    save();
    emit('change', { type: 'workspaces' });
  }
  /** 删除笔记本。strategy:
   *  - 'migrate' （默认）：把笔记迁到第一个剩余的本子
   *  - 'trash'  ：把笔记全部送进回收站
   *  - 'purge'  ：彻底删除（不放回收站，无法找回）*/
  function deleteWorkspace(id, strategy = 'migrate') {
    if (_data.workspaces.length <= 1) return false;
    _data.workspaces = _data.workspaces.filter(w => w.id !== id);
    // 记墓碑：让删除经同步生效，避免被云端/其它设备的旧记录拉回
    _data.wsTombstones = _data.wsTombstones || {};
    _data.wsTombstones[id] = Date.now();
    const fallback = _data.workspaces[0].id;
    const affectedIds = Object.keys(_data.notes).filter(nid => _data.notes[nid].workspaceId === id);
    if (strategy === 'migrate') {
      for (const nid of affectedIds) _data.notes[nid].workspaceId = fallback;
    } else if (strategy === 'trash') {
      for (const nid of affectedIds) {
        const n = _data.notes[nid];
        n.deletedAt = new Date().toISOString();
        n.workspaceId = fallback;  // 落回 fallback 以免数据孤悬
        _data.trash[nid] = n;
        _data.trashOrder = _data.trashOrder || [];
        if (!_data.trashOrder.includes(nid)) _data.trashOrder.unshift(nid);
        delete _data.notes[nid];
        _data.rootOrder = (_data.rootOrder || []).filter(x => x !== nid);
      }
    } else if (strategy === 'purge') {
      // 彻底删除：必须给每篇写「删除墓碑」+ 标脏，删除才会经结构总账(即时)与网盘双通道传播。
      //   否则对端只收到"笔记本没了"、收不到"这些笔记也删了" → 对端笔记还在；而本地笔记本一没，
      //   这些无归属笔记又被 reconcile 收编进当前笔记本（"无名笔记本/笔记乱窜"）并回传污染云端（用户报的 #7）。
      _data.noteTombstones = _data.noteTombstones || {};
      for (const nid of affectedIds) {
        delete _data.notes[nid];
        _data.rootOrder = (_data.rootOrder || []).filter(x => x !== nid);
        _data.noteTombstones[nid] = Date.now();
        _dirtyNoteIds.add(nid);
      }
      _globalDirty = true;
    }
    if (_data.settings.activeWorkspace === id) _data.settings.activeWorkspace = fallback;
    save();
    emit('change', { type: 'workspaces' });
    return { ok: true, affectedCount: affectedIds.length };
  }

  function getAll() { return _data; }

  function get(id) {
    // 关键变更：不再 rehydrate base64 给编辑器看
    // 这样编辑器里也只显示几十字符的 zhinote://img/<hash>，
    // 不会再出现几万字符的 base64 源码
    // 编辑器在 DOM 层面用 MutationObserver 把 <img src="zhinote://..."> 实时换成真 base64
    return _data.notes[id] || null;
  }

  /** 这篇笔记是否「真的没了」——已永久删除(有墓碑) 或 已在回收站。
   *  用于区分「真删」与「同步瞬时缺失」：后者(对端刚建/网盘还没下到)绝不能关编辑器翻欢迎页（B+ 止架）。 */
  function isNoteDeleted(id) {
    if (!id || !_data) return false;
    if (_data.noteTombstones && _data.noteTombstones[id]) return true; // 永久删除墓碑
    if (_data.trash && _data.trash[id]) return true;                   // 在回收站
    return false;
  }

  /** 获取单张本地图片的 dataURL（同步，仅命中内存缓存；供 editor 在 DOM 层面 rehydrate img.src 用） */
  function getLocalImage(hash) {
    return _imgCache[hash] || null;
  }

  /** 单张图片懒加载（异步）：缓存没有就直接从后端读这一张并回填缓存。
   *  不等全量载入完成——打开笔记时只读它用到的几张，立刻显示。命中返回 dataURL，否则 null。 */
  async function loadImage(hash) {
    if (!hash) return null;
    if (_imgCache[hash]) return _imgCache[hash];
    try {
      if (_imgBackend === 'file' && _imgDir) {
        let p = '';
        try {
          const r = await _imgFileOp('list', { dir: _imgDir, pattern: hash + '.*' });
          p = (((r && r.result) || '').toString().split(/\r?\n/).filter(Boolean)[0] || '').trim();
        } catch (_) {}
        if (!p) return _imgCache[hash] || null;
        const ext = (p.match(/\.([a-z0-9]+)$/i) || [])[1] || 'png';
        const rr = await _imgFileOp('readFile', { path: p, isBinary: 'true' });
        const b64 = ((rr && rr.result) || '').toString();
        if (b64) { _imgCache[hash] = 'data:' + _imgMimeOf(ext) + ';base64,' + b64; return _imgCache[hash]; }
        return null;
      }
      if (_imgBackend === 'idb') {
        const v = await idbImgGet(hash);
        if (v) { _imgCache[hash] = v; return v; }
        return null;
      }
    } catch (e) { console.warn('[storage] 单张图片懒加载失败', hash, e); }
    return _imgCache[hash] || null; // legacy：缓存即主库
  }

  /** 批量图片加载（异步）：一次桥接把一篇笔记用到的多张图全读回缓存。
   *  - file 后端：调 FileOp 'readMany' 一趟取回所有 base64（Quicker 侧需加该分支）；
   *    分支不存在/缺图时自动逐张 loadImage 兜底——所以即便 Quicker 还没加分支也照常工作。
   *  - idb 后端：并行 idbImgGet。
   *  返回 { hash: dataUrl } 命中表（只含本次新读或已缓存的）。不抛错。 */
  async function loadImages(hashes) {
    const out = {};
    if (!Array.isArray(hashes)) return out;
    const need = [];
    for (const h of hashes) {
      if (!h) continue;
      if (_imgCache[h]) { out[h] = _imgCache[h]; continue; }
      if (need.indexOf(h) === -1) need.push(h);
    }
    if (!need.length) return out;
    try {
      if (_imgBackend === 'file' && _imgDir) {
        try {
          const r = await _imgFileOp('readMany', { dir: _imgDir, hashes: need.join(',') });
          let arr = [];
          try { arr = JSON.parse(((r && r.result) || '[]').toString() || '[]'); } catch (_) { arr = []; }
          if (Array.isArray(arr)) {
            for (const it of arr) {
              if (!it || !it.hash || !it.content) continue;
              const dataUrl = 'data:' + _imgMimeOf(it.ext || 'png') + ';base64,' + it.content;
              _imgCache[it.hash] = dataUrl; out[it.hash] = dataUrl;
            }
          }
        } catch (_) {}
        const still = need.filter(h => !_imgCache[h]); // readMany 未生效/个别缺失 → 逐张兜底
        if (still.length) {
          await Promise.all(still.map(async (h) => { const v = await loadImage(h); if (v) out[h] = v; }));
        }
        return out;
      }
      if (_imgBackend === 'idb') {
        await Promise.all(need.map(async (h) => { const v = await idbImgGet(h); if (v) { _imgCache[h] = v; out[h] = v; } }));
        return out;
      }
    } catch (e) {
      console.warn('[storage] 批量图片加载失败，逐张兜底', e);
      await Promise.all(need.map(async (h) => { const v = await loadImage(h); if (v) out[h] = v; }));
    }
    return out;
  }

  /** 把 markdown 中的 zhinote://img/<hash> 全部替换回真 base64（用于导出、复制等场景） */
  function expandLocalImages(md) {
    return rehydrateLocalImages(md);
  }

  function getChildren(parentId) {
    const wsId = _data.settings.activeWorkspace || 'ws-default';
    if (parentId == null) {
      // 兜底：任何「顶级且属于当前笔记本、却没记进 rootOrder」的笔记也补回 rootOrder（供 manifest/自愈），
      // 避免「搜索能搜到、左侧却不显示」。显示顺序一律按 frac 权威排序，不再依赖 rootOrder 序列。
      const inRoot = new Set(_data.rootOrder);
      for (const id in _data.notes) {
        const n = _data.notes[id];
        if (n && n.parentId == null && n.workspaceId === wsId && !inRoot.has(id)) _data.rootOrder.push(id);
      }
      return Object.values(_data.notes)
        .filter(n => n && n.parentId == null && n.workspaceId === wsId)
        .sort(_cmpSib);
    }
    const children = Object.values(_data.notes)
      .filter(n => n.parentId === parentId && n.workspaceId === wsId)
      .sort(_cmpSib);
    return children;
  }

  function getAncestors(id) {
    const chain = [];
    let cur = _data.notes[id];
    while (cur) {
      chain.unshift(cur);
      if (!cur.parentId) break;
      cur = _data.notes[cur.parentId];
    }
    return chain;
  }

  // ── 分数序（fractional indexing）：跨设备稳定排序的「权威」字段 note.frac ─────────────
  //   每篇笔记存一个字符串 frac 作为「同级排序」权威键：拖动只改被拖那一篇的 frac、不动其它兄弟，
  //   并发插到同位由 id 兜底裁决 → 两端确定性收敛，根治「位置乱跳/两篇互换/反复重排」。
  //   order/rootOrder 仍维护（旧版兼容 + 网盘 manifest 回退），但 order **不再进同步元数据**
  //   （见 _LEDGER_META），故不会两端 LWW 互踩；positional order 现在是 frac 排序的确定性函数。
  function _fi() {
    const cb = window.__crdtBundle;
    return (cb && typeof cb.generateKeyBetween === 'function') ? cb : null;
  }
  // 同级排序比较器：唯一实现已收口到 order.js（window.__order），此处仅转调，保证全项目排序逻辑只有一份。
  function _cmpSib(a, b) { return window.__order.cmpSib(a, b); }
  const _rootWs = (n) => (n.workspaceId || 'ws-default');
  function _siblingsOf(parentId, wsId) {
    if (parentId == null) return Object.values(_data.notes).filter(n => n.parentId == null && _rootWs(n) === (wsId || 'ws-default'));
    return Object.values(_data.notes).filter(n => n.parentId === parentId);
  }
  // 在某同级组里，为 note 生成「位于 prevFrac 与 nextFrac 之间」的 frac（带降级兜底，绝不抛出）。
  function _genFrac(prevFrac, nextFrac) {
    const fi = _fi(); if (!fi) return null;
    const p = prevFrac || null, q = nextFrac || null;
    try { return fi.generateKeyBetween(p, q); }
    catch (_) { try { return fi.generateKeyBetween(p, null); } catch (__) { try { return fi.generateKeyBetween(null, null); } catch (e) { return null; } } }
  }
  // 给笔记分配「紧跟在 afterId 之后」的 frac；afterId 为空则放到同级末尾。
  function _assignFracAfter(note, parentId, wsId, afterId) {
    const sibs = _siblingsOf(parentId, wsId).filter(n => n.id !== note.id).sort(_cmpSib);
    let index = sibs.length;
    if (afterId) { const i = sibs.findIndex(n => n.id === afterId); if (i >= 0) index = i + 1; }
    _assignFracAt(note, parentId, wsId, index);
  }
  // 把某同级组的 frac 重新均匀编号（保持当前 _cmpSib 顺序）——用于「撞车/逆序」自愈。
  //   确定性：两端同样的成员集合 + 同样的 _cmpSib 顺序 → 生成同一串 frac → 各自重排后收敛，不打架。
  //   返回是否改动。注意：调用方随后会 recomputeOrder 把 order 一并对齐。
  function _respaceSiblings(parentId, wsId) {
    const fi = _fi(); if (!fi) return false;
    const sibs = _siblingsOf(parentId, wsId).sort(_cmpSib);
    if (!sibs.length) return false;
    let keys = null;
    try { keys = fi.generateNKeysBetween(null, null, sibs.length); } catch (_) { keys = null; }
    if (!keys || keys.length !== sibs.length) return false;
    for (let i = 0; i < sibs.length; i++) sibs[i].frac = keys[i];
    return true;
  }
  // 给「新建/移动到末尾或指定位置」的笔记分配 frac。index 为目标同级下标（含本篇前的排好序列表）。
  function _assignFracAt(note, parentId, wsId, index) {
    const fi = _fi(); if (!fi) return;
    let sibs = _siblingsOf(parentId, wsId).filter(n => n.id !== note.id).sort(_cmpSib);
    let prev = null, next = null;
    const pick = () => {
      prev = null; next = null;
      if (index == null || index >= sibs.length) { prev = sibs.length ? sibs[sibs.length - 1].frac : null; }
      else if (index <= 0) { next = sibs[0] ? sibs[0].frac : null; }
      else { prev = sibs[index - 1] ? sibs[index - 1].frac : null; next = sibs[index] ? sibs[index].frac : null; }
    };
    pick();
    // 撞车/逆序：两个邻居 frac 相等或倒序时，无法「夹在中间」取值（generateKeyBetween 会失败/降级到末尾，
    //   表现为"拖到这个位置不生效、弹到别处"）。先把这一组重新均匀编号自愈，再重取邻居即可正确落位。
    //   撞车主因：两台设备同时往末尾新建笔记 → 各自算出同一个 frac。靠 id 兜底显示稳，但插中间会卡。
    if (prev != null && next != null && !(prev < next)) {
      _respaceSiblings(parentId, wsId);
      sibs = _siblingsOf(parentId, wsId).filter(n => n.id !== note.id).sort(_cmpSib);
      pick();
    }
    const f = _genFrac(prev, next); if (f != null) note.frac = f;
  }
  // 缺失 frac 的确定性补齐 + rootOrder 的唯一推导，唯一实现已收口到 order.js（window.__order），此处仅转调。
  function _backfillFrac(data) { return window.__order.backfillFrac(data || _data); }
  // rootOrder 唯一推导：所有顶级笔记按 (笔记本, frac, id) 确定性排序——纯 frac 函数，与到达顺序/历史无关。
  function _deriveRootOrder(data) { return window.__order.deriveRootOrder(data || _data); }

  function recomputeOrder(parentId) {
    if (parentId == null) {
      // 根笔记：按 (笔记本, frac) 确定性排序 → 组内 order 设为本笔记本内下标；rootOrder 全局重建。
      // order 现为 frac 排序的确定性函数（不再是反过来驱动顺序），两端必然一致，杜绝振荡。
      const roots = Object.values(_data.notes).filter(n => n.parentId == null);
      const byWs = {};
      roots.forEach(n => { const ws = _rootWs(n); (byWs[ws] = byWs[ws] || []).push(n); });
      Object.keys(byWs).forEach(ws => { byWs[ws].sort(_cmpSib).forEach((n, i) => { n.order = i; }); });
      _data.rootOrder = _deriveRootOrder(_data);
      return;
    }
    const siblings = Object.values(_data.notes).filter(n => n.parentId === parentId).sort(_cmpSib);
    siblings.forEach((n, i) => { n.order = i; });
  }

  function create({ parentId = null, title = '无标题', content = '', doc = null, insertAfterId = null, workspaceId = null } = {}) {
    const id = genId();
    const wsId = workspaceId
      || ((parentId && _data.notes[parentId]) ? _data.notes[parentId].workspaceId : null)
      || (_data.settings.activeWorkspace || 'ws-default');
    const siblings = parentId != null
      ? Object.values(_data.notes).filter(n => n.parentId === parentId)
      : [];
    const maxOrder = siblings.length ? Math.max(...siblings.map(n => n.order || 0)) + 1 : 0;
    const note = {
      id, parentId, title, content,
      color: null, expanded: false, order: parentId != null ? maxOrder : 0,
      workspaceId: wsId,
      createdAt: now(), updatedAt: now(),
    };
    if (doc) note.doc = doc;
    _data.notes[id] = note;

    if (parentId == null) {
      if (insertAfterId) {
        const idx = _data.rootOrder.indexOf(insertAfterId);
        _data.rootOrder.splice(idx + 1, 0, id);
      } else {
        // 新建顶级笔记追加到列表末尾，与「新建子笔记排在同级末尾」保持一致
        _data.rootOrder.push(id);
      }
    } else {
      const parent = _data.notes[parentId];
      if (parent) parent.expanded = true;
      // 子笔记也支持 insertAfterId：把 order 设到「指定同级项之后」（+0.5），
      // 由下面 recomputeOrder 归一化为整数 → 副本紧贴原笔记，不被甩到同级末尾。
      const after = insertAfterId && _data.notes[insertAfterId];
      if (after && after.parentId === parentId) {
        note.order = (after.order || 0) + 0.5;
      }
    }
    // 分配分数序（权威排序键）：紧跟 insertAfterId 之后，否则同级末尾。
    _assignFracAfter(note, parentId, wsId, (insertAfterId && _data.notes[insertAfterId]) ? insertAfterId : null);
    recomputeOrder(parentId);
    if (parentId == null) recomputeOrder(null);
    save();
    emit('change', { type: 'create', id });
    return note;
  }

  function rename(id, title, opts = {}) {
    const n = _data.notes[id];
    if (!n) return;
    n.title = title || '无标题';
    n.updatedAt = now();
    save();
    // silent=true：调用方自己处理 UI（如顶栏标题输入逐键改，自己 updateNodeTitle 局部刷）
    // 避免 storage.on('change') 监听者每键都全树重渲 → 侧栏闪烁
    emit('change', { type: 'rename', id, silent: opts.silent === true });
  }

  /** 把 doc(JSON) 里所有 data: 图片入仓库，src 改写为 zhinote://img/<hash>。原地修改并返回 doc。 */
  function ingestDocImages(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    const ingest = (dataUrl) => {
      const h = quickHash(dataUrl);
      if (!_imgCache[h]) { _imgCache[h] = dataUrl; _imgPersistSafe(h, dataUrl); }
      return `zhinote://img/${h}`;
    };
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'image' && node.attrs && typeof node.attrs.src === 'string'
          && node.attrs.src.startsWith('data:')) {
        node.attrs.src = ingest(node.attrs.src);
      }
      if (Array.isArray(node.content)) node.content.forEach(visit);
    };
    visit(doc);
    return doc;
  }

  /** 维护一篇笔记的「合并账本」(note.ydoc)，与正文 doc 同步演进。
   *  - 首次建账本：用「改之前的正文」(oldDoc) 作确定化创世根——它最接近上次同步的共同版本，
   *    两端从同一共同版本各自独立建出的创世账本逐字节相同（同根），故能正确合并、不重复。
   *    （全新笔记无 oldDoc → 用新正文创世。）
   *  - 之后每次：把新正文叠加进账本（自动算最小增量）。
   *  账本只是合并工具，任何失败都不得影响正文保存，故整体 try/catch 吞掉。 */
  function _maintainLedger(note, newDoc, oldDoc) {
    try {
      const Y = window.__ydoc;
      if (!Y || !Y.ready()) return;
      if (!note.ydoc) note.ydoc = Y.build(oldDoc || newDoc);
      note.ydoc = Y.update(note.ydoc, newDoc);
    } catch (e) { console.warn('[storage] 维护合并账本失败（不影响正文）', e); }
  }

  // ── 工作区「结构底稿」影子维护（方案2 第1步）────────────────────────────────
  //   把全局结构(笔记元数据/笔记本/模板/回收站/三类墓碑)演进进 _data.structLedger(wsdoc)，
  //   与正文账本同手法。**此阶段仅影子维护**：不读取、不上传、不改 dataFormatVersion，
  //   线上行为零变化；任何失败 try/catch 吞掉，绝不影响真实数据。下一步才接入同步。
  //   注意 settings 含密钥，此阶段一律不纳入底稿，待接同步时用既有「可同步白名单」处理。
  function _buildStructSnapshot() {
    // 根笔记顺序由 rootOrder 决定（子笔记由各自 order 决定）；把根序换算进 note.order 入账。
    // **关键**：用「本笔记本内的下标」而非全局下标——否则别的笔记本多/少一篇就会让本篇 order 变化，
    // 两端 order 永远对不齐 → 合并来回冲突 → 反复重发整账（位置乱跳 + 信令被刷爆导致掉线）。
    _backfillFrac(_data);   // 迁移/自愈：给历史笔记确定性补齐 frac（引擎未就绪则跳过，下次再补）
    // 每个同级组按 frac 权威序算「下标 rank」当 order：rank 是已收敛 frac 的确定性函数，
    //   两端逐字节一致、入账后不再抖动（旧版无 frac 时靠它兜底排序）；frac 原样入账作新版权威键。
    const rankIdx = {};
    {
      const groups = {};
      for (const id in _data.notes) {
        const n = _data.notes[id];
        const key = (n.parentId == null) ? ('r:' + (n.workspaceId || 'ws-default')) : ('p:' + n.parentId);
        (groups[key] = groups[key] || []).push(n);
      }
      for (const k in groups) groups[k].sort(_cmpSib).forEach((n, i) => { rankIdx[n.id] = i; });
    }
    const notes = {};
    for (const id in _data.notes) {
      const n = _data.notes[id];
      notes[id] = {
        title: n.title || '', pinnedAt: n.pinnedAt || null, color: n.color || null,
        icon: n.icon || '', parentId: n.parentId == null ? null : n.parentId,
        workspaceId: n.workspaceId || 'ws-default',
        order: (rankIdx[id] != null ? rankIdx[id] : (n.order || 0)),
        frac: (typeof n.frac === 'string' ? n.frac : ''),
        expanded: !!n.expanded, createdAt: n.createdAt || '', updatedAt: n.updatedAt || '',
      };
    }
    const workspaces = {};
    (_data.workspaces || []).forEach((w, i) => { workspaces[w.id] = { name: w.name || '', icon: w.icon || '', order: i }; });
    const templates = {};
    (_data.templates || []).forEach((t, i) => { templates[t.id] = { name: t.name || '', content: t.content || '', order: i }; });
    const trash = {};
    for (const id in (_data.trash || {})) {
      const tn = _data.trash[id];
      trash[id] = { title: tn.title || '', workspaceId: tn.workspaceId || 'ws-default', parentId: tn.parentId == null ? null : tn.parentId, deletedAt: tn.deletedAt || '', updatedAt: tn.updatedAt || '' };
    }
    const tombstones = {};
    for (const id in (_data.tplTombstones || {})) tombstones['templates:' + id] = _data.tplTombstones[id];
    for (const id in (_data.wsTombstones || {})) tombstones['workspaces:' + id] = _data.wsTombstones[id];
    for (const id in (_data.noteTombstones || {})) tombstones['notes:' + id] = _data.noteTombstones[id];
    return { notes, workspaces, templates, trash, settings: {}, tombstones };
  }

  let _structLedgerTimer = null;
  function _scheduleStructLedger() {
    if (!window.__wsdoc || !window.__wsdoc.ready || !window.__wsdoc.ready()) return;
    clearTimeout(_structLedgerTimer);
    _structLedgerTimer = setTimeout(_maintainStructLedger, 400);
  }
  function _maintainStructLedger() {
    try {
      const W = window.__wsdoc;
      if (!W || !W.ready()) return;
      const snap = _buildStructSnapshot();
      if (_data.structLedger) {
        // 本地即权威：把「已从本地彻底消失」的记录补成墓碑，让底稿与本地一致。
        //   notes 与 trash 共用一个 id 空间(同一集合)，只有两边都没有才算永久删除。
        const prev = W.toData(_data.structLedger);
        const now = Date.now();
        const tomb = snap.tombstones || (snap.tombstones = {});
        // 笔记永久删除墓碑改由 _data.noteTombstones 显式提供（见 _buildStructSnapshot）。
        //   绝不再「总账有、本地无 → 推断已删」：它分不清"已删"和"正文还没同步到本端"，
        //   曾导致对端把刚新建、正文未到的笔记误打墓碑并回传，全网删除（数据丢失）。
        ['workspaces', 'templates'].forEach(function (coll) {
          const cur = snap[coll] || {}, old = prev[coll] || {};
          for (const id in old) { if (!cur[id] && !tomb[coll + ':' + id]) tomb[coll + ':' + id] = now; }
        });
        _data.structLedger = W.update(_data.structLedger, snap);
      } else {
        _data.structLedger = W.build(snap);
      }
      save();
    } catch (e) { console.warn('[storage] 维护结构底稿失败（不影响数据）', e); }
  }

  // ── 结构总账·同步层接口（方案2 wire-sync）──────────────────────────────────
  //   供 webdav-sync 调用，统一收口「创世/认领」规则（见 docs/CRDT同步大改方案.md 七·补）：
  //   - 同步层**绝不直接 merge 总账**（两份独立创世 merge 会丢数据，已验证）；一律走这里。
  //   - 本阶段总账仅「跟着同步、两端一致地存着」，**不当结构权威**——不改 _data.notes 等真实结构，零风险。
  /** 取本端最新结构总账（先把当前结构刷进去再返回 base64）；引擎未就绪/无结构则返回 undefined。 */
  function _webdavGetStructLedger() {
    try {
      const W = window.__wsdoc;
      if (!W || !W.ready()) return _data.structLedger;
      _maintainStructLedger();           // 刷入最新结构（含防抖未落的改动）
      return _data.structLedger;
    } catch (_) { return _data.structLedger; }
  }
  /** 把云端总账按规则并入本地：未扎根(本地独立创世/从未同步)→认领对方基线；已扎根→正常合并。 */
  function _webdavApplyStructLedger(remoteB64) {
    try {
      const W = window.__wsdoc;
      if (!W || !W.ready() || !remoteB64) return false;
      const before = _data.structLedger;
      _maintainStructLedger();           // 确保本地总账反映当前结构
      if (!_data.structLedger || !_data.structLedgerRooted) {
        // 认领：在对方基线上叠加本端当前结构，丢弃本地独立创世（避免撞车丢数据）
        _data.structLedger = W.update(remoteB64, _buildStructSnapshot());
      } else {
        // 已扎根（同源于云端基线）→ 正常合并
        _data.structLedger = W.merge(_data.structLedger, remoteB64);
      }
      _data.structLedgerRooted = true;
      save();
      const merged = _data.structLedger !== before;
      // 让总账当「结构/元数据」权威：把合并结果落地到真实结构（只动元数据、不碰正文、不造空壳）。
      let missing = [];
      if (merged) { try { const ar = _applyStructLedgerToData(); if (ar && ar.missing) missing = ar.missing; } catch (_) {} }
      return { changed: merged, missing: missing };
    } catch (e) { console.warn('[storage] 并入云端结构总账失败（忽略，不影响主同步）', e); return { changed: false, missing: [] }; }
  }
  /** 本端是首个上传者（云端原无总账）→ 标记已扎根，避免下次把自己的基线又当外来基线认领。 */
  function _webdavMarkStructLedgerRooted() { try { if (_data.structLedger) { _data.structLedgerRooted = true; save(); } } catch (_) {} }

  /** 覆盖恢复/覆盖云端专用：用本地当前实际内容重建一份**全新、零删除标记**的结构总账。
   *  先清掉本地三类过期墓碑（导入/恢复以备份实际内容为准，旧删除标记必须丢，否则
   *  CRDT「删除优先」会把恢复的笔记/笔记本永久删掉、且合并永不复活——覆盖恢复后刷新丢笔记的根因）。
   *  W.build 产生全新文档（无历史/无 tombstone）；随后由 mirror 以「替换+epoch++」推云，
   *  其它设备进入采纳模式对齐到这份干净全集。仅在用户主动覆盖时调用，不影响日常同步。 */
  function _webdavRebuildStructLedgerFresh() {
    try {
      const W = window.__wsdoc;
      // 先用内嵌总账里的「真实笔记本/模板名」修正明文：某些备份的明文笔记本名被旧事故写坏成序号(1、2…)，
      //   而其内嵌总账仍保有真名。按 id 对齐取总账名，既保住真名，重建后也不会再变回序号。
      if (W && W.ready && W.ready() && _data.structLedger) {
        try {
          const led = W.toData(_data.structLedger);
          const _validName = (s) => (typeof s === 'string' && s.trim() && s.trim() !== '未命名笔记本');
          if (led && led.workspaces && Array.isArray(_data.workspaces)) {
            for (const w of _data.workspaces) {
              const lw = w && led.workspaces[w.id];
              if (lw) { if (_validName(lw.name)) w.name = lw.name; if (typeof lw.icon === 'string' && lw.icon) w.icon = lw.icon; }
            }
          }
          if (led && led.templates && Array.isArray(_data.templates)) {
            for (const t of _data.templates) {
              const lt = t && led.templates[t.id];
              if (lt && _validName(lt.name)) t.name = lt.name;
            }
          }
        } catch (_) {}
      }
      delete _data.wsTombstones;
      delete _data.noteTombstones;
      delete _data.tplTombstones;
      if (!W || !W.ready()) { _data.structLedger = undefined; _data.structLedgerRooted = false; _globalDirty = true; save(); return false; }
      _data.structLedger = W.build(_buildStructSnapshot());
      _data.structLedgerRooted = true;
      _globalDirty = true;   // 让 doPut 的 globalDirty 分支运行，把笔记本/模板/总账一并权威推云
      save();
      return true;
    } catch (e) { console.warn('[storage] 重建干净结构总账失败', e); return false; }
  }

  /** 采纳权威世代（epoch 跳变/下载覆盖）专用：直接以云端总账为本地权威，**不合并**本地旧总账。
   *  先清掉本地三类过期墓碑——否则本地旧的「删除优先」墓碑会把权威刚恢复/分发的笔记又删掉，
   *  并在本端下次上传时回传、把云端再次污染（设备B反向污染A的根因）。随后落地到真实结构。 */
  function _webdavReplaceStructLedger(remoteB64) {
    try {
      const W = window.__wsdoc;
      if (!W || !W.ready() || !remoteB64) return false;
      delete _data.wsTombstones;
      delete _data.noteTombstones;
      delete _data.tplTombstones;
      _data.structLedger = remoteB64;     // 以云端权威总账为准（丢弃本地独立创世/旧墓碑）
      _data.structLedgerRooted = true;
      save();
      _applyStructLedgerToData();          // 按权威总账落地结构/元数据（只动元数据，不碰正文、不造空壳）
      return true;
    } catch (e) { console.warn('[storage] 采纳云端结构总账失败', e); return false; }
  }

  // ── 总账「落地」纯函数（方案2 第2步·当权威；先纯函数+模拟，未接线）────────────────
  //   把总账的「结构+元数据」合并进一个数据对象。**只动元数据，绝不碰正文(doc/ydoc)；
  //   只更新本地已存在的笔记，绝不据总账凭空造笔记**（笔记存在性+正文仍归 v3）。
  //   纯函数：只操作传入的 data，便于用合成数据单测，不依赖闭包 _data。
  //   注意：**不含 `updatedAt`**——它是「正文同步」的 LWW 时间戳，总账里存的是结构变更那刻的旧值，
  //   若回写会把笔记时间戳倒退、可能让较新正文被网盘误判为旧而覆盖。时间戳归正文路径独占。
  // 注意：**不含 order**。order（第几名）现在是 frac 的确定性函数，两端各自由 frac 算出必然一致，
  //   再同步它纯属重复、且会引入「两端 order 对不齐」的噪音（撞车时曾被 _cmpSib 误用 → 显示乱）。
  //   排序权威唯一来源 = frac。order 仅本地维护，作旧版/无 frac 时的兜底。
  const _LEDGER_META = ['title', 'pinnedAt', 'color', 'icon', 'parentId', 'workspaceId', 'frac', 'expanded'];
  function _applyMetaIfDiff(target, src, fields) {
    // 把 undefined / null / '' 视作等价的「空」，避免 icon:undefined↔'' 之类无意义差异被判为改动、触发多余上传抖动。
    const norm = v => (v === undefined || v === null) ? '' : v;
    let changed = false;
    for (const k of fields) {
      if (!(k in src)) continue;
      if (k === 'frac' && !src[k]) continue;   // 绝不用空 frac 覆盖本地已有 frac（旧版/迁移中途的记录）
      if (norm(target[k]) === norm(src[k])) continue;
      target[k] = src[k] === undefined ? null : src[k];
      changed = true;
    }
    return changed;
  }
  /** 返回 { changed, removed:[{id,note}] }（removed 供调用方落地前留底）。 */
  function _mergeLedgerIntoData(data, led) {
    const removed = [];
    let changed = false;
    data.notes = data.notes || {}; data.trash = data.trash || {};
    data.rootOrder = data.rootOrder || []; data.trashOrder = data.trashOrder || [];
    const tomb = (led && led.tombstones) || {};

    // 1) 永久删除墓碑：删笔记本体（先收集留底）/ 笔记本 / 模板
    for (const key in tomb) {
      const i = key.indexOf(':'); if (i < 0) continue;
      const coll = key.slice(0, i), id = key.slice(i + 1);
      if (coll === 'notes') {
        data.noteTombstones = data.noteTombstones || {};
        if (!data.noteTombstones[id]) data.noteTombstones[id] = tomb[key]; // 持久化墓碑→本端后续也会携带、不复活
        if (data.notes[id]) { removed.push({ id, note: data.notes[id] }); delete data.notes[id]; changed = true; }
        if (data.trash[id]) { removed.push({ id, note: data.trash[id] }); delete data.trash[id]; changed = true; }
        data.rootOrder = data.rootOrder.filter(x => x !== id);
        data.trashOrder = data.trashOrder.filter(x => x !== id);
      } else if (coll === 'workspaces') { data.wsTombstones = data.wsTombstones || {}; if (!data.wsTombstones[id]) { data.wsTombstones[id] = tomb[key]; changed = true; } }
      else if (coll === 'templates') { data.tplTombstones = data.tplTombstones || {}; if (!data.tplTombstones[id]) { data.tplTombstones[id] = tomb[key]; changed = true; } }
    }

    // 2) 笔记本（map→array 按 order；union 保留本地独有；墓碑过滤）
    if (led && led.workspaces) {
      const wt = data.wsTombstones || {};
      const fromLed = Object.keys(led.workspaces).filter(id => !wt[id])
        .map(id => ({ id, name: led.workspaces[id].name || '', icon: led.workspaces[id].icon || '', _o: led.workspaces[id].order || 0 }))
        .sort((a, b) => a._o - b._o);
      const seen = new Set(fromLed.map(w => w.id));
      const localOnly = (data.workspaces || []).filter(w => w && !seen.has(w.id) && !wt[w.id]);
      let merged = fromLed.map(w => ({ id: w.id, name: w.name, icon: w.icon })).concat(localOnly);
      if (!merged.length) merged = [{ id: 'ws-default', name: '默认笔记本', icon: '📒' }];
      if (JSON.stringify(merged) !== JSON.stringify(data.workspaces)) { data.workspaces = merged; changed = true; }
    }
    // 3) 模板（同笔记本）
    if (led && led.templates) {
      const tt = data.tplTombstones || {};
      const fromLed = Object.keys(led.templates).filter(id => !tt[id])
        .map(id => ({ id, name: led.templates[id].name || '', content: led.templates[id].content || '', _o: led.templates[id].order || 0 }))
        .sort((a, b) => a._o - b._o);
      const seen = new Set(fromLed.map(t => t.id));
      const localOnly = (data.templates || []).filter(t => t && !seen.has(t.id) && !tt[t.id]);
      const merged = fromLed.map(t => ({ id: t.id, name: t.name, content: t.content })).concat(localOnly);
      if (JSON.stringify(merged) !== JSON.stringify(data.templates || [])) { data.templates = merged; changed = true; }
    }

    // 4) 笔记元数据（只动本地已存在；不创建空壳）
    const missing = [];                          // 总账有、本地无、且未墓碑 → 正文待网盘补全（不在此造空壳）
    const ntomb = data.noteTombstones || {};
    const lnotes = (led && led.notes) || {}, ltrash = (led && led.trash) || {};
    for (const id in lnotes) {
      if (data.notes[id]) { if (_applyMetaIfDiff(data.notes[id], lnotes[id], _LEDGER_META)) changed = true; }
      else if (data.trash[id]) {                 // 还原：trash→notes
        const n = data.trash[id]; delete data.trash[id]; data.trashOrder = data.trashOrder.filter(x => x !== id);
        _applyMetaIfDiff(n, lnotes[id], _LEDGER_META); delete n.deletedAt; data.notes[id] = n;
        changed = true;
      }
      else if (!ntomb[id]) missing.push(id);
    }
    for (const id in ltrash) {
      if (data.trash[id]) { if (_applyMetaIfDiff(data.trash[id], ltrash[id], _LEDGER_META)) changed = true; }
      else if (data.notes[id]) {                 // 删到回收站：notes→trash
        const n = data.notes[id]; delete data.notes[id]; data.rootOrder = data.rootOrder.filter(x => x !== id);
        _applyMetaIfDiff(n, ltrash[id], _LEDGER_META); if (!n.deletedAt) n.deletedAt = new Date().toISOString();
        data.trash[id] = n; if (!data.trashOrder.includes(id)) data.trashOrder.unshift(id);
        changed = true;
      }
    }

    // 5) 先把缺失的 frac 确定性补齐（旧版/迁移中途的对端记录可能无 frac），再按 (笔记本, frac) 重建 rootOrder。
    //    frac 是稳定存储的权威键（不随合并集合的瞬时差异变化）→ 两端必然算出同一个 rootOrder，杜绝岔开与抖动。
    if (_backfillFrac(data)) changed = true;
    const roots = _deriveRootOrder(data);
    if (JSON.stringify(roots) !== JSON.stringify(data.rootOrder)) { data.rootOrder = roots; changed = true; }

    return { changed, removed, missing };
  }

  /** 把本端当前结构总账（_data.structLedger）落地到真实结构 _data。
   *  只动元数据/笔记本/模板/回收站开关，绝不碰正文；本地没有的笔记不创建空壳。
   *  永久删除墓碑删本体前，先复用网盘「同步留底」备份，可在留底里找回。
   *  落地后自愈 + 存盘 + 发 global-sync 让侧栏/切换器刷新（global-sync 不反向上传、不再自维护账本）。 */
  function _applyStructLedgerToData() {
    try {
      const W = window.__wsdoc;
      if (!W || !W.ready() || !_data || !_data.structLedger) return false;
      const led = W.toData(_data.structLedger);
      const r = _mergeLedgerIntoData(_data, led);
      if (r.removed && r.removed.length) {
        for (const x of r.removed) {
          try { if (window.webdavSync && window.webdavSync.backupBeforeOverwrite) window.webdavSync.backupBeforeOverwrite(x.id, x.note, 'ledger-purge'); } catch (_) {}
        }
      }
      if (r.changed) {
        reconcileStructure();
        save({ immediate: true });
        emit('change', { type: 'global-sync' });
      }
      return r;
    } catch (e) { console.warn('[storage] 结构总账落地失败（忽略，不影响数据）', e); return null; }
  }

  /** JSON 存储：写入笔记的 ProseMirror 文档 JSON（唯一事实来源）。
   *  阶段2/3 保留旧 content(md) 作兜底，不在此删除；阶段4 迁移统一清理。 */
  function updateDoc(id, doc, opts) {
    const n = _data.notes[id];
    if (!n || !doc) return;
    ingestDocImages(doc);  // data: → zhinote://，base64 收进本地仓库
    const str = JSON.stringify(doc);
    if (n.doc && JSON.stringify(n.doc) === str) return;  // 无变化，避免空顶 updatedAt
    const oldDoc = n.doc;  // 改之前的正文，作首次建账本的创世根
    n.doc = doc;
    n.updatedAt = now();
    // 阶段 C 绑定模式：账本权威 = 编辑器活的 Y.Doc（调用方随后用 _setNoteYdoc 写回），
    //   这里跳过「从 doc 重建账本」——否则会毁掉活账本的 CRDT 历史、合并出错。
    if (!(opts && opts.skipLedger)) _maintainLedger(n, doc, oldDoc);  // 合并账本与正文同步演进（v3）
    save();
    emit('change', { type: 'content', id, silent: true });
    if (typeof markDirty === 'function') markDirty();
  }

  /** 阶段 C：把编辑器活账本(Y.Doc)的状态(base64)写回 note.ydoc，并标记该篇待同步。
   *  仅绑定模式下由 editor.flushSave 调用；账本权威在编辑器侧，这里只负责落库+留底。 */
  function _setNoteYdoc(id, b64) {
    const n = _data.notes[id];
    if (!n || !b64) return;
    n.ydoc = b64;
    _dirtyNoteIds.add(id);
  }

  function setColor(id, color) {
    const n = _data.notes[id];
    if (!n) return;
    n.color = color;
    n.updatedAt = now();
    save();
    emit('change', { type: 'color', id });
  }

  function setIcon(id, icon) {
    const n = _data.notes[id];
    if (!n) return;
    n.icon = icon || '';
    n.updatedAt = now();
    save();
    emit('change', { type: 'icon', id });
  }

  /** 置顶/取消置顶：写在笔记上（pinnedAt），走笔记 dirty 上传，与以后按篇合并同路。 */
  function isPinned(id) {
    const n = _data.notes[id];
    return !!(n && n.pinnedAt);
  }

  function getPinnedNotes() {
    return Object.values(_data.notes || {})
      .filter(n => n.pinnedAt)
      .sort((a, b) => String(b.pinnedAt).localeCompare(String(a.pinnedAt)));
  }

  function setPinned(id, pinned) {
    const n = _data.notes[id];
    if (!n) return;
    const next = pinned ? now() : null;
    if ((n.pinnedAt || null) === next) return;
    n.pinnedAt = next;
    n.updatedAt = now();
    save();
    emit('change', { type: 'pinned', id });
  }

  function setExpanded(id, expanded) {
    const n = _data.notes[id];
    if (!n || n.expanded === expanded) return;
    n.expanded = expanded;
    save();
    emit('change', { type: 'expanded', id, silent: true });
  }

  function collapseAll() {
    for (const id in _data.notes) {
      _data.notes[id].expanded = false;
    }
    save();
    emit('change', { type: 'collapseAll' });
  }

  function expandAll() {
    for (const id in _data.notes) {
      // 只展开有子节点的，避免无意义脏写
      const hasChild = Object.values(_data.notes).some(n => n.parentId === id);
      if (hasChild) _data.notes[id].expanded = true;
    }
    save();
    emit('change', { type: 'expandAll' });
  }

  /** 检查是否还有可折叠的节点（用于切换按钮的图标/状态） */
  function hasExpandedNodes() {
    return Object.values(_data.notes).some(n => {
      if (!n.expanded) return false;
      return Object.values(_data.notes).some(c => c.parentId === n.id);
    });
  }

  function _collectDescendants(id, acc = []) {
    const children = Object.values(_data.notes).filter(n => n.parentId === id);
    for (const c of children) {
      acc.push(c.id);
      _collectDescendants(c.id, acc);
    }
    return acc;
  }

  function remove(id) {
    const n = _data.notes[id];
    if (!n) return;
    const ids = [id, ..._collectDescendants(id)];
    // 「彻底删除」开启时：直接删除、不入回收站，并标记为脏以便同步写墓碑+删云端，避免复活。
    const permanent = _data.settings.skipTrash === true;
    for (const nid of ids) {
      const node = _data.notes[nid];
      if (!node) continue;
      if (permanent) {
        delete _data.notes[nid];
        _dirtyNoteIds.add(nid);
        (_data.noteTombstones || (_data.noteTombstones = {}))[nid] = now();
      } else {
        _data.trash[nid] = { ...node, deletedAt: now() };
        delete _data.notes[nid];
      }
    }
    if (n.parentId == null) {
      _data.rootOrder = _data.rootOrder.filter(x => x !== id);
    }
    if (permanent) _globalDirty = true;
    else _data.trashOrder.unshift(id);
    recomputeOrder(n.parentId);
    save();
    emit('change', { type: 'delete', id, permanent });
  }

  function restoreFromTrash(id) {
    const node = _data.trash[id];
    if (!node) return;
    const ids = [id, ..._collectDescendantsInTrash(id)];
    for (const nid of ids) {
      const t = _data.trash[nid];
      if (!t) continue;
      const { deletedAt, ...n } = t;
      _data.notes[nid] = n;
      delete _data.trash[nid];
    }
    _data.trashOrder = _data.trashOrder.filter(x => x !== id);
    if (!_data.notes[node.parentId]) {
      _data.notes[id].parentId = null;
      if (!_data.rootOrder.includes(id)) _data.rootOrder.unshift(id);
    }
    // 还原回末尾：分配新 frac（旧 frac 可能与现存兄弟冲突，重排到末尾最稳）。
    { const rn = _data.notes[id]; _assignFracAfter(rn, rn.parentId, _rootWs(rn), null); }
    recomputeOrder(_data.notes[id].parentId);
    save();
    emit('change', { type: 'restore', id });
  }

  function _collectDescendantsInTrash(id, acc = []) {
    const children = Object.values(_data.trash).filter(n => n.parentId === id);
    for (const c of children) {
      acc.push(c.id);
      _collectDescendantsInTrash(c.id, acc);
    }
    return acc;
  }

  function purgeFromTrash(id) {
    const ids = [id, ..._collectDescendantsInTrash(id)];
    // 显式写墓碑 + 标脏：永久删除经「总账墓碑(即时同步)」与「网盘 deleted 清单」双通道传播，
    //   替代原先靠 _maintainStructLedger 推断（已移除）。
    for (const nid of ids) { delete _data.trash[nid]; _dirtyNoteIds.add(nid); (_data.noteTombstones || (_data.noteTombstones = {}))[nid] = now(); }
    _data.trashOrder = _data.trashOrder.filter(x => x !== id);
    _globalDirty = true;
    save();
    emit('change', { type: 'purge', id });
  }

  function emptyTrash() {
    const ids = Object.keys(_data.trash);
    _data.trash = {};
    _data.trashOrder = [];
    for (const id of ids) { _dirtyNoteIds.add(id); (_data.noteTombstones || (_data.noteTombstones = {}))[id] = now(); } // 写墓碑+删云端文件，防复活
    if (ids.length) _globalDirty = true;
    save();
    emit('change', { type: 'emptyTrash' });
  }

  function move(id, newParentId, newIndex) {
    const n = _data.notes[id];
    if (!n) return false;
    if (id === newParentId) return false;
    let p = newParentId;
    while (p) {
      if (p === id) return false;
      p = _data.notes[p]?.parentId;
    }
    const oldParentId = n.parentId;
    if (oldParentId == null) {
      _data.rootOrder = _data.rootOrder.filter(x => x !== id);
    }
    n.parentId = newParentId;
    n.updatedAt = now();

    if (newParentId == null) {
      // 在全局 rootOrder 中，找到同笔记本的第 newIndex 个笔记的位置，插入其前面
      const wsId = n.workspaceId || _data.settings.activeWorkspace || 'ws-default';
      let wsCount = 0;
      let insertAt = _data.rootOrder.length;
      for (let i = 0; i < _data.rootOrder.length; i++) {
        const sibling = _data.notes[_data.rootOrder[i]];
        if (sibling && sibling.workspaceId === wsId) {
          if (wsCount === (newIndex ?? Infinity)) {
            insertAt = i;
            break;
          }
          wsCount++;
        }
      }
      _data.rootOrder.splice(insertAt, 0, id);
    } else {
      const siblings = Object.values(_data.notes)
        .filter(x => x.parentId === newParentId && x.id !== id)
        .sort((a, b) => a.order - b.order);
      const idx = Math.max(0, Math.min(newIndex ?? siblings.length, siblings.length));
      siblings.splice(idx, 0, n);
      siblings.forEach((sib, i) => sib.order = i);
      _data.notes[newParentId].expanded = true;
    }
    // 分数序：只改被拖这一篇的 frac 到目标位置（newIndex 为同级下标），其它兄弟不动 → 两端只需合并一处。
    _assignFracAt(n, newParentId, (n.workspaceId || _data.settings.activeWorkspace || 'ws-default'), newIndex);
    recomputeOrder(oldParentId);
    recomputeOrder(newParentId);
    save();
    emit('change', { type: 'move', id });
    return true;
  }

  function moveToWorkspace(id, targetWsId) {
    const n = _data.notes[id];
    if (!n) return false;
    if (n.workspaceId === targetWsId) return false;
    const oldParentId = n.parentId;
    // 将笔记提升为目标笔记本的顶级笔记
    if (oldParentId != null) {
      recomputeOrder(oldParentId);
    } else {
      _data.rootOrder = _data.rootOrder.filter(x => x !== id);
    }
    n.parentId = null;
    n.workspaceId = targetWsId;
    n.order = _data.rootOrder.length;
    _data.rootOrder.push(id);
    _assignFracAfter(n, null, targetWsId, null);   // 落到目标笔记本根的末尾
    // 递归移动所有子笔记
    const moveChildren = (parentId) => {
      for (const cid in _data.notes) {
        if (_data.notes[cid].parentId === parentId) {
          _data.notes[cid].workspaceId = targetWsId;
          moveChildren(cid);
        }
      }
    };
    moveChildren(id);
    n.updatedAt = now();
    save();
    emit('change', { type: 'move', id });
    return true;
  }

  function getSetting(key) {
    if (!_data || !_data.settings) return undefined;
    return _data.settings[key];
  }
  function setSetting(key, value) {
    if (!_data) {
      console.warn('[storage] setSetting 但 _data 未初始化', key, value);
      return;
    }
    if (!_data.settings) _data.settings = DEFAULT_DATA().settings;
    _data.settings[key] = value;
    save({ immediate: false });
    // 可同步的设置（如 codeBlockExpanded 等）变更要标记 globalDirty 并调度上传。
    const _localOnly = LOCAL_ONLY_SETTINGS.includes(key) || LOCAL_ONLY_PREFIX.some(p => key.startsWith(p));
    if (!_localOnly) {
      _globalDirty = true;
      markDirty();
    }
  }

  function getTemplates() { return _data.templates || []; }
  function saveTemplate(tpl) {
    const idx = _data.templates.findIndex(t => t.id === tpl.id);
    if (idx >= 0) _data.templates[idx] = tpl;
    else _data.templates.push({ ...tpl, id: tpl.id || ('tpl_' + Date.now()) });
    save();
    emit('change', { type: 'template' });
  }
  function deleteTemplate(id) {
    _data.templates = _data.templates.filter(t => t.id !== id);
    _data.tplTombstones = _data.tplTombstones || {};
    _data.tplTombstones[id] = Date.now();
    save();
    emit('change', { type: 'template' });
  }

  /**
   * 全文搜索 v2：
   * 1. 直接子串匹配（中英文、大小写不敏感）— 最高优先级
   * 2. 拼音全拼匹配（如"中文" → "zhongwen"）
   * 3. 拼音首字母匹配（如"中文" → "zw"）
   * 4. 子序列模糊匹配（如"abc" 能匹配 "abxbycz"）
   * 命中后按 title/content 与匹配类型加权排序。
   */
  function stripMarkupForSearch(text) {
    return text
      .replace(/<img[^>]*>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/zhinote:\/\/img\/[a-z0-9]+/gi, '')
      .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x?[0-9a-fA-F]+;/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function searchAll(query) {
    if (!query) return [];
    const q = query.trim();
    if (!q) return [];
    const wsId = _data.settings.activeWorkspace || 'ws-default';
    const ts = window.textSearch;
    if (!ts) return [];

    function tsConsecutive(text, query) {
      const ranges = ts(text, query);
      if (!ranges || ranges.length === 0) return null;
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i][0] > ranges[i - 1][1] + 1) return null;
      }
      return ranges;
    }

    const hits = [];
    for (const id in _data.notes) {
      const n = _data.notes[id];
      if (n.workspaceId !== wsId) continue;
      const title = n.title || '';
      // 双读：有 doc 走纯文本提取（无 markdown 标记，已干净）；旧笔记退回 md 去标记。
      const content = n.doc
        ? (window.editor?.docToPlainText(n.doc) || '')
        : stripMarkupForSearch(n.content || '');

      let bestScore = 0;
      let snippet = '';
      let titleHit = false;
      let matchPos = -1;

      const titleRanges = tsConsecutive(title, q);
      if (titleRanges) {
        bestScore = 100;
        titleHit = true;
      }

      if (!bestScore) {
        const contentRanges = tsConsecutive(content.slice(0, 3000), q);
        if (contentRanges) {
          bestScore = 80;
          const firstStart = contentRanges[0][0];
          const lastEnd = contentRanges[contentRanges.length - 1][1];
          matchPos = firstStart;
          const snippetStart = Math.max(0, firstStart - 20);
          const snippetEnd = Math.min(content.length, lastEnd + 60);
          snippet = (snippetStart > 0 ? '…' : '') + content.slice(snippetStart, snippetEnd) + (snippetEnd < content.length ? '…' : '');
        }
      }

      if (bestScore > 0) {
        if (snippet) {
          snippet = snippet
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/zhinote:\/\/img\/[a-z0-9]+/gi, '')
            .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x?[0-9a-fA-F]+;/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          if (!snippet) snippet = '';
        }
        if (!titleHit && !snippet) continue;
        hits.push({ id, title, snippet, titleMatch: titleHit, score: bestScore, matchPos });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  function exportJSON() {
    // 安全：导出的备份文件**绝不**包含同步敏感信息（WebDAV 地址/账号/密码、加密口令）。
    //   否则把备份分享/上传出去就等于泄露同步登录与解密钥匙（备份本就是给人/跨设备传的）。
    //   其余设置无害，保留；恢复时由 importJSON 一律沿用本机本地设置，不会被这些值影响。
    const clone = Object.assign({}, _data);
    if (_data && _data.settings) {
      const s = Object.assign({}, _data.settings);
      delete s.webdavCryptoPass;
      for (const k in s) { if (k.indexOf('webdav_') === 0) delete s[k]; }
      clone.settings = s;
    }
    return JSON.stringify(clone, null, 2);
  }

  function exportCurrentNoteMd(id) {
    const note = _data.notes[id];
    if (!note) return null;
    // 双读：有 doc 由其派生干净 md；派生失败或旧笔记退回 content。
    let md = '';
    if (note.doc) md = window.editor?.serializeDocToMd(note.doc) || '';
    if (!md) md = note.content || '';
    const content = expandLocalImages(md);
    return { title: note.title || '无标题', content };
  }

  function exportAllAsTree({ allWorkspaces = false, imagesAsFiles = false, workspaceId = null } = {}) {
    const results = [];
    const sanitize = (name) => (name || '').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim() || '无标题';

    // 整包模式：笔记放在「notes/」文件夹、图片放在「images/」文件夹（两个清晰命名的目录），
    // 正文用相对链接引用图片，不内嵌 base64（对齐 Obsidian/Joplin/Notion：干净、体积小、通用）。
    const NOTES_DIR = 'notes/';
    const IMG_DIR = 'images/';
    const ASSET_RE = /zhinote:\/\/img\/([a-z0-9]+l[a-z0-9]+)(?:#[\w-]*)?/gi;
    const usedImages = new Map(); // hash -> { fname, dataUrl }
    const rewriteToAssets = (md, depth) => {
      const up = '../'.repeat(depth); // 从该 .md 所在目录回到 zip 根，再进「图片/」
      return String(md || '').replace(ASSET_RE, (full, h) => {
        const dataUrl = _imgCache[h];
        if (!dataUrl) return full; // 仓库里找不到就保留原引用，避免丢图
        let ext = ((dataUrl.match(/^data:image\/([a-z0-9+.-]+);base64,/i) || [])[1] || 'png').toLowerCase();
        if (ext === 'jpeg') ext = 'jpg'; else if (ext === 'svg+xml') ext = 'svg';
        const fname = `${h}.${ext}`;
        if (!usedImages.has(h)) usedImages.set(h, { fname, dataUrl });
        return up + IMG_DIR + fname;
      });
    };

    const workspaces = allWorkspaces
      ? (_data.workspaces || [{ id: 'ws-default', name: '默认笔记本' }])
      : [{ id: workspaceId || _data.settings?.activeWorkspace || 'ws-default', name: '' }];
    const multiWs = allWorkspaces && workspaces.length > 1;
    const notesRoot = imagesAsFiles ? NOTES_DIR : ''; // 整包：所有 .md 收进「笔记/」

    for (const ws of workspaces) {
      const wsId = ws.id;
      const wsPrefix = notesRoot + (multiWs ? sanitize(ws.name) + '/' : '');

      function walk(parentId, pathPrefix) {
        let children;
        if (parentId == null) {
          children = (_data.rootOrder || []).map(nid => _data.notes[nid]).filter(n => n && n.workspaceId === wsId);
        } else {
          children = Object.values(_data.notes).filter(n => n.parentId === parentId && n.workspaceId === wsId).sort((a, b) => (a.order || 0) - (b.order || 0));
        }
        for (const note of children) {
          const name = sanitize(note.title);
          const hasChildren = Object.values(_data.notes).some(n => n.parentId === note.id && n.workspaceId === wsId);
          const filePath = pathPrefix + name + '.md';
          let content = '';
          if (note.doc) content = window.editor?.serializeDocToMd(note.doc) || '';
          if (!content) content = note.content || '';
          if (imagesAsFiles) {
            const depth = (filePath.match(/\//g) || []).length; // 该 .md 距 zip 根的目录层数
            content = rewriteToAssets(content, depth);
          } else {
            try { content = expandLocalImages(content); } catch (_) {}
          }
          results.push({ path: filePath, content });
          if (hasChildren) walk(note.id, pathPrefix + name + '/');
        }
      }

      try { walk(null, wsPrefix); } catch (e) { console.error('[exportAllAsTree]', ws.id, e); }
    }
    // 整包模式：把被引用到的图片作为独立二进制文件追加到「图片/」（base64 标记，供 JSZip 解码）
    if (imagesAsFiles) {
      for (const { fname, dataUrl } of usedImages.values()) {
        const b64 = String(dataUrl).split(',')[1] || '';
        if (b64) results.push({ path: IMG_DIR + fname, content: b64, base64: true });
      }
    }
    return results;
  }

  /** 导入净化：把导入数据里可能的脏类型/空名规整掉，避免怪数据流入界面与同步。
   *  - 笔记本名：非字符串→转字符串；空白名→「未命名笔记本」；icon 非字符串→默认。
   *  - 模板名：非字符串→转字符串。
   *  - 笔记标题：非字符串→转字符串（空仍允许，由别处兜底为「无标题」）。
   *  仅在导入(整库替换)时调用，不在日常加载跑，避免误改既有数据触发同步。 */
  function _sanitizeImportedStructure() {
    try {
      if (Array.isArray(_data.workspaces)) {
        for (const w of _data.workspaces) {
          if (!w) continue;
          if (typeof w.name !== 'string') w.name = (w.name == null ? '' : String(w.name));
          if (!w.name.trim()) w.name = '未命名笔记本';
          if (typeof w.icon !== 'string' || !w.icon) w.icon = '📒';
        }
      }
      if (Array.isArray(_data.templates)) {
        for (const t of _data.templates) {
          if (t && typeof t.name !== 'string') t.name = (t.name == null ? '' : String(t.name));
        }
      }
      for (const id in (_data.notes || {})) {
        const n = _data.notes[id];
        if (n && typeof n.title !== 'string') n.title = (n.title == null ? '无标题' : String(n.title));
      }
    } catch (e) { console.warn('[storage] 导入净化失败（忽略）', e); }
  }

  async function importJSON(text) {
    let parsed;
    const trimmed = String(text || '').trim();
    if (trimmed.startsWith('MDNOTE_LZB64:')) {
      // 压缩格式
      if (typeof window.LZString === 'undefined') {
        throw new Error('未加载 LZ-string 库，无法解压。请重试或使用明文 JSON 导出。');
      }
      const b64 = trimmed.slice('MDNOTE_LZB64:'.length);
      const json = window.LZString.decompressFromBase64(b64);
      if (!json) throw new Error('压缩数据损坏或非合法 LZ-base64');
      parsed = JSON.parse(json);
    } else if (trimmed.startsWith('{')) {
      parsed = JSON.parse(trimmed);
    } else {
      // 兼容旧格式或纯字符串
      parsed = JSON.parse(trimmed);
    }
    // 整库替换前自动留底当前数据：万一导入错文件/文件本身损坏，可凭恢复键找回（控制台打印）。
    //   与迁移留底同一持久位（Quicker 变量 / localStorage），不占用户外部备份。
    try {
      if (_data) {
        const tag = 'preimport_' + Date.now();
        await _backupDataSnapshot(tag);
        console.warn('[storage] 覆盖导入前已自动留底当前数据；如需找回，恢复键 tag=' + tag);
      }
    } catch (_) {}
    // 备份只恢复「笔记内容」，不该改这台设备的「本地独有/敏感」设置：同步口令/地址/代理、加密口令、
    //   主题、当前笔记本等一律沿用本机现值。否则：① 导入旧备份会把同步登录改回旧值/清空（同步突然失效）；
    //   ② 配合下方 exportJSON 已抹掉口令，导入新备份更不能把口令清成空。
    const _prevSettings = (_data && _data.settings) ? _data.settings : null;
    migrate(parsed);
    _data = parsed;
    if (_prevSettings) {
      _data.settings = _data.settings || {};
      for (const k of LOCAL_ONLY_SETTINGS) { if (k in _prevSettings) _data.settings[k] = _prevSettings[k]; }
      for (const k in _prevSettings) { if (LOCAL_ONLY_PREFIX.some(p => k.startsWith(p))) _data.settings[k] = _prevSettings[k]; }
    }
    _sanitizeImportedStructure();   // 规整脏类型/空名（如备份里 name 是数字、空串），避免流入界面与同步
    // 整库替换语义：以这份备份的实际内容为唯一真相，重建一份全新、零删除标记的结构总账
    //   （并用内嵌总账修正被写坏的笔记本名）。否则备份自带的旧墓碑会在同步/刷新时把刚恢复的
    //   笔记又删掉（覆盖恢复后丢笔记的根因）。引擎未就绪时退化为丢弃旧总账，随后懒重建。
    try { _webdavRebuildStructLedgerFresh(); } catch (_) {}
    await rawSave(_data, { full: true }); // 整库替换 → 强制全量落盘（分片 diff 会同步重写/清理所有片）
    emit('change', { type: 'reload' });
    // 导入后标记所有笔记为 dirty，确保下次同步时上传覆盖远端（而非被远端删除标记覆盖）
    if (_data.notes) {
      for (const id in _data.notes) _dirtyNoteIds.add(id);
    }
    _globalDirty = true;
  }

  function save({ immediate = false, full = false } = {}) {
    if (!_data) return;
    if (immediate) {
      return _flush({ full });
    }
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => _flush({ full }), 400);
  }

  let _pendingFull = false;
  async function _flush({ full = false } = {}) {
    if (_saveInFlight) { _pendingSave = true; _pendingFull = _pendingFull || full; return; }
    _saveInFlight = true;
    try {
      await rawSave(_data, { full });
    } catch (err) {
      console.error('[storage] 保存失败', err);
    } finally {
      _saveInFlight = false;
      if (_pendingSave) {
        _pendingSave = false;
        const f = _pendingFull; _pendingFull = false;
        _flush({ full: f });
      }
    }
  }

  function on(event, cb) { _listeners.push({ event, cb }); }

  // WebDAV dirty 追踪
  let _dirtyNoteIds = new Set();
  let _globalDirty = false;

  // 这些变更会改动全局结构（rootOrder / trashOrder / 树形 / 笔记本归属），
  // 即使带 id 也必须标记 globalDirty。否则新建/删除/移动笔记后 rootOrder 不会上传，
  // 其它设备拿不到顺序、笔记被后续上传从 rootOrder 中抹掉 → 在所有设备上"同步消失"。
  const _STRUCTURAL_CHANGE = new Set(['create', 'delete', 'restore', 'purge', 'move']);
  function emit(event, payload) {
    if (event === 'change') {
      const t = payload?.type;
      if (payload?.id) _dirtyNoteIds.add(payload.id);
      if (t && _STRUCTURAL_CHANGE.has(t)) {
        _globalDirty = true;
      } else if (!payload?.id && t !== 'reload' && t !== 'global-sync' && t !== 'collapseAll' && t !== 'expandAll') {
        _globalDirty = true;
      }
      if (t === 'reload') { _dirtyNoteIds.clear(); _globalDirty = false; }
      // 收口：本地任何会产生脏数据的变更（新建/删除/改名/移动/颜色图标/回收站/笔记本/设置…）
      // 统一在此安排一次「去抖的」上传，让它们也像编辑文字一样触发同步、点亮徽标，
      // 不再只靠失焦/隐藏才推（关闭前来不及推 → 重开拉云端对不齐 → 冲突）。
      // reload / global-sync 是云端下行正在应用，绝不反向回推（避免回声/覆盖）。
      // schedulePut 自身有 _hasDirtyData 早退 + debounce，不会因频繁结构操作猛发请求。
      if (t !== 'reload' && t !== 'global-sync') {
        try { markDirty(); } catch (_) {}
      }
      // 结构变动（非正文）→ 影子维护结构底稿（方案2 第1步，暂不接线读取/上传）
      if (t !== 'content' && t !== 'global-sync') { try { _scheduleStructLedger(); } catch (_) {} }
    }
    _listeners.forEach(l => { if (l.event === event) l.cb(payload); });
  }

  function getDirtyNoteIds() { return Array.from(_dirtyNoteIds); }
  function clearDirtyNoteIds() { _dirtyNoteIds.clear(); }
  function removeDirtyNoteIds(idsToRemove) {
    for (const id of idsToRemove) _dirtyNoteIds.delete(id);
  }
  function markNotesDirtyByIds(ids) {
    for (const id of ids) _dirtyNoteIds.add(id);
  }
  function markAllNotesDirty() {
    for (const id in _data.notes) _dirtyNoteIds.add(id);
    // 回收站一并标脏：换加密口令后「上传覆盖云端」要把 trash/ 也重新加密，
    // 否则云端回收站永远留在旧钥上（扫描恢复/还原时解不开，还可能触发口令误报）
    for (const id in (_data.trash || {})) _dirtyNoteIds.add(id);
    _globalDirty = true;
  }

  function getDataFormatVersion() { return (_data && _data.dataFormatVersion) || 1; }

  /** 迁移前强制备份整份数据到并行持久位（与实时数据同一存储、同等持久）。失败返回 false → 中止迁移。 */
  async function _backupDataSnapshot(tag) {
    try {
      const json = JSON.stringify(_data);
      if (isQuicker()) {
        const v = await bridge();
        await v.setVar(QK_VAR_DATA + '__backup_' + tag, json);
      } else {
        localStorage.setItem(QK_STORAGE_DEV_KEY + '__backup_' + tag, json);
      }
      return true;
    } catch (e) {
      console.error('[storage] 迁移前备份失败（已中止迁移）', e);
      return false;
    }
  }

  /** 一次性迁移：把所有笔记 content(md) → doc(JSON)。幂等、备份优先、单篇失败兜底保留 content。
   *  需在编辑器（markdown manager）就绪后调用。返回迁移报告。 */
  async function migrateNotesToDoc() {
    if (!_data) return { ran: false, reason: 'no-data' };
    if ((_data.dataFormatVersion || 1) >= 2) return { ran: false, reason: 'already-migrated' };
    if (!window.editor || typeof window.editor.parseMdToDoc !== 'function') {
      console.warn('[storage] JSON 迁移中止：editor.parseMdToDoc 不可用（编辑器未就绪）');
      return { ran: false, reason: 'editor-not-ready' };
    }
    // 1) 强制备份；失败则中止，绝不带病前进
    const ok = await _backupDataSnapshot('v1tov2_' + Date.now());
    if (!ok) return { ran: false, reason: 'backup-failed', error: true };

    // 2) 逐篇转换（含回收站）；幂等：已有 doc 跳过；单篇失败保留 content 兜底，不中止整体
    let migrated = 0, skipped = 0, failed = 0;
    const convert = (note) => {
      if (!note) return;
      if (note.doc) { skipped++; return; }
      try {
        const doc = window.editor.parseMdToDoc(note.content || '');
        if (doc && doc.type === 'doc') {
          note.doc = doc;
          delete note.content;
          migrated++;
        } else { failed++; }
      } catch (e) {
        console.warn('[storage] 单篇迁移失败，保留 content 兜底:', note && note.id, e);
        failed++;
      }
    };
    for (const id in _data.notes) convert(_data.notes[id]);
    if (_data.trash) for (const id in _data.trash) convert(_data.trash[id]);

    // 3) 置格式版本 + 全部标脏（下次同步把 doc 全集推上云，并由 webdav 首推时 epoch++）
    //    直接置 v3（账本感知客户端）：账本随后按需懒建，此处不建以免拖慢迁移。
    _data.dataFormatVersion = 3;
    markAllNotesDirty();
    await save({ immediate: true });
    const report = { ran: true, migrated, skipped, failed };
    console.warn('[storage] JSON 迁移完成', report);
    // 通知 UI 刷新（type 非 reload，不会清空 dirty；保持已标脏以便同步上推）
    emit('change', { type: 'migration' });
    return report;
  }
  function isGlobalDirty() { return _globalDirty; }
  function clearGlobalDirty() { _globalDirty = false; }

  // ─── WebDAV 辅助函数（供 webdav-sync.js 调用） ──────────────────────────────
  // 结构/属性的唯一权威 = 结构总账(CRDT)。按篇网盘文件**只管正文**，不再仲裁这些字段（Stage B 收口）。
  //   归属(parentId/workspaceId)、排序(frac/order)、置顶/颜色/图标/展开，一律以总账为准。
  const _LEDGER_OWNED = ['title', 'parentId', 'workspaceId', 'pinnedAt', 'color', 'icon', 'expanded', 'frac', 'order'];
  function _webdavApplyNote(id, noteData) {
    if (!_data.notes) _data.notes = {};
    const prev = _data.notes[id];
    // 本地已存在的笔记：应用远端时**保留本地的结构/属性字段**，绝不被文件里(可能陈旧、且走另一套时间-LWW
    //   仲裁)的值覆盖 → 杜绝「按篇通道 vs 总账」两条路互踩（反复重排/绿点狂转/两端不一致的总病根）。
    //   总账会在同一次 doGet 周期稍后(structLedger 在按篇之后应用)把它们设成权威值；离线则下次周期校正。
    //   仅本地不存在(新笔记/冲突副本/扫描恢复)时整篇采纳——无本地可保，随后总账校正归位。
    if (prev && noteData) {
      const keep = {};
      for (const k of _LEDGER_OWNED) if (k in prev) keep[k] = prev[k];
      _data.notes[id] = Object.assign({}, noteData, keep);
    } else {
      _data.notes[id] = noteData;
    }
  }

  /** 实时同步落地：把「已合并好」的正文+账本直接写进笔记（不再 _maintainLedger 重建账本）。
   *  返回是否真有变化（无变化则不动 updatedAt、不发事件，避免回声/抖动）。
   *  同时 markDirty，让合并结果也经网盘兜底上云。 */
  function _realtimeApply(id, mergedDoc, mergedYdocB64) {
    const n = _data.notes[id];
    if (!n || !mergedDoc) return false;
    const str = JSON.stringify(mergedDoc);
    const sameDoc = n.doc && JSON.stringify(n.doc) === str;
    const sameYdoc = n.ydoc === mergedYdocB64;
    if (sameDoc && sameYdoc) return false;
    ingestDocImages(mergedDoc);
    n.doc = mergedDoc;
    if (mergedYdocB64) n.ydoc = mergedYdocB64;
    n.updatedAt = now();
    save();
    emit('change', { type: 'content', id, silent: true });
    if (typeof markDirty === 'function') markDirty();
    return true;
  }

  /** 即时同步：把对端发来的整篇笔记就地建出，让「对端新建/本端缺失」的笔记立刻出现，不必干等网盘。
   *  严格只建本地真缺失（notes/trash 都没有）且未永久删除的笔记，绝不覆盖本地已有或已删；
   *  建出后调 _applyStructLedgerToData 按总账排位/归笔记本，并 markDirty 经网盘兜底上云。
   *  返回是否真的建出（已存在/已墓碑 → false，不动）。 */
  function _realtimeMaterializeNote(id, noteData) {
    if (!id || !noteData || typeof noteData !== 'object') return false;
    _data.notes = _data.notes || {}; _data.trash = _data.trash || {};
    if (_data.notes[id] || _data.trash[id]) return false;          // 已存在(含回收站) → 不覆盖
    const ntomb = _data.noteTombstones || {};
    if (ntomb[id]) return false;                                   // 已永久删除 → 不复活
    noteData.id = id;                                              // 防御：以索取的 id 为准
    _data.notes[id] = noteData;
    try { ingestDocImages(noteData.doc); } catch (_) {}            // 入库正文图片引用（缺的图后续网盘补显）
    const r = _applyStructLedgerToData();                          // 按总账排位/归笔记本 + 存盘 + 发 global-sync
    if (!r) { try { save(); emit('change', { type: 'global-sync' }); } catch (_) {} }
    if (typeof markDirty === 'function') markDirty();
    return true;
  }

  function _webdavRemoveNote(id) {
    if (!_data.notes || !_data.notes[id]) return;
    if (!_data.trash) _data.trash = {};
    _data.trash[id] = { ..._data.notes[id], deletedAt: new Date().toISOString() };
    if (!_data.trashOrder) _data.trashOrder = [];
    if (!_data.trashOrder.includes(id)) _data.trashOrder.unshift(id);
    delete _data.notes[id];
    _data.rootOrder = (_data.rootOrder || []).filter(x => x !== id);
  }

  // ── 合并工具：绝不丢 id ────────────────────────────────────────────────
  /** 合并两个 id 顺序数组：base 在前（保留其顺序），追加仅出现在 extra 里的 id，去重 */
  function _mergeIdOrder(baseArr, extraArr) {
    const out = []; const seen = new Set();
    for (const id of (baseArr || [])) { if (id != null && !seen.has(id)) { seen.add(id); out.push(id); } }
    for (const id of (extraArr || [])) { if (id != null && !seen.has(id)) { seen.add(id); out.push(id); } }
    return out;
  }
  /** 按 id 合并对象数组：base 优先（同 id 用 base 版本），保留仅出现在 extra 里的项 */
  function _mergeById(baseArr, extraArr) {
    const out = []; const seen = new Set();
    for (const it of (baseArr || [])) { if (it && it.id != null && !seen.has(it.id)) { seen.add(it.id); out.push(it); } }
    for (const it of (extraArr || [])) { if (it && it.id != null && !seen.has(it.id)) { seen.add(it.id); out.push(it); } }
    return out;
  }

  /**
   * 结构自愈：把"仍存在于 _data.notes 里、却没挂在 rootOrder / 有效笔记本上"的笔记重新接回，
   * 修复早期同步缺陷（全局集合被整体覆盖）导致笔记从 rootOrder 掉出而"消失"的历史数据。
   * 幂等：重复运行不会再产生变化；有改动时置 _globalDirty 让恢复结果回传云端。
   */
  function reconcileStructure() {
    if (!_data) return false;
    let changed = false;
    _data.notes ??= {};
    if (!Array.isArray(_data.workspaces) || !_data.workspaces.length) {
      _data.workspaces = [{ id: 'ws-default', name: '默认笔记本', icon: '📒' }];
      changed = true;
    }
    _data.settings ??= DEFAULT_DATA().settings;
    const wsIds = new Set(_data.workspaces.map(w => w && w.id).filter(Boolean));
    let fallbackWs = _data.settings.activeWorkspace;
    if (!fallbackWs || !wsIds.has(fallbackWs)) fallbackWs = _data.workspaces[0].id;

    // 1) 父节点不存在 → 提升为顶级，避免笔记永久不可见
    for (const id in _data.notes) {
      const n = _data.notes[id];
      if (n && n.parentId != null && !_data.notes[n.parentId]) { n.parentId = null; changed = true; }
    }
    // 2) workspaceId 指向不存在的笔记本 → 分两种情况处理：
    //    a. 指向「已彻底删除(有墓碑)」的笔记本：这是被删本子的漏网/竞态笔记（删除时还没到、或子笔记 workspaceId 没更新）
    //       → 一并删除并写笔记墓碑，经双通道传播；**绝不**塞进当前本子（修 #1「删本子漏一两篇到当前」+ 污染回传）。
    //    b. 指向「未知(无墓碑)」的笔记本：历史数据自愈 → 落回有效笔记本，避免笔记永久不可见。
    const _wsTomb = _data.wsTombstones || {};
    for (const id in _data.notes) {
      const n = _data.notes[id];
      if (!n) continue;
      if (n.workspaceId && _wsTomb[n.workspaceId]) {
        delete _data.notes[id];
        _data.rootOrder = (_data.rootOrder || []).filter(x => x !== id);
        (_data.noteTombstones || (_data.noteTombstones = {}))[id] = Date.now();
        _dirtyNoteIds.add(id);
        changed = true;
        continue;
      }
      if (!n.workspaceId || !wsIds.has(n.workspaceId)) { n.workspaceId = fallbackWs; changed = true; }
    }
    // 3) rootOrder 唯一推导（顺序单权威收口）：先确定性补齐缺失 frac，再按 (笔记本, frac, id) 重排所有顶级笔记。
    //    deriveRootOrder 天然只含「存在且 parentId==null」的笔记、自动去重，遗漏的顶级笔记也一并按 frac 落位
    //    （不再追加到末尾再被别处重排 → 杜绝"先到末尾、稍后跳回正位"的偏移）。与到达顺序/历史 rootOrder 无关。
    _backfillFrac(_data);
    const derivedRoot = _deriveRootOrder(_data);
    if (JSON.stringify(derivedRoot) !== JSON.stringify(_data.rootOrder || [])) { _data.rootOrder = derivedRoot; changed = true; }
    // 4) trashOrder 只保留存在于 trash 的；遗漏的补回
    _data.trash ??= {};
    const cleanedTrash = (_data.trashOrder || []).filter(id => _data.trash[id]);
    if (cleanedTrash.length !== (_data.trashOrder || []).length) changed = true;
    const inTrash = new Set(cleanedTrash);
    for (const id in _data.trash) {
      if (!inTrash.has(id)) { cleanedTrash.push(id); inTrash.add(id); changed = true; }
    }
    _data.trashOrder = cleanedTrash;

    if (changed) _globalDirty = true;
    return changed;
  }

  function _webdavApplyGlobal(remote) {
    if (!_data) return;
    // 【单一裁判·第一刀】结构总账(CRDT)就绪时：顺序/笔记本/模板的唯一权威 = 总账
    //   （本周期稍后 _applyStructLedgerToData 落地）。这里**不再**用网盘清单"远端优先"覆盖结构，
    //   杜绝"网盘先按远端排一遍→账本再纠正"的双裁判闪跳/互踩。
    //   总账未就绪(旧数据/未生根/旧版云端)时回退旧的"远端优先并集"兜底，保证单设备/异步也能同步结构。
    //   两种模式都处理：设置、回收站顺序、墓碑（可加性安全）。
    const ledgerAuthoritative = !!(window.__wsdoc && window.__wsdoc.ready && window.__wsdoc.ready() && _data.structLedger);
    const localPrefs = {};
    for (const k of LOCAL_ONLY_SETTINGS) {
      if (_data.settings && _data.settings[k] !== undefined) localPrefs[k] = _data.settings[k];
    }
    if (_data.settings) {
      for (const k in _data.settings) {
        if (LOCAL_ONLY_PREFIX.some(p => k.startsWith(p))) localPrefs[k] = _data.settings[k];
      }
    }
    // 回收站顺序（总账不重建其排序）+ 笔记本/模板墓碑（合并远端墓碑，剔除被删项）→ 两种模式都执行。
    if (remote.trashOrder) _data.trashOrder = _mergeIdOrder(remote.trashOrder, _data.trashOrder);
    if (remote.wsDeleted) _data.wsTombstones = { ...(_data.wsTombstones || {}), ...remote.wsDeleted };
    if (remote.tplDeleted) _data.tplTombstones = { ...(_data.tplTombstones || {}), ...remote.tplDeleted };
    if (!ledgerAuthoritative) {
      // 兜底（无总账）：保留远端「笔记本/模板」并集；本地独有 id 一律保留不抹掉。
      //   顺序单权威收口：**不再读 manifest 的 rootOrder**。顺序统一由下方 reconcileStructure() 按 frac 推导，
      //   不论账本引擎本周期是否就绪都走同一条路 → 根除"就绪用 frac、没就绪用 manifest"二选一造成的偶发乱序。
      if (remote.workspaces) {
        const tomb = _data.wsTombstones || {};
        let merged = _mergeById(remote.workspaces, _data.workspaces).filter(w => !tomb[w.id]);
        if (!merged.length) merged = [{ id: 'ws-default', name: '默认笔记本', icon: '📒' }];
        _data.workspaces = merged;
      }
      if (remote.templates) {
        const tt = _data.tplTombstones || {};
        _data.templates = _mergeById(remote.templates, _data.templates).filter(t => !tt[t.id]);
      }
    } else {
      // 总账权威：rootOrder 交给总账重建（不动）；笔记本/模板只做**存在性兜底**——
      //   本地优先合并、只把远端独有项补进来（绝不用清单覆盖总账已定的名字/顺序），
      //   免得刚下载的笔记因 workspaceId 本地缺失被 reconcile 误塞当前本子。与 _webdavMergeWorkspaces 同策略。
      if (remote.workspaces) {
        const tomb = _data.wsTombstones || {};
        let merged = _mergeById(_data.workspaces, remote.workspaces).filter(w => !tomb[w.id]);
        if (!merged.length) merged = [{ id: 'ws-default', name: '默认笔记本', icon: '📒' }];
        _data.workspaces = merged;
      }
      if (remote.templates) {
        const tt = _data.tplTombstones || {};
        _data.templates = _mergeById(_data.templates, remote.templates).filter(t => !tt[t.id]);
      }
    }
    if (remote.settings) {
      const rs = { ...remote.settings };
      delete rs.pinned; // legacy 置顶列表，已迁 note.pinnedAt
      _data.settings = { ...(_data.settings || {}), ...rs };
    }
    Object.assign(_data.settings, localPrefs);
    // 当前激活笔记本若已被删除，回落到第一个有效笔记本
    if (!_data.workspaces.some(w => w.id === _data.settings.activeWorkspace)) {
      _data.settings.activeWorkspace = _data.workspaces[0].id;
    }
    reconcileStructure();
    save({ immediate: true });
    emit('change', { type: 'global-sync' });
  }

  /**
   * 仅并入远端「笔记本 / 模板」（含墓碑过滤），不动 rootOrder / settings。
   * 关键：即使本地 globalDirty（整体全局应用被跳过），也要先并入笔记本，
   * 否则刚下载的远端笔记因 workspaceId 在本地不存在，会被 reconcileStructure 统一塞进当前笔记本。
   * union 合并是非破坏性的（不会丢本地独有项），所以任何时候调用都安全。
   */
  function _webdavMergeWorkspaces(remoteWs, remoteWsDeleted, remoteTpl, remoteTplDeleted) {
    if (!_data) return false;
    let changed = false;
    if (remoteWsDeleted) _data.wsTombstones = { ...(_data.wsTombstones || {}), ...remoteWsDeleted };
    if (Array.isArray(remoteWs)) {
      const tomb = _data.wsTombstones || {};
      // 【Stage B 收口】**本地优先**：笔记本的名字/图标/顺序唯一权威 = 结构总账（已在本周期 _mergeLedgerIntoData
      //   里设成权威）。本函数只负责"存在性兜底"——把远端独有的笔记本补进来，免得刚下载的笔记因 workspaceId
      //   本地缺失被 reconcile 误塞进当前本子。绝不用网盘清单(manifest)里的版本覆盖总账已定的名字/顺序，
      //   否则就是「按篇笔记」之外的第二处双通道互踩（改名/重排会反复跳）。改名必同步进总账(emit('workspaces')→调度总账)。
      let merged = _mergeById(_data.workspaces, remoteWs).filter(w => !tomb[w.id]);
      if (!merged.length) merged = [{ id: 'ws-default', name: '默认笔记本', icon: '📒' }];
      if (JSON.stringify(merged) !== JSON.stringify(_data.workspaces)) { _data.workspaces = merged; changed = true; }
    }
    if (remoteTplDeleted) _data.tplTombstones = { ...(_data.tplTombstones || {}), ...remoteTplDeleted };
    if (Array.isArray(remoteTpl)) {
      const tt = _data.tplTombstones || {};
      const merged = _mergeById(_data.templates, remoteTpl).filter(t => !tt[t.id]); // 本地优先，同上
      if (JSON.stringify(merged) !== JSON.stringify(_data.templates)) { _data.templates = merged; changed = true; }
    }
    return changed;
  }

  function _webdavStoreImage(hash, dataUrl) {
    if (_imgCache[hash]) return;
    _imgCache[hash] = dataUrl;
    _imgPersistSafe(hash, dataUrl); // legacy 后端内部自带 save({immediate:true})，与旧行为一致
    // 通知编辑器：新图已落地 → 把当前笔记里还是占位的这张补显（覆盖"笔记已打开、图片随后才同步到"的情形）
    emit('image-stored', { hash });
  }

  function _emitCloudSync(payload) {
    emit('cloud-sync', payload);
  }

  let _switchingMethod = false;

  async function switchSyncMethod(method, config) {
    _switchingMethod = true;
    try {
      if (window.webdavSync && window.webdavSync.stop) window.webdavSync.stop();

      if (method === 'webdav') {
        if (config.webdavUrl) setSetting('webdavUrl', config.webdavUrl);
        if (config.webdavUser) setSetting('webdavUser', config.webdavUser);
        if (config.webdavPass) setSetting('webdavPass', config.webdavPass);
        if (config.webdavProvider) setSetting('webdavProvider', config.webdavProvider);
        if (config.webdavEncryptNotes !== undefined) setSetting('webdavEncryptNotes', config.webdavEncryptNotes);
        if (config.webdavProvider) {
          const pk = 'webdav_' + config.webdavProvider + '_';
          if (config.webdavUrl) setSetting(pk + 'url', config.webdavUrl);
          if (config.webdavUser) setSetting(pk + 'user', config.webdavUser);
          if (config.webdavPass) setSetting(pk + 'pass', config.webdavPass);
        }
      }
      setSetting('syncMethod', method);
      save({ immediate: true });

      if (config && config.autoStart === false) return;

      if (method === 'webdav' && window.webdavSync) {
        await window.webdavSync.loadConfig();
        window.webdavSync.startAutoSync();
      }
    } finally {
      _switchingMethod = false;
      // 网盘配置变了 → 即时同步重判启用条件（仅配好网盘才启用；账号变则房间号变）
      try { window.realtime && window.realtime.applyConfig && window.realtime.applyConfig(); } catch (_) {}
    }
  }

  // 每台设备各自的偏好 / UI 状态：绝不随云端覆盖（否则会出现"另一台设备改了本机就被拉回"的问题）。
  const LOCAL_ONLY_SETTINGS = [
    'theme', 'fontSize', 'fontFamily', 'sidebarCollapsed', 'outlineCollapsed', 'showTrashBadge', 'syncMethod',
    'noteTransition', 'editorPadding', 'sidebarWidth', 'outlineOpen',
    'activeWorkspace', 'lastOpenedId', 'recent',
    'webdavProxy', // 跨域代理前缀：每台设备各自配置（桌面直连不需要），绝不上云
    'imagesDir',   // 图片文件夹：本机路径，跨设备无意义，绝不上云
    'webdavCryptoPass', // 加密口令：manifest 是明文，绝不能经云端 settings 泄漏；只走本机/配置导出
    'pinned', // 置顶已迁到 note.pinnedAt（20260622）；legacy 列表不再同步，防旧端覆盖
  ];
  // 'webdav_' 前缀=同步配置；'_' 前缀=内部迁移标记，都只留本机
  const LOCAL_ONLY_PREFIX = ['webdav_', '_'];

  function markDirty() {
    const method = getSetting('syncMethod') || 'none';
    if (method === 'none') return;
    if (method === 'webdav' && window.webdavSync) {
      window.webdavSync.schedulePut();
    }
  }

  async function flushBeforeHide() {
    const method = getSetting('syncMethod') || 'none';
    if (method === 'none') return;
    if (method === 'webdav' && window.webdavSync) {
      window.webdavSync.flushPutOnHide();
    }
  }

  async function startAutoSync() {
    const method = getSetting('syncMethod') || 'none';
    if (method === 'none') return;
    if (method === 'webdav' && window.webdavSync) {
      window.webdavSync.startAutoSync();
    }
  }

  return {
    init, getAll, get, isNoteDeleted, _setNoteYdoc, getLocalImage, loadImage, loadImages, expandLocalImages, ingestImageDataUrl, getChildren, getAncestors,
    // 图片外置后端（阶段A）
    imagesReady: () => _imgReadyPromise,
    imagesPrimaryReady: () => _imgPrimaryReadyPromise,
    getImageMap: () => _imgCache,
    getImagesBackendInfo: () => ({ backend: _imgBackend, dir: _imgDir }),
    setImagesDir,
    create, rename, updateDoc, setColor, setIcon, setPinned, isPinned, getPinnedNotes, setExpanded, collapseAll, expandAll, hasExpandedNodes,
    remove, restoreFromTrash, purgeFromTrash, emptyTrash,
    move, moveToWorkspace,
    getSetting, setSetting,
    getTemplates, saveTemplate, deleteTemplate,
    searchAll,
    getWorkspaces, getActiveWorkspace, setActiveWorkspace, createWorkspace, renameWorkspace, setWorkspaceIcon, deleteWorkspace,
    exportJSON, importJSON, exportCurrentNoteMd, exportAllAsTree,
    startAutoSync, markDirty, flushBeforeHide,
    isDirty: () => _dirtyNoteIds.size > 0 || _globalDirty,
    save,
    on,
    isQuicker,
    // WebDAV sync support
    getDirtyNoteIds, clearDirtyNoteIds, removeDirtyNoteIds, markNotesDirtyByIds, markAllNotesDirty, isGlobalDirty, clearGlobalDirty,
    getDataFormatVersion, migrateNotesToDoc,
    switchSyncMethod, reconcileStructure,
    _webdavApplyNote, _webdavRemoveNote, _webdavApplyGlobal, _webdavMergeWorkspaces, _webdavStoreImage, _emitCloudSync, _realtimeApply, _realtimeMaterializeNote,
    // 方案2 结构底稿（影子阶段，仅供验证/调试）
    _buildStructSnapshot, _structLedger: () => _data && _data.structLedger, _maintainStructLedgerNow: _maintainStructLedger,
    // 方案2 wire-sync：结构总账同步层接口（统一收口创世/认领规则）
    _webdavGetStructLedger, _webdavApplyStructLedger, _webdavMarkStructLedgerRooted, _webdavRebuildStructLedgerFresh, _webdavReplaceStructLedger,
    // 方案2 第2步：总账落地（当结构/元数据权威）
    _mergeLedgerIntoData, _applyStructLedgerToData,
  };
})();

window.storage = storage;
