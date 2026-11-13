"""
AI 对话路由 - 流式对话 (SSE) / 会话管理
"""
import asyncio
import copy
import csv
import io
import json
import re
import time
import uuid
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from typing import AsyncIterator, Literal, Optional
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db
from app.models.operation_log import OperationLog
from app.services.agent_framework import derive_dify_base_url, get_agent_business_name, get_default_chat_agent
from app.services.device_agent import try_execute_device_command
from app.services.dify import DifyService, DifyWorkflowRunDetailError
from app.services.runtime_settings import get_runtime_services

router = APIRouter(prefix="/chat", tags=["AI 对话"])

AGENT_OVERVIEW_CACHE_TTL_SECONDS = 60
AGENT_OVERVIEW_DIFY_TIMEOUT_SECONDS = 6
AGENT_OVERVIEW_KNOWLEDGE_TIMEOUT_SECONDS = 5
AGENT_OVERVIEW_HA_TIMEOUT_SECONDS = 6
CHAT_STREAM_HEARTBEAT_SECONDS = 15.0
CHAT_QUERY_MAX_LENGTH = 20_000
CHAT_FEEDBACK_MAX_LENGTH = 2_000
_agent_overview_cache: dict[int, tuple[float, dict]] = {}
CONVERSATION_RECORD_CACHE_TTL_SECONDS = 30
CONVERSATION_RECORD_DEGRADED_CACHE_TTL_SECONDS = 120
CONVERSATION_RECORD_CONVERSATION_LIMIT = 30
CONVERSATION_RECORD_MESSAGE_LIMIT = 50
CONVERSATION_RECORD_LOCAL_RUN_LIMIT = 200
CONVERSATION_RECORD_DIFY_TIMEOUT_SECONDS = 6
CONVERSATION_RECORD_RUN_KINDS = {
    "workflow_run", "task_run", "device_control", "device_status", "platform_test", "platform_run",
}
_conversation_record_cache: dict[int, tuple[float, dict]] = {}
_conversation_record_pending: dict[int, asyncio.Task] = {}


# ── Schemas ──

class ChatRequest(BaseModel):
    query: str = Field(min_length=1, max_length=CHAT_QUERY_MAX_LENGTH)
    conversation_id: Optional[str] = Field(default="", max_length=256)

    @field_validator("query")
    @classmethod
    def query_must_have_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("问题内容不能为空")
        return value


class StopRequest(BaseModel):
    task_id: str = Field(min_length=1, max_length=256)


def _chat_stream_error_message(error: Exception) -> str:
    """将 Dify/网络异常收敛为不泄露内部地址的用户可行动诊断。"""
    if isinstance(error, httpx.TimeoutException):
        return "Dify 智能体响应超时，请稍后重试或检查工作流运行状态"
    if isinstance(error, httpx.RequestError):
        return "无法连接 Dify 智能体服务，请检查 Dify 地址、网络和服务状态"
    if isinstance(error, httpx.HTTPStatusError):
        status_code = error.response.status_code
        if status_code in {401, 403}:
            return "Dify 应用认证失败，请检查系统设置中的应用 API Key"
        if status_code == 429:
            return "Dify 请求过于频繁，请稍后重试"
        if status_code >= 500:
            return "Dify 智能体服务暂时异常，请稍后重试"
        return f"Dify 拒绝了本次请求（HTTP {status_code}），请检查工作流输入和应用配置"
    message = str(error).strip()
    if message and re.search(r"[\u4e00-\u9fff]", message) and not re.search(r"https?://|Traceback|Exception", message, re.I):
        return message
    return "智能体工作流执行失败，请查看运行记录或稍后重试"


def _dify_api_error(error: Exception, action: str) -> tuple[int, str]:
    """将 Dify 非流式接口异常转换为稳定且不泄露内部地址的 HTTP 契约。"""
    if isinstance(error, httpx.TimeoutException):
        return 504, f"{action}超时，请稍后重试或检查 Dify 服务状态"
    if isinstance(error, httpx.RequestError):
        return 503, f"{action}暂时无法连接 Dify，请检查服务地址、网络和运行状态"
    if isinstance(error, httpx.HTTPStatusError):
        status_code = error.response.status_code
        if status_code in {401, 403}:
            return 502, "Dify 应用认证失败，请检查系统设置中的应用 API Key 和访问权限"
        if status_code == 404:
            return 404, f"{action}失败：对应的 Dify 会话、消息或任务不存在"
        if status_code == 429:
            return 503, "Dify 请求过于频繁，请稍后重试"
        if status_code >= 500:
            return 502, f"{action}失败：Dify 服务暂时异常，请稍后重试"
        return 422, f"{action}被 Dify 拒绝，请检查当前会话状态和请求参数"
    message = str(error).strip()
    if message and re.search(r"[\u4e00-\u9fff]", message) and not re.search(
        r"https?://|Traceback|Exception|\b[a-z]+error\b",
        message,
        re.I,
    ):
        return 502, message
    return 502, f"{action}失败，请检查 Dify 应用配置和运行日志"


def _raise_dify_api_error(error: Exception, action: str) -> None:
    status_code, message = _dify_api_error(error, action)
    raise HTTPException(status_code=status_code, detail=message) from error


def _sanitize_chat_stream_chunk(chunk: str) -> str:
    """清洗 Dify 主动返回的失败事件，成功事件保持原始 SSE 契约。"""
    line = chunk.strip()
    if not line.startswith("data:"):
        return chunk
    try:
        payload = json.loads(line[5:].strip())
    except (TypeError, ValueError, json.JSONDecodeError):
        return chunk
    if not isinstance(payload, dict):
        return chunk
    event_type = str(payload.get("event") or "")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    workflow_failed = event_type == "workflow_finished" and str(data.get("status") or "").lower() in {"failed", "error"}
    if event_type != "error" and not workflow_failed:
        return chunk
    raw_message = data.get("error") or payload.get("message") or ""
    safe_message = _chat_stream_error_message(RuntimeError(str(raw_message)))
    if workflow_failed:
        data["error"] = safe_message
        payload["data"] = data
    else:
        payload["message"] = safe_message
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _chat_stream_with_heartbeat(
    source: AsyncIterator[str],
    heartbeat_seconds: float = CHAT_STREAM_HEARTBEAT_SECONDS,
):
    """等待 Dify 事件期间发送 SSE 注释，避免长节点被代理或浏览器误判为断流。"""
    iterator = source.__aiter__()
    pending: asyncio.Task | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(anext(iterator))
            done, _ = await asyncio.wait({pending}, timeout=heartbeat_seconds)
            if not done:
                yield ": keep-alive\n\n"
                continue
            try:
                chunk = pending.result()
            except StopAsyncIteration:
                return
            pending = None
            yield _sanitize_chat_stream_chunk(chunk)
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        close = getattr(iterator, "aclose", None)
        if close is not None:
            await close()


