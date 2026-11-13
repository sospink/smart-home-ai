"""
电子沙盘路由 - 虚拟设备列表 / 数据注入 / 仿真日志
"""
import asyncio
import json
import time
from datetime import datetime, timedelta
from collections import deque
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, require_admin
from app.models.operation_log import OperationLog
from app.services.runtime_settings import get_runtime_config

import httpx

router = APIRouter(prefix="/sandbox", tags=["电子沙盘"])

# ── 内存日志队列（最大 500 条）──
_log_queue: deque = deque(maxlen=500)
_log_event = asyncio.Event()

SANDBOX_LOG_TYPE = "sandbox_simulation"
STATE_CACHE_TTL_SECONDS = 3
READBACK_ATTEMPTS = 6
READBACK_INTERVAL_SECONDS = 0.2
_state_cache: dict[str, tuple[float, dict[str, dict]]] = {}
_state_pending: dict[str, asyncio.Task] = {}

UI_ENTITY_CANDIDATES = {
    "light_living": ["light.ke_ting_deng", "light.ke_ting_deng_2"],
    "light_bedroom": ["light.wo_shi_deng", "light.wo_shi_deng_2"],
    "light_study": ["light.shu_fang_deng", "light.shu_fang_deng_2"],
    "switch_coffee": ["switch.ka_pei_ji", "switch.ka_pei_ji_2"],
    "switch_water_heater": ["switch.re_shui_qi", "switch.re_shui_qi_2"],
    "switch_front_lock": ["switch.qian_men_men_suo", "switch.qian_men_men_suo_2"],
    "sensor_temp": ["sensor.shi_nei_wen_du"],
    "sensor_humidity": ["sensor.shi_nei_shi_du"],
    "sensor_pm25": ["sensor.pm2_5"],
    "sensor_power": ["sensor.dang_qian_gong_hao"],
    "binary_door": ["binary_sensor.qian_men"],
    "scene_home": ["scene.hui_jia_mo_shi"],
    "scene_away": ["scene.chi_jia_mo_shi"],
    "scene_sleep": ["scene.shui_mian_mo_shi"],
    "scene_cinema": ["scene.ying_yuan_mo_shi"],
}


def _get_browser_accessible_ha_url(request: Request, base_url: str) -> str:
    """将 HA 地址转换为浏览器可访问的地址"""
    base_url = base_url.rstrip("/")
    if not base_url:
        return ""

    parsed = urlparse(base_url)
    hostname = parsed.hostname or ""

    if hostname not in {"localhost", "127.0.0.1", "0.0.0.0"}:
        return base_url

    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    scheme = forwarded_proto or request.url.scheme or parsed.scheme or "http"
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
    request_host = request.headers.get("host", "").split(",")[0].strip()
    host = (forwarded_host or request_host or request.url.hostname or hostname).split(":")[0]
    port = parsed.port or 8123

    return f"{scheme}://{host}:{port}"


async def _fetch_available_entity_ids(ha_url: str, ha_token: str) -> set[str]:
    return set((await _fetch_ha_state_map(ha_url, ha_token)).keys())


def _normalize_ha_state(item: dict) -> dict:
    return {
        "state": item.get("state", "unknown"),
        "attributes": item.get("attributes", {}) or {},
        "last_changed": item.get("last_changed", ""),
        "last_updated": item.get("last_updated", ""),
    }


async def _load_ha_state_map(ha_url: str, ha_token: str) -> dict[str, dict]:
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        response = await client.get(
            f"{ha_url.rstrip('/')}/api/states",
            headers={"Authorization": f"Bearer {ha_token}"},
        )
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError("Home Assistant 状态响应格式异常")
    return {
        str(item.get("entity_id")): _normalize_ha_state(item)
        for item in payload
        if isinstance(item, dict) and item.get("entity_id")
    }


async def _fetch_ha_state_map(
    ha_url: str,
    ha_token: str,
    *,
    force: bool = False,
) -> dict[str, dict]:
    """一次读取 HA 全量状态，并对并发页面请求做短时去重。"""
    cache_key = ha_url.rstrip("/")
    cached = _state_cache.get(cache_key)
    if not force and cached and time.monotonic() - cached[0] < STATE_CACHE_TTL_SECONDS:
        return cached[1]

    task = _state_pending.get(cache_key)
    if not task:
        task = asyncio.create_task(_load_ha_state_map(cache_key, ha_token))
        _state_pending[cache_key] = task
    try:
        states = await asyncio.shield(task)
        _state_cache[cache_key] = (time.monotonic(), states)
        return states
    finally:
        if task.done() and _state_pending.get(cache_key) is task:
            _state_pending.pop(cache_key, None)


def _invalidate_state_cache(ha_url: str) -> None:
    _state_cache.pop(ha_url.rstrip("/"), None)


