"""
接口文档配置与 OpenAPI 导入服务
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.api_doc_endpoint import ApiDocEndpoint
from app.models.api_doc_module import ApiDocModule
from app.models.api_doc_source_meta import ApiDocSourceMeta
from app.models.system_config import SystemConfig


PROJECT_ROOT = Path(__file__).resolve().parents[3]
LOCAL_MODEL_DOC_PATH = PROJECT_ROOT / "统一的本地模型调用接口文档.md"


PRODUCT_COPY_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    (f"模{'拟'}调试", "接口示例"),
    ("静态调试原型", "参数预览"),
    (f"静态原{'型'}展示", "参数预览"),
    ("静态联调", "接口示例"),
    ("当前仅展示静态调试结构。", "当前展示接口参数、请求示例和响应结构。"),
    ("当前仅用于演示接口文档与静态调试结构。", "当前用于配置接口文档、请求参数和响应示例。"),
    ("第一版仅用于文档预览与参数结构演示，后续支持真实调试。", "用于查看参数结构，并可结合接口控制台执行调用调试。"),
    ("当前用于展示智能体调用外部能力的请求结构，后续再接入真实工作流调试。", "当前用于展示智能体调用外部能力的请求结构，可结合接口控制台执行调用调试。"),
    ("当前用于展示智能家居平台对接能力，真实调用将在后续科研接口调试页中完成。", "当前用于展示智能家居平台对接能力，并提供接口调用参数。"),
    ("当前用于展示电子沙盘接口结构与示例数据，真实调试页后续再实现。", "当前展示电子沙盘接口结构、请求与响应示例和调用参数。"),
    ("当前用于展示电子沙盘接口结构、示例数据和调用参数。", "当前展示电子沙盘接口结构、请求与响应示例和调用参数。"),
    ("科研接口调试页规划中", "接口调用调试"),
    ("本地模型接口原型", "本地模型接口示例"),
    ("mode\":\"static", "mode\":\"example"),
    ("\"mode\": \"static", "\"mode\": \"example"),
    ("status\":\"static", "status\":\"example"),
    ("\"status\": \"static", "\"status\": \"example"),
)


def clean_product_copy(value: Any) -> Any:
    if isinstance(value, str):
        result = value
        for old, new in PRODUCT_COPY_REPLACEMENTS:
            result = result.replace(old, new)
        return result
    if isinstance(value, list):
        return [clean_product_copy(item) for item in value]
    if isinstance(value, dict):
        return {key: clean_product_copy(item) for key, item in value.items()}
    return value


MODULE_SEEDS: list[dict[str, Any]] = [
    {
        "slug": "local-model",
        "title": "统一的本地模型调用接口",
        "subtitle": "支持文本生成、多轮对话与模型运行联调的统一入口。",
        "description": "面向本地大语言模型服务的统一调用入口，支持文本生成、多轮对话等能力，适合作为模型联调与应用接入的基础接口。",
        "markdown_content": "## 模块说明\n\n该模块用于展示本地大语言模型服务在平台中的统一调用方式，当前适合作为模型联调、科研接入和接口截图演示入口。",
        "endpoint_base": "/api/v1/chat",
        "sort_order": 10,
        "capability_tags": ["文本生成", "多轮对话", "流式响应"],
        "highlights": [
            {"title": "统一会话入口", "description": "集中展示文本生成、多轮对话和运行记录。"},
            {"title": "科研示例", "description": "内置 cURL、JavaScript、Python 三种示例。"},
        ],
        "groups": [
            {"id": "generation", "label": "生成接口"},
            {"id": "sessions", "label": "会话接口"},
            {"id": "evaluation", "label": "调试与评估"},
        ],
        "playground": {
            "title": "本地模型调用调试台",
            "targetLabel": "参数预览",
            "statusLabel": "接口示例",
            "note": "用于查看参数结构，并可结合接口控制台执行调用调试。",
            "fields": [
                {"id": "query", "label": "提示词", "type": "textarea", "value": "请介绍智慧家居智能体。"},
                {"id": "conversation_id", "label": "会话 ID", "type": "text", "value": ""},
            ],
            "presets": [
                {
                    "id": "chat-demo",
                    "label": "文本生成示例",
                    "description": "展示文本生成与多轮对话的基础调用结构。",
                    "requestPreview": "{\"query\":\"请介绍智慧家居智能体。\",\"conversation_id\":\"\"}",
                    "responseBody": "{\"answer\":\"智慧家居智能体可以理解自然语言并驱动设备控制。\"}",
                    "responseMeta": "{\"status\":200,\"mode\":\"example\"}",
                }
            ],
        },
    },
    {
        "slug": "agent-external",
        "title": "智能体调用外部功能接口",
        "subtitle": "面向智能体工作流调用外部设备、知识库与系统能力的统一入口。",
        "description": "该模块用于集中展示智能体调用外部功能接口的统一结构，覆盖设备控制接口、数据查询接口、知识库检索接口、文件与系统接口。",
        "markdown_content": "## 模块说明\n\n该模块面向智能体科研工作流的外部功能调用能力展示，适合演示智能体如何访问平台外部能力。",
        "endpoint_base": "/api/v1",
        "sort_order": 20,
        "capability_tags": ["设备控制", "数据查询", "知识库检索", "系统接口"],
        "highlights": [
            {"title": "统一调用视图", "description": "将智能体外部能力调用统一收敛到一个模块内展示。"},
            {"title": "可扩展绑定", "description": "后续支持为不同科研接口模块绑定独立调试页。"},
        ],
        "groups": [
            {"id": "external", "label": "外部能力"},
            {"id": "orchestration", "label": "编排联动"},
        ],
        "playground": {
            "title": "智能体外部能力调试台",
            "targetLabel": "接口调用调试",
            "statusLabel": "接口示例",
            "note": "当前用于展示智能体调用外部能力的请求结构，可结合接口控制台执行调用调试。",
            "fields": [
                {"id": "intent", "label": "调用意图", "type": "text", "value": "打开客厅灯并查询当前室温"},
                {"id": "agent", "label": "智能体实例", "type": "text", "value": "main-orchestrator"},
            ],
            "presets": [
                {
                    "id": "external-demo",
                    "label": "外部能力示例",
                    "description": "展示智能体调用设备控制与数据查询的请求预览。",
                    "requestPreview": "{\"intent\":\"打开客厅灯并查询当前室温\"}",
                    "responseBody": "{\"status\":\"planned\",\"message\":\"科研接口调试页规划中\"}",
                    "responseMeta": "{\"status\":200,\"mode\":\"example\"}",
                }
            ],
        },
    },
    {
        "slug": "smart-home",
        "title": "智能家居系统对接能力",
        "subtitle": "展示与主流智能家居平台进行设备接入、状态同步与控制的接口能力。",
        "description": "用于对接智能家居平台或系统，通过开放接口实现设备状态查询、传感器数据访问与设备控制。",
        "markdown_content": "## 模块说明\n\n该模块主要用于展示平台与 Home Assistant 等智能家居系统的对接能力。",
        "endpoint_base": "/api/v1/devices",
        "sort_order": 30,
        "capability_tags": ["设备台账", "网关接入", "设备状态", "场景信息", "控制回读"],
        "highlights": [
            {"title": "主流平台对接", "description": "支持通过标准接口对接 Home Assistant 等平台。"},
            {"title": "开放接口", "description": "设备台账、网关接入、场景信息和控制能力统一通过开放接口提供。"},
        ],
        "groups": [
            {"id": "ledger", "label": "设备台账"},
            {"id": "state", "label": "状态查询"},
            {"id": "scenes", "label": "场景能力"},
            {"id": "control", "label": "控制执行"},
            {"id": "gateways", "label": "网关接入"},
        ],
        "playground": {
            "title": "智能家居接口调试台",
            "targetLabel": "接口调用调试",
            "statusLabel": "接口示例",
            "note": "当前用于展示智能家居平台对接能力，并提供接口调用参数。",
            "fields": [
                {"id": "entity_id", "label": "设备实体 ID", "type": "text", "value": "light.ke_ting_deng"},
            ],
            "presets": [
                {
                    "id": "smart-home-demo",
                    "label": "设备状态示例",
                    "description": "展示设备状态与传感器数据查询结构。",
                    "requestPreview": "{\"entity_id\":\"light.ke_ting_deng\"}",
                    "responseBody": "{\"state\":\"on\",\"attributes\":{\"friendly_name\":\"客厅灯\"}}",
                    "responseMeta": "{\"status\":200,\"mode\":\"example\"}",
                }
            ],
        },
    },
    {
        "slug": "sandbox",
        "title": "虚拟设备系统与电子沙盘系统对接能力",
        "subtitle": "展示虚拟设备系统、电子沙盘系统的数据接入与控制能力。",
        "description": "用于对接虚拟设备系统与电子沙盘系统，支持获取虚拟设备状态、传感器数据、场景信息，并实现交互控制。",
        "markdown_content": "## 模块说明\n\n该模块用于承载电子沙盘与虚拟设备系统的接口能力展示和后续科研联调入口。",
        "endpoint_base": "/api/v1/sandbox",
        "sort_order": 40,
        "capability_tags": ["虚拟设备", "电子沙盘", "场景控制"],
        "highlights": [
            {"title": "沙盘联动", "description": "支持将虚拟环境中的设备状态映射到平台接口。"},
            {"title": "科研演示", "description": "适合作为虚拟环境交互和控制演示入口。"},
        ],
        "groups": [
            {"id": "sandbox-state", "label": "状态与配置"},
            {"id": "sandbox-control", "label": "交互控制"},
        ],
        "playground": {
            "title": "电子沙盘调试台",
            "targetLabel": "接口调用调试",
            "statusLabel": "接口示例",
            "note": "当前展示电子沙盘接口结构、请求与响应示例和调用参数。",
            "fields": [
                {"id": "scene", "label": "场景名称", "type": "text", "value": "客厅晚间模式"},
            ],
            "presets": [
                {
                    "id": "sandbox-demo",
                    "label": "沙盘控制示例",
                    "description": "展示虚拟设备与电子沙盘的场景控制结构。",
                    "requestPreview": "{\"scene\":\"客厅晚间模式\"}",
                    "responseBody": "{\"success\":true,\"scene\":\"客厅晚间模式\"}",
                    "responseMeta": "{\"status\":200,\"mode\":\"example\"}",
                }
            ],
        },
    },
    {
        "slug": "device-data",
        "title": "统一的设备数据访问接口",
        "subtitle": "统一展示实时状态、历史数据和设备运行信息的查询能力。",
        "description": "面向设备数据访问与科研分析的统一入口，支持实时状态数据、历史数据、设备运行信息等查询能力。",
        "markdown_content": "## 模块说明\n\n该模块聚焦设备数据访问，便于演示状态查询、历史趋势和运行信息查看能力。",
        "endpoint_base": "/api/v1/states",
        "sort_order": 50,
        "capability_tags": ["实时状态", "历史数据", "运行信息"],
        "highlights": [
            {"title": "统一查询入口", "description": "将设备实时、历史和运行信息放在统一的数据访问视图中。"},
            {"title": "适合科研分析", "description": "便于后续扩展为趋势分析和实验记录调试页。"},
        ],
        "groups": [
            {"id": "realtime", "label": "实时状态"},
            {"id": "history", "label": "历史趋势"},
            {"id": "runtime", "label": "运行信息"},
        ],
        "playground": {
            "title": "设备数据访问调试台",
            "targetLabel": "接口调用调试",
            "statusLabel": "接口示例",
            "note": "请求示例仅用于填写参数；执行调试后展示平台设备台账与 Home Assistant 的真实响应。",
            "fields": [
                {"id": "keyword", "label": "设备关键词", "type": "text", "value": ""},
            ],
            "presets": [
                {
                    "id": "device-data-demo",
                    "label": "数据查询示例",
                    "description": "展示实时状态与历史数据查询结构。",
                    "requestPreview": "{\"page\":1,\"size\":20,\"keyword\":\"\"}",
                    "responseBody": "{\"items\":[],\"summary\":{},\"page\":1,\"size\":20,\"total\":0,\"pages\":1}",
                    "responseMeta": "{\"status\":200,\"mode\":\"example\"}",
                }
            ],
        },
    },
    {
        "slug": "device-control",
        "title": "统一的设备控制接口",
        "subtitle": "统一展示智能体或外部系统发送控制请求并获取执行结果的能力。",
        "description": "用于向外部系统发送控制请求并获取执行结果，支持智能体向外部系统发送设备控制命令并返回执行反馈。",
        "markdown_content": "## 模块说明\n\n该模块用于承载统一设备控制接口的能力展示和后续科研控制调试页。",
        "endpoint_base": "/api/v1/devices",
        "sort_order": 60,
        "capability_tags": ["控制请求", "执行结果", "智能体联动"],
        "highlights": [
            {"title": "统一控制链路", "description": "控制请求与执行结果统一通过平台接口返回。"},
            {"title": "适配智能体调用", "description": "支持 Dify 工作流或智能体通过统一方式调用设备控制。"},
        ],
        "groups": [
            {"id": "control", "label": "控制接口"},
            {"id": "results", "label": "执行回执"},
        ],
        "playground": {
            "title": "设备控制调试台",
            "targetLabel": "接口调用调试",
            "statusLabel": "接口示例",
            "note": "当前用于展示设备控制接口的参数结构和执行回执结构。",
            "fields": [
                {"id": "entity_id", "label": "设备实体 ID", "type": "text", "value": "light.ke_ting_deng"},
                {"id": "service", "label": "控制动作", "type": "select", "value": "turn_on", "options": [{"label": "打开", "value": "turn_on"}, {"label": "关闭", "value": "turn_off"}]},
            ],
            "presets": [
                {
                    "id": "device-control-demo",
                    "label": "控制示例",
                    "description": "展示设备控制接口的请求与回执。",
                    "requestPreview": "{\"service\":\"turn_on\"}",
                    "responseBody": "{\"success\":true,\"entity_id\":\"light.ke_ting_deng\",\"new_state\":\"on\"}",
                    "responseMeta": "{\"status\":200,\"mode\":\"example\"}",
                }
            ],
        },
    },
    {
        "slug": "knowledge",
        "title": "知识库检索接口",
        "subtitle": "展示知识库管理、文档导入、语义检索与问答增强能力。",
        "description": "用于查看知识库管理与检索相关接口，支撑文档导入、存储、组织与语义检索等能力。",
        "markdown_content": "## 模块说明\n\n该模块用于展示知识库管理、文档导入、语义检索和命中测试等接口能力。",
        "endpoint_base": "/api/v1/knowledge",
        "sort_order": 70,
        "capability_tags": ["文档导入", "语义检索", "命中测试"],
        "highlights": [
            {"title": "知识增强", "description": "支持文档导入、知识库组织和语义召回。"},
            {"title": "可持续管理", "description": "支持增量更新、删除和命中测试。"},
        ],
        "groups": [
            {"id": "datasets", "label": "知识库管理"},
            {"id": "documents", "label": "文档管理"},
            {"id": "retrieval", "label": "检索接口"},
        ],
        "playground": {
            "title": "知识库检索调试台",
            "targetLabel": "接口调用调试",
            "statusLabel": "接口示例",
            "note": "当前用于展示知识库导入、检索和命中测试相关接口的结构。",
            "fields": [
                {"id": "query", "label": "检索问题", "type": "textarea", "value": "系统支持哪些外部接口？"},
            ],
            "presets": [
                {
                    "id": "knowledge-demo",
                    "label": "检索示例",
                    "description": "展示语义检索与知识命中测试的响应结构。",
                    "requestPreview": "{\"query\":\"系统支持哪些外部接口？\"}",
                    "responseBody": "{\"records\":[{\"content\":\"支持设备控制接口、数据查询接口...\"}]}",
                    "responseMeta": "{\"status\":200,\"mode\":\"example\"}",
                }
            ],
        },
    },
    {
        "slug": "system",
        "title": "文件与系统接口",
        "subtitle": "展示认证、系统设置、运行状态、用户与文件相关能力。",
        "description": "用于查看认证、系统设置、运行状态、用户管理等接口能力，用于平台集成与系统维护。",
        "markdown_content": "## 模块说明\n\n该模块用于展示文件与系统接口、认证接口和系统运行信息接口。",
        "endpoint_base": "/api/v1/system",
        "sort_order": 80,
        "capability_tags": ["系统设置", "运行状态", "用户管理"],
        "highlights": [
            {"title": "系统维护", "description": "集中展示平台系统配置、健康检查与用户管理相关接口。"},
            {"title": "文件与状态", "description": "适合作为平台集成与系统维护的文档入口。"},
        ],
        "groups": [
            {"id": "auth", "label": "认证与安全"},
            {"id": "settings", "label": "系统配置"},
            {"id": "status", "label": "运行状态"},
        ],
        "playground": {
            "title": "系统接口调试台",
            "targetLabel": "接口调用调试",
            "statusLabel": "接口示例",
            "note": "当前用于展示认证、系统设置与运行状态接口结构。",
            "fields": [
                {"id": "service", "label": "服务名称", "type": "text", "value": "dify"},
            ],
            "presets": [
                {
                    "id": "system-demo",
                    "label": "系统状态示例",
                    "description": "展示系统运行状态和配置信息查询结构。",
                    "requestPreview": "{\"service\":\"dify\"}",
                    "responseBody": "{\"status\":\"running\",\"latencyMs\":86}",
                    "responseMeta": "{\"status\":200,\"mode\":\"example\"}",
                }
            ],
        },
    },
]


CONTRACT_MODULE_PATCHES: dict[str, dict[str, Any]] = {
    "smart-home": {
        "groups": [
            {"id": "ledger", "label": "设备台账"},
            {"id": "state", "label": "状态查询"},
            {"id": "scenes", "label": "场景能力"},
            {"id": "control", "label": "控制执行"},
            {"id": "gateways", "label": "网关接入"},
        ],
    },
    "device-data": {
        "endpoint_base": "/api/v1/states",
        "subtitle": "统一查询设备实时状态、传感器数据、状态汇总与历史记录。",
        "description": "设备实时状态、传感器和运行汇总通过统一状态接口读取，历史记录复用 Home Assistant 真实历史数据。",
        "markdown_content": "## 模块说明\n\n`/states` 是统一只读查询入口，复用平台设备台账和 Home Assistant 状态快照，不维护第二套状态，也不生成演示传感器数据。历史数据由 `/monitor/device-history` 提供真实 HA History 记录。",
        "groups": [
            {"id": "realtime", "label": "实时状态"},
            {"id": "sensors", "label": "传感器数据"},
            {"id": "history", "label": "历史趋势"},
            {"id": "runtime", "label": "运行信息"},
        ],
        "capability_tags": ["实时状态", "历史数据", "运行信息"],
    },
}


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return normalized or "item"


def extract_endpoint_sections(markdown: str) -> list[dict[str, str]]:
    pattern = re.compile(
        r"^##\s+(.+?)\s+·\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s*$",
        re.MULTILINE,
    )
    matches = list(pattern.finditer(markdown))
    sections: list[dict[str, str]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        sections.append(
            {
                "title": match.group(1).strip(),
                "method": match.group(2).strip().upper(),
                "path": match.group(3).strip(),
                "body": markdown[start:end].strip(),
            }
        )
    return sections


def first_meaningful_paragraph(section_body: str) -> str:
    paragraphs = [block.strip() for block in re.split(r"\n\s*\n", section_body) if block.strip()]
    for paragraph in paragraphs:
        if paragraph.startswith("**端点**") or paragraph.startswith("```") or paragraph.startswith("|") or paragraph.startswith("###"):
            continue
        lines = [line.strip() for line in paragraph.splitlines() if line.strip()]
        if lines:
            return " ".join(lines)
    return ""


def extract_table_after_heading(section_body: str, heading: str) -> tuple[list[str], list[list[str]]]:
    heading_match = re.search(
        rf"^###\s+{re.escape(heading)}\s*$",
        section_body,
        re.MULTILINE,
    )
    if not heading_match:
        return [], []

    next_heading = re.search(r"^#{2,3}\s+", section_body[heading_match.end():], re.MULTILINE)
    subsection_end = heading_match.end() + next_heading.start() if next_heading else len(section_body)
    subsection = section_body[heading_match.end():subsection_end]
    table_match = re.search(r"((?:^\|.*(?:\n|$))+)", subsection, re.MULTILINE)
    if not table_match:
        return [], []

    lines = [line.strip() for line in table_match.group(1).splitlines() if line.strip().startswith("|")]
    if len(lines) < 2:
        return [], []

    def normalize_cell(cell: str) -> str:
        value = cell.strip().replace("\\|", "|")
        if value.startswith("`") and value.endswith("`") and len(value) >= 2:
            value = value[1:-1].strip()
        value = value.replace("\\`", "`").replace("`", "")
        return value.strip()

    def split_row(line: str) -> list[str]:
        placeholder = "__CODEx_ESCAPED_PIPE__"
        protected = line.strip("|").replace("\\|", placeholder)
        return [normalize_cell(cell.replace(placeholder, "|")) for cell in protected.split("|")]

    headers = split_row(lines[0])
    data_lines = [line for line in lines[2:] if not re.fullmatch(r"\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?", line)]
    rows = [split_row(line) for line in data_lines]
    return headers, rows


def markdown_request_params(section_body: str) -> list[dict[str, Any]]:
    headers, rows = extract_table_after_heading(section_body, "请求参数")
    if not headers or not rows:
        return []

    index_map = {header: idx for idx, header in enumerate(headers)}
    params: list[dict[str, Any]] = []
    for row in rows:
        name = row[index_map.get("参数名", 0)] if index_map.get("参数名", 0) < len(row) else ""
        if not name:
            continue
        param_type = row[index_map.get("类型", 1)] if index_map.get("类型", 1) < len(row) else "string"
        required_text = row[index_map.get("必填", 2)] if index_map.get("必填", 2) < len(row) else ""
        description = row[index_map.get("说明", 3)] if index_map.get("说明", 3) < len(row) else ""
        params.append(
            {
                "name": name,
                "location": "body",
                "type": param_type,
                "required": "✅" in required_text or required_text.lower() in {"yes", "true"},
                "description": description,
            }
        )
    return params


def markdown_response_fields(section_body: str) -> list[dict[str, str]]:
    headers, rows = extract_table_after_heading(section_body, "响应字段")
    if not headers or not rows:
        headers, rows = extract_table_after_heading(section_body, "返回字段")
    if not headers or not rows:
        return []

    index_map = {header: idx for idx, header in enumerate(headers)}
    fields: list[dict[str, str]] = []
    for row in rows:
        name_idx = index_map.get("字段名", index_map.get("字段", 0))
        field_type_idx = index_map.get("类型", 1)
        desc_idx = index_map.get("说明", 2)
        if name_idx >= len(row):
            continue
        fields.append(
            {
                "name": row[name_idx],
                "type": row[field_type_idx] if field_type_idx < len(row) else "string",
                "description": row[desc_idx] if desc_idx < len(row) else "",
            }
        )
    return fields


def extract_code_block(section_body: str, language: str) -> str:
    pattern = re.compile(rf"```{re.escape(language)}\n(.*?)```", re.DOTALL)
    match = pattern.search(section_body)
    return match.group(1).strip() if match else ""


def extract_json_blocks(section_body: str) -> list[str]:
    return [match.group(1).strip() for match in re.finditer(r"```json\n(.*?)```", section_body, re.DOTALL)]


def extract_curl_json_body(section_body: str) -> str:
    """从文档中的 cURL 示例提取请求体，避免把 JSON 响应误当成请求示例。"""
    for match in re.finditer(r"```bash\n(.*?)```", section_body, re.DOTALL):
        code = match.group(1)
        body_match = re.search(r"(?:--data(?:-raw|-binary)?|-d)\s+(['\"])(.*?)\1", code, re.DOTALL)
        if not body_match:
            continue
        body_text = body_match.group(2).strip()
        try:
            return json.dumps(json.loads(body_text), ensure_ascii=False, indent=2)
        except json.JSONDecodeError:
            continue
    return ""


def local_model_group_for_path(path: str) -> str:
    if path in {"/api/generate", "/api/chat"}:
        return "generation"
    if path == "/api/embed":
        return "embeddings"
    if path in {"/api/tags", "/api/ps"}:
        return "runtime"
    return "models"


def local_model_code_samples(method: str, path: str, section_body: str) -> list[dict[str, str]]:
    code_samples: list[dict[str, str]] = []
    for sample_id, label, language in (
        ("curl", "cURL", "bash"),
        ("javascript", "JavaScript", "javascript"),
        ("python", "Python", "python"),
    ):
        code = extract_code_block(section_body, language)
        if code:
            code_samples.append(
                {
                    "id": sample_id,
                    "label": label,
                    "language": language,
                    "code": code,
                }
            )
    if code_samples:
        return code_samples
    return build_manual_code_samples(method, path, "")


def build_local_model_doc_endpoints(markdown: str) -> list[dict[str, Any]]:
    endpoints: list[dict[str, Any]] = []
    for index, section in enumerate(extract_endpoint_sections(markdown), start=1):
        json_blocks = extract_json_blocks(section["body"])
        request_preview = extract_curl_json_body(section["body"])
        endpoints.append(
            {
                "slug": slugify(f"local-model-{section['method']}-{section['path']}"),
                "group_key": local_model_group_for_path(section["path"]),
                "method": section["method"],
                "path": section["path"],
                "summary": section["title"],
                "description": first_meaningful_paragraph(section["body"]) or f"{section['title']} 接口说明。",
                "source_type": "markdown",
                "source_identifier": f"ollama-markdown:{section['method']}:{section['path']}",
                "sort_order": index * 10,
                "is_visible": True,
                "tags": ["Ollama", "Local Model"],
                "params": markdown_request_params(section["body"]),
                "responses": markdown_response_fields(section["body"]),
                "notes": [
                    "该接口由《统一的本地模型调用接口文档》同步生成。",
                    "当前接口说明以 Ollama 本地模型服务为准。",
                ],
                "code_samples": local_model_code_samples(section["method"], section["path"], section["body"]),
                "request_preview": request_preview or "{}",
                "response_body": json_blocks[0] if json_blocks else "{}",
                "response_meta": json.dumps(
                    {
                        "status": 200,
                        "source": "ollama-markdown",
                        "method": section["method"],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            }
        )
    return endpoints


def build_manual_code_samples(method: str, path: str, request_preview: str) -> list[dict[str, str]]:
    curl_body = f" -d '{request_preview}'" if method in {"POST", "PUT", "PATCH"} and request_preview else ""
    js_body = (
        f",\n  body: JSON.stringify({request_preview})" if method in {"POST", "PUT", "PATCH"} and request_preview else ""
    )
    py_json = f",\n    json={request_preview}" if method in {"POST", "PUT", "PATCH"} and request_preview else ""
    return [
        {
            "id": "curl",
            "label": "cURL",
            "language": "bash",
            "code": f'curl -X {method} "http://your-host{path}" \\\n  -H "Authorization: Bearer <token>" \\\n  -H "Content-Type: application/json"{curl_body}',
        },
        {
            "id": "javascript",
            "label": "JavaScript",
            "language": "javascript",
            "code": f"""const res = await fetch('{path}', {{
  method: '{method}',
  headers: {{
    Authorization: `Bearer ${{token}}`,
    'Content-Type': 'application/json',
  }}{js_body}
}})""",
        },
        {
            "id": "python",
            "label": "Python",
            "language": "python",
            "code": f"""import httpx

