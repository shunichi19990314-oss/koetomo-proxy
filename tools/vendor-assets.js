"use strict";
/**
 * 声ともの「静的アセット」をこのフォルダ(vendor/koetomo/)に保存する。
 *
 * なぜ必要か:
 *   アプリ本体 /static/js/main.<hash>.js は約5MBあり、無料の公開プロキシは
 *   HTML(1.4KB)は返せても 5MB で切れる/死ぬものがほとんどです(実測で数分〜数十分で全滅)。
 *   一方このファイルは**ファイル名に内容ハッシュが入っている=中身が変わればURLも変わる**ので、
 *   一度取得してリポジトリに同梱しておけば、以降はプロキシを使わずに Render から直接配れます。
 *   HTML(1.4KB)と API の JSON(数KB)だけがプロキシ経由になればよいので、
 *   遅くて不安定な公開プロキシでも実用になります。
 *
 * 実行: node tools/vendor-assets.js
 *   環境変数 PROXIES で候補プロキシを指定可(既定は内蔵リスト + 自動探索)
 */
const { ProxyAgent, fetch } = require("undici");
const fs = require("fs");
const path = require("path");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ORIGIN = "https://koetomo.fun";
const OUT = path.join(__dirname, "..", "vendor", "koetomo");
const MIN_INLINE = Number(process.env.MIN_INLINE || 0);   // 0 = 全部保存
const CANDIDATES = (process.env.PROXIES || "140.238.32.108:3128,38.175.202.151:443,45.43.60.220:8080,111.119.162.248:10944,45.76.104.147:40001").split(",").map(s => s.trim()).filter(Boolean);

async function pickAlive() {
  for (const addr of CANDIDATES) {
    const d = new ProxyAgent({ uri: `http://${addr}`, connectTimeout: 12_000, headersTimeout: 20_000, bodyTimeout: 120_000 });
    try {
      const r = await fetch(ORIGIN + "/", { dispatcher: d, redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "user-agent": UA } });
      await r.body?.cancel().catch(() => {});
      if (r.status === 200) { console.log(`[proxy] 使用: ${addr}`); return { addr, d }; }
      console.log(`[proxy] ${addr} → ${r.status}`);
    } catch (e) { console.log(`[proxy] ${addr} → 死亡 ${e.cause?.code || e.message}`); }
    try { await d.close(); } catch {}
  }
  return null;
}

/** 1つのアセットを、生きてるプロキシを順に試して取得する */
async function grab(url, tries = CANDIDATES.length) {
  for (let i = 0; i < tries; i++) {
    const addr = CANDIDATES[i % CANDIDATES.length];
    const d = new ProxyAgent({ uri: `http://${addr}`, connectTimeout: 12_000, headersTimeout: 20_000, bodyTimeout: 180_000 });
    const t0 = Date.now();
    try {
      const r = await fetch(url, { dispatcher: d, redirect: "follow", signal: AbortSignal.timeout(180_000), headers: { "user-agent": UA, accept: "*/*" } });
      if (r.status !== 200) { await r.body?.cancel().catch(() => {}); throw new Error("HTTP " + r.status); }
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get("content-type") || "application/octet-stream";
      console.log(`  ✅ ${new URL(url).pathname}  ${(buf.length / 1024).toFixed(1)}KB  ${((Date.now() - t0) / 1000).toFixed(1)}秒  via ${addr}  ${ct.split(";")[0]}`);
      try { await d.close(); } catch {}
      return { buf, ct };
    } catch (e) {
      console.log(`  ⚠️  ${new URL(url).pathname} via ${addr} → ${e.cause?.code || e.message}`);
      try { await d.close(); } catch {}
    }
  }
  return null;
}

function save(relPath, buf) {
  const p = path.join(OUT, relPath.replace(/^\/+/, ""));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}

