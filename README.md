# koetomo-proxy — 本家「声とも」を Render 経由で開くフルリバースプロキシ

[声とも (koetomo.fun)](https://koetomo.fun) への全リクエストを肩代わりするリバースプロキシです。
Render の無料 Web サービスとしてデプロイし、ブラウザでは `https://koetomo-proxy.onrender.com` を開くだけで本家の声ともが動きます。

## 機能

| 機能 | 内容 |
|---|---|
| フルリバースプロキシ | GET / POST / WebSocket を koetomo.fun に転送。HTML・JS・CSS・JSON 内の絶対URL・`wss://`・URLエンコード形式・CSP ヘッダまで自分のオリジンに自動書き換え |
| Cookie / リダイレクト対応 | `Set-Cookie` の `Domain` 剥がし、`Location` 書き換え → ログイン状態がプロキシ側ドメインで維持される設計 |
| **🇯🇵 日本出口 ① リバーストンネル**(おすすめ) | 日本のマシン(自宅PC / Raspberry Pi 等)から Render へ**外向き**に接続させる方式。**クレジットカード不要・クラウド不要・ポート開放不要・グローバルIP不要(CGNAT可)**。`TUNNEL_TOKEN` を1つ設定し、日本側で `relay/reverse-tunnel.js` を起動するだけ → **[relay/README.md](relay/README.md)** |
| **🇯🇵 日本出口 ② forward リレー** | 日本のクラウド/VPS(Oracle Always Free 東京 等)に `relay/relay.js` を置き `RELAY_URL` を指定する方式。ポート開放ができるサーバ向け → **[relay/README.md](relay/README.md)** |
| `/__hub` | リバーストンネルのハブ状態(日本のマシンの接続台数・待機ソケット数・確立中トンネル数)を JSON で返す |
| **📦 同梱アセット(vendor)** | アプリ本体 `/static/js/main.<hash>.js` は**約5MB**あり、無料の公開プロキシは HTML(1.4KB)は返せても 5MB で切れる/数分で死ぬものがほとんどです(実測)。このファイルは**名前に内容ハッシュが入っている=中身が変わればURLも変わる**ため、`vendor/koetomo/` に同梱して**プロキシを一切使わずに Render から直接配信**します(実測 **404ms**)。これで「HTML と API の JSON だけがプロキシ経由」になり、遅くて不安定な日本出口でもアプリが起動します。撮り直しは `npm run vendor` |
| **静的アセットのキャッシュ** | 約5MBのアプリ本体 `/static/js/main.<hash>.js` は**ファイル名に内容ハッシュ**が入っているので、一度取得したらメモリに保持して2回目以降を瞬時にします(`cache-control: immutable` でブラウザ側にも強くキャッシュ)。遅い公開プロキシ経由でも**初回だけ我慢すれば以降は快適**です。状態は `/__cache`、上限は `ASSET_CACHE_MB`(既定128MB)・TTL は `ASSET_CACHE_TTL`(既定6時間)。**API や HTML は絶対にキャッシュしません**(ユーザ依存のため) |
| `/__cache` | アセットキャッシュの状態(エントリ数・使用バイト・ヒット率・保持中のファイル一覧) |
| `/__relay` | 日本出口プロキシ候補の実測状態(ステータス・応答時間・出口IP・国・無効化フラグ)。`?recheck=1` で即実測、`?rotate=1` で強制切替 |
| **マルチホスト対応(API が別ドメイン)** | 声ともは Web本体(`koetomo.fun`)とは別に **API を `a.koetomo.fun` / `api.meetscom.com`** で叩きます(同じ ALB なので同様に 403)。これらを `/__up/<host>/<path>` に書き換えて自分経由にし、**同一オリジン化(CORS も発生しない)**。難読化JSでホスト名が `'https://mtrcs.koetom'+'o.fun'` のように**分断されているケースも断片単位で書き換え**。素のホスト名・`https://`・`//`・`wss://`・`\/\/`・`%3A%2F%2F` の全形式に対応 |
| **日本出口プロキシの自動ローテーション** | `RELAY_LIST` の候補を5分ごとに実測して並べ替え、接続エラーや ELB の 403 を検出したら**その場で次の候補に切り替えて自動リトライ**。公開プロキシのように「すぐ死ぬ」出口でも運用できます |
| `/__status` 診断 | 「上流に受け入れられるIPで繋げているか」を判定(上流ステータス + Render発信IP + リレー出口IP・国・ASN + 日本語の判定文)。リレー経路も自動反映 |
| ブロック説明ページ | 上流 403 時は謎のエラーではなく、原因(地域ブロック)と対処(リレー構築手順への誘導)を書いた日本語ページを返す。アプリ本来の 403 JSON は素通し |
| `render.yaml` | Blueprint で **New + → Blueprint → リポジトリ選択** だけで `https://koetomo-proxy.onrender.com` が完成(Web Service からの手動作成でも同じ) |
| 自動テスト | 計 **101項目**: 直接モード33 + リレーチェーン22 + リバーストンネル36 + トンネル上の実HTTPS/TLS検証10(「日本国外IPは403」を模擬する上流を使い、直接403→日本出口経由200 まで検証) |

> **📌 リポジトリの移転について(2026-10-01)**
> このリポジトリは `shunichi19990314/koetomo-proxy` から **`shunichi19990314-oss/koetomo-proxy`** に移りました(コミット履歴はそのまま引き継いでいます)。
> そのため **既存の Render サービスは自動デプロイが止まります**。次のどちらかが必要です:
> - Render ダッシュボード → 対象サービス → **Settings → Repository → Connect account** で `shunichi19990314-oss` を追加し、リポジトリを差し替える
> - または **New + → Blueprint / Web Service** で新リポジトリから作り直す(設定値は下の表のとおり)
>
> なお旧サービス `koetomo.onrender.com` は現在 **suspended(503)** のため、**新規に作り直すほうが早い**場合があります。

## デプロイ手順(Render)

1. このフォルダを GitHub リポジトリに push する
2. Render ダッシュボード → **New +** → **Blueprint** → そのリポジトリを選択
   - **`TUNNEL_TOKEN` の値を聞かれます。** ランダムな32文字程度を入れてください(生成: `node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))'`)。
     これが「日本のマシン」との合い言葉になります。**未設定だと日本出口が作れず、必ず 403 になります**
3. 完了。`https://koetomo-proxy.onrender.com` が生まれます
   - サービス名 `koetomo-proxy` が既に世界中の誰かに使われていた場合、Render が自動で接尾辞を付けた URL になります(動作は同じ)
   - Blueprint を使わず **Web Service** から手動で作る場合は下の表のとおり
4. **デプロイ完了 → 約2分後に [`/__status`](https://koetomo-proxy.onrender.com/__status) を開く** ← 最重要
   - ✅ ならそのまま `/` を開いて声ともを利用できます
   - ❌ (403) なら下の「403 が出たとき」へ → **[relay/README.md](relay/README.md)** で日本の出口を用意

### Web Service から手動で作る場合の設定値

| 項目 | 値 |
|---|---|
| Name | `koetomo-proxy`(→ URL になります) |
| Region | **Singapore** |
| Branch | `main` |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Root Directory | (空欄) |
| Plan | Free |
| Advanced → Health Check Path | `/__health` |

Environment Variables:

| Key | Value |
|---|---|
| `NODE_VERSION` | `20.18.1` |
| `UPSTREAM` | `https://koetomo.fun` |
| `TZ` | `Asia/Tokyo` |
| `TUNNEL_TOKEN` | 32文字程度のランダム文字列(日本のマシンと同じ値にする) |
| `RELAY_ALLOW` | `koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org` |

> リージョンは **Singapore**(声とも=AWS東京に地理的に最寄り)が既定です。Render に日本リージョンは無いので、
> 日本の出口(方式A/B)はどちらにしても必要になります。
> 無料プランは 15 分無アクセスでスリープし、復帰時の初回アクセスに数十秒かかります
> (リバーストンネルは日本のマシンが自動で再接続するので、手作業は不要です)。

## 開けない(403)ときは → 日本出口リレー

声ともは **日本国外のIPを一律 403** にする地域制限を運用しています(実測: 日本ノードのみ 200、他19カ国は全て 403)。
**Render には日本リージョンが無い**ため、Manual Deploy でIPを何回転がしても、リージョンを変えても、Render 単体では絶対に通りません。

解決策は「日本の出口を1つ用意する」だけです。見た目のURLは Render のまま、上流への接続だけが日本出口になります。

```
ブラウザ → Render プロキシ(既存・変更不要) → 日本の出口 → koetomo.fun
```

### ① リバーストンネル(**おすすめ / クレジットカード不要**)

日本のマシン(自宅PC・実家のPC・Raspberry Pi など)を出口にします。
**クラウド契約もポート開放もグローバルIPも不要**(日本のマシンから Render へ外向きに繋ぐだけ)。

```bash
# 日本のマシン側(Linux 想定。Node 22+ なら依存ゼロ)
git clone https://github.com/shunichi19990314-oss/koetomo-proxy.git
cd koetomo-proxy/relay
bash setup-reverse-tunnel.sh wss://<あなたのRender>/__tunnel <TUNNEL_TOKEN>
```

- Render 側に足す環境変数は **`TUNNEL_TOKEN` の1つだけ**(ハブは server.js に内蔵)
- 確認は `/__hub`(日本のマシンの接続状況)→ `/__status`(✅ 判定)
- 詳細手順・切り分け表: **[relay/README.md](relay/README.md)**

### ② forward リレー(日本のクラウド/VPS を使える場合)

```bash
# 日本のサーバ側
cd koetomo-proxy/relay && bash setup-oracle.sh    # Oracle Cloud Always Free 東京/大阪($0)
```

- Render 側に足す環境変数は 2 つ: `RELAY_URL` と `RELAY_CA_B64`(スクリプトが最後に出力します)
- 詳細: **[relay/README.md](relay/README.md)**

### ③ 日本の無料公開プロキシ(**何もインストールしない** / 実測済み)

拡張機能もアプリも使えない場合の最後の手段。**OS/ブラウザのプロキシ設定に入れるだけ**で日本IPになります。
2026-10-01 に実測して `koetomo.fun` が **HTTP 200** になった公開プロキシと、
Firefox / Windows / macOS / Android / iOS ごとの設定手順、注意点を
**[relay/README.md → 方法D](relay/README.md#方法d-日本の無料公開プロキシ何もインストールしない)** にまとめています。

見つけたプロキシは `RELAY_LIST` にカンマ区切りで複数入れておくと、本体が
**5分ごとに実測して並べ替え + 失敗検出で自動ローテーション + 復帰の自動検出** を行います(`test/pool-smoke.js` で19項目検証済み)。
状態は `/__relay`(JSON)、`/__relay?recheck=1`(即実測)、`/__relay?rotate=1`(強制切替)で確認できます。

```
RELAY_LIST = 38.175.202.151:443,45.43.60.220:8080,140.238.32.108:3128
```

死んだら `npm run scan:jp` で「日本かつ 403 以外」のプロキシを自動で探し直せます。

### ④ ブラウザだけ・クレカ不要で今すぐ試す(VPN拡張)

アプリもサーバも用意せず、**ブラウザの拡張機能だけ**で日本IPを取って `koetomo.fun` を直接開く方法です
(Render のプロキシは使いません)。手軽な反面、**音声通話(WebRTC)が通らない可能性が高い**という制約があります。

- 2026年10月時点の実査で「無料・クレカ不要・日本サーバ」を満たすのは **Planet VPN lite / VeePN の拡張機能**程度
  (Windscribe無料=日本なし、TunnelBear無料=国選択が有料化、Proton無料=日本を抽選でしか狙えない、CroxyProxy等のWebプロキシ=日本出口なし)
- **Urban VPN は非推奨**(ユーザーデータをデータブローカーへ送信していた報告あり)
- 詳細・手順・WebRTC漏れの確認方法: **[relay/README.md → 方法C](relay/README.md#方法c-ブラウザだけクレカ不要vpn拡張機能)**
- ただし **拡張機能すら使えない場合は ③(公開プロキシ)が唯一の選択肢**になります

### 共通の安全設計

どちらも **Basic認証/トークン認証 + 接続先許可リスト(koetomo.fun 等)+ ポート 80/443 限定** なので、
オープンプロキシ(踏み台)にはなりません。声ともの TLS はエンドツーエンドのまま中継されるため、
日本のマシンもハブも通信内容を復号できません。

## /__status の読み方

| 項目 | 意味 |
|---|---|
| HTTP ステータス / Server | 声とも側のエッジサーバが Render の IP をどう扱ったか(例: `403` + `awselb/2.0` = AWS ロードバランサ段階で拒否) |
| 発信IP・国・ASN | この Render インスタンスが「外から見える IP」。データセンタ IP かどうかの判断材料 |
| 判定文 | ✅ 受け入れ / ❌ IP ブロック / ⚠️ 到達不能・上流エラー、を日本語で表示 |

JSON が欲しければ `/__status?format=json`。

### /__hub の読み方(リバーストンネル利用時)

| 項目 | 意味 |
|---|---|
| `relays` | 接続中の日本のマシン(名前・IP・稼働秒数・待機ソケット数)。**空なら日本出口が無い=必ず失敗します** |
| `readySockets` | すぐ使える待機ソケット数(リレーが事前に預けておく。要求が来ると即ペアリングされるので立ち上がり待ちが無い) |
| `activeTunnels` / `waitingRequests` | 確立中のトンネル数 / 待機ソケットが足りずにキューされている要求数 |
| `allow` | ハブが接続を許可するホスト(踏み台化防止の許可リスト) |

## 403 が出たとき

実測の結果、声ともの 403 は **日本国外IPに対する地域ブロック** です(日本のデータセンタIPは通り、他19カ国はサーバIPでも全滅)。そのため:

- ❌ **Manual Deploy(IPガチャ)・リージョン変更は無意味** — Render に日本リージョンが無い以上、直接接続は通りません
- ✅ **正解は「日本の出口」** — クレジットカードを使いたくないなら **① リバーストンネル**(日本のマシンで `relay/reverse-tunnel.js`)、クラウドを借りられるなら **② forward リレー**(`RELAY_URL`)。手順は [relay/README.md](relay/README.md)
- 設定後も 403 が出る場合は `/__status` の「日本出口のIP」が **日本 (JP)** になっているか確認
  - 日本でない → `TUNNEL_TOKEN`/`RELAY_URL` の設定ミス、または日本のマシンが接続できていない(`/__hub` の `relays` が空)
  - 日本なのに 403 → そのプロバイダのIPレンジがブロック対象。別の回線(スマホのテザリング等)や別マシンに切り替え
- `/__hub` の `relays` が空なのに 502 になる → 日本のマシンでリレーが起動していない(またはトークン不一致で終了している)
- 一時的な障害・メンテナンスの可能性もあるので、時間帯を変えた再確認も有効

## ローカル開発・テスト

```bash
npm install
npm start              # http://localhost:10000 → https://koetomo.fun へのプロキシとして起動

# 自動テスト
npm test
#   ├ test/smoke.js             直接モード 33項目(URL書き換え/Cookie/WS/SSE/403/診断/オープンプロキシ防止)
#   ├ test/chain-smoke.js       方式B リレーチェーン 22項目
#   └ test/tunnel-smoke.js      方式A リバーストンネル 36項目(geo上流 + ハブ + 日本のマシン + プロキシのE2E。
#                               直接403→トンネル経由200・書き換え・WS中継・8並列・トークン認証・
#                               日本のマシン切断/復帰時の挙動・/__status・/__hub まで検証)

# 実 HTTPS 上流を使った TLS 検証(ネットワーク必須)
node test/tunnel-tls-smoke.js   # トンネル上の TLS 終端・証明書検証・ALPN まで 10項目
node test/live-tunnel-check.js  # 実物の koetomo.fun に対して疎通確認(403 が返れば成功=地域ブロック)
```

3段構成のテストはループバックの別アドレスで「国」を模擬します
(`test/geo-mock-upstream.js`: `127.0.0.2` からの接続だけ 200、それ以外は `awselb/2.0` の 403)。

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `10000` | 待ち受けポート(Render が自動設定) |
| `UPSTREAM` | `https://koetomo.fun` | プロキシ先 |
| `PUBLIC_ORIGIN` | (リクエストの Host から自動判定) | URL 書き換えに使う自分のオリジンを固定したい場合のみ設定 |
| `TZ` | `Asia/Tokyo` | 診断ページの時刻表示用 |
| `RELAY_URL` | (未設定=直接接続) | **日本出口リレー**のURL。`https://koetomo-relay:<トークン>@<日本のIP>:8443` 形式。設定すると上流接続とWebSocketがこのリレー経由になり、地域ブロックを回避できます |
| `UPSTREAM_HOSTS` | `a.koetomo.fun,api.meetscom.com,mtrcs.koetomo.fun` | 一緒にプロキシする上流ホスト(声ともの API 等)。`alias=実オリジン` 形式で別の向き先にもできます(テスト用)。許可外ホストは 403 で拒否するのでオープンプロキシ化しません |
| `UPSTREAM_HOST_FRAGMENTS` | `https://mtrcs.koetom,mtrcs.koetom` | 難読化JSで分断されたホスト名の断片。連結後に正しいURLになるよう書き換えます |
| `RELAY_DEEP_PROBE` | `0` | `1` で候補の実測時に**アプリ本体(数MBの main.*.js)を実際にダウンロード**し、速度まで含めて評価します。「200は返るのにページが真っ白」になる遅いプロキシを自動的に外せます |
| `STATUS_PROBE_TIMEOUT` | `60000` | `/__status` の上流プローブの制限時間(ms)。公開プロキシ経由は1リクエストに10秒以上かかるため、短くすると「動いているのに到達不可」と誤判定します |
| `VENDOR_ASSETS` | `1` | `0` で同梱アセット配信を停止(常に上流へ取りに行く) |
| `ASSET_CACHE_MB` | `128` | 静的アセットのメモリキャッシュ上限(MB)。超えたら古いものから自動で捨てます |
| `ASSET_CACHE_TTL` | `21600000`(6時間) | アセットキャッシュの保持時間(ms) |
| `RELAY_RECHECK_MS` | `300000`(5分) | 候補の再実測間隔(ms)。`RELAY_DEEP_PROBE=1` のときは通信量を守るため `1800000`(30分)程度に。いますぐ測り直すのは `/__relay?recheck=1` |
| **`RELAY_LIST`** | (なし) | **日本出口プロキシの候補一覧**(カンマ区切り `host:port`、認証付きは `user:pass@host:port`)。起動時と5分ごとに全候補を実測して「200が返る→速い」順に並べ替え、失敗を検出したら即座に次へ回転します。死んだら自動で無効化、復帰したら自動で再利用。状態は `/__relay` |
| `RELAY_CA_B64` | (なし) | リレーの自己署名証明書(base64・1行)。`relay/setup-oracle.sh` が出力します |
| `RELAY_INSECURE` | (なし) | `true` でリレー証明書の検証を省略(非推奨。CAピン留めが使えない場合の応急用) |
| **`TUNNEL_TOKEN`** | (未設定=トンネル機能オフ) | **リバーストンネルの共有シークレット**。設定すると server.js 内蔵のハブ(`/__tunnel`)が有効になり、日本のマシン(`relay/reverse-tunnel.js`)を外向き接続で受け入れられます。日本のマシン側にも同じ値を設定します |
| `TUNNEL_MODE` | `embed` | `off` で内蔵ハブを停止(トークンは設定したまま機能を止めたい場合) |
| `TUNNEL_PATH` | `/__tunnel` | ハブの WebSocket エンドポイント |
| `TUNNEL_MAX` | `64` | 同時トンネル数の上限 |
| `TUNNEL_NO_RELAY_TIMEOUT` | `25000` | 日本のマシンが1台も接続していないとき、要求を失敗させるまで待つ時間(ms)。Render のスリープ復帰→リレー再接続を待つ猶予です |
| `RELAY_ALLOW` | `koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org` | ハブ/リレーが接続を許可するホスト(踏み台化防止) |

> `RELAY_URL` と `TUNNEL_TOKEN` の両方を設定した場合は **`TUNNEL_TOKEN`(リバーストンネル)が優先**されます。

## 仕組みメモ

- HTTP 転送は `undici` パッケージの `fetch`(リレー経由の `dispatcher` 指定が必要なため組み込み fetch ではなくパッケージ版を使用)。上流の gzip/br は自動解凍してから書き換え・再送するため `Content-Encoding`/`Content-Length` は正しく再計算されます
- 書き換え対応フォーマット: `https://` `http://` `wss://` `ws://` / `\/\/` エスケープ形式 / `%3A%2F%2F`・`%253A%252F%252F` エンコード形式 / プロトコル相対 `//host`(すべて `www.` 付きも含む、大小文字無視)
- `Origin`・`Referer` は上流ネイティブの値に補正してから転送(CSRF/Origin チェック対策)
- 3xx は `manual` で受け、`Location` が声とも向きなら自オリジンへ書き換え、外部(OAuth 等)なら素通し
- WebSocket は `upgrade` を捕捉し `ws` で上流へブリッジ。上流接続確立前のクライアント送信は**リスナ登録前のメッセージも取りこぼさないよう、ハンドシェイク完了直後からキュー**して開通後にまとめて転送
- **方式B リレーモード**: HTTP は undici `ProxyAgent`(CONNECT トンネル)、WS は自前の CONNECT トンネル確立 → `wss://` の場合は TLS ラップ → `ws` の `createConnection` に注入。声ともの TLS はエンドツーエンドで保たれ、リレーは中身を復号しません
- **方式A リバーストンネル**: `tunnel/hub.js`(ハブ)が 日本のマシン(`relay/reverse-tunnel.js`)の**外向き WebSocket** を受け入れ、プロキシからの要求と配对します。日本のマシンは「すぐ使える待機ソケット」を `RELAY_POOL` 本だけ先に預けておくので、要求が来た瞬間に配对され立ち上がり待ちがありません(不足時はハブが最大 `TUNNEL_NO_RELAY_TIMEOUT` だけキューイングし、リレーが自動補充)
  - プロキシ側は `tunnel/tunnel-bridge.js` が「ハブへの WebSocket」を **net.Socket 相当の Duplex** に見せ、HTTP は undici `Agent` の `connect` に、WS は `ws` の `createConnection` に注入します。`https`/`wss` はこの Duplex の上で `tls.connect({ socket })` するため、**証明書検証は通常どおり**行われ、ハブも日本のマシンも平文を見られません
  - 1リクエスト=1トンネル(`pipelining: 0` + `keepAliveTimeout: 10ms` で再利用しない)ので、応答境界の判定が不要=壊れにくい設計です
  - WS が閉じられた=日本側が上流との接続を閉じた(応答完了)と解釈し、Duplex に EOF を通知します(ここで destroy すると応答本文を捨てて 502 になるため注意)
- SSE (`text/event-stream`) はチャンク単位で書き換えながらストリーム
- バイナリ(画像/音声/フォント等)は無加工・ストリーム素通し。テキストは 25MB までバッファ書き換え
- absolute-form (`GET http://example.com/`) は 400 で拒否 → オープンプロキシ化を防止
- リレー (`relay/relay.js`) も同様に absolute-form/CONNECT とも **Basic認証 + ホスト許可リスト + ポート 80/443 限定**

## 制限・注意

- 対象は `koetomo.fun` / `www.koetomo.fun` のみ。他サブドメイン(`cdn.` など)が使われている場合は書き換え対象外です(現状 DNS 上 www は解決しません)
- 声ともの地域制限(日本限定)は日本出口構成で回避できますが、**日本の出口IP自体が弾かれた場合**は別の回線/マシンへの切り替えが必要です(`/__status` で切り分け可能)
- リバーストンネルは **日本のマシンが起動している間だけ**機能します(スリープ・電源OFF・ネットワーク断で不通)。常時起動できるマシンを使い、OS のスリープは無効にしてください
- リバーストンネルの帯域は日本のマシンの回線に依存します。音声系は帯域を食うので、光回線 + 有線LAN を推奨
- Render 無料プラン: スリープあり(15分無アクセス→復帰に数十秒)・月 512MB アウトバウンド等の制約あり。音声系アプリは通信量が多くなりがちなので、ヘビーユースは有料プラン (`plan: starter` 等) を検討してください
- 声ともは意図的に日本限定で提供されています。リレー/VPN等でのアクセスは利用規約に抵触し得るため、**アカウント停止リスクを含む自己責任**で判断してください。上流に過度なアクセス負荷をかけないこと
