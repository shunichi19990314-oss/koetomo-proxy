"use strict";
/*!
 * tunnel-bridge — Render(プロキシ)側から見た「日本への穴掘り」クライアント
 * ============================================================================
 * ハブ(tunnel/hub.js)へ WebSocket を1本張ると、ハブが日本のマシン
 * (relay/reverse-tunnel.js)の待機ソケットと配对してくれます。その瞬間から
 * 「日本のマシンに直接 TCP 接続しているのと同じ状態」の Duplex ストリームが得られます。
 *
 *   server.js ─(WS)→ ハブ ─(WS)→ 日本のマシン ─(TCP)→ koetomo.fun
 *
 * 使い方:
 *   const socket = await openTunnelSocket({ hubUrl, token, host, port });
 *   // socket は net.Socket 相当の Duplex。undici の connect / tls.connect({socket}) /
 *   // ws の createConnection にそのまま渡せます。
 *
 * なぜ WebSocket か: 日本の家庭回線はグローバルIPが無い(CGNAT)ことが多く、
 * ポート開放もできません。「日本側から外向きに繋ぐ」形にすれば、
 * クレジットカードもクラウドもポート開放も不要で日本の出口が作れます。
 *
 * 実装メモ:
 *  - 下り(上流→プロキシ)は WS バイナリフレームを Duplex の可読側へ push するだけ。
 *    resolve() より前に届いたデータも Duplex の内部バッファに溜まるので取りこぼしません。
 *  - WS が close された = 日本側が上流との接続を閉じた(= 応答完了)なので、
 *    push(null) で EOF を通知します(ここで destroy すると応答本文を捨てて 502 になります)。
 */

const tls = require("tls");
const { Duplex } = require("stream");
const { WebSocket } = require("ws");

const WS_HIGH_WATER = 4 * 1024 * 1024;   // WS 送信バッファの逆圧しきい値
const BUF_HIGH = 8 * 1024 * 1024;        // Duplex 可読バッファの上限(超えたら WS 受信を pause)
const BUF_LOW = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30_000;
const DBG = process.env.TUNNEL_DEBUG === "1";
const dbg = (...a) => { if (DBG) console.log("[tunnel-bridge]", ...a); };

/**
 * ハブ経由で「host:port への TCP トンネル」を表す Duplex ストリームを開く。
 * @param {{hubUrl:string, token:string, host:string, port:number, timeoutMs?:number}} opts
 * @returns {Promise<Duplex>}
 */
