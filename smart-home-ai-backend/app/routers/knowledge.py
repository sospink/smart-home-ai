"""
知识库路由 - 代理 Dify Dataset API
参考: https://docs.dify.ai/api-reference/datasets

端点:
  GET    /knowledge/datasets           - 知识库列表
  POST   /knowledge/datasets           - 创建知识库
  DELETE /knowledge/datasets/{id}      - 删除知识库
  GET    /knowledge/datasets/{id}/documents  - 文档列表
  POST   /knowledge/datasets/{id}/documents/text  - 通过文本创建文档
  POST   /knowledge/datasets/{id}/documents/file  - 通过文件创建文档
  DELETE /knowledge/datasets/{id}/documents/{doc_id} - 删除文档
"""
import asyncio
import hashlib
import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
import httpx
from pydantic import BaseModel, field_validator
from typing import Any, Optional
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, require_admin
from app.models.operation_log import OperationLog
from app.services.runtime_settings import get_runtime_services
from app.services.system_summary_cache import invalidate_system_summary

router = APIRouter(prefix="/knowledge", tags=["知识库"])

MAX_DOCUMENT_FILE_SIZE = 50 * 1024 * 1024
ALLOWED_DOCUMENT_EXTENSIONS = {"pdf", "txt", "docx", "csv", "md", "xlsx"}
DATASET_SNAPSHOT_TTL_SECONDS = 45
DATASET_SNAPSHOT_PAGE_SIZE = 100
DATASET_SNAPSHOT_MAX_ITEMS = 10_000

_dataset_snapshot_cache: dict[str, tuple[float, float, list[dict]]] = {}
_dataset_snapshot_pending: dict[str, asyncio.Task[list[dict]]] = {}
_dataset_snapshot_generation = 0


# ── Schemas ──

class CreateDatasetRequest(BaseModel):
    name: str
    description: str = ""


class CreateTextDocRequest(BaseModel):
    name: str
    text: str


class UpdateTextDocRequest(BaseModel):
    name: str
    text: str


def _dataset_to_dict(ds: dict) -> dict:
    return {
        "id": ds.get("id", ""),
        "name": ds.get("name", ""),
        "description": ds.get("description", ""),
        "provider": ds.get("provider", ""),
        "permission": ds.get("permission", ""),
        "data_source_type": ds.get("data_source_type", ""),
        "indexing_technique": ds.get("indexing_technique", ""),
        "app_count": ds.get("app_count", 0),
        "document_count": ds.get("document_count", 0),
        "word_count": ds.get("word_count", 0),
        "embedding_model": ds.get("embedding_model"),
        "embedding_model_provider": ds.get("embedding_model_provider"),
        "embedding_available": ds.get("embedding_available", False),
        "created_at": ds.get("created_at", 0),
        "updated_at": ds.get("updated_at", 0),
    }


def _dataset_snapshot_signature(base_url: str, api_key: str) -> str:
    secret_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
    return f"{base_url.rstrip('/')}:{secret_hash}"


def _invalidate_dataset_snapshot() -> None:
    global _dataset_snapshot_generation
    _dataset_snapshot_generation += 1
    _dataset_snapshot_cache.clear()


async def _record_knowledge_operation(
    db: AsyncSession,
    user: dict,
    *,
    title: str,
    action: str,
    dataset_id: str,
    document_id: str = "",
    name: str = "",
    level: str = "success",
    extra: Optional[dict[str, Any]] = None,
) -> bool:
    detail_payload = {
        "action": action,
        "dataset_id": dataset_id,
        "document_id": document_id,
        "name": name,
    }
    if extra:
        detail_payload.update(extra)
    detail = json.dumps(detail_payload, ensure_ascii=False)
    db.add(OperationLog(
        type="knowledge_management",
        level=level,
        title=title,
        detail=detail,
        user_id=user.get("user_id"),
        username=user.get("username", ""),
        entity_id=document_id or dataset_id,
    ))
    try:
        await db.commit()
        return True
    except Exception:
        await db.rollback()
        return False


