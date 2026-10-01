#!/usr/bin/env bash
# =============================================================================
#  koetomo-relay セットアップ(リバーストンネル版 / クレジットカード不要)
# =============================================================================
#  「日本にあるマシン」を声ともの出口にします。クラウド不要・ポート開放不要・
#  グローバルIP不要(CGNAT でも可)。Render のハブへ外向きに繋ぐだけなので、
#  自宅PC / 実家のPC / Raspberry Pi / 会社の常時起動マシン など何でも使えます。
#
#  使い方:
#     bash setup-reverse-tunnel.sh wss://koetomo.onrender.com/__tunnel <TUNNEL_TOKEN>
#
#    第1引数 HUB_URL     … Render の URL + /__tunnel
#    第2引数 TUNNEL_TOKEN … Render の環境変数 TUNNEL_TOKEN と同じ値
#    オプション:
#      --name <名前>     /__status に表示する名前(既定: ホスト名)
#      --pool <数>       待機ソケット数(既定 4。回線が細いなら 2)
#      --foreground      systemd 登録せず前面で動かす(動作確認用)
#      --no-systemd      systemd を使わず nohup で常駐
#
#  やること:
#    1) Node.js 20+ を確認(無ければ導入を試みる)
#    2) ws パッケージが必要な場合だけ npm install
#    3) 設定を /etc/koetomo-relay/env に保存(トークンはこのファイルだけに保存)
#    4) systemd サービス koetomo-relay を登録して起動(起動時自動開始)
#    5) 接続状態の確認方法を表示
#
#  削除したいとき:  sudo systemctl disable --now koetomo-relay && sudo rm -f /etc/systemd/system/koetomo-relay.service /etc/koetomo-relay/env
# =============================================================================
set -euo pipefail

HUB_URL="${1:-}"
TOKEN="${2:-}"
NAME="$(hostname -s 2>/dev/null || echo relay)"
POOL=4
FOREGROUND=0
USE_SYSTEMD=1
shift 2 2>/dev/null || true

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2;;
    --pool) POOL="$2"; shift 2;;
    --foreground) FOREGROUND=1; shift;;
    --no-systemd) USE_SYSTEMD=0; shift;;
    *) echo "不明なオプション: $1"; exit 1;;
  esac
done

if [ -z "$HUB_URL" ] || [ -z "$TOKEN" ]; then
  cat <<'USAGE'
使い方:
  bash setup-reverse-tunnel.sh <HUB_URL> <TUNNEL_TOKEN> [--name 名前] [--pool 4] [--foreground]

例:
  bash setup-reverse-tunnel.sh wss://koetomo.onrender.com/__tunnel abc123def456

HUB_URL      = Render の URL の末尾に /__tunnel を付けたもの
TUNNEL_TOKEN = Render ダッシュボード → Environment の TUNNEL_TOKEN と同じ値
               (未設定なら 32文字のランダム文字列を作って両方に設定してください:
                openssl rand -hex 16   または   node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')
USAGE
  exit 1
fi

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_JS="$SCRIPT_DIR/reverse-tunnel.js"
[ -f "$RELAY_JS" ] || die "reverse-tunnel.js が見つかりません (このスクリプトと同じフォルダに必要です): $RELAY_JS"

# ── 1. Node.js ─────────────────────────────────────────────────────────────
say "Node.js を確認します"
NEED_WS=0
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v)"
  NODE_MAJOR="$(echo "$NODE_VER" | sed 's/^v\([0-9]*\).*/\1/')"
  echo "  検出: node $NODE_VER ($(command -v node))"
  if [ "$NODE_MAJOR" -lt 20 ]; then
    warn "Node 20 未満です。新しい Node の導入を試みます…"
    NEED_INSTALL=1
  elif [ "$NODE_MAJOR" -lt 22 ]; then
    echo "  Node 22 未満なので WebSocket 用に ws パッケージが必要です"
    NEED_WS=1
    NEED_INSTALL=0
  else
    echo "  Node 22+ なので依存パッケージゼロで動きます ✅"
    NEED_INSTALL=0
  fi
else
  NEED_INSTALL=1
fi

