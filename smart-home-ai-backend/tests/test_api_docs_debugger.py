import inspect
from pathlib import Path
import unittest

from app.routers.api_docs import (
    LOCAL_MODEL_DEBUG_TIMEOUT_SECONDS,
    PLATFORM_DEBUG_TIMEOUT_SECONDS,
    _extract_installed_model_names,
    _extract_local_model_name,
    _format_debug_http_error,
    _get_debug_timeout,
    _is_local_model_target_allowed,
    _is_model_installed,
    _local_model_preflight_error,
    _requires_debugger_confirmation,
    execute_debugger_request,
)


class ApiDocsDebuggerTests(unittest.TestCase):
    @staticmethod
    def _frontend_source(relative_path: str) -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (project_root / "smart-home-ai-frontend" / relative_path).read_text(encoding="utf-8")

    def test_local_model_debugger_allows_cold_start(self):
        self.assertEqual(_get_debug_timeout(False).read, PLATFORM_DEBUG_TIMEOUT_SECONDS)
        self.assertEqual(_get_debug_timeout(True).read, LOCAL_MODEL_DEBUG_TIMEOUT_SECONDS)
        self.assertGreater(LOCAL_MODEL_DEBUG_TIMEOUT_SECONDS, PLATFORM_DEBUG_TIMEOUT_SECONDS)

    def test_debugger_does_not_route_localhost_through_system_proxy(self):
        source = inspect.getsource(execute_debugger_request)
        self.assertIn("trust_env=False", source)

    def test_extracts_inference_model_from_json_body(self):
        body = '{"model":"qwen3:4b","prompt":"你好","stream":false}'
        self.assertEqual(_extract_local_model_name("/api/generate", body), "qwen3:4b")
        self.assertEqual(_extract_local_model_name("/api/tags", body), "")
        self.assertEqual(_extract_local_model_name("/api/generate", "not-json"), "")

    def test_extracts_unique_installed_model_names(self):
        names = _extract_installed_model_names(
            {
                "models": [
                    {"name": "qwen3:4b", "model": "qwen3:4b"},
                    {"name": "nomic-embed-text:latest"},
                ]
            }
        )
        self.assertEqual(names, ["qwen3:4b", "nomic-embed-text:latest"])
        self.assertTrue(_is_model_installed("nomic-embed-text", names))

    def test_empty_model_list_returns_actionable_error_without_http_404(self):
        message = _local_model_preflight_error("deepseek-r1:1.5b", [])
        self.assertIn("没有已安装模型", message)
        self.assertIn("开源大语言模型", message)
        self.assertNotIn("HTTP 404", message)

    def test_mismatched_model_lists_available_models(self):
        message = _local_model_preflight_error("deepseek-r1:1.5b", ["qwen3:4b"])
        self.assertIn("deepseek-r1:1.5b 尚未安装", message)
        self.assertIn("qwen3:4b", message)

    def test_ollama_model_404_is_not_reported_as_missing_api(self):
        message = _format_debug_http_error(
            404,
            "http://localhost:11434/api/generate",
            '{"error":"model \'deepseek-r1:1.5b\' not found"}',
            is_local_model=True,
        )
        self.assertIn("模型尚未安装", message)
        self.assertNotIn("请求失败：HTTP 404", message)

    def test_local_model_target_must_match_trusted_runtime_url(self):
        trusted = "http://106.75.139.179:11434"
        self.assertTrue(_is_local_model_target_allowed(trusted, "/api/tags", trusted))
        self.assertFalse(_is_local_model_target_allowed("http://127.0.0.1:11434", "/api/tags", trusted))
        self.assertFalse(_is_local_model_target_allowed(trusted, "/v1/chat", trusted))

    def test_risky_debugger_requests_require_explicit_confirmation(self):
        self.assertFalse(_requires_debugger_confirmation("system", "GET", "/api/v1/system/health"))
        self.assertFalse(_requires_debugger_confirmation("local-model", "POST", "/api/generate"))
        self.assertFalse(_requires_debugger_confirmation("local-model", "POST", "/api/chat"))
        self.assertTrue(_requires_debugger_confirmation("local-model", "POST", "/api/pull"))
        self.assertTrue(_requires_debugger_confirmation("device-control", "POST", "/api/v1/devices/1/control"))
        self.assertTrue(_requires_debugger_confirmation("system", "DELETE", "/api/v1/users/1"))

    def test_backend_enforces_risky_execution_confirmation(self):
        source = inspect.getsource(execute_debugger_request)
        self.assertIn("confirm_risky_execution", source)
        self.assertIn("请在调试器中确认后再执行", source)

    def test_debugger_browser_storage_is_isolated_by_account(self):
        source = self._frontend_source("components/docs/ApiReferenceView.tsx")
        self.assertIn("getAuthCacheScope", source)
        self.assertIn("debuggerStorageKey(DEBUGGER_FAVORITES_KEY, debuggerStorageScope)", source)
        self.assertIn("debuggerStorageKey(DEBUGGER_RECENT_KEY, debuggerStorageScope)", source)
        self.assertIn("debuggerStorageKey(DEBUGGER_HISTORY_KEY, debuggerStorageScope)", source)
        self.assertIn("window.localStorage.removeItem(DEBUGGER_FAVORITES_KEY)", source)
        self.assertIn("window.localStorage.removeItem(DEBUGGER_RECENT_KEY)", source)
        self.assertIn("window.localStorage.removeItem(DEBUGGER_HISTORY_KEY)", source)
        self.assertIn("executionControllerRef.current?.abort()", source)
        self.assertIn("restoreControllerRef.current?.abort()", source)
        self.assertIn("setDebugResult({ status: null", source)

    def test_shared_pagination_hides_redundant_page_size_control(self):
        source = self._frontend_source("components/ui/Pagination.tsx")
        self.assertIn("const minimumPageSize = normalizedPageSizeOptions[0] || pageSize", source)
        self.assertIn("total > minimumPageSize", source)
        self.assertIn("label: `每页 ${option} ${unit}`", source)
        self.assertIn("h-9 w-[8rem] shrink-0", source)

        select_source = self._frontend_source("components/ui/UnifiedSelect.tsx")
        self.assertIn("const COMPACT_PANEL_MIN_WIDTH = 152", select_source)
        self.assertIn("whitespace-nowrap", select_source)

    def test_screenshot_panels_keep_complete_visible_boundaries(self):
        knowledge_source = self._frontend_source("app/(dashboard)/knowledge/[id]/page.tsx")
        vector_panel = knowledge_source.index("向量检索能力")
        self.assertIn(
            "rounded-[8px] border border-slate-300",
            knowledge_source[max(0, vector_panel - 500):vector_panel],
        )

        help_source = self._frontend_source("app/(dashboard)/help-docs/page.tsx")
        entry_panel = help_source.index("文档入口分工")
        self.assertIn(
            "rounded-[8px] border border-blue-300",
            help_source[max(0, entry_panel - 500):entry_panel],
        )
        reference_panel = help_source.index("接口参考入口")
        self.assertIn(
            "rounded-[8px] border border-slate-300",
            help_source[max(0, reference_panel - 500):reference_panel],
        )


if __name__ == "__main__":
    unittest.main()
