"""
设备接入与控制管理路由

平台侧维护网关、设备台账和实体映射；运行时叠加 Home Assistant 状态并代理控制。
旧的 Dify 控制入口 `/devices/search` 和 `/devices/{entity_id}/control` 保持兼容。
"""
from __future__ import annotations

import asyncio
import hashlib
import time
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.dependencies import get_agent_or_user, get_current_user, get_db, require_admin
from app.models.device_management import DeviceEntityMapping, DeviceGateway, ManagedDevice
from app.models.operation_log import OperationLog
from app.services.homeassistant import HomeAssistantService
from app.services.runtime_settings import get_runtime_config
from app.services.system_summary_cache import invalidate_system_summary

router = APIRouter(prefix="/devices", tags=["设备接入与控制"])

CONTROL_CONFIRM_ATTEMPTS = 12
CONTROL_CONFIRM_INTERVAL_SECONDS = 0.5
MIN_VISIBLE_LIGHT_BRIGHTNESS = 13
HA_WORKSPACE_CACHE_TTL_SECONDS = 60
HA_WORKSPACE_READ_TIMEOUT_SECONDS = 5.0
DEVICE_LIST_CACHE_TTL_SECONDS = 10
DEVICE_LIST_HA_READ_TIMEOUT_SECONDS = 3.0
_ha_workspace_snapshot_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_ha_workspace_snapshot_pending: dict[str, asyncio.Task] = {}
_device_list_snapshot_cache: tuple[float, dict[str, Any]] | None = None
_device_list_snapshot_pending: asyncio.Task | None = None
_device_list_snapshot_version = 0


class ControlRequest(BaseModel):
    """设备或实体控制请求"""
    service: str = "toggle"
    domain: Optional[str] = None
    data: Optional[dict[str, Any]] = None
    role: Optional[str] = None


class ControlStateRollbackError(RuntimeError):
    """HA 乐观回写目标状态后，又回滚为不符合控制目标的状态。"""


class MappingPayload(BaseModel):
    id: int | None = None
    role: str = "power"
    endpoint: str
    gateway_type: str = "homeassistant"
    access_mode: str = "rw"
    unit: str = ""
    value_path: str = ""
    control_actions: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DevicePayload(BaseModel):
    name: str
    category: str = "switch"
    brand: str = ""
    model: str = ""
    location: str = ""
    protocol: str = "homeassistant"
    gateway_id: int | None = None
    description: str = ""
    local_control: bool = False
    enabled: bool = True
    capability_tags: list[str] = Field(default_factory=list)
    mappings: list[MappingPayload] = Field(default_factory=list)


class GatewayPayload(BaseModel):
    name: str
    gateway_type: str = "homeassistant"
    base_url: str = ""
    port: int | None = None
    auth_type: str = "bearer"
    credential: str = ""
    enabled: bool = True
    description: str = ""


class GatewayImportPayload(BaseModel):
    entity_ids: list[str] = Field(default_factory=list, min_length=1, max_length=500)


IMPORTABLE_HA_DOMAINS = {
    "binary_sensor",
    "climate",
    "cover",
    "fan",
    "light",
    "lock",
    "media_player",
    "number",
    "select",
    "sensor",
    "switch",
}

HA_HELPER_PLATFORMS = {
    "counter",
    "input_boolean",
    "input_button",
    "input_datetime",
    "input_number",
    "input_select",
    "input_text",
    "schedule",
    "timer",
}

# 这些集成会在 HA Device Registry 中创建“设备”，但本质是软件服务，不能计作现场硬件。
HA_SOFTWARE_SERVICE_PLATFORMS = {
    "backup",
    "google_translate",
    "met",
    "sun",
    "weather",
}

HA_SOFTWARE_SERVICE_DOMAINS = {
    "conversation",
    "tts",
    "weather",
}

PRIMARY_HARDWARE_DOMAINS = {
    "climate",
    "cover",
    "fan",
    "light",
    "lock",
    "media_player",
}

MEASUREMENT_DEVICE_CLASSES = {
    "aqi",
    "battery",
    "carbon_dioxide",
    "carbon_monoxide",
    "current",
    "energy",
    "humidity",
    "illuminance",
    "moisture",
    "pm1",
    "pm10",
    "pm25",
    "power",
    "pressure",
    "signal_strength",
    "temperature",
    "volatile_organic_compounds",
    "voltage",
}


def _get_domain(endpoint: str) -> str:
    return endpoint.split(".")[0] if "." in endpoint else ""


def _normalize_display_name(value: Any, fallback: str = "") -> str:
    return " ".join(str(value or fallback).split())


def _ha_gateway_display_name(gateway: DeviceGateway | None) -> str:
    """生成面向用户的网关名称，避免重复显示 Home Assistant。"""
    name = _normalize_display_name(getattr(gateway, "name", ""))
    if not name:
        return "Home Assistant"
    if name.lower().startswith("home assistant"):
        return name
    return f"Home Assistant 网关「{name}」"


def _normalize_ha_failure_reason(error: Exception | str) -> str:
    """隐藏底层客户端英文异常，只返回可操作的中文诊断。"""
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return "连接超时"
    raw = _normalize_display_name(error)
    lowered = raw.lower()
    if not raw:
        return "服务未响应"
    if any(item in lowered for item in (
        "all connection attempts failed",
        "connection refused",
        "connecterror",
        "errno 61",
        "errno 111",
        "name or service not known",
        "nodename nor servname provided",
    )):
        return "无法建立网络连接"
    if "timed out" in lowered or "timeout" in lowered:
        return "连接超时"
    if "server disconnected" in lowered or "connection reset" in lowered:
        return "服务端已中断连接"
    if any(item in lowered for item in ("401", "unauthorized", "invalid authentication")):
        return "访问令牌无效或已过期"
    if "403" in lowered or "forbidden" in lowered:
        return "当前凭证没有访问权限"
    if any("\u4e00" <= character <= "\u9fff" for character in raw):
        return raw[:160]
    return "服务请求失败"


def _ha_read_failure_message(
    gateway: DeviceGateway | None,
    error: Exception | str,
    *,
    discovery: bool = False,
) -> str:
    action = "读取设备实体" if discovery else "连接"
    return f"无法{action} {_ha_gateway_display_name(gateway)}（{_normalize_ha_failure_reason(error)}）"


def _aggregate_ha_snapshot_errors(*errors: str) -> str:
    unique_errors = list(dict.fromkeys(
        _normalize_display_name(error).rstrip("；。")
        for error in errors
        if _normalize_display_name(error)
    ))
    if not unique_errors:
        return ""
    return (
        f"{'；'.join(unique_errors)}。继续显示平台设备台账；"
        "相关设备的实时状态和场景暂不可用。"
    )


def _normalize_device_search_text(value: Any) -> str:
    return "".join(
        character.lower()
        for character in str(value or "")
        if character.isalnum()
    )


def _device_matches_search_keyword(device: ManagedDevice, keyword: str) -> bool:
    """兼容设备名称、描述和映射元数据中的运行时别名。"""
    normalized_keyword = _normalize_device_search_text(keyword)
    if not normalized_keyword:
        return False
    candidates: list[Any] = [device.name, device.description]
    for mapping in device.mappings:
        metadata = mapping.mapping_metadata or {}
        candidates.extend(metadata.get("aliases") or [])
    return any(
        normalized_keyword in normalized_candidate
        for candidate in candidates
        if (normalized_candidate := _normalize_device_search_text(candidate))
    )


