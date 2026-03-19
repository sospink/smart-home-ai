"""
系统配置模型 - key-value 存储动态配置
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, func
from app.database import Base


class SystemConfig(Base):
    __tablename__ = "system_config"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    key = Column(String(64), unique=True, nullable=False, index=True)
    value = Column(Text, nullable=False, default="")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
