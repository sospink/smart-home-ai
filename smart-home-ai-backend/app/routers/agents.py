"""
智能体运行与管理框架聚合接口
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import math
from pathlib import Path
import re
import time
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy import String, and_, case, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, require_admin
from app.models.agent_instance import AgentInstance
from app.models.agent_template_library import AgentTemplateLibrary
from app.models.operation_log import OperationLog
from app.schemas.agents import (
    AgentCapabilitiesResponse,
    AgentFrameworkOverview,
    AgentImportToDifyResponse,
    AgentInstanceCreate,
    AgentInstanceListResponse,
    AgentInstanceListSummary,
    AgentLastRunEvidence,
    AgentInstanceResponse,
    AgentRuntimeEvidence,
    AgentInstanceUpdate,
    AgentRunListResponse,
    AgentRunListSummary,
    AgentRunRecord,
    AgentTestRunRequest,
    AgentTestRunResponse,
    AgentTemplateDoc,
    AgentTemplateLibraryDetail,
    AgentTemplateLibraryItem,
    AgentTemplateLibraryListResponse,
    AgentTemplateLibraryListSummary,
    AgentTemplateLibraryUpdate,
    AgentTemplateLibraryUploadResponse,
    AgentUploadDslResponse,
)
from app.services.dify import DifyService
from app.services.agent_framework import (
    DEFAULT_AGENT_BUSINESS_NAME,
    agent_callable_condition,
    agent_template_reference_condition,
    derive_dify_base_url,
    ensure_seed_instances,
    get_agent_business_description,
    get_agent_business_name,
    get_legacy_agent_business_name,
    get_capabilities_payload,
    get_overview_payload,
    get_template_by_id,
    get_template_docs,
    parse_dsl_content,
    sanitize_dsl_storage,
)
from app.services.runtime_settings import get_runtime_config

router = APIRouter(prefix="/agents", tags=["智能体运行与管理框架"])

BUILTIN_TEMPLATE_LIBRARY_ID = "builtin-template-00"
TEMPLATE_DESCRIPTION_PLACEHOLDERS = {"", "未填写描述", "暂无用途说明"}
TEMPLATE_MODE_LABELS = {
    "advanced-chat": "对话流",
    "chat": "聊天助手",
    "completion": "文本生成应用",
    "workflow": "工作流",
}
TEMPLATE_MODE_SEARCH_VALUES = {
    "对话流": ("advanced-chat", "chat"),
    "聊天助手": ("chat",),
    "文本生成应用": ("completion",),
    "工作流": ("workflow",),
}
TEMPLATE_TECHNICAL_TAGS = {"app", "dsl", "yaml", "yml", "内置模板", "上传模板"}
BUILTIN_TEMPLATE_FILE = "00 Smart Home Unified Chatflow.yml"
RUNTIME_EVIDENCE_TTL_SECONDS = 30
_runtime_evidence_cache: dict[str, tuple[float, AgentRuntimeEvidence]] = {}
TEMPLATE_LIBRARY_CACHE_TTL_SECONDS = 30
AGENT_TEST_TIMEOUT_SECONDS = 45
MAX_AGENT_DSL_FILE_SIZE = 2 * 1024 * 1024


def _utcnow() -> datetime:
    """返回与现有 MySQL DATETIME 字段兼容的 UTC 无时区时间。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return normalized or "agent-instance"


async def _get_instance_or_404(db: AsyncSession, instance_id: int) -> AgentInstance:
    instance = await db.get(AgentInstance, instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="智能体实例不存在")
    return instance


async def _ensure_unique_slug(
    db: AsyncSession,
    base_slug: str,
    *,
    exclude_instance_id: int | None = None,
) -> str:
    slug = base_slug
    suffix = 1
    while True:
        stmt = select(AgentInstance).where(AgentInstance.slug == slug)
        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()
        if not existing or (exclude_instance_id is not None and existing.id == exclude_instance_id):
            return slug
        suffix += 1
        slug = f"{base_slug}-{suffix}"


def _to_response(
    instance: AgentInstance,
    *,
    include_dsl: bool = True,
    include_secret_metadata: bool = True,
    runtime: AgentRuntimeEvidence | None = None,
    last_run: AgentLastRunEvidence | None = None,
) -> AgentInstanceResponse:
    response = AgentInstanceResponse.model_validate(instance, from_attributes=True)
    has_key = bool((getattr(instance, "dify_api_key", "") or "").strip())
    console_url = (response.dify_console_url or "").strip() if include_secret_metadata else ""
    if console_url and "/app/" not in console_url and not (response.dify_app_id or "").strip():
        console_url = ""
    return response.model_copy(update={
        "business_name": get_agent_business_name(instance),
        "business_description": get_agent_business_description(instance),
        "dsl_content": response.dsl_content if include_dsl else "",
        "has_dify_api_key": has_key,
        "dify_api_key_masked": _mask_secret(instance.dify_api_key) if has_key and include_secret_metadata else "",
        "dify_console_url": console_url,
        "runtime": runtime or AgentRuntimeEvidence(),
        "last_run": last_run or AgentLastRunEvidence(),
    })


def _agent_run_scope_conditions(current_user: dict, *extra_conditions):
    conditions = [OperationLog.type == "agent_test", *extra_conditions]
    if current_user.get("role") != "admin":
        conditions.append(OperationLog.user_id == current_user.get("user_id"))
    return conditions


