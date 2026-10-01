"use strict";
/**
 * 「HTTPS(TLS)上流」をリバーストンネル経由で fetch / WebSocket できるかの検証。
 * 本番(https://koetomo.fun + wss://koetomo.fun)と同じコードパスを通します。
 *
 * 上流は実在の HTTPS サイト(既定 https://ipinfo.io)を使い、
 * 日本のマシン役(relay/reverse-tunnel.js)経由で到達できることを確認します。
 *
 * 実行: node test/tunnel-tls-smoke.js
 */
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.TLS_PORT || 8791);
const TOKEN = "tls-smoke-token";
const TARGET = process.env.TLS_TARGET || "https://ipinfo.io";
const TARGET_HOST = new URL(TARGET).hostname;
const PROXY = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name + (extra !== undefined ? "  | " + extra : "")); }
}

function spawnNode(script, env, tag) {
  const c = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.logs = [];
  c.stdout.on("data", (d) => c.logs.push(d.toString()));
  c.stderr.on("data", (d) => c.logs.push(d.toString()));
  if (tag) { c.stdout.on("data", (d) => process.stdout.write(`[${tag}] ` + d)); c.stderr.on("data", (d) => process.stderr.write(`[${tag}!] ` + d)); }
  return c;
}

async function waitFor(cond, ms, label) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await new Promise((r) => setTimeout(r, 250));
  }
}

(async () => {
  // server.js を「HTTPS 上流 + トンネル」構成で起動
  const proxy = spawnNode(path.join(ROOT, "server.js"), {
    PORT: String(PORT),
    UPSTREAM: TARGET,
    TUNNEL_TOKEN: TOKEN,
    RELAY_ALLOW: `${TARGET_HOST},ipinfo.io,ipwho.is,api.ipify.org`,
    PUBLIC_ORIGIN: "",
  });
  await waitFor(async () => { try { return (await fetch(PROXY + "/__health")).ok; } catch { return false; } }, 20_000, "proxy");

  const relay = spawnNode(path.join(ROOT, "relay", "reverse-tunnel.js"), {
    HUB_URL: `ws://localhost:${PORT}/__tunnel`,
    TUNNEL_TOKEN: TOKEN,
    RELAY_NAME: "tls-relay",
    RELAY_POOL: "2",
    RELAY_ALLOW: `${TARGET_HOST},ipinfo.io,ipwho.is,api.ipify.org`,
  });
  await waitFor(async () => {
    const st = await (await fetch(PROXY + "/__hub")).json();
    return st.relays.length === 1 && st.readySockets >= 1;
  }, 25_000, "relay online");
  console.log(`\ntls-smoke: proxy(${PROXY}) → hub → relay → ${TARGET} (HTTPS/TLS)\n`);

  try {
    // ── 1. HTTPS 上流への GET が TLS トンネル経由で通る ──
    const r = await fetch(PROXY + "/json", { signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    ok("HTTPS 上流へ GET → 200", r.status === 200, `${r.status} ${text.slice(0, 120)}`);
    ok("TLS が正しく終端され JSON が読める", (() => { try { const j = JSON.parse(text); return typeof j === "object" && j !== null; } catch { return false; } })(), text.slice(0, 120));
    ok("プロキシの応答ヘッダが付く", r.headers.get("x-proxied-by") === "koetomo-proxy");

    // ── 2. /__status が「上流に到達できた」と判定する(TLS 検証が通っている証拠) ──
    const st = await (await fetch(PROXY + "/__status?format=json", { signal: AbortSignal.timeout(40_000) })).json();
    ok("/__status: 上流プローブ ok(HTTPS)", st.upstreamProbe && st.upstreamProbe.ok === true, JSON.stringify(st.upstreamProbe));
    ok("/__status: 403/接続エラーではない", st.upstreamProbe && st.upstreamProbe.status !== 403 && !st.upstreamProbe.error, JSON.stringify(st.upstreamProbe));
    ok("/__status: トンネル経路が表示される", /リバーストンネル/.test(st.route || ""), st.route);

    // ── 3. トンネル上の TLS で証明書検証が効いている(= 中間者ではない) ──
    const { openTunnelSocket, tlsWrapTunnel } = require("../tunnel/tunnel-bridge");
    const raw = await openTunnelSocket({ hubUrl: `ws://localhost:${PORT}/__tunnel`, token: TOKEN, host: TARGET_HOST, port: 443, timeoutMs: 20_000 });
    const secure = await tlsWrapTunnel(raw, TARGET_HOST, {});
    const cert = secure.getPeerCertificate();
    ok("証明書が本物(検証済み・CN/SAN あり)", Boolean(cert && (cert.subject?.CN || cert.subjectaltname)), JSON.stringify(cert?.subject));
    ok("ALPN が http/1.1 でネゴシエートされる", secure.alpnProtocol === "http/1.1", secure.alpnProtocol);
    ok("authorized = true(証明書チェーン検証OK)", secure.authorized === true, String(secure.authorizationError));

    // 誤った servername なら失敗する=検証が実際に効いていることの確認
    let rejected = false;
    try {
      const raw2 = await openTunnelSocket({ hubUrl: `ws://localhost:${PORT}/__tunnel`, token: TOKEN, host: TARGET_HOST, port: 443, timeoutMs: 20_000 });
      await tlsWrapTunnel(raw2, "wrong-hostname.example.invalid", {});
    } catch { rejected = true; }
    ok("servername 不一致は TLS エラーになる(検証が効いている)", rejected);
    try { secure.destroy(); } catch {}
  } catch (err) {
    failed++;
    console.error("  FAIL  テスト実行中にエラー:", err.message);
    console.error("--- proxy logs ---\n" + proxy.logs.join(""));
    console.error("--- relay logs ---\n" + relay.logs.join(""));
  } finally {
    relay.kill("SIGTERM");
    proxy.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
