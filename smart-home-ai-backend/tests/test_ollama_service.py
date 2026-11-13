import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.ollama import OllamaService


class _AsyncClientContext:
    def __init__(self, client):
        self.client = client

    async def __aenter__(self):
        return self.client

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class OllamaServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_list_models_does_not_use_system_proxy(self):
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"models": [{"name": "deepseek-r1:1.5b"}]}
        client = AsyncMock()
        client.get.return_value = response

        with patch(
            "app.services.ollama.httpx.AsyncClient",
            return_value=_AsyncClientContext(client),
        ) as async_client:
            models = await OllamaService("http://localhost:11434").list_models()

        async_client.assert_called_once_with(timeout=10, trust_env=False)
        client.get.assert_awaited_once_with("http://localhost:11434/api/tags")
        self.assertEqual(models, [{"name": "deepseek-r1:1.5b"}])


if __name__ == "__main__":
    unittest.main()
