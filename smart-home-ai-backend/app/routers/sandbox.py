"""
电子沙盘路由 - 虚拟设备列表 / 数据注入 / 仿真日志
"""
import asyncio
import json
import time
from datetime import datetime
from typing import Optional
from collections import deque

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.dependencies import get_current_user
from app.config import settings

import httpx

router = APIRouter(prefix="/sandbox", tags=["电子沙盘"])

# ── 内存日志队列（最大 500 条）──
_log_queue: deque = deque(maxlen=500)
_log_event = asyncio.Event()


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
        "name": "主卧空调",
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
        "name": "🌡️ 夏日高温",
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
        "name": "🌙 深夜睡眠",
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
        "name": "🚪 无人离家",
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
        "name": "🏠 回家模式",
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


# ════════════════════ API ════════════════════


@router.get("/health", summary="沙盘模块健康检查")
async def health():
    return {"status": "ok", "module": "sandbox"}


@router.get("/devices", summary="获取虚拟设备列表与实时状态")
async def get_virtual_devices(user=Depends(get_current_user)):
    """从 HA 拉取所有虚拟设备的当前状态"""
    ha_url = settings.HA_BASE_URL
    ha_token = settings.HA_TOKEN

    # 收集所有需要查询的 entity_id
    entity_ids = set()
    for dev in VIRTUAL_DEVICES:
        for eid in dev["entities"].values():
            entity_ids.add(eid)

    # 批量从 HA 拉取状态
    states = {}
    async with httpx.AsyncClient(timeout=10) as client:
        for eid in entity_ids:
            try:
                r = await client.get(
                    f"{ha_url}/api/states/{eid}",
                    headers={"Authorization": f"Bearer {ha_token}"},
                )
                if r.status_code == 200:
                    data = r.json()
                    states[eid] = {
                        "state": data.get("state", "unknown"),
                        "attributes": data.get("attributes", {}),
                        "last_updated": data.get("last_updated", ""),
                    }
            except Exception:
                states[eid] = {"state": "unavailable", "attributes": {}}

    # 组装结果
    result = []
    for dev in VIRTUAL_DEVICES:
        entity_states = {}
        for key, eid in dev["entities"].items():
            entity_states[key] = states.get(eid, {"state": "unknown", "attributes": {}})

        result.append({
            **dev,
            "entity_states": entity_states,
        })

    return {"devices": result, "count": len(result)}


class InjectRequest(BaseModel):
    entity_id: str
    value: str
    source: str = "manual"  # manual / preset / auto


@router.post("/inject", summary="数据注入 - 向虚拟传感器写入值")
async def inject_data(req: InjectRequest, user=Depends(get_current_user)):
    """通过 HA REST API 直接设置实体状态"""
    ha_url = settings.HA_BASE_URL
    ha_token = settings.HA_TOKEN

    entity_id = req.entity_id

    # 根据实体域选择调用方式
    domain = entity_id.split(".")[0]

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if domain == "input_number":
                r = await client.post(
                    f"{ha_url}/api/services/input_number/set_value",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json={"entity_id": entity_id, "value": float(req.value)},
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
                        "state": req.value,
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

        # 记录日志
        _add_log(
            "inject", "info",
            f"数据注入：{entity_id} = {req.value}",
            f"来源: {req.source}",
        )

        return {"success": True, "entity_id": entity_id, "value": req.value}

    except httpx.HTTPError as e:
        _add_log("inject", "error", f"注入失败：{entity_id}", str(e))
        raise HTTPException(500, f"HA 通信错误: {str(e)}")


class ControlRequest(BaseModel):
    entity_id: str
    service: str
    data: dict = {}


@router.post("/control", summary="控制虚拟设备")
async def control_device(req: ControlRequest, user=Depends(get_current_user)):
    """通过 HA 服务调用控制虚拟设备"""
    ha_url = settings.HA_BASE_URL
    ha_token = settings.HA_TOKEN

    try:
        domain, service_name = req.service.split(".", 1)
        payload = {"entity_id": req.entity_id, **req.data}

        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{ha_url}/api/services/{domain}/{service_name}",
                headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                json=payload,
            )

        _add_log(
            "control", "success",
            f"控制指令：{req.entity_id} → {req.service}",
            json.dumps(req.data, ensure_ascii=False),
        )

        return {"success": True, "entity_id": req.entity_id, "service": req.service}

    except Exception as e:
        _add_log("control", "error", f"控制失败：{req.entity_id}", str(e))
        raise HTTPException(500, f"控制失败: {str(e)}")


@router.get("/scenes", summary="获取场景预设列表")
async def get_scenes(user=Depends(get_current_user)):
    return {"scenes": SCENE_PRESETS}


@router.post("/scenes/{scene_id}/execute", summary="执行场景预设")
async def execute_scene(scene_id: str, user=Depends(get_current_user)):
    """执行预设场景：批量注入传感器数据 + 批量控制设备"""
    scene = next((s for s in SCENE_PRESETS if s["id"] == scene_id), None)
    if not scene:
        raise HTTPException(404, f"场景不存在: {scene_id}")

    ha_url = settings.HA_BASE_URL
    ha_token = settings.HA_TOKEN
    results = []

    async with httpx.AsyncClient(timeout=10) as client:
        # 1. 执行注入
        for inj in scene.get("injections", []):
            try:
                await client.post(
                    f"{ha_url}/api/states/{inj['entity_id']}",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json={"state": inj["value"], "attributes": {"unit_of_measurement": _get_unit(inj["entity_id"])}},
                )
                results.append({"entity_id": inj["entity_id"], "success": True})
            except Exception as e:
                results.append({"entity_id": inj["entity_id"], "success": False, "error": str(e)})

        # 2. 执行控制
        for ctrl in scene.get("controls", []):
            try:
                domain, svc = ctrl["service"].split(".", 1)
                payload = {"entity_id": ctrl["entity_id"], **ctrl.get("data", {})}
                await client.post(
                    f"{ha_url}/api/services/{domain}/{svc}",
                    headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
                    json=payload,
                )
                results.append({"entity_id": ctrl["entity_id"], "success": True})
            except Exception as e:
                results.append({"entity_id": ctrl["entity_id"], "success": False, "error": str(e)})

    _add_log(
        "system", "success",
        f"场景执行：{scene['name']}",
        f"执行了 {len(results)} 个操作",
    )

    return {"success": True, "scene": scene["name"], "results": results}


@router.get("/logs", summary="获取仿真日志")
async def get_logs(
    limit: int = Query(50, le=200),
    log_type: Optional[str] = Query(None),
    user=Depends(get_current_user),
):
    logs = list(_log_queue)
    if log_type:
        logs = [l for l in logs if l["type"] == log_type]
    return {"logs": logs[-limit:], "total": len(logs)}


@router.delete("/logs", summary="清空仿真日志")
async def clear_logs(user=Depends(get_current_user)):
    _log_queue.clear()
    return {"success": True}


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
