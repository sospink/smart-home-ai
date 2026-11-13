#!/bin/bash
#
# 智慧家居 LLM 智能体一体机 · 开发环境管理脚本
# ─────────────────────────────────────────────
# 用法:
#   ./start.sh              启动前后端（前台模式，Ctrl+C 退出全部）
#   ./start.sh -d           后台模式启动
#   ./start.sh stop         停止所有服务（按端口杀，稳定可靠）
#   ./start.sh restart      重启
#   ./start.sh status       查看状态
#   ./start.sh logs         跟踪日志
#   ./start.sh logs backend 只看后端日志
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/smart-home-ai-backend"
FRONTEND_DIR="$SCRIPT_DIR/smart-home-ai-frontend"
LOG_DIR="$SCRIPT_DIR/.logs"

BACKEND_PORT=8000
FRONTEND_PORT=8088

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

log()   { echo -e "${CYAN}[Smart Home]${NC} $1"; }
ok()    { echo -e "${GREEN}  ✅ $1${NC}"; }
warn()  { echo -e "${YELLOW}  ⚠️  $1${NC}"; }
err()   { echo -e "${RED}  ❌ $1${NC}"; }

read_backend_env_value() {
    local key=$1 fallback=$2 value=""
    if [[ -f "$BACKEND_DIR/.env" ]]; then
        value=$(awk -F= -v target="$key" '$1 == target {sub(/^[^=]*=/, ""); print; exit}' "$BACKEND_DIR/.env")
        value=${value%$'\r'}
        value=${value#\"}
        value=${value%\"}
    fi
    printf '%s' "${value:-$fallback}"
}

read_runtime_service_urls() {
    if [[ ! -x "$BACKEND_DIR/venv/bin/python" ]]; then
        return 1
    fi

    (
        cd "$BACKEND_DIR"
        ./venv/bin/python - <<'PY'
import asyncio

from app.database import AsyncSessionLocal, engine
from app.services.runtime_settings import get_runtime_config


async def main():
    try:
        async with AsyncSessionLocal() as db:
            runtime = await get_runtime_config(db)
            print(f"DIFY_BASE_URL={runtime.dify_base_url}")
            print(f"HA_BASE_URL={runtime.ha_base_url}")
            print(f"INFLUXDB_URL={runtime.influxdb_url}")
            print(f"CONFIG_SOURCE={runtime.config_source}")
    finally:
        await engine.dispose()


asyncio.run(main())
PY
    ) 2>/dev/null
}

print_http_status() {
    local name=$1 url=$2
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$url" || true)

    case "$status" in
        200|201|204|401|403)
            ok "$name 可达  →  ${CYAN}$url${NC}  (HTTP $status)"
            ;;
        000|"")
            warn "$name 未连接  →  ${CYAN}$url${NC}"
            ;;
        *)
            warn "$name 响应异常  →  ${CYAN}$url${NC}  (HTTP $status)"
            ;;
    esac
}

format_listener_processes() {
    local pids=$1
    local worker_pids="" supervisor_pids="" pid other_pid

    for pid in $pids; do
        local is_supervisor=false
        for other_pid in $pids; do
            [[ "$pid" == "$other_pid" ]] && continue
            if [[ "$(ps -o ppid= -p "$other_pid" 2>/dev/null | tr -d ' ')" == "$pid" ]]; then
                is_supervisor=true
                break
            fi
        done
        if [[ "$is_supervisor" == true ]]; then
            supervisor_pids="${supervisor_pids}${supervisor_pids:+,}$pid"
        else
            worker_pids="${worker_pids}${worker_pids:+,}$pid"
        fi
    done

    if [[ -n "$supervisor_pids" && -n "$worker_pids" ]]; then
        printf '工作 PID:%s（热重载监控 PID:%s）' "$worker_pids" "$supervisor_pids"
    else
        printf '监听 PID:%s' "$(printf '%s\n' $pids | sort -nu | paste -sd, -)"
    fi
}

build_dev_cors_origins() {
    local ips
    ips=$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -Ev '^(127\.|169\.254\.)' | sort -u || true)

    LOCAL_IPS="$ips" FRONTEND_PORT="$FRONTEND_PORT" python3 <<'PY'
import json
import os

