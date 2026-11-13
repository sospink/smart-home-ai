"""
接口文档来源元数据模型
"""
from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ApiDocSourceMeta(Base):
    __tablename__ = "api_doc_source_meta"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True, index=True)
    target_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    target_ref: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False, default="manual")
    source_ref: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    import_strategy: Mapped[str] = mapped_column(String(64), nullable=False, default="merge")
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    imported_at: Mapped[DateTime] = mapped_column(DateTime, server_default=func.now())

