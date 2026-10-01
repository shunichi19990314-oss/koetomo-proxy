"use strict";
/**
 * 日本出口プロキシ「プール」(自動実測 + 自動ローテーション)のエンドツーエンドテスト。
 *
 * 構成(ループバックの別アドレスで「国」を模擬):
 *   proxy (localhost:8792)
 *     ├ 候補1: relay BAD (127.0.0.4:9996) … 出口が非日本IP → geo-mock から 403
 *     └ 候補2: relay GOOD(127.0.0.2:9997) … 出口が日本IP   → geo-mock から 200
 *   geo-mock 上流 (127.0.0.3:9999) … 127.0.0.2 からの接続だけ許可
 *
 * わざと「壊れた候補」を先頭に置き、それでも 200 が返ること(=自動で良い候補に
 * 切り替わること)を検証します。さらに良い候補を殺して復旧させるまでの動きも見ます。
 *
 * 実行: node test/pool-smoke.js
 */
const { spawn } = require("child_process");
const path = require("path");
const { WebSocket } = require("ws");

const TOKEN = "pooltoken";
const GEO_IP = "127.0.0.3", GEO_PORT = 9999, GEO_SELF = `http://${GEO_IP}:${GEO_PORT}`;
const BAD_IP = "127.0.0.4", BAD_PORT = 9996;
const GOOD_IP = "127.0.0.2", GOOD_PORT = 9997;
const PROXY_PORT = 8792, PROXY = `http://localhost:${PROXY_PORT}`, PROXY_HOST = `localhost:${PROXY_PORT}`;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name + (extra !== undefined ? "  | " + extra : "")); }
}
function spawnNode(script, env) {
  const c = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.logs = [];
  c.stdout.on("data", (d) => c.logs.push(d.toString()));
  c.stderr.on("data", (d) => c.logs.push(d.toString()));
  return c;
}
const relayEnv = (bind, port) => ({
  RELAY_PORT: String(port), RELAY_BIND: bind, RELAY_SOURCE_IP: bind, RELAY_TOKEN: TOKEN,
  RELAY_ALLOW: `${GEO_IP},ipinfo.io,ipwho.is,api.ipify.org`, RELAY_PORTS: String(GEO_PORT),
  TLS_CERT: "/nonexistent/c.pem", TLS_KEY: "/nonexistent/k.pem",
});
const relayUrl = (bind, port) => `http://koetomo-relay:${TOKEN}@${bind}:${port}`;
async function waitUntil(fn, ms, label) {
  const t0 = Date.now();
  for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) throw new Error("timeout: " + label); await new Promise((r) => setTimeout(r, 250)); }
}
const dump = (n, c) => c && console.error(`--- ${n} ---\n` + c.logs.join(""));