class FeedbackRequest(BaseModel):
    rating: Literal["like", "dislike"]
    content: Optional[str] = Field(default=None, max_length=CHAT_FEEDBACK_MAX_LENGTH)


def _datetime_to_timestamp(value: datetime | None) -> int:
    if not value:
        return 0
    return int(value.timestamp())


def _extract_detail_value(detail: str, key: str) -> str:
    match = re.search(rf"{re.escape(key)}=([^,]+)", detail or "")
    return match.group(1).strip() if match else ""


async def _get_dify_for_chat(db: AsyncSession) -> DifyService:
    services = await get_runtime_services(db)
    instance = await get_default_chat_agent(db)
    if instance and (instance.dify_api_key or "").strip():
        base_url = derive_dify_base_url(instance.dify_console_url) or services.config.dify_base_url
        return DifyService(base_url=base_url, api_key=instance.dify_api_key)
    return services.dify


def _record_usage_tokens(item: dict) -> int | None:
    usage = item.get("usage") or {}
    if not isinstance(usage, dict):
        return None
    for key in ("total_tokens", "total_token", "tokens"):
        value = usage.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return None


class _UnconfiguredProbe(RuntimeError):
    pass


def _unpack_probe_result(result, fallback):
    """解析并发探测结果；异常对象和畸形返回都按局部失败处理。"""
    if isinstance(result, tuple) and len(result) == 2:
        payload, latency = result
        try:
            return payload, max(0, int(latency)), ""
        except (TypeError, ValueError):
            pass
    if isinstance(result, _UnconfiguredProbe):
        return fallback, None, str(result)
    if isinstance(result, httpx.HTTPStatusError):
        status_code = result.response.status_code
        if status_code in {401, 403}:
            message = "服务可达，但访问凭证未通过验证"
        else:
            message = f"服务已响应，但返回 HTTP {status_code}"
        return fallback, None, message
    if isinstance(result, (httpx.TimeoutException, asyncio.TimeoutError)):
        return fallback, None, "远端服务连接超时，请检查服务状态和网络"
    if isinstance(result, httpx.RequestError):
        return fallback, None, "远端服务无法建立连接，请检查服务地址和网络"
    raw_message = str(result).strip() or type(result).__name__
    lowered = raw_message.lower()
    if "server disconnected" in lowered:
        message = "远端服务已断开连接，请检查服务状态和网络"
    elif any(token in lowered for token in ("connecttimeout", "readtimeout", "timed out", "timeout")):
        message = "远端服务连接超时，请检查服务状态和网络"
    elif any(token in lowered for token in ("all connection attempts failed", "connection refused", "connecterror")):
        message = "远端服务无法建立连接，请检查服务地址和网络"
    elif re.search(r"[\u4e00-\u9fff]", raw_message) and "http://" not in lowered and "https://" not in lowered:
        message = raw_message
    else:
        message = "远端服务探测未完成，请检查服务配置和运行状态"
    return fallback, None, message


def _probe_status(result, error: str) -> tuple[str, int | None]:
    if not error:
        return "running", None
    if isinstance(result, _UnconfiguredProbe):
        return "unconfigured", None
    if isinstance(result, httpx.HTTPStatusError):
        status_code = result.response.status_code
        return ("auth_error" if status_code in {401, 403} else "error"), status_code
    if isinstance(result, (httpx.TimeoutException, asyncio.TimeoutError, httpx.RequestError)):
        return "stopped", None
    return "error", None


