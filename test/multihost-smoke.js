"use strict";
/**
 * マルチホスト対応(API が別サブドメインにあるケース)の自動テスト。
 *
 * 本物の声ともは Web本体(koetomo.fun)とは別に API(a.koetomo.fun / api.meetscom.com)を
 * 叩きます。これらは同じ ALB の地域ブロック対象なので、プロキシは
 *   /__up/<host>/<path>  →  https://<host>/<path>
 * に書き換えて自分経由にする必要があります(同一オリジン化するので CORS も出ません)。
 *
 * 構成:
 *   proxy (localhost:8793)
 *     ├ UPSTREAM        = http://127.0.0.1:9991  ("Web本体" のつもり)
 *     └ UPSTREAM_HOSTS  = api.test.local=http://127.0.0.1:9992  ("API" のつもり)
 *
 * 実行: node test/multihost-smoke.js
 */
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PROXY_PORT = 8793;
const MAIN_PORT = 9991;
const API_PORT = 9992;
const PROXY = `http://localhost:${PROXY_PORT}`;
const PROXY_HOST = `localhost:${PROXY_PORT}`;
const PROTO = "http";                       // ローカル検証なのでプロキシ自身のスキームは http
const MAIN_ORIGIN = `http://127.0.0.1:${MAIN_PORT}`;   // 上流から見た「Web本体」のオリジン
const API_ALIAS = "api.test.local";

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name + (extra !== undefined ? "  | " + extra : "")); }
}

// ── "Web本体" もどき: HTML/JS の中に API ホストへの参照を各種形で埋め込む ──
function startMain() {
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>声とも(マルチホスト模擬)</title></head><body>
<script>
  window.ENV = {
    API: '${API_ALIAS}',
    API_ABS: 'https://${API_ALIAS}/v1',
    API_REL: '//${API_ALIAS}/v1',
    WS: 'wss://${API_ALIAS}/v1/ws',
    ESCAPED: "https:\\/\\/${API_ALIAS}\\/v1",
    ENCODED: 'https%3A%2F%2F${API_ALIAS}%2Fv1',
    OTHER: 'https://not-allowed.example.com/x'
  };
</script>
<script src="/static/js/main.abc123.js"></script>
</body></html>`;
  const js = `window.CFG={endpoint:'${API_ALIAS}',ws:'wss://${API_ALIAS}/v1/ws',host:'koetomo-should-not-change.example'};`;
  const server = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    if (p === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (p.startsWith("/static/js/")) {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      return res.end(js);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((r) => server.listen(MAIN_PORT, "127.0.0.1", () => r(server)));
}

// ── "API" もどき: Origin/Host/Cookie/WS を検証できるようにする ──
function startApi() {
  const seen = {};
  const server = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    seen.origin = req.headers["origin"];
    seen.host = req.headers["host"];
    seen.referer = req.headers["referer"];
    seen.cookie = req.headers["cookie"];
    if (p === "/v1/users/1") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": [`sid=apicookie123; Domain=${API_ALIAS}; Path=/; Secure; HttpOnly; SameSite=None`],
      });
      return res.end(JSON.stringify({ id: 1, name: "test", self: `https://${API_ALIAS}/v1/users/1` }));
    }
    if (p === "/v1/headers") {
      // 注意: JSON で返すとプロキシが「上流ホスト→自オリジン」に書き換えてしまう(仕様どおり)。
      // ここは上流が見た生の値を検証したいので、バイナリ素通しになる型で返す。
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(JSON.stringify(seen));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 404, error: "not_found", path: p }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    seen.wsOrigin = req.headers["origin"];
    seen.wsPath = req.url;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (d) => ws.send("api-echo:" + d.toString()));
    });
  });
  return new Promise((r) => server.listen(API_PORT, "127.0.0.1", () => r({ server, seen })));
}

function spawnProxy(env) {
  const c = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  c.logs = [];
  c.stdout.on("data", (d) => c.logs.push(d.toString()));
  c.stderr.on("data", (d) => c.logs.push(d.toString()));
  return c;
}

