#!/bin/bash
#
# 智慧家居 LLM 智能体一体机 · 一键启动前后端
# 用法: ./start.sh        启动前后端
#       ./start.sh stop   停止前后端
#       ./start.sh status 查看状态
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/smart-home-ai-backend"
FRONTEND_DIR="$SCRIPT_DIR/smart-home-ai-frontend"
BACKEND_PID_FILE="$SCRIPT_DIR/.backend.pid"
FRONTEND_PID_FILE="$SCRIPT_DIR/.frontend.pid"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${CYAN}[Smart Home]${NC} $1"; }
ok()    { echo -e "${GREEN}  ✅ $1${NC}"; }
warn()  { echo -e "${YELLOW}  ⚠️  $1${NC}"; }
err()   { echo -e "${RED}  ❌ $1${NC}"; }

stop_services() {
    log "正在停止服务..."
    if [ -f "$BACKEND_PID_FILE" ]; then
        kill $(cat "$BACKEND_PID_FILE") 2>/dev/null && ok "后端已停止" || warn "后端进程不存在"
        rm -f "$BACKEND_PID_FILE"
    fi
    if [ -f "$FRONTEND_PID_FILE" ]; then
        kill $(cat "$FRONTEND_PID_FILE") 2>/dev/null && ok "前端已停止" || warn "前端进程不存在"
        rm -f "$FRONTEND_PID_FILE"
    fi
}

check_status() {
    echo ""
    log "服务状态:"
    if [ -f "$BACKEND_PID_FILE" ] && kill -0 $(cat "$BACKEND_PID_FILE") 2>/dev/null; then
        ok "后端运行中 (PID: $(cat "$BACKEND_PID_FILE"))  →  http://localhost:8000"
    else
        err "后端未运行"
    fi
    if [ -f "$FRONTEND_PID_FILE" ] && kill -0 $(cat "$FRONTEND_PID_FILE") 2>/dev/null; then
        ok "前端运行中 (PID: $(cat "$FRONTEND_PID_FILE"))  →  http://localhost:3100"
    else
        err "前端未运行"
    fi
    echo ""
}

start_services() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   智慧家居 LLM 智能体一体机 · 开发环境   ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""

    # 先停掉可能残留的旧进程
    stop_services 2>/dev/null

    # ── 启动后端 ──
    log "启动后端 (FastAPI)..."
    if [ ! -d "$BACKEND_DIR/venv" ]; then
        warn "未找到 venv，正在创建..."
        python3 -m venv "$BACKEND_DIR/venv"
        source "$BACKEND_DIR/venv/bin/activate"
        pip install -r "$BACKEND_DIR/requirements.txt" -q
    fi
    source "$BACKEND_DIR/venv/bin/activate"
    cd "$BACKEND_DIR"
    uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload > "$SCRIPT_DIR/.backend.log" 2>&1 &
    echo $! > "$BACKEND_PID_FILE"
    ok "后端已启动 (PID: $!)"

    # ── 启动前端 ──
    log "启动前端 (Next.js)..."
    cd "$FRONTEND_DIR"
    if [ ! -d "node_modules" ]; then
        warn "未找到 node_modules，正在安装依赖..."
        npm install -q
    fi
    npm run dev -- -p 3100 > "$SCRIPT_DIR/.frontend.log" 2>&1 &
    echo $! > "$FRONTEND_PID_FILE"
    ok "前端已启动 (PID: $!)"

    # ── 等待服务就绪 ──
    log "等待服务就绪..."
    sleep 3

    echo ""
    echo -e "${GREEN}════════════════════════════════════════════${NC}"
    echo -e "  🌐 前端页面    ${CYAN}http://localhost:3100${NC}"
    echo -e "  🔑 登录页      ${CYAN}http://localhost:3100/login${NC}"
    echo -e "  📡 后端 API    ${CYAN}http://localhost:8000${NC}"
    echo -e "  📖 Swagger     ${CYAN}http://localhost:8000/api/docs${NC}"
    echo -e "${GREEN}════════════════════════════════════════════${NC}"
    echo -e "  测试账号: ${YELLOW}admin${NC} / ${YELLOW}123456${NC}"
    echo ""
    echo -e "  日志: tail -f $SCRIPT_DIR/.backend.log"
    echo -e "        tail -f $SCRIPT_DIR/.frontend.log"
    echo -e "  停止: ${CYAN}./start.sh stop${NC}"
    echo ""
}

# ── 主入口 ──
case "${1:-start}" in
    start)   start_services ;;
    stop)    stop_services ;;
    status)  check_status ;;
    restart) stop_services; sleep 1; start_services ;;
    *)
        echo "用法: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
