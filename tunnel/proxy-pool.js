"use strict";
/*!
 * proxy-pool — 複数の「日本出口プロキシ」候補を自動で使い分けるプール
 * ============================================================================
 * 声ともは日本国外IPを 403 で拒否します。クラウドもクレカも日本のマシンも使えない場合、
 * 最後の手段は「日本にある公開プロキシ」を経由することです。ただし公開プロキシは
 *   ・数時間〜数日で死ぬ
 *   ・出口IPがブロックされる
 *   ・混雑して遅い
 * ので、1つ固定では実用になりません。このプールは候補を複数持たせて
 *   ・起動時と定期的に全候補を実測して「速くて通る順」に並べ替え
 *   ・失敗(接続エラー/403)を検出したら即座に次の候補へ回転
 *   ・現在の状態を /__status と /__relay で可視化
 * します。
 *
 * 環境変数(server.js 側で読む):
 *   RELAY_LIST  カンマ区切りの host:port 一覧
 *               例) 140.238.32.108:3128,45.43.60.220:8080
 *               認証付きは  user:pass@host:port  形式も可
 *   RELAY_URL   従来どおりの単一指定(両方あれば両方を候補にする)
 */

const { ProxyAgent, fetch } = require("undici");

const PROBE_TIMEOUT = 9_000;
const DEEP_TIMEOUT = 60_000;          // 大容量アセット検査の制限時間
// 公開プロキシは「HTML(1.4KB)は取れるが 5MB のアプリ本体は落とせない」ものが多く、
// その場合ページが真っ白になります。そこで HTML から main.*.js を見つけて実際に
// ダウンロードし、速度まで測って候補を評価します(RELAY_DEEP_PROBE=1 で有効)。
const DEEP_PROBE = String(process.env.RELAY_DEEP_PROBE || "0") !== "0";
// 再実測の間隔。RELAY_DEEP_PROBE=1 のときは数MB×候補数を毎回ダウンロードするため、
// Render 無料枠の通信量を守るには長め(例 30分)にしてください。
const RECHECK_MS = Number(process.env.RELAY_RECHECK_MS || 5 * 60_000);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** "user:pass@host:port" / "host:port" / 完全URL を候補オブジェクトにする */
function parseCandidate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : "http://" + s);
  } catch { return null; }
  if (!url.hostname || !url.port) return null;
  let token;
  if (url.username) {
    token = "Basic " + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password || "")}`).toString("base64");
  }
  return {
    label: `${url.protocol}//${url.host}`,
    host: url.hostname,
    port: url.port,
    url,
    token,
    tls: {},                       // 公開プロキシは平文HTTPが通常(上流TLSはエンドツーエンド)
    // 実測結果
    status: null,                  // 200 / 403 / "ERR:..." / null(未測定)
    ms: null,
    egressIp: null,
    country: null,
    org: null,
    lastCheck: null,
    failures: 0,
    disabled: false,
    _agent: null,
  };
}

class RelayPool {
  constructor({ candidates = [], upstream, log = console.log, recheckMs = RECHECK_MS }) {
    this.list = candidates.filter(Boolean);
    this.upstream = upstream;
    this.log = log;
    this.recheckMs = recheckMs;
    this.activeIndex = 0;
    this.checking = null;
    if (this.list.length) {
      this.recheck(true).catch(() => {});
      this.timer = setInterval(() => this.recheck(false).catch(() => {}), recheckMs);
      this.timer.unref?.();
    }
  }

  get enabled() { return this.list.length > 0; }
  get size() { return this.list.length; }

  /** 現在アクティブな候補(死んでいたら次の有効なものを探す) */
  active() {
    if (!this.list.length) return null;
    for (let n = 0; n < this.list.length; n++) {
      const i = (this.activeIndex + n) % this.list.length;
      const c = this.list[i];
      if (!c.disabled) { this.activeIndex = i; return c; }
    }
    // 全滅 → 一番マシなのを復活させて再測定を促す
    this.list.forEach((c) => { c.disabled = false; c.failures = 0; });
    this.recheck(true).catch(() => {});
    return this.list[this.activeIndex];
  }

  /** undici dispatcher(アクティブ候補の ProxyAgent)。候補が無ければ undefined=直接接続 */
  dispatcher() {
    const c = this.active();
    if (!c) return undefined;
    if (!c._agent) {
      c._agent = new ProxyAgent({
        uri: c.url.toString(),
        token: c.token,
        proxyTls: c.tls,
        requestTls: {},
        connectTimeout: 20_000,
        headersTimeout: 30_000,
      });
    }
    return c._agent;
  }