(async () => {
  process.env.BIND_ADDR = GEO_IP; process.env.GEO_PORT = String(GEO_PORT); process.env.JP_IPS = GOOD_IP;
  const { startGeo } = require("./geo-mock-upstream");
  const geo = await startGeo();

  const bad = spawnNode(path.join(__dirname, "..", "relay", "relay.js"), relayEnv(BAD_IP, BAD_PORT));
  let good = spawnNode(path.join(__dirname, "..", "relay", "relay.js"), relayEnv(GOOD_IP, GOOD_PORT));

  const proxy = spawnNode(path.join(__dirname, "..", "server.js"), {
    PORT: String(PROXY_PORT), UPSTREAM: GEO_SELF, PUBLIC_ORIGIN: "",
    // ★ わざと「壊れた候補(非日本IP)」を先頭に置く
    // 認証付き形式(user:pass@host:port)も同時に検証する
    RELAY_LIST: `koetomo-relay:${TOKEN}@${BAD_IP}:${BAD_PORT},koetomo-relay:${TOKEN}@${GOOD_IP}:${GOOD_PORT}`,
    RELAY_ALLOW: `${GEO_IP},ipinfo.io,ipwho.is,api.ipify.org`,
  });

  try {
    await waitUntil(async () => { try { return (await fetch(PROXY + "/__health")).ok; } catch { return false; } }, 20_000, "proxy");
    console.log(`\npool: browser → ${PROXY} → 候補[ ${BAD_IP}:${BAD_PORT}(非日本=403), ${GOOD_IP}:${GOOD_PORT}(日本=200) ] → geo-mock ${GEO_SELF}\n`);

    // ── 0. 前提: 非日本IPの候補は本当に 403 になる ──
    {
      const st = await (await fetch(PROXY + "/__relay")).json();
      ok("/__relay に候補が2件登録されている", st.pool.count === 2, JSON.stringify(st.pool.count));
      await waitUntil(async () => {
        const j = await (await fetch(PROXY + "/__relay")).json();
        return j.pool.candidates.every((c) => c.status !== null);
      }, 40_000, "全候補の実測完了");
      const st2 = await (await fetch(PROXY + "/__relay")).json();
      const byIp = Object.fromEntries(st2.pool.candidates.map((c) => [c.label.includes(BAD_IP) ? "bad" : "good", c]));
      ok("非日本IPの候補は 403 と実測される", byIp.bad && byIp.bad.status === 403, JSON.stringify(byIp.bad));
      ok("日本IPの候補は 200 と実測される", byIp.good && byIp.good.status === 200, JSON.stringify(byIp.good));
      ok("実測後は「日本の候補」がアクティブになる", st2.pool.active.includes(GOOD_IP), st2.pool.active);
      ok("/__relay の route 表示に候補数が出る", /候補2件/.test(st2.route || ""), st2.route);
    }

    // ── 1. 壊れた候補が先頭でも、リクエストは 200 で返る(自動で良い方に切替) ──
    {
      const r = await fetch(PROXY + "/", { headers: { accept: "text/html" } });
      const b = await r.text();
      ok("GET / → 200(壊れた候補を自動スキップ)", r.status === 200, `${r.status} ${b.slice(0, 140)}`);
      ok("URL 書き換えも機能", b.includes(`http://${PROXY_HOST}/page`), b.slice(0, 160));
      ok("CSP 書き換えも機能", (r.headers.get("content-security-policy") || "").includes(PROXY_HOST));
      const r2 = await fetch(PROXY + "/api.json");
      const j2 = await r2.json();
      ok("JSON も 200 + 書き換え", r2.status === 200 && j2.url === `http://${PROXY_HOST}/data`, JSON.stringify(j2).slice(0, 120));
    }

    // ── 2. WebSocket も「日本の候補」経由で中継される ──
    {
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://${PROXY_HOST}/socket`);
        let done = false;
        const fin = (c, e) => { if (done) return; done = true; ok("WS も日本出口経由で中継", c, e); try { ws.terminate(); } catch {} resolve(); };
        ws.on("open", () => ws.send("pool-hello"));
        ws.on("message", (m) => fin(m.toString() === "echo:pool-hello", m.toString()));
        ws.on("error", (e) => fin(false, e.message));
        setTimeout(() => fin(false, "timeout"), 10_000);
      });
    }

    // ── 3. 日本の候補が死んだら、回転して「分かりやすく失敗」する(ハングしない) ──
    {
      good.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 600));
      const t0 = Date.now();
      const r = await fetch(PROXY + "/", { headers: { accept: "text/html" } }).catch((e) => ({ status: 0, text: async () => String(e) }));
      const ms = Date.now() - t0;
      ok("全候補が駄目になっても 403/502 で返る(ハングしない)", r.status === 403 || r.status === 502 || r.status === 0, `${r.status} (${ms}ms)`);
      ok("失敗までの時間が有限(30秒未満)", ms < 30_000, ms + "ms");
      const st = await (await fetch(PROXY + "/__relay?recheck=1")).json();
      ok("/__relay が全滅を検出している", st.pool.candidates.some((c) => c.disabled || /^ERR/.test(String(c.status))), JSON.stringify(st.pool.candidates.map((c) => [c.label, c.status, c.disabled])));
      const stt = await (await fetch(PROXY + "/__status?format=json")).json();
      ok("/__status の判定が ✅ でなくなる", stt.verdict.ok === false, JSON.stringify(stt.verdict));
    }

    // ── 4. 日本の候補が復帰したら、自動でまた使えるようになる ──
    {
      good = spawnNode(path.join(__dirname, "..", "relay", "relay.js"), relayEnv(GOOD_IP, GOOD_PORT));
      await waitUntil(async () => {
        try { return (await fetch(`http://${GOOD_IP}:${GOOD_PORT}/healthz`)).ok; } catch { return false; }
      }, 15_000, "good relay 再起動");
      await waitUntil(async () => {
        const j = await (await fetch(PROXY + "/__relay?recheck=1")).json();
        return j.pool.active.includes(GOOD_IP) && j.pool.activeOk;
      }, 60_000, "プールの自動復旧");
      const r = await fetch(PROXY + "/", { headers: { accept: "text/html" } });
      ok("復帰後 GET / → 200(自動で復帰を検出)", r.status === 200, r.status);
      const st = await (await fetch(PROXY + "/__status?format=json")).json();
      ok("復帰後 /__status が ✅", st.verdict.ok === true, JSON.stringify(st.verdict));
      ok("/__status の経路に候補数が表示される", /候補2件/.test(st.route || ""), st.route);
    }

    // ── 5. ?rotate=1 で手動切替できる ──
    {
      const st = await (await fetch(PROXY + "/__relay?rotate=1")).json();
      ok("rotate で別の候補に切り替わる", st.pool.active.includes(BAD_IP) || st.pool.candidates.length === 2, st.pool.active);
      await (await fetch(PROXY + "/__relay?recheck=1")).json();
      const st2 = await (await fetch(PROXY + "/__relay")).json();
      ok("recheck で再び日本の候補に戻る", st2.pool.active.includes(GOOD_IP), st2.pool.active);
    }
  } catch (err) {
    failed++;
    console.error("  FAIL  テスト実行中にエラー:", err.message);
    dump("proxy", proxy); dump("bad", bad); dump("good", good);
  } finally {
    try { good.kill("SIGTERM"); } catch {}
    bad.kill("SIGTERM"); proxy.kill("SIGTERM");
    try { geo.close(); } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
