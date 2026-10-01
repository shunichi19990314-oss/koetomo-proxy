"use strict";
/*!
 * koetomo-relay(リバーストンネル版)— 日本のマシンで動かす「出口」
 * ============================================================================
 * クレジットカード不要・クラウド不要・ポート開放不要・グローバルIP不要(CGNAT可)。
 *
 *   ブラウザ → Render(koetomo.onrender.com)
 *                 └→ ハブ(/__tunnel) → このプログラム(日本の自宅PC等) → koetomo.fun
 *
 * このプログラムは Render のハブへ【外向き】の WebSocket を張るだけです。
 * ハブから「koetomo.fun:443 に繋いで」と頼まれたら日本の回線から dial し、
 * TCP バイトを WebSocket にそのまま流します。
 * 声ともの TLS は Render ⇔ koetomo.fun のエンドツーエンドなので、
 * このマシンは暗号化されたバイト列を中継するだけで中身を見られません。
 *
 * 必要環境: Node.js 20 以上
 *   ・Node 22+ なら組み込み WebSocket で依存ゼロ
 *   ・Node 20/21 は ws パッケージが必要(relay/ で npm install、またはリポジトリ直下の npm install)
 *
 * 環境変数:
 *   HUB_URL        必須。ハブの WS URL(例 wss://koetomo.onrender.com/__tunnel)
 *   TUNNEL_TOKEN   必須。Render の TUNNEL_TOKEN と同じ値
 *   RELAY_NAME     任意。/__status に出る表示名(既定 ホスト名)
 *   RELAY_POOL     待機ソケット数(既定 4。大きいほど同時接続の立ち上がりが速い)
 *   RELAY_ALLOW    接続を許可するホスト(既定 koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org)
 *   RELAY_PORTS    接続を許可するポート(既定 443,80)
 *   RELAY_LOCAL    1 で 127.0.0.x / localhost も許可(自動テスト用)
 *   RELAY_VERBOSE  1 で詳細ログ
 *
 * 実行:
 *   HUB_URL=wss://... TUNNEL_TOKEN=... node relay/reverse-tunnel.js
 *   常駐化:  bash relay/setup-reverse-tunnel.sh   (systemd 登録まで自動)
 */

const net = require("net");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");

// ───────────────────────── WebSocket 実装の解決 ─────────────────────────
// Node 22+ の組み込み WebSocket を優先。無ければ ws パッケージを探す
// (relay/node_modules → リポジトリ直下の node_modules → カレント)。
let NativeWS = typeof WebSocket === "function" ? WebSocket : null;
let WSLib = null;
if (!NativeWS) {
  for (const base of [__dirname, path.join(__dirname, ".."), process.cwd()]) {
    try {
      const resolved = createRequire(base + path.sep).resolve("ws");
      const mod = require(resolved);
      WSLib = mod.WebSocket || mod;
      break;
    } catch {}
  }
  if (!WSLib) {
    console.error("[koetomo-relay] WebSocket が使えません。どちらかを行ってください:");
    console.error("  (A) Node.js 22 以上を使う (現在: " + process.version + ")   確認: node -v");
    console.error("  (B) relay/ フォルダで npm install   (ws が入ります)");
    process.exit(1);
  }
}
const WS = NativeWS || WSLib;
const IS_NATIVE = Boolean(NativeWS);

/** WebSocket readyState(実装非依存の定数) */
const WS_OPEN = 1;

function newWebSocket(url, maxPayload) {
  const s = IS_NATIVE
    ? new WS(url, { maxPayload })
    : new WS(url, { maxPayload, perMessageDeflate: false, handshakeTimeout: 20_000 });
  if (IS_NATIVE) s.binaryType = "arraybuffer";
  else s.binaryType = "nodebuffer";
  return s;
}

/** 受信イベント → Buffer(テキストフレームなら null) */
function binOf(ev) {
  const d = ev && ev.data !== undefined ? ev.data : ev;
  if (typeof d === "string") return null;
  if (Buffer.isBuffer(d)) return d;
  if (d instanceof ArrayBuffer) return Buffer.from(d);
  if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  return Buffer.from(String(d), "utf8");
}

