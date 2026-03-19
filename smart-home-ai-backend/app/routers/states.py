"""
状态查询路由 - 实时状态快照 / 传感器数据 / 系统汇总
"""
from fastapi import APIRouter, Depends
from app.dependencies import get_current_user

router = APIRouter(prefix="/states", tags=["状态查询"])


@router.get("/health", summary="状态模块健康检查")
async def health():
    return {"status": "ok", "module": "states"}


# TODO: GET /realtime  - 所有设备实时状态快照
# TODO: GET /sensors   - 传感器数据列表
# TODO: GET /summary   - 系统状态汇总（用于监控大屏）
