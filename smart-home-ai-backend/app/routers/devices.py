"""
设备控制路由 - 设备列表 / 状态 / 控制 / 历史数据
"""
from fastapi import APIRouter, Depends
from app.dependencies import get_current_user

router = APIRouter(prefix="/devices", tags=["设备控制"])


@router.get("/health", summary="设备模块健康检查")
async def health():
    return {"status": "ok", "module": "devices"}


# TODO: GET  /              - 所有设备列表
# TODO: GET  /{entity_id}   - 单设备实时状态
# TODO: POST /{entity_id}/control - 控制设备
# TODO: GET  /{entity_id}/history - 设备历史数据 (InfluxDB)
# TODO: WS   /stream        - WebSocket 实时状态推送
