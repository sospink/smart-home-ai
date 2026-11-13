import inspect
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.dependencies import require_admin
from app.models.agent_instance import AgentInstance
from app.models.agent_template_library import AgentTemplateLibrary
from app.models.operation_log import OperationLog
from app.routers.agents import (
    MAX_AGENT_DSL_FILE_SIZE,
    _builtin_template_library_detail,
    _builtin_template_matches,
    _agent_run_scope_conditions,
    _get_runtime_evidence,
    _invalidate_runtime_evidence,
    _record_agent_instance_action,
    _record_template_library_action,
    _read_agent_dsl_upload,
    _run_record,
    _test_query_has_side_effects,
    _to_template_library_item,
    _to_response,
    create_agent_instance,
    delete_agent_instance,
    delete_agent_template_library_file,
    import_agent_to_dify,
    list_agent_instances,
    list_agent_runs,
    list_agent_template_library,
    update_agent_instance,
    update_agent_template_library_file,
    upload_agent_dsl,
    upload_agent_template_library_file,
)
from app.schemas.agents import AgentInstanceCreate, AgentTemplateLibraryDetail, AgentTemplateLibraryItem
from app.services.agent_framework import (
    agent_callable_condition,
    agent_template_reference_condition,
    derive_dify_base_url,
    get_overview_payload,
    parse_dsl_content,
    sanitize_dsl_storage,
)


class AgentsFrontendContractTests(unittest.TestCase):
    @staticmethod
    def _source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "agents"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    @staticmethod
    def _templates_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "agents"
            / "templates"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_instance_and_run_first_failures_are_separate_from_snapshots(self):
        source = self._source()
        self.assertIn("(instancesError && instancesLoaded) || templatesError || runtimeError", source)
        self.assertIn("!instancesLoaded && instancesError ?", source)
        self.assertIn("{instancesError}</p>", source)
        self.assertIn("runHistoryError && runHistory ?", source)
        self.assertIn("runHistoryError && !runHistory ?", source)
        self.assertIn("{runHistoryError}</p>", source)

    def test_run_history_first_failure_retry_has_pending_feedback(self):
        source = self._source()
        self.assertIn("disabled={runHistoryLoading}", source)
        self.assertIn("runHistoryLoading ? '正在重新读取' : '重新读取运行记录'", source)

    def test_list_view_uses_mobile_rows_instead_of_a_wide_table(self):
        source = self._source()
        self.assertIn('md:hidden', source)
        self.assertIn('hidden overflow-x-auto rounded-[8px] border border-slate-200 bg-white md:block', source)
        self.assertIn('grid-cols-[4.5rem_minmax(0,1fr)]', source)
        self.assertIn("{instanceTypeLabel(instance.instanceType)} · {instance.isDefault ? '当前使用' : '备用实例'}", source)
        self.assertIn('break-words text-sm font-black leading-5 text-slate-900 [overflow-wrap:anywhere]', source)

    def test_run_history_uses_mobile_evidence_rows_instead_of_a_wide_table(self):
        source = self._source()
        self.assertIn('hidden overflow-x-auto rounded-[8px] border border-slate-200 md:block', source)
        self.assertIn('line-clamp-2 break-words text-sm font-semibold leading-6 text-slate-700 [overflow-wrap:anywhere]', source)
        self.assertIn('查看证据', source)
        self.assertIn('grid-cols-[4rem_minmax(0,1fr)]', source)

    def test_template_library_keeps_read_actions_but_blocks_writes_on_stale_refresh(self):
        source = self._templates_source()
        self.assertIn("const templateWritesAllowed = templateSnapshotMatchesView && !error && !contextLoading", source)
        self.assertIn("disabled={!templateSnapshotMatchesView || previewLoadingId", source)
        self.assertIn("disabled={!templateSnapshotMatchesView || downloadingId", source)
        self.assertIn("disabled={!templateWritesAllowed || creating}", source)
        self.assertIn("{templatesLoaded && library.total > 0 ? (", source)

    def test_template_library_failure_retries_the_current_view(self):
        source = self._templates_source()
        self.assertIn("requestedPage,\n        requestedPageSize,\n        true", source)
        self.assertIn("onClick={() => void loadData(requestedPage, requestedPageSize, true)}", source)
        self.assertIn("disabled={refreshing}", source)
        self.assertIn("不按零个模板统计", source)

    def test_template_library_auto_recovery_does_not_queue_behind_an_active_read(self):
        source = self._templates_source()
        self.assertIn(
            "document.visibilityState !== 'visible' || listAbortRef.current",
            source,
        )


