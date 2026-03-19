"""
Home Assistant REST API 服务封装 - 设备控制与状态查询
"""
import httpx
from app.config import settings


class HomeAssistantService:
    def __init__(self):
        self.base_url = settings.HA_BASE_URL

    @property
    def headers(self) -> dict:
        return {
            "Authorization": f"Bearer {settings.HA_TOKEN}",
            "Content-Type": "application/json",
        }

    async def get_states(self) -> list:
        """获取所有设备状态"""
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{self.base_url}/api/states", headers=self.headers
            )
            r.raise_for_status()
            return r.json()

    async def get_state(self, entity_id: str) -> dict:
        """获取单个设备状态"""
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{self.base_url}/api/states/{entity_id}", headers=self.headers
            )
            r.raise_for_status()
            return r.json()

    async def call_service(
        self, domain: str, service: str, entity_id: str, **kwargs
    ) -> list:
        """调用 HA 服务（控制设备）"""
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{self.base_url}/api/services/{domain}/{service}",
                headers=self.headers,
                json={"entity_id": entity_id, **kwargs},
            )
            r.raise_for_status()
            return r.json()

    async def check_health(self) -> bool:
        """检查 HA 是否可用"""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(
                    f"{self.base_url}/api/", headers=self.headers
                )
                return r.status_code == 200
        except Exception:
            return False


ha_service = HomeAssistantService()
