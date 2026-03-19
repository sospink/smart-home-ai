"""
认证相关 Schema
"""
from pydantic import BaseModel, Field
from datetime import datetime


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=2, max_length=64, description="用户名")
    password: str = Field(..., min_length=4, max_length=128, description="密码")


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=2, max_length=64, description="用户名")
    password: str = Field(..., min_length=6, max_length=128, description="密码")
    nickname: str = Field("", max_length=64, description="昵称")


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
