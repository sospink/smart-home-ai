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
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from pydantic import BaseModel
from typing import Optional

from app.dependencies import require_admin
from app.services.dify_knowledge import dify_knowledge_service

router = APIRouter(prefix="/knowledge", tags=["知识库"])


# ── Schemas ──

class CreateDatasetRequest(BaseModel):
    name: str
    description: str = ""


class CreateTextDocRequest(BaseModel):
    name: str
    text: str


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
    _admin: dict = Depends(require_admin),
):
    """代理 Dify GET /v1/datasets，返回知识库列表"""
    try:
        result = await dify_knowledge_service.list_datasets(
            page=page, limit=limit, keyword=keyword
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Dify 请求失败: {str(e)}")

    # 转换为前端友好格式
    datasets = []
    for ds in result.get("data", []):
        datasets.append({
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
        })

    return {
        "datasets": datasets,
        "total": result.get("total", 0),
        "has_more": result.get("has_more", False),
        "page": result.get("page", 1),
    }


@router.post("/datasets", summary="创建知识库")
async def create_dataset(
    body: CreateDatasetRequest,
    _admin: dict = Depends(require_admin),
):
    """代理 Dify POST /v1/datasets，创建空知识库"""
    try:
        result = await dify_knowledge_service.create_dataset(
            name=body.name, description=body.description
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"创建知识库失败: {str(e)}")

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
    _admin: dict = Depends(require_admin),
):
    """代理 Dify DELETE /v1/datasets/{id}"""
    try:
        await dify_knowledge_service.delete_dataset(dataset_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"删除知识库失败: {str(e)}")

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
    _admin: dict = Depends(require_admin),
):
    """代理 Dify GET /v1/datasets/{id}/documents"""
    try:
        result = await dify_knowledge_service.list_documents(
            dataset_id=dataset_id, page=page, limit=limit, keyword=keyword
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"获取文档列表失败: {str(e)}")

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
            "created_at": doc.get("created_at", 0),
            "position": doc.get("position", 0),
        })

    return {
        "documents": documents,
        "total": result.get("total", 0),
        "has_more": result.get("has_more", False),
        "page": result.get("page", 1),
    }


@router.post("/datasets/{dataset_id}/documents/text", summary="通过文本创建文档")
async def create_text_document(
    dataset_id: str,
    body: CreateTextDocRequest,
    _admin: dict = Depends(require_admin),
):
    """代理 Dify POST /v1/datasets/{id}/document/create-by-text"""
    try:
        result = await dify_knowledge_service.create_document_by_text(
            dataset_id=dataset_id, name=body.name, text=body.text
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"创建文档失败: {str(e)}")

    return result


@router.post("/datasets/{dataset_id}/documents/file", summary="通过文件创建文档")
async def create_file_document(
    dataset_id: str,
    file: UploadFile = File(...),
    _admin: dict = Depends(require_admin),
):
    """代理 Dify POST /v1/datasets/{id}/document/create-by-file"""
    try:
        content = await file.read()
        result = await dify_knowledge_service.create_document_by_file(
            dataset_id=dataset_id,
            file_content=content,
            file_name=file.filename or "upload.txt",
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"上传文档失败: {str(e)}")

    return result


@router.delete(
    "/datasets/{dataset_id}/documents/{document_id}",
    summary="删除文档",
)
async def delete_document(
    dataset_id: str,
    document_id: str,
    _admin: dict = Depends(require_admin),
):
    """代理 Dify DELETE /v1/datasets/{id}/documents/{doc_id}"""
    try:
        await dify_knowledge_service.delete_document(dataset_id, document_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"删除文档失败: {str(e)}")

    return {"success": True, "message": "文档已删除"}


# ══════════════════════════════════════════════
#  语义检索测试 (Hit Testing)
# ══════════════════════════════════════════════

class HitTestingRequest(BaseModel):
    query: str


@router.post("/datasets/{dataset_id}/hit-testing", summary="语义召回测试")
async def hit_testing(
    dataset_id: str,
    body: HitTestingRequest,
    _admin: dict = Depends(require_admin),
):
    """代理 Dify POST /v1/datasets/{id}/hit-testing"""
    try:
        result = await dify_knowledge_service.hit_testing(
            dataset_id=dataset_id, query=body.query
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"检索测试失败: {str(e)}")

    records = []
    for rec in result.get("records", []):
        segment = rec.get("segment", {})
        doc = rec.get("document", {})
        records.append({
            "content": segment.get("content", ""),
            "score": rec.get("score", 0),
            "word_count": segment.get("word_count", 0),
            "document_name": doc.get("name", ""),
            "document_id": segment.get("document_id", ""),
            "segment_id": segment.get("id", ""),
        })

    return {
        "query": result.get("query", {}).get("content", body.query),
        "records": records,
    }

