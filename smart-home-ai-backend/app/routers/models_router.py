"""
模型管理路由 - 已安装模型 / 拉取 / 删除 / 推理状态
"""
from fastapi import APIRouter, Depends
from app.dependencies import get_current_user, require_admin

router = APIRouter(prefix="/models", tags=["模型管理"])


@router.get("/health", summary="模型模块健康检查")
async def health():
    return {"status": "ok", "module": "models"}


# TODO: GET  /        - 已安装模型列表
# TODO: POST /pull    - 拉取新模型
# TODO: DELETE /{name} - 删除模型
# TODO: GET  /status  - 当前推理状态（显存占用等）
