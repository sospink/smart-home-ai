"""
智慧家居 LLM 智能体一体机 · Web 管理平台后端 (FastAPI BFF)
"""
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from app.config import settings
from app.database import Base, engine
from app.routers import (
    agents,
    api_docs,
    auth,
    chat,
    devices,
    monitor,
    states,
    knowledge,
    models_router,
    sandbox,
    system,
    time_series,
    users,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期 - 启动/关闭时的资源管理"""
    # 启动时
    print("🚀 Smart Home AI Backend starting...")
    import app.models  # noqa: F401
    from app.models.api_doc_endpoint import ApiDocEndpoint
    from app.models.api_doc_module import ApiDocModule
    from app.models.api_doc_source_meta import ApiDocSourceMeta
    from app.models.agent_instance import AgentInstance
    from app.models.agent_template_library import AgentTemplateLibrary
    from app.models.device_management import DeviceEntityMapping, DeviceGateway, ManagedDevice
    from app.models.model_catalog_snapshot import ModelCatalogSnapshot
    from app.models.model_pull_task import ModelPullTask
    from app.models.operation_log import OperationLog

    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[
                AgentInstance.__table__,
                AgentTemplateLibrary.__table__,
                DeviceGateway.__table__,
                ManagedDevice.__table__,
                DeviceEntityMapping.__table__,
                ApiDocModule.__table__,
                ApiDocEndpoint.__table__,
                ApiDocSourceMeta.__table__,
                OperationLog.__table__,
                ModelCatalogSnapshot.__table__,
                ModelPullTask.__table__,
            ],
        )
        dialect = conn.dialect.name
        if dialect == "mysql":
            for statement in [
                "ALTER TABLE agent_instances ADD COLUMN dify_api_key VARCHAR(255) NOT NULL DEFAULT ''",
                "ALTER TABLE agent_instances ADD COLUMN is_default BOOL NOT NULL DEFAULT 0",
                "ALTER TABLE model_catalog_snapshots MODIFY payload_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL",
                "ALTER TABLE model_catalog_snapshots MODIFY error TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
            ]:
                try:
                    await conn.execute(text(statement))
                except Exception:
                    pass
        elif dialect == "sqlite":
            for statement in [
                "ALTER TABLE agent_instances ADD COLUMN dify_api_key VARCHAR(255) NOT NULL DEFAULT ''",
                "ALTER TABLE agent_instances ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT 0",
            ]:
                try:
                    await conn.execute(text(statement))
                except Exception:
                    pass
    from app.services.model_pull_tasks import mark_interrupted_tasks
    await mark_interrupted_tasks()
    collector_task = asyncio.create_task(time_series.run_periodic_collector())
    log_retention_task = asyncio.create_task(monitor.run_operation_log_retention())
    try:
        yield
    finally:
        collector_task.cancel()
        log_retention_task.cancel()
        for task in (collector_task, log_retention_task):
            try:
                await task
            except asyncio.CancelledError:
                pass
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
app.include_router(agents.router, prefix="/api/v1")
app.include_router(api_docs.router, prefix="/api/v1")
app.include_router(chat.router, prefix="/api/v1")
app.include_router(devices.router, prefix="/api/v1")
app.include_router(monitor.router, prefix="/api/v1")
app.include_router(states.router, prefix="/api/v1")
app.include_router(knowledge.router, prefix="/api/v1")
app.include_router(models_router.router, prefix="/api/v1")
app.include_router(sandbox.router, prefix="/api/v1")
app.include_router(system.router, prefix="/api/v1")
app.include_router(time_series.router, prefix="/api/v1")
app.include_router(users.router, prefix="/api/v1")


@app.get("/", tags=["根"])
async def root():
    return {
        "name": "智慧家居 LLM 智能体一体机 API",
        "version": "1.0.0",
        "docs": "/api/docs",
    }
