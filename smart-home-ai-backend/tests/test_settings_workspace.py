import asyncio
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from app.routers.system import (
    SETTINGS_KEYS,
    _business_log_title,
    _clear_public_summary_cache,
    _mask_token,
    _parse_settings_log,
    _test_runtime_service,
    get_settings,
    get_settings_history,
    get_settings_status,
    health,
    reset_settings,
    system_info,
    test_connection as execute_connection_test,
    update_settings,
)
from app.schemas.settings import (
    SettingsResetRequest,
    SettingsUpdate,
    TestConnectionRequest as ConnectionTestRequest,
    TestConnectionResponse as ConnectionTestResponse,
)


class SettingsFrontendContractTests(unittest.TestCase):
    @staticmethod
    def _source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "settings"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_history_first_failure_is_separate_from_retained_snapshot_warning(self):
        source = self._source()
        self.assertIn("{historyError && historyLoaded ? (", source)
        self.assertIn("!historyLoaded && historyError ? (", source)
        self.assertIn('>{historyError}</p>', source)
        self.assertIn("重新读取配置记录", source)
        self.assertNotIn("配置记录未取得，请点击刷新重试", source)


class _Result:
    def __init__(self, *, scalar=None, rows=None):
        self._scalar = scalar
        self._rows = rows or []

    def scalar(self):
        return self._scalar

    def scalars(self):
        return self

    def all(self):
        return self._rows


