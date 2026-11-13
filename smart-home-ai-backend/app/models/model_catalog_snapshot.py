"""
Ollama 官方模型库缓存快照。
"""
from sqlalchemy import Column, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.mysql import LONGTEXT

from app.database import Base


class ModelCatalogSnapshot(Base):
    __tablename__ = "model_catalog_snapshots"
    __table_args__ = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    source_url = Column(String(512), nullable=False, default="https://ollama.com/library")
    synced_at = Column(DateTime, server_default=func.now(), index=True)
    status = Column(String(32), nullable=False, default="success", index=True)
    error = Column(Text, nullable=True, default="")
    payload_json = Column(LONGTEXT().with_variant(Text, "sqlite"), nullable=False, default="{}")
