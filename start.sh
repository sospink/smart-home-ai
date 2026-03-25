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
FRONTEND_PORT=3100

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

# ══════════════════════════════════════════════
#  按端口杀进程（最可靠的方式）
# ══════════════════════════════════════════════
kill_port() {
    local port=$1 name=$2
    local pids
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
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
    # 也清理可能残留的 3000 端口
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
    if lsof -ti:$BACKEND_PORT &>/dev/null; then
        local be_pid
        be_pid=$(lsof -ti:$BACKEND_PORT | head -1)
        ok "后端运行中  PID:$be_pid  →  ${CYAN}http://localhost:$BACKEND_PORT${NC}"
    else
        err "后端未运行 (port $BACKEND_PORT)"
    fi

    # 前端
    if lsof -ti:$FRONTEND_PORT &>/dev/null; then
        local fe_pid
        fe_pid=$(lsof -ti:$FRONTEND_PORT | head -1)
        ok "前端运行中  PID:$fe_pid  →  ${CYAN}http://localhost:$FRONTEND_PORT${NC}"
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

    echo ""
}

# ══════════════════════════════════════════════
#  START
# ══════════════════════════════════════════════
start_services() {
    local daemon_mode="${1:-}"

    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   智慧家居 LLM 智能体一体机 · 开发环境   ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""

    # 先清理残留
    stop_services 2>/dev/null

    mkdir -p "$LOG_DIR"

    # ── 后端 ──
    log "启动后端 (FastAPI + uvicorn --reload)..."
    if [ ! -d "$BACKEND_DIR/venv" ]; then
        warn "未找到 venv，正在创建..."
        python3 -m venv "$BACKEND_DIR/venv"
        source "$BACKEND_DIR/venv/bin/activate"
        pip install -r "$BACKEND_DIR/requirements.txt" -q
    fi

    # 用 bash -c 包装，防止 source activate 影响当前 shell
    bash -c "
        source '$BACKEND_DIR/venv/bin/activate'
        cd '$BACKEND_DIR'
        exec uvicorn app.main:app \
            --host 0.0.0.0 \
            --port $BACKEND_PORT \
            --reload \
            --reload-dir app
    " > "$LOG_DIR/backend.log" 2>&1 &
    local be_pid=$!
    sleep 1

    if kill -0 $be_pid 2>/dev/null; then
        ok "后端已启动  PID:$be_pid  port:$BACKEND_PORT"
    else
        err "后端启动失败！查看日志: tail $LOG_DIR/backend.log"
        tail -5 "$LOG_DIR/backend.log" 2>/dev/null
        exit 1
    fi

    # ── 前端 ──
    log "启动前端 (Next.js Turbopack)..."
    if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
        warn "未找到 node_modules，正在安装..."
        (cd "$FRONTEND_DIR" && npm install -q)
    fi

    bash -c "
        cd '$FRONTEND_DIR'
        exec npx next dev --port $FRONTEND_PORT --turbopack
    " > "$LOG_DIR/frontend.log" 2>&1 &
    local fe_pid=$!
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
        if curl -sf "http://localhost:$BACKEND_PORT/api/v1/system/health" &>/dev/null; then
            break
        fi
        sleep 1
    done

    echo ""
    echo -e "${GREEN}════════════════════════════════════════════${NC}"
    echo -e "  🌐 前端页面    ${CYAN}http://localhost:$FRONTEND_PORT${NC}"
    echo -e "  📡 后端 API    ${CYAN}http://localhost:$BACKEND_PORT${NC}"
    echo -e "  📖 Swagger     ${CYAN}http://localhost:$BACKEND_PORT/api/docs${NC}"
    echo -e "${GREEN}════════════════════════════════════════════${NC}"
    echo -e "  测试账号: ${YELLOW}admin${NC} / ${YELLOW}123456${NC}"
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
