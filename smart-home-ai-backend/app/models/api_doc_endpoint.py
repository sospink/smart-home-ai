"""
接口文档端点模型
"""
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ApiDocEndpoint(Base):
    __tablename__ = "api_doc_endpoints"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True, index=True)
    module_id: Mapped[int] = mapped_column(ForeignKey("api_doc_modules.id", ondelete="CASCADE"), nullable=False, index=True)
    slug: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    group_key: Mapped[str] = mapped_column(String(64), nullable=False, default="overview")
    method: Mapped[str] = mapped_column(String(16), nullable=False, default="GET")
    path: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    summary: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_type: Mapped[str] = mapped_column(String(32), nullable=False, default="seed")
    source_identifier: Mapped[str] = mapped_column(String(255), nullable=False, default="", index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    tags: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    params: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    responses: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    notes: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    code_samples: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    request_preview: Mapped[str] = mapped_column(Text, nullable=False, default="")
    response_body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    response_meta: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[DateTime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[DateTime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    module = relationship("ApiDocModule", back_populates="endpoints")