async def _load_dataset_snapshot(
    services,
    refresh: bool = False,
    *,
    include_meta: bool = False,
) -> list[dict] | tuple[list[dict], dict]:
    signature = _dataset_snapshot_signature(
        services.config.dify_base_url,
        services.config.dify_dataset_api_key,
    )
    now = time.monotonic()
    cached = _dataset_snapshot_cache.get(signature)
    if not refresh and cached and cached[0] > now:
        result = cached[2]
        meta = {"status": "fresh", "stale": False, "snapshot_at": cached[1], "error": ""}
        return (result, meta) if include_meta else result
    generation = _dataset_snapshot_generation

    async def load_all() -> list[dict]:
        datasets: list[dict] = []
        seen_ids: set[str] = set()
        page = 1
        while len(datasets) < DATASET_SNAPSHOT_MAX_ITEMS:
            result = await services.dify_knowledge.list_datasets(
                page=page,
                limit=DATASET_SNAPSHOT_PAGE_SIZE,
            )
            rows = result.get("data") if isinstance(result, dict) else []
            if not isinstance(rows, list) or not rows:
                break
            for row in rows:
                dataset = _dataset_to_dict(row)
                dataset_id = dataset["id"]
                if dataset_id and dataset_id in seen_ids:
                    continue
                if dataset_id:
                    seen_ids.add(dataset_id)
                datasets.append(dataset)
                if len(datasets) >= DATASET_SNAPSHOT_MAX_ITEMS:
                    break
            total = int(result.get("total") or 0)
            if not result.get("has_more") or (total and len(datasets) >= total):
                break
            page += 1
        return datasets

    task = _dataset_snapshot_pending.get(signature)
    if not task:
        task = asyncio.create_task(load_all())
        _dataset_snapshot_pending[signature] = task
    try:
        datasets = await asyncio.shield(task)
        captured_at = time.time()
        if generation == _dataset_snapshot_generation:
            _dataset_snapshot_cache[signature] = (
                time.monotonic() + DATASET_SNAPSHOT_TTL_SECONDS,
                captured_at,
                datasets,
            )
        meta = {"status": "live", "stale": False, "snapshot_at": captured_at, "error": ""}
        return (datasets, meta) if include_meta else datasets
    except asyncio.CancelledError:
        raise
    except Exception as error:
        if cached:
            result = cached[2]
            meta = {
                "status": "stale",
                "stale": True,
                "snapshot_at": cached[1],
                "error": _dify_error_message("刷新知识库列表", error),
            }
            return (result, meta) if include_meta else result
        raise
    finally:
        if task.done() and _dataset_snapshot_pending.get(signature) is task:
            _dataset_snapshot_pending.pop(signature, None)


def _filter_sort_datasets(
    datasets: list[dict],
    *,
    keyword: str,
    permission: str,
    sort: str,
) -> list[dict]:
    allowed_sorts = {
        "created_desc",
        "created_asc",
        "updated_desc",
        "name_asc",
        "docs_desc",
        "words_desc",
    }
    if sort not in allowed_sorts:
        raise HTTPException(status_code=422, detail="知识库排序方式无效")
    if permission not in {"", "all_team_members"}:
        raise HTTPException(status_code=422, detail="知识库权限筛选无效")

    normalized_keyword = keyword.strip().casefold()
    filtered = [
        dataset for dataset in datasets
        if (
            not normalized_keyword
            or normalized_keyword in str(dataset.get("name") or "").casefold()
            or normalized_keyword in str(dataset.get("description") or "").casefold()
        )
        and (not permission or dataset.get("permission") == permission)
    ]
    sorters = {
        "created_desc": lambda item: (-int(item.get("created_at") or 0), str(item.get("id") or "")),
        "created_asc": lambda item: (int(item.get("created_at") or 0), str(item.get("id") or "")),
        "updated_desc": lambda item: (-int(item.get("updated_at") or 0), str(item.get("id") or "")),
        "name_asc": lambda item: (str(item.get("name") or "").casefold(), str(item.get("id") or "")),
        "docs_desc": lambda item: (-int(item.get("document_count") or 0), str(item.get("name") or "").casefold()),
        "words_desc": lambda item: (-int(item.get("word_count") or 0), str(item.get("name") or "").casefold()),
    }
    return sorted(filtered, key=sorters[sort])


