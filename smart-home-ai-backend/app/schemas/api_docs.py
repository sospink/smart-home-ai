"""
接口文档配置相关 schema
"""
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(word.capitalize() for word in parts[1:])


class CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class ApiDocEndpointWriteBase(CamelModel):
    @field_validator("method", check_fields=False, mode="before")
    @classmethod
    def normalize_method(cls, value: Any) -> Any:
        normalized = str(value or "").strip().upper()
        if normalized not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            raise ValueError("请求方法仅支持 GET、POST、PUT、PATCH、DELETE")
        return normalized


class ApiDocHighlight(CamelModel):
    title: str
    description: str


class ApiDocGroup(CamelModel):
    id: str
    label: str


class ApiDocParam(CamelModel):
    name: str
    location: str
    type: str
    required: bool = False
    description: str
    default_value: Optional[str | int | float | bool | dict[str, Any] | list[Any]] = None


class ApiDocResponseField(CamelModel):
    name: str
    type: str
    description: str


class ApiDocCodeSample(CamelModel):
    id: str
    label: str
    language: str
    code: str


class ApiDocPlaygroundField(CamelModel):
    id: str
    label: str
    type: str
    placeholder: Optional[str] = None
    value: Optional[str | int | bool] = None
    options: list[dict[str, str]] = Field(default_factory=list)


class ApiDocPlaygroundPreset(CamelModel):
    id: str
    label: str
    description: str
    request_preview: str
    response_body: str
    response_meta: str


class ApiDocPlayground(CamelModel):
    title: str
    target_label: str
    status_label: str
    note: str
    fields: list[ApiDocPlaygroundField] = Field(default_factory=list)
    presets: list[ApiDocPlaygroundPreset] = Field(default_factory=list)


class ApiDocEndpointResponse(CamelModel):
    id: int
    module_id: int
    slug: str
    group: str = Field(alias="group")
    method: str
    path: str
    summary: str
    description: str
    source_type: str
    source_identifier: str
    sort_order: int
    is_visible: bool
    tags: list[str] = Field(default_factory=list)
    params: list[ApiDocParam] = Field(default_factory=list)
    responses: list[ApiDocResponseField] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    code_samples: list[ApiDocCodeSample] = Field(default_factory=list)
    request_preview: str = ""
    response_body: str = ""
    response_meta: str = ""
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ApiDocModuleResponse(CamelModel):
    id: int
    slug: str
    title: str
    subtitle: str
    description: str
    markdown_content: str
    status: str
    source_type: str
    renderer_type: str
    endpoint_base: str
    sort_order: int
    is_visible: bool
    capability_tags: list[str] = Field(default_factory=list)
    highlights: list[ApiDocHighlight] = Field(default_factory=list)
    groups: list[ApiDocGroup] = Field(default_factory=list)
    playground: ApiDocPlayground
    endpoints: list[ApiDocEndpointResponse] = Field(default_factory=list)


class ApiDocModuleListResponse(CamelModel):
    modules: list[ApiDocModuleResponse]


class ApiDocCatalogSummary(CamelModel):
    module_total: int
    endpoint_total: int


class ApiDocCatalogItem(CamelModel):
    id: int
    slug: str
    title: str
    subtitle: str
    description: str
    endpoint_base: str
    capability_tags: list[str] = Field(default_factory=list)
    endpoint_count: int


class ApiDocCatalogResponse(CamelModel):
    summary: ApiDocCatalogSummary
    items: list[ApiDocCatalogItem]
    total: int
    page: int
    size: int
    page_count: int


class ApiDocAdminOverview(CamelModel):
    module_total: int
    visible_module_total: int
    endpoint_total: int
    visible_endpoint_total: int
    manual_endpoint_total: int
    history_total: int
    last_change_at: Optional[datetime] = None
    last_change_source: str = ""


class ApiDocModuleSummary(CamelModel):
    id: int
    slug: str
    title: str
    subtitle: str
    status: str
    source_type: str
    endpoint_base: str
    sort_order: int
    is_visible: bool
    endpoint_count: int
    visible_endpoint_count: int
    updated_at: Optional[datetime] = None


class ApiDocModulePageResponse(CamelModel):
    items: list[ApiDocModuleSummary]
    total: int
    page: int
    size: int
    page_count: int


class ApiDocEndpointPageResponse(CamelModel):
    items: list[ApiDocEndpointResponse]
    total: int
    page: int
    size: int
    page_count: int
    available_filters: dict[str, list[str]] = Field(default_factory=dict)