def _registry_candidate_metadata(
    entity_id: str,
    raw: dict[str, Any],
    entity_registry: dict[str, dict[str, Any]],
    device_registry: dict[str, dict[str, Any]],
    area_registry: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    entity_meta = entity_registry.get(entity_id, {})
    device_id = str(entity_meta.get("device_id") or "")
    device_meta = device_registry.get(device_id, {}) if device_id else {}
    platform = str(entity_meta.get("platform") or "")
    domain = _get_domain(entity_id)
    area_id = str(entity_meta.get("area_id") or device_meta.get("area_id") or "")
    area_meta = area_registry.get(area_id, {}) if area_id else {}
    hidden_or_disabled = bool(entity_meta.get("hidden_by") or entity_meta.get("disabled_by"))
    entity_category = str(entity_meta.get("entity_category") or "")

    if platform in HA_HELPER_PLATFORMS or domain in HA_HELPER_PLATFORMS:
        classification = "helper"
        reason = "HA 辅助实体不代表真实硬件"
    elif platform in HA_SOFTWARE_SERVICE_PLATFORMS or domain in HA_SOFTWARE_SERVICE_DOMAINS:
        classification = "system"
        reason = "软件服务集成不代表现场真实硬件"
    elif hidden_or_disabled:
        classification = "system"
        reason = "实体已在 HA 中隐藏或禁用"
    elif device_id and device_meta:
        classification = "hardware"
        reason = "实体已关联 HA Device Registry 设备；是否适合作为独立平台能力需结合实体类型与导入建议判断"
    elif entity_meta:
        classification = "system"
        reason = "实体未关联 HA 设备，默认不作为真实硬件导入"
    else:
        classification = "unregistered"
        reason = "实体不在 HA Entity Registry 中，无法确认硬件来源"

    attrs = raw.get("attributes", {})
    options = entity_meta.get("options") or {}
    conversation = options.get("conversation") if isinstance(options, dict) else {}
    conversation_exposed = bool(
        isinstance(conversation, dict) and conversation.get("should_expose")
    )
    device_class = str(
        attrs.get("device_class")
        or entity_meta.get("original_device_class")
        or ""
    )
    importable = (
        classification == "hardware"
        and domain in IMPORTABLE_HA_DOMAINS
        and entity_category not in {"diagnostic"}
    )
    recommended = importable and (
        conversation_exposed
        or domain in PRIMARY_HARDWARE_DOMAINS
        or (domain in {"sensor", "binary_sensor"} and device_class in MEASUREMENT_DEVICE_CLASSES)
    )
    return {
        "ha_device_id": device_id,
        "device_name": _normalize_display_name(
            device_meta.get("name_by_user") or device_meta.get("name"),
            attrs.get("friendly_name") or entity_id,
        ),
        "area_id": area_id,
        "area_name": _normalize_display_name(area_meta.get("name")),
        "manufacturer": _normalize_display_name(device_meta.get("manufacturer")),
        "model": _normalize_display_name(device_meta.get("model")),
        "platform": platform,
        "entity_category": entity_category,
        "device_class": device_class,
        "classification": classification,
        "classification_reason": reason,
        "importable": importable,
        "recommended": recommended,
    }


def _merge_entity_metadata(
    stored: dict[str, Any] | None,
    attributes: dict[str, Any] | None,
) -> dict[str, Any]:
    """合并导入时能力快照与 HA 当前属性，当前属性优先。"""
    return {**(stored or {}), **(attributes or {})}


def _capability_metadata(attributes: dict[str, Any] | None) -> dict[str, Any]:
    attrs = attributes or {}
    keys = {
        "supported_features",
        "supported_color_modes",
        "min_color_temp_kelvin",
        "max_color_temp_kelvin",
        "effect_list",
        "current_position",
        "min_temp",
        "max_temp",
        "target_temp_step",
        "temperature_unit",
        "hvac_modes",
        "percentage_step",
        "options",
        "min",
        "max",
        "step",
        "unit_of_measurement",
    }
    return {key: attrs[key] for key in keys if attrs.get(key) is not None}


def _control_actions_for_entity(
    endpoint: str,
    attributes: dict[str, Any] | None = None,
    category: str = "",
) -> list[str]:
    attrs = attributes or {}
    domain = _get_domain(endpoint)
    if domain in {"input_boolean", "switch", "light"}:
        actions = ["turn_on", "turn_off", "toggle"]
        if domain == "light":
            color_modes = attrs.get("supported_color_modes") or []
            if "brightness" in attrs or any(mode != "onoff" for mode in color_modes):
                actions.append("set_brightness")
            if (
                "color_temp" in color_modes
                or attrs.get("min_color_temp_kelvin") is not None
                or attrs.get("max_color_temp_kelvin") is not None
            ):
                actions.append("set_color_temperature")
            if attrs.get("effect_list"):
                actions.append("set_effect")
        return actions
    if domain == "lock":
        return ["lock", "unlock"]
    if domain in {"input_number", "number"}:
        return ["set_value"]
    if domain in {"input_select", "select"}:
        return ["select_option"]
    if domain == "cover":
        actions = ["open_cover", "close_cover", "stop_cover"]
        if attrs.get("current_position") is not None or int(attrs.get("supported_features") or 0) & 4:
            actions.append("set_position")
        return actions
    if domain == "climate":
        actions = ["turn_on", "turn_off"]
        if any(attrs.get(key) is not None for key in ("temperature", "current_temperature", "min_temp", "max_temp")):
            actions.append("set_temperature")
        if attrs.get("hvac_modes"):
            actions.append("set_hvac_mode")
        return actions
    if domain == "fan":
        actions = ["turn_on", "turn_off", "toggle"]
        if attrs.get("percentage") is not None or attrs.get("percentage_step") is not None:
            actions.append("set_percentage")
        return actions
    if domain == "media_player":
        return ["turn_on", "turn_off"]
    if category in {"sensor", "binary_sensor"}:
        return []
    return ["turn_on", "turn_off"]


def _default_actions(endpoint: str, category: str = "") -> list[str]:
    return _control_actions_for_entity(endpoint, category=category)


def _effective_mapping_actions(
    mapping: DeviceEntityMapping,
    attributes: dict[str, Any] | None = None,
) -> list[str]:
    configured = list(mapping.control_actions or [])
    if not mapping.device or mapping.device.source != "ha_sync":
        return configured
    metadata = _merge_entity_metadata(mapping.mapping_metadata, attributes)
    inferred = _control_actions_for_entity(
        mapping.endpoint,
        metadata,
        mapping.device.category,
    )
    return list(dict.fromkeys([*configured, *inferred]))


def _select_control_mapping(
    mappings: list[DeviceEntityMapping],
    role: str | None = None,
    action: str = "",
    entity_attributes: dict[str, dict[str, Any]] | None = None,
) -> DeviceEntityMapping | None:
    writable = [item for item in mappings if item.access_mode in {"rw", "write"}]
    if role:
        role_match = next((item for item in writable if item.role == role), None)
        if role_match:
            return role_match
    if action:
        action_match = next(
            (
                item for item in writable
                if action in _effective_mapping_actions(
                    item,
                    (entity_attributes or {}).get(item.endpoint, {}),
                )
            ),
            None,
        )
        if action_match:
            return action_match
    return writable[0] if writable else None


def _safe_number(value: Any, field_name: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} 必须是有效数字") from exc


def _bounded_number(
    value: Any,
    field_name: str,
    minimum: float,
    maximum: float,
) -> float:
    number = _safe_number(value, field_name)
    if number < minimum or number > maximum:
        raise ValueError(f"{field_name} 必须在 {minimum:g} 到 {maximum:g} 之间")
    return number


def _build_entity_capabilities(
    endpoint: str,
    attributes: dict[str, Any] | None,
    actions: list[str],
    state: Any = None,
) -> list[dict[str, Any]]:
    attrs = attributes or {}
    capabilities: list[dict[str, Any]] = []
    direct_actions = [
        action for action in actions
        if not action.startswith("set_") and action not in {"select_option"}
    ]
    if direct_actions:
        capabilities.append({
            "id": "actions",
            "label": "设备操作",
            "control_type": "actions",
            "actions": direct_actions,
        })

    def add_range(
        capability_id: str,
        label: str,
        action: str,
        minimum: float,
        maximum: float,
        step: float,
        unit: str,
        current_value: Any,
    ) -> None:
        if action not in actions:
            return
        capabilities.append({
            "id": capability_id,
            "label": label,
            "control_type": "range",
            "action": action,
            "min": minimum,
            "max": maximum,
            "step": step,
            "unit": unit,
            "current_value": current_value,
        })

    if "set_brightness" in actions:
        raw_brightness = attrs.get("brightness")
        brightness = round(float(raw_brightness) * 100 / 255) if raw_brightness is not None else None
        add_range("brightness", "亮度", "set_brightness", 0, 100, 1, "%", brightness)
    add_range(
        "color_temperature",
        "色温",
        "set_color_temperature",
        float(attrs.get("min_color_temp_kelvin") or 2000),
        float(attrs.get("max_color_temp_kelvin") or 6500),
        50,
        "K",
        attrs.get("color_temp_kelvin"),
    )
    add_range("position", "开合位置", "set_position", 0, 100, 1, "%", attrs.get("current_position"))
    add_range(
        "temperature",
        "目标温度",
        "set_temperature",
        float(attrs.get("min_temp") or 16),
        float(attrs.get("max_temp") or 30),
        float(attrs.get("target_temp_step") or 0.5),
        str(attrs.get("temperature_unit") or "°C"),
        attrs.get("temperature"),
    )
    add_range("percentage", "风量", "set_percentage", 0, 100, float(attrs.get("percentage_step") or 1), "%", attrs.get("percentage"))
    if "set_value" in actions:
        add_range(
            "value",
            "目标数值",
            "set_value",
            float(attrs.get("min") if attrs.get("min") is not None else 0),
            float(attrs.get("max") if attrs.get("max") is not None else 100),
            float(attrs.get("step") or 1),
            str(attrs.get("unit_of_measurement") or ""),
            state,
        )

    select_specs = [
        ("option", "选项", "select_option", attrs.get("options") or []),
        ("hvac_mode", "空调模式", "set_hvac_mode", attrs.get("hvac_modes") or []),
        ("effect", "灯光效果", "set_effect", attrs.get("effect_list") or []),
    ]
    for capability_id, label, action, options in select_specs:
        if action in actions and options:
            capabilities.append({
                "id": capability_id,
                "label": label,
                "control_type": "select",
                "action": action,
                "options": [str(item) for item in options],
                # 普通实体状态（如灯光的 on/off）不是 select 的合法选项。
                "current_value": attrs.get(capability_id) or (state if str(state) in {str(item) for item in options} else None),
            })
    return capabilities


def _translate_control_action(
    action: str,
    data: dict[str, Any] | None,
    attributes: dict[str, Any] | None,
) -> tuple[str, dict[str, Any]]:
    payload = dict(data or {})
    attrs = attributes or {}
    value = payload.pop("value", None)
    if action == "set_brightness":
        brightness = _bounded_number(payload.pop("brightness_pct", value), "亮度", 0, 100)
        return "turn_on", {**payload, "brightness_pct": round(brightness)}
    if action == "set_color_temperature":
        minimum = float(attrs.get("min_color_temp_kelvin") or 2000)
        maximum = float(attrs.get("max_color_temp_kelvin") or 6500)
        color_temp = _bounded_number(payload.pop("color_temp_kelvin", value), "色温", minimum, maximum)
        return "turn_on", {**payload, "color_temp_kelvin": round(color_temp)}
    if action == "set_position":
        position = _bounded_number(payload.pop("position", value), "开合位置", 0, 100)
        return "set_cover_position", {**payload, "position": round(position)}
    if action == "set_temperature":
        minimum = float(attrs.get("min_temp") or 16)
        maximum = float(attrs.get("max_temp") or 30)
        temperature = _bounded_number(payload.pop("temperature", value), "目标温度", minimum, maximum)
        return "set_temperature", {**payload, "temperature": temperature}
    if action == "set_percentage":
        percentage = _bounded_number(payload.pop("percentage", value), "风量", 0, 100)
        return "set_percentage", {**payload, "percentage": round(percentage)}
    if action == "set_value":
        number = _safe_number(payload.pop("value", value), "目标数值")
        return "set_value", {**payload, "value": number}

    option_keys = {
        "select_option": ("option", attrs.get("options") or []),
        "set_hvac_mode": ("hvac_mode", attrs.get("hvac_modes") or []),
        "set_effect": ("effect", attrs.get("effect_list") or []),
    }
    if action in option_keys:
        key, options = option_keys[action]
        selected = str(payload.pop(key, value) or "").strip()
        if not selected:
            raise ValueError("请选择目标选项")
        if options and selected not in {str(item) for item in options}:
            raise ValueError(f"不支持选项 {selected}，可选值：{', '.join(str(item) for item in options)}")
        # Home Assistant 灯光效果是 light.turn_on 的 effect 参数，不存在 light.set_effect 服务。
        service = "turn_on" if action == "set_effect" else action
        return service, {**payload, key: selected}
    return action, payload


def _ensure_visible_light_turn_on(
    domain: str,
    action: str,
    data: dict[str, Any],
    current_state: dict[str, Any],
) -> dict[str, Any]:
    """普通开灯不能沿用几乎不可见的历史亮度。"""
    if domain != "light" or action != "turn_on":
        return data
    if any(key in data for key in ("brightness", "brightness_pct")):
        return data
    raw_brightness = (current_state.get("attributes") or {}).get("brightness")
    try:
        brightness = float(raw_brightness)
    except (TypeError, ValueError):
        return data
    if brightness > MIN_VISIBLE_LIGHT_BRIGHTNESS:
        return data
    return {**data, "brightness_pct": 100}


def _numbers_close(actual: Any, expected: Any, tolerance: float) -> bool:
    try:
        return abs(float(actual) - float(expected)) <= tolerance
    except (TypeError, ValueError):
        return False


def _control_result_confirmed(
    action: str,
    requested_data: dict[str, Any] | None,
    previous_state: dict[str, Any],
    current_state: dict[str, Any],
) -> bool:
    """判断 HA 回读是否已经确认目标动作。"""
    state = str(current_state.get("state") or "unknown")
    previous = str(previous_state.get("state") or "unknown")
    attrs = current_state.get("attributes", {}) or {}
    data = requested_data or {}
    if state in {"unavailable", "unknown"}:
        return False
    if action == "turn_on":
        if state != "on":
            return False
        expected_brightness = data.get("brightness_pct")
        if expected_brightness is None:
            return True
        actual_brightness = attrs.get("brightness")
        if actual_brightness is None:
            return False
        return _numbers_close(float(actual_brightness) * 100 / 255, expected_brightness, 2)
    if action == "turn_off":
        return state == "off"
    if action == "toggle":
        return previous in {"on", "off"} and state in {"on", "off"} and state != previous
    if action == "set_brightness":
        expected = data.get("brightness_pct", data.get("value"))
        actual = attrs.get("brightness")
        if expected is None or actual is None:
            return False
        return _numbers_close(float(actual) * 100 / 255, expected, 2)
    if action == "set_color_temperature":
        expected = data.get("color_temp_kelvin", data.get("value"))
        return _numbers_close(attrs.get("color_temp_kelvin"), expected, 60)
    if action == "set_effect":
        return str(attrs.get("effect") or "") == str(data.get("effect", data.get("value")) or "")
    if action == "set_position":
        return _numbers_close(attrs.get("current_position"), data.get("position", data.get("value")), 2)
    if action == "set_temperature":
        return _numbers_close(attrs.get("temperature"), data.get("temperature", data.get("value")), 0.5)
    if action == "set_hvac_mode":
        expected = str(data.get("hvac_mode", data.get("value")) or "")
        return state == expected or str(attrs.get("hvac_mode") or "") == expected
    if action == "set_percentage":
        return _numbers_close(attrs.get("percentage"), data.get("percentage", data.get("value")), 2)
    if action == "set_value":
        return _numbers_close(state, data.get("value"), 0.001)
    if action == "select_option":
        return state == str(data.get("option", data.get("value")) or "")
    return True


def _control_confirmation(
    mapping: DeviceEntityMapping | None,
    *,
    is_scene_action: bool,
    attributes: dict[str, Any] | None = None,
) -> str:
    """区分 HA 接受命令与可视作普通状态回读确认的控制。"""
    if is_scene_action:
        return "accepted"
    metadata = _merge_entity_metadata(
        mapping.mapping_metadata if mapping else {},
        attributes,
    )
    platform = str(
        metadata.get("platform")
        or metadata.get("integration")
        or metadata.get("integration_platform")
        or ""
    ).lower()
    # Xiaomi Home 在 set_property 返回后会立即更新 HA 内存状态，不能据此证明物理设备已动作。
    if platform in {"xiaomi_home", "xiaomi_miot", "xiaomi"}:
        return "physical_pending"
    return "confirmed"


def _state_from_service_response(response: Any, entity_id: str) -> dict[str, Any] | None:
    """Home Assistant 服务响应若携带目标实体状态，直接复用，避免重复网络回读。"""
    candidates = response if isinstance(response, list) else [response]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        state = candidate.get("new_state") if isinstance(candidate.get("new_state"), dict) else candidate
        if state.get("entity_id") == entity_id:
            return state
    return None


def _confirmed_state_from_service_response(
    response: Any,
    entity_id: str,
    action: str,
    requested_data: dict[str, Any] | None,
    previous_state: dict[str, Any],
) -> dict[str, Any] | None:
    """复用 HA 服务调用携带的目标状态，避免已确认后继续轮询。"""
    state = _state_from_service_response(response, entity_id)
    if state and _control_result_confirmed(action, requested_data, previous_state, state):
        return state
    return None


async def _wait_for_control_confirmation(
    service: HomeAssistantService,
    entity_id: str,
    action: str,
    requested_data: dict[str, Any] | None,
    previous_state: dict[str, Any],
    *,
    settle_attempts: int = 0,
) -> dict[str, Any]:
    """轮询 HA；需要稳定观察时，目标状态回滚应直接视为失败。"""
    latest: dict[str, Any] = previous_state
    for attempt in range(CONTROL_CONFIRM_ATTEMPTS):
        if attempt:
            await asyncio.sleep(CONTROL_CONFIRM_INTERVAL_SECONDS)
        latest = await service.get_state(entity_id)
        if _control_result_confirmed(action, requested_data, previous_state, latest):
            for _ in range(settle_attempts):
                await asyncio.sleep(CONTROL_CONFIRM_INTERVAL_SECONDS)
                latest = await service.get_state(entity_id)
                if not _control_result_confirmed(action, requested_data, previous_state, latest):
                    raise ControlStateRollbackError(
                        f"HA 曾短暂显示控制目标已生效，但随后回滚为 {latest.get('state') or 'unknown'}；"
                        "小米设备可能未实际执行，请检查米家 App、墙壁供电和蓝牙 Mesh 网关"
                    )
            return latest
    raise TimeoutError(
        f"HA 已接收控制请求，但 {CONTROL_CONFIRM_ATTEMPTS * CONTROL_CONFIRM_INTERVAL_SECONDS:g} 秒内未确认目标状态"
    )


def _category_for_entity(entity_id: str) -> str:
    domain = _get_domain(entity_id)
    if domain in {"input_boolean", "switch"}:
        return "switch"
    if domain in {"input_number", "number"}:
        return "number"
    if domain in {"input_select", "select"}:
        return "select"
    return domain or "device"


def _role_for_entity(entity_id: str, unit: str = "") -> str:
    domain = _get_domain(entity_id)
    lowered_unit = (unit or "").lower()
    if domain == "sensor":
        if "°" in unit or lowered_unit in {"c", "°c", "f", "°f"}:
            return "temperature"
        if "%" in unit:
            return "humidity"
        return "value"
    if domain == "binary_sensor":
        return "status"
    if domain in {"input_number", "number"}:
        return "value"
    if domain in {"input_select", "select"}:
        return "mode"
    if domain == "lock":
        return "lock"
    if domain == "cover":
        return "position"
    return "power"


def _unique_mapping_role(base_role: str, domain: str, used_roles: set[str]) -> str:
    if base_role not in used_roles:
        return base_role
    candidate = f"{base_role}_{domain}"
    suffix = 2
    while candidate in used_roles:
        candidate = f"{base_role}_{domain}_{suffix}"
        suffix += 1
    return candidate


def _mask_secret(value: str) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    if len(text) <= 8:
        return f"{text[:2]}***{text[-2:]}"
    return f"{text[:4]}***{text[-4:]}"


def _is_masked_secret(value: str | None) -> bool:
    text = (value or "").strip()
    return not text or "*" in text or "•" in text


def _gateway_to_dict(gateway: DeviceGateway, *, include_private: bool = True) -> dict[str, Any]:
    system_managed = gateway.name == "Home Assistant 默认网关" and gateway.gateway_type == "homeassistant"
    return {
        "id": gateway.id,
        "name": gateway.name,
        "gateway_type": gateway.gateway_type,
        "base_url": gateway.base_url if include_private else "",
        "port": gateway.port if include_private else None,
        "auth_type": gateway.auth_type if include_private else "",
        "enabled": gateway.enabled,
        "status": gateway.status,
        "description": gateway.description,
        "system_managed": system_managed,
        "has_credential": bool((gateway.credential or "").strip()),
        "credential_masked": _mask_secret(gateway.credential) if include_private else "",
        "last_test_at": gateway.last_test_at,
        "created_at": gateway.created_at,
        "updated_at": gateway.updated_at,
    }


def _entity_state(mapping: DeviceEntityMapping, ha_map: dict[str, dict[str, Any]]) -> dict[str, Any]:
    raw = ha_map.get(mapping.endpoint)
    platform = str((mapping.mapping_metadata or {}).get("platform") or "").lower()
    physical_confirmation = "physical_pending" if platform in {"xiaomi_home", "xiaomi_miot", "xiaomi"} else "state_only"
    if not raw:
        actions = _effective_mapping_actions(mapping)
        return {
            "entity_id": mapping.endpoint,
            "state": "unavailable",
            "unit": mapping.unit,
            "attributes": {},
            "last_changed": None,
            "mapping_id": mapping.id,
            "access_mode": mapping.access_mode,
            "gateway_type": mapping.gateway_type,
            "physical_confirmation": physical_confirmation,
            "control_actions": actions,
            "capabilities": _build_entity_capabilities(
                mapping.endpoint,
                mapping.mapping_metadata or {},
                actions,
            ),
        }
    attrs = raw.get("attributes", {})
    actions = _effective_mapping_actions(mapping, attrs)
    return {
        "entity_id": mapping.endpoint,
        "state": raw.get("state", "unknown"),
        "unit": mapping.unit or attrs.get("unit_of_measurement", ""),
        "attributes": attrs,
        "last_changed": raw.get("last_changed"),
        "mapping_id": mapping.id,
        "access_mode": mapping.access_mode,
        "gateway_type": mapping.gateway_type,
        "physical_confirmation": physical_confirmation,
        "control_actions": actions,
        "capabilities": _build_entity_capabilities(
            mapping.endpoint,
            _merge_entity_metadata(mapping.mapping_metadata, attrs),
            actions,
            raw.get("state"),
        ),
    }


def _device_to_dict(device: ManagedDevice, ha_map: dict[str, dict[str, Any]]) -> dict[str, Any]:
    entities: dict[str, dict[str, Any]] = {}
    entity_states: list[str] = []
    for mapping in device.mappings:
        state = _entity_state(mapping, ha_map) if mapping.gateway_type == "homeassistant" else {
            "entity_id": mapping.endpoint,
            "state": "pending",
            "unit": mapping.unit,
            "attributes": {"note": "该网关类型已配置，需现场适配器联调后回读状态。"},
            "last_changed": None,
            "mapping_id": mapping.id,
            "access_mode": mapping.access_mode,
            "gateway_type": mapping.gateway_type,
            "control_actions": mapping.control_actions or [],
        }
        entities[mapping.role] = state
        entity_states.append(state["state"])
    if not device.enabled:
        status = "disabled"
    elif not device.mappings:
        status = "unmapped"
    elif any(state not in {"unavailable", "unknown", "pending"} for state in entity_states):
        status = "online"
    else:
        status = "offline"
    return {
        "id": str(device.id),
        "record_id": device.id,
        "name": device.name,
        "description": device.description,
        "category": device.category,
        "brand": device.brand,
        "model": device.model,
        "location": device.location,
        "protocol": device.protocol,
        "gateway_id": device.gateway_id,
        "gateway_name": device.gateway.name if device.gateway else "",
        "gateway_type": device.gateway.gateway_type if device.gateway else "",
        "status": status,
        "enabled": device.enabled,
        "local_control": device.local_control,
        "source": device.source,
        "capability_tags": device.capability_tags or [],
        "entities": entities,
        "mappings": [
            {
                "id": mapping.id,
                "role": mapping.role,
                "endpoint": mapping.endpoint,
                "gateway_type": mapping.gateway_type,
                "access_mode": mapping.access_mode,
                "unit": mapping.unit,
                "value_path": mapping.value_path,
                "control_actions": _effective_mapping_actions(
                    mapping,
                    (ha_map.get(mapping.endpoint) or {}).get("attributes", {}),
                ),
                "metadata": mapping.mapping_metadata or {},
            }
            for mapping in device.mappings
        ],
        "created_at": device.created_at,
        "updated_at": device.updated_at,
    }


async def _get_ha_service(db: AsyncSession, gateway: DeviceGateway | None = None) -> HomeAssistantService:
    runtime = await get_runtime_config(db)
    if not gateway or gateway.name == "Home Assistant 默认网关":
        return HomeAssistantService(base_url=runtime.ha_base_url, token=runtime.ha_token)
    return HomeAssistantService(
        base_url=(gateway.base_url or runtime.ha_base_url),
        token=(gateway.credential or runtime.ha_token),
    )


async def _get_ha_map(
    db: AsyncSession,
    gateway: DeviceGateway | None = None,
    *,
    timeout_seconds: float | None = None,
) -> tuple[dict[str, dict[str, Any]], str]:
    service = await _get_ha_service(db, gateway)
    try:
        if timeout_seconds is None:
            raw_states = await service.get_states()
        else:
            raw_states = await asyncio.wait_for(service.get_states(), timeout=timeout_seconds)
        return {item["entity_id"]: item for item in raw_states}, ""
    except asyncio.TimeoutError:
        return {}, _ha_read_failure_message(gateway, "连接超时")
    except Exception as exc:
        return {}, _ha_read_failure_message(gateway, exc)


async def _get_ha_discovery(
    db: AsyncSession,
    gateway: DeviceGateway | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, dict[str, Any]]], str]:
    service = await _get_ha_service(db, gateway)
    try:
        raw_states = await service.get_states()
        states = {item["entity_id"]: item for item in raw_states if item.get("entity_id")}
        registries = await service.get_registries()
        return states, {
            "entities": {item.get("entity_id", ""): item for item in registries.get("entities", []) if item.get("entity_id")},
            "devices": {item.get("id", ""): item for item in registries.get("devices", []) if item.get("id")},
            "areas": {item.get("area_id", ""): item for item in registries.get("areas", []) if item.get("area_id")},
        }, ""
    except Exception as exc:
        return (
            {},
            {"entities": {}, "devices": {}, "areas": {}},
            _ha_read_failure_message(gateway, exc, discovery=True),
        )


