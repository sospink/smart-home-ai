import unittest
from unittest.mock import AsyncMock, patch

from app.routers.chat import (
    ChatRequest,
    _conversation_record_cache,
    chat_completions,
    get_conversations,
)


class ChatFallbackTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _conversation_record_cache.clear()

    def tearDown(self):
        _conversation_record_cache.clear()

    async def test_conversation_list_degrades_to_empty_when_dify_is_unavailable(self):
        dify = AsyncMock()
        dify.get_conversations.side_effect = RuntimeError("Dify unavailable")

        with patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)):
            result = await get_conversations(
                last_id="",
                limit=50,
                current_user={"user_id": 1},
                db=AsyncMock(),
            )

        self.assertEqual(result["data"], [])
        self.assertFalse(result["has_more"])
        self.assertEqual(result["limit"], 50)
        self.assertIn("Dify", result["external_service_error"])

    async def test_local_chat_stream_reuses_audited_message_id_and_clears_record_cache(self):
        _conversation_record_cache[1] = (0, {"items": [{"message_id": "stale"}]})
        local_result = {
            "message_id": "local-control-stable",
            "answer": "筒灯当前为开启。",
            "source": "local_dynamic_device_status",
            "device_id": "23",
            "entity_id": "light.real",
            "action": "",
            "success": True,
            "confirmation": "confirmed",
        }
        dify_factory = AsyncMock()
        with (
            patch("app.routers.chat.try_execute_device_command", AsyncMock(return_value=local_result)),
            patch("app.routers.chat._get_dify_for_chat", dify_factory),
        ):
            response = await chat_completions(
                ChatRequest(query="筒灯现在是什么状态？"),
                {"user_id": 1, "username": "tester"},
                AsyncMock(),
            )
            chunks = [chunk async for chunk in response.body_iterator]

        text = "".join(chunks)
        self.assertEqual(text.count('"message_id": "local-control-stable"'), 2)
        self.assertIn('"execution_source": "local_dynamic_device_status"', text)
        self.assertNotIn(1, _conversation_record_cache)
        dify_factory.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
