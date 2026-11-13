#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${KIT_DIR}/../.." && pwd)"

CONFIG_FILE="${CONFIG_FILE:-${KIT_DIR}/config/migration.env}"

log() {
  printf '[cloud-migration] %s\n' "$*" >&2
}

warn() {
  printf '[cloud-migration][warn] %s\n' "$*" >&2
}

die() {
  printf '[cloud-migration][error] %s\n' "$*" >&2
  exit 1
}

usage_common() {
  cat <<EOF
通用环境变量：
  CONFIG_FILE=<path>  默认 ${KIT_DIR}/config/migration.env
EOF
}

load_config() {
  if [ ! -f "${CONFIG_FILE}" ]; then
    die "缺少配置文件：${CONFIG_FILE}。请先复制 config/migration.env.example 为 config/migration.env。"
  fi
  # shellcheck disable=SC1090
  set -a
  source "${CONFIG_FILE}"
  set +a

  SOURCE_SSH_PORT="${SOURCE_SSH_PORT:-22}"
  TARGET_SSH_PORT="${TARGET_SSH_PORT:-22}"
  SOURCE_USER="${SOURCE_USER:-ubuntu}"
  TARGET_USER="${TARGET_USER:-ubuntu}"
  LOCAL_MIGRATION_ROOT="${LOCAL_MIGRATION_ROOT:-build/migration}"
  SOURCE_APP_ROOT="${SOURCE_APP_ROOT:-/home/ubuntu/projects/smart-home/app}"
  TARGET_APP_ROOT="${TARGET_APP_ROOT:-/home/ubuntu/projects/smart-home/app}"
  SOURCE_DIFY_DOCKER_DIR="${SOURCE_DIFY_DOCKER_DIR:-/home/ubuntu/dify/docker}"
  TARGET_DIFY_DOCKER_DIR="${TARGET_DIFY_DOCKER_DIR:-/home/ubuntu/dify/docker}"
  SOURCE_DOCKER_SERVICE_DIR="${SOURCE_DOCKER_SERVICE_DIR:-/home/ubuntu/projects/smart-home/docker-service}"
  TARGET_DOCKER_SERVICE_DIR="${TARGET_DOCKER_SERVICE_DIR:-/home/ubuntu/projects/smart-home/docker-service}"
  TARGET_PUBLIC_PORT="${TARGET_PUBLIC_PORT:-8088}"
  TARGET_INFLUXDB_URL="${TARGET_INFLUXDB_URL:-http://127.0.0.1:8086}"
  INFLUXDB_ORG="${INFLUXDB_ORG:-smart-home}"
  INFLUXDB_BUCKET="${INFLUXDB_BUCKET:-smart-home-data}"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少本地命令：$1"
}

remote_source() {
  ssh -p "${SOURCE_SSH_PORT}" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    "${SOURCE_USER}@${SOURCE_HOST}" "$@"
}

remote_target() {
  ssh -p "${TARGET_SSH_PORT}" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    "${TARGET_USER}@${TARGET_HOST}" "$@"
}

scp_from_source() {
  scp -P "${SOURCE_SSH_PORT}" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -r "${SOURCE_USER}@${SOURCE_HOST}:$1" "$2"
}

scp_to_target() {
  scp -P "${TARGET_SSH_PORT}" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -r "$1" "${TARGET_USER}@${TARGET_HOST}:$2"
}

target_sudo_prefix() {
  if [ -n "${TARGET_SUDO_PASSWORD:-}" ]; then
    printf "printf %%s\\\\n %q | sudo -Skp '' " "${TARGET_SUDO_PASSWORD}"
  else
    printf "sudo -n "
  fi
}

replace_target_placeholders() {
  local value="$1"
  value="${value//__TARGET_PUBLIC_HOST__/${TARGET_PUBLIC_HOST:-${TARGET_HOST:-}}}"
  printf '%s' "$value"
}

create_run_dir() {
  local stamp
  stamp="$(date '+%Y%m%d-%H%M%S')"
  RUN_DIR="${ROOT_DIR}/${LOCAL_MIGRATION_ROOT}/${stamp}"
  mkdir -p "${RUN_DIR}"
  printf '%s\n' "${RUN_DIR}"
}