def _build_sync_candidates(
    ha_map: dict[str, dict[str, Any]],
    registries: dict[str, dict[str, dict[str, Any]]],
    mapped: set[str],
) -> list[dict[str, Any]]:
    candidates = []
    for entity_id, raw in sorted(ha_map.items()):
        attrs = raw.get("attributes", {})
        metadata = _registry_candidate_metadata(
            entity_id,
            raw,
            registries.get("entities", {}),
            registries.get("devices", {}),
            registries.get("areas", {}),
        )
        candidates.append({
            "entity_id": entity_id,
            "domain": _get_domain(entity_id),
            "name": _normalize_display_name(attrs.get("friendly_name"), entity_id),
            "state": raw.get("state"),
            "unit": attrs.get("unit_of_measurement", ""),
            "last_changed": raw.get("last_changed"),
            "last_updated": raw.get("last_updated"),
            "mapped": entity_id in mapped,
            **metadata,
            "control_actions": _control_actions_for_entity(
                entity_id,
                attrs,
                _category_for_entity(entity_id),
            ),
            "capability_metadata": _capability_metadata(attrs),
        })
    candidates_by_device: dict[str, list[dict[str, Any]]] = {}
    for candidate in candidates:
        if candidate["ha_device_id"]:
            candidates_by_device.setdefault(candidate["ha_device_id"], []).append(candidate)

    # 有主控实体（light/climate 等）时，不把同一设备的延时、配置开关默认勾选。
    for device_candidates in candidates_by_device.values():
        if any(item["domain"] in PRIMARY_HARDWARE_DOMAINS for item in device_candidates):
            for item in device_candidates:
                if item["domain"] not in PRIMARY_HARDWARE_DOMAINS and item["device_class"] not in MEASUREMENT_DEVICE_CLASSES:
                    item["recommended"] = False
    return candidates