/** 受信イベント → 文字列(バイナリフレームなら Buffer を UTF-8 解釈) */
function textOf(ev) {
  const d = ev && ev.data !== undefined ? ev.data : ev;
  if (typeof d === "string") return d;
  const b = binOf(ev);
  return b ? b.toString("utf8") : null;
}

// ───────────────────────── 設定 ─────────────────────────

const HUB_URL = (process.env.HUB_URL || "").trim();
const TOKEN = (process.env.TUNNEL_TOKEN || "").trim();
const NAME = (process.env.RELAY_NAME || os.hostname() || "relay").slice(0, 64);
const POOL_SIZE = Math.max(1, Number(process.env.RELAY_POOL || 4));
const ALLOW_LOCAL = String(process.env.RELAY_LOCAL || "") === "1";
const ALLOW = (process.env.RELAY_ALLOW || "koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const PORTS = new Set(String(process.env.RELAY_PORTS || "443,80").split(",").map((s) => Number(s.trim())));
const HIGH_WATER = 4 * 1024 * 1024;
const DIAL_TIMEOUT = Number(process.env.RELAY_DIAL_TIMEOUT || 15_000);
const VERBOSE = process.env.RELAY_VERBOSE === "1";

const log = (...a) => console.log(new Date().toISOString(), "[koetomo-relay]", ...a);
const vlog = (...a) => { if (VERBOSE) log(...a); };

if (!HUB_URL || !TOKEN) {
  console.error("[koetomo-relay] HUB_URL と TUNNEL_TOKEN の両方が必要です。");
  console.error("  例) HUB_URL=wss://koetomo.onrender.com/__tunnel TUNNEL_TOKEN=xxxx node relay/reverse-tunnel.js");
  process.exit(1);
}

function hostAllowed(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (ALLOW_LOCAL && (/^127\./.test(h) || h === "localhost" || h === "::1")) return true;
  return ALLOW.some((s) => h === s || h.endsWith("." + s));
}

let control = null;       // 在線登録用の常時接続
let registered = false;
let stopping = false;
let retry = 0;
let activeTunnels = 0;
let liveReady = 0;        // 待機中(open 済み・未使用)
let dialing = 0;          // 待機ソケットの確立中
let subSeq = 0;

function sendControl(obj) {
  if (control && control.readyState === WS_OPEN) {
    try { control.send(JSON.stringify(obj)); } catch {}
  }
}

// ───────────────────────── 待機ソケット(プール) ─────────────────────────
// ハブに「すぐ使える WebSocket」を先に預けておく方式。プロキシからの要求が来ると
// ハブが待機ソケットを1本選び、tunnel-go(接続先)を送ってきます。待ち時間が無いので
// ページ読み込みのようなバーストにも強いです。

function openReadySocket() {
  if (stopping) return;
  dialing++;
  const myId = "s" + (++subSeq);

  let sub;
  try {
    sub = newWebSocket(HUB_URL, 16 * 1024 * 1024);
  } catch (e) {
    dialing--;
    log("待機ソケット生成失敗:", e.message);
    setTimeout(replenish, 2000);
    return;
  }

  let state = "opening";   // opening → standby → used → closed

  const drop = (why) => {
    if (state === "closed") return;
    if (state === "standby") liveReady--;
    if (state === "opening") dialing--;
    state = "closed";
    try { sub.close(); } catch {}
    vlog(`#${myId} 終了 (${why} / state=${state}) ready=${liveReady} dialing=${dialing}`);
    replenish();
  };

  sub.addEventListener("open", () => {
    dialing--;
    sub.send(JSON.stringify({ type: "relay-tunnel-ready", mode: "relay", token: TOKEN, name: NAME }));
  });

  /**
   * 制御メッセージ専用ハンドラ。tunnel-go を受け取った時点で自分自身を外します。
   * (プロキシが最初に送る HTTP リクエスト行はテキストフレームで届くため、
   *  制御メッセージとして JSON 解析してしまう事故を防ぐ)
   */
  const onControl = (ev) => {
    if (state === "closed") return;
    let msg;
    try { msg = JSON.parse(textOf(ev)); } catch { return; }

    if (msg.type === "standby") {
      state = "standby";
      liveReady++;
      vlog(`#${myId} 待機完了 (ready=${liveReady}, active=${activeTunnels})`);
      return;
    }
    if (msg.type === "tunnel-go") {
      if (state === "standby") liveReady--;
      state = "used";
      sub.removeEventListener("message", onControl);
      startTunnel(sub, msg);
      return;
    }
    if (msg.type === "error") {
      log("ハブからのエラー:", msg.message);
      if (/unauthorized/i.test(String(msg.message))) { fatalAuth(); return; }
      drop("error");
    }
  };

  sub.addEventListener("message", onControl);
  sub.addEventListener("close", () => drop("close"));
  sub.addEventListener("error", () => drop("error"));
}

/** 待機ソケットを「日本 → 上流」の実際の TCP 接続に切り替える */
function startTunnel(sub, goMsg) {
  const host = String(goMsg?.host || "");
  const port = Number(goMsg?.port || 0);
  if (!host || !port) { try { sub.close(1008, "bad request"); } catch {} return; }

  if (!hostAllowed(host) || !PORTS.has(port)) {
    log(`拒否 (許可リスト外): ${host}:${port}`);
    try { sub.close(1008, "not allowed"); } catch {}
    replenish();
    return;
  }

  // dial 中(DNS解決〜TCP確立)に届いたデータは捨てずに溜める。
  // プロキシは tunnel-go 直後に TLS ClientHello / HTTP リクエストを送ってくるので、
  // ここで取りこぼすとハンドシェイクが永久に止まります。
  let pendingChunks = [];
  const earlyListener = (ev) => {
    const b = binOf(ev);
    if (b && pendingChunks) pendingChunks.push(b);
  };
  sub.addEventListener("message", earlyListener);

  const socket = net.connect({ host, port });
  const timer = setTimeout(() => socket.destroy(new Error("dial timeout")), DIAL_TIMEOUT);
  let up = false;
  let finished = false;
  let guard = null;

  const finish = (why) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (guard) clearInterval(guard);
    if (up) activeTunnels = Math.max(0, activeTunnels - 1);
    up = false;
    try { socket.destroy(); } catch {}
    try { if (sub.readyState === WS_OPEN) sub.close(1000, "tunnel closed"); } catch {}
    vlog(`トンネル終了 ${host}:${port}${why ? " (" + why + ")" : ""} active=${activeTunnels}`);
    replenish();
  };

  socket.once("connect", () => {
    clearTimeout(timer);
    up = true;
    activeTunnels++;
    log(`トンネル開始 -> ${host}:${port} (active=${activeTunnels})`);

    // 逆圧: WS 送信バッファが溜まったら上流の受信を止める
    let paused = false;
    guard = setInterval(() => {
      if (finished || sub.readyState !== WS_OPEN) return clearInterval(guard);
      if (!paused && sub.bufferedAmount > HIGH_WATER) { paused = true; try { socket.pause(); } catch {} }
      else if (paused && sub.bufferedAmount < HIGH_WATER / 2) { paused = false; try { socket.resume(); } catch {} }
    }, 50);
    guard.unref?.();

    // dial 中に溜めたデータを流し、以降は直接書き込む
    sub.removeEventListener("message", earlyListener);
    const chunks = pendingChunks || [];
    pendingChunks = null;
    for (const c of chunks) { try { socket.write(c); } catch { return finish("write failed"); } }

    sub.addEventListener("message", (ev) => {
      if (finished) return;
      const b = binOf(ev);          // 制御メッセージ(テキスト)は無視
      if (!b) return;
      try { socket.write(b); } catch { finish("write failed"); }
    });

    socket.on("data", (buf) => {
      if (sub.readyState !== WS_OPEN) return finish("ws gone");
      try { sub.send(buf); } catch { finish("send failed"); }
    });
    socket.once("close", () => finish("upstream closed"));
    socket.once("error", (e) => finish(e.code || e.message));
    sub.addEventListener("close", () => finish("hub closed"), { once: true });
    sub.addEventListener("error", () => finish("hub error"), { once: true });
  });

  socket.once("error", (e) => {
    if (finished) return;
    log(`接続失敗 ${host}:${port} -> ${e.code || e.message}`);
    try { sub.close(1011, String(e.code || "dial failed").slice(0, 100)); } catch {}
    finish(e.code || "dial failed");
  });
}

