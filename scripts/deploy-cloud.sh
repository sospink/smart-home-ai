#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${ROOT_DIR}/smart-home-ai-frontend"
BACKEND_DIR="${ROOT_DIR}/smart-home-ai-backend"
REMOTE_HELPER="${SCRIPT_DIR}/remote-deploy-helper.sh"
DEPLOY_ASSETS_DIR="${SCRIPT_DIR}/deploy"
BUILD_ROOT="${ROOT_DIR}/build/deploy-cloud"

HOST="42.240.132.79"
USER_NAME="ubuntu"
REMOTE_ROOT="/home/ubuntu/projects/smart-home/app"
PUBLIC_PORT="8088"
FRONTEND_PORT="3100"
BACKEND_PORT="8000"
KEEP_RELEASES="5"
SKIP_BUILD="0"
ONLY_UPLOAD="0"
VERBOSE="0"
ROLLBACK_RELEASE=""
PASSWORD="${SMART_HOME_DEPLOY_PASSWORD:-}"

RED="$(printf '\033[0;31m')"
GREEN="$(printf '\033[0;32m')"
YELLOW="$(printf '\033[1;33m')"
BLUE="$(printf '\033[0;34m')"
NC="$(printf '\033[0m')"

log() {
  printf '%b[deploy-cloud]%b %s\n' "${BLUE}" "${NC}" "$*" >&2
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
  ./scripts/deploy-cloud.sh [options]
  ./scripts/deploy-cloud.sh --rollback <release_id> [options]

Options:
  --host <host>                 Remote host, default 42.240.132.79
  --user <user>                 Remote user, default ubuntu
  --password <password>         SSH/sudo password. Or set SMART_HOME_DEPLOY_PASSWORD
  --remote-root <path>          Remote app root, default /home/ubuntu/projects/smart-home/app
  --public-port <port>          Public nginx port, default 8088
  --frontend-port <port>        Frontend bind port, default 3100
  --backend-port <port>         Backend bind port, default 8000
  --keep-releases <count>       Keep newest N releases, default 5
  --skip-build                  Reuse current local build output
  --only-upload                 Upload and stage release without switching current
  --rollback <release_id>       Roll back current symlink to a previous release
  --verbose                     Print verbose remote command output
  -h, --help                    Show this help

Examples:
  ./scripts/deploy-cloud.sh
  SMART_HOME_DEPLOY_PASSWORD='***' ./scripts/deploy-cloud.sh --verbose
  ./scripts/deploy-cloud.sh --rollback 20260407-153000-abcd123
EOF
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    exit 1
  fi
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --host)
        HOST="$2"
        shift 2
        ;;
      --user)
        USER_NAME="$2"
        shift 2
        ;;
      --password)
        PASSWORD="$2"
        shift 2
        ;;
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
      --skip-build)
        SKIP_BUILD="1"
        shift
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

prompt_for_password_if_needed() {
  if [ -n "${PASSWORD}" ]; then
    return
  fi

  if [ -t 0 ]; then
    printf 'Remote password for %s@%s: ' "${USER_NAME}" "${HOST}" >&2
    stty -echo
    read -r PASSWORD
    stty echo
    printf '\n' >&2
  else
    err "No password provided. Use --password or SMART_HOME_DEPLOY_PASSWORD."
    exit 1
  fi
}

ssh_opts=()
ssh_base=()
scp_base=()

setup_ssh() {
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "${USER_NAME}@${HOST}" true >/dev/null 2>&1; then
    ssh_opts=(
      -o BatchMode=yes
      -o StrictHostKeyChecking=accept-new
    )
    ssh_base=(ssh "${ssh_opts[@]}" "${USER_NAME}@${HOST}")
    scp_base=(scp "${ssh_opts[@]}")
    ok "Using local SSH private key for ${USER_NAME}@${HOST}"
    return
  fi

  prompt_for_password_if_needed
  ssh_opts=(
    -o PreferredAuthentications=password
    -o PubkeyAuthentication=no
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
  )
  ssh_base=(sshpass -p "${PASSWORD}" ssh "${ssh_opts[@]}" "${USER_NAME}@${HOST}")
  scp_base=(sshpass -p "${PASSWORD}" scp "${ssh_opts[@]}")
}

remote_quote() {
  printf '%q' "$1"
}

run_remote_helper() {
  local helper_args=(
    --remote-root "${REMOTE_ROOT}"
    --public-port "${PUBLIC_PORT}"
    --frontend-port "${FRONTEND_PORT}"
    --backend-port "${BACKEND_PORT}"
    --keep-releases "${KEEP_RELEASES}"
  )
  if [ -n "${ROLLBACK_RELEASE}" ]; then
    helper_args+=(--rollback "${ROLLBACK_RELEASE}")
  fi
  if [ "${ONLY_UPLOAD}" = "1" ]; then
    helper_args+=(--only-upload)
  fi
  if [ "${VERBOSE}" = "1" ]; then
    helper_args+=(--verbose)
  fi
  if [ -n "${1:-}" ]; then
    helper_args+=(--release-id "${1}")
  fi
  if [ -n "${2:-}" ]; then
    helper_args+=(--bundle-path "${2}")
  fi

  local remote_cmd
  remote_cmd="SMART_HOME_DEPLOY_PASSWORD=$(remote_quote "${PASSWORD}") bash -s --"
  for arg in "${helper_args[@]}"; do
    remote_cmd+=" $(remote_quote "${arg}")"
  done

  if [ "${VERBOSE}" = "1" ]; then
    log "Running remote helper on ${HOST}"
  fi

  "${ssh_base[@]}" "${remote_cmd}" < "${REMOTE_HELPER}"
}

