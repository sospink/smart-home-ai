"""
InfluxDB v2 时序数据服务封装。

服务实例使用运行时配置初始化，避免系统设置已更新但仍读取静态 settings。
"""
from __future__ import annotations

import asyncio
import csv
import io
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from influxdb_client import Point, WritePrecision
from influxdb_client.client.influxdb_client_async import InfluxDBClientAsync


MEASUREMENT_HA_STATE = "home_assistant_state"


@dataclass
class InfluxRuntimeConfig:
    url: str
    token: str
    org: str
    bucket: str


def parse_numeric_state(value: Any) -> float | None:
    """把 HA 状态转换为可聚合数值；不可数值化时返回 None。"""
    if value is None:
        return None
    normalized = str(value).strip().lower()
    bool_map = {
        "on": 1.0,
        "open": 1.0,
        "locked": 1.0,
        "home": 1.0,
        "true": 1.0,
        "off": 0.0,
        "closed": 0.0,
        "unlocked": 0.0,
        "not_home": 0.0,
        "false": 0.0,
    }
    if normalized in bool_map:
        return bool_map[normalized]
    try:
        return float(normalized)
    except (TypeError, ValueError):
        return None


def _escape_flux_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def normalize_window(value: str) -> str:
    allowed = {"raw", "1m", "5m", "15m", "30m", "1h", "6h", "1d"}
    return value if value in allowed else "5m"


