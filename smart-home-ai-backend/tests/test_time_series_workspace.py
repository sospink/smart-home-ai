import asyncio
import inspect
import json
from pathlib import Path
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from fastapi.params import Depends
from app.dependencies import require_admin

from app.routers.time_series import (
    COLLECT_FAILURE_LOG_RETENTION,
    QUERY_CHART_LIMIT,
    _QUERY_CACHE,
    _QUERY_PENDING,
    _build_query_snapshot,
    _clear_query_cache,
    _external_error_reason,
    _get_query_snapshot,
    _prune_collector_logs,
    _validate_query_options,
    cleanup_time_series_collector_history,
    collect_once,
    time_series_export,
    time_series_entities,
    time_series_history,
    time_series_overview,
    time_series_query,
    time_series_sync,
)
from app.services.influxdb import InfluxDBService


def point(index: int, *, value=None, entity_id: str = "sensor.temperature") -> dict:
    return {
        "time": f"2026-07-30T00:{index % 60:02d}:00+00:00",
        "entity_id": entity_id,
        "domain": "sensor",
        "device_id": "7",
        "device_name": "温度传感器",
        "role": "temperature",
        "category": "sensor",
        "source": "collector",
        "field": "value_numeric",
        "value": index if value is None else value,
        "state_raw": str(index if value is None else value),
        "unit": "°C",
    }


