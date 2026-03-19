"""
Dify API 服务封装 - 智能体编排
"""
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

    async def chat(self, query: str, user: str, conversation_id: str = "") -> dict:
        """调用 Dify Chatflow 对话"""
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
