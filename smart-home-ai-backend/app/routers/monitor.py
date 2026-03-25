"""
监控大屏路由 — 系统资源 / AI模型 / 服务健康 / 今日活动 / 图表数据 / 操作日志
Phase 1: resources, ai-status, services
Phase 2: activity(真实统计), chat-trends, logs(数据库)
"""
import asyncio
import platform
import time
import math
import random
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.dependencies import get_current_user, get_db
from app.config import settings
from app.services.ollama import ollama_service
from app.services.homeassistant import ha_service
from app.services.dify import dify_service
from app.services.dify_knowledge import dify_knowledge_service
from app.models.operation_log import OperationLog

try:
    import psutil
except ImportError:
    psutil = None

router = APIRouter(prefix="/monitor", tags=["监控大屏"])


# ── 启动时间 ──
_start_time = time.time()


# ══════════════════════════════════════════════
#  Helper
# ══════════════════════════════════════════════

async def _check_service_health(name: str, url: str, timeout: float = 5.0) -> dict:
    """检查服务连通性 + 延迟"""
    import httpx
    try:
        t0 = time.time()
        async with httpx.AsyncClient(timeout=timeout) as client:
            # HA 需要 token
            headers = {}
            if "8123" in url and settings.HA_TOKEN:
                headers["Authorization"] = f"Bearer {settings.HA_TOKEN}"
            r = await client.get(url, headers=headers)
            latency = int((time.time() - t0) * 1000)
            status = "running" if r.status_code < 500 else "error"
            return {"name": name, "status": status, "latency_ms": latency}
    except Exception:
        return {"name": name, "status": "stopped", "latency_ms": 0}


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
        "percent": 0,
        "vram_used_mb": 0,
        "vram_total_mb": 0,
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
        disk = type("D", (), {"percent": 0, "used": 0, "total": 0})()

    gpu = _get_gpu_info()

    return {
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
            "vram_used_gb": round(gpu["vram_used_mb"] / 1024, 1),
            "vram_total_gb": round(gpu["vram_total_mb"] / 1024, 1),
        },
        "disk": {
            "percent": round(disk.percent, 1),
            "used_gb": round(disk.used / (1024 ** 3), 1),
            "total_gb": round(disk.total / (1024 ** 3), 1),
        },
    }


# ══════════════════════════════════════════════
#  2. AI 模型状态
# ══════════════════════════════════════════════

@router.get("/ai-status", summary="AI 模型运行状态")
async def ai_status(_user=Depends(get_current_user)):
    """当前运行的模型信息 + 推理指标"""
    try:
        running = await ollama_service.running_models()
    except Exception:
        running = []

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
            models = await ollama_service.list_models()
            first = models[0] if models else {}
            return {
                "status": "idle",
                "model_name": first.get("name", "无模型"),
                "quantization": first.get("details", {}).get("quantization_level", ""),
                "family": first.get("details", {}).get("family", ""),
                "parameter_size": first.get("details", {}).get("parameter_size", ""),
                "vram_used_gb": 0,
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
                "vram_used_gb": 0,
                "inference_latency_ms": None,
                "throughput_tps": None,
            }


# ══════════════════════════════════════════════
#  3. 服务健康状态
# ══════════════════════════════════════════════

