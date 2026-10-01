"use strict";
/**
 * 声とものアプリが実際に通信する各ホストについて、
 * 「日本以外から直接アクセスして 403 になるか(=プロキシが必要なホストか)」を判定する。
 * プロキシすべきホストを最小限に絞るための調査。
 *
 * 実行: node tools/check-hosts-geoblock.js
 */
const dns = require("dns").promises;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// JS バンドルから抽出した、アプリが実際に使うホスト
const HOSTS = [
  ["koetomo.fun", "Web本体(Reactアプリ)"],
  ["a.koetomo.fun", "REACT_APP_API_ENDPOINT(メインAPI / WS)"],
  ["mtrcs.koetomo.fun", "FingerprintJS(ボット検知)"],
  ["api.meetscom.com", "REACT_APP_API_ENDPOINT2"],
  ["skyway-auth.meetscom.com", "SkyWay 認証(音声通話)"],
  ["skyway-auth.meetscom.co.jp", "SkyWay 認証(別候補)"],
  ["sfu.skyway.ntt.com", "SkyWay SFU(WebRTC 音声メディア)"],
  ["config.meetscom.com", "設定配信"],
  ["www.meetscom.co.jp", "運営サイト"],
  ["koe.jp", "関連ドメイン"],
];

async function probe(host, path = "/") {
  const url = `https://${host}${path}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": UA, accept: "*/*", "accept-language": "ja", origin: "https://koetomo.fun" },
    });
    const body = await r.text().catch(() => "");
    await r.body?.cancel().catch(() => {});
    return { status: r.status, server: r.headers.get("server"), ms: Date.now() - t0, len: body.length, cors: r.headers.get("access-control-allow-origin") };
  } catch (e) {
    return { status: "ERR", err: e.cause?.code || e.message, ms: Date.now() - t0 };
  }
}

(async () => {
  console.log("=== 声ともが使う各ホストの「地域ブロック」判定(この環境=日本国外から直接) ===\n");
  console.log("ホスト".padEnd(30) + "DNS".padEnd(18) + "直接アクセス".padEnd(26) + "判定");
  console.log("-".repeat(104));
  const needProxy = [];
  for (const [host, desc] of HOSTS) {
    let ip = "(解決不可)";
    try { ip = (await dns.lookup(host)).address; } catch {}
    const r = await probe(host);
    const blocked = r.status === 403 || r.status === 401;
    const label = r.status === "ERR"
      ? `接続不可(${r.err})`
      : `${r.status}${r.server ? " " + r.server : ""} ${r.ms}ms`;
    const verdict = ip === "(解決不可)"
      ? "— DNSなし(使われていない)"
      : blocked
        ? "🚫 地域ブロック → プロキシ必須"
        : r.status === "ERR"
          ? "⚠️ 直接届かない → プロキシ推奨"
          : "✅ ブロックなし → ブラウザが直接でOK";
    console.log(host.padEnd(30) + ip.padEnd(18) + label.padEnd(26) + verdict);
    console.log(" ".repeat(30) + `└ ${desc}${r.cors ? ` / CORS: ${r.cors}` : ""}`);
    if (ip !== "(解決不可)" && (blocked || r.status === "ERR")) needProxy.push(host);
  }
  console.log("\n=== 結論 ===");
  console.log("プロキシに含めるべきホスト(UPSTREAM_HOSTS):");
  console.log("  " + (needProxy.join(",") || "(なし)"));
  console.log("\n※ WebRTC の音声メディア(sfu.skyway.ntt.com)はブラウザが直接 UDP で繋ぐため、");
  console.log("   プロキシを経由しません。ここが地域ブロックされていなければ音声は使える見込みです。");
})();