frontend_port = os.environ.get("FRONTEND_PORT", "8088")
ips = [ip for ip in os.environ.get("LOCAL_IPS", "").split() if ip]

origins = {
    "http://localhost:3000",
    f"http://localhost:{frontend_port}",
    "http://127.0.0.1:3000",
    f"http://127.0.0.1:{frontend_port}",
}

for ip in ips:
    origins.add(f"http://{ip}:3000")
    origins.add(f"http://{ip}:{frontend_port}")

print(json.dumps(sorted(origins), ensure_ascii=False))
PY
}

wait_for_http_ready() {
    local url=$1
    local attempts=${2:-20}
    local timeout=${3:-3}

    for _ in $(seq 1 "$attempts"); do
        if curl -fsS --max-time "$timeout" "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done

    return 1
}

launch_detached() {
    local workdir=$1
    local logfile=$2
    local command=$3

    WORKDIR="$workdir" LOGFILE="$logfile" COMMAND="$command" python3 <<'PY'
import os
import subprocess

log = open(os.environ["LOGFILE"], "w")
process = subprocess.Popen(
    ["bash", "-lc", os.environ["COMMAND"]],
    cwd=os.environ["WORKDIR"],
    stdout=log,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    close_fds=True,
)
print(process.pid)
PY
}

# ══════════════════════════════════════════════
#  按端口杀进程（最可靠的方式）
# ══════════════════════════════════════════════
kill_port() {
    local port=$1 name=$2
    local pids
    pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -nu || true)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
        ok "$name 已停止 (port $port)"
    fi
}

# ══════════════════════════════════════════════
#  STOP
# ══════════════════════════════════════════════
stop_services() {
    log "正在停止服务..."
    kill_port $BACKEND_PORT  "后端 FastAPI"
    kill_port $FRONTEND_PORT "前端 Next.js"
    # 清理端口迁移前可能残留的旧开发服务。
    kill_port 3100 "Next.js (legacy 3100)" 2>/dev/null
    kill_port 3000 "Next.js (3000)" 2>/dev/null
    log "全部停止 ✓"
}

