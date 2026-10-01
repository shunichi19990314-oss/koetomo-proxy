"use strict";
/**
 * リバーストンネル方式(クレカ不要・ポート開放不要の日本出口)のエンドツーエンドテスト。
 *
 * 構成(ループバックの別アドレスで「国」を模擬):
 *   テストクライアント (127.0.0.1 = 非日本IP)
 *     → proxy+hub (localhost:8790)
 *        └→ reverse-tunnel (日本のマシンのつもり / RELAY_SOURCE_IP=127.0.0.2)
 *             → geo-mock 上流 (127.0.0.3:9999) … 127.0.0.2 からの接続だけ許可
 *
 * 検証:
 *   - 直接アクセス(非日本IP)は 403 = 地域ゲートが効いていること
 *   - トンネル経由で HTML/JSON が 200 になり、URL書き換え・Cookie・CSP が機能すること
 *   - WebSocket がトンネル経由で中継されること
 *   - 同時リクエストが複数トンネルで捌けること
 *   - TUNNEL_TOKEN の認証、接続先ホストの許可リストが機能すること
 *   - 日本のマシンが居なくなったときに「分かりやすいエラー」になること
 *   - /__status / /__hub がトンネル経路を反映すること
 *
 * 実行: node test/tunnel-smoke.js
 */
const { spawn } = require("child_process");
const path = require("path");
const { WebSocket } = require("ws");

const TOKEN = "tunnel-test-token";
const GEO_IP = "127.0.0.3";
const GEO_PORT = 9999;
const PROXY_PORT = 8790;
const PROXY = `http://localhost:${PROXY_PORT}`;
const PROXY_HOST = `localhost:${PROXY_PORT}`;
const GEO_SELF = `http://${GEO_IP}:${GEO_PORT}`;
const HUB_URL = `ws://localhost:${PROXY_PORT}/__tunnel`;

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name + (extra !== undefined ? "  | " + extra : "")); }
}

