import asyncio
import unittest
import httpx
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.routers.devices import (
    _build_home_assistant_workspace,
    _get_cached_ha_workspace_snapshot,
    _ha_workspace_snapshot_cache,
    _ha_workspace_snapshot_pending,
    _load_ha_workspace_snapshot,
    _registry_candidate_metadata,
    health,
)


class HomeAssistantFrontendContractTests(unittest.TestCase):
    @staticmethod
    def _source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "home-assistant"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_discovery_first_failure_is_owned_by_active_tab(self):
        source = self._source()
        self.assertIn("{discoveryError && discoveryLoaded ? (", source)
        self.assertIn("{discoveryError || '当前尚未取得实体发现结果。'}", source)
        self.assertIn("{discoveryError || '当前尚未取得接入诊断结果。'}", source)
        self.assertNotIn("，尚未取得实体发现数据。", source)

    def test_visibility_recovery_does_not_abort_active_reads(self):
        source = self._source()
        self.assertIn("if (!navigator.onLine || document.visibilityState !== 'visible') return", source)
        self.assertIn("mainReadFailed && !dataAbortRef.current", source)
        self.assertIn("mappedError && !mappedAbortRef.current", source)
        self.assertIn("discoveryOpen && discoveryError && !discoveryAbortRef.current", source)

    def test_mapped_pagination_closes_stale_entity_detail(self):
        source = self._source()
        invalidate_start = source.index("const invalidateMappedEntities = () =>")
        invalidate_end = source.index("const invalidateDiscovery = () =>", invalidate_start)
        self.assertIn("setSelectedEntity(null)", source[invalidate_start:invalidate_end])

    def test_mapping_workspace_has_mobile_rows_and_offline_repair_context(self):
        source = self._source()
        self.assertIn("mappedWorkspace.orphan_items.map", source)
        self.assertIn("Home Assistant 实时清单未取得；下方显示平台设备台账中已知的失联映射", source)
        self.assertIn("当前无法从 HA 回读", source)
        self.assertIn('className="hidden overflow-x-auto md:block"', source)
        self.assertIn("映射失联", source)
        self.assertIn("const resolvedPage = payload.status === 'running' ? payload.page : payload.orphan_page", source)


def _snapshot():
    return {
        "states": {
            "light.real": {
                "entity_id": "light.real",
                "state": "on",
                "last_changed": "2026-07-30T01:00:00+00:00",
                "last_updated": "2026-07-30T01:00:00+00:00",
                "attributes": {"friendly_name": "筒灯", "brightness": 255},
            },
            "sensor.temperature": {
                "entity_id": "sensor.temperature",
                "state": "24.5",
                "attributes": {
                    "friendly_name": "室温",
                    "device_class": "temperature",
                    "unit_of_measurement": "°C",
                },
            },
            "input_boolean.helper": {
                "entity_id": "input_boolean.helper",
                "state": "off",
                "attributes": {"friendly_name": "回家模式"},
            },
            "scene.home": {
                "entity_id": "scene.home",
                "state": "2026-07-30T01:00:00+00:00",
                "attributes": {"friendly_name": "回家模式"},
            },
        },
        "registries": {
            "entities": {
                "light.real": {"entity_id": "light.real", "platform": "xiaomi_home", "device_id": "dev1"},
                "sensor.temperature": {"entity_id": "sensor.temperature", "platform": "xiaomi_home", "device_id": "dev2"},
                "input_boolean.helper": {"entity_id": "input_boolean.helper", "platform": "input_boolean"},
                "scene.home": {"entity_id": "scene.home", "platform": "homeassistant"},
            },
            "devices": {
                "dev1": {"id": "dev1", "name": "筒灯", "manufacturer": "小米", "model": "xiaomi.light.test", "area_id": "bedroom"},
                "dev2": {"id": "dev2", "name": "温度计", "manufacturer": "小米", "model": "sensor.test", "area_id": "living"},
            },
            "areas": {
                "bedroom": {"area_id": "bedroom", "name": "卧室"},
                "living": {"area_id": "living", "name": "客厅"},
            },
        },
        "discovery_error": "",
        "registry_error": "",
        "generated_at": "2026-07-30T01:00:00",
        "duration_ms": 16,
        "cache_hit": False,
    }


