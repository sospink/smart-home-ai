"""
电子沙盘路由 - 虚拟设备列表 / 控制 / 场景
"""
from fastapi import APIRouter, Depends
from app.dependencies import get_current_user

router = APIRouter(prefix="/sandbox", tags=["电子沙盘"])


@router.get("/health", summary="沙盘模块健康检查")
async def health():
    return {"status": "ok", "module": "sandbox"}


# TODO: GET  /devices            - 虚拟设备列表与状态
# TODO: POST /devices/{id}/control - 控制虚拟设备
# TODO: GET  /scenes             - 预设场景列表
