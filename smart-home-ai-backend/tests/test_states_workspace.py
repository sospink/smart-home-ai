import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.routers.states import realtime_states, sensor_states, state_summary


def _snapshot():
    return {
        "devices": [
            {
                "id": "1",
                "name": "卧室环境传感器",
                "description": "真实 HA 映射",
                "category": "sensor",
                "location": "卧室",
                "gateway_id": 1,
                "gateway_name": "家庭网关",
                "status": "online",
                "entities": {
                    "temperature": {
                        "entity_id": "sensor.bedroom_temperature",
                        "state": "24.6",
                        "unit": "°C",
                        "attributes": {"friendly_name": "卧室温度", "device_class": "temperature"},
                        "last_changed": "2026-08-01T01:00:00+00:00",
                        "access_mode": "read",
                    },
                    "occupancy": {
                        "entity_id": "binary_sensor.bedroom_occupancy",
                        "state": "unavailable",
                        "unit": "",
                        "attributes": {"friendly_name": "卧室有人"},
                        "last_changed": None,
                        "access_mode": "read",
                    },
                },
                "mappings": [
                    {"role": "temperature", "endpoint": "sensor.bedroom_temperature", "access_mode": "read"},
                    {"role": "occupancy", "endpoint": "binary_sensor.bedroom_occupancy", "access_mode": "read"},
                ],
            },
            {
                "id": "2",
                "name": "筒灯",
                "description": "现场灯具",
                "category": "light",
                "location": "卧室",
                "gateway_id": 1,
                "gateway_name": "家庭网关",
                "status": "online",
                "entities": {"power": {"entity_id": "light.real", "state": "off", "attributes": {}}},
                "mappings": [{"role": "power", "endpoint": "light.real"}],
            },
        ],
        "scenes": [{"entity_id": "scene.home", "name": "回家模式"}],
        "summary": {
            "total": 2,
            "online": 2,
            "offline": 0,
            "unmapped": 0,
            "disabled": 0,
            "seed": 0,
            "scene_count": 1,
            "categories": {"sensor": 1, "light": 1},
        },
        "ha_error": "",
        "generated_at": "2026-08-01T01:00:00+00:00",
    }


class StatesWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_realtime_reuses_device_snapshot_and_paginates(self):
        with patch("app.routers.states._get_device_list_snapshot", AsyncMock(return_value=(_snapshot(), "hit"))):
            payload = await realtime_states(
                page=9, size=1, category="light", status="online", keyword="筒灯",
                refresh=False, _user={"user_id": 1}, db=AsyncMock(),
            )

        self.assertEqual(payload["page"], 1)
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["items"][0]["name"], "筒灯")
        self.assertEqual(payload["cache"], "hit")
        self.assertFalse(payload["degraded"])

    async def test_realtime_rejects_unknown_status(self):
        with self.assertRaises(HTTPException) as context:
            await realtime_states(
                page=1, size=20, category="", status="running", keyword="",
                refresh=False, _user={"user_id": 1}, db=AsyncMock(),
            )
        self.assertEqual(context.exception.status_code, 422)

    async def test_sensors_only_return_real_sensor_domains(self):
        with patch("app.routers.states._get_device_list_snapshot", AsyncMock(return_value=(_snapshot(), "miss"))):
            payload = await sensor_states(
                page=1, size=20, available=None, keyword="卧室",
                refresh=False, _user={"user_id": 1}, db=AsyncMock(),
            )

        self.assertEqual(payload["total"], 2)
        self.assertEqual({item["sensor_type"] for item in payload["items"]}, {"sensor", "binary_sensor"})
        self.assertEqual(payload["summary"], {"total": 2, "available": 1, "unavailable": 1})
        self.assertNotIn("light.real", {item["entity_id"] for item in payload["items"]})

    async def test_sensor_availability_filter_and_degraded_truth(self):
        snapshot = _snapshot()
        snapshot["ha_error"] = "Home Assistant 暂不可用"
        with patch("app.routers.states._get_device_list_snapshot", AsyncMock(return_value=(snapshot, "shared"))):
            payload = await sensor_states(
                page=1, size=20, available=False, keyword="",
                refresh=False, _user={"user_id": 1}, db=AsyncMock(),
            )

        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["items"][0]["state"], "unavailable")
        self.assertTrue(payload["degraded"])
        self.assertEqual(payload["error"], "Home Assistant 暂不可用")

    async def test_summary_uses_same_inventory_and_sensor_counts(self):
        with patch("app.routers.states._get_device_list_snapshot", AsyncMock(return_value=(_snapshot(), "hit"))):
            payload = await state_summary(refresh=False, _user={"user_id": 1}, db=AsyncMock())

        self.assertEqual(payload["total"], 2)
        self.assertEqual(payload["scene_count"], 1)
        self.assertEqual(payload["sensors"], 2)
        self.assertEqual(payload["available_sensors"], 1)
        self.assertIn("Home Assistant REST 状态", payload["data_sources"])


if __name__ == "__main__":
    unittest.main()
