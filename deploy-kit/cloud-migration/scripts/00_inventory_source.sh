#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

usage() {
  cat <<EOF
用法：
  CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env $0 [--output <dir>]

只读盘点源服务器服务、端口、镜像、目录大小和版本。
EOF
}

OUTPUT_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done

load_config
require_cmd ssh

if [ -z "${SOURCE_HOST:-}" ]; then
  die "SOURCE_HOST 不能为空"
fi

if [ -z "${OUTPUT_DIR}" ]; then
  OUTPUT_DIR="$(create_run_dir)"
else
  mkdir -p "${OUTPUT_DIR}"
fi

log "盘点源服务器 ${SOURCE_USER}@${SOURCE_HOST}"
remote_source "SOURCE_APP_ROOT='${SOURCE_APP_ROOT}' SOURCE_DIFY_DOCKER_DIR='${SOURCE_DIFY_DOCKER_DIR}' SOURCE_DOCKER_SERVICE_DIR='${SOURCE_DOCKER_SERVICE_DIR}' bash -s" > "${OUTPUT_DIR}/source-inventory.json" <<'REMOTE'
set -euo pipefail
json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}
section_text() {
  local cmd="$1"
  bash -lc "$cmd" 2>&1 | json_escape
}
printf '{\n'
printf '  "generated_at": %s,\n' "$(date -Iseconds | json_escape)"
printf '  "hostname": %s,\n' "$(hostname | json_escape)"
printf '  "os": %s,\n' "($(lsb_release -ds 2>/dev/null || cat /etc/os-release 2>/dev/null || true))" | sed 's/^/  /' >/tmp/os-json
printf '  "os": %s,\n' "$(lsb_release -ds 2>/dev/null | json_escape || echo '""')"
printf '  "versions": {\n'
printf '    "docker": %s,\n' "$(docker --version 2>/dev/null | json_escape || echo '""')"
printf '    "docker_compose": %s,\n' "$(docker compose version 2>/dev/null | json_escape || echo '""')"
printf '    "node": %s,\n' "$(node -v 2>/dev/null | json_escape || echo '""')"
printf '    "npm": %s,\n' "$(npm -v 2>/dev/null | json_escape || echo '""')"
printf '    "python3": %s,\n' "$(python3 --version 2>/dev/null | json_escape || echo '""')"
printf '    "mysql": %s,\n' "$(mysql --version 2>/dev/null | json_escape || echo '""')"
printf '    "influxd": %s,\n' "$(influxd version 2>/dev/null | json_escape || echo '""')"
printf '    "nginx": %s\n' "$(nginx -v 2>&1 | json_escape || echo '""')"
printf '  },\n'
printf '  "services": %s,\n' "$(section_text "systemctl is-active smart-home-backend smart-home-frontend nginx mysql influxdb docker containerd 2>/dev/null || true")"
printf '  "ports": %s,\n' "$(section_text "ss -ltnp 2>/dev/null | grep -E ':(80|443|8000|8088|3100|3306|8086|8123|8443|8888|11434)' || true")"
printf '  "docker_containers": %s,\n' "$(section_text "docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>/dev/null || true")"
printf '  "docker_images": %s,\n' "$(section_text "docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}' 2>/dev/null || true")"
printf '  "disk": %s,\n' "$(section_text "df -h; du -sh ${SOURCE_APP_ROOT} ${SOURCE_DIFY_DOCKER_DIR} ${SOURCE_DOCKER_SERVICE_DIR}/ha-config /var/lib/influxdb /var/lib/mysql 2>/dev/null || true")"
printf '  "current_release": %s\n' "$(section_text "cat ${SOURCE_APP_ROOT}/current/release.json 2>/dev/null || true")"
printf '}\n'
REMOTE

log "盘点结果：${OUTPUT_DIR}/source-inventory.json"

