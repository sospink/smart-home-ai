"""
智慧家居 LLM 智能体一体机 · Web 管理平台后端 (FastAPI BFF)
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.routers import (
    auth,
    chat,
    devices,
    states,
    knowledge,
    models_router,
    sandbox,
    system,
    users,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期 - 启动/关闭时的资源管理"""
    # 启动时
    print("🚀 Smart Home AI Backend starting...")
    yield
    # 关闭时
    print("👋 Smart Home AI Backend shutting down...")


app = FastAPI(
    title="智慧家居 LLM 智能体一体机 API",
    description="Web 管理平台后端 BFF 接口，统一认证(JWT)、设备控制、AI 对话、知识库管理",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# ── CORS ──
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 注册路由 ──
app.include_router(auth.router, prefix="/api/v1")
app.include_router(chat.router, prefix="/api/v1")
app.include_router(devices.router, prefix="/api/v1")
app.include_router(states.router, prefix="/api/v1")
app.include_router(knowledge.router, prefix="/api/v1")
app.include_router(models_router.router, prefix="/api/v1")
app.include_router(sandbox.router, prefix="/api/v1")
app.include_router(system.router, prefix="/api/v1")
app.include_router(users.router, prefix="/api/v1")


@app.get("/", tags=["根"])
async def root():
    return {
        "name": "智慧家居 LLM 智能体一体机 API",
        "version": "1.0.0",
        "docs": "/api/docs",
    }
