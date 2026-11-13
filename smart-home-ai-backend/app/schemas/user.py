"""
用户管理 Schema - 请求 / 响应模型
"""
from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from typing import Optional, Literal


# ── 请求 ──

class CreateUserRequest(BaseModel):
    username: str = Field(..., min_length=2, max_length=64, description="用户名")
    password: str = Field(..., min_length=1, max_length=128, description="密码")
    nickname: str = Field("", max_length=64, description="昵称")
    role: Literal["user", "admin"] = Field("user", description="角色")

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        normalized = str(value or "").strip()
        if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in normalized):
            raise ValueError("用户名不能包含空格或控制字符")
        return normalized

    @field_validator("nickname", mode="before")
    @classmethod
    def normalize_nickname(cls, value: str) -> str:
        return str(value or "").strip()


class UpdateUserRequest(BaseModel):
    nickname: Optional[str] = Field(None, max_length=64, description="昵称")
    role: Optional[Literal["user", "admin"]] = Field(None, description="角色")
    is_active: Optional[bool] = Field(None, description="是否启用")

    @field_validator("nickname", mode="before")
    @classmethod
    def normalize_nickname(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() if isinstance(value, str) else value


class ResetPasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=1, max_length=128, description="新密码")


class ChangePasswordRequest(BaseModel):
    old_password: str = Field(..., min_length=4, max_length=128, description="旧密码")
    new_password: str = Field(..., min_length=1, max_length=128, description="新密码")


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


class UserStatsResponse(BaseModel):
    total: int
    active: int
    inactive: int
    new_this_week: int
    admin_count: int
    active_admin_count: int


class UserAuditItem(BaseModel):
    id: int
    action: str
    target_user_id: Optional[int] = None
    target_username: str = ""
    changed_fields: list[str] = Field(default_factory=list)
    level: str = "info"
    operator: str = ""
    created_at: Optional[datetime] = None


class UserAuditPage(BaseModel):
    items: list[UserAuditItem]
    total: int
    page: int
    size: int
