"use strict";
/**
 * 実物の koetomo.fun に対して「マルチホスト(API 別サブドメイン)対応」が効くかを検証する。
 *
 *   ① トップページ 200 + アプリ本体(main.*.js)が落ちる
 *   ② JS 内の a.koetomo.fun / api.meetscom.com / mtrcs.koetomo.fun が
 *      <自分のオリジン>/__up/<host> に書き換わっている
 *   ③ /__up/a.koetomo.fun/... へのリクエストが 403(地域ブロック)以外を返す
 *      = 別ホストの API も日本出口経由で届いている
 *   ④ /__status が ✅
 *
 * 実行: node tools/live-multihost-check.js
 */
const { spawn } = require("child_process");
const path = require("path");
const { ProxyAgent, fetch: ufetch } = require("undici");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.SIM_PORT || 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CANDIDATES = (process.env.RELAY_LIST || "140.238.32.108:3128,38.175.202.151:443,45.43.60.220:8080,111.119.162.248:10944,140.227.61.201:3128").split(",").map(s => s.trim()).filter(Boolean);

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name + (extra !== undefined ? "  | " + extra : "")); }
}

/** 生きている日本プロキシを探す */
async function pickAlive() {
  for (const addr of CANDIDATES) {
    const d = new ProxyAgent({ uri: `http://${addr}`, connectTimeout: 12_000, headersTimeout: 15_000, bodyTimeout: 60_000 });
    try {
      const r = await ufetch("https://koetomo.fun/", { dispatcher: d, redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "user-agent": UA } });
      await r.body?.cancel().catch(() => {});
      if (r.status === 200) { console.log(`[proxy] 生存確認: ${addr}`); try { await d.close(); } catch {} return addr; }
      console.log(`[proxy] ${addr} → ${r.status}`);
    } catch (e) { console.log(`[proxy] ${addr} → 死亡 ${e.cause?.code || e.message}`); }
    try { await d.close(); } catch {}
  }
  return null;
}

(async () => {
  const alive = await pickAlive();
  if (!alive) { console.log("\n❌ 生きている日本プロキシがありません。tools/scan-jp-bigfile.js で探し直してください。"); process.exit(1); }

  const proxy = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(PORT), UPSTREAM: "https://koetomo.fun", RELAY_LIST: alive, RELAY_DEEP_PROBE: "1", PUBLIC_ORIGIN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  proxy.stdout.on("data", (d) => logs.push(d.toString()));
  proxy.stderr.on("data", (d) => logs.push(d.toString()));

  try {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + "/__health", { signal: AbortSignal.timeout(1500) })).ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
    console.log(`\n=== ${BASE} → ${alive}(日本) → koetomo.fun / a.koetomo.fun / api.meetscom.com ===\n`);

    // ① トップ + JS
    const html = await (await fetch(BASE + "/", { headers: { accept: "text/html" }, signal: AbortSignal.timeout(60_000) })).text();
    ok("① トップページ 200(声ともの HTML)", html.includes("<div id=\"root\"") || /koetomo|声とも/i.test(html), html.slice(0, 100));
    const jsPath = (html.match(/["']([^"']*\/static\/js\/main\.[a-z0-9]+\.js)["']/i) || [])[1];
    ok("① HTML から main.*.js を発見", Boolean(jsPath), jsPath);
    const js = jsPath ? await (await fetch(BASE + jsPath, { signal: AbortSignal.timeout(180_000) })).text() : "";
    ok("① アプリ本体(数MB)が落ちた", js.length > 1_000_000, (js.length / 1048576).toFixed(2) + "MB");

    // ② 別ホストが /__up/ 配下に書き換わっているか
    const HOST = `127.0.0.1:${PORT}`;
    for (const h of ["a.koetomo.fun", "api.meetscom.com", "mtrcs.koetomo.fun"]) {
      // 難読化JSでは 'https://mtrcs.koetom'+'o.fun' のようにホスト名が分断されているため、
      // 「完全一致」または「分断された断片が /__up/ 配下に書き換わっている」のどちらでもOKとする
      const full = js.split(`${HOST}/__up/${h}`).length - 1;
      const frag = js.split(`/__up/${h.slice(0, Math.max(6, h.length - 4))}`).length - 1;
      const raw = js.split(h).length - 1;
      ok(`② ${h} → /__up/ 配下に書き換え (完全一致${full} / 断片${frag} / 素のまま${raw})`, full > 0 || frag > 0, `素のまま残存=${raw}`);
    }
    ok("② API_ENDPOINT の値が自分のオリジンになっている", js.includes(`'${HOST}/__up/a.koetomo.fun'`) || js.includes(`"${HOST}/__up/a.koetomo.fun"`), (js.match(/REACT_APP_API_ENDPOINT'\s*:\s*'[^']{0,60}/) || [""])[0]);

    // ③ /__up/<host>/... が 403 以外を返す(=地域ブロックを通過している)
    for (const [h, p] of [["a.koetomo.fun", "/users/1"], ["a.koetomo.fun", "/"], ["api.meetscom.com", "/"], ["mtrcs.koetomo.fun", "/"]]) {
      const r = await fetch(`${BASE}/__up/${h}${p}`, { signal: AbortSignal.timeout(45_000), headers: { accept: "application/json" } }).catch((e) => ({ status: 0, headers: new Map(), text: async () => String(e) }));
      const body = await r.text().catch(() => "");
      const blocked = r.status === 403 && /awselb|Forbidden/i.test(String(r.headers?.get?.("server") || "") + body.slice(0, 200));
      console.log(`      /__up/${h}${p} → ${r.status} ${String(body).slice(0, 60).replace(/\s+/g, " ")}`);
      ok(`③ /__up/${h}${p} が地域ブロック(403 awselb)でない`, !blocked && r.status !== 0, r.status);
    }

    // 許可外ホストは拒否されるか(オープンプロキシ化防止)
    {
      const r = await fetch(BASE + "/__up/example.com/", { signal: AbortSignal.timeout(15_000) }).catch(() => ({ status: 0 }));
      ok("③ 許可外ホスト(example.com)は 403 で拒否", r.status === 403, r.status);
    }

    // ④ /__status
    const st = await (await fetch(BASE + "/__status?format=json", { signal: AbortSignal.timeout(90_000) })).json();
    console.log(`\n  /__status: ${st.verdict.icon} ${st.verdict.title}`);
    console.log(`  日本出口IP: ${st.relay?.egressIp?.ip} / ${st.relay?.egressIp?.country}  Render自身: ${st.egressIp?.ip} / ${st.egressIp?.country}`);
    ok("④ /__status が ✅ 判定", st.verdict.ok === true, st.verdict.title);
  } catch (e) {
    failed++;
    console.error("\n  FAIL  エラー:", e.cause?.code || e.message);
    console.error("--- proxy logs (tail) ---\n" + logs.join("").split("\n").slice(-20).join("\n"));
  } finally {
    proxy.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
