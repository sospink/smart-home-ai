import asyncio
import unittest
from inspect import signature
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.routers.sandbox import (
    INJECTABLE_ENTITY_IDS,
    STATE_CACHE_TTL_SECONDS,
    VIRTUAL_ENTITY_IDS,
    _fetch_ha_state_map,
    _brightness_to_percent,
    _brightness_to_raw,
    _invalidate_state_cache,
    _require_injectable_entity,
    _sandbox_runtime_error_message,
    _scene_operation_preview,
    _state_cache,
    _state_pending,
    _validate_injection_value,
    _validate_virtual_control,
    _wait_for_entity_state,
    clear_logs,
    execute_scene,
    get_logs,
    get_virtual_devices,
)
from app.dependencies import require_admin


class SandboxBoundaryTests(unittest.TestCase):
    @staticmethod
    def _frontend_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "sandbox"
            / "SandboxClient.tsx"
        ).read_text(encoding="utf-8")

    def test_log_failure_is_owned_by_log_panel_instead_of_global_warning(self):
        source = self._frontend_source()
        self.assertIn("error={logsError}", source)
        self.assertIn("runtimeError || scenesError || operationError ?", source)
        self.assertNotIn("runtimeError || scenesError || logsError || operationError ?", source)
        self.assertNotIn("operationError || runtimeError || scenesError || logsError", source)

    def test_scene_success_feedback_does_not_fall_back_to_internal_id(self):
        source = self._frontend_source()
        self.assertIn("scene?.name || '未命名场景'", source)
        self.assertNotIn("scene?.name || sceneId", source)

    def test_scene_preview_exposes_business_actions_without_technical_contract(self):
        preview = _scene_operation_preview({
            "injections": [{"entity_id": "sensor.shi_nei_wen_du", "value": "35.0"}],
            "controls": [
                {"entity_id": "input_boolean.light_living_room", "service": "input_boolean.turn_on", "data": {}},
                {"entity_id": "input_number.ac_temperature", "service": "input_number.set_value", "data": {"value": 24}},
            ],
        })

        self.assertEqual(preview[0]["device_name"], "室内温度")
        self.assertEqual(preview[0]["target_label"], "35.0°C")
        self.assertEqual(preview[1]["action_label"], "开启")
        self.assertEqual(preview[1]["target_label"], "开启")
        self.assertEqual(preview[2]["target_label"], "目标温度 24°C")
        self.assertEqual(preview[0]["entity_id"], "sensor.shi_nei_wen_du")
        self.assertEqual(preview[1]["entity_id"], "input_boolean.light_living_room")
        self.assertNotIn("service", preview[1])

    def test_scene_preview_uses_business_action_for_lock_and_climate(self):
        preview = _scene_operation_preview({
            "injections": [],
            "controls": [
                {"entity_id": "input_boolean.front_door_lock", "service": "input_boolean.turn_on", "data": {}},
                {"entity_id": "input_select.ac_power", "service": "input_select.select_option", "data": {"option": "关"}},
                {"entity_id": "input_select.ac_mode", "service": "input_select.select_option", "data": {"option": "制冷"}},
            ],
        })

        self.assertEqual([item["action_label"] for item in preview], ["上锁", "关闭空调", "设置运行模式"])
        self.assertEqual(preview[0]["target_label"], "已上锁")
    def test_runtime_network_error_is_translated_without_raw_exception(self):
        message = _sandbox_runtime_error_message(RuntimeError("All connection attempts failed"))
        self.assertIn("无法建立连接", message)
        self.assertNotIn("All connection attempts failed", message)

    def test_brightness_range_is_normalized_without_losing_raw_evidence(self):
        state = {
            "state": "200",
            "attributes": {"min": 0, "max": 255, "step": 1},
        }
        normalized = _brightness_to_percent(state)
        self.assertEqual(normalized["state"], "78.4")
        self.assertEqual(normalized["attributes"]["raw_state"], "200")
        self.assertEqual(normalized["attributes"]["raw_max"], 255)
        self.assertEqual(normalized["attributes"]["unit_of_measurement"], "%")
        self.assertEqual(_brightness_to_raw(80, state), 204)

    def test_percent_brightness_range_remains_unchanged(self):
        state = {
            "state": "80",
            "attributes": {"min": 0, "max": 100, "step": 1},
        }
        self.assertEqual(_brightness_to_percent(state)["state"], "80.0")
        self.assertEqual(_brightness_to_raw(80, state), 80)

    def test_only_predefined_virtual_sensors_are_injectable(self):
        self.assertIn("sensor.shi_nei_wen_du", INJECTABLE_ENTITY_IDS)
        _require_injectable_entity("sensor.shi_nei_wen_du")

        with self.assertRaises(HTTPException) as context:
            _require_injectable_entity("sensor.real_temperature")
        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("真实设备", context.exception.detail)

    def test_real_ha_entity_cannot_bypass_device_control_module(self):
        entity_id = "light.xiaomi_cn_2142280092_btlm2_s_2_light"
        self.assertNotIn(entity_id, VIRTUAL_ENTITY_IDS)
        with self.assertRaises(HTTPException) as context:
            _validate_virtual_control(entity_id, "light.turn_on")
        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("设备控制模块", context.exception.detail)

    def test_virtual_entity_rejects_cross_domain_service(self):
        with self.assertRaises(HTTPException) as context:
            _validate_virtual_control(
                "input_boolean.light_living_room",
                "lock.unlock",
            )
        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("允许服务", context.exception.detail)

    def test_virtual_service_rejects_unexpected_parameters(self):
        with self.assertRaises(HTTPException) as context:
            _validate_virtual_control(
                "input_boolean.light_living_room",
                "input_boolean.turn_on",
                {"brightness": 100},
            )
        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("不允许参数", context.exception.detail)

    def test_virtual_sensor_value_range_is_enforced(self):
        self.assertEqual(_validate_injection_value("sensor.shi_nei_wen_du", "22.5"), 22.5)
        with self.assertRaises(HTTPException) as context:
            _validate_injection_value("sensor.shi_nei_wen_du", "50")
        self.assertEqual(context.exception.status_code, 422)
        self.assertIn("10 至 45", context.exception.detail)

    def test_virtual_numeric_control_requires_bounded_value(self):
        with self.assertRaises(HTTPException) as context:
            _validate_virtual_control(
                "input_number.light_living_room_brightness",
                "input_number.set_value",
                {"value": 120},
            )
        self.assertEqual(context.exception.status_code, 422)
        self.assertIn("0 至 100", context.exception.detail)

    def test_log_cleanup_uses_admin_dependency(self):
        dependency = signature(clear_logs).parameters["user"].default.dependency
        self.assertIs(dependency, require_admin)