(async () => {
  const alive = await pickAlive();
  if (!alive) {
    console.log("\n❌ 生きている日本プロキシがありません。tools/scan-jp-bigfile.js で探し直してから再実行してください。");
    process.exit(1);
  }
  try { await alive.d.close(); } catch {}

  fs.mkdirSync(OUT, { recursive: true });
  console.log(`\n=== ${ORIGIN} の静的アセットを ${OUT} に保存します ===\n`);

  // 1) HTML 本体(参照アセットを洗い出すため)
  const html = await grab(ORIGIN + "/");
  if (!html) { console.log("❌ HTML を取得できませんでした"); process.exit(1); }
  save("/index.html", html.buf);
  const text = html.buf.toString("utf8");

  // 2) 参照されているアセットを列挙
  const urls = new Set();
  for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const u = m[1];
    if (u.startsWith("data:") || u.startsWith("#")) continue;
    urls.add(u.startsWith("http") ? u : ORIGIN + (u.startsWith("/") ? u : "/" + u));
  }
  // JS 内で動的に読まれそうな chunk も拾う(main.*.js の隣にある static/js/*.js 等)
  console.log(`HTML から ${urls.size} 件のアセットを検出`);

  const results = [];
  for (const u of [...urls].filter((x) => /^https:\/\/koetomo\.fun\//.test(x))) {
    const rel = new URL(u).pathname;
    const got = await grab(u);
    if (!got) { results.push({ rel, ok: false }); continue; }
    if (got.buf.length >= MIN_INLINE) {
      save(rel, got.buf);
      results.push({ rel, ok: true, bytes: got.buf.length, ct: got.ct });
    }
  }

  // 3) JS の中から追加の chunk 参照を探す(遅延ロードされる bundle)
  const jsFiles = results.filter((r) => r.ok && /\.js$/.test(r.rel));
  for (const j of jsFiles) {
    const body = fs.readFileSync(path.join(OUT, j.rel.replace(/^\/+/, "")), "utf8");
    const extra = new Set();
    for (const m of body.matchAll(/["'`](\/?static\/[a-z0-9./_-]+\.(?:js|css))["'`]/gi)) extra.add(m[1].startsWith("/") ? m[1] : "/" + m[1]);
    for (const m of body.matchAll(/["'`]((?:[a-z0-9-]+)\.[a-f0-9]{8}\.chunk\.js)["'`]/gi)) extra.add("/static/js/" + m[1]);
    const list = [...extra].filter((p) => !results.some((r) => r.rel === p));
    if (list.length) {
      console.log(`\n${j.rel} から遅延ロード chunk を ${list.length} 件検出 → 取得します`);
      for (const p of list.slice(0, 40)) {
        const got = await grab(ORIGIN + p);
        if (got) { save(p, got.buf); results.push({ rel: p, ok: true, bytes: got.buf.length, ct: got.ct }); }
        else results.push({ rel: p, ok: false });
      }
    }
  }

  // 4) マニフェストを書く(server.js がこれを見てローカル配信する)
  const manifest = {
    generatedAt: new Date().toISOString(),
    origin: ORIGIN,
    note: "tools/vendor-assets.js で生成。ファイル名に内容ハッシュが入っているので、上流が更新されたら撮り直すこと。",
    files: results.filter((r) => r.ok).map((r) => ({ path: r.rel, bytes: r.bytes, contentType: r.ct })),
    failed: results.filter((r) => !r.ok).map((r) => r.rel),
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

  const total = manifest.files.reduce((a, b) => a + b.bytes, 0);
  console.log(`\n=== 完了 ===`);
  console.log(` 保存: ${manifest.files.length}ファイル / ${(total / 1048576).toFixed(2)}MB`);
  console.log(` 失敗: ${manifest.failed.length}件 ${manifest.failed.slice(0, 6).join(", ")}`);
  console.log(` 出力: ${OUT}`);
  console.log(` マニフェスト: vendor/koetomo/manifest.json`);
})();
