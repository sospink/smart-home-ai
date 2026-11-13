import inspect
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.dependencies import require_admin
from app.models.model_pull_task import ModelPullTask
from app.models.operation_log import OperationLog
from app.routers.models_router import (
    PULL_TASK_SSE_HEARTBEAT_SECONDS,
    CopyModelRequest,
    SetCurrentModelRequest,
    _record_model_management_operation,
    _filter_installed_models,
    _filter_library_models,
    _paginate_items,
    cancel_model_pull_task,
    copy_model,
    create_pull_task,
    delete_model,
    model_library,
    list_models,
    pull_task_events,
    pull_model,
    retry_model_pull_task,
    set_current_model,
    sync_model_library,
    system_metrics,
    router as models_router,
)
from app.services.model_pull_tasks import (
    _merge_layer_progress,
    list_pull_tasks_page,
    ollama_models_disk_path,
    ollama_models_path,
)
from app.services.model_catalog import _normalize_catalog_payload, _parse_library_page


class ScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar(self):
        return self.value


class RowsResult:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        return self

    def all(self):
        return self.rows


class PairRowsResult:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


class ModelsWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _frontend_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "models"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    @staticmethod
    def _pulls_frontend_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "models"
            / "pulls"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_inventory_first_failure_is_owned_by_inventory_section(self):
        source = self._frontend_source()
        self.assertIn("section !== 'inventory' || inventoryLoaded", source)
        self.assertIn("sectionErrors.inventory && !inventoryLoaded", source)
        self.assertIn("{sectionErrors.inventory || (ollamaOnline === false", source)
        self.assertIn("inventoryRefreshing ? '正在重新读取' : '重新读取模型清单'", source)

    def test_pull_tasks_first_failure_is_not_presented_as_an_empty_snapshot(self):
        source = self._pulls_frontend_source()
        self.assertIn("tasksError && tasksLoaded", source)
        self.assertIn("!tasksLoaded && tasksError", source)
        self.assertIn("{tasksError}", source)
        self.assertIn("不按零条任务统计", source)

    def test_library_refresh_failure_keeps_same_view_pagination_and_interactions(self):
        source = self._pulls_frontend_source()
        self.assertIn("const libraryInteractionsAllowed = librarySnapshotMatchesView", source)
        self.assertNotIn("const libraryInteractionsAllowed = librarySnapshotMatchesView && !libraryError", source)
        self.assertIn("libraryError && !librarySnapshotMatchesView", source)
        self.assertIn("{libraryLoaded ? <Pagination", source)
        self.assertIn("版本选择、预检和分页仍可用", source)

    def test_same_precheck_is_shared_with_immediate_create_action(self):
        source = self._pulls_frontend_source()
        self.assertIn("promise: Promise<PrecheckResult | null>", source)
        self.assertIn("if (activeRequest?.key === requestKey) return activeRequest.promise", source)
        self.assertIn("precheckInFlightRef.current = { key: requestKey, promise }", source)
        self.assertNotIn("if (precheckInFlightRef.current === normalizedTarget) return null", source)

    def test_pull_summary_uses_two_columns_on_mobile_without_forced_character_breaks(self):
        source = self._pulls_frontend_source()
        self.assertIn('mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4', source)
        self.assertIn(
            'mt-2 break-words text-sm font-black leading-5 text-slate-900 [overflow-wrap:anywhere]',
            source,
        )

    def test_model_names_wrap_without_single_character_fragmentation_or_duplicate_summary(self):
        source = self._frontend_source()
        self.assertIn(
            'min-w-0 break-words text-2xl font-black leading-tight text-slate-900 [overflow-wrap:anywhere]',
            source,
        )
        self.assertIn(
            'min-w-0 break-words text-2xl font-black leading-tight [overflow-wrap:anywhere]',
            source,
        )
        self.assertIn("? '已配置，Ollama 当前离线'", source)
        self.assertIn(": '已设为当前使用模型，当前未加载到内存'", source)
        self.assertNotIn("`${currentModel} · 已设为当前使用模型", source)


    def test_model_collection_accepts_both_trailing_slash_forms_without_redirect(self):
        routes = {(route.path, method) for route in models_router.routes for method in route.methods}
        self.assertIn(("/models", "GET"), routes)
        self.assertIn(("/models/", "GET"), routes)
        documented = {
            route.path
            for route in models_router.routes
            if getattr(route, "include_in_schema", False) and route.path in {"/models", "/models/"}
        }
        self.assertEqual(documented, {"/models"})

    def test_pull_task_streams_keep_idle_connections_alive(self):
        self.assertEqual(PULL_TASK_SSE_HEARTBEAT_SECONDS, 10.0)
        self.assertIn('yield ": keep-alive\\n\\n"', inspect.getsource(pull_task_events))
        self.assertIn('yield ": keep-alive\\n\\n"', inspect.getsource(pull_model))

    def test_model_storage_path_uses_ollama_default_and_environment_override(self):
        with patch.dict("os.environ", {}, clear=True), patch("os.path.expanduser", return_value="/home/test/.ollama/models"):
            self.assertEqual(ollama_models_path(), "/home/test/.ollama/models")
        with patch.dict("os.environ", {"OLLAMA_MODELS": "/data/ollama-models"}, clear=True):
            self.assertEqual(ollama_models_path(), "/data/ollama-models")

    def test_model_storage_disk_path_falls_back_to_existing_parent(self):
        with (
            patch("app.services.model_pull_tasks.ollama_models_path", return_value="/data/ollama/models"),
            patch("os.path.exists", side_effect=lambda value: value == "/data"),
        ):
            self.assertEqual(ollama_models_disk_path(), "/data")

    async def test_system_metrics_reports_model_volume_capacity_and_swap(self):
        gib = 1024 ** 3
        disk_usage = SimpleNamespace(total=100 * gib, used=91 * gib, free=9 * gib)
        memory = SimpleNamespace(total=16 * gib, used=8 * gib, percent=50.0)
        swap = SimpleNamespace(total=4 * gib, used=3 * gib, free=1 * gib, percent=75.0)
        with (
            patch("app.routers.models_router.ollama_models_disk_path", return_value="/data/ollama/models"),
            patch("app.routers.models_router.shutil.disk_usage", return_value=disk_usage),
            patch("app.routers.models_router.psutil.cpu_percent", return_value=12.5),
            patch("app.routers.models_router.psutil.cpu_count", return_value=8),
            patch("app.routers.models_router.psutil.cpu_freq", return_value=SimpleNamespace(current=2400)),
            patch("app.routers.models_router.psutil.virtual_memory", return_value=memory),
            patch("app.routers.models_router.psutil.swap_memory", return_value=swap),
            patch("app.routers.models_router.psutil.getloadavg", return_value=(4.0, 0.0, 0.0)),
            patch("app.routers.models_router._get_gpu_info", return_value=[]),
        ):
            payload = await system_metrics(_user={"user_id": 1})

        self.assertEqual(payload["disk"], {
            "path": "/data/ollama/models",
            "total_gb": 100.0,
            "used_gb": 91.0,
            "available_gb": 9.0,
            "percent": 91.0,
        })
        self.assertEqual(payload["swap"], {
            "total_gb": 4.0,
            "used_gb": 3.0,
            "available_gb": 1.0,
            "percent": 75.0,
        })
        self.assertIn({"label": "Swap", "value": 75.0, "unit": "%"}, payload["metrics_bars"])

    async def test_gpu_temperature_keeps_celsius_unit(self):
        gib = 1024 ** 3
        with (
            patch("app.routers.models_router.ollama_models_disk_path", return_value="/data/ollama/models"),
            patch("app.routers.models_router.shutil.disk_usage", return_value=SimpleNamespace(total=100 * gib, used=20 * gib, free=80 * gib)),
            patch("app.routers.models_router.psutil.cpu_percent", return_value=12.5),
            patch("app.routers.models_router.psutil.cpu_count", return_value=8),
            patch("app.routers.models_router.psutil.cpu_freq", return_value=None),
            patch("app.routers.models_router.psutil.virtual_memory", return_value=SimpleNamespace(total=16 * gib, used=8 * gib, percent=50.0)),
            patch("app.routers.models_router.psutil.swap_memory", return_value=SimpleNamespace(total=0, used=0, free=0, percent=0.0)),
            patch("app.routers.models_router._get_gpu_info", return_value=[{
                "index": 0, "name": "GPU", "utilization_percent": 45.0,
                "memory_used_mb": 4096.0, "memory_total_mb": 8192.0,
                "memory_percent": 50.0, "temperature_c": 72.0,
            }]),
        ):
            payload = await system_metrics(_user={"user_id": 1})

        self.assertIn({"label": "GPU温度", "value": 72.0, "unit": "°C"}, payload["metrics_bars"])

    def test_model_asset_writes_require_admin(self):
        write_endpoints = [
            (set_current_model, "user"),
            (sync_model_library, "user"),
            (create_pull_task, "user"),
            (retry_model_pull_task, "user"),
            (cancel_model_pull_task, "user"),
            (pull_model, "user"),
            (copy_model, "user"),
            (delete_model, "user"),
        ]
        for endpoint, parameter_name in write_endpoints:
            with self.subTest(endpoint=endpoint.__name__):
                dependency = inspect.signature(endpoint).parameters[parameter_name].default.dependency
                self.assertIs(dependency, require_admin)

    def test_copy_model_request_normalizes_and_validates_names(self):
        payload = CopyModelRequest(source=" qwen3:8b ", destination=" qwen3-demo:latest ")
        self.assertEqual(payload.source, "qwen3:8b")
        self.assertEqual(payload.destination, "qwen3-demo:latest")

        invalid_names = ["", "model name:latest", "/model:latest", "model:", "team//model:latest"]
        for name in invalid_names:
            with self.subTest(name=name), self.assertRaises(ValueError):
                CopyModelRequest(source="qwen3:8b", destination=name)

    async def test_copy_model_rejects_same_destination_before_contacting_ollama(self):
        db = AsyncMock()
        with patch("app.routers.models_router.get_runtime_services", AsyncMock()) as runtime_loader:
            with self.assertRaises(HTTPException) as raised:
                await copy_model(
                    CopyModelRequest(source="qwen3:8b", destination="qwen3:8b"),
                    user={"user_id": 1, "username": "admin"},
                    db=db,
                )

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("不能与源模型相同", raised.exception.detail)
        runtime_loader.assert_not_awaited()

    def test_model_management_audit_records_actor_and_safe_fields(self):
        db = MagicMock()
        _record_model_management_operation(
            db,
            {"user_id": 7, "username": "admin"},
            action="set_current",
            title="当前模型已切换",
            entity_id="qwen3:8b",
            previous_model="deepseek-r1:1.5b",
            model="qwen3:8b",
            result="success",
        )

        log = db.add.call_args.args[0]
        self.assertIsInstance(log, OperationLog)
        self.assertEqual(log.type, "model_management")
        self.assertEqual(log.user_id, 7)
        self.assertEqual(log.username, "admin")
        self.assertEqual(log.entity_id, "qwen3:8b")
        self.assertIn("action=set_current", log.detail)
        self.assertIn("model=qwen3:8b", log.detail)
        self.assertNotIn("token", log.detail.lower())
        self.assertNotIn("password", log.detail.lower())

    def test_library_parser_does_not_treat_pull_count_as_parameter_size(self):
        html = """
        <li x-test-model>
          <a href="/library/qwen3"><span x-test-model-title title="qwen3"></span></a>
          <p class="break-words">Qwen model</p>
          <span class="bg-[#ddf4ff]">8b</span>
          <span>114.6m Pulls</span>
        </li>
        """

        models = _parse_library_page(html)

        self.assertEqual(models[0]["parameter_sizes"], ["8b"])

    def test_cached_catalog_removes_legacy_pull_count_from_parameters(self):
        payload = {
            "models": [{
                "name": "qwen3",
                "parameter_sizes": ["114.6m", "8b"],
                "tags": [{"tag": "8b", "full_name": "qwen3:8b"}],
            }],
        }

        normalized = _normalize_catalog_payload(payload)

        self.assertEqual(normalized["models"][0]["parameter_sizes"], ["8b"])

    def test_pull_progress_keeps_largest_model_layer(self):
        total, completed, percent = _merge_layer_progress(0, 0, 4_000_000_000, 2_000_000_000)
        total, completed, percent = _merge_layer_progress(total, completed, 487, 487)

        self.assertEqual(total, 4_000_000_000)
        self.assertEqual(completed, 2_000_000_000)
        self.assertEqual(percent, 50.0)

    def test_installed_model_filter_and_page_are_stable(self):
        models = [
            {"name": "qwen3:8b", "family": "qwen3", "parameter_size": "8B"},
            {"name": "nomic-embed-text:latest", "family": "nomic-bert", "parameter_size": "137M"},
            {"name": "qwen3:4b", "family": "qwen3", "parameter_size": "4B"},
        ]
        filtered = _filter_installed_models(models, "QWEN")
        page, total, safe_page, page_count = _paginate_items(filtered, 9, 1)

        self.assertEqual(total, 2)
        self.assertEqual(safe_page, 2)
        self.assertEqual(page_count, 2)
        self.assertEqual(page[0]["name"], "qwen3:4b")

    def test_library_filter_combines_server_side_conditions(self):
        models = [
            {
                "name": "qwen3",
                "desc": "中文对话模型",
                "family": "qwen",
                "category": "对话",
                "capabilities": ["completion", "tools"],
                "parameter_sizes": ["4B", "8B"],
                "installed": True,
                "recommended": True,
            },
            {
                "name": "bge-m3",
                "desc": "向量模型",
                "family": "bert",
                "category": "Embedding",
                "capabilities": ["embedding"],
                "parameter_sizes": [],
                "installed": False,
                "recommended": True,
            },
        ]

        result = _filter_library_models(
            models,
            keyword="中文",
            category="对话",
            capability="completion",
            installed=True,
            recommended=True,
        )

        self.assertEqual([item["name"] for item in result], ["qwen3"])

    async def test_library_route_does_not_shadow_optional_installed_filter(self):
        runtime = SimpleNamespace(
            ollama=SimpleNamespace(list_models=AsyncMock(return_value=[{"name": "qwen3:8b"}])),
        )
        catalog = {
            "models": [
                {"name": "qwen3", "category": "对话", "capabilities": ["tools"], "recommended": True, "tags": []},
                {"name": "bge-m3", "category": "Embedding", "capabilities": ["embedding"], "recommended": True, "tags": []},
            ],
            "source": "cache",
            "last_synced_at": None,
            "error": "",
        }
        with (
            patch("app.routers.models_router.get_runtime_services", AsyncMock(return_value=runtime)),
            patch("app.routers.models_router.get_catalog", AsyncMock(return_value=catalog)),
        ):
            payload = await model_library(
                keyword="",
                category="",
                capability="",
                installed=None,
                recommended=None,
                page=1,
                size=12,
                _user={"user_id": 1},
                db=AsyncMock(),
            )

        self.assertEqual(payload["total"], 2)
        self.assertEqual([item["name"] for item in payload["models"]], ["qwen3", "bge-m3"])

    async def test_library_distinguishes_installed_family_from_exact_tag(self):
        runtime = SimpleNamespace(
            ollama=SimpleNamespace(list_models=AsyncMock(return_value=[{"name": "deepseek-r1:1.5b"}])),
        )
        catalog = {
            "models": [
                {
                    "name": "deepseek-r1",
                    "category": "推理",
                    "capabilities": ["thinking"],
                    "recommended": True,
                    "tags": [
                        {"tag": "latest", "full_name": "deepseek-r1:latest"},
                        {"tag": "1.5b", "full_name": "deepseek-r1:1.5b"},
                    ],
                },
            ],
            "source": "cache",
            "last_synced_at": None,
            "error": "",
        }
        with (
            patch("app.routers.models_router.get_runtime_services", AsyncMock(return_value=runtime)),
            patch("app.routers.models_router.get_catalog", AsyncMock(return_value=catalog)),
        ):
            payload = await model_library(
                keyword="",
                category="",
                capability="",
                installed=None,
                recommended=None,
                page=1,
                size=12,
                _user={"user_id": 1},
                db=AsyncMock(),
            )

        model = payload["models"][0]
        tags = {tag["tag"]: tag["installed"] for tag in model["tags"]}
        self.assertTrue(model["installed"])
        self.assertFalse(tags["latest"])
        self.assertTrue(tags["1.5b"])

    async def test_installed_model_page_keeps_unfiltered_inventory_summary(self):
        runtime = SimpleNamespace(
            ollama=SimpleNamespace(list_models=AsyncMock(return_value=[
                {"name": "qwen3:8b", "size": 8, "details": {"family": "qwen3"}},
                {"name": "bge-m3:latest", "size": 3, "details": {"family": "bert"}},
            ])),
        )
        with patch("app.routers.models_router.get_runtime_services", AsyncMock(return_value=runtime)):
            payload = await list_models(
                keyword="qwen",
                page=1,
                size=1,
                _user={"user_id": 1},
                db=AsyncMock(),
            )

        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["summary"], {"total": 2, "total_size": 11})

    async def test_complete_installed_inventory_uses_one_ollama_snapshot(self):
        models = [
            {"name": f"model-{index}:latest", "size": index + 1, "details": {"family": "test"}}
            for index in range(130)
        ]
        list_models_mock = AsyncMock(return_value=models)
        runtime = SimpleNamespace(ollama=SimpleNamespace(list_models=list_models_mock))
        with patch("app.routers.models_router.get_runtime_services", AsyncMock(return_value=runtime)):
            payload = await list_models(
                keyword="",
                page=1,
                size=100,
                complete=True,
                _user={"user_id": 1},
                db=AsyncMock(),
            )

        self.assertEqual(len(payload["models"]), 130)
        self.assertEqual(payload["total"], 130)
        self.assertEqual(payload["page_count"], 1)
        self.assertEqual(payload["size"], 130)
        self.assertEqual(payload["summary"]["total"], 130)
        list_models_mock.assert_awaited_once()

    async def test_pull_task_page_reports_full_total_and_status_summary(self):
        tasks = [
            ModelPullTask(id=9, model_name="qwen3:8b", status="running", attempt=1, max_attempts=3),
            ModelPullTask(id=8, model_name="qwen3:4b", status="failed", attempt=3, max_attempts=3),
        ]
        db = AsyncMock()
        db.execute.side_effect = [
            ScalarResult(42),
            RowsResult(tasks),
            PairRowsResult([("running", 2), ("retrying", 1), ("succeeded", 7), ("failed", 4)]),
        ]

        payload = await list_pull_tasks_page(db, page=2, size=2)

        self.assertEqual(payload["total"], 42)
        self.assertEqual(payload["page"], 2)
        self.assertEqual(payload["page_count"], 21)
        self.assertEqual(len(payload["tasks"]), 2)
        self.assertEqual(payload["summary"]["active"], 3)
        self.assertEqual(payload["summary"]["failed"], 4)

    async def test_pull_task_page_clamps_page_after_filters_shrink_result(self):
        db = AsyncMock()
        db.execute.side_effect = [
            ScalarResult(1),
            RowsResult([]),
            PairRowsResult([("failed", 1)]),
        ]

        payload = await list_pull_tasks_page(db, status="failed", page=9, size=10)

        self.assertEqual(payload["page"], 1)
        self.assertEqual(payload["page_count"], 1)

    async def test_setting_current_model_fails_when_ollama_is_offline(self):
        runtime = SimpleNamespace(
            ollama=SimpleNamespace(list_models=AsyncMock(side_effect=RuntimeError("connection refused"))),
        )
        db = AsyncMock()
        with patch("app.routers.models_router.get_runtime_services", AsyncMock(return_value=runtime)):
            with self.assertRaises(HTTPException) as raised:
                await set_current_model(
                    SetCurrentModelRequest(name="qwen3:8b"),
                    user={"user_id": 1, "username": "admin"},
                    db=db,
                )

        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("无法确认模型是否已安装", raised.exception.detail)

    async def test_setting_same_current_model_is_idempotent(self):
        runtime = SimpleNamespace(
            ollama=SimpleNamespace(list_models=AsyncMock(return_value=[{"name": "qwen3:8b"}])),
        )
        db = AsyncMock()
        with (
            patch("app.routers.models_router.get_runtime_services", AsyncMock(return_value=runtime)),
            patch("app.routers.models_router._is_embedding_only_model", AsyncMock(return_value=False)),
            patch("app.routers.models_router._get_config", AsyncMock(return_value="qwen3:8b")),
            patch("app.routers.models_router._set_config", AsyncMock()) as setter,
            patch("app.routers.models_router._record_model_management_operation") as recorder,
        ):
            payload = await set_current_model(
                SetCurrentModelRequest(name="qwen3:8b"),
                user={"user_id": 1, "username": "admin"},
                db=db,
            )

        self.assertEqual(payload["current_model"], "qwen3:8b")
        self.assertIn("已是当前使用模型", payload["message"])
        setter.assert_not_awaited()
        recorder.assert_not_called()

    async def test_current_model_cannot_be_deleted(self):
        db = AsyncMock()
        runtime = SimpleNamespace(ollama=SimpleNamespace(delete_model=AsyncMock()))
        with (
            patch("app.routers.models_router._get_config", AsyncMock(return_value="qwen3:8b")),
            patch("app.routers.models_router.get_runtime_services", AsyncMock(return_value=runtime)),
        ):
            with self.assertRaises(HTTPException) as raised:
                await delete_model(
                    "qwen3:8b",
                    user={"user_id": 1, "username": "admin"},
                    db=db,
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("先选择其他模型", raised.exception.detail)
        runtime.ollama.delete_model.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
