"""
认证相关 Schema
"""
from pydantic import BaseModel, Field, field_validator
from datetime import datetime


def _normalize_username(value: str) -> str:
    normalized = str(value or "").strip()
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise ValueError("用户名不能包含空格或控制字符")
    return normalized


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=2, max_length=64, description="用户名")
    password: str = Field(..., min_length=4, max_length=128, description="密码")

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return _normalize_username(value)


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=2, max_length=64, description="用户名")
    password: str = Field(..., min_length=1, max_length=128, description="密码")
    nickname: str = Field("", max_length=64, description="昵称")

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return _normalize_username(value)

    @field_validator("nickname", mode="before")
    @classmethod
    def normalize_nickname(cls, value: str) -> str:
        return str(value or "").strip()


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    id: int
    username: str
    nickname: str
    role: str
    created_at: datetime

    model_config = {"from_attributes": True}
