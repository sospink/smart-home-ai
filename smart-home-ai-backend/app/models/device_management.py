"""
设备接入管理模型

平台以网关、设备台账、实体映射三层管理真实硬件接入。
第一阶段 HA 网关可真实同步和控制，其他网关类型保留配置与映射能力。
"""
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import relationship

from app.database import Base


class DeviceGateway(Base):
    __tablename__ = "device_gateways"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    name = Column(String(128), nullable=False)
    gateway_type = Column(String(32), nullable=False, default="homeassistant", index=True)
    base_url = Column(String(255), nullable=False, default="")
    port = Column(Integer, nullable=True)
    auth_type = Column(String(32), nullable=False, default="bearer")
    credential = Column(Text, nullable=False, default="")
    enabled = Column(Boolean, nullable=False, default=True)
    status = Column(String(32), nullable=False, default="unknown")
    description = Column(Text, nullable=False, default="")
    last_test_at = Column(DateTime, nullable=True)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    devices = relationship("ManagedDevice", back_populates="gateway")


class ManagedDevice(Base):
    __tablename__ = "managed_devices"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    name = Column(String(128), nullable=False)
    category = Column(String(32), nullable=False, default="switch", index=True)
    brand = Column(String(64), nullable=False, default="")
    model = Column(String(128), nullable=False, default="")
    location = Column(String(128), nullable=False, default="")
    protocol = Column(String(64), nullable=False, default="homeassistant")
    gateway_id = Column(Integer, ForeignKey("device_gateways.id", ondelete="SET NULL"), nullable=True, index=True)
    description = Column(Text, nullable=False, default="")
    local_control = Column(Boolean, nullable=False, default=False)
    enabled = Column(Boolean, nullable=False, default=True)
    source = Column(String(32), nullable=False, default="manual", index=True)
    capability_tags = Column(JSON, nullable=False, default=list)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    gateway = relationship("DeviceGateway", back_populates="devices")
    mappings = relationship(
        "DeviceEntityMapping",
        back_populates="device",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class DeviceEntityMapping(Base):
    __tablename__ = "device_entity_mappings"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    device_id = Column(Integer, ForeignKey("managed_devices.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(64), nullable=False, default="power")
    endpoint = Column(String(255), nullable=False, default="")
    gateway_type = Column(String(32), nullable=False, default="homeassistant")
    access_mode = Column(String(16), nullable=False, default="rw")
    unit = Column(String(32), nullable=False, default="")
    value_path = Column(String(128), nullable=False, default="")
    control_actions = Column(JSON, nullable=False, default=list)
    mapping_metadata = Column("metadata", JSON, nullable=False, default=dict)
    created_at = Column(DateTime, server_default=func.now(), index=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    device = relationship("ManagedDevice", back_populates="mappings")
