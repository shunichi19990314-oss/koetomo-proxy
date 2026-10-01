"use strict";
/** JS バンドル内の koetomo.fun 残存箇所を実際に確認する(実害の有無の判定用) */
const { spawn } = require("child_process");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.CTX_PORT || 8796);

const p = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  env: { ...process.env, PORT: String(PORT), UPSTREAM: "https://koetomo.fun", RELAY_LIST: process.env.RELAY_LIST || "140.238.32.108:3128", RELAY_DEEP_PROBE: "1", PUBLIC_ORIGIN: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
p.stdout.on("data", () => {});
p.stderr.on("data", (d) => process.stderr.write(d));

(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/__health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  await new Promise((r) => setTimeout(r, 3000));

  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  const jsPath = (html.match(/["']([^"']*\/static\/js\/main\.[a-z0-9]+\.js)["']/i) || [])[1];
  if (!jsPath) { console.log("main.js が見つかりません"); p.kill(); return process.exit(1); }
  const js = await (await fetch(`http://127.0.0.1:${PORT}${jsPath}`)).text();
  console.log(`JS: ${(js.length / 1048576).toFixed(2)}MB  path=${jsPath}`);

  const NEEDLE = process.env.NEEDLE || "koetomo.fun";
  const idxs = []; let i = -1;
  while ((i = js.indexOf(NEEDLE, i + 1)) !== -1) idxs.push(i);
  console.log(`\n"${NEEDLE}" 出現: ${idxs.length}箇所\n`);
  const seen = new Set();
  for (const k of idxs.slice(0, 60)) {
    const ctx = js.slice(Math.max(0, k - 80), k + 40).replace(/\s+/g, " ");
    const key = ctx.slice(-50);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log("  …" + ctx + "…");
  }

  console.log("\n--- 形式別の出現回数 ---");
  for (const pat of [`127.0.0.1:${PORT}`, "https://koetomo.fun", "http://koetomo.fun", "wss://koetomo.fun", "ws://koetomo.fun", "\\/\\/koetomo.fun", "%3A%2F%2Fkoetomo.fun", "//koetomo.fun"]) {
    const n = js.split(pat).length - 1;
    if (n) console.log(`  "${pat}" : ${n}回`);
  }
  p.kill();
  process.exit(0);
})();
