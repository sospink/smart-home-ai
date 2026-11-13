import asyncio
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.routers.chat import (
    _append_agent_runtime_logs,
    _conversation_csv_cell,
    _conversation_record_cache,
    _conversation_record_stats,
    _conversation_record_pending,
    _filter_conversation_record_snapshot,
    _get_conversation_record_snapshot,
    _is_conversation_message,
    _load_conversation_record_snapshot,
    export_conversation_records,
    get_conversation_records,
    get_workflow_run_detail,
)
from app.services.dify import DifyWorkflowRunDetailError


def _conversation_records_frontend_source() -> str:
    project_root = Path(__file__).resolve().parents[2]
    return (
        project_root
        / "smart-home-ai-frontend"
        / "app"
        / "(dashboard)"
        / "conversation-records"
        / "page.tsx"
    ).read_text(encoding="utf-8")


class ConversationRecordsFrontendContractTests(unittest.TestCase):
    def test_first_failure_and_retained_snapshot_use_separate_error_layers(self):
        source = _conversation_records_frontend_source()
        self.assertIn("{loadError && recordsLoaded ? (", source)
        self.assertIn("!recordsLoaded && loadError ? (", source)
        self.assertIn('>{loadError}</p>', source)
        self.assertIn("当前没有可展示的成功快照", source)

    def test_first_failure_retry_has_pending_and_date_guards(self):
        source = _conversation_records_frontend_source()
        self.assertIn("disabled={loading || dateRangeInvalid}", source)
        self.assertIn("loading ? '正在重新读取' : '重新读取记录'", source)
        self.assertIn('role="alert"', source)

    def test_run_list_exposes_truthful_attention_status_without_technical_noise(self):
        source = _conversation_records_frontend_source()
        self.assertIn("function recordPhysicalPending", source)
        self.assertIn("function recordListStatus", source)
        self.assertIn("label: '待复核'", source)
        self.assertIn("label: '待现场确认'", source)
        self.assertIn("label: '正常'", source)
        self.assertIn("const listStatus = activeView === 'runs' ? recordListStatus(item) : null", source)


def _record(
    message_id: str,
    *,
    conversation_id: str = "conversation-1",
    created_at: int = 100,
    rating: str = "",
    workflow_run_id: str = "",
    source: str = "dify_messages",
    answer: str = "回答",
) -> dict:
    return {
        "conversation_id": conversation_id,
        "conversation_name": "测试会话",
        "message_id": message_id,
        "query": f"问题 {message_id}",
        "answer": answer,
        "created_at": created_at,
        "feedback": {"rating": rating} if rating else None,
        "workflow_run_id": workflow_run_id,
        "task_id": "",
        "usage": {},
        "retriever_resources": [],
        "record_source": source,
        "run_status": "节点级运行记录" if workflow_run_id else "消息级运行记录",
    }


