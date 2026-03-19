"""
知识库路由 - 知识库 CRUD / 文档管理 / 语义检索
"""
from fastapi import APIRouter, Depends
from app.dependencies import get_current_user, require_admin

router = APIRouter(prefix="/knowledge", tags=["知识库"])


@router.get("/health", summary="知识库模块健康检查")
async def health():
    return {"status": "ok", "module": "knowledge"}


# TODO: GET  /datasets               - 知识库列表
# TODO: POST /datasets               - 创建知识库
# TODO: DELETE /datasets/{id}        - 删除知识库
# TODO: POST /datasets/{id}/retrieve - 语义检索
# TODO: POST /datasets/{id}/documents - 上传文档
# TODO: DELETE /datasets/{id}/documents/{doc_id} - 删除文档
