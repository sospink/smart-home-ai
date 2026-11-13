"""
监控大屏路由 — 系统资源 / AI模型 / 服务健康 / 今日活动 / 图表数据 / 操作日志
Phase 1: resources, ai-status, services
Phase 2: activity(真实统计), chat-trends, logs(数据库)
"""
import asyncio
import csv
import io
import json
import math
import platform
import re
import time
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import String, and_, case, cast, delete, func, literal, or_, select
from sqlalchemy.orm import selectinload
from app.dependencies import get_agent_or_user, get_current_user, get_db, require_admin
from app.database import AsyncSessionLocal
from app.services.runtime_settings import get_runtime_config, get_runtime_services
from app.services.influxdb import InfluxDBService, InfluxRuntimeConfig
from app.services.log_display import business_log_summary, business_log_title, business_log_type
from app.models.device_management import ManagedDevice
from app.models.operation_log import OperationLog

try:
    import psutil
except ImportError:
    psutil = None

router = APIRouter(prefix="/monitor", tags=["监控大屏"])

OPERATION_LOG_RETENTION_DAYS = 90
OPERATION_LOG_ERROR_RETENTION_DAYS = 365
OPERATION_LOG_RETENTION_INTERVAL_SECONDS = 24 * 60 * 60
OPERATION_LOG_CLEANUP_CONFIRMATION = "清理过期日志"


class OperationLogCleanupRequest(BaseModel):
    normal_days: int = Field(OPERATION_LOG_RETENTION_DAYS, ge=30, le=365)
    error_days: int = Field(OPERATION_LOG_ERROR_RETENTION_DAYS, ge=90, le=730)
    confirmation: str = ""


# ── 启动时间 ──
_start_time = time.time()


# ══════════════════════════════════════════════
#  Helper
# ══════════════════════════════════════════════

async def _check_service_health(name: str, url: str, headers: dict | None = None, timeout: float = 5.0) -> dict:
    """检查服务连通性 + 延迟"""
    import httpx
    try:
        t0 = time.time()
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            request_headers = headers.copy() if headers else {}
            r = await client.get(url, headers=request_headers)
            latency = int((time.time() - t0) * 1000)
            if 200 <= r.status_code < 300:
                status = "running"
                diagnostic = "服务响应正常"
            elif r.status_code in {401, 403}:
                status = "auth_error"
                diagnostic = "服务可达，但访问凭证未通过验证"
            else:
                status = "error"
                diagnostic = f"服务已响应，但返回 HTTP {r.status_code}"
            return {
                "name": name,
                "status": status,
                "latency_ms": latency,
                "http_status": r.status_code,
                "diagnostic": diagnostic,
            }
    except httpx.TimeoutException:
        return {"name": name, "status": "stopped", "latency_ms": None, "http_status": None, "diagnostic": "连接超时，未取得服务响应"}
    except httpx.RequestError:
        return {"name": name, "status": "stopped", "latency_ms": None, "http_status": None, "diagnostic": "无法建立连接，请检查服务地址和运行状态"}
    except Exception:
        return {"name": name, "status": "stopped", "latency_ms": None, "http_status": None, "diagnostic": "服务探测未完成"}


def _unconfigured_service(name: str, diagnostic: str) -> dict:
    return {
        "name": name,
        "status": "unconfigured",
        "latency_ms": None,
        "http_status": None,
        "diagnostic": diagnostic,
    }


def _get_gpu_info() -> dict:
    """尝试获取 GPU 信息（nvidia-smi）"""
    try:
        import subprocess
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            parts = result.stdout.strip().split(", ")
            return {
                "available": True,
                "model": parts[0].strip(),
                "percent": int(parts[1].strip()),
                "vram_used_mb": int(parts[2].strip()),
                "vram_total_mb": int(parts[3].strip()),
            }
    except Exception:
        pass

    # Fallback: 无 GPU 或获取失败
    return {
        "available": False,
        "model": "N/A",
        "percent": None,
        "vram_used_mb": None,
        "vram_total_mb": None,
    }


# ══════════════════════════════════════════════
#  1. 系统资源
# ══════════════════════════════════════════════

@router.get("/resources", summary="系统资源指标")
async def system_resources(_user=Depends(get_current_user)):
    """CPU / 内存 / GPU / 存储 实时数据"""

    if psutil:
        cpu_percent = psutil.cpu_percent(interval=0.5)
        cpu_count = psutil.cpu_count(logical=True)
        mem = psutil.virtual_memory()
        disk = psutil.disk_usage("/")

        cpu_model = platform.processor() or "Unknown CPU"
    else:
        # psutil 不可用时的 fallback
        cpu_percent = 0
        cpu_count = 0
        cpu_model = platform.processor() or "Unknown"
        mem = type("M", (), {"percent": 0, "used": 0, "total": 0})()
        disk = type("D", (), {"percent": 0, "used": 0, "total": 0, "free": 0})()

    gpu = _get_gpu_info()

    return {
        "available": psutil is not None,
        "diagnostic": "" if psutil is not None else "主机资源采集依赖 psutil 未安装，当前指标未取得",
        "cpu": {
            "percent": round(cpu_percent, 1),
            "model": cpu_model,
            "cores": cpu_count,
        },
        "memory": {
            "percent": round(mem.percent, 1),
            "used_gb": round(mem.used / (1024 ** 3), 1),
            "total_gb": round(mem.total / (1024 ** 3), 1),
        },
        "gpu": {
            "available": gpu["available"],
            "percent": gpu["percent"],
            "model": gpu["model"],
            "vram_used_gb": round(gpu["vram_used_mb"] / 1024, 1) if gpu["vram_used_mb"] is not None else None,
            "vram_total_gb": round(gpu["vram_total_mb"] / 1024, 1) if gpu["vram_total_mb"] is not None else None,
        },
        "disk": {
            "percent": round(disk.percent, 1),
            "used_gb": round(disk.used / (1024 ** 3), 1),
            "total_gb": round(disk.total / (1024 ** 3), 1),
            "available_gb": round(disk.free / (1024 ** 3), 1),
            "mount_path": "/",
        },
    }


# ══════════════════════════════════════════════
#  2. AI 模型状态
# ══════════════════════════════════════════════

