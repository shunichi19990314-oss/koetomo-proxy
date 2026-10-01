"use strict";
/*!
 * koetomo-hub — リバーストンネル方式の「待ち合わせサーバ」
 * ============================================================================
 * 声とも(koetomo.fun)は日本国外IPを 403 で拒否し、Render には日本リージョンが無い。
 * クレジットカード無しで日本の出口を作るには「日本にある自分のマシン」を出口にするのが
 * 確実だが、家庭回線には グローバルIPが無い(CGNAT) / ポート開放が必要 という壁がある。
 * このハブはその壁を無くす「外向き接続だけで成立する中継点」。
 *
 *   [日本のマシン relay/reverse-tunnel.js] --外向き WSS 常時接続(開放不要)--> [このハブ = Render]
 *   [Render のプロキシ server.js] --トンネル要求--> [ハブ] --ペアリング--> [日本のマシン] --> koetomo.fun
 *
 * ハブは TCP バイトを素通しするだけ。声ともの TLS は プロキシ ⇔ koetomo.fun の
 * エンドツーエンドなので、日本のマシンもハブも中身を復号できない(覗けない)。
 *
 * プロトコル(すべて /__tunnel への WebSocket。最初の1メッセージだけ JSON 制御):
 *   日本側① {type:"register",      mode:"relay", token, name}   → 常時接続・在線登録
 *   日本側② {type:"relay-tunnel-ready", mode:"relay", token}     → 「すぐ使える」待機ソケット
 *          ← {type:"tunnel-go", host, port}  收到後、日本から dial してバイトを流す
 *   プロキシ {type:"connect", mode:"proxy", token, host, port}   → 待機ソケットと即ペアリング
 *   待機ソケットが足りない場合はハブが要求をキューイングし、次の ready 到着時に配对する。
 *
 * 起動:  node tunnel/hub.js   (単独サービスとして Render にデプロイ可能)
 *        既定は server.js に内蔵(同じコードを attachHub で読み込む)
 *
 * 環境変数:
 *   PORT          待ち受けポート(既定 10000 / Render が渡す)
 *   TUNNEL_TOKEN  共有シークレット(未設定ならトンネル機能は無効)
 *   TUNNEL_PATH   WS エンドポイント(既定 /__tunnel)
 *   RELAY_ALLOW   接続を許可するホスト(既定 koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org)
 *   TUNNEL_MAX    同時トンネル上限(既定 64)
 */

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = (process.env.TUNNEL_TOKEN || "").trim();
const WS_PATH = process.env.TUNNEL_PATH || "/__tunnel";
const ALLOW = (process.env.RELAY_ALLOW || "koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_TUNNELS = Number(process.env.TUNNEL_MAX || 64);
const PAIR_TIMEOUT = Number(process.env.TUNNEL_PAIR_TIMEOUT || 15_000);
// 日本のマシンが1台も居ないときの待ち時間(Render のスリープ復帰→再接続を待つ猶予)
const NO_RELAY_TIMEOUT = Number(process.env.TUNNEL_NO_RELAY_TIMEOUT || 25_000);
const HIGH_WATER = 4 * 1024 * 1024;

const STARTED = Date.now();
const DBG = process.env.HUB_DEBUG === "1" || process.env.TUNNEL_DEBUG === "1";
const log = (...a) => console.log(new Date().toISOString(), "[koetomo-hub]", ...a);

const relays = new Map();     // id -> { ws, name, ip, since, pool:Set<ws> }
const readyPool = new Set();  // すぐに配对できる待機ソケット(日本側)
const pending = [];           // 待機ソケット待ちのプロキシ要求 { ws, host, port, timer }
let tunnelCount = 0;
let seq = 0;

function hostAllowed(hostname) {
  const h = String(hostname || "").toLowerCase();
  return ALLOW.some((s) => h === s || h.endsWith("." + s));
}

function sendControl(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

function hubStats() {
  return {
    enabled: Boolean(TOKEN),
    relays: [...relays.values()].map((r) => ({
      name: r.name, ip: r.ip, since: new Date(r.since).toISOString(),
      uptimeSec: Math.round((Date.now() - r.since) / 1000), readySockets: r.pool.size,
    })),
    readySockets: readyPool.size,
    waitingRequests: pending.length,
    activeTunnels: tunnelCount,
    allow: ALLOW,
    uptimeSec: Math.round((Date.now() - STARTED) / 1000),
  };
}

/** トンネル確立後: 2本の WebSocket をバイナリフレームで素通しにする */
let pairSeq = 0;
function pairSockets(wsA, wsB, label) {
  tunnelCount++;
  const pid = "p" + (++pairSeq);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    tunnelCount--;
    if (DBG) log(`${pid} tunnel closed (${label}) | active=${tunnelCount}`);
    try { wsA.close(1000, "tunnel closed"); } catch {}
    try { wsB.close(1000, "tunnel closed"); } catch {}
  };

  const pipe = (from, to) => {
    let paused = false;
    from.on("message", (data, isBinary) => {
      if (closed || !isBinary) return;
      if (to.readyState !== WebSocket.OPEN) { if (DBG) log(`${pid} DROP ${buf.length}B (to.readyState=${to.readyState})`); return close(); }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      to.send(buf, { binary: true }, (err) => { if (err) close(); });
      // 逆圧: 送信バッファが溜まったら相手の受信を止める
      if (!paused && to.bufferedAmount > HIGH_WATER) {
        paused = true;
        try { from.pause(); } catch {}
        const t = setInterval(() => {
          if (closed) { clearInterval(t); return; }
          if (to.bufferedAmount <= HIGH_WATER / 2) {
            clearInterval(t);
            paused = false;
            try { from.resume(); } catch {}
          }
        }, 40);
        t.unref?.();
      }
    });
  };

  pipe(wsA, wsB);
  pipe(wsB, wsA);
  for (const s of [wsA, wsB]) { s.once("close", close); s.once("error", close); }
  if (label) log(`tunnel paired (${label}) | active=${tunnelCount}`);
  return close;
}

/** 待機中のプロキシ要求があれば、到着した ready ソケットと配对する */
function tryPairReady(relayWs) {
  const req = pending.shift();
  if (!req) return false;
  clearTimeout(req.timer);
  sendControl(relayWs, { type: "tunnel-go", host: req.host, port: req.port });
  sendControl(req.ws, { type: "connected", host: req.host, port: req.port });
  pairSockets(req.ws, relayWs, `${req.host}:${req.port}`);
  return true;
}

function registerRelay(ws, msg, ip) {
  // 同名のリレーが再接続してきた場合、古いエントリを閉じてから登録する
  // (Render のスリープ復帰直後に二重登録されて /__status が見にくくなるのを防ぐ)
  const name = String(msg.name || "").slice(0, 64);
  for (const [oldId, old] of relays) {
    if (name && old.name === name && old.ws !== ws) {
      log(`relay re-registered: ${name} (古い接続をクローズ)`);
      relays.delete(oldId);
      for (const s of old.pool) { readyPool.delete(s); try { s.close(1000, "replaced"); } catch {} }
      old.pool.clear();
      try { old.ws.close(1000, "replaced"); } catch {}
    }
  }
  const id = `r${++seq}`;
  const rec = { id, ws, name: String(msg.name || id).slice(0, 64), ip, since: Date.now(), pool: new Set() };
  relays.set(id, rec);
  log(`relay online: ${rec.name} (${ip}) | relays=${relays.size}`);
  sendControl(ws, { type: "relay-ready", id, name: rec.name, allow: ALLOW, maxTunnels: MAX_TUNNELS, poolSize: Number(msg.poolSize || 0) });

  const bye = () => {
    if (!relays.has(id)) return;
    relays.delete(id);
    for (const s of rec.pool) { readyPool.delete(s); try { s.close(1001, "relay offline"); } catch {} }
    rec.pool.clear();
    log(`relay offline: ${rec.name} | relays=${relays.size} ready=${readyPool.size}`);
  };
  ws.on("close", bye);
  ws.on("error", bye);
}

/** 「すぐ使える」待機ソケットの登録 */
function acceptReadySocket(ws, msg, ip, relayRec) {
  const bye = () => {
    if (readyPool.delete(ws)) log(`ready socket dropped | ready=${readyPool.size}`);
    if (relayRec) relayRec.pool.delete(ws);
  };
  ws.once("close", bye);
  ws.once("error", bye);

  if (tryPairReady(ws)) {
    // 待っていたプロキシ要求と即配对 → 日本のマシンに補充を促す
    if (relayRec) relayRec.pool.delete(ws);
    sendControl(relayRec ? relayRec.ws : null, { type: "replenish" });
    for (const r of relays.values()) if (r !== relayRec) sendControl(r.ws, { type: "replenish" });
    return;
  }
  readyPool.add(ws);
  if (relayRec) relayRec.pool.add(ws);
  sendControl(ws, { type: "standby" });
  log(`ready socket accepted from ${ip} | ready=${readyPool.size}`);
}

/** プロキシからのトンネル要求 */
function handleProxyConnect(ws, msg, ip) {
  const host = String(msg.host || "").toLowerCase();
  const port = Number(msg.port || 0);
  const fail = (message, code = 1013) => {
    sendControl(ws, { type: "error", message });
    try { ws.close(code, String(message).slice(0, 100)); } catch {}
  };

  if (!host || !port) return fail("host/port required", 1008);
  if (!hostAllowed(host)) return fail(`destination not allowed: ${host}:${port}`, 1008);
  if (tunnelCount >= MAX_TUNNELS) return fail("too many tunnels");

  // 待機ソケットがあれば即座に配对
  for (const rws of readyPool) {
    if (rws.readyState !== WebSocket.OPEN) { readyPool.delete(rws); continue; }
    const rec = [...relays.values()].find((r) => r.pool.has(rws));
    readyPool.delete(rws);
    if (rec) rec.pool.delete(rws);
    if (DBG) log(`pair ${host}:${port} with ready socket (ready=${readyPool.size})`);
    sendControl(rws, { type: "tunnel-go", host, port });
    sendControl(ws, { type: "connected", host, port });
    pairSockets(ws, rws, `${host}:${port}`);
    sendControl(rec ? rec.ws : null, { type: "replenish" });
    return;
  }

  // 待機ソケットが無い(= 日本のマシンが未接続 / Render のスリープ復帰直後)場合は
  // すぐ失敗させずに少し待ちます。日本のマシンは数秒以内に自動で再接続してきます。
  const waitMs = relays.size === 0 ? NO_RELAY_TIMEOUT : PAIR_TIMEOUT;
  const item = { ws, host, port, timer: null };
  item.timer = setTimeout(() => {
    const i = pending.indexOf(item);
    if (i >= 0) pending.splice(i, 1);
    fail(relays.size === 0
      ? "no relay online (日本のマシンが未接続です)"
      : "no ready tunnel socket (日本のマシンの待機ソケットが足りません)");
  }, waitMs);
  item.timer.unref?.();
  ws.once("close", () => {
    clearTimeout(item.timer);
    const i = pending.indexOf(item);
    if (i >= 0) pending.splice(i, 1);
  });
  pending.push(item);
  for (const r of relays.values()) sendControl(r.ws, { type: "replenish" });
  log(`proxy request queued ${host}:${port} from ${ip} | waiting=${pending.length}`);
}

/** ハブの WS 端点。server.js(内蔵)からも standalone でも同じ関数を使う */
function handleHubSocket(ws, req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    sendControl(ws, { type: "error", message: "first control message timeout" });
    try { ws.close(1008, "handshake timeout"); } catch {}
  }, 15_000);
  timer.unref?.();

  ws.once("message", (data) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);

    let msg;
    try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)); }
    catch { sendControl(ws, { type: "error", message: "invalid control frame" }); return ws.close(1008); }

    if (!TOKEN) { sendControl(ws, { type: "error", message: "tunnel disabled (TUNNEL_TOKEN not set)" }); return ws.close(1008); }
    if (String(msg.token || "") !== TOKEN) {
      log(`auth rejected from ${ip} (type=${msg.type})`);
      sendControl(ws, { type: "error", message: "unauthorized" });
      return ws.close(1008, "unauthorized");
    }

    if (DBG) log(`ctl from ${ip}: ${JSON.stringify(msg).slice(0, 160)}`);
    if (msg.type === "register") return registerRelay(ws, msg, ip);
    if (msg.type === "relay-tunnel-ready") {
      const rec = [...relays.values()].find((r) => r.name === msg.name);
      return acceptReadySocket(ws, msg, ip, rec);
    }
    if (msg.type === "connect" && msg.mode === "proxy") return handleProxyConnect(ws, msg, ip);

    sendControl(ws, { type: "error", message: "unknown control message" });
    ws.close(1008);
  });
}

