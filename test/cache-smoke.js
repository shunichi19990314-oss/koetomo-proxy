"use strict";
/**
 * 静的アセットのキャッシュ(内容ハッシュ付きファイル)のテスト。
 *
 * 声とものアプリ本体 /static/js/main.<hash>.js は約5MBあり、日本出口が公開プロキシだと
 * 取得に十数秒かかります。これをキャッシュして 2 回目以降を瞬時にする機能の検証です。
 *
 * 実行: node test/cache-smoke.js
 */
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PROXY_PORT = 8798;
const UP_PORT = 9993;
const PROXY = `http://localhost:${PROXY_PORT}`;
const JS_PATH = "/static/js/main.deadbeef.js";
const BIG = "x".repeat(600_000);   // 600KB の JS 本体もどき

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name + (extra !== undefined ? "  | " + extra : "")); }
}

let upstreamHits = 0;
function startUpstream() {
  const server = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    if (p === JS_PATH) {
      upstreamHits++;
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      return res.end(`// koetomo main bundle ${upstreamHits}\nconst A="https://127.0.0.1:${UP_PORT}/x";\n` + BIG);
    }
    if (p === "/static/css/app.abc.css") {
      upstreamHits++;
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      return res.end(`body{color:red}/* ${upstreamHits} */`);
    }
    if (p === "/users/1") {           // API(=キャッシュしてはいけない)
      upstreamHits++;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: 1, hit: upstreamHits }));
    }
    if (p === "/index.html") {
      upstreamHits++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<html><body><script src="${JS_PATH}"></script></body></html>`);
    }
    res.writeHead(404); res.end("nf");
  });
  return new Promise((r) => server.listen(UP_PORT, "127.0.0.1", () => r(server)));
}

(async () => {
  const up = await startUpstream();
  const proxy = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PROXY_PORT), UPSTREAM: `http://127.0.0.1:${UP_PORT}`, PUBLIC_ORIGIN: "", ASSET_CACHE_MB: "32" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  proxy.stdout.on("data", (d) => logs.push(d.toString()));
  proxy.stderr.on("data", (d) => logs.push(d.toString()));

  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(PROXY + "/__health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    console.log(`\ncache: browser → ${PROXY} → upstream 127.0.0.1:${UP_PORT}\n`);

    // ── 1回目: MISS(上流へ行く) ──
    const r1 = await fetch(PROXY + JS_PATH);
    const b1 = await r1.text();
    ok("1回目は 200", r1.status === 200, r1.status);
    ok("1回目は x-proxy-cache: MISS", r1.headers.get("x-proxy-cache") === "MISS", r1.headers.get("x-proxy-cache"));
    ok("JS 内のURLが書き換えられている", !b1.includes(`127.0.0.1:${UP_PORT}`) && b1.includes(`localhost:${PROXY_PORT}`), b1.slice(0, 120));
    ok("本文が欠けていない(600KB超)", b1.length > 600_000, b1.length);
    ok("ブラウザにも強くキャッシュさせる", /max-age=31536000/.test(r1.headers.get("cache-control") || "") && /immutable/.test(r1.headers.get("cache-control") || ""), r1.headers.get("cache-control"));
    const hitsAfter1 = upstreamHits;

    // ── 2回目: HIT(上流へ行かない) ──
    const t0 = Date.now();
    const r2 = await fetch(PROXY + JS_PATH);
    const b2 = await r2.text();
    const ms2 = Date.now() - t0;
    ok("2回目は x-proxy-cache: HIT", r2.headers.get("x-proxy-cache") === "HIT", r2.headers.get("x-proxy-cache"));
    ok("2回目は上流へアクセスしていない", upstreamHits === hitsAfter1, `hits ${hitsAfter1} → ${upstreamHits}`);
    ok("2回目の本文が1回目と完全一致", b2 === b1, `${b1.length} vs ${b2.length}`);
    ok("2回目が速い(1秒未満)", ms2 < 1000, ms2 + "ms");
    ok("content-length が正しい", Number(r2.headers.get("content-length")) === Buffer.byteLength(b2), r2.headers.get("content-length"));

    // ── CSS もキャッシュされる ──
    await fetch(PROXY + "/static/css/app.abc.css");
    const rc = await fetch(PROXY + "/static/css/app.abc.css");
    ok("CSS も 2回目は HIT", rc.headers.get("x-proxy-cache") === "HIT", rc.headers.get("x-proxy-cache"));

    // ── API(ユーザ依存)は絶対にキャッシュしない ──
    const h0 = upstreamHits;
    const a1 = await (await fetch(PROXY + "/users/1")).json();
    const a2 = await (await fetch(PROXY + "/users/1")).json();
    ok("API は毎回上流へ行く(キャッシュされない)", upstreamHits === h0 + 2, `+${upstreamHits - h0}`);
    ok("API の応答が毎回異なる(=キャッシュされていない)", a1.hit !== a2.hit, JSON.stringify([a1, a2]));

    // ── HTML もキャッシュしない ──
    const h1 = upstreamHits;
    await fetch(PROXY + "/index.html");
    await fetch(PROXY + "/index.html");
    ok("HTML はキャッシュされない", upstreamHits >= h1 + 1, `+${upstreamHits - h1}`);

    // ── /__cache 診断 ──
    const c = await (await fetch(PROXY + "/__cache")).json();
    ok("/__cache にエントリが出る", c.entries >= 2 && c.bytes > 600_000, JSON.stringify({ e: c.entries, b: c.bytes }));
    ok("/__cache の hits が増えている", c.hits >= 2, JSON.stringify({ hits: c.hits, misses: c.misses }));
    ok("/__cache に JS のパスが記録されている", c.items.some((x) => x.key.includes("main.deadbeef.js")), JSON.stringify(c.items.map((x) => x.key)));

    // ── 304 / Range ではなく常に 200 で返る(シンプルさ優先)ことの確認 ──
    const r3 = await fetch(PROXY + JS_PATH, { headers: { "if-none-match": '"whatever"' } });
    ok("条件付きリクエストでも 200(本体を返す)", r3.status === 200, r3.status);
    await r3.body?.cancel().catch(() => {});
  } catch (err) {
    failed++;
    console.error("  FAIL  テスト実行中にエラー:", err.message);
    console.error("--- proxy logs ---\n" + logs.join("").split("\n").slice(-25).join("\n"));
  } finally {
    proxy.kill("SIGTERM");
    up.close();
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
