"use strict";
/**
 * 「Render → 日本の公開プロキシ → koetomo.fun」で *アプリ本体* が読み込めるかの実測。
 *
 * HTML シェル(1420B)が 200 で返るだけでは不十分で、実際に使うには
 *   ・JS / CSS / 画像などのアセット(数百KB〜数MB)が落ちること
 *   ・API(JSON)が叩けること
 *   ・WebSocket の CONNECT トンネルが張れること
 *   ・ある程度の時間つながったままいられること
 * が必要です。これを公開プロキシ経由で実際に試します。
 *
 * 実行: node tools/verify-app-through-proxy.js [proxy1,proxy2,...]
 */
const { ProxyAgent, fetch } = require("undici");
const net = require("net");
const tls = require("tls");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ORIGIN = process.env.TARGET || "https://koetomo.fun";
const HOST = new URL(ORIGIN).hostname;
const PROXIES = (process.argv[2] || process.env.PROXIES || "38.175.202.151:443,45.43.60.220:8080,140.238.32.108:3128").split(",").map(s => s.trim()).filter(Boolean);
const TIMEOUT = Number(process.env.TIMEOUT || 25_000);

function agent(uri) {
  return new ProxyAgent({ uri: `http://${uri}`, connectTimeout: TIMEOUT, headersTimeout: TIMEOUT, bodyTimeout: 60_000 });
}

async function getBody(d, url, opt = {}) {
  const t0 = Date.now();
  const r = await fetch(url, {
    dispatcher: d, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT),
    headers: { "user-agent": UA, accept: "*/*", "accept-language": "ja", ...(opt.headers || {}) },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, bytes: buf.length, ms: Date.now() - t0, ct: r.headers.get("content-type"), buf, headers: r.headers };
}

/** 素の CONNECT + TLS が張れるか(= wss:// が使えるかの判定) */
function connectTls(uri, host, port, ms = 15_000) {
  return new Promise((resolve) => {
    const [pip, pport] = uri.split(":");
    const sock = net.connect({ host: pip, port: Number(pport) });
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} resolve({ ok: false, err: "timeout" }); }, ms);
    const fail = (e) => { clearTimeout(timer); try { sock.destroy(); } catch {} resolve({ ok: false, err: e }); };
    sock.on("error", (e) => fail(e.message));
    sock.on("connect", () => sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      const head = buf.subarray(0, i).toString();
      if (!/^HTTP\/1\.[01] 200/.test(head)) return fail(head.split("\r\n")[0]);
      sock.removeAllListeners("data");
      const secure = tls.connect({ socket: sock, servername: host }, () => {
        clearTimeout(timer);
        resolve({ ok: true, alpn: secure.alpnProtocol, authorized: secure.authorized });
        try { secure.destroy(); } catch {}
      });
      secure.on("error", (e) => fail("tls:" + e.message));
      if (buf.length > i + 4) sock.unshift(buf.subarray(i + 4));
    });
  });
}

/** HTTPリクエストをCONNECTトンネル内で直接書いて、Upgrade(WebSocket)が通るか見る */
function wsProbe(uri, ms = 20_000) {
  return new Promise((resolve) => {
    const [pip, pport] = uri.split(":");
    const sock = net.connect({ host: pip, port: Number(pport) });
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} resolve({ ok: false, err: "timeout" }); }, ms);
    const fail = (e) => { clearTimeout(timer); try { sock.destroy(); } catch {} resolve({ ok: false, err: e }); };
    sock.on("error", (e) => fail(e.message));
    sock.on("connect", () => sock.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`));
    let buf = Buffer.alloc(0), phase = "head";
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (phase === "head") {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        if (!/^HTTP\/1\.[01] 200/.test(buf.subarray(0, i).toString())) return fail("CONNECT refused");
        phase = "tls";
        sock.removeAllListeners("data");
        const secure = tls.connect({ socket: sock, servername: HOST }, () => {
          const key = require("crypto").randomBytes(16).toString("base64");
          secure.write(
            `GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\n` +
            `Host: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
            `Origin: ${ORIGIN}\r\nUser-Agent: ${UA}\r\n\r\n`);
          let resp = "";
          secure.on("data", (c) => {
            resp += c.toString("latin1");
            if (resp.includes("\r\n\r\n")) {
              clearTimeout(timer);
              const line = resp.split("\r\n")[0];
              resolve({ ok: /^HTTP\/1\.[01] 101/.test(line), status: line, upgraded: /^HTTP\/1\.[01] 101/.test(line) });
              try { secure.destroy(); } catch {}
            }
          });
          secure.on("error", (e) => fail("tls-data:" + e.message));
        });
        secure.on("error", (e) => fail("tls:" + e.message));
        if (buf.length > i + 4) sock.unshift(buf.subarray(i + 4));
      }
    });
  });
}

