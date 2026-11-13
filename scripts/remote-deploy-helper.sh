#!/usr/bin/env bash
set -euo pipefail

REMOTE_ROOT=""
PUBLIC_PORT="8088"
FRONTEND_PORT="3100"
BACKEND_PORT="8000"
KEEP_RELEASES="5"
RELEASE_ID=""
BUNDLE_PATH=""
ONLY_UPLOAD="0"
ROLLBACK_RELEASE=""
VERBOSE="0"
PASSWORD="${SMART_HOME_DEPLOY_PASSWORD:-}"

RED="$(printf '\033[0;31m')"
GREEN="$(printf '\033[0;32m')"
YELLOW="$(printf '\033[1;33m')"
BLUE="$(printf '\033[0;34m')"
NC="$(printf '\033[0m')"

log() {
  printf '%b[remote-deploy]%b %s\n' "${BLUE}" "${NC}" "$*" >&2
}

ok() {
  printf '%b[ok]%b %s\n' "${GREEN}" "${NC}" "$*" >&2
}

warn() {
  printf '%b[warn]%b %s\n' "${YELLOW}" "${NC}" "$*" >&2
}

err() {
  printf '%b[error]%b %s\n' "${RED}" "${NC}" "$*" >&2
}

usage() {
  cat <<'EOF'
Usage:
  remote-deploy-helper.sh --remote-root <path> --release-id <id> --bundle-path <file> [options]
  remote-deploy-helper.sh --remote-root <path> --rollback <release_id> [options]
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --remote-root)
        REMOTE_ROOT="$2"
        shift 2
        ;;
      --public-port)
        PUBLIC_PORT="$2"
        shift 2
        ;;
      --frontend-port)
        FRONTEND_PORT="$2"
        shift 2
        ;;
      --backend-port)
        BACKEND_PORT="$2"
        shift 2
        ;;
      --keep-releases)
        KEEP_RELEASES="$2"
        shift 2
        ;;
      --release-id)
        RELEASE_ID="$2"
        shift 2
        ;;
      --bundle-path)
        BUNDLE_PATH="$2"
        shift 2
        ;;
      --only-upload)
        ONLY_UPLOAD="1"
        shift
        ;;
      --rollback)
        ROLLBACK_RELEASE="$2"
        shift 2
        ;;
      --verbose)
        VERBOSE="1"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        err "Unknown argument: $1"
        usage
        exit 1
        ;;
    esac
  done
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    exit 1
  fi
}

require_password() {
  if [ -z "${PASSWORD}" ]; then
    err "SMART_HOME_DEPLOY_PASSWORD is required for sudo operations"
    exit 1
  fi
}

run_sudo() {
  printf '%s\n' "${PASSWORD}" | sudo -Skp '' "$@"
}

run_sudo_shell() {
  printf '%s\n' "${PASSWORD}" | sudo -Skp '' bash -lc "$1"
}

assert_paths() {
  if [ -z "${REMOTE_ROOT}" ]; then
    err "--remote-root is required"
    exit 1
  fi

  if [ -n "${ROLLBACK_RELEASE}" ]; then
    return
  fi

  if [ -z "${RELEASE_ID}" ] || [ -z "${BUNDLE_PATH}" ]; then
    err "--release-id and --bundle-path are required for deploy"
    exit 1
  fi
}

ensure_layout() {
  mkdir -p "${REMOTE_ROOT}/releases" "${REMOTE_ROOT}/shared" "${REMOTE_ROOT}/shared/logs" "${REMOTE_ROOT}/shared/run"
}

copy_example_if_missing() {
  local source_file="$1"
  local target_file="$2"
  if [ -f "${source_file}" ] && [ ! -f "${target_file}" ]; then
    cp "${source_file}" "${target_file}"
  fi
}

check_shared_env_files() {
  local release_dir="$1"
  copy_example_if_missing "${release_dir}/deploy/examples/backend.env.example" "${REMOTE_ROOT}/shared/backend.env.example"
  copy_example_if_missing "${release_dir}/deploy/examples/frontend.env.example" "${REMOTE_ROOT}/shared/frontend.env.example"

  if [ ! -f "${REMOTE_ROOT}/shared/backend.env" ]; then
    err "Missing ${REMOTE_ROOT}/shared/backend.env"
    err "Template created at ${REMOTE_ROOT}/shared/backend.env.example"
    exit 1
  fi

  if [ ! -f "${REMOTE_ROOT}/shared/frontend.env" ]; then
    err "Missing ${REMOTE_ROOT}/shared/frontend.env"
    err "Template created at ${REMOTE_ROOT}/shared/frontend.env.example"
    exit 1
  fi
}

