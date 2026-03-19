"""
用户管理路由 - 增删改查 / 重置密码 / 启用禁用
仅管理员可访问
"""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_
from app.dependencies import get_db, require_admin
from app.models.user import User
from app.schemas.user import (
    CreateUserRequest,
    UpdateUserRequest,
    ResetPasswordRequest,
    UserDetailResponse,
    UserListResponse,
)
from app.routers.auth import hash_password

router = APIRouter(prefix="/users", tags=["用户管理"])


@router.get("/stats", summary="用户统计")
async def user_stats(
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """返回用户统计数据：总数、活跃数、本周新增、管理员数"""
    total = (await db.execute(select(func.count()).select_from(User))).scalar() or 0
    active = (await db.execute(
        select(func.count()).select_from(User).where(User.is_active == True)
    )).scalar() or 0
    admin_count = (await db.execute(
        select(func.count()).select_from(User).where(User.role == "admin")
    )).scalar() or 0

    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    new_this_week = (await db.execute(
        select(func.count()).select_from(User).where(User.created_at >= week_ago)
    )).scalar() or 0

    return {
        "total": total,
        "active": active,
        "new_this_week": new_this_week,
        "admin_count": admin_count,
    }



@router.get("", response_model=UserListResponse, summary="用户列表")
async def list_users(
    page: int = Query(1, ge=1, description="页码"),
    size: int = Query(20, ge=1, le=100, description="每页条数"),
    keyword: str = Query("", description="搜索关键词（用户名/昵称）"),
    role: str = Query("", description="角色筛选: user / admin / 空=全部"),
    is_active: str = Query("", description="状态筛选: true / false / 空=全部"),
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """分页获取用户列表，支持关键词搜索和角色/状态筛选"""
    query = select(User)

    # 关键词搜索
    if keyword:
        query = query.where(
            or_(
                User.username.contains(keyword),
                User.nickname.contains(keyword),
            )
        )
    # 角色筛选
    if role in ("user", "admin"):
        query = query.where(User.role == role)
    # 状态筛选
    if is_active in ("true", "false"):
        query = query.where(User.is_active == (is_active == "true"))

    # 计算总数
    count_query = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_query)).scalar() or 0

    # 分页查询
    query = query.order_by(User.id.desc()).offset((page - 1) * size).limit(size)
    result = await db.execute(query)
    users = result.scalars().all()

    return UserListResponse(items=users, total=total, page=page, size=size)


@router.post(
    "",
    response_model=UserDetailResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建用户",
)
async def create_user(
    body: CreateUserRequest,
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """管理员手动创建用户"""
    # 检查用户名冲突
    existing = await db.execute(
        select(User).where(User.username == body.username)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="用户名已存在")

    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        nickname=body.nickname or body.username,
        role=body.role,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return user


@router.get("/{user_id}", response_model=UserDetailResponse, summary="用户详情")
async def get_user(
    user_id: int,
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """获取单个用户详情"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return user


@router.put("/{user_id}", response_model=UserDetailResponse, summary="更新用户")
async def update_user(
    user_id: int,
    body: UpdateUserRequest,
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """更新用户信息（昵称、角色、启用状态）"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    if body.nickname is not None:
        user.nickname = body.nickname
    if body.role is not None:
        user.role = body.role
    if body.is_active is not None:
        user.is_active = body.is_active

    await db.flush()
    await db.refresh(user)
    return user


@router.delete(
    "/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除用户",
)
async def delete_user(
    user_id: int,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """删除用户（不可删除自己）"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    # 不能删除自己
    if user.id == admin["user_id"]:
        raise HTTPException(status_code=400, detail="不能删除自己的账号")

    await db.delete(user)


@router.patch("/{user_id}/reset-password", summary="重置密码")
async def reset_password(
    user_id: int,
    body: ResetPasswordRequest,
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """管理员强制重置用户密码"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    user.password_hash = hash_password(body.new_password)
    await db.flush()
    return {"success": True, "message": "密码已重置"}


@router.patch("/{user_id}/toggle-active", summary="启用/禁用用户")
async def toggle_active(
    user_id: int,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """切换用户启用/禁用状态（不可禁用自己）"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user.id == admin["user_id"]:
        raise HTTPException(status_code=400, detail="不能禁用自己的账号")

    user.is_active = not user.is_active
    await db.flush()
    await db.refresh(user)
    return {"success": True, "is_active": user.is_active}