def _resolve_ui_entities(available_ids: set[str]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for key, candidates in UI_ENTITY_CANDIDATES.items():
        resolved[key] = next(
            (entity_id for entity_id in candidates if entity_id in available_ids),
            candidates[0],
        )
    return resolved


def _add_log(log_type: str, level: str, title: str, detail: str = ""):
    """添加仿真日志"""
    entry = {
        "id": int(time.time() * 1000),
        "type": log_type,  # inject / control / agent / system
        "level": level,    # info / warn / error / success
        "title": title,
        "detail": detail,
        "time": datetime.now().strftime("%H:%M:%S"),
        "created_at": datetime.now().isoformat(),
    }
    _log_queue.append(entry)
    _log_event.set()
    _log_event.clear()
    return entry


# ── 虚拟设备注册表 ──
VIRTUAL_DEVICES = [
    # 客厅
    {
        "id": "v_living_room_light",
        "name": "客厅灯",
        "area": "客厅",
        "category": "light",
        "icon": "mdi:ceiling-light",
        "entities": {
            "power": "input_boolean.light_living_room",
            "brightness": "input_number.light_living_room_brightness",
        },
        "injectable": False,
    },
    {
        "id": "v_bedroom_light",
        "name": "卧室灯",
        "area": "卧室",
        "category": "light",
        "icon": "mdi:lamp",
        "entities": {
            "power": "input_boolean.light_bedroom",
            "brightness": "input_number.light_bedroom_brightness",
        },
        "injectable": False,
    },
    {
        "id": "v_study_room_light",
        "name": "书房灯",
        "area": "书房",
        "category": "light",
        "icon": "mdi:desk-lamp",
        "entities": {
            "power": "input_boolean.light_study_room",
            "brightness": "input_number.light_study_room_brightness",
        },
        "injectable": False,
    },
    # 空调
    {
        "id": "v_ac",
        "name": "客厅空调",
        "area": "客厅",
        "category": "climate",
        "icon": "mdi:air-conditioner",
        "entities": {
            "power": "input_select.ac_power",
            "mode": "input_select.ac_mode",
            "temperature": "input_number.ac_temperature",
        },
        "injectable": False,
    },
    # 开关设备
    {
        "id": "v_coffee_machine",
        "name": "咖啡机",
        "area": "厨卫",
        "category": "switch",
        "icon": "mdi:coffee-maker",
        "entities": {"power": "input_boolean.coffee_machine"},
        "injectable": False,
    },
    {
        "id": "v_water_heater",
        "name": "热水器",
        "area": "厨卫",
        "category": "switch",
        "icon": "mdi:water-boiler",
        "entities": {"power": "input_boolean.water_heater"},
        "injectable": False,
    },
    # 安防
    {
        "id": "v_front_door_lock",
        "name": "前门门锁",
        "area": "安防",
        "category": "lock",
        "icon": "mdi:lock",
        "entities": {"lock": "input_boolean.front_door_lock"},
        "injectable": False,
    },
    {
        "id": "v_front_door_sensor",
        "name": "前门门磁",
        "area": "安防",
        "category": "binary_sensor",
        "icon": "mdi:door",
        "entities": {"door": "binary_sensor.qian_men"},
        "injectable": False,
    },
    # 传感器（可注入）
    {
        "id": "v_temperature",
        "name": "室内温度",
        "area": "客厅",
        "category": "sensor",
        "icon": "mdi:thermometer",
        "entities": {"value": "sensor.shi_nei_wen_du"},
        "injectable": True,
        "inject_config": {
            "min": 10, "max": 45, "step": 0.5,
            "unit": "°C", "label": "温度",
        },
    },
    {
        "id": "v_humidity",
        "name": "室内湿度",
        "area": "客厅",
        "category": "sensor",
        "icon": "mdi:water-percent",
        "entities": {"value": "sensor.shi_nei_shi_du"},
        "injectable": True,
        "inject_config": {
            "min": 0, "max": 100, "step": 1,
            "unit": "%", "label": "湿度",
        },
    },
    {
        "id": "v_pm25",
        "name": "PM2.5",
        "area": "客厅",
        "category": "sensor",
        "icon": "mdi:air-filter",
        "entities": {"value": "sensor.pm2_5"},
        "injectable": True,
        "inject_config": {
            "min": 0, "max": 500, "step": 1,
            "unit": "μg/m³", "label": "PM2.5",
        },
    },
    {
        "id": "v_power",
        "name": "全屋功耗",
        "area": "客厅",
        "category": "sensor",
        "icon": "mdi:flash",
        "entities": {"value": "sensor.dang_qian_gong_hao"},
        "injectable": True,
        "inject_config": {
            "min": 0, "max": 5000, "step": 10,
            "unit": "W", "label": "功耗",
        },
    },
]

# 场景预设
SCENE_PRESETS = [
    {
        "id": "summer_hot",
        "name": "夏日高温",
        "description": "温度35°C、湿度80%，测试空调自动开启",
        "injections": [
            {"entity_id": "sensor.shi_nei_wen_du", "value": "35.0"},
            {"entity_id": "sensor.shi_nei_shi_du", "value": "80"},
        ],
        "controls": [
            {"entity_id": "input_select.ac_power", "service": "input_select.select_option", "data": {"option": "开"}},
            {"entity_id": "input_select.ac_mode", "service": "input_select.select_option", "data": {"option": "制冷"}},
            {"entity_id": "input_number.ac_temperature", "service": "input_number.set_value", "data": {"value": 24}},
        ],
    },
    {
        "id": "night_sleep",
        "name": "深夜睡眠",
        "description": "关闭所有灯，卧室灯微亮，空调26°C",
        "injections": [],
        "controls": [
            {"entity_id": "input_boolean.light_living_room", "service": "input_boolean.turn_off", "data": {}},
            {"entity_id": "input_boolean.light_study_room", "service": "input_boolean.turn_off", "data": {}},
            {"entity_id": "input_boolean.light_bedroom", "service": "input_boolean.turn_on", "data": {}},
            {"entity_id": "input_number.light_bedroom_brightness", "service": "input_number.set_value", "data": {"value": 20}},
            {"entity_id": "input_select.ac_power", "service": "input_select.select_option", "data": {"option": "开"}},
            {"entity_id": "input_number.ac_temperature", "service": "input_number.set_value", "data": {"value": 26}},
        ],
    },
    {
        "id": "leave_home",
        "name": "无人离家",
        "description": "全部灯关闭，空调关闭，门锁上锁",
        "injections": [],
        "controls": [
            {"entity_id": "input_boolean.light_living_room", "service": "input_boolean.turn_off", "data": {}},
            {"entity_id": "input_boolean.light_bedroom", "service": "input_boolean.turn_off", "data": {}},
            {"entity_id": "input_boolean.light_study_room", "service": "input_boolean.turn_off", "data": {}},
            {"entity_id": "input_boolean.coffee_machine", "service": "input_boolean.turn_off", "data": {}},
            {"entity_id": "input_select.ac_power", "service": "input_select.select_option", "data": {"option": "关"}},
            {"entity_id": "input_boolean.front_door_lock", "service": "input_boolean.turn_on", "data": {}},
        ],
    },
    {
        "id": "come_home",
        "name": "回家模式",
        "description": "客厅灯80%亮度，空调24°C制冷",
        "injections": [],
        "controls": [
            {"entity_id": "input_boolean.light_living_room", "service": "input_boolean.turn_on", "data": {}},
            {"entity_id": "input_number.light_living_room_brightness", "service": "input_number.set_value", "data": {"value": 80}},
            {"entity_id": "input_select.ac_power", "service": "input_select.select_option", "data": {"option": "开"}},
            {"entity_id": "input_number.ac_temperature", "service": "input_number.set_value", "data": {"value": 24}},
        ],
    },
]

VIRTUAL_ENTITY_IDS = {
    entity_id
    for device in VIRTUAL_DEVICES
    for entity_id in device["entities"].values()
}
INJECTABLE_ENTITY_IDS = {
    entity_id
    for device in VIRTUAL_DEVICES
    if device.get("injectable")
    for entity_id in device["entities"].values()
}
VIRTUAL_CONTROL_SERVICES = {
    entity_id: (
        {"input_boolean.turn_on", "input_boolean.turn_off", "input_boolean.toggle"}
        if entity_id.startswith("input_boolean.")
        else {"input_number.set_value"}
        if entity_id.startswith("input_number.")
        else {"input_select.select_option"}
        if entity_id.startswith("input_select.")
        else set()
    )
    for entity_id in VIRTUAL_ENTITY_IDS
}
VIRTUAL_SERVICE_DATA_KEYS = {
    "input_boolean.turn_on": set(),
    "input_boolean.turn_off": set(),
    "input_boolean.toggle": set(),
    "input_number.set_value": {"value"},
    "input_select.select_option": {"option"},
}

VIRTUAL_NUMBER_RANGES = {
    "input_number.light_living_room_brightness": (0.0, 100.0),
    "input_number.light_bedroom_brightness": (0.0, 100.0),
    "input_number.light_study_room_brightness": (0.0, 100.0),
    "input_number.ac_temperature": (16.0, 30.0),
}
VIRTUAL_SELECT_OPTIONS = {
    "input_select.ac_power": {"开", "关"},
    "input_select.ac_mode": {"自动", "制冷", "制热", "除湿", "送风"},
}


def _require_injectable_entity(entity_id: str) -> None:
    if entity_id not in INJECTABLE_ENTITY_IDS:
        raise HTTPException(
            status_code=400,
            detail="沙盘注入只允许预定义虚拟传感器；真实设备请通过设备控制模块接入",
        )


def _validate_injection_value(entity_id: str, value: str) -> float:
    _require_injectable_entity(entity_id)
    device = next(
        (item for item in VIRTUAL_DEVICES if entity_id in item["entities"].values()),
        None,
    )
    config = (device or {}).get("inject_config") or {}
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="虚拟传感器注入值必须是数值") from exc
    minimum = float(config.get("min", number))
    maximum = float(config.get("max", number))
    if not minimum <= number <= maximum:
        raise HTTPException(
            status_code=422,
            detail=f"注入值超出允许范围 {minimum:g} 至 {maximum:g}",
        )
    return number