def runtime_config(**overrides):
    values = {
        "influxdb_url": "http://localhost:8086",
        "influxdb_token": "configured",
        "influxdb_org": "smart-home",
        "influxdb_bucket": "smart-home-data",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class ScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar(self):
        return self.value


class RowsResult:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        return self

    def all(self):
        return self.rows


class DeleteResult:
    def __init__(self, rowcount):
        self.rowcount = rowcount


class HistoryRowsResult:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        return self

    def all(self):
        return self.rows


class TimeSeriesWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    def test_connection_errors_are_converted_to_chinese_diagnostics(self):
        self.assertEqual(
            _external_error_reason(RuntimeError("Cannot connect to host 192.168.34.190:8086 ssl:default [Host is down]")),
            "无法建立连接",
        )

    def test_manual_sync_requires_admin(self):
        marker = inspect.signature(time_series_sync).parameters["user"].default
        self.assertIsInstance(marker, Depends)
        self.assertIs(marker.dependency, require_admin)

    def setUp(self):
        _clear_query_cache()
        _QUERY_PENDING.clear()

    def tearDown(self):
        for task in _QUERY_PENDING.values():
            task.cancel()
        _clear_query_cache()
        _QUERY_PENDING.clear()

    def test_snapshot_stats_and_chart_sampling_use_the_full_result(self):
        rows = [point(index, entity_id=f"sensor.{index % 3}") for index in range(900)]
        snapshot = _build_query_snapshot(rows)

        self.assertEqual(snapshot["total"], 900)
        self.assertEqual(snapshot["entity_count"], 3)
        self.assertEqual(snapshot["minimum"], 0)
        self.assertEqual(snapshot["maximum"], 899)
        self.assertEqual(snapshot["average"], 449.5)
        self.assertEqual(len(snapshot["chart_points"]), QUERY_CHART_LIMIT)
        self.assertEqual(snapshot["chart_points"][0]["value"], 0)
        self.assertEqual(snapshot["chart_points"][-1]["value"], 899)
        self.assertEqual(snapshot["chart_entity_count"], 3)
        self.assertEqual(snapshot["chart_entity_total"], 3)
        self.assertFalse(snapshot["chart_entities_truncated"])

    def test_chart_sampling_preserves_sparse_entities(self):
        rows = [point(index, entity_id="sensor.frequent") for index in range(999)]
        rows.append(point(999, entity_id="sensor.sparse"))

        snapshot = _build_query_snapshot(rows)

        entities = {item["entity_id"] for item in snapshot["chart_points"]}
        self.assertEqual(len(snapshot["chart_points"]), QUERY_CHART_LIMIT)
        self.assertEqual(entities, {"sensor.frequent", "sensor.sparse"})
        self.assertEqual(snapshot["chart_entity_count"], 2)
        self.assertFalse(snapshot["chart_entities_truncated"])

    def test_chart_sampling_reports_entity_coverage_truncation(self):
        rows = [point(index, entity_id=f"sensor.{index}") for index in range(QUERY_CHART_LIMIT + 5)]

        snapshot = _build_query_snapshot(rows)

        self.assertEqual(snapshot["chart_entity_count"], QUERY_CHART_LIMIT)
        self.assertEqual(snapshot["chart_entity_total"], QUERY_CHART_LIMIT + 5)
        self.assertTrue(snapshot["chart_entities_truncated"])
        selected_times = [item["time"] for item in snapshot["chart_points"]]
        expected_times = [item["time"] for item in rows[:QUERY_CHART_LIMIT]]
        self.assertEqual(selected_times, expected_times)

    async def test_keyword_query_uses_namespaced_flux_string_functions(self):
        query_api = MagicMock()
        query_api.query = AsyncMock(return_value=[])
        client = MagicMock()
        client.query_api.return_value = query_api
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=None)
        service = InfluxDBService(SimpleNamespace(
            url="http://influx.local",
            token="token",
            org="smart-home",
            bucket="smart-home-data",
        ))
        with patch.object(service, "_client", return_value=client):
            await service.query_points(keyword="temperature")

        flux = query_api.query.await_args.args[0]
        self.assertIn('import "strings"', flux)
        self.assertIn("strings.containsStr", flux)
        self.assertNotIn(" or containsStr", flux)
        self.assertIn("|> group()", flux)

    async def test_latest_point_groups_all_series_before_sorting(self):
        query_api = MagicMock()
        query_api.query = AsyncMock(return_value=[])
        client = MagicMock()
        client.query_api.return_value = query_api
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=None)
        service = InfluxDBService(SimpleNamespace(
            url="http://influx.local",
            token="token",
            org="smart-home",
            bucket="smart-home-data",
        ))

        with patch.object(service, "_client", return_value=client):
            await service.latest_point()

        flux = query_api.query.await_args.args[0]
        group_index = flux.index("|> group()")
        sort_index = flux.index('|> sort(columns: ["_time"], desc: true)')
        limit_index = flux.index("|> limit(n: 1)")
        self.assertLess(group_index, sort_index)
        self.assertLess(sort_index, limit_index)

    async def test_query_cache_returns_independent_copies(self):
        loader = AsyncMock(return_value=_build_query_snapshot([point(1)]))
        first, first_status = await _get_query_snapshot(("key",), loader)
        first["rows"][0]["device_name"] = "被调用方修改"
        second, second_status = await _get_query_snapshot(("key",), loader)

        self.assertEqual(first_status, "miss")
        self.assertEqual(second_status, "hit")
        self.assertEqual(second["rows"][0]["device_name"], "温度传感器")
        loader.assert_awaited_once()

    async def test_concurrent_queries_share_one_influx_request(self):
        release = asyncio.Event()

        async def loader():
            await release.wait()
            return _build_query_snapshot([point(1)])

        first_task = asyncio.create_task(_get_query_snapshot(("shared",), loader))
        await asyncio.sleep(0)
        second_task = asyncio.create_task(_get_query_snapshot(("shared",), loader))
        await asyncio.sleep(0)
        release.set()
        first, second = await asyncio.gather(first_task, second_task)

        self.assertEqual({first[1], second[1]}, {"miss", "shared"})
        self.assertEqual(first[0]["total"], 1)
        self.assertEqual(second[0]["total"], 1)

    async def test_cancelling_one_waiter_keeps_shared_influx_query_alive(self):
        release = asyncio.Event()
        loader_calls = 0

        async def loader():
            nonlocal loader_calls
            loader_calls += 1
            await release.wait()
            return _build_query_snapshot([point(1)])

        cancelled_waiter = asyncio.create_task(_get_query_snapshot(("shielded",), loader))
        await asyncio.sleep(0)
        surviving_waiter = asyncio.create_task(_get_query_snapshot(("shielded",), loader))
        await asyncio.sleep(0)
        cancelled_waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled_waiter

        release.set()
        snapshot, status = await surviving_waiter
        self.assertEqual(loader_calls, 1)
        self.assertEqual(snapshot["total"], 1)
        self.assertEqual(status, "shared")

    async def test_query_endpoint_paginates_without_recomputing_snapshot_stats(self):
        snapshot = _build_query_snapshot([point(index) for index in range(45)])
        with (
            patch("app.routers.time_series.get_runtime_config", AsyncMock(return_value=runtime_config())),
            patch("app.routers.time_series._get_query_snapshot", AsyncMock(return_value=(snapshot, "hit"))),
            patch("app.routers.time_series._influx_service", return_value=MagicMock()),
        ):
            payload = await time_series_query(
                entity_id="",
                category="",
                keyword="",
                hours=24,
                window="5m",
                field="value_numeric",
                page=2,
                size=20,
                refresh=False,
                _user={},
                db=AsyncMock(),
            )

        self.assertEqual(payload["total"], 45)
        self.assertEqual(payload["count"], 20)
        self.assertEqual(payload["points"][0]["value"], 24)
        self.assertEqual(payload["points"][-1]["value"], 5)
        self.assertEqual(payload["chart_points"][0]["value"], 0)
        self.assertEqual(payload["chart_points"][-1]["value"], 44)
        self.assertEqual(payload["page_count"], 3)
        self.assertEqual(payload["stats"]["maximum"], 44)
        self.assertEqual(payload["meta"]["cache"], "hit")
        self.assertEqual(payload["meta"]["chart_entity_count"], 1)
        self.assertEqual(payload["meta"]["chart_entity_total"], 1)
        self.assertFalse(payload["meta"]["chart_entities_truncated"])

    async def test_query_endpoint_clamps_oversized_page_to_last_page(self):
        snapshot = _build_query_snapshot([point(index) for index in range(45)])
        with (
            patch("app.routers.time_series.get_runtime_config", AsyncMock(return_value=runtime_config())),
            patch("app.routers.time_series._get_query_snapshot", AsyncMock(return_value=(snapshot, "hit"))),
            patch("app.routers.time_series._influx_service", return_value=MagicMock()),
        ):
            payload = await time_series_query(
                entity_id="",
                category="",
                keyword="",
                hours=24,
                window="5m",
                field="value_numeric",
                page=9,
                size=20,
                refresh=False,
                _user={},
                db=AsyncMock(),
            )

        self.assertEqual(payload["page"], 3)
        self.assertEqual(payload["count"], 5)
        self.assertEqual([item["value"] for item in payload["points"]], [4, 3, 2, 1, 0])

    def test_invalid_field_window_combinations_are_rejected(self):
        with self.assertRaises(HTTPException) as invalid_window:
            _validate_query_options("2m", "value_numeric")
        with self.assertRaises(HTTPException) as invalid_field:
            _validate_query_options("raw", "fake_field")
        with self.assertRaises(HTTPException) as invalid_aggregate:
            _validate_query_options("5m", "state_raw")

        self.assertEqual(invalid_window.exception.status_code, 422)
        self.assertEqual(invalid_field.exception.status_code, 422)
        self.assertEqual(invalid_aggregate.exception.status_code, 422)

    async def test_overview_reports_real_offline_diagnostic(self):
        influx = MagicMock(ready_for_data=True)
        influx.check_health_detail = AsyncMock(return_value=(False, "Server disconnected"))
        with (
            patch("app.routers.time_series.get_runtime_config", AsyncMock(return_value=runtime_config())),
            patch("app.routers.time_series._influx_service", return_value=influx),
            patch("app.routers.time_series._managed_entities", AsyncMock(return_value=[])),
        ):
            payload = await time_series_overview(_user={}, db=AsyncMock())

        self.assertEqual(payload["status"], "stopped")
        self.assertEqual(payload["diagnostic"], "Server disconnected")
        self.assertFalse(payload["health_status"] == "running")

    async def test_overview_hides_runtime_location_from_normal_user(self):
        influx = MagicMock(ready_for_data=True)
        influx.check_health_detail = AsyncMock(return_value=(True, ""))
        influx.latest_point = AsyncMock(return_value={"time": "2026-08-04T01:20:00+00:00"})
        with (
            patch("app.routers.time_series.get_runtime_config", AsyncMock(return_value=runtime_config())),
            patch("app.routers.time_series._influx_service", return_value=influx),
            patch("app.routers.time_series._managed_entities", AsyncMock(return_value=[])),
        ):
            normal_payload = await time_series_overview(_user={"role": "user"}, db=AsyncMock())
            admin_payload = await time_series_overview(_user={"role": "admin"}, db=AsyncMock())

        self.assertEqual(normal_payload["url"], "")
        self.assertEqual(normal_payload["org"], "")
        self.assertEqual(normal_payload["bucket"], "")
        self.assertEqual(normal_payload["measurement"], "")
        self.assertEqual(admin_payload["url"], "http://localhost:8086")
        self.assertEqual(admin_payload["bucket"], "smart-home-data")

    async def test_entity_facets_remain_global_when_rows_are_filtered(self):
        entities = [
            {**point(1), "category": "sensor", "role": "temperature", "device_location": "卧室", "state": "20", "online": True, "last_changed": None},
            {**point(2, entity_id="light.ceiling"), "category": "light", "role": "power", "device_location": "客厅", "state": "off", "online": True, "last_changed": None},
        ]
        services = SimpleNamespace(homeassistant=SimpleNamespace(get_states=AsyncMock(return_value=[])))
        with (
            patch("app.routers.time_series.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.time_series._managed_entities", AsyncMock(return_value=entities)),
        ):
            payload = await time_series_entities(category="sensor", keyword="", _user={}, db=AsyncMock())

        self.assertEqual([item["category"] for item in payload["entities"]], ["sensor"])
        self.assertEqual(payload["categories"], {"sensor": 1, "light": 1})

    async def test_successful_collection_invalidates_query_cache(self):
        _QUERY_CACHE[("stale",)] = (1.0, {"rows": []})
        services = SimpleNamespace(
            config=runtime_config(),
            homeassistant=SimpleNamespace(get_states=AsyncMock(return_value=[])),
        )
        influx = SimpleNamespace(write_ha_states=AsyncMock(return_value=0))
        with (
            patch("app.routers.time_series.get_runtime_services", AsyncMock(return_value=services)),
            patch("app.routers.time_series._managed_entities", AsyncMock(return_value=[])),
            patch("app.routers.time_series._influx_service", return_value=influx),
        ):
            result = await collect_once(AsyncMock(), source="manual")

        self.assertEqual(result["status"], "success")
        self.assertEqual(_QUERY_CACHE, {})

    async def test_manual_sync_failure_is_audited_and_re_raised(self):
        db = AsyncMock()
        db.add = MagicMock()
        with patch("app.routers.time_series.collect_once", AsyncMock(side_effect=HTTPException(status_code=502, detail="InfluxDB 离线"))):
            with self.assertRaises(HTTPException):
                await time_series_sync(
                    user={"user_id": 8, "username": "admin"},
                    db=db,
                )

        db.add.assert_called_once()
        log = db.add.call_args.args[0]
        self.assertEqual(log.level, "error")
        self.assertEqual(log.title, "时序数据手动同步失败")
        self.assertIn("InfluxDB 离线", log.detail)
        db.commit.assert_awaited_once()

    async def test_collector_pruning_is_silent_and_retains_recent_failures(self):
        db = AsyncMock()
        db.add = MagicMock()
        db.execute.side_effect = [DeleteResult(7), RowsResult([901, 902, 903]), DeleteResult(3)]
        deleted = await _prune_collector_logs(db)

        self.assertEqual(COLLECT_FAILURE_LOG_RETENTION, 48)
        self.assertEqual(deleted, 10)
        self.assertEqual(db.execute.await_count, 3)
        db.add.assert_not_called()
        db.commit.assert_awaited_once()

    async def test_admin_cleanup_returns_retention_policy(self):
        with patch("app.routers.time_series._prune_collector_logs", AsyncMock(return_value=6)):
            db = AsyncMock()
            db.add = MagicMock()
            payload = await cleanup_time_series_collector_history(
                user={"user_id": 1, "username": "admin"},
                db=db,
            )

        self.assertEqual(payload["deleted"], 6)
        self.assertEqual(payload["retained_failures"], 48)
        self.assertEqual(db.add.call_args.args[0].title, "管理员执行时序采集日志清理")

    async def test_history_returns_filtered_server_page(self):
        row = SimpleNamespace(
            id=41,
            level="warning",
            title="时序数据自动采集失败",
            detail="Server disconnected",
            username="system",
            created_at=datetime(2026, 7, 30, 5, 4, 37),
        )
        db = AsyncMock()
        db.execute.side_effect = [ScalarResult(21), HistoryRowsResult([row])]

        payload = await time_series_history(
            scope="collector",
            level="warning",
            keyword="disconnected",
            page=2,
            size=20,
            user={"user_id": 8, "role": "user"},
            db=db,
        )

        self.assertEqual(payload["total"], 21)
        self.assertEqual(payload["page"], 2)
        self.assertEqual(payload["page_count"], 2)
        self.assertEqual(payload["items"][0]["scope"], "collector")
        self.assertEqual(payload["items"][0]["detail"], "Server disconnected")
        self.assertEqual(payload["visibility_scope"], "self")
        count_query = str(db.execute.await_args_list[0].args[0].compile(
            compile_kwargs={"literal_binds": True},
        ))
        self.assertIn("operation_logs.user_id", count_query)
        self.assertIn("时序数据自动采集", count_query)

    async def test_history_clamps_oversized_page_to_last_page(self):
        row = SimpleNamespace(
            id=42,
            level="success",
            title="时序数据手动同步完成",
            detail="written=3",
            username="admin",
            created_at=datetime(2026, 7, 30, 5, 4, 37),
        )
        db = AsyncMock()
        db.execute.side_effect = [ScalarResult(21), HistoryRowsResult([row])]

        payload = await time_series_history(
            scope="all",
            level="",
            keyword="",
            page=9,
            size=20,
            user={"user_id": 1, "role": "admin"},
            db=db,
        )

        self.assertEqual(payload["page"], 2)
        self.assertEqual(payload["items"][0]["id"], 42)
        data_query = str(db.execute.await_args_list[1].args[0].compile(
            compile_kwargs={"literal_binds": True},
        ))
        self.assertIn("OFFSET 20", data_query)

    async def test_csv_and_json_exports_are_real_download_responses(self):
        rows = [point(1, value="=2+2")]
        influx = SimpleNamespace(query_points=AsyncMock(return_value=rows))
        with (
            patch("app.routers.time_series.get_runtime_config", AsyncMock(return_value=runtime_config())),
            patch("app.routers.time_series._influx_service", return_value=influx),
        ):
            csv_response = await time_series_export(
                entity_id="", category="", keyword="", hours=24, window="raw",
                field="value_numeric", format="csv", _user={}, db=AsyncMock(),
            )
            json_response = await time_series_export(
                entity_id="", category="", keyword="", hours=24, window="raw",
                field="value_numeric", format="json", _user={}, db=AsyncMock(),
            )

        self.assertTrue(csv_response.body.startswith("\ufeff".encode("utf-8")))
        self.assertIn(b"'=2+2", csv_response.body)
        self.assertIn("attachment", csv_response.headers["content-disposition"])
        self.assertEqual(csv_response.headers["x-export-count"], "1")
        self.assertEqual(json.loads(json_response.body)[0]["device_name"], "温度传感器")

    async def test_export_marks_results_over_limit_as_truncated(self):
        rows = [point(index) for index in range(10001)]
        influx = SimpleNamespace(query_points=AsyncMock(return_value=rows))
        with (
            patch("app.routers.time_series.get_runtime_config", AsyncMock(return_value=runtime_config())),
            patch("app.routers.time_series._influx_service", return_value=influx),
        ):
            response = await time_series_export(
                entity_id="", category="", keyword="", hours=24, window="raw",
                field="value_numeric", format="json", _user={}, db=AsyncMock(),
            )

        self.assertEqual(response.headers["x-export-count"], "10000")
        self.assertEqual(response.headers["x-export-truncated"], "true")
        self.assertEqual(len(json.loads(response.body)), 10000)
        self.assertEqual(influx.query_points.await_args.kwargs["limit"], 10001)

    def test_csv_formula_neutralization_covers_all_spreadsheet_prefixes(self):
        for value in ("=cmd", "+cmd", "-cmd", "@cmd"):
            self.assertEqual(InfluxDBService.csv_cell(value), f"'{value}")

    def test_frontend_query_cache_is_scoped_to_current_account(self):
        frontend_source = (
            Path(__file__).resolve().parents[2]
            / "smart-home-ai-frontend"
            / "lib"
            / "api"
            / "time-series.ts"
        ).read_text(encoding="utf-8")

        self.assertIn("import { getAuthCacheScope } from '@/lib/auth-storage'", frontend_source)
        self.assertIn("return `${getAuthCacheScope()}:${JSON.stringify({", frontend_source)

    def test_frontend_keeps_raw_entity_ids_out_of_primary_time_series_labels(self):
        frontend_source = (
            Path(__file__).resolve().parents[2]
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "time-series"
            / "page.tsx"
        ).read_text(encoding="utf-8")

        self.assertIn("function timeSeriesDeviceName", frontend_source)
        self.assertIn("const looksLikeEntityId", frontend_source)
        self.assertIn("name: timeSeriesDeviceName(sortedRows[0]?.device_name, category, role)", frontend_source)
        self.assertIn("label: [timeSeriesDeviceName(entity.device_name, entity.category, entity.role), entity.device_location]", frontend_source)
        self.assertNotIn("name: sortedRows[0]?.device_name || entityId", frontend_source)


if __name__ == "__main__":
    unittest.main()
