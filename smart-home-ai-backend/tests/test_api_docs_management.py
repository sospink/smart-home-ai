import inspect
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.dependencies import require_admin
from app.models.api_doc_endpoint import ApiDocEndpoint
from app.models.api_doc_module import ApiDocModule
from app.models.operation_log import OperationLog
from app.routers.api_docs import (
    MAX_API_DOC_MARKDOWN_SIZE,
    _change_target_label,
    _normalize_method,
    _page_count,
    _record_api_doc_operation,
    _read_markdown_import,
    _validate_slug,
    create_endpoint,
    create_module,
    delete_endpoint,
    delete_module,
    get_admin_module_endpoints,
    get_admin_changes,
    get_admin_modules,
    get_modules,
    get_module_detail,
    get_module_endpoints,
    get_public_catalog,
    import_markdown,
    import_openapi,
    update_endpoint,
    update_module,
)
from app.services.api_docs import (
    CONTRACT_REFERENCE_ENDPOINTS,
    build_contract_reference_endpoint,
    extract_table_after_heading,
    markdown_response_fields,
    remove_generated_overview_endpoints,
    resolve_ref,
    sync_contract_reference_modules,
    sync_local_model_module_from_markdown,
)
from app.main import app
from app.schemas.api_docs import ApiDocEndpointCreate, ApiDocEndpointUpdate, ApiDocModuleCreate, ApiDocModuleUpdate
from pydantic import ValidationError


class ApiDocsConsoleFrontendContractTests(unittest.TestCase):
    @staticmethod
    def _source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "api-console"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_first_failure_and_retained_snapshot_are_separate_for_all_lists(self):
        source = self._source()
        for error_name, loaded_name in (
            ("moduleError", "modulesLoaded"),
            ("changeError", "changesLoaded"),
            ("endpointError", "endpointsLoaded"),
        ):
            self.assertIn(f"{{{error_name} && {loaded_name} ?", source)
            self.assertIn(f"!{loaded_name} && {error_name} ?", source)
            self.assertIn(f">{{{error_name}}}</p>", source)

    def test_each_first_failure_retries_only_its_own_list(self):
        source = self._source()
        self.assertIn("loadModules(modulePage, moduleSize, true)", source)
        self.assertIn("loadChanges(changePage, changeSize, true)", source)
        self.assertIn("loadEndpoints(endpointPage, endpointSize, true)", source)
        self.assertIn("重新读取模块目录", source)
        self.assertIn("重新读取变更历史", source)
        self.assertIn("重新读取接口清单", source)


class FakeUpload:
    def __init__(self, filename: str, content: bytes):
        self.filename = filename
        self.content = content

    async def read(self, size: int = -1):
        return self.content if size < 0 else self.content[:size]


class ScalarResult:
    def __init__(self, scalar=None, rows=None):
        self._scalar = scalar
        self._rows = rows or []

    def scalar(self):
        return self._scalar

    def scalar_one_or_none(self):
        return self._scalar

    def all(self):
        return self._rows

    def scalars(self):
        return self

    def unique(self):
        return self


class FakeDb:
    def __init__(self, results=None):
        self.results = list(results or [])
        self.added = []
        self.deleted = []

    async def execute(self, _statement):
        if not self.results:
            raise AssertionError("测试数据库缺少预设查询结果")
        return self.results.pop(0)

    def add(self, value):
        self.added.append(value)

    async def flush(self):
        for value in self.added:
            if isinstance(value, ApiDocEndpoint) and value.id is None:
                value.id = 42

    async def delete(self, value):
        self.deleted.append(value)