  /** 失敗を検出 → この候補を降格して次へ回転する。戻り値は新しいアクティブ候補 */
  reportFailure(why) {
    const c = this.active();
    if (!c) return null;
    c.failures++;
    c.status = why || "ERR";
    c.lastCheck = Date.now();
    if (c.failures >= 3) {
      c.disabled = true;
      this.log(`[relay-pool] ${c.label} を無効化 (${why}) — 残り ${this.list.filter((x) => !x.disabled).length}/${this.list.length}`);
    } else {
      this.log(`[relay-pool] ${c.label} 失敗 (${why}) → 次の候補へ回転`);
    }
    this.activeIndex = (this.activeIndex + 1) % this.list.length;
    // 全滅したら一旦リセットして測り直す
    if (this.list.every((x) => x.disabled)) {
      this.list.forEach((x) => { x.disabled = false; x.failures = 0; });
      this.recheck(true).catch(() => {});
    }
    return this.active();
  }

  /** 手動で次に切り替える */
  rotate() {
    const c = this.active();
    if (c) { c.disabled = true; }
    this.activeIndex = (this.activeIndex + 1) % Math.max(1, this.list.length);
    this.recheck(true).catch(() => {});
    return this.active();
  }

  /** 全候補を実測して「通る → 速い」順に並べ替える */
  async recheck(force) {
    if (!this.list.length) return [];
    if (this.checking && !force) return this.checking;
    const run = (async () => {
      const results = await Promise.all(this.list.map((c) => this.probe(c)));
      // 並べ替え: 有効(200/3xx) > 403(出口IPブロック) > エラー、同一区分内は応答時間順
      const rank = (c) => {
        if (c.status === null) return 4;
        if (/^ERR/.test(String(c.status))) return 5;
        if (c.status === 403 || c.status === 401) return 3;
        if (c.status >= 500) return 2;
        // 200 は返るがアプリ本体(数MBのJS)を落とせない候補は一段下げる
        if (DEEP_PROBE && c.deep && c.deep !== "ok" && c.deep !== "no-js") return 1;
        return 0;
      };
      this.list.sort((a, b) => (rank(a) - rank(b)) || ((b.deepKbps ?? 0) - (a.deepKbps ?? 0)) || ((a.ms ?? 1e9) - (b.ms ?? 1e9)));
      // 最上位をアクティブに
      const prev = this.activeIndex;
      this.activeIndex = 0;
      const best = this.list[0];
      if (best) {
        best.failures = 0;
        best.disabled = false;
        if (rank(best) === 0) {
          this.log(`[relay-pool] 最良の日本出口: ${best.label} (${best.status} / ${best.ms}ms / 出口IP ${best.egressIp || "?"} ${best.country || ""})`);
        } else {
          this.log(`[relay-pool] ⚠️ 200を返す日本出口がありません(最上位 ${best.label} = ${best.status})。候補を追加してください`);
        }
      }
      void prev;
      return results;
    })();
    this.checking = run;
    try { return await run; } finally { this.checking = null; }
  }