async def _load_ha_workspace_snapshot(service: HomeAssistantService) -> dict[str, Any]:
    """读取 HA 状态与注册表；注册表失败时仍保留可用的状态清单。"""
    started = time.perf_counter()
    states_result, registries_result = await asyncio.gather(
        asyncio.wait_for(service.get_states(), timeout=HA_WORKSPACE_READ_TIMEOUT_SECONDS),
        asyncio.wait_for(service.get_registries(), timeout=HA_WORKSPACE_READ_TIMEOUT_SECONDS),
        return_exceptions=True,
    )
    discovery_error = f"Home Assistant {_normalize_ha_failure_reason(states_result)}" if isinstance(states_result, BaseException) else ""
    registry_error = f"Home Assistant {_normalize_ha_failure_reason(registries_result)}" if isinstance(registries_result, BaseException) else ""
    raw_states = states_result if isinstance(states_result, list) else []
    raw_registries = registries_result if isinstance(registries_result, dict) else {}
    if not discovery_error and not isinstance(states_result, list):
        discovery_error = "Home Assistant 状态接口返回格式异常"
    if not registry_error and not isinstance(registries_result, dict):
        registry_error = "Home Assistant 注册表返回格式异常"
    registries = {
        "entities": {
            item.get("entity_id", ""): item
            for item in raw_registries.get("entities", [])
            if item.get("entity_id")
        },
        "devices": {
            item.get("id", ""): item
            for item in raw_registries.get("devices", [])
            if item.get("id")
        },
        "areas": {
            item.get("area_id", ""): item
            for item in raw_registries.get("areas", [])
            if item.get("area_id")
        },
    }
    return {
        "states": {
            item.get("entity_id", ""): item
            for item in raw_states
            if item.get("entity_id")
        },
        "registries": registries,
        "discovery_error": discovery_error,
        "registry_error": registry_error,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": int((time.perf_counter() - started) * 1000),
    }


async def _get_cached_ha_workspace_snapshot(
    cache_key: str,
    service: HomeAssistantService,
    *,
    refresh: bool = False,
) -> dict[str, Any]:
    """短时缓存完整发现快照，并合并同一 HA 配置的并发读取。"""
    now = time.monotonic()
    cached = _ha_workspace_snapshot_cache.get(cache_key)
    if not refresh and cached and now - cached[0] < HA_WORKSPACE_CACHE_TTL_SECONDS:
        return {**cached[1], "cache_hit": True}

    task = _ha_workspace_snapshot_pending.get(cache_key)
    shared = bool(task)
    if not task:
        task = asyncio.create_task(_load_ha_workspace_snapshot(service))
        _ha_workspace_snapshot_pending[cache_key] = task
    try:
        snapshot = await asyncio.shield(task)
        _ha_workspace_snapshot_cache[cache_key] = (time.monotonic(), snapshot)
        return {**snapshot, "cache_hit": shared}
    finally:
        if task.done() and _ha_workspace_snapshot_pending.get(cache_key) is task:
            _ha_workspace_snapshot_pending.pop(cache_key, None)


def _ha_workspace_cache_key(gateway: DeviceGateway, service: HomeAssistantService) -> str:
    credential_fingerprint = hashlib.sha256(service.token.encode("utf-8")).hexdigest()[:12]
    return f"{gateway.id}:{service.base_url}:{credential_fingerprint}"


def _area_alias_conflict(area_name: str, aliases: list[str]) -> str:
    known_areas = ("客厅", "卧室", "书房", "厨房", "餐厅", "阳台", "卫生间", "玄关")
    current = next((area for area in known_areas if area in area_name), "")
    if not current:
        return ""
    return next(
        (
            alias
            for alias in aliases
            if any(area != current and area in alias for area in known_areas)
        ),
        "",
    )


