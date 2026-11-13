import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.models.user import User, UserRole
from app.dependencies import _load_token_user, require_admin
from app.routers.auth import change_password, get_public_auth_config, login, register
from app.routers.users import (
    _add_user_log,
    _audit_changed_fields,
    _clamp_page,
    _parse_audit_detail,
    _protect_admin_access,
    list_users,
    update_user,
    user_audit,
    user_stats,
)
from app.schemas.user import ChangePasswordRequest, CreateUserRequest, UpdateUserRequest
from app.schemas.auth import LoginRequest, RegisterRequest


class _Result:
    def __init__(self, *, scalar=None, row=None, rows=None):
        self._scalar = scalar
        self._row = row
        self._rows = rows or []

    def scalar(self):
        return self._scalar

    def scalar_one_or_none(self):
        return self._scalar

    def one(self):
        return self._row

    def scalars(self):
        return self

    def all(self):
        return self._rows


class UsersWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _frontend_source() -> str:
        project_root = Path(__file__).resolve().parents[2]
        return (
            project_root
            / "smart-home-ai-frontend"
            / "app"
            / "(dashboard)"
            / "users"
            / "page.tsx"
        ).read_text(encoding="utf-8")

    def test_frontend_separates_first_failure_from_stale_snapshots(self):
        source = self._frontend_source()
        self.assertIn("auditError && auditLoaded", source)
        self.assertIn("usersError && usersLoaded", source)
        self.assertIn("{auditError}", source)
        self.assertIn("!usersLoaded && usersError ? usersError", source)
        self.assertNotIn("用户数据未取得，请稍后重试", source)
        self.assertNotIn("暂时无法读取用户操作审计，请点击刷新重试", source)

    def test_frontend_uses_truthful_stats_and_region_labels(self):
        source = self._frontend_source()
        self.assertIn("statsLoaded ? '；统计卡继续保留上次成功数据。' : '；统计卡暂不显示未经确认的数值。'", source)
        self.assertIn('aria-label="系统用户列表，可横向滚动"', source)
        self.assertNotIn('aria-label="用户审计记录列表，可横向滚动"', source)

    def test_frontend_preserves_desktop_table_and_adds_complete_mobile_rows(self):
        source = self._frontend_source()
        self.assertIn('function MobileUserRow', source)
        self.assertIn('className="divide-y divide-slate-100 md:hidden', source)
        self.assertIn('className="hidden overflow-x-auto md:block"', source)
        self.assertIn('账号状态', source)
        self.assertIn('加入日期', source)
        self.assertIn('账号操作', source)
        self.assertIn('<UserActions user={user} {...actionProps} />', source)

    def test_user_write_payload_normalizes_names_and_rejects_ambiguous_username(self):
        payload = CreateUserRequest(
            username=" operator ",
            password="123456",
            nickname=" 操作员 ",
        )
        self.assertEqual(payload.username, "operator")
        self.assertEqual(payload.nickname, "操作员")
        self.assertEqual(UpdateUserRequest(nickname=" 新昵称 ").nickname, "新昵称")

        for username in ("user name", "user\tname", "user\nname"):
            with self.subTest(username=username), self.assertRaises(ValueError):
                CreateUserRequest(username=username, password="123456")

    def test_public_auth_payloads_normalize_names_and_reject_ambiguous_username(self):
        login_payload = LoginRequest(username=" operator ", password="123456")
        register_payload = RegisterRequest(
            username=" student ",
            password="123456",
            nickname=" 学员 ",
        )

        self.assertEqual(login_payload.username, "operator")
        self.assertEqual(register_payload.username, "student")
        self.assertEqual(register_payload.nickname, "学员")

        for payload_type in (LoginRequest, RegisterRequest):
            for username in ("user name", "user\tname", "user\nname", "user\x7fname"):
                with self.subTest(payload_type=payload_type.__name__, username=username), self.assertRaises(ValueError):
                    payload_type(username=username, password="123456")

    def test_page_clamp_uses_last_real_page(self):
        self.assertEqual(_clamp_page(9, 10, 23), 3)
        self.assertEqual(_clamp_page(9, 10, 0), 1)

    async def test_stats_use_one_aggregate_query(self):
        db = AsyncMock()
        db.execute.return_value = _Result(row=(12, 9, 3, 2, 1))

        payload = await user_stats(_admin={"user_id": 1}, db=db)

        self.assertEqual(db.execute.await_count, 1)
        self.assertEqual(payload.total, 12)
        self.assertEqual(payload.active, 9)
        self.assertEqual(payload.inactive, 3)
        self.assertEqual(payload.new_this_week, 3)
        self.assertEqual(payload.admin_count, 2)
        self.assertEqual(payload.active_admin_count, 1)

    async def test_audit_is_paginated_and_only_returns_safe_fields(self):
        row = SimpleNamespace(
            id=18,
            detail=(
                "action=update; target_user_id=7; target_username=operator; "
                "changes=nickname,role:UserRole.user->admin; password=never-return"
            ),
            level="success",
            username="admin",
            created_at=datetime(2026, 7, 30, 9, 30, 0),
        )
        db = AsyncMock()
        db.execute.side_effect = [_Result(scalar=23), _Result(rows=[row])]

        payload = await user_audit(
            page=2,
            size=10,
            action="update",
            keyword="operator",
            _admin={"user_id": 1},
            db=db,
        )

        self.assertEqual(payload.total, 23)
        self.assertEqual(payload.page, 2)
        self.assertEqual(payload.size, 10)
        self.assertEqual(payload.items[0].target_user_id, 7)
        self.assertEqual(payload.items[0].changed_fields, ["nickname", "role"])
        serialized = payload.model_dump_json()
        self.assertNotIn("password", serialized)
        self.assertNotIn("never-return", serialized)

    async def test_audit_clamps_page_after_records_shrink(self):
        db = AsyncMock()
        db.execute.side_effect = [_Result(scalar=5), _Result(rows=[])]

        payload = await user_audit(
            page=4,
            size=4,
            action="",
            keyword="",
            _admin={"user_id": 1},
            db=db,
        )

        self.assertEqual(payload.page, 2)
        statement = db.execute.await_args_list[1].args[0]
        self.assertEqual(statement._offset_clause.value, 4)

    async def test_user_list_clamps_page_after_delete_or_filter(self):
        user = User(
            id=3,
            username="remaining",
            nickname="保留用户",
            role=UserRole.user,
            is_active=True,
            created_at=datetime(2026, 8, 3, 10, 0, 0),
        )
        db = AsyncMock()
        db.execute.side_effect = [_Result(scalar=11), _Result(rows=[user])]

        payload = await list_users(
            page=8,
            size=10,
            keyword="",
            role="",
            is_active="",
            _admin={"user_id": 1},
            db=db,
        )

        self.assertEqual(payload.page, 2)
        self.assertEqual(payload.total, 11)
        statement = db.execute.await_args_list[1].args[0]
        self.assertEqual(statement._offset_clause.value, 10)

    def test_old_audit_details_are_tolerated(self):
        detail = _parse_audit_detail("legacy text without fields; action=create; role=admin")
        self.assertEqual(detail["action"], "create")
        self.assertEqual(_audit_changed_fields("create", detail), ["role"])

    def test_user_logs_never_contain_password_hash(self):
        db = AsyncMock()
        db.add = MagicMock()
        user = User(
            id=4,
            username="safe-user",
            nickname="安全用户",
            role=UserRole.user,
            password_hash="secret-password-hash",
            is_active=True,
        )

        _add_user_log(db, {"user_id": 1, "username": "admin"}, "reset_password", user, "result=success")

        log = db.add.call_args.args[0]
        self.assertNotIn("secret-password-hash", log.detail)
        self.assertNotIn("password_hash", log.detail)
        self.assertNotIn("new_password=", log.detail)

    async def test_current_admin_cannot_demote_or_disable_self(self):
        db = AsyncMock()
        target = User(id=5, username="admin", role=UserRole.admin, is_active=True)

        for role, active in (("user", True), ("admin", False)):
            with self.subTest(role=role, active=active):
                with self.assertRaises(HTTPException) as raised:
                    await _protect_admin_access(
                        db,
                        target,
                        {"user_id": 5},
                        next_role=role,
                        next_active=active,
                    )
                self.assertEqual(raised.exception.status_code, 400)

    async def test_last_active_admin_cannot_be_removed(self):
        db = AsyncMock()
        db.execute.return_value = _Result(scalar=1)
        target = User(id=6, username="last-admin", role=UserRole.admin, is_active=True)

        with self.assertRaises(HTTPException) as raised:
            await _protect_admin_access(
                db,
                target,
                {"user_id": 1},
                next_role="user",
                next_active=False,
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("至少需要保留", raised.exception.detail)

    async def test_another_admin_can_be_demoted_when_two_are_active(self):
        db = AsyncMock()
        db.execute.return_value = _Result(scalar=2)
        target = User(id=6, username="other-admin", role=UserRole.admin, is_active=True)

        await _protect_admin_access(
            db,
            target,
            {"user_id": 1},
            next_role="user",
            next_active=True,
        )

        self.assertEqual(db.execute.await_count, 1)

    async def test_current_admin_can_update_own_nickname(self):
        user = User(
            id=5,
            username="admin",
            nickname="旧昵称",
            role=UserRole.admin,
            is_active=True,
        )
        db = AsyncMock()
        db.add = MagicMock()
        db.execute.return_value = _Result(scalar=user)

        updated = await update_user(
            5,
            UpdateUserRequest(nickname="新昵称"),
            admin={"user_id": 5, "username": "admin"},
            db=db,
        )

        self.assertEqual(updated.nickname, "新昵称")
        self.assertEqual(updated.role, UserRole.admin)
        self.assertTrue(updated.is_active)
        self.assertEqual(db.flush.await_count, 1)

    async def test_token_uses_current_database_role_and_active_state(self):
        user = User(id=8, username="changed", role=UserRole.user, is_active=True)
        db = AsyncMock()
        db.execute.return_value = _Result(scalar=user)

        with patch("app.dependencies._decode_token", return_value=8):
            current = await _load_token_user("stale-admin-token", db)

        self.assertEqual(current, {"user_id": 8, "role": "user", "username": "changed"})
        with self.assertRaises(HTTPException) as raised:
            require_admin(current)
        self.assertEqual(raised.exception.status_code, 403)

        user.is_active = False
        with patch("app.dependencies._decode_token", return_value=8):
            with self.assertRaises(HTTPException) as disabled:
                await _load_token_user("stale-active-token", db)
        self.assertEqual(disabled.exception.status_code, 403)

    async def test_only_first_registered_user_becomes_admin(self):
        runtime = SimpleNamespace(allow_registration=True, password_min_length=6)

        async def register_with_count(total: int):
            db = AsyncMock()
            db.add = MagicMock()
            db.execute.side_effect = [_Result(scalar=None), _Result(scalar=total)]
            with (
                patch("app.routers.auth.get_runtime_config", AsyncMock(return_value=runtime)),
                patch("app.routers.auth.hash_password", return_value="hashed"),
            ):
                await register(
                    RegisterRequest(username=f"new-user-{total}", password="123456", nickname="新用户"),
                    db=db,
                )
            return db.add.call_args.args[0]

        first = await register_with_count(0)
        later = await register_with_count(3)

        self.assertEqual(first.role, "admin")
        self.assertEqual(later.role, "user")

    async def test_login_uses_runtime_expiry_and_records_safe_audit(self):
        runtime = SimpleNamespace(jwt_expire_hours=12)
        user = User(
            id=9,
            username="operator",
            nickname="操作员",
            role=UserRole.user,
            password_hash="hashed-password",
            is_active=True,
        )
        db = AsyncMock()
        db.add = MagicMock()
        db.execute.return_value = _Result(scalar=user)

        with (
            patch("app.routers.auth.get_runtime_config", AsyncMock(return_value=runtime)),
            patch("app.routers.auth.verify_password", return_value=True),
            patch("app.routers.auth.create_access_token", return_value="signed-token") as create_token,
        ):
            response = await login(LoginRequest(username="operator", password="123456"), db=db)

        self.assertEqual(response.access_token, "signed-token")
        create_token.assert_called_once_with(9, "user", "operator", expire_minutes=720)
        audit = db.add.call_args.args[0]
        self.assertEqual(audit.type, "user_login")
        self.assertNotIn("hashed-password", audit.detail)
        self.assertNotIn("123456", audit.detail)

    async def test_disabled_user_cannot_login(self):
        runtime = SimpleNamespace(jwt_expire_hours=24)
        user = User(
            id=10,
            username="disabled-user",
            nickname="停用账号",
            role=UserRole.user,
            password_hash="hashed-password",
            is_active=False,
        )
        db = AsyncMock()
        db.execute.return_value = _Result(scalar=user)

        with (
            patch("app.routers.auth.get_runtime_config", AsyncMock(return_value=runtime)),
            patch("app.routers.auth.verify_password", return_value=True),
        ):
            with self.assertRaises(HTTPException) as raised:
                await login(LoginRequest(username="disabled-user", password="123456"), db=db)

        self.assertEqual(raised.exception.status_code, 403)
        self.assertIn("账号已被禁用", raised.exception.detail)

    async def test_current_user_can_change_password_without_secret_in_audit(self):
        runtime = SimpleNamespace(password_min_length=8)
        user = User(
            id=11,
            username="operator",
            nickname="操作员",
            role=UserRole.user,
            password_hash="old-password-hash",
            is_active=True,
        )
        db = AsyncMock()
        db.add = MagicMock()
        db.execute.return_value = _Result(scalar=user)

        with (
            patch("app.routers.auth.get_runtime_config", AsyncMock(return_value=runtime)),
            patch("app.routers.auth.verify_password", return_value=True),
            patch("app.routers.auth.hash_password", return_value="new-password-hash"),
        ):
            response = await change_password(
                ChangePasswordRequest(old_password="old-secret", new_password="new-secret"),
                current_user={"user_id": 11, "username": "operator"},
                db=db,
            )

        self.assertTrue(response["success"])
        self.assertEqual(user.password_hash, "new-password-hash")
        audit = db.add.call_args.args[0]
        self.assertEqual(audit.type, "user_management")
        self.assertEqual(audit.detail, "action=change_password; result=success")
        self.assertNotIn("old-secret", audit.detail)
        self.assertNotIn("new-secret", audit.detail)
        self.assertNotIn("password-hash", audit.detail)
        db.flush.assert_awaited_once()

    async def test_public_auth_config_uses_runtime_policy(self):
        runtime = SimpleNamespace(
            allow_registration=False,
            password_min_length=10,
            jwt_expire_hours=8,
        )

        with patch("app.routers.auth.get_runtime_config", AsyncMock(return_value=runtime)):
            response = await get_public_auth_config(db=AsyncMock())

        self.assertEqual(response, {
            "allow_registration": False,
            "password_min_length": 10,
            "jwt_expire_hours": 8,
        })


if __name__ == "__main__":
    unittest.main()
