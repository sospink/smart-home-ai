#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

usage() {
  cat <<EOF
用法：
  CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env $0 [--skip-build]

复用 scripts/deploy-cloud.sh 将当前代码发布到目标服务器。
注意：现有 deploy-cloud.sh 走 sshpass 密码发布，因此 TARGET_SSH_PASSWORD 必须填写。
EOF
}

SKIP_BUILD=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD="--skip-build"
      shift
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

[ -n "${TARGET_HOST:-}" ] || die "TARGET_HOST 不能为空"
[ -n "${TARGET_SSH_PASSWORD:-}" ] || die "TARGET_SSH_PASSWORD 不能为空；现有 deploy-cloud.sh 需要 sshpass 密码发布。"

cd "${ROOT_DIR}"
SMART_HOME_DEPLOY_PASSWORD="${TARGET_SSH_PASSWORD}" ./scripts/deploy-cloud.sh \
  --host "${TARGET_HOST}" \
  --user "${TARGET_USER}" \
  --remote-root "${TARGET_APP_ROOT}" \
  --public-port "${TARGET_PUBLIC_PORT}" \
  --frontend-port 3100 \
  --backend-port 8000 \
  ${SKIP_BUILD}