def _validate_virtual_control(
    entity_id: str,
    service: str,
    data: dict | None = None,
) -> None:
    if entity_id not in VIRTUAL_ENTITY_IDS:
        raise HTTPException(
            status_code=400,
            detail="沙盘控制只允许预定义虚拟实体；真实设备请通过设备控制模块接入",
        )
    allowed_services = VIRTUAL_CONTROL_SERVICES.get(entity_id, set())
    if service not in allowed_services:
        raise HTTPException(
            status_code=400,
            detail=f"虚拟实体 {entity_id} 不支持 {service}，允许服务：{', '.join(sorted(allowed_services)) or '无'}",
        )
    allowed_keys = VIRTUAL_SERVICE_DATA_KEYS.get(service, set())
    unexpected = set((data or {}).keys()) - allowed_keys
    if unexpected:
        raise HTTPException(
            status_code=400,
            detail=f"服务 {service} 不允许参数：{', '.join(sorted(unexpected))}",
        )
    payload = data or {}
    if service == "input_number.set_value":
        if "value" not in payload:
            raise HTTPException(status_code=422, detail="数值控制缺少 value 参数")
        try:
            number = float(payload["value"])
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="value 必须是数值") from exc
        minimum, maximum = VIRTUAL_NUMBER_RANGES.get(entity_id, (-1e9, 1e9))
        if not minimum <= number <= maximum:
            raise HTTPException(
                status_code=422,
                detail=f"目标值超出允许范围 {minimum:g} 至 {maximum:g}",
            )
    if service == "input_select.select_option":
        option = str(payload.get("option") or "").strip()
        allowed_options = VIRTUAL_SELECT_OPTIONS.get(entity_id, set())
        if not option:
            raise HTTPException(status_code=422, detail="选项控制缺少 option 参数")
        if allowed_options and option not in allowed_options:
            raise HTTPException(
                status_code=422,
                detail=f"不支持选项 {option}，可选值：{', '.join(sorted(allowed_options))}",
            )


def _device_entity_index() -> dict[str, dict]:
    index: dict[str, dict] = {}
    for device in VIRTUAL_DEVICES:
        for role, entity_id in device["entities"].items():
            index[entity_id] = {
                "device_id": device["id"],
                "device_name": device["name"],
                "area": device["area"],
                "role": role,
            }
    return index


VIRTUAL_ENTITY_INDEX = _device_entity_index()


def _is_brightness_entity(entity_id: str) -> bool:
    return (VIRTUAL_ENTITY_INDEX.get(entity_id) or {}).get("role") == "brightness"


def _number_range(state: dict) -> tuple[float, float, float]:
    attributes = state.get("attributes") or {}
    try:
        minimum = float(attributes.get("min", 0))
        maximum = float(attributes.get("max", 100))
        step = float(attributes.get("step", 1))
    except (TypeError, ValueError):
        return 0.0, 100.0, 1.0
    if maximum <= minimum:
        return 0.0, 100.0, 1.0
    return minimum, maximum, step if step > 0 else 1.0


def _brightness_to_percent(state: dict) -> dict:
    """将 HA 现场亮度量程归一为平台约定的 0-100%，同时保留原始证据。"""
    normalized = {**state, "attributes": dict(state.get("attributes") or {})}
    try:
        raw_value = float(state.get("state"))
    except (TypeError, ValueError):
        return normalized
    minimum, maximum, _step = _number_range(state)
    percent = max(0.0, min(100.0, (raw_value - minimum) * 100 / (maximum - minimum)))
    normalized["state"] = f"{percent:.1f}"
    normalized["attributes"].update({
        "raw_state": str(state.get("state")),
        "raw_min": minimum,
        "raw_max": maximum,
        "normalized_as_percent": True,
        "unit_of_measurement": "%",
    })
    return normalized


