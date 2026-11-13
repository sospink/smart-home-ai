"""
时序数据路由 — Home Assistant 状态采集、InfluxDB 查询与导出。
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
import time
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import AsyncSessionLocal, engine
from app.dependencies import get_current_user, get_db, require_admin
from app.models.device_management import ManagedDevice
from app.models.operation_log import OperationLog
from app.services.influxdb import InfluxDBService, InfluxRuntimeConfig
from app.services.runtime_settings import RuntimeConfig, get_runtime_config, get_runtime_services


router = APIRouter(prefix="/time-series", tags=["时序数据"])

COLLECT_INTERVAL_SECONDS = 60
COLLECT_MAX_RETRY_SECONDS = 15 * 60
COLLECT_FAILURE_LOG_INTERVAL_SECONDS = 30 * 60
COLLECT_FAILURE_LOG_RETENTION = 48
COLLECTOR_LOCK_NAME = "smart_home_time_series_collector"
QUERY_CACHE_TTL_SECONDS = 30
QUERY_SNAPSHOT_LIMIT = 10000
QUERY_CHART_LIMIT = 500
VALID_QUERY_WINDOWS = {"raw", "1m", "5m", "15m", "30m", "1h", "6h", "1d"}
VALID_QUERY_FIELDS = {"value_numeric", "state_raw", "unit"}
LAST_SYNC: dict[str, Any] = {
    "status": "idle",
    "written": 0,
    "entity_count": 0,
    "synced_at": None,
    "error": "",
    "consecutive_failures": 0,
    "next_retry_seconds": COLLECT_INTERVAL_SECONDS,
    "last_error_logged_at": None,
}
_COLLECTOR_LOG_STATE: dict[str, Any] = {
    "error_signature": "",
    "logged_at": None,
}
_QUERY_CACHE: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}
_QUERY_PENDING: dict[tuple[Any, ...], asyncio.Task] = {}


def _clear_query_cache() -> None:
    _QUERY_CACHE.clear()


def _validate_query_options(window: str, field: str) -> None:
    if window not in VALID_QUERY_WINDOWS:
        raise HTTPException(
            status_code=422,
            detail=f"不支持聚合窗口 {window}，可选值：{', '.join(sorted(VALID_QUERY_WINDOWS))}",
        )
    if field not in VALID_QUERY_FIELDS:
        raise HTTPException(
            status_code=422,
            detail=f"不支持查询字段 {field}，可选值：{', '.join(sorted(VALID_QUERY_FIELDS))}",
        )
    if field != "value_numeric" and window != "raw":
        raise HTTPException(status_code=422, detail="原始状态和单位字段仅支持 raw 聚合窗口")


def _query_cache_key(
    runtime: RuntimeConfig,
    *,
    entity_id: str,
    category: str,
    keyword: str,
    hours: int,
    window: str,
    field: str,
) -> tuple[Any, ...]:
    config_signature = hashlib.sha256(
        "\0".join((
            runtime.influxdb_url,
            runtime.influxdb_org,
            runtime.influxdb_bucket,
            runtime.influxdb_token,
        )).encode("utf-8")
    ).hexdigest()[:16]
    return (
        config_signature,
        entity_id.strip(),
        category.strip(),
        keyword.strip().lower(),
        int(hours),
        window,
        field,
    )


def _sample_chart_points(rows: list[dict[str, Any]], limit: int = QUERY_CHART_LIMIT) -> list[dict[str, Any]]:
    if len(rows) <= limit:
        return copy.deepcopy(rows)
    if limit <= 0:
        return []

    grouped: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        entity_id = str(row.get("entity_id") or f"__missing_entity_{index}")
        grouped.setdefault(entity_id, []).append(index)

    groups = list(grouped.values())
    if len(groups) >= limit:
        # 实体数超过图表预算时优先保留更多实体，每个实体取最新代表点。
        selected_indexes = [indexes[-1] for indexes in groups[:limit]]
    else:
        allocations = [1] * len(groups)
        capacities = [len(indexes) - 1 for indexes in groups]
        remaining = min(limit - len(groups), sum(capacities))

        # 按各实体剩余点数比例分配预算，避免高频实体吞掉稀疏实体的唯一数据点。
        while remaining > 0:
            available = [index for index, capacity in enumerate(capacities) if capacity > 0]
            if not available:
                break
            capacity_total = sum(capacities[index] for index in available)
            grants = {
                index: min(capacities[index], max(1, remaining * capacities[index] // capacity_total))
                for index in available
            }
            granted = min(remaining, sum(grants.values()))
            consumed = 0
            for index in available:
                grant = min(grants[index], granted - consumed)
                if grant <= 0:
                    break
                allocations[index] += grant
                capacities[index] -= grant
                consumed += grant
            remaining -= consumed

        selected_indexes: list[int] = []
        for indexes, allocation in zip(groups, allocations, strict=True):
            if allocation == 1:
                selected_indexes.append(indexes[-1])
                continue
            positions = {
                round(position * (len(indexes) - 1) / (allocation - 1))
                for position in range(allocation)
            }
            selected_indexes.extend(indexes[position] for position in sorted(positions))

    return [copy.deepcopy(rows[index]) for index in sorted(selected_indexes)]


def _build_query_snapshot(rows: list[dict[str, Any]]) -> dict[str, Any]:
    numeric_values = [
        float(item["value"])
        for item in rows
        if isinstance(item.get("value"), (int, float))
    ]
    chart_points = _sample_chart_points(rows)
    chart_entity_total = len({item.get("entity_id", "") for item in rows if item.get("entity_id")})
    chart_entity_count = len({item.get("entity_id", "") for item in chart_points if item.get("entity_id")})
    return {
        "rows": copy.deepcopy(rows),
        "chart_points": chart_points,
        "chart_entity_count": chart_entity_count,
        "chart_entity_total": chart_entity_total,
        "chart_entities_truncated": chart_entity_count < chart_entity_total,
        "total": len(rows),
        "entity_count": len({item.get("entity_id", "") for item in rows if item.get("entity_id")}),
        "latest_at": rows[-1].get("time") if rows else None,
        "first_at": rows[0].get("time") if rows else None,
        "minimum": min(numeric_values) if numeric_values else None,
        "maximum": max(numeric_values) if numeric_values else None,
        "average": (sum(numeric_values) / len(numeric_values)) if numeric_values else None,
        "truncated": len(rows) >= QUERY_SNAPSHOT_LIMIT,
        "generated_at": datetime.now().isoformat(),
    }


async def _load_query_snapshot(
    influx: InfluxDBService,
    *,
    entity_id: str,
    category: str,
    keyword: str,
    hours: int,
    window: str,
    field: str,
) -> dict[str, Any]:
    rows = await influx.query_points(
        hours=hours,
        entity_id=entity_id,
        category=category,
        keyword=keyword,
        field=field,
        window=window,
        limit=QUERY_SNAPSHOT_LIMIT,
    )
    return _build_query_snapshot(rows)


async def _get_query_snapshot(
    key: tuple[Any, ...],
    loader,
    *,
    refresh: bool = False,
) -> tuple[dict[str, Any], str]:
    now = time.monotonic()
    cached = _QUERY_CACHE.get(key)
    if not refresh and cached and now - cached[0] < QUERY_CACHE_TTL_SECONDS:
        return copy.deepcopy(cached[1]), "hit"

    pending = _QUERY_PENDING.get(key)
    cache_status = "shared" if pending and not pending.done() else "miss"
    if not pending or pending.done():
        pending = asyncio.create_task(loader())
        _QUERY_PENDING[key] = pending
    try:
        # 客户端断开只取消当前等待者，不能连带取消其他请求共用的 InfluxDB 查询。
        snapshot = await asyncio.shield(pending)
    finally:
        if _QUERY_PENDING.get(key) is pending and pending.done():
            _QUERY_PENDING.pop(key, None)
    _QUERY_CACHE[key] = (time.monotonic(), copy.deepcopy(snapshot))
    return copy.deepcopy(snapshot), cache_status


def _influx_service(config: RuntimeConfig) -> InfluxDBService:
    return InfluxDBService(
        InfluxRuntimeConfig(
            url=config.influxdb_url,
            token=config.influxdb_token,
            org=config.influxdb_org,
            bucket=config.influxdb_bucket,
        )
    )


def _external_error_reason(exc: Exception) -> str:
    raw = str(exc).strip()
    normalized = f"{exc.__class__.__name__} {raw}".lower()
    if "timeout" in normalized or "timed out" in normalized:
        return "请求超时"
    if any(marker in normalized for marker in (
        "refused",
        "all connection attempts failed",
        "cannot connect to host",
        "host is down",
        "network is unreachable",
        "no route to host",
    )):
        return "无法建立连接"
    if "disconnected" in normalized or "connection reset" in normalized:
        return "服务连接已断开"
    return raw or "底层服务未返回错误详情"


def _collector_error_text(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        return str(exc.detail).strip() or "采集接口未返回错误详情"
    return _external_error_reason(exc)


def _raise_influx_error(exc: Exception, action: str) -> None:
    reason = _external_error_reason(exc)
    detail = f"InfluxDB {action}失败：{reason}"
    status_code = 400 if "缺少" in reason or "未配置" in reason else 502
    raise HTTPException(status_code=status_code, detail=detail) from exc


def _domain(entity_id: str) -> str:
    return entity_id.split(".", 1)[0] if "." in entity_id else ""


async def _managed_entities(
    db: AsyncSession,
    ha_map: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    ha_map = ha_map or {}
    result = await db.execute(
        select(ManagedDevice)
        .options(selectinload(ManagedDevice.mappings))
        .where(ManagedDevice.enabled.is_(True))
        .order_by(ManagedDevice.id)
    )
    devices = result.scalars().unique().all()
    entities: list[dict[str, Any]] = []
    for device in devices:
        for mapping in device.mappings:
            if mapping.gateway_type != "homeassistant" or not mapping.endpoint:
                continue
            entity_id = mapping.endpoint
            raw = ha_map.get(entity_id, {})
            attrs = raw.get("attributes", {}) if raw else {}
            state = raw.get("state", "unavailable") if raw else "unavailable"
            entities.append({
                "entity_id": entity_id,
                "domain": _domain(entity_id),
                "device_id": str(device.id),
                "device_name": device.name,
                "device_location": device.location,
                "role": mapping.role,
                "category": device.category,
                "state": state,
                "unit": mapping.unit or attrs.get("unit_of_measurement", ""),
                "last_changed": raw.get("last_changed") if raw else None,
                "online": bool(raw) and state not in {"unknown", "unavailable"},
            })
    return entities


async def collect_once(db: AsyncSession, source: str = "manual") -> dict[str, Any]:
    """采集 HA 当前状态并写入 InfluxDB。"""
    services = await get_runtime_services(db)
    influx = _influx_service(services.config)

    try:
        raw_states = await services.homeassistant.get_states()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Home Assistant 状态采集失败：{_external_error_reason(exc)}") from exc

    ha_map = {item.get("entity_id", ""): item for item in raw_states if item.get("entity_id")}
    rows = await _managed_entities(db, ha_map)

    try:
        written = await influx.write_ha_states(rows, source=source)
    except Exception as exc:
        _raise_influx_error(exc, "写入")

    result = {
        "status": "success",
        "written": written,
        "entity_count": len(rows),
        "synced_at": datetime.now().isoformat(),
        "error": "",
    }
    LAST_SYNC.update(result)
    _clear_query_cache()
    return result


def _collector_retry_seconds(consecutive_failures: int) -> int:
    """外部时序库离线时逐步退避，避免无意义的每分钟重试。"""
    exponent = max(0, min(consecutive_failures - 1, 8))
    return min(COLLECT_INTERVAL_SECONDS * (2 ** exponent), COLLECT_MAX_RETRY_SECONDS)


def _should_log_collector_failure(error: str, now: datetime) -> bool:
    signature = error.strip()[:240]
    logged_at = _COLLECTOR_LOG_STATE.get("logged_at")
    should_log = (
        not logged_at
        or signature != _COLLECTOR_LOG_STATE.get("error_signature")
        or now - logged_at >= timedelta(seconds=COLLECT_FAILURE_LOG_INTERVAL_SECONDS)
    )
    if should_log:
        _COLLECTOR_LOG_STATE.update({"error_signature": signature, "logged_at": now})
    return should_log


def _collector_error_signature(error: str) -> str:
    normalized = re.sub(r"\s+", " ", error.strip()).lower()[:360]
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


async def _collector_failure_logged_recently(
    db: AsyncSession,
    signature: str,
    now: datetime,
) -> bool:
    result = await db.execute(
        select(OperationLog.id)
        .where(
            OperationLog.type == "time_series",
            OperationLog.title == "时序数据自动采集失败",
            OperationLog.created_at >= now - timedelta(seconds=COLLECT_FAILURE_LOG_INTERVAL_SECONDS),
            OperationLog.detail.contains(f"signature={signature}"),
        )
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


async def _prune_collector_logs(db: AsyncSession) -> int:
    """删除旧采集器产生的分钟级噪声，保留人工同步、恢复和最近失败证据。"""
    legacy_result = await db.execute(
        delete(OperationLog).where(
            OperationLog.type == "time_series",
            OperationLog.title.in_((
                "时序数据自动采集完成",
                "时序数据采集日志已清理",
            )),
        )
    )
    stale_result = await db.execute(
        select(OperationLog.id)
        .where(
            OperationLog.type == "time_series",
            OperationLog.title == "时序数据自动采集失败",
        )
        .order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
        .offset(COLLECT_FAILURE_LOG_RETENTION)
    )
    stale_ids = stale_result.scalars().all()
    if stale_ids:
        await db.execute(delete(OperationLog).where(OperationLog.id.in_(stale_ids)))
    deleted = int(legacy_result.rowcount or 0) + len(stale_ids)
    await db.commit()
    return deleted


async def _acquire_collector_lock(connection) -> bool:
    if connection.dialect.name != "mysql":
        return True
    result = await connection.execute(
        text("SELECT GET_LOCK(:lock_name, 0)"),
        {"lock_name": COLLECTOR_LOCK_NAME},
    )
    return result.scalar_one_or_none() == 1


async def _release_collector_lock(connection) -> None:
    if connection.dialect.name == "mysql":
        await connection.execute(
            text("SELECT RELEASE_LOCK(:lock_name)"),
            {"lock_name": COLLECTOR_LOCK_NAME},
        )


async def run_periodic_collector() -> None:
    """单实例周期采集；离线时退避，并用数据库签名跨重启抑制重复日志。"""
    async with engine.connect() as lock_connection:
        if not await _acquire_collector_lock(lock_connection):
            return
        try:
            async with AsyncSessionLocal() as cleanup_db:
                await _prune_collector_logs(cleanup_db)
            await asyncio.sleep(5)
            while True:
                next_retry_seconds = COLLECT_INTERVAL_SECONDS
                async with AsyncSessionLocal() as db:
                    try:
                        result = await collect_once(db, source="collector")
                        previous_failures = int(LAST_SYNC.get("consecutive_failures") or 0)
                        LAST_SYNC.update({
                            **result,
                            "consecutive_failures": 0,
                            "next_retry_seconds": COLLECT_INTERVAL_SECONDS,
                        })
                        if previous_failures:
                            db.add(OperationLog(
                                type="time_series",
                                level="success",
                                title="时序数据自动采集已恢复",
                                detail=(
                                    f"连续失败 {previous_failures} 次后恢复，"
                                    f"written={result['written']}, entity_count={result['entity_count']}"
                                ),
                                username="system",
                            ))
                            await db.commit()
                        _COLLECTOR_LOG_STATE.update({"error_signature": "", "logged_at": None})
                    except Exception as exc:
                        now = datetime.now()
                        error = _collector_error_text(exc)
                        signature = _collector_error_signature(error)
                        consecutive_failures = int(LAST_SYNC.get("consecutive_failures") or 0) + 1
                        next_retry_seconds = _collector_retry_seconds(consecutive_failures)
                        should_log = _should_log_collector_failure(error, now)
                        if should_log:
                            should_log = not await _collector_failure_logged_recently(db, signature, now)
                        LAST_SYNC.update({
                            "status": "error",
                            "error": error,
                            "synced_at": now.isoformat(),
                            "consecutive_failures": consecutive_failures,
                            "next_retry_seconds": next_retry_seconds,
                            "last_error_logged_at": (
                                now.isoformat()
                                if should_log
                                else LAST_SYNC.get("last_error_logged_at")
                            ),
                        })
                        if should_log:
                            db.add(OperationLog(
                                type="time_series",
                                level="warning",
                                title="时序数据自动采集失败",
                                detail=(
                                    f"{error[:360]}；连续失败 {consecutive_failures} 次，"
                                    f"{next_retry_seconds} 秒后重试；signature={signature}"
                                ),
                                username="system",
                            ))
                            await db.commit()
                await asyncio.sleep(next_retry_seconds)
        finally:
            await _release_collector_lock(lock_connection)


@router.get("/overview", summary="时序数据概览")
async def time_series_overview(
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    runtime = await get_runtime_config(db)
    influx = _influx_service(runtime)
    healthy, health_error = await influx.check_health_detail()
    managed_entities = await _managed_entities(db)

    latest_at = None
    auth_status = "ready" if influx.ready_for_data else "missing_token"
    if not runtime.influxdb_url or not runtime.influxdb_org or not runtime.influxdb_bucket:
        auth_status = "incomplete"
    if healthy and influx.ready_for_data:
        try:
            latest = await influx.latest_point()
            latest_at = latest.get("time") if latest else None
        except Exception as exc:
            auth_status = "error"
            health_error = str(exc).strip() or exc.__class__.__name__
            latest_at = None

    status = "running"
    if not healthy:
        status = "stopped"
    elif auth_status != "ready":
        status = "unconfigured" if auth_status in {"missing_token", "incomplete"} else "error"

    can_view_runtime_details = _user.get("role") == "admin"
    return {
        "status": status,
        "health_status": "running" if healthy else "stopped",
        "auth_status": auth_status,
        "configured": influx.ready_for_data,
        "diagnostic": "" if status == "running" else (
            health_error
            or (
                "InfluxDB Token 未配置，请在系统设置中补充后重试"
                if auth_status == "missing_token"
                else "InfluxDB 运行时配置不完整，请检查 URL、Org 与 Bucket"
            )
        ),
        "url": runtime.influxdb_url if can_view_runtime_details else "",
        "org": runtime.influxdb_org if can_view_runtime_details else "",
        "bucket": runtime.influxdb_bucket if can_view_runtime_details else "",
        "measurement": "home_assistant_state" if can_view_runtime_details else "",
        "entity_count": len(managed_entities),
        "latest_at": latest_at,
        "last_sync": LAST_SYNC,
        "collect_interval_seconds": COLLECT_INTERVAL_SECONDS,
    }


@router.get("/entities", summary="可查询实体列表")
async def time_series_entities(
    category: str = Query("", description="设备分类过滤"),
    keyword: str = Query("", description="关键词过滤"),
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    services = await get_runtime_services(db)
    ha_map: dict[str, dict[str, Any]] = {}
    try:
        raw_states = await services.homeassistant.get_states()
        ha_map = {item.get("entity_id", ""): item for item in raw_states if item.get("entity_id")}
    except Exception:
        ha_map = {}

    keyword_lower = keyword.lower().strip()
    rows = await _managed_entities(db, ha_map)
    categories: dict[str, int] = {}
    for item in rows:
        categories[item["category"]] = categories.get(item["category"], 0) + 1
    if category:
        rows = [item for item in rows if item["category"] == category]
    if keyword_lower:
        rows = [
            item for item in rows
            if keyword_lower in item["entity_id"].lower()
            or keyword_lower in item["device_name"].lower()
            or keyword_lower in item["role"].lower()
        ]

    return {
        "entities": rows,
        "count": len(rows),
        "categories": categories,
    }


@router.get("/query", summary="查询时序数据")
async def time_series_query(
    entity_id: str = Query("", description="实体 ID"),
    category: str = Query("", description="设备分类"),
    keyword: str = Query("", description="关键词"),
    hours: int = Query(24, ge=1, le=720, description="最近多少小时"),
    window: str = Query("5m", description="聚合窗口: raw/1m/5m/15m/30m/1h/6h/1d"),
    field: str = Query("value_numeric", description="字段: value_numeric/state_raw/unit"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=10, le=100),
    refresh: bool = Query(False, description="忽略查询快照缓存"),
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    runtime = await get_runtime_config(db)
    _validate_query_options(window, field)
    influx = _influx_service(runtime)
    key = _query_cache_key(
        runtime,
        entity_id=entity_id,
        category=category,
        keyword=keyword,
        hours=hours,
        window=window,
        field=field,
    )
    try:
        snapshot, cache_status = await _get_query_snapshot(
            key,
            lambda: _load_query_snapshot(
                influx,
                entity_id=entity_id,
                category=category,
                keyword=keyword,
                hours=hours,
                window=window,
                field=field,
            ),
            refresh=refresh,
        )
    except Exception as exc:
        _raise_influx_error(exc, "查询")

    total = int(snapshot["total"])
    page_count = max(1, (total + size - 1) // size)
    safe_page = min(page, page_count)
    offset = (safe_page - 1) * size
    # 明细以最新记录优先，图表和统计仍使用正序快照，避免折线方向和聚合口径变化。
    page_rows = list(reversed(snapshot["rows"]))[offset:offset + size]
    return {
        "source": "influxdb",
        "query": {
            "entity_id": entity_id,
            "category": category,
            "keyword": keyword,
            "hours": hours,
            "window": window,
            "field": field,
            "snapshot_limit": QUERY_SNAPSHOT_LIMIT,
        },
        "points": page_rows,
        "chart_points": snapshot["chart_points"],
        "total": total,
        "count": len(page_rows),
        "page": safe_page,
        "size": size,
        "page_count": page_count,
        "entity_count": snapshot["entity_count"],
        "latest_at": snapshot["latest_at"],
        "first_at": snapshot["first_at"],
        "stats": {
            "minimum": snapshot["minimum"],
            "maximum": snapshot["maximum"],
            "average": snapshot["average"],
        },
        "meta": {
            "cache": cache_status,
            "cache_ttl_seconds": QUERY_CACHE_TTL_SECONDS,
            "generated_at": snapshot["generated_at"],
            "truncated": snapshot["truncated"],
            "chart_point_count": len(snapshot["chart_points"]),
            "chart_entity_count": snapshot["chart_entity_count"],
            "chart_entity_total": snapshot["chart_entity_total"],
            "chart_entities_truncated": snapshot["chart_entities_truncated"],
        },
    }


@router.post("/sync", summary="立即同步时序数据")
async def time_series_sync(
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await collect_once(db, source="manual")
    except Exception as exc:
        error = str(exc).strip() or exc.__class__.__name__
        LAST_SYNC.update({
            "status": "error",
            "synced_at": datetime.now().isoformat(),
            "error": error,
        })
        db.add(OperationLog(
            type="time_series",
            level="error",
            title="时序数据手动同步失败",
            detail=f"result=failed, error={error[:360]}",
            user_id=user.get("user_id"),
            username=user.get("username", ""),
        ))
        await db.commit()
        raise
    db.add(OperationLog(
        type="time_series",
        level="success",
        title="时序数据手动同步完成",
        detail=f"written={result['written']}, entity_count={result['entity_count']}",
        user_id=user.get("user_id"),
        username=user.get("username", ""),
    ))
    return result


def _history_scope_clause(scope: str):
    if scope == "manual":
        return OperationLog.title.in_(("时序数据手动同步完成", "时序数据手动同步失败"))
    if scope == "collector":
        return or_(
            OperationLog.title.like("时序数据自动采集%"),
            OperationLog.title == "时序数据采集日志已清理",
            OperationLog.title == "管理员执行时序采集日志清理",
        )
    return OperationLog.type == "time_series"


@router.get("/history", summary="时序同步和采集历史")
async def time_series_history(
    scope: str = Query("all", pattern="^(all|manual|collector)$"),
    level: str = Query("", pattern="^(|info|success|warning|error)$"),
    keyword: str = Query(""),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=10, le=100),
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conditions = [OperationLog.type == "time_series", _history_scope_clause(scope)]
    visibility_scope = "all" if user.get("role") == "admin" else "self"
    if visibility_scope == "self":
        # 自动采集属于系统运行证据；人工操作只展示当前用户自己的记录。
        conditions.append(or_(
            OperationLog.title.like("时序数据自动采集%"),
            OperationLog.user_id == user.get("user_id"),
        ))
    if level:
        conditions.append(OperationLog.level == level)
    keyword = keyword.strip()
    if keyword:
        pattern = f"%{keyword}%"
        conditions.append(or_(OperationLog.title.ilike(pattern), OperationLog.detail.ilike(pattern)))

    total = int((await db.execute(
        select(func.count()).select_from(OperationLog).where(*conditions)
    )).scalar() or 0)
    page_count = max(1, (total + size - 1) // size)
    safe_page = min(page, page_count)
    result = await db.execute(
        select(OperationLog)
        .where(*conditions)
        .order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
        .offset((safe_page - 1) * size)
        .limit(size)
    )
    items = result.scalars().all()
    return {
        "items": [
            {
                "id": item.id,
                "level": item.level,
                "title": item.title,
                "detail": item.detail or "",
                "username": item.username or "system",
                "created_at": item.created_at,
                "scope": "manual" if "手动同步" in item.title else "collector",
            }
            for item in items
        ],
        "total": total,
        "page": safe_page,
        "size": size,
        "page_count": page_count,
        "visibility_scope": visibility_scope,
    }


@router.delete("/history/collector", summary="清理自动采集日志")
async def cleanup_time_series_collector_history(
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    deleted = await _prune_collector_logs(db)
    db.add(OperationLog(
        type="time_series",
        level="info",
        title="管理员执行时序采集日志清理",
        detail=f"deleted={deleted}, retained_failures={COLLECT_FAILURE_LOG_RETENTION}",
        user_id=user.get("user_id"),
        username=user.get("username", ""),
    ))
    await db.commit()
    return {
        "status": "success",
        "deleted": deleted,
        "retained_failures": COLLECT_FAILURE_LOG_RETENTION,
    }


@router.get("/export", summary="导出时序数据")
async def time_series_export(
    entity_id: str = Query("", description="实体 ID"),
    category: str = Query("", description="设备分类"),
    keyword: str = Query("", description="关键词"),
    hours: int = Query(24, ge=1, le=720),
    window: str = Query("5m"),
    field: str = Query("value_numeric"),
    format: str = Query("json", pattern="^(json|csv)$"),
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _validate_query_options(window, field)
    runtime = await get_runtime_config(db)
    influx = _influx_service(runtime)
    try:
        rows = await influx.query_points(
            hours=hours,
            entity_id=entity_id,
            category=category,
            keyword=keyword,
            field=field,
            window=window,
            limit=10001,
        )
    except Exception as exc:
        _raise_influx_error(exc, "导出")
    truncated = len(rows) > 10000
    rows = rows[:10000]
    filename = f"time-series-{datetime.now().strftime('%Y%m%d%H%M%S')}.{format}"
    if format == "csv":
        content = InfluxDBService.rows_to_csv(rows).encode("utf-8")
        media_type = "text/csv; charset=utf-8"
    else:
        content = json.dumps(rows, ensure_ascii=False, indent=2, default=str).encode("utf-8")
        media_type = "application/json; charset=utf-8"
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Export-Count": str(len(rows)),
            "X-Export-Truncated": "true" if truncated else "false",
        },
    )