class ApiDocChangeRecord(CamelModel):
    id: int
    target_type: str
    target_ref: str
    target_label: str = ""
    source_type: str
    source_ref: str
    import_strategy: str
    note: str
    imported_at: Optional[datetime] = None
    repeat_count: int = 1


class ApiDocChangePageResponse(CamelModel):
    items: list[ApiDocChangeRecord]
    total: int
    raw_total: int
    page: int
    size: int
    page_count: int


class ApiDocModuleCreate(CamelModel):
    title: str = Field(min_length=1, max_length=255)
    slug: str = Field(min_length=1, max_length=128, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    subtitle: str = Field(default="", max_length=255)
    description: str = ""
    markdown_content: str = ""
    sort_order: int = Field(default=0, ge=-2147483648, le=2147483647)
    is_visible: bool = True


class ApiDocModuleUpdate(CamelModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    slug: Optional[str] = Field(default=None, min_length=1, max_length=128, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    subtitle: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    markdown_content: Optional[str] = None
    status: Optional[str] = None
    source_type: Optional[str] = None
    renderer_type: Optional[str] = None
    endpoint_base: Optional[str] = Field(default=None, max_length=255)
    sort_order: Optional[int] = Field(default=None, ge=-2147483648, le=2147483647)
    is_visible: Optional[bool] = None
    capability_tags: Optional[list[str]] = None
    highlights: Optional[list[ApiDocHighlight]] = None
    groups: Optional[list[ApiDocGroup]] = None
    playground: Optional[ApiDocPlayground] = None


class ApiDocEndpointUpdate(ApiDocEndpointWriteBase):
    module_id: Optional[int] = None
    slug: Optional[str] = Field(default=None, min_length=1, max_length=128, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    group: Optional[str] = Field(default=None, max_length=64)
    method: Optional[str] = None
    path: Optional[str] = Field(default=None, min_length=1, max_length=255)
    summary: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    sort_order: Optional[int] = Field(default=None, ge=-2147483648, le=2147483647)
    is_visible: Optional[bool] = None
    source_type: Optional[str] = None
    tags: Optional[list[str]] = None
    params: Optional[list[ApiDocParam]] = None
    responses: Optional[list[ApiDocResponseField]] = None
    notes: Optional[list[str]] = None
    code_samples: Optional[list[ApiDocCodeSample]] = None
    request_preview: Optional[str] = None
    response_body: Optional[str] = None
    response_meta: Optional[str] = None


class ApiDocEndpointCreate(ApiDocEndpointWriteBase):
    slug: str = Field(min_length=1, max_length=128, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    group: str = Field(default="overview", max_length=64)
    method: str = "GET"
    path: str = Field(min_length=1, max_length=255)
    summary: str = Field(min_length=1, max_length=255)
    description: str = ""
    sort_order: int = Field(default=0, ge=-2147483648, le=2147483647)
    is_visible: bool = True
    tags: list[str] = Field(default_factory=list)
    params: list[ApiDocParam] = Field(default_factory=list)
    responses: list[ApiDocResponseField] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    code_samples: list[ApiDocCodeSample] = Field(default_factory=list)
    request_preview: str = ""
    response_body: str = ""
    response_meta: str = ""


class OpenApiImportRequest(CamelModel):
    refresh_existing: bool = True
    include_hidden_modules: bool = True


class OpenApiImportResponse(CamelModel):
    created: int
    updated: int
    skipped: int
    unmatched: int


class ApiDocDebuggerExecuteRequest(CamelModel):
    module_slug: str
    endpoint_slug: str
    base_url: str = ""
    method: str
    path: str
    path_params: dict[str, str] = Field(default_factory=dict)
    query_params: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    body_text: str = ""
    auth_type: str = "none"
    auth_value: str = ""
    custom_header_name: str = "X-Custom-Key"
    confirm_risky_execution: bool = False


class ApiDocDebuggerExecuteResponse(CamelModel):
    success: bool
    status_code: Optional[int] = None
    duration_ms: int
    response_headers: dict[str, str] = Field(default_factory=dict)
    response_body: Any = None
    request_snapshot: dict[str, Any] = Field(default_factory=dict)
    curl_command: str = ""
    error: str = ""


class ApiDocActionResponse(CamelModel):
    success: bool = True
    message: str = "ok"
    detail: dict[str, Any] = Field(default_factory=dict)