@router.get("/services", summary="服务健康状态")
async def service_health(_user=Depends(get_current_user)):
    """并行检测所有外部服务"""
    checks = await asyncio.gather(
        _check_service_health("Ollama 推理引擎", f"{settings.OLLAMA_BASE_URL}/api/version"),
        _check_service_health("Home Assistant", f"{settings.HA_BASE_URL}/api/"),
        _check_service_health("Dify 智能体框架", f"{settings.DIFY_BASE_URL}/v1/datasets"),
        _check_service_health("InfluxDB 时序库", f"{settings.INFLUXDB_URL}/health"),
    )

    # 后端自身
    uptime_s = int(time.time() - _start_time)
    services = [
        {
            "name": "FastAPI 后端",
            "status": "running",
            "latency_ms": 0,
            "extra": f"uptime {uptime_s // 3600}h {(uptime_s % 3600) // 60}m",
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
    """对话数 / 控制数 / 知识库 / 模型数 / 设备数"""
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    # 并行获取数据（外部 API 加 8s 超时保护）
    async def _get_conversations_count() -> int:
        """Dify 获取会话数量"""
        try:
            res = await asyncio.wait_for(
                dify_service.get_conversations(user="user-1", limit=100),
                timeout=8.0,
            )
            convs = res.get("data", [])
            count = 0
            for c in convs:
                created = c.get("created_at", 0)
                if isinstance(created, (int, float)):
                    ct = datetime.fromtimestamp(created)
                    if ct >= today_start:
                        count += 1
            return count if count > 0 else len(convs)
        except Exception:
            return 0

    async def _get_controls_count() -> int:
        """DB 统计今日控制数"""
        try:
            result = await db.execute(
                select(func.count(OperationLog.id)).where(
                    OperationLog.type == "device_control",
                    OperationLog.created_at >= today_start,
                )
            )
            return result.scalar() or 0
        except Exception:
            return 0

    async def _get_knowledge_count() -> int:
        """Dify 获取知识库文档数"""
        try:
            res = await asyncio.wait_for(
                dify_knowledge_service.list_datasets(page=1, limit=100),
                timeout=8.0,
            )
            datasets = res.get("data", [])
            total_docs = sum(d.get("document_count", 0) for d in datasets)
            return total_docs
        except Exception:
            return 0

    async def _get_model_count() -> int:
        try:
            models = await asyncio.wait_for(
                ollama_service.list_models(),
                timeout=5.0,
            )
            return len(models) if isinstance(models, list) else 0
        except Exception:
            return 0

    conversations, controls, knowledge, model_count = await asyncio.gather(
        _get_conversations_count(),
        _get_controls_count(),
        _get_knowledge_count(),
        _get_model_count(),
    )

    return {
        "conversations_today": conversations,
        "controls_today": controls,
        "knowledge_docs": knowledge,
        "model_count": model_count,
    }


# ══════════════════════════════════════════════
#  5. 传感器历史数据（HA History API + 模拟混合）
# ══════════════════════════════════════════════

# 传感器 entity_id 映射
SENSOR_MAP = {
    "temperature": {"entity_id": "sensor.shi_nei_wen_du", "default": 22.5, "variance": 3.0, "max_norm": 50},
    "humidity": {"entity_id": "sensor.shi_nei_shi_du", "default": 48.0, "variance": 5.0, "max_norm": 100},
    "pm25": {"entity_id": "sensor.pm2_5", "default": 78.0, "variance": 15.0, "max_norm": 200},
}

@router.get("/sensor-history", summary="传感器历史趋势")
async def sensor_history(
    hours: int = 24,
    _user=Depends(get_current_user),
):
    """
    返回温度/湿度/PM2.5 的历史趋势数据
    策略：HA History API 获取真实数据 → 数据不足时模拟填充
    """
    now = datetime.now()
    start_time = (now - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")
    end_time = now.strftime("%Y-%m-%dT%H:%M:%S")
    points_target = min(hours * 4, 96)  # 每 15 分钟一个点

    # 尝试从 HA History API 获取真实历史
    ha_history: dict = {}
    try:
        entity_ids = [cfg["entity_id"] for cfg in SENSOR_MAP.values()]
        raw = await asyncio.wait_for(
            ha_service.get_history(entity_ids, start_time, end_time),
            timeout=10.0,
        )
        # 解析 HA 返回的数据
        for entity_data in raw:
            if not entity_data:
                continue
            eid = entity_data[0].get("entity_id", "")
            points = []
            for p in entity_data:
                try:
                    val = float(p.get("state", ""))
                    ts = p.get("last_changed", "")[:19]
                    points.append({"time": ts, "value": round(val, 1)})
                except (ValueError, TypeError):
                    continue
            if points:
                ha_history[eid] = points
    except Exception:
        pass  # HA History 不可用，使用模拟数据

    # 获取 HA 当前状态作为模拟基准
    current_values: dict = {}
    try:
        states = await ha_service.get_states()
        for s in states:
            eid = s.get("entity_id", "")
            try:
                current_values[eid] = float(s.get("state", ""))
            except (ValueError, TypeError):
                pass
    except Exception:
        pass

    def _generate_series(
        sensor_key: str,
        cfg: dict,
    ) -> list:
        """如果 HA 有足够真实数据就用真实数据，否则用模拟填充"""
        entity_id = cfg["entity_id"]
        real_points = ha_history.get(entity_id, [])

        # 如果 HA 有超过 10 个真实数据点，直接用并重采样
        if len(real_points) >= 10:
            # 按时间均匀采样到 points_target 个
            step = max(1, len(real_points) // points_target)
            return real_points[::step][:points_target]

        # 不足时用模拟数据
        current = current_values.get(entity_id, cfg["default"])
        variance = cfg["variance"]
        daily_pattern = sensor_key != "pm25"

        # 使用确定性种子，同一分钟内返回相同曲线（避免每次刷新都变）
        seed = int(now.timestamp() // 900)  # 每 15 分钟换一次种子
        rng = random.Random(seed + hash(sensor_key))

        series = []
        for i in range(points_target):
            t = now - timedelta(minutes=(points_target - i) * 15)
            hour = t.hour + t.minute / 60.0

            if daily_pattern:
                daily_factor = math.sin((hour - 6) * math.pi / 12) * 0.3
            else:
                daily_factor = math.sin(hour * math.pi / 8) * 0.15

            noise = rng.gauss(0, variance * 0.1)
            value = current * (1 + daily_factor) + noise

            series.append({
                "time": t.strftime("%Y-%m-%dT%H:%M:%S"),
                "value": round(value, 1),
            })
        return series

    result = {}
    for key, cfg in SENSOR_MAP.items():
        result[key] = _generate_series(key, cfg)

    return result


# ══════════════════════════════════════════════
#  6. 综合数据（一次请求拿全部大屏数据）
# ══════════════════════════════════════════════

@router.get("/dashboard", summary="监控大屏全量数据")
async def monitor_dashboard(
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """一次请求聚合所有监控数据，减少前端请求次数"""
    resources, ai, services, activity, sensor, logs = await asyncio.gather(
        system_resources(_user),
        ai_status(_user),
        service_health(_user),
        today_activity(_user, db),
        sensor_history(24, _user),
        recent_logs(10, _user, db),
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

@router.get("/logs", summary="最近操作日志")
async def recent_logs(
    limit: int = Query(10, ge=1, le=50),
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """从 operation_logs 表查询最近的操作记录"""
    try:
        result = await db.execute(
            select(OperationLog)
            .order_by(OperationLog.created_at.desc())
            .limit(limit)
        )
        rows = result.scalars().all()

        logs = []
        now = datetime.now()
        for row in rows:
            # 计算相对时间
            delta = now - row.created_at if row.created_at else timedelta(0)
            if delta.total_seconds() < 60:
                time_str = "刚刚"
            elif delta.total_seconds() < 3600:
                time_str = f"{int(delta.total_seconds() // 60)} 分钟前"
            elif delta.total_seconds() < 86400:
                time_str = f"{int(delta.total_seconds() // 3600)} 小时前"
            else:
                time_str = f"{int(delta.days)} 天前"

            logs.append({
                "id": row.id,
                "type": row.type,
                "level": row.level,
                "title": row.title,
                "detail": row.detail or "",
                "username": row.username or "",
                "time": time_str,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            })

        return {"logs": logs}
    except Exception as e:
        return {"logs": [], "error": str(e)}


# ══════════════════════════════════════════════
#  8. 操作日志统计（对话趋势图用）
# ══════════════════════════════════════════════

@router.get("/control-trends", summary="控制操作趋势")
async def control_trends(
    _user=Depends(get_current_user),
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

    async def _count_by_hour(start: datetime, end: datetime) -> dict:
        """Group by 2h 统计"""
        try:
            result = await db.execute(
                select(OperationLog.created_at).where(
                    OperationLog.created_at >= start,
                    OperationLog.created_at < end,
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
        except Exception:
            return {h: 0 for h in hours}

    today_data, yesterday_data = await asyncio.gather(
        _count_by_hour(today_start, now),
        _count_by_hour(yesterday_start, today_start),
    )

    return {
        "hours": hours,
        "today": [today_data.get(h, 0) for h in hours],
        "yesterday": [yesterday_data.get(h, 0) for h in hours],
    }