class HomeAssistantWorkspaceContractTests(unittest.TestCase):
    def test_software_integrations_are_not_counted_as_physical_hardware(self):
        registries = {
            "sensor.backup": {"entity_id": "sensor.backup", "platform": "backup", "device_id": "backup-service"},
            "weather.home": {"entity_id": "weather.home", "platform": "met", "device_id": "weather-service"},
            "sensor.xiaomi": {"entity_id": "sensor.xiaomi", "platform": "xiaomi_home", "device_id": "xiaomi-device"},
        }
        devices = {
            "backup-service": {"id": "backup-service", "name": "Backup"},
            "weather-service": {"id": "weather-service", "name": "Forecast"},
            "xiaomi-device": {"id": "xiaomi-device", "name": "温度计"},
        }
        backup = _registry_candidate_metadata("sensor.backup", {"attributes": {}}, registries, devices, {})
        weather = _registry_candidate_metadata("weather.home", {"attributes": {}}, registries, devices, {})
        xiaomi = _registry_candidate_metadata("sensor.xiaomi", {"attributes": {"device_class": "temperature"}}, registries, devices, {})
        self.assertEqual(backup["classification"], "system")
        self.assertEqual(weather["classification"], "system")
        self.assertEqual(xiaomi["classification"], "hardware")

    def test_summary_uses_full_snapshot_before_filter_and_pagination(self):
        payload = _build_home_assistant_workspace(
            _snapshot(),
            [{
                "mapping_id": 1,
                "endpoint": "light.real",
                "role": "power",
                "access_mode": "rw",
                "device_id": 23,
                "device_name": "筒灯",
                "aliases": ["客厅灯"],
            }],
            {"id": 1, "name": "HA", "base_url": "http://ha:8123", "credential_configured": True},
            page=1,
            size=10,
            keyword="温度",
        )
        self.assertEqual(payload["summary"]["total_entities"], 4)
        self.assertEqual(payload["summary"]["hardware_entities"], 2)
        self.assertEqual(payload["summary"]["mapped_entities"], 1)
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["items"][0]["entity_id"], "sensor.temperature")
        self.assertEqual(payload["domains"]["scene"], 1)

    def test_xiaomi_and_area_alias_diagnostics_are_explicit(self):
        payload = _build_home_assistant_workspace(
            _snapshot(),
            [{
                "mapping_id": 1,
                "endpoint": "light.real",
                "role": "power",
                "access_mode": "rw",
                "device_id": 23,
                "device_name": "筒灯",
                "aliases": ["客厅灯", "小米筒灯"],
            }],
            {"id": 1, "name": "HA", "base_url": "http://ha:8123", "credential_configured": True},
            size=20,
        )
        diagnostic_ids = {item["id"] for item in payload["diagnostics"]}
        self.assertIn("xiaomi-physical-confirmation", diagnostic_ids)
        self.assertIn("area-alias-conflict:light.real", diagnostic_ids)
        light = next(item for item in payload["items"] if item["entity_id"] == "light.real")
        self.assertEqual(light["physical_confirmation"], "physical_pending")

    def test_unavailable_summary_separates_hardware_from_other_entities(self):
        snapshot = _snapshot()
        snapshot["states"]["sensor.temperature"]["state"] = "unavailable"
        snapshot["states"]["input_boolean.helper"]["state"] = "unknown"

        payload = _build_home_assistant_workspace(
            snapshot,
            [],
            {"id": 1, "name": "HA", "base_url": "http://ha:8123", "credential_configured": True},
            size=20,
        )

        self.assertEqual(payload["summary"]["unavailable_entities"], 2)
        self.assertEqual(payload["summary"]["hardware_unavailable_entities"], 1)
        self.assertEqual(payload["summary"]["hardware_unavailable_devices"], 1)
        self.assertEqual(payload["summary"]["other_unavailable_entities"], 1)
        diagnostic = next(item for item in payload["diagnostics"] if item["id"] == "unavailable-entities")
        self.assertIn("1 个设备关联实体", diagnostic["title"])
        self.assertIn("1 个辅助或系统实体", diagnostic["title"])

    def test_response_contains_no_credential_material(self):
        payload = _build_home_assistant_workspace(
            _snapshot(),
            [],
            {"id": 1, "base_url": "http://ha:8123", "credential_configured": True},
            size=20,
        )
        serialized = str(payload).lower()
        self.assertNotIn("token", serialized)
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("bearer", serialized)

    def test_oversized_page_returns_the_real_last_page(self):
        snapshot = _snapshot()
        snapshot["states"] = {
            f"sensor.sample_{index}": {
                "entity_id": f"sensor.sample_{index}",
                "state": str(index),
                "attributes": {"friendly_name": f"样本传感器 {index}"},
            }
            for index in range(25)
        }
        snapshot["registries"] = {"entities": {}, "devices": {}, "areas": {}}

        payload = _build_home_assistant_workspace(
            snapshot,
            [],
            {"id": 1, "name": "HA", "base_url": "http://ha:8123", "credential_configured": True},
            page=9,
            size=10,
        )

        self.assertEqual(payload["page"], 3)
        self.assertEqual(payload["pages"], 3)
        self.assertEqual(payload["total"], 25)
        self.assertEqual(len(payload["items"]), 5)

    def test_diagnostic_entity_samples_report_full_affected_scope(self):
        snapshot = _snapshot()
        mappings = [
            {
                "mapping_id": index,
                "endpoint": f"light.missing_{index}",
                "role": "power",
                "access_mode": "rw",
                "device_id": index,
                "device_name": f"失联灯 {index}",
                "aliases": [],
            }
            for index in range(25)
        ]

        payload = _build_home_assistant_workspace(
            snapshot,
            mappings,
            {"id": 1, "name": "HA", "base_url": "http://ha:8123", "credential_configured": True},
            size=20,
        )

        diagnostic = next(item for item in payload["diagnostics"] if item["id"] == "orphan-mappings")
        self.assertEqual(diagnostic["affected_count"], 25)
        self.assertEqual(len(diagnostic["entity_ids"]), 20)
        self.assertTrue(diagnostic["entity_ids_truncated"])
        self.assertEqual(payload["orphan_total"], 25)
        self.assertEqual(len(payload["orphan_items"]), 20)
        self.assertEqual(payload["orphan_items"][0]["platform_device_name"], "失联灯 0")
        self.assertEqual(payload["orphan_items"][0]["mapping_role"], "power")
        self.assertEqual(payload["orphan_items"][0]["entity_id"], "light.missing_0")

    def test_diagnostics_are_paginated_independently_from_entities(self):
        snapshot = _snapshot()
        snapshot["states"] = {
            f"light.room_{index}": {
                "entity_id": f"light.room_{index}",
                "state": "on",
                "attributes": {"friendly_name": f"卧室灯 {index}"},
            }
            for index in range(12)
        }
        snapshot["registries"] = {
            "entities": {
                entity_id: {"entity_id": entity_id, "platform": "xiaomi_home", "device_id": f"device-{index}"}
                for index, entity_id in enumerate(snapshot["states"])
            },
            "devices": {
                f"device-{index}": {"id": f"device-{index}", "name": f"卧室灯 {index}", "area_id": "bedroom"}
                for index in range(12)
            },
            "areas": {"bedroom": {"area_id": "bedroom", "name": "卧室"}},
        }
        mappings = [
            {
                "mapping_id": index,
                "endpoint": entity_id,
                "role": "power",
                "access_mode": "rw",
                "device_id": index,
                "device_name": f"卧室灯 {index}",
                "aliases": [f"客厅灯 {index}"],
            }
            for index, entity_id in enumerate(snapshot["states"])
        ]

        payload = _build_home_assistant_workspace(
            snapshot,
            mappings,
            {"id": 1, "name": "HA", "base_url": "http://ha:8123", "credential_configured": True},
            page=1,
            size=10,
            diagnostic_page=2,
            diagnostic_size=5,
        )

        self.assertEqual(payload["page"], 1)
        self.assertEqual(payload["diagnostics_total"], 13)
        self.assertEqual(payload["diagnostics_page"], 2)
        self.assertEqual(payload["diagnostics_size"], 5)
        self.assertEqual(payload["diagnostics_pages"], 3)
        self.assertEqual(len(payload["diagnostics"]), 5)


class HomeAssistantWorkspaceCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        _ha_workspace_snapshot_cache.clear()
        _ha_workspace_snapshot_pending.clear()

    async def asyncTearDown(self):
        _ha_workspace_snapshot_cache.clear()
        _ha_workspace_snapshot_pending.clear()

    async def test_concurrent_requests_share_one_ha_snapshot(self):
        service = SimpleNamespace()
        calls = {"states": 0, "registries": 0}

        async def get_states():
            calls["states"] += 1
            await asyncio.sleep(0.01)
            return []

        async def get_registries():
            calls["registries"] += 1
            await asyncio.sleep(0.01)
            return {"entities": [], "devices": [], "areas": []}

        service.get_states = get_states
        service.get_registries = get_registries
        first, second = await asyncio.gather(
            _get_cached_ha_workspace_snapshot("same-ha", service),
            _get_cached_ha_workspace_snapshot("same-ha", service),
        )
        self.assertEqual(calls, {"states": 1, "registries": 1})
        self.assertFalse(first["cache_hit"])
        self.assertTrue(second["cache_hit"])

    async def test_cancelling_one_waiter_keeps_shared_ha_snapshot_alive(self):
        release = asyncio.Event()
        calls = 0

        async def get_states():
            nonlocal calls
            calls += 1
            await release.wait()
            return []

        service = SimpleNamespace(
            get_states=get_states,
            get_registries=AsyncMock(return_value={"entities": [], "devices": [], "areas": []}),
        )
        cancelled_waiter = asyncio.create_task(
            _get_cached_ha_workspace_snapshot("shielded-ha", service)
        )
        await asyncio.sleep(0)
        surviving_waiter = asyncio.create_task(
            _get_cached_ha_workspace_snapshot("shielded-ha", service)
        )
        await asyncio.sleep(0)
        cancelled_waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled_waiter

        release.set()
        snapshot = await surviving_waiter
        self.assertEqual(calls, 1)
        self.assertTrue(snapshot["cache_hit"])
        self.assertIn("shielded-ha", _ha_workspace_snapshot_cache)

    async def test_cache_isolated_by_configuration_key(self):
        service = SimpleNamespace()
        calls = 0

        async def get_states():
            nonlocal calls
            calls += 1
            return []

        async def get_registries():
            return {"entities": [], "devices": [], "areas": []}

        service.get_states = get_states
        service.get_registries = get_registries
        await _get_cached_ha_workspace_snapshot("ha-one", service)
        await _get_cached_ha_workspace_snapshot("ha-two", service)
        self.assertEqual(calls, 2)

    async def test_sequential_filters_reuse_the_same_recent_snapshot(self):
        service = SimpleNamespace()
        calls = {"states": 0, "registries": 0}

        async def get_states():
            calls["states"] += 1
            return []

        async def get_registries():
            calls["registries"] += 1
            return {"entities": [], "devices": [], "areas": []}

        service.get_states = get_states
        service.get_registries = get_registries
        first = await _get_cached_ha_workspace_snapshot("same-filter-session", service)
        second = await _get_cached_ha_workspace_snapshot("same-filter-session", service)

        self.assertEqual(calls, {"states": 1, "registries": 1})
        self.assertFalse(first["cache_hit"])
        self.assertTrue(second["cache_hit"])

    async def test_connection_failures_return_structured_degraded_snapshot(self):
        service = SimpleNamespace(
            get_states=AsyncMock(side_effect=httpx.ConnectTimeout("connect timed out")),
            get_registries=AsyncMock(side_effect=httpx.ConnectTimeout("connect timed out")),
        )

        snapshot = await _load_ha_workspace_snapshot(service)

        self.assertEqual(snapshot["states"], {})
        self.assertEqual(snapshot["registries"], {"entities": {}, "devices": {}, "areas": {}})
        self.assertEqual(snapshot["discovery_error"], "Home Assistant 连接超时")
        self.assertNotIn("connect timed out", snapshot["discovery_error"])

    async def test_registry_timeout_keeps_available_states(self):
        release = asyncio.Event()

        async def get_registries():
            await release.wait()
            return {"entities": [], "devices": [], "areas": []}

        service = SimpleNamespace(
            get_states=AsyncMock(return_value=[{
                "entity_id": "light.available",
                "state": "on",
                "attributes": {"friendly_name": "可用灯光"},
            }]),
            get_registries=get_registries,
        )
        with patch("app.routers.devices.HA_WORKSPACE_READ_TIMEOUT_SECONDS", 0.01):
            snapshot = await _load_ha_workspace_snapshot(service)

        self.assertIn("light.available", snapshot["states"])
        self.assertEqual(snapshot["discovery_error"], "")
        self.assertEqual(snapshot["registry_error"], "Home Assistant 连接超时")

    async def test_invalid_upstream_shapes_do_not_escape_as_server_error(self):
        service = SimpleNamespace(
            get_states=AsyncMock(return_value={"unexpected": True}),
            get_registries=AsyncMock(return_value=["unexpected"]),
        )

        snapshot = await _load_ha_workspace_snapshot(service)

        self.assertEqual(snapshot["states"], {})
        self.assertEqual(snapshot["registries"], {"entities": {}, "devices": {}, "areas": {}})
        self.assertEqual(snapshot["discovery_error"], "Home Assistant 状态接口返回格式异常")
        self.assertEqual(snapshot["registry_error"], "Home Assistant 注册表返回格式异常")

    async def test_health_response_includes_probe_freshness(self):
        service = SimpleNamespace(check_health=AsyncMock(return_value=False))
        with (
            patch("app.routers.devices._ensure_default_gateway", AsyncMock(return_value=SimpleNamespace())),
            patch("app.routers.devices._get_ha_service", AsyncMock(return_value=service)),
        ):
            payload = await health(db=AsyncMock())

        self.assertEqual(payload["status"], "error")
        self.assertFalse(payload["ha_connected"])
        self.assertGreaterEqual(payload["latency_ms"], 0)
        self.assertIn("+00:00", payload["tested_at"])


if __name__ == "__main__":
    unittest.main()