class ApiDocsManagementTests(unittest.IsolatedAsyncioTestCase):
    async def test_markdown_import_accepts_utf8_file_and_text(self):
        content = "# 统一接口\n\n接口说明。\n"

        file_result = await _read_markdown_import(FakeUpload("api.md", content.encode("utf-8")), None)
        text_result = await _read_markdown_import(None, content)

        self.assertEqual(file_result, content)
        self.assertEqual(text_result, content)

    async def test_markdown_import_rejects_invalid_file_boundaries(self):
        cases = [
            (FakeUpload("api.txt", b"# API"), 400, "仅支持上传"),
            (FakeUpload("api.md", b""), 400, "请提供 Markdown"),
            (FakeUpload("api.md", b"a" * (MAX_API_DOC_MARKDOWN_SIZE + 1)), 413, "不能超过 5MB"),
            (FakeUpload("api.md", b"\xff\xfe"), 400, "UTF-8"),
        ]
        for upload, status_code, detail in cases:
            with self.subTest(filename=upload.filename, size=len(upload.content)):
                with self.assertRaises(HTTPException) as raised:
                    await _read_markdown_import(upload, None)
                self.assertEqual(raised.exception.status_code, status_code)
                self.assertIn(detail, raised.exception.detail)

    async def test_markdown_import_rejects_oversize_text(self):
        with self.assertRaises(HTTPException) as raised:
            await _read_markdown_import(None, "中" * (MAX_API_DOC_MARKDOWN_SIZE // 3 + 1))

        self.assertEqual(raised.exception.status_code, 413)
        self.assertIn("不能超过 5MB", raised.exception.detail)

    def test_api_doc_management_writes_require_admin(self):
        write_endpoints = [
            create_module,
            update_module,
            delete_module,
            import_markdown,
            import_openapi,
            create_endpoint,
            update_endpoint,
            delete_endpoint,
        ]
        for endpoint in write_endpoints:
            with self.subTest(endpoint=endpoint.__name__):
                parameters = inspect.signature(endpoint).parameters
                parameter_name = "admin" if "admin" in parameters else "_admin"
                dependency = parameters[parameter_name].default.dependency
                self.assertIs(dependency, require_admin)

    def test_response_table_allows_explanatory_text_after_heading(self):
        markdown = """### 响应字段

返回顶层 `models` 数组，每个元素包含：

| 字段名 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 模型名称 |
| `details.parameter_size` | `string` | 参数量 |

### 示例

| 不应读取 | 类型 | 说明 |
|---|---|---|
| ignored | string | 示例表格 |
"""
        headers, rows = extract_table_after_heading(markdown, "响应字段")
        self.assertEqual(headers, ["字段名", "类型", "说明"])
        self.assertEqual(len(rows), 2)
        self.assertEqual(
            markdown_response_fields(markdown),
            [
                {"name": "name", "type": "string", "description": "模型名称"},
                {"name": "details.parameter_size", "type": "string", "description": "参数量"},
            ],
        )

    def test_page_count_and_input_validation(self):
        self.assertEqual(_page_count(0, 20), 1)
        self.assertEqual(_page_count(41, 20), 3)
        self.assertEqual(_normalize_method(" post "), "POST")
        self.assertEqual(_validate_slug("device-control", "接口 Slug"), "device-control")

    def test_management_schemas_reject_database_overflow_and_invalid_methods(self):
        invalid_payloads = [
            (ApiDocModuleCreate, {"title": "模块", "slug": "x" * 129}),
            (ApiDocModuleCreate, {"title": "模" * 256, "slug": "module"}),
            (ApiDocModuleUpdate, {"endpointBase": "/" + "x" * 255}),
            (ApiDocEndpointCreate, {"slug": "endpoint", "path": "/" + "x" * 255, "summary": "接口"}),
            (ApiDocEndpointCreate, {"slug": "endpoint", "path": "/api/v1/test", "summary": "接口", "method": "TRACE"}),
            (ApiDocEndpointUpdate, {"group": "g" * 65}),
            (ApiDocEndpointUpdate, {"sortOrder": 2147483648}),
        ]

        for schema, payload in invalid_payloads:
            with self.subTest(schema=schema.__name__, payload=payload):
                with self.assertRaises(ValidationError):
                    schema.model_validate(payload)

    def test_management_schemas_keep_valid_contract_values(self):
        module = ApiDocModuleUpdate.model_validate({
            "title": "统一设备接口",
            "slug": "device-control",
            "endpointBase": "http://localhost:8000/api/v1",
            "sortOrder": -10,
        })
        endpoint = ApiDocEndpointCreate.model_validate({
            "slug": "device-state",
            "group": "devices",
            "method": " get ",
            "path": "/api/v1/devices/{device_id}",
            "summary": "查询设备状态",
        })

        self.assertEqual(module.slug, "device-control")
        self.assertEqual(endpoint.method, "GET")

    def test_change_target_label_prefers_business_name_and_keeps_chinese_fallback(self):
        module_labels = {"local-model": "统一的本地模型调用接口"}
        endpoint_labels = {"system-health": "系统健康检查"}

        self.assertEqual(
            _change_target_label("module", "local-model", module_labels, endpoint_labels),
            "统一的本地模型调用接口",
        )
        self.assertEqual(
            _change_target_label("endpoint", "system-health", module_labels, endpoint_labels),
            "系统健康检查",
        )
        self.assertEqual(
            _change_target_label("module", "contract-reference", module_labels, endpoint_labels),
            "项目接口目录",
        )
        self.assertEqual(
            _change_target_label("endpoint", "missing", module_labels, endpoint_labels),
            "接口端点",
        )

    async def test_change_history_response_keeps_raw_total_and_folded_event_count(self):
        row = SimpleNamespace(
            id=9,
            target_type="module",
            target_ref="local-model",
            source_type="markdown",
            source_ref="local-model.md",
            import_strategy="refresh",
            note="同步本地模型接口 Markdown 文档",
            imported_at=None,
            repeat_count=3,
        )
        db = FakeDb([
            ScalarResult(scalar=3),
            ScalarResult(scalar=1),
            ScalarResult(rows=[row]),
            ScalarResult(rows=[("local-model", "统一的本地模型调用接口")]),
        ])

        payload = await get_admin_changes(
            target_type="",
            source_type="",
            keyword="",
            page=1,
            size=10,
            _admin={"user_id": 1},
            db=db,
        )

        self.assertEqual(payload["raw_total"], 3)
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["items"][0]["repeat_count"], 3)
        self.assertEqual(payload["items"][0]["target_label"], "统一的本地模型调用接口")
        with self.assertRaises(HTTPException):
            _normalize_method("TRACE")
        with self.assertRaises(HTTPException):
            _validate_slug("Device_Control", "接口 Slug")

    def test_management_lists_are_database_paginated(self):
        modules_source = inspect.getsource(get_admin_modules)
        endpoints_source = inspect.getsource(get_admin_module_endpoints)
        self.assertIn(".offset((safe_page - 1) * size)", modules_source)
        self.assertIn(".limit(size)", modules_source)
        self.assertIn(".offset((safe_page - 1) * size)", endpoints_source)
        self.assertIn(".limit(size)", endpoints_source)

    def test_public_module_directory_skips_endpoint_relationship_when_lightweight(self):
        source = inspect.getsource(get_modules)
        self.assertIn("if include_endpoints:", source)
        self.assertIn('attribute_names=["endpoints"]', source)

    def test_public_module_deep_links_prepare_managed_sources(self):
        for endpoint in (get_module_detail, get_module_endpoints):
            with self.subTest(endpoint=endpoint.__name__):
                source = inspect.getsource(endpoint)
                self.assertLess(
                    source.index("await prepare_api_docs(db)"),
                    source.index("await get_module_by_ref(db, module_ref)"),
                )

    async def test_public_catalog_returns_visible_module_summaries_without_endpoints(self):
        module = ApiDocModule(
            id=3,
            slug="device-control",
            title="统一的设备控制接口",
            subtitle="设备控制能力",
            description="提供设备控制与状态反馈。",
            endpoint_base="/api/v1/devices",
            capability_tags=["设备控制", "状态反馈"],
            sort_order=30,
            is_visible=True,
        )
        db = FakeDb([
            ScalarResult(8),
            ScalarResult(157),
            ScalarResult(1),
            ScalarResult(rows=[(module, 12)]),
        ])
        with patch("app.routers.api_docs.prepare_api_docs", new=AsyncMock()):
            result = await get_public_catalog(keyword="设备", page=1, size=5, db=db)
        self.assertEqual(result["summary"], {"module_total": 8, "endpoint_total": 157})
        self.assertEqual(result["items"][0]["endpoint_count"], 12)
        self.assertNotIn("endpoints", result["items"][0])
        source = inspect.getsource(get_public_catalog)
        self.assertIn("ApiDocModule.is_visible.is_(True)", source)
        self.assertIn("ApiDocEndpoint.is_visible.is_(True)", source)
        self.assertIn("ApiDocModule.capability_tags", source)

    def test_managed_source_sync_preserves_manual_overrides(self):
        contract_source = inspect.getsource(sync_contract_reference_modules)
        markdown_source = inspect.getsource(sync_local_model_module_from_markdown)
        self.assertIn('endpoint.source_type == "manual"', contract_source)
        self.assertIn('module.source_type == "manual"', contract_source)
        self.assertIn('endpoint.source_type == "manual"', markdown_source)
        self.assertIn('module.source_type == "manual"', markdown_source)

    async def test_device_data_sync_updates_contract_structure_and_keeps_manual_endpoint(self):
        stale = ApiDocEndpoint(
            id=1,
            module_id=8,
            slug="old-monitor-resource",
            source_type="openapi",
            source_identifier="openapi:get:/api/v1/monitor/resources",
            path="/api/v1/monitor/resources",
            method="GET",
            summary="旧监控资源",
        )
        manual = ApiDocEndpoint(
            id=2,
            module_id=8,
            slug="manual-custom",
            source_type="manual",
            source_identifier="manual:custom",
            path="/api/v1/custom/device-data",
            method="GET",
            summary="人工扩展接口",
        )
        module = ApiDocModule(
            id=8,
            slug="device-data",
            title="统一的设备数据访问接口",
            source_type="manual",
            endpoint_base="/api/v1/monitor",
            groups=[],
        )
        module.endpoints = [stale, manual]
        db = FakeDb([ScalarResult(rows=[module])])

        await sync_contract_reference_modules(db)

        self.assertEqual(module.endpoint_base, "/api/v1/states")
        self.assertIn({"id": "sensors", "label": "传感器数据"}, module.groups)
        self.assertIn(stale, db.deleted)
        self.assertNotIn(manual, db.deleted)
        created_sources = {
            item.source_identifier for item in db.added if isinstance(item, ApiDocEndpoint)
        }
        self.assertIn("contract:device-data:realtime", created_sources)
        self.assertIn("contract:device-data:sensors", created_sources)

    def test_contract_reference_does_not_expose_internal_acceptance_notes(self):
        endpoint = build_contract_reference_endpoint(
            module_slug="agent-external",
            identifier="data-query",
            group_key="external",
            method="GET",
            path="/api/v1/monitor/device-realtime",
            summary="数据查询接口",
            description="读取设备实时数据。",
            params=[],
            responses=[],
        )

        self.assertEqual(endpoint["notes"], [])

    def test_openapi_import_does_not_seed_fake_success_or_internal_todo_notes(self):
        source = inspect.getsource(__import__("app.services.api_docs", fromlist=["import_openapi_spec"]).import_openapi_spec)

        self.assertIn('response_body = "{}"', source)
        self.assertIn('"notes": []', source)
        self.assertNotIn('"status": "success", "path": path', source)
        self.assertNotIn('后续可在后台进一步补充摘要', source)

    def test_read_only_device_examples_do_not_claim_fixed_runtime_values(self):
        read_endpoints = [
            endpoint
            for module_slug in ("agent-external", "smart-home", "device-data")
            for endpoint in CONTRACT_REFERENCE_ENDPOINTS[module_slug]
            if endpoint["method"] == "GET"
        ]
        combined = "\n".join(endpoint["response_body"] for endpoint in read_endpoints)

        self.assertNotIn('"state": "25.2"', combined)
        self.assertNotIn('"state": "on"', combined)
        self.assertNotIn('"status": "online"', combined)
        self.assertNotIn('已读取 HA 实体 42 个', combined)

    def test_contract_response_examples_keep_top_level_counts_consistent(self):
        collection_keys = ("devices", "scenes", "history", "candidates")
        for module_slug, endpoints in CONTRACT_REFERENCE_ENDPOINTS.items():
            for endpoint in endpoints:
                if not endpoint["response_body"]:
                    continue
                payload = json.loads(endpoint["response_body"])
                if not isinstance(payload, dict) or "count" not in payload:
                    continue
                collections = [payload[key] for key in collection_keys if isinstance(payload.get(key), list)]
                if not collections:
                    continue
                with self.subTest(module=module_slug, endpoint=endpoint["slug"]):
                    self.assertEqual(payload["count"], len(collections[0]))

    def test_contract_sync_deduplicates_managed_routes_without_removing_manual_routes(self):
        source = inspect.getsource(sync_contract_reference_modules)

        self.assertIn('endpoint.source_type != "manual"', source)
        self.assertIn('not endpoint.source_identifier.startswith("contract:")', source)
        self.assertIn('normalized_route in expected_routes', source)

    def test_sandbox_device_example_matches_runtime_field_nesting(self):
        endpoint = next(
            item for item in CONTRACT_REFERENCE_ENDPOINTS["sandbox"]
            if item["path"] == "/api/v1/sandbox/devices"
        )
        payload = json.loads(endpoint["response_body"])

        self.assertIn("entity_states", payload["devices"][0])
        self.assertNotIn("entity_states", payload)
        self.assertEqual(payload["count"], len(payload["devices"]))
        self.assertEqual(payload["available_count"] + payload["partial_count"] + payload["unavailable_count"], payload["count"])
        self.assertEqual(payload["devices"][0]["availability"], "unavailable")
        self.assertFalse(payload["ha_connected"])
        self.assertEqual(payload["status"], "unavailable")

    def test_sandbox_contract_examples_match_current_runtime_contract(self):
        endpoints = {
            item["path"]: item
            for item in CONTRACT_REFERENCE_ENDPOINTS["sandbox"]
        }

        client_config = json.loads(endpoints["/api/v1/sandbox/client-config"]["response_body"])
        self.assertEqual(client_config["mode"], "simulation")
        self.assertEqual(client_config["auth_mode"], "backend_proxy")

        scenes = json.loads(endpoints["/api/v1/sandbox/scenes"]["response_body"])
        self.assertEqual(scenes["count"], len(scenes["scenes"]))
        self.assertIn("operations", scenes["scenes"][0])
        self.assertIn("entity_id", scenes["scenes"][0]["operations"][0])
        self.assertEqual(scenes["mode"], "simulation")

        control = endpoints["/api/v1/sandbox/control"]
        control_request = json.loads(control["request_preview"])
        control_response = json.loads(control["response_body"])
        self.assertEqual(control_request["service"], "input_boolean.turn_on")
        self.assertIn("readback", control_response)
        self.assertIn("confirmed", control_response)
        self.assertNotIn("new_state", control_response)

        logs = endpoints["/api/v1/sandbox/logs"]
        self.assertEqual(
            [item["name"] for item in logs["params"]],
            ["page", "size", "level", "action", "keyword"],
        )
        logs_response = json.loads(logs["response_body"])
        self.assertIn("items", logs_response)
        self.assertIn("page_count", logs_response)
        self.assertIn("summary", logs_response)

    def test_contract_reference_routes_and_parameters_match_current_openapi(self):
        openapi = app.openapi()

        for module_slug, endpoints in CONTRACT_REFERENCE_ENDPOINTS.items():
            for endpoint in endpoints:
                with self.subTest(module=module_slug, endpoint=endpoint["slug"]):
                    operation = openapi.get("paths", {}).get(endpoint["path"], {}).get(endpoint["method"].lower())
                    self.assertIsNotNone(operation, f"OpenAPI 中不存在 {endpoint['method']} {endpoint['path']}")

                    actual_params = {
                        (item["name"], item["in"])
                        for item in operation.get("parameters", [])
                    }
                    body_schema = (
                        operation.get("requestBody", {})
                        .get("content", {})
                        .get("application/json", {})
                        .get("schema", {})
                    )
                    if "$ref" in body_schema:
                        body_schema = resolve_ref(openapi, body_schema["$ref"])
                    actual_params.update(
                        (name, "body")
                        for name in body_schema.get("properties", {})
                    )
                    documented_params = {
                        (item["name"], item["location"])
                        for item in endpoint.get("params", [])
                    }
                    self.assertEqual(documented_params, actual_params)

    def test_typed_contract_responses_match_current_openapi_fields(self):
        openapi = app.openapi()

        for module_slug, endpoints in CONTRACT_REFERENCE_ENDPOINTS.items():
            for endpoint in endpoints:
                operation = openapi["paths"][endpoint["path"]][endpoint["method"].lower()]
                response = next(
                    (
                        operation.get("responses", {}).get(status)
                        for status in ("200", "201", "202")
                        if operation.get("responses", {}).get(status)
                    ),
                    None,
                )
                schema = (
                    (response or {}).get("content", {})
                    .get("application/json", {})
                    .get("schema", {})
                )
                if "$ref" in schema:
                    schema = resolve_ref(openapi, schema["$ref"])
                actual_fields = set(schema.get("properties", {}))
                if not actual_fields:
                    continue
                documented_fields = {
                    item["name"].split(".", 1)[0]
                    for item in endpoint.get("responses", [])
                }
                with self.subTest(module=module_slug, endpoint=endpoint["slug"]):
                    self.assertEqual(documented_fields, actual_fields)

    async def test_generated_overview_endpoints_are_removed_without_touching_manual_content(self):
        db = FakeDb([ScalarResult()])
        await remove_generated_overview_endpoints(db)
        self.assertEqual(len(db.results), 0)
        source = inspect.getsource(remove_generated_overview_endpoints)
        self.assertIn('source_type == "seed"', source)
        self.assertIn('source_identifier.like("seed:%:overview")', source)
        self.assertIn('path.like("/api/reference/%/overview")', source)

    def test_operation_log_has_no_secret_payload(self):
        db = FakeDb()
        _record_api_doc_operation(
            db,
            {"user_id": 7, "username": "admin"},
            action="更新接口",
            target_type="endpoint",
            target_ref="system-health",
            note="method=GET",
        )
        log = next(value for value in db.added if isinstance(value, OperationLog))
        self.assertEqual(log.type, "api_doc_management")
        self.assertEqual(log.user_id, 7)
        self.assertNotIn("token", (log.detail or "").lower())

    async def test_create_endpoint_records_source_and_operation(self):
        module = ApiDocModule(id=3, slug="system", title="系统接口")
        db = FakeDb([ScalarResult(None)])
        body = SimpleNamespace(
            slug="manual-health",
            group="status",
            method="GET",
            path="/api/v1/system/health",
            summary="系统健康检查",
            description="读取平台健康状态。",
            sort_order=10,
            is_visible=True,
            tags=[],
            params=[],
            responses=[],
            notes=[],
            code_samples=[],
            request_preview="",
            response_body="{}",
            response_meta="{}",
        )
        with patch("app.routers.api_docs.get_module_by_ref", new=AsyncMock(return_value=module)):
            result = await create_endpoint(
                "system",
                body,
                admin={"user_id": 7, "username": "admin"},
                db=db,
            )

        endpoint = next(value for value in db.added if isinstance(value, ApiDocEndpoint))
        self.assertEqual(endpoint.source_type, "manual")
        self.assertEqual(endpoint.method, "GET")
        self.assertEqual(endpoint.source_identifier, "manual:3:manual-health")
        self.assertEqual(result["slug"], "manual-health")
        self.assertTrue(any(isinstance(value, OperationLog) for value in db.added))


if __name__ == "__main__":
    unittest.main()
