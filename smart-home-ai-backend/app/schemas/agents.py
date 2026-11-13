"""
智能体运行与管理框架相关 schema
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(word.capitalize() for word in parts[1:])


class CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class AgentCapabilityModule(CamelModel):
    title: str
    description: str
    status: str = "ready"
    entry_label: str = ""
    entry_route: str = ""
    deployment_scope: str = ""
    extensible: bool = True


class AgentOverviewMetric(CamelModel):
    label: str
    value: str
    note: str = ""


class AgentFrameworkOverview(CamelModel):
    title: str
    subtitle: str
    metrics: list[AgentOverviewMetric] = Field(default_factory=list)
    modules: list[AgentCapabilityModule] = Field(default_factory=list)
    deployment_highlights: list[str] = Field(default_factory=list)


class AgentTemplateDoc(CamelModel):
    id: str
    title: str
    file_name: str
    template_type: str
    description: str
    function_desc: str
    usage: str
    config: str
    customization: str
    entry_route: str
    docs_section: str
    capability_tags: list[str] = Field(default_factory=list)


class AgentTemplateLibraryItem(CamelModel):
    id: str
    name: str
    description: str
    tags: list[str] = Field(default_factory=list)
    file_name: str
    source: str
    readonly: bool = False
    created_by: int | None = None
    created_at: Any
    updated_at: Any


class AgentTemplateLibraryDetail(AgentTemplateLibraryItem):
    dsl_content: str = ""


class AgentTemplateLibraryListSummary(CamelModel):
    total_templates: int = 0
    builtin_templates: int = 0
    uploaded_templates: int = 0


class AgentTemplateLibraryListResponse(CamelModel):
    items: list[AgentTemplateLibraryItem] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    page_size: int = 10
    page_count: int = 1
    summary: AgentTemplateLibraryListSummary = Field(default_factory=AgentTemplateLibraryListSummary)
    can_manage: bool = False
    generated_at: Any = None
    cache_ttl_seconds: int = 30


class AgentTemplateLibraryUploadResponse(CamelModel):
    success: bool = True
    created: bool = True
    item: AgentTemplateLibraryItem


class AgentTemplateLibraryUpdate(CamelModel):
    name: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None


class AgentInstanceBase(CamelModel):
    name: str
    slug: str
    dify_app_id: str = ""
    is_default: bool = False
    instance_type: str = "workflow"
    source_type: str = "built_in_template"
    source_template: str = ""
    dsl_file_name: str = ""
    status: str = "draft"
    enabled: bool = True
    description: str = ""
    default_model: str = ""
    knowledge_bindings: list[str] = Field(default_factory=list)
    capability_tags: list[str] = Field(default_factory=list)
    entry_route: str = "/chat"
    dify_console_url: str = ""
    dsl_content: str = ""
    has_dify_api_key: bool = False
    dify_api_key_masked: str = ""


class AgentInstanceCreate(CamelModel):
    name: str = ""
    description: str = ""
    instance_type: str = "workflow"
    source_type: str = "built_in_template"
    source_template: str = ""
    default_model: str = ""
    knowledge_bindings: list[str] = Field(default_factory=list)
    capability_tags: list[str] = Field(default_factory=list)
    entry_route: str = "/chat"
    enabled: bool = True
    dify_app_id: str = ""
    dify_api_key: str = ""
    is_default: bool = False
    dify_console_url: str = ""


class AgentInstanceUpdate(CamelModel):
    name: Optional[str] = None
    slug: Optional[str] = None
    dify_app_id: Optional[str] = None
    dify_api_key: Optional[str] = None
    is_default: Optional[bool] = None
    instance_type: Optional[str] = None
    source_type: Optional[str] = None
    source_template: Optional[str] = None
    dsl_file_name: Optional[str] = None
    status: Optional[str] = None
    enabled: Optional[bool] = None
    description: Optional[str] = None
    default_model: Optional[str] = None
    knowledge_bindings: Optional[list[str]] = None
    capability_tags: Optional[list[str]] = None
    entry_route: Optional[str] = None
    dify_console_url: Optional[str] = None
    dsl_content: Optional[str] = None


class AgentRuntimeEvidence(CamelModel):
    status: str = "unconfigured"
    binding_status: str = "unconfigured"
    app_name: str = ""
    app_mode: str = ""
    base_url: str = ""
    latency_ms: int | None = None
    checked_at: Any = None
    error: str = ""
    name_matches: bool | None = None
    source: str = "dify_app_api"


class AgentLastRunEvidence(CamelModel):
    status: str = "never"
    title: str = ""
    query: str = ""
    message_id: str = ""
    workflow_run_id: str = ""
    error: str = ""
    created_at: Any = None


class AgentInstanceResponse(AgentInstanceBase):
    id: int
    business_name: str = ""
    business_description: str = ""
    created_by: int | None = None
    created_at: Any
    updated_at: Any
    runtime: AgentRuntimeEvidence = Field(default_factory=AgentRuntimeEvidence)
    last_run: AgentLastRunEvidence = Field(default_factory=AgentLastRunEvidence)


class AgentInstanceListSummary(CamelModel):
    total_instances: int = 0
    enabled_instances: int = 0
    default_instances: int = 0
    bound_instances: int = 0
    callable_instances: int = 0
    template_reference_instances: int = 0
    successful_runs_24h: int = 0
    failed_runs_24h: int = 0


class AgentInstanceListResponse(CamelModel):
    instances: list[AgentInstanceResponse] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    page_size: int = 10
    page_count: int = 1
    summary: AgentInstanceListSummary = Field(default_factory=AgentInstanceListSummary)
    run_visibility_scope: str = "self"
    generated_at: Any = None
    cache_ttl_seconds: int = 30


class AgentCapabilitiesResponse(CamelModel):
    title: str
    subtitle: str
    items: list[dict[str, Any]] = Field(default_factory=list)


class AgentUploadDslResponse(CamelModel):
    success: bool = True
    instance: AgentInstanceResponse
    parsed: dict[str, Any] = Field(default_factory=dict)


class AgentImportToDifyResponse(CamelModel):
    success: bool = True
    message: str
    console_url: str = ""
    detail: dict[str, Any] = Field(default_factory=dict)


class AgentTestRunRequest(CamelModel):
    query: str = ""
    allow_side_effects: bool = False


class AgentTestRunResponse(CamelModel):
    success: bool = True
    instance_id: int
    instance_name: str
    business_name: str = ""
    query: str
    answer: str = ""
    message_id: str = ""
    conversation_id: str = ""
    task_id: str = ""
    workflow_run_id: str = ""
    runtime_binding: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class AgentRunRecord(CamelModel):
    id: int
    instance_id: int | None = None
    instance_name: str = ""
    business_name: str = ""
    status: str = "unknown"
    title: str = ""
    query: str = ""
    answer: str = ""
    message_id: str = ""
    workflow_run_id: str = ""
    error: str = ""
    username: str = ""
    created_at: Any = None


class AgentRunListSummary(CamelModel):
    total_runs: int = 0
    successful_runs: int = 0
    failed_runs: int = 0
    runs_24h: int = 0


class AgentRunListResponse(CamelModel):
    items: list[AgentRunRecord] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    page_size: int = 10
    page_count: int = 1
    summary: AgentRunListSummary = Field(default_factory=AgentRunListSummary)
    visibility_scope: str = "self"
