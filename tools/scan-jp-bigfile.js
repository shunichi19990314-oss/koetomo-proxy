"use strict";
/**
 * 「日本出口の無料公開プロキシで、声とものアプリ本体が本当に読み込めるか」の総当たり検査。
 *
 * 背景: HTML シェル(1.4KB)や小さな画像は多くの公開プロキシで取れますが、
 * 声ともは React 製で /static/js/main.*.js が数MB あります。これが落ちないと
 * ページは真っ白=実用になりません。そこで
 *   ① 日本のプロキシを複数の無料リストからかき集める
 *   ② 生きているものだけ選別(CONNECT + TLS + GET /)
 *   ③ 生き残りに「数MBの実ファイル」を落とさせて、速度と成否を測る
 * を行い、Render の RELAY_LIST に入れる価値があるものを判定します。
 *
 * 実行: node tools/scan-jp-bigfile.js
 */
const { ProxyAgent, fetch } = require("undici");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ORIGIN = process.env.TARGET || "https://koetomo.fun";
const HOST = new URL(ORIGIN).hostname;
const CONC = Number(process.env.CONC || 40);
const QUICK_MS = 8_000;
const BIG_MS = Number(process.env.BIG_MS || 45_000);

const SOURCES = [
  { name: "geonode-p1", url: "https://proxylist.geonode.com/api/proxy-list?limit=300&page=1&sortBy=lastChecked&sortType=desc&country=JP", json: (j) => (j.data || []).map((x) => `${x.ip}:${x.port}`) },
  { name: "geonode-p2", url: "https://proxylist.geonode.com/api/proxy-list?limit=300&page=2&sortBy=lastChecked&sortType=desc&country=JP", json: (j) => (j.data || []).map((x) => `${x.ip}:${x.port}`) },
  { name: "geonode-p3", url: "https://proxylist.geonode.com/api/proxy-list?limit=300&page=3&sortBy=lastChecked&sortType=desc&country=JP", json: (j) => (j.data || []).map((x) => `${x.ip}:${x.port}`) },
  { name: "proxyscrape-jp", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=jp&proxy_format=protocolipport&format=json&timeout=20000", json: (j) => (j.proxies || []).map((x) => `${x.ip}:${x.port}`) },
  { name: "proxyscan-jp", url: "https://proxyscan.io/api/proxy?country=JP&limit=200&type=http,https", json: (j) => (Array.isArray(j) ? j : []).map((x) => `${x.Ip}:${x.Port}`) },
  { name: "proxylist-dl", url: "https://www.proxy-list.download/api/v1/get?type=https&country=JP", json: (j) => (Array.isArray(j) ? j : []).map((x) => `${x.IP}:${x.PORT}`) },
  { name: "pubproxy-jp", url: "http://pubproxy.com/api/proxy?country=JP&limit=50&type=http", json: (j) => (j.proxies || []).map((x) => `${x.ipPort}`) },
  { name: "freeproxylist-jp", url: "https://free-proxy-list.net/", html: (t) => extractFromTable(t, /japan/i) },
  { name: "proxylist-raw", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", txt: (t) => t.split(/\s+/).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)).slice(0, 1200) },
];

/** free-proxy-list.net 風のテーブルから国名が一致する行の ip:port を抜く */
function extractFromTable(html, countryRe) {
  const out = [];
  const rows = String(html).split(/<tr/i);
  for (const r of rows) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    if (cells.length < 3) continue;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(cells[0]) && /^\d+$/.test(cells[1]) && countryRe.test(cells[3] || cells[2] || "")) {
      out.push(`${cells[0]}:${cells[1]}`);
    }
  }
  return out;
}

async function collect() {
  const set = new Map();
  await Promise.all(SOURCES.map(async (src) => {
    try {
      const r = await fetch(src.url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": UA, accept: "*/*" }, redirect: "follow" });
      if (!r.ok) return console.log(`[list] ${src.name}: HTTP ${r.status}`);
      const raw = await r.text();
      let items = [];
      try {
        if (src.json) items = src.json(JSON.parse(raw));
        else if (src.html) items = src.html(raw);
        else if (src.txt) items = src.txt(raw);
      } catch { return console.log(`[list] ${src.name}: パース失敗`); }
      let n = 0;
      for (const it of items) {
        const s = String(it || "").trim();
        if (!/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) continue;
        if (!set.has(s)) { set.set(s, { addr: s, src: src.name }); n++; }
      }
      console.log(`[list] ${src.name}: ${items.length}件中 ${n}件追加 (累計 ${set.size})`);
    } catch (e) { console.log(`[list] ${src.name}: 失敗 ${e.cause?.code || e.message}`); }
  }));
  return [...set.values()];
}

/** CONNECT + TLS + GET / をまとめて速く判定 */
function quickCheck(addr) {
  return new Promise((resolve) => {
    const [pip, pport] = addr.split(":");
    const sock = net.connect({ host: pip, port: Number(pport) });
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} resolve(null); }, QUICK_MS);
    const bad = () => { clearTimeout(timer); try { sock.destroy(); } catch {} resolve(null); };
    sock.on("error", bad);
    sock.on("connect", () => sock.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`));
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      if (!/^HTTP\/1\.[01] 200/.test(buf.subarray(0, i).toString())) return bad();
      sock.removeAllListeners("data");
      const secure = tls.connect({ socket: sock, servername: HOST }, () => {
        secure.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: ${UA}\r\nAccept: text/html\r\nAccept-Language: ja\r\nConnection: close\r\n\r\n`);
        let resp = Buffer.alloc(0);
        secure.on("data", (c) => {
          resp = Buffer.concat([resp, c]);
          if (resp.length > 4096) finish();
        });
        secure.on("end", finish);
        secure.on("close", finish);
        secure.on("error", finish);
        let done = false;
        function finish() {
          if (done) return; done = true;
          clearTimeout(timer);
          const head = resp.subarray(0, Math.max(0, resp.indexOf("\r\n\r\n"))).toString("latin1");
          try { secure.destroy(); } catch {}
          const m = head.match(/^HTTP\/1\.[01] (\d{3})/);
          const status = m ? Number(m[1]) : null;
          resolve(status === 200 ? { addr, status, bytes: resp.length } : null);
        }
        setTimeout(finish, QUICK_MS);
      });
      secure.on("error", bad);
      if (buf.length > i + 4) sock.unshift(buf.subarray(i + 4));
    });
  });
}

