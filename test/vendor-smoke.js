"use strict";
/**
 * 同梱アセット(vendor/koetomo)のテスト。
 *
 * 「日本出口プロキシが1つも無い(=上流は確実に 403)」状態でも、
 * アプリ本体 main.<hash>.js が Render から直接 200 で返ることを検証します。
 * これが効くと、遅くて不安定な公開プロキシでも HTML(1.4KB)と API(JSON)だけが
 * プロキシ経由になればよいので、アプリが実際に起動します。
 *
 * 実行: node test/vendor-smoke.js
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.VENDOR_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const VENDOR_DIR = path.join(ROOT, "vendor", "koetomo");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name + (extra !== undefined ? "  | " + extra : "")); }
}

(async () => {
  const manifestPath = path.join(VENDOR_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.log("vendor/koetomo が無いためスキップします(node tools/vendor-assets.js で生成)");
    process.exit(0);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const jsEntry = (manifest.files || []).find((f) => /\/static\/js\/main\.[a-z0-9]+\.js$/i.test(f.path));

  // 日本出口を一切設定しない → 上流(実物の koetomo.fun)は地域ブロックで必ず 403
  const proxy = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(PORT), UPSTREAM: "https://koetomo.fun", PUBLIC_ORIGIN: "", RELAY_LIST: "", TUNNEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  proxy.stdout.on("data", (d) => logs.push(d.toString()));
  proxy.stderr.on("data", (d) => logs.push(d.toString()));

  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/__health", { signal: AbortSignal.timeout(1500) })).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    console.log(`\nvendor: ${BASE} (日本出口なし=上流は必ず403) / 同梱 ${manifest.files.length}ファイル\n`);

    // ── 1. 前提: 日本出口が無いので HTML は 403 になる ──
    const top = await fetch(BASE + "/", { headers: { accept: "text/html" }, signal: AbortSignal.timeout(90_000) }).catch((e) => ({ status: 0 }));
    ok("前提: 日本出口なしでは トップページが 403/502(=ブロックされている)", top.status === 403 || top.status === 502 || top.status === 0, top.status);
    await top.text?.().catch(() => {});

    // ── 2. 同梱アセットはプロキシ無しでも 200 で返る ──
    if (jsEntry) {
      const t0 = Date.now();
      const r = await fetch(BASE + jsEntry.path, { signal: AbortSignal.timeout(120_000) });
      const body = await r.text();
      const ms = Date.now() - t0;
      console.log(`  → ${jsEntry.path}: HTTP ${r.status} / ${(body.length / 1048576).toFixed(2)}MB / ${ms}ms / cache=${r.headers.get("x-proxy-cache")}`);
      ok("アプリ本体(5MB)が日本出口なしで 200", r.status === 200, r.status);
      ok("x-proxy-cache: VENDOR(同梱から配信)", r.headers.get("x-proxy-cache") === "VENDOR", r.headers.get("x-proxy-cache"));
      ok("サイズが期待どおり(1MB超)", body.length > 1_000_000, body.length);
      ok("content-type が JavaScript", /javascript/i.test(r.headers.get("content-type") || ""), r.headers.get("content-type"));
      ok("immutable キャッシュヘッダ", /max-age=31536000/.test(r.headers.get("cache-control") || "") && /immutable/.test(r.headers.get("cache-control") || ""), r.headers.get("cache-control"));
      ok("API ホストが /__up/ に書き換えられている", body.includes("/__up/a.koetomo.fun"), "a.koetomo.fun 出現=" + (body.split("a.koetomo.fun").length - 1));
      ok("JS が途中で切れていない", body.length >= jsEntry.bytes * 0.98, `${body.length} vs 期待 ${jsEntry.bytes}`);

      // 2回目も同じ(メモリ上に書き換え結果を保持)
      const t1 = Date.now();
      const r2 = await fetch(BASE + jsEntry.path, { signal: AbortSignal.timeout(120_000) });
      const b2 = await r2.text();
      ok("2回目も同一の内容が速く返る", r2.status === 200 && b2 === body && (Date.now() - t1) < ms + 3000, `${Date.now() - t1}ms`);
    } else {
      ok("manifest に main.*.js がある", false, JSON.stringify(manifest.files?.map((f) => f.path)));
    }

    // ── 3. 画像などバイナリも同梱から返る(壊れていない) ──
    const img = (manifest.files || []).find((f) => /\.(png|ico|svg)$/i.test(f.path));
    if (img) {
      const r = await fetch(BASE + img.path, { signal: AbortSignal.timeout(60_000) });
      const buf = Buffer.from(await r.arrayBuffer());
      ok(`バイナリ(${img.path})が 200 でサイズ一致`, r.status === 200 && buf.length === img.bytes, `${r.status} ${buf.length} vs ${img.bytes}`);
      ok("バイナリは書き換えない(content-type 維持)", r.headers.get("content-type") === img.contentType, r.headers.get("content-type"));
    }

    // ── 4. 同梱していないパスは通常どおり上流へ行く(=ブロックされる) ──
    const nf = await fetch(BASE + "/static/js/not-vendored.abc123.js", { signal: AbortSignal.timeout(90_000) }).catch((e) => ({ status: 0 }));
    ok("未同梱のパスは上流へ行く(403/502/0)", [403, 502, 0, 404].includes(nf.status), nf.status);
    await nf.text?.().catch(() => {});

    // ── 5. /__cache に vendor 情報が出る ──
    const c = await (await fetch(BASE + "/__cache")).json();
    ok("/__cache に vendor 情報", c.vendor && c.vendor.enabled === true && c.vendor.files > 0, JSON.stringify(c.vendor));
    ok("/__cache の vendor に main.*.js が入っている", (c.vendor?.paths || []).some((p) => /main\.[a-z0-9]+\.js/.test(p)), JSON.stringify(c.vendor?.paths));

    // ── 6. ディレクトリトラバーサルで vendor 外を読めない ──
    for (const evil of ["/../../etc/passwd", "/static/../../server.js", "/%2e%2e%2f%2e%2e%2fetc/passwd"]) {
      const r = await fetch(BASE + evil, { signal: AbortSignal.timeout(30_000) }).catch(() => ({ status: 0 }));
      await r.text?.().catch(() => {});
      ok(`traversal 拒否 ${evil.slice(0, 28)}`, r.status !== 200, r.status);
    }
  } catch (err) {
    failed++;
    console.error("  FAIL  テスト実行中にエラー:", err.message);
    console.error("--- proxy logs ---\n" + logs.join("").split("\n").slice(-20).join("\n"));
  } finally {
    proxy.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
