"""
模型管理路由 - 代理 Ollama REST API
参考: https://docs.ollama.com/api/introduction

端点:
  GET    /models/              — 已安装模型列表 (Ollama GET /api/tags)
  GET    /models/status        — 运行中模型 + VRAM  (Ollama GET /api/ps)
  GET    /models/version       — Ollama 版本信息   (Ollama GET /api/version)
  GET    /models/system-metrics— 系统利用率       (psutil + nvidia-smi)
  POST   /models/{name}/detail — 模型详情         (Ollama POST /api/show)
  POST   /models/pull          — 拉取模型 (SSE)   (Ollama POST /api/pull)
  POST   /models/copy          — 复制模型         (Ollama POST /api/copy)
  DELETE /models/{name}        — 删除模型         (Ollama DELETE /api/delete)
"""
from datetime import datetime, timezone
import asyncio
import os
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import json
import psutil
import subprocess
import shutil

from app.dependencies import get_current_user, get_db, require_admin
from app.database import AsyncSessionLocal
from app.models.operation_log import OperationLog
from app.models.system_config import SystemConfig
from app.services.model_catalog import get_catalog, sync_catalog
from app.services.model_pull_tasks import (
    cancel_pull_task,
    create_or_reuse_pull_task,
    get_pull_task,
    list_pull_tasks_page,
    ollama_models_disk_path,
    precheck_model_pull,
    retry_pull_task,
)
from app.services.runtime_settings import get_runtime_services
from app.services.system_summary_cache import invalidate_system_summary

router = APIRouter(prefix="/models", tags=["模型管理"])

PULL_TASK_STATUSES = {
    "pending", "running", "retrying", "succeeded", "failed", "canceled", "interrupted",
}
PULL_TASK_SSE_HEARTBEAT_SECONDS = 10.0


# ── Schemas ──

class PullModelRequest(BaseModel):
    name: str  # e.g. "qwen2.5:7b"
    allow_custom: bool = False
    force: bool = False


class InferenceTestRequest(BaseModel):
    model: str | None = None
    prompt: str


class PullTaskRequest(BaseModel):
    model_name: str
    allow_custom: bool = False
    force: bool = False


class PullTaskPrecheckRequest(BaseModel):
    model_name: str
    allow_custom: bool = False
    force: bool = False


# ── Helpers ──

def _format_size(size_bytes: int) -> str:
    """字节数 → 人类可读"""
    if not size_bytes:
        return "0 B"
    if size_bytes >= 1_073_741_824:
        return f"{size_bytes / 1_073_741_824:.1f} GB"
    elif size_bytes >= 1_048_576:
        return f"{size_bytes / 1_048_576:.0f} MB"
    return f"{size_bytes / 1024:.0f} KB"


def _relative_time(iso_str: str) -> str:
    """ISO 时间 → 相对时间（几天前 / 几小时前）"""
    try:
        from datetime import datetime, timezone
        if isinstance(iso_str, str) and iso_str:
            clean = iso_str.replace("Z", "+00:00")
            dt = datetime.fromisoformat(clean)
            now = datetime.now(timezone.utc)
            diff = now - dt
            days = diff.days
            if days < 0:
                return "刚刚"
            if days == 0:
                hours = diff.seconds // 3600
                if hours == 0:
                    mins = diff.seconds // 60
                    return f"{max(mins, 1)} 分钟前"
                return f"{hours} 小时前"
            elif days < 7:
                return f"{days} 天前"
            elif days < 30:
                return f"{days // 7} 周前"
            return f"{days // 30} 月前"
    except Exception:
        pass
    return "未知"


def _extract_arch_value(model_info: dict, suffix: str):
    """从 model_info 中按后缀提取值，key 格式为 '{arch}.{suffix}'"""
    for key, val in model_info.items():
        if key.endswith(f".{suffix}"):
            return val
    return None