def _mask_secret(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if len(value) <= 10:
        return f"{value[:2]}***{value[-2:]}"
    return f"{value[:7]}***{value[-4:]}"


def _is_masked_secret(value: str | None) -> bool:
    text = (value or "").strip()
    return not text or "*" in text or "•" in text


def _extract_detail_value(detail: str, key: str) -> str:
    pattern = rf"(?:^|,\s*){re.escape(key)}=(.*?)(?=,\s*[a-zA-Z_][a-zA-Z0-9_]*=|$)"
    match = re.search(pattern, detail or "", flags=re.DOTALL)
    return match.group(1).strip() if match else ""


def _instance_id_from_log(row: OperationLog) -> int | None:
    entity_id = row.entity_id or ""
    if entity_id.startswith("agent:") and entity_id[6:].isdigit():
        return int(entity_id[6:])
    raw = _extract_detail_value(row.detail or "", "instance_id")
    return int(raw) if raw.isdigit() else None


def _run_record(
    row: OperationLog,
    business_names: dict[int, str] | None = None,
) -> AgentRunRecord:
    detail = row.detail or ""
    instance_id = _instance_id_from_log(row)
    title = row.title or "智能体测试记录"
    instance_name = _extract_detail_value(detail, "instance_name")
    if not instance_name:
        instance_name = title.split("：", 1)[-1].strip() if "：" in title else ""
    return AgentRunRecord(
        id=row.id,
        instance_id=instance_id,
        instance_name=instance_name,
        business_name=(business_names or {}).get(
            instance_id or 0,
            get_legacy_agent_business_name(instance_name),
        ),
        status="success" if row.level == "success" else "failed" if row.level == "error" else row.level,
        title=title,
        query=_extract_detail_value(detail, "query"),
        answer=_extract_detail_value(detail, "answer"),
        message_id=_extract_detail_value(detail, "message_id"),
        workflow_run_id=_extract_detail_value(detail, "workflow_run_id"),
        error=_extract_detail_value(detail, "error"),
        username=row.username or "",
        created_at=row.created_at,
    )


def _last_run_evidence(row: OperationLog | None) -> AgentLastRunEvidence:
    if row is None:
        return AgentLastRunEvidence()
    record = _run_record(row)
    return AgentLastRunEvidence(
        status=record.status,
        title=record.title,
        query=record.query,
        message_id=record.message_id,
        workflow_run_id=record.workflow_run_id,
        error=record.error,
        created_at=record.created_at,
    )


def _normalized_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "", (value or "").lower())


async def _get_runtime_evidence(
    instance: AgentInstance,
    runtime_config,
    *,
    force: bool = False,
) -> AgentRuntimeEvidence:
    instance_key = (instance.dify_api_key or "").strip()
    fallback_key = runtime_config.dify_api_key if instance.is_default else ""
    api_key = instance_key or fallback_key
    base_url = derive_dify_base_url(instance.dify_console_url) or runtime_config.dify_base_url.rstrip("/")
    binding_status = (
        "instance_key" if instance_key
        else "system_runtime_fallback" if fallback_key
        else "unconfigured"
    )
    checked_at = _utcnow()

    if not instance.enabled:
        return AgentRuntimeEvidence(
            status="disabled",
            binding_status=binding_status,
            base_url=base_url,
            checked_at=checked_at,
        )
    if not api_key or not base_url:
        return AgentRuntimeEvidence(
            status="unconfigured",
            binding_status=binding_status,
            base_url=base_url,
            checked_at=checked_at,
            error="未配置可用于该实例的 Dify 应用 API 密钥" if not api_key else "Dify 基础地址未配置",
        )

    signature = hashlib.sha256(f"{instance.id}|{base_url}|{api_key}".encode()).hexdigest()
    cached = _runtime_evidence_cache.get(signature)
    if not force and cached and cached[0] > time.monotonic():
        return cached[1]

    started = time.perf_counter()
    try:
        payload = await DifyService(base_url=base_url, api_key=api_key).get_app_info()
        latency_ms = int((time.perf_counter() - started) * 1000)
        app_name = str(payload.get("name") or "")
        expected = _normalized_name(instance.name)
        actual = _normalized_name(app_name)
        name_matches = bool(expected and actual and (expected in actual or actual in expected))
        evidence = AgentRuntimeEvidence(
            status="running" if name_matches else "mismatch",
            binding_status=binding_status,
            app_name=app_name,
            app_mode=str(payload.get("mode") or ""),
            base_url=base_url,
            latency_ms=latency_ms,
            checked_at=_utcnow(),
            error="" if name_matches else "API 密钥对应的 Dify 应用名称与平台实例不一致",
            name_matches=name_matches,
        )
    except Exception as exc:
        evidence = AgentRuntimeEvidence(
            status="unavailable",
            binding_status=binding_status,
            base_url=base_url,
            latency_ms=int((time.perf_counter() - started) * 1000),
            checked_at=_utcnow(),
            error=str(exc)[:300],
        )
    _runtime_evidence_cache[signature] = (time.monotonic() + RUNTIME_EVIDENCE_TTL_SECONDS, evidence)
    return evidence


def _invalidate_runtime_evidence() -> None:
    _runtime_evidence_cache.clear()


def _safe_download_name(file_name: str) -> str:
    value = Path(file_name or "template.yml").name
    return value if value.lower().endswith((".yml", ".yaml")) else f"{value}.yml"


async def _read_agent_dsl_upload(file: UploadFile) -> str:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".yml", ".yaml"}:
        raise HTTPException(status_code=400, detail="仅支持上传 .yml 或 .yaml DSL 文件")
    raw_bytes = await file.read(MAX_AGENT_DSL_FILE_SIZE + 1)
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="DSL 文件不能为空")
    if len(raw_bytes) > MAX_AGENT_DSL_FILE_SIZE:
        raise HTTPException(status_code=413, detail="DSL 文件不能超过 2MB")
    try:
        return raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="DSL 文件必须使用 UTF-8 编码") from exc


