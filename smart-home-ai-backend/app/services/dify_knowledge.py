"""
Dify 知识库服务封装 - 代理 Dify Dataset API
参考: https://docs.dify.ai/api-reference/datasets

Endpoints:
  GET    /v1/datasets          — 知识库列表
  POST   /v1/datasets          — 创建空知识库
  DELETE /v1/datasets/{id}     — 删除知识库
  GET    /v1/datasets/{id}/documents — 文档列表
  POST   /v1/datasets/{id}/document/create-by-text  — 通过文本创建文档
  POST   /v1/datasets/{id}/document/create-by-file  — 通过文件创建文档
  DELETE /v1/datasets/{id}/documents/{doc_id}       — 删除文档
"""
import httpx
from typing import Optional
from app.config import settings


class DifyKnowledgeService:
    def __init__(self):
        self.base_url = settings.DIFY_BASE_URL.rstrip("/")
        self.api_key = settings.DIFY_DATASET_API_KEY

    @property
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"}

    # ── 知识库 CRUD ──

    async def list_datasets(
        self, page: int = 1, limit: int = 20, keyword: str = ""
    ) -> dict:
        """GET /v1/datasets — 知识库列表"""
        params = {"page": page, "limit": limit}
        if keyword:
            params["keyword"] = keyword
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                f"{self.base_url}/v1/datasets",
                headers=self._headers,
                params=params,
            )
            r.raise_for_status()
            return r.json()

    async def create_dataset(self, name: str, description: str = "") -> dict:
        """POST /v1/datasets — 创建空知识库"""
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{self.base_url}/v1/datasets",
                headers=self._headers,
                json={
                    "name": name,
                    "description": description,
                    "indexing_technique": "economy",
                    "permission": "all_team_members",
                },
            )
            r.raise_for_status()
            return r.json()

    async def delete_dataset(self, dataset_id: str) -> None:
        """DELETE /v1/datasets/{id} — 删除知识库"""
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.delete(
                f"{self.base_url}/v1/datasets/{dataset_id}",
                headers=self._headers,
            )
            r.raise_for_status()

    # ── 文档管理 ──

    async def list_documents(
        self, dataset_id: str, page: int = 1, limit: int = 20, keyword: str = ""
    ) -> dict:
        """GET /v1/datasets/{id}/documents — 文档列表"""
        params: dict = {"page": page, "limit": limit}
        if keyword:
            params["keyword"] = keyword
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                f"{self.base_url}/v1/datasets/{dataset_id}/documents",
                headers=self._headers,
                params=params,
            )
            r.raise_for_status()
            return r.json()

    async def create_document_by_text(
        self,
        dataset_id: str,
        name: str,
        text: str,
        indexing_technique: str = "economy",
    ) -> dict:
        """POST /v1/datasets/{id}/document/create-by-text"""
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{self.base_url}/v1/datasets/{dataset_id}/document/create-by-text",
                headers=self._headers,
                json={
                    "name": name,
                    "text": text,
                    "indexing_technique": indexing_technique,
                    "process_rule": {"mode": "automatic"},
                },
            )
            r.raise_for_status()
            return r.json()

    async def create_document_by_file(
        self,
        dataset_id: str,
        file_content: bytes,
        file_name: str,
    ) -> dict:
        """POST /v1/datasets/{id}/document/create-by-file"""
        import json

        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{self.base_url}/v1/datasets/{dataset_id}/document/create-by-file",
                headers=self._headers,
                files={"file": (file_name, file_content)},
                data={
                    "data": json.dumps({
                        "indexing_technique": "economy",
                        "process_rule": {"mode": "automatic"},
                    })
                },
            )
            r.raise_for_status()
            return r.json()

    async def delete_document(self, dataset_id: str, document_id: str) -> None:
        """DELETE /v1/datasets/{id}/documents/{doc_id}"""
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.delete(
                f"{self.base_url}/v1/datasets/{dataset_id}/documents/{document_id}",
                headers=self._headers,
            )
            r.raise_for_status()

    # ── 语义检索测试 ──

    async def hit_testing(self, dataset_id: str, query: str) -> dict:
        """POST /v1/datasets/{id}/hit-testing — 召回测试"""
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                f"{self.base_url}/v1/datasets/{dataset_id}/hit-testing",
                headers=self._headers,
                json={"query": query},
            )
            r.raise_for_status()
            return r.json()


dify_knowledge_service = DifyKnowledgeService()
