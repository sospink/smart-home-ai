import inspect
import unittest

from fastapi import HTTPException

from app.routers import devices, time_series
from app.routers.monitor import _resolve_agent_entity_from_inventory, _resolve_agent_query_type


class DynamicDeviceSourceTests(unittest.TestCase):
    def test_devices_do_not_regenerate_fixed_registry(self):
        source = inspect.getsource(devices)
        self.assertNotIn("DEVICE_REGISTRY", source)
        self.assertNotIn("_ensure_seed_data", source)

    def test_time_series_reads_managed_device_mappings(self):
        source = inspect.getsource(time_series._managed_entities)
        self.assertIn("ManagedDevice", source)
        self.assertIn("device.mappings", source)
        self.assertNotIn("DEVICE_REGISTRY", source)

    def test_monitor_agent_query_uses_dynamic_inventory(self):
        inventory = [
            {
                "device_name": "筒灯",
                "location": "卧室",
                "category": "light",
                "role": "power",
                "entity_id": "light.real",
            },
            {
                "device_name": "筒灯",
                "location": "卧室",
                "category": "light",
                "role": "brightness",
                "entity_id": "light.real_brightness",
            },
        ]
        self.assertEqual(
            _resolve_agent_entity_from_inventory("", "筒灯当前状态", "", inventory),
            "light.real",
        )
        self.assertEqual(
            _resolve_agent_entity_from_inventory("brightness", "查询筒灯亮度", "", inventory),
            "light.real_brightness",
        )

    def test_monitor_rejects_guessed_entity(self):
        inventory = [{
            "device_name": "筒灯",
            "location": "卧室",
            "category": "light",
            "role": "power",
            "entity_id": "light.real",
        }]
        with self.assertRaises(HTTPException) as context:
            _resolve_agent_entity_from_inventory("", "查询客厅灯", "light.guessed", inventory)
        self.assertEqual(context.exception.status_code, 404)
        self.assertIn("动态设备台账", context.exception.detail)

    def test_device_status_query_is_not_misclassified_as_service_health(self):
        self.assertEqual(_resolve_agent_query_type("筒灯现在是什么状态", "", "auto"), "realtime")
        self.assertEqual(_resolve_agent_query_type("查询系统健康状态", "", "auto"), "services")

    def test_history_query_distinguishes_device_from_sensor_trends(self):
        self.assertEqual(_resolve_agent_query_type("筒灯最近状态", "", "auto"), "device_history")
        self.assertEqual(_resolve_agent_query_type("最近 24 小时室内温度趋势", "", "auto"), "sensor_history")


if __name__ == "__main__":
    unittest.main()