(async () => {
  for (const uri of PROXIES) {
    console.log(`\n${"=".repeat(72)}\n=== ${uri}  →  ${ORIGIN}\n${"=".repeat(72)}`);
    const d = agent(uri);
    try {
      // 1) HTML シェル
      const html = await getBody(d, ORIGIN + "/");
      console.log(`[1] HTML      : ${html.status} / ${html.bytes}B / ${html.ms}ms / ${html.ct || "-"}`);
      if (html.status !== 200) { console.log("    → 200 以外なのでこのプロキシは以降スキップ"); continue; }

      // 2) アセット(JS/CSS/画像)を HTML から抽出して実際に落とす
      const text = html.buf.toString("utf8");
      const urls = new Set();
      for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:js|css|png|jpg|svg|woff2?|ico))["']/gi)) urls.add(m[1]);
      for (const m of text.matchAll(/["'](\/[^"']*\.(?:js|css))["']/g)) urls.add(m[1]);
      const list = [...urls].slice(0, 4);
      console.log(`[2] アセット  : HTML から ${urls.size} 件検出、先頭 ${list.length} 件を取得してみる`);
      let totalBytes = 0, okAssets = 0;
      for (const u of list) {
        const abs = u.startsWith("http") ? u : ORIGIN + (u.startsWith("/") ? u : "/" + u);
        try {
          const a = await getBody(d, abs);
          const good = a.status === 200 && a.bytes > 0;
          if (good) { okAssets++; totalBytes += a.bytes; }
          console.log(`      ${good ? "✅" : "❌"} ${a.status} ${(a.bytes / 1024).toFixed(1)}KB ${a.ms}ms  ${abs.slice(0, 78)}`);
        } catch (e) {
          console.log(`      ❌ ERR ${e.cause?.code || e.message}  ${abs.slice(0, 78)}`);
        }
      }
      console.log(`    → アセット成功 ${okAssets}/${list.length}、合計 ${(totalBytes / 1024).toFixed(0)}KB`);

      // 3) 大きめの連続ダウンロードに耐えるか(同一接続で複数リクエスト)
      const t0 = Date.now();
      let n = 0;
      for (let i = 0; i < 5; i++) {
        try { const r = await getBody(d, ORIGIN + `/?probe=${i}`); if (r.status === 200) n++; } catch {}
      }
      console.log(`[3] 連続5リクエスト: ${n}/5 成功 (${Date.now() - t0}ms)`);

      // 4) CONNECT + TLS(WebSocket の土台)
      const t = await connectTls(uri, HOST, 443);
      console.log(`[4] CONNECT+TLS: ${t.ok ? `✅ ALPN=${t.alpn} 証明書検証=${t.authorized}` : `❌ ${t.err}`}`);

      // 5) WebSocket アップグレードが通るか(認証前なので 101 以外でも「応答が返る」こと自体が重要)
      const w = await wsProbe(uri);
      console.log(`[5] WS Upgrade : ${w.ok ? "✅ 101 Switching Protocols(WebSocket 中継可能)" : `△ ${w.status || w.err}(トンネルは通るが 101 ではない)`}`);

      console.log(`\n  総合判定: ${html.status === 200 && okAssets > 0 && t.ok ? "○ Render の上流として使える見込み" : "△ 不安定"}`);
    } catch (e) {
      console.log("  ❌ このプロキシは使えません:", e.cause?.code || e.message);
    } finally {
      try { await d.close(); } catch {}
    }
  }
})();
