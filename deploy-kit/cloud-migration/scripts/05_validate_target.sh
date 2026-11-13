#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

usage() {
  cat <<EOF
用法：
  CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env $0

验证目标服务器平台、Dify、HA、InfluxDB、日志刷屏风险和关键服务状态。
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

load_config
require_cmd curl
require_cmd ssh

[ -n "${TARGET_HOST:-}" ] || die "TARGET_HOST 不能为空"
TARGET_PUBLIC_BASE_URL="$(replace_target_placeholders "${TARGET_PUBLIC_BASE_URL:-http://__TARGET_PUBLIC_HOST__:8088}")"

log "公网入口验证：${TARGET_PUBLIC_BASE_URL}"
curl -sS -L -o /dev/null -w "public_home=%{http_code} final=%{url_effective}\n" "${TARGET_PUBLIC_BASE_URL}/home"
curl -sS -o /dev/null -w "public_api_health=%{http_code}\n" "${TARGET_PUBLIC_BASE_URL}/api/v1/system/health"
curl -sS -o /dev/null -w "dify_datasets_without_auth=%{http_code}\n" "$(replace_target_placeholders "${TARGET_DIFY_BASE_URL:-http://__TARGET_PUBLIC_HOST__}")/v1/datasets" || true
curl -sS -o /dev/null -w "ha_api_without_auth=%{http_code}\n" "$(replace_target_placeholders "${TARGET_HA_BASE_URL:-http://__TARGET_PUBLIC_HOST__:8123}")/api/" || true

log "目标服务器内部验证"
remote_target "TARGET_APP_ROOT='${TARGET_APP_ROOT}' bash -s" <<'REMOTE'
set -euo pipefail
echo "== services =="
systemctl is-active smart-home-backend smart-home-frontend nginx mysql influxdb docker 2>/dev/null || true
echo "== local endpoints =="
curl -sS -o /dev/null -w "backend=%{http_code}\n" http://127.0.0.1:8000/api/v1/system/health || true
curl -sS -o /dev/null -w "frontend=%{http_code}\n" http://127.0.0.1:3100/home || true
curl -sS -o /dev/null -w "public=%{http_code}\n" http://127.0.0.1:8088/home || true
curl -sS -o /dev/null -w "influx_health=%{http_code}\n" http://127.0.0.1:8086/health || true
echo "== docker =="
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | grep -E 'docker-|home-assistant|NAMES' || true
echo "== recent operation logs =="
cd "${TARGET_APP_ROOT}/current/backend" 2>/dev/null || exit 0
if [ -f .venv/bin/python ] && [ -f "${TARGET_APP_ROOT}/shared/backend.env" ]; then
  ./.venv/bin/python - <<'PY'
import re, subprocess
from urllib.parse import urlparse, unquote
text=open('/home/ubuntu/projects/smart-home/app/shared/backend.env').read()
m=re.search(r'^DATABASE_URL=(.*)$', text, re.M)
if not m:
    raise SystemExit(0)
u=urlparse(m.group(1).strip().strip('"').strip("'"))
cmd=['mysql','-h'+(u.hostname or '127.0.0.1'),'-P'+str(u.port or 3306),'-u'+unquote(u.username or ''),'-p'+unquote(u.password or ''),'-N','-B',(u.path or '/').lstrip('/'),'-e',"SELECT COUNT(*) FROM operation_logs; SELECT created_at, level, type, title FROM operation_logs ORDER BY created_at DESC LIMIT 8;"]
res=subprocess.run(cmd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
print(res.stdout)
PY
fi
REMOTE

log "目标验证完成"

