# 日本出口の作り方 — 「声とも」を Render 経由で開くための最後の1ピース

声とも (koetomo.fun) は **日本国外のIPを一律 403 で拒否** する地域制限を運用しています
(実測: 日本ノードのみ 200、他19カ国は全て 403)。そして **Render には日本リージョンが存在しません**。

つまり **Render 側で何を設定しても、日本の出口を1つ用意するまでは絶対に開けません。**
このフォルダはその「日本の出口」を作るためのものです。方式は2つあります。

| | 方式A: リバーストンネル(**おすすめ**) | 方式B:  forward リレー |
|---|---|---|
| クレジットカード | **不要** | 必要(Oracle は本人確認のみ・$0) |
| クラウド契約 | **不要**(手持ちの日本のマシンでOK) | 必要(Oracle Cloud 等) |
| ポート開放 / グローバルIP | **不要**(CGNAT でも可) | 必要(TCP 8443 開放) |
| 動かすもの | `relay/reverse-tunnel.js` を日本のマシンで常駐 | `relay/relay.js` を日本のサーバで常駐 |
| Render 側の設定 | `TUNNEL_TOKEN` 1つ | `RELAY_URL` + `RELAY_CA_B64` |
| 向いている人 | 日本で常時起動できるマシンがある | 日本の VPS を借りられる |
| 詳細 | ↓ このページの「方式A」 | ↓ 「方式B」 |

どちらでも **ブラウザで開く URL は Render のまま**(`https://koetomo.onrender.com`)。
日本のマシン/サーバは **暗号化されたバイト列を中継するだけ** で、TLS は
Render ⇔ koetomo.fun のエンドツーエンドのまま保たれます(中身を見られません)。

```
あなたのブラウザ
   │  https://koetomo.onrender.com      ← 見た目のURLは Render のまま
   ▼
Render プロキシ (Singapore 等)           … URL書き換え・Cookie・WebSocket中継
   │
   ├── 方式A: /__tunnel (ハブ) ←外向きWS── 日本のマシン (reverse-tunnel.js) ─┐
   └── 方式B: RELAY_URL ─────────────────→ 日本のサーバ (relay.js) ─────────┤
                                                                            ▼
                                                                     koetomo.fun(声とも)
```

---

# 方式A: リバーストンネル(クレカ不要・ポート開放不要)

## 仕組み(なぜポート開放が要らないのか)

日本の家庭回線は **グローバルIPが無い(CGNAT)** ことが多く、ルータのポート開放もできません。
そこで **接続の向きを逆にします**。日本のマシンから Render へ「外向き」の WebSocket を
張りっぱなしにし、Render 側は「その穴」を通じて日本から接続させます。

```
[日本のマシン]  ──外向き WSS(常時・自動再接続)──▶  [Render のハブ /__tunnel]
                                                          ▲
[Render のプロキシ] ──「koetomo.fun:443 に繋いで」────────┘
                                                          │ ハブが2本をペアリング
[日本のマシン] ──実際に日本の回線から koetomo.fun へ dial ─┘
```

- 日本のマシンは **受信を一切しません**(送信用の接続だけ)= ポート開放・グローバルIP不要
- ハブは TCP バイトを素通しするだけ = **TLS はエンドツーエンド**(ハブも日本のマシンも復号できません)
- Render 側は **`TUNNEL_TOKEN` を1つ設定するだけ**(ハブは server.js に内蔵済み)

## 手順1: トークンを作る

適当な32文字程度のランダム文字列を作ります(どちらか):

```bash
node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))'
openssl rand -hex 16
```

## 手順2: Render に `TUNNEL_TOKEN` を設定

1. Render ダッシュボード → 自分のサービス(koetomo-proxy)→ **Environment**
2. **Add Environment Variable**
   - Key: `TUNNEL_TOKEN`
   - Value: 手順1で作った文字列
3. **Save Changes** → 自動で再デプロイされます(1〜2分)

> `RELAY_ALLOW` は `render.yaml` で `koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org` に
> 設定済みです。ハブはここに無いホストへの接続を拒否するので、踏み台にはなりません。

