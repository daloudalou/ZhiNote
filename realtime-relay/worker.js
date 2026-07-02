/**
 * 枝记 实时同步中转 — Cloudflare Worker + Durable Object（免费版即可）
 *
 * 作用：两台设备打开同一篇笔记时，谁一保存，改动经本中转站「即时」转给对方（1~2 秒），
 *       比网盘轮询（10~30 秒）快得多。网盘照旧兜底，中转断了只是退回网盘、绝不丢数据。
 *
 * 隐私：本中转只转发「不透明的密文字节」——客户端用你的同步口令把内容加密后才发出，
 *       中转站看不到笔记明文（与跨域代理同级的零知识模型）。房间号也由口令哈希得出，
 *       没有口令的人既猜不到房间、也解不开内容。
 *
 * 数据：中转只在「房间有人」时临时存一份最新快照用于让后到的设备追上进度；
 *       房间空了立即删除。真正的存档永远是你的网盘，本中转不长期保存任何东西。
 *
 * 成本：免费版用 WebSocket 休眠（Hibernation）—— 连接挂着不发消息时不计费、不占时长配额；
 *       到达免费上限当天，客户端自动退回网盘同步，第二天恢复。
 *
 * 部署：见同目录 README.md（Wrangler 一条命令，或「Deploy to Cloudflare」按钮）。
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查 / 根路径：方便部署后用浏览器点开确认「活着」
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('ZhiNote realtime relay OK', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // 仅接受 /room/<房间号>，房间号是客户端用口令哈希出的不透明串
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,128})$/);
    if (!m) return new Response('not found', { status: 404 });

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    // 同一房间号 → 同一个 Durable Object 实例（房间）
    const id = env.ROOMS.idFromName(m[1]);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

/**
 * 一个 Room = 一篇笔记的实时房间。用 WebSocket 休眠 API，省配额。
 * 模型极简：只保留「最近一份完整快照」。
 *   - 新设备进来 → 把这份快照发给它，让它瞬间追上进度；
 *   - 任意设备发来新快照 → 覆盖保存 + 转发给房间内其它设备；
 *   - 房间空了 → 删掉快照（临时存储归零）。
 * 快照对中转是不透明字节（客户端已加密），中转不解析、不合并、不关心内容。
 */
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // 休眠式接受：连接挂着不计时长费；醒来时 getWebSockets() 仍能拿到全部连接
    this.ctx.acceptWebSocket(server);

    // 把房间当前最新快照发给刚进来的设备（让它立刻追上）
    try {
      const latest = await this.ctx.storage.get('latest');
      if (latest) server.send(latest);
    } catch (_) {}

    // 广播「房间真实人数」给所有人（含刚进来的这台）：服务器手握全部连接，是在场状态的权威来源。
    //   客户端据此即时、可靠地点亮/熄灭紫点，不再靠心跳超时猜测。控制消息用 {__zr:'occ',n}，
    //   与不透明密文（base64，不以 '{' 开头）天然区分；旧客户端不认识会忽略，向后兼容。
    this._broadcastOcc();

    return new Response(null, { status: 101, webSocket: client });
  }

  // 把当前房间人数广播给全部在线连接（可传入已算好的列表，省一次 getWebSockets）。
  _broadcastOcc(list) {
    const peers = list || this.ctx.getWebSockets();
    let msg;
    try { msg = JSON.stringify({ __zr: 'occ', n: peers.length }); } catch (_) { return; }
    for (let i = 0; i < peers.length; i++) {
      try { peers[i].send(msg); } catch (_) {}
    }
  }

  async webSocketMessage(ws, msg) {
    // 中转对内容不透明：字符串（base64 密文）或二进制都原样转发。
    // 存一份最新快照（仅房间存活期间临时存，给后到的设备引导用）。
    // 超大快照不落库（仍正常实时转发），避免触碰单值存储上限。
    try {
      const size = typeof msg === 'string' ? msg.length : (msg.byteLength || 0);
      if (size > 0 && size <= 1900000) {
        await this.ctx.storage.put('latest', msg);
      }
    } catch (_) {}

    // 转发给房间内其它设备
    const peers = this.ctx.getWebSockets();
    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i];
      if (peer !== ws) {
        try { peer.send(msg); } catch (_) {}
      }
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch (_) {}
    // 房间空了 → 删除临时快照（存档在网盘，这里不留痕）；否则把「少了一个」即时广播给剩下的人。
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (remaining.length === 0) {
      try { await this.ctx.storage.delete('latest'); } catch (_) {}
    } else {
      this._broadcastOcc(remaining);
    }
  }

  async webSocketError(ws) {
    try { ws.close(); } catch (_) {}
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (remaining.length > 0) this._broadcastOcc(remaining);
  }
}
