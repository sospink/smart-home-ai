"""
用户管理 Schema - 请求 / 响应模型
"""
from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional, Literal


# ── 请求 ──

class CreateUserRequest(BaseModel):
    username: str = Field(..., min_length=2, max_length=64, description="用户名")
    password: str = Field(..., min_length=6, max_length=128, description="密码")
    nickname: str = Field("", max_length=64, description="昵称")
    role: Literal["user", "admin"] = Field("user", description="角色")


class UpdateUserRequest(BaseModel):
    nickname: Optional[str] = Field(None, max_length=64, description="昵称")
    role: Optional[Literal["user", "admin"]] = Field(None, description="角色")
    is_active: Optional[bool] = Field(None, description="是否启用")


class ResetPasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=6, max_length=128, description="新密码")


class ChangePasswordRequest(BaseModel):
    old_password: str = Field(..., min_length=4, max_length=128, description="旧密码")
    new_password: str = Field(..., min_length=6, max_length=128, description="新密码")


# ── 响应 ──

class UserDetailResponse(BaseModel):
    id: int
    username: str
    nickname: str
    avatar: Optional[str] = ""
    role: str
    is_active: bool
    created_at: datetime
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class UserListResponse(BaseModel):
    items: list[UserDetailResponse]
    total: int
    page: int
    size: int