## 手順3: 日本のマシンでリレーを起動

**日本で常時起動しておけるマシン**なら何でも構いません(自宅PC / 実家のPC / Raspberry Pi / 常時ONのミニPC など)。
OS は Ubuntu / Debian などの Linux が一番簡単です(macOS も可、Windows は WSL2 推奨)。

```bash
# 1) リポジトリを取得(どこでもOK。relay/ フォルダだけあれば動きます)
git clone https://github.com/shunichi19990314/koetomo-proxy.git
cd koetomo-proxy/relay

# 2) 一発セットアップ(Node導入 → 設定保存 → systemd 常駐 → 状態表示まで自動)
bash setup-reverse-tunnel.sh wss://koetomo.onrender.com/__tunnel <手順1のトークン>
```

※ URL は **あなたの Render の URL** に置き換えてください(末尾に `/__tunnel` を付ける)。

手動で動かす場合はこれだけです:

```bash
HUB_URL=wss://koetomo.onrender.com/__tunnel \
TUNNEL_TOKEN=<手順1のトークン> \
node relay/reverse-tunnel.js
```

ログに次が出れば接続成功です:

```
[koetomo-relay] ✅ オンライン登録完了 (id=r1) — 待機ソケット 4 本を用意します
```

> **Node のバージョン**: Node 22 以上なら依存パッケージゼロで動きます。
> Node 20 / 21 の場合は `ws` が必要なので `cd relay && npm install` を実行してください
> (setup スクリプトが自動で判断して入れます)。

## 手順4: 確認する

1. `https://<あなたのRender>/__hub` を開く
   → `"relays": [ { "name": "...", "readySockets": 4 } ]` と出ていれば日本のマシンが接続済み
2. `https://<あなたのRender>/__status` を開く
   → ✅ **「上流に受け入れられています」** になれば完了
3. `https://<あなたのRender>/` を開く → 本家の声ともが動きます

## 運用メモ(方式A)

| こと | 挙動 |
|---|---|
| 日本のマシンがスリープ/電源OFF | 声ともが開けなくなります。**スリープ無効**を推奨(ネットワーク断は自動再接続します) |
| Render がスリープ(無料プラン15分) | リレーが数秒おきに再接続を試み、Render が起きたら自動で復帰します。最初の1アクセスは数十秒かかることがあります |
| 同時に何人使えるか | `RELAY_POOL`(既定4)が「即座に使える待機ソケット数」。不足分はハブが最大25秒キューイングし、リレーが自動補充します。家族数人程度なら既定で足ります |
| 回線が遅い/細い | `RELAY_POOL=2` に下げる、または音声系は帯域を食うので光回線推奨 |
| トークンを変える | Render の `TUNNEL_TOKEN` を変更 → 日本のマシン側の `/etc/koetomo-relay/env` も同じ値にして `sudo systemctl restart koetomo-relay` |
| ログ | `sudo journalctl -u koetomo-relay -f`(systemd)/ `tail -f ~/koetomo-relay.log`(nohup) |
| 停止 | `sudo systemctl stop koetomo-relay` / 完全削除は setup スクリプト末尾に記載 |
| 複数台 | 同じトークンで2台以上動かすと負荷分散されます(どちらか1台が生きていれば動きます) |

### うまくいかないときの切り分け

| 症状 | 原因 / 対処 |
|---|---|
| `/__hub` の `relays` が空 | 日本のマシンでリレーが起動していない。ログを確認(`journalctl -u koetomo-relay -n 50`) |
| ログに `❌ TUNNEL_TOKEN が一致しません` | Render の `TUNNEL_TOKEN` と違う値。合わせて再起動 |
| ログに `ハブ接続エラー: connect ECONNREFUSED` が続く | Render がスリープ中 or URL 間違い。**スリープ中なら `/__status` を一度開いてから 1分待って**再確認 |
| `/__status` が「上流に到達できません」 | 日本のマシンから `koetomo.fun:443` への送信が塞がれている(社内FW等)。`curl -I https://koetomo.fun` をそのマシンで実行して確認 |
| `/__status` が ❌ 403 のまま・出口IPが日本でない | リレーが動いているマシンが実は日本でない / VPN経由。`curl https://ipinfo.io` でそのマシンのIPの国を確認 |
| 出口IPは日本なのに 403 | そのプロバイダのIPレンジがブロック対象。別の回線(例: スマホのテザリング)で試す |
| 最初は動くがすぐ切れる | 日本のマシンのスリープ/省電力設定。`systemctl mask sleep.target suspend.target` 等で無効化 |

