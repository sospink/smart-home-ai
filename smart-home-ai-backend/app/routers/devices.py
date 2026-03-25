"""
设备控制路由 — 对接 Home Assistant REST API
基于"逻辑设备"模型：多个 HA 实体聚合为一个独立设备
覆盖合同条款：§14(4种接口), §19(HA对接), §20(状态≥3项), §21(数据访问), §22(控制接口)
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.dependencies import get_current_user, get_db
from app.services.homeassistant import ha_service
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/devices", tags=["设备控制"])


# ── Schema ─────────────────────────────────────────────

class ControlRequest(BaseModel):
    """设备控制请求"""
    service: str                      # e.g. "turn_on", "turn_off", "toggle"
    domain: Optional[str] = None      # e.g. "input_boolean" (可自动推断)
    data: Optional[dict] = None       # 额外参数


# ── 逻辑设备注册表 ─────────────────────────────────────
# 每个条目代表一个"独立设备"，聚合多个 HA 实体

DEVICE_REGISTRY = [
    # ── 灯光 ──
    {
        "id": "living_room_light",
        "name": "客厅灯",
        "description": "可调式 LED 灯组",
        "category": "light",
        "entities": {
            "power": "input_boolean.light_living_room",
            "brightness": "input_number.light_living_room_brightness",
        },
    },
    {
        "id": "bedroom_light",
        "name": "卧室灯",
        "description": "卧室智能灯",
        "category": "light",
        "entities": {
            "power": "input_boolean.light_bedroom",
            "brightness": "input_number.light_bedroom_brightness",
        },
    },
    {
        "id": "study_room_light",
        "name": "书房灯",
        "description": "书房护眼台灯",
        "category": "light",
        "entities": {
            "power": "input_boolean.light_study_room",
            "brightness": "input_number.light_study_room_brightness",
        },
    },

    # ── 空调 ──
    {
        "id": "living_room_ac",
        "name": "主卧空调",
        "description": "温控系统",
        "category": "climate",
        "entities": {
            "power": "input_select.ac_power",
            "mode": "input_select.ac_mode",
            "temperature": "input_number.ac_temperature",
        },
    },

    # ── 开关设备 ──
    {
        "id": "coffee_machine",
        "name": "咖啡机",
        "description": "厨房设备",
        "category": "switch",
        "entities": {
            "power": "input_boolean.coffee_machine",
        },
    },
    {
        "id": "water_heater",
        "name": "热水器",
        "description": "浴室设备",
        "category": "switch",
        "entities": {
            "power": "input_boolean.water_heater",
        },
    },

    # ── 安防 ──
    {
        "id": "front_door_lock",
        "name": "前门门锁",
        "description": "智能门锁 Pro v2",
        "category": "lock",
        "entities": {
            "lock": "input_boolean.front_door_lock",
        },
    },

    # ── 传感器 ──
    {
        "id": "indoor_env_sensor",
        "name": "室内环境",
        "description": "温湿度传感器",
        "category": "sensor",
        "entities": {
            "temperature": "sensor.shi_nei_wen_du",
            "humidity": "sensor.shi_nei_shi_du",
        },
    },
    {
        "id": "air_quality_sensor",
        "name": "空气质量",
        "description": "PM2.5 传感器",
        "category": "sensor",
        "entities": {
            "pm25": "sensor.pm2_5",
        },
    },
    {
        "id": "power_monitor",
        "name": "电力监控",
        "description": "全屋功率计",
        "category": "sensor",
        "entities": {
            "power": "sensor.dang_qian_gong_hao",
        },
    },
    {
        "id": "front_door_sensor",
        "name": "前门门磁",
        "description": "门窗传感器",
        "category": "sensor",
        "entities": {
            "door": "binary_sensor.qian_men",
        },
    },
]


# ── Helper ─────────────────────────────────────────────

def _get_domain(entity_id: str) -> str:
    """从 entity_id 提取 domain"""
    return entity_id.split(".")[0]


def _resolve_device(reg_device: dict, ha_states: dict) -> dict:
    """
    将注册表设备 + HA 实体状态合并为前端消费的逻辑设备对象
    ha_states: { entity_id: raw_state_dict }
    """
    entities_state = {}
    status = "online"

    for role, entity_id in reg_device["entities"].items():
        raw = ha_states.get(entity_id)
        if raw:
            state = raw.get("state", "unknown")
            attrs = raw.get("attributes", {})
            entities_state[role] = {
                "entity_id": entity_id,
                "state": state,
                "unit": attrs.get("unit_of_measurement", ""),
                "attributes": attrs,
                "last_changed": raw.get("last_changed"),
            }
            if state in ("unavailable", "unknown"):
                status = "offline"
        else:
            entities_state[role] = {
                "entity_id": entity_id,
                "state": "unavailable",
                "unit": "",
                "attributes": {},
                "last_changed": None,
            }
            status = "offline"

    return {
        "id": reg_device["id"],
        "name": reg_device["name"],
        "description": reg_device["description"],
        "category": reg_device["category"],
        "status": status,
        "entities": entities_state,
    }


def _resolve_scenes(ha_states: dict) -> list:
    """提取场景列表"""
    scenes = []
    for eid, raw in ha_states.items():
        if not eid.startswith("scene."):
            continue
        attrs = raw.get("attributes", {})
        scenes.append({
            "entity_id": eid,
            "name": attrs.get("friendly_name", eid),
            "icon": attrs.get("icon", ""),
            "entity_count": len(attrs.get("entity_id", [])),
            "last_activated": raw.get("state"),
        })
    return scenes


# ── Routes ─────────────────────────────────────────────

@router.get("/health", summary="设备模块健康检查")
async def health():
    """检查 HA 连接状态"""
    ok = await ha_service.check_health()
    return {
        "status": "ok" if ok else "error",
        "module": "devices",
        "ha_connected": ok,
    }


@router.get("/", summary="设备列表")
async def list_devices(
    category: Optional[str] = None,
    _user=Depends(get_current_user),
):
    """
    获取所有逻辑设备 + 场景 + 统计

    - **category**: 可选过滤，如 light / switch / sensor / climate / lock
    """
    try:
        raw_states = await ha_service.get_states()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Home Assistant 连接失败: {str(e)}")

    # 构建 entity_id → raw 映射
    ha_map = {s["entity_id"]: s for s in raw_states}

    # 解析逻辑设备
    devices = []
    for reg in DEVICE_REGISTRY:
        device = _resolve_device(reg, ha_map)
        if category and device["category"] != category:
            continue
        devices.append(device)

    # 解析场景
    scenes = _resolve_scenes(ha_map)

    # 统计（只算独立设备，不算场景）
    cats: dict = {}
    online = 0
    for d in devices:
        cats[d["category"]] = cats.get(d["category"], 0) + 1
        if d["status"] == "online":
            online += 1

    return {
        "devices": devices,
        "scenes": scenes,
        "summary": {
            "total": len(devices),
            "online": online,
            "offline": len(devices) - online,
            "scene_count": len(scenes),
            "categories": cats,
        },
    }


@router.get("/summary", summary="设备统计汇总")
async def device_summary(_user=Depends(get_current_user)):
    """仅返回统计数据（用于仪表盘卡片）"""
    try:
        raw_states = await ha_service.get_states()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"HA 连接失败: {str(e)}")

    ha_map = {s["entity_id"]: s for s in raw_states}

    cats: dict = {}
    online = 0
    for reg in DEVICE_REGISTRY:
        device = _resolve_device(reg, ha_map)
        cats[device["category"]] = cats.get(device["category"], 0) + 1
        if device["status"] == "online":
            online += 1

    scenes = _resolve_scenes(ha_map)

    return {
        "total": len(DEVICE_REGISTRY),
        "online": online,
        "offline": len(DEVICE_REGISTRY) - online,
        "scene_count": len(scenes),
        "categories": cats,
    }


@router.get("/{entity_id:path}", summary="单实体状态")
async def get_entity(
    entity_id: str,
    _user=Depends(get_current_user),
):
    """获取单个 HA 实体的完整状态"""
    try:
        raw = await ha_service.get_state(entity_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"HA 查询失败: {str(e)}")

    if not raw or "entity_id" not in raw:
        raise HTTPException(status_code=404, detail=f"实体 {entity_id} 不存在")

    attrs = raw.get("attributes", {})
    return {
        "entity_id": raw["entity_id"],
        "state": raw.get("state"),
        "domain": _get_domain(entity_id),
        "name": attrs.get("friendly_name", entity_id),
        "unit": attrs.get("unit_of_measurement", ""),
        "attributes": attrs,
        "last_changed": raw.get("last_changed"),
        "last_updated": raw.get("last_updated"),
    }


@router.post("/{entity_id:path}/control", summary="控制设备")
async def control_device(
    entity_id: str,
    req: ControlRequest,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    控制设备（操作单个 HA 实体）

    - **service**: turn_on / turn_off / toggle / set_value / select_option
    - **domain**: 可选，自动从 entity_id 推断
    - **data**: 额外参数，如 {value: 80} 或 {option: "制冷"}
    """
    domain = req.domain or _get_domain(entity_id)
    extra = req.data or {}

    try:
        await ha_service.call_service(
            domain=domain,
            service=req.service,
            entity_id=entity_id,
            **extra,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"HA 控制失败: {str(e)}")

    # 写入操作日志
    try:
        from app.models.operation_log import OperationLog
        # 找到设备名
        dev_name = entity_id
        for reg in DEVICE_REGISTRY:
            if entity_id in reg["entities"].values():
                dev_name = reg["name"]
                break
        log = OperationLog(
            type="device_control",
            level="info",
            title=f"控制 {dev_name}：{req.service}",
            detail=f"entity={entity_id}, service={domain}.{req.service}, data={extra}",
            user_id=_user.get("user_id"),
            username=_user.get("username", ""),
            entity_id=entity_id,
        )
        db.add(log)
    except Exception:
        pass  # 日志写入失败不影响控制操作

    # 控制后查询最新状态
    try:
        updated = await ha_service.get_state(entity_id)
        return {
            "success": True,
            "entity_id": entity_id,
            "service": f"{domain}.{req.service}",
            "new_state": updated.get("state"),
            "attributes": updated.get("attributes", {}),
        }
    except Exception:
        return {
            "success": True,
            "entity_id": entity_id,
            "service": f"{domain}.{req.service}",
            "new_state": None,
            "attributes": {},
        }
