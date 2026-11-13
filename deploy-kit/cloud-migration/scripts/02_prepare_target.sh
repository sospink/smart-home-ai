#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

usage() {
  cat <<EOF
用法：
  CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env $0

初始化目标服务器基础环境：系统依赖、Docker、MySQL、InfluxDB、Nginx、目录结构和基础防火墙。
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

load_config
require_cmd ssh

[ -n "${TARGET_HOST:-}" ] || die "TARGET_HOST 不能为空"
[ -n "${TARGET_PUBLIC_HOST:-}" ] || die "TARGET_PUBLIC_HOST 不能为空"

log "准备目标服务器 ${TARGET_USER}@${TARGET_HOST}"
remote_target "TARGET_APP_ROOT='${TARGET_APP_ROOT}' TARGET_DIFY_DOCKER_DIR='${TARGET_DIFY_DOCKER_DIR}' TARGET_DOCKER_SERVICE_DIR='${TARGET_DOCKER_SERVICE_DIR}' TARGET_PUBLIC_PORT='${TARGET_PUBLIC_PORT}' TARGET_SSH_PORT='${TARGET_SSH_PORT}' TARGET_SUDO_PASSWORD='${TARGET_SUDO_PASSWORD:-}' bash -s" <<'REMOTE'
set -euo pipefail

run_sudo() {
  if [ -n "${TARGET_SUDO_PASSWORD:-}" ]; then
    printf '%s\n' "${TARGET_SUDO_PASSWORD}" | sudo -Skp '' "$@"
  else
    sudo -n "$@"
  fi
}

if ! run_sudo true >/dev/null 2>&1; then
  echo "当前用户无法 sudo；请配置免密 sudo 或在 migration.env 填写 TARGET_SUDO_PASSWORD。" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
run_sudo apt-get update
run_sudo apt-get install -y ca-certificates curl gnupg lsb-release tar gzip unzip rsync nginx mysql-server python3 python3-venv python3-pip nodejs npm ufw

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | run_sudo sh
fi
run_sudo systemctl enable --now docker

if ! command -v influx >/dev/null 2>&1 || ! command -v influxd >/dev/null 2>&1; then
  curl -fsSL https://repos.influxdata.com/influxdata-archive_compat.key \
    | gpg --dearmor \
    | run_sudo tee /etc/apt/trusted.gpg.d/influxdata-archive_compat.gpg >/dev/null
  echo 'deb [signed-by=/etc/apt/trusted.gpg.d/influxdata-archive_compat.gpg] https://repos.influxdata.com/ubuntu stable main' \
    | run_sudo tee /etc/apt/sources.list.d/influxdata.list >/dev/null
  run_sudo apt-get update
  run_sudo apt-get install -y influxdb2 influxdb2-cli
fi
run_sudo systemctl enable --now mysql nginx influxdb

run_sudo mkdir -p \
  "${TARGET_APP_ROOT}/releases" \
  "${TARGET_APP_ROOT}/shared" \
  "${TARGET_APP_ROOT}/shared/logs" \
  "${TARGET_APP_ROOT}/shared/run" \
  "${TARGET_DIFY_DOCKER_DIR}" \
  "${TARGET_DOCKER_SERVICE_DIR}/ha-config"
run_sudo chown -R "$(id -un):$(id -gn)" \
  "${TARGET_APP_ROOT}" \
  "$(dirname "${TARGET_DIFY_DOCKER_DIR}")" \
  "$(dirname "${TARGET_DOCKER_SERVICE_DIR}")"

run_sudo ufw allow "${TARGET_SSH_PORT}/tcp"
run_sudo ufw allow 80/tcp
run_sudo ufw allow 443/tcp
run_sudo ufw allow "${TARGET_PUBLIC_PORT}/tcp"
run_sudo ufw allow 8123/tcp
run_sudo ufw --force enable

echo "目标服务器基础环境已准备。"
docker --version || true
docker compose version || true
mysql --version || true
influxd version || true
nginx -v 2>&1 || true
REMOTE

log "目标服务器准备完成"
