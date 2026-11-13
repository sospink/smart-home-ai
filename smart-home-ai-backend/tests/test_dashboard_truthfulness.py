import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.routers.monitor import (
    _collapsed_operation_log_query,
    _csv_cell,
    _operation_log_filters,
    _operation_log_cleanup_preview,
    _operation_log_retention_filter,
    _operation_log_level_label,
    _operation_log_scope_filters,
    _operation_log_type_label,
    _serialize_grouped_operation_log,
    _serialize_operation_log,
    OperationLogCleanupRequest,
    cleanup_operation_log_retention,
    export_logs,
    preview_operation_log_retention,
    recent_logs,
)
from app.routers.system import (
    _business_log_title,
    _build_dashboard_runtime_payload,
    _dataset_total,
    _distinct_dashboard_logs,
    _load_dashboard_platform_data,
    _load_runtime_value,
    _managed_device_stats,
    _runtime_error_message,
    dashboard,
    public_summary,
)
from app.services.system_summary_cache import invalidate_system_summary
from app.services.log_display import business_log_summary, business_log_title


class _Result:
    def __init__(self, *, scalar=None, rows=None, rowcount=0):
        self._scalar = scalar
        self._rows = rows or []
        self.rowcount = rowcount

    def scalar(self):
        return self._scalar

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return self

    def unique(self):
        return self

    def all(self):
        return self._rows


class DashboardTruthfulnessTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _frontend_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "dashboard"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_dashboard_first_failures_are_owned_by_their_content_sections(self):
        source = self._frontend_source()
        self.assertIn("platformError && platformData", source)
        self.assertIn("runtimeError && runtimeData", source)
        self.assertIn("!platformData && platformError", source)
        self.assertIn("runtimeError && !runtimeData && services.length > 0", source)
        self.assertIn("不按零条日志统计", source)
        self.assertIn("当前没有成功服务快照，不能判断服务是否可用", source)
        self.assertIn("if (platformError) void loadPlatform(true)", source)
        self.assertIn("if (runtimeError) void loadRuntime(true)", source)

    def test_dashboard_service_table_has_accurate_region_semantics(self):
        source = self._frontend_source()
        self.assertIn('aria-label="核心服务状态列表，可横向滚动"', source)
        self.assertNotIn('aria-label="系统活动记录列表，可横向滚动"', source)

    def test_dashboard_converts_legacy_service_keys_to_display_names(self):
        self.assertEqual(
            _business_log_title("homeassistant 连接测试通过"),
            "Home Assistant 连接测试通过",
        )
        self.assertEqual(_business_log_title("dify 连接测试未通过"), "Dify 连接测试未通过")
        self.assertEqual(_business_log_title("设备控制成功"), "设备控制成功")
        self.assertEqual(
            _business_log_title("控制 筒灯 已下发，待实机确认：set_effect"),
            "控制 筒灯 已下发，待实机确认：选择灯光效果",
        )
        self.assertEqual(
            _business_log_title("下发控制 筒灯：set_color_temperature"),
            "下发控制 筒灯：设置色温",
        )
        self.assertEqual(
            business_log_title("控制 筒灯 已下发，待实机确认：turn_on"),
            "控制 筒灯 已下发，待实机确认：打开",
        )

    def test_monitor_log_serialization_uses_same_business_title(self):
        row = SimpleNamespace(
            id=1,
            type="device_control",
            level="warning",
            title="控制 筒灯 已下发，待实机确认：turn_off",
            detail="action=turn_off",
            username="admin",
            entity_id="light.real",
            created_at=datetime.now(),
        )

        payload = _serialize_operation_log(row)

        self.assertEqual(payload["title"], "控制 筒灯 已下发，待实机确认：关闭")
        self.assertNotIn("turn_off", payload["title"])
        self.assertEqual(payload["summary"], "已记录设备控制操作；原始字段请在技术信息中查看。")

    def test_business_log_summary_separates_business_copy_from_technical_detail(self):
        summary = business_log_summary(
            "model_inference",
            "model=qwen3; result=inference_failed; error=Connection refused http://192.168.34.190",
        )
        structured = business_log_summary("system_settings", '{"action":"save","api_key":"secret"}')

        self.assertIn("模型 qwen3 推理未完成", summary)
        self.assertNotIn("192.168.34.190", summary)
        self.assertNotIn("Connection refused", summary)
        self.assertEqual(structured, "已记录系统配置操作；完整字段请在技术信息中查看。")
        self.assertNotIn("secret", structured)

        retrieval = business_log_summary(
            "knowledge_management",
            '{"action":"hit_testing","status":"success","hit_count":3,"duration_ms":128}',
        )
        failed_retrieval = business_log_summary(
            "knowledge_management",
            '{"action":"hit_testing","status":"failed","error_category":"network","duration_ms":25}',
        )
        self.assertEqual(retrieval, "语义检索完成，命中 3 条，耗时 128 ms。")
        self.assertEqual(failed_retrieval, "语义检索失败，耗时 25 ms；请在技术信息中查看错误分类。")

    def test_business_log_summary_explains_stable_audit_fields(self):
        self.assertEqual(
            business_log_summary("user_login", "user_id=2, role=user"),
            "登录成功，当前身份为普通用户。",
        )
        self.assertEqual(
            business_log_summary("model_inference", "model=qwen3; latency_ms=128; result=success"),
            "模型 qwen3 推理完成，耗时 128 ms。",
        )
        self.assertEqual(
            business_log_summary("device_control", "action=turn_off; result=physical_pending"),
            "设备控制结果：待实机确认；执行动作：关闭。",
        )
        self.assertEqual(
            business_log_summary("time_series", "written=42, entity_count=3"),
            "时序数据同步完成：写入 42 个数据点，覆盖 3 个实体。",
        )
        self.assertEqual(
            business_log_summary(
                "agent_device_status",
                "message_id=1, result=success, answer=筒灯当前状态：power：on（亮度 100%）",
            ),
            "状态查询结果：筒灯当前状态：电源：开启（亮度 100%）",
        )
        self.assertEqual(
            business_log_summary("agent_test", "instance_id=7, answer=当前系统运行正常"),
            "智能体测试完成：当前系统运行正常",
        )
        self.assertNotIn(
            "未完成",
            business_log_summary("agent_device_status", "result=success, answer=设备状态正常"),
        )

    def test_managed_device_stats_only_count_platform_inventory(self):
        enabled = SimpleNamespace(
            enabled=True,
            mappings=[SimpleNamespace(
                endpoint="light.real",
                gateway_type="homeassistant",
            )],
        )
        disabled = SimpleNamespace(
            enabled=False,
            mappings=[SimpleNamespace(
                endpoint="sensor.helper",
                gateway_type="homeassistant",
            )],
        )
        states = [
            {"entity_id": "light.real", "state": "on"},
            {"entity_id": "sensor.unregistered", "state": "20"},
        ]

        self.assertEqual(_managed_device_stats([enabled, disabled], states), (1, 1))
        self.assertEqual(_managed_device_stats([enabled, disabled], None), (1, None))

    async def test_external_counts_preserve_unknown_instead_of_fake_zero(self):
        self.assertIsNone(_dataset_total(None))
        self.assertIsNone(_dataset_total({"data": "invalid"}))
        self.assertEqual(_dataset_total({"total": 4}), 4)

        async def broken_loader():
            raise RuntimeError("外部服务不可用")

        result = await _load_runtime_value(broken_loader, 1)
        self.assertEqual(result["status"], "stopped")
        self.assertIsNone(result["value"])
        self.assertIn("外部服务不可用", result["error"])

    def test_runtime_errors_are_converted_to_chinese_diagnostics(self):
        self.assertIn("无法建立连接", _runtime_error_message(RuntimeError("All connection attempts failed")))
        self.assertIn("认证失败", _runtime_error_message(RuntimeError("401 Unauthorized")))
        self.assertIn("连接超时", _runtime_error_message(RuntimeError("Read timeout")))

    async def test_dashboard_has_real_counts_and_no_fake_uptime_percentages(self):
        device = SimpleNamespace(
            enabled=True,
            mappings=[SimpleNamespace(
                endpoint="light.real",
                gateway_type="homeassistant",
            )],
        )
        log = SimpleNamespace(
            id=8,
            type="device_control",
            level="warning",
            title="控制已下发，待实机确认",
            username="admin",
            entity_id="light.real",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
        )
        db = AsyncMock()
        db.execute.side_effect = [
            _Result(scalar=3),
            _Result(scalar=2),
            _Result(scalar=1),
            _Result(rows=[device]),
            _Result(rows=[log]),
        ]
        runtime = SimpleNamespace(
            config=SimpleNamespace(
                ollama_base_url="http://localhost:11434",
                dify_base_url="http://dify.local",
                dify_api_key="configured",
                dify_dataset_api_key="configured",
                ha_base_url="http://ha.local:8123",
                ha_token="configured",
                influxdb_url="http://influx.local:8086",
            ),
            ollama=SimpleNamespace(list_models=AsyncMock()),
            dify_knowledge=SimpleNamespace(list_datasets=AsyncMock()),
            dify=SimpleNamespace(get_app_info=AsyncMock()),
            homeassistant=SimpleNamespace(get_states=AsyncMock()),
        )
        runtime_values = [
            {"status": "running", "latency_ms": 8, "value": [{"name": "qwen"}], "error": ""},
            {"status": "running", "latency_ms": 12, "value": {"total": 4}, "error": ""},
            {"status": "running", "latency_ms": 15, "value": {"name": "默认智能体"}, "error": ""},
            {"status": "running", "latency_ms": 10, "value": [{"entity_id": "light.real", "state": "on"}], "error": ""},
            {"status": "stopped", "latency_ms": 0, "value": None, "error": "连接失败"},
        ]

        with (
            patch("app.routers.system.get_runtime_services", AsyncMock(return_value=runtime)),
            patch("app.routers.system._load_runtime_value", AsyncMock(side_effect=runtime_values)),
        ):
            payload = await dashboard(user={"user_id": 1, "role": "admin"}, db=db)

        self.assertEqual(payload["stats"]["registered_devices"], 1)
        self.assertEqual(payload["stats"]["online_devices"], 1)
        self.assertEqual(payload["stats"]["model_count"], 1)
        self.assertEqual(payload["stats"]["knowledge_count"], 4)
        home_assistant = next(
            service for service in payload["services"]
            if service["key"] == "homeassistant"
        )
        self.assertEqual(home_assistant["detail"], "1/1 个平台设备的 HA 状态可读")
        self.assertNotIn("在线", home_assistant["detail"])
        self.assertEqual(payload["recent_activity"][0]["id"], 8)
        self.assertTrue(payload["warnings"])
        self.assertEqual(payload["warnings"], ["InfluxDB 时序库：连接失败"])
        serialized = str(payload)
        self.assertNotIn("99.99%", serialized)
        self.assertNotIn("98.21%", serialized)
        self.assertFalse(any("uptime" in service for service in payload["services"]))

    async def test_dashboard_activity_reports_scan_coverage(self):
        rows = [
            SimpleNamespace(
                id=index,
                type="user_login",
                level="info",
                title=f"用户 {index} 登录系统",
                username=f"user-{index}",
                entity_id="",
                created_at=datetime(2026, 7, 30, 10, 0, 0),
            )
            for index in range(101, 0, -1)
        ]
        db = AsyncMock()
        db.execute.side_effect = [
            _Result(scalar=1),
            _Result(scalar=1),
            _Result(scalar=0),
            _Result(rows=[]),
            _Result(rows=rows),
        ]

        payload, _ = await _load_dashboard_platform_data(
            db,
            include_private=True,
            current_user={"user_id": 1, "role": "admin"},
        )

        self.assertEqual(payload["activity_coverage"]["scanned_count"], 100)
        self.assertEqual(payload["activity_coverage"]["scan_limit"], 100)
        self.assertTrue(payload["activity_coverage"]["scan_truncated"])
        self.assertEqual(payload["activity_coverage"]["distinct_count"], 8)
        self.assertEqual(len(payload["recent_activity"]), 8)

    async def test_runtime_dashboard_uses_agent_business_name(self):
        runtime = SimpleNamespace(
            config=SimpleNamespace(
                ollama_base_url="http://ollama.local",
                dify_base_url="http://dify.local",
                dify_api_key="configured",
                dify_dataset_api_key="configured",
                ha_base_url="http://ha.local",
                ha_token="configured",
                influxdb_url="http://influx.local",
            ),
            ollama=SimpleNamespace(list_models=AsyncMock()),
            dify_knowledge=SimpleNamespace(list_datasets=AsyncMock()),
            dify=SimpleNamespace(get_app_info=AsyncMock()),
            homeassistant=SimpleNamespace(get_states=AsyncMock()),
        )
        runtime_values = [
            {"status": "running", "latency_ms": 8, "value": [], "error": ""},
            {"status": "running", "latency_ms": 9, "value": {"total": 1}, "error": ""},
            {
                "status": "running",
                "latency_ms": 10,
                "value": {"name": "00 Smart Home Unified Chatflow"},
                "error": "",
            },
            {"status": "running", "latency_ms": 11, "value": [], "error": ""},
            {"status": "running", "latency_ms": 12, "value": {}, "error": ""},
        ]

        with (
            patch("app.routers.system.get_runtime_services", AsyncMock(return_value=runtime)),
            patch("app.routers.system._load_runtime_value", AsyncMock(side_effect=runtime_values)),
        ):
            payload = await _build_dashboard_runtime_payload(AsyncMock(), managed_devices=[])

        app_service = next(item for item in payload["services"] if item["key"] == "dify_app")
        self.assertEqual(app_service["detail"], "智慧空间智能体")
        self.assertNotIn("00 Smart Home Unified Chatflow", str(payload))

        with (
            patch("app.routers.system.get_runtime_services", AsyncMock(return_value=runtime)),
            patch("app.routers.system._load_runtime_value", AsyncMock(side_effect=runtime_values)),
        ):
            hidden = await _build_dashboard_runtime_payload(
                AsyncMock(),
                managed_devices=[],
                include_endpoints=False,
            )
        self.assertTrue(all(not service["endpoint"] for service in hidden["services"]))

    async def test_platform_scope_does_not_wait_for_external_services(self):
        device = SimpleNamespace(enabled=True, mappings=[])
        db = AsyncMock()
        db.execute.side_effect = [
            _Result(scalar=4),
            _Result(scalar=3),
            _Result(scalar=1),
            _Result(rows=[device]),
            _Result(rows=[]),
        ]

        with patch("app.routers.system.get_runtime_services", AsyncMock()) as runtime_loader:
            payload = await dashboard(scope="platform", user={"user_id": 1, "role": "admin"}, db=db)

        runtime_loader.assert_not_awaited()
        self.assertEqual(payload["scope"], "platform")
        self.assertEqual(payload["stats"]["total_users"], 4)
        self.assertEqual(payload["stats"]["registered_devices"], 1)
        self.assertIsNone(payload["stats"]["online_devices"])
        self.assertEqual([item["key"] for item in payload["services"]], ["backend"])

    async def test_normal_user_dashboard_only_uses_own_account_and_activity(self):
        own_log = SimpleNamespace(
            id=9,
            type="model_inference",
            level="success",
            title="模型推理测试成功",
            username="student",
            entity_id="qwen3:8b",
            created_at=datetime(2026, 7, 31, 10, 0, 0),
        )
        db = AsyncMock()
        db.execute.side_effect = [
            _Result(scalar=1),
            _Result(scalar=1),
            _Result(scalar=0),
            _Result(rows=[]),
            _Result(rows=[own_log]),
        ]

        payload, _devices = await _load_dashboard_platform_data(
            db,
            current_user={"user_id": 42, "role": "user"},
        )

        self.assertEqual(payload["visibility_scope"], "self")
        self.assertEqual(payload["stats"]["total_users"], 1)
        self.assertEqual(payload["recent_activity"][0]["username"], "student")
        statements = [str(call.args[0]) for call in db.execute.await_args_list]
        self.assertIn("users.id =", statements[0])
        self.assertIn("operation_logs.user_id =", statements[-1])

    async def test_invalid_dashboard_scope_is_rejected(self):
        with self.assertRaises(HTTPException) as invalid:
            await dashboard(scope="private", user={"user_id": 1, "role": "admin"}, db=AsyncMock())
        self.assertEqual(invalid.exception.status_code, 422)

    async def test_public_summary_is_cached_and_does_not_expose_endpoints_or_users(self):
        dashboard_payload = {
            "stats": {
                "total_users": 9,
                "active_users": 8,
                "new_users_7d": 2,
                "registered_devices": 3,
                "online_devices": 2,
                "model_count": None,
                "knowledge_count": 4,
            },
            "services": [
                {
                    "key": "backend",
                    "name": "平台后端",
                    "endpoint": "http://private-backend",
                    "status": "running",
                    "latency_ms": 0,
                    "detail": "敏感诊断",
                    "source": "内部探测",
                },
                {
                    "key": "ollama",
                    "name": "Ollama 推理服务",
                    "endpoint": "http://localhost:11434",
                    "status": "stopped",
                    "latency_ms": 0,
                    "detail": "连接失败",
                    "source": "内部探测",
                },
            ],
            "recent_activity": [{"title": "不应公开"}],
            "activity_coverage": {"scanned_count": 100, "scan_truncated": True},
            "warnings": ["不应公开"],
            "generated_at": "2026-07-30T11:00:00+08:00",
            "backend_uptime_seconds": 100,
        }
        cache = {"expires_at": 0.0, "value": None}
        with (
            patch("app.routers.system._build_dashboard_payload", AsyncMock(return_value=dashboard_payload)) as builder,
            patch("app.routers.system._public_summary_cache", cache),
        ):
            first = await public_summary(db=AsyncMock())
            second = await public_summary(db=AsyncMock())

        self.assertEqual(builder.await_count, 1)
        builder.assert_awaited_once_with(unittest.mock.ANY, include_private=False)
        self.assertEqual(first["overall_status"], "degraded")
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(first["stats"]["online_devices"], 2)
        self.assertIsNone(first["stats"]["model_count"])
        self.assertNotIn("total_users", first["stats"])
        self.assertNotIn("endpoint", first["services"][0])
        self.assertNotIn("recent_activity", first)
        self.assertNotIn("activity_coverage", first)
        self.assertNotIn("warnings", first)

    async def test_public_summary_rebuilds_after_shared_generation_is_invalidated(self):
        dashboard_payload = {
            "stats": {
                "registered_devices": 1,
                "online_devices": 1,
                "model_count": 1,
                "knowledge_count": 4,
            },
            "services": [{
                "key": "backend",
                "name": "平台后端",
                "endpoint": "/api/v1/system/health",
                "status": "running",
                "latency_ms": 0,
            }],
            "generated_at": "2026-07-31T15:00:00+08:00",
        }
        cache = {"expires_at": 0.0, "value": None}
        with (
            patch("app.routers.system._build_dashboard_payload", AsyncMock(return_value=dashboard_payload)) as builder,
            patch("app.routers.system._public_summary_cache", cache),
        ):
            first = await public_summary(db=AsyncMock())
            invalidate_system_summary()
            second = await public_summary(db=AsyncMock())

        self.assertEqual(builder.await_count, 2)
        self.assertFalse(first["cached"])
        self.assertFalse(second["cached"])

    def test_dashboard_recent_activity_deduplicates_periodic_noise(self):
        repeated = [
            SimpleNamespace(
                id=value,
                type="time_series",
                level="warning",
                title="时序数据自动采集失败",
                username="system",
                entity_id="",
                created_at=datetime(2026, 7, 30, 10, value, 0),
            )
            for value in (3, 2, 1)
        ]
        login = SimpleNamespace(
            id=4,
            type="user_login",
            level="info",
            title="用户登录系统",
            username="admin",
            entity_id="",
            created_at=datetime(2026, 7, 30, 9, 0, 0),
        )

        payload = _distinct_dashboard_logs([*repeated, login])
        self.assertEqual([item["id"] for item in payload], [3, 4])

    def test_dashboard_activity_uses_shared_business_type_labels(self):
        rows = [
            SimpleNamespace(
                id=index,
                type=log_type,
                level="info",
                title="测试日志",
                username="admin",
                entity_id="",
                created_at=datetime(2026, 7, 30, 10, index, 0),
            )
            for index, log_type in enumerate(
                ["agent_instance", "knowledge_management", "sandbox_simulation"],
                start=1,
            )
        ]

        payload = _distinct_dashboard_logs(rows)

        self.assertEqual(
            [item["type_label"] for item in payload],
            ["智能体实例管理", "知识库管理", "电子沙盘联调"],
        )