  /**
   * 大容量アセット(main.*.js)を実際に落とせるかを検査する。
   * 声ともは React 製で /static/js/main.*.js が約5MBあり、これを落とせない
   * プロキシは「200が返るのにページが真っ白」という最悪の状態になります。
   */
  async deepProbe(c, dispatcher) {
    try {
      // HTML からアプリ本体の JS を探す(ハッシュはデプロイごとに変わるので動的に取得)
      let jsUrl = this.deepUrl;
      if (!jsUrl) {
        const r = await fetch(this.upstream + "/", { dispatcher, signal: AbortSignal.timeout(PROBE_TIMEOUT), headers: { "user-agent": UA, accept: "text/html" } });
        const html = Buffer.from(await r.arrayBuffer()).toString("utf8");
        const m = html.match(/["']([^"']*\/static\/js\/main\.[a-z0-9]+\.js)["']/i) || html.match(/src=["']([^"']+\.js)["']/i);
        if (!m) { c.deep = "no-js"; return; }
        jsUrl = m[1].startsWith("http") ? m[1] : this.upstream + (m[1].startsWith("/") ? m[1] : "/" + m[1]);
        this.deepUrl = jsUrl;
      }
      const t0 = Date.now();
      const r2 = await fetch(jsUrl, { dispatcher, signal: AbortSignal.timeout(DEEP_TIMEOUT), headers: { "user-agent": UA, accept: "*/*" } });
      let n = 0;
      const rd = r2.body.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; }
      const ms = Date.now() - t0;
      c.deepBytes = n;
      c.deepMs = ms;
      c.deepKbps = Math.round((n / 1024) / Math.max(0.001, ms / 1000));
      c.deep = (r2.status === 200 && n > 100_000) ? "ok" : `bad:${r2.status}/${n}B`;
      c.deepAt = Date.now();
      this.log(`[relay-pool] deep ${c.label}: ${c.deep} ${(n / 1048576).toFixed(2)}MB / ${(ms / 1000).toFixed(1)}秒 / ${c.deepKbps}KB/s`);
    } catch (e) {
      c.deep = "ERR:" + (e.cause?.code || e.message);
      c.deepBytes = 0; c.deepKbps = 0; c.deepAt = Date.now();
      this.log(`[relay-pool] deep ${c.label}: ${c.deep} (アプリ本体を落とせません=ページが真っ白になります)`);
    }
  }

  /** 1候補を実測: 上流のステータス + 出口IP */
  async probe(c) {
    const t0 = Date.now();
    let dispatcher;
    try {
      dispatcher = c._agent || (c._agent = new ProxyAgent({
        uri: c.url.toString(), token: c.token, proxyTls: c.tls, requestTls: {},
        connectTimeout: PROBE_TIMEOUT, headersTimeout: PROBE_TIMEOUT,
      }));
    } catch (e) {
      c.status = "ERR:" + e.message; c.ms = null; c.lastCheck = Date.now(); return c;
    }
    try {
      const r = await fetch(this.upstream + "/", {
        dispatcher, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT),
        headers: { "user-agent": UA, accept: "text/html", "accept-language": "ja" },
      });
      c.status = r.status;
      c.server = r.headers.get("server");
      await r.body?.cancel().catch(() => {});
    } catch (e) {
      c.status = "ERR:" + (e.cause?.code || e.message);
      c.server = null;
    }
    c.ms = Date.now() - t0;
    // 出口IP(= 声ともから見えるIP)
    if (!/^ERR/.test(String(c.status))) {
      try {
        const r2 = await fetch("https://ipinfo.io/json", { dispatcher, signal: AbortSignal.timeout(PROBE_TIMEOUT), headers: { accept: "application/json", "user-agent": UA } });
        if (r2.ok) {
          const j = await r2.json();
          c.egressIp = j.ip; c.country = j.country; c.city = j.city; c.org = j.org || null;
          const m = String(j.org || "").match(/^(AS\d+)/);
          c.asn = m ? m[1] : null;
        }
      } catch { /* 出口IPが取れなくても判定には影響させない */ }
    }
    c.lastCheck = Date.now();
    c.failures = /^ERR/.test(String(c.status)) ? c.failures + 1 : 0;
    if (c.failures >= 3) c.disabled = true;
    // 大容量アセット検査(有効時のみ)。200 が返るのにアプリ本体を落とせない候補を弾く
    if (DEEP_PROBE && !/^ERR/.test(String(c.status)) && c.status !== 403 && c.status !== 401) {
      await this.deepProbe(c, dispatcher);
      if (c.deep && c.deep !== "ok" && c.deep !== "no-js") c.failures += 2;
      if (c.failures >= 3) c.disabled = true;
    }
    return c;
  }

  /** /__status・/__relay 用の状態 */
  stats() {
    const active = this.active();
    return {
      enabled: this.enabled,
      count: this.list.length,
      active: active ? active.label : null,
      activeOk: active ? (!/^ERR/.test(String(active.status)) && active.status !== 403 && active.status !== 401 && active.status !== null) : false,
      candidates: this.list.map((c) => ({
        label: c.label, status: c.status, ms: c.ms, egressIp: c.egressIp, country: c.country,
        org: c.org, asn: c.asn, failures: c.failures, disabled: c.disabled,
        deep: c.deep || null, deepMB: c.deepBytes ? +(c.deepBytes / 1048576).toFixed(2) : null,
        deepSec: c.deepMs ? +(c.deepMs / 1000).toFixed(1) : null, deepKBps: c.deepKbps || null,
        lastCheck: c.lastCheck ? new Date(c.lastCheck).toISOString() : null,
        active: active === c,
      })),
    };
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.list) { try { await c._agent?.close(); } catch {} }
  }
}

module.exports = { RelayPool, parseCandidate };