if [ "${NEED_INSTALL:-0}" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    say "Node.js 22 を apt で導入します(要 sudo)"
    sudo apt-get update -y || true
    sudo apt-get install -y ca-certificates curl gnupg || true
    # NodeSource の Node 22(無ければディストリの nodejs)
    if curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh 2>/dev/null; then
      sudo bash /tmp/nodesource_setup.sh || true
      sudo apt-get install -y nodejs || true
    fi
    if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v\([0-9]*\).*/\1/')" -lt 20 ]; then
      sudo apt-get install -y nodejs npm || true
    fi
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs npm || true
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y nodejs npm || true
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm nodejs npm || true
  elif command -v brew >/dev/null 2>&1; then
    brew install node@22 || brew install node || true
  else
    die "Node.js が見つからず、自動導入もできませんでした。https://nodejs.org から Node 22+ を入れて再実行してください。"
  fi
  command -v node >/dev/null 2>&1 || die "Node.js の導入に失敗しました"
  NODE_VER="$(node -v)"; NODE_MAJOR="$(echo "$NODE_VER" | sed 's/^v\([0-9]*\).*/\1/')"
  echo "  導入後: node $NODE_VER"
  [ "$NODE_MAJOR" -lt 20 ] && die "Node 20 以上が必要です(現在 $NODE_VER)"
  [ "$NODE_MAJOR" -lt 22 ] && NEED_WS=1
fi

NODE_BIN="$(command -v node)"

# ── 2. ws パッケージ(Node 20/21 のみ必要)─────────────────────────────────
if [ "$NEED_WS" = "1" ]; then
  say "ws パッケージを導入します(Node $NODE_VER 用)"
  if [ ! -d "$SCRIPT_DIR/node_modules/ws" ] && [ ! -d "$SCRIPT_DIR/../node_modules/ws" ]; then
    if command -v npm >/dev/null 2>&1; then
      (cd "$SCRIPT_DIR" && npm install --omit=dev --no-audit --no-fund) \
        || warn "npm install に失敗しました。Node 22+ を使うと依存ゼロで動きます。"
    else
      warn "npm が無いので ws を導入できません。Node 22+ を入れてください。"
    fi
  else
    echo "  既存の ws を利用します"
  fi
fi

# ── 3. 設定ファイル ────────────────────────────────────────────────────────
say "設定を保存します"
ETC_DIR=/etc/koetomo-relay
if [ -w /etc ] || sudo -n true 2>/dev/null; then
  sudo mkdir -p "$ETC_DIR"
  sudo tee "$ETC_DIR/env" >/dev/null <<EOF
# koetomo-relay (リバーストンネル) 設定 — このファイルは root 以外は読めません
HUB_URL=$HUB_URL
TUNNEL_TOKEN=$TOKEN
RELAY_NAME=$NAME
RELAY_POOL=$POOL
RELAY_ALLOW=koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org
RELAY_PORTS=443,80
EOF
  sudo chmod 600 "$ETC_DIR/env"
  sudo chown root:root "$ETC_DIR/env" 2>/dev/null || true
  ENV_FILE="$ETC_DIR/env"
  echo "  $ENV_FILE (権限 600)"
else
  ENV_FILE="$HOME/.koetomo-relay.env"
  cat > "$ENV_FILE" <<EOF
HUB_URL=$HUB_URL
TUNNEL_TOKEN=$TOKEN
RELAY_NAME=$NAME
RELAY_POOL=$POOL
RELAY_ALLOW=koetomo.fun,ipinfo.io,ipwho.is,api.ipify.org
RELAY_PORTS=443,80
EOF
  chmod 600 "$ENV_FILE"
  warn "sudo が使えないため $ENV_FILE に保存しました"
fi

# ── 4. 起動 ────────────────────────────────────────────────────────────────
run_foreground() {
  say "前面で起動します(Ctrl+C で停止)"
  set -a; . "$ENV_FILE"; set +a
  exec "$NODE_BIN" "$RELAY_JS"
}

if [ "$FOREGROUND" = "1" ]; then run_foreground; fi

if [ "$USE_SYSTEMD" = "1" ] && command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1; then
  say "systemd サービスを登録します"
  RUN_USER="${SUDO_USER:-$(id -un)}"
  sudo tee /etc/systemd/system/koetomo-relay.service >/dev/null <<EOF
[Unit]
Description=koetomo-relay (声とも 日本出口 / リバーストンネル)
Documentation=https://github.com/shunichi19990314/koetomo-proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $RELAY_JS
Restart=always
RestartSec=3
# 異常時にプロセスを軽く抑える
MemoryMax=256M
TasksMax=256
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal
SyslogIdentifier=koetomo-relay

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable koetomo-relay >/dev/null 2>&1 || true
  sudo systemctl restart koetomo-relay
  sleep 2
  say "起動しました"
  sudo systemctl --no-pager --lines=15 status koetomo-relay || true
else
  say "systemd が使えないので nohup で常駐します"
  PIDFILE="$HOME/.koetomo-relay.pid"
  LOGFILE="$HOME/koetomo-relay.log"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
  fi
  ( set -a; . "$ENV_FILE"; set +a; nohup "$NODE_BIN" "$RELAY_JS" >>"$LOGFILE" 2>&1 & echo $! > "$PIDFILE" )
  sleep 2
  echo "  PID $(cat "$PIDFILE") / ログ $LOGFILE"
  tail -n 12 "$LOGFILE" || true
  warn "この方式は OS 再起動後に自動で戻りません。再起動したら再度このスクリプトを実行してください。"
fi

# ── 5. まとめ ──────────────────────────────────────────────────────────────
cat <<EOF


============================================================
 ✅ セットアップ完了
============================================================
 役割      : 声ともの「日本出口」(リバーストンネル)
 ハブ      : $HUB_URL
 名前      : $NAME (Render の /__status に表示されます)
 待機数    : $POOL
 設定      : $ENV_FILE
 ポート開放: 不要(外向き接続のみ)
 クレカ    : 不要

 動作確認
   1) ブラウザで  ${HUB_URL%/__tunnel}/__hub   を開く
      → "relays": [ { "name": "$NAME", ... } ]  と出ていれば接続済み
   2) ${HUB_URL%/__tunnel}/__status  を開く
      → ✅「上流に受け入れられています」になれば完了。/ を開けば声ともが動きます

 ログを見る
   systemd : sudo journalctl -u koetomo-relay -f
   nohup   : tail -f ~/koetomo-relay.log

 停止 / 削除
   停止    : sudo systemctl stop koetomo-relay
   無効化  : sudo systemctl disable --now koetomo-relay
   完全削除: sudo rm -f /etc/systemd/system/koetomo-relay.service $ENV_FILE && sudo systemctl daemon-reload

 注意
   ・このマシンがスリープ/電源OFF になると声ともが開けなくなります
     (電源設定でスリープ無効を推奨。ネットワークが切れても自動で再接続します)
   ・Render 無料プランは15分無アクセスでスリープします。スリープ中は
     このリレーが再接続を繰り返し、起きたら数秒で復帰します(自動)
   ・TUNNEL_TOKEN はこのマシンと Render だけが知る秘密です。他人に渡すと
     あなたの回線を出口に使われてしまいます
============================================================
EOF