def _dataset_snapshot_summary(snapshot: list[dict]) -> dict:
    """基于完整 Dify 快照计算汇总，避免分页列表导致文档规模少算。"""
    return {
        "total": len(snapshot),
        "document_total": sum(max(0, int(item.get("document_count") or 0)) for item in snapshot),
        "word_total": sum(max(0, int(item.get("word_count") or 0)) for item in snapshot),
    }


def _dify_error_message(action: str, error: Exception) -> str:
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if status in {401, 403}:
            return f"{action}失败: Dify Dataset API Key 无效、无权访问，或该 Key 与当前 Dify 地址不匹配"
        if status == 404:
            return f"{action}失败: 知识库不存在、已被删除或当前 Dataset Key 无权访问"
        if status in {502, 503, 504}:
            return f"{action}失败: Dify 知识库服务不可用，请检查 Dify 服务是否启动以及运行时 Dify 地址"
        return f"{action}失败: Dify 返回 HTTP {status}"
    if isinstance(error, httpx.TimeoutException):
        return f"{action}失败: 连接 Dify 知识库服务超时，请检查 Dify 服务状态和网络连通性"
    if isinstance(error, httpx.ConnectError):
        return f"{action}失败: 无法连接 Dify 知识库服务，请检查系统设置中的 Dify 地址和服务状态"
    if isinstance(error, httpx.RequestError):
        return f"{action}失败: Dify 知识库网络请求异常，请检查服务地址和网络连通性"
    if isinstance(error, RuntimeError):
        detail = str(error).strip() or "Dify 知识库运行时配置异常"
        return f"{action}失败: {detail}"
    detail = str(error).strip()
    return f"{action}失败: {detail or 'Dify 知识库服务请求异常'}"


def _dify_read_status_code(error: Exception) -> int:
    """只透传资源不存在；Dify 身份异常不能触发平台登录态清理。"""
    if isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 404:
        return 404
    if isinstance(error, httpx.TimeoutException):
        return 504
    return 502


def _validate_document_file(file_name: str, content: bytes) -> None:
    extension = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    if extension not in ALLOWED_DOCUMENT_EXTENSIONS:
        raise HTTPException(status_code=422, detail="仅支持 PDF、TXT、DOCX、CSV、MD、XLSX 文件")
    if not content:
        raise HTTPException(status_code=422, detail="不能上传空文件")
    if len(content) > MAX_DOCUMENT_FILE_SIZE:
        raise HTTPException(status_code=413, detail="文件不能超过 50MB")


# ══════════════════════════════════════════════
#  知识库 CRUD
# ══════════════════════════════════════════════

@router.get("/health", summary="知识库模块健康检查")
async def health():
    return {"status": "ok", "module": "knowledge"}


