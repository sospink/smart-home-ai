"""
AI 设备控制编排

只处理能够唯一命中平台动态设备台账、且动作和参数明确的自然语言控制指令。
实体选择、能力校验和最终控制仍由 devices 路由的统一领域逻辑完成。
"""
from __future__ import annotations

from dataclasses import dataclass, field
import re
import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.device_management import ManagedDevice
from app.models.operation_log import OperationLog
from app.routers.devices import (
    ControlRequest,
    _build_entity_capabilities,
    _effective_mapping_actions,
    _get_ha_maps_for_devices,
    _ha_map_for_device,
    control_device,
)


CONTROL_HINTS = (
    "打开",
    "开启",
    "启动",
    "关闭",
    "关掉",
    "停止",
    "切换",
    "设置",
    "设为",
    "调到",
    "调成",
    "调节",
    "调亮",
    "调暗",
)

STATUS_HINTS = (
    "状态",
    "开着",
    "关着",
    "打开了吗",
    "关闭了吗",
    "亮度是多少",
    "色温是多少",
    "温度是多少",
    "当前亮度",
    "当前色温",
    "当前温度",
)

CATEGORY_ALIASES = {
    "light": ("灯", "灯光"),
    "climate": ("空调", "温控"),
    "cover": ("窗帘", "卷帘", "遮阳帘"),
    "fan": ("风扇",),
    "lock": ("门锁", "锁"),
    "media_player": ("播放器", "音箱", "电视"),
    "switch": ("开关",),
}

DEVICE_SUBJECT_HINTS = tuple({
    "设备",
    "传感器",
    "插座",
    "热水器",
    "咖啡机",
    *(alias for aliases in CATEGORY_ALIASES.values() for alias in aliases),
})

ACTION_VALUE_KEYS = {
    "set_brightness": "brightness_pct",
    "set_color_temperature": "color_temp_kelvin",
    "set_effect": "effect",
    "set_position": "position",
    "set_temperature": "temperature",
    "set_hvac_mode": "hvac_mode",
    "set_percentage": "percentage",
    "set_value": "value",
    "select_option": "option",
}

ROLE_LABELS = {
    "power": "电源",
    "brightness": "亮度",
    "color_temperature": "色温",
    "temperature": "温度",
    "humidity": "湿度",
    "position": "位置",
    "status": "状态",
}

STATE_LABELS = {
    "on": "开启",
    "off": "关闭",
    "open": "打开",
    "closed": "关闭",
    "opening": "正在打开",
    "closing": "正在关闭",
    "locked": "已锁定",
    "unlocked": "未锁定",
    "unavailable": "不可用",
    "unknown": "未知",
}


@dataclass
class DeviceCommand:
    handled: bool
    device_id: str = ""
    device_name: str = ""
    entity_id: str = ""
    role: str = ""
    action: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    message: str = ""


def _normalize_text(value: Any) -> str:
    return re.sub(r"[\s，。！？、,.!?：:；;\-_]+", "", str(value or "")).lower()


def _looks_like_control_request(query: str) -> bool:
    if not any(hint in query for hint in CONTROL_HINTS):
        return False
    explicit = bool(
        re.search(r"(?:请(?:帮我|直接)?|帮我|给我|把|执行|立即|马上).*(?:打开|开启|启动|关闭|关掉|停止|切换|设置|设为|调到|调成|调节|调亮|调暗)", query)
        or re.match(r"\s*(?:打开|开启|启动|关闭|关掉|停止|切换|设置|调节|调亮|调暗)", query)
    )
    asks_only = bool(re.search(r"(?:了吗|了没|没有|是多少|什么状态|状态如何|状态怎么样|怎么|如何|是否|能否|支持.*吗)", query))
    return explicit or not asks_only


def _looks_like_status_request(query: str) -> bool:
    return any(hint in query for hint in STATUS_HINTS)


def _mentions_device_subject(query: str, inventory: list[dict[str, Any]]) -> bool:
    normalized = _normalize_text(query)
    if any(
        alias in normalized
        for item in inventory
        for alias in _normalized_device_names(item)
    ):
        return True
    return any(hint in query for hint in DEVICE_SUBJECT_HINTS)


def _number_from_query(query: str) -> float | None:
    match = re.search(r"(?<!\d)(\d+(?:\.\d+)?)\s*(?:%|％|k|K|度)?", query)
    return float(match.group(1)) if match else None


def _display_number(value: Any) -> str:
    number = float(value)
    return str(int(number)) if number.is_integer() else str(number)


def _writable_mappings(device: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in device.get("mappings", [])
        if item.get("access_mode") in {"rw", "write"}
    ]


