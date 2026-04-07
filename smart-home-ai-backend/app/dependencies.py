"""
公共依赖注入 - get_db / get_current_user / require_admin
"""
from typing import AsyncGenerator
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from jose import JWTError, jwt
from app.database import AsyncSessionLocal
from app.config import settings

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """获取数据库 session"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    """解析 JWT Token，返回当前用户信息"""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="认证失败，请重新登录",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        user_id: str = payload.get("sub")
        role: str = payload.get("role", "user")
        username: str = payload.get("username", "")
        if user_id is None:
            raise credentials_exception
        return {"user_id": int(user_id), "role": role, "username": username}
    except JWTError:
        raise credentials_exception


async def get_optional_user(token: str | None = Depends(
    OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)
)) -> dict | None:
    """可选认证 - 未登录返回 None"""
    if token is None:
        return None
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        user_id = payload.get("sub")
        if user_id is None:
            return None
        return {
            "user_id": int(user_id),
            "role": payload.get("role", "user"),
            "username": payload.get("username", ""),
        }
    except JWTError:
        return None


def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    """仅管理员可访问"""
    if current_user["role"] != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要管理员权限",
        )
    return current_user


async def get_agent_or_user(
    request: "Request",
    token: str | None = Depends(
        OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)
    ),
) -> dict:
    """
    双模认证：支持 Agent API Key（Dify 工作流调用）或 JWT Token（前端调用）
    优先级：X-Agent-Key 头 > Bearer Token
    """
    # 1. 检查 Agent API Key
    agent_key = request.headers.get("X-Agent-Key", "")
    if agent_key and agent_key == settings.AGENT_API_KEY:
        return {"user_id": 0, "role": "agent", "username": "dify-agent"}

    # 2. 回退到 JWT 认证
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="认证失败：需要 Bearer Token 或 X-Agent-Key",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="无效 Token")
        return {
            "user_id": int(user_id),
            "role": payload.get("role", "user"),
            "username": payload.get("username", ""),
        }
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 已过期或无效")

