"""
Ollama 模型拉取任务编排。
"""
from __future__ import annotations

import asyncio
from datetime import datetime
import os
import re
import shutil
import time
from typing import Any

import httpx
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.model_pull_task import ModelPullTask
from app.models.operation_log import OperationLog
from app.models.system_config import SystemConfig
from app.services.model_catalog import find_catalog_tag, get_catalog
from app.services.runtime_settings import get_runtime_services
from app.services.system_summary_cache import invalidate_system_summary


ACTIVE_STATUSES = {"pending", "running", "retrying"}
FINAL_STATUSES = {"succeeded", "failed", "canceled", "interrupted"}
RETRYABLE_ERROR_TYPES = {"retryable_network", "http_5xx", "unknown"}
BACKOFF_SECONDS = [10, 30, 90]
MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._.-]*)?$")

RUNNING_TASKS: dict[int, asyncio.Task] = {}


def _now() -> datetime:
    return datetime.utcnow()


def _serialize_task(task: ModelPullTask) -> dict[str, Any]:
    return {
        "id": task.id,
        "model_name": task.model_name,
        "status": task.status,
        "attempt": task.attempt,
        "max_attempts": task.max_attempts,
        "total_bytes": task.total_bytes,
        "completed_bytes": task.completed_bytes,
        "progress_percent": round(float(task.progress_percent or 0), 1),
        "last_status": task.last_status,
        "error_type": task.error_type,
        "error_message": task.error_message,
        "started_at": task.started_at.isoformat() if task.started_at else None,
        "finished_at": task.finished_at.isoformat() if task.finished_at else None,
        "created_by": task.created_by,
        "username": task.username,
        "created_at": task.created_at.isoformat() if task.created_at else None,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
    }


def _merge_layer_progress(
    largest_total: int,
    largest_completed: int,
    total: int,
    completed: int,
) -> tuple[int, int, float]:
    """保留最大的模型层进度，避免末尾小型 manifest 层覆盖模型实际大小。"""
    if total > largest_total:
        largest_total = total
        largest_completed = completed
    elif total == largest_total:
        largest_completed = max(largest_completed, completed)
    percent = round(largest_completed / largest_total * 100, 1) if largest_total > 0 else 0
    return largest_total, largest_completed, percent


def _normalize_model_name(model_name: str) -> str:
    name = model_name.strip()
    return name if ":" in name else f"{name}:latest"


def ollama_models_path() -> str:
    """返回 Ollama 模型目录；未显式配置时使用官方默认目录。"""
    return os.path.abspath(os.path.expanduser(os.environ.get("OLLAMA_MODELS") or "~/.ollama/models"))


def ollama_models_disk_path() -> str:
    """目录尚未创建时逐级回退到最近存在的父目录，用于磁盘容量探测。"""
    path = ollama_models_path()
    while not os.path.exists(path):
        parent = os.path.dirname(path)
        if parent == path:
            return "/"
        path = parent
    return path


def _classify_error(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, asyncio.CancelledError):
        return "canceled", "拉取任务已取消"
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        detail = ""
        try:
            detail = exc.response.json().get("error", "")
        except Exception:
            detail = exc.response.text.strip()
        message = detail or f"HTTP {status}"
        if status == 404:
            return "model_not_found", message
        if status >= 500:
            return "http_5xx", message
        if status in {400, 401, 403}:
            return "invalid_model", message
        return "unknown", message
    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)):
        return "ollama_offline", "Ollama 服务不可达，请检查服务地址和运行状态"
    if isinstance(exc, (httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.TransportError)):
        return "retryable_network", str(exc) or "网络中断或连接重置"
    message = str(exc) or exc.__class__.__name__
    lowered = message.lower()
    if "no space" in lowered or "disk" in lowered:
        return "disk_insufficient", message
    if "not found" in lowered or "manifest" in lowered:
        return "model_not_found", message
    return "unknown", message