class FakeUpload:
    def __init__(self, filename: str, content: bytes):
        self.filename = filename
        self.content = content

    async def read(self, size: int = -1):
        return self.content if size < 0 else self.content[:size]


def _instance(**overrides) -> AgentInstance:
    values = {
        "id": 7,
        "name": "00 Smart Home Unified Chatflow",
        "slug": "smart-home-unified-chatflow",
        "dify_app_id": "",
        "dify_api_key": "",
        "dify_console_url": "http://dify.local/app/app-id/workflow",
        "instance_type": "chatflow",
        "source_type": "built_in_template",
        "source_template": "template-00",
        "dsl_file_name": "00 Smart Home Unified Chatflow.yml",
        "status": "ready",
        "enabled": True,
        "is_default": False,
        "description": "默认智能体",
        "default_model": "qwen3-max",
        "knowledge_bindings": [],
        "capability_tags": [],
        "entry_route": "/chat",
        "dsl_content": "",
        "created_at": datetime(2026, 7, 30, 10, 0, 0),
        "updated_at": datetime(2026, 7, 30, 10, 0, 0),
    }
    values.update(overrides)
    return AgentInstance(**values)


def _runtime(**overrides):
    values = {
        "dify_api_key": "system-key",
        "dify_base_url": "http://runtime-dify.local",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class AgentRunRecordTests(unittest.TestCase):
    def test_template_dsl_sanitizer_redacts_credentials_and_keeps_runtime_references(self):
        raw_text = """app:
  name: 凭证边界测试
workflow:
  environment_variables:
  - name: AGENT_API_KEY
    value: app-sensitive-value
    value_type: secret
  - name: BACKEND_BASE_URL
    value: http://backend.local
    value_type: string
  nodes:
  - data:
      api_key: nested-sensitive-value
      access_token: token-sensitive-value
      password: prefix-{{#env.AGENT_API_KEY#}}
      secret: '{{#env.AGENT_API_KEY#}}'
      headers: |-
        Authorization:Bearer literal-sensitive-value
        X-Agent-Key:{{#env.AGENT_API_KEY#}}
"""

        sanitized = sanitize_dsl_storage(raw_text)
        parsed = __import__("yaml").safe_load(sanitized)
        variables = parsed["workflow"]["environment_variables"]
        node_data = parsed["workflow"]["nodes"][0]["data"]

        self.assertEqual(variables[0]["value"], "")
        self.assertEqual(variables[1]["value"], "http://backend.local")
        self.assertEqual(node_data["api_key"], "")
        self.assertEqual(node_data["access_token"], "")
        self.assertEqual(node_data["password"], "")
        self.assertEqual(node_data["secret"], "{{#env.AGENT_API_KEY#}}")
        self.assertNotIn("literal-sensitive-value", node_data["headers"])
        self.assertIn("X-Agent-Key:{{#env.AGENT_API_KEY#}}", node_data["headers"])
        self.assertNotIn("app-sensitive-value", sanitized)
        self.assertNotIn("nested-sensitive-value", sanitized)
        self.assertNotIn("token-sensitive-value", sanitized)

    def test_template_dsl_sanitizer_redacts_malformed_historical_content(self):
        raw_text = "api_key: leaked-key\nheaders: Authorization:Bearer leaked-token\ninvalid: ["

        sanitized = sanitize_dsl_storage(raw_text)

        self.assertNotIn("leaked-key", sanitized)
        self.assertNotIn("leaked-token", sanitized)

    def test_agent_test_side_effect_detection_is_conservative(self):
        self.assertTrue(_test_query_has_side_effects("打开客厅灯并返回结果"))
        self.assertTrue(_test_query_has_side_effects("执行场景 scene.home"))
        self.assertTrue(_test_query_has_side_effects("turn_on light.demo"))
        self.assertFalse(_test_query_has_side_effects("查询当前照明设备状态，不要执行控制"))

    def test_agent_run_scope_is_self_for_normal_user_and_all_for_admin(self):
        normal_conditions = _agent_run_scope_conditions({"role": "user", "user_id": 9})
        admin_conditions = _agent_run_scope_conditions({"role": "admin", "user_id": 1})

        self.assertEqual(len(normal_conditions), 2)
        self.assertIn("operation_logs.user_id", str(normal_conditions[-1]))
        self.assertEqual(normal_conditions[-1].right.value, 9)
        self.assertEqual(len(admin_conditions), 1)

    def test_run_record_parses_auditable_fields(self):
        row = OperationLog(
            id=18,
            type="agent_test",
            level="error",
            title="智能体测试失败：环境分析工作流",
            detail=(
                "instance_id=7, query=查询最近 24 小时温度, "
                "answer=最近 24 小时平均温度为 24.2 摄氏度, "
                "message_id=msg-1, workflow_run_id=run-2, "
                "error=Dify 工作流超时"
            ),
            entity_id="agent:7",
            username="admin",
        )

        record = _run_record(row)

        self.assertEqual(record.instance_id, 7)
        self.assertEqual(record.instance_name, "环境分析工作流")
        self.assertEqual(record.status, "failed")
        self.assertEqual(record.query, "查询最近 24 小时温度")
        self.assertEqual(record.answer, "最近 24 小时平均温度为 24.2 摄氏度")
        self.assertEqual(record.message_id, "msg-1")
        self.assertEqual(record.workflow_run_id, "run-2")
        self.assertEqual(record.error, "Dify 工作流超时")

    def test_default_instance_uses_business_name_without_losing_runtime_name(self):
        instance = _instance(is_default=True)

        response = _to_response(instance)

        self.assertEqual(response.business_name, "智慧空间智能体")
        self.assertEqual(response.business_description, "统一承载设备控制、知识问答、数据查询和日常对话。")
        self.assertEqual(response.name, "00 Smart Home Unified Chatflow")

    def test_builtin_workflow_uses_chinese_business_name(self):
        response = _to_response(_instance(
            name="04 Data Analysis Workflow",
            source_template="template-04",
        ))

        self.assertEqual(response.business_name, "数据分析工作流")
        self.assertEqual(response.business_description, "负责查询平台监控与历史数据并生成分析结果。")
        self.assertEqual(response.name, "04 Data Analysis Workflow")

    def test_unbound_instance_does_not_expose_root_url_as_app_console(self):
        response = _to_response(_instance(
            dify_app_id="",
            dify_console_url="http://42.240.132.79",
        ))

        self.assertEqual(response.dify_console_url, "")

    def test_bound_instance_keeps_root_url_for_app_url_derivation(self):
        response = _to_response(_instance(
            dify_app_id="app-id",
            dify_console_url="http://dify.local",
        ))

        self.assertEqual(response.dify_console_url, "http://dify.local")

    def test_run_record_prefers_business_name_for_current_instance(self):
        row = OperationLog(
            id=19,
            type="agent_test",
            level="success",
            title="智能体测试运行：智慧空间智能体",
            detail="instance_id=7, instance_name=00 Smart Home Unified Chatflow, query=系统状态",
            entity_id="agent:7",
        )

        record = _run_record(row, {7: "智慧空间智能体"})

        self.assertEqual(record.business_name, "智慧空间智能体")
        self.assertEqual(record.instance_name, "00 Smart Home Unified Chatflow")

    def test_legacy_run_without_current_instance_uses_chinese_business_name(self):
        row = OperationLog(
            id=20,
            type="agent_test",
            level="success",
            title="智能体测试运行：05 Orchestration Smoke Test Workflow",
            detail="instance_id=99, query=联调自检",
            entity_id="agent:99",
        )

        record = _run_record(row)

        self.assertEqual(record.business_name, "联调测试工作流")
        self.assertEqual(record.instance_name, "05 Orchestration Smoke Test Workflow")

    def test_non_admin_instance_detail_hides_key_tail_and_dsl(self):
        response = _to_response(
            _instance(dify_api_key="app-sensitive-tail", dsl_content="app: {}"),
            include_dsl=False,
            include_secret_metadata=False,
        )

        self.assertTrue(response.has_dify_api_key)
        self.assertEqual(response.dify_api_key_masked, "")
        self.assertEqual(response.dify_console_url, "")
        self.assertEqual(response.dsl_content, "")

    def test_instance_configuration_writes_require_admin(self):
        for endpoint in (
            create_agent_instance,
            update_agent_instance,
            delete_agent_instance,
            upload_agent_dsl,
            import_agent_to_dify,
        ):
            dependency = inspect.signature(endpoint).parameters["current_user"].default.dependency
        self.assertIs(dependency, require_admin)


class AgentDslUploadBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_dsl_upload_accepts_utf8_yaml(self):
        content = "app:\n  name: 智慧家居智能体\n"

        result = await _read_agent_dsl_upload(FakeUpload("agent.yaml", content.encode("utf-8")))

        self.assertEqual(result, content)

    async def test_dsl_upload_rejects_invalid_extension_empty_oversize_and_encoding(self):
        cases = [
            (FakeUpload("agent.txt", b"app: {}"), 400, "仅支持上传"),
            (FakeUpload("agent.yml", b""), 400, "不能为空"),
            (FakeUpload("agent.yml", b"a" * (MAX_AGENT_DSL_FILE_SIZE + 1)), 413, "不能超过 2MB"),
            (FakeUpload("agent.yml", b"\xff\xfe"), 400, "UTF-8"),
        ]
        for upload, status_code, detail in cases:
            with self.subTest(filename=upload.filename, size=len(upload.content)):
                with self.assertRaises(HTTPException) as raised:
                    await _read_agent_dsl_upload(upload)
                self.assertEqual(raised.exception.status_code, status_code)
                self.assertIn(detail, raised.exception.detail)


class AgentRuntimeEvidenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _invalidate_runtime_evidence()

    def tearDown(self):
        _invalidate_runtime_evidence()

    async def test_non_default_instance_never_borrows_system_key(self):
        with patch(
            "app.routers.agents.DifyService.get_app_info",
            new=AsyncMock(),
        ) as get_info:
            evidence = await _get_runtime_evidence(_instance(), _runtime(), force=True)

        self.assertEqual(evidence.status, "unconfigured")
        self.assertEqual(evidence.binding_status, "unconfigured")
        self.assertIn("API 密钥", evidence.error)
        get_info.assert_not_awaited()

    async def test_default_instance_can_use_system_runtime_key(self):
        get_info = AsyncMock(return_value={
            "name": "00 Smart Home Unified Chatflow",
            "mode": "advanced-chat",
        })
        with patch("app.routers.agents.DifyService.get_app_info", new=get_info):
            evidence = await _get_runtime_evidence(
                _instance(is_default=True),
                _runtime(),
                force=True,
            )

        self.assertEqual(evidence.status, "running")
        self.assertEqual(evidence.binding_status, "system_runtime_fallback")
        self.assertTrue(evidence.name_matches)
        get_info.assert_awaited_once()

    async def test_app_name_mismatch_is_visible(self):
        get_info = AsyncMock(return_value={
            "name": "另一个 Dify 应用",
            "mode": "workflow",
        })
        with patch("app.routers.agents.DifyService.get_app_info", new=get_info):
            evidence = await _get_runtime_evidence(
                _instance(dify_api_key="instance-key"),
                _runtime(),
                force=True,
            )

        self.assertEqual(evidence.status, "mismatch")
        self.assertEqual(evidence.binding_status, "instance_key")
        self.assertFalse(evidence.name_matches)
        self.assertIn("应用名称", evidence.error)

    def test_instance_summary_conditions_separate_callable_and_template_records(self):
        without_runtime = str(agent_callable_condition(False).compile(compile_kwargs={"literal_binds": True}))
        with_runtime = str(agent_callable_condition(True).compile(compile_kwargs={"literal_binds": True}))
        template_reference = str(agent_template_reference_condition().compile(compile_kwargs={"literal_binds": True}))

        self.assertIn("agent_instances.enabled IS true", without_runtime)
        self.assertIn("agent_instances.dify_api_key != ''", without_runtime)
        self.assertNotIn("agent_instances.is_default IS true", without_runtime)
        self.assertIn("agent_instances.is_default IS true", with_runtime)
        self.assertIn("agent_instances.source_type IN ('built_in_template', 'template_library')", template_reference)
        self.assertIn("agent_instances.is_default IS false", template_reference)

    async def test_framework_overview_separates_callable_instances_from_template_records(self):
        db = AsyncMock()
        db.scalar.side_effect = [6, 1, 0, 5]

        with (
            patch("app.services.agent_framework.ensure_seed_instances", AsyncMock()),
            patch("app.services.agent_framework.get_runtime_config", AsyncMock(return_value=_runtime())),
        ):
            payload = await get_overview_payload(db)

        metrics = {item["label"]: item for item in payload["metrics"]}
        self.assertEqual(metrics["登记记录"]["value"], "6")
        self.assertEqual(metrics["调用已配置"]["value"], "1")
        self.assertEqual(metrics["模板参考记录"]["value"], "5")
        self.assertNotIn("已就绪实例", metrics)


class AgentPaginationTests(unittest.IsolatedAsyncioTestCase):
    async def test_primary_instance_scope_includes_default_and_template_candidates(self):
        default_instance = _instance(
            id=12,
            name="自定义默认智能体",
            source_template="custom-template",
            is_default=True,
        )
        db = _AgentListDb(
            scalar=1,
            results=[
                _AgentListResult(rows=[default_instance]),
                _AgentListResult(rows=[]),
                _AgentListResult(one=(3, 2, 1, 1, 2, 1)),
                _AgentListResult(one=(4, 1)),
            ],
        )
        with (
            patch("app.routers.agents.ensure_seed_instances", AsyncMock()),
            patch("app.routers.agents.get_runtime_config", AsyncMock(return_value=_runtime())),
        ):
            payload = await list_agent_instances(
                page=1,
                page_size=1,
                keyword="",
                status="",
                instance_type="",
                source_type="",
                bound=None,
                refresh_runtime=False,
                primary_only=True,
                include_runtime=False,
                current_user={"user_id": 1, "role": "admin"},
                db=db,
            )

        self.assertEqual([item.id for item in payload.instances], [12])
        count_query = str(db.statements[0].compile(compile_kwargs={"literal_binds": True}))
        self.assertIn("agent_instances.is_default IS true", count_query)
        self.assertIn("agent_instances.source_template = 'template-00'", count_query)
        self.assertIn("lower(agent_instances.name) LIKE lower('00 %')", count_query)

    async def test_instance_list_clamps_oversized_page_before_querying(self):
        instance = _instance(id=9)
        db = _AgentListDb(
            scalar=3,
            results=[
                _AgentListResult(rows=[instance]),
                _AgentListResult(rows=[]),
                _AgentListResult(one=(3, 2, 1, 1, 2, 1)),
                _AgentListResult(one=(4, 1)),
            ],
        )
        with (
            patch("app.routers.agents.ensure_seed_instances", AsyncMock()),
            patch("app.routers.agents.get_runtime_config", AsyncMock(return_value=_runtime())),
        ):
            payload = await list_agent_instances(
                page=9,
                page_size=2,
                keyword="",
                status="",
                instance_type="",
                source_type="",
                bound=None,
                refresh_runtime=False,
                primary_only=False,
                include_runtime=False,
                current_user={"user_id": 1, "role": "admin"},
                db=db,
            )

        self.assertEqual(payload.page, 2)
        self.assertEqual([item.id for item in payload.instances], [9])
        self.assertEqual(payload.summary.callable_instances, 2)
        self.assertEqual(payload.summary.template_reference_instances, 1)
        data_query = str(db.statements[1].compile(compile_kwargs={"literal_binds": True}))
        self.assertIn("OFFSET 2", data_query)

    async def test_run_list_clamps_oversized_page_before_querying(self):
        row = OperationLog(
            id=31,
            type="agent_test",
            level="success",
            title="智能体测试运行：智慧空间智能体",
            detail="instance_id=7, query=系统状态, answer=运行正常",
            entity_id="agent:7",
            username="admin",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
        )
        db = _AgentListDb(
            scalar=3,
            results=[
                _AgentListResult(rows=[row]),
                _AgentListResult(rows=[_instance(id=7)]),
                _AgentListResult(one=(3, 2, 1, 1)),
            ],
        )

        payload = await list_agent_runs(
            page=9,
            page_size=2,
            keyword="",
            status="",
            instance_id=None,
            current_user={"user_id": 1, "role": "admin"},
            db=db,
        )

        self.assertEqual(payload.page, 2)
        self.assertEqual([item.id for item in payload.items], [31])
        data_query = str(db.statements[1].compile(compile_kwargs={"literal_binds": True}))
        self.assertIn("OFFSET 2", data_query)


class DifyBaseUrlTests(unittest.TestCase):
    def test_console_app_routes_are_reduced_to_origin(self):
        self.assertEqual(
            derive_dify_base_url("http://192.0.2.10/app/example/workflow"),
            "http://192.0.2.10",
        )


class _TemplateResult:
    def __init__(self, *, scalar=None, rows=None):
        self._scalar = scalar
        self._rows = rows or []

    def scalar(self):
        return self._scalar

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _TemplateDb:
    def __init__(self, results):
        self.results = list(results)
        self.added = []

    async def execute(self, _statement):
        if not self.results:
            raise AssertionError("模板库测试缺少预设查询结果")
        return self.results.pop(0)

    def add(self, value):
        self.added.append(value)

    async def flush(self):
        template = next((item for item in self.added if isinstance(item, AgentTemplateLibrary)), None)
        if template is not None and template.id is None:
            template.id = 21

    async def refresh(self, _value):
        return None


class _CreateFromLibraryResult:
    def scalar_one_or_none(self):
        return None


class _CreateFromLibraryDb:
    def __init__(self, template):
        self.template = template
        self.added = []

    async def get(self, model, item_id):
        if model is AgentTemplateLibrary and item_id == self.template.id:
            return self.template
        return None

    async def execute(self, _statement):
        return _CreateFromLibraryResult()

    def add(self, value):
        self.added.append(value)

    async def flush(self):
        instance = next((item for item in self.added if isinstance(item, AgentInstance)), None)
        if instance is not None and instance.id is None:
            instance.id = 88

    async def refresh(self, _value):
        return None


class _AgentListResult:
    def __init__(self, *, rows=None, one=None):
        self._rows = rows or []
        self._one = one

    def scalars(self):
        return self

    def all(self):
        return self._rows

    def one(self):
        return self._one


class _AgentListDb:
    def __init__(self, *, scalar, results):
        self.scalar_value = scalar
        self.results = list(results)
        self.statements = []

    async def scalar(self, statement):
        self.statements.append(statement)
        return self.scalar_value

    async def execute(self, statement):
        self.statements.append(statement)
        if not self.results:
            raise AssertionError("智能体分页测试缺少预设查询结果")
        return self.results.pop(0)


class AgentTemplateLibraryTests(unittest.IsolatedAsyncioTestCase):
    def test_builtin_template_uses_business_name_and_keeps_file_evidence(self):
        detail = _builtin_template_library_detail()

        self.assertEqual(detail.name, "智慧空间智能体模板")
        self.assertEqual(detail.file_name, "00 Smart Home Unified Chatflow.yml")
        self.assertNotEqual(detail.name, detail.file_name.removesuffix(".yml"))

    def test_builtin_search_matches_business_fields_and_source(self):
        detail = AgentTemplateLibraryDetail(
            id="builtin-template-00",
            name="智慧家居统一智能体",
            description="设备控制与知识问答",
            tags=["Chatflow", "DSL"],
            file_name="smart-home.yml",
            source="builtin",
            readonly=True,
            created_at="",
            updated_at="",
            dsl_content="app: {}",
        )
        self.assertTrue(_builtin_template_matches(detail, "知识问答", ""))
        self.assertTrue(_builtin_template_matches(detail, "chatflow", "builtin"))
        self.assertFalse(_builtin_template_matches(detail, "不存在", ""))
        self.assertFalse(_builtin_template_matches(detail, "智慧家居", "uploaded"))

    def test_uploaded_template_derives_real_mode_without_fabricating_description(self):
        item = AgentTemplateLibrary(
            id=9,
            name="市场调研助手",
            description="未填写描述",
            tags=["上传模板", "workflow", "DSL"],
            file_name="market.yml",
            dsl_content="app:\n  name: 市场调研助手\n  mode: workflow\n  description: ''\nkind: app\n",
            source="uploaded",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
            updated_at=datetime(2026, 7, 30, 10, 0, 0),
        )

        payload = _to_template_library_item(item)

        self.assertEqual(payload.description, "DSL 未提供用途说明")
        self.assertIn("工作流", payload.tags)
        self.assertNotIn("workflow", payload.tags)

    def test_dsl_description_uses_author_written_node_description_when_app_description_is_empty(self):
        parsed = parse_dsl_content("""app:
  name: 市场调研助手
  mode: workflow
  description: ''
workflow:
  graph:
    nodes:
    - data:
        type: start
        desc: 输入网址
    - data:
        type: llm
        desc: 接收采集结果并整理成结构化的市场调研报告。
""")

        self.assertEqual(parsed["description"], "接收采集结果并整理成结构化的市场调研报告。")

    def test_explicit_app_description_keeps_priority_over_node_descriptions(self):
        parsed = parse_dsl_content("""app:
  name: 环境分析助手
  mode: workflow
  description: 分析真实环境数据并生成报告。
workflow:
  graph:
    nodes:
    - data:
        desc: 这是节点内部说明，不应覆盖应用说明。
""")

        self.assertEqual(parsed["description"], "分析真实环境数据并生成报告。")

    def test_uploaded_template_hides_dsl_kind_and_version_from_business_tags(self):
        item = AgentTemplateLibrary(
            id=12,
            name="设备巡检助手",
            description="巡检设备状态",
            tags=["上传模板", "app", "DSL", "1.5.0", "advanced-chat", "设备巡检"],
            file_name="inspection.yml",
            dsl_content="app:\n  mode: advanced-chat\n",
            source="uploaded",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
            updated_at=datetime(2026, 7, 30, 10, 0, 0),
        )

        payload = _to_template_library_item(item)

        self.assertEqual(payload.tags, ["对话流", "设备巡检"])

    async def test_create_instance_from_library_copies_dsl_snapshot(self):
        template = AgentTemplateLibrary(
            id=13,
            name="环境分析助手",
            description="分析环境状态",
            tags=["上传模板", "workflow", "环境分析"],
            file_name="environment.yml",
            dsl_content="app:\n  name: 环境分析助手\n  mode: workflow\n  description: 分析环境状态\n",
            source="uploaded",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
            updated_at=datetime(2026, 7, 30, 10, 0, 0),
        )
        db = _CreateFromLibraryDb(template)

        with patch("app.routers.agents.ensure_seed_instances", AsyncMock()):
            response = await create_agent_instance(
                body=AgentInstanceCreate(
                    name="现场环境分析",
                    source_type="template_library",
                    source_template="13",
                    enabled=True,
                ),
                current_user={"user_id": 1, "role": "admin"},
                db=db,
            )

        instance = next(item for item in db.added if isinstance(item, AgentInstance))
        self.assertEqual(response.source_type, "template_library")
        self.assertEqual(instance.source_template, "13")
        self.assertEqual(instance.dsl_file_name, "environment.yml")
        self.assertEqual(instance.instance_type, "workflow")
        self.assertIn("mode: workflow", instance.dsl_content)
        self.assertEqual(instance.description, "分析环境状态")
        self.assertIn("环境分析", instance.capability_tags)
        audit = next(item for item in db.added if isinstance(item, OperationLog))
        self.assertEqual(audit.type, "agent_instance")
        self.assertIn("source_template=13", audit.detail)
        self.assertNotIn("mode: workflow", audit.detail)

    def test_uploaded_template_keeps_manually_edited_description(self):
        item = AgentTemplateLibrary(
            id=10,
            name="环境分析模板",
            description="查询真实环境数据并生成分析结果",
            tags=["数据查询"],
            file_name="environment.yml",
            dsl_content="app:\n  mode: advanced-chat\n  description: DSL 原始说明\n",
            source="uploaded",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
            updated_at=datetime(2026, 7, 30, 10, 0, 0),
        )

        payload = _to_template_library_item(item)

        self.assertEqual(payload.description, "查询真实环境数据并生成分析结果")
        self.assertIn("对话流", payload.tags)

    def test_template_list_searches_the_chinese_mode_and_derived_description_shown_on_cards(self):
        source = inspect.getsource(list_agent_template_library)

        self.assertIn("TEMPLATE_MODE_SEARCH_VALUES", source)
        self.assertIn("AgentTemplateLibrary.dsl_content.ilike", source)
        self.assertIn("AgentTemplateLibrary.dsl_content", source)
        self.assertIn('func.replace(field, "的", "")', source)

    async def test_list_uses_server_pagination_and_full_summary(self):
        uploaded = AgentTemplateLibrary(
            id=8,
            name="环境分析模板",
            description="查询真实环境数据",
            tags=["数据查询"],
            file_name="environment.yml",
            dsl_content="app: {}",
            source="uploaded",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
            updated_at=datetime(2026, 7, 30, 10, 0, 0),
        )
        db = _TemplateDb([
            _TemplateResult(scalar=4),
            _TemplateResult(scalar=4),
            _TemplateResult(rows=[uploaded]),
        ])

        payload = await list_agent_template_library(
            page=2,
            page_size=2,
            keyword="",
            source="",
            current_user={"role": "admin"},
            db=db,
        )

        self.assertEqual(payload.total, 5)
        self.assertEqual(payload.page, 2)
        self.assertEqual(payload.page_count, 3)
        self.assertEqual(payload.summary.total_templates, 5)
        self.assertEqual(payload.summary.builtin_templates, 1)
        self.assertEqual(payload.summary.uploaded_templates, 4)
        self.assertTrue(payload.can_manage)
        self.assertEqual([item.id for item in payload.items], ["8"])
        source = inspect.getsource(list_agent_template_library)
        self.assertIn(".offset(upload_offset)", source)
        self.assertIn(".limit(upload_limit)", source)

    async def test_upload_same_dsl_returns_existing_template_without_duplicate_insert(self):
        content = "app:\n  name: 环境分析助手\n  mode: workflow\n"
        existing = AgentTemplateLibrary(
            id=20,
            name="环境分析助手",
            description="DSL 未提供用途说明",
            tags=["上传模板", "工作流"],
            file_name="environment.yml",
            dsl_content=content,
            source="uploaded",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
            updated_at=datetime(2026, 7, 30, 10, 0, 0),
        )
        db = _TemplateDb([_TemplateResult(rows=[existing])])

        response = await upload_agent_template_library_file(
            file=FakeUpload("copy.yml", content.encode("utf-8")),
            current_user={"user_id": 1, "username": "admin", "role": "admin"},
            db=db,
        )

        self.assertFalse(response.created)
        self.assertEqual(response.item.id, "20")
        self.assertEqual(db.added, [])

    def test_template_writes_require_admin_and_audit_excludes_dsl(self):
        for endpoint in (
            upload_agent_template_library_file,
            update_agent_template_library_file,
            delete_agent_template_library_file,
        ):
            dependency = inspect.signature(endpoint).parameters["current_user"].default.dependency
            self.assertIs(dependency, require_admin)

        db = MagicMock()
        item = AgentTemplateLibraryItem(
            id="8",
            name="环境分析模板",
            description="真实数据查询",
            tags=["数据查询"],
            file_name="environment.yml",
            source="uploaded",
            created_at="",
            updated_at="",
        )
        _record_template_library_action(
            db,
            {"user_id": 1, "username": "admin"},
            "upload",
            item,
        )
        log = db.add.call_args.args[0]
        self.assertEqual(log.type, "agent_template")
        self.assertIn("template_id=8", log.detail)
        self.assertNotIn("dsl_content", log.detail)
        self.assertNotIn("app: {}", log.detail)

        instance_db = MagicMock()
        _record_agent_instance_action(
            instance_db,
            {"user_id": 1, "username": "admin"},
            "update",
            _instance(dify_api_key="app-sensitive-value"),
            changed_fields=["dify_api_key", "dify_console_url"],
        )
        instance_log = instance_db.add.call_args.args[0]
        self.assertEqual(instance_log.type, "agent_instance")
        self.assertIn("changed_fields=dify_api_key,dify_console_url", instance_log.detail)
        self.assertNotIn("app-sensitive-value", instance_log.detail)
        self.assertEqual(
            derive_dify_base_url("https://dify.example.com/chat/example"),
            "https://dify.example.com",
        )
        self.assertEqual(
            derive_dify_base_url("https://dify.example.com/apps"),
            "https://dify.example.com",
        )


if __name__ == "__main__":
    unittest.main()
