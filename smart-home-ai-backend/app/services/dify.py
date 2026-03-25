"""
Dify API 服务封装 - 智能体编排
支持流式(SSE) + 阻塞两种模式
"""
import json
from typing import AsyncGenerator, Optional
import httpx
from app.config import settings


class DifyService:
    def __init__(self):
        self.base_url = settings.DIFY_BASE_URL
        self.api_key = settings.DIFY_API_KEY

    @property
    def headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    # ── 流式对话 (SSE) ──
    async def chat_stream(
        self,
        query: str,
        user: str,
        conversation_id: str = "",
    ) -> AsyncGenerator[str, None]:
        """调用 Dify Chatflow 对话 — 流式 SSE"""
        payload = {
            "inputs": {},
            "query": query,
            "response_mode": "streaming",
            "user": user,
        }
        if conversation_id:
            payload["conversation_id"] = conversation_id

        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/v1/chat-messages",
                headers=self.headers,
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.startswith("data:"):
                        yield line + "\n\n"

    # ── 阻塞式对话 ──
    async def chat(
        self,
        query: str,
        user: str,
        conversation_id: str = "",
    ) -> dict:
        """调用 Dify Chatflow 对话 — 阻塞模式"""
        async with httpx.AsyncClient(timeout=60) as client:
            payload = {
                "inputs": {},
                "query": query,
                "response_mode": "blocking",
                "user": user,
            }
            if conversation_id:
                payload["conversation_id"] = conversation_id
            r = await client.post(
                f"{self.base_url}/v1/chat-messages",
                headers=self.headers,
                json=payload,
            )
            r.raise_for_status()
            return r.json()

    # ── 会话列表 ──
    async def get_conversations(
        self,
        user: str,
        last_id: str = "",
        limit: int = 20,
        sort_by: str = "-updated_at",
    ) -> dict:
        """获取用户的会话列表"""
        async with httpx.AsyncClient(timeout=30) as client:
            params = {"user": user, "limit": limit, "sort_by": sort_by}
            if last_id:
                params["last_id"] = last_id
            r = await client.get(
                f"{self.base_url}/v1/conversations",
                headers=self.headers,
                params=params,
            )
            r.raise_for_status()
            return r.json()

    # ── 会话历史消息 ──
    async def get_messages(
        self,
        conversation_id: str,
        user: str,
        first_id: str = "",
        limit: int = 20,
    ) -> dict:
        """获取会话的历史消息"""
        async with httpx.AsyncClient(timeout=30) as client:
            params = {
                "conversation_id": conversation_id,
                "user": user,
                "limit": limit,
            }
            if first_id:
                params["first_id"] = first_id
            r = await client.get(
                f"{self.base_url}/v1/messages",
                headers=self.headers,
                params=params,
            )
            r.raise_for_status()
            return r.json()

    # ── 删除会话 ──
    async def delete_conversation(self, conversation_id: str, user: str) -> None:
        """删除会话"""
        import json
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.request(
                "DELETE",
                f"{self.base_url}/v1/conversations/{conversation_id}",
                headers={**self.headers, "Content-Type": "application/json"},
                content=json.dumps({"user": user}),
            )
            r.raise_for_status()

    # ── 停止响应 ──
    async def stop_stream(self, task_id: str, user: str) -> None:
        """停止流式响应"""
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{self.base_url}/v1/chat-messages/{task_id}/stop",
                headers=self.headers,
                json={"user": user},
            )
            r.raise_for_status()

    # ── 运行 Workflow ──
    async def run_workflow(self, inputs: dict, user: str) -> dict:
        """运行 Dify Workflow"""
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{self.base_url}/v1/workflows/run",
                headers=self.headers,
                json={"inputs": inputs, "response_mode": "blocking", "user": user},
            )
            r.raise_for_status()
            return r.json()


dify_service = DifyService()
