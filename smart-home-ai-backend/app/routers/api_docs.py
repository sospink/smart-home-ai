"""
接口文档配置路由
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import time
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from sqlalchemy import String, case, cast, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, get_optional_user, require_admin
from app.models.api_doc_endpoint import ApiDocEndpoint
from app.models.api_doc_module import ApiDocModule
from app.models.api_doc_source_meta import ApiDocSourceMeta
from app.models.operation_log import OperationLog
from app.schemas.api_docs import (
    ApiDocActionResponse,
    ApiDocAdminOverview,
    ApiDocCatalogResponse,
    ApiDocChangePageResponse,
    ApiDocDebuggerExecuteRequest,
    ApiDocDebuggerExecuteResponse,
    ApiDocEndpointCreate,
    ApiDocEndpointPageResponse,
    ApiDocEndpointResponse,
    ApiDocEndpointUpdate,
    ApiDocModuleCreate,
    ApiDocModuleListResponse,
    ApiDocModulePageResponse,
    ApiDocModuleResponse,
    ApiDocModuleUpdate,
    OpenApiImportRequest,
    OpenApiImportResponse,
)
from app.services.api_docs import (
    get_endpoint_by_ref,
    get_module_by_ref,
    import_openapi_spec,
    list_modules,
    prepare_api_docs,
    record_source_meta,
    serialize_endpoint,
    serialize_module,
)
from app.services.runtime_settings import get_runtime_config

router = APIRouter(prefix="/api-docs", tags=["接口文档"])

PLATFORM_DEBUG_TIMEOUT_SECONDS = 30
LOCAL_MODEL_DEBUG_TIMEOUT_SECONDS = 120
LOCAL_MODEL_READ_ONLY_EXECUTION_PATHS = {"/api/generate", "/api/chat", "/api/embed"}
MAX_API_DOC_MARKDOWN_SIZE = 5 * 1024 * 1024


def _page_count(total: int, size: int) -> int:
    return max(1, (total + size - 1) // size)


def _change_target_label(
    target_type: str,
    target_ref: str,
    module_labels: dict[str, str],
    endpoint_labels: dict[str, str],
) -> str:
    """变更列表优先展示业务名称，技术标识保留在详情。"""
    if target_type == "module":
        return module_labels.get(target_ref) or {
            "contract-reference": "项目接口目录",
        }.get(target_ref, "接口模块")
    if target_type == "endpoint":
        return endpoint_labels.get(target_ref) or "接口端点"
    if target_type == "import":
        return {
            "project-openapi": "当前项目 OpenAPI",
        }.get(target_ref, "接口导入任务")
    return "其他配置对象"


def _normalize_method(method: str) -> str:
    value = method.strip().upper()
    if value not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        raise HTTPException(status_code=422, detail="接口方法仅支持 GET、POST、PUT、PATCH、DELETE")
    return value


def _requires_debugger_confirmation(module_slug: str, method: str, path: str) -> bool:
    """真实写入或执行类调试必须显式确认，避免从文档页误操作外部系统。"""
    if method.upper() == "GET":
        return False
    return not (module_slug == "local-model" and path in LOCAL_MODEL_READ_ONLY_EXECUTION_PATHS)


def _validate_slug(slug: str, field_label: str) -> str:
    value = slug.strip()
    if not value or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", value):
        raise HTTPException(status_code=422, detail=f"{field_label}仅支持小写字母、数字和连字符")
    return value


async def _read_markdown_import(file: UploadFile | None, markdown_text: str | None) -> str:
    if file is not None:
        if Path(file.filename or "").suffix.lower() != ".md":
            raise HTTPException(status_code=400, detail="仅支持上传 .md Markdown 文件")
        raw = await file.read(MAX_API_DOC_MARKDOWN_SIZE + 1)
        if len(raw) > MAX_API_DOC_MARKDOWN_SIZE:
            raise HTTPException(status_code=413, detail="Markdown 文件不能超过 5MB")
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=400, detail="Markdown 文件必须使用 UTF-8 编码") from exc
    else:
        content = markdown_text or ""
        if len(content.encode("utf-8")) > MAX_API_DOC_MARKDOWN_SIZE:
            raise HTTPException(status_code=413, detail="Markdown 文本不能超过 5MB")
    if not content.strip():
        raise HTTPException(status_code=400, detail="请提供 Markdown 文本或文件")
    return content


def _record_api_doc_operation(
    db: AsyncSession,
    admin: dict,
    *,
    action: str,
    target_type: str,
    target_ref: str,
    note: str = "",
) -> None:
    db.add(OperationLog(
        type="api_doc_management",
        level="success",
        title=f"接口文档配置：{action}",
        detail=f"action={action}; target_type={target_type}; target_ref={target_ref}; {note}".strip(),
        user_id=admin.get("user_id"),
        username=admin.get("username", ""),
        entity_id=f"api-doc:{target_type}:{target_ref}"[:128],
    ))


def _replace_path_params(path: str, values: dict[str, str]) -> str:
    final_path = path
    for key, value in values.items():
        final_path = final_path.replace(f"{{{key}}}", str(value))
        final_path = final_path.replace(f":{key}", str(value))
    return final_path


def _compact_values(values: dict[str, str]) -> dict[str, str]:
    return {key: str(value) for key, value in values.items() if str(value).strip()}


def _build_curl_command(method: str, url: str, headers: dict[str, str], body_text: str) -> str:
    header_lines = [f'  -H "{key}: {value}"' for key, value in headers.items()]
    body_lines = [f"  -d '{body_text.replace(chr(39), chr(92) + chr(39))}'"] if body_text.strip() else []
    return " \\\n".join([f'curl -X {method.upper()} "{url}"', *header_lines, *body_lines])


def _redact_sensitive_headers(headers: dict[str, str]) -> dict[str, str]:
    sensitive_names = {"authorization", "x-agent-key", "x-api-key", "api-key"}
    return {
        key: "***" if key.lower() in sensitive_names else value
        for key, value in headers.items()
    }


def _apply_auth_headers(headers: dict[str, str], body: ApiDocDebuggerExecuteRequest, forwarded_authorization: str = "") -> dict[str, str]:
    next_headers = dict(headers)
    if body.auth_type == "bearer" and body.auth_value.strip():
        next_headers["Authorization"] = f"Bearer {body.auth_value.strip()}"
    elif body.auth_type == "x-agent-key" and body.auth_value.strip():
        next_headers["X-Agent-Key"] = body.auth_value.strip()
    elif body.auth_type == "custom" and body.auth_value.strip() and body.custom_header_name.strip():
        next_headers[body.custom_header_name.strip()] = body.auth_value.strip()
    elif forwarded_authorization and "Authorization" not in next_headers:
        next_headers["Authorization"] = forwarded_authorization
    return next_headers


def _parse_response_body(content_type: str, text: str):
    if not text:
        return None
    if "application/json" in content_type:
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return text


LOCAL_MODEL_INFERENCE_PATHS = {"/api/generate", "/api/chat", "/api/embed"}


def _extract_local_model_name(path: str, body_text: str) -> str:
    """提取需要预先校验的 Ollama 推理模型名。"""
    if path not in LOCAL_MODEL_INFERENCE_PATHS or not body_text.strip():
        return ""
    try:
        payload = json.loads(body_text)
    except json.JSONDecodeError:
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("model") or "").strip()


def _extract_installed_model_names(payload: object) -> list[str]:
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        return []
    names: list[str] = []
    for item in payload["models"]:
        if not isinstance(item, dict):
            continue
        for field in ("name", "model"):
            value = str(item.get(field) or "").strip()
            if value and value not in names:
                names.append(value)
    return names


def _is_model_installed(model_name: str, installed_names: list[str]) -> bool:
    if model_name in installed_names:
        return True
    if ":" not in model_name and f"{model_name}:latest" in installed_names:
        return True
    return False


def _local_model_preflight_error(model_name: str, installed_names: list[str]) -> str:
    if not model_name:
        return ""
    if not installed_names:
        return (
            "无法执行本地模型请求：Ollama 当前没有已安装模型。"
            "请先前往“开源大语言模型”页面安装模型，再点击“恢复示例”重试。"
        )
    if not _is_model_installed(model_name, installed_names):
        available = "、".join(installed_names[:8])
        return (
            f"无法执行本地模型请求：模型 {model_name} 尚未安装。"
            f"当前可用模型：{available}。请点击“恢复示例”自动使用可用模型，或手动修改 model。"
        )
    return ""


def _is_local_model_target_allowed(base_url: str, path: str, trusted_base_url: str | None = None) -> bool:
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or not path.startswith("/api/"):
        return False
    if trusted_base_url:
        return base_url.rstrip("/") == trusted_base_url.rstrip("/")
    return parsed.hostname in {"localhost", "127.0.0.1", "::1"}


def _get_debug_timeout(is_local_model: bool) -> httpx.Timeout:
    read_timeout = LOCAL_MODEL_DEBUG_TIMEOUT_SECONDS if is_local_model else PLATFORM_DEBUG_TIMEOUT_SECONDS
    return httpx.Timeout(read_timeout, connect=10)


def _build_internal_backend_root(request: Request) -> str:
    """平台内部接口固定回环到当前 FastAPI 服务，避免公网 Host/端口被 Nginx 改写。"""
    server = request.scope.get("server") or ("127.0.0.1", 8000)
    host = server[0] or "127.0.0.1"
    port = server[1] or 8000
    if host in {"0.0.0.0", "::"}:
        host = "127.0.0.1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port}"


def _format_debug_http_error(status_code: int, target_url: str, response_text: str, *, is_local_model: bool = False) -> str:
    parts = [f"请求失败：HTTP {status_code}", f"目标地址：{target_url}"]
    if is_local_model and status_code == 404:
        lowered = response_text.lower()
        if "model" in lowered and ("not found" in lowered or "not exist" in lowered):
            parts[0] = "本地模型调用失败：请求中的模型尚未安装"
            parts.append("诊断：请点击“恢复示例”自动使用已安装模型，或先在“开源大语言模型”页面安装该模型。")
        else:
            parts.append("诊断：Ollama 未找到该接口。请确认 Ollama 版本支持当前 /api/* 路径。")
    if response_text.strip():
        snippet = response_text.strip().replace("\r\n", "\n")
        if len(snippet) > 800:
            snippet = f"{snippet[:800]}..."
        parts.append(f"响应摘要：{snippet}")
    return "\n".join(parts)


@router.get("/modules", response_model=ApiDocModuleListResponse, summary="获取接口文档模块列表")
async def get_modules(
    include_hidden: bool = False,
    include_endpoints: bool = True,
    current_user: dict | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
):
    if include_hidden and (not current_user or current_user.get("role") != "admin"):
        raise HTTPException(status_code=403, detail="隐藏接口模块仅管理员可查看")
    modules = await list_modules(db, include_hidden=include_hidden)
    if include_endpoints:
        for module in modules:
            await db.refresh(module, attribute_names=["endpoints"])
    return {
        "modules": [
            serialize_module(module, include_hidden=include_hidden, include_endpoints=include_endpoints)
            for module in modules
        ]
    }


@router.get("/catalog", response_model=ApiDocCatalogResponse, summary="分页查询帮助文档接口目录")
async def get_public_catalog(
    keyword: str = Query("", max_length=100),
    page: int = Query(1, ge=1),
    size: int = Query(5, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
):
    """为后台帮助页提供轻量目录，不加载每个模块的完整端点定义。"""
    await prepare_api_docs(db)
    visible_modules = ApiDocModule.is_visible.is_(True)
    visible_endpoints = ApiDocEndpoint.is_visible.is_(True)
    module_total = (await db.execute(
        select(func.count()).select_from(ApiDocModule).where(visible_modules)
    )).scalar() or 0
    endpoint_total = (await db.execute(
        select(func.count())
        .select_from(ApiDocEndpoint)
        .join(ApiDocModule, ApiDocModule.id == ApiDocEndpoint.module_id)
        .where(visible_endpoints, visible_modules)
    )).scalar() or 0
    endpoint_counts = (
        select(
            ApiDocEndpoint.module_id.label("module_id"),
            func.count(ApiDocEndpoint.id).label("endpoint_count"),
        )
        .where(visible_endpoints)
        .group_by(ApiDocEndpoint.module_id)
        .subquery()
    )
    filters = [visible_modules]
    if keyword.strip():
        term = f"%{keyword.strip()}%"
        filters.append(or_(
            ApiDocModule.title.ilike(term),
            ApiDocModule.subtitle.ilike(term),
            ApiDocModule.description.ilike(term),
            ApiDocModule.slug.ilike(term),
            cast(ApiDocModule.capability_tags, String).ilike(term),
        ))
    total = (await db.execute(
        select(func.count()).select_from(ApiDocModule).where(*filters)
    )).scalar() or 0
    page_count = _page_count(total, size)
    safe_page = min(page, page_count)
    rows = (await db.execute(
        select(ApiDocModule, endpoint_counts.c.endpoint_count)
        .outerjoin(endpoint_counts, endpoint_counts.c.module_id == ApiDocModule.id)
        .where(*filters)
        .order_by(ApiDocModule.sort_order, ApiDocModule.id)
        .offset((safe_page - 1) * size)
        .limit(size)
    )).all()
    return {
        "summary": {"module_total": module_total, "endpoint_total": endpoint_total},
        "items": [
            {
                "id": module.id,
                "slug": module.slug,
                "title": module.title,
                "subtitle": module.subtitle,
                "description": module.description,
                "endpoint_base": module.endpoint_base,
                "capability_tags": module.capability_tags or [],
                "endpoint_count": int(endpoint_count or 0),
            }
            for module, endpoint_count in rows
        ],
        "total": total,
        "page": safe_page,
        "size": size,
        "page_count": page_count,
    }


@router.get("/admin/overview", response_model=ApiDocAdminOverview, summary="接口文档配置概览")
async def get_admin_overview(
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    await prepare_api_docs(db)
    module_total = (await db.execute(select(func.count()).select_from(ApiDocModule))).scalar() or 0
    visible_module_total = (await db.execute(
        select(func.count()).select_from(ApiDocModule).where(ApiDocModule.is_visible.is_(True))
    )).scalar() or 0
    endpoint_total = (await db.execute(select(func.count()).select_from(ApiDocEndpoint))).scalar() or 0
    visible_endpoint_total = (await db.execute(
        select(func.count()).select_from(ApiDocEndpoint).where(ApiDocEndpoint.is_visible.is_(True))
    )).scalar() or 0
    manual_endpoint_total = (await db.execute(
        select(func.count()).select_from(ApiDocEndpoint).where(ApiDocEndpoint.source_type == "manual")
    )).scalar() or 0
    history_total = (await db.execute(select(func.count()).select_from(ApiDocSourceMeta))).scalar() or 0
    last_change = (await db.execute(
        select(ApiDocSourceMeta).order_by(ApiDocSourceMeta.imported_at.desc(), ApiDocSourceMeta.id.desc()).limit(1)
    )).scalar_one_or_none()
    return {
        "module_total": module_total,
        "visible_module_total": visible_module_total,
        "endpoint_total": endpoint_total,
        "visible_endpoint_total": visible_endpoint_total,
        "manual_endpoint_total": manual_endpoint_total,
        "history_total": history_total,
        "last_change_at": last_change.imported_at if last_change else None,
        "last_change_source": last_change.source_type if last_change else "",
    }


@router.get("/admin/modules", response_model=ApiDocModulePageResponse, summary="分页查询接口文档模块")
async def get_admin_modules(
    keyword: str = Query("", max_length=100),
    visibility: str = Query("all", pattern="^(all|visible|hidden)$"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    await prepare_api_docs(db)
    endpoint_counts = (
        select(
            ApiDocEndpoint.module_id.label("module_id"),
            func.count(ApiDocEndpoint.id).label("endpoint_count"),
            func.sum(case((ApiDocEndpoint.is_visible.is_(True), 1), else_=0)).label("visible_endpoint_count"),
        )
        .group_by(ApiDocEndpoint.module_id)
        .subquery()
    )
    filters = []
    if keyword.strip():
        term = f"%{keyword.strip()}%"
        filters.append(or_(ApiDocModule.title.ilike(term), ApiDocModule.slug.ilike(term), ApiDocModule.subtitle.ilike(term)))
    if visibility == "visible":
        filters.append(ApiDocModule.is_visible.is_(True))
    elif visibility == "hidden":
        filters.append(ApiDocModule.is_visible.is_(False))

    total_stmt = select(func.count()).select_from(ApiDocModule)
    if filters:
        total_stmt = total_stmt.where(*filters)
    total = (await db.execute(total_stmt)).scalar() or 0
    page_count = _page_count(total, size)
    safe_page = min(page, page_count)
    stmt = (
        select(ApiDocModule, endpoint_counts.c.endpoint_count, endpoint_counts.c.visible_endpoint_count)
        .outerjoin(endpoint_counts, endpoint_counts.c.module_id == ApiDocModule.id)
        .order_by(ApiDocModule.sort_order, ApiDocModule.id)
        .offset((safe_page - 1) * size)
        .limit(size)
    )
    if filters:
        stmt = stmt.where(*filters)
    rows = (await db.execute(stmt)).all()
    return {
        "items": [
            {
                "id": module.id,
                "slug": module.slug,
                "title": module.title,
                "subtitle": module.subtitle,
                "status": module.status,
                "source_type": module.source_type,
                "endpoint_base": module.endpoint_base,
                "sort_order": module.sort_order,
                "is_visible": module.is_visible,
                "endpoint_count": int(endpoint_count or 0),
                "visible_endpoint_count": int(visible_endpoint_count or 0),
                "updated_at": module.updated_at,
            }
            for module, endpoint_count, visible_endpoint_count in rows
        ],
        "total": total,
        "page": safe_page,
        "size": size,
        "page_count": page_count,
    }


@router.get("/admin/changes", response_model=ApiDocChangePageResponse, summary="分页查询接口文档变更历史")
async def get_admin_changes(
    target_type: str = Query(""),
    source_type: str = Query(""),
    keyword: str = Query("", max_length=100),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    filters = []
    if target_type:
        filters.append(ApiDocSourceMeta.target_type == target_type)
    if source_type:
        filters.append(ApiDocSourceMeta.source_type == source_type)
    if keyword.strip():
        term = f"%{keyword.strip()}%"
        module_name_matches = select(ApiDocModule.id).where(
            ApiDocModule.slug == ApiDocSourceMeta.target_ref,
            ApiDocModule.title.ilike(term),
        ).exists()
        endpoint_name_matches = select(ApiDocEndpoint.id).where(
            ApiDocEndpoint.slug == ApiDocSourceMeta.target_ref,
            ApiDocEndpoint.summary.ilike(term),
        ).exists()
        filters.append(or_(
            ApiDocSourceMeta.target_ref.ilike(term),
            ApiDocSourceMeta.source_ref.ilike(term),
            ApiDocSourceMeta.note.ilike(term),
            module_name_matches,
            endpoint_name_matches,
        ))

    raw_total_stmt = select(func.count()).select_from(ApiDocSourceMeta)
    if filters:
        raw_total_stmt = raw_total_stmt.where(*filters)
    raw_total = (await db.execute(raw_total_stmt)).scalar() or 0

    grouped = select(
        func.max(ApiDocSourceMeta.id).label("id"),
        ApiDocSourceMeta.target_type.label("target_type"),
        ApiDocSourceMeta.target_ref.label("target_ref"),
        ApiDocSourceMeta.source_type.label("source_type"),
        ApiDocSourceMeta.source_ref.label("source_ref"),
        ApiDocSourceMeta.import_strategy.label("import_strategy"),
        ApiDocSourceMeta.note.label("note"),
        ApiDocSourceMeta.imported_at.label("imported_at"),
        func.count(ApiDocSourceMeta.id).label("repeat_count"),
    )
    if filters:
        grouped = grouped.where(*filters)
    grouped = grouped.group_by(
        ApiDocSourceMeta.target_type,
        ApiDocSourceMeta.target_ref,
        ApiDocSourceMeta.source_type,
        ApiDocSourceMeta.source_ref,
        ApiDocSourceMeta.import_strategy,
        ApiDocSourceMeta.note,
        ApiDocSourceMeta.imported_at,
    ).subquery()

    total = (await db.execute(select(func.count()).select_from(grouped))).scalar() or 0
    page_count = _page_count(total, size)
    safe_page = min(page, page_count)
    rows = (await db.execute(
        select(grouped)
        .order_by(grouped.c.imported_at.desc(), grouped.c.id.desc())
        .offset((safe_page - 1) * size)
        .limit(size)
    )).all()

    module_refs = {row.target_ref for row in rows if row.target_type == "module"}
    endpoint_refs = {row.target_ref for row in rows if row.target_type == "endpoint"}
    module_labels = dict((await db.execute(
        select(ApiDocModule.slug, ApiDocModule.title).where(ApiDocModule.slug.in_(module_refs))
    )).all()) if module_refs else {}
    endpoint_labels = dict((await db.execute(
        select(ApiDocEndpoint.slug, ApiDocEndpoint.summary).where(ApiDocEndpoint.slug.in_(endpoint_refs))
    )).all()) if endpoint_refs else {}

    return {
        "items": [
            {
                "id": row.id,
                "target_type": row.target_type,
                "target_ref": row.target_ref,
                "target_label": _change_target_label(
                    row.target_type, row.target_ref, module_labels, endpoint_labels,
                ),
                "source_type": row.source_type,
                "source_ref": row.source_ref,
                "import_strategy": row.import_strategy,
                "note": row.note,
                "imported_at": row.imported_at,
                "repeat_count": row.repeat_count,
            }
            for row in rows
        ],
        "total": total,
        "raw_total": raw_total,
        "page": safe_page,
        "size": size,
        "page_count": page_count,
    }


@router.get("/admin/modules/{module_ref}", response_model=ApiDocModuleResponse, summary="获取接口文档模块配置")
async def get_admin_module_detail(
    module_ref: str,
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    filters = [ApiDocModule.slug == module_ref]
    if module_ref.isdigit():
        filters = [or_(ApiDocModule.slug == module_ref, ApiDocModule.id == int(module_ref))]
    module = (await db.execute(select(ApiDocModule).where(*filters))).scalar_one_or_none()
    if not module:
        raise HTTPException(status_code=404, detail="接口模块不存在")
    return serialize_module(module, include_hidden=True, include_endpoints=False)


@router.post("/modules", response_model=ApiDocModuleResponse, summary="创建接口文档模块")
async def create_module(
    body: ApiDocModuleCreate,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    slug = _validate_slug(body.slug, "模块 Slug")
    if not body.title.strip():
        raise HTTPException(status_code=422, detail="模块名称不能为空")
    duplicate = (await db.execute(select(ApiDocModule.id).where(ApiDocModule.slug == slug))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail="模块 Slug 已存在")
    module = ApiDocModule(
        slug=slug,
        title=body.title.strip(),
        subtitle=body.subtitle,
        description=body.description,
        markdown_content=body.markdown_content,
        status="configured",
        source_type="manual",
        renderer_type="api-reference",
        endpoint_base="",
        sort_order=body.sort_order,
        is_visible=body.is_visible,
        capability_tags=[],
        highlights=[],
        groups=[{"id": "overview", "label": "默认分组"}],
        playground={
            "title": f"{body.title}调试台",
            "targetLabel": "接口调用调试",
            "statusLabel": "接口示例",
            "note": "当前用于配置接口文档、请求参数和响应示例。",
            "fields": [],
            "presets": [],
        },
    )
    db.add(module)
    await db.flush()
    await record_source_meta(
        db,
        target_type="module",
        target_ref=module.slug,
        source_type="manual",
        source_ref="api-console",
        import_strategy="create",
        note="后台手工创建接口模块",
    )
    _record_api_doc_operation(db, admin, action="创建模块", target_type="module", target_ref=module.slug)
    return serialize_module(module)


@router.get("/modules/{module_ref}", response_model=ApiDocModuleResponse, summary="获取接口文档模块详情")
async def get_module_detail(
    module_ref: str,
    include_hidden: bool = False,
    current_user: dict | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
):
    if include_hidden and (not current_user or current_user.get("role") != "admin"):
        raise HTTPException(status_code=403, detail="隐藏接口模块仅管理员可查看")
    await prepare_api_docs(db)
    module = await get_module_by_ref(db, module_ref)
    if not module or (not include_hidden and not module.is_visible):
        raise HTTPException(status_code=404, detail="接口模块不存在")
    await db.refresh(module, attribute_names=["endpoints"])
    return serialize_module(module, include_hidden=include_hidden)


@router.put("/modules/{module_ref}", response_model=ApiDocModuleResponse, summary="更新接口文档模块")
async def update_module(
    module_ref: str,
    body: ApiDocModuleUpdate,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    module = await get_module_by_ref(db, module_ref)
    if not module:
        raise HTTPException(status_code=404, detail="接口模块不存在")

    payload = body.model_dump(exclude_unset=True, by_alias=False)
    old_slug = module.slug
    if "slug" in payload:
        payload["slug"] = _validate_slug(payload["slug"], "模块 Slug")
        duplicate = (await db.execute(
            select(ApiDocModule.id).where(ApiDocModule.slug == payload["slug"], ApiDocModule.id != module.id)
        )).scalar_one_or_none()
        if duplicate:
            raise HTTPException(status_code=409, detail="模块 Slug 已存在")
    if "title" in payload:
        payload["title"] = payload["title"].strip()
        if not payload["title"]:
            raise HTTPException(status_code=422, detail="模块名称不能为空")
    for key, value in payload.items():
        setattr(module, key, value)
    module.source_type = "manual"
    await record_source_meta(
        db,
        target_type="module",
        target_ref=module.slug,
        source_type="manual",
        source_ref="api-console",
        import_strategy="update",
        note="后台手工更新模块配置",
    )
    _record_api_doc_operation(
        db,
        admin,
        action="更新模块",
        target_type="module",
        target_ref=module.slug,
        note=f"old_slug={old_slug}",
    )
    await db.flush()
    await db.refresh(module, attribute_names=["endpoints"])
    return serialize_module(module, include_hidden=True)


@router.delete("/modules/{module_ref}", response_model=ApiDocActionResponse, summary="删除接口文档模块")
async def delete_module(
    module_ref: str,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    module = await get_module_by_ref(db, module_ref)
    if not module:
        raise HTTPException(status_code=404, detail="接口模块不存在")
    endpoint_count = len(module.endpoints)
    _record_api_doc_operation(
        db,
        admin,
        action="删除模块",
        target_type="module",
        target_ref=module.slug,
        note=f"endpoint_count={endpoint_count}",
    )
    await record_source_meta(
        db,
        target_type="module",
        target_ref=module.slug,
        source_type="manual",
        source_ref="api-console",
        import_strategy="delete",
        note=f"后台删除接口模块及其 {endpoint_count} 个端点",
    )
    await db.delete(module)
    return {"success": True, "message": "模块已删除"}


@router.post("/modules/{module_ref}/markdown-import", response_model=ApiDocModuleResponse, summary="导入模块 Markdown")
async def import_markdown(
    module_ref: str,
    markdown_text: str | None = Form(None),
    append: bool = Form(False),
    file: UploadFile | None = File(None),
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    module = await get_module_by_ref(db, module_ref)
    if not module:
        raise HTTPException(status_code=404, detail="接口模块不存在")

    content = await _read_markdown_import(file, markdown_text)

    module.markdown_content = f"{module.markdown_content.rstrip()}\n\n{content.strip()}" if append and module.markdown_content else content.strip()
    module.source_type = "manual"
    await record_source_meta(
        db,
        target_type="module",
        target_ref=module.slug,
        source_type="markdown",
        source_ref=file.filename if file else "textarea",
        import_strategy="append" if append else "replace",
        note="通过接口控制台导入模块 Markdown",
    )
    _record_api_doc_operation(
        db,
        admin,
        action="导入 Markdown",
        target_type="module",
        target_ref=module.slug,
        note=f"strategy={'append' if append else 'replace'}; bytes={len(content.encode('utf-8'))}",
    )
    await db.flush()
    await db.refresh(module, attribute_names=["endpoints"])
    return serialize_module(module, include_hidden=True)


@router.post("/import/openapi", response_model=OpenApiImportResponse, summary="从当前项目 OpenAPI 导入接口")
async def import_openapi(
    body: OpenApiImportRequest,
    request: Request,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    openapi = request.app.openapi()
    result = await import_openapi_spec(db, openapi, refresh_existing=body.refresh_existing)
    _record_api_doc_operation(
        db,
        admin,
        action="导入 OpenAPI",
        target_type="import",
        target_ref="project-openapi",
        note="; ".join(f"{key}={value}" for key, value in result.items()),
    )
    return result


@router.get("/modules/{module_ref}/endpoints", response_model=list[ApiDocEndpointResponse], summary="获取模块接口列表")
async def get_module_endpoints(
    module_ref: str,
    include_hidden: bool = False,
    current_user: dict | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
):
    if include_hidden and (not current_user or current_user.get("role") != "admin"):
        raise HTTPException(status_code=403, detail="隐藏接口仅管理员可查看")
    await prepare_api_docs(db)
    module = await get_module_by_ref(db, module_ref)
    if not module:
        raise HTTPException(status_code=404, detail="接口模块不存在")
    await db.refresh(module, attribute_names=["endpoints"])
    endpoints = sorted(module.endpoints, key=lambda item: (item.sort_order, item.id))
    if not include_hidden:
        endpoints = [endpoint for endpoint in endpoints if endpoint.is_visible]
    return [serialize_endpoint(endpoint) for endpoint in endpoints]


@router.get("/admin/modules/{module_ref}/endpoints", response_model=ApiDocEndpointPageResponse, summary="分页查询模块接口")
async def get_admin_module_endpoints(
    module_ref: str,
    keyword: str = Query("", max_length=100),
    method: str = Query(""),
    group: str = Query(""),
    visibility: str = Query("all", pattern="^(all|visible|hidden)$"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    _admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    module = await get_module_by_ref(db, module_ref)
    if not module:
        raise HTTPException(status_code=404, detail="接口模块不存在")
    filters = [ApiDocEndpoint.module_id == module.id]
    if keyword.strip():
        term = f"%{keyword.strip()}%"
        filters.append(or_(ApiDocEndpoint.summary.ilike(term), ApiDocEndpoint.path.ilike(term), ApiDocEndpoint.slug.ilike(term)))
    if method:
        filters.append(ApiDocEndpoint.method == _normalize_method(method))
    if group:
        filters.append(ApiDocEndpoint.group_key == group)
    if visibility == "visible":
        filters.append(ApiDocEndpoint.is_visible.is_(True))
    elif visibility == "hidden":
        filters.append(ApiDocEndpoint.is_visible.is_(False))
    total = (await db.execute(select(func.count()).select_from(ApiDocEndpoint).where(*filters))).scalar() or 0
    page_count = _page_count(total, size)
    safe_page = min(page, page_count)
    items = (await db.execute(
        select(ApiDocEndpoint)
        .where(*filters)
        .order_by(ApiDocEndpoint.sort_order, ApiDocEndpoint.id)
        .offset((safe_page - 1) * size)
        .limit(size)
    )).scalars().all()
    group_values = (await db.execute(
        select(ApiDocEndpoint.group_key).where(ApiDocEndpoint.module_id == module.id).distinct().order_by(ApiDocEndpoint.group_key)
    )).scalars().all()
    method_values = (await db.execute(
        select(ApiDocEndpoint.method).where(ApiDocEndpoint.module_id == module.id).distinct().order_by(ApiDocEndpoint.method)
    )).scalars().all()
    return {
        "items": [serialize_endpoint(item) for item in items],
        "total": total,
        "page": safe_page,
        "size": size,
        "page_count": page_count,
        "available_filters": {"groups": group_values, "methods": method_values},
    }


@router.post("/modules/{module_ref}/endpoints", response_model=ApiDocEndpointResponse, summary="创建接口端点")
async def create_endpoint(
    module_ref: str,
    body: ApiDocEndpointCreate,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    module = await get_module_by_ref(db, module_ref)
    if not module:
        raise HTTPException(status_code=404, detail="接口模块不存在")
    slug = _validate_slug(body.slug, "接口 Slug")
    if not body.summary.strip() or not body.path.strip().startswith("/"):
        raise HTTPException(status_code=422, detail="接口摘要不能为空，路径必须以 / 开头")
    duplicate = (await db.execute(select(ApiDocEndpoint.id).where(ApiDocEndpoint.slug == slug))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail="当前模块已存在相同接口 Slug")
    endpoint = ApiDocEndpoint(
        module_id=module.id,
        slug=slug,
        group_key=body.group.strip() or "overview",
        method=_normalize_method(body.method),
        path=body.path.strip(),
        summary=body.summary.strip(),
        description=body.description.strip(),
        source_type="manual",
        source_identifier=f"manual:{module.id}:{slug}",
        sort_order=body.sort_order,
        is_visible=body.is_visible,
        tags=body.tags,
        params=[item.model_dump(by_alias=True) for item in body.params],
        responses=[item.model_dump(by_alias=True) for item in body.responses],
        notes=body.notes,
        code_samples=[item.model_dump(by_alias=True) for item in body.code_samples],
        request_preview=body.request_preview,
        response_body=body.response_body,
        response_meta=body.response_meta,
    )
    db.add(endpoint)
    await db.flush()
    await record_source_meta(
        db,
        target_type="endpoint",
        target_ref=endpoint.slug,
        source_type="manual",
        source_ref="api-console",
        import_strategy="create",
        note=f"在模块 {module.slug} 中创建接口端点",
    )
    _record_api_doc_operation(db, admin, action="创建接口", target_type="endpoint", target_ref=endpoint.slug, note=f"module={module.slug}")
    return serialize_endpoint(endpoint)


@router.post("/debugger/execute", response_model=ApiDocDebuggerExecuteResponse, summary="执行接口文档调试请求")
async def execute_debugger_request(
    body: ApiDocDebuggerExecuteRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    module = await get_module_by_ref(db, body.module_slug)
    endpoint = await get_endpoint_by_ref(db, body.endpoint_slug)
    if not module or not endpoint or endpoint.module_id != module.id:
        raise HTTPException(status_code=404, detail="接口调试目标不存在")

    if any("file" in str(param.get("type", "")).lower() or "upload" in str(param.get("type", "")).lower() or "binary" in str(param.get("type", "")).lower() for param in endpoint.params or []):
        raise HTTPException(status_code=400, detail="当前调试器暂不支持文件上传或二进制接口")

    method = body.method.upper()
    if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        raise HTTPException(status_code=400, detail="不支持的 HTTP 方法")
    if method != endpoint.method.upper() or body.path != endpoint.path:
        raise HTTPException(status_code=400, detail="请求方法或路径与接口文档不一致")
    if _requires_debugger_confirmation(module.slug, method, endpoint.path) and not body.confirm_risky_execution:
        raise HTTPException(status_code=409, detail="当前接口可能改变设备、模型、配置或业务数据，请在调试器中确认后再执行")

    resolved_path = _replace_path_params(endpoint.path, _compact_values(body.path_params))
    if re.search(r'\{[^}]+\}', resolved_path):
        missing = re.findall(r'\{([^}]+)\}', resolved_path)
        raise HTTPException(status_code=400, detail=f"路径参数未填写完整，请在「路径参数」标签页填写以下参数：{', '.join(missing)}")
    query_params = _compact_values(body.query_params)
    forwarded_authorization = "" if module.slug == "local-model" else request.headers.get("authorization", "")
    headers = _apply_auth_headers(_compact_values(body.headers), body, forwarded_authorization)
    request_body_text = body.body_text.strip()
    if method in {"POST", "PUT", "PATCH", "DELETE"} and request_body_text and "Content-Type" not in headers and "content-type" not in {key.lower(): value for key, value in headers.items()}:
        headers["Content-Type"] = "application/json"

    if module.slug == "local-model":
        runtime = await get_runtime_config(db)
        base_url = runtime.ollama_base_url.strip() or module.endpoint_base or "http://localhost:11434"
        if not _is_local_model_target_allowed(base_url, resolved_path, runtime.ollama_base_url):
            raise HTTPException(status_code=500, detail="系统 Ollama 地址配置无效，请在系统设置中检查")
        target_url = f"{base_url.rstrip('/')}{resolved_path}"
    else:
        if not resolved_path.startswith("/api/v1/"):
            raise HTTPException(status_code=400, detail="当前调试器仅允许平台 /api/v1/* 接口或本地模型接口")
        backend_root = _build_internal_backend_root(request)
        target_url = f"{backend_root}{resolved_path}"

    started_at = time.perf_counter()
    display_headers = _redact_sensitive_headers(headers)
    curl_command = _build_curl_command(method, target_url, display_headers, request_body_text)
    request_snapshot = {
        "method": method,
        "url": target_url,
        "headers": display_headers,
        "query_params": query_params,
        "body": request_body_text,
    }

    try:
        # Ollama 推理可能包含模型冷启动，读取超时需高于普通平台接口。
        async with httpx.AsyncClient(
            timeout=_get_debug_timeout(module.slug == "local-model"),
            trust_env=False,
        ) as client:
            requested_model = _extract_local_model_name(resolved_path, request_body_text)
            if module.slug == "local-model" and requested_model:
                tags_response = await client.get(f"{base_url.rstrip('/')}/api/tags")
                if tags_response.is_success:
                    installed_names = _extract_installed_model_names(tags_response.json())
                    preflight_error = _local_model_preflight_error(requested_model, installed_names)
                    if preflight_error:
                        duration_ms = round((time.perf_counter() - started_at) * 1000)
                        return {
                            "success": False,
                            "status_code": None,
                            "duration_ms": duration_ms,
                            "response_headers": {},
                            "response_body": None,
                            "request_snapshot": request_snapshot,
                            "curl_command": curl_command,
                            "error": preflight_error,
                        }
            response = await client.request(
                method,
                target_url,
                params=query_params,
                headers=headers,
                content=request_body_text if request_body_text and method != "GET" else None,
            )
        duration_ms = round((time.perf_counter() - started_at) * 1000)
        response_text = response.text
        response_body = _parse_response_body(response.headers.get("content-type", ""), response_text)
        error = "" if response.is_success else _format_debug_http_error(
            response.status_code,
            target_url,
            response_text,
            is_local_model=module.slug == "local-model",
        )
        return {
            "success": response.is_success,
            "status_code": response.status_code,
            "duration_ms": duration_ms,
            "response_headers": dict(response.headers),
            "response_body": response_body,
            "request_snapshot": request_snapshot,
            "curl_command": curl_command,
            "error": error,
        }
    except httpx.ConnectError:
        duration_ms = round((time.perf_counter() - started_at) * 1000)
        hint = "Ollama 服务未启动或系统配置地址不可达" if module.slug == "local-model" else "目标后端服务不可达"
        return {
            "success": False,
            "status_code": None,
            "duration_ms": duration_ms,
            "response_headers": {},
            "response_body": None,
            "request_snapshot": request_snapshot,
            "curl_command": curl_command,
            "error": f"连接失败：{hint}",
        }
    except httpx.TimeoutException:
        duration_ms = round((time.perf_counter() - started_at) * 1000)
        timeout_seconds = (
            LOCAL_MODEL_DEBUG_TIMEOUT_SECONDS
            if module.slug == "local-model"
            else PLATFORM_DEBUG_TIMEOUT_SECONDS
        )
        return {
            "success": False,
            "status_code": None,
            "duration_ms": duration_ms,
            "response_headers": {},
            "response_body": None,
            "request_snapshot": request_snapshot,
            "curl_command": curl_command,
            "error": f"请求超过 {timeout_seconds} 秒，请检查目标服务状态、模型负载或网络连通性",
        }
    except httpx.HTTPError as exc:
        duration_ms = round((time.perf_counter() - started_at) * 1000)
        return {
            "success": False,
            "status_code": None,
            "duration_ms": duration_ms,
            "response_headers": {},
            "response_body": None,
            "request_snapshot": request_snapshot,
            "curl_command": curl_command,
            "error": f"调试请求失败：{exc}",
        }


@router.get("/debugger/runtime", summary="获取接口调试运行环境")
async def get_debugger_runtime(
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    runtime = await get_runtime_config(db)
    return {"local_model_base_url": runtime.ollama_base_url.rstrip("/")}


@router.put("/endpoints/{endpoint_ref}", response_model=ApiDocEndpointResponse, summary="更新接口端点配置")
async def update_endpoint(
    endpoint_ref: str,
    body: ApiDocEndpointUpdate,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    endpoint = await get_endpoint_by_ref(db, endpoint_ref)
    if not endpoint:
        raise HTTPException(status_code=404, detail="接口端点不存在")

    payload = body.model_dump(exclude_unset=True, by_alias=False)
    if "slug" in payload:
        payload["slug"] = _validate_slug(payload["slug"], "接口 Slug")
        duplicate = (await db.execute(
            select(ApiDocEndpoint.id).where(ApiDocEndpoint.slug == payload["slug"], ApiDocEndpoint.id != endpoint.id)
        )).scalar_one_or_none()
        if duplicate:
            raise HTTPException(status_code=409, detail="当前模块已存在相同接口 Slug")
    if "method" in payload:
        payload["method"] = _normalize_method(payload["method"])
    if "path" in payload:
        payload["path"] = payload["path"].strip()
        if not payload["path"].startswith("/"):
            raise HTTPException(status_code=422, detail="接口路径必须以 / 开头")
    if "summary" in payload:
        payload["summary"] = payload["summary"].strip()
        if not payload["summary"]:
            raise HTTPException(status_code=422, detail="接口摘要不能为空")
    if "group" in payload:
        payload["group_key"] = payload.pop("group")
    old_slug = endpoint.slug
    for key, value in payload.items():
        setattr(endpoint, key, value)
    endpoint.source_type = "manual"
    await record_source_meta(
        db,
        target_type="endpoint",
        target_ref=endpoint.slug,
        source_type="manual",
        source_ref="api-console",
        import_strategy="update",
        note="后台手工更新接口端点配置",
    )
    _record_api_doc_operation(
        db,
        admin,
        action="更新接口",
        target_type="endpoint",
        target_ref=endpoint.slug,
        note=f"old_slug={old_slug}; module_id={endpoint.module_id}",
    )
    await db.flush()
    return serialize_endpoint(endpoint)


@router.delete("/endpoints/{endpoint_ref}", response_model=ApiDocActionResponse, summary="删除接口端点")
async def delete_endpoint(
    endpoint_ref: str,
    admin: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    endpoint = await get_endpoint_by_ref(db, endpoint_ref)
    if not endpoint:
        raise HTTPException(status_code=404, detail="接口端点不存在")
    if endpoint.source_type != "manual":
        raise HTTPException(status_code=409, detail="受管接口不能直接删除，请将其设为隐藏；重新导入时仍可恢复来源数据")
    _record_api_doc_operation(
        db,
        admin,
        action="删除接口",
        target_type="endpoint",
        target_ref=endpoint.slug,
        note=f"module_id={endpoint.module_id}; source_type={endpoint.source_type}",
    )
    await record_source_meta(
        db,
        target_type="endpoint",
        target_ref=endpoint.slug,
        source_type="manual",
        source_ref="api-console",
        import_strategy="delete",
        note=f"从模块 {endpoint.module_id} 删除手工接口端点",
    )
    await db.delete(endpoint)
    return {"success": True, "message": "接口已删除"}