async def _get_config(db: AsyncSession, key: str, default: str = "") -> str:
    result = await db.execute(select(SystemConfig.value).where(SystemConfig.key == key))
    value = result.scalar_one_or_none()
    return value if value is not None else default


async def _set_config(db: AsyncSession, key: str, value: str) -> None:
    result = await db.execute(select(SystemConfig).where(SystemConfig.key == key))
    row = result.scalar_one_or_none()
    if row:
        row.value = value
    else:
        db.add(SystemConfig(key=key, value=value))


async def precheck_model_pull(
    db: AsyncSession,
    model_name: str,
    allow_custom: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    normalized_name = _normalize_model_name(model_name)
    checks: list[dict[str, Any]] = []
    blocking_errors: list[str] = []

    def add_check(key: str, ok: bool, message: str, detail: Any = None) -> None:
        checks.append({"key": key, "ok": ok, "message": message, "detail": detail})
        if not ok:
            blocking_errors.append(message)

    if not MODEL_NAME_RE.match(normalized_name):
        add_check("model_name", False, "模型名格式不符合 Ollama model:tag 规则")
        return {"ok": False, "model_name": normalized_name, "checks": checks, "errors": blocking_errors}
    add_check("model_name", True, "模型名格式正确")

    services = await get_runtime_services(db)
    try:
        version = await services.ollama.get_version()
        add_check("ollama", True, f"Ollama 已连接，版本 {version}")
    except Exception:
        add_check("ollama", False, "Ollama 未连接，请先在系统设置确认 Ollama 地址")
        return {"ok": False, "model_name": normalized_name, "checks": checks, "errors": blocking_errors}

    catalog = await get_catalog(db)
    catalog_tag = find_catalog_tag(catalog, normalized_name)
    if catalog_tag or allow_custom:
        add_check("catalog", True, "模型存在于官方缓存或已确认使用自定义模型")
    else:
        add_check("catalog", False, "模型未在官方缓存中找到，如需拉取自定义模型请显式确认")

    installed_names: set[str] = set()
    try:
        installed = await services.ollama.list_models()
        installed_names = {item.get("name", "") for item in installed}
    except Exception:
        installed = []
    installed_exact = normalized_name in installed_names
    if installed_exact and not force:
        add_check("installed", False, f"模型 {normalized_name} 已安装，如需重新拉取请确认覆盖")
    else:
        add_check("installed", True, "未发现阻塞性重复安装" if not installed_exact else "已确认重新拉取")

    expected_bytes = int((catalog_tag or {}).get("size_bytes") or 0)
    disk_path = ollama_models_disk_path()
    try:
        usage = shutil.disk_usage(disk_path)
        required = int(expected_bytes * 1.2) if expected_bytes else 0
        if required and usage.free < required:
            add_check("disk", False, "磁盘可用空间不足，需大于模型大小加 20% 缓冲", {
                "free_bytes": usage.free,
                "required_bytes": required,
                "model_size_bytes": expected_bytes,
                "path": disk_path,
            })
        else:
            add_check("disk", True, "磁盘空间预检通过", {
                "free_bytes": usage.free,
                "required_bytes": required,
                "model_size_bytes": expected_bytes,
                "path": disk_path,
            })
    except Exception as e:
        add_check("disk", False, f"磁盘空间检查失败: {str(e)}")

    return {
        "ok": not blocking_errors,
        "model_name": normalized_name,
        "checks": checks,
        "errors": blocking_errors,
        "catalog": {
            "source": catalog.get("source"),
            "last_synced_at": catalog.get("last_synced_at"),
            "tag": catalog_tag,
        },
        "installed": installed_exact,
    }


async def list_pull_tasks(
    db: AsyncSession,
    status: str | None = None,
    model_name: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    query = select(ModelPullTask)
    if status:
        query = query.where(ModelPullTask.status == status)
    if model_name:
        query = query.where(ModelPullTask.model_name.ilike(f"%{model_name}%"))
    result = await db.execute(query.order_by(desc(ModelPullTask.updated_at), desc(ModelPullTask.id)).limit(limit))
    return [_serialize_task(row) for row in result.scalars().all()]


async def list_pull_tasks_page(
    db: AsyncSession,
    *,
    status: str | None = None,
    model_name: str | None = None,
    page: int = 1,
    size: int = 20,
) -> dict[str, Any]:
    """按服务端分页返回持久拉取任务，并提供未受当前筛选影响的状态汇总。"""
    filters = []
    if status:
        filters.append(ModelPullTask.status == status)
    if model_name:
        filters.append(ModelPullTask.model_name.ilike(f"%{model_name.strip()}%"))

    total_result = await db.execute(
        select(func.count()).select_from(ModelPullTask).where(*filters)
    )
    total = int(total_result.scalar() or 0)
    safe_size = max(1, size)
    page_count = max(1, (total + safe_size - 1) // safe_size)
    safe_page = min(max(1, page), page_count)
    rows_result = await db.execute(
        select(ModelPullTask)
        .where(*filters)
        .order_by(desc(ModelPullTask.updated_at), desc(ModelPullTask.id))
        .offset((safe_page - 1) * safe_size)
        .limit(safe_size)
    )

    summary_result = await db.execute(
        select(ModelPullTask.status, func.count(ModelPullTask.id)).group_by(ModelPullTask.status)
    )
    status_counts = {str(task_status): int(count) for task_status, count in summary_result.all()}
    active = sum(status_counts.get(item, 0) for item in ACTIVE_STATUSES)
    failed = status_counts.get("failed", 0) + status_counts.get("interrupted", 0)
    return {
        "tasks": [_serialize_task(row) for row in rows_result.scalars().all()],
        "total": total,
        "page": safe_page,
        "size": safe_size,
        "page_count": page_count,
        "summary": {
            "total": sum(status_counts.values()),
            "active": active,
            "succeeded": status_counts.get("succeeded", 0),
            "failed": failed,
            "canceled": status_counts.get("canceled", 0),
            "by_status": status_counts,
        },
    }


async def get_pull_task(db: AsyncSession, task_id: int) -> dict[str, Any] | None:
    result = await db.execute(select(ModelPullTask).where(ModelPullTask.id == task_id))
    task = result.scalar_one_or_none()
    return _serialize_task(task) if task else None


async def create_or_reuse_pull_task(
    db: AsyncSession,
    model_name: str,
    user: dict[str, Any],
    allow_custom: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    normalized_name = _normalize_model_name(model_name)
    result = await db.execute(
        select(ModelPullTask)
        .where(ModelPullTask.model_name == normalized_name, ModelPullTask.status.in_(ACTIVE_STATUSES))
        .order_by(desc(ModelPullTask.id))
        .limit(1)
    )
    existing = result.scalar_one_or_none()
    if existing:
        precheck = {"ok": True, "model_name": normalized_name, "checks": [], "errors": [], "reused": True}
        return {"created": False, "task": _serialize_task(existing), "precheck": precheck, "error_type": ""}

    precheck = await precheck_model_pull(db, normalized_name, allow_custom=allow_custom, force=force)
    if not precheck["ok"]:
        error_type = "already_installed" if precheck.get("installed") else "invalid_model"
        return {"created": False, "task": None, "precheck": precheck, "error_type": error_type}

    now = _now()
    task = ModelPullTask(
        model_name=normalized_name,
        status="pending",
        attempt=0,
        max_attempts=3,
        total_bytes=0,
        completed_bytes=0,
        progress_percent=0,
        error_type="",
        error_message="",
        created_by=user.get("user_id"),
        username=user.get("username", ""),
        last_status="等待后台拉取任务启动",
        created_at=now,
        updated_at=now,
    )
    db.add(task)
    await db.flush()
    db.add(OperationLog(
        type="model_pull",
        level="info",
        title="模型拉取任务已创建",
        detail=f"task_id={task.id}; model={task.model_name}; action=create; result=pending",
        user_id=task.created_by,
        username=task.username,
        entity_id=task.model_name,
    ))
    await db.commit()
    serialized = _serialize_task(task)
    start_background_pull(task.id)
    return {"created": True, "task": serialized, "precheck": precheck, "error_type": ""}


async def retry_pull_task(
    db: AsyncSession,
    task_id: int,
    actor: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    result = await db.execute(select(ModelPullTask).where(ModelPullTask.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        return None
    if task.status not in {"failed", "canceled", "interrupted"}:
        raise ValueError("仅 failed/canceled/interrupted 任务允许重试")
    task.status = "pending"
    task.error_type = ""
    task.error_message = ""
    task.finished_at = None
    task.last_status = "等待重试"
    task.updated_at = _now()
    db.add(OperationLog(
        type="model_pull",
        level="info",
        title="模型拉取任务已重试",
        detail=f"task_id={task.id}; model={task.model_name}; action=retry; result=pending",
        user_id=(actor or {}).get("user_id", task.created_by),
        username=(actor or {}).get("username", task.username),
        entity_id=task.model_name,
    ))
    await db.flush()
    serialized = _serialize_task(task)
    start_background_pull(task.id)
    return serialized


async def cancel_pull_task(
    db: AsyncSession,
    task_id: int,
    actor: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    task_handle = RUNNING_TASKS.get(task_id)
    if task_handle and not task_handle.done():
        task_handle.cancel()
    result = await db.execute(select(ModelPullTask).where(ModelPullTask.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        return None
    if task.status in FINAL_STATUSES:
        return _serialize_task(task)
    task.status = "canceled"
    task.error_type = "canceled"
    task.error_message = "用户取消拉取；Ollama 已下载层会保留，下次可续传"
    task.last_status = "已取消"
    task.finished_at = _now()
    task.updated_at = _now()
    db.add(OperationLog(
        type="model_pull",
        level="warning",
        title="模型拉取已取消",
        detail=f"task_id={task.id}; model={task.model_name}; attempt={task.attempt}; result=canceled",
        user_id=(actor or {}).get("user_id", task.created_by),
        username=(actor or {}).get("username", task.username),
        entity_id=task.model_name,
    ))
    await db.flush()
    return _serialize_task(task)


async def mark_interrupted_tasks() -> None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(ModelPullTask).where(ModelPullTask.status.in_(ACTIVE_STATUSES)))
        for task in result.scalars().all():
            task.status = "interrupted"
            task.error_type = "retryable_network"
            task.error_message = "后端服务重启，拉取任务已中断，可继续重试"
            task.last_status = "服务重启中断"
            task.finished_at = _now()
            task.updated_at = _now()
        await db.commit()


def start_background_pull(task_id: int) -> None:
    existing = RUNNING_TASKS.get(task_id)
    if existing and not existing.done():
        return
    RUNNING_TASKS[task_id] = asyncio.create_task(_run_pull_task(task_id))


async def _update_task(task_id: int, **values: Any) -> None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(ModelPullTask).where(ModelPullTask.id == task_id))
        task = result.scalar_one_or_none()
        if not task:
            return
        for key, value in values.items():
            if value is None:
                continue
            setattr(task, key, value)
        task.updated_at = _now()
        await db.commit()


async def _finish_with_log(task_id: int, status: str, error_type: str = "", error_message: str = "", started_perf: float | None = None) -> None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(ModelPullTask).where(ModelPullTask.id == task_id))
        task = result.scalar_one_or_none()
        if not task:
            return
        elapsed_ms = int((time.perf_counter() - started_perf) * 1000) if started_perf else 0
        task.status = status
        task.error_type = error_type
        task.error_message = error_message[:1000]
        task.finished_at = _now()
        task.updated_at = _now()
        task.last_status = "拉取完成" if status == "succeeded" else task.last_status

        if status == "succeeded":
            invalidate_system_summary()
            catalog = await get_catalog(db)
            tag = find_catalog_tag(catalog, task.model_name)
            capabilities = ((tag or {}).get("base_model") or {}).get("capabilities", [])
            current_model = await _get_config(db, "current_model", "")
            if not current_model and "embedding" not in capabilities:
                await _set_config(db, "current_model", task.model_name)

        level = "success" if status == "succeeded" else "error"
        title = "模型拉取成功" if status == "succeeded" else "模型拉取失败"
        if status == "canceled":
            level = "warning"
            title = "模型拉取已取消"
        db.add(OperationLog(
            type="model_pull",
            level=level,
            title=title,
            detail=(
                f"task_id={task.id}; model={task.model_name}; status={status}; "
                f"attempt={task.attempt}; elapsed_ms={elapsed_ms}; "
                f"error_type={error_type}; error={error_message[:200]}"
            ),
            user_id=task.created_by,
            username=task.username,
            entity_id=task.model_name,
        ))
        await db.commit()


async def _run_pull_task(task_id: int) -> None:
    started_perf = time.perf_counter()
    largest_total = 0
    largest_completed = 0
    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(ModelPullTask).where(ModelPullTask.id == task_id))
            task = result.scalar_one_or_none()
            if not task:
                return
            model_name = task.model_name
            max_attempts = task.max_attempts
            created_by = task.created_by
            username = task.username
            await db.commit()

        for attempt_index in range(max_attempts):
            attempt = attempt_index + 1
            await _update_task(
                task_id,
                status="running" if attempt == 1 else "retrying",
                attempt=attempt,
                started_at=_now() if attempt == 1 else None,
                last_status=f"开始第 {attempt} 次拉取",
                error_type="",
                error_message="",
            )
            async with AsyncSessionLocal() as db:
                services = await get_runtime_services(db)
                try:
                    async for progress in services.ollama.pull_model(model_name):
                        status = progress.get("status", "")
                        total = int(progress.get("total") or 0)
                        completed = int(progress.get("completed") or 0)
                        largest_total, largest_completed, percent = _merge_layer_progress(
                            largest_total,
                            largest_completed,
                            total,
                            completed,
                        )
                        if status == "success":
                            await _update_task(
                                task_id,
                                status="running",
                                progress_percent=100,
                                last_status="拉取完成",
                            )
                            await _finish_with_log(task_id, "succeeded", started_perf=started_perf)
                            return
                        update_values: dict[str, Any] = {
                            "status": "running",
                            "last_status": status or "拉取中",
                        }
                        if largest_total > 0:
                            update_values.update({
                                "total_bytes": largest_total,
                                "completed_bytes": largest_completed,
                                "progress_percent": percent,
                            })
                        await _update_task(task_id, **update_values)
                    await _update_task(task_id, progress_percent=100, last_status="拉取完成")
                    await _finish_with_log(task_id, "succeeded", started_perf=started_perf)
                    return
                except asyncio.CancelledError:
                    await _finish_with_log(task_id, "canceled", "canceled", "用户取消拉取；Ollama 已下载层会保留，下次可续传", started_perf)
                    raise
                except Exception as e:
                    error_type, message = _classify_error(e)
                    can_retry = error_type in RETRYABLE_ERROR_TYPES and attempt < max_attempts
                    await _update_task(
                        task_id,
                        status="retrying" if can_retry else "failed",
                        error_type=error_type,
                        error_message=message[:1000],
                        last_status="等待自动重试" if can_retry else "拉取失败",
                    )
                    if can_retry:
                        await asyncio.sleep(BACKOFF_SECONDS[min(attempt_index, len(BACKOFF_SECONDS) - 1)])
                        continue
                    await _finish_with_log(task_id, "failed", error_type, message, started_perf)
                    return
    finally:
        RUNNING_TASKS.pop(task_id, None)