@router.get("/ai-status", summary="AI 模型运行状态")
async def ai_status(_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """当前运行的模型信息 + 推理指标"""
    services = await get_runtime_services(db)
    try:
        running = await asyncio.wait_for(services.ollama.running_models(), timeout=4.0)
    except Exception:
        return {
            "status": "offline",
            "model_name": "Ollama 未连接",
            "quantization": "",
            "family": "",
            "parameter_size": "",
            "vram_used_gb": None,
            "inference_latency_ms": None,
            "throughput_tps": None,
        }

    if running and len(running) > 0:
        model = running[0]
        model_name = model.get("name", "unknown")
        # 从 details 提取量化方式
        details = model.get("details", {})
        quant = details.get("quantization_level", "")
        family = details.get("family", "")
        param_size = details.get("parameter_size", "")
        # VRAM
        size_vram = model.get("size_vram", 0)
        vram_gb = round(size_vram / (1024 ** 3), 1) if size_vram else 0

        return {
            "status": "running",
            "model_name": model_name,
            "quantization": quant,
            "family": family,
            "parameter_size": param_size,
            "vram_used_gb": vram_gb,
            # 推理指标需要实际调用才能拿到，这里展示模型信息
            "inference_latency_ms": None,
            "throughput_tps": None,
        }
    else:
        # 没有活跃模型，尝试获取已安装模型列表
        try:
            models = await asyncio.wait_for(services.ollama.list_models(), timeout=4.0)
            first = models[0] if models else {}
            return {
                "status": "idle",
                "model_name": first.get("name", "无模型"),
                "quantization": first.get("details", {}).get("quantization_level", ""),
                "family": first.get("details", {}).get("family", ""),
                "parameter_size": first.get("details", {}).get("parameter_size", ""),
                "vram_used_gb": None,
                "inference_latency_ms": None,
                "throughput_tps": None,
            }
        except Exception:
            return {
                "status": "offline",
                "model_name": "Ollama 未连接",
                "quantization": "",
                "family": "",
                "parameter_size": "",
                "vram_used_gb": None,
                "inference_latency_ms": None,
                "throughput_tps": None,
            }


# ══════════════════════════════════════════════
#  3. 服务健康状态
# ══════════════════════════════════════════════

@router.get("/services", summary="服务健康状态")
async def service_health(_user=Depends(get_agent_or_user), db: AsyncSession = Depends(get_db)):
    """并行检测所有外部服务"""
    runtime = await get_runtime_config(db)
    check_specs = [
        ("Ollama 推理引擎", runtime.ollama_base_url, "当前未配置 Ollama 服务地址", "/api/version", {}, 2.0),
        ("Home Assistant", runtime.ha_base_url if runtime.ha_token else "", "当前未配置 Home Assistant 地址或访问令牌", "/api/", {"Authorization": f"Bearer {runtime.ha_token}"}, 3.0),
        ("Dify 智能体框架", runtime.dify_base_url if runtime.dify_dataset_api_key else "", "当前未配置 Dify 地址或知识库访问密钥", "/v1/datasets", {"Authorization": f"Bearer {runtime.dify_dataset_api_key}"}, 4.0),
        ("InfluxDB 时序库", runtime.influxdb_url, "当前未配置 InfluxDB 服务地址", "/health", {}, 2.0),
    ]
    pending = []
    configured_indexes = []
    checks = [None] * len(check_specs)
    for index, (name, base_url, missing, path, headers, timeout) in enumerate(check_specs):
        if not str(base_url or "").strip():
            checks[index] = _unconfigured_service(name, missing)
            continue
        configured_indexes.append(index)
        pending.append(_check_service_health(name, f"{str(base_url).rstrip('/')}{path}", headers=headers, timeout=timeout))
    if pending:
        for index, value in zip(configured_indexes, await asyncio.gather(*pending)):
            checks[index] = value

    # 后端自身
    uptime_s = int(time.time() - _start_time)
    services = [
        {
            "name": "FastAPI 后端",
            "status": "running",
            "latency_ms": None,
            "http_status": None,
            "diagnostic": "当前页面已通过后端接口取得响应",
            "extra": f"已运行 {uptime_s // 3600} 小时 {(uptime_s % 3600) // 60} 分钟",
        },
        *checks,
    ]

    return {"services": services}


# ══════════════════════════════════════════════
#  4. 今日活动统计
# ══════════════════════════════════════════════

@router.get("/activity", summary="今日活动统计")
async def today_activity(
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """对话数 / 控制数 / 知识库 / 模型数；不可达的外部来源保持未知。"""
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        services = await get_runtime_services(db)
        runtime_error = ""
    except Exception:
        services = None
        runtime_error = "运行时配置暂不可用"

    async def _load_metric(source: str, loader):
        try:
            value = await loader()
            return value, {"status": "available", "source": source, "error": ""}
        except Exception:
            return None, {
                "status": "unavailable",
                "source": source,
                "error": runtime_error or f"{source}当前不可用",
            }

    # 并行获取数据；可选外部服务不能拖住监控首屏。
    async def _get_conversations_count() -> int:
        if services is None:
            raise RuntimeError(runtime_error)
        res = await asyncio.wait_for(
            services.dify.get_conversations(
                user=f"user-{_user.get('user_id')}",
                limit=100,
            ),
            timeout=2.0,
        )
        conversations = res.get("data")
        if not isinstance(conversations, list):
            raise RuntimeError("Dify 会话响应格式异常")
        count = 0
        for conversation in conversations:
            created = conversation.get("created_at", 0)
            if isinstance(created, (int, float)) and datetime.fromtimestamp(created) >= today_start:
                count += 1
        return count

    async def _get_controls_count() -> int:
        """每次真实调用 HA 后只会写入一条 result=pending 下发记录。"""
        scope_filters = _operation_log_scope_filters(_user)
        result = await db.execute(
            select(func.count(OperationLog.id)).where(
                OperationLog.type == "device_control",
                OperationLog.detail.like("%result=pending%"),
                OperationLog.created_at >= today_start,
                *scope_filters,
            )
        )
        return result.scalar() or 0

    async def _get_knowledge_count() -> int:
        if services is None:
            raise RuntimeError(runtime_error)
        res = await asyncio.wait_for(
            services.dify_knowledge.list_datasets(page=1, limit=100),
            timeout=3.0,
        )
        datasets = res.get("data")
        if not isinstance(datasets, list):
            raise RuntimeError("Dataset 响应格式异常")
        return sum(int(dataset.get("document_count") or 0) for dataset in datasets)

    async def _get_model_count() -> int:
        if services is None:
            raise RuntimeError(runtime_error)
        models = await asyncio.wait_for(
            services.ollama.list_models(),
            timeout=2.0,
        )
        if not isinstance(models, list):
            raise RuntimeError("Ollama 模型响应格式异常")
        return len(models)

    conversations, controls, knowledge, model_count = await asyncio.gather(
        _load_metric("Dify 会话接口", _get_conversations_count),
        _load_metric("平台设备控制日志", _get_controls_count),
        _load_metric("Dify Dataset 接口", _get_knowledge_count),
        _load_metric("Ollama 模型接口", _get_model_count),
    )

    return {
        "conversations_today": conversations[0],
        "controls_today": controls[0],
        "knowledge_docs": knowledge[0],
        "model_count": model_count[0],
        "sources": {
            "conversations_today": conversations[1],
            "controls_today": controls[1],
            "knowledge_docs": knowledge[1],
            "model_count": model_count[1],
        },
        "scopes": {
            "conversations_today": "self",
            "controls_today": "all" if _user.get("role") == "admin" else "self",
            "knowledge_docs": "platform",
            "model_count": "platform",
        },
    }


# ══════════════════════════════════════════════
#  5. 传感器真实历史数据
# ══════════════════════════════════════════════

# 业务指标定义；具体实体必须从平台已纳管的真实设备映射中解析。
SENSOR_DEFINITIONS = {
    "temperature": {"label": "室内温度", "unit": "°C"},
    "humidity": {"label": "室内湿度", "unit": "%"},
    "pm25": {"label": "PM2.5", "unit": "μg/m³"},
}


def _sensor_metric(role: str, metadata: dict, unit: str) -> str:
    text = " ".join((role, str(metadata.get("device_class") or ""), unit)).lower()
    if any(value in text for value in ("pm25", "pm2.5", "pm2_5")):
        return "pm25"
    if "humidity" in text or "湿度" in text:
        return "humidity"
    if "temperature" in text or "温度" in text or "°c" in text:
        return "temperature"
    return ""


async def _load_monitor_sensor_map(db: AsyncSession) -> dict[str, dict]:
    """只选择有 HA 设备归属的已纳管传感器，排除沙盘 Helper 和猜测实体。"""
    result = await db.execute(
        select(ManagedDevice)
        .options(selectinload(ManagedDevice.mappings))
        .where(ManagedDevice.enabled.is_(True))
        .order_by(ManagedDevice.id)
    )
    devices = result.scalars().unique().all()
    resolved: dict[str, dict] = {}
    for device in devices:
        for mapping in device.mappings:
            metadata = mapping.mapping_metadata or {}
            if (
                mapping.gateway_type != "homeassistant"
                or not str(mapping.endpoint or "").startswith("sensor.")
                or not metadata.get("ha_device_id")
            ):
                continue
            metric = _sensor_metric(mapping.role or "", metadata, mapping.unit or "")
            if not metric or metric in resolved:
                continue
            definition = SENSOR_DEFINITIONS[metric]
            resolved[metric] = {
                "entity_id": mapping.endpoint,
                "label": definition["label"],
                "unit": mapping.unit or definition["unit"],
                "device_name": device.name,
                "device_location": device.location,
            }
    return resolved

AGENT_ROLE_KEYWORDS = {
    "power": ("power", "电源", "开关", "启停"),
    "brightness": ("brightness", "亮度"),
    "color_temperature": ("color temperature", "color_temperature", "色温"),
    "temperature": ("temperature", "temp", "温度"),
    "humidity": ("humidity", "湿度"),
    "pm25": ("pm25", "pm2.5", "空气质量"),
    "position": ("position", "位置", "开合度"),
    "effect": ("effect", "灯效", "效果"),
}

AGENT_CATEGORY_KEYWORDS = {
    "light": ("light", "灯", "照明"),
    "climate": ("climate", "空调", "温控"),
    "cover": ("cover", "窗帘", "卷帘"),
    "lock": ("lock", "门锁", "锁"),
    "sensor": ("sensor", "传感器"),
    "switch": ("switch", "开关"),
    "fan": ("fan", "风扇"),
}


def _contains_keyword(text: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword.lower() in text for keyword in keywords)


def _resolve_agent_entity_from_inventory(
    metric: str,
    query: str,
    entity_id: str,
    inventory: list[dict],
) -> str:
    """只从平台动态设备台账解析查询实体，不接受模型猜测的 HA 实体。"""
    requested_entity = entity_id.strip()
    if requested_entity:
        if any(item["entity_id"] == requested_entity for item in inventory):
            return requested_entity
        raise HTTPException(status_code=404, detail=f"实体 {requested_entity} 未纳入平台动态设备台账")

    if not inventory:
        raise HTTPException(status_code=404, detail="平台动态设备台账为空，请先从 Home Assistant 同步并导入设备")

    text = f"{metric} {query}".strip().lower()
    scored: list[tuple[int, dict]] = []
    for item in inventory:
        score = 0
        name = str(item.get("device_name") or "").strip().lower()
        location = str(item.get("location") or "").strip().lower()
        category = str(item.get("category") or "").strip().lower()
        role = str(item.get("role") or "").strip().lower()

        if name and name in text:
            score += 100
        if location and location in text:
            score += 20
        if category in AGENT_CATEGORY_KEYWORDS and _contains_keyword(text, AGENT_CATEGORY_KEYWORDS[category]):
            score += 15
        if role in AGENT_ROLE_KEYWORDS and _contains_keyword(text, AGENT_ROLE_KEYWORDS[role]):
            score += 30
        if role == "power" and any(word in text for word in ("状态", "开启", "打开", "关闭")):
            score += 10
        if score:
            scored.append((score, item))

    if not scored:
        names = "、".join(dict.fromkeys(str(item.get("device_name") or "") for item in inventory if item.get("device_name")))
        raise HTTPException(status_code=404, detail=f"未从动态设备台账匹配到查询对象；当前设备：{names or '无'}")

    best_score = max(score for score, _item in scored)
    best = [item for score, item in scored if score == best_score]
    best_entities = list(dict.fromkeys(item["entity_id"] for item in best))
    if len(best_entities) != 1:
        candidates = "、".join(dict.fromkeys(str(item.get("device_name") or item["entity_id"]) for item in best))
        raise HTTPException(status_code=409, detail=f"查询对象不唯一，请指定设备名称或实体；候选：{candidates}")
    return best_entities[0]


async def _resolve_agent_entity(db: AsyncSession, metric: str, query: str, entity_id: str = "") -> str:
    result = await db.execute(
        select(ManagedDevice)
        .options(selectinload(ManagedDevice.mappings))
        .where(ManagedDevice.enabled.is_(True))
        .order_by(ManagedDevice.id)
    )
    inventory = [
        {
            "device_name": device.name,
            "location": device.location,
            "category": device.category,
            "role": mapping.role,
            "entity_id": mapping.endpoint,
        }
        for device in result.scalars().unique().all()
        for mapping in device.mappings
        if mapping.gateway_type == "homeassistant" and mapping.endpoint
    ]
    return _resolve_agent_entity_from_inventory(metric, query, entity_id, inventory)


def _resolve_agent_hours(query: str, hours: int) -> int:
    text = query.lower()
    if "7天" in text or "一周" in text or "本周" in text:
        hours = 168
    elif "3天" in text or "三天" in text:
        hours = 72
    elif "48" in text or "两天" in text:
        hours = 48
    return max(1, min(hours, 168))


def _resolve_agent_query_type(query: str, metric: str, query_type: str) -> str:
    if query_type and query_type != "auto":
        return query_type
    text = f"{query} {metric}".lower()
    if any(word in text for word in ["服务", "系统健康", "平台健康", "service", "system health", "health check"]):
        return "services"
    if any(word in text for word in ["历史", "趋势", "最近", "过去", "本周", "7天", "history", "trend"]):
        sensor_keywords = ("temperature", "temp", "温度", "humidity", "湿度", "pm25", "pm2.5", "空气质量")
        return "sensor_history" if any(word in text for word in sensor_keywords) else "device_history"
    return "realtime"


def _parse_agent_metric_payload(metric: str) -> dict:
    """兼容 Dify 参数提取节点输出的 JSON 文本。"""
    if not metric:
        return {}
    try:
        json_match = re.search(r"\{.*\}", metric, re.DOTALL)
        if not json_match:
            return {}
        parsed = json.loads(json_match.group())
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


@router.get("/device-realtime", summary="实时状态数据")
async def device_realtime(
    entity_id: str = Query(..., description="设备实体 ID"),
    _user=Depends(get_agent_or_user),
    db: AsyncSession = Depends(get_db),
):
    """查询单个设备的实时状态数据"""
    services = await get_runtime_services(db)
    try:
        raw = await services.homeassistant.get_state(entity_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"设备实时状态查询失败: {str(e)}")

    if not raw or "entity_id" not in raw:
        raise HTTPException(status_code=404, detail=f"实体 {entity_id} 不存在")

    attributes = raw.get("attributes", {})
    return {
        "entity_id": raw["entity_id"],
        "state": raw.get("state"),
        "name": attributes.get("friendly_name", entity_id),
        "domain": entity_id.split(".")[0],
        "unit": attributes.get("unit_of_measurement", ""),
        "attributes": attributes,
        "last_changed": raw.get("last_changed"),
        "last_updated": raw.get("last_updated"),
    }


@router.get("/device-history", summary="历史数据")
async def device_history(
    entity_id: str = Query(..., description="设备实体 ID"),
    hours: int = Query(24, ge=1, le=168, description="查询最近多少小时"),
    _user=Depends(get_agent_or_user),
    db: AsyncSession = Depends(get_db),
):
    """查询单个设备的历史数据"""
    now = datetime.now()
    start_time = (now - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")
    end_time = now.strftime("%Y-%m-%dT%H:%M:%S")

    services = await get_runtime_services(db)
    try:
        raw = await services.homeassistant.get_history([entity_id], start_time, end_time)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"设备历史数据查询失败: {str(e)}")

    history_points: list[dict[str, str]] = []
    series = raw[0] if raw else []
    for point in series:
        history_points.append(
            {
                "state": str(point.get("state", "")),
                "time": str(point.get("last_changed", ""))[:19],
            }
        )

    return {
        "entity_id": entity_id,
        "hours": hours,
        "history": history_points,
        "count": len(history_points),
    }


@router.get("/device-runtime", summary="设备运行信息")
async def device_runtime(
    entity_id: str = Query(..., description="设备实体 ID"),
    _user=Depends(get_agent_or_user),
    db: AsyncSession = Depends(get_db),
):
    """查询单个设备的运行信息"""
    services = await get_runtime_services(db)
    try:
        raw = await services.homeassistant.get_state(entity_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"设备运行信息查询失败: {str(e)}")

    if not raw or "entity_id" not in raw:
        raise HTTPException(status_code=404, detail=f"实体 {entity_id} 不存在")

    attributes = raw.get("attributes", {})
    return {
        "entity_id": raw["entity_id"],
        "domain": entity_id.split(".")[0],
        "name": attributes.get("friendly_name", entity_id),
        "state": raw.get("state"),
        "unit": attributes.get("unit_of_measurement", ""),
        "last_changed": raw.get("last_changed"),
        "last_updated": raw.get("last_updated"),
        "attributes": attributes,
    }

@router.get("/sensor-history", summary="传感器历史趋势")
async def sensor_history(
    hours: int = Query(24, ge=1, le=168, description="查询最近多少小时"),
    _user=Depends(get_agent_or_user),
    db: AsyncSession = Depends(get_db),
):
    """返回温度、湿度和 PM2.5 的真实历史；没有数据时返回空数组。"""
    now = datetime.now().astimezone()
    start_time = (now - timedelta(hours=hours)).isoformat(timespec="seconds")
    end_time = now.isoformat(timespec="seconds")
    points_target = min(hours * 4, 96)
    window_minutes = max(15, math.ceil(hours * 60 / points_target))
    sensor_map = await _load_monitor_sensor_map(db)

    services = await get_runtime_services(db)
    influx = InfluxDBService(InfluxRuntimeConfig(
        url=services.config.influxdb_url,
        token=services.config.influxdb_token,
        org=services.config.influxdb_org,
        bucket=services.config.influxdb_bucket,
    ))

    async def _query_influx(entity_id: str) -> tuple[list[dict], str, int, bool]:
        try:
            rows = await asyncio.wait_for(
                influx.query_points(
                    hours=hours,
                    entity_id=entity_id,
                    field="value_numeric",
                    window=f"{window_minutes}m",
                    limit=points_target + 1,
                ),
                timeout=2.0,
            )
            points = []
            for row in rows:
                try:
                    points.append({
                        "time": str(row.get("time") or ""),
                        "value": round(float(row.get("value")), 1),
                    })
                except (TypeError, ValueError):
                    continue
            raw_count = len(points)
            return points[:points_target], "", raw_count, raw_count > points_target
        except Exception as exc:
            return [], str(exc)[:240], 0, False

    influx_results = await asyncio.gather(*(
        _query_influx(cfg["entity_id"])
        for cfg in sensor_map.values()
    ))
    influx_history = {
        cfg["entity_id"]: points
        for cfg, (points, _error, _raw_count, _truncated) in zip(sensor_map.values(), influx_results)
        if points
    }
    influx_errors = {
        cfg["entity_id"]: error
        for cfg, (_points, error, _raw_count, _truncated) in zip(sensor_map.values(), influx_results)
        if error
    }
    influx_coverage = {
        cfg["entity_id"]: {"raw_point_count": raw_count, "truncated": truncated}
        for cfg, (_points, _error, raw_count, truncated) in zip(sensor_map.values(), influx_results)
    }

    ha_history: dict[str, list[dict]] = {}
    ha_coverage: dict[str, dict] = {}
    ha_error = ""
    missing_entities = [
        cfg["entity_id"]
        for cfg in sensor_map.values()
        if not influx_history.get(cfg["entity_id"])
    ]
    if missing_entities:
        try:
            raw = await asyncio.wait_for(
                services.homeassistant.get_history(missing_entities, start_time, end_time),
                timeout=4.0,
            )
            for entity_data in raw:
                if not entity_data:
                    continue
                entity_id = str(entity_data[0].get("entity_id") or "")
                points = []
                for point in entity_data:
                    try:
                        points.append({
                            "time": str(point.get("last_changed") or ""),
                            "value": round(float(point.get("state")), 1),
                        })
                    except (TypeError, ValueError):
                        continue
                if points:
                    raw_count = len(points)
                    if raw_count <= points_target:
                        sampled = points
                    elif points_target == 1:
                        sampled = [points[-1]]
                    else:
                        sampled = [
                            points[round(index * (raw_count - 1) / (points_target - 1))]
                            for index in range(points_target)
                        ]
                    ha_history[entity_id] = sampled
                    ha_coverage[entity_id] = {
                        "raw_point_count": raw_count,
                        "truncated": raw_count > len(sampled),
                    }
        except Exception as exc:
            ha_error = str(exc)[:240]

    result: dict = {}
    metrics: dict[str, dict] = {}
    sources: set[str] = set()
    available_count = 0
    for key, definition in SENSOR_DEFINITIONS.items():
        cfg = sensor_map.get(key)
        entity_id = cfg["entity_id"] if cfg else ""
        if influx_history.get(entity_id):
            points = influx_history[entity_id][:points_target]
            source = "influxdb"
            reason = ""
            coverage = influx_coverage.get(entity_id, {})
            aggregation = f"{window_minutes}m_mean"
        elif ha_history.get(entity_id):
            points = ha_history[entity_id]
            source = "home_assistant_history"
            reason = ""
            coverage = ha_coverage.get(entity_id, {})
            aggregation = "even_sample" if coverage.get("truncated") else "raw"
        else:
            points = []
            source = "no_real_data"
            coverage = influx_coverage.get(entity_id, {})
            aggregation = "none"
            if not cfg:
                reason = "平台尚未纳管带真实设备归属的该类传感器，未使用电子沙盘或 Helper 数据替代。"
            elif ha_error:
                reason = f"Home Assistant 历史查询失败：{ha_error}"
            elif influx_errors.get(entity_id):
                reason = "InfluxDB 查询不可用，Home Assistant 也未返回该实体历史。"
            else:
                reason = "InfluxDB 与 Home Assistant 均未返回该实体的真实历史点。"

        result[key] = points
        if points:
            available_count += 1
            sources.add(source)
        metrics[key] = {
            "label": definition["label"],
            "entity_id": entity_id,
            "unit": cfg["unit"] if cfg else definition["unit"],
            "device_name": cfg.get("device_name", "") if cfg else "",
            "device_location": cfg.get("device_location", "") if cfg else "",
            "source": source,
            "point_count": len(points),
            "raw_point_count": int(coverage.get("raw_point_count") or 0),
            "coverage_truncated": bool(coverage.get("truncated")),
            "aggregation": aggregation,
            "first_point_at": points[0]["time"] if points else "",
            "last_point_at": points[-1]["time"] if points else "",
            "missing_reason": reason,
        }

    if available_count == 0:
        data_source = "no_real_data"
        note = "当前时间范围内没有温度、湿度或 PM2.5 的真实历史点，页面不会生成模拟趋势。"
    elif available_count < len(SENSOR_DEFINITIONS) or len(sources) > 1:
        data_source = "partial"
        note = "部分指标有真实历史，缺失指标保持空白。"
    else:
        data_source = next(iter(sources))
        note = "数据全部来自真实时序记录。"

    result["_meta"] = {
        "data_source": data_source,
        "fallback_note": note,
        "hours": hours,
        "requested_start_at": start_time,
        "requested_end_at": end_time,
        "target_points_per_metric": points_target,
        "aggregation_window_minutes": window_minutes,
        "available_metrics": available_count,
        "total_metrics": len(SENSOR_DEFINITIONS),
        "generated": False,
        "metrics": metrics,
    }
    return result


@router.get("/agent-query", summary="Dify 数据查询代理")
async def agent_data_query(
    query: str = Query("", description="用户原始数据查询问题"),
    metric: str = Query("", description="指标名称，如 temperature / humidity / pm25"),
    query_type: str = Query("auto", description="auto / realtime / device_history / sensor_history / services"),
    entity_id: str = Query("", description="可选 HA 实体 ID"),
    hours: int = Query(24, ge=1, le=168, description="历史查询小时数"),
    _user=Depends(get_agent_or_user),
    db: AsyncSession = Depends(get_db),
):
    """供 Dify Workflow 调用的统一数据查询代理，内部复用现有真实监控接口。"""
    parsed = _parse_agent_metric_payload(metric)
    metric = str(parsed.get("metric") or metric or "")
    query_type = str(parsed.get("query_type") or query_type or "auto")
    entity_id = str(parsed.get("entity_id") or entity_id or "")
    try:
        hours = int(parsed.get("hours") or hours)
    except (TypeError, ValueError):
        hours = 24

    resolved_hours = _resolve_agent_hours(query, hours)
    resolved_type = _resolve_agent_query_type(query, metric, query_type)
    resolved_entity = ""
    if resolved_type not in {"services", "sensor_history"}:
        resolved_entity = await _resolve_agent_entity(db, metric, query, entity_id)

    if resolved_type == "services":
        result = await service_health(_user, db)
        source_endpoint = "/api/v1/monitor/services"
        data_source = "platform_service_health"
        fallback_note = ""
    elif resolved_type == "device_history":
        result = await device_history(resolved_entity, resolved_hours, _user, db)
        source_endpoint = "/api/v1/monitor/device-history"
        data_source = "home_assistant_history"
        fallback_note = ""
    elif resolved_type == "sensor_history":
        result = await sensor_history(resolved_hours, _user, db)
        source_endpoint = "/api/v1/monitor/sensor-history"
        meta = result.get("_meta", {}) if isinstance(result, dict) else {}
        data_source = meta.get("data_source", "no_real_data")
        fallback_note = meta.get("fallback_note", "")
    else:
        result = await device_realtime(resolved_entity, _user, db)
        source_endpoint = "/api/v1/monitor/device-realtime"
        data_source = "home_assistant_realtime_state"
        fallback_note = ""

    has_real_data = not (resolved_type == "sensor_history" and data_source == "no_real_data")
    return {
        "status": "success" if has_real_data else "no_real_data",
        "query": query,
        "query_type": resolved_type,
        "metric": metric,
        "entity_id": resolved_entity if resolved_type != "services" else "",
        "hours": resolved_hours if resolved_type in {"device_history", "sensor_history"} else None,
        "data_source": data_source,
        "source_endpoint": source_endpoint,
        "fallback_note": fallback_note,
        "result": result,
    }


# ══════════════════════════════════════════════
#  6. 综合数据（一次请求拿全部大屏数据）
# ══════════════════════════════════════════════

@router.get("/dashboard", summary="监控大屏全量数据")
async def monitor_dashboard(
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """用独立数据库会话并行聚合，避免离线服务的超时依次叠加。"""

    async def _with_session(loader):
        async with AsyncSessionLocal() as task_db:
            return await loader(task_db)

    resources, ai, services, activity, sensor, logs = await asyncio.gather(
        system_resources(_user),
        _with_session(lambda task_db: ai_status(_user, task_db)),
        _with_session(lambda task_db: service_health(_user, task_db)),
        _with_session(lambda task_db: today_activity(_user, task_db)),
        _with_session(lambda task_db: sensor_history(24, _user, task_db)),
        _with_session(lambda task_db: recent_logs(
            limit=10,
            page=1,
            size=None,
            type="",
            level="",
            keyword="",
            start_time="",
            end_time="",
            user=_user,
            db=task_db,
        )),
    )

    return {
        "resources": resources,
        "ai_status": ai,
        "services": services["services"],
        "activity": activity,
        "sensor_history": sensor,
        "logs": logs["logs"],
        "timestamp": datetime.now().isoformat(),
    }


# ══════════════════════════════════════════════
#  7. 操作日志
# ══════════════════════════════════════════════

def _parse_log_time(value: str, label: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{label}格式无效，请使用 ISO 日期时间") from exc


def _operation_log_filters(
    log_type: str,
    level: str,
    keyword: str,
    start_time: str,
    end_time: str,
) -> list:
    filters = []
    if log_type:
        filters.append(OperationLog.type == log_type)
    if level:
        filters.append(OperationLog.level == level)
    if keyword.strip():
        like = f"%{keyword.strip()}%"
        filters.append(or_(
            OperationLog.title.ilike(like),
            OperationLog.detail.ilike(like),
            OperationLog.username.ilike(like),
            OperationLog.type.ilike(like),
            OperationLog.entity_id.ilike(like),
        ))
    start_dt = _parse_log_time(start_time, "开始时间")
    end_dt = _parse_log_time(end_time, "结束时间")
    if start_dt and end_dt and start_dt > end_dt:
        raise HTTPException(status_code=422, detail="开始时间不能晚于结束时间")
    if start_dt:
        filters.append(OperationLog.created_at >= start_dt)
    if end_dt:
        filters.append(OperationLog.created_at <= end_dt)
    return filters


def _operation_log_scope_filters(user: dict) -> list:
    """管理员可查看全平台日志，普通用户只可查看自己的运行记录。"""
    if user.get("role") == "admin":
        return []
    return [OperationLog.user_id == user.get("user_id")]


def _relative_log_time(value: datetime | None) -> str:
    if not value:
        return "未知"
    delta = datetime.now() - value
    if delta.total_seconds() < 60:
        return "刚刚"
    if delta.total_seconds() < 3600:
        return f"{int(delta.total_seconds() // 60)} 分钟前"
    if delta.total_seconds() < 86400:
        return f"{int(delta.total_seconds() // 3600)} 小时前"
    return f"{int(delta.days)} 天前"


def _serialize_operation_log(row: OperationLog) -> dict:
    return {
        "id": row.id,
        "type": row.type,
        "level": row.level,
        "title": business_log_title(row.title),
        "summary": business_log_summary(row.type, row.detail),
        "detail": row.detail or "",
        "username": row.username or "",
        "entity_id": row.entity_id or "",
        "time": _relative_log_time(row.created_at),
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _serialize_grouped_operation_log(row) -> dict:
    payload = dict(row._mapping if hasattr(row, "_mapping") else row)
    created_at = payload.get("created_at")
    return {
        "id": payload.get("id"),
        "type": payload.get("type"),
        "level": payload.get("level"),
        "title": business_log_title(payload.get("title")),
        "summary": business_log_summary(payload.get("type"), payload.get("detail")),
        "detail": payload.get("detail") or "",
        "username": payload.get("username") or "",
        "entity_id": payload.get("entity_id") or "",
        "time": _relative_log_time(created_at),
        "created_at": created_at.isoformat() if created_at else None,
        "repeat_count": int(payload.get("repeat_count") or 1),
    }


def _collapsed_operation_log_query(filters: list):
    """仅按采集阶段折叠周期告警；其他业务日志仍保持逐条审计。"""
    signature_position = func.instr(OperationLog.detail, "signature=")
    periodic_failure = and_(
        OperationLog.type == "time_series",
        OperationLog.level == "warning",
        OperationLog.title == "时序数据自动采集失败",
        OperationLog.username == "system",
        signature_position > 0,
    )
    periodic_stage = case(
        (
            OperationLog.detail.contains("Home Assistant 状态采集失败"),
            literal("home_assistant_read"),
        ),
        (
            OperationLog.detail.contains("InfluxDB 写入失败"),
            literal("influxdb_write"),
        ),
        else_=func.substr(OperationLog.detail, signature_position + len("signature=")),
    )
    group_key = case(
        (
            periodic_failure,
            literal("periodic:time_series:")
            + periodic_stage,
        ),
        else_=literal("log:") + cast(OperationLog.id, String),
    ).label("group_key")
    source = select(
        OperationLog.id,
        OperationLog.type,
        OperationLog.level,
        OperationLog.title,
        OperationLog.detail,
        OperationLog.username,
        OperationLog.entity_id,
        OperationLog.created_at,
        group_key,
    ).where(*filters).subquery("operation_log_group_source")
    ranked = select(
        source,
        func.count().over(partition_by=source.c.group_key).label("repeat_count"),
        func.row_number().over(
            partition_by=source.c.group_key,
            order_by=(source.c.created_at.desc(), source.c.id.desc()),
        ).label("group_rank"),
    ).subquery("operation_log_group_ranked")
    return select(ranked).where(ranked.c.group_rank == 1)


def _csv_cell(value) -> str:
    text_value = str(value or "")
    if text_value.startswith(("=", "+", "-", "@")):
        return f"'{text_value}"
    return text_value


def _operation_log_level_label(value: str) -> str:
    return {
        "success": "成功",
        "warning": "警告",
        "error": "错误",
        "info": "信息",
    }.get(value, "其他等级")


def _operation_log_type_label(value: str) -> str:
    return business_log_type(value)


def _operation_log_retention_filter(now: datetime, normal_days: int, error_days: int):
    normal_cutoff = now - timedelta(days=normal_days)
    error_cutoff = now - timedelta(days=error_days)
    return or_(
        and_(OperationLog.level != "error", OperationLog.created_at < normal_cutoff),
        and_(OperationLog.level == "error", OperationLog.created_at < error_cutoff),
    ), normal_cutoff, error_cutoff


async def _operation_log_cleanup_preview(
    db: AsyncSession,
    *,
    normal_days: int = OPERATION_LOG_RETENTION_DAYS,
    error_days: int = OPERATION_LOG_ERROR_RETENTION_DAYS,
    now: datetime | None = None,
) -> dict:
    reference_time = now or datetime.now()
    stale_filter, normal_cutoff, error_cutoff = _operation_log_retention_filter(
        reference_time,
        normal_days,
        error_days,
    )
    total = int((await db.execute(select(func.count(OperationLog.id)))).scalar() or 0)
    deletable = int((await db.execute(
        select(func.count(OperationLog.id)).where(stale_filter)
    )).scalar() or 0)
    oldest = (await db.execute(select(func.min(OperationLog.created_at)))).scalar_one_or_none()
    return {
        "normal_days": normal_days,
        "error_days": error_days,
        "normal_cutoff": normal_cutoff.isoformat(),
        "error_cutoff": error_cutoff.isoformat(),
        "total": total,
        "deletable": deletable,
        "retained": max(0, total - deletable),
        "oldest_at": oldest.isoformat() if oldest else None,
    }


async def _prune_operation_logs(
    db: AsyncSession,
    *,
    normal_days: int = OPERATION_LOG_RETENTION_DAYS,
    error_days: int = OPERATION_LOG_ERROR_RETENTION_DAYS,
    now: datetime | None = None,
) -> int:
    stale_filter, _, _ = _operation_log_retention_filter(
        now or datetime.now(),
        normal_days,
        error_days,
    )
    result = await db.execute(delete(OperationLog).where(stale_filter))
    await db.commit()
    return int(result.rowcount or 0)


async def run_operation_log_retention() -> None:
    """每日清理过期操作日志；近期业务记录和长周期错误证据仍保留。"""
    while True:
        await asyncio.sleep(OPERATION_LOG_RETENTION_INTERVAL_SECONDS)
        try:
            async with AsyncSessionLocal() as db:
                await _prune_operation_logs(db)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"操作日志保留策略执行失败: {exc}")


@router.get("/logs/retention", summary="预览操作日志保留策略")
async def preview_operation_log_retention(
    normal_days: int = Query(OPERATION_LOG_RETENTION_DAYS, ge=30, le=365),
    error_days: int = Query(OPERATION_LOG_ERROR_RETENTION_DAYS, ge=90, le=730),
    _user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if error_days < normal_days:
        raise HTTPException(status_code=422, detail="错误日志保留天数不能少于普通日志")
    return await _operation_log_cleanup_preview(
        db,
        normal_days=normal_days,
        error_days=error_days,
    )


@router.post("/logs/retention/cleanup", summary="清理过期操作日志")
async def cleanup_operation_log_retention(
    payload: OperationLogCleanupRequest,
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if payload.error_days < payload.normal_days:
        raise HTTPException(status_code=422, detail="错误日志保留天数不能少于普通日志")
    if payload.confirmation.strip() != OPERATION_LOG_CLEANUP_CONFIRMATION:
        raise HTTPException(status_code=422, detail=f"请输入确认词“{OPERATION_LOG_CLEANUP_CONFIRMATION}”")
    preview = await _operation_log_cleanup_preview(
        db,
        normal_days=payload.normal_days,
        error_days=payload.error_days,
    )
    deleted = await _prune_operation_logs(
        db,
        normal_days=payload.normal_days,
        error_days=payload.error_days,
    )
    db.add(OperationLog(
        type="system_settings",
        level="info",
        title="管理员执行过期操作日志清理",
        detail=(
            f"deleted={deleted}; normal_days={payload.normal_days}; "
            f"error_days={payload.error_days}; preview_total={preview['total']}"
        ),
        user_id=user.get("user_id"),
        username=user.get("username", ""),
    ))
    await db.commit()
    return {
        "success": True,
        "deleted": deleted,
        "normal_days": payload.normal_days,
        "error_days": payload.error_days,
        "remaining": max(0, preview["total"] - deleted) + 1,
    }


@router.get("/logs", summary="最近操作日志")
async def recent_logs(
    limit: int = Query(10, ge=1, le=50),
    page: int = Query(1, ge=1, description="页码"),
    size: Optional[int] = Query(None, ge=1, le=100, description="每页条数；不传时兼容 limit"),
    type: str = Query("", description="日志类型过滤，如 user_management / model_inference"),
    level: str = Query("", description="等级过滤: success / warning / error / info"),
    keyword: str = Query("", description="关键词，匹配标题、详情、用户、类型"),
    start_time: str = Query("", description="开始时间 ISO 字符串"),
    end_time: str = Query("", description="结束时间 ISO 字符串"),
    collapse_periodic: bool = False,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """从 operation_logs 表分页查询操作记录，统计口径与当前筛选一致。"""
    try:
        scope_filters = _operation_log_scope_filters(user)
        filters = [*scope_filters, *_operation_log_filters(type, level, keyword, start_time, end_time)]
        query = select(OperationLog).where(*filters)

        count_result = await db.execute(select(func.count()).select_from(query.subquery()))
        raw_total = count_result.scalar() or 0
        visible_query = _collapsed_operation_log_query(filters) if collapse_periodic else query
        if collapse_periodic:
            visible_count_result = await db.execute(
                select(func.count()).select_from(visible_query.subquery())
            )
            total = visible_count_result.scalar() or 0
        else:
            total = raw_total
        page_size = size or limit
        page_count = max(1, (total + page_size - 1) // page_size)
        safe_page = min(page, page_count)
        offset = (safe_page - 1) * page_size

        order_created_at = (
            visible_query.selected_columns.created_at
            if collapse_periodic
            else OperationLog.created_at
        )
        order_id = visible_query.selected_columns.id if collapse_periodic else OperationLog.id
        result = await db.execute(
            visible_query
            .order_by(order_created_at.desc(), order_id.desc())
            .offset(offset)
            .limit(page_size)
        )
        rows = result.all() if collapse_periodic else result.scalars().all()

        stats_result = await db.execute(
            select(OperationLog.level, func.count(OperationLog.id))
            .where(*filters)
            .group_by(OperationLog.level)
        )
        level_counts = {level_name or "info": count for level_name, count in stats_result.all()}
        latest_result = await db.execute(
            select(OperationLog.created_at)
            .where(*filters)
            .order_by(OperationLog.created_at.desc())
            .limit(1)
        )
        latest_at = latest_result.scalar_one_or_none()
        type_result = await db.execute(
            select(OperationLog.type, func.count(OperationLog.id))
            .where(*scope_filters)
            .group_by(OperationLog.type)
            .order_by(func.count(OperationLog.id).desc(), OperationLog.type)
        )

        return {
            "logs": [
                _serialize_grouped_operation_log(row) if collapse_periodic else _serialize_operation_log(row)
                for row in rows
            ],
            "total": total,
            "raw_total": raw_total,
            "collapsed_count": max(0, raw_total - total),
            "collapse_periodic": collapse_periodic,
            "page": safe_page,
            "size": page_size,
            "page_count": page_count,
            "stats": {
                "total": raw_total,
                "success": level_counts.get("success", 0),
                "warning": level_counts.get("warning", 0),
                "error": level_counts.get("error", 0),
                "info": level_counts.get("info", 0),
                "latest_at": latest_at.isoformat() if latest_at else None,
                "scope": "filtered",
            },
            "type_facets": [
                {"value": type_name, "count": count}
                for type_name, count in type_result.all()
            ],
            "visibility_scope": "all" if user.get("role") == "admin" else "self",
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"操作日志查询失败: {exc}") from exc


@router.get("/logs/export", summary="导出操作日志")
async def export_logs(
    type: str = Query("", description="日志类型过滤"),
    level: str = Query("", description="日志等级过滤"),
    keyword: str = Query("", description="关键词过滤"),
    start_time: str = Query("", description="开始时间 ISO 字符串"),
    end_time: str = Query("", description="结束时间 ISO 字符串"),
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """导出当前筛选范围，单次最多 10000 条，避免大查询耗尽服务内存。"""
    try:
        filters = [
            *_operation_log_scope_filters(user),
            *_operation_log_filters(type, level, keyword, start_time, end_time),
        ]
        result = await db.execute(
            select(OperationLog)
            .where(*filters)
            .order_by(OperationLog.created_at.desc())
            .limit(10001)
        )
        rows = result.scalars().all()
        truncated = len(rows) > 10000
        rows = rows[:10000]

        output = io.StringIO()
        output.write("\ufeff")
        writer = csv.writer(output)
        writer.writerow(["日志ID", "时间", "等级", "类型", "标题", "业务摘要", "用户", "关联对象", "技术详情", "原始等级", "原始类型"])
        for row in rows:
            writer.writerow([
                row.id,
                row.created_at.isoformat() if row.created_at else "",
                _operation_log_level_label(row.level),
                _operation_log_type_label(row.type),
                _csv_cell(business_log_title(row.title)),
                _csv_cell(business_log_summary(row.type, row.detail)),
                _csv_cell(row.username),
                _csv_cell(row.entity_id),
                _csv_cell(row.detail),
                _csv_cell(row.level),
                _csv_cell(row.type),
            ])

        filename = f"operation-logs-{datetime.now().strftime('%Y%m%d-%H%M%S')}.csv"
        return Response(
            content=output.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Export-Count": str(len(rows)),
                "X-Export-Truncated": "true" if truncated else "false",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"操作日志导出失败: {exc}") from exc


# ══════════════════════════════════════════════
#  8. 操作日志统计（对话趋势图用）
# ══════════════════════════════════════════════

@router.get("/control-trends", summary="控制操作趋势")
async def control_trends(
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    按小时统计今日和昨日的设备控制操作量
    用于对话趋势柱状图
    """
    now = datetime.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_start = today_start - timedelta(days=1)

    hours = [f"{h:02d}:00" for h in range(0, 24, 2)]  # 12 个时间段
    scope_filters = _operation_log_scope_filters(user)

    async def _count_by_hour(start: datetime, end: datetime) -> dict:
        """Group by 2h 统计"""
        result = await db.execute(
            select(OperationLog.created_at).where(
                OperationLog.type == "device_control",
                OperationLog.level == "success",
                OperationLog.created_at >= start,
                OperationLog.created_at < end,
                *scope_filters,
            )
        )
        rows = result.scalars().all()
        buckets: dict = {h: 0 for h in hours}
        for ts in rows:
            if ts:
                bucket = f"{(ts.hour // 2) * 2:02d}:00"
                if bucket in buckets:
                    buckets[bucket] += 1
        return buckets

    try:
        today_data, yesterday_data = await asyncio.gather(
            _count_by_hour(today_start, now),
            _count_by_hour(yesterday_start, today_start),
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail="设备控制趋势暂时无法读取，请稍后重试") from exc

    return {
        "hours": hours,
        "today": [today_data.get(h, 0) for h in hours],
        "yesterday": [yesterday_data.get(h, 0) for h in hours],
        "visibility_scope": "all" if user.get("role") == "admin" else "self",
    }
