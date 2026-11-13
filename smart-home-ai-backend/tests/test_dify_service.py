import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from app.services.dify import DifyService, DifyWorkflowRunDetailError


class _AsyncClientContext:
    def __init__(self, client):
        self.client = client

    async def __aenter__(self):
        return self.client

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class _AsyncStreamContext:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class DifyServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_aggregates_stream_without_using_system_proxy(self):
        response = MagicMock()
        response.raise_for_status.return_value = None

        async def iter_lines():
            yield 'data: {"event":"message","task_id":"task-1","message_id":"message-1","conversation_id":"conversation-1","answer":"o"}'
            yield 'data: {"event":"message","answer":"k"}'
            yield 'data: {"event":"message_end","metadata":{"usage":{"total_tokens":2}}}'

        response.aiter_lines = iter_lines
        client = MagicMock()
        client.stream.return_value = _AsyncStreamContext(response)

        with patch(
            "app.services.dify.httpx.AsyncClient",
            return_value=_AsyncClientContext(client),
        ) as async_client:
            result = await DifyService(
                base_url="http://192.168.251.190",
                api_key="test-key",
            ).chat(query="你好", user="test-user")

        async_client.assert_called_once_with(timeout=120, trust_env=False)
        client.stream.assert_called_once()
        self.assertEqual(result["answer"], "ok")
        self.assertEqual(result["message_id"], "message-1")
        self.assertEqual(result["conversation_id"], "conversation-1")
        self.assertEqual(result["metadata"]["usage"]["total_tokens"], 2)

    async def test_chat_surfaces_failed_workflow_error(self):
        service = DifyService(base_url="http://192.168.251.190", api_key="test-key")

        async def failed_stream(**kwargs):
            yield 'data: {"event":"workflow_finished","data":{"status":"failed","error":"后端地址不可达"}}\n\n'

        with patch.object(service, "chat_stream", failed_stream):
            with self.assertRaisesRegex(RuntimeError, "后端地址不可达"):
                await service.chat(query="测试", user="test-user")

    async def test_workflow_detail_translates_upstream_server_error(self):
        request = httpx.Request("GET", "http://dify.local/v1/workflows/run/run-1")
        response = httpx.Response(500, request=request, json={"message": "Internal Server Error"})
        client = AsyncMock()
        client.get.return_value = response

        with patch(
            "app.services.dify.httpx.AsyncClient",
            return_value=_AsyncClientContext(client),
        ):
            with self.assertRaisesRegex(DifyWorkflowRunDetailError, "平台保存的消息与运行证据仍可查看") as caught:
                await DifyService(base_url="http://dify.local", api_key="test-key").get_workflow_run_detail("run-1")

        self.assertEqual(caught.exception.upstream_status, 500)

    async def test_workflow_detail_rejects_non_object_payload(self):
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = []
        client = AsyncMock()
        client.get.return_value = response

        with patch(
            "app.services.dify.httpx.AsyncClient",
            return_value=_AsyncClientContext(client),
        ):
            with self.assertRaisesRegex(DifyWorkflowRunDetailError, "返回格式异常"):
                await DifyService(base_url="http://dify.local", api_key="test-key").get_workflow_run_detail("run-1")


if __name__ == "__main__":
    unittest.main()
