"""
用户管理路由 - 增删改查 / 重置密码 / 启用禁用
仅管理员可访问
"""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import case, func, or_, select
from app.dependencies import get_db, require_admin
from app.models.operation_log import OperationLog
from app.models.user import User
from app.schemas.user import (
    CreateUserRequest,
    UpdateUserRequest,
    ResetPasswordRequest,
    UserAuditItem,
    UserAuditPage,
    UserDetailResponse,
    UserListResponse,
    UserStatsResponse,
)
from app.routers.auth import hash_password
from app.services.runtime_settings import get_runtime_config

router = APIRouter(prefix="/users", tags=["用户管理"])

USER_ACTION_LABELS = {
    "create": "创建用户",
    "update": "更新用户",
    "delete": "删除用户",
    "reset_password": "重置密码",
    "toggle_active": "启用或禁用用户",
}
USER_CHANGED_FIELDS = {"nickname", "role", "is_active"}


def _clamp_page(page: int, size: int, total: int) -> int:
    page_count = max(1, (total + size - 1) // size)
    return min(page, page_count)


def _role_value(role) -> str:
    return str(getattr(role, "value", role) or "")


def _parse_audit_detail(detail: str | None) -> dict[str, str]:
    values: dict[str, str] = {}
    for segment in str(detail or "").split(";"):
        key, separator, value = segment.strip().partition("=")
        if separator and key:
            values[key] = value.strip()
    return values


def _audit_changed_fields(action: str, detail: dict[str, str]) -> list[str]:
    if action == "update":
        return list(dict.fromkeys(
            part.split(":", 1)[0]
            for part in detail.get("changes", "").split(",")
            if part.split(":", 1)[0] in USER_CHANGED_FIELDS
        ))
    if action in {"create", "delete"}:
        return [key for key in ("role", "is_active") if key in detail]
    if action == "toggle_active":
        return ["is_active"]
    return []


async def _active_admin_count(db: AsyncSession) -> int:
    return int((await db.execute(
        select(func.count()).select_from(User).where(
            User.role == "admin",
            User.is_active.is_(True),
        )
    )).scalar() or 0)


async def _protect_admin_access(
    db: AsyncSession,
    target: User,
    admin: dict,
    *,
    next_role: str | None = None,
    next_active: bool | None = None,
) -> None:
    current_role = _role_value(target.role)
    resolved_role = next_role if next_role is not None else current_role
    resolved_active = next_active if next_active is not None else bool(target.is_active)
    removes_current_access = current_role == "admin" and bool(target.is_active) and (
        resolved_role != "admin" or not resolved_active
    )
    if target.id == admin.get("user_id") and removes_current_access:
        raise HTTPException(status_code=400, detail="不能移除当前登录管理员自己的管理权限")
    if removes_current_access and await _active_admin_count(db) <= 1:
        raise HTTPException(status_code=409, detail="系统至少需要保留一位已启用管理员")


def _add_user_log(
    db: AsyncSession,
    admin: dict,
    action: str,
    target: User,
    detail: str = "",
):
    """记录用户管理审计日志，不记录任何密码或密码哈希。"""
    safe_detail = (
        f"action={action}; target_user_id={target.id}; "
        f"target_username={target.username}; {detail}"
    ).strip()
    db.add(OperationLog(
        type="user_management",
        level="success",
        title=f"{USER_ACTION_LABELS.get(action, '用户管理操作')}：{target.username}",
        detail=safe_detail,
        user_id=admin.get("user_id"),
        username=admin.get("username", ""),
    ))


@router.get("/stats", response_model=UserStatsResponse, summary="用户统计")
async def user_stats(
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """使用单次聚合返回用户与管理员安全基线。"""
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    row = (await db.execute(select(
        func.count(User.id),
        func.sum(case((User.is_active.is_(True), 1), else_=0)),
        func.sum(case((User.created_at >= week_ago, 1), else_=0)),
        func.sum(case((User.role == "admin", 1), else_=0)),
        func.sum(case(((User.role == "admin") & User.is_active.is_(True), 1), else_=0)),
    ))).one()
    total, active, new_this_week, admin_count, active_admin_count = [int(value or 0) for value in row]
    return UserStatsResponse(
        total=total,
        active=active,
        inactive=max(total - active, 0),
        new_this_week=new_this_week,
        admin_count=admin_count,
        active_admin_count=active_admin_count,
    )


@router.get("/audit", response_model=UserAuditPage, summary="分页读取用户管理审计")
async def user_audit(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    action: str = Query(""),
    keyword: str = Query("", max_length=128),
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    query = select(OperationLog).where(OperationLog.type == "user_management")
    if action in USER_ACTION_LABELS:
        query = query.where(OperationLog.detail.like(f"%action={action}%"))
    if keyword.strip():
        text = f"%{keyword.strip()}%"
        query = query.where(or_(
            OperationLog.title.ilike(text),
            OperationLog.detail.ilike(text),
            OperationLog.username.ilike(text),
        ))
    total = int((await db.execute(
        select(func.count()).select_from(query.subquery())
    )).scalar() or 0)
    safe_page = _clamp_page(page, size, total)
    rows = (await db.execute(
        query.order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
        .offset((safe_page - 1) * size).limit(size)
    )).scalars().all()
    items = []
    for row in rows:
        detail = _parse_audit_detail(row.detail)
        action_name = detail.get("action", "")
        target_id = detail.get("target_user_id", "")
        items.append(UserAuditItem(
            id=row.id,
            action=action_name if action_name in USER_ACTION_LABELS else "unknown",
            target_user_id=int(target_id) if target_id.isdigit() else None,
            target_username=detail.get("target_username", ""),
            changed_fields=_audit_changed_fields(action_name, detail),
            level=row.level,
            operator=row.username or "",
            created_at=row.created_at,
        ))
    return UserAuditPage(items=items, total=total, page=safe_page, size=size)



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
    normalized_keyword = keyword.strip()
    if normalized_keyword:
        query = query.where(
            or_(
                User.username.contains(normalized_keyword),
                User.nickname.contains(normalized_keyword),
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
    safe_page = _clamp_page(page, size, int(total))
    query = query.order_by(User.id.desc()).offset((safe_page - 1) * size).limit(size)
    result = await db.execute(query)
    users = result.scalars().all()

    return UserListResponse(items=users, total=total, page=safe_page, size=size)


@router.post(
    "",
    response_model=UserDetailResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建用户",
)
async def create_user(
    body: CreateUserRequest,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """管理员手动创建用户"""
    runtime = await get_runtime_config(db)
    if len(body.password) < runtime.password_min_length:
        raise HTTPException(
            status_code=400,
            detail=f"密码长度不能少于 {runtime.password_min_length} 位",
        )
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
    _add_user_log(db, admin, "create", user, f"role={user.role}; is_active={user.is_active}")
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
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """更新用户信息（昵称、角色、启用状态）"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    next_role = body.role if body.role is not None else _role_value(user.role)
    next_active = body.is_active if body.is_active is not None else bool(user.is_active)
    await _protect_admin_access(
        db,
        user,
        admin,
        next_role=next_role,
        next_active=next_active,
    )

    changes = []
    if body.nickname is not None and body.nickname != user.nickname:
        changes.append("nickname")
        user.nickname = body.nickname
    if body.role is not None and body.role != user.role:
        changes.append(f"role:{user.role}->{body.role}")
        user.role = body.role
    if body.is_active is not None and body.is_active != user.is_active:
        changes.append(f"is_active:{user.is_active}->{body.is_active}")
        user.is_active = body.is_active

    await db.flush()
    await db.refresh(user)
    _add_user_log(db, admin, "update", user, f"changes={','.join(changes) or 'none'}")
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
    await _protect_admin_access(db, user, admin, next_role="user", next_active=False)

    _add_user_log(db, admin, "delete", user, f"role={user.role}; is_active={user.is_active}")
    await db.delete(user)


@router.patch("/{user_id}/reset-password", summary="重置密码")
async def reset_password(
    user_id: int,
    body: ResetPasswordRequest,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """管理员强制重置用户密码"""
    runtime = await get_runtime_config(db)
    if len(body.new_password) < runtime.password_min_length:
        raise HTTPException(
            status_code=400,
            detail=f"密码长度不能少于 {runtime.password_min_length} 位",
        )
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    user.password_hash = hash_password(body.new_password)
    await db.flush()
    _add_user_log(db, admin, "reset_password", user, "result=success")
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

    await _protect_admin_access(
        db,
        user,
        admin,
        next_active=not bool(user.is_active),
    )

    user.is_active = not user.is_active
    await db.flush()
    await db.refresh(user)
    _add_user_log(db, admin, "toggle_active", user, f"is_active={user.is_active}")
    return {"success": True, "is_active": user.is_active}
