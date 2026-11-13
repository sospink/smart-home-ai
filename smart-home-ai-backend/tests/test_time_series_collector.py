import unittest
from datetime import datetime, timedelta

from fastapi import HTTPException

from app.routers.time_series import (
    COLLECT_FAILURE_LOG_INTERVAL_SECONDS,
    COLLECT_MAX_RETRY_SECONDS,
    _COLLECTOR_LOG_STATE,
    _collector_retry_seconds,
    _collector_error_signature,
    _collector_error_text,
    _external_error_reason,
    _should_log_collector_failure,
)


class TimeSeriesCollectorTests(unittest.TestCase):
    def setUp(self):
        _COLLECTOR_LOG_STATE.update({"error_signature": "", "logged_at": None})

    def test_retry_uses_exponential_backoff_with_upper_bound(self):
        self.assertEqual(_collector_retry_seconds(1), 60)
        self.assertEqual(_collector_retry_seconds(2), 120)
        self.assertEqual(_collector_retry_seconds(3), 240)
        self.assertEqual(_collector_retry_seconds(99), COLLECT_MAX_RETRY_SECONDS)

    def test_same_failure_is_suppressed_inside_log_window(self):
        now = datetime(2026, 7, 30, 8, 0, 0)
        self.assertTrue(_should_log_collector_failure("InfluxDB 离线", now))
        self.assertFalse(_should_log_collector_failure("InfluxDB 离线", now + timedelta(minutes=5)))
        self.assertTrue(_should_log_collector_failure(
            "InfluxDB 离线",
            now + timedelta(seconds=COLLECT_FAILURE_LOG_INTERVAL_SECONDS),
        ))

    def test_changed_failure_is_logged_immediately(self):
        now = datetime(2026, 7, 30, 8, 0, 0)
        self.assertTrue(_should_log_collector_failure("连接失败", now))
        self.assertTrue(_should_log_collector_failure("鉴权失败", now + timedelta(seconds=10)))

    def test_error_signature_is_stable_and_does_not_expose_original_error(self):
        left = _collector_error_signature("InfluxDB  写入失败\nServer disconnected")
        right = _collector_error_signature("influxdb 写入失败 server disconnected")
        changed = _collector_error_signature("InfluxDB 鉴权失败")
        self.assertEqual(left, right)
        self.assertNotEqual(left, changed)
        self.assertEqual(len(left), 16)
        self.assertNotIn("InfluxDB", left)

    def test_empty_transport_errors_have_actionable_chinese_reason(self):
        disconnected = type("ServerDisconnectedError", (Exception,), {})()
        self.assertEqual(_external_error_reason(disconnected), "服务连接已断开")
        self.assertEqual(
            _collector_error_text(HTTPException(status_code=502, detail="InfluxDB 写入失败：服务连接已断开")),
            "InfluxDB 写入失败：服务连接已断开",
        )

    def test_unknown_empty_error_never_produces_blank_diagnostic(self):
        self.assertEqual(_external_error_reason(RuntimeError()), "底层服务未返回错误详情")


if __name__ == "__main__":
    unittest.main()
