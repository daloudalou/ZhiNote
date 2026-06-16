/**
 * 枝记 Service Worker — PWA 离线外壳
 *
 * 策略（按请求类型分流）：
 * - 页面导航（HTML）：缓存优先 + 后台静默更新 → 秒开（不必每次启动等 2MB 下载完才渲染，
 *   这正是此前白屏/黑屏几秒的根因）；后台拉到新版本后，下次启动生效。
 * - 其余同源资源：缓存优先 + 后台静默更新（stale-while-revalidate）→ 秒开，新版本下次启动生效。
 * - 跨域请求（CDN 依赖 / WebDAV / 代理）：完全不拦截，交给浏览器自身的 HTTP 缓存与网络。
 *   网盘数据绝不能被 SW 缓存，否则会读到陈旧的同步状态。
 *
 * v1.0.200 由发布脚本替换为版本号；版本变化 → 缓存名变化 → 旧缓存在 activate 时清除。
 */
const VERSION = 'v1.0.200';
const CACHE = 'zhinote-' + VERSION;

self.addEventListener('install', (e) => {
  // 预缓存入口页：版本更新后新缓存不为空，下次启动仍然秒开（否则要回退一次全量网络加载）
  e.waitUntil((async () => {
    try {
      const resp = await fetch('./', { cache: 'no-cache' });
      if (resp && resp.ok) await (await caches.open(CACHE)).put('./', resp);
    } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('zhinote-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域不拦截

  // 页面导航 + 静态资源统一：缓存优先 + 后台更新（秒开；新版本下次启动生效）
  e.respondWith((async () => {
    // 导航请求可能带查询串（如 PWA 启动参数），匹配不到时回退到预缓存的入口页 './'
    const cached = (await caches.match(req))
      || (req.mode === 'navigate' ? await caches.match('./') : null);
    const refresh = fetch(req).then(async (resp) => {
      if (resp && resp.ok) (await caches.open(CACHE)).put(req, resp.clone());
      return resp;
    }).catch(() => null);
    if (cached) {
      e.waitUntil(refresh); // 缓存命中也让后台更新跑完，别被 SW 提前休眠掐断
      return cached;
    }
    const fresh = await refresh;
    if (fresh) return fresh;
    return new Response(req.mode === 'navigate' ? '离线，且本地暂无缓存版本' : '', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