(async () => {
  const main = await startMain();
  const api = await startApi();
  const proxy = spawnProxy({
    PORT: String(PROXY_PORT),
    UPSTREAM: `http://127.0.0.1:${MAIN_PORT}`,
    UPSTREAM_HOSTS: `${API_ALIAS}=http://127.0.0.1:${API_PORT}`,
    PUBLIC_ORIGIN: "",
  });

  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(PROXY + "/__health", { signal: AbortSignal.timeout(1500) })).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`\nmultihost: browser → ${PROXY} → main(127.0.0.1:${MAIN_PORT}) / API(${API_ALIAS}→127.0.0.1:${API_PORT})\n`);

    // ── 1. HTML / JS 内の API ホストが /__up/ 配下に書き換わる ──
    const html = await (await fetch(PROXY + "/")).text();
    ok("素のホスト名 → <origin>/__up/<host>", html.includes(`API: '${PROXY_HOST}/__up/${API_ALIAS}'`), (html.match(/API: '[^']*/) || [""])[0]);
    ok("http(s):// 形式 → <自スキーム>://<origin>/__up/<host>", html.includes(`${PROTO}://${PROXY_HOST}/__up/${API_ALIAS}/v1'`), (html.match(/API_ABS:[^\n]*/) || [""])[0]);
    ok("// 相対形式 → //<origin>/__up/<host>", html.includes(`'//${PROXY_HOST}/__up/${API_ALIAS}/v1'`));
    ok("wss:// 形式 → wss://<origin>/__up/<host>", html.includes(`wss://${PROXY_HOST}/__up/${API_ALIAS}/v1/ws`));
    // \/\/ エスケープ形式: エスケープが一部残っても JS 解釈後は同じURLになればよい
    ok("\\/\\/ エスケープ形式も書き換え(解釈後に正しいURL)", html.replace(/\\\//g, "/").includes(`${PROTO}://${PROXY_HOST}/__up/${API_ALIAS}/v1`), (html.match(/ESCAPED:[^\n]*/) || [""])[0]);
    ok("URLエンコード形式もエンコードのまま書き換え", html.includes(`${PROTO}%3A%2F%2F${PROXY_HOST}%2F__up%2F${API_ALIAS}%2Fv1`), (html.match(/ENCODED:[^\n]*/) || [""])[0]);
    ok("許可外のホストは書き換えない", html.includes("https://not-allowed.example.com/x"));

    const js = await (await fetch(PROXY + "/static/js/main.abc123.js")).text();
    ok("JS 内の API ホストも書き換え", js.includes(`endpoint:'${PROXY_HOST}/__up/${API_ALIAS}'`), js.slice(0, 140));
    ok("JS 内の wss も書き換え", js.includes(`wss://${PROXY_HOST}/__up/${API_ALIAS}/v1/ws`));

    // ── 2. /__up/<host>/... が実際に API ホストへルーティングされる ──
    const r = await fetch(`${PROXY}/__up/${API_ALIAS}/v1/users/1`);
    const j = await r.json();
    ok("/__up/ 経由で API に到達(200 + JSON)", r.status === 200 && j.id === 1, JSON.stringify(j));
    ok("API の応答内 URL も書き換わる", j.self === `${PROTO}://${PROXY_HOST}/__up/${API_ALIAS}/v1/users/1`, j.self);
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith("sid="));
    ok("API の Set-Cookie から Domain が剥がれる", cookie && !/;\s*Domain=/i.test(cookie), cookie);

    // ── 3. 上流から見える Origin / Host が「API ホストそのもの」になっているか ──
    const h = JSON.parse(await (await fetch(`${PROXY}/__up/${API_ALIAS}/v1/headers`, { headers: { referer: `${PROXY}/timeline`, cookie: "sid=apicookie123" } })).text());
    // ブラウザは API が別ホストでも「ページ側(Web本体)のオリジン」を Origin/Referer に載せる
    ok("Origin は Web本体のオリジンになる", h.origin === MAIN_ORIGIN, h.origin);
    ok("Host は API ホスト(実体)になる", h.host === `127.0.0.1:${API_PORT}`, h.host);
    ok("Referer が Web本体オリジン + 元パス に戻る", h.referer === `${MAIN_ORIGIN}/timeline`, h.referer);
    ok("Cookie が API へ転送される", /sid=apicookie123/.test(h.cookie || ""), h.cookie);

    // ── 4. /__up/ 配下の WebSocket も中継される ──
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${PROXY_HOST}/__up/${API_ALIAS}/v1/ws`);
      let done = false;
      const fin = (c, e) => { if (done) return; done = true; ok("API ホストへの WS 中継", c, e); try { ws.terminate(); } catch {} resolve(); };
      ws.on("open", () => ws.send("hello-api"));
      ws.on("message", (m) => fin(m.toString() === "api-echo:hello-api", m.toString()));
      ws.on("error", (e) => fin(false, e.message));
      ws.on("close", (c) => fin(false, "closed " + c));
      setTimeout(() => fin(false, "timeout"), 8000);
    });
    ok("WS の Origin も Web本体のオリジンになる", api.seen.wsOrigin === MAIN_ORIGIN, api.seen.wsOrigin);
    ok("WS のパスが正しく転送される", api.seen.wsPath === "/v1/ws", api.seen.wsPath);

    // ── 5. 許可リスト外のホストは拒否(オープンプロキシ化の防止) ──
    const bad = await fetch(`${PROXY}/__up/evil.example.com/`);
    ok("許可外ホストは 403 で拒否", bad.status === 403, bad.status);
    const badWs = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${PROXY_HOST}/__up/evil.example.com/x`);
      const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve("timeout"); }, 4000);
      ws.on("error", () => { clearTimeout(t); resolve("error"); });
      ws.on("unexpected-response", (_r, res) => { clearTimeout(t); resolve(res.statusCode); });
      ws.on("open", () => { clearTimeout(t); ws.terminate(); resolve("open"); });
    });
    ok("許可外ホストへの WS も拒否", badWs === 403 || badWs === "error", badWs);

    // ── 6. メインホストは従来どおり ──
    const r2 = await fetch(PROXY + "/");
    ok("メインホストは従来どおり 200", r2.status === 200);
    ok("x-proxied-by が付く", r2.headers.get("x-proxied-by") === "koetomo-proxy");
  } catch (err) {
    failed++;
    console.error("  FAIL  テスト実行中にエラー:", err.message);
    console.error("--- proxy logs ---\n" + proxy.logs.join("").split("\n").slice(-25).join("\n"));
  } finally {
    proxy.kill("SIGTERM");
    main.close(); api.server.close();
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
