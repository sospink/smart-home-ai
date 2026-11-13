#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

DRY_RUN="0"
OUTPUT_DIR=""

usage() {
  cat <<EOF
用法：
  CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env $0 [--dry-run] [--output <dir>]

从源服务器导出核心迁移包：
  app-source.tar.gz
  mysql-smart_home_web.sql.gz
  influxdb-backup.tar.gz
  dify-docker.tar.gz
  ha-config.tar.gz
  app-shared-config.tar.gz
  docker-images-required.txt
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
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
require_cmd scp

if [ -z "${SOURCE_HOST:-}" ]; then
  die "SOURCE_HOST 不能为空"
fi

if [ -z "${OUTPUT_DIR}" ]; then
  OUTPUT_DIR="$(create_run_dir)"
else
  mkdir -p "${OUTPUT_DIR}"
fi

cat > "${OUTPUT_DIR}/docker-images-required.txt" <<'EOF'
langgenius/dify-api:1.13.3
langgenius/dify-web:1.13.3
langgenius/dify-sandbox:0.2.14
langgenius/dify-plugin-daemon:0.5.3-local
postgres:15-alpine
redis:6-alpine
semitechnologies/weaviate:1.27.0
ubuntu/squid:latest
nginx:latest
ghcr.io/home-assistant/home-assistant:stable
EOF

if [ "${DRY_RUN}" = "1" ]; then
  log "dry-run：将从源服务器导出以下内容"
  remote_source "du -sh '${SOURCE_APP_ROOT}/current/' '${SOURCE_APP_ROOT}/shared' '${SOURCE_DIFY_DOCKER_DIR}' '${SOURCE_DOCKER_SERVICE_DIR}/ha-config' /var/lib/influxdb /var/lib/mysql 2>/dev/null || true"
  log "dry-run：镜像清单已写入 ${OUTPUT_DIR}/docker-images-required.txt"
  exit 0
fi

REMOTE_TMP="/tmp/smart-home-migration-export-$(date '+%Y%m%d-%H%M%S')"
log "源服务器打包临时目录：${REMOTE_TMP}"

remote_source "REMOTE_TMP='${REMOTE_TMP}' SOURCE_APP_ROOT='${SOURCE_APP_ROOT}' SOURCE_DIFY_DOCKER_DIR='${SOURCE_DIFY_DOCKER_DIR}' SOURCE_DOCKER_SERVICE_DIR='${SOURCE_DOCKER_SERVICE_DIR}' bash -s" <<'REMOTE'
set -euo pipefail
mkdir -p "${REMOTE_TMP}"

log_remote() { printf '[source-export] %s\n' "$*" >&2; }

parse_env() {
  python3 - "$1" "$2" <<'PY'
import re, sys
path, key = sys.argv[1], sys.argv[2]
text = open(path).read()
m = re.search(rf"^{re.escape(key)}=(.*)$", text, re.M)
print(m.group(1).strip().strip('"').strip("'") if m else "")
PY
}

BACKEND_ENV="${SOURCE_APP_ROOT}/shared/backend.env"
DATABASE_URL="$(parse_env "${BACKEND_ENV}" DATABASE_URL)"
INFLUXDB_TOKEN="$(parse_env "${BACKEND_ENV}" INFLUXDB_TOKEN)"
INFLUXDB_ORG="$(parse_env "${BACKEND_ENV}" INFLUXDB_ORG)"
INFLUXDB_BUCKET="$(parse_env "${BACKEND_ENV}" INFLUXDB_BUCKET)"

log_remote "打包平台 current（排除后端 .venv）"
tar --dereference -C "${SOURCE_APP_ROOT}" --exclude='current/backend/.venv' --exclude='current/backend/__pycache__' -czf "${REMOTE_TMP}/app-source.tar.gz" current

log_remote "打包平台 shared 配置"
tar -C "${SOURCE_APP_ROOT}" -czf "${REMOTE_TMP}/app-shared-config.tar.gz" shared

log_remote "导出 MySQL smart_home_web"
python3 - "${DATABASE_URL}" "${REMOTE_TMP}/mysql-smart_home_web.sql.gz" <<'PY'
import gzip
import subprocess
import sys
from urllib.parse import urlparse, unquote
url = urlparse(sys.argv[1])
out = sys.argv[2]
db = (url.path or "/").lstrip("/") or "smart_home_web"
cmd = [
    "mysqldump",
    "-h", url.hostname or "127.0.0.1",
    "-P", str(url.port or 3306),
    "-u", unquote(url.username or "root"),
    "-p" + unquote(url.password or ""),
    "--single-transaction",
    "--routines",
    "--triggers",
    "--default-character-set=utf8mb4",
    db,
]
res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
if res.returncode:
    sys.stderr.write(res.stderr.decode(errors="ignore"))
    raise SystemExit(res.returncode)
with gzip.open(out, "wb") as f:
    f.write(res.stdout)
PY

log_remote "备份 InfluxDB bucket"
INFLUX_TMP="${REMOTE_TMP}/influxdb-backup"
mkdir -p "${INFLUX_TMP}"
if command -v influx >/dev/null 2>&1 && [ -n "${INFLUXDB_TOKEN}" ]; then
  influx backup "${INFLUX_TMP}" --host http://127.0.0.1:8086 --token "${INFLUXDB_TOKEN}" --org "${INFLUXDB_ORG:-smart-home}" --bucket "${INFLUXDB_BUCKET:-smart-home-data}"
  tar -C "${INFLUX_TMP}" -czf "${REMOTE_TMP}/influxdb-backup.tar.gz" .
else
  printf 'InfluxDB CLI or token missing; backup was not created.\n' > "${INFLUX_TMP}/README.txt"
  tar -C "${INFLUX_TMP}" -czf "${REMOTE_TMP}/influxdb-backup.tar.gz" .
fi

log_remote "打包 Dify docker 目录"
tar -C "$(dirname "${SOURCE_DIFY_DOCKER_DIR}")" -czf "${REMOTE_TMP}/dify-docker.tar.gz" "$(basename "${SOURCE_DIFY_DOCKER_DIR}")"

log_remote "打包 Home Assistant 配置"
tar -C "${SOURCE_DOCKER_SERVICE_DIR}" -czf "${REMOTE_TMP}/ha-config.tar.gz" ha-config

log_remote "生成校验和"
cd "${REMOTE_TMP}"
sha256sum *.tar.gz *.sql.gz > SHA256SUMS
REMOTE

log "下载迁移包到 ${OUTPUT_DIR}"
scp_from_source "${REMOTE_TMP}/app-source.tar.gz" "${OUTPUT_DIR}/"
scp_from_source "${REMOTE_TMP}/app-shared-config.tar.gz" "${OUTPUT_DIR}/"
scp_from_source "${REMOTE_TMP}/mysql-smart_home_web.sql.gz" "${OUTPUT_DIR}/"
scp_from_source "${REMOTE_TMP}/influxdb-backup.tar.gz" "${OUTPUT_DIR}/"
scp_from_source "${REMOTE_TMP}/dify-docker.tar.gz" "${OUTPUT_DIR}/"
scp_from_source "${REMOTE_TMP}/ha-config.tar.gz" "${OUTPUT_DIR}/"
scp_from_source "${REMOTE_TMP}/SHA256SUMS" "${OUTPUT_DIR}/"

"${SCRIPT_DIR}/00_inventory_source.sh" --output "${OUTPUT_DIR}" >/dev/null
log "迁移包已生成：${OUTPUT_DIR}"
