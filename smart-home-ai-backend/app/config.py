"""
应用配置 — 优先从 config.yaml 读取，回退到 .env / 环境变量
"""
from pathlib import Path
from typing import List

import yaml
from pydantic_settings import BaseSettings


def _load_yaml_config() -> dict:
    """加载 config.yaml 并展平为 Settings 兼容的字典"""
    yaml_path = Path(__file__).resolve().parent.parent / "config.yaml"
    if not yaml_path.exists():
        return {}

    with open(yaml_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    flat: dict = {}

    # database
    db = raw.get("database", {})
    if db.get("url"):
        flat["DATABASE_URL"] = db["url"]

    # jwt
    jwt = raw.get("jwt", {})
    if jwt.get("secret_key"):
        flat["SECRET_KEY"] = jwt["secret_key"]
    if jwt.get("algorithm"):
        flat["ALGORITHM"] = jwt["algorithm"]
    if jwt.get("access_token_expire_minutes"):
        flat["ACCESS_TOKEN_EXPIRE_MINUTES"] = jwt["access_token_expire_minutes"]

    # services
    svc = raw.get("services", {})

    ollama = svc.get("ollama", {})
    if ollama.get("base_url"):
        flat["OLLAMA_BASE_URL"] = ollama["base_url"]

    ha = svc.get("homeassistant", {})
    if ha.get("base_url"):
        flat["HA_BASE_URL"] = ha["base_url"]
    if ha.get("token"):
        flat["HA_TOKEN"] = ha["token"]

    dify = svc.get("dify", {})
    if dify.get("base_url"):
        flat["DIFY_BASE_URL"] = dify["base_url"]
    if dify.get("api_key"):
        flat["DIFY_API_KEY"] = dify["api_key"]
    if dify.get("dataset_api_key"):
        flat["DIFY_DATASET_API_KEY"] = dify["dataset_api_key"]

    influx = svc.get("influxdb", {})
    if influx.get("url"):
        flat["INFLUXDB_URL"] = influx["url"]
    if influx.get("token"):
        flat["INFLUXDB_TOKEN"] = influx["token"]
    if influx.get("org"):
        flat["INFLUXDB_ORG"] = influx["org"]
    if influx.get("bucket"):
        flat["INFLUXDB_BUCKET"] = influx["bucket"]

    # agent
    agent = raw.get("agent", {})
    if agent.get("api_key"):
        flat["AGENT_API_KEY"] = agent["api_key"]

    # cors
    cors = raw.get("cors", {})
    if cors.get("origins"):
        flat["CORS_ORIGINS"] = cors["origins"]

    return flat


# 先加载 YAML，作为初始值传给 Settings
_yaml_values = _load_yaml_config()


class Settings(BaseSettings):
    # ── 数据库 ──
    DATABASE_URL: str = "mysql+aiomysql://root:123456@localhost:3306/smart_home_web"

    # ── JWT ──
    SECRET_KEY: str = "smart-home-dev-secret-key-change-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24h

    # ── 外部服务 ──
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    HA_BASE_URL: str = "http://localhost:8123"
    HA_TOKEN: str = ""
    DIFY_BASE_URL: str = "http://localhost:5001"
    DIFY_API_KEY: str = ""
    DIFY_DATASET_API_KEY: str = ""
    INFLUXDB_URL: str = "http://localhost:8086"
    INFLUXDB_TOKEN: str = ""
    INFLUXDB_ORG: str = "smart-home"
    INFLUXDB_BUCKET: str = "smart-home-data"

    # ── Agent API Key（供 Dify 工作流调用后端接口） ──
    AGENT_API_KEY: str = "sk-smart-home-agent-2026"

    # ── CORS ──
    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://localhost:3100"]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


# 优先级：环境变量 > .env > config.yaml > 代码默认值
# pydantic-settings 自动处理 环境变量 > .env > 默认值
# 我们把 yaml 值注入为默认值的覆盖
settings = Settings(**{
    k: v for k, v in _yaml_values.items()
    if k in Settings.model_fields
})