function openTunnelSocket(opts) {
  const { hubUrl, token, host, port, timeoutMs = DEFAULT_TIMEOUT } = opts;
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(hubUrl, {
        maxPayload: 256 * 1024 * 1024,
        perMessageDeflate: false,
        handshakeTimeout: Math.min(timeoutMs, 20_000),
      });
    } catch (err) { return reject(err); }
    ws.binaryType = "nodebuffer";

    let settled = false;
    let wsOpen = false;
    let eofPushed = false;
    let paused = false;

    const timer = setTimeout(() => cleanup(new Error("hub connect timeout")), timeoutMs);
    timer.unref?.();

    const duplex = new Duplex({
      // 上り: プロキシ → (WS) → ハブ → 日本のマシン → 上流
      write(chunk, enc, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
        if (!wsOpen || ws.readyState !== WebSocket.OPEN) return cb(new Error("tunnel not open"));
        ws.send(buf, { binary: true }, (err) => {
          if (err) return cb(err);
          if (ws.bufferedAmount > WS_HIGH_WATER) ws.once("drain", cb);
          else cb();
        });
      },
      final(cb) { try { ws.close(1000, "eof"); } catch {} cb(); },
      // 下り: 上流 → 日本のマシン → ハブ → (WS) → push
      read() {
        if (paused && duplex.readableLength < BUF_LOW) {
          paused = false;
          dbg("resume ws (backpressure relieved)");
          try { ws.resume(); } catch {}
        }
      },
      destroy(err, cb) { cleanup(err || null); cb(err); },
    });

    // 誰も 'error' を購読していない瞬間にエラーが来てもプロセスを落とさない
    // (undici / ws が後から自分のリスナを付けて受け取ります)
    duplex.on("error", () => {});
    // net.Socket 互換のメソッド(tls.connect / ws ライブラリが呼ぶことがある)
    duplex.setNoDelay = () => duplex;
    duplex.setKeepAlive = () => duplex;
    duplex.ref = () => duplex;
    duplex.unref = () => duplex;
    duplex.setTimeout = function (_ms, fn) { if (fn) this.once("timeout", fn); return this; };
    duplex.on("close", () => cleanup());

    const pushEof = () => {
      if (eofPushed) return;
      eofPushed = true;
      dbg("push EOF");
      try { duplex.push(null); } catch {}
    };

    function cleanup(err) {
      clearTimeout(timer);
      if (err && !settled) {
        settled = true;
        try { ws.terminate(); } catch {}
        return reject(err);
      }
      try { ws.close(1000, "tunnel done"); } catch {}
    }

    ws.on("open", () => {
      wsOpen = true;
      ws.send(JSON.stringify({ type: "connect", mode: "proxy", token, host, port }));
    });

    ws.on("message", (data, isBinary) => {
      dbg("ws message isBinary=" + isBinary + " len=" + (data && data.length));
      if (!isBinary) {
        let msg;
        try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
        dbg("control: " + msg.type);
        if (msg.type === "connected") {
          clearTimeout(timer);
          if (!settled) { settled = true; resolve(duplex); }
          return;
        }
        if (msg.type === "error") return cleanup(new Error("hub: " + (msg.message || "error")));
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (duplex.destroyed) return;
      duplex.push(buf);
      // 逆圧: 消費が追いつかない間は WS の受信を止める(データは ws 内部に溜まる)
      if (!paused && duplex.readableLength > BUF_HIGH) {
        paused = true;
        dbg("pause ws (backpressure) readableLength=" + duplex.readableLength);
        try { ws.pause(); } catch {}
      }
    });

    ws.on("close", (code, reason) => {
      dbg(`ws close code=${code} ${reason ? reason.toString().slice(0, 60) : ""} settled=${settled}`);
      if (!settled) return cleanup(new Error(`tunnel websocket closed before established (code=${code})`));
      // 日本側が上流との接続を閉じた = 正常な応答完了。EOF として扱う。
      pushEof();
    });

    ws.on("error", (err) => {
      dbg("ws error " + err.message);
      if (!settled) return cleanup(err);
      // 確立後のエラーは「途中で切れた」= 読み手にエラーを伝えて 502 にさせる
      if (!duplex.destroyed) duplex.destroy(err);
    });
  });
}

/**
 * トンネルソケットを TLS でラップする(声ともの証明書はエンドツーエンドで検証される)。
 * 日本のマシンもハブも平文を見られません。
 */
function tlsWrapTunnel(socket, servername, tlsOpts = {}) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername, ALPNProtocols: ["http/1.1"], ...tlsOpts }, () => resolve(secure));
    secure.once("error", reject);
  });
}

/**
 * トンネル経由の HTTP/HTTPS 接続を作る(undici の connect オプション用)。
 * https の場合はここで TLS を張るので、上流の証明書検証は通常どおり行われます。
 */
async function makeTunnelConnection(opts) {
  const { hubUrl, token, hostname, port, tls: tlsOpts } = opts;
  const socket = await openTunnelSocket({ hubUrl, token, host: hostname, port });
  if (opts.protocol === "https:") return tlsWrapTunnel(socket, opts.servername || hostname, tlsOpts || {});
  return socket;
}

module.exports = { openTunnelSocket, tlsWrapTunnel, makeTunnelConnection };
