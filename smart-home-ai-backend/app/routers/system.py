"""
系统状态路由 - 健康检查 / 系统指标 / Dashboard / 系统设置
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text
from datetime import datetime, timedelta
import asyncio
import platform
import time
import httpx

from app.dependencies import get_db, require_admin
from app.models.user import User
from app.models.system_config import SystemConfig
from app.config import settings
from app.services.ollama import ollama_service
from app.services.homeassistant import ha_service
from app.schemas.settings import (
    SettingsResponse, SettingsUpdate, ServiceConfig, SecurityConfig,
    TestConnectionRequest, TestConnectionResponse, SystemInfoResponse,
)

router = APIRouter(prefix="/system", tags=["系统状态"])

# ── 记录启动时间 ──
_start_time = time.time()


# ══════════════════════════════════════════════
#  Health Check
# ══════════════════════════════════════════════

@router.get("/health", summary="系统健康检查")
async def health():
    return {
        "status": "ok",
        "module": "system",
        "platform": platform.system(),
        "python": platform.python_version(),
    }


# ══════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════

async def _check_service(url: str, timeout: float = 3.0) -> str:
    """检查外部服务是否可达"""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url)
            return "running" if resp.status_code < 500 else "error"
    except Exception:
        return "stopped"


async def _check_service_with_latency(url: str, timeout: float = 5.0) -> tuple[str, int]:
    """检查外部服务，同时返回延迟 ms"""
    try:
        t0 = time.time()
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url)
            latency = int((time.time() - t0) * 1000)
            status = "running" if resp.status_code < 500 else "error"
            return status, latency
    except Exception as e:
        return "stopped", 0


async def _get_model_count() -> int:
    try:
        models = await ollama_service.list_models()
        return len(models) if isinstance(models, list) else 0
    except Exception:
        return 0


async def _get_online_devices() -> int:
    try:
        states = await ha_service.get_states()
        return sum(1 for s in states if s.get("state") not in ("unavailable", "unknown"))
    except Exception:
        return 0


def _mask_token(token: str) -> str:
    """脱敏 token，仅保留末4位"""
    if not token or len(token) <= 4:
        return token
    return "••••••••" + token[-4:]


async def _get_config_value(db: AsyncSession, key: str, default: str = "") -> str:
    """从 system_config 表读取配置，fallback 到 default"""
    result = await db.execute(
        select(SystemConfig.value).where(SystemConfig.key == key)
    )
    row = result.scalar_one_or_none()
    return row if row is not None else default


async def _set_config_value(db: AsyncSession, key: str, value: str):
    """写入或更新 system_config"""
    result = await db.execute(
        select(SystemConfig).where(SystemConfig.key == key)
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.value = value
    else:
        db.add(SystemConfig(key=key, value=value))


# ══════════════════════════════════════════════
#  Dashboard
# ══════════════════════════════════════════════

@router.get("/dashboard", summary="Dashboard 概览数据")
async def dashboard(
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """仪表盘聚合数据"""
    seven_days_ago = datetime.utcnow() - timedelta(days=7)

    total_users = (await db.execute(select(func.count(User.id)))).scalar() or 0
    active_users = (await db.execute(
        select(func.count(User.id)).where(User.is_active == True)  # noqa: E712
    )).scalar() or 0
    new_users = (await db.execute(
        select(func.count(User.id)).where(User.created_at >= seven_days_ago)
    )).scalar() or 0

    model_count, online_devices, ollama_status, ha_status, influxdb_status = await asyncio.gather(
        _get_model_count(),
        _get_online_devices(),
        _check_service(f"{settings.OLLAMA_BASE_URL}/api/tags"),
        _check_service(f"{settings.HA_BASE_URL}/api/"),
        _check_service(f"{settings.INFLUXDB_URL}/health"),
    )

    services = [
        {"name": "FastAPI Backend", "endpoint": "localhost:8000", "uptime": "99.99%", "status": "Running"},
        {"name": "Next.js Frontend", "endpoint": "localhost:3000", "uptime": "99.95%", "status": "Running"},
        {
            "name": "Ollama LLM",
            "endpoint": settings.OLLAMA_BASE_URL.replace("http://", ""),
            "uptime": "98.21%" if ollama_status == "running" else "—",
            "status": "Running" if ollama_status == "running" else "Stopped",
        },
        {
            "name": "Home Assistant",
            "endpoint": settings.HA_BASE_URL.replace("http://", ""),
            "uptime": "100%" if ha_status == "running" else "—",
            "status": "Running" if ha_status == "running" else "Stopped",
        },
        {
            "name": "InfluxDB",
            "endpoint": settings.INFLUXDB_URL.replace("http://", ""),
            "uptime": "99.90%" if influxdb_status == "running" else "—",
            "status": "Syncing" if influxdb_status == "running" else "Stopped",
        },
    ]

    return {
        "stats": {
            "total_users": total_users, "active_users": active_users,
            "new_users": new_users, "online_devices": online_devices,
            "model_count": model_count, "knowledge_count": 0,
        },
        "services": services,
    }


# ══════════════════════════════════════════════
#  Settings CRUD
# ══════════════════════════════════════════════

@router.get("/settings", response_model=SettingsResponse, summary="获取系统配置")
async def get_settings(
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """读取当前系统配置，DB 优先于 .env 默认值"""

    # 读取所有配置 (DB 覆盖 .env)
    ollama_url = await _get_config_value(db, "ollama_base_url", settings.OLLAMA_BASE_URL)
    dify_url = await _get_config_value(db, "dify_base_url", settings.DIFY_BASE_URL)
    dify_key = await _get_config_value(db, "dify_api_key", settings.DIFY_API_KEY)
    ha_url = await _get_config_value(db, "ha_base_url", settings.HA_BASE_URL)
    ha_token = await _get_config_value(db, "ha_token", settings.HA_TOKEN)
    influx_url = await _get_config_value(db, "influxdb_url", settings.INFLUXDB_URL)
    influx_token = await _get_config_value(db, "influxdb_token", settings.INFLUXDB_TOKEN)
    influx_org = await _get_config_value(db, "influxdb_org", settings.INFLUXDB_ORG)
    influx_bucket = await _get_config_value(db, "influxdb_bucket", settings.INFLUXDB_BUCKET)
    jwt_hours = await _get_config_value(db, "jwt_expire_hours", str(settings.ACCESS_TOKEN_EXPIRE_MINUTES // 60))
    allow_reg = await _get_config_value(db, "allow_registration", "true")
    pwd_min = await _get_config_value(db, "password_min_length", "6")

    # 并行检测各服务状态
    ollama_st, dify_st, ha_st, influx_st = await asyncio.gather(
        _check_service(f"{ollama_url}/api/tags"),
        _check_service(f"{dify_url}/v1/datasets", 3.0),
        _check_service(f"{ha_url}/api/"),
        _check_service(f"{influx_url}/health"),
    )

    return SettingsResponse(
        services={
            "ollama": ServiceConfig(url=ollama_url, status=ollama_st),
            "dify": ServiceConfig(url=dify_url, token=_mask_token(dify_key), status=dify_st),
            "homeassistant": ServiceConfig(url=ha_url, token=_mask_token(ha_token), status=ha_st),
            "influxdb": ServiceConfig(
                url=influx_url, token=_mask_token(influx_token), status=influx_st,
                extra={"org": influx_org, "bucket": influx_bucket},
            ),
        },
        security=SecurityConfig(
            jwt_expire_hours=int(jwt_hours),
            allow_registration=allow_reg.lower() in ("true", "1", "yes"),
            password_min_length=int(pwd_min),
        ),
    )


@router.put("/settings", summary="保存系统配置")
async def update_settings(
    body: SettingsUpdate,
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """保存系统配置到 DB，空字段不更新"""
    field_map = {
        "ollama_base_url": body.ollama_base_url,
        "dify_base_url": body.dify_base_url,
        "dify_api_key": body.dify_api_key,
        "ha_base_url": body.ha_base_url,
        "ha_token": body.ha_token,
        "influxdb_url": body.influxdb_url,
        "influxdb_token": body.influxdb_token,
        "influxdb_org": body.influxdb_org,
        "influxdb_bucket": body.influxdb_bucket,
        "jwt_expire_hours": str(body.jwt_expire_hours) if body.jwt_expire_hours is not None else None,
        "allow_registration": str(body.allow_registration).lower() if body.allow_registration is not None else None,
        "password_min_length": str(body.password_min_length) if body.password_min_length is not None else None,
    }

    updated_keys = []
    for key, value in field_map.items():
        if value is not None and value != "":
            await _set_config_value(db, key, value)
            updated_keys.append(key)

    return {"message": "配置已保存", "updated": updated_keys}


# ══════════════════════════════════════════════
#  Connection Test
# ══════════════════════════════════════════════

@router.post("/test-connection", response_model=TestConnectionResponse, summary="测试外部服务连接")
async def test_connection(
    body: TestConnectionRequest,
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """测试指定外部服务的连接状态和延迟"""
    service_urls = {
        "ollama": (await _get_config_value(db, "ollama_base_url", settings.OLLAMA_BASE_URL)) + "/api/tags",
        "dify": (await _get_config_value(db, "dify_base_url", settings.DIFY_BASE_URL)) + "/v1/datasets",
        "homeassistant": (await _get_config_value(db, "ha_base_url", settings.HA_BASE_URL)) + "/api/",
        "influxdb": (await _get_config_value(db, "influxdb_url", settings.INFLUXDB_URL)) + "/health",
    }

    url = service_urls.get(body.service.value, "")
    status, latency = await _check_service_with_latency(url)

    messages = {
        "running": "服务运行正常",
        "stopped": "无法连接到服务，请检查地址和网络",
        "error": "服务返回异常状态码",
    }

    return TestConnectionResponse(
        service=body.service.value,
        status=status,
        message=messages.get(status, "未知状态"),
        latency_ms=latency,
    )


# ══════════════════════════════════════════════
#  System Info
# ══════════════════════════════════════════════

@router.get("/info", response_model=SystemInfoResponse, summary="系统运行信息")
async def system_info(
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """返回系统版本、运行时长、DB 状态等"""
    # DB 连接测试
    try:
        await db.execute(text("SELECT 1"))
        db_status = "connected"
    except Exception:
        db_status = "disconnected"

    uptime = int(time.time() - _start_time)
    days = uptime // 86400
    hours = (uptime % 86400) // 3600
    mins = (uptime % 3600) // 60

    if days > 0:
        uptime_display = f"{days}d {hours}h {mins}m"
    elif hours > 0:
        uptime_display = f"{hours}h {mins}m"
    else:
        uptime_display = f"{mins}m"

    return SystemInfoResponse(
        version="1.0.0",
        python_version=platform.python_version(),
        os_info=f"{platform.system()} {platform.machine()}",
        db_status=db_status,
        uptime_seconds=uptime,
        uptime_display=uptime_display,
        api_docs_url="http://localhost:8000/api/docs",
    )
