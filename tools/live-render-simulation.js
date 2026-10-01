"use strict";
/**
 * 「Render の本番構成」をこのマシンで再現し、実物の koetomo.fun に対して
 * どこまで動くかを実測するスクリプト。
 *
 *   ブラウザ役(このスクリプト) → server.js(:8794) → 公開プロキシ(日本) → koetomo.fun
 *
 * 検証するのは「HTML が 200 で返る」だけでなく、実際にアプリが起動するのに必要な
 *   ・5MB の /static/js/main.*.js がプロキシ経由で落ちて、URL書き換えまで通るか
 *   ・/__status が ✅ 判定になるか
 *   ・/__relay の deep probe(大容量アセット検査)が正しく働くか
 *
 * 実行: node tools/live-render-simulation.js [proxy1,proxy2,...]
 */
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.SIM_PORT || 8794);
const BASE = `http://127.0.0.1:${PORT}`;
const PROXIES = process.argv[2] || process.env.RELAY_LIST || "140.238.32.108:3128,38.175.202.151:443,45.43.60.220:8080";

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name + (extra !== undefined ? "  | " + extra : "")); }
}

(async () => {
  const proxy = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      UPSTREAM: "https://koetomo.fun",
      RELAY_LIST: PROXIES,
      RELAY_DEEP_PROBE: "1",
      PUBLIC_ORIGIN: "",
      TZ: "Asia/Tokyo",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  proxy.stdout.on("data", (d) => { const t = d.toString(); logs.push(t); if (/relay-pool|listening|BLOCKED|upstream/.test(t)) process.stdout.write(t); });
  proxy.stderr.on("data", (d) => { logs.push(d.toString()); process.stderr.write(d); });

  try {
    // 起動待ち
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(BASE + "/__health", { signal: AbortSignal.timeout(1500) })).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`\n=== Render 本番構成の再現: ${BASE} → 公開プロキシ(${PROXIES}) → https://koetomo.fun ===\n`);

    // プールの実測(deep probe 込み)が済むまで待つ
    console.log("[待機] 日本出口候補の実測(大容量アセット検査を含む)…");
    let st = null;
    for (let i = 0; i < 100; i++) {
      st = await (await fetch(BASE + "/__relay", { signal: AbortSignal.timeout(5000) })).json();
      const measured = st.pool.candidates.filter((c) => c.status !== null);
      if (measured.length === st.pool.count && measured.some((c) => c.deep)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log("\n--- /__relay の実測結果 ---");
    for (const c of st.pool.candidates) {
      console.log(`  ${c.active ? "▶" : " "} ${c.label}  status=${c.status}  ${c.ms ?? "-"}ms  出口=${c.egressIp || "?"}/${c.country || "?"}` +
        (c.deep ? `  deep=${c.deep}${c.deepMB ? ` ${c.deepMB}MB/${c.deepSec}s/${c.deepKBps}KB/s` : ""}` : "") +
        (c.disabled ? "  [無効化]" : ""));
    }
    ok("候補のうち1つ以上が 200 を返す", st.pool.candidates.some((c) => c.status === 200), JSON.stringify(st.pool.candidates.map((c) => c.status)));
    ok("アクティブな候補が決まっている", Boolean(st.pool.active), st.pool.active);

    // ── 1. トップページ(HTML) ──
    console.log("\n--- [1] トップページ ---");
    const t0 = Date.now();
    const r = await fetch(BASE + "/", { headers: { accept: "text/html" }, signal: AbortSignal.timeout(60_000) });
    const html = await r.text();
    console.log(`  HTTP ${r.status} / ${(html.length / 1024).toFixed(1)}KB / ${Date.now() - t0}ms`);
    ok("トップページが 200(403ブロックページではない)", r.status === 200, `${r.status} ${html.slice(0, 120)}`);
    ok("声ともの HTML が返っている", /koetomo|声とも|KoeTomo/i.test(html), html.slice(0, 160));
    ok("プロキシの書き換えが入っている(x-proxied-by)", r.headers.get("x-proxied-by") === "koetomo-proxy");
    ok("上流ドメイン(koetomo.fun)が本文から消えている", !html.includes("koetomo.fun"), (html.match(/koetomo\.fun[^"'<]{0,30}/) || [""])[0]);

    // ── 2. アプリ本体(main.*.js 数MB) ──
    const jsPath = (html.match(/["']([^"']*\/static\/js\/main\.[a-z0-9]+\.js)["']/i) || html.match(/src=["']([^"']+\.js)["']/i) || [])[1];
    if (jsPath) {
      console.log(`\n--- [2] アプリ本体 ${jsPath} ---`);
      const t1 = Date.now();
      const r2 = await fetch(BASE + (jsPath.startsWith("/") ? jsPath : "/" + jsPath), { signal: AbortSignal.timeout(180_000) });
      const js = await r2.text();
      const ms = Date.now() - t1;
      console.log(`  HTTP ${r2.status} / ${(js.length / 1048576).toFixed(2)}MB / ${(ms / 1000).toFixed(1)}秒 / ${Math.round((js.length / 1024) / (ms / 1000))}KB/s`);
      ok("アプリ本体(数MBのJS)が 200 で落ちる", r2.status === 200 && js.length > 100_000, `${r2.status} ${js.length}B`);
      ok("JS 内のURLも書き換えられている", !js.includes("koetomo.fun"), (js.match(/koetomo\.fun[^"'`)]{0,30}/) || [""])[0]);
      ok("JS が壊れていない(末尾まで取得)", /\}\)?;?\s*$/.test(js.slice(-200)) || js.length > 1_000_000, js.slice(-60));
    } else {
      console.log("\n--- [2] HTML から main.*.js を見つけられませんでした ---");
      ok("アプリ本体のURLを特定できる", false, html.slice(0, 300));
    }

    // ── 3. /__status の最終判定 ──
    console.log("\n--- [3] /__status ---");
    const s = await (await fetch(BASE + "/__status?format=json", { signal: AbortSignal.timeout(90_000) })).json();
    console.log(`  ${s.verdict.icon} ${s.verdict.title}`);
    console.log(`  上流プローブ: ok=${s.upstreamProbe.ok} status=${s.upstreamProbe.status} server=${s.upstreamProbe.server} ${s.upstreamProbe.ms}ms`);
    console.log(`  経路: ${s.route}`);
    console.log(`  日本出口IP: ${s.relay?.egressIp?.ip || "?"} / ${s.relay?.egressIp?.country || "?"} ${s.relay?.egressIp?.org || ""}`);
    console.log(`  Render自身のIP: ${s.egressIp?.ip || "?"} / ${s.egressIp?.country || "?"}`);
    ok("/__status が ✅ 判定", s.verdict.ok === true, s.verdict.title);
    ok("日本出口のIPが日本(JP)", s.relay?.egressIp?.country === "JP", JSON.stringify(s.relay?.egressIp));
  } catch (e) {
    failed++;
    console.error("\n  FAIL  実行中にエラー:", e.cause?.code || e.message);
    console.error("--- proxy logs (tail) ---\n" + logs.join("").split("\n").slice(-25).join("\n"));
  } finally {
    proxy.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  console.log(failed === 0
    ? "\n✅ この構成(公開プロキシを日本出口にする)で、Render のドメインから声ともが実際に読み込めます。"
    : "\n△ 一部が失敗しました。上のログの「relay-pool」行で、どの候補がどこで落ちたか分かります。");
  process.exit(failed ? 1 : 0);
})();
