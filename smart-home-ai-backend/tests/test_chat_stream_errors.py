import asyncio
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from pydantic import ValidationError

from app.routers.chat import (
    CHAT_FEEDBACK_MAX_LENGTH,
    CHAT_QUERY_MAX_LENGTH,
    CHAT_STREAM_HEARTBEAT_SECONDS,
    ChatRequest,
    FeedbackRequest,
    _chat_stream_error_message,
    _chat_stream_with_heartbeat,
    _dify_api_error,
    _sanitize_chat_stream_chunk,
    submit_feedback,
)


class ChatInputContractTests(unittest.TestCase):
    def test_chat_query_rejects_blank_and_oversized_content(self):
        for query in ("   ", "x" * (CHAT_QUERY_MAX_LENGTH + 1)):
            with self.subTest(length=len(query)):
                with self.assertRaises(ValidationError):
                    ChatRequest(query=query)

    def test_chat_query_accepts_exact_limit(self):
        request = ChatRequest(query="x" * CHAT_QUERY_MAX_LENGTH)

        self.assertEqual(len(request.query), CHAT_QUERY_MAX_LENGTH)

    def test_conversation_id_rejects_more_than_256_characters(self):
        with self.assertRaises(ValidationError):
            ChatRequest(query="测试", conversation_id="x" * 257)

    def test_feedback_rejects_unknown_rating_and_oversized_content(self):
        with self.assertRaises(ValidationError):
            FeedbackRequest(rating="neutral")
        with self.assertRaises(ValidationError):
            FeedbackRequest(rating="like", content="x" * (CHAT_FEEDBACK_MAX_LENGTH + 1))

    def test_feedback_accepts_exact_content_limit(self):
        request = FeedbackRequest(rating="like", content="x" * CHAT_FEEDBACK_MAX_LENGTH)

        self.assertEqual(len(request.content or ""), CHAT_FEEDBACK_MAX_LENGTH)


class ChatStreamErrorMessageTests(unittest.TestCase):
    def test_timeout_and_network_errors_are_actionable(self):
        request = httpx.Request("POST", "http://dify.local/v1/chat-messages")

        self.assertIn("响应超时", _chat_stream_error_message(httpx.ReadTimeout("timeout", request=request)))
        self.assertIn("无法连接 Dify", _chat_stream_error_message(httpx.ConnectError("connection refused", request=request)))

    def test_http_status_errors_do_not_leak_upstream_payload(self):
        expected = {
            401: "应用认证失败",
            403: "应用认证失败",
            429: "请求过于频繁",
            500: "服务暂时异常",
            422: "HTTP 422",
        }
        for status_code, phrase in expected.items():
            with self.subTest(status_code=status_code):
                request = httpx.Request("POST", "http://dify.local/v1/chat-messages")
                response = httpx.Response(status_code, request=request, text="internal upstream detail")
                error = httpx.HTTPStatusError("raw upstream error", request=request, response=response)
                message = _chat_stream_error_message(error)
                self.assertIn(phrase, message)
                self.assertNotIn("internal upstream detail", message)
                self.assertNotIn("dify.local", message)

    def test_business_chinese_error_is_preserved_but_technical_text_is_hidden(self):
        self.assertEqual(
            _chat_stream_error_message(RuntimeError("工作流节点配置不完整，请联系管理员")),
            "工作流节点配置不完整，请联系管理员",
        )
        self.assertEqual(
            _chat_stream_error_message(RuntimeError("Server disconnected without sending a response")),
            "智能体工作流执行失败，请查看运行记录或稍后重试",
        )
        self.assertNotIn(
            "192.168.34.190",
            _chat_stream_error_message(RuntimeError("请求 http://192.168.34.190 失败")),
        )

    def test_dify_failure_events_are_sanitized_but_success_events_are_unchanged(self):
        failed = _sanitize_chat_stream_chunk(
            'data: {"event":"workflow_finished","data":{"status":"failed","error":"Server disconnected from http://192.168.34.190"}}\n\n'
        )
        upstream_error = _sanitize_chat_stream_chunk(
            'data: {"event":"error","message":"Connection refused by http://192.168.34.190"}\n\n'
        )
        succeeded = 'data: {"event":"workflow_finished","data":{"status":"succeeded"}}\n\n'

        self.assertIn("智能体工作流执行失败", failed)
        self.assertIn("智能体工作流执行失败", upstream_error)
        self.assertNotIn("192.168.34.190", failed)
        self.assertNotIn("192.168.34.190", upstream_error)
        self.assertEqual(_sanitize_chat_stream_chunk(succeeded), succeeded)