class _FakeResponse:
    def __init__(self, payload=None, status_code=200):
        self.payload = payload if payload is not None else {}
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


class _FakeClient:
    def __init__(self, *, get_payloads=None, post_statuses=None):
        self.get_payloads = list(get_payloads or [])
        self.post_statuses = list(post_statuses or [])
        self.get_calls = []
        self.post_calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback):
        return False

    async def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        payload = self.get_payloads.pop(0) if self.get_payloads else {}
        return _FakeResponse(payload)

    async def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        status = self.post_statuses.pop(0) if self.post_statuses else 200
        return _FakeResponse({}, status)


class _FakeDb:
    def __init__(self):
        self.added = []

    def add(self, value):
        self.added.append(value)

    async def commit(self):
        return None


class _FakeScalarRows:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _FakeSummaryRows:
    def __init__(self, summary):
        self._summary = summary

    def one(self):
        return self._summary


class _FakeLogDb:
    def __init__(self, total, rows):
        self.total = total
        self.rows = rows
        self.statements = []

    async def scalar(self, statement):
        self.statements.append(statement)
        return self.total

    async def execute(self, statement):
        self.statements.append(statement)
        if len(self.statements) == 2:
            return _FakeScalarRows(self.rows)
        return _FakeSummaryRows((self.total, self.total, 0, self.total, None))


class SandboxRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        _state_cache.clear()
        _state_pending.clear()

    async def asyncTearDown(self):
        for task in _state_pending.values():
            task.cancel()
        _state_cache.clear()
        _state_pending.clear()

    async def test_state_map_cache_deduplicates_repeated_loads(self):
        payload = {"sensor.shi_nei_wen_du": {"state": "22", "attributes": {}}}
        with patch("app.routers.sandbox._load_ha_state_map", AsyncMock(return_value=payload)) as loader:
            first = await _fetch_ha_state_map("http://ha:8123", "token")
            second = await _fetch_ha_state_map("http://ha:8123", "token")
        self.assertEqual(first, second)
        self.assertEqual(loader.await_count, 1)
        self.assertGreater(STATE_CACHE_TTL_SECONDS, 0)

    async def test_cancelling_one_waiter_keeps_shared_state_snapshot_alive(self):
        release = asyncio.Event()
        payload = {"sensor.shi_nei_wen_du": {"state": "22", "attributes": {}}}

        async def load_once(_url, _token):
            await release.wait()
            return payload

        with patch("app.routers.sandbox._load_ha_state_map", side_effect=load_once) as loader:
            cancelled_waiter = asyncio.create_task(_fetch_ha_state_map("http://ha:8123", "token"))
            await asyncio.sleep(0)
            surviving_waiter = asyncio.create_task(_fetch_ha_state_map("http://ha:8123", "token"))
            await asyncio.sleep(0)
            cancelled_waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await cancelled_waiter
            release.set()
            result = await surviving_waiter

        self.assertEqual(loader.call_count, 1)
        self.assertEqual(result, payload)
        self.assertIn("http://ha:8123", _state_cache)

    async def test_forced_state_refresh_bypasses_cache(self):
        with patch(
            "app.routers.sandbox._load_ha_state_map",
            AsyncMock(side_effect=[{"a": {"state": "off"}}, {"a": {"state": "on"}}]),
        ) as loader:
            first = await _fetch_ha_state_map("http://ha:8123", "token")
            second = await _fetch_ha_state_map("http://ha:8123", "token", force=True)
        self.assertEqual(first["a"]["state"], "off")
        self.assertEqual(second["a"]["state"], "on")
        self.assertEqual(loader.await_count, 2)

    async def test_device_workspace_uses_one_batched_state_snapshot(self):
        state_map = {
            "input_boolean.light_living_room": {"state": "on", "attributes": {}},
            "sensor.shi_nei_wen_du": {"state": "23", "attributes": {}},
        }
        runtime = SimpleNamespace(ha_base_url="http://ha:8123", ha_token="token")
        with patch("app.routers.sandbox.get_runtime_config", AsyncMock(return_value=runtime)), patch(
            "app.routers.sandbox._fetch_ha_state_map",
            AsyncMock(return_value=state_map),
        ) as fetch_states:
            response = await get_virtual_devices(refresh=True, _user={"user_id": 1}, db=_FakeDb())
        self.assertEqual(fetch_states.await_count, 1)
        self.assertEqual(response["count"], 12)
        self.assertTrue(response["ha_connected"])
        self.assertEqual(response["status"], "connected")
        self.assertIsNone(response["error"])
        living = next(item for item in response["devices"] if item["id"] == "v_living_room_light")
        self.assertEqual(living["entity_states"]["power"]["state"], "on")
        self.assertEqual(living["entity_states"]["brightness"]["state"], "unavailable")
        self.assertEqual(living["availability"], "partial")
        self.assertEqual(living["available_entity_count"], 1)
        self.assertEqual(living["total_entity_count"], 2)
        self.assertEqual(living["missing_roles"], ["brightness"])
        self.assertEqual(response["available_count"], 1)
        self.assertEqual(response["partial_count"], 1)
        self.assertEqual(response["unavailable_count"], 10)

    async def test_device_workspace_degrades_when_home_assistant_is_offline(self):
        runtime = SimpleNamespace(ha_base_url="http://ha:8123", ha_token="token")
        with patch("app.routers.sandbox.get_runtime_config", AsyncMock(return_value=runtime)), patch(
            "app.routers.sandbox._fetch_ha_state_map",
            AsyncMock(side_effect=RuntimeError("All connection attempts failed")),
        ):
            response = await get_virtual_devices(refresh=True, _user={"user_id": 1}, db=_FakeDb())

        self.assertEqual(response["count"], 12)
        self.assertEqual(response["available_count"], 0)
        self.assertEqual(response["partial_count"], 0)
        self.assertEqual(response["unavailable_count"], 12)
        self.assertFalse(response["ha_connected"])
        self.assertEqual(response["status"], "unavailable")
        self.assertIn("无法建立连接", response["error"])
        self.assertNotIn("All connection attempts failed", response["error"])
        for device in response["devices"]:
            self.assertTrue(device["entity_states"])
            self.assertEqual(device["availability"], "unavailable")
            self.assertEqual(device["available_entity_count"], 0)
            self.assertEqual(device["total_entity_count"], len(device["entity_states"]))
            self.assertEqual(set(device["missing_roles"]), set(device["entity_states"]))
            self.assertTrue(all(
                state["state"] == "unavailable"
                for state in device["entity_states"].values()
            ))

    async def test_readback_waits_until_target_state_is_observed(self):
        client = _FakeClient(get_payloads=[
            {"state": "off", "attributes": {}},
            {"state": "on", "attributes": {"brightness": 100}},
        ])
        state, confirmed = await _wait_for_entity_state(
            client,
            "http://ha:8123",
            "token",
            "input_boolean.light_living_room",
            "on",
            service="input_boolean.turn_on",
        )
        self.assertTrue(confirmed)
        self.assertEqual(state["state"], "on")
        self.assertEqual(len(client.get_calls), 2)

    async def test_scene_returns_partial_failure_details(self):
        runtime = SimpleNamespace(ha_base_url="http://ha:8123", ha_token="token")
        scene = {
            "id": "test_scene",
            "name": "测试场景",
            "description": "",
            "injections": [],
            "controls": [
                {
                    "entity_id": "input_boolean.light_living_room",
                    "service": "input_boolean.turn_on",
                    "data": {},
                },
                {
                    "entity_id": "input_boolean.light_bedroom",
                    "service": "input_boolean.turn_off",
                    "data": {},
                },
            ],
        }
        client = _FakeClient(
            get_payloads=[{"state": "on", "attributes": {}}],
            post_statuses=[200, 500],
        )
        db = _FakeDb()
        with patch("app.routers.sandbox.SCENE_PRESETS", [scene]), patch(
            "app.routers.sandbox.get_runtime_config",
            AsyncMock(return_value=runtime),
        ), patch(
            "app.routers.sandbox._fetch_ha_state_map",
            AsyncMock(return_value={
                "input_boolean.light_living_room": {"state": "off", "attributes": {}},
                "input_boolean.light_bedroom": {"state": "on", "attributes": {}},
            }),
        ), patch("app.routers.sandbox.httpx.AsyncClient", return_value=client):
            response = await execute_scene(
                "test_scene",
                user={"user_id": 1, "username": "tester"},
                db=db,
            )
        self.assertFalse(response["success"])
        self.assertTrue(response["partial"])
        self.assertEqual(response["succeeded_count"], 1)
        self.assertEqual(response["failed_count"], 1)
        self.assertEqual(len(response["results"]), 2)
        self.assertEqual(len(db.added), 1)

    async def test_scene_does_not_send_requests_when_all_targets_are_unavailable(self):
        runtime = SimpleNamespace(ha_base_url="http://ha:8123", ha_token="token")
        scene = {
            "id": "blocked_scene",
            "name": "不可用场景",
            "description": "",
            "injections": [],
            "controls": [{
                "entity_id": "input_boolean.light_living_room",
                "service": "input_boolean.turn_on",
                "data": {},
            }],
        }
        with patch("app.routers.sandbox.SCENE_PRESETS", [scene]), patch(
            "app.routers.sandbox.get_runtime_config",
            AsyncMock(return_value=runtime),
        ), patch(
            "app.routers.sandbox._fetch_ha_state_map",
            AsyncMock(return_value={
                "input_boolean.light_living_room": {"state": "unavailable", "attributes": {}},
            }),
        ), patch("app.routers.sandbox.httpx.AsyncClient") as client:
            with self.assertRaises(HTTPException) as context:
                await execute_scene(
                    "blocked_scene",
                    user={"user_id": 1, "username": "tester"},
                    db=_FakeDb(),
                )

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("全部不可用", context.exception.detail)
        client.assert_not_called()

    async def test_scene_skips_unavailable_steps_after_preflight(self):
        runtime = SimpleNamespace(ha_base_url="http://ha:8123", ha_token="token")
        scene = {
            "id": "partial_scene",
            "name": "部分可用场景",
            "description": "",
            "injections": [],
            "controls": [
                {"entity_id": "input_boolean.light_living_room", "service": "input_boolean.turn_on", "data": {}},
                {"entity_id": "input_boolean.light_bedroom", "service": "input_boolean.turn_off", "data": {}},
            ],
        }
        client = _FakeClient(get_payloads=[{"state": "on", "attributes": {}}], post_statuses=[200])
        with patch("app.routers.sandbox.SCENE_PRESETS", [scene]), patch(
            "app.routers.sandbox.get_runtime_config",
            AsyncMock(return_value=runtime),
        ), patch(
            "app.routers.sandbox._fetch_ha_state_map",
            AsyncMock(return_value={
                "input_boolean.light_living_room": {"state": "off", "attributes": {}},
                "input_boolean.light_bedroom": {"state": "unavailable", "attributes": {}},
            }),
        ), patch("app.routers.sandbox.httpx.AsyncClient", return_value=client):
            response = await execute_scene(
                "partial_scene",
                user={"user_id": 1, "username": "tester"},
                db=_FakeDb(),
            )

        self.assertEqual(len(client.post_calls), 1)
        self.assertEqual(response["succeeded_count"], 1)
        self.assertEqual(response["failed_count"], 1)
        skipped = next(item for item in response["results"] if item["entity_id"] == "input_boolean.light_bedroom")
        self.assertEqual(skipped["actual_state"], "unavailable")
        self.assertIn("未发送该步骤", skipped["error"])

    async def test_log_page_is_clamped_after_filters_reduce_results(self):
        row = SimpleNamespace(
            id=9,
            level="success",
            title="注入室内温度数据",
            detail='{"action": "inject", "requested_value": "23", "actual_state": "23"}',
            entity_id="sensor.shi_nei_wen_du",
            username="tester",
            created_at=None,
        )
        db = _FakeLogDb(total=1, rows=[row])

        response = await get_logs(
            page=8,
            size=20,
            level="success",
            action="inject",
            keyword="温度",
            user={"user_id": 1, "role": "admin"},
            db=db,
        )

        self.assertEqual(response["page"], 1)
        self.assertEqual(response["page_count"], 1)
        self.assertEqual(response["total"], 1)
        self.assertEqual(response["items"][0]["requested_value"], "23")
        self.assertIsNone(response["summary"]["latest_at"])


if __name__ == "__main__":
    unittest.main()