async def _build_agent_runtime_overview(db: AsyncSession, current_user: dict) -> dict:
    """聚合默认智能体近 24 小时真实运行指标，不制造推理或设备模拟数据。"""
    services = await get_runtime_services(db)
    instance = await get_default_chat_agent(db)
    dify = await _get_dify_for_chat(db)
    user_id = f"user-{current_user['user_id']}"
    since = datetime.now() - timedelta(hours=24)
    since_timestamp = int(since.timestamp())

    async def load_records() -> tuple[dict, int]:
        if not configured:
            raise _UnconfiguredProbe("Dify 应用 API Key 未配置")
        started = time.perf_counter()
        payload = await dify.get_conversation_records(
            user=user_id,
            view="history",
            start_time=since_timestamp,
            conversation_limit=50,
            message_limit=100,
        )
        return payload, int((time.perf_counter() - started) * 1000)

    async def load_knowledge() -> tuple[dict, int]:
        if not knowledge_configured:
            raise _UnconfiguredProbe("Dify Dataset API Key 未配置")
        started = time.perf_counter()
        payload = await services.dify_knowledge.list_datasets(page=1, limit=1)
        return payload, int((time.perf_counter() - started) * 1000)

    async def load_ha_health() -> tuple[bool, int]:
        if not home_assistant_configured:
            raise _UnconfiguredProbe("Home Assistant 长效 Token 未配置")
        started = time.perf_counter()
        if not ha_direct_probe_configured:
            healthy = await services.homeassistant.check_health()
            if not healthy:
                raise RuntimeError("Home Assistant 健康检查未通过")
            return True, int((time.perf_counter() - started) * 1000)
        async with httpx.AsyncClient(timeout=AGENT_OVERVIEW_HA_TIMEOUT_SECONDS, trust_env=False) as client:
            response = await client.get(
                f"{services.config.ha_base_url.rstrip('/')}/api/",
                headers={"Authorization": f"Bearer {services.config.ha_token}"},
            )
            response.raise_for_status()
        return True, int((time.perf_counter() - started) * 1000)

    runtime_dify_key = str(getattr(getattr(services, "config", None), "dify_api_key", "") or "").strip()
    configured = bool(instance and ((instance.dify_api_key or "").strip() or runtime_dify_key))
    runtime_config = getattr(services, "config", None)
    knowledge_configured = bool(str(getattr(runtime_config, "dify_dataset_api_key", "") or "").strip()) if runtime_config is not None and hasattr(runtime_config, "dify_dataset_api_key") else True
    ha_direct_probe_configured = bool(runtime_config is not None and hasattr(runtime_config, "ha_base_url") and hasattr(runtime_config, "ha_token"))
    home_assistant_configured = bool(
        str(getattr(runtime_config, "ha_base_url", "") or "").strip()
        and str(getattr(runtime_config, "ha_token", "") or "").strip()
    ) if ha_direct_probe_configured else True

    records_result, knowledge_result, ha_result = await asyncio.gather(
        asyncio.wait_for(load_records(), timeout=AGENT_OVERVIEW_DIFY_TIMEOUT_SECONDS),
        asyncio.wait_for(load_knowledge(), timeout=AGENT_OVERVIEW_KNOWLEDGE_TIMEOUT_SECONDS),
        asyncio.wait_for(load_ha_health(), timeout=AGENT_OVERVIEW_HA_TIMEOUT_SECONDS),
        return_exceptions=True,
    )

    records, dify_latency, dify_error = _unpack_probe_result(
        records_result,
        {"items": [], "stats": {}},
    )
    knowledge, knowledge_latency, knowledge_error = _unpack_probe_result(
        knowledge_result,
        {"data": [], "total": 0},
    )
    ha_healthy, ha_latency, ha_error = _unpack_probe_result(ha_result, False)
    dify_status, dify_http_status = _probe_status(records_result, dify_error)
    knowledge_status, knowledge_http_status = _probe_status(knowledge_result, knowledge_error)
    ha_status, ha_http_status = _probe_status(ha_result, ha_error)

    items = list(records.get("items") or [])
    record_meta = records.get("_meta") or {}
    likes = 0
    dislikes = 0
    retrieval_messages = 0
    retrieval_segments = 0
    total_tokens = 0
    token_message_count = 0
    latest_activity_at = 0
    for item in items:
        feedback = item.get("feedback") or {}
        rating = feedback.get("rating") if isinstance(feedback, dict) else ""
        likes += int(rating == "like")
        dislikes += int(rating == "dislike")
        resources = item.get("retriever_resources") or []
        if resources:
            retrieval_messages += 1
            retrieval_segments += len(resources)
        message_tokens = _record_usage_tokens(item)
        if message_tokens is not None:
            total_tokens += message_tokens
            token_message_count += 1
        latest_activity_at = max(latest_activity_at, int(item.get("created_at") or 0))

    log_query = (
        select(OperationLog.type, OperationLog.level, func.count(OperationLog.id), func.max(OperationLog.created_at))
        .where(
            OperationLog.created_at >= since,
            OperationLog.type.in_(["agent_control", "agent_device_status", "agent_test"]),
        )
        .group_by(OperationLog.type, OperationLog.level)
    )
    if current_user.get("user_id"):
        log_query = log_query.where(OperationLog.user_id == current_user["user_id"])
    log_rows = (await db.execute(log_query)).all()
    local_runs = 0
    local_success = 0
    device_controls = 0
    device_control_success = 0
    for log_type, level, count, latest_at in log_rows:
        count = int(count or 0)
        local_runs += count
        local_success += count if level == "success" else 0
        if log_type == "agent_control":
            device_controls += count
            device_control_success += count if level == "success" else 0
        latest_activity_at = max(latest_activity_at, _datetime_to_timestamp(latest_at))

    message_count = len(items)
    conversation_count = len({str(item.get("conversation_id") or "") for item in items if item.get("conversation_id")})
    feedback_count = likes + dislikes
    knowledge_total = int(knowledge.get("total") or len(knowledge.get("data") or []))
    dify_healthy = not bool(dify_error)
    knowledge_healthy = not bool(knowledge_error)
    home_assistant_healthy = bool(ha_healthy and not ha_error)
    dify_metrics_complete = bool(
        dify_healthy
        and not record_meta.get("conversation_has_more")
        and not record_meta.get("message_truncated_conversations")
        and not record_meta.get("message_load_error_count")
    )
    token_coverage_complete = bool(dify_metrics_complete and token_message_count == message_count)
    all_runtime_sources_available = dify_healthy and knowledge_healthy and home_assistant_healthy

    return {
        "agent": {
            "id": instance.id if instance else None,
            "name": get_agent_business_name(instance, default_context=True),
            "runtime_name": instance.name if instance else "",
            "model": instance.default_model if instance and instance.default_model else "由 Dify 应用配置",
            "status": "running" if configured and all_runtime_sources_available else "degraded" if configured else "unconfigured",
            "instance_type": instance.instance_type if instance else "",
            "knowledge_bindings": len(instance.knowledge_bindings or []) if instance else 0,
        },
        "window": {"label": "近 24 小时", "hours": 24, "since": since.isoformat()},
        "coverage": {
            "complete": bool(
                not dify_error
                and knowledge_healthy
                and home_assistant_healthy
                and not record_meta.get("conversation_has_more")
                and not record_meta.get("message_truncated_conversations")
                and not record_meta.get("message_load_error_count")
                and token_coverage_complete
            ),
            "conversation_limit": 50,
            "message_limit_per_conversation": 100,
            "conversation_count_loaded": int(record_meta.get("conversation_count_loaded") or 0),
            "conversation_has_more": bool(record_meta.get("conversation_has_more")),
            "message_truncated_conversations": int(record_meta.get("message_truncated_conversations") or 0),
            "message_load_error_count": int(record_meta.get("message_load_error_count") or 0),
            "dify_records_available": dify_healthy,
            "dify_metrics_complete": dify_metrics_complete,
            "token_message_count": token_message_count if dify_healthy else 0,
            "token_coverage_complete": token_coverage_complete,
            "knowledge_available": knowledge_healthy,
            "home_assistant_available": home_assistant_healthy,
        },
        "metrics": {
            "conversation_count": conversation_count if dify_healthy else None,
            "message_count": message_count if dify_healthy else None,
            "feedback_count": feedback_count if dify_healthy else None,
            "positive_feedback_count": likes if dify_healthy else None,
            "negative_feedback_count": dislikes if dify_healthy else None,
            "positive_feedback_rate": round(likes / feedback_count * 100, 1) if dify_healthy and feedback_count else None,
            "retrieval_message_count": retrieval_messages if dify_healthy else None,
            "retrieval_segment_count": retrieval_segments if dify_healthy else None,
            "device_control_count": device_controls,
            "device_control_success_count": device_control_success,
            "device_control_success_rate": round(device_control_success / device_controls * 100, 1) if device_controls else None,
            "local_run_count": local_runs,
            "local_run_success_rate": round(local_success / local_runs * 100, 1) if local_runs else None,
            "total_tokens": total_tokens if dify_healthy and token_message_count else None,
        },
        "services": [
            {
                "key": "dify",
                "name": "Dify 智能体",
                "status": dify_status,
                "latency_ms": dify_latency,
                "http_status": dify_http_status,
                "detail": "应用 API 可用" if dify_healthy else "应用 API 未配置" if dify_status == "unconfigured" else "应用 API 不可用",
                "error": dify_error,
            },
            {
                "key": "knowledge",
                "name": "知识库",
                "status": knowledge_status,
                "latency_ms": knowledge_latency,
                "http_status": knowledge_http_status,
                "detail": f"已连接 {knowledge_total} 个知识库" if knowledge_healthy else "Dataset API 未配置" if knowledge_status == "unconfigured" else "Dataset API 不可用",
                "error": knowledge_error,
            },
            {
                "key": "home_assistant",
                "name": "Home Assistant",
                "status": ha_status,
                "latency_ms": ha_latency,
                "http_status": ha_http_status,
                "detail": "状态读取与命令下发接口可用" if ha_healthy else "设备服务未配置" if ha_status == "unconfigured" else "设备服务不可用",
                "error": ha_error,
            },
        ],
        "latest_activity_at": latest_activity_at or None,
        "generated_at": datetime.now().isoformat(),
        "cache_ttl_seconds": AGENT_OVERVIEW_CACHE_TTL_SECONDS,
        "data_sources": ["Dify 消息与反馈", "Dify Dataset API", "平台设备执行日志", "Home Assistant 健康检查"],
    }


