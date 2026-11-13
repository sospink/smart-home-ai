"""统一状态查询路由。

该接口族是设备模块的只读兼容层，所有数据均来自平台设备台账与 Home Assistant
实时快照，不维护第二套状态，也不生成演示传感器数据。
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_current_user, get_db
from app.routers.devices import (
    DEVICE_LIST_CACHE_TTL_SECONDS,
    _filter_device_snapshot,
    _get_device_list_snapshot,
)
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/states", tags=["状态查询"])


@router.get("/health", summary="状态模块健康检查")
async def health():
    return {"status": "ok", "module": "states"}


def _page(items: list[dict[str, Any]], page: int, size: int) -> tuple[list[dict[str, Any]], int, int, int]:
    total = len(items)
    pages = max(1, (total + size - 1) // size)
    safe_page = min(page, pages)
    start = (safe_page - 1) * size
    return items[start:start + size], safe_page, total, pages


def _snapshot_meta(snapshot: dict[str, Any], cache_status: str) -> dict[str, Any]:
    return {
        "generated_at": snapshot.get("generated_at"),
        "cache": cache_status,
        "cache_ttl_seconds": DEVICE_LIST_CACHE_TTL_SECONDS,
        "data_sources": ["平台设备映射台账", "Home Assistant REST 状态"],
        "degraded": bool(snapshot.get("ha_error")),
        "error": snapshot.get("ha_error") or None,
    }


@router.get("/realtime", summary="设备实时状态快照")
async def realtime_states(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    category: str = "",
    status: str = "",
    keyword: str = "",
    refresh: bool = False,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """分页返回平台已纳管设备及其真实映射实体状态。"""
    if status and status not in {"online", "offline", "unmapped", "disabled"}:
        raise HTTPException(status_code=422, detail="不支持的设备状态筛选")
    snapshot, cache_status = await _get_device_list_snapshot(db, refresh=refresh)
    filtered = _filter_device_snapshot(
        snapshot["devices"],
        keyword=keyword,
        category=category,
        status=status,
        sort="name",
    )
    items, safe_page, total, pages = _page(filtered, page, size)
    return {
        "items": items,
        "summary": snapshot["summary"],
        "page": safe_page,
        "size": size,
        "total": total,
        "pages": pages,
        **_snapshot_meta(snapshot, cache_status),
    }


def _sensor_items(devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sensors: list[dict[str, Any]] = []
    for device in devices:
        mappings = {
            str(mapping.get("role") or ""): mapping
            for mapping in device.get("mappings") or []
        }
        for role, entity in (device.get("entities") or {}).items():
            entity_id = str(entity.get("entity_id") or "")
            domain = entity_id.split(".", 1)[0]
            if domain not in {"sensor", "binary_sensor"}:
                continue
            attributes = entity.get("attributes") or {}
            mapping = mappings.get(str(role), {})
            sensors.append({
                "device_id": device.get("id"),
                "device_name": device.get("name"),
                "location": device.get("location"),
                "category": device.get("category"),
                "role": role,
                "entity_id": entity_id,
                "sensor_type": domain,
                "name": attributes.get("friendly_name") or device.get("name"),
                "state": entity.get("state"),
                "unit": entity.get("unit") or attributes.get("unit_of_measurement", ""),
                "available": entity.get("state") not in {"unknown", "unavailable", "pending"},
                "last_changed": entity.get("last_changed"),
                "device_class": attributes.get("device_class", ""),
                "access_mode": entity.get("access_mode") or mapping.get("access_mode", "read"),
            })
    sensors.sort(key=lambda item: (str(item.get("location") or ""), str(item.get("name") or "")))
    return sensors


@router.get("/sensors", summary="传感器实时数据列表")
async def sensor_states(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    available: bool | None = None,
    keyword: str = "",
    refresh: bool = False,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回已纳管的真实传感器；没有映射时保持真实空列表。"""
    snapshot, cache_status = await _get_device_list_snapshot(db, refresh=refresh)
    sensors = _sensor_items(snapshot["devices"])
    normalized_keyword = keyword.strip().casefold()
    if normalized_keyword:
        sensors = [
            item for item in sensors
            if normalized_keyword in " ".join(str(value or "") for value in (
                item.get("device_name"), item.get("name"), item.get("location"),
                item.get("entity_id"), item.get("device_class"), item.get("role"),
            )).casefold()
        ]
    if available is not None:
        sensors = [item for item in sensors if item["available"] is available]
    items, safe_page, total, pages = _page(sensors, page, size)
    return {
        "items": items,
        "summary": {
            "total": total,
            "available": sum(1 for item in sensors if item["available"]),
            "unavailable": sum(1 for item in sensors if not item["available"]),
        },
        "page": safe_page,
        "size": size,
        "total": total,
        "pages": pages,
        **_snapshot_meta(snapshot, cache_status),
    }


@router.get("/summary", summary="设备与场景状态汇总")
async def state_summary(
    refresh: bool = False,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回与设备台账一致的汇总口径，并补充真实传感器可用数量。"""
    snapshot, cache_status = await _get_device_list_snapshot(db, refresh=refresh)
    sensors = _sensor_items(snapshot["devices"])
    return {
        **snapshot["summary"],
        "sensors": len(sensors),
        "available_sensors": sum(1 for item in sensors if item["available"]),
        **_snapshot_meta(snapshot, cache_status),
    }
