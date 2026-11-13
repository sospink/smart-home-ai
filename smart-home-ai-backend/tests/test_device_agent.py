import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.models.operation_log import OperationLog
from app.services.device_agent import build_device_control_inventory, resolve_device_command, try_execute_device_command


def _inventory(state: str = "on") -> list[dict]:
    return [
        {
            "device_id": "23",
            "name": "筒灯",
            "location": "卧室",
            "category": "light",
            "source": "ha_sync",
            "mappings": [
                {
                    "role": "power",
                    "entity_id": "light.real",
                    "access_mode": "rw",
                    "state": state,
                    "available_actions": [
                        "turn_on",
                        "turn_off",
                        "toggle",
                        "set_brightness",
                        "set_color_temperature",
                        "set_effect",
                    ],
                    "capabilities": [
                        {
                            "id": "effect",
                            "action": "set_effect",
                            "control_type": "select",
                            "options": ["明亮模式", "温馨模式", "夜灯模式"],
                        }
                    ],
                }
            ],
        }
    ]


class DeviceAgentTests(unittest.TestCase):
    def test_plain_status_question_is_not_intercepted(self):
        command = resolve_device_command("筒灯现在是什么状态？", _inventory())
        self.assertTrue(command.handled)
        self.assertIn("电源：开启", command.message)
        self.assertNotIn("power：on", command.message)
        self.assertEqual(command.entity_id, "light.real")
        self.assertEqual(command.role, "power")

        brightness = resolve_device_command("筒灯亮度是多少？", _inventory())
        self.assertTrue(brightness.handled)

        closed = resolve_device_command("筒灯关闭了吗？", _inventory())
        self.assertTrue(closed.handled)

    def test_unrelated_question_is_not_intercepted(self):
        command = resolve_device_command("智慧家居有哪些核心能力？", _inventory())
        self.assertFalse(command.handled)

    def test_unknown_home_device_control_never_falls_back_to_dify(self):
        command = resolve_device_command("请打开客厅灯", _inventory())
        self.assertTrue(command.handled)
        self.assertIn("动态设备台账", command.message)
        self.assertIn("筒灯", command.message)

    def test_exact_device_name_resolves_dynamic_device_id(self):
        command = resolve_device_command("请打开筒灯", _inventory())
        self.assertTrue(command.handled)
        self.assertEqual(command.device_id, "23")
        self.assertEqual(command.action, "turn_on")
        self.assertEqual(command.role, "power")

    def test_runtime_alias_resolves_real_device(self):
        inventory = _inventory()
        inventory[0]["aliases"] = ["客厅灯", "客厅灯光", "小米筒灯"]
        command = resolve_device_command("请打开客厅灯光", inventory)
        self.assertTrue(command.handled)
        self.assertEqual(command.device_id, "23")
        self.assertEqual(command.entity_id, "light.real")
        self.assertEqual(command.action, "turn_on")

    def test_location_and_unique_category_can_resolve_device(self):
        command = resolve_device_command("把卧室的灯关闭", _inventory())
        self.assertTrue(command.handled)
        self.assertEqual(command.device_id, "23")
        self.assertEqual(command.action, "turn_off")

    def test_brightness_value_is_structured_and_validated_later(self):
        command = resolve_device_command("筒灯亮度设置为 42%", _inventory())
        self.assertEqual(command.action, "set_brightness")
        self.assertEqual(command.data, {"brightness_pct": 42.0})

    def test_effect_is_selected_from_runtime_capability_options(self):
        command = resolve_device_command("把筒灯设置为温馨模式", _inventory())
        self.assertEqual(command.action, "set_effect")
        self.assertEqual(command.data, {"effect": "温馨模式"})

    def test_missing_numeric_target_returns_clarification(self):
        command = resolve_device_command("调节筒灯亮度", _inventory())
        self.assertTrue(command.handled)
        self.assertFalse(command.action)
        self.assertIn("0 到 100", command.message)

    def test_unsupported_action_never_falls_back_to_guessed_entity(self):
        inventory = _inventory()
        inventory[0]["mappings"][0]["available_actions"] = ["turn_on", "turn_off"]
        command = resolve_device_command("切换筒灯", inventory)
        self.assertTrue(command.handled)
        self.assertIn("不支持动作", command.message)

    def test_ambiguous_location_category_requires_exact_name(self):
        inventory = _inventory() + [
            {
                **_inventory()[0],
                "device_id": "24",
                "name": "床头灯",
            }
        ]
        command = resolve_device_command("把卧室的灯关闭", inventory)
        self.assertTrue(command.handled)
        self.assertIn("多个设备", command.message)


class _DeviceScalarResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def unique(self):
        return self

    def all(self):
        return self._rows


class DeviceAgentInventoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_inventory_accepts_gateway_error_details_from_ha_snapshot(self):
        mapping = SimpleNamespace(
            endpoint="light.real",
            role="power",
            access_mode="rw",
            control_actions=["turn_on", "turn_off"],
            mapping_metadata={},
        )
        device = SimpleNamespace(
            id=23,
            name="筒灯",
            location="卧室",
            category="light",
            source="ha_sync",
            gateway_id=7,
            mappings=[mapping],
        )
        mapping.device = device
        db = AsyncMock()
        db.execute.return_value = _DeviceScalarResult([device])
        ha_maps = {7: {"light.real": {"state": "on", "attributes": {}}}}

        with patch(
            "app.services.device_agent._get_ha_maps_for_devices",
            AsyncMock(return_value=(ha_maps, "", {})),
        ):
            inventory = await build_device_control_inventory(db)

        self.assertEqual(len(inventory), 1)
        self.assertEqual(inventory[0]["name"], "筒灯")
        self.assertEqual(inventory[0]["mappings"][0]["state"], "on")

    async def test_unrelated_chat_skips_device_inventory(self):
        with patch(
            "app.services.device_agent.build_device_control_inventory",
            AsyncMock(side_effect=AssertionError("普通对话不应读取设备库存")),
        ):
            result = await try_execute_device_command(
                "请介绍智慧家居的核心能力",
                {"user_id": 1},
                AsyncMock(),
            )

        self.assertIsNone(result)

    async def test_local_result_and_operation_log_share_stable_message_id(self):
        db = AsyncMock()
        db.add = unittest.mock.Mock()
        with patch(
            "app.services.device_agent.build_device_control_inventory",
            AsyncMock(return_value=_inventory()),
        ):
            result = await try_execute_device_command(
                "筒灯现在是什么状态？",
                {"user_id": 1, "username": "tester"},
                db,
            )

        self.assertTrue(result["message_id"].startswith("local-control-"))
        log = db.add.call_args.args[0]
        self.assertIsInstance(log, OperationLog)
        self.assertIn(f"message_id={result['message_id']}", log.detail)
        db.flush.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
