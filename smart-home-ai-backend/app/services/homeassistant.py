"""
Home Assistant REST API 服务封装 - 设备控制与状态查询
"""
import json
from urllib.parse import urlparse, urlunparse

import httpx
from websockets.asyncio.client import connect
from typing import Optional
from app.config import settings


class HomeAssistantService:
    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None):
        self.base_url = (base_url or settings.HA_BASE_URL).rstrip("/")
        self.token = (token if token is not None else settings.HA_TOKEN).strip()

    @property
    def headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def get_states(self) -> list:
        """获取所有设备状态"""
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            r = await client.get(
                f"{self.base_url}/api/states", headers=self.headers
            )
            r.raise_for_status()
            return r.json()

    async def get_registries(self) -> dict[str, list]:
        """通过 HA WebSocket API 读取实体、设备和区域注册表。"""
        if not self.token:
            raise RuntimeError("Home Assistant Token 未配置，无法读取 Registry")

        parsed = urlparse(self.base_url)
        websocket_url = urlunparse((
            "wss" if parsed.scheme == "https" else "ws",
            parsed.netloc,
            "/api/websocket",
            "",
            "",
            "",
        ))
        commands = (
            (1, "entities", "config/entity_registry/list"),
            (2, "devices", "config/device_registry/list"),
            (3, "areas", "config/area_registry/list"),
        )

        async with connect(
            websocket_url,
            open_timeout=10,
            close_timeout=5,
            proxy=None,
        ) as websocket:
            greeting = json.loads(await websocket.recv())
            if greeting.get("type") != "auth_required":
                raise RuntimeError("Home Assistant WebSocket 握手响应异常")

            await websocket.send(json.dumps({"type": "auth", "access_token": self.token}))
            auth_response = json.loads(await websocket.recv())
            if auth_response.get("type") != "auth_ok":
                raise RuntimeError("Home Assistant WebSocket 鉴权失败")

            for command_id, _key, command_type in commands:
                await websocket.send(json.dumps({"id": command_id, "type": command_type}))

            pending = {command_id: key for command_id, key, _command_type in commands}
            registries: dict[str, list] = {key: [] for _command_id, key, _command_type in commands}
            while pending:
                message = json.loads(await websocket.recv())
                command_id = message.get("id")
                if command_id not in pending:
                    continue
                key = pending.pop(command_id)
                if not message.get("success"):
                    error = message.get("error") or {}
                    raise RuntimeError(str(error.get("message") or f"读取 HA {key} Registry 失败"))
                result = message.get("result")
                registries[key] = result if isinstance(result, list) else []
            return registries

    async def get_state(self, entity_id: str) -> dict:
        """获取单个设备状态"""
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            r = await client.get(
                f"{self.base_url}/api/states/{entity_id}", headers=self.headers
            )
            r.raise_for_status()
            return r.json()

    async def call_service(
        self, domain: str, service: str, entity_id: str, **kwargs
    ) -> list:
        """调用 HA 服务（控制设备）"""
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            r = await client.post(
                f"{self.base_url}/api/services/{domain}/{service}",
                headers=self.headers,
                json={"entity_id": entity_id, **kwargs},
            )
            if r.is_error:
                try:
                    payload = r.json()
                    detail = payload.get("message") or payload.get("error") or payload
                except ValueError:
                    detail = r.text.strip() or r.reason_phrase
                raise RuntimeError(
                    f"Home Assistant 服务 {domain}.{service} 返回 HTTP {r.status_code}：{detail}"
                )
            return r.json()

    async def check_health(self) -> bool:
        """检查 HA 是否可用"""
        try:
            async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
                r = await client.get(
                    f"{self.base_url}/api/", headers=self.headers
                )
                return r.status_code == 200
        except Exception:
            return False

    async def get_history(
        self,
        entity_ids: list[str],
        start_time: str,
        end_time: str,
    ) -> list:
        """
        获取 HA 历史数据
        GET /api/history/period/{start_time}?filter_entity_id=...&end_time=...
        返回格式: [[{entity_id, state, last_changed}, ...], ...]
        """
        filter_str = ",".join(entity_ids)
        url = (
            f"{self.base_url}/api/history/period/{start_time}"
            f"?filter_entity_id={filter_str}"
            f"&minimal_response&no_attributes"
            f"&end_time={end_time}"
        )
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            r = await client.get(url, headers=self.headers)
            r.raise_for_status()
            return r.json()


ha_service = HomeAssistantService()
