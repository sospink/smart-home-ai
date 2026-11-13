"""
Ollama 模型拉取任务。
"""
from sqlalchemy import Column, DateTime, Float, Integer, String, Text, func

from app.database import Base


class ModelPullTask(Base):
    __tablename__ = "model_pull_tasks"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    model_name = Column(String(256), nullable=False, index=True)
    status = Column(String(32), nullable=False, default="pending", index=True)
    attempt = Column(Integer, nullable=False, default=0)
    max_attempts = Column(Integer, nullable=False, default=3)
    total_bytes = Column(Integer, nullable=False, default=0)
    completed_bytes = Column(Integer, nullable=False, default=0)
    progress_percent = Column(Float, nullable=False, default=0)
    last_status = Column(String(512), nullable=False, default="")
    error_type = Column(String(64), nullable=False, default="")
    error_message = Column(Text, nullable=False, default="")
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    created_by = Column(Integer, nullable=True, index=True)
    username = Column(String(64), nullable=False, default="")
    created_at = Column(DateTime, server_default=func.now(), index=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), index=True)
