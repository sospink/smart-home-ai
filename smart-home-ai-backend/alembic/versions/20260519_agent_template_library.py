"""Agent template library

Revision ID: 20260519_agent_template_library
Revises: 20260515_agent_binding
Create Date: 2026-05-19
"""
from alembic import op
import sqlalchemy as sa


revision = "20260519_agent_template_library"
down_revision = "20260515_agent_binding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_template_library",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("dsl_content", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False, server_default="uploaded"),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_agent_template_library_id", "agent_template_library", ["id"])


def downgrade() -> None:
    op.drop_index("ix_agent_template_library_id", table_name="agent_template_library")
    op.drop_table("agent_template_library")
