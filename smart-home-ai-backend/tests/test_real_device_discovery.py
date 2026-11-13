import unittest
from unittest.mock import patch

from app.routers.devices import (
    ControlStateRollbackError,
    _build_entity_capabilities,
    _build_sync_candidates,
    _control_actions_for_entity,
    _control_result_confirmed,
    _control_confirmation,
    _confirmed_state_from_service_response,
    _entity_state,
    _state_from_service_response,
    _device_matches_search_keyword,
    _ensure_visible_light_turn_on,
    _select_control_mapping,
    _translate_control_action,
    _unique_mapping_role,
    _wait_for_control_confirmation,
    router as device_router,
)
from app.models.device_management import DeviceEntityMapping, ManagedDevice


class RealDeviceDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.states = {
            "input_boolean.demo": {
                "entity_id": "input_boolean.demo",
                "state": "on",
                "attributes": {"friendly_name": "演示灯"},
            },
            "light.real": {
                "entity_id": "light.real",
                "state": "on",
                "attributes": {
                    "friendly_name": " 真实   灯 ",
                    "brightness": 128,
                    "supported_color_modes": ["color_temp"],
                    "min_color_temp_kelvin": 2700,
                    "max_color_temp_kelvin": 5700,
                },
            },
            "switch.real_delay": {
                "entity_id": "switch.real_delay",
                "state": "off",
                "attributes": {"friendly_name": "延时"},
            },
        }
        self.registries = {
            "entities": {
                "input_boolean.demo": {
                    "entity_id": "input_boolean.demo",
                    "platform": "input_boolean",
                    "device_id": None,
                },
                "light.real": {
                    "entity_id": "light.real",
                    "platform": "xiaomi_home",
                    "device_id": "dev1",
                    "options": {"conversation": {"should_expose": True}},
                },
                "switch.real_delay": {
                    "entity_id": "switch.real_delay",
                    "platform": "xiaomi_home",
                    "device_id": "dev1",
                    "options": {"conversation": {"should_expose": True}},
                },
            },
            "devices": {
                "dev1": {
                    "id": "dev1",
                    "name": "真实灯",
                    "manufacturer": "小米",
                    "model": "xiaomi.light.test",
                    "area_id": "room1",
                }
            },
            "areas": {"room1": {"area_id": "room1", "name": "客厅"}},
        }

    def test_helper_is_not_importable(self):
        items = {
            item["entity_id"]: item
            for item in _build_sync_candidates(self.states, self.registries, set())
        }
        helper = items["input_boolean.demo"]
        self.assertEqual(helper["classification"], "helper")
        self.assertFalse(helper["importable"])
        self.assertFalse(helper["recommended"])

    def test_primary_hardware_entity_is_recommended(self):
        items = {
            item["entity_id"]: item
            for item in _build_sync_candidates(self.states, self.registries, set())
        }
        primary = items["light.real"]
        attached = items["switch.real_delay"]
        self.assertEqual(primary["classification"], "hardware")
        self.assertEqual(primary["name"], "真实 灯")
        self.assertEqual(primary["manufacturer"], "小米")
        self.assertEqual(primary["area_name"], "客厅")
        self.assertTrue(primary["recommended"])
        self.assertIn("set_brightness", primary["control_actions"])
        self.assertIn("set_color_temperature", primary["control_actions"])
        self.assertEqual(primary["capability_metadata"]["min_color_temp_kelvin"], 2700)
        self.assertFalse(attached["recommended"])

    def test_light_capabilities_are_derived_from_ha_attributes(self):
        attrs = {
            "brightness": 128,
            "supported_color_modes": ["color_temp"],
            "min_color_temp_kelvin": 2700,
            "max_color_temp_kelvin": 5700,
        }
        actions = _control_actions_for_entity("light.real", attrs, "light")
        capabilities = _build_entity_capabilities("light.real", attrs, actions, "on")
        capability_map = {item["id"]: item for item in capabilities}
        self.assertEqual(capability_map["brightness"]["current_value"], 50)
        self.assertEqual(capability_map["color_temperature"]["min"], 2700)
        self.assertEqual(capability_map["color_temperature"]["max"], 5700)

    def test_platform_actions_translate_to_valid_ha_services(self):
        service, data = _translate_control_action("set_brightness", {"brightness_pct": 42}, {})
        self.assertEqual(service, "turn_on")
        self.assertEqual(data, {"brightness_pct": 42})

        service, data = _translate_control_action(
            "set_color_temperature",
            {"color_temp_kelvin": 3200},
            {"min_color_temp_kelvin": 2700, "max_color_temp_kelvin": 5700},
        )
        self.assertEqual(service, "turn_on")
        self.assertEqual(data, {"color_temp_kelvin": 3200})

        service, data = _translate_control_action(
            "set_effect",
            {"effect": "温馨模式"},
            {"effect_list": ["温馨模式", "电影模式"]},
        )
        self.assertEqual(service, "turn_on")
        self.assertEqual(data, {"effect": "温馨模式"})

        effects = _build_entity_capabilities(
            "light.real",
            {"effect_list": ["温馨模式", "电影模式"]},
            ["set_effect"],
            "off",
        )
        self.assertIsNone(effects[0]["current_value"])

        with self.assertRaisesRegex(ValueError, "2700 到 5700"):
            _translate_control_action(
                "set_color_temperature",
                {"color_temp_kelvin": 6500},
                {"min_color_temp_kelvin": 2700, "max_color_temp_kelvin": 5700},
            )

    def test_control_success_requires_matching_ha_readback(self):
        previous = {"state": "on", "attributes": {"brightness": 255}}
        self.assertTrue(
            _control_result_confirmed(
                "turn_off",
                {},
                previous,
                {"state": "off", "attributes": {}},
            )
        )
        self.assertFalse(
            _control_result_confirmed(
                "turn_off",
                {},
                previous,
                {"state": "on", "attributes": {}},
            )
        )
        self.assertTrue(
            _control_result_confirmed(
                "set_brightness",
                {"brightness_pct": 50},
                previous,
                {"state": "on", "attributes": {"brightness": 128}},
            )
        )
        self.assertFalse(
            _control_result_confirmed(
                "set_color_temperature",
                {"color_temp_kelvin": 3200},
                previous,
                {"state": "on", "attributes": {"color_temp_kelvin": 4000}},
            )
        )

    def test_plain_turn_on_restores_an_almost_dark_light(self):
        data = _ensure_visible_light_turn_on(
            "light",
            "turn_on",
            {},
            {"state": "on", "attributes": {"brightness": 3}},
        )
        self.assertEqual(data, {"brightness_pct": 100})
        self.assertFalse(
            _control_result_confirmed(
                "turn_on",
                data,
                {"state": "on", "attributes": {"brightness": 3}},
                {"state": "on", "attributes": {"brightness": 3}},
            )
        )
        self.assertTrue(
            _control_result_confirmed(
                "turn_on",
                data,
                {"state": "on", "attributes": {"brightness": 3}},
                {"state": "on", "attributes": {"brightness": 255}},
            )
        )

    def test_plain_turn_on_keeps_normal_or_explicit_brightness(self):
        normal = _ensure_visible_light_turn_on(
            "light",
            "turn_on",
            {},
            {"state": "off", "attributes": {"brightness": 128}},
        )
        explicit = _ensure_visible_light_turn_on(
            "light",
            "turn_on",
            {"brightness_pct": 20},
            {"state": "off", "attributes": {"brightness": 3}},
        )
        self.assertEqual(normal, {})
        self.assertEqual(explicit, {"brightness_pct": 20})

    def test_xiaomi_home_optimistic_state_requires_physical_confirmation(self):
        mapping = DeviceEntityMapping(
            role="power",
            endpoint="light.real",
            access_mode="rw",
            mapping_metadata={"platform": "xiaomi_home"},
        )
        self.assertEqual(
            _control_confirmation(mapping, is_scene_action=False),
            "physical_pending",
        )
        mapping.mapping_metadata = {"platform": "mqtt"}
        self.assertEqual(
            _control_confirmation(mapping, is_scene_action=False),
            "confirmed",
        )
        self.assertEqual(
            _control_confirmation(None, is_scene_action=True),
            "accepted",
        )
        mapping.mapping_metadata = {}
        self.assertEqual(
            _control_confirmation(
                mapping,
                is_scene_action=False,
                attributes={"integration_platform": "xiaomi_home"},
            ),
            "physical_pending",
        )

    def test_xiaomi_entity_state_exposes_physical_confirmation_boundary(self):
        mapping = DeviceEntityMapping(
            role="power",
            endpoint="light.real",
            gateway_type="homeassistant",
            access_mode="rw",
            mapping_metadata={"platform": "xiaomi_home"},
        )
        state = _entity_state(mapping, {
            "light.real": {
                "entity_id": "light.real",
                "state": "on",
                "attributes": {"brightness": 255},
                "last_changed": "2026-08-03T03:55:00+00:00",
            },
        })
        self.assertEqual(state["physical_confirmation"], "physical_pending")
        self.assertEqual(state["state"], "on")

    def test_service_response_state_is_reused_without_an_extra_read(self):
        state = {
            "entity_id": "light.real",
            "state": "on",
            "attributes": {"brightness": 128},
        }
        self.assertEqual(
            _state_from_service_response([state], "light.real"),
            state,
        )
        self.assertEqual(
            _state_from_service_response(
                [{"entity_id": "light.other", "state": "off"}],
                "light.real",
            ),
            None,
        )

    def test_dify_search_matches_runtime_device_alias(self):
        device = ManagedDevice(
            name="筒灯",
            description="现场 Home Assistant 导入的真实灯具",
            source="ha_sync",
            category="light",
        )
        device.mappings = [
            DeviceEntityMapping(
                role="power",
                endpoint="light.real",
                access_mode="rw",
                mapping_metadata={"aliases": ["客厅灯", "客厅灯光", "小米筒灯"]},
            )
        ]
        self.assertTrue(_device_matches_search_keyword(device, "客厅 灯光"))
        self.assertTrue(_device_matches_search_keyword(device, "真实灯具"))
        self.assertFalse(_device_matches_search_keyword(device, "书房灯"))

    def test_select_action_rejects_unknown_option(self):
        service, data = _translate_control_action(
            "set_hvac_mode",
            {"hvac_mode": "cool"},
            {"hvac_modes": ["off", "cool", "heat"]},
        )
        self.assertEqual(service, "set_hvac_mode")
        self.assertEqual(data, {"hvac_mode": "cool"})
        with self.assertRaisesRegex(ValueError, "不支持选项"):
            _translate_control_action(
                "set_hvac_mode",
                {"hvac_mode": "invalid"},
                {"hvac_modes": ["off", "cool", "heat"]},
            )

    def test_action_selects_the_matching_mapping_for_ai_control(self):
        device = ManagedDevice(name="组合设备", source="ha_sync", category="climate")
        power = DeviceEntityMapping(
            role="power",
            endpoint="switch.climate_power",
            access_mode="rw",
            control_actions=["turn_on", "turn_off"],
        )
        climate = DeviceEntityMapping(
            role="climate",
            endpoint="climate.bedroom",
            access_mode="rw",
            control_actions=["set_temperature", "set_hvac_mode"],
        )
        device.mappings = [power, climate]
        selected = _select_control_mapping(device.mappings, action="set_temperature")
        self.assertIs(selected, climate)

    def test_service_response_skips_polling_only_after_target_is_confirmed(self):
        previous = {"entity_id": "light.real", "state": "off", "attributes": {}}
        confirmed = [{
            "entity_id": "light.real",
            "state": "on",
            "attributes": {"brightness": 128},
        }]
        stale = [{"entity_id": "light.real", "state": "off", "attributes": {}}]

        self.assertEqual(
            _confirmed_state_from_service_response(
                confirmed, "light.real", "turn_on", {}, previous,
            )["state"],
            "on",
        )
        self.assertIsNone(
            _confirmed_state_from_service_response(
                stale, "light.real", "turn_on", {}, previous,
            )
        )

    def test_mapping_roles_are_unique_for_grouped_device(self):
        self.assertEqual(_unique_mapping_role("power", "switch", set()), "power")
        self.assertEqual(_unique_mapping_role("power", "switch", {"power"}), "power_switch")
        self.assertEqual(
            _unique_mapping_role("power", "switch", {"power", "power_switch"}),
            "power_switch_2",
        )

    def test_static_cleanup_route_precedes_catch_all_device_route(self):
        routes = [route.path for route in device_router.routes]
        self.assertLess(routes.index("/devices/demo-devices"), routes.index("/devices/{device_ref:path}"))
        self.assertLess(routes.index("/devices/{device_id}/logs"), routes.index("/devices/{device_ref:path}"))

    def test_device_collection_accepts_both_trailing_slash_forms_without_redirect(self):
        routes = {(route.path, method) for route in device_router.routes for method in route.methods}
        self.assertIn(("/devices", "GET"), routes)
        self.assertIn(("/devices/", "GET"), routes)
        self.assertIn(("/devices", "POST"), routes)
        self.assertIn(("/devices/", "POST"), routes)

        documented = {
            route.path
            for route in device_router.routes
            if getattr(route, "include_in_schema", False) and route.path in {"/devices", "/devices/"}
        }
        self.assertEqual(documented, {"/devices"})


