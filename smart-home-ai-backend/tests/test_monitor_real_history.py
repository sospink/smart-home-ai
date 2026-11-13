import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.routers.monitor import (
    _check_service_health,
    _get_gpu_info,
    _load_monitor_sensor_map,
    agent_data_query,
    ai_status,
    control_trends,
    sensor_history,
    service_health,
    system_resources,
    today_activity,
)


SENSOR_MAP = {
    "temperature": {"entity_id": "sensor.real_temperature", "label": "室内温度", "unit": "°C"},
    "humidity": {"entity_id": "sensor.real_humidity", "label": "室内湿度", "unit": "%"},
    "pm25": {"entity_id": "sensor.real_pm25", "label": "PM2.5", "unit": "μg/m³"},
}


class MonitorFrontendContractTests(unittest.TestCase):
    @staticmethod
    def _source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "monitor"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_top_warning_only_summarizes_failed_sections_with_snapshots(self):
        source = self._source()
        for expression in (
            "resources && resourceError",
            "aiStatus && aiError",
            "activity && activityError",
            "deviceSummary && deviceError",
            "logsLoaded && logsError",
        ):
            self.assertIn(expression, source)
        self.assertIn("{retainedPrimaryError ? (", source)
        self.assertIn("对应区块继续保留上一次成功结果", source)
        self.assertIn("重新读取旧快照失败项", source)


def _runtime_services():
    return SimpleNamespace(
        config=SimpleNamespace(
            influxdb_url="http://influx.test",
            influxdb_token="token",
            influxdb_org="org",
            influxdb_bucket="bucket",
        ),
        homeassistant=AsyncMock(),
    )


class _ScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar(self):
        return self.value


class _RowsResult:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        return self

    def all(self):
        return self.rows


class MonitorRealHistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_service_health_distinguishes_auth_failure_and_unknown_latency(self):
        response = SimpleNamespace(status_code=401)
        client = AsyncMock()
        client.get.return_value = response
        client.__aenter__.return_value = client
        client.__aexit__.return_value = None

        with patch("httpx.AsyncClient", return_value=client):
            result = await _check_service_health("Dify", "http://service.test/v1/datasets")

        self.assertEqual(result["status"], "auth_error")
        self.assertEqual(result["http_status"], 401)
        self.assertIsInstance(result["latency_ms"], int)
        self.assertIn("凭证", result["diagnostic"])
        self.assertNotIn("service.test", result["diagnostic"])

    async def test_service_health_connection_failure_does_not_report_zero_ms(self):
        import httpx

        request = httpx.Request("GET", "http://service.test/health")
        client = AsyncMock()
        client.get.side_effect = httpx.ConnectError("connection refused", request=request)
        client.__aenter__.return_value = client
        client.__aexit__.return_value = None

        with patch("httpx.AsyncClient", return_value=client):
            result = await _check_service_health("InfluxDB", "http://service.test/health")

        self.assertEqual(result["status"], "stopped")
        self.assertIsNone(result["latency_ms"])
        self.assertIsNone(result["http_status"])
        self.assertNotIn("service.test", result["diagnostic"])

    async def test_service_health_skips_unconfigured_credentials(self):
        runtime = SimpleNamespace(
            ollama_base_url="http://ollama.test",
            ha_base_url="http://ha.test",
            ha_token="",
            dify_base_url="http://dify.test",
            dify_dataset_api_key="",
            influxdb_url="http://influx.test",
        )
        check = AsyncMock(return_value={
            "name": "服务",
            "status": "running",
            "latency_ms": 4,
            "http_status": 200,
            "diagnostic": "服务响应正常",
        })

        with (
            patch("app.routers.monitor.get_runtime_config", AsyncMock(return_value=runtime)),
            patch("app.routers.monitor._check_service_health", check),
        ):
            result = await service_health(_user={}, db=AsyncMock())

        self.assertEqual(check.await_count, 2)
        services = {item["name"]: item for item in result["services"]}
        self.assertEqual(services["Home Assistant"]["status"], "unconfigured")
        self.assertEqual(services["Dify 智能体框架"]["status"], "unconfigured")
        self.assertIsNone(services["FastAPI 后端"]["latency_ms"])
        self.assertIn("已运行", services["FastAPI 后端"]["extra"])

    def test_gpu_fallback_preserves_unknown_numeric_values(self):
        gpu = _get_gpu_info()
        if gpu["available"]:
            self.skipTest("当前环境存在可用 NVIDIA GPU")

        self.assertIsNone(gpu["percent"])
        self.assertIsNone(gpu["vram_used_mb"])
        self.assertIsNone(gpu["vram_total_mb"])

    async def test_system_resources_preserves_no_gpu_as_unknown(self):
        no_gpu = {
            "available": False,
            "model": "N/A",
            "percent": None,
            "vram_used_mb": None,
            "vram_total_mb": None,
        }
        with patch("app.routers.monitor._get_gpu_info", return_value=no_gpu):
            result = await system_resources(_user={})

        self.assertFalse(result["gpu"]["available"])
        self.assertTrue(result["available"])
        self.assertEqual(result["diagnostic"], "")
        self.assertIsNone(result["gpu"]["percent"])
        self.assertIsNone(result["gpu"]["vram_used_gb"])
        self.assertIsNone(result["gpu"]["vram_total_gb"])
        self.assertEqual(result["disk"]["mount_path"], "/")
        self.assertGreaterEqual(result["disk"]["available_gb"], 0)
        self.assertLessEqual(result["disk"]["available_gb"], result["disk"]["total_gb"])

    async def test_system_resources_without_psutil_keeps_disk_contract(self):
        no_gpu = {
            "available": False,
            "model": "N/A",
            "percent": None,
            "vram_used_mb": None,
            "vram_total_mb": None,
        }
        with (
            patch("app.routers.monitor.psutil", None),
            patch("app.routers.monitor._get_gpu_info", return_value=no_gpu),
        ):
            result = await system_resources(_user={})

        self.assertEqual(result["disk"]["available_gb"], 0)
        self.assertEqual(result["disk"]["mount_path"], "/")
        self.assertFalse(result["available"])
        self.assertIn("psutil", result["diagnostic"])

    async def test_ai_status_idle_and_offline_do_not_report_fake_zero_vram(self):
        idle_services = SimpleNamespace(ollama=SimpleNamespace(
            running_models=AsyncMock(return_value=[]),
            list_models=AsyncMock(return_value=[{"name": "qwen", "details": {}}]),
        ))
        with patch("app.routers.monitor.get_runtime_services", AsyncMock(return_value=idle_services)):
            idle = await ai_status(_user={}, db=AsyncMock())

        offline_services = SimpleNamespace(ollama=SimpleNamespace(
            running_models=AsyncMock(side_effect=RuntimeError("offline")),
        ))
        with patch("app.routers.monitor.get_runtime_services", AsyncMock(return_value=offline_services)):
            offline = await ai_status(_user={}, db=AsyncMock())

        self.assertEqual(idle["status"], "idle")
        self.assertIsNone(idle["vram_used_gb"])
        self.assertEqual(offline["status"], "offline")
        self.assertIsNone(offline["vram_used_gb"])

    async def test_ai_status_running_preserves_real_zero_vram(self):
        services = SimpleNamespace(ollama=SimpleNamespace(
            running_models=AsyncMock(return_value=[{
                "name": "cpu-model",
                "size_vram": 0,
                "details": {},
            }]),
        ))
        with patch("app.routers.monitor.get_runtime_services", AsyncMock(return_value=services)):
            result = await ai_status(_user={}, db=AsyncMock())

        self.assertEqual(result["status"], "running")
        self.assertEqual(result["vram_used_gb"], 0)

    async def test_activity_preserves_external_unknown_and_counts_dispatched_controls(self):
        services = SimpleNamespace(
            dify=SimpleNamespace(get_conversations=AsyncMock(side_effect=RuntimeError("Dify offline"))),
            dify_knowledge=SimpleNamespace(list_datasets=AsyncMock(side_effect=RuntimeError("Dataset offline"))),
            ollama=SimpleNamespace(list_models=AsyncMock(side_effect=RuntimeError("Ollama offline"))),
        )
        db = AsyncMock()
        db.execute.return_value = _ScalarResult(7)

        with patch("app.routers.monitor.get_runtime_services", AsyncMock(return_value=services)):
            result = await today_activity(
                _user={"user_id": 42, "role": "user"},
                db=db,
            )

        self.assertIsNone(result["conversations_today"])
        self.assertEqual(result["controls_today"], 7)
        self.assertIsNone(result["knowledge_docs"])
        self.assertIsNone(result["model_count"])
        self.assertEqual(result["sources"]["conversations_today"]["status"], "unavailable")
        self.assertEqual(result["sources"]["controls_today"]["status"], "available")
        self.assertEqual(result["scopes"]["conversations_today"], "self")
        self.assertEqual(result["scopes"]["controls_today"], "self")
        services.dify.get_conversations.assert_awaited_once_with(user="user-42", limit=100)

        statement = db.execute.await_args.args[0]
        compiled = str(statement.compile(compile_kwargs={"literal_binds": True}))
        self.assertIn("result=pending", compiled)
        self.assertIn("operation_logs.user_id = 42", compiled)
        self.assertNotIn("operation_logs.level = 'success'", compiled)

    async def test_activity_keeps_real_zero_as_available(self):
        services = SimpleNamespace(
            dify=SimpleNamespace(get_conversations=AsyncMock(return_value={
                "data": [{"created_at": (datetime.now() - timedelta(days=2)).timestamp()}],
            })),
            dify_knowledge=SimpleNamespace(list_datasets=AsyncMock(return_value={"data": []})),
            ollama=SimpleNamespace(list_models=AsyncMock(return_value=[])),
        )
        db = AsyncMock()
        db.execute.return_value = _ScalarResult(0)

        with patch("app.routers.monitor.get_runtime_services", AsyncMock(return_value=services)):
            result = await today_activity(
                _user={"user_id": 1, "role": "admin"},
                db=db,
            )

        self.assertEqual(result["conversations_today"], 0)
        self.assertEqual(result["controls_today"], 0)
        self.assertEqual(result["knowledge_docs"], 0)
        self.assertEqual(result["model_count"], 0)
        self.assertTrue(all(
            source["status"] == "available"
            for source in result["sources"].values()
        ))
        self.assertEqual(result["scopes"]["controls_today"], "all")
        services.dify.get_conversations.assert_awaited_once_with(user="user-1", limit=100)

    async def test_control_trends_are_scoped_for_normal_users(self):
        now = datetime.now().replace(minute=0, second=0, microsecond=0)
        db = AsyncMock()
        db.execute.side_effect = [_RowsResult([now]), _RowsResult([])]

        result = await control_trends(
            user={"user_id": 42, "role": "user"},
            db=db,
        )

        self.assertEqual(result["visibility_scope"], "self")
        self.assertEqual(sum(result["today"]), 1)
        self.assertTrue(all(
            "operation_logs.user_id = 42" in str(
                call.args[0].compile(compile_kwargs={"literal_binds": True})
            )
            for call in db.execute.await_args_list
        ))
        self.assertTrue(all(
            "operation_logs.level = 'success'" in str(
                call.args[0].compile(compile_kwargs={"literal_binds": True})
            )
            for call in db.execute.await_args_list
        ))

    async def test_control_trends_report_query_failure_instead_of_fake_zeroes(self):
        db = AsyncMock()
        db.execute.side_effect = RuntimeError("database unavailable")

        with self.assertRaises(HTTPException) as context:
            await control_trends(
                user={"user_id": 42, "role": "user"},
                db=db,
            )

        self.assertEqual(context.exception.status_code, 503)
        self.assertIn("趋势暂时无法读取", context.exception.detail)
        self.assertNotIn("database unavailable", context.exception.detail)

    async def test_empty_sources_return_empty_series_without_generated_points(self):
        services = _runtime_services()
        services.homeassistant.get_history.return_value = []
        influx = AsyncMock()
        influx.query_points.return_value = []

        with (
            patch("app.routers.monitor.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.monitor.InfluxDBService", return_value=influx),
            patch("app.routers.monitor._load_monitor_sensor_map", AsyncMock(return_value={})),
        ):
            result = await sensor_history(hours=24, _user={}, db=AsyncMock())

        self.assertEqual(result["temperature"], [])
        self.assertEqual(result["humidity"], [])
        self.assertEqual(result["pm25"], [])
        self.assertEqual(result["_meta"]["data_source"], "no_real_data")
        self.assertFalse(result["_meta"]["generated"])
        self.assertEqual(result["_meta"]["available_metrics"], 0)
        self.assertTrue(all(
            item["source"] == "no_real_data"
            for item in result["_meta"]["metrics"].values()
        ))

    async def test_partial_real_history_does_not_fill_missing_metrics(self):
        services = _runtime_services()
        services.homeassistant.get_history.return_value = []
        influx = AsyncMock()

        async def query_points(**kwargs):
            if kwargs["entity_id"] == "sensor.real_temperature":
                return [{"time": "2026-07-30T08:00:00+00:00", "value": 24.2}]
            return []

        influx.query_points.side_effect = query_points
        with (
            patch("app.routers.monitor.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.monitor.InfluxDBService", return_value=influx),
            patch("app.routers.monitor._load_monitor_sensor_map", AsyncMock(return_value=SENSOR_MAP)),
        ):
            result = await sensor_history(hours=6, _user={}, db=AsyncMock())

        self.assertEqual(result["temperature"][0]["value"], 24.2)
        self.assertEqual(result["humidity"], [])
        self.assertEqual(result["pm25"], [])
        self.assertEqual(result["_meta"]["data_source"], "partial")
        self.assertEqual(result["_meta"]["available_metrics"], 1)
        self.assertEqual(result["_meta"]["aggregation_window_minutes"], 15)
        self.assertTrue(result["temperature"][0]["time"].endswith("+00:00"))
        self.assertEqual(result["_meta"]["metrics"]["temperature"]["first_point_at"], "2026-07-30T08:00:00+00:00")

    async def test_seven_day_influx_history_uses_full_range_window(self):
        services = _runtime_services()
        services.homeassistant.get_history.return_value = []
        influx = AsyncMock()
        influx.query_points.return_value = [
            {"time": "2026-07-23T08:00:00+00:00", "value": 20},
            {"time": "2026-07-30T08:00:00+00:00", "value": 31},
        ]

        with (
            patch("app.routers.monitor.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.monitor.InfluxDBService", return_value=influx),
            patch("app.routers.monitor._load_monitor_sensor_map", AsyncMock(return_value={"temperature": SENSOR_MAP["temperature"]})),
        ):
            result = await sensor_history(hours=168, _user={}, db=AsyncMock())

        self.assertEqual(result["_meta"]["target_points_per_metric"], 96)
        self.assertEqual(result["_meta"]["aggregation_window_minutes"], 105)
        self.assertEqual(influx.query_points.await_args.kwargs["window"], "105m")
        self.assertEqual(influx.query_points.await_args.kwargs["limit"], 97)
        self.assertEqual(result["temperature"][-1]["time"], "2026-07-30T08:00:00+00:00")

    async def test_home_assistant_sampling_preserves_first_and_last_points(self):
        services = _runtime_services()
        history = [
            {
                "entity_id": "sensor.real_temperature",
                "last_changed": f"2026-07-30T{index:02d}:00:00+08:00",
                "state": index,
            }
            for index in range(12)
        ]
        services.homeassistant.get_history.return_value = [history]
        influx = AsyncMock()
        influx.query_points.return_value = []

        with (
            patch("app.routers.monitor.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.monitor.InfluxDBService", return_value=influx),
            patch("app.routers.monitor._load_monitor_sensor_map", AsyncMock(return_value={"temperature": SENSOR_MAP["temperature"]})),
        ):
            result = await sensor_history(hours=1, _user={}, db=AsyncMock())

        points = result["temperature"]
        metric = result["_meta"]["metrics"]["temperature"]
        self.assertEqual(len(points), 4)
        self.assertEqual(points[0]["time"], "2026-07-30T00:00:00+08:00")
        self.assertEqual(points[-1]["time"], "2026-07-30T11:00:00+08:00")
        self.assertEqual(metric["raw_point_count"], 12)
        self.assertTrue(metric["coverage_truncated"])
        self.assertEqual(metric["aggregation"], "even_sample")

    async def test_monitor_sensor_map_excludes_helpers_without_device_registry_parent(self):
        helper_mapping = SimpleNamespace(
            gateway_type="homeassistant",
            endpoint="sensor.shi_nei_wen_du",
            role="temperature",
            unit="°C",
            mapping_metadata={"platform": "template"},
        )
        real_mapping = SimpleNamespace(
            gateway_type="homeassistant",
            endpoint="sensor.real_temperature",
            role="temperature",
            unit="°C",
            mapping_metadata={"platform": "xiaomi_home", "ha_device_id": "device-1", "device_class": "temperature"},
        )
        devices = [
            SimpleNamespace(id=1, name="沙盘温度", location="演示区", mappings=[helper_mapping]),
            SimpleNamespace(id=2, name="现场温度计", location="卧室", mappings=[real_mapping]),
        ]
        rows = SimpleNamespace(unique=lambda: SimpleNamespace(all=lambda: devices))
        db = AsyncMock()
        db.execute.return_value = SimpleNamespace(scalars=lambda: rows)

        result = await _load_monitor_sensor_map(db)

        self.assertEqual(result["temperature"]["entity_id"], "sensor.real_temperature")
        self.assertEqual(result["temperature"]["device_name"], "现场温度计")

    async def test_agent_query_reports_no_real_data_instead_of_success(self):
        result = {
            "temperature": [],
            "humidity": [],
            "pm25": [],
            "_meta": {
                "data_source": "no_real_data",
                "fallback_note": "没有真实历史点",
            },
        }
        with patch("app.routers.monitor.sensor_history", AsyncMock(return_value=result)):
            response = await agent_data_query(
                query="最近 24 小时室内温度趋势",
                metric="temperature",
                query_type="auto",
                entity_id="",
                hours=24,
                _user={},
                db=AsyncMock(),
            )

        self.assertEqual(response["status"], "no_real_data")
        self.assertEqual(response["data_source"], "no_real_data")
        self.assertEqual(response["result"], result)


if __name__ == "__main__":
    unittest.main()
