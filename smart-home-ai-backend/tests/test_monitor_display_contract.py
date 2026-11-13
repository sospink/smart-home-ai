import unittest
from pathlib import Path


class MonitorDisplayContractTests(unittest.TestCase):
    @staticmethod
    def _frontend_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "monitor"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_unknown_device_state_does_not_leak_into_business_summary(self):
        source = self._frontend_source()
        self.assertIn("function deviceStateText", source)
        self.assertIn("return '状态待确认'", source)
        self.assertIn('value={latest ? deviceStateText(latest.state)', source)
        self.assertNotIn("DEVICE_VALUE_TEXT[String(latest.state)] || String(latest.state", source)

    def test_force_refresh_waits_for_merged_compensation_batches(self):
        source = self._frontend_source()
        self.assertIn("await primaryReloadRef.current(true, Array.from(queued.keys))", source)
        self.assertIn("await slowReloadRef.current(true, Array.from(queued.keys))", source)
        self.assertNotIn("window.queueMicrotask(() => {", source)

    def test_same_range_history_force_refresh_shares_active_promise(self):
        source = self._frontend_source()
        self.assertIn("promise: Promise<void>", source)
        self.assertIn("return activeRequest.promise", source)
        self.assertIn("historyInFlightRef.current = { request, hours, force, promise }", source)
        self.assertNotIn("historyInFlightRef.current?.hours === hours && historyInFlightRef.current.force) return", source)


if __name__ == "__main__":
    unittest.main()