def _brightness_to_raw(percent: float, state: dict) -> float:
    minimum, maximum, step = _number_range(state)
    raw_value = minimum + max(0.0, min(100.0, percent)) * (maximum - minimum) / 100
    stepped = minimum + round((raw_value - minimum) / step) * step
    return max(minimum, min(maximum, stepped))


def _workspace_entity_state(entity_id: str, state: dict) -> dict:
    return _brightness_to_percent(state) if _is_brightness_entity(entity_id) else state


def _unavailable_entity_state() -> dict:
    return {
        "state": "unavailable",
        "attributes": {},
        "last_changed": "",
        "last_updated": "",
    }


def _sandbox_runtime_error_message(error: Exception | str) -> str:
    message = str(error or "").strip()
    normalized = message.lower()
    if not message:
        return "Home Assistant 当前无法建立连接，请检查服务地址、网络和运行状态"
    if any(token in normalized for token in ("401", "403", "unauthorized", "forbidden", "authentication")):
        return "Home Assistant 认证失败，请在系统设置中更新长效 Token"
    if any(token in normalized for token in ("timeout", "timed out", "connecttimeout", "readtimeout")):
        return "Home Assistant 连接超时，请检查服务地址、网络和运行状态"
    if any(token in normalized for token in (
        "all connection attempts failed",
        "connection refused",
        "connecterror",
        "name or service not known",
        "nodename nor servname provided",
        "network is unreachable",
        "server disconnected",
    )):
        return "Home Assistant 当前无法建立连接，请检查服务地址、网络和运行状态"
    if any(token in normalized for token in ("json", "响应格式", "response format")):
        return "Home Assistant 返回的数据格式异常，请检查服务版本和接口响应"
    if message.startswith("Home Assistant") and not any(char in message for char in "\r\n"):
        return message[:200]
    return "Home Assistant 状态读取失败，请检查服务配置和运行日志"


def _build_virtual_device_workspace(states: dict[str, dict] | None = None) -> list[dict]:
    state_map = states or {}
    result = []
    for device in VIRTUAL_DEVICES:
        entity_states = {}
        for key, entity_id in device["entities"].items():
            state = state_map.get(entity_id, _unavailable_entity_state())
            entity_states[key] = _workspace_entity_state(entity_id, state)
        available_roles = [
            role
            for role, state in entity_states.items()
            if str(state.get("state") or "").lower() not in {"", "unknown", "unavailable"}
        ]
        missing_roles = [role for role in entity_states if role not in available_roles]
        if not missing_roles:
            availability = "available"
        elif available_roles:
            availability = "partial"
        else:
            availability = "unavailable"
        result.append({
            **device,
            "entity_states": entity_states,
            "availability": availability,
            "available_entity_count": len(available_roles),
            "total_entity_count": len(entity_states),
            "missing_roles": missing_roles,
        })
    return result


def _entity_label(entity_id: str) -> str:
    item = VIRTUAL_ENTITY_INDEX.get(entity_id) or {}
    return str(item.get("device_name") or _get_name(entity_id))


def _expected_state(service: str, data: dict | None = None) -> str | None:
    payload = data or {}
    if service.endswith(".turn_on"):
        return "on"
    if service.endswith(".turn_off"):
        return "off"
    if service == "input_number.set_value":
        return str(payload.get("value"))
    if service == "input_select.select_option":
        return str(payload.get("option"))
    return None


def _service_label(service: str) -> str:
    return {
        "input_boolean.turn_on": "打开",
        "input_boolean.turn_off": "关闭",
        "input_boolean.toggle": "切换开关",
        "input_number.set_value": "设置数值",
        "input_select.select_option": "选择模式",
    }.get(service, "执行控制")


def _virtual_action_label(entity_id: str, service: str, expected: str | None = None) -> str:
    role = str((VIRTUAL_ENTITY_INDEX.get(entity_id) or {}).get("role") or "")
    expected_text = str(expected or "")
    if role == "lock":
        return "上锁" if expected_text == "on" else "解锁" if expected_text == "off" else "设置门锁"
    if role == "power":
        device = str((VIRTUAL_ENTITY_INDEX.get(entity_id) or {}).get("device_name") or "")
        if "空调" in device:
            return "开启空调" if expected_text in {"on", "开"} else "关闭空调" if expected_text in {"off", "关"} else "设置空调电源"
        return "开启" if expected_text == "on" else "关闭" if expected_text == "off" else _service_label(service)
    if role == "brightness":
        return "设置亮度"
    if role == "temperature":
        return "设置目标温度"
    if role == "mode":
        return "设置运行模式"
    return _service_label(service)


def _scene_operation_preview(scene: dict) -> list[dict[str, str]]:
    previews: list[dict[str, str]] = []
    for item in scene.get("injections", []):
        entity_id = str(item.get("entity_id") or "")
        unit = _get_unit(entity_id)
        previews.append({
            "kind": "inject",
            "entity_id": entity_id,
            "device_name": _entity_label(entity_id),
            "action_label": "注入传感器值",
            "target_label": f"{item.get('value', '')}{unit}",
        })
    for item in scene.get("controls", []):
        entity_id = str(item.get("entity_id") or "")
        service = str(item.get("service") or "")
        payload = item.get("data") or {}
        expected = _expected_state(service, payload)
        role = str((VIRTUAL_ENTITY_INDEX.get(entity_id) or {}).get("role") or "")
        if role == "brightness" and expected not in (None, ""):
            target_label = f"亮度 {expected}%"
        elif role == "temperature" and expected not in (None, ""):
            target_label = f"目标温度 {expected}°C"
        elif role == "mode" and expected not in (None, ""):
            target_label = f"模式 {expected}"
        elif role == "lock":
            target_label = {"on": "已上锁", "off": "已解锁"}.get(str(expected), str(expected or "执行"))
        else:
            target_label = {"on": "开启", "off": "关闭", "开": "开启", "关": "关闭"}.get(str(expected), str(expected or "执行"))
        previews.append({
            "kind": "control",
            "entity_id": entity_id,
            "device_name": _entity_label(entity_id),
            "action_label": _virtual_action_label(entity_id, service, expected),
            "target_label": target_label,
        })
    return previews