@router.get("/datasets", summary="知识库列表")
async def list_datasets(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    keyword: str = Query(""),
    permission: str = Query("", description="权限筛选；团队共享使用 all_team_members"),
    sort: str = Query("created_desc", description="排序方式"),
    refresh: bool = Query(False, description="是否绕过 45 秒列表快照"),
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """读取 Dify 知识库快照，在完整集合上筛选、排序并分页。"""
    services = await get_runtime_services(db)
    try:
        snapshot, snapshot_meta = await _load_dataset_snapshot(
            services,
            refresh=refresh,
            include_meta=True,
        )
        datasets = _filter_sort_datasets(
            snapshot,
            keyword=keyword,
            permission=permission,
            sort=sort,
        )
    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=502, detail=_dify_error_message("获取知识库列表", e))

    total = len(datasets)
    page_count = max(1, (total + limit - 1) // limit)
    safe_page = min(page, page_count)
    offset = (safe_page - 1) * limit

    return {
        "datasets": datasets[offset:offset + limit],
        "total": total,
        "has_more": safe_page < page_count,
        "page": safe_page,
        "page_count": page_count,
        "summary": _dataset_snapshot_summary(snapshot),
        "cache_ttl_seconds": DATASET_SNAPSHOT_TTL_SECONDS,
        "snapshot": snapshot_meta,
    }


@router.get("/datasets/{dataset_id}", summary="知识库详情")
async def get_dataset(
    dataset_id: str,
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify GET /v1/datasets/{id}，避免详情页扫描知识库列表。"""
    services = await get_runtime_services(db)
    try:
        result = await services.dify_knowledge.get_dataset(dataset_id)
    except Exception as e:
        raise HTTPException(status_code=_dify_read_status_code(e), detail=_dify_error_message("获取知识库详情", e))
    return _dataset_to_dict(result)


@router.post("/datasets", summary="创建知识库")
async def create_dataset(
    body: CreateDatasetRequest,
    _user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify POST /v1/datasets，创建空知识库"""
    services = await get_runtime_services(db)
    try:
        result = await services.dify_knowledge.create_dataset(
            name=body.name, description=body.description
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=_dify_error_message("创建知识库", e))

    _invalidate_dataset_snapshot()
    invalidate_system_summary()
    await _record_knowledge_operation(
        db,
        _user,
        title=f"知识库「{result.get('name') or body.name}」已创建",
        action="create_dataset",
        dataset_id=str(result.get("id") or ""),
        name=str(result.get("name") or body.name),
    )
    return {
        "id": result.get("id", ""),
        "name": result.get("name", ""),
        "description": result.get("description", ""),
        "document_count": result.get("document_count", 0),
        "word_count": result.get("word_count", 0),
    }


@router.delete("/datasets/{dataset_id}", summary="删除知识库")
async def delete_dataset(
    dataset_id: str,
    _user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify DELETE /v1/datasets/{id}"""
    services = await get_runtime_services(db)
    try:
        await services.dify_knowledge.delete_dataset(dataset_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=_dify_error_message("删除知识库", e))

    _invalidate_dataset_snapshot()
    invalidate_system_summary()
    await _record_knowledge_operation(
        db,
        _user,
        title="知识库已删除",
        action="delete_dataset",
        dataset_id=dataset_id,
    )
    return {"success": True, "message": "知识库已删除"}


# ══════════════════════════════════════════════
#  文档管理
# ══════════════════════════════════════════════

@router.get("/datasets/{dataset_id}/documents", summary="文档列表")
async def list_documents(
    dataset_id: str,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    keyword: str = Query(""),
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify GET /v1/datasets/{id}/documents"""
    services = await get_runtime_services(db)
    try:
        result = await services.dify_knowledge.list_documents(
            dataset_id=dataset_id, page=page, limit=limit, keyword=keyword
        )
        total = max(0, int(result.get("total") or 0))
        page_count = max(1, (total + limit - 1) // limit)
        safe_page = min(page, page_count)
        if safe_page != page:
            result = await services.dify_knowledge.list_documents(
                dataset_id=dataset_id, page=safe_page, limit=limit, keyword=keyword
            )
    except Exception as e:
        raise HTTPException(status_code=_dify_read_status_code(e), detail=_dify_error_message("获取文档列表", e))

    documents = []
    for doc in result.get("data", []):
        documents.append({
            "id": doc.get("id", ""),
            "name": doc.get("name", ""),
            "word_count": doc.get("word_count", 0),
            "tokens": doc.get("tokens", 0),
            "indexing_status": doc.get("indexing_status", ""),
            "enabled": doc.get("enabled", False),
            "data_source_type": doc.get("data_source_type", ""),
            "doc_form": doc.get("doc_form", ""),
            "indexing_technique": doc.get("indexing_technique", ""),
            "created_at": doc.get("created_at", 0),
            "position": doc.get("position", 0),
        })

    return {
        "documents": documents,
        "total": result.get("total", total),
        "has_more": result.get("has_more", False),
        "page": safe_page,
    }


@router.post("/datasets/{dataset_id}/documents/text", summary="通过文本创建文档")
async def create_text_document(
    dataset_id: str,
    body: CreateTextDocRequest,
    _user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify POST /v1/datasets/{id}/document/create-by-text"""
    services = await get_runtime_services(db)
    try:
        result = await services.dify_knowledge.create_document_by_text(
            dataset_id=dataset_id, name=body.name, text=body.text
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=_dify_error_message("创建文档", e))

    _invalidate_dataset_snapshot()
    document = result.get("document") if isinstance(result, dict) else {}
    document_id = str((document or {}).get("id") or result.get("id") or "")
    await _record_knowledge_operation(
        db,
        _user,
        title=f"知识库文档「{body.name}」已创建",
        action="create_text_document",
        dataset_id=dataset_id,
        document_id=document_id,
        name=body.name,
    )
    return result


@router.put("/datasets/{dataset_id}/documents/{document_id}/text", summary="通过文本修改文档")
async def update_text_document(
    dataset_id: str,
    document_id: str,
    body: UpdateTextDocRequest,
    _user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify 文本文档更新接口"""
    services = await get_runtime_services(db)
    try:
        result = await services.dify_knowledge.update_document_by_text(
            dataset_id=dataset_id,
            document_id=document_id,
            name=body.name,
            text=body.text,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=_dify_error_message("修改文档", e))

    _invalidate_dataset_snapshot()
    await _record_knowledge_operation(
        db,
        _user,
        title=f"知识库文档「{body.name}」已更新",
        action="update_text_document",
        dataset_id=dataset_id,
        document_id=document_id,
        name=body.name,
    )
    return result


@router.post("/datasets/{dataset_id}/documents/file", summary="通过文件创建文档")
async def create_file_document(
    dataset_id: str,
    file: UploadFile = File(...),
    _user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify POST /v1/datasets/{id}/document/create-by-file"""
    content = await file.read()
    file_name = file.filename or "upload.txt"
    _validate_document_file(file_name, content)
    services = await get_runtime_services(db)
    try:
        result = await services.dify_knowledge.create_document_by_file(
            dataset_id=dataset_id,
            file_content=content,
            file_name=file_name,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=_dify_error_message("上传文档", e))

    _invalidate_dataset_snapshot()
    document = result.get("document") if isinstance(result, dict) else {}
    document_id = str((document or {}).get("id") or result.get("id") or "")
    await _record_knowledge_operation(
        db,
        _user,
        title=f"知识库文件「{file_name}」已上传",
        action="create_file_document",
        dataset_id=dataset_id,
        document_id=document_id,
        name=file_name,
    )
    return result


@router.post("/datasets/{dataset_id}/documents/{document_id}/file", summary="通过文件替换文档")
async def update_file_document(
    dataset_id: str,
    document_id: str,
    file: UploadFile = File(...),
    _user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify 文件文档更新接口"""
    content = await file.read()
    file_name = file.filename or "upload.txt"
    _validate_document_file(file_name, content)
    services = await get_runtime_services(db)
    try:
        result = await services.dify_knowledge.update_document_by_file(
            dataset_id=dataset_id,
            document_id=document_id,
            file_content=content,
            file_name=file_name,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=_dify_error_message("替换文档", e))

    _invalidate_dataset_snapshot()
    await _record_knowledge_operation(
        db,
        _user,
        title=f"知识库文件「{file_name}」已替换",
        action="update_file_document",
        dataset_id=dataset_id,
        document_id=document_id,
        name=file_name,
    )
    return result


@router.delete(
    "/datasets/{dataset_id}/documents/{document_id}",
    summary="删除文档",
)
async def delete_document(
    dataset_id: str,
    document_id: str,
    _user: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify DELETE /v1/datasets/{id}/documents/{doc_id}"""
    services = await get_runtime_services(db)
    try:
        await services.dify_knowledge.delete_document(dataset_id, document_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=_dify_error_message("删除文档", e))

    _invalidate_dataset_snapshot()
    await _record_knowledge_operation(
        db,
        _user,
        title="知识库文档已删除",
        action="delete_document",
        dataset_id=dataset_id,
        document_id=document_id,
    )
    return {"success": True, "message": "文档已删除"}


# ══════════════════════════════════════════════
#  语义检索测试 (Hit Testing)
# ══════════════════════════════════════════════

class HitTestingRequest(BaseModel):
    query: str

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        query = value.strip()
        if not query:
            raise ValueError("检索问题不能为空")
        if len(query) > 2000:
            raise ValueError("检索问题不能超过 2000 个字符")
        return query


class HitRecordResponse(BaseModel):
    content: str
    score: float
    word_count: int
    document_name: str
    document_id: str
    segment_id: str


class HitTestingResponse(BaseModel):
    query: str
    records: list[HitRecordResponse]
    hit_count: int
    duration_ms: int
    executed_at: str
    audit_recorded: bool


def _hit_record_to_dict(rec: dict) -> dict:
    segment = rec.get("segment") or {}
    document = rec.get("document") or segment.get("document") or {}
    return {
        "content": segment.get("content", ""),
        "score": rec.get("score", 0),
        "word_count": segment.get("word_count", 0),
        "document_name": document.get("name", ""),
        "document_id": segment.get("document_id") or document.get("id", ""),
        "segment_id": segment.get("id", ""),
    }


@router.post(
    "/datasets/{dataset_id}/hit-testing",
    summary="语义召回测试",
    response_model=HitTestingResponse,
)
async def hit_testing(
    dataset_id: str,
    body: HitTestingRequest,
    _user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """代理 Dify POST /v1/datasets/{id}/hit-testing"""
    started_at = time.perf_counter()
    try:
        services = await get_runtime_services(db)
        result = await services.dify_knowledge.hit_testing(
            dataset_id=dataset_id, query=body.query
        )
    except Exception as e:
        duration_ms = max(0, round((time.perf_counter() - started_at) * 1000))
        error_category = (
            "timeout" if isinstance(e, httpx.TimeoutException)
            else "network" if isinstance(e, httpx.NetworkError)
            else "configuration" if isinstance(e, RuntimeError)
            else "upstream"
        )
        await _record_knowledge_operation(
            db,
            _user,
            title="知识库语义检索失败",
            action="hit_testing",
            dataset_id=dataset_id,
            level="error",
            extra={
                "status": "failed",
                "query_digest": hashlib.sha256(body.query.encode("utf-8")).hexdigest()[:12],
                "query_length": len(body.query),
                "hit_count": 0,
                "duration_ms": duration_ms,
                "error_category": error_category,
            },
        )
        raise HTTPException(status_code=_dify_read_status_code(e), detail=_dify_error_message("检索测试", e))

    records = [_hit_record_to_dict(rec) for rec in result.get("records", [])]
    duration_ms = max(0, round((time.perf_counter() - started_at) * 1000))
    executed_at = datetime.now(timezone.utc).isoformat()
    audit_recorded = await _record_knowledge_operation(
        db,
        _user,
        title="知识库语义检索完成",
        action="hit_testing",
        dataset_id=dataset_id,
        extra={
            "status": "success",
            "query_digest": hashlib.sha256(body.query.encode("utf-8")).hexdigest()[:12],
            "query_length": len(body.query),
            "hit_count": len(records),
            "duration_ms": duration_ms,
        },
    )

    return {
        "query": result.get("query", {}).get("content", body.query),
        "records": records,
        "hit_count": len(records),
        "duration_ms": duration_ms,
        "executed_at": executed_at,
        "audit_recorded": audit_recorded,
    }