/** 待機ソケットを POOL_SIZE まで補充する */
function replenish() {
  if (stopping || !registered) return;
  let guard = 0;
  while (liveReady + dialing < POOL_SIZE && guard++ < POOL_SIZE * 4) openReadySocket();
}

// ───────────────────────── 制御ソケット(在線登録) ─────────────────────────

function fatalAuth() {
  if (stopping) return;
  log("❌ TUNNEL_TOKEN がハブと一致しません。Render の環境変数 TUNNEL_TOKEN と同じ値にしてください。");
  stopping = true;
  process.exitCode = 2;
  try { control?.close(1008); } catch {}
  const t = setTimeout(() => process.exit(2), 300);
  t.unref?.();
}

function connectControl() {
  if (stopping) return;
  let sock;
  try {
    sock = newWebSocket(HUB_URL, 1 * 1024 * 1024);
  } catch (e) {
    log("ハブへの接続失敗:", e.message);
    return scheduleReconnect();
  }
  control = sock;
  registered = false;

  sock.addEventListener("open", () => {
    sock.send(JSON.stringify({ type: "register", mode: "relay", token: TOKEN, name: NAME, poolSize: POOL_SIZE }));
  });

  sock.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(textOf(ev)); } catch { return; }
    if (msg.type === "relay-ready") {
      retry = 0;
      registered = true;
      log(`✅ オンライン登録完了 (id=${msg.id}) — 待機ソケット ${POOL_SIZE} 本を用意します`);
      replenish();
      return;
    }
    if (msg.type === "replenish") return replenish();
    if (msg.type === "error") {
      log("ハブからのエラー:", msg.message);
      if (/unauthorized/i.test(String(msg.message))) fatalAuth();
    }
  });

  sock.addEventListener("close", (ev) => {
    registered = false;
    log(`ハブ接続が閉じました (code=${ev?.code ?? "?"}) — 再接続します`);
    control = null;
    scheduleReconnect();
  });
  sock.addEventListener("error", (ev) => {
    if (!registered) log("ハブ接続エラー:", ev?.message || ev?.error?.message || "(詳細なし)");
  });
}

