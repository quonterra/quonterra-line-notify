#!/usr/bin/env bash
# Cron エンドポイントを手動で呼び出す。
# 使い方: scripts/cron-request.sh <dry-run|validate|unauthorized|broadcast> [ベースURL]
#
# ベースURL を省略した場合は CRON_BASE_URL、それも無ければ http://localhost:${PORT:-3000} を使う。
# (ポート3000を別プロジェクトの開発サーバーが使っている場合は、ポートを変えて起動し、ここで指定すること)
# CRON_SECRET が環境変数に無ければ .env.local から読み込む。シークレットは画面に表示しない。
# Preview 環境で Deployment Protection が有効な場合は VERCEL_AUTOMATION_BYPASS_SECRET も設定すること。
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-dry-run}"
base="${2:-${CRON_BASE_URL:-http://localhost:${PORT:-3000}}}"
endpoint="${base%/}/api/cron/line-market-summary"

if [[ -z "${CRON_SECRET:-}" && -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi
: "${CRON_SECRET:?CRON_SECRET is not set (environment or .env.local)}"

bypass=()
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
  bypass=(-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
fi

# このプロジェクトのエンドポイントは必ず JSON を返す。HTML などが返ったら別のサーバーに届いている。
warn_not_json() {
  local content_type="$1"
  echo "警告: $base からの応答が JSON ではありません(Content-Type: ${content_type:-なし})。" >&2
  echo "      このプロジェクト以外のサーバーに届いている可能性があります。" >&2
  if [[ "$base" =~ ^https?://(localhost|127\.0\.0\.1)(:([0-9]+))? ]]; then
    local port="${BASH_REMATCH[3]:-80}"
    echo "      ポート $port を使っているプロセスの確認: lsof -nP -iTCP:$port -sTCP:LISTEN" >&2
  fi
}

case "$mode" in
  dry-run) url="$endpoint?dryRun=1" ;;
  validate) url="$endpoint?validate=1" ;;
  unauthorized)
    for auth in "Bearer undefined" ""; do
      meta="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' ${bypass[@]+"${bypass[@]}"} ${auth:+-H "Authorization: $auth"} "$endpoint")"
      printf '%-16s -> HTTP %s\n' "${auth:-no header}" "${meta%% *}"
      [[ "${meta#* }" == application/json* ]] || { warn_not_json "${meta#* }"; exit 1; }
    done
    exit 0
    ;;
  broadcast)
    read -r -p "$endpoint から LINE 公式アカウントの友だち全員に配信されます。続けますか? [y/N] " answer
    [[ "$answer" == "y" ]] || { echo "中止しました"; exit 1; }
    url="$endpoint"
    ;;
  *) echo "unknown mode: $mode (dry-run | validate | unauthorized | broadcast)" >&2; exit 2 ;;
esac

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
meta="$(curl -sS -o "$body" -w '%{http_code} %{content_type}' ${bypass[@]+"${bypass[@]}"} -H "Authorization: Bearer ${CRON_SECRET}" "$url")"
cat "$body"
printf '\nHTTP %s\n' "${meta%% *}"
if [[ "${meta#* }" != application/json* ]]; then
  warn_not_json "${meta#* }"
  exit 1
fi
