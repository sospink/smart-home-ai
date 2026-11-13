"""
智能体应用模板库模型

保存模板文件元数据和 DSL 内容；创建实例时复制为独立快照，不直接参与实例运行配置。
"""
from sqlalchemy import Column, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.mysql import JSON

from app.database import Base


class AgentTemplateLibrary(Base):
    __tablename__ = "agent_template_library"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=False, default="")
    tags = Column(JSON, nullable=False, default=list)
    file_name = Column(String(255), nullable=False)
    dsl_content = Column(Text, nullable=False)
    source = Column(String(32), nullable=False, default="uploaded")
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
