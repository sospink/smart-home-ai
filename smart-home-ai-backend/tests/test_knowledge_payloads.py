import asyncio
import inspect
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.params import Depends
from pydantic import ValidationError

from app.dependencies import require_admin
from app.services.dify_knowledge import (
    DIFY_KNOWLEDGE_READ_TIMEOUT_SECONDS,
    DifyKnowledgeService,
)
from app.routers.knowledge import (
    HitTestingRequest,
    _dataset_snapshot_cache,
    _dataset_snapshot_pending,
    _dataset_snapshot_summary,
    _dataset_to_dict,
    _dify_error_message,
    _dify_read_status_code,
    _filter_sort_datasets,
    _load_dataset_snapshot,
    _hit_record_to_dict,
    _validate_document_file,
    create_dataset,
    create_file_document,
    create_text_document,
    delete_dataset,
    delete_document,
    list_documents,
    list_datasets as list_dataset_route,
    hit_testing,
    update_file_document,
    update_text_document,
)
from fastapi import HTTPException


class KnowledgePayloadTests(unittest.TestCase):
    @staticmethod
    def _detail_frontend_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "knowledge"
            / "[id]"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    @staticmethod
    def _list_frontend_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "knowledge"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_detail_first_failure_and_retained_snapshot_have_distinct_owners(self):
        source = self._detail_frontend_source()
        self.assertIn("loadError && hasLoadedData", source)
        self.assertIn("!hasLoadedData && loadError", source)
        self.assertIn("{loadError}", source)
        self.assertIn("重新读取知识库", source)

    def test_list_first_failure_and_retained_snapshot_have_distinct_owners(self):
        source = self._list_frontend_source()
        self.assertIn("loadError && datasetsLoaded", source)
        self.assertIn("!datasetsLoaded && loadError", source)
        self.assertIn("不按零个知识库统计", source)
        self.assertIn("详情和分页仍可用，新建与删除已暂停", source)
        self.assertIn("{datasetsLoaded ? (", source)


    def test_dify_network_errors_are_actionable_and_never_empty(self):
        request = httpx.Request("GET", "http://dify.local/v1/datasets")

        self.assertEqual(
            _dify_error_message("获取知识库列表", httpx.ConnectError("", request=request)),
            "获取知识库列表失败: 无法连接 Dify 知识库服务，请检查系统设置中的 Dify 地址和服务状态",
        )
        self.assertIn(
            "连接 Dify 知识库服务超时",
            _dify_error_message("获取知识库列表", httpx.ReadTimeout("", request=request)),
        )
        self.assertEqual(
            _dify_error_message("获取知识库列表", Exception()),
            "获取知识库列表失败: Dify 知识库服务请求异常",
        )

    def test_dify_read_error_keeps_resource_and_platform_auth_semantics_separate(self):
        missing_request = httpx.Request("GET", "http://dify.local/v1/datasets/missing/documents")
        missing_response = httpx.Response(404, request=missing_request)
        missing = httpx.HTTPStatusError("missing", request=missing_request, response=missing_response)
        self.assertEqual(_dify_read_status_code(missing), 404)
        self.assertIn("知识库不存在", _dify_error_message("获取文档列表", missing))

        denied_request = httpx.Request("GET", "http://dify.local/v1/datasets/denied")
        denied_response = httpx.Response(403, request=denied_request)
        denied = httpx.HTTPStatusError("denied", request=denied_request, response=denied_response)
        self.assertEqual(_dify_read_status_code(denied), 502)
        self.assertIn("无权访问", _dify_error_message("获取知识库详情", denied))

        timeout = httpx.ReadTimeout("timeout", request=missing_request)
        self.assertEqual(_dify_read_status_code(timeout), 504)

    def test_dataset_payload_uses_stable_frontend_contract(self):
        result = _dataset_to_dict({
            "id": "dataset-1",
            "name": "智慧家居",
            "document_count": 3,
            "embedding_available": True,
        })
        self.assertEqual(result["id"], "dataset-1")
        self.assertEqual(result["document_count"], 3)
        self.assertTrue(result["embedding_available"])
        self.assertEqual(result["description"], "")

    def test_hit_record_reads_document_nested_under_segment(self):
        result = _hit_record_to_dict({
            "score": 0.82,
            "segment": {
                "id": "segment-1",
                "document_id": "document-1",
                "content": "真实命中内容",
                "word_count": 8,
                "document": {"id": "document-1", "name": "系统总览.md"},
            },
        })
        self.assertEqual(result["document_name"], "系统总览.md")
        self.assertEqual(result["document_id"], "document-1")
        self.assertEqual(result["segment_id"], "segment-1")

    def test_hit_record_remains_compatible_with_top_level_document(self):
        result = _hit_record_to_dict({
            "document": {"id": "document-2", "name": "兼容文档.md"},
            "segment": {"id": "segment-2", "content": "内容"},
        })
        self.assertEqual(result["document_name"], "兼容文档.md")
        self.assertEqual(result["document_id"], "document-2")

    def test_hit_testing_query_is_trimmed_and_bounded(self):
        self.assertEqual(HitTestingRequest(query="  如何打开灯光？  ").query, "如何打开灯光？")
        with self.assertRaises(ValidationError):
            HitTestingRequest(query="   ")
        with self.assertRaises(ValidationError):
            HitTestingRequest(query="问" * 2001)

    def test_knowledge_writes_require_admin(self):
        routes = [
            create_dataset,
            delete_dataset,
            create_text_document,
            update_text_document,
            create_file_document,
            update_file_document,
            delete_document,
        ]
        for route in routes:
            marker = inspect.signature(route).parameters["_user"].default
            self.assertIsInstance(marker, Depends)
            self.assertIs(marker.dependency, require_admin)

    def test_document_file_validation_rejects_unsupported_empty_and_oversized_files(self):
        with self.assertRaises(HTTPException) as unsupported:
            _validate_document_file("script.exe", b"content")
        self.assertEqual(unsupported.exception.status_code, 422)

        with self.assertRaises(HTTPException) as empty:
            _validate_document_file("document.md", b"")
        self.assertEqual(empty.exception.status_code, 422)

        with self.assertRaises(HTTPException) as oversized:
            _validate_document_file("document.pdf", b"x" * (50 * 1024 * 1024 + 1))
        self.assertEqual(oversized.exception.status_code, 413)

        _validate_document_file("document.DOCX", b"content")

    def test_dataset_filter_and_sort_use_complete_snapshot(self):
        datasets = [
            _dataset_to_dict({
                "id": "1", "name": "旧共享库", "permission": "all_team_members",
                "document_count": 1, "word_count": 100, "created_at": 1, "updated_at": 2,
            }),
            _dataset_to_dict({
                "id": "2", "name": "新共享库", "permission": "all_team_members",
                "document_count": 8, "word_count": 80, "created_at": 3, "updated_at": 4,
            }),
            _dataset_to_dict({
                "id": "3", "name": "私有库", "permission": "only_me",
                "document_count": 12, "word_count": 900, "created_at": 5, "updated_at": 6,
            }),
        ]
        filtered = _filter_sort_datasets(
            datasets,
            keyword="共享",
            permission="all_team_members",
            sort="docs_desc",
        )
        self.assertEqual([item["id"] for item in filtered], ["2", "1"])

    def test_dataset_summary_uses_complete_snapshot(self):
        summary = _dataset_snapshot_summary([
            {"document_count": 3, "word_count": 120},
            {"document_count": 2, "word_count": 80},
            {"document_count": -1, "word_count": None},
        ])
        self.assertEqual(summary, {
            "total": 3,
            "document_total": 5,
            "word_total": 200,
        })


class KnowledgeSnapshotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        _dataset_snapshot_cache.clear()
        _dataset_snapshot_pending.clear()

    async def test_snapshot_loads_all_pages_and_reuses_cache(self):
        service = AsyncMock()
        service.list_datasets.side_effect = [
            {
                "data": [{"id": "1", "name": "第一库"}],
                "total": 2,
                "has_more": True,
            },
            {
                "data": [{"id": "2", "name": "第二库"}],
                "total": 2,
                "has_more": False,
            },
        ]
        services = SimpleNamespace(
            config=SimpleNamespace(dify_base_url="http://dify.local", dify_dataset_api_key="secret"),
            dify_knowledge=service,
        )

        first = await _load_dataset_snapshot(services)
        second = await _load_dataset_snapshot(services)

        self.assertEqual([item["id"] for item in first], ["1", "2"])
        self.assertIs(first, second)
        self.assertEqual(service.list_datasets.await_count, 2)

    async def test_cancelling_one_waiter_keeps_shared_dataset_snapshot_alive(self):
        release = asyncio.Event()
        service = AsyncMock()

        async def list_datasets(**_kwargs):
            await release.wait()
            return {"data": [{"id": "1", "name": "共享知识库"}], "total": 1, "has_more": False}

        service.list_datasets.side_effect = list_datasets
        services = SimpleNamespace(
            config=SimpleNamespace(dify_base_url="http://dify.local", dify_dataset_api_key="secret"),
            dify_knowledge=service,
        )
        cancelled_waiter = asyncio.create_task(_load_dataset_snapshot(services))
        await asyncio.sleep(0)
        surviving_waiter = asyncio.create_task(_load_dataset_snapshot(services))
        await asyncio.sleep(0)
        cancelled_waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled_waiter

        release.set()
        result = await surviving_waiter
        self.assertEqual(service.list_datasets.await_count, 1)
        self.assertEqual(result[0]["name"], "共享知识库")
        self.assertTrue(_dataset_snapshot_cache)

    async def test_expired_snapshot_is_retained_when_refresh_fails(self):
        service = AsyncMock()
        service.list_datasets.side_effect = httpx.ConnectError(
            "offline",
            request=httpx.Request("GET", "http://dify.local/v1/datasets"),
        )
        services = SimpleNamespace(
            config=SimpleNamespace(dify_base_url="http://dify.local", dify_dataset_api_key="secret"),
            dify_knowledge=service,
        )
        signature = "http://dify.local:" + __import__("hashlib").sha256(b"secret").hexdigest()
        snapshot = [{"id": "1", "name": "最近成功知识库"}]
        captured_at = time.time() - 90
        _dataset_snapshot_cache[signature] = (time.monotonic() - 1, captured_at, snapshot)

        result, meta = await _load_dataset_snapshot(services, refresh=True, include_meta=True)

        self.assertIs(result, snapshot)
        self.assertTrue(meta["stale"])
        self.assertEqual(meta["status"], "stale")
        self.assertEqual(meta["snapshot_at"], captured_at)
        self.assertIn("无法连接 Dify", meta["error"])

    async def test_snapshot_failure_without_previous_success_is_not_hidden(self):
        service = AsyncMock()
        error = httpx.ConnectError(
            "offline",
            request=httpx.Request("GET", "http://dify.local/v1/datasets"),
        )
        service.list_datasets.side_effect = error
        services = SimpleNamespace(
            config=SimpleNamespace(dify_base_url="http://dify.local", dify_dataset_api_key="secret"),
            dify_knowledge=service,
        )

        with self.assertRaises(httpx.ConnectError):
            await _load_dataset_snapshot(services, include_meta=True)

    async def test_dataset_route_exposes_stale_snapshot_without_fake_success(self):
        snapshot = [
            _dataset_to_dict({"id": "1", "name": "较早知识库", "document_count": 3, "created_at": 1}),
            _dataset_to_dict({"id": "2", "name": "最近成功知识库", "document_count": 1, "created_at": 2}),
        ]
        meta = {
            "status": "stale",
            "stale": True,
            "snapshot_at": 1_780_000_000.0,
            "error": "刷新知识库列表失败: 无法连接 Dify 知识库服务",
        }
        with (
            patch("app.routers.knowledge.get_runtime_services", AsyncMock(return_value=SimpleNamespace())),
            patch("app.routers.knowledge._load_dataset_snapshot", AsyncMock(return_value=(snapshot, meta))),
        ):
            payload = await list_dataset_route(
                page=1,
                limit=1,
                keyword="",
                permission="",
                sort="created_desc",
                refresh=True,
                _user={"user_id": 1},
                db=AsyncMock(),
            )

        self.assertEqual([item["id"] for item in payload["datasets"]], ["2"])
        self.assertEqual(payload["total"], 2)
        self.assertEqual(payload["summary"]["document_total"], 4)
        self.assertTrue(payload["snapshot"]["stale"])
        self.assertIn("无法连接 Dify", payload["snapshot"]["error"])

    async def test_document_route_refetches_the_real_last_page(self):
        service = AsyncMock()
        service.list_documents.side_effect = [
            {"data": [], "total": 21, "has_more": False, "page": 9},
            {
                "data": [{"id": "doc-21", "name": "末页文档.md"}],
                "total": 21,
                "has_more": False,
                "page": 3,
            },
        ]
        services = SimpleNamespace(dify_knowledge=service)
        with patch("app.routers.knowledge.get_runtime_services", AsyncMock(return_value=services)):
            payload = await list_documents(
                dataset_id="dataset-1",
                page=9,
                limit=10,
                keyword="",
                _user={"user_id": 1},
                db=AsyncMock(),
            )

        self.assertEqual(payload["page"], 3)
        self.assertEqual(payload["total"], 21)
        self.assertEqual([item["id"] for item in payload["documents"]], ["doc-21"])
        self.assertEqual(service.list_documents.await_count, 2)
        self.assertEqual(service.list_documents.await_args_list[1].kwargs["page"], 3)


class KnowledgeHitTestingTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_returns_execution_evidence_and_records_safe_audit(self):
        service = AsyncMock()
        service.hit_testing.return_value = {
            "query": {"content": "如何打开客厅灯？"},
            "records": [{
                "score": 0.91,
                "segment": {
                    "id": "segment-1",
                    "document_id": "document-1",
                    "content": "使用设备控制接口打开灯光",
                    "document": {"name": "设备控制.md"},
                },
            }],
        }
        services = SimpleNamespace(dify_knowledge=service)
        audit = AsyncMock(return_value=True)
        with (
            patch("app.routers.knowledge.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.knowledge._record_knowledge_operation", audit),
        ):
            payload = await hit_testing(
                dataset_id="dataset-1",
                body=HitTestingRequest(query="  如何打开客厅灯？  "),
                _user={"user_id": 7, "username": "tester"},
                db=AsyncMock(),
            )

        self.assertEqual(payload["hit_count"], 1)
        self.assertEqual(payload["records"][0]["document_name"], "设备控制.md")
        self.assertGreaterEqual(payload["duration_ms"], 0)
        self.assertTrue(payload["executed_at"].endswith("+00:00"))
        self.assertTrue(payload["audit_recorded"])
        self.assertEqual(service.hit_testing.await_args.kwargs["query"], "如何打开客厅灯？")
        audit_extra = audit.await_args.kwargs["extra"]
        self.assertEqual(audit_extra["status"], "success")
        self.assertEqual(audit_extra["hit_count"], 1)
        self.assertNotIn("api_key", audit_extra)
        self.assertNotIn("records", audit_extra)
        self.assertNotIn("base_url", audit_extra)

    async def test_upstream_failure_records_category_without_raw_response(self):
        request = httpx.Request("POST", "http://dify.local/v1/datasets/dataset-1/hit-testing")
        service = AsyncMock()
        service.hit_testing.side_effect = httpx.ReadTimeout("secret upstream body", request=request)
        services = SimpleNamespace(dify_knowledge=service)
        audit = AsyncMock(return_value=True)
        with (
            patch("app.routers.knowledge.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.knowledge._record_knowledge_operation", audit),
        ):
            with self.assertRaises(HTTPException) as raised:
                await hit_testing(
                    dataset_id="dataset-1",
                    body=HitTestingRequest(query="测试检索失败"),
                    _user={"user_id": 7, "username": "tester"},
                    db=AsyncMock(),
                )

        self.assertEqual(raised.exception.status_code, 504)
        self.assertNotIn("secret upstream body", str(raised.exception.detail))
        self.assertEqual(audit.await_args.kwargs["level"], "error")
        audit_extra = audit.await_args.kwargs["extra"]
        self.assertEqual(audit_extra["status"], "failed")
        self.assertEqual(audit_extra["error_category"], "timeout")
        self.assertNotIn("error", audit_extra)
        self.assertNotIn("query_preview", audit_extra)


class KnowledgeServiceTimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def test_detail_and_document_reads_share_bounded_timeout(self):
        response = SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"data": [], "total": 0, "page": 1},
        )
        client = AsyncMock()
        client.get.return_value = response
        context = AsyncMock()
        context.__aenter__.return_value = client

        with patch("app.services.dify_knowledge.httpx.AsyncClient", return_value=context) as factory:
            service = DifyKnowledgeService("http://dify.local", "secret")
            await service.get_dataset("dataset-1")
            await service.list_documents("dataset-1")

        self.assertEqual(factory.call_count, 2)
        for call in factory.call_args_list:
            self.assertEqual(call.kwargs["timeout"], DIFY_KNOWLEDGE_READ_TIMEOUT_SECONDS)
            self.assertFalse(call.kwargs["trust_env"])


if __name__ == "__main__":
    unittest.main()
