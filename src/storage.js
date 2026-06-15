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
 *   settings: { theme, fontSize, sidebarWidth, lastOpenedId, editorMode, ... },
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
    editorMode: 'wysiwyg',
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
      for (const nid of affectedIds) {
        delete _data.notes[nid];
        _data.rootOrder = (_data.rootOrder || []).filter(x => x !== nid);
      }
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
      const ordered = _data.rootOrder
        .map(id => _data.notes[id])
        .filter(n => n && n.workspaceId === wsId);
      // 兜底：任何「顶级且属于当前笔记本、却没记进 rootOrder」的笔记也要显示，
      // 避免出现「搜索能搜到、左侧却不显示」（rootOrder 偶发漏记导致的笔记隐身）。
      const inRoot = new Set(_data.rootOrder);
      const orphans = [];
      for (const id in _data.notes) {
        const n = _data.notes[id];
        if (n && n.parentId == null && n.workspaceId === wsId && !inRoot.has(id)) {
          orphans.push(n);
          _data.rootOrder.push(id); // 顺手补回，下次起即归位（幂等）
        }
      }
      return orphans.length ? ordered.concat(orphans) : ordered;
    }
    const children = Object.values(_data.notes)
      .filter(n => n.parentId === parentId && n.workspaceId === wsId)
      .sort((a, b) => a.order - b.order);
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

  function recomputeOrder(parentId) {
    const siblings = parentId == null
      ? _data.rootOrder.map(id => _data.notes[id]).filter(Boolean)
      : Object.values(_data.notes).filter(n => n.parentId === parentId).sort((a, b) => a.order - b.order);
    siblings.forEach((n, i) => { n.order = i; });
    if (parentId == null) {
      _data.rootOrder = siblings.map(n => n.id);
    }
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

  /** JSON 存储：写入笔记的 ProseMirror 文档 JSON（唯一事实来源）。
   *  阶段2/3 保留旧 content(md) 作兜底，不在此删除；阶段4 迁移统一清理。 */
  function updateDoc(id, doc) {
    const n = _data.notes[id];
    if (!n || !doc) return;
    ingestDocImages(doc);  // data: → zhinote://，base64 收进本地仓库
    const str = JSON.stringify(doc);
    if (n.doc && JSON.stringify(n.doc) === str) return;  // 无变化，避免空顶 updatedAt
    n.doc = doc;
    n.updatedAt = now();
    save();
    emit('change', { type: 'content', id, silent: true });
    if (typeof markDirty === 'function') markDirty();
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
    for (const nid of ids) delete _data.trash[nid];
    _data.trashOrder = _data.trashOrder.filter(x => x !== id);
    save();
    emit('change', { type: 'purge', id });
  }

  function emptyTrash() {
    const ids = Object.keys(_data.trash);
    _data.trash = {};
    _data.trashOrder = [];
    for (const id of ids) _dirtyNoteIds.add(id); // 让同步据此写墓碑 + 删云端文件，避免清空回收站的笔记复活
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

  function exportJSON() { return JSON.stringify(_data, null, 2); }

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

  function exportAllAsTree({ allWorkspaces = false, imagesAsFiles = false } = {}) {
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
      : [{ id: _data.settings?.activeWorkspace || 'ws-default', name: '' }];
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
    migrate(parsed);
    _data = parsed;
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
    setSaveStatus('saving', '保存中...');
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
      setSaveStatus('saved', '已保存');
    } catch (err) {
      console.error('[storage] 保存失败', err);
      setSaveStatus('error', '保存失败');
    } finally {
      _saveInFlight = false;
      if (_pendingSave) {
        _pendingSave = false;
        const f = _pendingFull; _pendingFull = false;
        _flush({ full: f });
      }
    }
  }

  function setSaveStatus(cls, text) {
    const el = document.getElementById('save-status');
    if (!el) return;
    el.className = 'save-status ' + cls;
    // 用小圆点替代文字，鼠标悬停时显示具体文字
    el.textContent = '●';
    el.title = text || (cls === 'saved' ? '已保存' : cls === 'saving' ? '保存中…' : cls === 'error' ? '保存失败' : '');
    if (cls === 'saved') {
      // 不再回填文字，圆点本身就表达"已保存"
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
    if ((_data.dataFormatVersion || 1) >= 2) return { ran: false, reason: 'already-v2' };
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
    _data.dataFormatVersion = 2;
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
  function _webdavApplyNote(id, noteData) {
    if (!_data.notes) _data.notes = {};
    _data.notes[id] = noteData;
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
    // 2) workspaceId 指向不存在的笔记本 → 落回有效笔记本
    for (const id in _data.notes) {
      const n = _data.notes[id];
      if (n && (!n.workspaceId || !wsIds.has(n.workspaceId))) { n.workspaceId = fallbackWs; changed = true; }
    }
    // 3) rootOrder 只保留"存在且为顶级"的笔记，并去重（重复 id 会让同一篇渲染两次）；
    //    遗漏的顶级笔记补回（核心：修复消失的笔记）
    const _seenRoot = new Set();
    const cleanedRoot = (_data.rootOrder || []).filter(id => {
      if (!_data.notes[id] || _data.notes[id].parentId != null) return false;
      if (_seenRoot.has(id)) return false;
      _seenRoot.add(id);
      return true;
    });
    if (cleanedRoot.length !== (_data.rootOrder || []).length) changed = true;
    const inRoot = new Set(cleanedRoot);
    for (const id in _data.notes) {
      const n = _data.notes[id];
      if (n && n.parentId == null && !inRoot.has(id)) { cleanedRoot.push(id); inRoot.add(id); changed = true; }
    }
    _data.rootOrder = cleanedRoot;
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
    const localPrefs = {};
    for (const k of LOCAL_ONLY_SETTINGS) {
      if (_data.settings && _data.settings[k] !== undefined) localPrefs[k] = _data.settings[k];
    }
    if (_data.settings) {
      for (const k in _data.settings) {
        if (LOCAL_ONLY_PREFIX.some(p => k.startsWith(p))) localPrefs[k] = _data.settings[k];
      }
    }
    // 合并而非覆盖：远端优先（保留远端顺序/重命名），但本地独有的 id 一律保留，绝不抹掉。
    // 这样另一台设备刚建、本机还没拿到 rootOrder 记录的笔记，不会被这次应用顶掉。
    if (remote.rootOrder) _data.rootOrder = _mergeIdOrder(remote.rootOrder, _data.rootOrder);
    if (remote.trashOrder) _data.trashOrder = _mergeIdOrder(remote.trashOrder, _data.trashOrder);
    // 笔记本墓碑：合并远端墓碑，并据此剔除被删除的笔记本（防止删掉的笔记本被拉回）
    if (remote.wsDeleted) _data.wsTombstones = { ...(_data.wsTombstones || {}), ...remote.wsDeleted };
    if (remote.workspaces) {
      const tomb = _data.wsTombstones || {};
      let merged = _mergeById(remote.workspaces, _data.workspaces).filter(w => !tomb[w.id]);
      if (!merged.length) merged = [{ id: 'ws-default', name: '默认笔记本', icon: '📒' }];
      _data.workspaces = merged;
    }
    if (remote.tplDeleted) _data.tplTombstones = { ...(_data.tplTombstones || {}), ...remote.tplDeleted };
    if (remote.templates) {
      const tt = _data.tplTombstones || {};
      _data.templates = _mergeById(remote.templates, _data.templates).filter(t => !tt[t.id]);
    }
    if (remote.settings) _data.settings = { ...(_data.settings || {}), ...remote.settings };
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
      let merged = _mergeById(remoteWs, _data.workspaces).filter(w => !tomb[w.id]);
      if (!merged.length) merged = [{ id: 'ws-default', name: '默认笔记本', icon: '📒' }];
      if (JSON.stringify(merged) !== JSON.stringify(_data.workspaces)) { _data.workspaces = merged; changed = true; }
    }
    if (remoteTplDeleted) _data.tplTombstones = { ...(_data.tplTombstones || {}), ...remoteTplDeleted };
    if (Array.isArray(remoteTpl)) {
      const tt = _data.tplTombstones || {};
      const merged = _mergeById(remoteTpl, _data.templates).filter(t => !tt[t.id]);
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
    }
  }

  // 每台设备各自的偏好 / UI 状态：绝不随云端覆盖（否则会出现"另一台设备改了本机就被拉回"的问题）。
  const LOCAL_ONLY_SETTINGS = [
    'theme', 'fontSize', 'fontFamily', 'sidebarCollapsed', 'outlineCollapsed', 'showTrashBadge', 'syncMethod',
    'noteTransition', 'editorPadding', 'sidebarWidth', 'editorMode', 'outlineOpen',
    'activeWorkspace', 'lastOpenedId', 'recent',
    'webdavProxy', // 跨域代理前缀：每台设备各自配置（桌面直连不需要），绝不上云
    'imagesDir',   // 图片文件夹：本机路径，跨设备无意义，绝不上云
    'webdavCryptoPass', // 加密口令：manifest 是明文，绝不能经云端 settings 泄漏；只走本机/配置导出
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
    init, getAll, get, getLocalImage, loadImage, loadImages, expandLocalImages, ingestImageDataUrl, getChildren, getAncestors,
    // 图片外置后端（阶段A）
    imagesReady: () => _imgReadyPromise,
    imagesPrimaryReady: () => _imgPrimaryReadyPromise,
    getImageMap: () => _imgCache,
    getImagesBackendInfo: () => ({ backend: _imgBackend, dir: _imgDir }),
    setImagesDir,
    create, rename, updateDoc, setColor, setIcon, setExpanded, collapseAll, expandAll, hasExpandedNodes,
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
    _webdavApplyNote, _webdavRemoveNote, _webdavApplyGlobal, _webdavMergeWorkspaces, _webdavStoreImage, _emitCloudSync,
  };
})();

window.storage = storage;
