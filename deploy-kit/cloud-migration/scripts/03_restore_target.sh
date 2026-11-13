#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

BUNDLE_DIR=""

usage() {
  cat <<EOF
用法：
  CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env $0 --bundle-dir build/migration/<timestamp>

恢复 MySQL、InfluxDB、Dify、Home Assistant 和平台 shared 配置到目标服务器。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle-dir)
      BUNDLE_DIR="$2"
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

[ -n "${TARGET_HOST:-}" ] || die "TARGET_HOST 不能为空"
[ -n "${TARGET_PUBLIC_HOST:-}" ] || die "TARGET_PUBLIC_HOST 不能为空"
[ -n "${BUNDLE_DIR}" ] || die "必须传入 --bundle-dir"
[ -d "${BUNDLE_DIR}" ] || die "迁移包目录不存在：${BUNDLE_DIR}"

TARGET_DIFY_BASE_URL="$(replace_target_placeholders "${TARGET_DIFY_BASE_URL:-http://__TARGET_PUBLIC_HOST__}")"
TARGET_HA_BASE_URL="$(replace_target_placeholders "${TARGET_HA_BASE_URL:-http://__TARGET_PUBLIC_HOST__:8123}")"
TARGET_CORS_ORIGINS="$(replace_target_placeholders "${TARGET_CORS_ORIGINS:-[\"http://__TARGET_PUBLIC_HOST__:8088\"]}")"

for file in app-shared-config.tar.gz mysql-smart_home_web.sql.gz influxdb-backup.tar.gz dify-docker.tar.gz ha-config.tar.gz; do
  [ -f "${BUNDLE_DIR}/${file}" ] || die "迁移包缺少 ${file}"
done

REMOTE_STAGE="/tmp/smart-home-migration-restore-$(date '+%Y%m%d-%H%M%S')"
log "上传迁移包到目标服务器：${REMOTE_STAGE}"
remote_target "mkdir -p '${REMOTE_STAGE}'"
scp_to_target "${BUNDLE_DIR}/app-shared-config.tar.gz" "${REMOTE_STAGE}/"
scp_to_target "${BUNDLE_DIR}/mysql-smart_home_web.sql.gz" "${REMOTE_STAGE}/"
scp_to_target "${BUNDLE_DIR}/influxdb-backup.tar.gz" "${REMOTE_STAGE}/"
scp_to_target "${BUNDLE_DIR}/dify-docker.tar.gz" "${REMOTE_STAGE}/"
scp_to_target "${BUNDLE_DIR}/ha-config.tar.gz" "${REMOTE_STAGE}/"
scp_to_target "${BUNDLE_DIR}/docker-images-required.txt" "${REMOTE_STAGE}/"
scp_to_target "${KIT_DIR}/templates/docker-compose.home-assistant.yml" "${REMOTE_STAGE}/"

log "执行目标服务器恢复"
remote_target "REMOTE_STAGE='${REMOTE_STAGE}' TARGET_APP_ROOT='${TARGET_APP_ROOT}' TARGET_DIFY_DOCKER_DIR='${TARGET_DIFY_DOCKER_DIR}' TARGET_DOCKER_SERVICE_DIR='${TARGET_DOCKER_SERVICE_DIR}' TARGET_DATABASE_URL='${TARGET_DATABASE_URL}' TARGET_DIFY_BASE_URL='${TARGET_DIFY_BASE_URL}' TARGET_HA_BASE_URL='${TARGET_HA_BASE_URL}' TARGET_INFLUXDB_URL='${TARGET_INFLUXDB_URL}' TARGET_CORS_ORIGINS='${TARGET_CORS_ORIGINS}' TARGET_PUBLIC_HOST='${TARGET_PUBLIC_HOST}' TARGET_PUBLIC_PORT='${TARGET_PUBLIC_PORT}' TARGET_SUDO_PASSWORD='${TARGET_SUDO_PASSWORD:-}' INFLUXDB_ADMIN_USER='${INFLUXDB_ADMIN_USER}' INFLUXDB_ADMIN_PASSWORD='${INFLUXDB_ADMIN_PASSWORD}' INFLUXDB_ORG='${INFLUXDB_ORG}' INFLUXDB_BUCKET='${INFLUXDB_BUCKET}' bash -s" <<'REMOTE'
set -euo pipefail

run_sudo() {
  if [ -n "${TARGET_SUDO_PASSWORD:-}" ]; then
    printf '%s\n' "${TARGET_SUDO_PASSWORD}" | sudo -Skp '' "$@"
  else
    sudo -n "$@"
  fi
}

parse_env() {
  python3 - "$1" "$2" <<'PY'
import re, sys
path, key = sys.argv[1], sys.argv[2]
text = open(path).read()
m = re.search(rf"^{re.escape(key)}=(.*)$", text, re.M)
print(m.group(1).strip().strip('"').strip("'") if m else "")
PY
}

replace_env_key() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "${file}"; then
    python3 - "$file" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
with open(path, "w") as f:
    for line in lines:
        if line.startswith(key + "="):
            f.write(f"{key}={value}\n")
        else:
            f.write(line + "\n")
PY
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

mkdir -p "${TARGET_APP_ROOT}" "${TARGET_DIFY_DOCKER_DIR}" "${TARGET_DOCKER_SERVICE_DIR}"

echo "恢复平台 shared 配置"
tar -C "${TARGET_APP_ROOT}" -xzf "${REMOTE_STAGE}/app-shared-config.tar.gz"
BACKEND_ENV="${TARGET_APP_ROOT}/shared/backend.env"
FRONTEND_ENV="${TARGET_APP_ROOT}/shared/frontend.env"
replace_env_key "${BACKEND_ENV}" DATABASE_URL "${TARGET_DATABASE_URL}"
replace_env_key "${BACKEND_ENV}" DIFY_BASE_URL "${TARGET_DIFY_BASE_URL}"
replace_env_key "${BACKEND_ENV}" HA_BASE_URL "${TARGET_HA_BASE_URL}"
replace_env_key "${BACKEND_ENV}" INFLUXDB_URL "${TARGET_INFLUXDB_URL}"
replace_env_key "${BACKEND_ENV}" CORS_ORIGINS "${TARGET_CORS_ORIGINS}"
replace_env_key "${FRONTEND_ENV}" NEXT_PUBLIC_API_BASE_URL "/api/v1"
replace_env_key "${FRONTEND_ENV}" NEXT_PUBLIC_WS_URL ""

echo "恢复 MySQL"
python3 - "${TARGET_DATABASE_URL}" >/tmp/smart-home-create-db.sql <<'PY'
import re, sys
from urllib.parse import urlparse, unquote
u = urlparse(sys.argv[1])
db = (u.path or "/").lstrip("/") or "smart_home_web"
user = unquote(u.username or "smart_home")
password = unquote(u.password or "")
def esc(v):
    return v.replace("\\", "\\\\").replace("'", "\\'")
print(f"CREATE DATABASE IF NOT EXISTS `{db}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;")
print(f"CREATE USER IF NOT EXISTS '{esc(user)}'@'%' IDENTIFIED BY '{esc(password)}';")
print(f"ALTER USER '{esc(user)}'@'%' IDENTIFIED BY '{esc(password)}';")
print(f"GRANT ALL PRIVILEGES ON `{db}`.* TO '{esc(user)}'@'%';")
print("FLUSH PRIVILEGES;")
PY
run_sudo mysql < /tmp/smart-home-create-db.sql
TARGET_DB="$(python3 - "${TARGET_DATABASE_URL}" <<'PY'
from urllib.parse import urlparse
import sys
print((urlparse(sys.argv[1]).path or "/").lstrip("/") or "smart_home_web")
PY
)"
gzip -dc "${REMOTE_STAGE}/mysql-smart_home_web.sql.gz" | run_sudo mysql "${TARGET_DB}"

echo "恢复 InfluxDB"
INFLUX_TOKEN="$(parse_env "${BACKEND_ENV}" INFLUXDB_TOKEN)"
if curl -fsS http://127.0.0.1:8086/api/v2/setup 2>/dev/null | grep -q '"allowed":true'; then
  influx setup \
    --username "${INFLUXDB_ADMIN_USER}" \
    --password "${INFLUXDB_ADMIN_PASSWORD}" \
    --org "${INFLUXDB_ORG}" \
    --bucket "${INFLUXDB_BUCKET}" \
    --token "${INFLUX_TOKEN}" \
    --force
fi
mkdir -p "${REMOTE_STAGE}/influxdb-backup"
tar -C "${REMOTE_STAGE}/influxdb-backup" -xzf "${REMOTE_STAGE}/influxdb-backup.tar.gz"
if [ -n "${INFLUX_TOKEN}" ] && [ ! -f "${REMOTE_STAGE}/influxdb-backup/README.txt" ]; then
  influx restore "${REMOTE_STAGE}/influxdb-backup" --host http://127.0.0.1:8086 --token "${INFLUX_TOKEN}" || true
fi

echo "恢复 Dify"
mkdir -p "$(dirname "${TARGET_DIFY_DOCKER_DIR}")"
tar -C "$(dirname "${TARGET_DIFY_DOCKER_DIR}")" -xzf "${REMOTE_STAGE}/dify-docker.tar.gz"
if [ -f "${TARGET_DIFY_DOCKER_DIR}/.env" ]; then
  sed -i "s#42\\.240\\.132\\.79#${TARGET_PUBLIC_HOST}#g" "${TARGET_DIFY_DOCKER_DIR}/.env" "${TARGET_DIFY_DOCKER_DIR}"/nginx/*.conf 2>/dev/null || true
fi
cd "${TARGET_DIFY_DOCKER_DIR}"
docker compose pull
docker compose up -d

echo "恢复 Home Assistant"
mkdir -p "${TARGET_DOCKER_SERVICE_DIR}"
tar -C "${TARGET_DOCKER_SERVICE_DIR}" -xzf "${REMOTE_STAGE}/ha-config.tar.gz"
cp "${REMOTE_STAGE}/docker-compose.home-assistant.yml" "${TARGET_DOCKER_SERVICE_DIR}/docker-compose.yml"
cat > "${TARGET_DOCKER_SERVICE_DIR}/.env" <<EOF
TZ=Asia/Shanghai
HA_CONFIG_PATH=./ha-config
EOF
cd "${TARGET_DOCKER_SERVICE_DIR}"
docker compose pull
docker compose up -d

echo "重写平台数据库运行时配置"
python3 - "${TARGET_DATABASE_URL}" "${TARGET_DIFY_BASE_URL}" "${TARGET_HA_BASE_URL}" "${TARGET_INFLUXDB_URL}" "${TARGET_PUBLIC_HOST}" <<'PY' >/tmp/smart-home-rewrite-runtime.sql
import sys
from urllib.parse import urlparse, unquote
db_url, dify, ha, influx, public_host = sys.argv[1:]
u = urlparse(db_url)
def esc(v):
    return v.replace("\\", "\\\\").replace("'", "\\'")
for key, value in {"dify_base_url": dify, "ha_base_url": ha, "influxdb_url": influx}.items():
    print(f"INSERT INTO system_config (`key`,`value`) VALUES ('{esc(key)}','{esc(value)}') ON DUPLICATE KEY UPDATE `value`=VALUES(`value`);")
print(f"UPDATE agent_instances SET dify_console_url=REPLACE(dify_console_url, '42.240.132.79', '{esc(public_host)}') WHERE dify_console_url LIKE '%42.240.132.79%';")
PY
DB_HOST="$(python3 - "${TARGET_DATABASE_URL}" <<'PY'
from urllib.parse import urlparse
import sys
print(urlparse(sys.argv[1]).hostname or "127.0.0.1")
PY
)"
DB_PORT="$(python3 - "${TARGET_DATABASE_URL}" <<'PY'
from urllib.parse import urlparse
import sys
print(urlparse(sys.argv[1]).port or 3306)
PY
)"
DB_USER="$(python3 - "${TARGET_DATABASE_URL}" <<'PY'
from urllib.parse import urlparse, unquote
import sys
print(unquote(urlparse(sys.argv[1]).username or ""))
PY
)"
DB_PASS="$(python3 - "${TARGET_DATABASE_URL}" <<'PY'
from urllib.parse import urlparse, unquote
import sys
print(unquote(urlparse(sys.argv[1]).password or ""))
PY
)"
mysql -h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASS}" "${TARGET_DB}" < /tmp/smart-home-rewrite-runtime.sql

echo "目标恢复完成"
REMOTE

log "目标服务器恢复完成"