def _paginate_items(items: list[dict], page: int, size: int) -> tuple[list[dict], int, int, int]:
    """对外部服务返回的快照做稳定分页，返回当前页、总数、安全页码和总页数。"""
    safe_size = max(1, size)
    total = len(items)
    page_count = max(1, (total + safe_size - 1) // safe_size)
    safe_page = min(max(1, page), page_count)
    start = (safe_page - 1) * safe_size
    return items[start:start + safe_size], total, safe_page, page_count


def _filter_installed_models(models: list[dict], keyword: str) -> list[dict]:
    term = keyword.strip().lower()
    if not term:
        return models
    return [
        model for model in models
        if term in " ".join(str(model.get(key) or "") for key in (
            "name", "family", "parameter_size", "quantization_level", "format",
        )).lower()
    ]


def _filter_library_models(
    models: list[dict],
    *,
    keyword: str = "",
    category: str = "",
    capability: str = "",
    installed: bool | None = None,
    recommended: bool | None = None,
) -> list[dict]:
    term = keyword.strip().lower()
    category_term = category.strip().lower()
    capability_term = capability.strip().lower()
    result = []
    for model in models:
        if installed is not None:
            installed_value = model.get("installed")
            if installed_value is None or bool(installed_value) is not installed:
                continue
        if recommended is not None and bool(model.get("recommended")) is not recommended:
            continue
        if category_term and str(model.get("category") or "").lower() != category_term:
            continue
        capabilities = [str(item).lower() for item in model.get("capabilities", [])]
        if capability_term and capability_term not in capabilities:
            continue
        searchable = " ".join([
            str(model.get("name") or ""),
            str(model.get("desc") or ""),
            str(model.get("family") or ""),
            str(model.get("category") or ""),
            " ".join(capabilities),
            " ".join(str(item) for item in model.get("parameter_sizes", [])),
        ]).lower()
        if term and term not in searchable:
            continue
        result.append(model)
    return result


# ══════════════════════════════════════════════
#  Health
# ══════════════════════════════════════════════

@router.get("/health", summary="模型模块健康检查")
async def health(db: AsyncSession = Depends(get_db)):
    services = await get_runtime_services(db)
    online = await services.ollama.check_health()
    return {"status": "ok" if online else "offline", "module": "models", "ollama_online": online}


# ══════════════════════════════════════════════
#  系统利用率 (psutil + nvidia-smi)
# ══════════════════════════════════════════════

def _get_gpu_info() -> list[dict]:
    """通过 nvidia-smi 获取 GPU 信息"""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return []
        gpus = []
        for line in result.stdout.strip().split("\n"):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 6:
                gpus.append({
                    "index": int(parts[0]),
                    "name": parts[1],
                    "utilization_percent": float(parts[2]),
                    "memory_used_mb": float(parts[3]),
                    "memory_total_mb": float(parts[4]),
                    "memory_percent": round(float(parts[3]) / float(parts[4]) * 100, 1) if float(parts[4]) > 0 else 0,
                    "temperature_c": float(parts[5]),
                })
        return gpus
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        return []


@router.get("/system-metrics", summary="系统利用率")
async def system_metrics(
    _user: dict = Depends(get_current_user),
):
    """返回真实系统资源利用率：CPU、内存、磁盘、GPU"""
    # CPU
    cpu_percent = psutil.cpu_percent(interval=0.5)
    cpu_count = psutil.cpu_count(logical=True)
    cpu_freq = psutil.cpu_freq()

    # 内存
    mem = psutil.virtual_memory()

    # 磁盘（与模型拉取预检使用同一 Ollama 模型存储卷）
    disk_path = ollama_models_disk_path()
    disk = shutil.disk_usage(disk_path)

    # 交换空间始终返回结构化数据，便于前端说明真实资源压力。
    swap = psutil.swap_memory()

    # GPU
    gpus = _get_gpu_info()

    # 6 个利用率指标，用于柱状图
    metrics_bars = [
        {"label": "CPU", "value": cpu_percent, "unit": "%"},
        {"label": "内存", "value": mem.percent, "unit": "%"},
        {"label": "磁盘", "value": round(disk.used / disk.total * 100, 1), "unit": "%"},
    ]
    if gpus:
        metrics_bars.append({"label": "GPU", "value": gpus[0]["utilization_percent"], "unit": "%"})
        metrics_bars.append({"label": "显存", "value": gpus[0]["memory_percent"], "unit": "%"})
        metrics_bars.append({"label": "GPU温度", "value": gpus[0]["temperature_c"], "unit": "°C"})
    else:
        # 无 GPU 时展示真实 swap 和系统负载，不用固定占位指标补齐数量。
        load_1m = 0.0
        try:
            load_1m = psutil.getloadavg()[0] / (cpu_count or 1) * 100
        except (AttributeError, OSError):
            pass
        metrics_bars.append({"label": "Swap", "value": swap.percent, "unit": "%"})
        metrics_bars.append({"label": "系统负载", "value": round(min(load_1m, 100), 1), "unit": "%"})

    return {
        "cpu": {
            "percent": cpu_percent,
            "count": cpu_count,
            # 部分 macOS/虚拟化环境会返回个位数伪频率，低于 100 MHz 时视为不可用。
            "freq_mhz": round(cpu_freq.current, 0) if cpu_freq and cpu_freq.current >= 100 else None,
        },
        "memory": {
            "total_gb": round(mem.total / (1024 ** 3), 1),
            "used_gb": round(mem.used / (1024 ** 3), 1),
            "percent": mem.percent,
        },
        "disk": {
            "path": disk_path,
            "total_gb": round(disk.total / (1024 ** 3), 1),
            "used_gb": round(disk.used / (1024 ** 3), 1),
            "available_gb": round(disk.free / (1024 ** 3), 1),
            "percent": round(disk.used / disk.total * 100, 1),
        },
        "swap": {
            "total_gb": round(swap.total / (1024 ** 3), 1),
            "used_gb": round(swap.used / (1024 ** 3), 1),
            "available_gb": round(swap.free / (1024 ** 3), 1),
            "percent": swap.percent,
        },
        "gpus": gpus,
        "metrics_bars": metrics_bars,
    }


# ══════════════════════════════════════════════
#  Ollama 版本
# ══════════════════════════════════════════════

@router.get("/version", summary="Ollama 版本信息")
async def ollama_version(
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """GET /api/version → 返回 Ollama 版本号"""
    services = await get_runtime_services(db)
    try:
        version = await services.ollama.get_version()
        return {"version": version, "online": True}
    except Exception as e:
        return {"version": "unknown", "online": False, "error": str(e)}


# ══════════════════════════════════════════════
#  当前使用模型（合同第11条）
# ══════════════════════════════════════════════

class SetCurrentModelRequest(BaseModel):
    name: str  # e.g. "qwen3:8b"


async def _get_config(db: AsyncSession, key: str, default: str = "") -> str:
    result = await db.execute(
        select(SystemConfig.value).where(SystemConfig.key == key)
    )
    row = result.scalar_one_or_none()
    return row if row is not None else default


async def _set_config(db: AsyncSession, key: str, value: str):
    result = await db.execute(
        select(SystemConfig).where(SystemConfig.key == key)
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.value = value
    else:
        db.add(SystemConfig(key=key, value=value))


def _record_model_management_operation(
    db: AsyncSession,
    user: dict,
    *,
    action: str,
    title: str,
    entity_id: str = "",
    level: str = "success",
    **fields,
) -> None:
    detail_fields = [f"action={action}"]
    detail_fields.extend(
        f"{key}={str(value)[:240]}"
        for key, value in fields.items()
        if value is not None and str(value) != ""
    )
    db.add(OperationLog(
        type="model_management",
        level=level,
        title=title,
        detail="; ".join(detail_fields),
        user_id=user.get("user_id"),
        username=user.get("username", ""),
        entity_id=entity_id,
    ))


async def _is_embedding_only_model(services, model_name: str) -> bool:
    """判断模型是否仅支持 embedding，避免误用于 generate 对话推理。"""
    try:
        detail = await services.ollama.show_model(model_name)
        capabilities = detail.get("capabilities") or []
        if "embedding" in capabilities:
            return not any(cap in capabilities for cap in ("completion", "tools", "thinking", "vision"))
    except Exception:
        pass
    return "embed" in model_name.lower() or "embedding" in model_name.lower()


def _diagnose_ollama_runner_error(message: str) -> str:
    """把 Ollama runner 崩溃转换为验收人员能理解的诊断信息。"""
    if "llama runner process has terminated" not in message and "model failed to load" not in message:
        return message

    log_path = os.path.expanduser("~/.ollama/logs/server.log")
    recent_log = ""
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 120_000))
            recent_log = f.read().decode("utf-8", errors="ignore")
    except Exception:
        pass

    if "ggml_metal_library_init" in recent_log and "bfloat" in recent_log and "Apple M5" in recent_log:
        return (
            "Ollama 在 Apple M5 的 Metal 后端初始化失败，Metal shader 编译报 bfloat/half 类型不匹配；"
            "模型已安装，但当前 Ollama/Metal 运行时无法加载模型。请升级或降级 Ollama/macOS/Xcode Command Line Tools，"
            "或切换到已验证可用的 Ollama 运行环境后重试。"
        )
    if "failed to initialize Metal backend" in recent_log or "ggml_metal" in recent_log:
        return (
            "Ollama Metal 后端初始化失败，模型无法加载。请检查 Ollama server.log、更新/回退 Ollama，"
            "或切换到不依赖当前 Metal 后端的运行环境后重试。"
        )
    return f"Ollama runner 加载模型失败：{message}"


@router.get("/current", summary="获取当前使用模型")
async def get_current_model(
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """读取 system_config 中的 current_model"""
    current = await _get_config(db, "current_model", "")
    return {"current_model": current}


@router.put("/current", summary="设置当前使用模型")
async def set_current_model(
    body: SetCurrentModelRequest,
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """将选定模型名写入 system_config.current_model"""
    services = await get_runtime_services(db)
    # 验证模型是否已安装
    try:
        installed = await services.ollama.list_models()
        names = [m.get("name", "") for m in installed]
        if body.name not in names:
            raise HTTPException(status_code=400, detail=f"模型 {body.name} 未安装")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Ollama 当前不可用，无法确认模型是否已安装: {str(exc)}",
        ) from exc

    if await _is_embedding_only_model(services, body.name):
        raise HTTPException(status_code=400, detail=f"模型 {body.name} 是 Embedding 模型，不能设为对话推理模型")

    previous_model = await _get_config(db, "current_model", "")
    if previous_model == body.name:
        return {"message": f"模型 {body.name} 已是当前使用模型", "current_model": body.name}
    await _set_config(db, "current_model", body.name)
    _record_model_management_operation(
        db,
        user,
        action="set_current",
        title="当前模型已切换",
        entity_id=body.name,
        previous_model=previous_model,
        model=body.name,
        result="success",
    )
    return {"message": f"当前模型已设置为 {body.name}", "current_model": body.name}


@router.post("/inference-test", summary="本地模型推理测试")
async def inference_test(
    body: InferenceTestRequest,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """调用 Ollama 执行一次非流式推理，用于形成模型验收证据。"""
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="测试 Prompt 不能为空")

    model_name = (body.model or "").strip() or await _get_config(db, "current_model", "")
    if not model_name:
        raise HTTPException(status_code=400, detail="未设置当前使用模型，请先选择模型")

    services = await get_runtime_services(db)
    installed_names: list[str] = []
    try:
        installed = await services.ollama.list_models()
        installed_names = [m.get("name", "") for m in installed]
    except Exception as e:
        db.add(OperationLog(
            type="model_inference",
            level="error",
            title="模型推理测试失败",
            detail=f"model={model_name}; result=ollama_unavailable; error={str(e)[:160]}",
            user_id=user.get("user_id"),
            username=user.get("username", ""),
        ))
        await db.commit()
        raise HTTPException(status_code=502, detail=f"Ollama 不可用: {str(e)}")

    if model_name not in installed_names:
        db.add(OperationLog(
            type="model_inference",
            level="error",
            title="模型推理测试失败",
            detail=f"model={model_name}; result=model_not_installed",
            user_id=user.get("user_id"),
            username=user.get("username", ""),
        ))
        await db.commit()
        raise HTTPException(status_code=400, detail=f"模型 {model_name} 未安装")

    if await _is_embedding_only_model(services, model_name):
        db.add(OperationLog(
            type="model_inference",
            level="warning",
            title="模型推理测试已拒绝",
            detail=f"model={model_name}; result=embedding_only",
            user_id=user.get("user_id"),
            username=user.get("username", ""),
        ))
        await db.commit()
        raise HTTPException(status_code=400, detail=f"模型 {model_name} 是 Embedding 模型，不支持对话推理测试")

    started = time.perf_counter()
    tested_at = datetime.now(timezone.utc).isoformat()
    try:
        response = await services.ollama.generate(model_name, prompt, stream=False)
        latency_ms = round((time.perf_counter() - started) * 1000)
        db.add(OperationLog(
            type="model_inference",
            level="success",
            title="模型推理测试成功",
            detail=f"model={model_name}; latency_ms={latency_ms}; result=success",
            user_id=user.get("user_id"),
            username=user.get("username", ""),
        ))
        return {
            "success": True,
            "model": model_name,
            "prompt": prompt,
            "response": response,
            "latency_ms": latency_ms,
            "tested_at": tested_at,
        }
    except Exception as e:
        latency_ms = round((time.perf_counter() - started) * 1000)
        diagnosed_error = _diagnose_ollama_runner_error(str(e))
        db.add(OperationLog(
            type="model_inference",
            level="error",
            title="模型推理测试失败",
            detail=f"model={model_name}; latency_ms={latency_ms}; result=inference_failed; error={diagnosed_error[:240]}",
            user_id=user.get("user_id"),
            username=user.get("username", ""),
        ))
        await db.commit()
        raise HTTPException(status_code=502, detail=f"推理失败: {diagnosed_error}")


# ══════════════════════════════════════════════
#  可用模型库（精选列表）
# ══════════════════════════════════════════════

# 精选模型目录 — 覆盖主流开源模型
MODEL_LIBRARY = [
    {
        "name": "qwen3",
        "desc": "阿里通义千问 3，中文能力最强的开源模型",
        "tags": ["0.6b", "1.7b", "4b", "8b", "14b", "30b", "32b", "235b"],
        "default_tag": "8b",
        "family": "qwen3",
        "category": "对话",
    },
    {
        "name": "qwen2.5",
        "desc": "阿里通义千问 2.5，均衡的中英文对话模型",
        "tags": ["0.5b", "1.5b", "3b", "7b", "14b", "32b", "72b"],
        "default_tag": "7b",
        "family": "qwen2.5",
        "category": "对话",
    },
    {
        "name": "llama3.1",
        "desc": "Meta 最新开源模型，英文推理能力出色",
        "tags": ["8b", "70b", "405b"],
        "default_tag": "8b",
        "family": "llama",
        "category": "对话",
    },
    {
        "name": "gemma3",
        "desc": "Google DeepMind 开源模型，支持多模态",
        "tags": ["1b", "4b", "12b", "27b"],
        "default_tag": "4b",
        "family": "gemma",
        "category": "对话",
    },
    {
        "name": "deepseek-r1",
        "desc": "DeepSeek 推理模型，擅长数学与逻辑推理",
        "tags": ["1.5b", "7b", "8b", "14b", "32b", "70b", "671b"],
        "default_tag": "7b",
        "family": "deepseek",
        "category": "推理",
    },
    {
        "name": "phi4",
        "desc": "微软小参数高性能模型，适合边缘部署",
        "tags": ["14b"],
        "default_tag": "14b",
        "family": "phi",
        "category": "对话",
    },
    {
        "name": "mistral",
        "desc": "Mistral AI 开源模型，高效推理",
        "tags": ["7b"],
        "default_tag": "7b",
        "family": "mistral",
        "category": "对话",
    },
    {
        "name": "codellama",
        "desc": "Meta 代码专用模型，支持代码生成与补全",
        "tags": ["7b", "13b", "34b", "70b"],
        "default_tag": "7b",
        "family": "llama",
        "category": "代码",
    },
    {
        "name": "nomic-embed-text",
        "desc": "高质量文本 Embedding 模型，用于 RAG 检索",
        "tags": ["latest"],
        "default_tag": "latest",
        "family": "nomic-bert",
        "category": "Embedding",
    },
    {
        "name": "bge-m3",
        "desc": "BAAI 多语言 Embedding 模型，中英文均衡",
        "tags": ["latest"],
        "default_tag": "latest",
        "family": "bert",
        "category": "Embedding",
    },
    {
        "name": "llava",
        "desc": "多模态视觉语言模型，支持图像理解",
        "tags": ["7b", "13b", "34b"],
        "default_tag": "7b",
        "family": "llava",
        "category": "多模态",
    },
]


@router.get("/library", summary="可用模型库")
async def model_library(
    keyword: str = Query(default="", max_length=100),
    category: str = Query(default="", max_length=64),
    capability: str = Query(default="", max_length=64),
    installed: bool | None = Query(default=None),
    recommended: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=12, ge=1, le=50),
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回官方 Ollama 模型库缓存，失败时自动降级到种子模型。"""
    installed_names = set()
    ollama_online = True
    services = await get_runtime_services(db)
    try:
        installed_models = await services.ollama.list_models()
        for m in installed_models:
            name = m.get("name", "")
            installed_names.add(name)
            # 也添加不带 tag 的基础名
            if ":" in name:
                installed_names.add(name.split(":")[0])
    except Exception:
        ollama_online = False

    catalog = await get_catalog(db)
    result = []
    for model in catalog.get("models", []):
        tags = []
        model_installed: bool | None = model.get("name") in installed_names if ollama_online else None
        for tag in model.get("tags", []):
            full_name = tag.get("full_name") or f"{model.get('name')}:{tag.get('tag', 'latest')}"
            tag_installed: bool | None = full_name in installed_names if ollama_online else None
            if tag_installed:
                model_installed = True
            tags.append({**tag, "installed": tag_installed})
        result.append({**model, "tags": tags, "installed": model_installed})

    filtered = _filter_library_models(
        result,
        keyword=keyword,
        category=category,
        capability=capability,
        installed=installed,
        recommended=recommended,
    )
    page_items, total, safe_page, page_count = _paginate_items(filtered, page, size)
    categories = sorted({str(model.get("category") or "其他") for model in result})
    capabilities = sorted({
        str(item) for model in result for item in model.get("capabilities", []) if item
    })
    return {
        "models": page_items,
        "total": total,
        "page": safe_page,
        "size": size,
        "page_count": page_count,
        "available_filters": {
            "categories": categories,
            "capabilities": capabilities,
        },
        "ollama_online": ollama_online,
        "source": catalog.get("source", "cache"),
        "last_synced_at": catalog.get("last_synced_at"),
        "error": catalog.get("error", ""),
    }


@router.post("/library/sync", summary="同步官方模型库")
async def sync_model_library(
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """主动同步 Ollama 官方模型库；失败时返回旧缓存或种子兜底。"""
    catalog = await sync_catalog(db)
    sync_error = str(catalog.get("error") or "")
    _record_model_management_operation(
        db,
        user,
        action="sync_catalog",
        title="模型目录同步完成" if not sync_error else "模型目录同步使用缓存",
        level="success" if not sync_error else "warning",
        source=catalog.get("source", ""),
        model_count=len(catalog.get("models") or []),
        result="success" if not sync_error else "fallback",
        error=sync_error,
    )
    return catalog


# ══════════════════════════════════════════════
#  持久拉取任务
# ══════════════════════════════════════════════

@router.post("/pull-tasks/precheck", summary="模型拉取预检")
async def pull_task_precheck(
    body: PullTaskPrecheckRequest,
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await precheck_model_pull(
        db,
        body.model_name,
        allow_custom=body.allow_custom,
        force=body.force,
    )


@router.post("/pull-tasks", summary="创建模型拉取任务")
async def create_pull_task(
    body: PullTaskRequest,
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await create_or_reuse_pull_task(
        db,
        body.model_name,
        user,
        allow_custom=body.allow_custom,
        force=body.force,
    )
    if not result.get("task"):
        raise HTTPException(status_code=400, detail={
            "error_type": result.get("error_type") or "invalid_model",
            "precheck": result.get("precheck"),
        })
    return result


@router.get("/pull-tasks", summary="模型拉取任务列表")
async def pull_tasks(
    status: str | None = Query(default=None),
    model_name: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int | None = Query(default=None, ge=1, le=100),
    limit: int | None = Query(default=None, ge=1, le=100),
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if status and status not in PULL_TASK_STATUSES:
        raise HTTPException(status_code=422, detail="不支持的拉取任务状态")
    resolved_size = size or limit or 20
    return await list_pull_tasks_page(
        db,
        status=status,
        model_name=model_name,
        page=page,
        size=resolved_size,
    )


@router.get("/pull-tasks/{task_id}", summary="模型拉取任务详情")
async def pull_task_detail(
    task_id: int,
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    task = await get_pull_task(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="拉取任务不存在")
    return task


@router.get("/pull-tasks/{task_id}/events", summary="模型拉取任务事件流")
async def pull_task_events(
    task_id: int,
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    initial = await get_pull_task(db, task_id)
    if not initial:
        raise HTTPException(status_code=404, detail="拉取任务不存在")

    async def event_generator():
        last_payload = ""
        last_emitted_at = time.monotonic()
        while True:
            async with AsyncSessionLocal() as session:
                task = await get_pull_task(session, task_id)
            if not task:
                payload = {"status": "error", "message": "拉取任务不存在"}
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                return
            payload = json.dumps(task, ensure_ascii=False)
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
                last_emitted_at = time.monotonic()
            elif time.monotonic() - last_emitted_at >= PULL_TASK_SSE_HEARTBEAT_SECONDS:
                yield ": keep-alive\n\n"
                last_emitted_at = time.monotonic()
            if task["status"] in {"succeeded", "failed", "canceled", "interrupted"}:
                return
            await asyncio.sleep(0.8)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/pull-tasks/{task_id}/retry", summary="重试模型拉取任务")
async def retry_model_pull_task(
    task_id: int,
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    try:
        task = await retry_pull_task(db, task_id, user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not task:
        raise HTTPException(status_code=404, detail="拉取任务不存在")
    return task


@router.post("/pull-tasks/{task_id}/cancel", summary="取消模型拉取任务")
async def cancel_model_pull_task(
    task_id: int,
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    task = await cancel_pull_task(db, task_id, user)
    if not task:
        raise HTTPException(status_code=404, detail="拉取任务不存在")
    return task


# ══════════════════════════════════════════════
#  模型列表  (Ollama GET /api/tags)
# ══════════════════════════════════════════════


@router.get("/", summary="已安装模型列表", include_in_schema=False)
@router.get("", summary="已安装模型列表")
async def list_models(
    keyword: str = Query(default="", max_length=100),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    complete: bool = Query(default=False),
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """代理 Ollama GET /api/tags，补充格式化字段"""
    services = await get_runtime_services(db)
    try:
        raw_models = await services.ollama.list_models()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"无法连接 Ollama: {str(e)}")

    models = []
    for m in raw_models:
        details = m.get("details", {})
        models.append({
            "name": m.get("name", ""),
            "model": m.get("model", m.get("name", "")),
            "size": m.get("size", 0),
            "size_display": _format_size(m.get("size", 0)),
            "parameter_size": details.get("parameter_size", "—"),
            "quantization_level": details.get("quantization_level", "—"),
            "family": details.get("family", "—"),
            "families": details.get("families", []),
            "format": details.get("format", "—"),
            "modified_at": m.get("modified_at", ""),
            "modified_display": _relative_time(m.get("modified_at", "")),
            "digest": m.get("digest", "")[:12],
        })

    filtered = _filter_installed_models(models, keyword)
    if complete is True:
        page_items, total, safe_page, page_count = filtered, len(filtered), 1, 1
        response_size = len(filtered) or size
    else:
        page_items, total, safe_page, page_count = _paginate_items(filtered, page, size)
        response_size = size
    inventory_total_size = sum(int(model.get("size") or 0) for model in models)
    return {
        "models": page_items,
        "total": total,
        "page": safe_page,
        "size": response_size,
        "page_count": page_count,
        "total_size": sum(int(model.get("size") or 0) for model in filtered),
        "summary": {
            "total": len(models),
            "total_size": inventory_total_size,
        },
    }


# ══════════════════════════════════════════════
#  模型详情  (Ollama POST /api/show)
# ══════════════════════════════════════════════

@router.post("/{name:path}/detail", summary="模型详情")
async def model_detail(
    name: str,
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """代理 Ollama POST /api/show，返回模型全部元数据"""
    services = await get_runtime_services(db)
    try:
        info = await services.ollama.show_model(name)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"模型不存在: {str(e)}")

    details = info.get("details", {})
    model_info = info.get("model_info", {})

    return {
        "name": name,
        "license": info.get("license", ""),
        "system": info.get("system", ""),
        "template": info.get("template", ""),
        "parameters": info.get("parameters", ""),
        "capabilities": info.get("capabilities", []),
        "modified_at": info.get("modified_at", ""),
        "details": {
            "parent_model": details.get("parent_model", ""),
            "family": details.get("family", "—"),
            "parameter_size": details.get("parameter_size", "—"),
            "quantization_level": details.get("quantization_level", "—"),
            "format": details.get("format", "—"),
            "families": details.get("families", []),
        },
        "model_info": model_info,
        # 从 model_info 中提取关键架构参数（方便前端展示）
        "architecture": {
            "architecture": model_info.get("general.architecture", "—"),
            "parameter_count": model_info.get("general.parameter_count", 0),
            "quantization_version": model_info.get("general.quantization_version", None),
            "file_type": model_info.get("general.file_type", None),
            "context_length": _extract_arch_value(model_info, "context_length"),
            "embedding_length": _extract_arch_value(model_info, "embedding_length"),
            "block_count": _extract_arch_value(model_info, "block_count"),
            "head_count": _extract_arch_value(model_info, "attention.head_count"),
            "head_count_kv": _extract_arch_value(model_info, "attention.head_count_kv"),
            "feed_forward_length": _extract_arch_value(model_info, "feed_forward_length"),
        },
    }


# ══════════════════════════════════════════════
#  拉取模型 (Ollama POST /api/pull, stream)
# ══════════════════════════════════════════════

@router.post("/pull", summary="拉取新模型")
async def pull_model(
    body: PullModelRequest,
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """兼容旧 SSE 拉取接口：内部创建持久任务并转接任务事件。"""
    result = await create_or_reuse_pull_task(
        db,
        body.name,
        user,
        allow_custom=True if body.allow_custom is False else body.allow_custom,
        force=body.force,
    )
    task = result.get("task")

    async def event_generator():
        if not task:
            yield f"data: {json.dumps({'status': 'error', 'message': result.get('precheck')}, ensure_ascii=False)}\n\n"
            return
        last_payload = ""
        last_emitted_at = time.monotonic()
        while True:
            async with AsyncSessionLocal() as session:
                latest = await get_pull_task(session, task["id"])
            if not latest:
                yield f"data: {json.dumps({'status': 'error', 'message': '拉取任务不存在'}, ensure_ascii=False)}\n\n"
                return
            status = latest["status"]
            data = {
                "task_id": latest["id"],
                "status": "success" if status == "succeeded" else "error" if status in {"failed", "canceled", "interrupted"} else latest["last_status"],
                "task_status": status,
                "total": latest["total_bytes"],
                "completed": latest["completed_bytes"],
                "progress_percent": latest["progress_percent"],
                "message": latest["error_message"],
                "error_type": latest["error_type"],
            }
            payload = json.dumps(data, ensure_ascii=False)
            if payload != last_payload:
                yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
                last_payload = payload
                last_emitted_at = time.monotonic()
            elif time.monotonic() - last_emitted_at >= PULL_TASK_SSE_HEARTBEAT_SECONDS:
                yield ": keep-alive\n\n"
                last_emitted_at = time.monotonic()
            if status in {"succeeded", "failed", "canceled", "interrupted"}:
                return
            await asyncio.sleep(0.8)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ══════════════════════════════════════════════
#  复制模型 (Ollama POST /api/copy)
# ══════════════════════════════════════════════

class CopyModelRequest(BaseModel):
    source: str       # e.g. "qwen3:8b"
    destination: str  # e.g. "my-qwen:latest"

    @field_validator("source", "destination")
    @classmethod
    def validate_model_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("模型名称不能为空")
        if len(normalized) > 255:
            raise ValueError("模型名称不能超过 255 个字符")
        if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in normalized):
            raise ValueError("模型名称不能包含空格或控制字符")
        if normalized.startswith(("/", ":")) or normalized.endswith(("/", ":")) or "//" in normalized:
            raise ValueError("模型名称格式不正确")
        return normalized


@router.post("/copy", summary="复制模型")
async def copy_model(
    body: CopyModelRequest,
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """代理 Ollama POST /api/copy，复制模型创建别名"""
    if body.source == body.destination:
        raise HTTPException(status_code=400, detail="新模型名称不能与源模型相同")
    services = await get_runtime_services(db)
    try:
        await services.ollama.copy_model(body.source, body.destination)
    except Exception as e:
        _record_model_management_operation(
            db,
            user,
            action="copy",
            title="模型复制失败",
            entity_id=body.source,
            level="error",
            source=body.source,
            destination=body.destination,
            result="failed",
            error=str(e),
        )
        await db.commit()
        raise HTTPException(status_code=400, detail=f"复制失败: {str(e)}")

    _record_model_management_operation(
        db,
        user,
        action="copy",
        title="模型复制完成",
        entity_id=body.destination,
        source=body.source,
        destination=body.destination,
        result="success",
    )
    invalidate_system_summary()
    return {"message": f"模型已复制: {body.source} → {body.destination}"}


# ══════════════════════════════════════════════
#  删除模型 (Ollama DELETE /api/delete)
# ══════════════════════════════════════════════

@router.delete("/{name:path}", summary="删除模型")
async def delete_model(
    name: str,
    user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """代理 Ollama DELETE /api/delete 删除指定模型"""
    current_model = await _get_config(db, "current_model", "")
    if current_model == name:
        raise HTTPException(
            status_code=409,
            detail="当前使用模型不能删除，请先选择其他模型作为当前模型",
        )
    services = await get_runtime_services(db)
    try:
        await services.ollama.delete_model(name)
    except Exception as e:
        _record_model_management_operation(
            db,
            user,
            action="delete",
            title="模型删除失败",
            entity_id=name,
            level="error",
            model=name,
            result="failed",
            error=str(e),
        )
        await db.commit()
        raise HTTPException(status_code=400, detail=f"删除失败: {str(e)}")

    _record_model_management_operation(
        db,
        user,
        action="delete",
        title="模型删除完成",
        entity_id=name,
        model=name,
        result="success",
    )
    invalidate_system_summary()
    return {"message": f"模型 {name} 已删除"}


# ══════════════════════════════════════════════
#  推理状态 (Ollama GET /api/ps)
# ══════════════════════════════════════════════

@router.get("/status", summary="当前推理状态")
async def running_models(
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """代理 Ollama GET /api/ps，返回运行中的模型 + VRAM 占用"""
    services = await get_runtime_services(db)
    try:
        running = await services.ollama.running_models()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"无法获取状态: {str(e)}")

    models = []
    for m in running:
        details = m.get("details", {})
        models.append({
            "name": m.get("name", ""),
            "model": m.get("model", ""),
            "size": m.get("size", 0),
            "size_display": _format_size(m.get("size", 0)),
            "size_vram": m.get("size_vram", 0),
            "size_vram_display": _format_size(m.get("size_vram", 0)),
            "parameter_size": details.get("parameter_size", "—"),
            "quantization_level": details.get("quantization_level", "—"),
            "family": details.get("family", "—"),
            "context_length": m.get("context_length", 0),
            "expires_at": m.get("expires_at", ""),
            "digest": m.get("digest", "")[:12],
        })

    return {"running": models, "count": len(models)}
