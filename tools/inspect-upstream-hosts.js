"use strict";
/**
 * 声ともの JS バンドル(オリジナル)から「アプリが実際に叩くホスト名」を全部洗い出す。
 * プロキシの書き換え対象を決めるための調査用。
 *
 * 実行: node tools/inspect-upstream-hosts.js [proxy]
 */
const { ProxyAgent, fetch } = require("undici");
const dns = require("dns").promises;
const net = require("net");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PROXY = process.argv[2] || process.env.PROXY || "140.238.32.108:3128";
const ORIGIN = "https://koetomo.fun";

const d = new ProxyAgent({ uri: `http://${PROXY}`, connectTimeout: 20_000, headersTimeout: 25_000, bodyTimeout: 120_000 });

(async () => {
  console.log(`=== ${ORIGIN} の JS からアプリが使うホストを抽出 (経由: ${PROXY}) ===\n`);
  const html = Buffer.from(await (await fetch(ORIGIN + "/", { dispatcher: d, headers: { "user-agent": UA } })).arrayBuffer()).toString("utf8");
  const jsPaths = [...new Set([...html.matchAll(/["']([^"']+\.js)["']/g)].map((m) => m[1]))];
  console.log("HTML から検出した JS:", jsPaths.join(", ") || "(なし)");

  let js = "";
  for (const p of jsPaths) {
    const abs = p.startsWith("http") ? p : ORIGIN + (p.startsWith("/") ? p : "/" + p);
    try {
      const r = await fetch(abs, { dispatcher: d, headers: { "user-agent": UA }, signal: AbortSignal.timeout(120_000) });
      js += Buffer.from(await r.arrayBuffer()).toString("utf8");
      console.log(`  取得: ${abs} (${r.status})`);
    } catch (e) { console.log(`  失敗: ${abs} ${e.cause?.code || e.message}`); }
  }
  console.log(`\nJS 合計 ${(js.length / 1048576).toFixed(2)}MB`);

  // 1) REACT_APP_* の設定値
  console.log("\n--- REACT_APP_* / process.env 系の設定 ---");
  const envs = new Set();
  for (const m of js.matchAll(/['"](REACT_APP_[A-Z0-9_]+)['"]\s*:\s*(?:[a-zA-Z0-9_$]+\([^)]*\)|['"]([^'"]*)['"])/g)) {
    envs.add(`${m[1]} = ${m[2] !== undefined ? JSON.stringify(m[2]) : "(難読化された関数呼び出し)"}`);
  }
  [...envs].sort().forEach((e) => console.log("  " + e));

  // 2) ドメインらしき文字列を全部
  console.log("\n--- JS 内に出現するドメイン(上位40) ---");
  const hosts = {};
  for (const m of js.matchAll(/(?:[a-z0-9-]+\.)+(?:com|net|org|jp|fun|io|dev|app|co|me|xyz|info|cloud|firebaseio\.com|googleapis\.com|amazonaws\.com)\b/gi)) {
    const h = m[0].toLowerCase();
    hosts[h] = (hosts[h] || 0) + 1;
  }
  const sorted = Object.entries(hosts).sort((a, b) => b[1] - a[1]);
  sorted.slice(0, 40).forEach(([h, n]) => console.log(`  ${String(n).padStart(5)}回  ${h}`));

  // 3) koetomo.fun 系のサブドメインだけ抽出
  console.log("\n--- koetomo.fun 系のホスト(これが書き換え対象) ---");
  const ks = sorted.filter(([h]) => h.endsWith("koetomo.fun"));
  for (const [h, n] of ks) {
    let ip = "(DNS解決不可)";
    try { const r = await dns.lookup(h); ip = r.address; } catch {}
    console.log(`  ${h}  出現${n}回  DNS=${ip}`);
  }

  // 4) それぞれのホストが「日本以外から 403」か「日本からは 200」か
  console.log("\n--- 各地域ブロック状況(日本プロキシ経由 / この環境=シンガポール直) ---");
  for (const [h] of ks.concat([["koetomo.fun", 0]])) {
    const url = `https://${h}/`;
    let viaJp = "-", direct = "-";
    try {
      const r = await fetch(url, { dispatcher: d, redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "user-agent": UA, accept: "*/*" } });
      viaJp = `${r.status} ${r.headers.get("server") || ""}`.trim();
      await r.body?.cancel().catch(() => {});
    } catch (e) { viaJp = "ERR:" + (e.cause?.code || e.message); }
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "user-agent": UA, accept: "*/*" } });
      direct = `${r.status} ${r.headers.get("server") || ""}`.trim();
      await r.body?.cancel().catch(() => {});
    } catch (e) { direct = "ERR:" + (e.cause?.code || e.message); }
    console.log(`  ${h.padEnd(20)} 日本経由: ${String(viaJp).padEnd(22)} 直接(非日本): ${direct}`);
  }

  // 5) API のパスの手がかり
  console.log("\n--- API パスらしきもの(上位20) ---");
  const paths = {};
  for (const m of js.matchAll(/["'`](\/(?:api|v1|v2|graphql|socket\.io|ws|auth|users?)[^"'`\s]{0,60})["'`]/gi)) {
    const p = m[1].split("?")[0];
    paths[p] = (paths[p] || 0) + 1;
  }
  Object.entries(paths).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([p, n]) => console.log(`  ${String(n).padStart(4)}回  ${p}`));

  console.log("\n--- WebSocket / socket.io の手がかり ---");
  for (const kw of ["socket.io", "WebSocket", "wss://", "ws://", "firebase", "Firestore", "supabase", "ably", "pusher"]) {
    const n = js.split(kw).length - 1;
    if (n) console.log(`  ${kw}: ${n}回`);
  }

  try { await d.close(); } catch {}
})();
