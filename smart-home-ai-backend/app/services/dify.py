"""
Dify API 服务封装 - 智能体编排
支持流式(SSE) + 阻塞两种模式
"""
import asyncio
import json
from typing import AsyncGenerator, Optional
import httpx
from app.config import settings


class DifyWorkflowRunDetailError(RuntimeError):
    def __init__(self, message: str, upstream_status: int = 0):
        super().__init__(message)
        self.upstream_status = upstream_status


class DifyService:
    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None):
        self.base_url = (base_url or settings.DIFY_BASE_URL).rstrip("/")
        self.api_key = api_key or settings.DIFY_API_KEY

    @property
    def headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def get_app_info(self, timeout: float = 5.0) -> dict:
        """读取当前 App API Key 对应的 Dify 应用元数据。"""
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            response = await client.get(
                f"{self.base_url}/v1/info",
                headers=self.headers,
            )
            response.raise_for_status()
            payload = response.json()
            return payload if isinstance(payload, dict) else {}

    # ── 流式对话 (SSE) ──
    async def chat_stream(
        self,
        query: str,
        user: str,
        conversation_id: str = "",
    ) -> AsyncGenerator[str, None]:
        """调用 Dify Chatflow 对话 — 流式 SSE"""
        payload = {
            "inputs": {},
            "query": query,
            "response_mode": "streaming",
            "user": user,
        }
        if conversation_id:
            payload["conversation_id"] = conversation_id

        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/v1/chat-messages",
                headers=self.headers,
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.startswith("data:"):
                        yield line + "\n\n"

    # ── 阻塞式对话 ──
    async def chat(
        self,
        query: str,
        user: str,
        conversation_id: str = "",
    ) -> dict:
        """消费 Dify 流式事件并聚合为阻塞式结果。"""
        result: dict = {
            "answer": "",
            "message_id": "",
            "conversation_id": conversation_id,
            "task_id": "",
            "workflow_run_id": "",
            "metadata": {},
        }
        answer_parts: list[str] = []

        async for chunk in self.chat_stream(
            query=query,
            user=user,
            conversation_id=conversation_id,
        ):
            line = chunk.strip()
            if not line.startswith("data:"):
                continue
            try:
                event = json.loads(line[5:].strip())
            except (TypeError, ValueError, json.JSONDecodeError):
                continue

            event_type = event.get("event", "")
            data = event.get("data") or {}
            if event_type == "error":
                message = event.get("message") or data.get("error") or "Dify 工作流执行失败"
                raise RuntimeError(str(message))
            if event_type == "message":
                answer_parts.append(event.get("answer", ""))
            if event_type == "workflow_started":
                result["workflow_run_id"] = event.get("workflow_run_id") or data.get("id") or ""
            if event_type == "workflow_finished" and data.get("status") == "failed":
                raise RuntimeError(str(data.get("error") or "Dify 工作流执行失败"))
            if event_type == "message_end":
                result["metadata"] = event.get("metadata") or data.get("metadata") or {}

            result["task_id"] = event.get("task_id") or result["task_id"]
            result["message_id"] = event.get("message_id") or event.get("id") or result["message_id"]
            result["conversation_id"] = event.get("conversation_id") or result["conversation_id"]
            result["workflow_run_id"] = event.get("workflow_run_id") or result["workflow_run_id"]

        result["answer"] = "".join(answer_parts)
        if not result["answer"]:
            raise RuntimeError("Dify 工作流未返回有效回答")
        return result

    # ── 会话列表 ──
    async def get_conversations(
        self,
        user: str,
        last_id: str = "",
        limit: int = 20,
        sort_by: str = "-updated_at",
    ) -> dict:
        """获取用户的会话列表"""
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            params = {"user": user, "limit": limit, "sort_by": sort_by}
            if last_id:
                params["last_id"] = last_id
            r = await client.get(
                f"{self.base_url}/v1/conversations",
                headers=self.headers,
                params=params,
            )
            r.raise_for_status()
            return r.json()

    # ── 会话历史消息 ──
    async def get_messages(
        self,
        conversation_id: str,
        user: str,
        first_id: str = "",
        limit: int = 20,
    ) -> dict:
        """获取会话的历史消息"""
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            params = {
                "conversation_id": conversation_id,
                "user": user,
                "limit": limit,
            }
            if first_id:
                params["first_id"] = first_id
            r = await client.get(
                f"{self.base_url}/v1/messages",
                headers=self.headers,
                params=params,
            )
            r.raise_for_status()
            return r.json()

    # ── 删除会话 ──
    async def delete_conversation(self, conversation_id: str, user: str) -> None:
        """删除会话"""
        import json
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            r = await client.request(
                "DELETE",
                f"{self.base_url}/v1/conversations/{conversation_id}",
                headers={**self.headers, "Content-Type": "application/json"},
                content=json.dumps({"user": user}),
            )
            r.raise_for_status()

    # ── 停止响应 ──
    async def stop_stream(self, task_id: str, user: str) -> None:
        """停止流式响应"""
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            r = await client.post(
                f"{self.base_url}/v1/chat-messages/{task_id}/stop",
                headers=self.headers,
                json={"user": user},
            )
            r.raise_for_status()

    # ── 消息反馈 ──
    async def submit_message_feedback(
        self,
        message_id: str,
        user: str,
        rating: Optional[str],
        content: Optional[str] = None,
    ) -> dict:
        """提交消息反馈（点赞/点踩/备注）"""
        payload = {"user": user, "rating": rating}
        if content is not None:
            payload["content"] = content

        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            r = await client.post(
                f"{self.base_url}/v1/messages/{message_id}/feedbacks",
                headers=self.headers,
                json=payload,
            )
            r.raise_for_status()
            return r.json()

    # ── Workflow 运行详情 ──
    async def get_workflow_run_detail(self, workflow_run_id: str) -> dict:
        """获取 Workflow 运行详情"""
        try:
            async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
                response = await client.get(
                    f"{self.base_url}/v1/workflows/run/{workflow_run_id}",
                    headers=self.headers,
                )
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise DifyWorkflowRunDetailError("Dify 工作流详情返回格式异常")
                return payload
        except DifyWorkflowRunDetailError:
            raise
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in {401, 403}:
                message = "当前 Dify 应用密钥无权读取该历史工作流，记录可能属于其他应用"
            elif status == 404:
                message = "Dify 中已找不到该历史工作流，记录可能已过期或被清理"
            elif status >= 500:
                message = "Dify 工作流详情服务暂时异常，平台保存的消息与运行证据仍可查看"
            else:
                message = f"Dify 工作流详情读取失败（远端 HTTP {status}）"
            raise DifyWorkflowRunDetailError(message, status) from exc
        except httpx.TimeoutException as exc:
            raise DifyWorkflowRunDetailError("Dify 工作流详情读取超时，请稍后重试") from exc
        except httpx.RequestError as exc:
            raise DifyWorkflowRunDetailError("无法连接 Dify 工作流详情服务，请检查服务状态和网络") from exc
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise DifyWorkflowRunDetailError("Dify 工作流详情返回格式异常") from exc

    async def get_conversation_records(
        self,
        user: str,
        view: str = "history",
        keyword: str = "",
        rating: str = "",
        has_workflow_run: Optional[bool] = None,
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
        conversation_limit: int = 50,
        message_limit: int = 100,
    ) -> dict:
        """聚合当前用户的会话与运行记录"""
        conversations_res = await self.get_conversations(user=user, limit=conversation_limit)
        conversations = conversations_res.get("data", []) or []
        semaphore = asyncio.Semaphore(6)

        async def _load_messages(conv: dict) -> tuple[list[dict], bool, str]:
            async with semaphore:
                try:
                    res = await self.get_messages(
                        conversation_id=conv.get("id", ""),
                        user=user,
                        limit=message_limit,
                    )
                    return res.get("data", []) or [], bool(res.get("has_more")), ""
                except Exception as exc:
                    return [], False, str(exc)

        message_results = await asyncio.gather(*[_load_messages(conv) for conv in conversations])

        all_records: list[dict] = []
        records: list[dict] = []
        for conv, (messages, _has_more, _error) in zip(conversations, message_results):
            conversation_id = conv.get("id", "")
            conversation_name = conv.get("name", "") or "新对话"
            updated_at = conv.get("updated_at", 0)
            for message in messages:
                created_at = message.get("created_at", 0) or 0
                record = {
                    "conversation_id": conversation_id,
                    "conversation_name": conversation_name,
                    "conversation_updated_at": updated_at,
                    "message_id": message.get("id", ""),
                    "query": message.get("query", ""),
                    "answer": message.get("answer", ""),
                    "created_at": created_at,
                    "feedback": message.get("feedback"),
                    "workflow_run_id": message.get("workflow_run_id") or message.get("workflow_run", {}).get("id"),
                    "task_id": message.get("task_id") or message.get("task", {}).get("id"),
                    "usage": message.get("usage") or message.get("message_tokens"),
                    "retriever_resources": message.get("retriever_resources") or [],
                }
                record["record_source"] = "dify_messages"
                record["record_kind"] = "conversation_message"
                record["debug_available"] = bool(record.get("workflow_run_id"))
                record["run_status"] = "节点级运行记录" if record["debug_available"] else "消息级运行记录"

                all_records.append(record)

                if keyword:
                    haystack = " ".join([
                        str(record["conversation_name"]),
                        str(record["query"]),
                        str(record["answer"]),
                    ]).lower()
                    if keyword.lower() not in haystack:
                        continue

                if start_time and created_at < start_time:
                    continue
                if end_time and created_at > end_time:
                    continue

                feedback = record.get("feedback") or {}
                record_rating = feedback.get("rating") if isinstance(feedback, dict) else None

                if rating and record_rating != rating:
                    continue

                if has_workflow_run is True and not record.get("workflow_run_id"):
                    continue
                if has_workflow_run is False and record.get("workflow_run_id"):
                    continue

                if view == "feedback" and not record_rating:
                    continue

                records.append(record)

        records.sort(key=lambda item: item.get("created_at", 0), reverse=True)

        return {
            "items": records,
            "stats": {
                "conversation_count": len(conversations),
                "message_count": len(all_records),
                "feedback_count": len([
                    item for item in all_records
                    if isinstance(item.get("feedback"), dict) and item["feedback"].get("rating")
                ]),
                    "run_count": len([
                        item for item in all_records
                        if item.get("workflow_run_id") or item.get("task_id")
                    ]),
                "workflow_run_count": len([item for item in all_records if item.get("workflow_run_id")]),
            },
            "_meta": {
                "conversation_has_more": bool(conversations_res.get("has_more")),
                "conversation_count_loaded": len(conversations),
                "message_truncated_conversations": sum(1 for _messages, has_more, _error in message_results if has_more),
                "message_load_error_count": sum(1 for _messages, _has_more, error in message_results if error),
            },
        }

    # ── 运行 Workflow ──
    async def run_workflow(self, inputs: dict, user: str) -> dict:
        """运行 Dify Workflow"""
        async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
            r = await client.post(
                f"{self.base_url}/v1/workflows/run",
                headers=self.headers,
                json={"inputs": inputs, "response_mode": "blocking", "user": user},
            )
            r.raise_for_status()
            return r.json()


dify_service = DifyService()
