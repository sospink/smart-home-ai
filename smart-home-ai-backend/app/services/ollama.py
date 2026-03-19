"""
Ollama 服务封装 - LLM 推理
"""
from ollama import AsyncClient
from app.config import settings


class OllamaService:
    def __init__(self):
        self.client = AsyncClient(host=settings.OLLAMA_BASE_URL)

    async def list_models(self) -> list:
        """获取已安装模型列表"""
        result = await self.client.list()
        return result.get("models", [])

    async def chat_stream(self, model: str, messages: list):
        """流式对话，返回异步生成器"""
        async for chunk in await self.client.chat(
            model=model,
            messages=messages,
            stream=True,
        ):
            content = chunk.get("message", {}).get("content", "")
            if content:
                yield content

    async def generate(self, model: str, prompt: str) -> str:
        """非流式文本生成"""
        response = await self.client.generate(model=model, prompt=prompt)
        return response.get("response", "")

    async def model_status(self) -> list:
        """获取当前运行中的模型和显存占用"""
        result = await self.client.ps()
        return result.get("models", [])


ollama_service = OllamaService()