class InfluxDBService:
    def __init__(self, config: InfluxRuntimeConfig):
        self.config = config

    @property
    def configured(self) -> bool:
        return bool(self.config.url and self.config.org and self.config.bucket)

    @property
    def ready_for_data(self) -> bool:
        return bool(self.configured and self.config.token)

    def validate_query_config(self) -> None:
        missing = []
        if not self.config.url:
            missing.append("URL")
        if not self.config.org:
            missing.append("Org")
        if not self.config.bucket:
            missing.append("Bucket")
        if missing:
            raise RuntimeError(f"InfluxDB 缺少 {', '.join(missing)} 配置")
        if not self.config.token:
            raise RuntimeError("InfluxDB 缺少 Token，请在系统设置中填写 InfluxDB Token 后重试")

    def _client(self) -> InfluxDBClientAsync:
        return InfluxDBClientAsync(
            url=self.config.url,
            token=self.config.token,
            org=self.config.org,
            timeout=5000,
        )

    async def check_health(self) -> bool:
        healthy, _error = await self.check_health_detail()
        return healthy

    async def check_health_detail(self) -> tuple[bool, str]:
        """返回连接状态和可展示诊断，避免概览只能给出布尔值。"""
        if not self.configured:
            return False, "InfluxDB URL、Org 或 Bucket 配置不完整"
        try:
            async with self._client() as client:
                healthy = await asyncio.wait_for(client.ping(), timeout=3.0)
                return (True, "") if healthy else (False, "InfluxDB 健康检查未通过")
        except Exception as exc:
            return False, str(exc).strip() or exc.__class__.__name__

    async def write_ha_states(self, rows: list[dict[str, Any]], source: str = "collector") -> int:
        """写入 Home Assistant 当前状态点。"""
        self.validate_query_config()

        points = []
        now = datetime.now(timezone.utc)
        for row in rows:
            state_raw = str(row.get("state", ""))
            numeric = parse_numeric_state(state_raw)
            point = (
                Point(MEASUREMENT_HA_STATE)
                .tag("entity_id", row.get("entity_id", ""))
                .tag("domain", row.get("domain", ""))
                .tag("device_id", row.get("device_id", ""))
                .tag("device_name", row.get("device_name", ""))
                .tag("role", row.get("role", ""))
                .tag("category", row.get("category", ""))
                .tag("source", source)
                .tag("state_raw", state_raw)
                .tag("unit", str(row.get("unit", "")))
                .field("state_raw", state_raw)
                .field("unit", str(row.get("unit", "")))
                .time(now, WritePrecision.NS)
            )
            if numeric is not None:
                point = point.field("value_numeric", numeric)
            points.append(point)

        if not points:
            return 0

        async with self._client() as client:
            write_api = client.write_api()
            await asyncio.wait_for(
                write_api.write(
                    bucket=self.config.bucket,
                    org=self.config.org,
                    record=points,
                ),
                timeout=8.0,
            )
        return len(points)

    async def query_points(
        self,
        *,
        hours: int = 24,
        entity_id: str = "",
        category: str = "",
        keyword: str = "",
        field: str = "value_numeric",
        window: str = "5m",
        limit: int = 2000,
    ) -> list[dict[str, Any]]:
        """查询时序点，默认读取可画图的数值字段。"""
        self.validate_query_config()

        hours = max(1, min(int(hours or 24), 24 * 30))
        # 导出接口会多取一条用于判断 10,000 条上限是否被截断。
        limit = max(1, min(int(limit or 2000), 10001))
        field = field if field in {"value_numeric", "state_raw", "unit"} else "value_numeric"
        window = normalize_window(window)

        filters = [
            f'|> filter(fn: (r) => r["_measurement"] == "{MEASUREMENT_HA_STATE}")',
            f'|> filter(fn: (r) => r["_field"] == "{_escape_flux_string(field)}")',
        ]
        if entity_id:
            filters.append(f'|> filter(fn: (r) => r["entity_id"] == "{_escape_flux_string(entity_id)}")')
        if category:
            filters.append(f'|> filter(fn: (r) => r["category"] == "{_escape_flux_string(category)}")')
        if keyword:
            safe = _escape_flux_string(keyword.lower())
            filters.append(
                '|> filter(fn: (r) => '
                f'strings.containsStr(v: strings.toLower(v: r["entity_id"]), substr: "{safe}") or '
                f'strings.containsStr(v: strings.toLower(v: r["device_name"]), substr: "{safe}")'
                ")"
            )

        aggregate = ""
        if field == "value_numeric" and window != "raw":
            aggregate = f"|> aggregateWindow(every: {window}, fn: mean, createEmpty: false)"

        import_strings = 'import "strings"\n' if keyword else ""
        query = f"""
        {import_strings}
        from(bucket: "{_escape_flux_string(self.config.bucket)}")
          |> range(start: -{hours}h)
          {' '.join(filters)}
          {aggregate}
          |> group()
          |> sort(columns: ["_time"], desc: false)
          |> limit(n: {limit})
        """

        async with self._client() as client:
            tables = await asyncio.wait_for(client.query_api().query(query), timeout=6.0)

        rows: list[dict[str, Any]] = []
        for table in tables:
            for record in table.records:
                values = record.values
                rows.append({
                    "time": record.get_time().isoformat() if record.get_time() else "",
                    "entity_id": values.get("entity_id", ""),
                    "domain": values.get("domain", ""),
                    "device_id": values.get("device_id", ""),
                    "device_name": values.get("device_name", ""),
                    "role": values.get("role", ""),
                    "category": values.get("category", ""),
                    "source": values.get("source", ""),
                    "field": record.get_field(),
                    "value": record.get_value(),
                    "state_raw": values.get("state_raw", ""),
                    "unit": values.get("unit", ""),
                })
        # group 后 Flux 已按整个筛选结果执行 limit；本地排序保留确定性的同时间实体顺序。
        rows.sort(key=lambda item: (str(item.get("time") or ""), str(item.get("entity_id") or "")))
        return rows[:limit]

    async def latest_point(self) -> dict[str, Any] | None:
        if not self.configured:
            return None
        query = f"""
        from(bucket: "{_escape_flux_string(self.config.bucket)}")
          |> range(start: -720h)
          |> filter(fn: (r) => r["_measurement"] == "{MEASUREMENT_HA_STATE}")
          |> filter(fn: (r) => r["_field"] == "value_numeric")
          |> group()
          |> sort(columns: ["_time"], desc: true)
          |> limit(n: 1)
        """
        async with self._client() as client:
            tables = await asyncio.wait_for(client.query_api().query(query), timeout=6.0)
        for table in tables:
            for record in table.records:
                return {
                    "time": record.get_time().isoformat() if record.get_time() else "",
                    "entity_id": record.values.get("entity_id", ""),
                    "value": record.get_value(),
                }
        return None

    @staticmethod
    def rows_to_csv(rows: list[dict[str, Any]]) -> str:
        output = io.StringIO()
        writer = csv.DictWriter(
            output,
            fieldnames=[
                "time",
                "entity_id",
                "device_name",
                "role",
                "category",
                "field",
                "value",
                "unit",
                "source",
            ],
            extrasaction="ignore",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({
                key: InfluxDBService.csv_cell(value)
                for key, value in row.items()
            })
        return "\ufeff" + output.getvalue()

    @staticmethod
    def csv_cell(value: Any) -> Any:
        """阻止导出文本被表格软件解释为公式。"""
        if not isinstance(value, str):
            return value
        return f"'{value}" if value.startswith(("=", "+", "-", "@")) else value
