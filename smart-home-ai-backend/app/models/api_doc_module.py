"""
接口文档模块模型
"""
from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ApiDocModule(Base):
    __tablename__ = "api_doc_modules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True, index=True)
    slug: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    subtitle: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    markdown_content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="static")
    source_type: Mapped[str] = mapped_column(String(32), nullable=False, default="seed")
    renderer_type: Mapped[str] = mapped_column(String(64), nullable=False, default="api-reference")
    endpoint_base: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    capability_tags: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    highlights: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    groups: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    playground: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[DateTime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    endpoints = relationship(
        "ApiDocEndpoint",
        back_populates="module",
        cascade="all, delete-orphan",
        order_by="ApiDocEndpoint.sort_order",
    )