async def _append_agent_runtime_logs(
    payload: dict,
    db: AsyncSession,
    current_user: dict,
    *,
    keyword: str = "",
    start_time: Optional[int] = None,
    end_time: Optional[int] = None,
) -> dict:
    """把平台侧智能体测试审计补进运行记录，避免 Dify 缺少 workflow_run_id 时页面空白。"""
    items = list(payload.get("items") or [])
    existing_by_message = {
        item.get("message_id"): item
        for item in items
        if item.get("message_id")
    }

    query = select(OperationLog).where(OperationLog.type.in_(["agent_test", "agent_control", "agent_device_status"]))
    user_id = current_user.get("user_id")
    if user_id:
        query = query.where(OperationLog.user_id == user_id)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(or_(
            OperationLog.title.ilike(like),
            OperationLog.detail.ilike(like),
            OperationLog.entity_id.ilike(like),
        ))

    result = await db.execute(
        query.order_by(OperationLog.created_at.desc()).limit(CONVERSATION_RECORD_LOCAL_RUN_LIMIT + 1)
    )
    fetched_rows = result.scalars().all()
    local_run_has_more = len(fetched_rows) > CONVERSATION_RECORD_LOCAL_RUN_LIMIT
    rows = fetched_rows[:CONVERSATION_RECORD_LOCAL_RUN_LIMIT]

    for row in rows:
        created_at = _datetime_to_timestamp(row.created_at)
        if start_time and created_at < start_time:
            continue
        if end_time and created_at > end_time:
            continue

        detail = row.detail or ""
        message_id = _extract_detail_value(detail, "message_id")
        workflow_run_id = _extract_detail_value(detail, "workflow_run_id")
        existing = existing_by_message.get(message_id) if message_id else None
        if existing:
            if workflow_run_id and not existing.get("workflow_run_id"):
                existing["workflow_run_id"] = workflow_run_id
                existing["debug_available"] = True
                existing["run_status"] = "节点级运行记录"
            existing["record_source"] = "dify_messages+operation_logs"
            existing["runtime_evidence_type"] = row.type
            existing["runtime_evidence_level"] = row.level
            continue

        log_message_id = message_id or f"operation-log-{row.id}"
        is_local_control = row.type in {"agent_control", "agent_device_status"}
        answer = _extract_detail_value(detail, "answer")
        items.append({
            "conversation_id": f"operation-log-{row.id}",
            "conversation_name": row.title,
            "conversation_updated_at": created_at,
            "message_id": log_message_id,
            "query": _extract_detail_value(detail, "query") or row.title,
            "answer": answer,
            "created_at": created_at,
            "feedback": None,
            "workflow_run_id": workflow_run_id,
            "task_id": "",
            "usage": {
                "source": "operation_logs",
                "type": row.type,
                "level": row.level,
                "entity_id": row.entity_id or "",
                "log_id": row.id,
            },
            "retriever_resources": [],
            "record_source": "local_device_control" if is_local_control else "operation_logs",
            "record_kind": (
                "device_status" if row.type == "agent_device_status"
                else "device_control" if row.type == "agent_control"
                else "platform_test"
            ),
            "debug_available": bool(workflow_run_id),
            "run_status": (
                "本地设备状态回读" if row.type == "agent_device_status"
                else "本地设备控制成功" if is_local_control and row.level == "success"
                else "设备控制已下发，待实机确认" if is_local_control and row.level == "warning"
                else "本地设备控制失败" if is_local_control
                else "节点级运行记录" if workflow_run_id
                else "测试失败记录" if row.level == "error"
                else "平台测试记录"
            ),
        })

    items.sort(key=lambda item: item.get("created_at", 0), reverse=True)
    payload["items"] = items
    payload["stats"] = _conversation_record_stats(items)
    payload.setdefault("_meta", {})["local_run_has_more"] = local_run_has_more
    return payload


def _clear_conversation_record_cache(user_id: int) -> None:
    _conversation_record_cache.pop(user_id, None)


def _is_conversation_message(item: dict) -> bool:
    """只有 Dify 消息属于会话历史，平台审计不能伪装成一轮对话。"""
    source = str(item.get("record_source") or "")
    conversation_id = str(item.get("conversation_id") or "")
    return bool(
        source in {"dify_messages", "dify_messages+operation_logs"}
        and conversation_id
        and not conversation_id.startswith("operation-log-")
    )


