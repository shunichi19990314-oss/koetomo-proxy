"use strict";
/** 見つかった日本プロキシの実用性検証(速度・安定性・CONNECT/WebSocket可否) */
const { ProxyAgent, fetch } = require("undici");
const net = require("net");
const tls = require("tls");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const LIST = (process.env.PROXIES || "140.238.32.108:3128,38.175.202.151:443,45.43.60.220:8080,111.119.162.248:10944").split(",").map(s => s.trim()).filter(Boolean);

async function once(uri, url, ms = 12000) {
  const d = new ProxyAgent({ uri: `http://${uri}`, connectTimeout: ms, headersTimeout: ms });
  const t0 = Date.now();
  try {
    const r = await fetch(url, { dispatcher: d, redirect: "manual", signal: AbortSignal.timeout(ms), headers: { "user-agent": UA, accept: "text/html", "accept-language": "ja" } });
    const len = Number(r.headers.get("content-length") || 0);
    await r.body?.cancel().catch(() => {});
    return { status: r.status, ms: Date.now() - t0, server: r.headers.get("server"), len };
  } catch (e) { return { status: "ERR", ms: Date.now() - t0, err: e.cause?.code || e.message }; }
  finally { try { await d.close(); } catch {} }
}

/** 素の CONNECT トンネル + TLS が張れるか(= wss:// が使えるかの判定) */
function connectTls(uri, host, port, ms = 12000) {
  return new Promise((resolve) => {
    const [pip, pport] = uri.split(":");
    const sock = net.connect({ host: pip, port: Number(pport) });
    const timer = setTimeout(() => { sock.destroy(); resolve({ ok: false, err: "timeout" }); }, ms);
    sock.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, err: e.message }); });
    sock.on("connect", () => sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let buf = Buffer.alloc(0), phase = "head";
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (phase === "head") {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        const head = buf.subarray(0, i).toString();
        if (!/^HTTP\/1\.[01] 200/.test(head)) { clearTimeout(timer); sock.destroy(); return resolve({ ok: false, err: head.split("\r\n")[0] }); }
        phase = "tls";
        const rest = buf.subarray(i + 4);
        const secure = tls.connect({ socket: sock, servername: host }, () => {
          clearTimeout(timer);
          const cert = secure.getPeerCertificate();
          resolve({ ok: true, alpn: secure.alpnProtocol, cn: cert?.subject?.CN, authorized: secure.authorized });
          try { secure.destroy(); } catch {}
        });
        secure.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, err: "tls:" + e.message }); });
        if (rest.length) sock.unshift(rest);
      }
    });
  });
}

(async () => {
  for (const uri of LIST) {
    console.log(`\n===== ${uri} =====`);
    const info = await once(uri, "https://ipinfo.io/json");
    let geo = {};
    if (info.status === 200) {
      const d = new ProxyAgent({ uri: `http://${uri}` });
      try { geo = await (await fetch("https://ipinfo.io/json", { dispatcher: d, signal: AbortSignal.timeout(12000) })).json(); } catch {}
      try { await d.close(); } catch {}
    }
    console.log(`  出口IP   : ${geo.ip || "?"} / ${geo.country || "?"} / ${geo.city || ""} ${geo.region || ""}`);
    console.log(`  回線     : ${geo.org || "?"}`);

    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await once(uri, "https://koetomo.fun/"));
    const okc = runs.filter(r => r.status === 200).length;
    console.log(`  koetomo  : ${runs.map(r => `${r.status}(${r.ms}ms)`).join(" ")}  → 成功 ${okc}/3  server=${runs[0].server || "-"}  size=${runs[0].len || "-"}B`);

    const t = await connectTls(uri, "koetomo.fun", 443);
    console.log(`  CONNECT+TLS: ${t.ok ? `✅ ALPN=${t.alpn} CN=${t.cn} 証明書検証=${t.authorized}` : `❌ ${t.err}`}`);

    const api = await once(uri, "https://koetomo.fun/api/v1/health").catch(() => null);
    console.log(`  備考     : API系パス応答=${api ? api.status : "-"} / 実用判定=${okc >= 2 && t.ok ? "○ 使える" : "△ 不安定"}`);
  }
})();
