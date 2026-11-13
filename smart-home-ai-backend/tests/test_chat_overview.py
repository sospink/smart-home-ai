import asyncio
import unittest
import httpx
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.routers.chat import (
    _agent_overview_cache,
    _build_agent_runtime_overview,
    _record_usage_tokens,
    _unpack_probe_result,
    agent_runtime_overview,
)


class _QueryResult:
    def __init__(self, rows=None):
        self._rows = rows or []

    def all(self):
        return self._rows


class ChatOverviewTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _agent_overview_cache.clear()

    def test_usage_tokens_supports_dify_total_tokens(self):
        self.assertEqual(_record_usage_tokens({"usage": {"total_tokens": 37}}), 37)
        self.assertEqual(_record_usage_tokens({"usage": {"total_token": 12.8}}), 12)
        self.assertIsNone(_record_usage_tokens({"usage": "invalid"}))
        self.assertIsNone(_record_usage_tokens({"usage": {}}))

    def test_probe_result_treats_connect_timeout_as_local_failure(self):
        fallback = {"items": [], "stats": {}}
        payload, latency, error = _unpack_probe_result(
            httpx.ConnectTimeout("Dify 连接超时"),
            fallback,
        )
        self.assertIs(payload, fallback)
        self.assertIsNone(latency)
        self.assertIn("连接超时", error)

    def test_probe_result_rejects_malformed_latency(self):
        fallback = {"data": [], "total": 0}
        payload, latency, error = _unpack_probe_result(({"data": [{}]}, "unknown"), fallback)
        self.assertIs(payload, fallback)
        self.assertIsNone(latency)
        self.assertIn("探测未完成", error)

    def test_probe_result_classifies_http_error_without_leaking_response(self):
        request = httpx.Request("GET", "http://192.168.34.190/v1/messages")
        response = httpx.Response(401, request=request, text="secret upstream body")
        error = httpx.HTTPStatusError("401 from private upstream", request=request, response=response)

        payload, latency, message = _unpack_probe_result(error, {})

        self.assertEqual(payload, {})
        self.assertIsNone(latency)
        self.assertEqual(message, "服务可达，但访问凭证未通过验证")
        self.assertNotIn("192.168", message)
        self.assertNotIn("secret", message)

    async def test_unconfigured_services_are_not_probed(self):
        instance = SimpleNamespace(
            id=7,
            name="默认智能体",
            default_model="qwen3-max",
            dify_api_key="",
            instance_type="chatflow",
            knowledge_bindings=[],
        )
        services = SimpleNamespace(
            config=SimpleNamespace(
                dify_api_key="",
                dify_dataset_api_key="",
                ha_base_url="http://ha:8123",
                ha_token="",
            ),
            dify_knowledge=AsyncMock(),
            homeassistant=AsyncMock(),
        )
        dify = AsyncMock()
        db = AsyncMock()
        db.execute.return_value = _QueryResult([])

        with (
            patch("app.routers.chat.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.chat.get_default_chat_agent", AsyncMock(return_value=instance)),
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
            patch("app.routers.chat.httpx.AsyncClient") as client,
        ):
            payload = await _build_agent_runtime_overview(db, {"user_id": 1})

        self.assertEqual([item["status"] for item in payload["services"]], ["unconfigured"] * 3)
        self.assertTrue(all(item["latency_ms"] is None for item in payload["services"]))
        dify.get_conversation_records.assert_not_awaited()
        services.dify_knowledge.list_datasets.assert_not_awaited()
        services.homeassistant.check_health.assert_not_awaited()
        client.assert_not_called()

    async def test_overview_uses_null_rate_without_feedback(self):
        instance = SimpleNamespace(
            id=7,
            name="00 Smart Home Unified Chatflow",
            default_model="qwen3-max",
            dify_api_key="configured",
            instance_type="chatflow",
            knowledge_bindings=["智慧家居"],
        )
        dify = AsyncMock()
        dify.get_conversation_records.return_value = {
            "items": [{"conversation_id": "conversation-1", "created_at": 1785280000, "usage": {"total_tokens": 9}}],
            "stats": {"conversation_count": 99, "message_count": 99},
            "_meta": {"conversation_count_loaded": 1},
        }
        services = SimpleNamespace(
            dify_knowledge=AsyncMock(),
            homeassistant=AsyncMock(),
        )
        services.dify_knowledge.list_datasets.return_value = {"data": [{}], "total": 1}
        services.homeassistant.check_health.return_value = True
        db = AsyncMock()
        db.execute.return_value = _QueryResult([])

        with (
            patch("app.routers.chat.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.chat.get_default_chat_agent", AsyncMock(return_value=instance)),
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
        ):
            payload = await _build_agent_runtime_overview(db, {"user_id": 1})

        self.assertIsNone(payload["metrics"]["positive_feedback_rate"])
        self.assertEqual(payload["metrics"]["total_tokens"], 9)
        self.assertEqual(payload["coverage"]["token_message_count"], 1)
        self.assertTrue(payload["coverage"]["token_coverage_complete"])
        self.assertEqual(payload["metrics"]["conversation_count"], 1)
        self.assertEqual(payload["metrics"]["message_count"], 1)
        self.assertTrue(payload["coverage"]["complete"])
        self.assertTrue(payload["coverage"]["dify_records_available"])
        self.assertTrue(payload["coverage"]["dify_metrics_complete"])
        self.assertTrue(payload["coverage"]["knowledge_available"])
        self.assertTrue(payload["coverage"]["home_assistant_available"])
        self.assertEqual(payload["agent"]["name"], "智慧空间智能体")
        self.assertEqual(payload["agent"]["runtime_name"], "00 Smart Home Unified Chatflow")
        self.assertEqual(payload["agent"]["model"], "qwen3-max")
        self.assertTrue(all(item["status"] == "running" for item in payload["services"]))
        ha_service = next(item for item in payload["services"] if item["key"] == "home_assistant")
        self.assertEqual(ha_service["detail"], "状态读取与命令下发接口可用")

    async def test_external_service_errors_degrade_instead_of_raising(self):
        instance = SimpleNamespace(
            id=7,
            name="默认智能体",
            default_model="qwen3-max",
            dify_api_key="configured",
            instance_type="chatflow",
            knowledge_bindings=[],
        )
        dify = AsyncMock()
        dify.get_conversation_records.side_effect = RuntimeError("Dify 不可达")
        services = SimpleNamespace(
            dify_knowledge=AsyncMock(),
            homeassistant=AsyncMock(),
        )
        services.dify_knowledge.list_datasets.side_effect = RuntimeError("Dataset 不可达")
        services.homeassistant.check_health.side_effect = RuntimeError("HA 不可达")
        db = AsyncMock()
        db.execute.return_value = _QueryResult([])

        with (
            patch("app.routers.chat.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.chat.get_default_chat_agent", AsyncMock(return_value=instance)),
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
        ):
            payload = await _build_agent_runtime_overview(db, {"user_id": 1})

        self.assertEqual(payload["agent"]["status"], "degraded")
        self.assertEqual([item["status"] for item in payload["services"]], ["error", "error", "error"])
        self.assertIn("Dify 不可达", payload["services"][0]["error"])
        self.assertFalse(payload["coverage"]["complete"])
        self.assertFalse(payload["coverage"]["dify_records_available"])
        self.assertFalse(payload["coverage"]["dify_metrics_complete"])
        self.assertFalse(payload["coverage"]["knowledge_available"])
        self.assertFalse(payload["coverage"]["home_assistant_available"])
        self.assertNotIn("Server disconnected", payload["services"][0]["error"])
        for key in (
            "conversation_count",
            "message_count",
            "feedback_count",
            "positive_feedback_count",
            "negative_feedback_count",
            "positive_feedback_rate",
            "retrieval_message_count",
            "retrieval_segment_count",
            "total_tokens",
        ):
            self.assertIsNone(payload["metrics"][key])
        self.assertEqual(payload["metrics"]["device_control_count"], 0)
        self.assertEqual(payload["metrics"]["local_run_count"], 0)

    async def test_missing_usage_is_unknown_instead_of_zero(self):
        instance = SimpleNamespace(
            id=7,
            name="默认智能体",
            default_model="qwen3-max",
            dify_api_key="configured",
            instance_type="chatflow",
            knowledge_bindings=[],
        )
        dify = AsyncMock()
        dify.get_conversation_records.return_value = {
            "items": [
                {"conversation_id": "conversation-1", "created_at": 1785280000},
                {"conversation_id": "conversation-1", "created_at": 1785280001},
            ],
            "_meta": {"conversation_count_loaded": 1},
        }
        services = SimpleNamespace(dify_knowledge=AsyncMock(), homeassistant=AsyncMock())
        services.dify_knowledge.list_datasets.return_value = {"data": [], "total": 0}
        services.homeassistant.check_health.return_value = True
        db = AsyncMock()
        db.execute.return_value = _QueryResult([])

        with (
            patch("app.routers.chat.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.chat.get_default_chat_agent", AsyncMock(return_value=instance)),
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
        ):
            payload = await _build_agent_runtime_overview(db, {"user_id": 1})

        self.assertIsNone(payload["metrics"]["total_tokens"])
        self.assertEqual(payload["coverage"]["token_message_count"], 0)
        self.assertFalse(payload["coverage"]["token_coverage_complete"])
        self.assertTrue(payload["coverage"]["dify_metrics_complete"])
        self.assertFalse(payload["coverage"]["complete"])

    async def test_default_agent_can_use_system_runtime_key(self):
        instance = SimpleNamespace(
            id=7,
            name="默认智能体",
            default_model="qwen3-max",
            dify_api_key="",
            instance_type="chatflow",
            knowledge_bindings=[],
        )
        dify = AsyncMock()
        dify.get_conversation_records.return_value = {"items": [], "_meta": {}}
        services = SimpleNamespace(
            config=SimpleNamespace(dify_api_key="system-runtime-key"),
            dify_knowledge=AsyncMock(),
            homeassistant=AsyncMock(),
        )
        services.dify_knowledge.list_datasets.return_value = {"data": [], "total": 0}
        services.homeassistant.check_health.return_value = True
        db = AsyncMock()
        db.execute.return_value = _QueryResult([])

        with (
            patch("app.routers.chat.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.chat.get_default_chat_agent", AsyncMock(return_value=instance)),
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
        ):
            payload = await _build_agent_runtime_overview(db, {"user_id": 1})

        self.assertEqual(payload["agent"]["status"], "running")

    async def test_partial_external_sources_degrade_status_and_coverage(self):
        instance = SimpleNamespace(
            id=7,
            name="默认智能体",
            default_model="qwen3-max",
            dify_api_key="configured",
            instance_type="chatflow",
            knowledge_bindings=[],
        )
        dify = AsyncMock()
        dify.get_conversation_records.return_value = {"items": [], "_meta": {}}
        services = SimpleNamespace(
            config=SimpleNamespace(dify_api_key="configured"),
            dify_knowledge=AsyncMock(),
            homeassistant=AsyncMock(),
        )
        services.dify_knowledge.list_datasets.side_effect = RuntimeError("Dataset 不可达")
        services.homeassistant.check_health.return_value = False
        db = AsyncMock()
        db.execute.return_value = _QueryResult([])

        with (
            patch("app.routers.chat.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.chat.get_default_chat_agent", AsyncMock(return_value=instance)),
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
        ):
            payload = await _build_agent_runtime_overview(db, {"user_id": 1})

        self.assertEqual(payload["agent"]["status"], "degraded")
        self.assertFalse(payload["coverage"]["complete"])
        self.assertTrue(payload["coverage"]["dify_records_available"])
        self.assertFalse(payload["coverage"]["knowledge_available"])
        self.assertFalse(payload["coverage"]["home_assistant_available"])

    async def test_overview_probe_timeout_returns_partial_payload(self):
        instance = SimpleNamespace(
            id=7,
            name="默认智能体",
            default_model="qwen3-max",
            dify_api_key="configured",
            instance_type="chatflow",
            knowledge_bindings=[],
        )
        dify = AsyncMock()
        dify.get_conversation_records.side_effect = asyncio.TimeoutError()
        services = SimpleNamespace(
            config=SimpleNamespace(dify_api_key="configured"),
            dify_knowledge=AsyncMock(),
            homeassistant=AsyncMock(),
        )
        services.dify_knowledge.list_datasets.return_value = {"data": [], "total": 0}
        services.homeassistant.check_health.return_value = True
        db = AsyncMock()
        db.execute.return_value = _QueryResult([("agent_control", "success", 2, None)])

        with (
            patch("app.routers.chat.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.chat.get_default_chat_agent", AsyncMock(return_value=instance)),
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
        ):
            payload = await _build_agent_runtime_overview(db, {"user_id": 1})

        self.assertFalse(payload["coverage"]["dify_records_available"])
        self.assertIsNone(payload["metrics"]["positive_feedback_rate"])
        self.assertEqual(payload["metrics"]["device_control_count"], 2)
        self.assertEqual(payload["services"][0]["status"], "stopped")

    async def test_overview_marks_truncated_dify_snapshot_as_partial(self):
        instance = SimpleNamespace(
            id=7,
            name="默认智能体",
            default_model="qwen3-max",
            dify_api_key="configured",
            instance_type="chatflow",
            knowledge_bindings=[],
        )
        dify = AsyncMock()
        dify.get_conversation_records.return_value = {
            "items": [
                {"conversation_id": "conversation-1", "created_at": 1785280000},
                {"conversation_id": "conversation-1", "created_at": 1785280001},
            ],
            "_meta": {
                "conversation_count_loaded": 50,
                "conversation_has_more": True,
                "message_truncated_conversations": 1,
                "message_load_error_count": 0,
            },
        }
        services = SimpleNamespace(dify_knowledge=AsyncMock(), homeassistant=AsyncMock())
        services.dify_knowledge.list_datasets.return_value = {"data": [], "total": 0}
        services.homeassistant.check_health.return_value = True
        db = AsyncMock()
        db.execute.return_value = _QueryResult([])

        with (
            patch("app.routers.chat.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.chat.get_default_chat_agent", AsyncMock(return_value=instance)),
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
        ):
            payload = await _build_agent_runtime_overview(db, {"user_id": 1})

        self.assertEqual(payload["metrics"]["conversation_count"], 1)
        self.assertEqual(payload["metrics"]["message_count"], 2)
        self.assertFalse(payload["coverage"]["complete"])
        self.assertTrue(payload["coverage"]["conversation_has_more"])
        self.assertFalse(payload["coverage"]["dify_metrics_complete"])
        self.assertEqual(payload["coverage"]["message_truncated_conversations"], 1)

    async def test_endpoint_returns_cached_payload(self):
        payload = {"agent": {"name": "默认智能体"}, "generated_at": "now"}
        with patch("app.routers.chat._build_agent_runtime_overview", AsyncMock(return_value=payload)) as builder:
            first = await agent_runtime_overview(
                refresh=False,
                current_user={"user_id": 9},
                db=AsyncMock(),
            )
            second = await agent_runtime_overview(
                refresh=False,
                current_user={"user_id": 9},
                db=AsyncMock(),
            )

        self.assertEqual(first["cache"], "miss")
        self.assertEqual(second["cache"], "hit")
        builder.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