class ControlConfirmationTests(unittest.IsolatedAsyncioTestCase):
    async def test_settle_window_rejects_optimistic_state_rollback(self):
        class FakeService:
            def __init__(self):
                self.states = iter([
                    {"state": "on", "attributes": {}},
                    {"state": "on", "attributes": {}},
                    {"state": "off", "attributes": {}},
                ])

            async def get_state(self, _entity_id):
                return next(self.states)

        with patch("app.routers.devices.asyncio.sleep", return_value=None):
            with self.assertRaisesRegex(ControlStateRollbackError, "回滚为 off"):
                await _wait_for_control_confirmation(
                    FakeService(),
                    "light.real",
                    "turn_on",
                    {},
                    {"state": "off", "attributes": {}},
                    settle_attempts=2,
                )

    async def test_settle_window_accepts_stable_target_state(self):
        class FakeService:
            async def get_state(self, _entity_id):
                return {"state": "on", "attributes": {}}

        with patch("app.routers.devices.asyncio.sleep", return_value=None):
            result = await _wait_for_control_confirmation(
                FakeService(),
                "light.real",
                "turn_on",
                {},
                {"state": "off", "attributes": {}},
                settle_attempts=2,
            )

        self.assertEqual(result["state"], "on")


if __name__ == "__main__":
    unittest.main()