def _is_conversation_run(item: dict) -> bool:
    """运行记录必须有 Workflow/任务标识或明确的平台运行审计。"""
    source = str(item.get("record_source") or "")
    return bool(
        item.get("workflow_run_id")
        or item.get("task_id")
        or source in {"operation_logs", "local_device_control", "dify_messages+operation_logs"}
    )


def _conversation_record_kind(item: dict) -> str:
    usage = item.get("usage") or {}
    log_type = str(usage.get("type") or item.get("runtime_evidence_type") or "")
    if item.get("workflow_run_id"):
        return "workflow_run"
    if item.get("task_id"):
        return "task_run"
    if log_type == "agent_device_status":
        return "device_status"
    if log_type == "agent_control":
        return "device_control"
    if log_type == "agent_test":
        return "platform_test"
    if _is_conversation_message(item):
        return "conversation_message"
    return "platform_run"


def _conversation_record_matches(
    item: dict,
    *,
    view: str,
    keyword: str,
    rating: str,
    has_workflow_run: Optional[bool],
    run_kind: str,
    start_time: Optional[int],
    end_time: Optional[int],
    conversation_id: str = "",
) -> bool:
    if conversation_id and str(item.get("conversation_id") or "") != conversation_id:
        return False
    created_at = int(item.get("created_at") or 0)
    if start_time and created_at < start_time:
        return False
    if end_time and created_at > end_time:
        return False

    feedback = item.get("feedback") or {}
    item_rating = feedback.get("rating") if isinstance(feedback, dict) else ""
    is_message = _is_conversation_message(item)
    is_run = _is_conversation_run(item)
    if rating and (not is_message or item_rating != rating):
        return False
    if view == "history" and not is_message:
        return False
    if view == "feedback" and (not is_message or not item_rating):
        return False
    if view == "runs" and not is_run:
        return False
    if run_kind and _conversation_record_kind(item) != run_kind:
        return False
    if has_workflow_run is True and not item.get("workflow_run_id"):
        return False
    if has_workflow_run is False and item.get("workflow_run_id"):
        return False

    normalized_keyword = keyword.strip().lower()
    if normalized_keyword:
        haystack = " ".join([
            str(item.get("conversation_name") or ""),
            str(item.get("query") or ""),
            str(item.get("answer") or ""),
            str(item.get("run_status") or ""),
            str(item.get("record_source") or ""),
        ]).lower()
        if normalized_keyword not in haystack:
            return False
    return True


def _conversation_record_stats(items: list[dict]) -> dict:
    conversation_messages = [item for item in items if _is_conversation_message(item)]
    conversation_ids = {
        str(item.get("conversation_id") or "")
        for item in conversation_messages
        if item.get("conversation_id")
    }
    feedbacks = [
        item.get("feedback") or {}
        for item in conversation_messages
        if isinstance(item.get("feedback"), dict)
    ]
    likes = sum(1 for item in feedbacks if item.get("rating") == "like")
    dislikes = sum(1 for item in feedbacks if item.get("rating") == "dislike")
    workflow_runs = sum(1 for item in items if item.get("workflow_run_id"))
    run_items = [item for item in items if _is_conversation_run(item)]
    kinds = [_conversation_record_kind(item) for item in run_items]
    def explicit_failure(value: object) -> bool:
        normalized = str(value or "").strip().lower()
        return normalized in {"error", "failed", "failure"} or "异常" in normalized or "失败" in normalized

    abnormal = sum(1 for item in items if (
        (isinstance(item.get("feedback"), dict) and item["feedback"].get("rating") == "dislike")
        or (_is_conversation_message(item) and not str(item.get("answer") or "").strip())
        or explicit_failure((item.get("usage") or {}).get("level"))
        or explicit_failure(item.get("run_status"))
    ))
    return {
        "conversation_count": len(conversation_ids),
        "message_count": len(conversation_messages),
        "record_count": len(items),
        "feedback_count": likes + dislikes,
        "positive_feedback_count": likes,
        "negative_feedback_count": dislikes,
        "run_count": len(run_items),
        "workflow_run_count": workflow_runs,
        "platform_run_count": sum(
            1 for kind in kinds
            if kind in {"device_control", "device_status", "platform_test", "platform_run"}
        ),
        "device_control_count": kinds.count("device_control"),
        "device_status_count": kinds.count("device_status"),
        "platform_test_count": kinds.count("platform_test"),
        "abnormal_count": abnormal,
    }


