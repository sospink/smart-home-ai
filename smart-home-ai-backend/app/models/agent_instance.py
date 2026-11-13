"""
智能体实例元数据模型

平台侧只管理轻量实例信息，不替代 Dify 的深度编辑与执行能力。
"""
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.mysql import JSON

from app.database import Base


class AgentInstance(Base):
    __tablename__ = "agent_instances"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    name = Column(String(255), nullable=False)
    slug = Column(String(255), nullable=False, unique=True, index=True)
    dify_app_id = Column(String(128), nullable=False, default="")
    dify_api_key = Column(String(255), nullable=False, default="")
    instance_type = Column(String(32), nullable=False, default="workflow")
    source_type = Column(String(32), nullable=False, default="built_in_template")
    source_template = Column(String(64), nullable=False, default="")
    dsl_file_name = Column(String(255), nullable=False, default="")
    status = Column(String(32), nullable=False, default="draft")
    enabled = Column(Boolean, nullable=False, default=True)
    is_default = Column(Boolean, nullable=False, default=False)
    description = Column(Text, nullable=False, default="")
    default_model = Column(String(128), nullable=False, default="")
    knowledge_bindings = Column(JSON, nullable=False, default=list)
    capability_tags = Column(JSON, nullable=False, default=list)
    entry_route = Column(String(255), nullable=False, default="/chat")
    dify_console_url = Column(String(512), nullable=False, default="")
    dsl_content = Column(Text, nullable=False, default="")
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
