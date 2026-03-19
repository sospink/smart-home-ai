"""
AI 对话路由 - 流式对话 / Agent 调用 / 会话管理
"""
from fastapi import APIRouter, Depends
from app.dependencies import get_current_user
from app.schemas.common import ActionResult

router = APIRouter(prefix="/chat", tags=["AI 对话"])


@router.get("/health", summary="对话模块健康检查")
async def health():
    return {"status": "ok", "module": "chat"}


# TODO: POST /completions  - Ollama 流式对话 (SSE)
# TODO: POST /agent         - Dify Chatflow Agent 调用
# TODO: GET  /sessions      - 会话历史列表
# TODO: GET  /sessions/{id} - 单条会话详情
# TODO: DELETE /sessions/{id} - 删除会话
