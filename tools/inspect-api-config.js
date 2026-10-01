"use strict";
/** JS バンドル内の API エンドポイント選択ロジック周辺を原文で確認する */
const { ProxyAgent, fetch } = require("undici");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CANDIDATES = (process.argv[2] || process.env.PROXIES ||
  "140.238.32.108:3128,38.175.202.151:443,45.43.60.220:8080,111.119.162.248:10944,140.227.61.201:3128").split(",").map((s) => s.trim()).filter(Boolean);

/** 生きている日本プロキシを候補から探す(公開プロキシは数分で死ぬため必須) */
async function pickAlive() {
  for (const addr of CANDIDATES) {
    const d = new ProxyAgent({ uri: `http://${addr}`, connectTimeout: 12_000, headersTimeout: 15_000, bodyTimeout: 60_000 });
    try {
      const r = await fetch("https://koetomo.fun/", { dispatcher: d, redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "user-agent": UA } });
      await r.body?.cancel().catch(() => {});
      if (r.status === 200) { console.log(`[proxy] 使用: ${addr} (200)`); return { addr, d }; }
      console.log(`[proxy] ${addr} → ${r.status} (スキップ)`);
    } catch (e) { console.log(`[proxy] ${addr} → 死亡 ${e.cause?.code || e.message}`); }
    try { await d.close(); } catch {}
  }
  throw new Error("生きている日本プロキシが1つもありません。tools/scan-jp-bigfile.js で探し直してください");
}

(async () => {
  const { d } = await pickAlive();
  const html = Buffer.from(await (await fetch("https://koetomo.fun/", { dispatcher: d, headers: { "user-agent": UA } })).arrayBuffer()).toString("utf8");
  const jsPath = (html.match(/["']([^"']*\/static\/js\/main\.[a-z0-9]+\.js)["']/i) || [])[1];
  if (!jsPath) throw new Error("main.*.js が見つかりません: " + html.slice(0, 200));
  const js = Buffer.from(await (await fetch("https://koetomo.fun" + jsPath, { dispatcher: d, headers: { "user-agent": UA }, signal: AbortSignal.timeout(120_000) })).arrayBuffer()).toString("utf8");
  console.log(`JS ${(js.length / 1048576).toFixed(2)}MB  ${jsPath}\n`);

  const show = (needle, before = 400, after = 700, max = 3) => {
    console.log("=".repeat(80));
    console.log(`>>> "${needle}" の周辺`);
    let i = -1, n = 0;
    while ((i = js.indexOf(needle, i + 1)) !== -1 && n < max) {
      n++;
      console.log(`\n--- ${n}件目 (offset ${i}) ---`);
      console.log(js.slice(Math.max(0, i - before), i + after).replace(/\s+/g, " "));
    }
    if (!n) console.log("  (見つからず)");
  };

  show("REACT_APP_API_ENDPOINT", 200, 900, 2);
  show("'koetomo.fun'!=window", 500, 700, 2);
  show("koetomo.fun", 300, 400, 6);
  show("sfu.skyway", 300, 400, 2);
  show("/v1/ws", 300, 400, 2);
  show("wss://", 250, 350, 3);

  try { await d.close(); } catch {}
})();