/** 実際に数MBのアセットを落とせるか(=アプリが起動できるか) */
async function bigFileCheck(addr) {
  const d = new ProxyAgent({ uri: `http://${addr}`, connectTimeout: 15_000, headersTimeout: 20_000, bodyTimeout: BIG_MS });
  const out = { addr, htmlUrl: null, jsUrl: null, jsBytes: 0, jsMs: null, jsStatus: null, err: null, kbps: 0 };
  try {
    // HTML から main.*.js を探す
    const r = await fetch(ORIGIN + "/", { dispatcher: d, signal: AbortSignal.timeout(20_000), headers: { "user-agent": UA, accept: "text/html" } });
    const html = Buffer.from(await r.arrayBuffer()).toString("utf8");
    out.htmlStatus = r.status;
    const m = html.match(/["']([^"']*\/static\/js\/main\.[a-z0-9]+\.js)["']/i) ||
              html.match(/["']([^"']*main\.[a-z0-9]+\.js)["']/i) ||
              html.match(/src=["']([^"']+\.js)["']/i);
    if (!m) { out.err = "HTML内にJSを見つけられず"; return out; }
    out.jsUrl = m[1].startsWith("http") ? m[1] : ORIGIN + (m[1].startsWith("/") ? m[1] : "/" + m[1]);

    const t0 = Date.now();
    const r2 = await fetch(out.jsUrl, { dispatcher: d, signal: AbortSignal.timeout(BIG_MS), headers: { "user-agent": UA, accept: "*/*" } });
    out.jsStatus = r2.status;
    let n = 0;
    const rd = r2.body.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; }
    out.jsBytes = n;
    out.jsMs = Date.now() - t0;
    out.kbps = Math.round((n / 1024) / Math.max(0.001, out.jsMs / 1000));
  } catch (e) {
    out.err = e.cause?.code || e.message;
  } finally { try { await d.close(); } catch {} }
  return out;
}

(async () => {
  const list = await collect();
  console.log(`\n=== 候補 ${list.length} 件 → CONNECT+TLS+GET/ の高速選別(並列${CONC}) ===`);
  const alive = [];
  let i = 0, tested = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, list.length)) }, async () => {
    while (i < list.length) {
      const c = list[i++];
      const r = await quickCheck(c.addr);
      tested++;
      if (tested % 250 === 0) console.log(`  ...${tested}/${list.length} 検査, 生存(200)=${alive.length}, ${Math.round((Date.now() - t0) / 1000)}秒`);
      if (r) { alive.push(r); console.log(`  ✅ 生存: ${r.addr} (${r.src || c.src}) 200 / ${r.bytes}B`); }
    }
  }));
  console.log(`\n=== 選別結果: ${list.length}件中 ${alive.length}件が「日本出口で koetomo 200」 ===\n`);

  if (!alive.length) {
    console.log("生存プロキシが見つかりませんでした。無料公開プロキシは寿命が数分〜数時間です。");
    process.exit(0);
  }

  console.log(`=== 生存 ${alive.length} 件に「数MBのアプリ本体(main.*.js)」を落とさせる ===\n`);
  const results = [];
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(8, alive.length) }, async () => {
    while (k < alive.length) {
      const a = alive[k++];
      const r = await bigFileCheck(a.addr);
      results.push(r);
      const mb = (r.jsBytes / 1048576).toFixed(2);
      console.log(r.err
        ? `  ❌ ${a.addr}  JS取得失敗: ${r.err}`
        : `  ${r.jsBytes > 100_000 ? "✅" : "⚠️"} ${a.addr}  ${r.jsStatus} ${mb}MB / ${r.jsMs}ms / ${r.kbps}KB/s  ${r.jsUrl ? new URL(r.jsUrl).pathname : ""}`);
    }
  }));

  const good = results.filter((r) => !r.err && r.jsBytes > 100_000);
  console.log(`\n=== 結論 ===`);
  console.log(` 検査した生存プロキシ : ${results.length}`);
  console.log(` アプリ本体を落とせた : ${good.length}`);
  if (good.length) {
    console.log(`\n 使える(速度順):`);
    for (const r of good.sort((a, b) => b.kbps - a.kbps)) {
      console.log(`   ${r.addr}  ${(r.jsBytes / 1048576).toFixed(2)}MB / ${(r.jsMs / 1000).toFixed(1)}秒 / ${r.kbps}KB/s`);
    }
    console.log(`\n → RELAY_LIST に入れるなら:`);
    console.log(`   ${good.sort((a, b) => b.kbps - a.kbps).map((r) => r.addr).join(",")}`);
  } else {
    console.log(`\n ❌ 数MBのアプリ本体を落とせる公開プロキシは1つもありませんでした。`);
    console.log(`    (HTMLや小さな画像は取れても、main.*.js が落ちない=ページが真っ白になります)`);
  }
})();