def _parse_template_library_metadata(raw_text: str, file_name: str) -> dict:
    try:
        parsed = parse_dsl_content(raw_text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    name = (parsed.get("name") or Path(file_name).stem or "未命名模板").strip()
    description = (parsed.get("description") or "DSL 未提供用途说明").strip()
    tags: list[str] = []
    for value in [parsed.get("mode")]:
        normalized = TEMPLATE_MODE_LABELS.get(str(value).strip().lower(), str(value).strip()) if value else ""
        if normalized and normalized not in tags:
            tags.append(normalized)
    if "DSL" not in tags:
        tags.append("DSL")
    return {"name": name, "description": description, "tags": tags, "parsed": parsed}


def _builtin_template_library_detail() -> AgentTemplateLibraryDetail:
    template_path = Path(__file__).resolve().parents[3] / "dify" / BUILTIN_TEMPLATE_FILE
    raw_text = template_path.read_text(encoding="utf-8") if template_path.exists() else ""
    metadata = _parse_template_library_metadata(raw_text, BUILTIN_TEMPLATE_FILE) if raw_text else {
        "name": "00 智慧家居统一 Chatflow",
        "description": "智慧家居统一 Chatflow 是正式推荐入口。",
        "tags": ["对话流", "DSL"],
    }
    return AgentTemplateLibraryDetail(
        id=BUILTIN_TEMPLATE_LIBRARY_ID,
        name=f"{DEFAULT_AGENT_BUSINESS_NAME}模板",
        description=metadata["description"],
        tags=["内置模板", *metadata["tags"]],
        file_name=BUILTIN_TEMPLATE_FILE,
        source="builtin",
        readonly=True,
        created_by=None,
        created_at="",
        updated_at="",
        dsl_content=sanitize_dsl_storage(raw_text),
    )


def _to_template_library_item(item: AgentTemplateLibrary) -> AgentTemplateLibraryItem:
    stored_description = str(item.description or "").strip()
    stored_tags = [str(tag).strip() for tag in (item.tags or []) if str(tag).strip()]
    derived_description = ""
    derived_mode = ""
    try:
        parsed = parse_dsl_content(item.dsl_content or "")
        derived_description = str(parsed.get("description") or "").strip()
        raw_mode = str(parsed.get("mode") or "").strip().lower()
        derived_mode = TEMPLATE_MODE_LABELS.get(raw_mode, raw_mode)
    except ValueError:
        # 历史文件即使已损坏，目录仍应保留人工维护的元数据和下载入口。
        pass

    description = stored_description
    if stored_description in TEMPLATE_DESCRIPTION_PLACEHOLDERS:
        description = derived_description or "DSL 未提供用途说明"

    tags: list[str] = []
    for tag in stored_tags:
        normalized = TEMPLATE_MODE_LABELS.get(tag.lower(), tag)
        if normalized.strip().lower() in TEMPLATE_TECHNICAL_TAGS or re.fullmatch(r"v?\d+(?:\.\d+){0,3}", normalized.strip(), re.IGNORECASE):
            continue
        if normalized and normalized not in tags:
            tags.append(normalized)
    if derived_mode and derived_mode not in tags:
        tags.append(derived_mode)

    return AgentTemplateLibraryItem(
        id=str(item.id),
        name=item.name,
        description=description,
        tags=tags,
        file_name=item.file_name,
        source=item.source,
        readonly=False,
        created_by=item.created_by,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


async def _get_template_library_upload_or_404(db: AsyncSession, template_id: str) -> AgentTemplateLibrary:
    if not template_id.isdigit():
        raise HTTPException(status_code=404, detail="模板不存在")
    item = await db.get(AgentTemplateLibrary, int(template_id))
    if not item:
        raise HTTPException(status_code=404, detail="模板不存在")
    return item


async def _get_template_library_detail_for_instance(
    db: AsyncSession,
    template_id: str,
) -> AgentTemplateLibraryDetail:
    if not template_id:
        raise HTTPException(status_code=400, detail="请选择模板库中的应用模板")
    if template_id == BUILTIN_TEMPLATE_LIBRARY_ID:
        detail = _builtin_template_library_detail()
    else:
        item = await _get_template_library_upload_or_404(db, template_id)
        detail = AgentTemplateLibraryDetail(
            **_to_template_library_item(item).model_dump(),
            dsl_content=item.dsl_content,
        )
    if not detail.dsl_content.strip():
        raise HTTPException(status_code=409, detail="模板 DSL 内容为空，无法创建智能体实例")
    return detail


def _builtin_template_matches(detail: AgentTemplateLibraryDetail, keyword: str, source: str) -> bool:
    if source == "uploaded":
        return False
    cleaned_keyword = keyword.strip().casefold()
    if not cleaned_keyword:
        return True
    haystack = " ".join([
        detail.name,
        detail.description,
        detail.file_name,
        *detail.tags,
    ]).casefold()
    return cleaned_keyword in haystack


def _record_template_library_action(
    db: AsyncSession,
    user: dict,
    action: str,
    item: AgentTemplateLibraryItem,
) -> None:
    action_labels = {
        "upload": "上传模板",
        "update": "更新模板信息",
        "delete": "删除模板",
    }
    db.add(OperationLog(
        type="agent_template",
        level="success",
        title=f"{action_labels.get(action, '管理模板')}：{item.name}",
        detail=f"action={action}; template_id={item.id}; file_name={item.file_name}; source={item.source}",
        user_id=user.get("user_id"),
        username=user.get("username", ""),
        entity_id=f"agent-template:{item.id}",
    ))


def _record_agent_instance_action(
    db: AsyncSession,
    user: dict,
    action: str,
    instance: AgentInstance,
    *,
    changed_fields: list[str] | None = None,
) -> None:
    action_labels = {
        "create": "创建智能体实例",
        "update": "更新智能体配置",
        "upload_dsl": "更新智能体 DSL",
        "delete": "删除智能体实例",
    }
    fields = ",".join(sorted(set(changed_fields or [])))
    detail_parts = [
        f"action={action}",
        f"instance_id={instance.id}",
        f"source_type={instance.source_type}",
        f"source_template={instance.source_template}",
    ]
    if fields:
        detail_parts.append(f"changed_fields={fields}")
    if action == "upload_dsl":
        detail_parts.append(f"dsl_file_name={instance.dsl_file_name}")
    db.add(OperationLog(
        type="agent_instance",
        level="success",
        title=f"{action_labels.get(action, '管理智能体实例')}：{instance.name}",
        detail="; ".join(detail_parts),
        user_id=user.get("user_id"),
        username=user.get("username", ""),
        entity_id=f"agent:{instance.id}",
    ))


async def _set_default_instance(db: AsyncSession, instance: AgentInstance) -> None:
    result = await db.execute(select(AgentInstance).where(AgentInstance.id != instance.id))
    for item in result.scalars().all():
        item.is_default = False
        if item.status == "running":
            item.status = "ready"
    instance.is_default = True
    instance.enabled = True
    instance.status = "ready"


def _default_test_query(instance: AgentInstance) -> str:
    if instance.source_template == "template-00" or "Unified" in (instance.name or "") or "统一" in (instance.name or ""):
        return "查询当前系统服务状态"
    if instance.source_template == "template-02" or "设备" in (instance.name or ""):
        return "查询当前可用照明设备及状态，不要执行控制"
    if instance.source_template == "template-03" or "RAG" in (instance.name or "").upper():
        return "根据知识库回答：系统支持哪些核心能力？"
    if instance.source_template == "template-04" or "数据" in (instance.name or ""):
        return "查询当前室内温度和最近 24 小时趋势"
    return "请执行一次智能家居平台联调自检，并返回运行结果"


def _test_query_has_side_effects(query: str) -> bool:
    """识别可能触发设备、场景或配置写入的测试语句。"""
    normalized = " ".join((query or "").strip().lower().split())
    if not normalized:
        return False
    explicit_actions = (
        "turn_on", "turn_off", "toggle", "set_brightness", "set_temperature",
        "打开", "开启", "关闭", "关掉", "切换", "调亮", "调暗", "调节",
        "设置亮度", "设置色温", "执行场景", "启动场景", "激活场景",
    )
    return any(action in normalized for action in explicit_actions)


@router.get("/overview", response_model=AgentFrameworkOverview, summary="获取智能体运行与管理框架总览")
async def get_agents_overview(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _ = current_user
    payload = await get_overview_payload(db)
    return AgentFrameworkOverview.model_validate(payload)


@router.get("/capabilities", response_model=AgentCapabilitiesResponse, summary="获取运行框架与扩展能力说明")
async def get_agent_capabilities(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _ = current_user
    payload = await get_capabilities_payload(db)
    return AgentCapabilitiesResponse.model_validate(payload)


@router.get("/templates", response_model=list[AgentTemplateDoc], summary="获取内置智能体模板说明")
async def get_agent_templates(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await ensure_seed_instances(db)
    return [AgentTemplateDoc.model_validate(item) for item in get_template_docs()]


@router.get("/template-library", response_model=AgentTemplateLibraryListResponse, summary="获取智能体应用模板库")
async def list_agent_template_library(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    keyword: str = Query("", max_length=100),
    source: str = Query("", pattern="^(|builtin|uploaded)$"),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    builtin_detail = _builtin_template_library_detail()
    builtin_included = _builtin_template_matches(builtin_detail, keyword, source)
    conditions = []
    cleaned_keyword = keyword.strip()
    if cleaned_keyword:
        like = f"%{cleaned_keyword}%"
        searchable_fields = [
            AgentTemplateLibrary.name,
            AgentTemplateLibrary.description,
            AgentTemplateLibrary.file_name,
            cast(AgentTemplateLibrary.tags, String),
            AgentTemplateLibrary.dsl_content,
        ]
        keyword_conditions = [
            field.ilike(like)
            for field in searchable_fields
        ]
        if len(cleaned_keyword) >= 4 and re.search(r"[\u4e00-\u9fff]", cleaned_keyword):
            normalized_keyword = cleaned_keyword.replace("的", "")
            normalized_like = f"%{normalized_keyword}%"
            keyword_conditions.extend(
                func.replace(field, "的", "").ilike(normalized_like)
                for field in searchable_fields
            )
        for raw_mode in TEMPLATE_MODE_SEARCH_VALUES.get(cleaned_keyword, ()):
            keyword_conditions.append(AgentTemplateLibrary.dsl_content.ilike(f"%mode: {raw_mode}%"))
        conditions.append(or_(*keyword_conditions))
    if source == "builtin":
        conditions.append(AgentTemplateLibrary.id < 0)
    where_clause = and_(*conditions) if conditions else None

    uploaded_total = int((await db.execute(
        select(func.count()).select_from(AgentTemplateLibrary)
    )).scalar() or 0)
    count_stmt = select(func.count()).select_from(AgentTemplateLibrary)
    if where_clause is not None:
        count_stmt = count_stmt.where(where_clause)
    filtered_uploaded_total = int((await db.execute(count_stmt)).scalar() or 0)
    total = filtered_uploaded_total + int(builtin_included)
    page_count = max(1, math.ceil(total / page_size))
    safe_page = min(page, page_count)
    global_offset = (safe_page - 1) * page_size
    items: list[AgentTemplateLibraryItem] = []
    upload_offset = global_offset
    upload_limit = page_size
    if builtin_included:
        if global_offset == 0:
            items.append(AgentTemplateLibraryItem.model_validate(
                builtin_detail.model_dump(exclude={"dsl_content"})
            ))
            upload_limit -= 1
            upload_offset = 0
        else:
            upload_offset -= 1
    if upload_limit > 0 and filtered_uploaded_total > upload_offset:
        data_stmt = select(AgentTemplateLibrary)
        if where_clause is not None:
            data_stmt = data_stmt.where(where_clause)
        data_stmt = (
            data_stmt
            .order_by(AgentTemplateLibrary.created_at.desc(), AgentTemplateLibrary.id.desc())
            .offset(upload_offset)
            .limit(upload_limit)
        )
        result = await db.execute(data_stmt)
        items.extend(_to_template_library_item(item) for item in result.scalars().all())

    return AgentTemplateLibraryListResponse(
        items=items,
        total=total,
        page=safe_page,
        page_size=page_size,
        page_count=page_count,
        summary=AgentTemplateLibraryListSummary(
            total_templates=uploaded_total + 1,
            builtin_templates=1,
            uploaded_templates=uploaded_total,
        ),
        can_manage=current_user.get("role") == "admin",
        generated_at=_utcnow(),
        cache_ttl_seconds=TEMPLATE_LIBRARY_CACHE_TTL_SECONDS,
    )


@router.post("/template-library/upload", response_model=AgentTemplateLibraryUploadResponse, summary="上传智能体应用模板 DSL")
async def upload_agent_template_library_file(
    file: UploadFile = File(...),
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    raw_text = await _read_agent_dsl_upload(file)

    metadata = _parse_template_library_metadata(raw_text, file.filename or "template.yml")
    sanitized_content = sanitize_dsl_storage(raw_text)
    content_digest = hashlib.sha256(sanitized_content.encode("utf-8")).digest()
    duplicate_result = await db.execute(
        select(AgentTemplateLibrary)
        .where(AgentTemplateLibrary.dsl_content == sanitized_content)
        .order_by(AgentTemplateLibrary.id.asc())
    )
    duplicate = next((
        candidate for candidate in duplicate_result.scalars().all()
        if hashlib.sha256((candidate.dsl_content or "").encode("utf-8")).digest() == content_digest
    ), None)
    if duplicate:
        return AgentTemplateLibraryUploadResponse(
            created=False,
            item=_to_template_library_item(duplicate),
        )
    item = AgentTemplateLibrary(
        name=metadata["name"],
        description=metadata["description"],
        tags=["上传模板", *metadata["tags"]],
        file_name=_safe_download_name(file.filename or "template.yml"),
        dsl_content=sanitized_content,
        source="uploaded",
        created_by=current_user.get("user_id"),
    )
    db.add(item)
    await db.flush()
    await db.refresh(item)
    response_item = _to_template_library_item(item)
    _record_template_library_action(db, current_user, "upload", response_item)
    return AgentTemplateLibraryUploadResponse(created=True, item=response_item)


@router.get("/template-library/{template_id}", response_model=AgentTemplateLibraryDetail, summary="获取智能体应用模板 DSL 内容")
async def get_agent_template_library_detail(
    template_id: str,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _ = current_user
    if template_id == BUILTIN_TEMPLATE_LIBRARY_ID:
        return _builtin_template_library_detail()
    item = await _get_template_library_upload_or_404(db, template_id)
    return AgentTemplateLibraryDetail(
        **_to_template_library_item(item).model_dump(),
        dsl_content=sanitize_dsl_storage(item.dsl_content or ""),
    )


@router.get("/template-library/{template_id}/download", summary="下载智能体应用模板 DSL")
async def download_agent_template_library_file(
    template_id: str,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _ = current_user
    if template_id == BUILTIN_TEMPLATE_LIBRARY_ID:
        detail = _builtin_template_library_detail()
        file_name = _safe_download_name(detail.file_name)
        content = detail.dsl_content
    else:
        item = await _get_template_library_upload_or_404(db, template_id)
        file_name = _safe_download_name(item.file_name)
        content = sanitize_dsl_storage(item.dsl_content or "")

    encoded_name = quote(file_name)
    return Response(
        content=content,
        media_type="application/x-yaml; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=\"template.yml\"; filename*=UTF-8''{encoded_name}"},
    )


@router.put("/template-library/{template_id}", response_model=AgentTemplateLibraryItem, summary="更新上传模板的展示信息")
async def update_agent_template_library_file(
    template_id: str,
    body: AgentTemplateLibraryUpdate,
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    _ = current_user
    if template_id == BUILTIN_TEMPLATE_LIBRARY_ID:
        raise HTTPException(status_code=400, detail="内置 00 模板不可编辑")
    item = await _get_template_library_upload_or_404(db, template_id)
    updates = body.model_dump(exclude_unset=True)

    if "name" in updates:
        name = (updates["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="模板名称不能为空")
        item.name = name
    if "description" in updates:
        item.description = (updates["description"] or "").strip() or "DSL 未提供用途说明"
    if "tags" in updates:
        cleaned_tags: list[str] = []
        for tag in updates["tags"] or []:
            value = str(tag).strip()
            if value and value not in cleaned_tags:
                cleaned_tags.append(value)
        item.tags = cleaned_tags

    await db.flush()
    await db.refresh(item)
    response_item = _to_template_library_item(item)
    _record_template_library_action(db, current_user, "update", response_item)
    return response_item


@router.delete("/template-library/{template_id}", status_code=204, summary="删除上传的智能体应用模板")
async def delete_agent_template_library_file(
    template_id: str,
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if template_id == BUILTIN_TEMPLATE_LIBRARY_ID:
        raise HTTPException(status_code=400, detail="内置 00 模板不可删除")
    item = await _get_template_library_upload_or_404(db, template_id)
    response_item = _to_template_library_item(item)
    await db.delete(item)
    await db.flush()
    _record_template_library_action(db, current_user, "delete", response_item)


@router.get("/instances", response_model=AgentInstanceListResponse, summary="获取智能体实例列表")
async def list_agent_instances(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    keyword: str = Query("", max_length=100),
    status: str = Query("", max_length=32),
    instance_type: str = Query("", max_length=32),
    source_type: str = Query("", max_length=32),
    bound: bool | None = Query(None),
    refresh_runtime: bool = Query(False),
    primary_only: bool = Query(False),
    include_runtime: bool = Query(True),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await ensure_seed_instances(db)
    conditions = []
    cleaned_keyword = keyword.strip()
    if cleaned_keyword:
        like = f"%{cleaned_keyword}%"
        conditions.append(or_(
            AgentInstance.name.ilike(like),
            AgentInstance.description.ilike(like),
            AgentInstance.slug.ilike(like),
            AgentInstance.dify_app_id.ilike(like),
        ))
    if status:
        conditions.append(AgentInstance.status == status)
    if instance_type:
        conditions.append(AgentInstance.instance_type == instance_type)
    if source_type:
        conditions.append(AgentInstance.source_type == source_type)
    if bound is True:
        conditions.append(AgentInstance.dify_api_key != "")
    elif bound is False:
        conditions.append(AgentInstance.dify_api_key == "")
    if primary_only:
        conditions.append(or_(
            AgentInstance.is_default.is_(True),
            AgentInstance.source_template == "template-00",
            AgentInstance.name.ilike("00 %"),
        ))

    where_clause = and_(*conditions) if conditions else None
    count_stmt = select(func.count()).select_from(AgentInstance)
    data_stmt = select(AgentInstance)
    if where_clause is not None:
        count_stmt = count_stmt.where(where_clause)
        data_stmt = data_stmt.where(where_clause)
    total = await db.scalar(count_stmt) or 0
    page_count = max(1, math.ceil(total / page_size))
    safe_page = min(page, page_count)
    result = await db.execute(
        data_stmt
        .order_by(AgentInstance.is_default.desc(), AgentInstance.updated_at.desc(), AgentInstance.id.desc())
        .offset((safe_page - 1) * page_size)
        .limit(page_size)
    )
    instances = list(result.scalars().all())

    entity_ids = [f"agent:{item.id}" for item in instances]
    latest_logs: dict[int, OperationLog] = {}
    if entity_ids:
        latest_log_conditions = _agent_run_scope_conditions(
            current_user,
            OperationLog.entity_id.in_(entity_ids),
        )
        log_result = await db.execute(
            select(OperationLog)
            .where(and_(*latest_log_conditions))
            .order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
        )
        for row in log_result.scalars().all():
            instance_id = _instance_id_from_log(row)
            if instance_id is not None and instance_id not in latest_logs:
                latest_logs[instance_id] = row

    runtime_config = await get_runtime_config(db)
    if include_runtime:
        runtime_evidence = await asyncio.gather(*[
            _get_runtime_evidence(item, runtime_config, force=refresh_runtime)
            for item in instances
        ])
    else:
        runtime_evidence = [
            AgentRuntimeEvidence(
                status="unchecked",
                binding_status=(
                    "instance_key" if (item.dify_api_key or "").strip()
                    else "system_runtime_fallback" if item.is_default
                    else "unconfigured"
                ),
                checked_at=None,
                source="deferred",
            )
            for item in instances
        ]

    day_start = _utcnow() - timedelta(hours=24)
    summary_query = await db.execute(select(
        func.count(AgentInstance.id),
        func.sum(case((AgentInstance.enabled.is_(True), 1), else_=0)),
        func.sum(case((AgentInstance.is_default.is_(True), 1), else_=0)),
        func.sum(case((AgentInstance.dify_api_key != "", 1), else_=0)),
        func.sum(case((agent_callable_condition(bool(runtime_config.dify_api_key)), 1), else_=0)),
        func.sum(case((agent_template_reference_condition(), 1), else_=0)),
    ))
    summary_row = summary_query.one()
    run_summary_conditions = _agent_run_scope_conditions(
        current_user,
        OperationLog.created_at >= day_start,
    )
    run_summary = await db.execute(select(
        func.sum(case((OperationLog.level == "success", 1), else_=0)),
        func.sum(case((OperationLog.level == "error", 1), else_=0)),
    ).where(and_(*run_summary_conditions)))
    run_row = run_summary.one()

    return AgentInstanceListResponse(
        instances=[
            _to_response(
                item,
                include_dsl=False,
                include_secret_metadata=current_user.get("role") == "admin",
                runtime=runtime_evidence[index],
                last_run=_last_run_evidence(latest_logs.get(item.id)),
            )
            for index, item in enumerate(instances)
        ],
        total=total,
        page=safe_page,
        page_size=page_size,
        page_count=page_count,
        summary=AgentInstanceListSummary(
            total_instances=int(summary_row[0] or 0),
            enabled_instances=int(summary_row[1] or 0),
            default_instances=int(summary_row[2] or 0),
            bound_instances=int(summary_row[3] or 0),
            callable_instances=int(summary_row[4] or 0),
            template_reference_instances=int(summary_row[5] or 0),
            successful_runs_24h=int(run_row[0] or 0),
            failed_runs_24h=int(run_row[1] or 0),
        ),
        run_visibility_scope="all" if current_user.get("role") == "admin" else "self",
        generated_at=_utcnow(),
        cache_ttl_seconds=RUNTIME_EVIDENCE_TTL_SECONDS,
    )


@router.get("/runs", response_model=AgentRunListResponse, summary="获取智能体测试运行历史")
async def list_agent_runs(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    keyword: str = Query("", max_length=100),
    status: str = Query("", max_length=16),
    instance_id: int | None = Query(None, ge=1),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conditions = _agent_run_scope_conditions(current_user)
    cleaned_keyword = keyword.strip()
    if cleaned_keyword:
        like = f"%{cleaned_keyword}%"
        conditions.append(or_(
            OperationLog.title.ilike(like),
            OperationLog.detail.ilike(like),
            OperationLog.username.ilike(like),
        ))
    if status == "success":
        conditions.append(OperationLog.level == "success")
    elif status == "failed":
        conditions.append(OperationLog.level == "error")
    if instance_id is not None:
        conditions.append(or_(
            OperationLog.entity_id == f"agent:{instance_id}",
            OperationLog.detail.ilike(f"%instance_id={instance_id},%"),
        ))

    where_clause = and_(*conditions)
    total = await db.scalar(select(func.count()).select_from(OperationLog).where(where_clause)) or 0
    page_count = max(1, math.ceil(total / page_size))
    safe_page = min(page, page_count)
    result = await db.execute(
        select(OperationLog)
        .where(where_clause)
        .order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
        .offset((safe_page - 1) * page_size)
        .limit(page_size)
    )
    rows = list(result.scalars().all())
    run_instance_ids = {
        item_id
        for row in rows
        if (item_id := _instance_id_from_log(row)) is not None
    }
    business_names: dict[int, str] = {}
    if run_instance_ids:
        run_instances = list((await db.execute(
            select(AgentInstance).where(AgentInstance.id.in_(run_instance_ids))
        )).scalars().all())
        business_names = {
            item.id: get_agent_business_name(item)
            for item in run_instances
        }

    base_conditions = _agent_run_scope_conditions(current_user)
    day_start = _utcnow() - timedelta(hours=24)
    summary = await db.execute(select(
        func.count(OperationLog.id),
        func.sum(case((OperationLog.level == "success", 1), else_=0)),
        func.sum(case((OperationLog.level == "error", 1), else_=0)),
        func.sum(case((OperationLog.created_at >= day_start, 1), else_=0)),
    ).where(and_(*base_conditions)))
    summary_row = summary.one()
    return AgentRunListResponse(
        items=[_run_record(row, business_names) for row in rows],
        total=total,
        page=safe_page,
        page_size=page_size,
        page_count=page_count,
        summary=AgentRunListSummary(
            total_runs=int(summary_row[0] or 0),
            successful_runs=int(summary_row[1] or 0),
            failed_runs=int(summary_row[2] or 0),
            runs_24h=int(summary_row[3] or 0),
        ),
        visibility_scope="all" if current_user.get("role") == "admin" else "self",
    )


@router.post("/instances", response_model=AgentInstanceResponse, summary="创建智能体实例")
async def create_agent_instance(
    body: AgentInstanceCreate,
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    await ensure_seed_instances(db)

    data = body.model_dump()
    template = get_template_by_id(body.source_template) if body.source_type == "built_in_template" and body.source_template else None
    library_template = await _get_template_library_detail_for_instance(db, body.source_template) if body.source_type == "template_library" else None
    fallback_name = "DSL 导入应用" if body.source_type == "uploaded_dsl" else "新建智能体应用"
    if library_template:
        fallback_name = library_template.name
    name = template.title if template and not body.name else (body.name or fallback_name)
    slug = await _ensure_unique_slug(db, _slugify(name))

    parsed_meta = {}
    if template:
        parsed_meta = next((item for item in get_template_docs() if item["id"] == template.id), {})
    elif library_template:
        try:
            parsed_meta = parse_dsl_content(library_template.dsl_content)
        except ValueError:
            parsed_meta = {}

    library_mode = str(parsed_meta.get("mode") or "").strip().lower()
    library_instance_type = "chatflow" if library_mode in {"advanced-chat", "chat"} else "workflow"
    library_capability_tags = [
        tag for tag in (library_template.tags if library_template else [])
        if tag.strip().lower() not in TEMPLATE_TECHNICAL_TAGS
    ]

    instance = AgentInstance(
        name=name,
        slug=slug,
        dify_app_id=data.get("dify_app_id", ""),
        dify_api_key=(data.get("dify_api_key") or "").strip(),
        instance_type=library_instance_type if library_template else (body.instance_type or (template.instance_type if template else "workflow")),
        source_type=body.source_type,
        source_template=body.source_template,
        dsl_file_name=library_template.file_name if library_template else (template.file_name if template else ""),
        status="draft" if not body.enabled else "ready",
        enabled=body.enabled,
        is_default=body.is_default,
        description=body.description or (library_template.description if library_template else parsed_meta.get("description", "")),
        default_model=body.default_model or (template.default_model if template else ""),
        knowledge_bindings=body.knowledge_bindings or (template.knowledge_bindings if template else []),
        capability_tags=body.capability_tags or (library_capability_tags if library_template else (template.capability_tags if template else [])),
        entry_route=body.entry_route or (template.entry_route if template else "/chat"),
        dify_console_url=(body.dify_console_url or "").strip(),
        created_by=current_user["user_id"],
    )

    if template:
        template_path = Path(__file__).resolve().parents[3] / "dify" / template.file_name
        if template_path.exists():
            instance.dsl_content = sanitize_dsl_storage(template_path.read_text(encoding="utf-8"))
            if not instance.description:
                try:
                    parsed = parse_dsl_content(instance.dsl_content)
                    instance.description = parsed.get("description", "")
                except ValueError:
                    pass
    elif library_template:
        # 实例保存创建时的 DSL 快照，后续模板编辑或删除不会改变既有实例。
        instance.dsl_content = sanitize_dsl_storage(library_template.dsl_content)

    db.add(instance)
    if instance.is_default:
        await db.flush()
        await _set_default_instance(db, instance)
    await db.flush()
    await db.refresh(instance)
    _record_agent_instance_action(db, current_user, "create", instance)
    await db.flush()
    _invalidate_runtime_evidence()
    return _to_response(instance)


@router.get("/instances/{instance_id}", response_model=AgentInstanceResponse, summary="获取智能体实例详情")
async def get_agent_instance(
    instance_id: int,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await ensure_seed_instances(db)
    instance = await _get_instance_or_404(db, instance_id)
    return _to_response(
        instance,
        include_dsl=current_user.get("role") == "admin",
        include_secret_metadata=current_user.get("role") == "admin",
    )


@router.put("/instances/{instance_id}", response_model=AgentInstanceResponse, summary="更新智能体实例配置")
async def update_agent_instance(
    instance_id: int,
    body: AgentInstanceUpdate,
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    instance = await _get_instance_or_404(db, instance_id)
    updates = body.model_dump(exclude_unset=True)
    changed_fields = list(updates)
    dify_api_key = updates.pop("dify_api_key", None)
    is_default = updates.pop("is_default", None)
    for field, value in updates.items():
        setattr(instance, field, value)
    if dify_api_key is not None and not _is_masked_secret(dify_api_key):
        instance.dify_api_key = dify_api_key.strip()
    if is_default is not None:
        if is_default:
            await _set_default_instance(db, instance)
        else:
            instance.is_default = False
            if instance.status == "running":
                instance.status = "ready"
    if "name" in updates and "slug" not in updates:
        instance.slug = await _ensure_unique_slug(db, _slugify(instance.name), exclude_instance_id=instance.id)
    await db.flush()
    await db.refresh(instance)
    _record_agent_instance_action(db, current_user, "update", instance, changed_fields=changed_fields)
    await db.flush()
    _invalidate_runtime_evidence()
    return _to_response(instance)


@router.delete("/instances/{instance_id}", status_code=204, summary="删除智能体实例")
async def delete_agent_instance(
    instance_id: int,
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    instance = await _get_instance_or_404(db, instance_id)
    _record_agent_instance_action(db, current_user, "delete", instance)
    await db.delete(instance)
    await db.flush()
    _invalidate_runtime_evidence()


@router.post("/instances/{instance_id}/upload-dsl", response_model=AgentUploadDslResponse, summary="上传 DSL 文件并解析")
async def upload_agent_dsl(
    instance_id: int,
    file: UploadFile = File(...),
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    instance = await _get_instance_or_404(db, instance_id)
    raw_text = await _read_agent_dsl_upload(file)

    try:
        parsed = parse_dsl_content(raw_text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    instance.dsl_content = sanitize_dsl_storage(raw_text)
    instance.dsl_file_name = file.filename or instance.dsl_file_name
    instance.source_type = "uploaded_dsl"
    if parsed.get("name"):
        instance.name = parsed["name"]
        instance.slug = await _ensure_unique_slug(db, _slugify(instance.name), exclude_instance_id=instance.id)
    if parsed.get("description"):
        instance.description = parsed["description"]
    if parsed.get("mode"):
        instance.instance_type = "chatflow" if parsed["mode"] == "advanced-chat" else "workflow"
    await db.flush()
    await db.refresh(instance)
    _record_agent_instance_action(
        db,
        current_user,
        "upload_dsl",
        instance,
        changed_fields=["dsl_content", "dsl_file_name", "source_type", "name", "description", "instance_type"],
    )
    await db.flush()
    _invalidate_runtime_evidence()

    return AgentUploadDslResponse(instance=_to_response(instance), parsed=parsed)


@router.post(
    "/instances/{instance_id}/import-to-dify",
    response_model=AgentImportToDifyResponse,
    summary="获取 Dify 控制台入口（兼容旧接口）",
    deprecated=True,
)
async def import_agent_to_dify(
    instance_id: int,
    current_user=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    _ = current_user
    instance = await _get_instance_or_404(db, instance_id)
    runtime_config = await get_runtime_config(db)
    console_url = instance.dify_console_url or runtime_config.dify_base_url.rstrip("/")
    return AgentImportToDifyResponse(
        message="平台负责登记 Dify 智能体与调用密钥，Prompt、节点和发布请继续在 Dify 控制台维护。",
        console_url=console_url,
        detail={
            "instance_id": instance.id,
            "instance_name": instance.name,
            "dsl_file_name": instance.dsl_file_name,
            "source_type": instance.source_type,
            "has_dify_api_key": bool((instance.dify_api_key or "").strip()),
            "is_default": bool(instance.is_default),
        },
    )


@router.post(
    "/instances/{instance_id}/test-run",
    response_model=AgentTestRunResponse,
    summary="测试运行智能体实例",
)
async def test_run_agent_instance(
    instance_id: int,
    body: AgentTestRunRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    从平台内触发一次 Dify 阻塞式测试运行。

    优先使用实例级 Dify API 密钥；默认实例未填写时回退系统运行时密钥。
    """
    instance = await _get_instance_or_404(db, instance_id)
    runtime_config = await get_runtime_config(db)
    instance_key = (getattr(instance, "dify_api_key", "") or "").strip()
    runtime_key = instance_key or (runtime_config.dify_api_key if instance.is_default else "")
    if not runtime_key:
        raise HTTPException(
            status_code=400,
            detail="当前实例未配置独立的 Dify 应用 API 密钥；只有当前默认实例可使用系统运行时密钥。",
        )

    query = (body.query or "").strip() or _default_test_query(instance)
    if _test_query_has_side_effects(query) and not body.allow_side_effects:
        raise HTTPException(
            status_code=409,
            detail="测试语句可能触发真实设备或场景操作，请明确允许真实副作用后再执行。",
        )
    user_id = f"user-{current_user['user_id']}"
    warnings: list[str] = []

    if not instance.dify_app_id:
        warnings.append("当前实例未绑定 Dify 应用标识，可运行但不利于在控制台定位。")
    if not instance_key and instance.is_default:
        warnings.append("当前实例未填写 Dify API 密钥，本次使用系统运行时密钥。")
    if instance.instance_type != "chatflow":
        warnings.append("当前实例为工作流，使用工作流接口运行；节点详情请在 Dify 控制台查看。")
    if instance.source_template == "template-03":
        warnings.append("知识检索工作流需要在 Dify 环境绑定知识库，并通过检索命中结果确认。")

    base_url = derive_dify_base_url(instance.dify_console_url) or runtime_config.dify_base_url
    dify = DifyService(base_url=base_url, api_key=runtime_key)
    try:
        if instance.instance_type == "workflow":
            workflow_result = await asyncio.wait_for(
                dify.run_workflow(inputs={"query": query}, user=user_id),
                timeout=AGENT_TEST_TIMEOUT_SECONDS,
            )
            data = workflow_result.get("data") or {}
            outputs = data.get("outputs") or workflow_result.get("outputs") or {}
            answer = (
                outputs.get("answer")
                or outputs.get("result")
                or outputs.get("text")
                or str(outputs or "")
            )
            result = {
                "answer": answer,
                "workflow_run_id": data.get("id") or workflow_result.get("workflow_run_id") or "",
                "task_id": workflow_result.get("task_id") or "",
                "message_id": "",
                "conversation_id": "",
                "metadata": {},
            }
        else:
            result = await asyncio.wait_for(
                dify.chat(query=query, user=user_id),
                timeout=AGENT_TEST_TIMEOUT_SECONDS,
            )
    except Exception as exc:
        error_message = (
            f"Dify 测试运行超过 {AGENT_TEST_TIMEOUT_SECONDS} 秒，已停止等待"
            if isinstance(exc, TimeoutError)
            else str(exc)
        )
        try:
            from app.models.operation_log import OperationLog

            db.add(OperationLog(
                type="agent_test",
                level="error",
                title=f"智能体测试失败：{get_agent_business_name(instance)}",
                detail=f"instance_id={instance.id}, instance_name={instance.name}, query={query}, error={error_message}",
                user_id=current_user.get("user_id"),
                username=current_user.get("username", ""),
                entity_id=f"agent:{instance.id}",
            ))
            await db.flush()
        except Exception:
            pass
        raise HTTPException(
            status_code=504 if isinstance(exc, TimeoutError) else 502,
            detail=error_message if isinstance(exc, TimeoutError) else f"Dify 测试运行失败: {error_message}",
        )

    metadata = result.get("metadata") or {}
    workflow_run = result.get("workflow_run") or metadata.get("workflow_run") or {}
    workflow_run_id = (
        result.get("workflow_run_id")
        or workflow_run.get("id")
        or metadata.get("workflow_run_id")
        or ""
    )

    try:
        from app.models.operation_log import OperationLog

        answer_summary = re.sub(r"\s+", " ", str(result.get("answer") or "")).strip()[:1000]
        db.add(OperationLog(
            type="agent_test",
            level="success",
            title=f"智能体测试运行：{get_agent_business_name(instance)}",
            detail=(
                f"instance_id={instance.id}, instance_name={instance.name}, query={query}, "
                f"answer={answer_summary}, "
                f"message_id={result.get('message_id') or result.get('id') or ''}, "
                f"workflow_run_id={workflow_run_id}"
            ),
            user_id=current_user.get("user_id"),
            username=current_user.get("username", ""),
            entity_id=f"agent:{instance.id}",
        ))
        await db.flush()
    except Exception:
        pass

    return AgentTestRunResponse(
        instance_id=instance.id,
        instance_name=instance.name,
        business_name=get_agent_business_name(instance),
        query=query,
        answer=result.get("answer", ""),
        message_id=result.get("message_id") or result.get("id") or "",
        conversation_id=result.get("conversation_id", ""),
        task_id=result.get("task_id", ""),
        workflow_run_id=workflow_run_id,
        runtime_binding={
            "dify_base_url": base_url.rstrip("/"),
            "difyBaseUrl": base_url.rstrip("/"),
            "binding": "instance_api_key" if instance_key else "system_runtime_dify_app_key",
            "binding_status": "instance_bound" if instance_key else "system_runtime_fallback",
            "bindingStatus": "instance_bound" if instance_key else "system_runtime_fallback",
            "instance_dify_app_id": instance.dify_app_id or "",
            "instanceDifyAppId": instance.dify_app_id or "",
            "has_instance_api_key": bool(instance_key),
            "hasInstanceApiKey": bool(instance_key),
            "instance_type": instance.instance_type,
            "instanceType": instance.instance_type,
            "is_default": bool(instance.is_default),
            "isDefault": bool(instance.is_default),
        },
        warnings=warnings,
    )
