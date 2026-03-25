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
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import json
import psutil
import subprocess
import shutil

from app.dependencies import require_admin, get_db
from app.services.ollama import ollama_service
from app.models.system_config import SystemConfig

router = APIRouter(prefix="/models", tags=["模型管理"])


# ── Schemas ──

class PullModelRequest(BaseModel):
    name: str  # e.g. "qwen2.5:7b"


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


# ══════════════════════════════════════════════
#  Health
# ══════════════════════════════════════════════

@router.get("/health", summary="模型模块健康检查")
async def health():
    online = await ollama_service.check_health()
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
    _admin: dict = Depends(require_admin),
):
    """返回真实系统资源利用率：CPU、内存、磁盘、GPU"""
    # CPU
    cpu_percent = psutil.cpu_percent(interval=0.5)
    cpu_count = psutil.cpu_count(logical=True)
    cpu_freq = psutil.cpu_freq()

    # 内存
    mem = psutil.virtual_memory()

    # 磁盘（模型存储路径）
    disk = shutil.disk_usage("/")

    # GPU
    gpus = _get_gpu_info()

    # 6 个利用率指标，用于柱状图
    metrics_bars = [
        {"label": "CPU", "value": cpu_percent},
        {"label": "内存", "value": mem.percent},
        {"label": "磁盘", "value": round(disk.used / disk.total * 100, 1)},
    ]
    if gpus:
        metrics_bars.append({"label": "GPU", "value": gpus[0]["utilization_percent"]})
        metrics_bars.append({"label": "显存", "value": gpus[0]["memory_percent"]})
        metrics_bars.append({"label": "GPU温度", "value": min(gpus[0]["temperature_c"], 100)})
    else:
        # 无 GPU 时补充 swap 和系统负载
        swap = psutil.swap_memory()
        load_1m = 0.0
        try:
            load_1m = psutil.getloadavg()[0] / (cpu_count or 1) * 100
        except (AttributeError, OSError):
            pass
        metrics_bars.append({"label": "Swap", "value": swap.percent})
        metrics_bars.append({"label": "系统负载", "value": round(min(load_1m, 100), 1)})
        metrics_bars.append({"label": "IO等待", "value": 0.0})

    return {
        "cpu": {
            "percent": cpu_percent,
            "count": cpu_count,
            "freq_mhz": round(cpu_freq.current, 0) if cpu_freq else None,
        },
        "memory": {
            "total_gb": round(mem.total / (1024 ** 3), 1),
            "used_gb": round(mem.used / (1024 ** 3), 1),
            "percent": mem.percent,
        },
        "disk": {
            "total_gb": round(disk.total / (1024 ** 3), 1),
            "used_gb": round(disk.used / (1024 ** 3), 1),
            "percent": round(disk.used / disk.total * 100, 1),
        },
        "gpus": gpus,
        "metrics_bars": metrics_bars,
    }


# ══════════════════════════════════════════════
#  Ollama 版本
# ══════════════════════════════════════════════

@router.get("/version", summary="Ollama 版本信息")
async def ollama_version(
    _admin: dict = Depends(require_admin),
):
    """GET /api/version → 返回 Ollama 版本号"""
    try:
        version = await ollama_service.get_version()
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


@router.get("/current", summary="获取当前使用模型")
async def get_current_model(
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """读取 system_config 中的 current_model"""
    current = await _get_config(db, "current_model", "")
    return {"current_model": current}


@router.put("/current", summary="设置当前使用模型")
async def set_current_model(
    body: SetCurrentModelRequest,
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """将选定模型名写入 system_config.current_model"""
    # 验证模型是否已安装
    try:
        installed = await ollama_service.list_models()
        names = [m.get("name", "") for m in installed]
        if body.name not in names:
            raise HTTPException(status_code=400, detail=f"模型 {body.name} 未安装")
    except HTTPException:
        raise
    except Exception:
        pass  # Ollama 不可用时仍允许设置

    await _set_config(db, "current_model", body.name)
    return {"message": f"当前模型已设置为 {body.name}", "current_model": body.name}


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
    _admin: dict = Depends(require_admin),
):
    """返回可拉取的精选模型列表"""
    # 获取已安装模型名，用于标记 installed
    installed_names = set()
    try:
        installed = await ollama_service.list_models()
        for m in installed:
            name = m.get("name", "")
            installed_names.add(name)
            # 也添加不带 tag 的基础名
            if ":" in name:
                installed_names.add(name.split(":")[0])
    except Exception:
        pass

    result = []
    for m in MODEL_LIBRARY:
        result.append({
            **m,
            "installed": m["name"] in installed_names,
        })

    return {"models": result, "total": len(result)}


# ══════════════════════════════════════════════
#  模型列表  (Ollama GET /api/tags)
# ══════════════════════════════════════════════


@router.get("/", summary="已安装模型列表")
async def list_models(
    _admin: dict = Depends(require_admin),
):
    """代理 Ollama GET /api/tags，补充格式化字段"""
    try:
        raw_models = await ollama_service.list_models()
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

    return {"models": models, "total": len(models)}


# ══════════════════════════════════════════════
#  模型详情  (Ollama POST /api/show)
# ══════════════════════════════════════════════

@router.post("/{name:path}/detail", summary="模型详情")
async def model_detail(
    name: str,
    _admin: dict = Depends(require_admin),
):
    """代理 Ollama POST /api/show，返回模型全部元数据"""
    try:
        info = await ollama_service.show_model(name)
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
    _admin: dict = Depends(require_admin),
):
    """拉取模型，SSE 流式返回进度"""
    async def event_generator():
        try:
            async for progress in ollama_service.pull_model(body.name):
                status = progress.get("status", "")
                data = {
                    "status": status,
                    "digest": progress.get("digest", ""),
                    "total": progress.get("total", 0),
                    "completed": progress.get("completed", 0),
                }
                yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

                # Ollama 最终返回 {"status": "success"} 表示完成
                if status == "success":
                    return
            # 如果循环结束没有收到 success，也认为完成
            yield f"data: {json.dumps({'status': 'success', 'message': '模型拉取完成'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"

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


@router.post("/copy", summary="复制模型")
async def copy_model(
    body: CopyModelRequest,
    _admin: dict = Depends(require_admin),
):
    """代理 Ollama POST /api/copy，复制模型创建别名"""
    try:
        await ollama_service.copy_model(body.source, body.destination)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"复制失败: {str(e)}")

    return {"message": f"模型已复制: {body.source} → {body.destination}"}


# ══════════════════════════════════════════════
#  删除模型 (Ollama DELETE /api/delete)
# ══════════════════════════════════════════════

@router.delete("/{name:path}", summary="删除模型")
async def delete_model(
    name: str,
    _admin: dict = Depends(require_admin),
):
    """代理 Ollama DELETE /api/delete 删除指定模型"""
    try:
        await ollama_service.delete_model(name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"删除失败: {str(e)}")

    return {"message": f"模型 {name} 已删除"}


# ══════════════════════════════════════════════
#  推理状态 (Ollama GET /api/ps)
# ══════════════════════════════════════════════

@router.get("/status", summary="当前推理状态")
async def running_models(
    _admin: dict = Depends(require_admin),
):
    """代理 Ollama GET /api/ps，返回运行中的模型 + VRAM 占用"""
    try:
        running = await ollama_service.running_models()
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
