"use strict";
/**
 * 実物の koetomo.fun に対して「リバーストンネル + TLS + HTTP」が成立するかを検証する。
 * 地域ブロックにより HTTP 403 (awselb) が返るのが正常な結果です。
 * ここで確認するのは「トンネル越しに暗号路が張れ、リクエストと応答が往復できる」こと。
 *
 * 実行: node test/live-tunnel-check.js
 */
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.CHECK_PORT || 8799);
const TOKEN = "livecheck";
const TARGET_HOST = process.env.CHECK_HOST || "koetomo.fun";

function spawnNode(script, env, tag) {
  const c = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout.on("data", (d) => process.stdout.write(`[${tag}] ` + d));
  c.stderr.on("data", (d) => process.stderr.write(`[${tag}!] ` + d));
  c.on("exit", (code) => console.log(`[${tag}] exit code=${code}`));
  return c;
}

const proxy = spawnNode(path.join(ROOT, "server.js"), {
  PORT: String(PORT), UPSTREAM: `https://${TARGET_HOST}`, TUNNEL_TOKEN: TOKEN,
}, "PROXY");

async function waitHealth(ms = 20_000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/__health`); if (r.ok) return; } catch {}
    if (Date.now() - t0 > ms) throw new Error("proxy(ハブ)が起動しません");
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function waitRelay(ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const st = await (await fetch(`http://127.0.0.1:${PORT}/__hub`)).json();
      if (st.relays.length > 0 && st.readySockets > 0) return st;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error("日本のマシン(relay)がハブに登録されません");
    await new Promise((r) => setTimeout(r, 300));
  }
}

let finished = false;
let relay = null;
function finish(code) {
  if (finished) return;
  finished = true;
  setTimeout(() => {
    try { relay?.kill(); } catch {}
    try { proxy.kill(); } catch {}
    process.exit(code);
  }, 400);
}

(async () => {
  await waitHealth();
  relay = spawnNode(path.join(ROOT, "relay", "reverse-tunnel.js"), {
    HUB_URL: `ws://127.0.0.1:${PORT}/__tunnel`, TUNNEL_TOKEN: TOKEN, RELAY_NAME: "livecheck", RELAY_POOL: "2",
  }, "RELAY");

  const st = await waitRelay();
  console.log(`[CHECK] 日本のマシン接続確認: ${st.relays.map((r) => r.name).join(", ")} / 待機ソケット ${st.readySockets}本`);

  // ① プロキシ本体(undici)がトンネル経由で実物に到達できるか
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/__status?format=json`, { signal: AbortSignal.timeout(40_000) });
  const j = await r.json();
  console.log(`[CHECK] /__status (${Date.now() - t0}ms): ${j.verdict.icon} ${j.verdict.title}`);
  console.log(`[CHECK]    上流プローブ: ok=${j.upstreamProbe.ok} status=${j.upstreamProbe.status} server=${j.upstreamProbe.server} ms=${j.upstreamProbe.ms} err=${j.upstreamProbe.error}`);
  console.log(`[CHECK]    Render自身のIP: ${j.egressIp?.ip || "?"} / ${j.egressIp?.country || "?"} ${j.egressIp?.org || ""}`);
  console.log(`[CHECK]    トンネル: relays=${j.tunnel?.relays?.length} ready=${j.tunnel?.readySockets} active=${j.tunnel?.activeTunnels}`);

  // ② 素の TLS トンネルで生 HTTP を往復できるか
  const { openTunnelSocket, tlsWrapTunnel } = require("../tunnel/tunnel-bridge");
  const raw = await openTunnelSocket({ hubUrl: `ws://127.0.0.1:${PORT}/__tunnel`, token: TOKEN, host: TARGET_HOST, port: 443, timeoutMs: 20_000 });
  const tlsSock = await tlsWrapTunnel(raw, TARGET_HOST, {});
  const cert = tlsSock.getPeerCertificate?.() || {};
  console.log(`[CHECK] ✅ 生TLSトンネル確立 (CN=${cert.subject?.CN}, ALPN=${tlsSock.alpnProtocol}, 暗号=${tlsSock.getCipher?.().name})`);

  tlsSock.resume();
  const got = await new Promise((resolve) => {
    let buf = "";
    const to = setTimeout(() => resolve(buf || "(timeout)"), 15_000);
    tlsSock.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n") || buf.length > 900) { clearTimeout(to); resolve(buf); }
    });
    tlsSock.on("close", () => { clearTimeout(to); resolve(buf || "(closed)"); });
    tlsSock.on("error", (e) => { clearTimeout(to); resolve(buf + " [err:" + e.message + "]"); });
    tlsSock.write(
      `GET / HTTP/1.1\r\n` +
      `Host: ${TARGET_HOST}\r\n` +
      `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36\r\n` +
      `Accept: text/html,application/xhtml+xml\r\nAccept-Language: ja\r\nConnection: close\r\n\r\n`
    );
  });
  const line = got.split("\r\n")[0];
  const server = (got.match(/server:\s*([^\r\n]+)/i) || [])[1];
  console.log(`[CHECK] 生HTTP応答: ${line || "(空)"}${server ? " / server: " + server : ""} / ${got.length}B`);
  console.log(line.includes("403")
    ? "[CHECK] → 403 は想定どおり(この検証環境のIPが日本国外)。トンネル+TLS+HTTP の往復は完全に機能しています。"
    : "[CHECK] → 403 以外の応答です。");
  try { tlsSock.destroy(); } catch {}
  finish(0);
})().catch((e) => { console.log("[CHECK] ❌ 失敗:", e.message); finish(1); });

setTimeout(() => { console.log("[CHECK] 全体タイムアウト"); finish(1); }, 120_000);
