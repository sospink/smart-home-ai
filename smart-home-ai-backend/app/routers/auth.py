"""
认证路由 - 登录 / 注册 / Token 刷新
"""
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func, select
from jose import jwt
import bcrypt
from app.config import settings
from app.dependencies import get_db, get_current_user
from app.models.user import User
from app.models.operation_log import OperationLog
from app.services.runtime_settings import get_runtime_config
from app.schemas.auth import (
    LoginRequest,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)
from app.schemas.user import ChangePasswordRequest

router = APIRouter(prefix="/auth", tags=["认证"])

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode('utf-8'), hashed.encode('utf-8'))


def create_access_token(user_id: int, role: str, username: str, expire_minutes: int) -> str:
    expire = datetime.utcnow() + timedelta(
        minutes=expire_minutes
    )
    payload = {
        "sub": str(user_id),
        "role": role,
        "username": username,
        "exp": expire,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


@router.post("/login", response_model=TokenResponse, summary="登录")
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    runtime = await get_runtime_config(db)
    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
        )

    # 检查用户是否被禁用
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已被禁用，请联系管理员",
        )

    token = create_access_token(
        user.id,
        user.role.value,
        user.username,
        expire_minutes=max(runtime.jwt_expire_hours, 1) * 60,
    )

    # 写入登录日志
    try:
        from app.models.operation_log import OperationLog
        log = OperationLog(
            type="user_login",
            level="info",
            title=f"用户 {user.username} 登录系统",
            detail=f"user_id={user.id}, role={user.role.value}",
            user_id=user.id,
            username=user.username,
        )
        db.add(log)
    except Exception:
        pass  # 日志写入不影响登录

    return TokenResponse(access_token=token)


@router.post(
    "/register",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    summary="注册",
)
async def register(body: RegisterRequest, db: AsyncSession = Depends(get_db)):
    runtime = await get_runtime_config(db)
    if not runtime.allow_registration:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前系统已关闭公开注册，请联系管理员",
        )
    if len(body.password) < runtime.password_min_length:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"密码长度不能少于 {runtime.password_min_length} 位",
        )
    # 检查用户名是否已存在
    result = await db.execute(select(User).where(User.username == body.username))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="用户名已存在",
        )

    user_count = int((await db.execute(select(func.count()).select_from(User))).scalar() or 0)
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        nickname=body.nickname or body.username,
        role="admin" if user_count == 0 else "user",
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return user


@router.get("/me", response_model=UserResponse, summary="获取当前用户")
async def get_me(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(User).where(User.id == current_user["user_id"])
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return user


@router.put("/password", summary="修改密码")
async def change_password(
    body: ChangePasswordRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """当前登录用户修改自己的密码"""
    runtime = await get_runtime_config(db)
    result = await db.execute(
        select(User).where(User.id == current_user["user_id"])
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="旧密码错误")

    if len(body.new_password) < runtime.password_min_length:
        raise HTTPException(
            status_code=400,
            detail=f"新密码长度不能少于 {runtime.password_min_length} 位",
        )

    user.password_hash = hash_password(body.new_password)
    db.add(OperationLog(
        type="user_management",
        level="success",
        title="当前用户修改登录密码",
        detail="action=change_password; result=success",
        user_id=user.id,
        username=user.username,
    ))
    await db.flush()
    return {"success": True, "message": "密码已修改"}


@router.get("/public-config", summary="获取公开认证配置")
async def get_public_auth_config(db: AsyncSession = Depends(get_db)):
    runtime = await get_runtime_config(db)
    return {
        "allow_registration": runtime.allow_registration,
        "password_min_length": runtime.password_min_length,
        "jwt_expire_hours": runtime.jwt_expire_hours,
    }
