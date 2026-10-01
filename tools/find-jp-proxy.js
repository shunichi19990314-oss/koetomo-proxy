"use strict";
/**
 * 無料の公開プロキシ一覧から「日本(JP)」のものだけを集め、
 * 実際に koetomo.fun が 403 以外を返すか=地域ブロックを突破できるかを実測する。
 *
 * 判定:
 *   1) プロキシ経由で ipinfo.io を叩き、出口IPの国が JP か
 *   2) プロキシ経由で https://koetomo.fun/ を叩き、ステータスが 403 以外か
 */
const { ProxyAgent, fetch } = require("undici");

const SOURCES = [
  { name: "geonode", url: "https://proxylist.geonode.com/api/proxy-list?limit=200&page=1&sortBy=lastChecked&sortType=desc&country=JP&protocols=http%2Chttps",
    parse: (j) => (j.data || []).map((x) => ({ ip: x.ip, port: Number(x.port), proto: (x.protocols || []).join("/") })) },
  { name: "proxyscrape", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=jp&proxy_format=protocolipport&format=json&timeout=10000",
    parse: (j) => (j.proxies || []).map((x) => ({ ip: x.ip, port: Number(x.port), proto: x.protocol })) },
  { name: "proxyscrape-all", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=jp&proxy_format=protocolipport&format=json&timeout=20000",
    parse: (j) => (j.proxies || []).map((x) => ({ ip: x.ip, port: Number(x.port), proto: x.protocol })) },
  { name: "geonode-2", url: "https://proxylist.geonode.com/api/proxy-list?limit=300&page=2&sortBy=lastChecked&sortType=desc&country=JP",
    parse: (j) => (j.data || []).map((x) => ({ ip: x.ip, port: Number(x.port), proto: (x.protocols || []).join("/") })) },
  { name: "freeproxylist", url: "https://api.freeproxylists.com/?country=JP",
    parse: (t) => String(t).match(/\d+\.\d+\.\d+\.\d+:\d+/g)?.map((l) => { const [ip, port] = l.split(":"); return { ip, port: Number(port), proto: "http" }; }) || [] },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TIMEOUT = 7000;

async function collect() {
  const found = new Map();
  for (const src of SOURCES) {
    try {
      const r = await fetch(src.url, { signal: AbortSignal.timeout(15000), headers: { "user-agent": UA, accept: "*/*" } });
      if (!r.ok) { console.log(`[list] ${src.name}: HTTP ${r.status}`); continue; }
      const ct = r.headers.get("content-type") || "";
      const raw = await r.text();
      const items = ct.includes("json") ? src.parse(JSON.parse(raw)) : src.parse(raw);
      let n = 0;
      for (const it of items) {
        if (!it.ip || !it.port) continue;
        const key = `${it.ip}:${it.port}`;
        if (!found.has(key)) { found.set(key, { ...it, key, src: src.name }); n++; }
      }
      console.log(`[list] ${src.name}: ${items.length}件中 ${n}件を追加 (累計 ${found.size})`);
    } catch (e) {
      console.log(`[list] ${src.name}: 取得失敗 ${e.cause?.code || e.message}`);
    }
  }
  return [...found.values()];
}

async function testOne(p) {
  let dispatcher;
  try {
    dispatcher = new ProxyAgent({ uri: `http://${p.ip}:${p.port}`, requestTls: { servername: undefined }, connectTimeout: TIMEOUT, headersTimeout: TIMEOUT });
  } catch (e) { return { ...p, err: "agent:" + e.message }; }
  const out = { ...p, err: null, country: null, ip: null, koetomo: null };
  try {
    const r1 = await fetch("https://ipinfo.io/json", { dispatcher, signal: AbortSignal.timeout(TIMEOUT), headers: { accept: "application/json", "user-agent": UA } });
    if (r1.ok) { const j = await r1.json(); out.ip = j.ip; out.country = j.country; out.org = (j.org || "").slice(0, 40); }
  } catch (e) { out.err = "ipinfo:" + (e.cause?.code || e.message); }
  if (out.country === "JP" || !out.err) {
    try {
      const r2 = await fetch("https://koetomo.fun/", { dispatcher, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT), headers: { "user-agent": UA, accept: "text/html", "accept-language": "ja" } });
      out.koetomo = r2.status;
      out.server = r2.headers.get("server");
      await r2.body?.cancel().catch(() => {});
    } catch (e) { out.koetomo = "ERR:" + (e.cause?.code || e.message); }
  }
  try { await dispatcher.close(); } catch {}
  return out;
}

(async () => {
  const list = await collect();
  console.log(`\n=== 候補 ${list.length} 件を実測します(並列20) ===\n`);
  const results = [];
  const CONC = 20;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, async () => {
    while (i < list.length) {
      const p = list[i++];
      const r = await testOne(p);
      results.push(r);
      if (r.country === "JP" || (r.koetomo && r.koetomo !== 403 && !String(r.koetomo).startsWith("ERR"))) {
        console.log(`  ★ ${r.key}  出口IP=${r.ip || "?"}/${r.country || "?"}  koetomo=${r.koetomo}  (${r.src})`);
      }
    }
  }));

  const alive = results.filter((r) => !r.err && r.country);
  const jp = results.filter((r) => r.country === "JP");
  const win = jp.filter((r) => r.koetomo && r.koetomo !== 403 && !String(r.koetomo).startsWith("ERR"));
  console.log(`\n=== 結果 ===`);
  console.log(` tested      : ${results.length}`);
  console.log(` 生存(出口IP確認可): ${alive.length}`);
  console.log(` 出口が日本(JP)     : ${jp.length}`);
  console.log(` ★ 日本でかつ koetomo が 403 以外: ${win.length}`);
  if (jp.length) {
    console.log(`\n--- 日本出口だったプロキシ(上位10) ---`);
    for (const r of jp.slice(0, 10)) console.log(`  ${r.key}  ip=${r.ip}  koetomo=${r.koetomo}  server=${r.server || "-"}  org=${r.org || "-"}  src=${r.src}`);
  }
  if (alive.length) {
    const byCountry = {};
    for (const r of alive) byCountry[r.country] = (byCountry[r.country] || 0) + 1;
    console.log(`\n--- 生存プロキシの出口国の内訳 ---`);
    console.log("  " + Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, n]) => `${c}:${n}`).join("  "));
  }
})();