---

# 方式B: forward リレー(日本のクラウドサーバを使う)

日本の VPS / クラウドを借りられる場合はこちら。外向きのポート開放(TCP 8443)ができるサーバに
`relay/relay.js` を置き、Render の `RELAY_URL` に指定します。

- 実行: **[setup-oracle.sh](setup-oracle.sh)**(Oracle Cloud Always Free 東京/大阪 向け・$0)
  ```bash
  git clone https://github.com/shunichi19990314/koetomo-proxy.git
  cd koetomo-proxy/relay && bash setup-oracle.sh
  ```
  スクリプトが最後に `RELAY_URL=...` と `RELAY_CA_B64=...` の2行を出力するので、
  そのまま Render の Environment に貼り付けて Save するだけで切り替わります。

## Oracle Cloud Always Free の手順(要クレジットカード=本人確認のみ・$0)

1. https://signup.cloud.oracle.com でアカウント作成(メール・電話番号・カード本人確認あり)
2. **Compute → Instances → Create instance**

   | 項目 | 値 |
   |---|---|
   | Placement | Home Region が **Japan East (Tokyo)** / **Japan Central (Osaka)** |
   | Image | Ubuntu 22.04 / 24.04 (aarch64 または x86) |
   | Shape | **VM.Standard.A1.Flex**(ARM・Always Free、OCPU 1〜4 / RAM 6〜24GB)<br>在庫が無ければ **VM.Standard.E2.1.Micro**(AMD・Always Free) |
   | VCN | 「Create new VCN」でOK。**SSH(22)は自分のIPのみ**に絞る |

3. **VCN → Security List → Ingress Rules → Add Ingress Rules** で **TCP 8443**(Source `0.0.0.0/0`)を開放
   ※ これを忘れると Render からリレーに到達できず 502 になります
4. SSH して上記の `bash setup-oracle.sh` を実行

> ARM (A1.Flex) は東京リージョンで空きが無く「Out of capacity」になることがあります。
> その場合は AMD の E2.1.Micro を選ぶか、時間帯を変えて再試行してください。

## 方式B のセキュリティ

- Basic 認証(`RELAY_TOKEN`)必須。トークン無しは 407 で拒否
- 接続先は許可リスト(`koetomo.fun` / IP情報API のみ)。それ以外は 403
- CONNECT 先ポートは 443 / 80 のみ = オープンプロキシ化しません
- TLS は自己署名証明書を生成して `RELAY_CA_B64` でピン留め(盗聴・改ざん防止)

---

# それでも開けないときの最終確認

`/__status` は「事実」を全部出します。ここを見れば原因は一意に決まります。

| `/__status` の表示 | 意味 | 対処 |
|---|---|---|
| ✅ 上流に受け入れられています | 完成。`/` を開けば声ともが動きます | — |
| ❌ HTTP 403 / 経路=直接接続 | 日本の出口がまだ無い | 上の方式A か 方式B を実施 |
| ❌ HTTP 403 / 出口IPが日本 | そのIPレンジがブロックされている | 別の回線・別のマシンに切り替え |
| ⚠️ 上流に到達できません | リレーが落ちている/設定ミス | 上の「切り分け」表へ |
| `/__hub` の relays が空 | 日本のマシンが未接続 | リレーの起動とトークンを確認 |

---

## ⚠️ 免責

声ともは運営(Meetscom 社)が **意図的に日本限定で提供** しています。
プロキシや日本出口リレーを用いたアクセスは利用規約に反する可能性があり、
アカウント停止などのリスクは利用者の自己責任となります。
技術的な実現可能性と手順を記載しているものであり、利用を推奨するものではありません。
