"""
系统设置相关 Schema
"""
from datetime import datetime
from pydantic import BaseModel, Field, field_validator
from typing import Optional
from enum import Enum
from urllib.parse import urlsplit


class ServiceName(str, Enum):
    ollama = "ollama"
    dify = "dify"
    homeassistant = "homeassistant"
    influxdb = "influxdb"


# ── 配置读取响应 ──
class ServiceConfig(BaseModel):
    """单个外部服务的配置"""
    url: str
    configured: bool = False  # 地址是否已配置；普通用户可据此判断状态，但不暴露实际地址
    token: str = ""  # 脱敏后的 token（仅末4位）
    token_configured: bool = False
    status: str = "unknown"  # running / stopped / unknown
    extra: dict = Field(default_factory=dict)  # 额外字段 (如 InfluxDB 的 org/bucket)


class SecurityConfig(BaseModel):
    """安全设置"""
    jwt_expire_hours: int = 24
    allow_registration: bool = True
    password_min_length: int = 6


class SettingsResponse(BaseModel):
    """GET /settings 完整响应"""
    services: dict[str, ServiceConfig]  # ollama / dify / homeassistant / influxdb
    security: SecurityConfig
    config_source: str = "default_config"
    override_keys: list[str] = Field(default_factory=list)
    last_updated_at: Optional[datetime] = None
    can_manage: bool = False


# ── 配置更新请求 ──
class SettingsUpdate(BaseModel):
    """PUT /settings 请求体（所有字段可选，空 = 不更新）"""
    ollama_base_url: Optional[str] = Field(default=None, max_length=512)
    dify_base_url: Optional[str] = Field(default=None, max_length=512)
    dify_api_key: Optional[str] = Field(default=None, max_length=4096)
    dify_dataset_api_key: Optional[str] = Field(default=None, max_length=4096)
    ha_base_url: Optional[str] = Field(default=None, max_length=512)
    ha_token: Optional[str] = Field(default=None, max_length=4096)
    influxdb_url: Optional[str] = Field(default=None, max_length=512)
    influxdb_token: Optional[str] = Field(default=None, max_length=4096)
    influxdb_org: Optional[str] = Field(default=None, max_length=256)
    influxdb_bucket: Optional[str] = Field(default=None, max_length=256)
    jwt_expire_hours: Optional[int] = Field(default=None, ge=1, le=720)
    allow_registration: Optional[bool] = None
    password_min_length: Optional[int] = Field(default=None, ge=4, le=128)
    reset_keys: list[str] = Field(default_factory=list, max_length=13)

    @field_validator("ollama_base_url", "dify_base_url", "ha_base_url", "influxdb_url")
    @classmethod
    def validate_service_url(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        normalized = value.strip().rstrip("/")
        parsed = urlsplit(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("服务地址必须是有效的 http:// 或 https:// URL")
        if parsed.username or parsed.password:
            raise ValueError("服务地址不能包含用户名或密码")
        if parsed.fragment:
            raise ValueError("服务地址不能包含 URL 片段")
        return normalized

    @field_validator("dify_api_key", "dify_dataset_api_key", "ha_token", "influxdb_token")
    @classmethod
    def reject_masked_secret(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and "•" in value:
            raise ValueError("脱敏凭证不能作为新值保存")
        return value.strip() if value is not None else value


# ── 连接测试 ──
class TestConnectionRequest(BaseModel):
    service: ServiceName
    ollama_base_url: Optional[str] = None
    dify_base_url: Optional[str] = None
    dify_api_key: Optional[str] = None
    dify_dataset_api_key: Optional[str] = None
    ha_base_url: Optional[str] = None
    ha_token: Optional[str] = None
    influxdb_url: Optional[str] = None
    influxdb_token: Optional[str] = None
    influxdb_org: Optional[str] = Field(default=None, max_length=256)
    influxdb_bucket: Optional[str] = Field(default=None, max_length=256)

    @field_validator("ollama_base_url", "dify_base_url", "ha_base_url", "influxdb_url")
    @classmethod
    def validate_service_url(cls, value: Optional[str]) -> Optional[str]:
        return SettingsUpdate.validate_service_url(value)

    @field_validator("dify_api_key", "dify_dataset_api_key", "ha_token", "influxdb_token")
    @classmethod
    def reject_masked_secret(cls, value: Optional[str]) -> Optional[str]:
        return SettingsUpdate.reject_masked_secret(value)


class TestConnectionResponse(BaseModel):
    service: str
    status: str  # running / stopped / error
    message: str
    latency_ms: int


class SettingsStatusResponse(BaseModel):
    services: dict[str, TestConnectionResponse]
    tested_at: datetime
    cached: bool = False


class SettingsHistoryItem(BaseModel):
    id: int
    action: str
    level: str
    title: str
    changed_keys: list[str] = Field(default_factory=list)
    service: str = ""
    status: str = ""
    latency_ms: int = 0
    message: str = ""
    username: str = ""
    created_at: Optional[datetime] = None


class SettingsHistoryPage(BaseModel):
    items: list[SettingsHistoryItem]
    total: int
    page: int
    size: int


class SettingsActionResponse(BaseModel):
    success: bool = True
    message: str
    updated_keys: list[str] = Field(default_factory=list)
    reset_keys: list[str] = Field(default_factory=list)


class SettingsResetRequest(BaseModel):
    keys: list[str] = Field(default_factory=list, max_length=13)


# ── 系统信息 ──
class SystemInfoResponse(BaseModel):
    version: str
    python_version: str = ""
    os_info: str = ""
    db_status: str
    uptime_seconds: int
    uptime_display: str
    api_docs_url: str
    config_source: str = "使用默认配置"
    runtime_details_visible: bool = False