install_backend_venv() {
  local release_dir="$1"
  log "Creating backend virtualenv"
  (
    cd "${release_dir}/backend"
    python3 -m venv .venv
    ./.venv/bin/python -m pip install --upgrade pip >/dev/null
    ./.venv/bin/python -m pip install -r requirements.txt
  )
}

render_template() {
  local template_file="$1"
  local output_file="$2"
  sed \
    -e "s|__REMOTE_ROOT__|${REMOTE_ROOT}|g" \
    -e "s|__BACKEND_PORT__|${BACKEND_PORT}|g" \
    -e "s|__FRONTEND_PORT__|${FRONTEND_PORT}|g" \
    -e "s|__PUBLIC_PORT__|${PUBLIC_PORT}|g" \
    "${template_file}" > "${output_file}"
}

install_systemd_units() {
  local release_dir="$1"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  render_template "${release_dir}/deploy/templates/smart-home-backend.service" "${tmp_dir}/smart-home-backend.service"
  render_template "${release_dir}/deploy/templates/smart-home-frontend.service" "${tmp_dir}/smart-home-frontend.service"

  run_sudo cp "${tmp_dir}/smart-home-backend.service" /etc/systemd/system/smart-home-backend.service
  run_sudo cp "${tmp_dir}/smart-home-frontend.service" /etc/systemd/system/smart-home-frontend.service
  run_sudo systemctl daemon-reload
  run_sudo systemctl enable smart-home-backend.service smart-home-frontend.service >/dev/null

  rm -rf "${tmp_dir}"
}

install_nginx_site() {
  local release_dir="$1"
  local tmp_dir
  local site_name="smart-home-app-${PUBLIC_PORT}"
  tmp_dir="$(mktemp -d)"

  render_template "${release_dir}/deploy/templates/smart-home-app.nginx.conf" "${tmp_dir}/${site_name}.conf"

  run_sudo cp "${tmp_dir}/${site_name}.conf" "/etc/nginx/sites-available/${site_name}"
  run_sudo ln -sfn "/etc/nginx/sites-available/${site_name}" "/etc/nginx/sites-enabled/${site_name}"
  run_sudo nginx -t
  run_sudo systemctl reload nginx

  rm -rf "${tmp_dir}"
}

activate_release() {
  local release_dir="$1"
  ln -sfn "${release_dir}" "${REMOTE_ROOT}/current"
}

restart_services() {
  run_sudo systemctl restart smart-home-backend.service
  run_sudo systemctl restart smart-home-frontend.service
  run_sudo systemctl reload nginx
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-30}"
  local delay="${4:-2}"
  local i

  for i in $(seq 1 "${attempts}"); do
    if curl -fsS --max-time 5 "${url}" >/dev/null 2>&1; then
      ok "${label} healthy: ${url}"
      return 0
    fi
    sleep "${delay}"
  done

  err "${label} health check failed: ${url}"
  return 1
}

source_backend_env() {
  set -a
  # shellcheck disable=SC1090
  source "${REMOTE_ROOT}/shared/backend.env"
  set +a
}

check_optional_dependency() {
  local name="$1"
  local url="$2"
  if [ -z "${url}" ]; then
    warn "${name} URL not configured"
    return 0
  fi

  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${url}" 2>/dev/null || true)"
  code="${code:-000}"
  if [ "${code}" = "000" ] || [ "${code}" -ge 500 ] 2>/dev/null; then
    warn "${name} unreachable: ${url}"
  else
    ok "${name} reachable: ${url} (HTTP ${code})"
  fi
}

check_optional_dependencies() {
  source_backend_env
  check_optional_dependency "Dify" "${DIFY_BASE_URL:-}/v1/datasets"
  check_optional_dependency "Home Assistant" "${HA_BASE_URL:-}/api/"
  check_optional_dependency "Ollama" "${OLLAMA_BASE_URL:-http://127.0.0.1:11434}/api/version"
  check_optional_dependency "InfluxDB" "${INFLUXDB_URL:-http://127.0.0.1:8086}/health"
}

