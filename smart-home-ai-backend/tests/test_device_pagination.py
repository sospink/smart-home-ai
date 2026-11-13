import asyncio
import inspect
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import app.routers.devices as devices_router
from app.dependencies import require_admin
from app.routers.devices import (
    _aggregate_ha_snapshot_errors,
    _filter_device_snapshot,
    _get_ha_maps_for_devices,
    _get_ha_map,
    _get_ha_service,
    _get_device_list_snapshot,
    _ha_read_failure_message,
    _invalidate_device_list_snapshot,
    _normalize_ha_failure_reason,
    _gateway_to_dict,
    GatewayPayload,
    create_device,
    create_gateway,
    delete_demo_devices,
    delete_device,
    delete_gateway,
    device_control_logs,
    import_gateway_entities,
    list_devices,
    sync_gateway,
    test_gateway,
    update_device,
    update_gateway,
)


def _snapshot():
    devices = [
        {
            "id": "1",
            "name": "筒灯",
            "description": "现场灯具",
            "category": "light",
            "brand": "小米",
            "model": "btlm2",
            "location": "卧室",
            "gateway_id": 1,
            "gateway_name": "家庭网关",
            "status": "online",
            "source": "ha_sync",
            "mappings": [{
                "endpoint": "light.real",
                "metadata": {"aliases": ["客厅灯", "客厅灯光", "小米筒灯"]},
            }],
        },
        {
            "id": "2",
            "name": "门磁",
            "description": "入户门",
            "category": "binary_sensor",
            "brand": "",
            "model": "",
            "location": "玄关",
            "gateway_id": 1,
            "gateway_name": "家庭网关",
            "status": "offline",
            "source": "ha_sync",
            "mappings": [],
        },
        {
            "id": "3",
            "name": "演示开关",
            "description": "",
            "category": "switch",
            "brand": "",
            "model": "",
            "location": "",
            "gateway_id": 2,
            "gateway_name": "演示网关",
            "status": "disabled",
            "source": "seed",
            "mappings": [],
        },
    ]
    return {
        "devices": devices,
        "scenes": [{"entity_id": "scene.home", "name": "回家模式"}],
        "summary": {
            "total": 3,
            "online": 1,
            "offline": 1,
            "unmapped": 0,
            "disabled": 1,
            "seed": 1,
            "scene_count": 1,
            "categories": {"light": 1, "binary_sensor": 1, "switch": 1},
        },
        "ha_error": "",
        "generated_at": "2026-07-30T12:00:00+00:00",
    }


class DevicePaginationContractTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _frontend_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "devices"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_first_device_list_failure_uses_one_specific_diagnostic(self):
        source = self._frontend_source()
        self.assertIn("error && (data || !deviceListError)", source)
        self.assertIn("{deviceListError || error}", source)
        self.assertNotIn("恢复平台连接后重新读取，不会将读取失败计为 0 台设备。", source)
        self.assertIn("读取失败不会计为 0 台设备。", source)

    def test_device_list_retry_exposes_loading_state(self):
        source = self._frontend_source()
        self.assertIn("disabled={loading}", source)
        self.assertIn("loading ? '正在重新读取' : '重新读取台账'", source)

    def test_device_registry_and_gateway_writes_require_admin(self):
        write_endpoints = [
            (create_gateway, "current_user"),
            (update_gateway, "_user"),
            (delete_gateway, "_user"),
            (test_gateway, "_user"),
            (sync_gateway, "_user"),
            (import_gateway_entities, "current_user"),
            (delete_demo_devices, "current_user"),
            (create_device, "current_user"),
            (update_device, "current_user"),
            (delete_device, "_user"),
        ]
        for endpoint, parameter_name in write_endpoints:
            with self.subTest(endpoint=endpoint.__name__):
                dependency = inspect.signature(endpoint).parameters[parameter_name].default.dependency
                self.assertIs(dependency, require_admin)

    async def test_device_list_ha_read_budget_degrades_to_platform_snapshot(self):
        gateway = type("Gateway", (), {"name": "Home Assistant 默认网关"})()
        service = type("Service", (), {
            "get_states": AsyncMock(side_effect=asyncio.TimeoutError()),
        })()

        with patch("app.routers.devices._get_ha_service", AsyncMock(return_value=service)):
            states, error = await _get_ha_map(
                AsyncMock(),
                gateway,
                timeout_seconds=0.01,
            )

        self.assertEqual(states, {})
        self.assertIn("连接超时", error)

    async def test_system_default_gateway_always_uses_runtime_ha_configuration(self):
        runtime = type("Runtime", (), {
            "ha_base_url": "http://192.168.34.190:8123",
            "ha_token": "current-token",
        })()
        legacy_gateway = type("Gateway", (), {
            "name": "Home Assistant 默认网关",
            "base_url": "http://192.168.251.190:8123",
            "credential": "legacy-token",
        })()

        with patch("app.routers.devices.get_runtime_config", AsyncMock(return_value=runtime)):
            service = await _get_ha_service(AsyncMock(), legacy_gateway)

        self.assertEqual(service.base_url, runtime.ha_base_url)
        self.assertEqual(service.token, runtime.ha_token)

    async def test_custom_gateway_keeps_its_explicit_connection_configuration(self):
        runtime = type("Runtime", (), {
            "ha_base_url": "http://192.168.34.190:8123",
            "ha_token": "current-token",
        })()
        custom_gateway = type("Gateway", (), {
            "name": "实验室网关",
            "base_url": "http://192.168.34.215:8123",
            "credential": "custom-token",
        })()

        with patch("app.routers.devices.get_runtime_config", AsyncMock(return_value=runtime)):
            service = await _get_ha_service(AsyncMock(), custom_gateway)

        self.assertEqual(service.base_url, custom_gateway.base_url)
        self.assertEqual(service.token, custom_gateway.credential)

    async def test_gateway_errors_remain_attributed_for_scene_availability(self):
        gateway = type("Gateway", (), {"name": "Home Assistant 默认网关"})()
        device = type("Device", (), {
            "gateway_id": 7,
            "gateway": gateway,
            "mappings": [type("Mapping", (), {"gateway_type": "homeassistant"})()],
        })()
        failure = "无法连接 Home Assistant 默认网关（服务未响应）"

        with patch("app.routers.devices._get_ha_map", AsyncMock(return_value=({}, failure))):
            maps, aggregate_error, gateway_errors = await _get_ha_maps_for_devices(AsyncMock(), [device])

        self.assertEqual(maps, {7: {}})
        self.assertEqual(aggregate_error, failure)
        self.assertEqual(gateway_errors, {7: failure})

    def test_gateway_private_connection_metadata_can_be_redacted(self):
        gateway = type("Gateway", (), {
            "id": 1,
            "name": "家庭网关",
            "gateway_type": "homeassistant",
            "base_url": "http://192.168.1.20:8123",
            "port": 8123,
            "auth_type": "bearer",
            "enabled": True,
            "status": "running",
            "description": "家庭网络",
            "credential": "secret-token-value",
            "last_test_at": None,
            "created_at": None,
            "updated_at": None,
        })()

        payload = _gateway_to_dict(gateway, include_private=False)

        self.assertEqual(payload["base_url"], "")
        self.assertIsNone(payload["port"])
        self.assertEqual(payload["auth_type"], "")
        self.assertEqual(payload["credential_masked"], "")
        self.assertTrue(payload["has_credential"])

    def test_system_default_gateway_is_marked_as_runtime_managed(self):
        gateway = type("Gateway", (), {
            "id": 1,
            "name": "Home Assistant 默认网关",
            "gateway_type": "homeassistant",
            "base_url": "http://ha:8123",
            "port": None,
            "auth_type": "bearer",
            "enabled": True,
            "status": "running",
            "description": "",
            "credential": "",
            "last_test_at": None,
            "created_at": None,
            "updated_at": None,
        })()

        payload = _gateway_to_dict(gateway)

        self.assertTrue(payload["system_managed"])
        self.assertFalse(payload["has_credential"])

    async def test_system_default_gateway_rejects_direct_update_and_delete(self):
        gateway = type("Gateway", (), {
            "name": "Home Assistant 默认网关",
            "gateway_type": "homeassistant",
        })()
        payload = GatewayPayload(name="默认网关", base_url="http://other:8123")
        db = AsyncMock()

        with patch("app.routers.devices._get_gateway_or_404", AsyncMock(return_value=gateway)):
            with self.assertRaisesRegex(HTTPException, "系统设置"):
                await update_gateway(1, payload, _user={"role": "admin"}, db=db)
            with self.assertRaisesRegex(HTTPException, "不能删除"):
                await delete_gateway(1, _user={"role": "admin"}, db=db)

    def test_home_assistant_errors_are_translated_and_do_not_repeat_product_name(self):
        gateway = type("Gateway", (), {"name": "Home Assistant 默认网关"})()
        message = _ha_read_failure_message(
            gateway,
            RuntimeError("All connection attempts failed"),
        )

        self.assertEqual(
            message,
            "无法连接 Home Assistant 默认网关（无法建立网络连接）",
        )
        self.assertNotIn("Home Assistant Home Assistant", message)
        self.assertEqual(
            _normalize_ha_failure_reason(RuntimeError("request timed out")),
            "连接超时",
        )

    def test_snapshot_error_aggregation_deduplicates_and_explains_degraded_data(self):
        failure = "无法连接 Home Assistant 默认网关（无法建立网络连接）"
        message = _aggregate_ha_snapshot_errors(failure, failure, "")

        self.assertEqual(message.count(failure), 1)
        self.assertEqual(
            message,
            "无法连接 Home Assistant 默认网关（无法建立网络连接）。"
            "继续显示平台设备台账；相关设备的实时状态和场景暂不可用。",
        )

    async def test_filtered_page_preserves_full_inventory_summary_and_safe_page(self):
        snapshot = _snapshot()
        with patch(
            "app.routers.devices._get_device_list_snapshot",
            AsyncMock(return_value=(snapshot, "hit")),
        ):
            payload = await list_devices(
                page=99,
                size=1,
                category="light",
                gateway_id=None,
                status="online",
                keyword="客厅灯光",
                sort="name",
                refresh=False,
                _user={"user_id": 1},
                db=AsyncMock(),
            )

        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["pages"], 1)
        self.assertEqual(payload["page"], 1)
        self.assertEqual([item["id"] for item in payload["devices"]], ["1"])
        self.assertEqual(payload["summary"], snapshot["summary"])
        self.assertEqual(payload["summary"]["total"], 3)
        self.assertEqual(payload["cache"], "hit")

    def test_runtime_mapping_alias_is_searchable(self):
        matches = _filter_device_snapshot(
            _snapshot()["devices"],
            keyword="客厅 灯光",
            sort="name",
        )
        self.assertEqual([item["name"] for item in matches], ["筒灯"])

    async def test_unknown_status_is_rejected_before_snapshot_load(self):
        loader = AsyncMock()
        with patch("app.routers.devices._get_device_list_snapshot", loader):
            with self.assertRaises(HTTPException) as caught:
                await list_devices(
                    page=1,
                    size=20,
                    category="",
                    gateway_id=None,
                    status="running",
                    keyword="",
                    sort="name",
                    refresh=False,
                    _user={"user_id": 1},
                    db=AsyncMock(),
                )
        self.assertEqual(caught.exception.status_code, 422)
        loader.assert_not_awaited()

    async def test_device_logs_use_all_mapped_entities_and_safe_page(self):
        device = type("Device", (), {
            "mappings": [
                type("Mapping", (), {"endpoint": "light.real"})(),
                type("Mapping", (), {"endpoint": "sensor.real"})(),
            ],
        })()
        row = type("Log", (), {
            "id": 9,
            "type": "device_control",
            "level": "success",
            "title": "设备控制已确认",
            "detail": "result=confirmed",
            "username": "admin",
            "entity_id": "light.real",
            "created_at": None,
        })()

        class Result:
            def __init__(self, scalar_value=None, rows=None):
                self.scalar_value = scalar_value
                self.rows = rows or []

            def scalar(self):
                return self.scalar_value

            def scalars(self):
                return self

            def all(self):
                return self.rows

        db = AsyncMock()
        db.execute.side_effect = [Result(scalar_value=11), Result(rows=[row])]
        with patch("app.routers.devices._get_device_or_404", AsyncMock(return_value=device)):
            payload = await device_control_logs(
                device_id=23,
                page=99,
                size=5,
                user={"user_id": 1, "role": "user"},
                db=db,
            )

        self.assertEqual(payload["total"], 11)
        self.assertEqual(payload["pages"], 3)
        self.assertEqual(payload["page"], 3)
        self.assertEqual(payload["logs"][0]["entity_id"], "light.real")
        self.assertEqual(payload["logs"][0]["level"], "success")
        self.assertEqual(payload["visibility_scope"], "self")
        count_query = str(db.execute.await_args_list[0].args[0])
        self.assertIn("operation_logs.user_id", count_query)
        self.assertIn("operation_logs.level IN", count_query)

    async def test_unmapped_device_logs_never_fall_back_to_global_records(self):
        device = type("Device", (), {"mappings": []})()
        db = AsyncMock()
        with patch("app.routers.devices._get_device_or_404", AsyncMock(return_value=device)):
            payload = await device_control_logs(
                device_id=24,
                page=1,
                size=10,
                user={"user_id": 1, "role": "admin"},
                db=db,
            )
        self.assertEqual(payload["total"], 0)
        self.assertEqual(payload["visibility_scope"], "all")
        db.execute.assert_not_awaited()


class DeviceSnapshotCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        devices_router._device_list_snapshot_cache = None
        devices_router._device_list_snapshot_pending = None
        devices_router._device_list_snapshot_version = 0

    async def asyncTearDown(self):
        pending = devices_router._device_list_snapshot_pending
        if pending and not pending.done():
            pending.cancel()
        devices_router._device_list_snapshot_cache = None
        devices_router._device_list_snapshot_pending = None
        devices_router._device_list_snapshot_version = 0

    async def test_concurrent_reads_share_one_snapshot_load(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def loader(_db):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return _snapshot()

        with patch("app.routers.devices._load_device_list_snapshot", side_effect=loader):
            first = asyncio.create_task(_get_device_list_snapshot(AsyncMock()))
            await started.wait()
            second = asyncio.create_task(_get_device_list_snapshot(AsyncMock()))
            await asyncio.sleep(0)
            release.set()
            results = await asyncio.gather(first, second)

        self.assertEqual(calls, 1)
        self.assertEqual({status for _snapshot_value, status in results}, {"miss", "shared"})
        self.assertIsNotNone(devices_router._device_list_snapshot_cache)

    async def test_cancelling_one_waiter_keeps_shared_device_snapshot_alive(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def loader(_db):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return _snapshot()

        with patch("app.routers.devices._load_device_list_snapshot", side_effect=loader):
            cancelled_waiter = asyncio.create_task(_get_device_list_snapshot(AsyncMock()))
            await started.wait()
            surviving_waiter = asyncio.create_task(_get_device_list_snapshot(AsyncMock()))
            await asyncio.sleep(0)
            cancelled_waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await cancelled_waiter
            release.set()
            snapshot, status = await surviving_waiter

        self.assertEqual(calls, 1)
        self.assertEqual(status, "shared")
        self.assertEqual(snapshot["summary"]["total"], 3)
        self.assertIsNotNone(devices_router._device_list_snapshot_cache)

    async def test_invalidation_during_load_prevents_stale_cache_writeback(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def loader(_db):
            started.set()
            await release.wait()
            return _snapshot()

        with patch("app.routers.devices._load_device_list_snapshot", side_effect=loader):
            task = asyncio.create_task(_get_device_list_snapshot(AsyncMock()))
            await started.wait()
            _invalidate_device_list_snapshot()
            release.set()
            snapshot, status = await task

        self.assertEqual(status, "miss")
        self.assertEqual(snapshot["summary"]["total"], 3)
        self.assertIsNone(devices_router._device_list_snapshot_cache)


if __name__ == "__main__":
    unittest.main()
