from pathlib import Path
import unittest


class DifyWorkspaceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_root = Path(__file__).resolve().parents[2]
        cls.source = (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "dify"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_first_failure_uses_specific_business_diagnostic_once(self):
        self.assertIn("datasetsError && datasets ?", self.source)
        self.assertIn("runsError && runs ?", self.source)
        self.assertIn(">{datasetsError}</p>", self.source)
        self.assertIn(">{runsError}</p>", self.source)
        self.assertNotIn("请检查 Dify 知识库地址、Dataset API Key 和网络后重试。", self.source)
        self.assertNotIn("当前无法判断是否存在测试记录，请检查平台后端后重试。", self.source)

    def test_failure_and_retry_controls_have_accessible_state(self):
        self.assertGreaterEqual(self.source.count('role="alert"'), 4)
        self.assertIn('aria-label="Dify 知识库列表，可横向滚动"', self.source)
        self.assertIn('aria-label="应用测试运行记录列表，可横向滚动"', self.source)
        self.assertIn("disabled={datasetsLoading}", self.source)
        self.assertIn("disabled={runsLoading}", self.source)
        self.assertIn("datasetsLoading ? '正在重新读取' : '重新读取知识库'", self.source)
        self.assertIn("runsLoading ? '正在重新读取' : '重新读取记录'", self.source)

    def test_incremental_recovery_never_aborts_an_active_overview_read(self):
        self.assertIn(".filter((key) => !resourceLoading[key])", self.source)
        self.assertIn("failedKeys.length && !dataAbortRef.current", self.source)
        self.assertIn("datasetsError && !datasetsAbortRef.current", self.source)
        self.assertIn("runsError && !runsAbortRef.current", self.source)
        self.assertIn("document.visibilityState !== 'visible'", self.source)


if __name__ == "__main__":
    unittest.main()
