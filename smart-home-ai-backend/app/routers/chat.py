"""
AI 对话路由 - 流式对话 (SSE) / 会话管理
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from app.dependencies import get_current_user
from app.services.dify import dify_service

router = APIRouter(prefix="/chat", tags=["AI 对话"])


# ── Schemas ──

class ChatRequest(BaseModel):
    query: str
    conversation_id: Optional[str] = ""


class StopRequest(BaseModel):
    task_id: str


# ── 健康检查 ──

@router.get("/health", summary="对话模块健康检查")
async def health():
    return {"status": "ok", "module": "chat"}


# ── 流式对话 (SSE) ──

@router.post("/completions", summary="AI 流式对话")
async def chat_completions(
    body: ChatRequest,
    current_user=Depends(get_current_user),
):
    """
    调用 Dify Chatflow API 进行流式对话
    返回 text/event-stream，前端通过 EventSource / fetch 消费
    """
    user_id = f"user-{current_user['user_id']}"

    async def event_generator():
        try:
            async for chunk in dify_service.chat_stream(
                query=body.query,
                user=user_id,
                conversation_id=body.conversation_id or "",
            ):
                yield chunk
        except Exception as e:
            import json, traceback
            traceback.print_exc()
            error_data = json.dumps({"event": "error", "message": str(e) or repr(e)})
            yield f"data: {error_data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── 阻塞式对话（备用） ──

@router.post("/blocking", summary="AI 阻塞式对话")
async def chat_blocking(
    body: ChatRequest,
    current_user=Depends(get_current_user),
):
    """调用 Dify Chatflow API — 阻塞模式，返回完整回复"""
    user_id = f"user-{current_user['user_id']}"
    try:
        result = await dify_service.chat(
            query=body.query,
            user=user_id,
            conversation_id=body.conversation_id or "",
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── 会话列表 ──

@router.get("/conversations", summary="获取会话列表")
async def get_conversations(
    last_id: str = Query("", description="分页游标"),
    limit: int = Query(20, ge=1, le=100),
    current_user=Depends(get_current_user),
):
    user_id = f"user-{current_user['user_id']}"
    try:
        return await dify_service.get_conversations(
            user=user_id, last_id=last_id, limit=limit
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── 会话历史消息 ──

@router.get("/messages", summary="获取会话历史消息")
async def get_messages(
    conversation_id: str = Query(..., description="会话 ID"),
    first_id: str = Query("", description="分页游标"),
    limit: int = Query(20, ge=1, le=100),
    current_user=Depends(get_current_user),
):
    user_id = f"user-{current_user['user_id']}"
    try:
        return await dify_service.get_messages(
            conversation_id=conversation_id,
            user=user_id,
            first_id=first_id,
            limit=limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── 删除会话 ──

@router.delete("/conversations/{conversation_id}", summary="删除会话")
async def delete_conversation(
    conversation_id: str,
    current_user=Depends(get_current_user),
):
    user_id = f"user-{current_user['user_id']}"
    try:
        await dify_service.delete_conversation(conversation_id, user_id)
        return {"result": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── 停止流式响应 ──

@router.post("/stop", summary="停止流式响应")
async def stop_stream(
    body: StopRequest,
    current_user=Depends(get_current_user),
):
    user_id = f"user-{current_user['user_id']}"
    try:
        await dify_service.stop_stream(body.task_id, user_id)
        return {"result": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
