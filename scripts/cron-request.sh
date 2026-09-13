#!/usr/bin/env bash
# Cron エンドポイントを手動で呼び出す。
# 使い方: scripts/cron-request.sh <dry-run|validate|unauthorized|broadcast> [ベースURL(省略時 http://localhost:3000)]
#
# CRON_SECRET が環境変数に無ければ .env.local から読み込む。シークレットは画面に表示しない。
# Preview 環境で Deployment Protection が有効な場合は VERCEL_AUTOMATION_BYPASS_SECRET も設定すること。
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-dry-run}"
base="${2:-http://localhost:3000}"
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

case "$mode" in
  dry-run) url="$endpoint?dryRun=1" ;;
  validate) url="$endpoint?validate=1" ;;
  unauthorized)
    echo "Bearer undefined -> HTTP $(curl -sS -o /dev/null -w '%{http_code}' ${bypass[@]+"${bypass[@]}"} -H 'Authorization: Bearer undefined' "$endpoint")"
    echo "no header        -> HTTP $(curl -sS -o /dev/null -w '%{http_code}' ${bypass[@]+"${bypass[@]}"} "$endpoint")"
    exit 0
    ;;
  broadcast)
    read -r -p "$endpoint から LINE 公式アカウントの友だち全員に配信されます。続けますか? [y/N] " answer
    [[ "$answer" == "y" ]] || { echo "中止しました"; exit 1; }
    url="$endpoint"
    ;;
  *) echo "unknown mode: $mode (dry-run | validate | unauthorized | broadcast)" >&2; exit 2 ;;
esac

curl -sS -w '\nHTTP %{http_code}\n' ${bypass[@]+"${bypass[@]}"} -H "Authorization: Bearer ${CRON_SECRET}" "$url"
