from pathlib import Path
import unittest


class ActivityLogsWorkspaceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_root = Path(__file__).resolve().parents[2]
        cls.source = (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "activity-logs"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_first_failure_and_stale_snapshot_use_different_error_layers(self):
        self.assertIn("{error && hasLoaded ? (", self.source)
        self.assertIn('className="mx-auto flex max-w-xl flex-col items-center" role="alert"', self.source)
        self.assertIn('<p className="mt-1 max-w-full break-words text-xs leading-5">{error}</p>', self.source)
        self.assertNotIn('请使用上方“重试”重新读取', self.source)

    def test_first_failure_retry_has_pending_and_validation_guards(self):
        self.assertIn("disabled={refreshing || dateRangeInvalid}", self.source)
        self.assertIn("refreshing ? '正在重新读取' : '重新读取日志'", self.source)
        self.assertIn('role="alert"', self.source)

    def test_legacy_success_answers_are_not_presented_as_failures(self):
        self.assertIn("log.type === 'agent_device_status'", self.source)
        self.assertIn("return `状态查询结果：${answer}`", self.source)
        self.assertIn("const diagnostic = translateDiagnostic(fields.reason || fields.error || '')", self.source)
        self.assertNotIn("fields.reason || fields.error || fields.answer", self.source)
        self.assertIn("signature=[^；;,\\s]+", self.source)
        self.assertIn("return sanitizeBusinessSummary(log.summary)", self.source)

    def test_mobile_logs_show_business_context_without_a_wide_table(self):
        self.assertIn('divide-y divide-slate-100 md:hidden', self.source)
        self.assertIn('hidden max-w-full overflow-x-auto md:block', self.source)
        self.assertIn('操作人：{displayOperator(log.username)}', self.source)
        self.assertIn('line-clamp-2 break-words text-sm leading-6 text-slate-500 [overflow-wrap:anywhere]', self.source)


if __name__ == "__main__":
    unittest.main()