class _ScalarResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class ConversationRecordTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _conversation_record_cache.clear()
        _conversation_record_pending.clear()

    def tearDown(self):
        for task in _conversation_record_pending.values():
            task.cancel()
        _conversation_record_cache.clear()
        _conversation_record_pending.clear()

    async def test_workflow_detail_maps_dify_failure_to_upstream_error(self):
        dify = AsyncMock()
        dify.get_workflow_run_detail.side_effect = DifyWorkflowRunDetailError(
            "Dify 工作流详情服务暂时异常，平台保存的消息与运行证据仍可查看",
            500,
        )
        with patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)):
            with self.assertRaises(HTTPException) as caught:
                await get_workflow_run_detail("run-1", {"user_id": 1}, AsyncMock())

        self.assertEqual(caught.exception.status_code, 502)
        self.assertIn("平台保存的消息与运行证据仍可查看", caught.exception.detail)

    def test_filters_cover_view_rating_workflow_time_and_keyword(self):
        snapshot = {
            "items": [
                _record("plain", created_at=100),
                _record("liked", created_at=200, rating="like"),
                _record("workflow", created_at=300, workflow_run_id="run-1"),
                _record("local", created_at=400, source="local_device_control"),
            ]
        }

        feedback = _filter_conversation_record_snapshot(
            snapshot,
            view="feedback",
            keyword="liked",
            rating="like",
            has_workflow_run=None,
            run_kind="",
            start_time=150,
            end_time=250,
        )
        workflow = _filter_conversation_record_snapshot(
            snapshot,
            view="runs",
            keyword="",
            rating="",
            has_workflow_run=True,
            run_kind="",
            start_time=None,
            end_time=None,
        )
        platform_runs = _filter_conversation_record_snapshot(
            snapshot,
            view="runs",
            keyword="local",
            rating="",
            has_workflow_run=False,
            run_kind="",
            start_time=None,
            end_time=None,
        )

        self.assertEqual([item["message_id"] for item in feedback], ["liked"])
        self.assertEqual([item["message_id"] for item in workflow], ["workflow"])
        self.assertEqual([item["message_id"] for item in platform_runs], ["local"])

        device_controls = _filter_conversation_record_snapshot(
            {
                "items": [{
                    **_record("control", source="local_device_control"),
                    "usage": {"type": "agent_control"},
                }]
            },
            view="runs",
            keyword="",
            rating="",
            has_workflow_run=None,
            run_kind="device_control",
            start_time=None,
            end_time=None,
        )
        self.assertEqual([item["message_id"] for item in device_controls], ["control"])

    def test_history_feedback_and_runs_have_distinct_business_semantics(self):
        local_feedback = _record(
            "operation-log-1",
            conversation_id="operation-log-1",
            rating="like",
            source="local_device_control",
        )
        snapshot = {
            "items": [
                _record("plain-message"),
                _record("workflow-message", workflow_run_id="run-1"),
                local_feedback,
                _record("platform-test", source="operation_logs"),
            ]
        }

        history = _filter_conversation_record_snapshot(
            snapshot, view="history", keyword="", rating="",
            has_workflow_run=None, run_kind="", start_time=None, end_time=None,
        )
        runs = _filter_conversation_record_snapshot(
            snapshot, view="runs", keyword="", rating="",
            has_workflow_run=None, run_kind="", start_time=None, end_time=None,
        )
        feedback = _filter_conversation_record_snapshot(
            snapshot, view="feedback", keyword="", rating="",
            has_workflow_run=None, run_kind="", start_time=None, end_time=None,
        )

        self.assertEqual(
            [item["message_id"] for item in history],
            ["plain-message", "workflow-message"],
        )
        self.assertEqual(
            [item["message_id"] for item in runs],
            ["workflow-message", "operation-log-1", "platform-test"],
        )
        self.assertEqual(feedback, [])

    def test_snapshot_marks_feedback_capability_only_for_real_dify_messages(self):
        dify_message = _record("dify-message")
        merged_message = _record("merged-message", source="dify_messages+operation_logs")
        platform_run = _record(
            "operation-log-1",
            conversation_id="operation-log-1",
            source="operation_logs",
        )
        items = [dify_message, merged_message, platform_run]

        for item in items:
            item["feedback_supported"] = _is_conversation_message(item) and bool(item.get("message_id"))

        self.assertTrue(dify_message["feedback_supported"])
        self.assertTrue(merged_message["feedback_supported"])
        self.assertFalse(platform_run["feedback_supported"])

    def test_conversation_filter_returns_the_complete_selected_conversation(self):
        snapshot = {
            "items": [
                _record("first", conversation_id="conversation-a", created_at=300),
                _record("second", conversation_id="conversation-b", created_at=200),
                _record("third", conversation_id="conversation-a", created_at=100),
            ]
        }

        filtered = _filter_conversation_record_snapshot(
            snapshot,
            view="history",
            keyword="",
            rating="",
            has_workflow_run=None,
            run_kind="",
            start_time=None,
            end_time=None,
            conversation_id="conversation-a",
        )

        self.assertEqual(
            [item["message_id"] for item in filtered],
            ["first", "third"],
        )

    def test_stats_separate_messages_runs_and_device_evidence(self):
        device_control = {
            **_record("control", conversation_id="operation-log-1", source="local_device_control"),
            "usage": {"type": "agent_control", "level": "warning"},
        }
        device_status = {
            **_record("status", conversation_id="operation-log-2", source="local_device_control"),
            "usage": {"type": "agent_device_status", "level": "success"},
        }
        platform_test = {
            **_record("test", conversation_id="operation-log-3", source="operation_logs"),
            "usage": {"type": "agent_test", "level": "success"},
        }
        items = [
            _record("plain"),
            _record("workflow", workflow_run_id="run-1"),
            device_control,
            device_status,
            platform_test,
        ]

        stats = _conversation_record_stats(items)

        self.assertEqual(stats["record_count"], 5)
        self.assertEqual(stats["message_count"], 2)
        self.assertEqual(stats["conversation_count"], 1)
        self.assertEqual(stats["run_count"], 4)
        self.assertEqual(stats["workflow_run_count"], 1)
        self.assertEqual(stats["platform_run_count"], 3)
        self.assertEqual(stats["device_control_count"], 1)
        self.assertEqual(stats["device_status_count"], 1)
        self.assertEqual(stats["platform_test_count"], 1)

    def test_abnormal_stats_do_not_treat_successful_run_without_answer_as_failure(self):
        empty_message = _record("empty-message", answer="")
        successful_legacy_run = {
            **_record("legacy-run", source="operation_logs", answer=""),
            "usage": {"type": "agent_test", "level": "success"},
            "run_status": "平台测试记录",
        }
        failed_run = {
            **_record("failed-run", source="local_device_control", answer="执行失败说明"),
            "usage": {"type": "agent_control", "level": "error"},
            "run_status": "本地设备控制失败",
        }
        disliked_message = _record("disliked", rating="dislike")

        stats = _conversation_record_stats([
            empty_message,
            successful_legacy_run,
            failed_run,
            disliked_message,
        ])

        self.assertEqual(stats["abnormal_count"], 3)

    async def test_endpoint_returns_filtered_stats_and_server_pagination(self):
        snapshot = {
            "items": [
                _record("first", created_at=300, workflow_run_id="run-1"),
                _record("second", created_at=200, source="local_device_control"),
                _record("history-only", created_at=100),
            ],
            "stats": {"message_count": 3},
            "meta": {"generated_at": "now"},
        }
        with patch(
            "app.routers.chat._get_conversation_record_snapshot",
            AsyncMock(return_value=(snapshot, "hit")),
        ):
            payload = await get_conversation_records(
                view="runs",
                keyword="",
                rating="",
                has_workflow_run=None,
                run_kind="",
                start_time=None,
                end_time=None,
                page=2,
                size=1,
                refresh=False,
                current_user={"user_id": 7},
                db=AsyncMock(),
            )

        self.assertEqual(payload["total"], 2)
        self.assertEqual(payload["items"][0]["message_id"], "second")
        self.assertEqual(payload["stats"]["record_count"], 2)
        self.assertEqual(payload["stats"]["message_count"], 1)
        self.assertEqual(payload["stats"]["run_count"], 2)
        self.assertEqual(payload["snapshot_stats"], {"message_count": 3})
        self.assertEqual(payload["meta"]["cache"], "hit")

    async def test_history_endpoint_paginates_conversations_without_splitting_messages(self):
        snapshot = {
            "items": [
                _record("a-new", conversation_id="conversation-a", created_at=400),
                _record("a-old", conversation_id="conversation-a", created_at=300),
                _record("b", conversation_id="conversation-b", created_at=200),
            ],
            "stats": {},
            "meta": {},
        }
        with patch(
            "app.routers.chat._get_conversation_record_snapshot",
            AsyncMock(return_value=(snapshot, "hit")),
        ):
            payload = await get_conversation_records(
                view="history",
                keyword="",
                conversation_id="",
                rating="",
                has_workflow_run=None,
                run_kind="",
                start_time=None,
                end_time=None,
                page=1,
                size=1,
                group_conversations=True,
                refresh=False,
                current_user={"user_id": 7},
                db=AsyncMock(),
            )

        self.assertEqual(payload["total"], 2)
        self.assertEqual(
            [item["message_id"] for item in payload["items"]],
            ["a-new", "a-old"],
        )

    async def test_endpoint_clamps_oversized_page_to_last_available_page(self):
        snapshot = {
            "items": [
                _record("first", created_at=300, workflow_run_id="run-1"),
                _record("second", created_at=200, workflow_run_id="run-2"),
            ],
            "stats": {},
            "meta": {},
        }
        with patch(
            "app.routers.chat._get_conversation_record_snapshot",
            AsyncMock(return_value=(snapshot, "hit")),
        ):
            payload = await get_conversation_records(
                view="runs",
                keyword="",
                rating="",
                has_workflow_run=None,
                run_kind="",
                start_time=None,
                end_time=None,
                page=9,
                size=1,
                refresh=False,
                current_user={"user_id": 7},
                db=AsyncMock(),
            )

        self.assertEqual(payload["page"], 2)
        self.assertEqual([item["message_id"] for item in payload["items"]], ["second"])

    async def test_grouped_history_clamps_page_by_unique_conversation_count(self):
        snapshot = {
            "items": [
                _record("a-new", conversation_id="conversation-a", created_at=400),
                _record("a-old", conversation_id="conversation-a", created_at=300),
                _record("b", conversation_id="conversation-b", created_at=200),
            ],
            "stats": {},
            "meta": {},
        }
        with patch(
            "app.routers.chat._get_conversation_record_snapshot",
            AsyncMock(return_value=(snapshot, "hit")),
        ):
            payload = await get_conversation_records(
                view="history",
                keyword="",
                conversation_id="",
                rating="",
                has_workflow_run=None,
                run_kind="",
                start_time=None,
                end_time=None,
                page=9,
                size=1,
                group_conversations=True,
                refresh=False,
                current_user={"user_id": 7},
                db=AsyncMock(),
            )

        self.assertEqual(payload["page"], 2)
        self.assertEqual(payload["total"], 2)
        self.assertEqual([item["message_id"] for item in payload["items"]], ["b"])

    async def test_reversed_time_range_is_rejected(self):
        with self.assertRaises(HTTPException) as caught:
            await get_conversation_records(
                view="history",
                keyword="",
                rating="",
                has_workflow_run=None,
                run_kind="",
                start_time=200,
                end_time=100,
                page=1,
                size=20,
                refresh=False,
                current_user={"user_id": 7},
                db=AsyncMock(),
            )
        self.assertEqual(caught.exception.status_code, 422)

    async def test_snapshot_cache_hit_returns_an_independent_copy(self):
        payload = {"items": [_record("cached")], "stats": {}, "meta": {}}
        with patch(
            "app.routers.chat._load_conversation_record_snapshot",
            AsyncMock(return_value=payload),
        ) as loader:
            first, first_status = await _get_conversation_record_snapshot(
                AsyncMock(), {"user_id": 11}, refresh=False
            )
            first["items"][0]["answer"] = "已被调用方修改"
            second, second_status = await _get_conversation_record_snapshot(
                AsyncMock(), {"user_id": 11}, refresh=False
            )

        self.assertEqual(first_status, "miss")
        self.assertEqual(second_status, "hit")
        self.assertEqual(second["items"][0]["answer"], "回答")
        loader.assert_awaited_once()

    async def test_degraded_snapshot_uses_response_ttl_for_retry_backoff(self):
        payload = {
            "items": [],
            "stats": {},
            "meta": {"dify_available": False, "cache_ttl_seconds": 120},
        }
        with patch(
            "app.routers.chat._load_conversation_record_snapshot",
            AsyncMock(return_value=payload),
        ) as loader:
            before = asyncio.get_running_loop().time()
            first, first_status = await _get_conversation_record_snapshot(
                AsyncMock(), {"user_id": 15}, refresh=False
            )
            expires_at = _conversation_record_cache[15][0]
            second, second_status = await _get_conversation_record_snapshot(
                AsyncMock(), {"user_id": 15}, refresh=False
            )

        self.assertEqual(first_status, "miss")
        self.assertEqual(second_status, "hit")
        self.assertFalse(first["meta"]["dify_available"])
        self.assertGreaterEqual(expires_at - before, 119)
        self.assertLessEqual(expires_at - before, 121)
        loader.assert_awaited_once()

    async def test_concurrent_snapshot_requests_share_one_loader(self):
        release = asyncio.Event()

        async def load_once(_db, _user):
            await release.wait()
            return {"items": [_record("shared")], "stats": {}, "meta": {}}

        with patch("app.routers.chat._load_conversation_record_snapshot", side_effect=load_once) as loader:
            first_task = asyncio.create_task(
                _get_conversation_record_snapshot(AsyncMock(), {"user_id": 12}, refresh=False)
            )
            await asyncio.sleep(0)
            second_task = asyncio.create_task(
                _get_conversation_record_snapshot(AsyncMock(), {"user_id": 12}, refresh=False)
            )
            await asyncio.sleep(0)
            release.set()
            first, second = await asyncio.gather(first_task, second_task)

        self.assertEqual(loader.call_count, 1)
        self.assertEqual({first[1], second[1]}, {"miss", "shared"})

    async def test_cancelling_one_waiter_keeps_shared_record_snapshot_alive(self):
        release = asyncio.Event()

        async def load_once(_db, _user):
            await release.wait()
            return {"items": [_record("survived")], "stats": {}, "meta": {}}

        with patch("app.routers.chat._load_conversation_record_snapshot", side_effect=load_once) as loader:
            cancelled_waiter = asyncio.create_task(
                _get_conversation_record_snapshot(AsyncMock(), {"user_id": 13}, refresh=False)
            )
            await asyncio.sleep(0)
            surviving_waiter = asyncio.create_task(
                _get_conversation_record_snapshot(AsyncMock(), {"user_id": 13}, refresh=False)
            )
            await asyncio.sleep(0)
            cancelled_waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await cancelled_waiter
            release.set()
            snapshot, status = await surviving_waiter

        self.assertEqual(loader.call_count, 1)
        self.assertEqual(status, "shared")
        self.assertEqual(snapshot["items"][0]["message_id"], "survived")
        self.assertIn(13, _conversation_record_cache)

    async def test_dify_failure_keeps_platform_records_and_reports_degraded_source(self):
        local_payload = {
            "items": [_record("operation-log-1", source="local_device_control")],
            "stats": {},
        }
        dify = AsyncMock()
        dify.get_conversation_records.side_effect = RuntimeError("Dify 暂不可达")
        with (
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
            patch(
                "app.routers.chat._append_agent_runtime_logs",
                AsyncMock(return_value=local_payload),
            ),
        ):
            snapshot = await _load_conversation_record_snapshot(
                AsyncMock(), {"user_id": 13}
            )

        self.assertEqual(len(snapshot["items"]), 1)
        self.assertFalse(snapshot["meta"]["dify_available"])
        self.assertIn("Dify 暂不可达", snapshot["meta"]["dify_error"])
        self.assertIn("local_device_control", snapshot["meta"]["data_sources"])
        self.assertEqual(snapshot["meta"]["cache_ttl_seconds"], 120)

    async def test_dify_timeout_keeps_platform_records_and_reports_degraded_source(self):
        async def never_returns(**_kwargs):
            await asyncio.sleep(1)

        local_payload = {
            "items": [_record("operation-log-timeout", source="local_device_control")],
            "stats": {},
        }
        dify = AsyncMock()
        dify.get_conversation_records.side_effect = never_returns
        with (
            patch("app.routers.chat.CONVERSATION_RECORD_DIFY_TIMEOUT_SECONDS", 0.01),
            patch("app.routers.chat._get_dify_for_chat", AsyncMock(return_value=dify)),
            patch(
                "app.routers.chat._append_agent_runtime_logs",
                AsyncMock(return_value=local_payload),
            ),
        ):
            snapshot = await _load_conversation_record_snapshot(
                AsyncMock(), {"user_id": 14}
            )

        self.assertEqual(len(snapshot["items"]), 1)
        self.assertFalse(snapshot["meta"]["dify_available"])
        self.assertIn("超过 0.01 秒", snapshot["meta"]["dify_error"])

    async def test_physical_pending_log_is_warning_not_success(self):
        row = SimpleNamespace(
            id=19,
            type="agent_control",
            level="warning",
            title="AI 设备控制已下发，待实机确认：筒灯",
            detail="query=打开筒灯, device_id=23, action=turn_on, result=physical_pending, answer=待实机确认",
            entity_id="light.real",
            created_at=None,
        )
        db = AsyncMock()
        db.execute.return_value = _ScalarResult([row])

        payload = await _append_agent_runtime_logs(
            {"items": [], "stats": {}}, db, {"user_id": 9}
        )

        self.assertEqual(payload["items"][0]["run_status"], "设备控制已下发，待实机确认")
        self.assertEqual(payload["items"][0]["usage"]["level"], "warning")
        self.assertEqual(payload["items"][0]["record_kind"], "device_control")

    async def test_platform_test_log_does_not_expose_structured_audit_detail_as_answer(self):
        rows = [
            SimpleNamespace(
                id=21,
                type="agent_test",
                level="success",
                title="智能体测试运行：主应用",
                detail="instance_id=7, query=知识问答, message_id=msg-1, workflow_run_id=run-1, answer=真实回答",
                entity_id="",
                created_at=None,
            ),
            SimpleNamespace(
                id=22,
                type="agent_test",
                level="error",
                title="智能体测试失败：主应用",
                detail="instance_id=7, query=知识问答, error=上游失败",
                entity_id="",
                created_at=None,
            ),
        ]
        db = AsyncMock()
        db.execute.return_value = _ScalarResult(rows)

        payload = await _append_agent_runtime_logs(
            {"items": [], "stats": {}}, db, {"user_id": 9}
        )

        by_title = {item["conversation_name"]: item for item in payload["items"]}
        self.assertEqual(by_title["智能体测试运行：主应用"]["answer"], "真实回答")
        self.assertEqual(by_title["智能体测试失败：主应用"]["answer"], "")

    async def test_export_json_and_csv_follow_filters_and_neutralize_formulas(self):
        snapshot = {
            "items": [
                {
                    **_record("formula", rating="like"),
                    "conversation_name": "=危险公式",
                    "query": "+问题",
                    "answer": "@回答",
                },
                _record("unrated"),
            ],
            "stats": {},
            "meta": {
                "snapshot_truncated": True,
                "conversation_has_more": True,
                "conversation_limit": 30,
                "message_limit_per_conversation": 50,
                "local_run_limit": 200,
                "dify_available": True,
            },
        }
        with patch(
            "app.routers.chat._get_conversation_record_snapshot",
            AsyncMock(return_value=(snapshot, "hit")),
        ):
            csv_response = await export_conversation_records(
                view="feedback",
                keyword="",
                rating="like",
                has_workflow_run=None,
                run_kind="",
                start_time=None,
                end_time=None,
                format="csv",
                current_user={"user_id": 7},
                db=AsyncMock(),
            )
            json_response = await export_conversation_records(
                view="feedback",
                keyword="",
                rating="like",
                has_workflow_run=None,
                run_kind="",
                start_time=None,
                end_time=None,
                format="json",
                current_user={"user_id": 7},
                db=AsyncMock(),
            )

        csv_text = csv_response.body.decode("utf-8")
        json_payload = json.loads(json_response.body)
        self.assertIn("'=危险公式", csv_text)
        self.assertIn("'+问题", csv_text)
        self.assertIn("'@回答", csv_text)
        self.assertEqual(json_payload["count"], 1)
        self.assertEqual(json_payload["items"][0]["message_id"], "formula")
        self.assertFalse(json_payload["coverage"]["complete"])
        self.assertIn("Dify 会话仅载入最近 30 个", json_payload["coverage"]["reasons"])
        self.assertEqual(csv_response.headers["x-snapshot-truncated"], "true")
        self.assertIn("快照完整性", csv_text)
        self.assertIn("覆盖说明", csv_text)
        self.assertIn("Dify 会话仅载入最近 30 个", csv_text)
        self.assertEqual(_conversation_csv_cell("-1+2"), "'-1+2")

    async def test_local_run_limit_marks_snapshot_as_truncated(self):
        rows = [
            SimpleNamespace(
                id=index,
                type="agent_test",
                level="success",
                title=f"测试记录 {index}",
                detail="",
                entity_id="",
                created_at=None,
            )
            for index in range(201)
        ]
        db = AsyncMock()
        db.execute.return_value = _ScalarResult(rows)

        payload = await _append_agent_runtime_logs(
            {"items": [], "stats": {}, "_meta": {}}, db, {"user_id": 9}
        )

        self.assertEqual(len(payload["items"]), 200)
        self.assertTrue(payload["_meta"]["local_run_has_more"])

    async def test_history_export_excludes_platform_audit_records(self):
        snapshot = {
            "items": [
                _record("message"),
                _record(
                    "operation-log-1",
                    conversation_id="operation-log-1",
                    source="local_device_control",
                ),
            ],
            "stats": {},
            "meta": {},
        }
        with patch(
            "app.routers.chat._get_conversation_record_snapshot",
            AsyncMock(return_value=(snapshot, "hit")),
        ):
            response = await export_conversation_records(
                view="history",
                keyword="",
                rating="",
                has_workflow_run=None,
                run_kind="",
                start_time=None,
                end_time=None,
                format="json",
                current_user={"user_id": 7},
                db=AsyncMock(),
            )

        payload = json.loads(response.body)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["items"][0]["message_id"], "message")


if __name__ == "__main__":
    unittest.main()