/** ハブ単体の HTTP ハンドラ */
function hubRequestHandler(req, res) {
  const u = req.url.split("?")[0];
  if (u === "/__health" || u === "/healthz") {
    res.writeHead(200, [["content-type", "text/plain"]]);
    return res.end("ok");
  }
  if (u === "/__hub") {
    const body = JSON.stringify(hubStats(), null, 2);
    res.writeHead(200, [["content-type", "application/json; charset=utf-8"], ["content-length", Buffer.byteLength(body)]]);
    return res.end(body);
  }
  res.writeHead(404, [["content-type", "text/plain; charset=utf-8"]]);
  res.end(`koetomo-hub: WebSocket 専用サービスです (端点: ${WS_PATH})\n状態: /__hub\n`);
}

/**
 * 既存の http.Server にハブを載せる(server.js 内蔵モード)。
 * @returns {{ upgrade(req,socket,head):boolean, stats():object, enabled:boolean, path:string }}
 */
function attachHub(server, opts = {}) {
  const path = opts.path || WS_PATH;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, clientTracking: false });
  const upgrade = (req, socket, head) => {
    if (!TOKEN) { socket.destroy(); return true; }
    wss.handleUpgrade(req, socket, head, (ws) => handleHubSocket(ws, req));
    return true;
  };
  if (server && typeof server.on === "function") server.on("close", () => { try { wss.close(); } catch {} });
  return { upgrade, stats: hubStats, enabled: Boolean(TOKEN), path };
}

module.exports = { attachHub, hubStats, handleHubSocket, hubRequestHandler, WS_PATH, TOKEN, relays, readyPool };

// ── 単独サービスとして起動する場合(node tunnel/hub.js)──
if (require.main === module) {
  const server = http.createServer(hubRequestHandler);
  const hub = attachHub(server);
  server.on("upgrade", (req, socket, head) => {
    if (req.url.split("?")[0] === hub.path) return hub.upgrade(req, socket, head);
    socket.destroy();
  });
  server.listen(PORT, () => {
    log(`hub listening on :${PORT} | path ${hub.path} | auth: ${TOKEN ? "ON" : "OFF (TUNNEL_TOKEN 未設定=機能停止)"}`);
    log(`allow: ${ALLOW.join(", ")}`);
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => { log(`${sig} received`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
  }
}