cleanup_bundle() {
  if [ -n "${BUNDLE_PATH}" ] && [ -f "${BUNDLE_PATH}" ]; then
    rm -f "${BUNDLE_PATH}"
  fi
}

cleanup_old_releases() {
  if [ "${KEEP_RELEASES}" -lt 1 ] 2>/dev/null; then
    return
  fi

  local releases_dir="${REMOTE_ROOT}/releases"
  local current_target=""
  local stale_releases

  if [ -L "${REMOTE_ROOT}/current" ]; then
    current_target="$(readlink "${REMOTE_ROOT}/current")"
  fi

  stale_releases="$(
    find "${releases_dir}" -mindepth 1 -maxdepth 1 -type d -print \
      | sort -r \
      | awk -v keep="${KEEP_RELEASES}" 'NR > keep { print }'
  )"

  if [ -z "${stale_releases}" ]; then
    return
  fi

  while IFS= read -r release_dir; do
    [ -n "${release_dir}" ] || continue
    if [ "${release_dir}" = "${current_target}" ]; then
      continue
    fi
    rm -rf "${release_dir}"
  done <<EOF
${stale_releases}
EOF
}

preflight() {
  need_cmd bash
  need_cmd python3
  need_cmd node
  need_cmd npm
  need_cmd systemctl
  need_cmd nginx
  need_cmd tar
  need_cmd curl
  require_password
}

deploy_release() {
  local release_dir="${REMOTE_ROOT}/releases/${RELEASE_ID}"
  local previous_release=""

  if [ -e "${release_dir}" ]; then
    err "Release already exists: ${release_dir}"
    exit 1
  fi

  if [ -L "${REMOTE_ROOT}/current" ]; then
    previous_release="$(readlink "${REMOTE_ROOT}/current")"
  fi

  log "Extracting bundle to ${release_dir}"
  mkdir -p "${release_dir}"
  tar -xzf "${BUNDLE_PATH}" -C "${release_dir}"
  cleanup_bundle

  check_shared_env_files "${release_dir}"
  install_backend_venv "${release_dir}"

  if [ "${ONLY_UPLOAD}" = "1" ]; then
    ok "Release ${RELEASE_ID} staged at ${release_dir}"
    exit 0
  fi

  install_systemd_units "${release_dir}"
  install_nginx_site "${release_dir}"
  activate_release "${release_dir}"

  if restart_services \
    && wait_for_url "http://127.0.0.1:${BACKEND_PORT}/api/v1/system/health" "Backend" \
    && wait_for_url "http://127.0.0.1:${FRONTEND_PORT}" "Frontend" \
    && wait_for_url "http://127.0.0.1:${PUBLIC_PORT}" "Public entry"; then
    check_optional_dependencies
    cleanup_old_releases
    ok "Release ${RELEASE_ID} is live"
    return 0
  fi

  err "Deployment failed after switching release"
  if [ -n "${previous_release}" ] && [ -d "${previous_release}" ]; then
    warn "Rolling back to previous release ${previous_release}"
    activate_release "${previous_release}"
    install_systemd_units "${previous_release}"
    install_nginx_site "${previous_release}"
    restart_services || true
  fi
  exit 1
}

rollback_release() {
  local target_release="${REMOTE_ROOT}/releases/${ROLLBACK_RELEASE}"
  if [ ! -d "${target_release}" ]; then
    err "Rollback target does not exist: ${target_release}"
    exit 1
  fi

  check_shared_env_files "${target_release}"
  install_systemd_units "${target_release}"
  install_nginx_site "${target_release}"
  activate_release "${target_release}"
  restart_services
  wait_for_url "http://127.0.0.1:${BACKEND_PORT}/api/v1/system/health" "Backend"
  wait_for_url "http://127.0.0.1:${FRONTEND_PORT}" "Frontend"
  wait_for_url "http://127.0.0.1:${PUBLIC_PORT}" "Public entry"
  check_optional_dependencies
  ok "Rollback to ${ROLLBACK_RELEASE} completed"
}

main() {
  parse_args "$@"
  assert_paths
  preflight
  ensure_layout

  if [ -n "${ROLLBACK_RELEASE}" ]; then
    rollback_release
  else
    deploy_release
  fi
}

main "$@"
