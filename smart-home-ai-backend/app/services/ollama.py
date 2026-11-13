"""
Ollama 服务封装 - 直接通过 REST API 调用（httpx）
参考: https://docs.ollama.com/api/introduction

Endpoints:
  GET  /api/tags         — 模型列表
  POST /api/show         — 模型详情
  POST /api/pull         — 拉取模型 (stream)
  DELETE /api/delete      — 删除模型
  GET  /api/ps           — 运行中模型
  POST /api/generate     — 文本生成
  POST /api/chat         — 对话
  POST /api/embed        — Embedding
  GET  /api/version      — 版本信息
"""
import httpx
import json
from typing import AsyncIterator, Optional
from app.config import settings


def _extract_ollama_error(response: httpx.Response) -> str:
    """提取 Ollama 原始错误，避免只暴露 HTTP 500。"""
    try:
        data = response.json()
        if isinstance(data, dict) and data.get("error"):
            return str(data["error"])
    except Exception:
        pass
    text = response.text.strip()
    return text or f"HTTP {response.status_code}"


class OllamaService:
    def __init__(self, base_url: Optional[str] = None):
        self.base_url = (base_url or settings.OLLAMA_BASE_URL).rstrip("/")

    # ══════════════════════════════════════════════
    #  模型管理 API
    # ══════════════════════════════════════════════

    async def list_models(self) -> list:
        """GET /api/tags — 获取已安装模型列表"""
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            r = await client.get(f"{self.base_url}/api/tags")
            r.raise_for_status()
            return r.json().get("models", [])

    async def show_model(self, name: str) -> dict:
        """POST /api/show — 获取模型详情"""
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            r = await client.post(
                f"{self.base_url}/api/show",
                json={"model": name},
            )
            r.raise_for_status()
            return r.json()

    async def pull_model(self, name: str) -> AsyncIterator[dict]:
        """POST /api/pull — 拉取模型（流式进度）"""
        async with httpx.AsyncClient(timeout=600, trust_env=False) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/api/pull",
                json={"model": name, "stream": True},
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.strip():
                        try:
                            yield json.loads(line)
                        except json.JSONDecodeError:
                            continue

    async def delete_model(self, name: str) -> None:
        """DELETE /api/delete — 删除模型"""
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            r = await client.request(
                "DELETE",
                f"{self.base_url}/api/delete",
                json={"model": name},
            )
            r.raise_for_status()

    async def running_models(self) -> list:
        """GET /api/ps — 获取运行中的模型"""
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            r = await client.get(f"{self.base_url}/api/ps")
            r.raise_for_status()
            return r.json().get("models", [])

    async def copy_model(self, source: str, destination: str) -> None:
        """POST /api/copy — 复制模型（创建别名/标签）"""
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            r = await client.post(
                f"{self.base_url}/api/copy",
                json={"source": source, "destination": destination},
            )
            r.raise_for_status()

    async def get_version(self) -> str:
        """GET /api/version — 获取 Ollama 版本"""
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            r = await client.get(f"{self.base_url}/api/version")
            r.raise_for_status()
            return r.json().get("version", "unknown")

    # ══════════════════════════════════════════════
    #  推理 API
    # ══════════════════════════════════════════════

    async def chat_stream(self, model: str, messages: list) -> AsyncIterator[str]:
        """POST /api/chat — 流式对话"""
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/api/chat",
                json={"model": model, "messages": messages, "stream": True},
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.strip():
                        try:
                            data = json.loads(line)
                            content = data.get("message", {}).get("content", "")
                            if content:
                                yield content
                        except json.JSONDecodeError:
                            continue

    async def generate(self, model: str, prompt: str, stream: bool = False) -> str:
        """POST /api/generate — 文本生成（非流式）"""
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            r = await client.post(
                f"{self.base_url}/api/generate",
                json={"model": model, "prompt": prompt, "stream": stream},
            )
            try:
                r.raise_for_status()
            except httpx.HTTPStatusError as e:
                raise RuntimeError(_extract_ollama_error(e.response)) from e
            return r.json().get("response", "")

    async def embed(self, model: str, input_text: str) -> list:
        """POST /api/embed — 生成 Embedding"""
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            r = await client.post(
                f"{self.base_url}/api/embed",
                json={"model": model, "input": input_text},
            )
            r.raise_for_status()
            return r.json().get("embeddings", [])

    # ══════════════════════════════════════════════
    #  健康检查
    # ══════════════════════════════════════════════

    async def check_health(self) -> bool:
        """检查 Ollama 是否在线"""
        try:
            async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
                r = await client.get(f"{self.base_url}/api/version")
                return r.status_code == 200
        except Exception:
            return False


ollama_service = OllamaService()
