"""
应用配置 - 使用 pydantic-settings 从 .env 读取
"""
from pydantic_settings import BaseSettings
from typing import List


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
    INFLUXDB_URL: str = "http://localhost:8086"
    INFLUXDB_TOKEN: str = ""
    INFLUXDB_ORG: str = "smart-home"
    INFLUXDB_BUCKET: str = "smart-home-data"

    # ── CORS ──
    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://localhost:3100"]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