# ══════════════════════════════════════════════
#  STATUS
# ══════════════════════════════════════════════
check_status() {
    echo ""
    log "服务状态:"

    # 后端
    local backend_pids frontend_pids
    backend_pids=$(lsof -tiTCP:"$BACKEND_PORT" -sTCP:LISTEN 2>/dev/null | sort -nu || true)
    frontend_pids=$(lsof -tiTCP:"$FRONTEND_PORT" -sTCP:LISTEN 2>/dev/null | sort -nu || true)

    if [[ -n "$backend_pids" ]]; then
        ok "后端运行中  $(format_listener_processes "$backend_pids")  →  ${CYAN}http://localhost:$BACKEND_PORT${NC}"
    else
        err "后端未运行 (port $BACKEND_PORT)"
    fi

    # 前端
    if [[ -n "$frontend_pids" ]]; then
        ok "前端运行中  $(format_listener_processes "$frontend_pids")  →  ${CYAN}http://localhost:$FRONTEND_PORT${NC}"
    else
        err "前端未运行 (port $FRONTEND_PORT)"
    fi

    # Ollama
    if curl -sf http://localhost:11434/api/version &>/dev/null; then
        local ver
        ver=$(curl -sf http://localhost:11434/api/version | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
        ok "Ollama 运行中  v$ver  →  ${CYAN}http://localhost:11434${NC}"
    else
        warn "Ollama 未运行 (port 11434)"
    fi

    local dify_base_url ha_base_url influxdb_url config_source runtime_urls
    runtime_urls=$(read_runtime_service_urls || true)
    dify_base_url=$(printf '%s\n' "$runtime_urls" | awk -F= '$1 == "DIFY_BASE_URL" {sub(/^[^=]*=/, ""); print; exit}')
    ha_base_url=$(printf '%s\n' "$runtime_urls" | awk -F= '$1 == "HA_BASE_URL" {sub(/^[^=]*=/, ""); print; exit}')
    influxdb_url=$(printf '%s\n' "$runtime_urls" | awk -F= '$1 == "INFLUXDB_URL" {sub(/^[^=]*=/, ""); print; exit}')
    config_source=$(printf '%s\n' "$runtime_urls" | awk -F= '$1 == "CONFIG_SOURCE" {sub(/^[^=]*=/, ""); print; exit}')

    dify_base_url=${dify_base_url:-$(read_backend_env_value "DIFY_BASE_URL" "http://192.168.34.190")}
    ha_base_url=${ha_base_url:-$(read_backend_env_value "HA_BASE_URL" "http://192.168.34.190:8123")}
    influxdb_url=${influxdb_url:-$(read_backend_env_value "INFLUXDB_URL" "http://localhost:8086")}

    if [[ "$config_source" == "database_overrides" ]]; then
        echo -e "${DIM}  外部服务地址来源：数据库运行时配置${NC}"
    elif [[ -n "$runtime_urls" ]]; then
        echo -e "${DIM}  外部服务地址来源：默认配置${NC}"
    else
        echo -e "${DIM}  外部服务地址来源：.env / 启动兜底（数据库配置读取失败）${NC}"
    fi
    print_http_status "Dify" "${dify_base_url%/}/v1/datasets"
    # HA 的 /api/ 需要认证，无 Token 探测会污染其安全日志；首页足以判断 Web 服务可达性。
    print_http_status "Home Assistant" "${ha_base_url%/}/"
    print_http_status "InfluxDB" "${influxdb_url%/}/health"

    echo ""
}

# ══════════════════════════════════════════════
#  START
# ══════════════════════════════════════════════
start_services() {
    local daemon_mode="${1:-}"
    local dev_cors_origins

    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   智慧家居 LLM 智能体一体机 · 开发环境   ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""

    # 先清理残留
    stop_services 2>/dev/null

    mkdir -p "$LOG_DIR"
    dev_cors_origins=$(build_dev_cors_origins)

    # ── 后端 ──
    log "启动后端 (FastAPI + uvicorn --reload)..."
    if [ ! -d "$BACKEND_DIR/venv" ]; then
        warn "未找到 venv，正在创建..."
        python3 -m venv "$BACKEND_DIR/venv"
        source "$BACKEND_DIR/venv/bin/activate"
        pip install -r "$BACKEND_DIR/requirements.txt" -q
    fi

    local backend_command
    backend_command="
        source '$BACKEND_DIR/venv/bin/activate'
        export CORS_ORIGINS='$dev_cors_origins'
        exec uvicorn app.main:app \
            --host 0.0.0.0 \
            --port $BACKEND_PORT \
            --reload \
            --reload-dir app
    "
    local be_pid
    if [ "$daemon_mode" = "-d" ]; then
        be_pid=$(launch_detached "$BACKEND_DIR" "$LOG_DIR/backend.log" "$backend_command")
    else
        # 用 bash -c 包装，防止 source activate 影响当前 shell
        nohup bash -c "cd '$BACKEND_DIR'; $backend_command" > "$LOG_DIR/backend.log" 2>&1 &
        be_pid=$!
    fi
    sleep 1

    if kill -0 $be_pid 2>/dev/null; then
        ok "后端已启动  PID:$be_pid  port:$BACKEND_PORT"
        ok "开发环境 CORS 已放行当前本机/局域网来源"
    else
        err "后端启动失败！查看日志: tail $LOG_DIR/backend.log"
        tail -5 "$LOG_DIR/backend.log" 2>/dev/null
        exit 1
    fi

    # ── 前端 ──
    log "启动前端 (Next.js webpack dev server)..."
    if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
        warn "未找到 node_modules，正在安装..."
        (cd "$FRONTEND_DIR" && npm install -q)
    fi

    local frontend_command
    frontend_command="
        exec npx next dev --port $FRONTEND_PORT --webpack
    "
    local fe_pid
    if [ "$daemon_mode" = "-d" ]; then
        fe_pid=$(launch_detached "$FRONTEND_DIR" "$LOG_DIR/frontend.log" "$frontend_command")
    else
        nohup bash -c "cd '$FRONTEND_DIR'; $frontend_command" > "$LOG_DIR/frontend.log" 2>&1 &
        fe_pid=$!
    fi
    sleep 2

    if kill -0 $fe_pid 2>/dev/null; then
        ok "前端已启动  PID:$fe_pid  port:$FRONTEND_PORT"
    else
        err "前端启动失败！查看日志: tail $LOG_DIR/frontend.log"
        tail -5 "$LOG_DIR/frontend.log" 2>/dev/null
        exit 1
    fi

    # ── 等待就绪 ──
    log "等待服务就绪..."
    for i in $(seq 1 15); do
        if ! kill -0 $be_pid 2>/dev/null; then
            err "后端进程在就绪前退出！最近日志："
            tail -20 "$LOG_DIR/backend.log" 2>/dev/null || true
            exit 1
        fi
        if ! kill -0 $fe_pid 2>/dev/null; then
            err "前端进程在就绪前退出！最近日志："
            tail -20 "$LOG_DIR/frontend.log" 2>/dev/null || true
            exit 1
        fi
        if curl -sf "http://localhost:$BACKEND_PORT/api/v1/system/health" &>/dev/null; then
            break
        fi
        sleep 1
    done

    if ! wait_for_http_ready "http://localhost:$BACKEND_PORT/api/v1/system/health" 5 3; then
        err "后端健康检查超时！最近日志："
        tail -20 "$LOG_DIR/backend.log" 2>/dev/null || true
        exit 1
    fi

    if ! wait_for_http_ready "http://localhost:$FRONTEND_PORT/home" 30 5; then
        err "前端健康检查超时！最近日志："
        tail -40 "$LOG_DIR/frontend.log" 2>/dev/null || true
        exit 1
    fi

    echo ""
    echo -e "${GREEN}════════════════════════════════════════════${NC}"
    echo -e "  🌐 前端页面    ${CYAN}http://localhost:$FRONTEND_PORT${NC}"
    echo -e "  📡 后端 API    ${CYAN}http://localhost:$BACKEND_PORT${NC}"
    echo -e "  📖 Swagger     ${CYAN}http://localhost:$BACKEND_PORT/api/docs${NC}"
    echo -e "${GREEN}════════════════════════════════════════════${NC}"
    echo -e "  登录账号: ${YELLOW}请使用管理员分配的账号${NC}"
    echo -e "  忘记密码: ${DIM}按需执行 ./reset-admin-password.sh 后立即修改${NC}"
    echo ""
    echo -e "  日志: ${DIM}./start.sh logs${NC}"
    echo -e "  停止: ${DIM}./start.sh stop${NC}"
    echo ""

    # 前台模式：trap Ctrl+C 清理，tail 跟踪日志
    if [ "$daemon_mode" != "-d" ]; then
        trap 'echo ""; stop_services; exit 0' INT TERM
        log "前台模式运行中 (Ctrl+C 停止所有服务)"
        echo ""
        tail -f "$LOG_DIR/backend.log" "$LOG_DIR/frontend.log" &
        local tail_pid=$!
        # 等待任一子进程退出
        wait $be_pid $fe_pid 2>/dev/null || true
        kill $tail_pid 2>/dev/null || true
        warn "服务已退出"
        stop_services
    fi
}

# ══════════════════════════════════════════════
#  LOGS
# ══════════════════════════════════════════════
show_logs() {
    local target="${1:-all}"
    mkdir -p "$LOG_DIR"
    case "$target" in
        backend|be)
            tail -f "$LOG_DIR/backend.log"
            ;;
        frontend|fe)
            tail -f "$LOG_DIR/frontend.log"
            ;;
        *)
            tail -f "$LOG_DIR/backend.log" "$LOG_DIR/frontend.log"
            ;;
    esac
}

# ══════════════════════════════════════════════
#  主入口
# ══════════════════════════════════════════════
case "${1:-start}" in
    start)   start_services "${2:-}" ;;
    stop)    stop_services ;;
    restart) stop_services; sleep 1; start_services "${2:-}" ;;
    status)  check_status ;;
    logs)    show_logs "${2:-all}" ;;
    -d)      start_services -d ;;
    *)
        echo "用法: $0 {start|stop|restart|status|logs [backend|frontend]}"
        echo ""
        echo "  start         前台启动 (Ctrl+C 退出)"
        echo "  start -d      后台启动"
        echo "  stop          停止所有服务"
        echo "  restart       重启"
        echo "  status        查看状态"
        echo "  logs          跟踪日志"
        echo "  logs backend  只看后端日志"
        exit 1
        ;;
esac
