"""
通用 Schema
"""
from pydantic import BaseModel
from typing import Generic, TypeVar, Optional, List

T = TypeVar("T")


class ActionResult(BaseModel):
    success: bool
    message: str = ""


class PaginatedResponse(BaseModel, Generic[T]):
    items: List[T]
    total: int
    page: int
    size: int


class ErrorResponse(BaseModel):
    detail: str
