"""Agent 实例级 Dify 绑定字段

Revision ID: 20260515_agent_binding
Revises: e01b9892fbe7
Create Date: 2026-05-15
"""
from alembic import op
import sqlalchemy as sa


revision = "20260515_agent_binding"
down_revision = "e01b9892fbe7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_instances", sa.Column("dify_api_key", sa.String(length=255), nullable=False, server_default=""))
    op.add_column("agent_instances", sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("agent_instances", "is_default")
    op.drop_column("agent_instances", "dify_api_key")