class OperationLogContractTests(unittest.IsolatedAsyncioTestCase):
    def test_collapsed_query_only_groups_signed_periodic_failures(self):
        statement = str(_collapsed_operation_log_query([]).compile(compile_kwargs={"literal_binds": True}))
        self.assertIn("时序数据自动采集失败", statement)
        self.assertIn("signature=", statement)
        self.assertIn("home_assistant_read", statement)
        self.assertIn("influxdb_write", statement)
        self.assertIn("row_number() OVER", statement)
        self.assertIn("count(*) OVER", statement)
        self.assertIn("operation_logs.id", statement)

    def test_grouped_log_keeps_latest_row_and_repeat_count(self):
        row = {
            "id": 48,
            "type": "time_series",
            "level": "warning",
            "title": "时序数据自动采集失败",
            "detail": "连接超时；signature=abc",
            "username": "system",
            "entity_id": "",
            "created_at": datetime(2026, 8, 1, 11, 0, 0),
            "repeat_count": 48,
        }
        payload = _serialize_grouped_operation_log(row)
        self.assertEqual(payload["id"], 48)
        self.assertEqual(payload["repeat_count"], 48)
        self.assertEqual(payload["created_at"], "2026-08-01T11:00:00")

    def test_normal_user_log_scope_is_limited_to_self(self):
        admin_filters = _operation_log_scope_filters({"user_id": 1, "role": "admin"})
        user_filters = _operation_log_scope_filters({"user_id": 42, "role": "user"})

        self.assertEqual(admin_filters, [])
        self.assertEqual(len(user_filters), 1)
        self.assertIn("operation_logs.user_id", str(user_filters[0]))

    async def test_normal_user_log_list_and_export_apply_same_scope(self):
        row = SimpleNamespace(
            id=7,
            type="user_login",
            level="info",
            title="用户登录系统",
            detail="user_id=42; role=user",
            username="student",
            entity_id="",
            created_at=datetime(2026, 7, 31, 10, 0, 0),
        )
        list_db = AsyncMock()
        list_db.execute.side_effect = [
            _Result(scalar=1),
            _Result(rows=[row]),
            _Result(rows=[("info", 1)]),
            _Result(scalar=row.created_at),
            _Result(rows=[("user_login", 1)]),
        ]

        payload = await recent_logs(
            limit=10,
            page=1,
            size=20,
            type="",
            level="",
            keyword="",
            start_time="",
            end_time="",
            user={"user_id": 42, "role": "user"},
            db=list_db,
        )

        self.assertEqual(payload["visibility_scope"], "self")
        self.assertEqual(payload["total"], 1)
        self.assertTrue(all(
            "operation_logs.user_id =" in str(call.args[0])
            for call in list_db.execute.await_args_list
        ))

        export_db = AsyncMock()
        export_db.execute.return_value = _Result(rows=[row])
        response = await export_logs(
            type="",
            level="",
            keyword="",
            start_time="",
            end_time="",
            user={"user_id": 42, "role": "user"},
            db=export_db,
        )
        self.assertIn("operation_logs.user_id =", str(export_db.execute.await_args.args[0]))
        self.assertEqual(response.headers["X-Export-Count"], "1")
        csv_text = response.body.decode("utf-8")
        self.assertIn("student", csv_text)
        self.assertIn("业务摘要", csv_text)
        self.assertIn("用户登录系统", csv_text)
        self.assertIn("登录成功，当前身份为普通用户", csv_text)
    def test_invalid_or_reversed_time_range_is_rejected(self):
        with self.assertRaises(HTTPException) as invalid:
            _operation_log_filters("", "", "", "not-a-date", "")
        self.assertEqual(invalid.exception.status_code, 422)

        with self.assertRaises(HTTPException) as reversed_range:
            _operation_log_filters("", "", "", "2026-07-30T12:00", "2026-07-30T10:00")
        self.assertEqual(reversed_range.exception.status_code, 422)

    def test_csv_cells_neutralize_formula_prefixes(self):
        self.assertEqual(_csv_cell("=HYPERLINK('x')"), "'=HYPERLINK('x')")
        self.assertEqual(_csv_cell("正常文本"), "正常文本")
        self.assertEqual(_operation_log_level_label("warning"), "警告")
        self.assertEqual(_operation_log_level_label("custom_runtime_level"), "其他等级")
        self.assertEqual(_operation_log_type_label("knowledge_management"), "知识库管理")
        self.assertEqual(_operation_log_type_label("agent_instance"), "智能体实例管理")

    async def test_log_stats_use_current_filter_scope(self):
        row = SimpleNamespace(
            id=3,
            type="device_control",
            level="warning",
            title="设备控制待确认",
            detail="result=physical_pending",
            username="admin",
            entity_id="light.real",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
        )
        db = AsyncMock()
        db.execute.side_effect = [
            _Result(scalar=1),
            _Result(rows=[row]),
            _Result(rows=[("warning", 1)]),
            _Result(scalar=row.created_at),
            _Result(rows=[("time_series", 100), ("device_control", 1)]),
        ]

        payload = await recent_logs(
            limit=10,
            page=1,
            size=20,
            type="device_control",
            level="warning",
            keyword="",
            start_time="",
            end_time="",
            user={"user_id": 1, "role": "admin"},
            db=db,
        )

        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["stats"]["total"], 1)
        self.assertEqual(payload["stats"]["warning"], 1)
        self.assertEqual(payload["stats"]["scope"], "filtered")

    async def test_database_failure_is_not_returned_as_empty_success(self):
        db = AsyncMock()
        db.execute.side_effect = RuntimeError("database offline")

        with self.assertRaises(HTTPException) as caught:
            await recent_logs(
                limit=10,
                page=1,
                size=20,
                type="",
                level="",
                keyword="",
                start_time="",
                end_time="",
                user={"user_id": 1, "role": "admin"},
                db=db,
            )
        self.assertEqual(caught.exception.status_code, 500)
        self.assertIn("操作日志查询失败", caught.exception.detail)

    async def test_log_page_clamps_after_filter_shrinks_result(self):
        row = SimpleNamespace(
            id=1,
            type="knowledge_management",
            level="success",
            title="知识库已创建",
            detail="{}",
            username="admin",
            entity_id="dataset-1",
            created_at=datetime(2026, 7, 30, 10, 0, 0),
        )
        db = AsyncMock()
        db.execute.side_effect = [
            _Result(scalar=1),
            _Result(rows=[row]),
            _Result(rows=[("success", 1)]),
            _Result(scalar=row.created_at),
            _Result(rows=[("knowledge_management", 1)]),
        ]

        payload = await recent_logs(
            limit=10,
            page=9,
            size=20,
            type="knowledge_management",
            level="",
            keyword="",
            start_time="",
            end_time="",
            user={"user_id": 1, "role": "admin"},
            db=db,
        )

        self.assertEqual(payload["page"], 1)
        self.assertEqual(payload["page_count"], 1)

    def test_retention_filter_keeps_error_logs_longer(self):
        stale_filter, normal_cutoff, error_cutoff = _operation_log_retention_filter(
            datetime(2026, 8, 2, 12, 0, 0),
            90,
            365,
        )
        statement = str(stale_filter.compile(compile_kwargs={"literal_binds": True}))
        self.assertIn("operation_logs.level != 'error'", statement)
        self.assertIn("operation_logs.level = 'error'", statement)
        self.assertEqual(normal_cutoff.isoformat(), "2026-05-04T12:00:00")
        self.assertEqual(error_cutoff.isoformat(), "2025-08-02T12:00:00")

    async def test_retention_preview_reports_deletable_and_retained(self):
        db = AsyncMock()
        db.execute.side_effect = [
            _Result(scalar=575),
            _Result(scalar=12),
            _Result(scalar=datetime(2025, 1, 1, 8, 0, 0)),
        ]
        payload = await _operation_log_cleanup_preview(
            db,
            normal_days=90,
            error_days=365,
            now=datetime(2026, 8, 2, 12, 0, 0),
        )
        self.assertEqual(payload["total"], 575)
        self.assertEqual(payload["deletable"], 12)
        self.assertEqual(payload["retained"], 563)
        self.assertEqual(payload["oldest_at"], "2025-01-01T08:00:00")

    async def test_retention_rejects_shorter_error_window_and_bad_confirmation(self):
        db = AsyncMock()
        with self.assertRaises(HTTPException) as invalid_window:
            await preview_operation_log_retention(
                normal_days=180,
                error_days=90,
                _user={"role": "admin"},
                db=db,
            )
        self.assertEqual(invalid_window.exception.status_code, 422)

        with self.assertRaises(HTTPException) as invalid_confirmation:
            await cleanup_operation_log_retention(
                OperationLogCleanupRequest(
                    normal_days=90,
                    error_days=365,
                    confirmation="确认",
                ),
                user={"user_id": 1, "username": "admin"},
                db=db,
            )
        self.assertEqual(invalid_confirmation.exception.status_code, 422)

    async def test_cleanup_writes_admin_audit_and_returns_remaining_count(self):
        db = AsyncMock()
        db.add = MagicMock()
        with patch(
            "app.routers.monitor._operation_log_cleanup_preview",
            AsyncMock(return_value={"total": 575, "deletable": 12}),
        ), patch(
            "app.routers.monitor._prune_operation_logs",
            AsyncMock(return_value=12),
        ):
            payload = await cleanup_operation_log_retention(
                OperationLogCleanupRequest(
                    normal_days=90,
                    error_days=365,
                    confirmation="清理过期日志",
                ),
                user={"user_id": 1, "username": "admin"},
                db=db,
            )
        self.assertEqual(payload["deleted"], 12)
        self.assertEqual(payload["remaining"], 564)
        self.assertEqual(db.add.call_args.args[0].title, "管理员执行过期操作日志清理")
        db.commit.assert_awaited()


if __name__ == "__main__":
    unittest.main()