def runtime_config(**overrides):
    values = {
        "ollama_base_url": "http://ollama.local:11434",
        "dify_base_url": "http://dify.local",
        "dify_api_key": "app-secret",
        "dify_dataset_api_key": "dataset-secret",
        "ha_base_url": "http://ha.local:8123",
        "ha_token": "ha-secret",
        "influxdb_url": "http://influx.local:8086",
        "influxdb_token": "influx-secret",
        "influxdb_org": "smart-home",
        "influxdb_bucket": "smart-home-data",
        "jwt_expire_hours": 24,
        "allow_registration": False,
        "password_min_length": 12,
        "config_source": "database_overrides",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def mock_db():
    db = AsyncMock()
    db.add = MagicMock()
    return db


class SettingsSchemaTests(unittest.TestCase):
    def test_service_url_and_policy_ranges_are_validated(self):
        valid = SettingsUpdate(
            ollama_base_url="http://localhost:11434/",
            jwt_expire_hours=24,
            password_min_length=12,
        )
        self.assertEqual(valid.ollama_base_url, "http://localhost:11434")

        for payload in (
            {"ollama_base_url": "ftp://invalid"},
            {"dify_base_url": "http://user:pass@dify.local"},
            {"ha_base_url": "http://ha.local/#secret"},
            {"jwt_expire_hours": 0},
            {"password_min_length": 3},
            {"ha_token": "••••abcd"},
        ):
            with self.assertRaises(ValidationError):
                SettingsUpdate(**payload)

    def test_short_secrets_are_never_returned_verbatim(self):
        self.assertEqual(_mask_token(""), "")
        self.assertEqual(_mask_token("abc"), "••••")
        self.assertEqual(_mask_token("abcdef"), "••••••••cdef")

    def test_audit_detail_parser_only_extracts_structured_fields(self):
        detail = _parse_settings_log(
            "action=save; updated_keys=ha_base_url,ha_token; reset_keys=; message=认证失败"
        )
        self.assertEqual(detail["action"], "save")
        self.assertEqual(detail["updated_keys"], ["ha_base_url", "ha_token"])
        self.assertEqual(detail["message"], "认证失败")

    def test_public_summary_cache_can_be_invalidated_after_runtime_change(self):
        cache = {"expires_at": 999.0, "value": {"overall_status": "healthy"}}
        with patch("app.routers.system._public_summary_cache", cache):
            _clear_public_summary_cache()
        self.assertEqual(cache, {"expires_at": 0.0, "value": None})


class SettingsRouterTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_health_does_not_expose_runtime_fingerprint(self):
        self.assertEqual(await health(), {"status": "ok", "module": "system"})

    async def test_influx_draft_test_targets_selected_org_and_bucket(self):
        db = mock_db()
        body = ConnectionTestRequest(
            service="influxdb",
            influxdb_url="http://draft-influx.local:8086",
            influxdb_token="draft-token",
            influxdb_org="draft-org",
            influxdb_bucket="draft-bucket",
        )
        with (
            patch(
                "app.routers.system._check_service_with_latency",
                AsyncMock(return_value=("running", 4)),
            ),
            patch(
                "app.routers.system._check_influx_bucket",
                AsyncMock(return_value=("running", 9, "服务运行正常")),
            ) as check_bucket,
        ):
            result = await _test_runtime_service(
                "influxdb", body, db, runtime_config(),
            )

        self.assertEqual(result.status, "running")
        self.assertEqual(result.latency_ms, 9)
        check_bucket.assert_awaited_once_with(
            "http://draft-influx.local:8086",
            "draft-token",
            "draft-org",
            "draft-bucket",
        )

    async def test_influx_empty_draft_target_does_not_fall_back_to_saved_bucket(self):
        db = mock_db()
        body = ConnectionTestRequest(
            service="influxdb",
            influxdb_org="",
            influxdb_bucket="",
        )
        with (
            patch(
                "app.routers.system._check_service_with_latency",
                AsyncMock(return_value=("running", 4)),
            ),
            patch("app.routers.system._check_influx_bucket", AsyncMock()) as check_bucket,
        ):
            result = await _test_runtime_service(
                "influxdb", body, db, runtime_config(),
            )

        self.assertEqual(result.status, "stopped")
        self.assertIn("缺少组织名或存储桶", result.message)
        check_bucket.assert_not_awaited()

    async def test_empty_draft_secrets_do_not_fall_back_to_saved_credentials(self):
        db = mock_db()
        runtime = runtime_config()

        for service, body, expected_message in (
            (
                "homeassistant",
                ConnectionTestRequest(service="homeassistant", ha_token=""),
                "缺少长效 Token",
            ),
            (
                "dify",
                ConnectionTestRequest(
                    service="dify",
                    dify_api_key="",
                    dify_dataset_api_key="",
                ),
                "缺少应用 API Key 和 Dataset API Key",
            ),
        ):
            with self.subTest(service=service):
                with patch("app.routers.system._check_service_with_latency", AsyncMock()) as check:
                    result = await _test_runtime_service(service, body, db, runtime)
                self.assertEqual(result.status, "stopped")
                self.assertIn(expected_message, result.message)
                check.assert_not_awaited()

        with (
            patch(
                "app.routers.system._check_service_with_latency",
                AsyncMock(return_value=("running", 4)),
            ),
            patch("app.routers.system._check_influx_bucket", AsyncMock()) as check_bucket,
        ):
            result = await _test_runtime_service(
                "influxdb",
                ConnectionTestRequest(service="influxdb", influxdb_token=""),
                db,
                runtime,
            )
        self.assertEqual(result.status, "stopped")
        self.assertIn("缺少 Token", result.message)
        check_bucket.assert_not_awaited()

    async def test_omitted_draft_secrets_continue_to_use_runtime_credentials(self):
        db = mock_db()
        runtime = runtime_config()
        with patch(
            "app.routers.system._check_service_with_latency",
            AsyncMock(return_value=("running", 7)),
        ) as check:
            result = await _test_runtime_service(
                "homeassistant",
                ConnectionTestRequest(service="homeassistant"),
                db,
                runtime,
            )

        self.assertEqual(result.status, "running")
        requested_headers = check.await_args.kwargs["headers"]
        self.assertEqual(requested_headers["Authorization"], "Bearer ha-secret")

    async def test_non_admin_cannot_test_explicit_empty_draft_credentials(self):
        db = mock_db()

        with self.assertRaises(HTTPException) as context:
            await execute_connection_test(
                body=ConnectionTestRequest(service="homeassistant", ha_token=""),
                user={"user_id": 2, "role": "user", "username": "test"},
                db=db,
            )

        self.assertEqual(context.exception.status_code, 403)
        self.assertIn("只有管理员", context.exception.detail)
        db.add.assert_not_called()

    async def test_settings_read_hides_secret_suffixes_from_non_admin(self):
        now = datetime.now()
        db = mock_db()
        db.execute.return_value = _Result(rows=[("ha_token", now)])

        with patch("app.routers.system.get_runtime_config", AsyncMock(return_value=runtime_config())):
            payload = await get_settings(
                user={"user_id": 2, "role": "user", "username": "test"},
                db=db,
            )

        self.assertFalse(payload.can_manage)
        self.assertEqual(payload.services["ollama"].url, "")
        self.assertEqual(payload.services["dify"].url, "")
        self.assertTrue(payload.services["dify"].configured)
        self.assertEqual(payload.services["homeassistant"].url, "")
        self.assertTrue(payload.services["homeassistant"].configured)
        self.assertEqual(payload.services["influxdb"].url, "")
        self.assertEqual(payload.services["influxdb"].extra["org"], "")
        self.assertEqual(payload.services["influxdb"].extra["bucket"], "")
        self.assertEqual(payload.services["homeassistant"].token, "")
        self.assertTrue(payload.services["homeassistant"].token_configured)
        self.assertEqual(payload.override_keys, [])

    async def test_admin_read_returns_masked_secrets_and_fast_metadata(self):
        now = datetime.now()
        db = mock_db()
        db.execute.return_value = _Result(rows=[("ha_token", now)])

        with patch("app.routers.system.get_runtime_config", AsyncMock(return_value=runtime_config())):
            payload = await get_settings(
                user={"user_id": 1, "role": "admin", "username": "admin"},
                db=db,
            )

        self.assertTrue(payload.can_manage)
        self.assertEqual(payload.services["homeassistant"].url, "http://ha.local:8123")
        self.assertTrue(payload.services["homeassistant"].configured)
        self.assertEqual(payload.services["influxdb"].extra["bucket"], "smart-home-data")
        self.assertEqual(payload.services["homeassistant"].token, "••••••••cret")
        self.assertEqual(payload.services["ollama"].status, "unknown")

    async def test_system_info_hides_runtime_fingerprint_from_non_admin(self):
        db = mock_db()
        db.execute.return_value = _Result()
        with patch(
            "app.routers.system.get_config_source_label",
            AsyncMock(return_value="数据库已覆盖"),
        ):
            payload = await system_info(
                user={"user_id": 2, "role": "user", "username": "test"},
                db=db,
            )

        self.assertFalse(payload.runtime_details_visible)
        self.assertEqual(payload.os_info, "")
        self.assertEqual(payload.python_version, "")
        self.assertEqual(payload.config_source, "数据库已覆盖")

    async def test_system_info_keeps_runtime_details_for_admin(self):
        db = mock_db()
        db.execute.return_value = _Result()
        with (
            patch("app.routers.system.get_config_source_label", AsyncMock(return_value="使用默认配置")),
            patch("app.routers.system.platform.system", return_value="Linux"),
            patch("app.routers.system.platform.machine", return_value="x86_64"),
            patch("app.routers.system.platform.python_version", return_value="3.12.0"),
        ):
            payload = await system_info(
                user={"user_id": 1, "role": "admin", "username": "admin"},
                db=db,
            )

        self.assertTrue(payload.runtime_details_visible)
        self.assertEqual(payload.os_info, "Linux x86_64")
        self.assertEqual(payload.python_version, "3.12.0")

    async def test_update_is_idempotent_and_does_not_audit_unchanged_values(self):
        db = mock_db()
        db.execute.return_value = _Result(rows=[])

        with (
            patch("app.routers.system.get_runtime_config", AsyncMock(return_value=runtime_config())),
            patch("app.routers.system._clear_public_summary_cache") as clear_summary,
        ):
            payload = await update_settings(
                body=SettingsUpdate(ha_base_url="http://ha.local:8123"),
                user={"user_id": 1, "role": "admin", "username": "admin"},
                db=db,
            )

        self.assertEqual(payload.updated_keys, [])
        self.assertFalse(db.add.called)
        clear_summary.assert_not_called()

    async def test_update_audit_contains_only_key_names(self):
        db = mock_db()
        db.execute.return_value = _Result(rows=[])
        new_secret = "private-new-ha-token"

        with (
            patch("app.routers.system.get_runtime_config", AsyncMock(return_value=runtime_config())),
            patch("app.routers.system._set_config_value", AsyncMock()),
            patch("app.routers.system._clear_public_summary_cache") as clear_summary,
        ):
            payload = await update_settings(
                body=SettingsUpdate(ha_token=new_secret),
                user={"user_id": 1, "role": "admin", "username": "admin"},
                db=db,
            )

        self.assertEqual(payload.updated_keys, ["ha_token"])
        log = db.add.call_args.args[0]
        self.assertIn("ha_token", log.detail)
        self.assertNotIn(new_secret, log.detail)
        clear_summary.assert_called_once_with()

    async def test_non_admin_cannot_test_draft_target(self):
        db = mock_db()
        with self.assertRaises(HTTPException) as caught:
            await execute_connection_test(
                body=ConnectionTestRequest(service="dify", dify_base_url="http://other.local"),
                user={"user_id": 2, "role": "user", "username": "test"},
                db=db,
            )
        self.assertEqual(caught.exception.status_code, 403)

    async def test_current_runtime_test_remains_available_to_logged_in_user(self):
        db = mock_db()
        response = ConnectionTestResponse(
            service="dify", status="running", message="服务运行正常", latency_ms=18,
        )
        with patch("app.routers.system._test_runtime_service", AsyncMock(return_value=response)):
            payload = await execute_connection_test(
                body=ConnectionTestRequest(service="dify"),
                user={"user_id": 2, "role": "user", "username": "test"},
                db=db,
            )
        self.assertEqual(payload.status, "running")
        self.assertIn("action=test", db.add.call_args.args[0].detail)

    async def test_dify_app_and_dataset_probes_run_concurrently(self):
        both_started = asyncio.Event()
        release = asyncio.Event()
        started_urls = []

        async def probe(url, headers=None, timeout=5.0):
            started_urls.append(url)
            if len(started_urls) == 2:
                both_started.set()
            await release.wait()
            return "running", 12

        async def execute_probe():
            result = await _test_runtime_service(
                "dify",
                ConnectionTestRequest(service="dify"),
                mock_db(),
                runtime_config(),
            )
            return result

        with patch("app.routers.system._check_service_with_latency", side_effect=probe):
            task = asyncio.create_task(execute_probe())
            await asyncio.wait_for(both_started.wait(), timeout=0.2)
            self.assertEqual(
                set(started_urls),
                {"http://dify.local/v1/parameters", "http://dify.local/v1/datasets"},
            )
            release.set()
            payload = await task

        self.assertEqual(payload.status, "running")
        self.assertEqual(payload.latency_ms, 12)

    async def test_status_probe_reuses_single_runtime_snapshot(self):
        db = mock_db()
        runtime = runtime_config()

        async def probe(service, body, db_arg, runtime_arg=None):
            self.assertIs(runtime_arg, runtime)
            return ConnectionTestResponse(
                service=service, status="running", message="服务运行正常", latency_ms=5,
            )

        with (
            patch("app.routers.system.get_runtime_config", AsyncMock(return_value=runtime)),
            patch("app.routers.system._test_runtime_service", AsyncMock(side_effect=probe)),
            patch("app.routers.system._settings_status_cache", {"expires_at": 0.0, "value": None}),
        ):
            payload = await get_settings_status(refresh=True, _user={"user_id": 1}, db=db)

        self.assertEqual(set(payload.services), {"ollama", "dify", "homeassistant", "influxdb"})
        self.assertFalse(payload.cached)

    async def test_history_is_paginated_and_never_exposes_secret_values(self):
        secret = "must-not-leak"
        row = SimpleNamespace(
            id=9,
            type="system_settings",
            level="success",
            title="homeassistant 连接测试通过",
            detail="action=test; service=homeassistant; status=running; latency_ms=12; message=服务运行正常",
            username="admin",
            created_at=datetime.now() - timedelta(minutes=1),
        )
        db = mock_db()
        db.execute.side_effect = [_Result(scalar=1), _Result(rows=[row])]
        payload = await get_settings_history(
            page=1, size=20, action="", _user={"user_id": 1}, db=db,
        )
        self.assertEqual(payload.total, 1)
        self.assertEqual(payload.items[0].title, "Home Assistant 连接测试通过")
        self.assertNotIn(secret, str(payload.model_dump()))

    async def test_history_clamps_page_after_filter_result_shrinks(self):
        db = mock_db()
        db.execute.side_effect = [_Result(scalar=5), _Result(rows=[])]

        payload = await get_settings_history(
            page=7, size=4, action="test", _user={"user_id": 1}, db=db,
        )

        self.assertEqual(payload.page, 2)
        self.assertEqual(payload.total, 5)
        statement = db.execute.await_args_list[1].args[0]
        self.assertEqual(statement._offset_clause.value, 4)

    async def test_reset_only_deletes_supported_overrides(self):
        row = SimpleNamespace(key="ha_token")
        db = mock_db()
        db.execute.return_value = _Result(rows=[row])

        with patch("app.routers.system._clear_public_summary_cache") as clear_summary:
            payload = await reset_settings(
                body=SettingsResetRequest(keys=["ha_token"]),
                user={"user_id": 1, "role": "admin", "username": "admin"},
                db=db,
            )
        self.assertEqual(payload.reset_keys, ["ha_token"])
        self.assertEqual(db.execute.await_count, 1)
        db.delete.assert_awaited_once_with(row)
        self.assertNotIn("ha-secret", db.add.call_args.args[0].detail)
        clear_summary.assert_called_once_with()

        with self.assertRaises(HTTPException) as caught:
            await reset_settings(
                body=SettingsResetRequest(keys=["unsupported"]),
                user={"user_id": 1, "role": "admin", "username": "admin"},
                db=mock_db(),
            )
        self.assertEqual(caught.exception.status_code, 422)
        self.assertNotIn("unsupported", SETTINGS_KEYS)


if __name__ == "__main__":
    unittest.main()
