"""
操作日志模型 — 记录设备控制、用户登录、系统事件等
"""
from sqlalchemy import Column, Integer, String, DateTime, Text, func
from app.database import Base


class OperationLog(Base):
    __tablename__ = "operation_logs"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    type = Column(String(32), nullable=False, index=True)     # device_control, user_login, system, ai, warning
    level = Column(String(16), nullable=False, default="info") # info, warning, error, success
    title = Column(String(256), nullable=False)
    detail = Column(Text, nullable=True, default="")
    user_id = Column(Integer, nullable=True, index=True)
    username = Column(String(64), nullable=True, default="")
    entity_id = Column(String(128), nullable=True, default="")  # 关联的 HA 实体
    created_at = Column(DateTime, server_default=func.now(), index=True)