async def _load_conversation_record_snapshot(
    db: AsyncSession,
    current_user: dict,
) -> dict:
    """读取有明确上限的当前用户运行快照，供分页、筛选和导出复用。"""
    user_id = f"user-{current_user['user_id']}"
    dify = await _get_dify_for_chat(db)
    dify_error = ""
    try:
        payload = await asyncio.wait_for(
            dify.get_conversation_records(
                user=user_id,
                view="history",
                conversation_limit=CONVERSATION_RECORD_CONVERSATION_LIMIT,
                message_limit=CONVERSATION_RECORD_MESSAGE_LIMIT,
            ),
            timeout=CONVERSATION_RECORD_DIFY_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        payload = {"items": [], "stats": {}}
        dify_error = f"Dify 会话历史读取超过 {CONVERSATION_RECORD_DIFY_TIMEOUT_SECONDS} 秒"
    except Exception as exc:
        payload = {"items": [], "stats": {}}
        dify_error = str(exc)

    payload = await _append_agent_runtime_logs(payload, db, current_user)
    items = list(payload.get("items") or [])
    for item in items:
        item["record_kind"] = _conversation_record_kind(item)
        item["feedback_supported"] = _is_conversation_message(item) and bool(item.get("message_id"))
        item["available_views"] = [
            view
            for view in ("history", "runs", "feedback")
            if _conversation_record_matches(
                item,
                view=view,
                keyword="",
                rating="",
                has_workflow_run=None,
                run_kind="",
                start_time=None,
                end_time=None,
            )
        ]
    items.sort(key=lambda item: int(item.get("created_at") or 0), reverse=True)
    sources = sorted({str(item.get("record_source") or "未知来源") for item in items})
    upstream_meta = payload.get("_meta") or {}
    snapshot_truncated = bool(
        upstream_meta.get("conversation_has_more")
        or upstream_meta.get("message_truncated_conversations")
        or upstream_meta.get("local_run_has_more")
    )
    cache_ttl_seconds = (
        CONVERSATION_RECORD_DEGRADED_CACHE_TTL_SECONDS
        if dify_error
        else CONVERSATION_RECORD_CACHE_TTL_SECONDS
    )
    return {
        "items": items,
        "stats": _conversation_record_stats(items),
        "meta": {
            "generated_at": datetime.now().astimezone().isoformat(),
            "cache_ttl_seconds": cache_ttl_seconds,
            "conversation_limit": CONVERSATION_RECORD_CONVERSATION_LIMIT,
            "message_limit_per_conversation": CONVERSATION_RECORD_MESSAGE_LIMIT,
            "local_run_limit": CONVERSATION_RECORD_LOCAL_RUN_LIMIT,
            "data_sources": sources,
            "dify_available": not bool(dify_error),
            "dify_error": dify_error,
            "snapshot_truncated": snapshot_truncated,
            "conversation_has_more": bool(upstream_meta.get("conversation_has_more")),
            "message_truncated_conversations": int(upstream_meta.get("message_truncated_conversations") or 0),
            "message_load_error_count": int(upstream_meta.get("message_load_error_count") or 0),
            "local_run_has_more": bool(upstream_meta.get("local_run_has_more")),
        },
    }


def _conversation_record_coverage(meta: dict) -> dict:
    reasons = []
    if not meta.get("dify_available", True):
        reasons.append("Dify 会话与评价当前不可读取")
    if meta.get("conversation_has_more"):
        reasons.append(f"Dify 会话仅载入最近 {meta.get('conversation_limit', CONVERSATION_RECORD_CONVERSATION_LIMIT)} 个")
    truncated_messages = int(meta.get("message_truncated_conversations") or 0)
    if truncated_messages:
        reasons.append(f"{truncated_messages} 个会话仍有更早消息未载入")
    failed_messages = int(meta.get("message_load_error_count") or 0)
    if failed_messages:
        reasons.append(f"{failed_messages} 个会话的消息读取失败")
    if meta.get("local_run_has_more"):
        reasons.append(f"平台运行日志仅载入最近 {meta.get('local_run_limit', CONVERSATION_RECORD_LOCAL_RUN_LIMIT)} 条")
    return {
        "complete": not reasons,
        "snapshot_truncated": bool(meta.get("snapshot_truncated")),
        "reasons": reasons,
        "limits": {
            "conversation_limit": int(meta.get("conversation_limit") or CONVERSATION_RECORD_CONVERSATION_LIMIT),
            "message_limit_per_conversation": int(meta.get("message_limit_per_conversation") or CONVERSATION_RECORD_MESSAGE_LIMIT),
            "local_run_limit": int(meta.get("local_run_limit") or CONVERSATION_RECORD_LOCAL_RUN_LIMIT),
        },
    }


async def _get_conversation_record_snapshot(
    db: AsyncSession,
    current_user: dict,
    *,
    refresh: bool,
) -> tuple[dict, str]:
    user_id = int(current_user["user_id"])
    now = time.monotonic()
    cached = _conversation_record_cache.get(user_id)
    if not refresh and cached and cached[0] > now:
        return copy.deepcopy(cached[1]), "hit"
    task = _conversation_record_pending.get(user_id) if not refresh else None
    shared = bool(task)
    if not task:
        task = asyncio.create_task(_load_conversation_record_snapshot(db, current_user))
        _conversation_record_pending[user_id] = task
    try:
        payload = await asyncio.shield(task)
        cache_ttl_seconds = int(
            payload.get("meta", {}).get("cache_ttl_seconds")
            or CONVERSATION_RECORD_CACHE_TTL_SECONDS
        )
        _conversation_record_cache[user_id] = (
            time.monotonic() + cache_ttl_seconds,
            copy.deepcopy(payload),
        )
        return copy.deepcopy(payload), "shared" if shared else "miss"
    finally:
        if task.done() and _conversation_record_pending.get(user_id) is task:
            _conversation_record_pending.pop(user_id, None)


def _filter_conversation_record_snapshot(
    snapshot: dict,
    *,
    view: str,
    keyword: str,
    rating: str,
    has_workflow_run: Optional[bool],
    run_kind: str,
    start_time: Optional[int],
    end_time: Optional[int],
    conversation_id: str = "",
) -> list[dict]:
    return [
        item for item in snapshot.get("items") or []
        if _conversation_record_matches(
            item,
            view=view,
            keyword=keyword,
            rating=rating,
            has_workflow_run=has_workflow_run,
            run_kind=run_kind,
            start_time=start_time,
            end_time=end_time,
            conversation_id=conversation_id,
        )
    ]


def _conversation_csv_cell(value: object) -> str:
    text_value = str(value or "")
    if text_value.startswith(("=", "+", "-", "@")):
        return f"'{text_value}"
    return text_value


# ── 健康检查 ──

@router.get("/health", summary="对话模块健康检查")
async def health():
    return {"status": "ok", "module": "chat"}


@router.get("/overview", summary="默认智能体真实运行概览")
async def agent_runtime_overview(
    refresh: bool = Query(False, description="是否跳过 60 秒缓存"),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cache_key = int(current_user["user_id"])
    cached = _agent_overview_cache.get(cache_key)
    if not refresh and cached and time.monotonic() - cached[0] < AGENT_OVERVIEW_CACHE_TTL_SECONDS:
        return {**cached[1], "cache": "hit"}

    payload = await _build_agent_runtime_overview(db, current_user)
    _agent_overview_cache[cache_key] = (time.monotonic(), payload)
    return {**payload, "cache": "miss"}


# ── 流式对话 (SSE) ──

@router.post("/completions", summary="AI 流式对话")
async def chat_completions(
    body: ChatRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    调用 Dify Chatflow API 进行流式对话
    返回 text/event-stream，前端通过 EventSource / fetch 消费
    """
    local_control = await try_execute_device_command(body.query, current_user, db)
    if local_control is not None:
        message_id = str(local_control.get("message_id") or f"local-control-{uuid.uuid4().hex}")
        _clear_conversation_record_cache(int(current_user["user_id"]))

        async def local_event_generator():
            metadata = {
                "execution_source": local_control["source"],
                "device_id": local_control.get("device_id", ""),
                "entity_id": local_control.get("entity_id", ""),
                "action": local_control.get("action", ""),
                "success": local_control["success"],
                "confirmation": local_control.get("confirmation", ""),
            }
            yield f"data: {json.dumps({'event': 'message', 'message_id': message_id, 'answer': local_control['answer'], 'metadata': metadata}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'event': 'message_end', 'message_id': message_id, 'metadata': metadata}, ensure_ascii=False)}\n\n"

        return StreamingResponse(
            local_event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    user_id = f"user-{current_user['user_id']}"
    dify = await _get_dify_for_chat(db)

    async def event_generator():
        try:
            source = dify.chat_stream(
                query=body.query,
                user=user_id,
                conversation_id=body.conversation_id or "",
            )
            async for chunk in _chat_stream_with_heartbeat(source):
                yield chunk
        except Exception as e:
            import traceback
            traceback.print_exc()
            error_data = json.dumps({"event": "error", "message": _chat_stream_error_message(e)}, ensure_ascii=False)
            yield f"data: {error_data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── 阻塞式对话（备用） ──

@router.post("/blocking", summary="AI 阻塞式对话")
async def chat_blocking(
    body: ChatRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """调用 Dify Chatflow API — 阻塞模式，返回完整回复"""
    local_control = await try_execute_device_command(body.query, current_user, db)
    if local_control is not None:
        _clear_conversation_record_cache(int(current_user["user_id"]))
        return {
            "answer": local_control["answer"],
            "message_id": str(local_control.get("message_id") or f"local-control-{uuid.uuid4().hex}"),
            "conversation_id": "",
            "metadata": {
                "execution_source": local_control["source"],
                "device_id": local_control.get("device_id", ""),
                "entity_id": local_control.get("entity_id", ""),
                "action": local_control.get("action", ""),
                "success": local_control["success"],
                "confirmation": local_control.get("confirmation", ""),
            },
        }

    user_id = f"user-{current_user['user_id']}"
    dify = await _get_dify_for_chat(db)
    try:
        result = await dify.chat(
            query=body.query,
            user=user_id,
            conversation_id=body.conversation_id or "",
        )
        return result
    except Exception as exc:
        _raise_dify_api_error(exc, "智能体请求")


# ── 会话列表 ──

@router.get("/conversations", summary="获取会话列表")
async def get_conversations(
    last_id: str = Query("", description="分页游标"),
    limit: int = Query(20, ge=1, le=100),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = f"user-{current_user['user_id']}"
    dify = await _get_dify_for_chat(db)
    try:
        return await dify.get_conversations(
            user=user_id, last_id=last_id, limit=limit
        )
    except Exception as exc:
        # 云端 Dify 不可达或实例版本不支持会话接口时，不阻断本地设备控制页面。
        _status_code, message = _dify_api_error(exc, "Dify 会话历史读取")
        return {
            "data": [],
            "has_more": False,
            "limit": limit,
            "external_service_error": message,
        }


# ── 会话历史消息 ──

@router.get("/messages", summary="获取会话历史消息")
async def get_messages(
    conversation_id: str = Query(..., description="会话 ID"),
    first_id: str = Query("", description="分页游标"),
    limit: int = Query(20, ge=1, le=100),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = f"user-{current_user['user_id']}"
    dify = await _get_dify_for_chat(db)
    try:
        return await dify.get_messages(
            conversation_id=conversation_id,
            user=user_id,
            first_id=first_id,
            limit=limit,
        )
    except Exception as exc:
        _raise_dify_api_error(exc, "会话消息读取")


@router.get("/records", summary="获取会话与运行记录")
async def get_conversation_records(
    view: str = Query("history", description="视图类型: history / runs / feedback"),
    keyword: str = Query("", description="关键词"),
    conversation_id: str = "",
    rating: str = Query("", description="评估筛选: like / dislike"),
    has_workflow_run: Optional[bool] = Query(None, description="是否仅返回带 workflow_run_id 的消息"),
    run_kind: str = Query("", description="运行类型筛选"),
    start_time: Optional[int] = Query(None, description="开始时间戳"),
    end_time: Optional[int] = Query(None, description="结束时间戳"),
    page: int = Query(1, ge=1, description="页码"),
    size: int = Query(20, ge=1, le=100, description="每页条数"),
    group_conversations: bool = False,
    refresh: bool = Query(False, description="是否跳过 30 秒快照缓存"),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if view not in {"history", "runs", "feedback"}:
        raise HTTPException(status_code=400, detail="view 必须是 history、runs 或 feedback")
    if rating and rating not in {"like", "dislike"}:
        raise HTTPException(status_code=400, detail="rating 必须是 like 或 dislike")
    if run_kind and run_kind not in CONVERSATION_RECORD_RUN_KINDS:
        raise HTTPException(status_code=400, detail="不支持的运行类型筛选")
    if start_time and end_time and start_time > end_time:
        raise HTTPException(status_code=422, detail="开始时间不能晚于结束时间")
    try:
        snapshot, cache_status = await _get_conversation_record_snapshot(
            db,
            current_user,
            refresh=refresh,
        )
        filtered = _filter_conversation_record_snapshot(
            snapshot,
            view=view,
            keyword=keyword,
            rating=rating,
            has_workflow_run=has_workflow_run,
            run_kind=run_kind,
            start_time=start_time,
            end_time=end_time,
            conversation_id=conversation_id,
        )
        total = len(filtered)
        if view == "history" and group_conversations:
            conversation_ids = list(dict.fromkeys(
                str(item.get("conversation_id") or "") for item in filtered
                if item.get("conversation_id")
            ))
            total = len(conversation_ids)
            page_count = max(1, (total + size - 1) // size)
            safe_page = min(page, page_count)
            offset = (safe_page - 1) * size
            selected_ids = set(conversation_ids[offset:offset + size])
            page_items = [
                item for item in filtered
                if str(item.get("conversation_id") or "") in selected_ids
            ]
        else:
            page_count = max(1, (total + size - 1) // size)
            safe_page = min(page, page_count)
            offset = (safe_page - 1) * size
            page_items = filtered[offset:offset + size]
        meta = {**snapshot.get("meta", {}), "cache": cache_status}
        return {
            "items": page_items,
            "total": total,
            "page": safe_page,
            "size": size,
            "stats": _conversation_record_stats(filtered),
            "snapshot_stats": snapshot.get("stats", {}),
            "meta": meta,
        }
    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/records/export", summary="导出会话与运行记录")
async def export_conversation_records(
    view: str = Query("history", description="视图类型"),
    keyword: str = Query("", description="关键词"),
    conversation_id: str = "",
    rating: str = Query("", description="评估筛选"),
    has_workflow_run: Optional[bool] = Query(None, description="是否带 Workflow 运行标识"),
    run_kind: str = Query("", description="运行类型筛选"),
    start_time: Optional[int] = Query(None, description="开始时间戳"),
    end_time: Optional[int] = Query(None, description="结束时间戳"),
    format: str = Query("csv", description="csv / json"),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if view not in {"history", "runs", "feedback"}:
        raise HTTPException(status_code=400, detail="view 必须是 history、runs 或 feedback")
    if rating and rating not in {"like", "dislike"}:
        raise HTTPException(status_code=400, detail="rating 必须是 like 或 dislike")
    if run_kind and run_kind not in CONVERSATION_RECORD_RUN_KINDS:
        raise HTTPException(status_code=400, detail="不支持的运行类型筛选")
    if format not in {"csv", "json"}:
        raise HTTPException(status_code=400, detail="format 必须是 csv 或 json")
    if start_time and end_time and start_time > end_time:
        raise HTTPException(status_code=422, detail="开始时间不能晚于结束时间")

    try:
        snapshot, _cache_status = await _get_conversation_record_snapshot(
            db,
            current_user,
            refresh=False,
        )
        filtered = _filter_conversation_record_snapshot(
            snapshot,
            view=view,
            keyword=keyword,
            rating=rating,
            has_workflow_run=has_workflow_run,
            run_kind=run_kind,
            start_time=start_time,
            end_time=end_time,
            conversation_id=conversation_id,
        )
        truncated = len(filtered) > 5000
        rows = filtered[:5000]
        coverage = _conversation_record_coverage(snapshot.get("meta", {}))
        coverage_text = "完整快照" if coverage["complete"] else "；".join(coverage["reasons"])
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        if format == "json":
            content = json.dumps({
                "exported_at": datetime.now().astimezone().isoformat(),
                "view": view,
                "run_kind": run_kind,
                "count": len(rows),
                "truncated": truncated,
                "coverage": coverage,
                "items": rows,
            }, ensure_ascii=False, indent=2)
            media_type = "application/json; charset=utf-8"
        else:
            output = io.StringIO()
            output.write("\ufeff")
            writer = csv.writer(output)
            writer.writerow([
                "会话名称", "提问", "回答", "评估", "运行状态", "记录来源",
                "创建时间", "会话ID", "消息ID", "Workflow运行ID", "任务ID",
                "快照完整性", "覆盖说明",
            ])
            for item in rows:
                feedback = item.get("feedback") or {}
                writer.writerow([
                    _conversation_csv_cell(item.get("conversation_name")),
                    _conversation_csv_cell(item.get("query")),
                    _conversation_csv_cell(item.get("answer")),
                    _conversation_csv_cell(feedback.get("rating") if isinstance(feedback, dict) else ""),
                    _conversation_csv_cell(item.get("run_status")),
                    _conversation_csv_cell(item.get("record_source")),
                    datetime.fromtimestamp(int(item.get("created_at") or 0)).astimezone().isoformat()
                    if item.get("created_at") else "",
                    _conversation_csv_cell(item.get("conversation_id")),
                    _conversation_csv_cell(item.get("message_id")),
                    _conversation_csv_cell(item.get("workflow_run_id")),
                    _conversation_csv_cell(item.get("task_id")),
                    "完整" if coverage["complete"] else "有限",
                    coverage_text,
                ])
            content = output.getvalue()
            media_type = "text/csv; charset=utf-8"

        return Response(
            content=content,
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="conversation-records-{stamp}.{format}"',
                "X-Export-Count": str(len(rows)),
                "X-Export-Truncated": "true" if truncated else "false",
                "X-Snapshot-Truncated": "false" if coverage["complete"] else "true",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"会话记录导出失败: {exc}") from exc


# ── 删除会话 ──

@router.delete("/conversations/{conversation_id}", summary="删除会话")
async def delete_conversation(
    conversation_id: str,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = f"user-{current_user['user_id']}"
    dify = await _get_dify_for_chat(db)
    try:
        await dify.delete_conversation(conversation_id, user_id)
        _clear_conversation_record_cache(int(current_user["user_id"]))
        return {"result": "success"}
    except Exception as exc:
        _raise_dify_api_error(exc, "会话删除")


# ── 停止流式响应 ──

@router.post("/stop", summary="停止流式响应")
async def stop_stream(
    body: StopRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = f"user-{current_user['user_id']}"
    dify = await _get_dify_for_chat(db)
    try:
        await dify.stop_stream(body.task_id, user_id)
        return {"result": "success"}
    except Exception as exc:
        _raise_dify_api_error(exc, "智能体响应停止")


@router.post("/messages/{message_id}/feedback", summary="提交消息效果评估")
async def submit_feedback(
    message_id: str,
    body: FeedbackRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if message_id.startswith("local-control-"):
        raise HTTPException(status_code=400, detail="本地设备操作不支持 Dify 消息效果评估")
    user_id = f"user-{current_user['user_id']}"
    dify = await _get_dify_for_chat(db)
    if body.rating not in {"like", "dislike"}:
        raise HTTPException(status_code=400, detail="rating 必须是 like 或 dislike")
    try:
        result = await dify.submit_message_feedback(
            message_id=message_id,
            user=user_id,
            rating=body.rating,
            content=body.content,
        )
        _clear_conversation_record_cache(int(current_user["user_id"]))
        return result
    except Exception as exc:
        _raise_dify_api_error(exc, "消息效果评估提交")


@router.get("/workflow-runs/{workflow_run_id}", summary="获取 Workflow 运行记录")
async def get_workflow_run_detail(
    workflow_run_id: str,
    _current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dify = await _get_dify_for_chat(db)
    try:
        return await dify.get_workflow_run_detail(workflow_run_id)
    except DifyWorkflowRunDetailError as exc:
        status_code = 504 if "超时" in str(exc) else 502
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    except Exception as e:
        raise HTTPException(status_code=502, detail="Dify 工作流详情暂时无法读取，平台保存的运行记录仍可查看") from e
