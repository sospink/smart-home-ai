"""
Ollama 官方模型库同步与缓存。
"""
from __future__ import annotations

from datetime import datetime
import html
import json
import re
from typing import Any

import httpx
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.model_catalog_snapshot import ModelCatalogSnapshot


OLLAMA_LIBRARY_URL = "https://ollama.com/library"
MAX_MODELS_TO_SYNC = 24
MAX_TAGS_PER_MODEL = 12


SEED_MODELS: list[dict[str, Any]] = [
    {
        "name": "qwen3",
        "desc": "Qwen3 是通义千问系列开源模型，适合中文对话、工具调用和推理演示。",
        "category": "对话",
        "family": "qwen",
        "capabilities": ["tools", "thinking"],
        "parameter_sizes": ["0.6b", "1.7b", "4b", "8b", "14b", "30b", "32b", "235b"],
        "recommended": True,
        "default_tag": "8b",
        "tags": [
            {"tag": "8b", "full_name": "qwen3:8b", "size": "5.2GB", "size_bytes": 5583457485, "context": "40K", "input": "Text", "updated": "内置种子"},
            {"tag": "4b", "full_name": "qwen3:4b", "size": "2.5GB", "size_bytes": 2684354560, "context": "256K", "input": "Text", "updated": "内置种子"},
        ],
    },
    {
        "name": "deepseek-r1",
        "desc": "DeepSeek-R1 开源推理模型，适合数学、逻辑和复杂问题演示。",
        "category": "推理",
        "family": "deepseek",
        "capabilities": ["tools", "thinking"],
        "parameter_sizes": ["1.5b", "7b", "8b", "14b", "32b", "70b", "671b"],
        "recommended": True,
        "default_tag": "7b",
        "tags": [
            {"tag": "7b", "full_name": "deepseek-r1:7b", "size": "4.7GB", "size_bytes": 5046586573, "context": "128K", "input": "Text", "updated": "内置种子"},
        ],
    },
    {
        "name": "nomic-embed-text",
        "desc": "高质量文本 Embedding 模型，适合 RAG 检索与知识库向量化。",
        "category": "Embedding",
        "family": "nomic-bert",
        "capabilities": ["embedding"],
        "parameter_sizes": [],
        "recommended": True,
        "default_tag": "latest",
        "tags": [
            {"tag": "latest", "full_name": "nomic-embed-text:latest", "size": "274MB", "size_bytes": 287309824, "context": "2K", "input": "Text", "updated": "内置种子"},
        ],
    },
    {
        "name": "llava",
        "desc": "视觉语言模型，适合图片理解演示。",
        "category": "多模态",
        "family": "llava",
        "capabilities": ["vision"],
        "parameter_sizes": ["7b", "13b", "34b"],
        "recommended": False,
        "default_tag": "7b",
        "tags": [
            {"tag": "7b", "full_name": "llava:7b", "size": "4.7GB", "size_bytes": 5046586573, "context": "4K", "input": "Text/Image", "updated": "内置种子"},
        ],
    },
]