def _normalized_device_names(device: dict[str, Any]) -> list[str]:
    values = [device.get("name"), *(device.get("aliases") or [])]
    return list(dict.fromkeys(
        normalized
        for value in values
        if (normalized := _normalize_text(value))
    ))


def _device_candidates(query: str, inventory: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_query = _normalize_text(query)
    exact: list[tuple[int, dict[str, Any]]] = []
    for device in inventory:
        scores = [
            len(name)
            for name in _normalized_device_names(device)
            if name in normalized_query
        ]
        if scores:
            exact.append((max(scores), device))
    if exact:
        longest = max(score for score, _device in exact)
        return [device for score, device in exact if score == longest]

    # 没有设备名时，只接受“位置 + 设备类别”且结果唯一的表达，例如“卧室的灯”。
    contextual: list[dict[str, Any]] = []
    for device in inventory:
        location = _normalize_text(device.get("location"))
        aliases = CATEGORY_ALIASES.get(str(device.get("category") or ""), ())
        if location and location in normalized_query and any(
            _normalize_text(alias) in normalized_query for alias in aliases
        ):
            contextual.append(device)
    return contextual


def _mapping_for_action(device: dict[str, Any], action: str) -> dict[str, Any] | None:
    for mapping in _writable_mappings(device):
        if action in mapping.get("available_actions", []):
            return mapping
    return None


def _device_status_message(device: dict[str, Any]) -> str:
    values: list[str] = []
    for mapping in device.get("mappings", []):
        raw_role = str(mapping.get("role") or "")
        role = ROLE_LABELS.get(raw_role, f"设备能力（{raw_role}）" if raw_role else "设备状态")
        state = str(mapping.get("state") or "unknown")
        display_state = STATE_LABELS.get(state.lower(), f"技术状态：{state}")
        capabilities = mapping.get("capabilities", []) or []
        details = []
        for capability in capabilities:
            current = capability.get("current_value")
            if current is None or current == "":
                continue
            if capability.get("id") == "actions":
                continue
            details.append(
                f"{capability.get('label') or capability.get('id')} {current}{capability.get('unit') or ''}"
            )
        suffix = f"（{'，'.join(details)}）" if details else ""
        values.append(f"{role}：{display_state}{suffix}")
    status = "；".join(values) or "没有可读实体"
    return f"{device.get('name') or '设备'}当前状态：{status}。"


def _all_actions(device: dict[str, Any]) -> set[str]:
    return {
        action
        for mapping in _writable_mappings(device)
        for action in mapping.get("available_actions", [])
    }


def _option_action(query: str, device: dict[str, Any]) -> tuple[str, str] | None:
    normalized_query = _normalize_text(query)
    matches: list[tuple[int, str, str]] = []
    for mapping in _writable_mappings(device):
        for capability in mapping.get("capabilities", []):
            action = str(capability.get("action") or "")
            if action not in {"set_effect", "set_hvac_mode", "select_option"}:
                continue
            for option in capability.get("options", []) or []:
                normalized_option = _normalize_text(option)
                if normalized_option and normalized_option in normalized_query:
                    matches.append((len(normalized_option), action, str(option)))
    if not matches:
        return None
    _length, action, option = max(matches, key=lambda item: item[0])
    return action, option


def _resolve_action(query: str, device: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
    actions = _all_actions(device)
    number = _number_from_query(query)
    normalized = _normalize_text(query)

    option_match = _option_action(query, device)
    if option_match:
        action, option = option_match
        return action, {ACTION_VALUE_KEYS[action]: option}, ""

    if "色温" in query:
        if number is None:
            return "", {}, "请提供明确的色温数值。"
        return "set_color_temperature", {"color_temp_kelvin": number}, ""
    if "亮度" in query:
        if number is None:
            return "", {}, "请提供 0 到 100 的亮度百分比。"
        return "set_brightness", {"brightness_pct": number}, ""
    if any(word in query for word in ("位置", "开度")) and "set_position" in actions:
        if number is None:
            return "", {}, "请提供 0 到 100 的位置百分比。"
        return "set_position", {"position": number}, ""
    if "温度" in query and "set_temperature" in actions:
        if number is None:
            return "", {}, "请提供明确的目标温度。"
        return "set_temperature", {"temperature": number}, ""
    if any(word in query for word in ("风速", "转速")) and "set_percentage" in actions:
        if number is None:
            return "", {}, "请提供 0 到 100 的目标百分比。"
        return "set_percentage", {"percentage": number}, ""

    hvac_aliases = {
        "制冷": "cool",
        "制热": "heat",
        "自动": "auto",
        "除湿": "dry",
        "送风": "fan_only",
    }
    if "set_hvac_mode" in actions:
        for label, value in hvac_aliases.items():
            if label in query:
                return "set_hvac_mode", {"hvac_mode": value}, ""

    if any(word in query for word in ("关闭", "关掉", "停止")) or normalized.startswith("关"):
        return "turn_off", {}, ""
    if any(word in query for word in ("打开", "开启", "启动")) or normalized.startswith("开"):
        return "turn_on", {}, ""
    if "切换" in query:
        return "toggle", {}, ""

    if number is not None and "set_value" in actions:
        return "set_value", {"value": number}, ""
    return "", {}, "未识别到明确的设备控制动作，请说明打开、关闭或目标数值。"


def resolve_device_command(query: str, inventory: list[dict[str, Any]]) -> DeviceCommand:
    """把自然语言解析为受动态设备清单约束的控制命令。"""
    if not query.strip() or not (_looks_like_control_request(query) or _looks_like_status_request(query)):
        return DeviceCommand(handled=False)

    candidates = _device_candidates(query, inventory)
    if not candidates:
        if _mentions_device_subject(query, inventory):
            available = "、".join(str(item.get("name")) for item in inventory if item.get("name")) or "暂无设备"
            return DeviceCommand(
                handled=True,
                message=f"未在平台动态设备台账中找到目标设备。当前可用设备：{available}。",
            )
        return DeviceCommand(handled=False)
    if len(candidates) > 1:
        names = "、".join(sorted({str(item.get("name") or "未命名设备") for item in candidates}))
        return DeviceCommand(handled=True, message=f"匹配到多个设备：{names}，请指定准确设备名称。")

    device = candidates[0]
    if _looks_like_status_request(query) and not _looks_like_control_request(query):
        status_mapping = next(
            (
                item
                for item in device.get("mappings", [])
                if item.get("entity_id") and item.get("state") not in {"unavailable", "unknown"}
            ),
            next(
                (item for item in device.get("mappings", []) if item.get("entity_id")),
                {},
            ),
        )
        return DeviceCommand(
            handled=True,
            device_id=str(device.get("device_id") or ""),
            device_name=str(device.get("name") or ""),
            entity_id=str(status_mapping.get("entity_id") or ""),
            role=str(status_mapping.get("role") or ""),
            message=_device_status_message(device),
        )
    action, data, error = _resolve_action(query, device)
    if error:
        return DeviceCommand(
            handled=True,
            device_id=str(device.get("device_id") or ""),
            device_name=str(device.get("name") or ""),
            message=error,
        )
    mapping = _mapping_for_action(device, action)
    if not mapping:
        available = "、".join(sorted(_all_actions(device))) or "无"
        return DeviceCommand(
            handled=True,
            device_id=str(device.get("device_id") or ""),
            device_name=str(device.get("name") or ""),
            action=action,
            message=f"设备不支持动作 {action}，当前可用动作：{available}。",
        )
    return DeviceCommand(
        handled=True,
        device_id=str(device.get("device_id") or ""),
        device_name=str(device.get("name") or ""),
        entity_id=str(mapping.get("entity_id") or ""),
        role=str(mapping.get("role") or ""),
        action=action,
        data=data,
    )


async def build_device_control_inventory(db: AsyncSession) -> list[dict[str, Any]]:
    """从数据库台账和 HA 当前状态生成 AI 可用设备清单。"""
    result = await db.execute(
        select(ManagedDevice)
        .options(selectinload(ManagedDevice.gateway), selectinload(ManagedDevice.mappings))
        .where(ManagedDevice.enabled.is_(True))
        .order_by(ManagedDevice.id)
    )
    devices = result.scalars().unique().all()
    ha_maps, _ha_error, _gateway_errors = await _get_ha_maps_for_devices(db, devices)
    inventory: list[dict[str, Any]] = []
    for device in devices:
        ha_map = _ha_map_for_device(device, ha_maps)
        mappings: list[dict[str, Any]] = []
        aliases: list[str] = []
        for mapping in device.mappings:
            raw = ha_map.get(mapping.endpoint) or {}
            attrs = raw.get("attributes", {})
            metadata = mapping.mapping_metadata or {}
            aliases.extend(
                str(item).strip()
                for item in metadata.get("aliases", [])
                if str(item).strip()
            )
            actions = (
                _effective_mapping_actions(mapping, attrs)
                if mapping.access_mode in {"rw", "write"}
                else []
            )
            mappings.append({
                "role": mapping.role,
                "entity_id": mapping.endpoint,
                "access_mode": mapping.access_mode,
                "state": raw.get("state", "unavailable"),
                "available_actions": actions,
                "capabilities": _build_entity_capabilities(
                    mapping.endpoint,
                    {**(mapping.mapping_metadata or {}), **attrs},
                    actions,
                    raw.get("state"),
                ),
            })
        if mappings:
            inventory.append({
                "device_id": str(device.id),
                "name": device.name,
                "aliases": list(dict.fromkeys(aliases)),
                "location": device.location,
                "category": device.category,
                "source": device.source,
                "mappings": mappings,
            })
    return inventory


def _success_message(command: DeviceCommand, result: dict[str, Any]) -> str:
    values = {
        "turn_on": "已打开",
        "turn_off": "已关闭",
        "toggle": "已切换",
    }
    if command.action in values:
        prefix = f"{values[command.action]}{command.device_name}"
    elif command.action == "set_brightness":
        prefix = f"已将{command.device_name}亮度设置为 {_display_number(command.data['brightness_pct'])}%"
    elif command.action == "set_color_temperature":
        prefix = f"已将{command.device_name}色温设置为 {_display_number(command.data['color_temp_kelvin'])}K"
    elif command.action == "set_effect":
        prefix = f"已将{command.device_name}效果设置为 {command.data['effect']}"
    elif command.action == "set_position":
        prefix = f"已将{command.device_name}位置设置为 {_display_number(command.data['position'])}%"
    elif command.action == "set_temperature":
        prefix = f"已将{command.device_name}温度设置为 {_display_number(command.data['temperature'])}"
    else:
        prefix = f"已执行{command.device_name}的 {command.action}"
    if result.get("confirmation") == "physical_pending":
        return (
            f"已向{command.device_name}下发控制命令。Home Assistant 当前显示状态："
            f"{result.get('new_state') or 'unknown'}；Xiaomi Home 会在命令被接受后即时回写状态，"
            "物理设备是否动作仍需现场确认。"
        )
    return f"{prefix}。Home Assistant 回读状态：{result.get('new_state') or 'unknown'}。"


async def try_execute_device_command(
    query: str,
    user: dict[str, Any],
    db: AsyncSession,
) -> dict[str, Any] | None:
    """命中设备控制时返回本地执行结果；普通对话返回 None。"""
    if not (_looks_like_control_request(query) or _looks_like_status_request(query)):
        return None
    inventory = await build_device_control_inventory(db)
    command = resolve_device_command(query, inventory)
    if not command.handled:
        return None

    if command.message:
        is_status = not command.action and _looks_like_status_request(query)
        result = {
            "success": is_status,
            "answer": command.message,
            "device_id": command.device_id,
            "device_name": command.device_name,
            "entity_id": command.entity_id,
            "action": command.action,
            "source": "local_dynamic_device_status" if is_status else "local_dynamic_device_control",
        }
    else:
        try:
            control_result = await control_device(
                command.device_id,
                ControlRequest(service=command.action, role=command.role, data=command.data),
                user=user,
                db=db,
            )
            result = {
                "success": True,
                "answer": _success_message(command, control_result),
                "device_id": command.device_id,
                "device_name": command.device_name,
                "entity_id": control_result.get("entity_id", command.entity_id),
                "action": command.action,
                "new_state": control_result.get("new_state"),
                "confirmation": control_result.get("confirmation", "confirmed"),
                "source": "local_dynamic_device_control",
            }
        except HTTPException as exc:
            result = {
                "success": False,
                "answer": f"控制未执行：{exc.detail}",
                "device_id": command.device_id,
                "device_name": command.device_name,
                "entity_id": command.entity_id,
                "action": command.action,
                "source": "local_dynamic_device_control",
            }

    physically_pending = result.get("confirmation") == "physical_pending"
    message_id = f"local-control-{uuid.uuid4().hex}"
    result["message_id"] = message_id
    db.add(OperationLog(
        type="agent_device_status" if result["source"] == "local_dynamic_device_status" else "agent_control",
        level="warning" if physically_pending else "success" if result["success"] else "error",
        title=(
            f"AI 设备状态查询：{command.device_name or '待确认设备'}"
            if result["source"] == "local_dynamic_device_status"
            else (
                f"AI 设备控制已下发，待实机确认：{command.device_name or '待确认设备'}"
                if physically_pending
                else f"AI 设备控制：{command.device_name or '待确认设备'}"
            )
        ),
        detail=(
            f"message_id={message_id}, query={query[:160]}, device_id={command.device_id}, "
            f"action={command.action}, result={'physical_pending' if physically_pending else 'success' if result['success'] else 'failed'}, "
            f"answer={result['answer'][:240]}"
        ),
        user_id=user.get("user_id"),
        username=user.get("username", ""),
        entity_id=result.get("entity_id", command.entity_id),
    ))
    await db.flush()
    return result
