"""
系统状态路由 - 健康检查 / 系统指标 / Dashboard / 系统设置
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text
from sqlalchemy.orm import selectinload
from datetime import datetime, timedelta
import asyncio
import platform
import time
import httpx

from app.dependencies import get_db, get_current_user, require_admin
from app.models.operation_log import OperationLog
from app.models.device_management import ManagedDevice
from app.models.user import User
from app.models.system_config import SystemConfig
from app.config import settings
from app.services.runtime_settings import (
    APP_VERSION,
    API_DOCS_URL,
    get_config_source_label,
    get_runtime_config,
    get_runtime_services,
)
from app.services.agent_framework import DEFAULT_AGENT_BUSINESS_NAME
from app.services.log_display import SERVICE_DISPLAY_NAMES, business_log_title, business_log_type
from app.services.system_summary_cache import (
    get_system_summary_generation,
    invalidate_system_summary,
)
from app.schemas.settings import (
    SettingsResponse, SettingsUpdate, ServiceConfig, SecurityConfig,
    TestConnectionRequest, TestConnectionResponse, SystemInfoResponse,
    SettingsActionResponse, SettingsHistoryItem, SettingsHistoryPage,
    SettingsResetRequest, SettingsStatusResponse,
)

router = APIRouter(prefix="/system", tags=["系统状态"])

# ── 记录启动时间 ──
_start_time = time.time()

SETTINGS_KEYS = {
    "ollama_base_url", "dify_base_url", "dify_api_key", "dify_dataset_api_key",
    "ha_base_url", "ha_token", "influxdb_url", "influxdb_token", "influxdb_org",
    "influxdb_bucket", "jwt_expire_hours", "allow_registration", "password_min_length",
}
SECRET_SETTINGS_KEYS = {
    "dify_api_key", "dify_dataset_api_key", "ha_token", "influxdb_token",
}
SETTINGS_STATUS_TTL_SECONDS = 30
_settings_status_cache: dict[str, object] = {"expires_at": 0.0, "value": None}
PUBLIC_SUMMARY_TTL_SECONDS = 30
_public_summary_cache: dict[str, object] = {"expires_at": 0.0, "value": None}
_public_summary_lock = asyncio.Lock()

# ══════════════════════════════════════════════
#  Health Check
# ══════════════════════════════════════════════

@router.get("/health", summary="系统健康检查")
async def health():
    return {
        "status": "ok",
        "module": "system",
    }


# ══════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════

async def _check_service(url: str, headers: dict | None = None, timeout: float = 3.0) -> str:
    """检查外部服务是否可达"""
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.get(url, headers=headers or {})
            return "running" if 200 <= resp.status_code < 300 else "error"
    except Exception:
        return "stopped"


async def _check_service_with_latency(url: str, headers: dict | None = None, timeout: float = 5.0) -> tuple[str, int]:
    """检查外部服务，同时返回延迟 ms"""
    try:
        t0 = time.time()
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.get(url, headers=headers or {})
            latency = int((time.time() - t0) * 1000)
            status = "running" if 200 <= resp.status_code < 300 else "error"
            return status, latency
    except Exception as e:
        return "stopped", 0


async def _check_influx_bucket(
    base_url: str,
    token: str,
    org: str,
    bucket: str,
    timeout: float = 5.0,
) -> tuple[str, int, str]:
    """验证草稿指向的精确存储桶，避免把空查询的 HTTP 200 误判为可用。"""
    try:
        started_at = time.time()
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            response = await client.get(
                f"{base_url}/api/v2/buckets",
                params={"org": org, "name": bucket},
                headers={"Authorization": f"Token {token}"},
            )
        latency = int((time.time() - started_at) * 1000)
        if not 200 <= response.status_code < 300:
            return "error", latency, "InfluxDB Token 鉴权失败，或无目标存储桶查询权限"
        payload = response.json()
        buckets = payload.get("buckets", []) if isinstance(payload, dict) else []
        if not any(isinstance(item, dict) and item.get("name") == bucket for item in buckets):
            return "error", latency, f"目标存储桶 {bucket} 不存在，或当前 Token 不可见"
        return "running", latency, "服务运行正常"
    except (httpx.HTTPError, ValueError, TypeError):
        return "stopped", 0, "无法连接到 InfluxDB，或存储桶响应格式异常"


async def _load_runtime_value(loader, timeout: float) -> dict:
    """执行外部系统读取，失败时保留未知状态，避免用 0 冒充真实结果。"""
    started_at = time.perf_counter()
    try:
        value = await asyncio.wait_for(loader(), timeout=timeout)
        return {
            "status": "running",
            "latency_ms": round((time.perf_counter() - started_at) * 1000),
            "value": value,
            "error": "",
        }
    except Exception as exc:
        return {
            "status": "stopped",
            "latency_ms": 0,
            "value": None,
            "error": _runtime_error_message(exc),
        }


def _runtime_error_message(exc: Exception) -> str:
    raw = (str(exc).strip() or exc.__class__.__name__)[:240]
    lowered = raw.lower()
    if "401" in lowered or "403" in lowered or "unauthorized" in lowered or "forbidden" in lowered:
        return "认证失败，请检查访问凭证和接口权限"
    if "404" in lowered or "not found" in lowered:
        return "接口不存在，请检查服务地址和版本"
    if "timeout" in lowered or "timed out" in lowered:
        return "连接超时，请检查服务状态和网络链路"
    if "server disconnected" in lowered or "connection reset" in lowered:
        return "服务在响应前断开连接，请检查服务日志"
    if "connection" in lowered or "connecterror" in lowered or "network" in lowered:
        return "无法建立连接，请检查服务是否启动和地址是否正确"
    return f"连接检查失败：{raw}" if raw else "连接检查失败，服务未返回诊断信息"


def _format_process_uptime(seconds: int) -> str:
    if seconds < 60:
        return "启动未满 1 分钟"
    hours, remainder = divmod(seconds, 3600)
    minutes = remainder // 60
    if hours:
        return f"已连续运行 {hours} 小时 {minutes} 分钟"
    return f"已连续运行 {minutes} 分钟"


def _managed_device_stats(
    devices: list[ManagedDevice],
    states: list[dict] | None,
) -> tuple[int, int | None]:
    """按平台设备台账统计设备，不把 HA 的全部辅助实体计作设备。"""
    enabled_devices = [device for device in devices if device.enabled]
    if states is None:
        return len(enabled_devices), None
    state_map = {
        str(item.get("entity_id") or ""): str(item.get("state") or "unknown")
        for item in states
    }
    online = sum(
        1
        for device in enabled_devices
        if any(
            state_map.get(mapping.endpoint, "unknown") not in {"unknown", "unavailable"}
            for mapping in device.mappings
            if mapping.gateway_type == "homeassistant" and mapping.endpoint
        )
    )
    return len(enabled_devices), online


def _dataset_total(payload: dict | None) -> int | None:
    if not isinstance(payload, dict):
        return None
    total = payload.get("total")
    if isinstance(total, (int, float)):
        return int(total)
    data = payload.get("data")
    return len(data) if isinstance(data, list) else None


def _dashboard_log(row: OperationLog) -> dict:
    return {
        "id": row.id,
        "type": row.type,
        "type_label": business_log_type(row.type),
        "level": row.level,
        "title": _business_log_title(row.title),
        "username": row.username or "",
        "entity_id": row.entity_id or "",
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _business_log_title(title: str | None) -> str:
    """兼容现有调用方，统一逻辑由日志显示服务维护。"""
    return business_log_title(title)


def _distinct_dashboard_logs(rows: list[OperationLog], limit: int = 8) -> list[dict]:
    """首页只保留同类事件的最新一条，避免周期任务淹没人工操作。"""
    seen: set[tuple[str, str, str, str]] = set()
    result: list[dict] = []
    for row in rows:
        key = (row.type, row.level, row.title, row.entity_id or "")
        if key in seen:
            continue
        seen.add(key)
        result.append(_dashboard_log(row))
        if len(result) >= limit:
            break
    return result


def _mask_token(token: str) -> str:
    """脱敏 token，仅保留末4位"""
    if not token:
        return ""
    if len(token) <= 4:
        return "••••"
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


def _parse_settings_log(detail: str | None) -> dict:
    parsed: dict[str, str | list[str]] = {}
    for part in (detail or "").split("; "):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        parsed[key.strip()] = [item for item in value.split(",") if item] if key.strip() in {"updated_keys", "reset_keys"} else value.strip()
    return parsed


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(str(value or default))
    except (TypeError, ValueError):
        return default


def _clear_settings_status_cache() -> None:
    _settings_status_cache["expires_at"] = 0.0
    _settings_status_cache["value"] = None


def _clear_public_summary_cache() -> None:
    invalidate_system_summary()
    _public_summary_cache["expires_at"] = 0.0
    _public_summary_cache["value"] = None


async def _test_runtime_service(
    service: str,
    body: TestConnectionRequest,
    db: AsyncSession,
    runtime=None,
) -> TestConnectionResponse:
    runtime = runtime or await get_runtime_config(db)
    def draft_or_runtime(field: str, runtime_value: str) -> str:
        return getattr(body, field) if field in body.model_fields_set else runtime_value

    ollama_base_url = draft_or_runtime("ollama_base_url", runtime.ollama_base_url)
    dify_base_url = draft_or_runtime("dify_base_url", runtime.dify_base_url)
    dify_api_key = draft_or_runtime("dify_api_key", runtime.dify_api_key)
    dify_dataset_api_key = draft_or_runtime("dify_dataset_api_key", runtime.dify_dataset_api_key)
    ha_base_url = draft_or_runtime("ha_base_url", runtime.ha_base_url)
    ha_token = draft_or_runtime("ha_token", runtime.ha_token)
    influxdb_url = draft_or_runtime("influxdb_url", runtime.influxdb_url)
    influxdb_token = draft_or_runtime("influxdb_token", runtime.influxdb_token)
    influxdb_org = body.influxdb_org if body.influxdb_org is not None else runtime.influxdb_org
    influxdb_bucket = body.influxdb_bucket if body.influxdb_bucket is not None else runtime.influxdb_bucket

    status = "stopped"
    latency = 0
    message = "无法连接到服务，请检查地址和网络"

    if service == "ollama":
        status, latency = await _check_service_with_latency(f"{ollama_base_url}/api/version")
    elif service == "homeassistant":
        if not ha_token:
            message = "Home Assistant 缺少长效 Token"
        else:
            status, latency = await _check_service_with_latency(
                f"{ha_base_url}/api/", headers={"Authorization": f"Bearer {ha_token}"},
            )
    elif service == "influxdb":
        health_status, health_latency = await _check_service_with_latency(f"{influxdb_url}/health")
        latency = health_latency
        if health_status != "running":
            status = health_status
        elif not influxdb_token:
            message = "InfluxDB 健康接口可达，但缺少 Token，查询和写入不可用"
        elif not influxdb_org or not influxdb_bucket:
            message = "InfluxDB 健康接口可达，但缺少组织名或存储桶"
        else:
            status, auth_latency, message = await _check_influx_bucket(
                influxdb_url, influxdb_token, influxdb_org, influxdb_bucket,
            )
            latency = max(health_latency, auth_latency)
    elif service == "dify":
        if not dify_api_key and not dify_dataset_api_key:
            message = "Dify 缺少应用 API Key 和 Dataset API Key"
        elif not dify_api_key:
            message = "Dify 缺少应用 API Key"
        elif not dify_dataset_api_key:
            message = "Dify 缺少 Dataset API Key"
        else:
            (app_status, app_latency), (dataset_status, dataset_latency) = await asyncio.gather(
                _check_service_with_latency(
                    f"{dify_base_url}/v1/parameters",
                    headers={"Authorization": f"Bearer {dify_api_key}"},
                ),
                _check_service_with_latency(
                    f"{dify_base_url}/v1/datasets",
                    headers={"Authorization": f"Bearer {dify_dataset_api_key}"},
                ),
            )
            latency = max(app_latency, dataset_latency)
            status = "running" if app_status == "running" and dataset_status == "running" else "error" if "error" in {app_status, dataset_status} else "stopped"
            if status == "error":
                message = "Dify 应用 API Key 和 Dataset API Key 均认证失败" if app_status != "running" and dataset_status != "running" else "Dify 应用 API Key 认证失败" if app_status != "running" else "Dify Dataset API Key 认证失败"
            elif status == "stopped":
                message = "无法连接到 Dify，请检查地址、认证信息和网络"

    messages = {
        "running": "服务运行正常",
        "stopped": "无法连接到服务，请检查地址、认证信息和网络",
        "error": "服务返回异常状态码或鉴权失败",
    }
    if status != "running" and message == "无法连接到服务，请检查地址和网络":
        message = messages.get(status, message)
    return TestConnectionResponse(
        service=service,
        status=status,
        message=message if message != "无法连接到服务，请检查地址和网络" else messages.get(status, "未知状态"),
        latency_ms=latency,
    )


# ══════════════════════════════════════════════
#  Dashboard
# ══════════════════════════════════════════════

async def _load_dashboard_platform_data(
    db: AsyncSession,
    *,
    include_private: bool = True,
    current_user: dict | None = None,
) -> tuple[dict, list[ManagedDevice]]:
    """先读取本地平台数据，避免外部探测阻塞 Dashboard 首屏。"""
    seven_days_ago = datetime.now() - timedelta(days=7)
    total_users = active_users = new_users = 0
    visibility_scope = "public"
    if include_private:
        is_admin = (current_user or {}).get("role") == "admin"
        visibility_scope = "all" if is_admin else "self"
        user_scope = [] if is_admin else [User.id == (current_user or {}).get("user_id")]
        total_users = (await db.execute(
            select(func.count(User.id)).where(*user_scope)
        )).scalar() or 0
        active_users = (await db.execute(
            select(func.count(User.id)).where(User.is_active == True, *user_scope)  # noqa: E712
        )).scalar() or 0
        new_users = (await db.execute(
            select(func.count(User.id)).where(User.created_at >= seven_days_ago, *user_scope)
        )).scalar() or 0

    device_result = await db.execute(
        select(ManagedDevice)
        .options(selectinload(ManagedDevice.mappings))
        .order_by(ManagedDevice.id)
    )
    managed_devices = device_result.scalars().unique().all()
    recent_activity = []
    activity_coverage = {
        "scanned_count": 0,
        "scan_limit": 100,
        "scan_truncated": False,
        "distinct_count": 0,
        "display_limit": 8,
    }
    if include_private:
        activity_scope = [] if visibility_scope == "all" else [
            OperationLog.user_id == (current_user or {}).get("user_id")
        ]
        recent_result = await db.execute(
            select(OperationLog)
            .where(*activity_scope)
            .order_by(OperationLog.created_at.desc())
            .limit(activity_coverage["scan_limit"] + 1)
        )
        recent_rows = recent_result.scalars().all()
        activity_coverage["scan_truncated"] = len(recent_rows) > activity_coverage["scan_limit"]
        scanned_rows = recent_rows[:activity_coverage["scan_limit"]]
        activity_coverage["scanned_count"] = len(scanned_rows)
        recent_activity = _distinct_dashboard_logs(scanned_rows, limit=activity_coverage["display_limit"])
        activity_coverage["distinct_count"] = len(recent_activity)

    uptime_seconds = max(0, int(time.time() - _start_time))
    return ({
        "stats": {
            "total_users": total_users,
            "active_users": active_users,
            "new_users_7d": new_users,
            "registered_devices": len([item for item in managed_devices if item.enabled]),
            "online_devices": None,
            "model_count": None,
            "knowledge_count": None,
        },
        "services": [{
            "key": "backend",
            "name": "平台后端",
            "endpoint": "/api/v1/system/health",
            "status": "running",
            "latency_ms": 0,
            "detail": _format_process_uptime(uptime_seconds),
            "source": "当前后端进程",
        }],
        "recent_activity": recent_activity,
        "activity_coverage": activity_coverage,
        "warnings": [],
        "generated_at": datetime.now().astimezone().isoformat(),
        "backend_uptime_seconds": uptime_seconds,
        "scope": "platform",
        "visibility_scope": visibility_scope,
    }, managed_devices)


async def _build_dashboard_runtime_payload(
    db: AsyncSession,
    *,
    managed_devices: list[ManagedDevice] | None = None,
    include_endpoints: bool = True,
) -> dict:
    """聚合外部运行时；失败只返回局部诊断，不影响平台快照。"""
    runtime = await get_runtime_services(db)
    if managed_devices is None:
        device_result = await db.execute(
            select(ManagedDevice)
            .options(selectinload(ManagedDevice.mappings))
            .order_by(ManagedDevice.id)
        )
        managed_devices = device_result.scalars().unique().all()

    async def _probe_influxdb():
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            response = await client.get(f"{runtime.config.influxdb_url}/health")
            response.raise_for_status()
            return response.json()

    ollama, knowledge, dify_app, homeassistant, influxdb = await asyncio.gather(
        _load_runtime_value(runtime.ollama.list_models, 4),
        _load_runtime_value(
            lambda: runtime.dify_knowledge.list_datasets(page=1, limit=1),
            5,
        ) if runtime.config.dify_dataset_api_key else asyncio.sleep(0, result={
            "status": "unconfigured", "latency_ms": 0, "value": None,
            "error": "Dify Dataset API Key 未配置",
        }),
        _load_runtime_value(runtime.dify.get_app_info, 5)
        if runtime.config.dify_api_key else asyncio.sleep(0, result={
            "status": "unconfigured", "latency_ms": 0, "value": None,
            "error": "Dify 应用 API Key 未配置",
        }),
        _load_runtime_value(runtime.homeassistant.get_states, 5)
        if runtime.config.ha_token else asyncio.sleep(0, result={
            "status": "unconfigured", "latency_ms": 0, "value": None,
            "error": "Home Assistant Token 未配置",
        }),
        _load_runtime_value(_probe_influxdb, 3),
    )

    registered_devices, online_devices = _managed_device_stats(
        managed_devices,
        homeassistant["value"] if isinstance(homeassistant["value"], list) else None,
    )
    model_count = len(ollama["value"]) if isinstance(ollama["value"], list) else None
    knowledge_count = _dataset_total(knowledge["value"])
    services = [
        {
            "key": "dify_app",
            "name": "Dify 智能体应用",
            "endpoint": runtime.config.dify_base_url if include_endpoints else "",
            "status": dify_app["status"],
            "latency_ms": dify_app["latency_ms"],
            "detail": (
                DEFAULT_AGENT_BUSINESS_NAME
                if dify_app["status"] == "running" else dify_app["error"]
            ),
            "source": "Dify 应用信息接口",
        },
        {
            "key": "dify_knowledge",
            "name": "Dify 知识库",
            "endpoint": runtime.config.dify_base_url if include_endpoints else "",
            "status": knowledge["status"],
            "latency_ms": knowledge["latency_ms"],
            "detail": (
                f"读取到 {knowledge_count} 个知识库"
                if knowledge_count is not None else knowledge["error"]
            ),
            "source": "Dify 知识库接口",
        },
        {
            "key": "homeassistant",
            "name": "Home Assistant",
            "endpoint": runtime.config.ha_base_url if include_endpoints else "",
            "status": homeassistant["status"],
            "latency_ms": homeassistant["latency_ms"],
            "detail": (
                f"{online_devices}/{registered_devices} 个平台设备的 HA 状态可读"
                if online_devices is not None else homeassistant["error"]
            ),
            "source": "Home Assistant 状态接口 + 平台设备台账",
        },
        {
            "key": "ollama",
            "name": "Ollama 推理服务",
            "endpoint": runtime.config.ollama_base_url if include_endpoints else "",
            "status": ollama["status"],
            "latency_ms": ollama["latency_ms"],
            "detail": f"已安装 {model_count} 个模型" if model_count is not None else ollama["error"],
            "source": "Ollama 模型列表接口",
        },
        {
            "key": "influxdb",
            "name": "InfluxDB 时序库",
            "endpoint": runtime.config.influxdb_url if include_endpoints else "",
            "status": influxdb["status"],
            "latency_ms": influxdb["latency_ms"],
            "detail": "健康接口检查通过" if influxdb["status"] == "running" else influxdb["error"],
            "source": "InfluxDB 健康接口",
        },
    ]
    warnings = [
        f"{service['name']}：{service['detail'] or '当前不可用'}"
        for service in services
        if service["status"] != "running"
    ]

    return {
        "stats": {
            "registered_devices": registered_devices,
            "online_devices": online_devices,
            "model_count": model_count,
            "knowledge_count": knowledge_count,
        },
        "services": services,
        "warnings": warnings,
        "generated_at": datetime.now().astimezone().isoformat(),
        "scope": "runtime",
    }


async def _build_dashboard_payload(
    db: AsyncSession,
    *,
    include_private: bool = True,
    current_user: dict | None = None,
) -> dict:
    """保留完整 Dashboard 合同，供帮助页和公开摘要兼容使用。"""
    platform_payload, managed_devices = await _load_dashboard_platform_data(
        db,
        include_private=include_private,
        current_user=current_user,
    )
    runtime_payload = await _build_dashboard_runtime_payload(
        db,
        managed_devices=managed_devices,
        include_endpoints=include_private and (current_user or {}).get("role") == "admin",
    )
    return {
        **platform_payload,
        "stats": {**platform_payload["stats"], **runtime_payload["stats"]},
        "services": [*platform_payload["services"], *runtime_payload["services"]],
        "warnings": runtime_payload["warnings"],
        "generated_at": runtime_payload["generated_at"],
        "scope": "all",
    }


@router.get("/dashboard", summary="Dashboard 概览数据")
async def dashboard(
    scope: str = "all",
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if scope == "platform":
        payload, _managed_devices = await _load_dashboard_platform_data(db, current_user=user)
        return payload
    if scope == "runtime":
        return await _build_dashboard_runtime_payload(
            db,
            include_endpoints=user.get("role") == "admin",
        )
    if scope != "all":
        raise HTTPException(status_code=422, detail="scope 必须是 all、platform 或 runtime")
    return await _build_dashboard_payload(db, current_user=user)


@router.get("/public-summary", summary="首页公开运行摘要")
async def public_summary(db: AsyncSession = Depends(get_db)):
    """返回首页需要的脱敏运行状态；短时缓存避免公开页面反复探测外部服务。"""
    now = time.monotonic()
    generation = get_system_summary_generation()
    cached = _public_summary_cache.get("value")
    if (
        cached is not None
        and _public_summary_cache.get("generation") == generation
        and float(_public_summary_cache.get("expires_at") or 0) > now
    ):
        return {**cached, "cached": True}

    async with _public_summary_lock:
        now = time.monotonic()
        generation = get_system_summary_generation()
        cached = _public_summary_cache.get("value")
        if (
            cached is not None
            and _public_summary_cache.get("generation") == generation
            and float(_public_summary_cache.get("expires_at") or 0) > now
        ):
            return {**cached, "cached": True}

        payload = await _build_dashboard_payload(db, include_private=False)
        services = [
            {
                "key": service["key"],
                "name": service["name"],
                "status": service["status"],
                "latency_ms": service["latency_ms"],
            }
            for service in payload["services"]
        ]
        running_services = sum(service["status"] == "running" for service in services)
        summary = {
            "overall_status": (
                "healthy" if running_services == len(services)
                else "unavailable" if running_services == 0
                else "degraded"
            ),
            "stats": {
                "registered_devices": payload["stats"]["registered_devices"],
                "online_devices": payload["stats"]["online_devices"],
                "model_count": payload["stats"]["model_count"],
                "knowledge_count": payload["stats"]["knowledge_count"],
                "running_services": running_services,
                "total_services": len(services),
            },
            "services": services,
            "generated_at": payload["generated_at"],
            "cached": False,
        }
        _public_summary_cache["value"] = summary
        _public_summary_cache["expires_at"] = now + PUBLIC_SUMMARY_TTL_SECONDS
        _public_summary_cache["generation"] = generation
        return summary


# ══════════════════════════════════════════════
#  Settings CRUD
# ══════════════════════════════════════════════

@router.get("/settings", response_model=SettingsResponse, summary="获取系统配置")
async def get_settings(
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """快速读取当前系统配置；实时服务探测由独立状态接口负责。"""
    runtime = await get_runtime_config(db)
    can_manage = user.get("role") == "admin"
    override_rows = (await db.execute(
        select(SystemConfig.key, SystemConfig.updated_at)
        .where(SystemConfig.key.in_(SETTINGS_KEYS))
        .order_by(SystemConfig.key)
    )).all()
    override_keys = [row[0] for row in override_rows]
    last_updated_at = max((row[1] for row in override_rows if row[1]), default=None)

    return SettingsResponse(
        services={
            "ollama": ServiceConfig(
                url=runtime.ollama_base_url if can_manage else "",
                configured=bool(runtime.ollama_base_url),
            ),
            "dify": ServiceConfig(
                url=runtime.dify_base_url if can_manage else "",
                configured=bool(runtime.dify_base_url),
                token=_mask_token(runtime.dify_api_key) if can_manage else "",
                token_configured=bool(runtime.dify_api_key),
                extra={
                    "dataset_token": _mask_token(runtime.dify_dataset_api_key) if can_manage else "",
                    "dataset_token_configured": str(bool(runtime.dify_dataset_api_key)).lower(),
                },
            ),
            "homeassistant": ServiceConfig(
                url=runtime.ha_base_url if can_manage else "",
                configured=bool(runtime.ha_base_url),
                token=_mask_token(runtime.ha_token) if can_manage else "",
                token_configured=bool(runtime.ha_token),
            ),
            "influxdb": ServiceConfig(
                url=runtime.influxdb_url if can_manage else "",
                configured=bool(runtime.influxdb_url),
                token=_mask_token(runtime.influxdb_token) if can_manage else "",
                token_configured=bool(runtime.influxdb_token),
                extra={
                    "org": runtime.influxdb_org if can_manage else "",
                    "bucket": runtime.influxdb_bucket if can_manage else "",
                },
            ),
        },
        security=SecurityConfig(
            jwt_expire_hours=runtime.jwt_expire_hours,
            allow_registration=runtime.allow_registration,
            password_min_length=runtime.password_min_length,
        ),
        config_source=runtime.config_source,
        override_keys=override_keys if can_manage else [],
        last_updated_at=last_updated_at,
        can_manage=can_manage,
    )


@router.put("/settings", response_model=SettingsActionResponse, summary="保存系统配置")
async def update_settings(
    body: SettingsUpdate,
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """保存系统配置到 DB；密钥空值表示不变，reset_keys 表示恢复默认来源。"""
    field_map = {
        "ollama_base_url": body.ollama_base_url,
        "dify_base_url": body.dify_base_url,
        "dify_api_key": body.dify_api_key,
        "dify_dataset_api_key": body.dify_dataset_api_key,
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
    runtime = await get_runtime_config(db)
    effective_values = {
        "ollama_base_url": runtime.ollama_base_url,
        "dify_base_url": runtime.dify_base_url,
        "dify_api_key": runtime.dify_api_key,
        "dify_dataset_api_key": runtime.dify_dataset_api_key,
        "ha_base_url": runtime.ha_base_url,
        "ha_token": runtime.ha_token,
        "influxdb_url": runtime.influxdb_url,
        "influxdb_token": runtime.influxdb_token,
        "influxdb_org": runtime.influxdb_org,
        "influxdb_bucket": runtime.influxdb_bucket,
        "jwt_expire_hours": str(runtime.jwt_expire_hours),
        "allow_registration": str(runtime.allow_registration).lower(),
        "password_min_length": str(runtime.password_min_length),
    }

    invalid_reset_keys = set(body.reset_keys) - SETTINGS_KEYS
    if invalid_reset_keys:
        raise HTTPException(status_code=422, detail=f"不支持恢复的配置项：{','.join(sorted(invalid_reset_keys))}")

    existing_rows = await db.execute(
        select(SystemConfig).where(SystemConfig.key.in_(SETTINGS_KEYS))
    )
    existing_by_key = {row.key: row for row in existing_rows.scalars().all()}
    updated_keys = []
    for key, value in field_map.items():
        if key in body.reset_keys:
            continue
        current_value = existing_by_key.get(key).value if existing_by_key.get(key) else effective_values[key]
        if value is not None and value != "" and str(value) != current_value:
            await _set_config_value(db, key, value)
            updated_keys.append(key)

    reset_keys = sorted(set(body.reset_keys))
    if reset_keys:
        reset_keys = [key for key in reset_keys if key in existing_by_key]
        for key in reset_keys:
            row = existing_by_key[key]
            await db.delete(row)

    if updated_keys or reset_keys:
        db.add(OperationLog(
            type="system_settings",
            level="success",
            title="系统配置已保存",
            detail=f"action=save; updated_keys={','.join(updated_keys)}; reset_keys={','.join(reset_keys)}",
            user_id=user.get("user_id"),
            username=user.get("username", ""),
        ))
        _clear_settings_status_cache()
        _clear_public_summary_cache()

    return SettingsActionResponse(
        message="配置已保存" if updated_keys or reset_keys else "没有需要保存的变更",
        updated_keys=updated_keys,
        reset_keys=reset_keys,
    )


# ══════════════════════════════════════════════
#  Connection Test
# ══════════════════════════════════════════════

@router.post("/test-connection", response_model=TestConnectionResponse, summary="测试外部服务连接")
async def test_connection(
    body: TestConnectionRequest,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """测试草稿或当前运行时配置，并记录不含凭证的诊断证据。"""
    # 显式提交空值同样属于草稿覆盖，不能让普通用户借此改变探测目标或凭证语义。
    has_draft_override = bool(body.model_fields_set - {"service"})
    if has_draft_override and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="只有管理员可以测试未保存的地址或凭证")
    result = await _test_runtime_service(body.service.value, body, db)
    service_name = SERVICE_DISPLAY_NAMES.get(body.service.value, body.service.value)
    db.add(OperationLog(
        type="system_settings",
        level="success" if result.status == "running" else "warning",
        title=f"{service_name} 连接测试{'通过' if result.status == 'running' else '未通过'}",
        detail=f"action=test; service={body.service.value}; status={result.status}; latency_ms={result.latency_ms}; message={result.message}",
        user_id=user.get("user_id"),
        username=user.get("username", ""),
    ))
    return result


@router.get("/settings/status", response_model=SettingsStatusResponse, summary="读取外部服务状态")
async def get_settings_status(
    refresh: bool = Query(False),
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = time.time()
    cached_value = _settings_status_cache.get("value")
    if not refresh and cached_value and float(_settings_status_cache.get("expires_at") or 0) > now:
        return SettingsStatusResponse(**cached_value, cached=True)

    services = ["ollama", "dify", "homeassistant", "influxdb"]
    runtime = await get_runtime_config(db)
    results = await asyncio.gather(*[
        _test_runtime_service(service, TestConnectionRequest(service=service), db, runtime)
        for service in services
    ])
    payload = {
        "services": {result.service: result for result in results},
        "tested_at": datetime.now().astimezone(),
    }
    _settings_status_cache["value"] = payload
    _settings_status_cache["expires_at"] = now + SETTINGS_STATUS_TTL_SECONDS
    return SettingsStatusResponse(**payload, cached=False)


@router.get("/settings/history", response_model=SettingsHistoryPage, summary="分页读取配置变更与连接测试记录")
async def get_settings_history(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    action: str = Query(""),
    _user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    query = select(OperationLog).where(OperationLog.type == "system_settings")
    if action == "test":
        query = query.where(OperationLog.detail.like("%action=test%"))
    elif action in {"save", "reset"}:
        query = query.where(OperationLog.detail.like(f"%action={action}%"))
    total = int((await db.execute(select(func.count()).select_from(query.subquery()))).scalar() or 0)
    page_count = max(1, (total + size - 1) // size)
    safe_page = min(page, page_count)
    rows = (await db.execute(
        query.order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
        .offset((safe_page - 1) * size).limit(size)
    )).scalars().all()
    items = []
    for row in rows:
        detail = _parse_settings_log(row.detail)
        items.append(SettingsHistoryItem(
            id=row.id,
            action=str(detail.get("action") or "save"),
            level=row.level,
            title=_business_log_title(row.title),
            changed_keys=[*detail.get("updated_keys", []), *detail.get("reset_keys", [])],
            service=str(detail.get("service") or ""),
            status=str(detail.get("status") or ""),
            latency_ms=_safe_int(detail.get("latency_ms")),
            message=str(detail.get("message") or ""),
            username=row.username or "",
            created_at=row.created_at,
        ))
    return SettingsHistoryPage(items=items, total=total, page=safe_page, size=size)


@router.post("/settings/reset", response_model=SettingsActionResponse, summary="恢复默认配置来源")
async def reset_settings(
    body: SettingsResetRequest,
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    requested = set(body.keys) if body.keys else SETTINGS_KEYS
    invalid = requested - SETTINGS_KEYS
    if invalid:
        raise HTTPException(status_code=422, detail=f"不支持恢复的配置项：{','.join(sorted(invalid))}")
    rows = (await db.execute(
        select(SystemConfig).where(SystemConfig.key.in_(requested))
    )).scalars().all()
    reset_keys = sorted(row.key for row in rows)
    if not reset_keys:
        return SettingsActionResponse(message="当前没有数据库运行时覆盖，无需恢复")
    for row in rows:
        await db.delete(row)
    db.add(OperationLog(
        type="system_settings",
        level="warning",
        title="系统配置已恢复默认来源",
        detail=f"action=reset; reset_keys={','.join(reset_keys)}",
        user_id=user.get("user_id"),
        username=user.get("username", ""),
    ))
    _clear_settings_status_cache()
    _clear_public_summary_cache()
    return SettingsActionResponse(message="已恢复默认配置来源", reset_keys=reset_keys)


# ══════════════════════════════════════════════
#  System Info
# ══════════════════════════════════════════════

@router.get("/info", response_model=SystemInfoResponse, summary="系统运行信息")
async def system_info(
    user: dict = Depends(get_current_user),
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

    config_source = await get_config_source_label(db)
    can_view_runtime_details = user.get("role") == "admin"

    return SystemInfoResponse(
        version=APP_VERSION,
        python_version=platform.python_version() if can_view_runtime_details else "",
        os_info=f"{platform.system()} {platform.machine()}" if can_view_runtime_details else "",
        db_status=db_status,
        uptime_seconds=uptime,
        uptime_display=uptime_display,
        api_docs_url=API_DOCS_URL,
        config_source=config_source,
        runtime_details_visible=can_view_runtime_details,
    )
