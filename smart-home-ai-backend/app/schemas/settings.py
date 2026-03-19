"""
系统设置相关 Schema
"""
from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum


class ServiceName(str, Enum):
    ollama = "ollama"
    dify = "dify"
    homeassistant = "homeassistant"
    influxdb = "influxdb"


# ── 配置读取响应 ──
class ServiceConfig(BaseModel):
    """单个外部服务的配置"""
    url: str
    token: str = ""  # 脱敏后的 token（仅末4位）
    status: str = "unknown"  # running / stopped / unknown
    extra: dict = {}  # 额外字段 (如 InfluxDB 的 org/bucket)


class SecurityConfig(BaseModel):
    """安全设置"""
    jwt_expire_hours: int = 24
    allow_registration: bool = True
    password_min_length: int = 6


class SettingsResponse(BaseModel):
    """GET /settings 完整响应"""
    services: dict[str, ServiceConfig]  # ollama / dify / homeassistant / influxdb
    security: SecurityConfig


# ── 配置更新请求 ──
class SettingsUpdate(BaseModel):
    """PUT /settings 请求体（所有字段可选，空 = 不更新）"""
    ollama_base_url: Optional[str] = None
    dify_base_url: Optional[str] = None
    dify_api_key: Optional[str] = None
    ha_base_url: Optional[str] = None
    ha_token: Optional[str] = None
    influxdb_url: Optional[str] = None
    influxdb_token: Optional[str] = None
    influxdb_org: Optional[str] = None
    influxdb_bucket: Optional[str] = None
    jwt_expire_hours: Optional[int] = None
    allow_registration: Optional[bool] = None
    password_min_length: Optional[int] = None


# ── 连接测试 ──
class TestConnectionRequest(BaseModel):
    service: ServiceName


class TestConnectionResponse(BaseModel):
    service: str
    status: str  # running / stopped / error
    message: str
    latency_ms: int


# ── 系统信息 ──
class SystemInfoResponse(BaseModel):
    version: str
    python_version: str
    os_info: str
    db_status: str
    uptime_seconds: int
    uptime_display: str
    api_docs_url: str