def _strip_tags(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _parse_size_bytes(value: str) -> int:
    match = re.match(r"^\s*([0-9.]+)\s*([KMGT]B)\s*$", value, re.I)
    if not match:
        return 0
    number = float(match.group(1))
    unit = match.group(2).upper()
    scale = {"KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}.get(unit, 1)
    return int(number * scale)


def _guess_category(name: str, capabilities: list[str]) -> str:
    lowered = name.lower()
    if "embedding" in capabilities or "embed" in lowered or "bge" in lowered:
        return "Embedding"
    if "vision" in capabilities or "llava" in lowered or "vl" in lowered:
        return "多模态"
    if "coder" in lowered or "code" in lowered:
        return "代码"
    if "thinking" in capabilities or "r1" in lowered or "qwq" in lowered:
        return "推理"
    return "对话"


def _capabilities_from_text(text: str) -> list[str]:
    known = ["tools", "thinking", "vision", "embedding", "cloud", "audio"]
    lowered = text.lower()
    return [item for item in known if item in lowered]


def _parameter_sizes_from_text(text: str) -> list[str]:
    values = re.findall(r"\b(?:[0-9]+(?:\.[0-9]+)?|[ex][0-9]+|[0-9]+x[0-9]+)(?:b|m)\b", text.lower())
    result: list[str] = []
    for item in values:
        if item not in result:
            result.append(item)
    return result[:12]


def _parameter_sizes_from_badges(raw_html: str) -> list[str]:
    """只读取官方页面中的参数规模徽标，避免把 Pulls 下载量识别成参数量。"""
    values: list[str] = []
    badge_pattern = r'<span[^>]*class="[^"]*bg-\[#ddf4ff\][^"]*"[^>]*>(.*?)</span>'
    for badge in re.findall(badge_pattern, raw_html, flags=re.S | re.I):
        for value in _parameter_sizes_from_text(_strip_tags(badge)):
            if value not in values:
                values.append(value)
    return values[:12]


def _parameter_sizes_from_tags(tags: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for tag in tags:
        text = f"{tag.get('tag', '')} {tag.get('full_name', '')}"
        for value in _parameter_sizes_from_text(text):
            if value not in values:
                values.append(value)
    return values[:12]


def _normalize_catalog_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """清理历史缓存中误混入的下载量，并从版本标签补齐参数规模。"""
    for model in payload.get("models", []):
        tags = model.get("tags") or []
        tag_values = _parameter_sizes_from_tags(tags)
        current_values = [
            str(value).lower()
            for value in (model.get("parameter_sizes") or [])
            if re.fullmatch(r"(?:[0-9]+(?:\.[0-9]+)?|[ex][0-9]+|[0-9]+x[0-9]+)(?:b|m)", str(value).lower())
        ]
        if tag_values:
            tag_value_set = set(tag_values)
            current_values = [value for value in current_values if value in tag_value_set]
            model["parameter_sizes"] = list(dict.fromkeys(current_values + tag_values))[:12]
        else:
            # 历史误识别值多为带小数的 Pulls 数（如 114.6m）；无版本证据时不展示这类值。
            model["parameter_sizes"] = [
                value for value in current_values if value.endswith("b") or "." not in value
            ][:12]
    return payload


def _tag_from_full_name(model_name: str, full_name: str) -> str:
    if ":" not in full_name:
        return "latest"
    tag = full_name.split(":", 1)[1]
    if tag == "latest":
        return "latest"
    return tag


def _parse_library_page(raw_html: str) -> list[dict[str, Any]]:
    blocks = re.findall(r"(<li x-test-model\b.*?</li>)", raw_html, flags=re.S)
    models: list[dict[str, Any]] = []
    for block in blocks[:MAX_MODELS_TO_SYNC]:
        href = re.search(r'href="/library/([^"/:]+)"', block)
        title = re.search(r'x-test-model-title title="([^"]+)"', block)
        desc = re.search(r'<p class="[^"]*break-words[^"]*">(.*?)</p>', block, flags=re.S)
        name = html.unescape((title.group(1) if title else href.group(1) if href else "")).strip()
        if not name:
            continue
        block_text = _strip_tags(block)
        capabilities = _capabilities_from_text(block_text)
        models.append({
            "name": name,
            "desc": _strip_tags(desc.group(1)) if desc else "",
            "category": _guess_category(name, capabilities),
            "family": name.split("-")[0].split(".")[0],
            "capabilities": capabilities,
            "parameter_sizes": _parameter_sizes_from_badges(block),
            "recommended": name in {"qwen3", "qwen2.5", "deepseek-r1", "llama3.1", "gemma3", "nomic-embed-text", "bge-m3"},
            "default_tag": "latest",
            "tags": [],
        })
    return models


def _parse_tag_page(model_name: str, raw_html: str) -> list[dict[str, Any]]:
    tags: list[dict[str, Any]] = []
    seen: set[str] = set()
    for match in re.finditer(r'<input class="command hidden" value="([^"]+)"\s*/>', raw_html):
        full_name = html.unescape(match.group(1)).strip()
        if not full_name.startswith(f"{model_name}:") or full_name in seen:
            continue
        seen.add(full_name)
        chunk = _strip_tags(raw_html[match.end():match.end() + 2400])
        size_match = re.search(r"\b([0-9.]+\s*(?:KB|MB|GB|TB))\b", chunk, flags=re.I)
        context_match = re.search(r"\b([0-9.]+\s*[KkMm]?)\s+context window\b", chunk)
        input_match = re.search(r"\b(Text|Image|Vision|Embedding|Audio)(?:/[A-Za-z]+)?\s+input\b", chunk, flags=re.I)
        updated_match = re.search(r"\b([0-9]+\s+(?:minute|hour|day|week|month|year)s?\s+ago)\b", chunk, flags=re.I)
        digest_match = re.search(r"\b([a-f0-9]{12,})\b", chunk)
        size = size_match.group(1).replace(" ", "") if size_match else ""
        tag = _tag_from_full_name(model_name, full_name)
        tags.append({
            "tag": tag,
            "full_name": full_name,
            "size": size,
            "size_bytes": _parse_size_bytes(size),
            "context": context_match.group(1).replace(" ", "") if context_match else "",
            "input": input_match.group(1).capitalize() if input_match else "Text",
            "updated": updated_match.group(1) if updated_match else "",
            "digest": digest_match.group(1) if digest_match else "",
        })
        if len(tags) >= MAX_TAGS_PER_MODEL:
            break
    return tags


async def fetch_official_catalog() -> dict[str, Any]:
    """抓取 Ollama 官方模型库。"""
    headers = {"User-Agent": "smart-home-ai-backend/1.0"}
    async with httpx.AsyncClient(timeout=20, headers=headers, follow_redirects=True) as client:
        library_response = await client.get(OLLAMA_LIBRARY_URL)
        library_response.raise_for_status()
        models = _parse_library_page(library_response.text)
        for model in models:
            try:
                tags_response = await client.get(f"{OLLAMA_LIBRARY_URL}/{model['name']}/tags")
                tags_response.raise_for_status()
                tags = _parse_tag_page(model["name"], tags_response.text)
                if tags:
                    model["tags"] = tags
                    model["default_tag"] = "latest" if any(t["tag"] == "latest" for t in tags) else tags[0]["tag"]
                    model["parameter_sizes"] = list(dict.fromkeys(
                        model["parameter_sizes"] + _parameter_sizes_from_tags(tags)
                    ))[:12]
                    model["capabilities"] = sorted(set(model["capabilities"] + [
                        "embedding" if "embed" in model["name"].lower() else "",
                        "vision" if any((t.get("input") or "").lower() in {"image", "vision"} for t in tags) else "",
                    ]) - {""})
                    model["category"] = _guess_category(model["name"], model["capabilities"])
            except Exception:
                # 单个模型 tag 页失败不阻塞整个模型库。
                continue
    if not models:
        raise RuntimeError("官方模型库解析为空")
    return {"models": models, "total": len(models), "synced_at": datetime.utcnow().isoformat()}


async def sync_catalog(db: AsyncSession) -> dict[str, Any]:
    """同步官方模型库；失败时写入失败快照但不覆盖旧成功快照。"""
    try:
        payload = await fetch_official_catalog()
        synced_at = datetime.utcnow()
        snapshot = ModelCatalogSnapshot(
            source_url=OLLAMA_LIBRARY_URL,
            synced_at=synced_at,
            status="success",
            error="",
            # 官方模型库偶尔包含 emoji 等 4 字节字符；转义存储可兼容历史 utf8 列。
            payload_json=json.dumps(payload, ensure_ascii=True),
        )
        db.add(snapshot)
        await db.flush()
        return {**payload, "source": "fresh", "last_synced_at": synced_at.isoformat(), "error": ""}
    except Exception as e:
        await db.rollback()
        db.add(ModelCatalogSnapshot(
            source_url=OLLAMA_LIBRARY_URL,
            synced_at=datetime.utcnow(),
            status="failed",
            error=str(e)[:1000],
            payload_json="{}",
        ))
        cached = await get_cached_catalog(db)
        if cached:
            return {**cached["payload"], "source": "cache", "last_synced_at": cached["synced_at"], "error": str(e)}
        return {"models": SEED_MODELS, "total": len(SEED_MODELS), "source": "seed", "last_synced_at": None, "error": str(e)}


async def get_cached_catalog(db: AsyncSession) -> dict[str, Any] | None:
    result = await db.execute(
        select(ModelCatalogSnapshot)
        .where(ModelCatalogSnapshot.status == "success")
        .order_by(desc(ModelCatalogSnapshot.synced_at), desc(ModelCatalogSnapshot.id))
        .limit(1)
    )
    snapshot = result.scalar_one_or_none()
    if not snapshot:
        return None
    try:
        return {
            "payload": _normalize_catalog_payload(json.loads(snapshot.payload_json or "{}")),
            "synced_at": snapshot.synced_at.isoformat() if snapshot.synced_at else None,
        }
    except Exception:
        return None


async def get_catalog(db: AsyncSession) -> dict[str, Any]:
    cached = await get_cached_catalog(db)
    if cached:
        return {**cached["payload"], "source": "cache", "last_synced_at": cached["synced_at"], "error": ""}
    return await sync_catalog(db)


def find_catalog_tag(catalog: dict[str, Any], model_name: str) -> dict[str, Any] | None:
    normalized = model_name if ":" in model_name else f"{model_name}:latest"
    for model in catalog.get("models", []):
        if model.get("name") == model_name:
            normalized = f"{model_name}:{model.get('default_tag') or 'latest'}"
        for tag in model.get("tags", []):
            if tag.get("full_name") == normalized:
                return {**tag, "base_model": model}
    return None