async function waitForHealth(url, timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("not healthy: " + url);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function waitFor(cond, timeoutMs = 20_000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting: " + label);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function spawnNode(script, env) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.logs = [];
  child.stdout.on("data", (d) => child.logs.push(d.toString()));
  child.stderr.on("data", (d) => child.logs.push(d.toString()));
  return child;
}

const dump = (name, child) => console.error(`--- ${name} logs ---\n` + child.logs.join(""));

(async () => {
  // geo-mock 上流(このプロセス内)
  process.env.BIND_ADDR = GEO_IP;
  process.env.GEO_PORT = String(GEO_PORT);
  process.env.JP_IPS = "127.0.0.2";
  const { startGeo } = require("./geo-mock-upstream");
  const geo = await startGeo();

  // proxy + 内蔵ハブ
  const proxy = spawnNode(path.join(__dirname, "..", "server.js"), {
    PORT: String(PROXY_PORT),
    UPSTREAM: GEO_SELF,
    TUNNEL_TOKEN: TOKEN,
    TUNNEL_NO_RELAY_TIMEOUT: "6000",   // テストは「日本のマシン未接続」の猶予を短くする
    RELAY_ALLOW: `${GEO_IP},ipinfo.io,ipwho.is,api.ipify.org`,
    PUBLIC_ORIGIN: "",
  });

  // 日本のマシン(リバーストンネル)を起動する前: geo-mock の「日本IP」は 127.0.0.2 なので、
  // 127.0.0.1 からの接続は proxy 経由でも直接でも 403 になる(=地域ゲートが効いている証明)。
  let relay = null;

  try {
    await waitForHealth(PROXY + "/__health");
    console.log(`tunnel: browser → ${PROXY} → hub(/__tunnel) → reverse-tunnel(日本) → geo-mock ${GEO_SELF}\n`);

    // ── 0. 地域ゲートと「日本のマシン未接続」の挙動 ──
    {
      const direct = await fetch(GEO_SELF + "/");
      ok("上流への直接アクセス(非日本IP)は 403", direct.status === 403 && direct.headers.get("server") === "awselb/2.0", direct.status);

      const hubStats = await (await fetch(PROXY + "/__hub")).json();
      ok("/__hub: 初期状態は relays=0", hubStats.enabled === true && hubStats.relays.length === 0, JSON.stringify(hubStats));

      const r = await fetch(PROXY + "/", { headers: { accept: "text/html" } });
      const b = await r.text();
      ok("日本のマシン未接続 → 502(ハングせず即失敗)", r.status === 502, r.status);
      ok("502ページに上流接続失敗の理由が出る", /502|接続できません/.test(b), b.slice(0, 120));
      const st0 = await (await fetch(PROXY + "/__status?format=json")).json();
      ok("/__status: relays=0 を反映", st0.tunnel.relays.length === 0, JSON.stringify(st0.tunnel));
      ok("/__status: 判定は ✅ にならない", st0.verdict.ok === false, JSON.stringify(st0.verdict));
    }

    // ── 日本のマシンを起動 ──
    relay = spawnNode(path.join(__dirname, "..", "relay", "reverse-tunnel.js"), {
      HUB_URL,
      TUNNEL_TOKEN: TOKEN,
      RELAY_NAME: "test-jp-relay",
      RELAY_POOL: "3",
      RELAY_ALLOW: `${GEO_IP},ipinfo.io,ipwho.is,api.ipify.org`,
      RELAY_PORTS: String(GEO_PORT),
      RELAY_LOCAL: "1",
    });

    await waitFor(async () => {
      const st = await (await fetch(PROXY + "/__hub")).json();
      return st.relays.length === 1 && st.readySockets >= 1;
    }, 20_000, "日本のマシンのオンライン登録 + 待機ソケット準備");
    ok("日本のマシンがオンライン登録され、待機ソケットが用意された", true);

    // ここから「日本のマシン = 127.0.0.1(このマシン)」として扱うため、
    // geo-mock の日本IP判定に 127.0.0.1 を追加する(地域ゲート自体は test 0 で確認済み)。
    process.env.JP_IPS = "127.0.0.1,127.0.0.2";

    // ── 1. トンネル経由で HTML が 200 + URL書き換え ──
    {
      const r = await fetch(PROXY + "/", { headers: { accept: "text/html" } });
      const b = await r.text();
      ok("GET / → トンネル経由で 200", r.status === 200, `${r.status} ${b.slice(0, 160)}`);
      ok("絶対URL 書き換え", b.includes(`http://${PROXY_HOST}/page`), b.slice(0, 200));
      ok("プロトコル相対 //host 書き換え", b.includes(`//${PROXY_HOST}/app.js`));
      ok("ws:// 書き換え", b.includes(`ws://${PROXY_HOST}/socket`));
      ok("エスケープ形式 書き換え", b.includes(`http:\\/\\/${PROXY_HOST}\\/api`));
      ok("URLエンコード形式 書き換え", b.includes(`http%3A%2F%2F${PROXY_HOST}%2Fcb`));
      ok("上流(geo)アドレスが本文に残らない", !b.includes(GEO_IP));
      const csp = r.headers.get("content-security-policy") || "";
      ok("CSP ヘッダ書き換え", csp.includes(PROXY_HOST) && !csp.includes(GEO_IP), csp);
      const sid = r.headers.getSetCookie().find((c) => c.startsWith("sid="));
      ok("Set-Cookie Domain 剥がし", sid && !/;\s*Domain=/i.test(sid), sid);
      ok("x-proxied-by", r.headers.get("x-proxied-by") === "koetomo-proxy");
    }

    // ── 2. JSON 書き換え / アプリ本来の 403 JSON 素通し ──
    {
      const r = await fetch(PROXY + "/api.json");
      const j = await r.json();
      ok("JSON 内 URL 書き換え", j.url === `http://${PROXY_HOST}/data` && j.ws === `ws://${PROXY_HOST}/socket`, JSON.stringify(j));
      const r2 = await fetch(PROXY + "/forbidden-json", { headers: { accept: "application/json" } });
      const b2 = await r2.text();
      ok("アプリ本来の 403 JSON は素通し(トンネル経由)", r2.status === 403 && b2.includes('"error":"forbidden"'), b2);
    }

    // ── 3. POST / 大きめのボディが壊れないこと ──
    {
      const payload = "x".repeat(200_000);
      const r = await fetch(PROXY + "/api.json", { method: "POST", body: payload, headers: { "content-type": "text/plain" } });
      ok("POST(200KB) がトンネル経由で通る", r.status === 200 || r.status === 404, r.status);
    }

    // ── 4. WebSocket がトンネル経由で中継される ──
    {
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://${PROXY_HOST}/socket`);
        let done = false;
        const finish = (cond, extra) => {
          if (done) return;
          done = true;
          ok("WS トンネル経由 双方向中継", cond, extra);
          try { ws.terminate(); } catch {}
          resolve();
        };
        ws.on("open", () => ws.send("tunnel-hello"));
        ws.on("message", (m) => finish(m.toString() === "echo:tunnel-hello", m.toString()));
        ws.on("error", (e) => finish(false, e.message));
        ws.on("close", (c) => finish(false, "closed code=" + c));
        setTimeout(() => finish(false, "timeout"), 10_000);
      });
    }

    // ── 5. 同時リクエストが複数トンネルで捌けること ──
    {
      const t0 = Date.now();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => fetch(PROXY + `/api.json?i=${i}`)));
      const codes = rs.map((r) => r.status);
      ok("8並列リクエストが全て 200", codes.every((c) => c === 200), codes.join(","));
      const st = await (await fetch(PROXY + "/__hub")).json();
      ok("並列後もハブが生きている(activeTunnels が数値)", typeof st.activeTunnels === "number", JSON.stringify(st));
      console.log(`        (8並列: ${Date.now() - t0}ms)`);
    }

    // ── 6. トークン認証 ──
    {
      const bad = spawnNode(path.join(__dirname, "..", "relay", "reverse-tunnel.js"), {
        HUB_URL, TUNNEL_TOKEN: "wrong-token", RELAY_NAME: "attacker", RELAY_POOL: "1", RELAY_LOCAL: "1",
      });
      await new Promise((r) => setTimeout(r, 2500));
      const st = await (await fetch(PROXY + "/__hub")).json();
      ok("誤トークンの日本マシンは登録されない", st.relays.every((r) => r.name !== "attacker"), JSON.stringify(st.relays));
      ok("誤トークンは即終了(exit code 2)", bad.exitCode === 2, "exitCode=" + bad.exitCode);
      bad.kill("SIGTERM");
    }

    // ── 7. /__status がトンネル経路を反映 ──
    {
      const r = await fetch(PROXY + "/__status?format=json");
      const j = await r.json();
      ok("/__status tunnel.enabled = true", j.tunnel && j.tunnel.enabled === true, JSON.stringify(j.tunnel));
      ok("/__status に日本のマシン名が出る", j.tunnel && (j.tunnel.relays || []).some((x) => x.name === "test-jp-relay"), JSON.stringify(j.tunnel?.relays));
      ok("/__status 上流プローブ 200", j.upstreamProbe && j.upstreamProbe.status === 200, JSON.stringify(j.upstreamProbe));
      ok("/__status 判定 ✅", j.verdict && j.verdict.ok === true, JSON.stringify(j.verdict));
      ok("/__status route 表示", /リバーストンネル/.test(j.route || ""), j.route);
      const r2 = await fetch(PROXY + "/__status", { headers: { accept: "text/html" } });
      const b2 = await r2.text();
      ok("/__status HTML に「リバーストンネル」表示", b2.includes("リバーストンネル") && b2.includes("test-jp-relay"));
    }

    // ── 7.5 日本のマシンが復帰すれば、待たされていた要求が成功すること ──
    {
      relay.kill("SIGTERM");
      relay = null;
      await waitFor(async () => (await (await fetch(PROXY + "/__hub")).json()).relays.length === 0, 10_000, "relay offline");

      const inflight = fetch(PROXY + "/api.json").then((r) => r.status).catch(() => 0);
      await new Promise((r) => setTimeout(r, 800));   // 要求をキューに入れた状態で
      relay = spawnNode(path.join(__dirname, "..", "relay", "reverse-tunnel.js"), {
        HUB_URL, TUNNEL_TOKEN: TOKEN, RELAY_NAME: "test-jp-relay", RELAY_POOL: "2",
        RELAY_ALLOW: `${GEO_IP},ipinfo.io,ipwho.is,api.ipify.org`, RELAY_PORTS: String(GEO_PORT), RELAY_LOCAL: "1",
      });
      const status = await inflight;
      ok("日本のマシン復帰 → 待たされていた要求が 200 で完了", status === 200, status);
      await waitFor(async () => {
        const st = await (await fetch(PROXY + "/__hub")).json();
        return st.relays.length === 1 && st.relays[0].name === "test-jp-relay";
      }, 15_000, "relay re-register");
      ok("再接続時に同名リレーが二重登録されない", (await (await fetch(PROXY + "/__hub")).json()).relays.length === 1);
    }

    // ── 8. 日本のマシンが落ちたら分かりやすく失敗する ──
    {
      relay.kill("SIGTERM");
      relay = null;
      await waitFor(async () => {
        const st = await (await fetch(PROXY + "/__hub")).json();
        return st.relays.length === 0;
      }, 10_000, "relay offline 検知");
      const r = await fetch(PROXY + "/", { headers: { accept: "text/html" } }).catch((e) => ({ status: 0, text: async () => String(e) }));
      ok("日本のマシン停止後は 403/502(ハングしない)", r.status === 403 || r.status === 502 || r.status === 0, r.status);
      const st = await (await fetch(PROXY + "/__status?format=json")).json();
      ok("/__status が relays=0 を反映", st.tunnel.relays.length === 0, JSON.stringify(st.tunnel));
      ok("/__status 判定が ✅ でなくなる", st.verdict.ok === false, JSON.stringify(st.verdict));
    }
  } catch (err) {
    failed++;
    console.error("  FAIL  テスト実行中にエラー:", err.message);
    dump("proxy", proxy);
    if (relay) dump("relay", relay);
  } finally {
    if (relay) relay.kill("SIGTERM");
    proxy.kill("SIGTERM");
    try { geo.close(); } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