response = httpx.request(
    "{method}",
    "http://your-host{path}",
    headers={{"Authorization": f"Bearer {{token}}"}}{py_json}
)""",
        },
    ]


def build_contract_reference_endpoint(
    *,
    module_slug: str,
    identifier: str,
    group_key: str,
    method: str,
    path: str,
    summary: str,
    description: str,
    params: list[dict[str, Any]],
    responses: list[dict[str, str]],
    request_preview: str = "",
    response_body: str = "",
    tags: list[str] | None = None,
    sort_order: int = 10,
) -> dict[str, Any]:
    return {
        "slug": slugify(f"{module_slug}-{identifier}-{method}-{path}"),
        "group_key": group_key,
        "method": method,
        "path": path,
        "summary": summary,
        "description": description,
        "source_type": "contract",
        "source_identifier": f"contract:{module_slug}:{identifier}",
        "sort_order": sort_order,
        "is_visible": True,
        "tags": tags or ["Contract", "Reference"],
        "params": params,
        "responses": responses,
        "notes": [],
        "code_samples": build_manual_code_samples(method, path, request_preview),
        "request_preview": request_preview,
        "response_body": response_body or json.dumps({"success": True, "path": path}, ensure_ascii=False, indent=2),
        "response_meta": json.dumps({"status": 200, "source": "contract-reference", "method": method}, ensure_ascii=False, indent=2),
    }


CONTRACT_REFERENCE_ENDPOINTS: dict[str, list[dict[str, Any]]] = {
    "agent-external": [
        build_contract_reference_endpoint(
            module_slug="agent-external",
            identifier="device-control",
            group_key="external",
            method="POST",
            path="/api/v1/devices/{device_ref}/control",
            summary="设备控制接口",
            description="智能体通过统一设备控制接口向外部系统发送控制请求，并获取执行结果。",
            params=[
                {"name": "device_ref", "location": "path", "type": "string", "required": True, "description": "平台设备 ID 或已纳管 Home Assistant 实体 ID。"},
                {"name": "service", "location": "body", "type": "string", "required": False, "description": "控制动作，如 turn_on / turn_off。", "defaultValue": "toggle"},
                {"name": "domain", "location": "body", "type": "string", "required": False, "description": "可选 HA domain；填写时必须与目标实体类型一致。"},
                {"name": "data", "location": "body", "type": "object", "required": False, "description": "亮度、温度、位置等控制参数。"},
                {"name": "role", "location": "body", "type": "string", "required": False, "description": "平台设备映射角色。"},
            ],
            responses=[
                {"name": "success", "type": "boolean", "description": "控制是否成功。"},
                {"name": "entity_id", "type": "string", "description": "被控制的设备实体 ID。"},
                {"name": "new_state", "type": "string", "description": "控制后的最新状态。"},
            ],
            request_preview=json.dumps({"service": "turn_on"}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"success": True, "entity_id": "light.ke_ting_deng", "new_state": "on"}, ensure_ascii=False, indent=2),
            tags=["Agent", "Device Control"],
            sort_order=10,
        ),
        build_contract_reference_endpoint(
            module_slug="agent-external",
            identifier="data-query",
            group_key="external",
            method="GET",
            path="/api/v1/monitor/device-realtime",
            summary="数据查询接口",
            description="智能体通过统一数据查询接口访问设备实时状态与相关传感器数据。",
            params=[
                {"name": "entity_id", "location": "query", "type": "string", "required": True, "description": "目标设备实体 ID。", "defaultValue": "sensor.shi_nei_wen_du"},
            ],
            responses=[
                {"name": "entity_id", "type": "string", "description": "目标实体 ID。"},
                {"name": "state", "type": "string", "description": "当前实时状态值。"},
                {"name": "attributes", "type": "object", "description": "扩展属性与传感器元数据。"},
            ],
            response_body=json.dumps({"entity_id": "", "state": None, "attributes": {}}, ensure_ascii=False, indent=2),
            tags=["Agent", "Data Query"],
            sort_order=20,
        ),
        build_contract_reference_endpoint(
            module_slug="agent-external",
            identifier="knowledge-retrieval",
            group_key="external",
            method="POST",
            path="/api/v1/knowledge/datasets/{dataset_id}/hit-testing",
            summary="知识库检索接口",
            description="智能体通过知识库检索接口获取相关知识片段与语义命中结果。",
            params=[
                {"name": "dataset_id", "location": "path", "type": "string", "required": True, "description": "知识库 ID。"},
                {"name": "query", "location": "body", "type": "string", "required": True, "description": "检索问题。", "defaultValue": "系统支持哪些外部功能接口？"},
            ],
            responses=[
                {"name": "query", "type": "string", "description": "检索问题。"},
                {"name": "records", "type": "array<object>", "description": "知识库命中结果列表。"},
                {"name": "hit_count", "type": "integer", "description": "本次真实命中数量。"},
                {"name": "duration_ms", "type": "integer", "description": "检索耗时，单位毫秒。"},
                {"name": "executed_at", "type": "string", "description": "检索执行时间。"},
                {"name": "audit_recorded", "type": "boolean", "description": "是否已记录检索审计。"},
            ],
            request_preview=json.dumps({"query": "系统支持哪些外部功能接口？"}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"query": "系统支持哪些外部功能接口？", "records": [{"content": "支持设备控制接口、数据查询接口、知识库检索接口、文件与系统接口。"}], "hit_count": 1, "duration_ms": 18, "executed_at": "", "audit_recorded": True}, ensure_ascii=False, indent=2),
            tags=["Agent", "Knowledge Retrieval"],
            sort_order=30,
        ),
        build_contract_reference_endpoint(
            module_slug="agent-external",
            identifier="file-system",
            group_key="external",
            method="GET",
            path="/api/v1/system/info",
            summary="文件与系统接口",
            description="智能体通过文件与系统接口访问平台运行信息、系统状态与维护能力。",
            params=[],
            responses=[
                {"name": "version", "type": "string", "description": "平台应用版本。"},
                {"name": "python_version", "type": "string", "description": "Python 运行时版本。"},
                {"name": "os_info", "type": "string", "description": "操作系统与处理器架构。"},
                {"name": "db_status", "type": "string", "description": "数据库连接状态。"},
                {"name": "uptime_seconds", "type": "integer", "description": "服务进程运行秒数。"},
                {"name": "uptime_display", "type": "string", "description": "便于阅读的运行时长。"},
                {"name": "api_docs_url", "type": "string", "description": "后端接口文档地址。"},
                {"name": "config_source", "type": "string", "description": "当前运行时配置来源。"},
                {"name": "runtime_details_visible", "type": "boolean", "description": "当前账号是否有权查看运行环境明细。"},
            ],
            response_body=json.dumps({"version": "", "python_version": "", "os_info": "", "db_status": "unknown", "uptime_seconds": 0, "uptime_display": "", "api_docs_url": "/api/docs", "config_source": "", "runtime_details_visible": False}, ensure_ascii=False, indent=2),
            tags=["Agent", "System"],
            sort_order=40,
        ),
    ],
    "smart-home": [
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="device-ledger-list",
            group_key="ledger",
            method="GET",
            path="/api/v1/devices",
            summary="设备台账列表",
            description="查询平台设备台账，返回设备信息、实体映射、实时状态、场景和统计摘要。",
            params=[
                {"name": "page", "location": "query", "type": "integer", "required": False, "description": "页码。", "defaultValue": 1},
                {"name": "size", "location": "query", "type": "integer", "required": False, "description": "每页数量。", "defaultValue": 20},
                {"name": "category", "location": "query", "type": "string", "required": False, "description": "设备类型筛选，如 light / switch / sensor。"},
                {"name": "gateway_id", "location": "query", "type": "integer", "required": False, "description": "所属网关 ID。"},
                {"name": "status", "location": "query", "type": "string", "required": False, "description": "在线、离线、未映射或未启用状态。"},
                {"name": "keyword", "location": "query", "type": "string", "required": False, "description": "设备名称、位置、品牌、型号或实体关键词。", "defaultValue": ""},
                {"name": "sort", "location": "query", "type": "string", "required": False, "description": "排序方式，如 name / updated_at。", "defaultValue": "name"},
                {"name": "refresh", "location": "query", "type": "boolean", "required": False, "description": "是否跳过短期缓存并强制读取当前状态。", "defaultValue": False},
            ],
            responses=[
                {"name": "devices", "type": "array<object>", "description": "设备台账与映射列表。"},
                {"name": "summary", "type": "object", "description": "设备总数、在线数和分类统计。"},
                {"name": "ha_error", "type": "string", "description": "HA 不可达时的降级说明。"},
            ],
            response_body=json.dumps({"devices": [], "scenes": [], "summary": {"total": 0, "online": 0}, "ha_error": None}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Device Ledger"],
            sort_order=5,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="device-ledger-create",
            group_key="ledger",
            method="POST",
            path="/api/v1/devices",
            summary="新增设备台账",
            description="新增平台侧设备台账和实体映射；不会在 HA 或真实硬件中创建设备。",
            params=[
                {"name": "name", "location": "body", "type": "string", "required": True, "description": "设备名称。"},
                {"name": "category", "location": "body", "type": "string", "required": False, "description": "设备分类，如 switch / light / sensor。", "defaultValue": "switch"},
                {"name": "brand", "location": "body", "type": "string", "required": False, "description": "设备品牌。"},
                {"name": "model", "location": "body", "type": "string", "required": False, "description": "设备型号。"},
                {"name": "location", "location": "body", "type": "string", "required": False, "description": "安装位置。"},
                {"name": "protocol", "location": "body", "type": "string", "required": False, "description": "接入协议。", "defaultValue": "homeassistant"},
                {"name": "gateway_id", "location": "body", "type": "integer", "required": False, "description": "所属网关 ID。"},
                {"name": "description", "location": "body", "type": "string", "required": False, "description": "设备说明。"},
                {"name": "local_control", "location": "body", "type": "boolean", "required": False, "description": "是否支持本地控制。", "defaultValue": False},
                {"name": "enabled", "location": "body", "type": "boolean", "required": False, "description": "是否启用该台账。", "defaultValue": True},
                {"name": "capability_tags", "location": "body", "type": "array<string>", "required": False, "description": "设备能力标签。"},
                {"name": "mappings", "location": "body", "type": "array<object>", "required": False, "description": "实体映射列表。"},
            ],
            responses=[
                {"name": "id", "type": "string", "description": "平台设备 ID。"},
                {"name": "name", "type": "string", "description": "设备名称。"},
                {"name": "mappings", "type": "array<object>", "description": "设备实体映射。"},
            ],
            request_preview=json.dumps({"name": "客厅灯", "category": "light", "gateway_id": 1, "mappings": [{"role": "power", "endpoint": "input_boolean.light_living_room", "gateway_type": "homeassistant", "access_mode": "rw"}]}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"id": "", "name": "", "status": "unmapped", "mappings": []}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Device Ledger"],
            sort_order=6,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="device-ledger-detail",
            group_key="ledger",
            method="GET",
            path="/api/v1/devices/{device_ref}",
            summary="设备详情与实时状态",
            description="按平台设备 ID 或已纳管实体 ID 查询台账、实体映射、实时状态和最近控制日志。",
            params=[
                {"name": "device_ref", "location": "path", "type": "string", "required": True, "description": "平台设备 ID 或已纳管 Home Assistant 实体 ID。"},
            ],
            responses=[
                {"name": "entities", "type": "object", "description": "设备角色到实体状态的映射。"},
                {"name": "logs", "type": "array<object>", "description": "该设备相关的最近控制日志。"},
            ],
            response_body=json.dumps({"id": "", "name": "", "entities": {}, "logs": []}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Device Ledger"],
            sort_order=7,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="device-ledger-update",
            group_key="ledger",
            method="PUT",
            path="/api/v1/devices/{device_id}",
            summary="更新设备台账",
            description="更新平台设备基础信息、启用状态和实体映射。",
            params=[
                {"name": "device_id", "location": "path", "type": "integer", "required": True, "description": "平台设备 ID。"},
                {"name": "name", "location": "body", "type": "string", "required": True, "description": "设备名称。"},
                {"name": "category", "location": "body", "type": "string", "required": False, "description": "设备分类。", "defaultValue": "switch"},
                {"name": "brand", "location": "body", "type": "string", "required": False, "description": "设备品牌。"},
                {"name": "model", "location": "body", "type": "string", "required": False, "description": "设备型号。"},
                {"name": "location", "location": "body", "type": "string", "required": False, "description": "安装位置。"},
                {"name": "protocol", "location": "body", "type": "string", "required": False, "description": "接入协议。", "defaultValue": "homeassistant"},
                {"name": "gateway_id", "location": "body", "type": "integer", "required": False, "description": "所属网关 ID。"},
                {"name": "description", "location": "body", "type": "string", "required": False, "description": "设备说明。"},
                {"name": "local_control", "location": "body", "type": "boolean", "required": False, "description": "是否支持本地控制。", "defaultValue": False},
                {"name": "enabled", "location": "body", "type": "boolean", "required": False, "description": "是否启用。", "defaultValue": True},
                {"name": "capability_tags", "location": "body", "type": "array<string>", "required": False, "description": "设备能力标签。"},
                {"name": "mappings", "location": "body", "type": "array<object>", "required": False, "description": "更新后的完整映射列表。"},
            ],
            responses=[
                {"name": "id", "type": "string", "description": "平台设备 ID。"},
                {"name": "enabled", "type": "boolean", "description": "设备启用状态。"},
                {"name": "mappings", "type": "array<object>", "description": "更新后的实体映射。"},
            ],
            request_preview=json.dumps({"name": "客厅灯", "category": "light", "enabled": True, "mappings": [{"role": "power", "endpoint": "input_boolean.light_living_room"}]}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"id": "", "name": "", "enabled": True, "mappings": []}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Device Ledger"],
            sort_order=8,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="device-ledger-delete",
            group_key="ledger",
            method="DELETE",
            path="/api/v1/devices/{device_id}",
            summary="删除设备台账",
            description="删除平台台账和映射，不删除 HA entity 或真实硬件配置。",
            params=[
                {"name": "device_id", "location": "path", "type": "integer", "required": True, "description": "平台设备 ID。"},
            ],
            responses=[
                {"name": "status", "type": "integer", "description": "成功时返回 204。"},
            ],
            response_body="",
            tags=["Smart Home", "Device Ledger"],
            sort_order=9,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="sensor-data",
            group_key="state",
            method="GET",
            path="/api/v1/states/sensors",
            summary="传感器数据",
            description="分页获取平台已纳管的真实传感器状态；没有映射时返回空列表。",
            params=[
                {"name": "page", "location": "query", "type": "integer", "required": False, "description": "页码。", "defaultValue": 1},
                {"name": "size", "location": "query", "type": "integer", "required": False, "description": "每页数量。", "defaultValue": 20},
                {"name": "keyword", "location": "query", "type": "string", "required": False, "description": "设备、位置或实体关键词。", "defaultValue": ""},
                {"name": "available", "location": "query", "type": "boolean", "required": False, "description": "按当前状态是否可用筛选。"},
                {"name": "refresh", "location": "query", "type": "boolean", "required": False, "description": "是否跳过短期缓存并强制读取当前状态。", "defaultValue": False},
            ],
            responses=[
                {"name": "items", "type": "array<object>", "description": "真实传感器映射与状态。"},
                {"name": "summary", "type": "object", "description": "传感器总数与可用数量。"},
            ],
            request_preview=json.dumps({"page": 1, "size": 20, "keyword": ""}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"items": [], "summary": {"total": 0, "available": 0, "unavailable": 0}}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Sensor"],
            sort_order=20,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="scene-info",
            group_key="scenes",
            method="GET",
            path="/api/v1/devices/scenes",
            summary="场景信息",
            description="通过标准化接口获取场景信息列表与场景元数据。",
            params=[],
            responses=[
                {"name": "scenes", "type": "array<object>", "description": "场景信息列表。"},
                {"name": "count", "type": "integer", "description": "场景数量。"},
            ],
            response_body=json.dumps({"scenes": [{"entity_id": "scene.living_room_evening", "name": "客厅晚间模式"}], "count": 1}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Scenes"],
            sort_order=30,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="device-control-by-id",
            group_key="control",
            method="POST",
            path="/api/v1/devices/{device_ref}/control",
            summary="按设备执行控制",
            description="按平台设备 ID 和映射角色解析到 HA entity 后执行控制，并回读最新状态。",
            params=[
                {"name": "device_ref", "location": "path", "type": "string", "required": True, "description": "平台设备 ID 或已纳管 Home Assistant 实体 ID。"},
                {"name": "service", "location": "body", "type": "string", "required": False, "description": "控制动作，如 turn_on / turn_off / set_value。", "defaultValue": "toggle"},
                {"name": "domain", "location": "body", "type": "string", "required": False, "description": "可选 HA domain；填写时必须与目标实体类型一致。"},
                {"name": "data", "location": "body", "type": "object", "required": False, "description": "亮度、温度、位置等控制参数。"},
                {"name": "role", "location": "body", "type": "string", "required": False, "description": "映射角色，如 power / brightness / mode。"},
            ],
            responses=[
                {"name": "success", "type": "boolean", "description": "控制是否成功。"},
                {"name": "entity_id", "type": "string", "description": "实际控制的 HA entity。"},
                {"name": "new_state", "type": "string", "description": "控制后回读状态。"},
            ],
            request_preview=json.dumps({"service": "turn_on", "data": {}, "role": "power"}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"success": True, "entity_id": "input_boolean.light_living_room", "service": "input_boolean.turn_on", "new_state": "on"}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Control"],
            sort_order=40,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="gateway-list",
            group_key="gateways",
            method="GET",
            path="/api/v1/devices/gateways",
            summary="网关接入配置列表",
            description="查询 HA、MQTT、Modbus、HTTP、小米等网关配置，响应仅返回凭证脱敏状态。",
            params=[],
            responses=[
                {"name": "gateways", "type": "array<object>", "description": "网关配置列表。"},
                {"name": "has_credential", "type": "boolean", "description": "是否已配置凭证。"},
                {"name": "credential_masked", "type": "string", "description": "脱敏凭证。"},
            ],
            response_body=json.dumps({"gateways": [{"id": 1, "name": "Home Assistant 默认网关", "gateway_type": "homeassistant", "has_credential": True, "credential_masked": "abcd***wxyz"}]}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Gateways"],
            sort_order=50,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="gateway-create",
            group_key="gateways",
            method="POST",
            path="/api/v1/devices/gateways",
            summary="新增网关接入配置",
            description="新增网关资料。第一版 HA 可真实测试和同步，其他类型保存资料并标记待现场联调。",
            params=[
                {"name": "name", "location": "body", "type": "string", "required": True, "description": "网关名称。"},
                {"name": "gateway_type", "location": "body", "type": "string", "required": True, "description": "homeassistant / mqtt / modbus / http / xiaomi。"},
                {"name": "base_url", "location": "body", "type": "string", "required": False, "description": "网关服务基础地址。"},
                {"name": "port", "location": "body", "type": "integer", "required": False, "description": "可选服务端口。"},
                {"name": "auth_type", "location": "body", "type": "string", "required": False, "description": "鉴权方式。", "defaultValue": "bearer"},
                {"name": "credential", "location": "body", "type": "string", "required": False, "description": "网关凭证，响应不返回明文。"},
                {"name": "enabled", "location": "body", "type": "boolean", "required": False, "description": "是否启用网关。", "defaultValue": True},
                {"name": "description", "location": "body", "type": "string", "required": False, "description": "网关说明。"},
            ],
            responses=[
                {"name": "id", "type": "integer", "description": "网关 ID。"},
                {"name": "has_credential", "type": "boolean", "description": "是否已保存凭证。"},
                {"name": "credential_masked", "type": "string", "description": "脱敏凭证。"},
            ],
            request_preview=json.dumps({"name": "HA 实验室网关", "gateway_type": "homeassistant", "base_url": "http://homeassistant.local:8123", "auth_type": "bearer", "credential": "<token>"}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"id": 2, "name": "HA 实验室网关", "has_credential": True, "credential_masked": "<t***en>"}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Gateways"],
            sort_order=51,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="gateway-update",
            group_key="gateways",
            method="PUT",
            path="/api/v1/devices/gateways/{gateway_id}",
            summary="更新网关接入配置",
            description="更新网关地址、端口、鉴权方式、启用状态和说明；留空或保留掩码不会覆盖原凭证。",
            params=[
                {"name": "gateway_id", "location": "path", "type": "integer", "required": True, "description": "网关 ID。"},
                {"name": "name", "location": "body", "type": "string", "required": True, "description": "网关名称。"},
                {"name": "gateway_type", "location": "body", "type": "string", "required": False, "description": "网关类型。", "defaultValue": "homeassistant"},
                {"name": "base_url", "location": "body", "type": "string", "required": False, "description": "网关服务基础地址。"},
                {"name": "port", "location": "body", "type": "integer", "required": False, "description": "可选服务端口。"},
                {"name": "auth_type", "location": "body", "type": "string", "required": False, "description": "鉴权方式。", "defaultValue": "bearer"},
                {"name": "credential", "location": "body", "type": "string", "required": False, "description": "新凭证；留空时按业务规则保留已有配置。"},
                {"name": "enabled", "location": "body", "type": "boolean", "required": False, "description": "是否启用网关。", "defaultValue": True},
                {"name": "description", "location": "body", "type": "string", "required": False, "description": "网关说明。"},
            ],
            responses=[
                {"name": "id", "type": "integer", "description": "网关 ID。"},
                {"name": "status", "type": "string", "description": "网关连接状态。"},
                {"name": "credential_masked", "type": "string", "description": "脱敏凭证。"},
            ],
            request_preview=json.dumps({"name": "HA 实验室网关", "gateway_type": "homeassistant", "base_url": "http://homeassistant.local:8123", "credential": ""}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"id": 2, "name": "HA 实验室网关", "credential_masked": "abcd***wxyz"}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Gateways"],
            sort_order=52,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="gateway-delete",
            group_key="gateways",
            method="DELETE",
            path="/api/v1/devices/gateways/{gateway_id}",
            summary="删除网关接入配置",
            description="删除平台侧网关配置；若仍有关联设备则拒绝删除。",
            params=[
                {"name": "gateway_id", "location": "path", "type": "integer", "required": True, "description": "网关 ID。"},
            ],
            responses=[
                {"name": "status", "type": "integer", "description": "成功时返回 204。"},
            ],
            response_body="",
            tags=["Smart Home", "Gateways"],
            sort_order=53,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="gateway-test",
            group_key="gateways",
            method="POST",
            path="/api/v1/devices/gateways/{gateway_id}/test",
            summary="测试网关连接",
            description="测试指定网关连接。HA 网关执行真实连接测试，其他网关返回待现场适配器联调状态。",
            params=[
                {"name": "gateway_id", "location": "path", "type": "integer", "required": True, "description": "网关 ID。"},
            ],
            responses=[
                {"name": "status", "type": "string", "description": "running / pending / error。"},
                {"name": "message", "type": "string", "description": "测试结果说明。"},
                {"name": "gateway", "type": "object", "description": "网关脱敏信息。"},
            ],
            response_body=json.dumps({"status": "unknown", "message": "", "gateway": None}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Gateways"],
            sort_order=54,
        ),
        build_contract_reference_endpoint(
            module_slug="smart-home",
            identifier="gateway-sync",
            group_key="gateways",
            method="POST",
            path="/api/v1/devices/gateways/{gateway_id}/sync",
            summary="同步 HA 实体候选",
            description="从 HA 网关读取 entity 候选，供前端创建平台设备或追加实体映射；不会自动声明真实硬件验收完成。",
            params=[
                {"name": "gateway_id", "location": "path", "type": "integer", "required": True, "description": "网关 ID。"},
            ],
            responses=[
                {"name": "status", "type": "string", "description": "running / pending / error。"},
                {"name": "candidates", "type": "array<object>", "description": "HA entity 候选列表。"},
                {"name": "message", "type": "string", "description": "同步结果说明。"},
            ],
            response_body=json.dumps({"status": "unknown", "message": "", "candidates": [], "count": 0}, ensure_ascii=False, indent=2),
            tags=["Smart Home", "Gateways"],
            sort_order=55,
        ),
    ],
    "sandbox": [
        build_contract_reference_endpoint(
            module_slug="sandbox",
            identifier="virtual-devices",
            group_key="sandbox-state",
            method="GET",
            path="/api/v1/sandbox/devices",
            summary="获取虚拟设备列表与实时状态",
            description="返回电子沙盘使用的虚拟设备、实体映射和当前状态，用于证明平台具备虚拟设备系统对接能力。",
            params=[
                {"name": "refresh", "location": "query", "type": "boolean", "required": False, "description": "是否跳过短期缓存并强制读取当前状态。", "defaultValue": False},
            ],
            responses=[
                {"name": "devices", "type": "array<object>", "description": "虚拟设备清单；每项的 entity_states 保存角色到 HA 状态的映射。"},
                {"name": "count", "type": "integer", "description": "虚拟设备数量。"},
                {"name": "available_count", "type": "integer", "description": "全部关联实体状态均可用的虚拟设备数量。"},
                {"name": "partial_count", "type": "integer", "description": "仅部分关联实体状态可用的虚拟设备数量。"},
                {"name": "ha_connected", "type": "boolean", "description": "本次是否成功读取 Home Assistant 状态。"},
                {"name": "error", "type": "string | null", "description": "Home Assistant 不可用时的诊断。"},
            ],
            response_body=json.dumps({
                "devices": [{
                    "id": "v_living_room_light",
                    "name": "客厅灯",
                    "category": "light",
                    "entity_states": {
                        "power": {"state": "unavailable", "attributes": {}},
                    },
                    "availability": "unavailable",
                    "available_entity_count": 0,
                    "total_entity_count": 1,
                    "missing_roles": ["power"],
                }],
                "count": 1,
                "available_count": 0,
                "partial_count": 0,
                "unavailable_count": 1,
                "mode": "simulation",
                "ha_connected": False,
                "status": "unavailable",
                "error": "Home Assistant 当前不可用",
                "cache_ttl_seconds": 3,
            }, ensure_ascii=False, indent=2),
            tags=["Sandbox", "Virtual Devices"],
            sort_order=10,
        ),
        build_contract_reference_endpoint(
            module_slug="sandbox",
            identifier="client-config",
            group_key="sandbox-state",
            method="GET",
            path="/api/v1/sandbox/client-config",
            summary="获取电子沙盘前端连接配置",
            description="返回电子沙盘前端可用的连接配置和实体映射，不向浏览器暴露 Home Assistant Token。",
            params=[],
            responses=[
                {"name": "mode", "type": "string", "description": "沙盘接入模式。"},
                {"name": "auth_mode", "type": "string", "description": "浏览器通过平台后端代理访问，不下发 HA Token。"},
                {"name": "ha_url", "type": "string", "description": "浏览器可访问的 HA 地址。"},
                {"name": "entities", "type": "object", "description": "沙盘 UI 与实体 ID 的映射。"},
            ],
            response_body=json.dumps({"mode": "simulation", "auth_mode": "backend_proxy", "ha_url": "http://localhost:8123", "entities": {"light_living": "light.ke_ting_deng"}}, ensure_ascii=False, indent=2),
            tags=["Sandbox", "Config"],
            sort_order=20,
        ),
        build_contract_reference_endpoint(
            module_slug="sandbox",
            identifier="scenes",
            group_key="sandbox-control",
            method="GET",
            path="/api/v1/sandbox/scenes",
            summary="获取电子沙盘场景预设",
            description="返回电子沙盘可用的虚拟场景预设，用于演示回家、离家、睡眠、影院等复合场景。",
            params=[],
            responses=[
                {"name": "scenes", "type": "array<object>", "description": "场景预设列表；operations 提供逐步骤业务动作、目标值和目标实体，用于执行前可用性预检。"},
                {"name": "count", "type": "integer", "description": "场景预设数量。"},
                {"name": "mode", "type": "string", "description": "当前为 simulation 虚拟联调模式。"},
            ],
            response_body=json.dumps({"scenes": [{"id": "come_home", "name": "回家模式", "description": "客厅灯80%亮度，空调24°C制冷", "operation_count": 4, "injection_count": 0, "control_count": 4, "operations": [{"kind": "control", "entity_id": "input_boolean.light_living_room", "device_name": "客厅灯", "action_label": "开启", "target_label": "开启"}]}], "count": 1, "mode": "simulation"}, ensure_ascii=False, indent=2),
            tags=["Sandbox", "Scenes"],
            sort_order=30,
        ),
        build_contract_reference_endpoint(
            module_slug="sandbox",
            identifier="control",
            group_key="sandbox-control",
            method="POST",
            path="/api/v1/sandbox/control",
            summary="控制虚拟设备",
            description="向虚拟设备系统发送控制请求，实现灯光、开关、门锁等对象的交互控制。",
            params=[
                {"name": "entity_id", "location": "body", "type": "string", "required": True, "description": "预定义虚拟设备实体 ID。", "defaultValue": "input_boolean.light_living_room"},
                {"name": "service", "location": "body", "type": "string", "required": True, "description": "完整 HA 服务名，如 input_boolean.turn_on / input_boolean.turn_off。", "defaultValue": "input_boolean.turn_on"},
                {"name": "data", "location": "body", "type": "object", "required": False, "description": "数值或选项控制的附加参数；开关控制传空对象。"},
            ],
            responses=[
                {"name": "success", "type": "boolean", "description": "控制回读是否确认成功。"},
                {"name": "entity_id", "type": "string", "description": "被控制的实体 ID。"},
                {"name": "readback", "type": "object", "description": "控制后的实体状态回读。"},
                {"name": "confirmed", "type": "boolean", "description": "回读是否符合目标状态。"},
            ],
            request_preview=json.dumps({"entity_id": "input_boolean.light_living_room", "service": "input_boolean.turn_on", "data": {}}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"success": True, "entity_id": "input_boolean.light_living_room", "device_name": "客厅灯", "service": "input_boolean.turn_on", "previous_state": {"state": "off", "attributes": {}}, "readback": {"state": "on", "attributes": {}}, "confirmed": True, "mode": "simulation"}, ensure_ascii=False, indent=2),
            tags=["Sandbox", "Control"],
            sort_order=40,
        ),
        build_contract_reference_endpoint(
            module_slug="sandbox",
            identifier="logs",
            group_key="sandbox-state",
            method="GET",
            path="/api/v1/sandbox/logs",
            summary="获取电子沙盘仿真日志",
            description="查询电子沙盘和虚拟设备系统的控制、注入、系统事件日志，用于验收留痕。",
            params=[
                {"name": "page", "location": "query", "type": "integer", "required": False, "description": "页码。", "defaultValue": 1},
                {"name": "size", "location": "query", "type": "integer", "required": False, "description": "每页数量，范围 10-100。", "defaultValue": 20},
                {"name": "level", "location": "query", "type": "string", "required": False, "description": "info / success / warning / error。", "defaultValue": ""},
                {"name": "action", "location": "query", "type": "string", "required": False, "description": "inject / control / scene。", "defaultValue": ""},
                {"name": "keyword", "location": "query", "type": "string", "required": False, "description": "标题、详情或操作人关键词。", "defaultValue": ""},
            ],
            responses=[
                {"name": "items", "type": "array<object>", "description": "当前页仿真日志。"},
                {"name": "total", "type": "integer", "description": "当前筛选命中总数。"},
                {"name": "page_count", "type": "integer", "description": "分页总页数。"},
                {"name": "summary", "type": "object", "description": "全量日志成功、需关注和近 24 小时统计。"},
            ],
            request_preview=json.dumps({"page": 1, "size": 20, "level": "", "action": "", "keyword": ""}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"items": [], "logs": [], "total": 0, "page": 1, "size": 20, "page_count": 1, "summary": {"total": 0, "successful": 0, "attention": 0, "last_24h": 0, "latest_at": None}}, ensure_ascii=False, indent=2),
            tags=["Sandbox", "Logs"],
            sort_order=50,
        ),
    ],
    "device-data": [
        build_contract_reference_endpoint(
            module_slug="device-data",
            identifier="realtime",
            group_key="realtime",
            method="GET",
            path="/api/v1/states/realtime",
            summary="实时状态数据",
            description="分页查询平台已纳管设备及其 Home Assistant 实时状态快照。",
            params=[
                {"name": "page", "location": "query", "type": "integer", "required": False, "description": "页码。", "defaultValue": 1},
                {"name": "size", "location": "query", "type": "integer", "required": False, "description": "每页数量。", "defaultValue": 20},
                {"name": "category", "location": "query", "type": "string", "required": False, "description": "设备类型筛选。", "defaultValue": ""},
                {"name": "status", "location": "query", "type": "string", "required": False, "description": "在线、离线、未映射或未启用状态。", "defaultValue": ""},
                {"name": "keyword", "location": "query", "type": "string", "required": False, "description": "设备名称、位置或实体关键词。", "defaultValue": ""},
                {"name": "refresh", "location": "query", "type": "boolean", "required": False, "description": "是否跳过短期缓存并强制读取当前状态。", "defaultValue": False},
            ],
            responses=[
                {"name": "items", "type": "array<object>", "description": "设备及真实映射实体状态。"},
                {"name": "summary", "type": "object", "description": "完整设备台账汇总。"},
                {"name": "degraded", "type": "boolean", "description": "Home Assistant 状态读取是否降级。"},
            ],
            request_preview=json.dumps({"page": 1, "size": 20, "keyword": ""}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"items": [], "summary": {}, "page": 1, "size": 20, "total": 0, "pages": 1, "degraded": False}, ensure_ascii=False, indent=2),
            tags=["Device Data", "Realtime"],
            sort_order=10,
        ),
        build_contract_reference_endpoint(
            module_slug="device-data",
            identifier="sensors",
            group_key="sensors",
            method="GET",
            path="/api/v1/states/sensors",
            summary="传感器实时数据",
            description="分页查询平台已纳管的真实传感器映射；没有映射时返回空列表。",
            params=[
                {"name": "page", "location": "query", "type": "integer", "required": False, "description": "页码。", "defaultValue": 1},
                {"name": "size", "location": "query", "type": "integer", "required": False, "description": "每页数量。", "defaultValue": 20},
                {"name": "available", "location": "query", "type": "boolean", "required": False, "description": "按当前可用状态筛选。"},
                {"name": "keyword", "location": "query", "type": "string", "required": False, "description": "设备名称、位置或实体关键词。", "defaultValue": ""},
                {"name": "refresh", "location": "query", "type": "boolean", "required": False, "description": "是否跳过短期缓存并强制读取当前状态。", "defaultValue": False},
            ],
            responses=[
                {"name": "items", "type": "array<object>", "description": "真实 sensor 或 binary_sensor 映射。"},
                {"name": "summary", "type": "object", "description": "传感器总数与可用数量。"},
            ],
            request_preview=json.dumps({"page": 1, "size": 20}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"items": [], "summary": {"total": 0, "available": 0, "unavailable": 0}}, ensure_ascii=False, indent=2),
            tags=["Device Data", "Sensors"],
            sort_order=20,
        ),
        build_contract_reference_endpoint(
            module_slug="device-data",
            identifier="history",
            group_key="history",
            method="GET",
            path="/api/v1/monitor/device-history",
            summary="历史数据",
            description="统一查询设备历史状态数据。",
            params=[
                {"name": "entity_id", "location": "query", "type": "string", "required": True, "description": "设备实体 ID。", "defaultValue": "light.ke_ting_deng"},
                {"name": "hours", "location": "query", "type": "integer", "required": False, "description": "查询最近多少小时。", "defaultValue": 24},
            ],
            responses=[
                {"name": "history", "type": "array<object>", "description": "设备历史状态点。"},
                {"name": "count", "type": "integer", "description": "历史数据点数量。"},
            ],
            response_body=json.dumps({"entity_id": "", "history": [], "count": 0}, ensure_ascii=False, indent=2),
            tags=["Device Data", "History"],
            sort_order=30,
        ),
        build_contract_reference_endpoint(
            module_slug="device-data",
            identifier="runtime",
            group_key="runtime",
            method="GET",
            path="/api/v1/states/summary",
            summary="设备运行信息",
            description="查询设备、场景和真实传感器可用情况的统一运行汇总。",
            params=[
                {"name": "refresh", "location": "query", "type": "boolean", "required": False, "description": "是否跳过短期缓存并强制读取当前状态。", "defaultValue": False},
            ],
            responses=[
                {"name": "total", "type": "integer", "description": "平台设备总数。"},
                {"name": "online", "type": "integer", "description": "在线设备数量。"},
                {"name": "sensors", "type": "integer", "description": "已纳管传感器数量。"},
                {"name": "degraded", "type": "boolean", "description": "外部状态读取是否降级。"},
            ],
            response_body=json.dumps({"total": 0, "online": 0, "scene_count": 0, "sensors": 0, "available_sensors": 0, "degraded": False}, ensure_ascii=False, indent=2),
            tags=["Device Data", "Runtime"],
            sort_order=40,
        ),
    ],
    "device-control": [
        build_contract_reference_endpoint(
            module_slug="device-control",
            identifier="unified-control",
            group_key="control",
            method="POST",
            path="/api/v1/devices/{device_ref}/control",
            summary="统一的设备控制接口",
            description="通过统一的设备控制接口向外部系统发送控制请求，并返回执行结果。",
            params=[
                {"name": "device_ref", "location": "path", "type": "string", "required": True, "description": "平台设备 ID 或已纳管 Home Assistant 实体 ID。"},
                {"name": "service", "location": "body", "type": "string", "required": False, "description": "控制动作。", "defaultValue": "toggle"},
                {"name": "domain", "location": "body", "type": "string", "required": False, "description": "可选 HA domain；填写时必须与目标实体类型一致。"},
                {"name": "data", "location": "body", "type": "object", "required": False, "description": "亮度、温度、位置等控制参数。"},
                {"name": "role", "location": "body", "type": "string", "required": False, "description": "平台设备映射角色。"},
            ],
            responses=[
                {"name": "success", "type": "boolean", "description": "控制是否成功。"},
                {"name": "service", "type": "string", "description": "执行的控制服务。"},
                {"name": "new_state", "type": "string", "description": "控制后的设备状态。"},
            ],
            request_preview=json.dumps({"service": "turn_on"}, ensure_ascii=False, indent=2),
            response_body=json.dumps({"success": True, "service": "light.turn_on", "new_state": "on"}, ensure_ascii=False, indent=2),
            tags=["Device Control", "Execution Result"],
            sort_order=10,
        ),
    ],
}


def resolve_ref(openapi: dict[str, Any], ref: str | None) -> dict[str, Any]:
    if not ref or not ref.startswith("#/"):
        return {}
    current: Any = openapi
    for part in ref.lstrip("#/").split("/"):
        if not isinstance(current, dict):
            return {}
        current = current.get(part)
    return current if isinstance(current, dict) else {}


def infer_field_type(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return schema["$ref"].split("/")[-1]
    if "type" in schema:
        return str(schema["type"])
    if "anyOf" in schema:
        return " | ".join(filter(None, [item.get("type") for item in schema["anyOf"] if isinstance(item, dict)]))
    return "object"


def schema_to_fields(openapi: dict[str, Any], schema: dict[str, Any] | None) -> list[dict[str, str]]:
    if not schema:
        return []
    if "$ref" in schema:
        schema = resolve_ref(openapi, schema["$ref"])
    if schema.get("type") == "array":
        item_schema = schema.get("items", {})
        item_name = item_schema.get("title") or item_schema.get("$ref", "items").split("/")[-1]
        return [{"name": "items", "type": f"array<{infer_field_type(item_schema)}>", "description": f"{item_name} 列表"}]
    properties = schema.get("properties", {})
    if not properties:
        return []
    required = set(schema.get("required", []))
    fields: list[dict[str, str]] = []
    for name, prop in properties.items():
        prop_schema = prop
        if "$ref" in prop:
            prop_schema = resolve_ref(openapi, prop["$ref"])
        desc = prop.get("description") or prop_schema.get("description") or ""
        suffix = "（必填）" if name in required else ""
        fields.append({
            "name": name,
            "type": infer_field_type(prop if "$ref" not in prop else prop_schema),
            "description": f"{desc}{suffix}".strip(),
        })
    return fields


def body_schema_to_params(openapi: dict[str, Any], schema: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not schema:
        return []
    if "$ref" in schema:
        schema = resolve_ref(openapi, schema["$ref"])
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    params: list[dict[str, Any]] = []
    for name, prop in properties.items():
        prop_schema = prop if "$ref" not in prop else resolve_ref(openapi, prop["$ref"])
        params.append({
            "name": name,
            "location": "body",
            "type": infer_field_type(prop if "$ref" not in prop else prop_schema),
            "required": name in required,
            "description": prop.get("description") or prop_schema.get("description") or "",
            "defaultValue": prop.get("default"),
        })
    return params


def schema_preview(openapi: dict[str, Any], schema: dict[str, Any] | None) -> str:
    if not schema:
        return "{}"
    if "$ref" in schema:
        schema = resolve_ref(openapi, schema["$ref"])
    preview: dict[str, Any] = {}
    for name, prop in schema.get("properties", {}).items():
        default = prop.get("default")
        if default is not None:
            preview[name] = default
        else:
            prop_type = prop.get("type")
            if prop_type == "integer":
                preview[name] = 0
            elif prop_type == "number":
                preview[name] = 0
            elif prop_type == "boolean":
                preview[name] = False
            elif prop_type == "array":
                preview[name] = []
            elif prop_type == "object":
                preview[name] = {}
            else:
                preview[name] = ""
    return json.dumps(preview, ensure_ascii=False, indent=2)


def classify_module(path: str, method: str) -> tuple[str, str]:
    if path.startswith("/api/v1/chat/completions") or path.startswith("/api/v1/chat/blocking") or path.startswith("/api/v1/chat/conversations") or path.startswith("/api/v1/chat/messages"):
        return "local-model", "generation"
    if path.startswith("/api/v1/chat/feedback") or path.startswith("/api/v1/chat/workflow-runs"):
        return "agent-external", "external"
    if path.startswith("/api/v1/sandbox"):
        if "inject" in path or "control" in path:
            return "sandbox", "sandbox-control"
        return "sandbox", "sandbox-state"
    if path.startswith("/api/v1/knowledge"):
        if "hit-testing" in path:
            return "knowledge", "retrieval"
        if "documents" in path:
            return "knowledge", "documents"
        return "knowledge", "datasets"
    if path.startswith("/api/v1/system") or path.startswith("/api/v1/auth") or path.startswith("/api/v1/users"):
        if path.startswith("/api/v1/auth"):
            return "system", "auth"
        if "settings" in path:
            return "system", "settings"
        return "system", "status"
    if path.startswith("/api/v1/monitor"):
        if "device-runtime" in path:
            return "device-data", "runtime"
        if "history" in path or "trend" in path:
            return "device-data", "history"
        return "device-data", "realtime"
    if path.startswith("/api/v1/devices"):
        if "/control" in path or method.upper() == "POST":
            return "device-control", "control"
        if "search" in path:
            return "agent-external", "external"
        if "scene" in path:
            return "smart-home", "scenes"
        return "smart-home", "state"
    return "system", "unassigned"


async def sync_contract_reference_modules(db: AsyncSession) -> None:
    result = await db.execute(select(ApiDocModule).options(selectinload(ApiDocModule.endpoints)))
    modules = result.scalars().unique().all()
    module_by_slug = {module.slug: module for module in modules}
    changed = False

    for module_slug, patch in CONTRACT_MODULE_PATCHES.items():
        module = module_by_slug.get(module_slug)
        if module is None:
            continue
        # 统一设备数据模块的基址和分组属于合同接口结构；即使模块曾在后台编辑，
        # 也必须跟随真实路由更新，未列入补丁的人工内容仍保持不变。
        if module.source_type == "manual" and module_slug not in {"device-data", "smart-home"}:
            continue
        for field_name, value in patch.items():
            if getattr(module, field_name) != value:
                setattr(module, field_name, value)
                changed = True

    for module_slug, endpoint_payloads in CONTRACT_REFERENCE_ENDPOINTS.items():
        module = module_by_slug.get(module_slug)
        if module is None:
            continue

        existing_by_source = {
            endpoint.source_identifier: endpoint
            for endpoint in module.endpoints
            if endpoint.source_identifier.startswith("contract:")
        }
        expected_sources = {payload["source_identifier"] for payload in endpoint_payloads}
        expected_routes = {
            (
                payload["method"],
                re.sub(r"\{[^}]+\}", "{}", payload["path"].rstrip("/") or "/"),
            )
            for payload in endpoint_payloads
        }

        for endpoint in list(module.endpoints):
            normalized_route = (
                endpoint.method,
                re.sub(r"\{[^}]+\}", "{}", endpoint.path.rstrip("/") or "/"),
            )
            duplicate_imported_route = (
                endpoint.source_type != "manual"
                and not endpoint.source_identifier.startswith("contract:")
                and normalized_route in expected_routes
            )
            stale_managed_endpoint = (
                endpoint.source_type != "manual"
                and endpoint.source_identifier not in expected_sources
                and (
                    module_slug == "device-data"
                    or endpoint.source_identifier.startswith("contract:")
                    or duplicate_imported_route
                )
            )
            if stale_managed_endpoint:
                await db.delete(endpoint)
                changed = True

        for payload in endpoint_payloads:
            endpoint = existing_by_source.get(payload["source_identifier"])
            if endpoint is None:
                db.add(
                    ApiDocEndpoint(
                        module_id=module.id,
                        slug=payload["slug"],
                        group_key=payload["group_key"],
                        method=payload["method"],
                        path=payload["path"],
                        summary=payload["summary"],
                        description=payload["description"],
                        source_type=payload["source_type"],
                        source_identifier=payload["source_identifier"],
                        sort_order=payload["sort_order"],
                        is_visible=payload["is_visible"],
                        tags=payload["tags"],
                        params=payload["params"],
                        responses=payload["responses"],
                        notes=payload["notes"],
                        code_samples=payload["code_samples"],
                        request_preview=payload["request_preview"],
                        response_body=payload["response_body"],
                        response_meta=payload["response_meta"],
                    )
                )
                changed = True
                continue

            # 控制台手工保存后保留覆盖内容；重新导入时再显式回到源文档版本。
            if endpoint.source_type == "manual":
                continue

            endpoint_changed = any(
                (
                    endpoint.slug != payload["slug"],
                    endpoint.group_key != payload["group_key"],
                    endpoint.method != payload["method"],
                    endpoint.path != payload["path"],
                    endpoint.summary != payload["summary"],
                    endpoint.description != payload["description"],
                    endpoint.source_type != payload["source_type"],
                    endpoint.sort_order != payload["sort_order"],
                    endpoint.is_visible != payload["is_visible"],
                    endpoint.tags != payload["tags"],
                    endpoint.params != payload["params"],
                    endpoint.responses != payload["responses"],
                    endpoint.notes != payload["notes"],
                    endpoint.code_samples != payload["code_samples"],
                    endpoint.request_preview != payload["request_preview"],
                    endpoint.response_body != payload["response_body"],
                    endpoint.response_meta != payload["response_meta"],
                )
            )
            endpoint.slug = payload["slug"]
            endpoint.group_key = payload["group_key"]
            endpoint.method = payload["method"]
            endpoint.path = payload["path"]
            endpoint.summary = payload["summary"]
            endpoint.description = payload["description"]
            endpoint.source_type = payload["source_type"]
            endpoint.sort_order = payload["sort_order"]
            endpoint.is_visible = payload["is_visible"]
            endpoint.tags = payload["tags"]
            endpoint.params = payload["params"]
            endpoint.responses = payload["responses"]
            endpoint.notes = payload["notes"]
            endpoint.code_samples = payload["code_samples"]
            endpoint.request_preview = payload["request_preview"]
            endpoint.response_body = payload["response_body"]
            endpoint.response_meta = payload["response_meta"]
            changed = changed or endpoint_changed

    if changed:
        await record_source_meta(
            db,
            target_type="module",
            target_ref="contract-reference",
            source_type="contract",
            source_ref="contract-api-reference",
            import_strategy="refresh",
            note="同步项目接口与模块分组",
        )


async def get_module_by_ref(db: AsyncSession, module_ref: str) -> ApiDocModule | None:
    statement = select(ApiDocModule).options(selectinload(ApiDocModule.endpoints)).where(ApiDocModule.slug == module_ref)
    if module_ref.isdigit():
        statement = select(ApiDocModule).options(selectinload(ApiDocModule.endpoints)).where(
            (ApiDocModule.slug == module_ref) | (ApiDocModule.id == int(module_ref))
        )
    result = await db.execute(statement)
    return result.scalar_one_or_none()


async def get_endpoint_by_ref(db: AsyncSession, endpoint_ref: str) -> ApiDocEndpoint | None:
    statement = select(ApiDocEndpoint).where(ApiDocEndpoint.slug == endpoint_ref)
    if endpoint_ref.isdigit():
        statement = select(ApiDocEndpoint).where((ApiDocEndpoint.slug == endpoint_ref) | (ApiDocEndpoint.id == int(endpoint_ref)))
    result = await db.execute(statement)
    return result.scalar_one_or_none()


def serialize_endpoint(endpoint: ApiDocEndpoint) -> dict[str, Any]:
    return clean_product_copy({
        "id": endpoint.id,
        "module_id": endpoint.module_id,
        "slug": endpoint.slug,
        "group": endpoint.group_key,
        "method": endpoint.method,
        "path": endpoint.path,
        "summary": endpoint.summary,
        "description": endpoint.description,
        "source_type": endpoint.source_type,
        "source_identifier": endpoint.source_identifier,
        "sort_order": endpoint.sort_order,
        "is_visible": endpoint.is_visible,
        "tags": endpoint.tags or [],
        "params": endpoint.params or [],
        "responses": endpoint.responses or [],
        "notes": endpoint.notes or [],
        "code_samples": endpoint.code_samples or [],
        "request_preview": endpoint.request_preview or "",
        "response_body": endpoint.response_body or "",
        "response_meta": endpoint.response_meta or "",
        "created_at": endpoint.created_at,
        "updated_at": endpoint.updated_at,
    })


def serialize_module(
    module: ApiDocModule,
    include_hidden: bool = False,
    include_endpoints: bool = True,
) -> dict[str, Any]:
    endpoints = sorted(module.endpoints, key=lambda item: (item.sort_order, item.id)) if include_endpoints else []
    return clean_product_copy({
        "id": module.id,
        "slug": module.slug,
        "title": module.title,
        "subtitle": module.subtitle,
        "description": module.description,
        "markdown_content": module.markdown_content or "",
        "status": module.status,
        "source_type": module.source_type,
        "renderer_type": module.renderer_type,
        "endpoint_base": module.endpoint_base,
        "sort_order": module.sort_order,
        "is_visible": module.is_visible,
        "capability_tags": module.capability_tags or [],
        "highlights": module.highlights or [],
        "groups": module.groups or [],
        "playground": module.playground or {
            "title": "接口调试台",
            "targetLabel": "接口调用调试",
            "statusLabel": "接口示例",
            "note": "当前展示接口参数、请求示例和响应结构。",
            "fields": [],
            "presets": [],
        },
        "endpoints": [serialize_endpoint(endpoint) for endpoint in endpoints if include_hidden or endpoint.is_visible],
    })


async def ensure_api_docs_seeded(db: AsyncSession) -> None:
    existing = (await db.execute(select(ApiDocModule.id).limit(1))).scalar_one_or_none()
    if existing:
        return

    modules: list[ApiDocModule] = []
    for seed in MODULE_SEEDS:
        module = ApiDocModule(
            slug=seed["slug"],
            title=seed["title"],
            subtitle=seed["subtitle"],
            description=seed["description"],
            markdown_content=seed["markdown_content"],
            status="configured",
            source_type="seed",
            renderer_type="api-reference",
            endpoint_base=seed["endpoint_base"],
            sort_order=seed["sort_order"],
            is_visible=True,
            capability_tags=seed["capability_tags"],
            highlights=seed["highlights"],
            groups=seed["groups"],
            playground=seed["playground"],
        )
        db.add(module)
        modules.append(module)
    await db.flush()

async def remove_generated_overview_endpoints(db: AsyncSession) -> None:
    """移除早期为占位展示生成、但没有真实后端路由的模块概览端点。"""
    await db.execute(
        delete(ApiDocEndpoint).where(
            ApiDocEndpoint.source_type == "seed",
            ApiDocEndpoint.source_identifier.like("seed:%:overview"),
            ApiDocEndpoint.path.like("/api/reference/%/overview"),
        )
    )


async def sync_local_model_module_from_markdown(db: AsyncSession) -> None:
    if not LOCAL_MODEL_DOC_PATH.exists():
        return

    result = await db.execute(select(ApiDocModule).where(ApiDocModule.slug == "local-model"))
    module = result.scalar_one_or_none()
    if module is None:
        return
    if module.source_type == "manual":
        return

    markdown = LOCAL_MODEL_DOC_PATH.read_text(encoding="utf-8")
    current_model = (
        await db.execute(select(SystemConfig.value).where(SystemConfig.key == "current_model"))
    ).scalar_one_or_none()
    preferred_generation_model = (current_model or "gemma3").strip() or "gemma3"
    changed = False
    next_subtitle = "支持文本生成、多轮对话、向量嵌入与模型管理的统一入口。"
    next_description = "面向 Ollama 本地模型服务的统一调用入口，支持文本生成、多轮对话、向量嵌入、模型管理和运行状态查询等能力。"
    next_capability_tags = ["文本生成", "多轮对话", "向量嵌入", "模型管理"]
    next_highlights = [
        {"title": "文档同步", "description": "自动同步《统一的本地模型调用接口文档》的模块说明和接口骨架。"},
        {"title": "Ollama 原生接口", "description": "当前模块以 Ollama 本地模型服务接口为准，不再混用平台后端代理接口。"},
    ]
    next_groups = [
        {"id": "generation", "label": "文本生成与对话"},
        {"id": "embeddings", "label": "向量嵌入"},
        {"id": "runtime", "label": "运行状态"},
        {"id": "models", "label": "模型管理"},
    ]
    next_playground = {
        "title": "本地模型调用调试台",
        "targetLabel": "本地模型接口示例",
        "statusLabel": "接口示例",
        "note": "当前模块内容同步自 Ollama 本地模型接口文档，右侧区域展示参数结构和响应示例。",
        "fields": [
            {"id": "model", "label": "模型名称", "type": "text", "value": preferred_generation_model},
            {"id": "prompt", "label": "提示词", "type": "textarea", "value": "请介绍智慧家居智能体的作用。"},
        ],
        "presets": [
            {
                "id": "generate-demo",
                "label": "文本生成示例",
                "description": "演示 Ollama `/api/generate` 的请求与响应结构。",
                "requestPreview": json.dumps({"model": preferred_generation_model, "prompt": "请介绍智慧家居智能体的作用。", "stream": False}, ensure_ascii=False, indent=2),
                "responseBody": json.dumps({"model": preferred_generation_model, "response": "智慧家居智能体可以理解自然语言并驱动设备控制。", "done": True}, ensure_ascii=False, indent=2),
                "responseMeta": json.dumps({"status": 200, "source": "ollama-markdown", "mode": "example"}, ensure_ascii=False, indent=2),
            }
        ],
    }
    if module.subtitle != next_subtitle:
        module.subtitle = next_subtitle
        changed = True
    if module.description != next_description:
        module.description = next_description
        changed = True
    if module.markdown_content != markdown:
        module.markdown_content = markdown
        changed = True
    if module.source_type != "markdown":
        module.source_type = "markdown"
        changed = True
    if module.endpoint_base != "http://localhost:11434":
        module.endpoint_base = "http://localhost:11434"
        changed = True
    if module.capability_tags != next_capability_tags:
        module.capability_tags = next_capability_tags
        changed = True
    if module.highlights != next_highlights:
        module.highlights = next_highlights
        changed = True
    if module.groups != next_groups:
        module.groups = next_groups
        changed = True
    if module.playground != next_playground:
        module.playground = next_playground
        changed = True

    endpoint_result = await db.execute(
        select(ApiDocEndpoint).where(ApiDocEndpoint.module_id == module.id)
    )
    module_endpoints = endpoint_result.scalars().all()

    doc_endpoints = build_local_model_doc_endpoints(markdown)
    for payload in doc_endpoints:
        if payload["path"] not in {"/api/generate", "/api/chat"}:
            continue
        try:
            request_preview = json.loads(payload["request_preview"])
        except json.JSONDecodeError:
            continue
        if isinstance(request_preview, dict):
            request_preview["model"] = preferred_generation_model
            payload["request_preview"] = json.dumps(request_preview, ensure_ascii=False, indent=2)
    existing_by_source = {endpoint.source_identifier: endpoint for endpoint in module_endpoints}
    expected_sources = {item["source_identifier"] for item in doc_endpoints}

    for endpoint in module_endpoints:
        if endpoint.source_type == "openapi" and endpoint.path.startswith("/api/v1/chat"):
            await db.delete(endpoint)
            changed = True
        elif (
            endpoint.source_type != "manual"
            and endpoint.source_identifier.startswith("ollama-markdown:")
            and endpoint.source_identifier not in expected_sources
        ):
            await db.delete(endpoint)
            changed = True

    for payload in doc_endpoints:
        endpoint = existing_by_source.get(payload["source_identifier"])
        if endpoint is None:
            db.add(
                ApiDocEndpoint(
                    module_id=module.id,
                    slug=payload["slug"],
                    group_key=payload["group_key"],
                    method=payload["method"],
                    path=payload["path"],
                    summary=payload["summary"],
                    description=payload["description"],
                    source_type=payload["source_type"],
                    source_identifier=payload["source_identifier"],
                    sort_order=payload["sort_order"],
                    is_visible=payload["is_visible"],
                    tags=payload["tags"],
                    params=payload["params"],
                    responses=payload["responses"],
                    notes=payload["notes"],
                    code_samples=payload["code_samples"],
                    request_preview=payload["request_preview"],
                    response_body=payload["response_body"],
                    response_meta=payload["response_meta"],
                )
            )
            changed = True
            continue


        # 控制台手工保存后保留覆盖内容；Markdown 导入会重置模块正文，
        # 但不会在每次读取模块时静默覆盖已保存的端点草稿。
        if endpoint.source_type == "manual":
            continue

        endpoint_changed = any(
            (
                endpoint.slug != payload["slug"],
                endpoint.group_key != payload["group_key"],
                endpoint.method != payload["method"],
                endpoint.path != payload["path"],
                endpoint.summary != payload["summary"],
                endpoint.description != payload["description"],
                endpoint.source_type != payload["source_type"],
                endpoint.sort_order != payload["sort_order"],
                endpoint.is_visible != payload["is_visible"],
                endpoint.tags != payload["tags"],
                endpoint.params != payload["params"],
                endpoint.responses != payload["responses"],
                endpoint.notes != payload["notes"],
                endpoint.code_samples != payload["code_samples"],
                endpoint.request_preview != payload["request_preview"],
                endpoint.response_body != payload["response_body"],
                endpoint.response_meta != payload["response_meta"],
            )
        )
        endpoint.slug = payload["slug"]
        endpoint.group_key = payload["group_key"]
        endpoint.method = payload["method"]
        endpoint.path = payload["path"]
        endpoint.summary = payload["summary"]
        endpoint.description = payload["description"]
        endpoint.source_type = payload["source_type"]
        endpoint.sort_order = payload["sort_order"]
        endpoint.is_visible = payload["is_visible"]
        endpoint.tags = payload["tags"]
        endpoint.params = payload["params"]
        endpoint.responses = payload["responses"]
        endpoint.notes = payload["notes"]
        endpoint.code_samples = payload["code_samples"]
        endpoint.request_preview = payload["request_preview"]
        endpoint.response_body = payload["response_body"]
        endpoint.response_meta = payload["response_meta"]
        changed = changed or endpoint_changed

    if changed:
        await record_source_meta(
            db,
            target_type="module",
            target_ref="local-model",
            source_type="markdown",
            source_ref=str(LOCAL_MODEL_DOC_PATH.name),
            import_strategy="refresh",
            note="同步本地模型接口 Markdown 文档",
        )


async def list_modules(db: AsyncSession, include_hidden: bool = False) -> list[ApiDocModule]:
    await prepare_api_docs(db)
    result = await db.execute(
        select(ApiDocModule)
        .options(selectinload(ApiDocModule.endpoints))
        .order_by(ApiDocModule.sort_order, ApiDocModule.id)
    )
    modules = result.scalars().unique().all()
    if not include_hidden:
        modules = [module for module in modules if module.is_visible]
    return modules


async def prepare_api_docs(db: AsyncSession) -> None:
    """确保文档种子与受管来源已同步，不额外加载所有端点正文。"""
    await ensure_api_docs_seeded(db)
    await remove_generated_overview_endpoints(db)
    await sync_local_model_module_from_markdown(db)
    await sync_contract_reference_modules(db)


async def record_source_meta(
    db: AsyncSession,
    *,
    target_type: str,
    target_ref: str,
    source_type: str,
    source_ref: str,
    import_strategy: str,
    note: str = "",
) -> None:
    db.add(
        ApiDocSourceMeta(
            target_type=target_type,
            target_ref=target_ref,
            source_type=source_type,
            source_ref=source_ref,
            import_strategy=import_strategy,
            note=note,
        )
    )


async def import_openapi_spec(db: AsyncSession, openapi: dict[str, Any], refresh_existing: bool = True) -> dict[str, int]:
    await ensure_api_docs_seeded(db)
    modules = await list_modules(db, include_hidden=True)
    module_by_slug = {module.slug: module for module in modules}
    endpoint_result = await db.execute(select(ApiDocEndpoint))
    endpoints = endpoint_result.scalars().all()
    endpoint_by_source = {endpoint.source_identifier: endpoint for endpoint in endpoints}

    created = 0
    updated = 0
    skipped = 0
    unmatched = 0

    for path, methods in openapi.get("paths", {}).items():
        for method, operation in methods.items():
            method_upper = method.upper()
            if method_upper not in {"GET", "POST", "PUT", "DELETE", "PATCH"}:
                continue

            if path.startswith("/api/v1/chat/completions") or path.startswith("/api/v1/chat/blocking") or path.startswith("/api/v1/chat/conversations") or path.startswith("/api/v1/chat/messages"):
                skipped += 1
                continue

            module_slug, group_key = classify_module(path, method_upper)
            module = module_by_slug.get(module_slug)
            if not module:
                unmatched += 1
                continue

            parameters = operation.get("parameters", [])
            request_body = operation.get("requestBody", {})
            body_schema = {}
            if request_body:
                content = request_body.get("content", {})
                body_schema = (
                    content.get("application/json", {}).get("schema")
                    or content.get("multipart/form-data", {}).get("schema")
                    or {}
                )

            response_schema = {}
            response_content = operation.get("responses", {}).get("200", {}) or operation.get("responses", {}).get("201", {})
            if response_content:
                response_schema = (response_content.get("content", {}) or {}).get("application/json", {}).get("schema", {})

            params: list[dict[str, Any]] = []
            for parameter in parameters:
                param_schema = parameter.get("schema", {})
                params.append(
                    {
                        "name": parameter.get("name", ""),
                        "location": parameter.get("in", "query"),
                        "type": infer_field_type(param_schema),
                        "required": parameter.get("required", False),
                        "description": parameter.get("description", ""),
                        "defaultValue": param_schema.get("default"),
                    }
                )
            params.extend(body_schema_to_params(openapi, body_schema))

            responses = schema_to_fields(openapi, response_schema)
            request_preview = schema_preview(openapi, body_schema)
            response_body = "{}"
            response_meta = json.dumps({"source": "openapi", "method": method_upper}, ensure_ascii=False, indent=2)

            source_identifier = f"openapi:{method_upper}:{path}"
            endpoint = endpoint_by_source.get(source_identifier)

            payload = {
                "module_id": module.id,
                "slug": slugify(f"{module.slug}-{method}-{path}"),
                "group_key": group_key,
                "method": method_upper,
                "path": path,
                "summary": operation.get("summary") or operation.get("operationId") or path,
                "description": operation.get("description") or operation.get("summary") or "",
                "source_type": "openapi",
                "source_identifier": source_identifier,
                "tags": operation.get("tags", []),
                "params": params,
                "responses": responses,
                "notes": [],
                "code_samples": build_manual_code_samples(method_upper, path, request_preview if request_preview != "{}" else ""),
                "request_preview": request_preview,
                "response_body": response_body,
                "response_meta": response_meta,
            }

            if endpoint is None:
                endpoint = ApiDocEndpoint(
                    module_id=payload["module_id"],
                    slug=payload["slug"],
                    group_key=payload["group_key"],
                    method=payload["method"],
                    path=payload["path"],
                    summary=payload["summary"],
                    description=payload["description"],
                    source_type=payload["source_type"],
                    source_identifier=payload["source_identifier"],
                    sort_order=100 + created,
                    is_visible=True,
                    tags=payload["tags"],
                    params=payload["params"],
                    responses=payload["responses"],
                    notes=payload["notes"],
                    code_samples=payload["code_samples"],
                    request_preview=payload["request_preview"],
                    response_body=payload["response_body"],
                    response_meta=payload["response_meta"],
                )
                db.add(endpoint)
                endpoint_by_source[source_identifier] = endpoint
                created += 1
                continue

            if endpoint.source_type == "manual":
                skipped += 1
                continue

            if refresh_existing:
                endpoint.module_id = payload["module_id"]
                endpoint.group_key = payload["group_key"]
                endpoint.slug = payload["slug"]
                endpoint.method = payload["method"]
                endpoint.path = payload["path"]
                endpoint.summary = payload["summary"]
                endpoint.description = payload["description"]
                endpoint.tags = payload["tags"]
                endpoint.params = payload["params"]
                endpoint.responses = payload["responses"]
                endpoint.notes = payload["notes"]
                endpoint.code_samples = payload["code_samples"]
                endpoint.request_preview = payload["request_preview"]
                endpoint.response_body = payload["response_body"]
                endpoint.response_meta = payload["response_meta"]
                endpoint.source_type = "openapi"
                updated += 1
            else:
                skipped += 1

    await record_source_meta(
        db,
        target_type="import",
        target_ref="project-openapi",
        source_type="openapi",
        source_ref="/api/openapi.json",
        import_strategy="refresh" if refresh_existing else "merge",
        note="从当前项目 OpenAPI 自动导入接口骨架",
    )

    await sync_contract_reference_modules(db)

    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "unmatched": unmatched,
    }
