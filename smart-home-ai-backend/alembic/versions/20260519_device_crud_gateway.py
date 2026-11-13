"""device crud gateway

Revision ID: 20260519_device_crud_gateway
Revises: 20260519_agent_template_library
Create Date: 2026-05-19
"""
from alembic import op
import sqlalchemy as sa


revision = "20260519_device_crud_gateway"
down_revision = "20260519_agent_template_library"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_gateways",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("gateway_type", sa.String(length=32), nullable=False, server_default="homeassistant"),
        sa.Column("base_url", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("port", sa.Integer(), nullable=True),
        sa.Column("auth_type", sa.String(length=32), nullable=False, server_default="bearer"),
        sa.Column("credential", sa.Text(), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="unknown"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("last_test_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
    )
    op.create_index(op.f("ix_device_gateways_id"), "device_gateways", ["id"])
    op.create_index(op.f("ix_device_gateways_gateway_type"), "device_gateways", ["gateway_type"])
    op.create_index(op.f("ix_device_gateways_created_at"), "device_gateways", ["created_at"])

    op.create_table(
        "managed_devices",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False, server_default="switch"),
        sa.Column("brand", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("model", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("location", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("protocol", sa.String(length=64), nullable=False, server_default="homeassistant"),
        sa.Column("gateway_id", sa.Integer(), sa.ForeignKey("device_gateways.id", ondelete="SET NULL"), nullable=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("local_control", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("source", sa.String(length=32), nullable=False, server_default="manual"),
        sa.Column("capability_tags", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
    )
    op.create_index(op.f("ix_managed_devices_id"), "managed_devices", ["id"])
    op.create_index(op.f("ix_managed_devices_category"), "managed_devices", ["category"])
    op.create_index(op.f("ix_managed_devices_gateway_id"), "managed_devices", ["gateway_id"])
    op.create_index(op.f("ix_managed_devices_source"), "managed_devices", ["source"])
    op.create_index(op.f("ix_managed_devices_created_at"), "managed_devices", ["created_at"])

    op.create_table(
        "device_entity_mappings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("device_id", sa.Integer(), sa.ForeignKey("managed_devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(length=64), nullable=False, server_default="power"),
        sa.Column("endpoint", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("gateway_type", sa.String(length=32), nullable=False, server_default="homeassistant"),
        sa.Column("access_mode", sa.String(length=16), nullable=False, server_default="rw"),
        sa.Column("unit", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("value_path", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("control_actions", sa.JSON(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
    )
    op.create_index(op.f("ix_device_entity_mappings_id"), "device_entity_mappings", ["id"])
    op.create_index(op.f("ix_device_entity_mappings_device_id"), "device_entity_mappings", ["device_id"])
    op.create_index(op.f("ix_device_entity_mappings_created_at"), "device_entity_mappings", ["created_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_device_entity_mappings_created_at"), table_name="device_entity_mappings")
    op.drop_index(op.f("ix_device_entity_mappings_device_id"), table_name="device_entity_mappings")
    op.drop_index(op.f("ix_device_entity_mappings_id"), table_name="device_entity_mappings")
    op.drop_table("device_entity_mappings")
    op.drop_index(op.f("ix_managed_devices_created_at"), table_name="managed_devices")
    op.drop_index(op.f("ix_managed_devices_source"), table_name="managed_devices")
    op.drop_index(op.f("ix_managed_devices_gateway_id"), table_name="managed_devices")
    op.drop_index(op.f("ix_managed_devices_category"), table_name="managed_devices")
    op.drop_index(op.f("ix_managed_devices_id"), table_name="managed_devices")
    op.drop_table("managed_devices")
    op.drop_index(op.f("ix_device_gateways_created_at"), table_name="device_gateways")
    op.drop_index(op.f("ix_device_gateways_gateway_type"), table_name="device_gateways")
    op.drop_index(op.f("ix_device_gateways_id"), table_name="device_gateways")
    op.drop_table("device_gateways")