def _build_home_assistant_workspace(
    snapshot: dict[str, Any],
    mapping_records: list[dict[str, Any]],
    gateway: dict[str, Any],
    *,
    page: int = 1,
    size: int = 20,
    diagnostic_page: int = 1,
    diagnostic_size: int = 10,
    keyword: str = "",
    classification: str = "",
    domain: str = "",
    mapped: bool | None = None,
    status: str = "",
) -> dict[str, Any]:
    """基于完整快照计算统计，再分别对实体和诊断清单分页。"""
    mapping_by_endpoint = {item["endpoint"]: item for item in mapping_records}
    candidates = _build_sync_candidates(
        snapshot.get("states", {}),
        snapshot.get("registries", {"entities": {}, "devices": {}, "areas": {}}),
        set(mapping_by_endpoint),
    )
    for candidate in candidates:
        mapping = mapping_by_endpoint.get(candidate["entity_id"], {})
        candidate.update({
            "platform_device_id": mapping.get("device_id"),
            "platform_device_name": mapping.get("device_name", ""),
            "mapping_role": mapping.get("role", ""),
            "mapping_access_mode": mapping.get("access_mode", ""),
            "mapping_aliases": mapping.get("aliases", []),
            "physical_confirmation": (
                "physical_pending"
                if candidate.get("platform") == "xiaomi_home" and candidate.get("mapped")
                else "state_only"
            ),
        })

    candidate_endpoints = {item["entity_id"] for item in candidates}
    orphan_mappings = [
        item for item in mapping_records
        if item["endpoint"] not in candidate_endpoints
    ]
    unavailable_states = {"unavailable", "unknown"}
    diagnostics: list[dict[str, Any]] = []
    if snapshot.get("discovery_error"):
        diagnostics.append({
            "id": "ha-unavailable",
            "severity": "error",
            "title": "Home Assistant 实体读取失败",
            "message": snapshot["discovery_error"],
            "action_href": "/settings",
            "action_label": "检查系统设置",
        })
    if snapshot.get("registry_error"):
        diagnostics.append({
            "id": "registry-unavailable",
            "severity": "warning",
            "title": "设备注册表读取不完整",
            "message": f"实体状态仍可查看，但设备归属、区域和硬件分类可能不完整：{snapshot['registry_error']}",
            "action_href": "/settings",
            "action_label": "检查 HA 凭证",
        })
    unavailable_count = sum(1 for item in candidates if item.get("state") in unavailable_states)
    hardware_unavailable_count = sum(
        1 for item in candidates
        if item.get("classification") == "hardware" and item.get("state") in unavailable_states
    )
    hardware_unavailable_device_count = len({
        item.get("ha_device_id") for item in candidates
        if item.get("classification") == "hardware"
        and item.get("state") in unavailable_states
        and item.get("ha_device_id")
    })
    other_unavailable_count = unavailable_count - hardware_unavailable_count
    if unavailable_count:
        if hardware_unavailable_count:
            title = f"{hardware_unavailable_count} 个设备关联实体当前不可用"
            if other_unavailable_count:
                title += f"，另有 {other_unavailable_count} 个辅助或系统实体不可用"
            message = "设备关联实体的不可用或未知状态不会作为真实在线证据；请到设备台账核对已映射设备。"
            action_href = "/devices"
            action_label = "查看设备台账"
        else:
            title = f"{other_unavailable_count} 个辅助或系统实体当前不可用"
            message = "这些记录不代表同等数量的现场硬件故障；不可用或未知状态不会作为真实在线证据。"
            action_href = ""
            action_label = ""
        diagnostics.append({
            "id": "unavailable-entities",
            "severity": "warning",
            "title": title,
            "message": message,
            "action_href": action_href,
            "action_label": action_label,
        })
    if orphan_mappings:
        orphan_entity_ids = [item["endpoint"] for item in orphan_mappings[:20]]
        diagnostics.append({
            "id": "orphan-mappings",
            "severity": "error",
            "title": f"{len(orphan_mappings)} 条平台映射已失联",
            "message": "对应实体已不在当前 HA 状态清单中，请在设备台账核对或重新映射。",
            "affected_count": len(orphan_mappings),
            "entity_ids": orphan_entity_ids,
            "entity_ids_truncated": len(orphan_entity_ids) < len(orphan_mappings),
            "action_href": "/devices",
            "action_label": "修复映射",
        })
    xiaomi_items = [
        item for item in candidates
        if item.get("platform") == "xiaomi_home" and item.get("mapped")
    ]
    if xiaomi_items:
        xiaomi_entity_ids = [item["entity_id"] for item in xiaomi_items[:20]]
        diagnostics.append({
            "id": "xiaomi-physical-confirmation",
            "severity": "warning",
            "title": "小米设备状态需要现场确认",
            "message": "Xiaomi Home 接受命令后可能立即回写 HA 内存状态；on/off 只代表平台回读，不能证明实体灯、开关或其他硬件已经动作。",
            "affected_count": len(xiaomi_items),
            "entity_ids": xiaomi_entity_ids,
            "entity_ids_truncated": len(xiaomi_entity_ids) < len(xiaomi_items),
            "action_href": "/devices",
            "action_label": "查看控制记录",
        })
    for item in candidates:
        conflict_alias = _area_alias_conflict(item.get("area_name", ""), item.get("mapping_aliases", []))
        if not conflict_alias:
            continue
        diagnostics.append({
            "id": f"area-alias-conflict:{item['entity_id']}",
            "severity": "warning",
            "title": "设备别名与 HA 区域不一致",
            "message": f"{item.get('name') or item['entity_id']} 属于“{item.get('area_name')}”，但平台别名包含“{conflict_alias}”，可能控制到错误的现场设备。",
            "affected_count": 1,
            "entity_ids": [item["entity_id"]],
            "entity_ids_truncated": False,
            "action_href": "/devices",
            "action_label": "调整设备映射",
        })

    domain_counts: dict[str, int] = {}
    for item in candidates:
        item_domain = str(item.get("domain") or "unknown")
        domain_counts[item_domain] = domain_counts.get(item_domain, 0) + 1
    summary = {
        "total_entities": len(candidates),
        "hardware_entities": sum(1 for item in candidates if item.get("classification") == "hardware"),
        "helper_entities": sum(1 for item in candidates if item.get("classification") == "helper"),
        "system_entities": sum(1 for item in candidates if item.get("classification") == "system"),
        "unregistered_entities": sum(1 for item in candidates if item.get("classification") == "unregistered"),
        "recommended_entities": sum(1 for item in candidates if item.get("recommended") and not item.get("mapped")),
        "mapped_entities": sum(1 for item in candidates if item.get("mapped")),
        "mapped_devices": len({item.get("device_id") for item in mapping_records if item.get("device_id")}),
        "unavailable_entities": unavailable_count,
        "hardware_unavailable_entities": hardware_unavailable_count,
        "hardware_unavailable_devices": hardware_unavailable_device_count,
        "other_unavailable_entities": other_unavailable_count,
        "ha_devices": len({item.get("ha_device_id") for item in candidates if item.get("ha_device_id")}),
        "areas": len({item.get("area_id") for item in candidates if item.get("area_id")}),
        "scenes": domain_counts.get("scene", 0),
        "orphan_mappings": len(orphan_mappings),
        "xiaomi_mapped_entities": len(xiaomi_items),
    }

    normalized_keyword = keyword.strip().casefold()
    filtered = candidates
    if normalized_keyword:
        filtered = [
            item for item in filtered
            if normalized_keyword in " ".join(str(value) for value in [
                item.get("name"), item.get("entity_id"), item.get("device_name"),
                item.get("area_name"), item.get("manufacturer"), item.get("model"),
                item.get("platform_device_name"), *(item.get("mapping_aliases") or []),
            ]).casefold()
        ]
    if classification:
        filtered = [item for item in filtered if item.get("classification") == classification]
    if domain:
        filtered = [item for item in filtered if item.get("domain") == domain]
    if mapped is not None:
        filtered = [item for item in filtered if bool(item.get("mapped")) is mapped]
    if status == "available":
        filtered = [item for item in filtered if item.get("state") not in unavailable_states]
    elif status == "unavailable":
        filtered = [item for item in filtered if item.get("state") in unavailable_states]
    elif status:
        filtered = [item for item in filtered if item.get("state") == status]

    filtered.sort(key=lambda item: (
        item.get("classification") != "hardware",
        not item.get("recommended"),
        not item.get("mapped"),
        str(item.get("area_name") or ""),
        str(item.get("name") or item.get("entity_id") or ""),
    ))
    total = len(filtered)
    page_count = max(1, (total + size - 1) // size)
    safe_page = min(max(1, page), page_count)
    start = (safe_page - 1) * size
    diagnostics_total = len(diagnostics)
    diagnostics_pages = max(1, (diagnostics_total + diagnostic_size - 1) // diagnostic_size)
    safe_diagnostic_page = min(max(1, diagnostic_page), diagnostics_pages)
    diagnostics_start = (safe_diagnostic_page - 1) * diagnostic_size
    orphan_total = len(orphan_mappings)
    orphan_pages = max(1, (orphan_total + size - 1) // size)
    orphan_page = min(max(1, page), orphan_pages)
    orphan_start = (orphan_page - 1) * size
    orphan_items = [
        {
            "mapping_id": item.get("mapping_id"),
            "platform_device_id": item.get("device_id"),
            "platform_device_name": item.get("device_name") or "未命名平台设备",
            "mapping_role": item.get("role") or "",
            "entity_id": item.get("endpoint") or "",
            "mapping_access_mode": item.get("access_mode") or "",
        }
        for item in orphan_mappings[orphan_start:orphan_start + size]
    ]
    return {
        "status": "error" if snapshot.get("discovery_error") else "running",
        "gateway": gateway,
        "summary": summary,
        "items": filtered[start:start + size],
        "page": safe_page,
        "size": size,
        "total": total,
        "pages": page_count,
        "domains": domain_counts,
        "diagnostics": diagnostics[diagnostics_start:diagnostics_start + diagnostic_size],
        "diagnostics_total": diagnostics_total,
        "diagnostics_page": safe_diagnostic_page,
        "diagnostics_size": diagnostic_size,
        "diagnostics_pages": diagnostics_pages,
        "orphan_items": orphan_items,
        "orphan_total": orphan_total,
        "orphan_page": orphan_page,
        "orphan_pages": orphan_pages,
        "generated_at": snapshot.get("generated_at"),
        "duration_ms": snapshot.get("duration_ms", 0),
        "cache_hit": bool(snapshot.get("cache_hit")),
        "cache_ttl_seconds": HA_WORKSPACE_CACHE_TTL_SECONDS,
        "data_sources": ["Home Assistant REST 状态", "Home Assistant Registry", "平台设备映射台账"],
    }


async def _get_ha_maps_for_devices(
    db: AsyncSession,
    devices: list[ManagedDevice],
) -> tuple[dict[int, dict[str, dict[str, Any]]], str, dict[int, str]]:
    maps: dict[int, dict[str, dict[str, Any]]] = {}
    errors: list[str] = []
    gateway_errors: dict[int, str] = {}
    gateways: dict[int, DeviceGateway | None] = {}
    for device in devices:
        if any(mapping.gateway_type == "homeassistant" for mapping in device.mappings):
            gateways[device.gateway_id or 0] = device.gateway
    for gateway_id, gateway in gateways.items():
        ha_map, ha_error = await _get_ha_map(
            db,
            gateway,
            timeout_seconds=DEVICE_LIST_HA_READ_TIMEOUT_SECONDS,
        )
        maps[gateway_id] = ha_map
        if ha_error:
            errors.append(ha_error)
            gateway_errors[gateway_id] = ha_error
    return maps, "；".join(dict.fromkeys(errors)), gateway_errors


def _ha_map_for_device(
    device: ManagedDevice,
    ha_maps: dict[int, dict[str, dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    return ha_maps.get(device.gateway_id or 0, {})


def _invalidate_device_list_snapshot() -> None:
    """写操作后清理设备状态快照，下一次读取重新聚合数据库与 HA。"""
    global _device_list_snapshot_cache, _device_list_snapshot_pending, _device_list_snapshot_version
    _device_list_snapshot_cache = None
    _device_list_snapshot_pending = None
    _device_list_snapshot_version += 1


async def _load_device_list_snapshot(db: AsyncSession) -> dict[str, Any]:
    default_gateway = await _ensure_default_gateway(db)
    result = await db.execute(
        select(ManagedDevice)
        .options(selectinload(ManagedDevice.gateway), selectinload(ManagedDevice.mappings))
        .order_by(ManagedDevice.id)
    )
    records = result.scalars().unique().all()
    ha_maps, ha_error, gateway_errors = await _get_ha_maps_for_devices(db, records)
    default_gateway_key = default_gateway.id or 0
    if default_gateway_key in ha_maps:
        scene_map = ha_maps[default_gateway_key]
        scene_error = gateway_errors.get(default_gateway_key, "")
    else:
        scene_map, scene_error = await _get_ha_map(
            db,
            default_gateway,
            timeout_seconds=DEVICE_LIST_HA_READ_TIMEOUT_SECONDS,
        )
    devices = [_device_to_dict(item, _ha_map_for_device(item, ha_maps)) for item in records]
    scenes = _resolve_scenes(scene_map)
    categories: dict[str, int] = {}
    for item in devices:
        categories[item["category"]] = categories.get(item["category"], 0) + 1
    return {
        "devices": devices,
        "scenes": scenes,
        "summary": {
            "total": len(devices),
            "online": sum(1 for item in devices if item["status"] == "online"),
            "offline": sum(1 for item in devices if item["status"] == "offline"),
            "unmapped": sum(1 for item in devices if item["status"] == "unmapped"),
            "disabled": sum(1 for item in devices if item["status"] == "disabled"),
            "seed": sum(1 for item in devices if item.get("source") == "seed"),
            "scene_count": None if scene_error else len(scenes),
            "categories": categories,
        },
        "ha_error": _aggregate_ha_snapshot_errors(ha_error, scene_error),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


async def _get_device_list_snapshot(
    db: AsyncSession,
    *,
    refresh: bool = False,
) -> tuple[dict[str, Any], str]:
    global _device_list_snapshot_cache, _device_list_snapshot_pending
    now = time.monotonic()
    if (
        not refresh
        and _device_list_snapshot_cache
        and now - _device_list_snapshot_cache[0] < DEVICE_LIST_CACHE_TTL_SECONDS
    ):
        return _device_list_snapshot_cache[1], "hit"
    snapshot_version = _device_list_snapshot_version
    task = _device_list_snapshot_pending if not refresh else None
    shared = bool(task)
    if not task:
        task = asyncio.create_task(_load_device_list_snapshot(db))
        _device_list_snapshot_pending = task
    try:
        snapshot = await asyncio.shield(task)
        if snapshot_version == _device_list_snapshot_version:
            _device_list_snapshot_cache = (time.monotonic(), snapshot)
        return snapshot, "shared" if shared else "miss"
    finally:
        if task.done() and _device_list_snapshot_pending is task:
            _device_list_snapshot_pending = None


def _filter_device_snapshot(
    devices: list[dict[str, Any]],
    *,
    keyword: str = "",
    category: str = "",
    status: str = "",
    gateway_id: int | None = None,
    sort: str = "name",
) -> list[dict[str, Any]]:
    normalized_keyword = _normalize_device_search_text(keyword)
    filtered = []
    for device in devices:
        if category and device.get("category") != category:
            continue
        if status and device.get("status") != status:
            continue
        if gateway_id and device.get("gateway_id") != gateway_id:
            continue
        if normalized_keyword:
            values: list[Any] = [
                device.get("name"), device.get("description"), device.get("category"),
                device.get("brand"), device.get("model"), device.get("location"),
                device.get("gateway_name"),
            ]
            for mapping in device.get("mappings") or []:
                values.extend([
                    mapping.get("endpoint"),
                    *((mapping.get("metadata") or {}).get("aliases") or []),
                ])
            haystack = _normalize_device_search_text(" ".join(str(value or "") for value in values))
            if normalized_keyword not in haystack:
                continue
        filtered.append(device)

    if sort == "status":
        status_order = {"online": 0, "offline": 1, "unmapped": 2, "disabled": 3}
        filtered.sort(key=lambda item: (status_order.get(str(item.get("status")), 9), str(item.get("name") or "")))
    elif sort == "category":
        filtered.sort(key=lambda item: (str(item.get("category") or ""), str(item.get("name") or "")))
    else:
        filtered.sort(key=lambda item: str(item.get("name") or "").casefold())
    return filtered


async def _ensure_default_gateway(db: AsyncSession) -> DeviceGateway:
    runtime = await get_runtime_config(db)
    result = await db.execute(select(DeviceGateway).where(DeviceGateway.gateway_type == "homeassistant").order_by(DeviceGateway.id))
    gateway = result.scalars().first()
    if not gateway:
        gateway = DeviceGateway(
            name="Home Assistant 默认网关",
            gateway_type="homeassistant",
            base_url=runtime.ha_base_url,
            auth_type="bearer",
            credential="",
            status="unknown",
            enabled=True,
            description="默认 HA 接入网关。Token 优先使用系统设置，不在响应中回传明文。",
        )
        db.add(gateway)
        await db.flush()
    elif gateway.name == "Home Assistant 默认网关":
        # 系统默认网关只是运行时配置的展示记录，不能因历史地址或凭证阻断配置切换。
        gateway.base_url = runtime.ha_base_url
        gateway.credential = ""

    duplicate_gateway_result = await db.execute(
        select(DeviceGateway)
        .where(
            DeviceGateway.id != gateway.id,
            DeviceGateway.name == "Home Assistant 默认网关",
            DeviceGateway.gateway_type == "homeassistant",
            DeviceGateway.base_url == gateway.base_url,
        )
        .order_by(DeviceGateway.id)
    )
    for duplicate_gateway in duplicate_gateway_result.scalars().all():
        device_count = (
            await db.execute(
                select(func.count())
                .select_from(ManagedDevice)
                .where(ManagedDevice.gateway_id == duplicate_gateway.id)
            )
        ).scalar() or 0
        if device_count == 0:
            await db.delete(duplicate_gateway)
    return gateway


async def _get_device_or_404(db: AsyncSession, device_id: int) -> ManagedDevice:
    result = await db.execute(
        select(ManagedDevice)
        .options(selectinload(ManagedDevice.gateway), selectinload(ManagedDevice.mappings))
        .where(ManagedDevice.id == device_id)
    )
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="设备不存在")
    return device


async def _get_gateway_or_404(db: AsyncSession, gateway_id: int) -> DeviceGateway:
    gateway = await db.get(DeviceGateway, gateway_id)
    if not gateway:
        raise HTTPException(status_code=404, detail="网关不存在")
    return gateway


async def _record_control_failure(
    db: AsyncSession,
    user: dict[str, Any],
    entity_id: str,
    device_name: str,
    service: str,
    reason: str,
) -> None:
    db.add(OperationLog(
        type="device_control",
        level="error",
        title=f"控制 {device_name} 失败",
        detail=f"entity={entity_id}, service={service}, result=failed, reason={reason[:240]}",
        user_id=user.get("user_id"),
        username=user.get("username", ""),
        entity_id=entity_id,
    ))
    # 路由随后会抛出 HTTPException，需先独立提交失败审计。
    await db.commit()


def _apply_gateway_payload(gateway: DeviceGateway, payload: GatewayPayload) -> None:
    gateway.name = payload.name.strip()
    gateway.gateway_type = payload.gateway_type
    gateway.base_url = payload.base_url.strip()
    gateway.port = payload.port
    gateway.auth_type = payload.auth_type
    gateway.enabled = payload.enabled
    gateway.description = payload.description.strip()
    if not _is_masked_secret(payload.credential):
        gateway.credential = payload.credential.strip()


async def _replace_mappings(db: AsyncSession, device: ManagedDevice, mappings: list[MappingPayload]) -> None:
    await db.execute(delete(DeviceEntityMapping).where(DeviceEntityMapping.device_id == device.id))
    await db.flush()
    for mapping in mappings:
        db.add(DeviceEntityMapping(
            device_id=device.id,
            role=mapping.role.strip() or "power",
            endpoint=mapping.endpoint.strip(),
            gateway_type=mapping.gateway_type,
            access_mode=mapping.access_mode,
            unit=mapping.unit.strip(),
            value_path=mapping.value_path.strip(),
            control_actions=(mapping.control_actions or _default_actions(mapping.endpoint))
            if mapping.access_mode in {"rw", "write"}
            else [],
            mapping_metadata=mapping.metadata or {},
        ))


def _apply_device_payload(device: ManagedDevice, payload: DevicePayload) -> None:
    device.name = payload.name.strip()
    device.category = payload.category
    device.brand = payload.brand.strip()
    device.model = payload.model.strip()
    device.location = payload.location.strip()
    device.protocol = payload.protocol.strip()
    device.gateway_id = payload.gateway_id
    device.description = payload.description.strip()
    device.local_control = payload.local_control
    device.enabled = payload.enabled
    device.capability_tags = payload.capability_tags


@router.get("/health", summary="设备模块健康检查")
async def health(db: AsyncSession = Depends(get_db)):
    gateway = await _ensure_default_gateway(db)
    service = await _get_ha_service(db, gateway)
    started_at = time.perf_counter()
    ok = await service.check_health()
    return {
        "status": "ok" if ok else "error",
        "module": "devices",
        "ha_connected": ok,
        "latency_ms": int((time.perf_counter() - started_at) * 1000),
        "tested_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/home-assistant/workspace", summary="Home Assistant 接入工作台")
async def home_assistant_workspace(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=10, le=100),
    diagnostic_page: int = Query(1, ge=1),
    diagnostic_size: int = Query(10, ge=5, le=50),
    keyword: str = Query("", max_length=160),
    classification: str = Query("", pattern="^(|hardware|helper|system|unregistered)$"),
    domain: str = Query("", max_length=64),
    mapped: bool | None = Query(None),
    status: str = Query("", max_length=64),
    refresh: bool = Query(False),
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """只读发现、分页和诊断；不执行同步、导入或实体控制。"""
    gateway = await _ensure_default_gateway(db)
    service = await _get_ha_service(db, gateway)
    snapshot = await _get_cached_ha_workspace_snapshot(
        _ha_workspace_cache_key(gateway, service),
        service,
        refresh=refresh,
    )
    mapping_result = await db.execute(
        select(DeviceEntityMapping)
        .options(selectinload(DeviceEntityMapping.device))
        .join(ManagedDevice)
        .where(
            DeviceEntityMapping.gateway_type == "homeassistant",
            ManagedDevice.gateway_id == gateway.id,
        )
        .order_by(DeviceEntityMapping.id)
    )
    mapping_records = []
    for mapping in mapping_result.scalars().all():
        metadata = mapping.mapping_metadata or {}
        mapping_records.append({
            "mapping_id": mapping.id,
            "endpoint": mapping.endpoint,
            "role": mapping.role,
            "access_mode": mapping.access_mode,
            "device_id": mapping.device_id,
            "device_name": mapping.device.name if mapping.device else "",
            "aliases": [
                str(item).strip()
                for item in metadata.get("aliases", [])
                if str(item).strip()
            ],
        })
    runtime = await get_runtime_config(db)
    gateway_payload = {
        "id": gateway.id,
        "name": gateway.name,
        "base_url": service.base_url,
        "enabled": gateway.enabled,
        "status": "error" if snapshot.get("discovery_error") else "running",
        "credential_configured": bool(service.token),
        "config_source": runtime.config_source,
        "last_test_at": gateway.last_test_at,
    }
    return _build_home_assistant_workspace(
        snapshot,
        mapping_records,
        gateway_payload,
        page=page,
        size=size,
        diagnostic_page=diagnostic_page,
        diagnostic_size=diagnostic_size,
        keyword=keyword,
        classification=classification,
        domain=domain,
        mapped=mapped,
        status=status,
    )


@router.get("/search", summary="按名称和动作搜索设备")
async def search_device(
    name: str,
    action: str = "",
    _user=Depends(get_agent_or_user),
    db: AsyncSession = Depends(get_db),
):
    await _ensure_default_gateway(db)
    keyword = name.strip()
    result = await db.execute(
        select(ManagedDevice)
        .options(selectinload(ManagedDevice.gateway), selectinload(ManagedDevice.mappings))
        .where(ManagedDevice.enabled.is_(True))
        .order_by(ManagedDevice.id)
    )
    devices = [
        device
        for device in result.scalars().unique().all()
        if _device_matches_search_keyword(device, keyword)
    ]
    ha_maps, _ha_error, _gateway_errors = await _get_ha_maps_for_devices(db, devices)
    matches = []
    unsupported: list[dict[str, Any]] = []
    for device in devices:
        ha_map = _ha_map_for_device(device, ha_maps)
        entity_attributes = {
            entity_id: raw.get("attributes", {})
            for entity_id, raw in ha_map.items()
        }
        first_mapping = _select_control_mapping(
            device.mappings,
            action=action,
            entity_attributes=entity_attributes,
        )
        if not first_mapping and device.mappings:
            first_mapping = device.mappings[0]
        available_mappings = [
            {
                "role": item.role,
                "entity_id": item.endpoint,
                "access_mode": item.access_mode,
                "available_actions": _effective_mapping_actions(
                    item,
                    entity_attributes.get(item.endpoint, {}),
                ),
            }
            for item in device.mappings
        ]
        matched_action = bool(
            first_mapping
            and (
                not action
                or action in _effective_mapping_actions(
                    first_mapping,
                    entity_attributes.get(first_mapping.endpoint, {}),
                )
            )
        )
        item = {
            "device_id": str(device.id),
            "name": device.name,
            "category": device.category,
            "description": device.description,
            "main_entity_id": first_mapping.endpoint if first_mapping else "",
            "main_role": first_mapping.role if first_mapping else "",
            "available_actions": _effective_mapping_actions(
                first_mapping,
                entity_attributes.get(first_mapping.endpoint, {}),
            ) if first_mapping else [],
            "supports_requested_action": matched_action,
            "mappings": available_mappings,
        }
        (matches if matched_action else unsupported).append(item)
    if not matches:
        if unsupported and action:
            available = sorted({
                item_action
                for item in unsupported
                for mapping in item["mappings"]
                for item_action in mapping["available_actions"]
            })
            raise HTTPException(
                status_code=400,
                detail=f"设备 {name} 不支持动作 {action}，可用动作：{', '.join(available) or '无'}",
            )
        raise HTTPException(status_code=404, detail=f"未找到设备: {name}")
    return {"devices": matches, "count": len(matches)}


@router.get("/gateways", summary="网关接入配置列表")
async def list_gateways(user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _ensure_default_gateway(db)
    result = await db.execute(select(DeviceGateway).order_by(DeviceGateway.id))
    include_private = user.get("role") == "admin"
    return {
        "gateways": [
            _gateway_to_dict(item, include_private=include_private)
            for item in result.scalars().all()
        ],
        "can_manage": include_private,
    }


@router.post("/gateways", summary="新增网关接入配置")
async def create_gateway(payload: GatewayPayload, current_user=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="网关名称不能为空")
    gateway = DeviceGateway(created_by=current_user["user_id"])
    _apply_gateway_payload(gateway, payload)
    db.add(gateway)
    await db.flush()
    await db.refresh(gateway)
    _invalidate_device_list_snapshot()
    return _gateway_to_dict(gateway)


@router.put("/gateways/{gateway_id}", summary="更新网关接入配置")
async def update_gateway(gateway_id: int, payload: GatewayPayload, _user=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    gateway = await _get_gateway_or_404(db, gateway_id)
    if gateway.name == "Home Assistant 默认网关" and gateway.gateway_type == "homeassistant":
        raise HTTPException(status_code=400, detail="系统默认网关由系统设置统一托管，请在系统设置中修改 Home Assistant 配置")
    _apply_gateway_payload(gateway, payload)
    await db.flush()
    await db.refresh(gateway)
    _invalidate_device_list_snapshot()
    return _gateway_to_dict(gateway)


@router.delete("/gateways/{gateway_id}", status_code=204, summary="删除网关接入配置")
async def delete_gateway(gateway_id: int, _user=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    gateway = await _get_gateway_or_404(db, gateway_id)
    if gateway.name == "Home Assistant 默认网关" and gateway.gateway_type == "homeassistant":
        raise HTTPException(status_code=400, detail="系统默认网关不能删除，请在系统设置中维护 Home Assistant 配置")
    device_count = (await db.execute(select(func.count()).select_from(ManagedDevice).where(ManagedDevice.gateway_id == gateway_id))).scalar() or 0
    if device_count:
        raise HTTPException(status_code=400, detail="该网关下仍有设备，请先迁移或删除设备")
    await db.delete(gateway)
    await db.flush()
    _invalidate_device_list_snapshot()


@router.post("/gateways/{gateway_id}/test", summary="测试网关连接")
async def test_gateway(gateway_id: int, _user=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    gateway = await _get_gateway_or_404(db, gateway_id)
    if gateway.gateway_type != "homeassistant":
        gateway.status = "pending"
        gateway.last_test_at = datetime.utcnow()
        await db.flush()
        return {
            "status": "pending",
            "message": "该网关类型已保存配置，需现场协议和适配器联调后执行真实连接测试。",
            "gateway": _gateway_to_dict(gateway),
        }
    service = await _get_ha_service(db, gateway)
    ok = await service.check_health()
    gateway.status = "running" if ok else "error"
    gateway.last_test_at = datetime.utcnow()
    await db.flush()
    await db.refresh(gateway)
    return {"status": gateway.status, "message": "HA 连接正常" if ok else "HA 连接失败", "gateway": _gateway_to_dict(gateway)}


@router.post("/gateways/{gateway_id}/sync", summary="从网关同步实体")
async def sync_gateway(gateway_id: int, _user=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    gateway = await _get_gateway_or_404(db, gateway_id)
    if gateway.gateway_type != "homeassistant":
        return {
            "status": "pending",
            "message": "该网关类型需现场适配器后才能同步实体。",
            "candidates": [],
            "updated_mappings": 0,
        }
    ha_map, registries, ha_error = await _get_ha_discovery(db, gateway)
    if ha_error:
        gateway.status = "error"
        await db.flush()
        raise HTTPException(status_code=502, detail=ha_error)
    result = await db.execute(
        select(DeviceEntityMapping)
        .options(selectinload(DeviceEntityMapping.device))
        .join(ManagedDevice)
        .where(
            DeviceEntityMapping.gateway_type == "homeassistant",
            ManagedDevice.gateway_id == gateway.id,
        )
    )
    mapped_items = result.scalars().all()
    mapped = {item.endpoint for item in mapped_items}
    for mapping in mapped_items:
        raw = ha_map.get(mapping.endpoint, {})
        metadata = _registry_candidate_metadata(
            mapping.endpoint,
            raw,
            registries["entities"],
            registries["devices"],
            registries["areas"],
        )
        mapping.mapping_metadata = {
            **(mapping.mapping_metadata or {}),
            "ha_device_id": metadata["ha_device_id"],
            "platform": metadata["platform"],
            "area_id": metadata["area_id"],
            "entity_category": metadata["entity_category"],
            "device_class": metadata["device_class"],
            **_capability_metadata(raw.get("attributes", {})),
        }
        device = mapping.device
        if device and device.source == "ha_sync" and metadata["ha_device_id"]:
            device.name = metadata["device_name"] or _normalize_display_name(device.name)
            device.brand = metadata["manufacturer"] or device.brand
            device.model = metadata["model"] or device.model
            device.location = metadata["area_name"] or device.location
    candidates = _build_sync_candidates(ha_map, registries, mapped)
    gateway.status = "running"
    gateway.last_test_at = datetime.utcnow()
    await db.flush()
    _invalidate_device_list_snapshot()
    hardware_count = sum(1 for item in candidates if item["classification"] == "hardware")
    recommended_count = sum(1 for item in candidates if item["recommended"] and not item["mapped"])
    return {
        "status": "running",
        "message": f"已读取 {len(candidates)} 个 HA 实体，其中 {hardware_count} 个关联设备注册表，推荐导入 {recommended_count} 个",
        "candidates": candidates,
        "updated_mappings": len(mapped),
        "hardware_entities": hardware_count,
        "recommended_entities": recommended_count,
    }


@router.post("/gateways/{gateway_id}/import", summary="批量导入 Home Assistant 实体")
async def import_gateway_entities(
    gateway_id: int,
    payload: GatewayImportPayload,
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    gateway = await _get_gateway_or_404(db, gateway_id)
    if gateway.gateway_type != "homeassistant":
        raise HTTPException(status_code=400, detail="只有 Home Assistant 网关支持实体批量导入")

    requested = list(dict.fromkeys(item.strip() for item in payload.entity_ids if item.strip()))
    if not requested:
        raise HTTPException(status_code=400, detail="请选择至少一个待导入实体")

    ha_map, registries, ha_error = await _get_ha_discovery(db, gateway)
    if ha_error:
        raise HTTPException(status_code=502, detail=ha_error)

    mapped_result = await db.execute(
        select(DeviceEntityMapping)
        .options(selectinload(DeviceEntityMapping.device))
        .join(ManagedDevice)
        .where(
            DeviceEntityMapping.gateway_type == "homeassistant",
            ManagedDevice.gateway_id == gateway.id,
        )
    )
    mapped_items = mapped_result.scalars().all()
    mapped = {item.endpoint for item in mapped_items}
    existing_device_by_ha_device: dict[str, ManagedDevice] = {}
    for mapping in mapped_items:
        registry_entity = registries["entities"].get(mapping.endpoint, {})
        ha_device_id = str(
            (mapping.mapping_metadata or {}).get("ha_device_id")
            or registry_entity.get("device_id")
            or ""
        )
        if ha_device_id and mapping.device:
            existing_device_by_ha_device[ha_device_id] = mapping.device
    imported: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    imported_devices: dict[str, ManagedDevice] = {}

    for entity_id in requested:
        raw = ha_map.get(entity_id)
        domain = _get_domain(entity_id)
        if entity_id in mapped:
            skipped.append({"entity_id": entity_id, "reason": "实体已映射"})
            continue
        if not raw:
            skipped.append({"entity_id": entity_id, "reason": "HA 中不存在该实体"})
            continue
        metadata = _registry_candidate_metadata(
            entity_id,
            raw,
            registries["entities"],
            registries["devices"],
            registries["areas"],
        )
        if not metadata["importable"]:
            skipped.append({"entity_id": entity_id, "reason": metadata["classification_reason"]})
            continue

        attrs = raw.get("attributes", {})
        unit = str(attrs.get("unit_of_measurement", "") or "")
        category = _category_for_entity(entity_id)
        actions = _control_actions_for_entity(entity_id, attrs, category)
        ha_device_id = metadata["ha_device_id"]
        device = imported_devices.get(ha_device_id) or existing_device_by_ha_device.get(ha_device_id)
        if not device:
            device = ManagedDevice(
                name=metadata["device_name"] or _normalize_display_name(attrs.get("friendly_name"), entity_id),
                category=category,
                brand=metadata["manufacturer"],
                model=metadata["model"],
                location=metadata["area_name"],
                protocol="homeassistant",
                gateway_id=gateway.id,
                description=f"从 Home Assistant 设备 {ha_device_id} 导入",
                local_control=bool(actions),
                enabled=True,
                source="ha_sync",
                capability_tags=["Home Assistant", metadata["platform"] or domain],
                created_by=current_user["user_id"],
            )
            db.add(device)
            await db.flush()
        elif actions:
            device.local_control = True
        imported_devices[ha_device_id] = device
        existing_device_by_ha_device[ha_device_id] = device
        used_roles_result = await db.execute(
            select(DeviceEntityMapping.role).where(DeviceEntityMapping.device_id == device.id)
        )
        used_roles = set(used_roles_result.scalars().all())
        mapping_role = _unique_mapping_role(
            _role_for_entity(entity_id, unit),
            domain,
            used_roles,
        )
        db.add(DeviceEntityMapping(
            device_id=device.id,
            role=mapping_role,
            endpoint=entity_id,
            gateway_type="homeassistant",
            access_mode="rw" if actions else "ro",
            unit=unit,
            control_actions=actions,
            mapping_metadata={
                "ha_device_id": ha_device_id,
                "platform": metadata["platform"],
                "area_id": metadata["area_id"],
                "entity_category": metadata["entity_category"],
                "device_class": attrs.get("device_class", ""),
                **_capability_metadata(attrs),
            },
        ))
        mapped.add(entity_id)
        imported.append({
            "device_id": str(device.id),
            "ha_device_id": ha_device_id,
            "entity_id": entity_id,
            "name": device.name,
        })

    gateway.status = "running"
    gateway.last_test_at = datetime.utcnow()
    db.add(OperationLog(
        type="device_sync",
        level="info",
        title="批量导入 Home Assistant 实体",
        detail=f"gateway={gateway.id}, imported={len(imported)}, skipped={len(skipped)}",
        user_id=current_user.get("user_id"),
        username=current_user.get("username", ""),
    ))
    await db.flush()
    _invalidate_device_list_snapshot()
    invalidate_system_summary()
    return {
        "status": "success",
        "message": f"已导入 {len(imported)} 个真实 HA 实体，跳过 {len(skipped)} 个",
        "imported": imported,
        "skipped": skipped,
    }


@router.delete("/demo-devices", summary="清理历史演示设备")
async def delete_demo_devices(
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    count = (
        await db.execute(
            select(func.count()).select_from(ManagedDevice).where(ManagedDevice.source == "seed")
        )
    ).scalar() or 0
    await db.execute(delete(ManagedDevice).where(ManagedDevice.source == "seed"))
    db.add(OperationLog(
        type="device_sync",
        level="warning",
        title="清理历史演示设备",
        detail=f"deleted={count}",
        user_id=current_user.get("user_id"),
        username=current_user.get("username", ""),
    ))
    await db.flush()
    _invalidate_device_list_snapshot()
    if count:
        invalidate_system_summary()
    return {"success": True, "deleted": count, "message": f"已清理 {count} 台历史演示设备"}


@router.get("/", summary="设备台账列表", include_in_schema=False)
@router.get("", summary="设备台账列表")
async def list_devices(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    category: str = "",
    gateway_id: Optional[int] = Query(None, ge=1),
    status: str = "",
    keyword: str = "",
    sort: str = Query("name", pattern="^(name|status|category)$"),
    refresh: bool = False,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if status and status not in {"online", "offline", "unmapped", "disabled"}:
        raise HTTPException(status_code=422, detail="不支持的设备状态筛选")
    snapshot, cache_status = await _get_device_list_snapshot(db, refresh=refresh)
    filtered = _filter_device_snapshot(
        snapshot["devices"],
        keyword=keyword,
        category=category,
        status=status,
        gateway_id=gateway_id,
        sort=sort,
    )
    total = len(filtered)
    pages = max(1, (total + size - 1) // size)
    safe_page = min(page, pages)
    start = (safe_page - 1) * size
    return {
        "devices": filtered[start:start + size],
        "scenes": snapshot["scenes"],
        "summary": snapshot["summary"],
        "page": safe_page,
        "size": size,
        "total": total,
        "pages": pages,
        "ha_error": snapshot["ha_error"],
        "generated_at": snapshot["generated_at"],
        "cache": cache_status,
        "cache_ttl_seconds": DEVICE_LIST_CACHE_TTL_SECONDS,
    }


@router.post("/", summary="新增设备台账", include_in_schema=False)
@router.post("", summary="新增设备台账")
async def create_device(payload: DevicePayload, current_user=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    await _ensure_default_gateway(db)
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="设备名称不能为空")
    device = ManagedDevice(source="manual", created_by=current_user["user_id"])
    _apply_device_payload(device, payload)
    db.add(device)
    await db.flush()
    await _replace_mappings(db, device, payload.mappings)
    await db.refresh(device)
    response = await get_device(str(device.id), current_user, db)
    _invalidate_device_list_snapshot()
    invalidate_system_summary()
    return response


@router.get("/summary", summary="设备统计汇总")
async def device_summary(_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    snapshot, _cache_status = await _get_device_list_snapshot(db)
    return snapshot["summary"]


@router.get("/scenes", summary="场景信息")
async def list_scenes(_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    gateway = await _ensure_default_gateway(db)
    ha_map, ha_error = await _get_ha_map(db, gateway)
    if ha_error:
        raise HTTPException(status_code=502, detail=ha_error)
    scenes = _resolve_scenes(ha_map)
    return {"scenes": scenes, "count": len(scenes)}


def _resolve_scenes(ha_states: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    scenes = []
    for entity_id, raw in ha_states.items():
        if not entity_id.startswith("scene."):
            continue
        attrs = raw.get("attributes", {})
        scenes.append({
            "entity_id": entity_id,
            "name": attrs.get("friendly_name", entity_id),
            "icon": attrs.get("icon", ""),
            "entity_count": len(attrs.get("entity_id", [])),
            "last_activated": raw.get("state"),
        })
    return scenes


def _serialize_device_log(log: OperationLog) -> dict[str, Any]:
    return {
        "id": log.id,
        "type": log.type,
        "level": log.level,
        "title": log.title,
        "detail": log.detail or "",
        "username": log.username or "",
        "entity_id": log.entity_id or "",
        "time": "",
        "created_at": log.created_at.isoformat() if log.created_at else None,
    }


@router.get("/{device_id}/logs", summary="设备控制日志")
async def device_control_logs(
    device_id: int,
    page: int = Query(1, ge=1),
    size: int = Query(10, ge=1, le=100),
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """按设备全部实体精确分页读取控制日志，避免详情页截取固定十条。"""
    device = await _get_device_or_404(db, device_id)
    endpoints = [mapping.endpoint for mapping in device.mappings if mapping.endpoint]
    visibility_scope = "all" if user.get("role") == "admin" else "self"
    filters = [
        OperationLog.type == "device_control",
        OperationLog.level.in_(["success", "warning", "error"]),
    ]
    if visibility_scope == "self":
        filters.append(OperationLog.user_id == user.get("user_id"))
    if endpoints:
        filters.append(OperationLog.entity_id.in_(endpoints))
    else:
        # 未映射设备不应混入全局控制日志。
        return {
            "logs": [], "total": 0, "page": 1, "size": size, "pages": 1,
            "visibility_scope": visibility_scope,
        }

    total = (
        await db.execute(
            select(func.count()).select_from(OperationLog).where(*filters)
        )
    ).scalar() or 0
    pages = max(1, (total + size - 1) // size)
    safe_page = min(page, pages)
    result = await db.execute(
        select(OperationLog)
        .where(*filters)
        .order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
        .offset((safe_page - 1) * size)
        .limit(size)
    )
    return {
        "logs": [_serialize_device_log(log) for log in result.scalars().all()],
        "total": total,
        "page": safe_page,
        "size": size,
        "pages": pages,
        "visibility_scope": visibility_scope,
    }


@router.get("/{device_ref:path}", summary="设备详情或单实体状态")
async def get_device(device_ref: str, _user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _ensure_default_gateway(db)
    if device_ref.isdigit():
        device = await _get_device_or_404(db, int(device_ref))
        ha_map, ha_error = await _get_ha_map(db, device.gateway)
        return {**_device_to_dict(device, ha_map), "ha_error": ha_error}

    mapping_result = await db.execute(
        select(DeviceEntityMapping)
        .options(selectinload(DeviceEntityMapping.device).selectinload(ManagedDevice.gateway))
        .where(
            DeviceEntityMapping.endpoint == device_ref,
            DeviceEntityMapping.gateway_type == "homeassistant",
        )
    )
    mapping = mapping_result.scalars().first()
    service = await _get_ha_service(db, mapping.device.gateway if mapping and mapping.device else None)
    try:
        raw = await service.get_state(device_ref)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"HA 查询失败: {exc}")
    attrs = raw.get("attributes", {})
    return {
        "entity_id": raw["entity_id"],
        "state": raw.get("state"),
        "domain": _get_domain(device_ref),
        "name": attrs.get("friendly_name", device_ref),
        "unit": attrs.get("unit_of_measurement", ""),
        "attributes": attrs,
        "last_changed": raw.get("last_changed"),
        "last_updated": raw.get("last_updated"),
    }


@router.put("/{device_id}", summary="更新设备台账")
async def update_device(device_id: int, payload: DevicePayload, current_user=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    device = await _get_device_or_404(db, device_id)
    _apply_device_payload(device, payload)
    await _replace_mappings(db, device, payload.mappings)
    await db.flush()
    response = await get_device(str(device.id), current_user, db)
    _invalidate_device_list_snapshot()
    invalidate_system_summary()
    return response


@router.delete("/{device_id}", status_code=204, summary="删除设备台账")
async def delete_device(device_id: int, _user=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    device = await _get_device_or_404(db, device_id)
    await db.delete(device)
    await db.flush()
    _invalidate_device_list_snapshot()
    invalidate_system_summary()


@router.post("/{device_ref:path}/control", summary="控制设备或实体")
async def control_device(device_ref: str, req: ControlRequest, user=Depends(get_agent_or_user), db: AsyncSession = Depends(get_db)):
    await _ensure_default_gateway(db)
    target_entity = device_ref
    device_name = device_ref
    mapping: DeviceEntityMapping | None = None
    gateway: DeviceGateway | None = None
    if device_ref.isdigit():
        device = await _get_device_or_404(db, int(device_ref))
        device_name = device.name
        gateway = device.gateway
        mappings = [item for item in device.mappings if item.access_mode in {"rw", "write"}]
        mapping = _select_control_mapping(mappings, role=req.role, action=req.service)
        if not mapping:
            raise HTTPException(status_code=400, detail="该设备没有可写控制映射")
        if mapping.gateway_type != "homeassistant":
            raise HTTPException(status_code=400, detail="该网关类型已配置，真实控制需现场适配器联调")
        target_entity = mapping.endpoint
    else:
        mapping_result = await db.execute(
            select(DeviceEntityMapping)
            .options(selectinload(DeviceEntityMapping.device).selectinload(ManagedDevice.gateway))
            .where(
                DeviceEntityMapping.endpoint == device_ref,
                DeviceEntityMapping.gateway_type == "homeassistant",
            )
        )
        mapping = mapping_result.scalars().first()
        if mapping and mapping.device:
            device_name = mapping.device.name
            gateway = mapping.device.gateway

    is_scene_action = (
        not mapping
        and _get_domain(target_entity) == "scene"
        and req.service == "turn_on"
    )
    if not mapping and not is_scene_action:
        await _record_control_failure(db, user, target_entity, device_name, req.service, "实体尚未导入平台设备台账")
        raise HTTPException(status_code=404, detail="该实体尚未导入平台设备台账，拒绝直接控制")
    if mapping and mapping.access_mode not in {"rw", "write"}:
        await _record_control_failure(db, user, target_entity, device_name, req.service, "实体为只读映射")
        raise HTTPException(status_code=400, detail="该实体为只读映射，不能执行控制")
    domain = req.domain or _get_domain(target_entity)
    if req.domain and req.domain != _get_domain(target_entity):
        await _record_control_failure(db, user, target_entity, device_name, req.service, "请求 domain 与实体类型不一致")
        raise HTTPException(status_code=400, detail="请求 domain 与实体类型不一致")
    service = await _get_ha_service(db, gateway)
    try:
        current_state = await service.get_state(target_entity)
    except Exception as exc:
        await _record_control_failure(db, user, target_entity, device_name, req.service, f"HA 状态读取失败: {exc}")
        raise HTTPException(status_code=502, detail=f"HA 状态读取失败: {exc}")
    allowed_actions = _effective_mapping_actions(
        mapping,
        current_state.get("attributes", {}),
    ) if mapping else ["turn_on"]
    if req.service not in allowed_actions:
        await _record_control_failure(db, user, target_entity, device_name, req.service, "请求动作不在映射允许动作中")
        raise HTTPException(
            status_code=400,
            detail=f"该实体不支持 {req.service}，允许动作：{', '.join(allowed_actions) or '无'}",
        )
    if not is_scene_action and current_state.get("state") in {"unavailable", "unknown"}:
        await _record_control_failure(db, user, target_entity, device_name, req.service, f"设备状态为 {current_state.get('state')}")
        raise HTTPException(status_code=409, detail=f"设备当前状态为 {current_state.get('state')}，拒绝执行控制")
    try:
        translated_service, extra = _translate_control_action(
            req.service,
            req.data,
            _merge_entity_metadata(
                mapping.mapping_metadata if mapping else {},
                current_state.get("attributes", {}),
            ),
        )
        extra = _ensure_visible_light_turn_on(
            domain,
            req.service,
            extra,
            current_state,
        )
    except ValueError as exc:
        await _record_control_failure(db, user, target_entity, device_name, req.service, str(exc))
        raise HTTPException(status_code=422, detail=str(exc))
    try:
        service_response = await service.call_service(
            domain=domain,
            service=translated_service,
            entity_id=target_entity,
            **extra,
        )
    except Exception as exc:
        await _record_control_failure(db, user, target_entity, device_name, req.service, f"HA 服务调用失败: {exc}")
        raise HTTPException(status_code=502, detail=f"HA 控制失败: {exc}")

    db.add(OperationLog(
        type="device_control",
        level="info",
        title=f"下发控制 {device_name}：{req.service}",
        detail=f"entity={target_entity}, action={req.service}, service={domain}.{translated_service}, data={extra}, result=pending",
        user_id=user.get("user_id"),
        username=user.get("username", ""),
        entity_id=target_entity,
    ))

    confirmation = _control_confirmation(
        mapping,
        is_scene_action=is_scene_action,
        attributes=current_state.get("attributes", {}),
    )
    try:
        # Xiaomi Home 的即时状态是集成层乐观回写，长时间扣住 HTTP 请求也无法证明实体硬件已动作。
        # 因此复用服务响应并明确返回待实机确认；普通设备仍等待目标状态确认。
        response_state = _state_from_service_response(service_response, target_entity)
        if confirmation == "physical_pending":
            # 小米集成的状态只能作为平台回读，不能作为实机动作证据；服务响应为空时仅做一次短回读。
            updated = response_state
            if not updated:
                try:
                    updated = await asyncio.wait_for(service.get_state(target_entity), timeout=2.0)
                except Exception:
                    updated = None
            updated = updated or {
                "entity_id": target_entity,
                "state": None,
                "attributes": {},
            }
        elif is_scene_action:
            updated = _state_from_service_response(service_response, target_entity) or {
                "entity_id": target_entity,
                "state": None,
                "attributes": {},
            }
        else:
            updated = _confirmed_state_from_service_response(
                service_response,
                target_entity,
                req.service,
                extra,
                current_state,
            ) or await _wait_for_control_confirmation(
                service,
                target_entity,
                req.service,
                extra,
                current_state,
            )
    except ControlStateRollbackError as exc:
        await _record_control_failure(db, user, target_entity, device_name, req.service, str(exc))
        raise HTTPException(status_code=502, detail=str(exc))
    except TimeoutError as exc:
        await _record_control_failure(db, user, target_entity, device_name, req.service, str(exc))
        raise HTTPException(status_code=504, detail=str(exc))
    except Exception as exc:
        await _record_control_failure(db, user, target_entity, device_name, req.service, f"控制已发送但状态回读失败: {exc}")
        raise HTTPException(status_code=502, detail=f"HA 控制已发送但状态回读失败: {exc}")
    physically_pending = confirmation == "physical_pending"
    db.add(OperationLog(
        type="device_control",
        level="warning" if physically_pending else "success",
        title=(
            f"控制 {device_name} 已下发，待实机确认：{req.service}"
            if physically_pending
            else f"控制 {device_name} 已确认：{req.service}"
        ),
        detail=(
            f"entity={target_entity}, action={req.service}, service={domain}.{translated_service}, "
            f"result={confirmation}, new_state={updated.get('state')}"
        ),
        user_id=user.get("user_id"),
        username=user.get("username", ""),
        entity_id=target_entity,
    ))
    _invalidate_device_list_snapshot()
    return {
        "success": True,
        "entity_id": target_entity,
        "device_id": int(device_ref) if device_ref.isdigit() else None,
        "action": req.service,
        "service": f"{domain}.{translated_service}",
        "new_state": updated.get("state"),
        "attributes": updated.get("attributes", {}),
        "confirmation": confirmation,
    }