function scheduleReconnect() {
  if (stopping) return;
  retry = Math.min(retry + 1, 5);
  const wait = Math.min(1000 * 2 ** retry, 20_000) + Math.floor(Math.random() * 400);
  log(`${Math.round(wait / 1000)}秒後に再接続します… (Render がスリープ中はこれが繰り返されます)`);
  // ※ unref しないこと。unref すると他にハンドルが無い瞬間にプロセスが静かに終了してしまい、
  //   「ハブがまだ起動していない」ケースで二度と再接続しなくなります。
  setTimeout(connectControl, wait);
}

// ───────────────────────── 起動 ─────────────────────────

log(`起動: name=${NAME} hub=${HUB_URL} pool=${POOL_SIZE} (WebSocket: ${IS_NATIVE ? "Node組み込み" : "wsパッケージ"}, node ${process.version})`);
log(`許可: ${ALLOW.join(", ")}${ALLOW_LOCAL ? " (+loopback)" : ""} / port ${[...PORTS].join(",")}`);
connectControl();

// 生存監視(Render のスリープ復帰・一時的なネットワーク断からの復活)
setInterval(() => {
  if (stopping) return;
  if (!control || control.readyState !== WS_OPEN) {
    log("制御ソケットが切れているので再接続します");
    try { control?.close(); } catch {}
    control = null;
    connectControl();
  } else {
    try { control.ping?.(); } catch {}
    replenish();   // 待機ソケットが減っていたら補充
  }
  if (VERBOSE) log(`状態: ready=${liveReady} dialing=${dialing} active=${activeTunnels} registered=${registered}`);
}, 20_000);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig} received, shutting down (active=${activeTunnels})`);
    stopping = true;
    try { control?.close(1001, "shutdown"); } catch {}
    setTimeout(() => process.exit(0), 1500).unref?.();
  });
}

process.on("uncaughtException", (e) => {
  log("uncaughtException:", e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
});
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message || e));