def _state_matches(actual: str, expected: str | None, *, service: str = "") -> bool:
    if expected is None:
        return actual not in {"unknown", "unavailable", ""}
    if service == "input_number.set_value":
        try:
            return abs(float(actual) - float(expected)) < 0.001
        except (TypeError, ValueError):
            return False
    return str(actual) == str(expected)


async def _read_entity_state(
    client: httpx.AsyncClient,
    ha_url: str,
    ha_token: str,
    entity_id: str,
) -> dict:
    response = await client.get(
        f"{ha_url.rstrip('/')}/api/states/{entity_id}",
        headers={"Authorization": f"Bearer {ha_token}"},
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Home Assistant 实体回读格式异常")
    return _normalize_ha_state(payload)


async def _wait_for_entity_state(
    client: httpx.AsyncClient,
    ha_url: str,
    ha_token: str,
    entity_id: str,
    expected: str | None,
    *,
    service: str = "",
) -> tuple[dict, bool]:
    latest = {"state": "unknown", "attributes": {}}
    for attempt in range(READBACK_ATTEMPTS):
        if attempt:
            await asyncio.sleep(READBACK_INTERVAL_SECONDS)
        latest = await _read_entity_state(client, ha_url, ha_token, entity_id)
        if _state_matches(str(latest.get("state") or ""), expected, service=service):
            return latest, True
    return latest, False


def _operation_detail(
    *,
    action: str,
    source: str,
    entity_id: str = "",
    service: str = "",
    requested_value: str = "",
    actual_state: str = "",
    confirmed: bool | None = None,
    total: int | None = None,
    succeeded: int | None = None,
    failed: int | None = None,
    error: str = "",
) -> str:
    return json.dumps({
        "action": action,
        "source": source,
        "entity_id": entity_id,
        "service": service,
        "requested_value": requested_value,
        "actual_state": actual_state,
        "confirmed": confirmed,
        "total": total,
        "succeeded": succeeded,
        "failed": failed,
        "error": error[:300],
    }, ensure_ascii=False)


def _parse_operation_detail(detail: str | None) -> dict:
    try:
        payload = json.loads(detail or "{}")
        return payload if isinstance(payload, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


def _add_operation_log(
    db: AsyncSession,
    user: dict,
    *,
    level: str,
    title: str,
    detail: str,
    entity_id: str = "",
) -> None:
    db.add(OperationLog(
        type=SANDBOX_LOG_TYPE,
        level=level,
        title=title,
        detail=detail,
        user_id=user.get("user_id"),
        username=user.get("username", ""),
        entity_id=entity_id,
    ))


# ════════════════════ API ════════════════════


@router.get("/health", summary="沙盘模块健康检查")
async def health():
    return {"status": "ok", "module": "sandbox", "mode": "simulation"}


@router.get("/client-config", summary="获取电子沙盘前端连接配置")
async def get_sandbox_client_config(
    request: Request,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    runtime = await get_runtime_config(db)
    ha_url = _get_browser_accessible_ha_url(request, runtime.ha_base_url)
    if not ha_url or not runtime.ha_token:
        raise HTTPException(status_code=503, detail="Home Assistant 前端连接配置缺失")

    try:
        available_ids = await _fetch_available_entity_ids(runtime.ha_base_url, runtime.ha_token)
        entities = _resolve_ui_entities(available_ids)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Home Assistant 实体加载失败: {exc}") from exc

    return {
        "ha_url": ha_url,
        "entities": entities,
        "auth_mode": "backend_proxy",
        "mode": "simulation",
    }


@router.get("/devices", summary="获取虚拟设备列表与实时状态")
async def get_virtual_devices(
    refresh: bool = Query(False),
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回虚拟设备定义；HA 离线时保留工作区并明确标记运行态不可用。"""
    runtime = await get_runtime_config(db)
    ha_url = runtime.ha_base_url
    ha_token = runtime.ha_token
    states: dict[str, dict] = {}
    ha_connected = False
    runtime_error: str | None = None

    if not ha_url or not ha_token:
        runtime_error = "Home Assistant 运行时配置不完整，请在系统设置中填写服务地址和长效 Token"
    else:
        try:
            states = await _fetch_ha_state_map(ha_url, ha_token, force=refresh)
            ha_connected = True
        except Exception as exc:
            runtime_error = _sandbox_runtime_error_message(exc)

    result = _build_virtual_device_workspace(states)

    available_count = sum(1 for device in result if device["availability"] == "available")
    partial_count = sum(1 for device in result if device["availability"] == "partial")
    unavailable_count = sum(1 for device in result if device["availability"] == "unavailable")
    return {
        "devices": result,
        "count": len(result),
        "available_count": available_count,
        "partial_count": partial_count,
        "unavailable_count": unavailable_count,
        "mode": "simulation",
        "ha_connected": ha_connected,
        "status": "connected" if ha_connected else "unavailable",
        "error": runtime_error,
        "fetched_at": datetime.now().isoformat(),
        "cache_ttl_seconds": STATE_CACHE_TTL_SECONDS,
    }


class InjectRequest(BaseModel):
    entity_id: str
    value: str
    source: str = Field("manual", pattern="^(manual|preset|auto)$")


@router.post("/inject", summary="数据注入 - 向虚拟传感器写入值")
async def inject_data(
    req: InjectRequest,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """通过 HA REST API 直接设置实体状态"""
    runtime = await get_runtime_config(db)
    ha_url = runtime.ha_base_url
    ha_token = runtime.ha_token

    entity_id = req.entity_id
    numeric_value = _validate_injection_value(entity_id, req.value)
    domain = entity_id.split(".")[0]

    try:
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            if domain == "input_number":
                r = await client.post(
                    f"{ha_url}/api/services/input_number/set_value",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json={"entity_id": entity_id, "value": numeric_value},
                )
            elif domain == "input_boolean":
                service = "turn_on" if req.value.lower() in ("on", "true", "1") else "turn_off"
                r = await client.post(
                    f"{ha_url}/api/services/input_boolean/{service}",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json={"entity_id": entity_id},
                )
            elif domain == "input_select":
                r = await client.post(
                    f"{ha_url}/api/services/input_select/select_option",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json={"entity_id": entity_id, "option": req.value},
                )
            elif domain == "sensor":
                # Template sensor 直接通过 HA API 设置状态（模拟注入）
                r = await client.post(
                    f"{ha_url}/api/states/{entity_id}",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json={
                        "state": str(numeric_value),
                        "attributes": {"unit_of_measurement": _get_unit(entity_id), "friendly_name": _get_name(entity_id)},
                    },
                )
            elif domain == "binary_sensor":
                state_val = "on" if req.value.lower() in ("on", "true", "1") else "off"
                r = await client.post(
                    f"{ha_url}/api/states/{entity_id}",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json={"state": state_val, "attributes": {}},
                )
            else:
                raise HTTPException(400, f"不支持的实体类型: {domain}")
            r.raise_for_status()

            expected = str(numeric_value)
            readback, confirmed = await _wait_for_entity_state(
                client,
                ha_url,
                ha_token,
                entity_id,
                expected,
                service="input_number.set_value" if domain == "input_number" else "",
            )

        _invalidate_state_cache(ha_url)
        level = "success" if confirmed else "warning"
        title = f"注入{_entity_label(entity_id)}数据"
        detail = _operation_detail(
            action="inject",
            source=req.source,
            entity_id=entity_id,
            requested_value=req.value,
            actual_state=str(readback.get("state") or "unknown"),
            confirmed=confirmed,
        )
        _add_operation_log(
            db,
            user,
            level=level,
            title=title,
            detail=detail,
            entity_id=entity_id,
        )

        _add_log(
            "inject",
            level,
            title,
            f"目标值 {req.value}，回读 {readback.get('state', 'unknown')}",
        )
        return {
            "success": confirmed,
            "entity_id": entity_id,
            "device_name": _entity_label(entity_id),
            "value": req.value,
            "readback": readback,
            "confirmed": confirmed,
            "mode": "simulation",
        }

    except HTTPException:
        raise
    except Exception as exc:
        runtime_error = _sandbox_runtime_error_message(exc)
        title = f"注入{_entity_label(entity_id)}数据失败"
        _add_log("inject", "error", title, runtime_error)
        _add_operation_log(
            db,
            user,
            level="error",
            title=title,
            detail=_operation_detail(
                action="inject",
                source=req.source,
                entity_id=entity_id,
                requested_value=req.value,
                confirmed=False,
                error=runtime_error,
            ),
            entity_id=entity_id,
        )
        await db.commit()
        raise HTTPException(502, f"虚拟传感器注入失败：{runtime_error}") from exc


class ControlRequest(BaseModel):
    entity_id: str
    service: str
    data: dict = Field(default_factory=dict)


@router.post("/control", summary="控制虚拟设备")
async def control_device(
    req: ControlRequest,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """通过 HA 服务调用控制虚拟设备"""
    runtime = await get_runtime_config(db)
    ha_url = runtime.ha_base_url
    ha_token = runtime.ha_token
    _validate_virtual_control(req.entity_id, req.service, req.data)

    try:
        domain, service_name = req.service.split(".", 1)

        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            previous = await _read_entity_state(
                client,
                ha_url,
                ha_token,
                req.entity_id,
            )
            service_data = dict(req.data)
            requested_value = str(req.data.get("value", ""))
            if req.service == "input_number.set_value" and _is_brightness_entity(req.entity_id):
                service_data["value"] = _brightness_to_raw(float(req.data["value"]), previous)
            payload = {"entity_id": req.entity_id, **service_data}
            r = await client.post(
                f"{ha_url}/api/services/{domain}/{service_name}",
                headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                json=payload,
            )
            r.raise_for_status()

            expected = _expected_state(req.service, service_data)
            if req.service.endswith(".toggle"):
                previous_state = str(previous.get("state") or "unknown")
                expected = "off" if previous_state == "on" else "on" if previous_state == "off" else None
            readback, confirmed = await _wait_for_entity_state(
                client,
                ha_url,
                ha_token,
                req.entity_id,
                expected,
                service=req.service,
            )

        workspace_readback = _workspace_entity_state(req.entity_id, readback)

        _invalidate_state_cache(ha_url)
        level = "success" if confirmed else "warning"
        title = f"控制{_entity_label(req.entity_id)}：{_service_label(req.service)}"
        _add_operation_log(
            db,
            user,
            level=level,
            title=title,
            detail=_operation_detail(
                action="control",
                source="manual",
                entity_id=req.entity_id,
                service=req.service,
                requested_value=requested_value or str(expected or ""),
                actual_state=str(workspace_readback.get("state") or "unknown"),
                confirmed=confirmed,
            ),
            entity_id=req.entity_id,
        )
        _add_log(
            "control",
            level,
            title,
            f"目标状态 {requested_value or expected or '可用'}，回读 {workspace_readback.get('state', 'unknown')}",
        )

        return {
            "success": confirmed,
            "entity_id": req.entity_id,
            "device_name": _entity_label(req.entity_id),
            "service": req.service,
            "previous_state": previous,
            "readback": workspace_readback,
            "confirmed": confirmed,
            "mode": "simulation",
        }

    except HTTPException:
        raise
    except Exception as exc:
        runtime_error = _sandbox_runtime_error_message(exc)
        title = f"控制{_entity_label(req.entity_id)}失败"
        _add_log("control", "error", title, runtime_error)
        _add_operation_log(
            db,
            user,
            level="error",
            title=title,
            detail=_operation_detail(
                action="control",
                source="manual",
                entity_id=req.entity_id,
                service=req.service,
                confirmed=False,
                error=runtime_error,
            ),
            entity_id=req.entity_id,
        )
        await db.commit()
        raise HTTPException(502, f"虚拟设备控制失败：{runtime_error}") from exc


@router.get("/scenes", summary="获取场景预设列表")
async def get_scenes(user=Depends(get_current_user)):
    return {
        "scenes": [
            {
                "id": scene["id"],
                "name": scene["name"],
                "description": scene["description"],
                "operation_count": len(scene.get("injections", [])) + len(scene.get("controls", [])),
                "injection_count": len(scene.get("injections", [])),
                "control_count": len(scene.get("controls", [])),
                "operations": _scene_operation_preview(scene),
            }
            for scene in SCENE_PRESETS
        ],
        "count": len(SCENE_PRESETS),
        "mode": "simulation",
    }


@router.post("/scenes/{scene_id}/execute", summary="执行场景预设")
async def execute_scene(
    scene_id: str,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """执行预设场景：批量注入传感器数据 + 批量控制设备"""
    scene = next((s for s in SCENE_PRESETS if s["id"] == scene_id), None)
    if not scene:
        raise HTTPException(404, f"场景不存在: {scene_id}")

    runtime = await get_runtime_config(db)
    ha_url = runtime.ha_base_url
    ha_token = runtime.ha_token
    results: list[dict] = []

    if not ha_url or not ha_token:
        raise HTTPException(status_code=503, detail="Home Assistant 运行时配置不完整，场景未执行")

    required_entity_ids = [
        str(item.get("entity_id") or "")
        for item in [*scene.get("injections", []), *scene.get("controls", [])]
        if item.get("entity_id")
    ]
    try:
        current_states = await _fetch_ha_state_map(ha_url, ha_token, force=True)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_sandbox_runtime_error_message(exc)) from exc
    available_targets = [
        entity_id
        for entity_id in required_entity_ids
        if str((current_states.get(entity_id) or {}).get("state") or "").lower()
        not in {"", "unknown", "unavailable"}
    ]
    if required_entity_ids and not available_targets:
        raise HTTPException(
            status_code=409,
            detail="场景所需虚拟实体当前全部不可用，未发送任何场景步骤",
        )

    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        for inj in scene.get("injections", []):
            if inj["entity_id"] not in available_targets:
                results.append({
                    "kind": "inject",
                    "device_name": _entity_label(inj["entity_id"]),
                    "entity_id": inj["entity_id"],
                    "action_label": "注入传感器值",
                    "requested_value": str(inj["value"]),
                    "actual_state": "unavailable",
                    "success": False,
                    "confirmed": False,
                    "error": "执行前预检未通过：虚拟实体当前不可用，未发送该步骤",
                })
                continue
            try:
                numeric_value = _validate_injection_value(inj["entity_id"], str(inj["value"]))
                response = await client.post(
                    f"{ha_url}/api/states/{inj['entity_id']}",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json={"state": str(numeric_value), "attributes": {"unit_of_measurement": _get_unit(inj["entity_id"])}},
                )
                response.raise_for_status()
                readback, confirmed = await _wait_for_entity_state(
                    client,
                    ha_url,
                    ha_token,
                    inj["entity_id"],
                    str(numeric_value),
                )
                results.append({
                    "kind": "inject",
                    "device_name": _entity_label(inj["entity_id"]),
                    "entity_id": inj["entity_id"],
                    "action_label": "注入传感器值",
                    "requested_value": str(inj["value"]),
                    "actual_state": str(readback.get("state") or "unknown"),
                    "success": confirmed,
                    "confirmed": confirmed,
                    "error": "" if confirmed else "Home Assistant 未在确认窗口内回读目标值",
                })
            except Exception as exc:
                results.append({
                    "kind": "inject",
                    "device_name": _entity_label(inj["entity_id"]),
                    "entity_id": inj["entity_id"],
                    "action_label": "注入传感器值",
                    "requested_value": str(inj["value"]),
                    "actual_state": "unknown",
                    "success": False,
                    "confirmed": False,
                    "error": _sandbox_runtime_error_message(exc),
                })

        for ctrl in scene.get("controls", []):
            if ctrl["entity_id"] not in available_targets:
                expected = _expected_state(ctrl["service"], ctrl.get("data", {}))
                results.append({
                    "kind": "control",
                    "device_name": _entity_label(ctrl["entity_id"]),
                    "entity_id": ctrl["entity_id"],
                    "service": ctrl["service"],
                    "action_label": _virtual_action_label(ctrl["entity_id"], ctrl["service"], expected),
                    "requested_value": str((ctrl.get("data") or {}).get("value", expected or "")),
                    "actual_state": "unavailable",
                    "success": False,
                    "confirmed": False,
                    "error": "执行前预检未通过：虚拟实体当前不可用，未发送该步骤",
                })
                continue
            try:
                _validate_virtual_control(ctrl["entity_id"], ctrl["service"], ctrl.get("data", {}))
                domain, svc = ctrl["service"].split(".", 1)
                service_data = dict(ctrl.get("data", {}))
                if ctrl["service"] == "input_number.set_value" and _is_brightness_entity(ctrl["entity_id"]):
                    previous = await _read_entity_state(client, ha_url, ha_token, ctrl["entity_id"])
                    service_data["value"] = _brightness_to_raw(float(service_data["value"]), previous)
                payload = {"entity_id": ctrl["entity_id"], **service_data}
                response = await client.post(
                    f"{ha_url}/api/services/{domain}/{svc}",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json=payload,
                )
                response.raise_for_status()
                expected = _expected_state(ctrl["service"], service_data)
                readback, confirmed = await _wait_for_entity_state(
                    client,
                    ha_url,
                    ha_token,
                    ctrl["entity_id"],
                    expected,
                    service=ctrl["service"],
                )
                workspace_readback = _workspace_entity_state(ctrl["entity_id"], readback)
                requested_value = str((ctrl.get("data") or {}).get("value", expected or ""))
                results.append({
                    "kind": "control",
                    "device_name": _entity_label(ctrl["entity_id"]),
                    "entity_id": ctrl["entity_id"],
                    "service": ctrl["service"],
                    "action_label": _virtual_action_label(ctrl["entity_id"], ctrl["service"], expected),
                    "requested_value": requested_value,
                    "actual_state": str(workspace_readback.get("state") or "unknown"),
                    "success": confirmed,
                    "confirmed": confirmed,
                    "error": "" if confirmed else "Home Assistant 未在确认窗口内回读目标状态",
                })
            except Exception as exc:
                results.append({
                    "kind": "control",
                    "device_name": _entity_label(ctrl["entity_id"]),
                    "entity_id": ctrl["entity_id"],
                    "service": ctrl["service"],
                    "action_label": _virtual_action_label(
                        ctrl["entity_id"],
                        ctrl["service"],
                        _expected_state(ctrl["service"], ctrl.get("data", {})),
                    ),
                    "requested_value": str(_expected_state(ctrl["service"], ctrl.get("data", {})) or ""),
                    "actual_state": "unknown",
                    "success": False,
                    "confirmed": False,
                    "error": _sandbox_runtime_error_message(exc),
                })

    _invalidate_state_cache(ha_url)
    failed = [item for item in results if not item["success"]]
    succeeded = len(results) - len(failed)
    level = "success" if not failed else "error" if not succeeded else "warning"
    title = f"执行虚拟场景：{scene['name']}"
    _add_operation_log(
        db,
        user,
        level=level,
        title=title,
        detail=_operation_detail(
            action="scene",
            source="preset",
            total=len(results),
            succeeded=succeeded,
            failed=len(failed),
            confirmed=not failed,
            error="；".join(str(item.get("error") or "") for item in failed)[:300],
        ),
        entity_id=f"scene:{scene_id}",
    )
    _add_log(
        "system",
        level,
        title,
        f"共 {len(results)} 项，成功 {succeeded} 项，失败 {len(failed)} 项",
    )
    return {
        "success": not failed,
        "partial": bool(failed and succeeded),
        "scene_id": scene_id,
        "scene": scene["name"],
        "operation_count": len(results),
        "succeeded_count": succeeded,
        "failed_count": len(failed),
        "results": results,
        "mode": "simulation",
    }


@router.get("/logs", summary="获取仿真日志")
async def get_logs(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=10, le=100),
    level: str = Query("", pattern="^(|info|success|warning|error)$"),
    action: str = Query("", pattern="^(|inject|control|scene)$"),
    keyword: str = Query("", max_length=100),
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conditions = [OperationLog.type == SANDBOX_LOG_TYPE]
    if user.get("role") != "admin":
        conditions.append(OperationLog.user_id == user.get("user_id"))
    if level:
        conditions.append(OperationLog.level == level)
    if action:
        conditions.append(OperationLog.detail.ilike(f'%"action": "{action}"%'))
    cleaned_keyword = keyword.strip()
    if cleaned_keyword:
        pattern = f"%{cleaned_keyword}%"
        conditions.append(or_(
            OperationLog.title.ilike(pattern),
            OperationLog.detail.ilike(pattern),
            OperationLog.username.ilike(pattern),
        ))

    where_clause = and_(*conditions)
    total = int(await db.scalar(
        select(func.count()).select_from(OperationLog).where(where_clause)
    ) or 0)
    page_count = max(1, (total + size - 1) // size)
    effective_page = min(page, page_count)
    result = await db.execute(
        select(OperationLog)
        .where(where_clause)
        .order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
        .offset((effective_page - 1) * size)
        .limit(size)
    )
    rows = list(result.scalars().all())

    summary_conditions = [OperationLog.type == SANDBOX_LOG_TYPE]
    if user.get("role") != "admin":
        summary_conditions.append(OperationLog.user_id == user.get("user_id"))
    since = datetime.now() - timedelta(hours=24)
    summary = (await db.execute(select(
        func.count(OperationLog.id),
        func.sum(case((OperationLog.level == "success", 1), else_=0)),
        func.sum(case((OperationLog.level.in_(["warning", "error"]), 1), else_=0)),
        func.sum(case((OperationLog.created_at >= since, 1), else_=0)),
        func.max(OperationLog.created_at),
    ).where(*summary_conditions))).one()

    items = []
    for row in rows:
        detail = _parse_operation_detail(row.detail)
        items.append({
            "id": row.id,
            "action": detail.get("action") or "system",
            "source": detail.get("source") or "manual",
            "level": row.level,
            "title": row.title,
            "device_name": _entity_label(row.entity_id) if row.entity_id and not row.entity_id.startswith("scene:") else "",
            "entity_id": row.entity_id or detail.get("entity_id") or "",
            "service": detail.get("service") or "",
            "requested_value": detail.get("requested_value") or "",
            "actual_state": detail.get("actual_state") or "",
            "confirmed": detail.get("confirmed"),
            "total": detail.get("total"),
            "succeeded": detail.get("succeeded"),
            "failed": detail.get("failed"),
            "error": detail.get("error") or "",
            "operator": row.username or "系统",
            "created_at": row.created_at,
        })

    return {
        "items": items,
        "logs": items,
        "total": total,
        "page": effective_page,
        "size": size,
        "page_count": page_count,
        "summary": {
            "total": int(summary[0] or 0),
            "successful": int(summary[1] or 0),
            "attention": int(summary[2] or 0),
            "last_24h": int(summary[3] or 0),
            "latest_at": summary[4],
        },
    }


@router.delete("/logs", summary="清空仿真日志")
async def clear_logs(
    user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    deleted = int(await db.scalar(
        select(func.count()).select_from(OperationLog).where(OperationLog.type == SANDBOX_LOG_TYPE)
    ) or 0)
    await db.execute(delete(OperationLog).where(OperationLog.type == SANDBOX_LOG_TYPE))
    _log_queue.clear()
    return {
        "success": True,
        "deleted": deleted,
        "operator": user.get("username", ""),
    }


@router.get("/logs/stream", summary="SSE 实时日志流")
async def log_stream(user=Depends(get_current_user)):
    """Server-Sent Events 推送实时日志"""
    async def event_generator():
        last_id = 0
        yield f"data: {json.dumps({'type': 'connected', 'message': '日志流已连接'})}\n\n"

        while True:
            # 检查新日志
            new_logs = [l for l in _log_queue if l["id"] > last_id]
            for log in new_logs:
                yield f"data: {json.dumps(log, ensure_ascii=False)}\n\n"
                last_id = log["id"]

            await asyncio.sleep(1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── 辅助函数 ──

def _get_unit(entity_id: str) -> str:
    units = {
        "sensor.shi_nei_wen_du": "°C",
        "sensor.shi_nei_shi_du": "%",
        "sensor.pm2_5": "μg/m³",
        "sensor.dang_qian_gong_hao": "W",
    }
    return units.get(entity_id, "")


def _get_name(entity_id: str) -> str:
    names = {
        "sensor.shi_nei_wen_du": "室内温度",
        "sensor.shi_nei_shi_du": "室内湿度",
        "sensor.pm2_5": "PM2.5",
        "sensor.dang_qian_gong_hao": "当前功耗",
    }
    return names.get(entity_id, entity_id)