prepare_build_dirs() {
  mkdir -p "${BUILD_ROOT}"
}

build_frontend() {
  if [ "${SKIP_BUILD}" = "1" ]; then
    if [ ! -f "${FRONTEND_DIR}/.next/standalone/server.js" ]; then
      err "Missing ${FRONTEND_DIR}/.next/standalone/server.js. Run without --skip-build first."
      exit 1
    fi
    ok "Skipping frontend build and reusing current .next output"
    return
  fi

  log "Installing frontend dependencies"
  (
    cd "${FRONTEND_DIR}"
    npm ci
  )

  log "Building frontend standalone bundle"
  (
    cd "${FRONTEND_DIR}"
    rm -rf .next
    NEXT_PUBLIC_API_BASE_URL="/api/v1" NEXT_PUBLIC_WS_URL="" npm run build

    if grep -R "localhost:8000\|ws://localhost:8000" -n .next >/dev/null 2>&1; then
      err "Frontend build contains local development API URL. Check .env.local or build env."
      exit 1
    fi
  )
}

create_release_bundle() {
  local release_id="$1"
  local stage_dir="${BUILD_ROOT}/stage-${release_id}"
  local bundle_path="${BUILD_ROOT}/smart-home-${release_id}.tar.gz"
  local git_commit
  local git_branch
  local built_at

  git_commit="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
  git_branch="$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
  built_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  rm -rf "${stage_dir}"
  mkdir -p "${stage_dir}/backend" "${stage_dir}/frontend/.next" "${stage_dir}/deploy/templates" "${stage_dir}/deploy/examples"

  log "Collecting backend sources"
  tar \
    -C "${BACKEND_DIR}" \
    --exclude='.env' \
    --exclude='venv' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.DS_Store' \
    -cf - \
    app alembic requirements.txt alembic.ini sql .env.example .env.required \
    | tar -C "${stage_dir}/backend" -xf -

  log "Collecting frontend standalone output"
  cp -R "${FRONTEND_DIR}/.next/standalone/." "${stage_dir}/frontend/"
  cp -R "${FRONTEND_DIR}/.next/static" "${stage_dir}/frontend/.next/"
  cp -R "${FRONTEND_DIR}/public" "${stage_dir}/frontend/"

  log "Copying deployment templates"
  cp -R "${DEPLOY_ASSETS_DIR}/templates/." "${stage_dir}/deploy/templates/"
  cp -R "${DEPLOY_ASSETS_DIR}/examples/." "${stage_dir}/deploy/examples/"

  cat > "${stage_dir}/release.json" <<EOF
{
  "release_id": "${release_id}",
  "git_commit": "${git_commit}",
  "git_branch": "${git_branch}",
  "built_at_utc": "${built_at}"
}
EOF

  log "Packing release bundle"
  tar -C "${stage_dir}" -czf "${bundle_path}" .
  printf '%s\n' "${bundle_path}"
}

upload_bundle() {
  local bundle_path="$1"
  local remote_bundle_path="/tmp/$(basename "${bundle_path}")"
  log "Uploading release bundle to ${USER_NAME}@${HOST}:${remote_bundle_path}"
  "${scp_base[@]}" "${bundle_path}" "${USER_NAME}@${HOST}:${remote_bundle_path}"
  printf '%s\n' "${remote_bundle_path}"
}

main() {
  parse_args "$@"

  need_cmd bash
  need_cmd sshpass
  need_cmd ssh
  need_cmd scp
  need_cmd tar
  need_cmd git
  need_cmd node
  need_cmd npm

  if [ ! -f "${REMOTE_HELPER}" ]; then
    err "Missing remote helper: ${REMOTE_HELPER}"
    exit 1
  fi

  setup_ssh
  prepare_build_dirs

  if [ -n "${ROLLBACK_RELEASE}" ]; then
    log "Rolling back remote release to ${ROLLBACK_RELEASE}"
    run_remote_helper
    ok "Rollback completed"
    exit 0
  fi

  build_frontend

  local release_id
  release_id="$(date '+%Y%m%d-%H%M%S')-$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || printf 'nogit')"

  local bundle_path
  bundle_path="$(create_release_bundle "${release_id}")"

  local remote_bundle_path
  remote_bundle_path="$(upload_bundle "${bundle_path}")"

  log "Running remote deployment for release ${release_id}"
  run_remote_helper "${release_id}" "${remote_bundle_path}"

  if [ "${ONLY_UPLOAD}" = "1" ]; then
    ok "Release ${release_id} uploaded and staged on remote host"
  else
    ok "Release ${release_id} deployed successfully"
    printf 'Access URL: http://%s:%s\n' "${HOST}" "${PUBLIC_PORT}"
  fi
}

main "$@"
