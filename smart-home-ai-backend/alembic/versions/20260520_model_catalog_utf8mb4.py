"""model catalog utf8mb4

Revision ID: 20260520_model_catalog_utf8mb4
Revises: 20260519_device_crud_gateway
Create Date: 2026-05-20
"""
from alembic import op
import sqlalchemy as sa


revision = "20260520_model_catalog_utf8mb4"
down_revision = "20260519_device_crud_gateway"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "mysql":
        return
    if not sa.inspect(bind).has_table("model_catalog_snapshots"):
        return
    op.execute(
        "ALTER TABLE model_catalog_snapshots "
        "MODIFY payload_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL"
    )
    op.execute(
        "ALTER TABLE model_catalog_snapshots "
        "MODIFY error TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    )


def downgrade() -> None:
    pass
