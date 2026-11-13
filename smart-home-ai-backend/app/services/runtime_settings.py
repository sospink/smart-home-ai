"""
运行时系统配置服务

以 system_config 表作为运行时配置真相源，config.yaml 仅作为默认兜底。
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.system_config import SystemConfig
from app.services.dify import DifyService
from app.services.dify_knowledge import DifyKnowledgeService
from app.services.homeassistant import HomeAssistantService
from app.services.ollama import OllamaService


APP_VERSION = "1.0.0"
API_DOCS_URL = "/help-docs"


def _parse_bool(value: str | bool | None, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"true", "1", "yes", "on"}


def _parse_int(value: str | int | None, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


@dataclass
class RuntimeConfig:
    ollama_base_url: str
    dify_base_url: str
    dify_api_key: str
    dify_dataset_api_key: str
    ha_base_url: str
    ha_token: str
    influxdb_url: str
    influxdb_token: str
    influxdb_org: str
    influxdb_bucket: str
    jwt_expire_hours: int
    allow_registration: bool
    password_min_length: int
    config_source: str


@dataclass
class RuntimeServices:
    config: RuntimeConfig
    ollama: OllamaService
    dify: DifyService
    dify_knowledge: DifyKnowledgeService
    homeassistant: HomeAssistantService


async def get_runtime_config_map(db: AsyncSession) -> dict[str, str]:
    result = await db.execute(select(SystemConfig.key, SystemConfig.value))
    return {
        key: value for key, value in result.all()
        if value is not None and str(value).strip() != ""
    }


async def get_runtime_config(db: AsyncSession) -> RuntimeConfig:
    overrides = await get_runtime_config_map(db)
    config_source = "database_overrides" if overrides else "default_config"

    return RuntimeConfig(
        ollama_base_url=overrides.get("ollama_base_url", settings.OLLAMA_BASE_URL),
        dify_base_url=overrides.get("dify_base_url", settings.DIFY_BASE_URL),
        dify_api_key=overrides.get("dify_api_key", settings.DIFY_API_KEY),
        dify_dataset_api_key=overrides.get("dify_dataset_api_key", settings.DIFY_DATASET_API_KEY),
        ha_base_url=overrides.get("ha_base_url", settings.HA_BASE_URL),
        ha_token=overrides.get("ha_token", settings.HA_TOKEN),
        influxdb_url=overrides.get("influxdb_url", settings.INFLUXDB_URL),
        influxdb_token=overrides.get("influxdb_token", settings.INFLUXDB_TOKEN),
        influxdb_org=overrides.get("influxdb_org", settings.INFLUXDB_ORG),
        influxdb_bucket=overrides.get("influxdb_bucket", settings.INFLUXDB_BUCKET),
        jwt_expire_hours=_parse_int(
            overrides.get("jwt_expire_hours"),
            max(1, settings.ACCESS_TOKEN_EXPIRE_MINUTES // 60),
        ),
        allow_registration=_parse_bool(overrides.get("allow_registration"), True),
        password_min_length=max(
            4,
            _parse_int(overrides.get("password_min_length"), 6),
        ),
        config_source=config_source,
    )


async def get_runtime_services(db: AsyncSession) -> RuntimeServices:
    config = await get_runtime_config(db)
    return RuntimeServices(
        config=config,
        ollama=OllamaService(base_url=config.ollama_base_url),
        dify=DifyService(base_url=config.dify_base_url, api_key=config.dify_api_key),
        dify_knowledge=DifyKnowledgeService(
            base_url=config.dify_base_url,
            api_key=config.dify_dataset_api_key,
        ),
        homeassistant=HomeAssistantService(
            base_url=config.ha_base_url,
            token=config.ha_token,
        ),
    )


async def get_config_source_label(db: AsyncSession) -> str:
    result = await db.execute(select(func.count()).select_from(SystemConfig))
    total = result.scalar() or 0
    return "数据库已覆盖" if total > 0 else "使用默认配置"