class ChatApiErrorContractTests(unittest.TestCase):
    def test_non_stream_errors_use_actionable_status_without_leaking_upstream(self):
        request = httpx.Request("GET", "http://192.168.34.190/v1/messages")
        cases = {
            401: (502, "认证失败"),
            404: (404, "不存在"),
            422: (422, "被 Dify 拒绝"),
            429: (503, "请求过于频繁"),
            500: (502, "服务暂时异常"),
        }
        for upstream_status, (expected_status, phrase) in cases.items():
            with self.subTest(upstream_status=upstream_status):
                response = httpx.Response(upstream_status, request=request, text="secret upstream payload")
                error = httpx.HTTPStatusError("raw error", request=request, response=response)
                status_code, message = _dify_api_error(error, "会话消息读取")
                self.assertEqual(status_code, expected_status)
                self.assertIn(phrase, message)
                self.assertNotIn("192.168.34.190", message)
                self.assertNotIn("secret upstream payload", message)

    def test_non_stream_timeout_network_and_technical_errors_are_sanitized(self):
        request = httpx.Request("GET", "http://dify.local/v1/messages")
        timeout_status, timeout_message = _dify_api_error(
            httpx.ReadTimeout("timeout", request=request),
            "会话消息读取",
        )
        network_status, network_message = _dify_api_error(
            httpx.ConnectError("connection refused", request=request),
            "会话消息读取",
        )
        technical_status, technical_message = _dify_api_error(
            RuntimeError("Server disconnected from http://192.168.34.190"),
            "会话消息读取",
        )

        self.assertEqual((timeout_status, network_status, technical_status), (504, 503, 502))
        self.assertIn("超时", timeout_message)
        self.assertIn("无法连接", network_message)
        self.assertNotIn("192.168.34.190", technical_message)


class ChatFeedbackBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_device_message_is_rejected_before_dify_client_creation(self):
        dify_factory = AsyncMock()
        with patch("app.routers.chat._get_dify_for_chat", dify_factory):
            with self.assertRaises(HTTPException) as caught:
                await submit_feedback(
                    "local-control-test",
                    FeedbackRequest(rating="like"),
                    {"user_id": 1},
                    AsyncMock(),
                )

        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("本地设备操作", caught.exception.detail)
        dify_factory.assert_not_awaited()


class ChatStreamHeartbeatTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_upstream_emits_comment_without_losing_real_event(self):
        async def source():
            await asyncio.sleep(0.03)
            yield 'data: {"event":"message","answer":"完成"}\n\n'

        stream = _chat_stream_with_heartbeat(source(), heartbeat_seconds=0.005)
        received = []
        async for chunk in stream:
            received.append(chunk)

        self.assertEqual(CHAT_STREAM_HEARTBEAT_SECONDS, 15.0)
        self.assertIn(": keep-alive\n\n", received)
        self.assertEqual(received[-1], 'data: {"event":"message","answer":"完成"}\n\n')


class ChatFrontendStreamLifecycleTests(unittest.TestCase):
    def test_stream_connection_has_timeout_abort_and_cleanup_contract(self):
        frontend_source = (
            Path(__file__).resolve().parents[2]
            / "smart-home-ai-frontend"
            / "lib"
            / "api"
            / "chat.ts"
        ).read_text(encoding="utf-8")

        self.assertIn("const requestController = new AbortController()", frontend_source)
        self.assertIn("signal?.addEventListener('abort', handleExternalAbort, { once: true })", frontend_source)
        self.assertIn("}, CHAT_WRITE_TIMEOUT_MS)", frontend_source)
        self.assertIn("智能体服务 20 秒内未建立响应连接", frontend_source)
        self.assertIn("signal?.removeEventListener('abort', handleExternalAbort)", frontend_source)

    def test_conversation_append_failure_does_not_invalidate_the_loaded_directory(self):
        frontend_source = (
            Path(__file__).resolve().parents[2]
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "chat"
            / "page.tsx"
        ).read_text(encoding="utf-8")

        self.assertIn("const [conversationMoreError, setConversationMoreError]", frontend_source)
        self.assertIn("setConversationMoreError(res.external_service_error)", frontend_source)
        self.assertIn("setConversationSnapshotAt(writeConversationSnapshot(merged, nextHasMore))", frontend_source)
        self.assertIn("更早会话未能载入，当前列表仍可正常使用。", frontend_source)
        self.assertIn("conversationMoreError ? '重新加载更多会话' : '加载更多会话'", frontend_source)


if __name__ == "__main__":
    unittest.main()
