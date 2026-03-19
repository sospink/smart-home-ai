"""
InfluxDB 时序数据服务封装 - 传感器历史数据查询
"""
from influxdb_client.client.influxdb_client_async import InfluxDBClientAsync
from app.config import settings


class InfluxDBService:
    async def query_sensor_data(
        self, entity_id: str, hours: int = 24
    ) -> list[dict]:
        """查询传感器历史数据"""
        async with InfluxDBClientAsync(
            url=settings.INFLUXDB_URL,
            token=settings.INFLUXDB_TOKEN,
            org=settings.INFLUXDB_ORG,
        ) as client:
            query = f"""
            from(bucket: "{settings.INFLUXDB_BUCKET}")
              |> range(start: -{hours}h)
              |> filter(fn: (r) => r["entity_id"] == "{entity_id}")
              |> aggregateWindow(every: 5m, fn: mean)
            """
            tables = await client.query_api().query(query)
            return [
                {
                    "time": record.get_time().isoformat(),
                    "value": record.get_value(),
                }
                for table in tables
                for record in table.records
            ]

    async def check_health(self) -> bool:
        """检查 InfluxDB 是否可用"""
        try:
            async with InfluxDBClientAsync(
                url=settings.INFLUXDB_URL,
                token=settings.INFLUXDB_TOKEN,
                org=settings.INFLUXDB_ORG,
            ) as client:
                return await client.ping()
        except Exception:
            return False


influxdb_service = InfluxDBService()
