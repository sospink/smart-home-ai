"""
智能体运行与管理框架服务

负责：
- 内置模板元数据
- DSL 文件解析
- 平台侧实例元数据初始化
- 合同化总览与能力说明
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any

import yaml
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_instance import AgentInstance
from app.services.runtime_settings import get_runtime_config


REPO_ROOT = Path(__file__).resolve().parents[3]
DIFY_DIR = REPO_ROOT / "dify"
DEFAULT_AGENT_BUSINESS_NAME = "智慧空间智能体"
BUILTIN_AGENT_BUSINESS_NAMES = {
    "template-00": DEFAULT_AGENT_BUSINESS_NAME,
    "template-01": "历史拆分主编排",
    "template-02": "家居控制工作流",
    "template-03": "知识问答工作流",
    "template-04": "数据分析工作流",
    "template-05": "联调测试工作流",
}
BUILTIN_AGENT_BUSINESS_DESCRIPTIONS = {
    "template-00": "统一承载设备控制、知识问答、数据查询和日常对话。",
    "template-01": "用于追溯历史分层编排方案，正式运行优先使用当前默认智能体。",
    "template-02": "负责识别家居控制意图、定位设备并调用平台控制接口。",
    "template-03": "负责检索知识库并生成带有真实命中依据的回答。",
    "template-04": "负责查询平台监控与历史数据并生成分析结果。",
    "template-05": "用于验证历史多应用编排链路，不作为正式业务入口。",
}
LEGACY_AGENT_BUSINESS_NAMES = {
    "00 Smart Home Unified Chatflow": DEFAULT_AGENT_BUSINESS_NAME,
    "01 Main Orchestrator Chatflow": "历史拆分主编排",
    "02 Home Control Workflow": "家居控制工作流",
    "03 RAG QA Workflow": "知识问答工作流",
    "04 Data Analysis Workflow": "数据分析工作流",
    "05 Orchestration Smoke Test Workflow": "联调测试工作流",
}


def get_legacy_agent_business_name(runtime_name: str) -> str:
    value = (runtime_name or "").strip()
    return LEGACY_AGENT_BUSINESS_NAMES.get(value, value)


def get_agent_business_name(
    instance: AgentInstance | None,
    *,
    default_context: bool = False,
) -> str:
    """默认智能体使用统一业务名，Dify 原名仅作为运行绑定证据。"""
    if not instance:
        return "未配置默认智能体"
    is_default = default_context or bool(getattr(instance, "is_default", False))
    if is_default:
        return DEFAULT_AGENT_BUSINESS_NAME
    source_template = str(getattr(instance, "source_template", "") or "")
    return BUILTIN_AGENT_BUSINESS_NAMES.get(source_template, instance.name)


def get_agent_business_description(instance: AgentInstance | None) -> str:
    if not instance:
        return ""
    source_template = str(getattr(instance, "source_template", "") or "")
    return BUILTIN_AGENT_BUSINESS_DESCRIPTIONS.get(
        source_template,
        str(getattr(instance, "description", "") or ""),
    )


@dataclass(frozen=True)
class BuiltInTemplate:
    id: str
    title: str
    file_name: str
    template_type: str
    description: str
    function_desc: str
    usage: str
    config: str
    customization: str
    entry_route: str
    docs_section: str
    default_model: str
    knowledge_bindings: list[str]
    capability_tags: list[str]
    instance_type: str
    default_status: str


BUILT_IN_TEMPLATES: tuple[BuiltInTemplate, ...] = (
    BuiltInTemplate(
        id="template-00",
        title="00 智慧家居统一 Chatflow",
        file_name="00 Smart Home Unified Chatflow.yml",
        template_type="Chatflow",
        description="智慧家居统一 Chatflow 是正式推荐入口，单个 DSL 内置家居控制、知识问答、数据查询和兜底问答能力。",
        function_desc="支持单应用导入、统一意图分类、平台设备控制、知识增强和监控数据查询，减少多 Workflow App Key 配置和运行排障复杂度。",
        usage="正式演示和交付优先只导入本模板；导入后配置 BACKEND_BASE_URL、AGENT_API_KEY，并在知识库检索节点绑定真实 dataset。",
        config="配置平台后端地址、Agent 调用 Key、默认模型和知识库 dataset；不需要配置 02/03/04 子 Workflow App Key。",
        customization="支持在同一画布内扩展新的意图类别、设备控制策略、知识库检索规则和数据查询回答模板。",
        entry_route="/chat",
        docs_section="template-00",
        default_model="qwen3-max",
        knowledge_bindings=["智慧家居"],
        capability_tags=["智能体框架与应用", "知识增强", "设备控制接口", "数据查询接口", "Web 管理界面"],
        instance_type="chatflow",
        default_status="ready",
    ),
    BuiltInTemplate(
        id="template-01",
        title="01 历史拆分主编排 Chatflow",
        file_name="01 Main Orchestrator Chatflow.yml",
        template_type="Chatflow",
        description="历史拆分版主编排 Chatflow，负责接收用户请求并通过 Dify Workflow API 路由到家居控制、知识问答与数据分析子流程。",
        function_desc="用于追溯多 App 分层编排结构；正式演示优先使用 00 统一 Chatflow。",
        usage="作为历史拆分模板保留；仅在需要验证多 App 编排时，按旧流程导入 02/03/04 后再导入本模板。",
        config="配置默认模型、Dify Chatflow 运行参数、绑定知识库以及外部 HTTP 请求地址，确保与平台系统设置一致。",
        customization="支持扩展新的意图分类规则、子流程分发策略、回答模板和对话开场白，满足科研应用二次开发与功能扩展。",
        entry_route="/chat",
        docs_section="template-01",
        default_model="qwen3:8b",
        knowledge_bindings=["智慧家居科研知识库"],
        capability_tags=["智能体框架与应用", "知识增强", "应用模板库", "Web 管理界面"],
        instance_type="chatflow",
        default_status="ready",
    ),
    BuiltInTemplate(
        id="template-02",
        title="02 家居控制 Workflow",
        file_name="02_home_control_workflow.yml",
        template_type="Workflow",
        description="历史拆分版家居控制 Workflow，负责解析控制意图、搜索目标设备、调用设备控制接口并返回执行结果。",
        function_desc="绑定智能家居对接能力与设备控制接口，可作为 00 统一 Chatflow 控制分支的结构参考。",
        usage="作为历史拆分模板和单独联调参考保留；正式演示优先导入 00 统一 Chatflow。",
        config="配置 Home Assistant、设备控制接口地址、X-Agent-Key 与默认控制模型，保证控制链路可用。",
        customization="支持增加设备类型、扩展场景联动规则、自定义控制前置校验与执行回执，满足功能扩展。",
        entry_route="/devices",
        docs_section="template-02",
        default_model="qwen3:8b",
        knowledge_bindings=[],
        capability_tags=["智能家居对接能力", "设备控制接口", "Web 管理界面"],
        instance_type="workflow",
        default_status="ready",
    ),
    BuiltInTemplate(
        id="template-03",
        title="03 RAG 问答 Workflow",
        file_name="03_rag_qa_workflow.yml",
        template_type="Workflow",
        description="历史拆分版 RAG 问答 Workflow，用于完成知识增强、语义检索、命中结果优化与知识调用。",
        function_desc="承接知识增强与应用模板库能力，可作为 00 统一 Chatflow RAG 分支的结构参考。",
        usage="作为历史拆分模板和知识库单独联调参考保留；正式演示优先导入 00 统一 Chatflow。",
        config="配置数据集、Embedding 模型、语义检索参数与回答生成模型，确保知识库连接与检索链路可用。",
        customization="支持替换检索策略、调整命中阈值、增强引用样式与补库建议逻辑，以适配不同科研知识场景。",
        entry_route="/knowledge",
        docs_section="template-03",
        default_model="qwen3:8b",
        knowledge_bindings=["智慧家居科研知识库"],
        capability_tags=["知识增强", "知识库检索接口", "应用模板库"],
        instance_type="workflow",
        default_status="ready",
    ),
    BuiltInTemplate(
        id="template-04",
        title="04 数据分析 Workflow",
        file_name="04_data_analysis_workflow.yml",
        template_type="Workflow",
        description="历史拆分版数据分析 Workflow，用于汇总系统运行数据、分析趋势并生成监控与科研分析结果。",
        function_desc="支持数据查询接口、系统运行情况分析与监控数据处理，可作为 00 统一 Chatflow 数据分支的结构参考。",
        usage="作为历史拆分模板和数据查询单独联调参考保留；正式演示优先导入 00 统一 Chatflow。",
        config="配置数据源地址、查询参数、分析模型和报告模板；优先接入平台 `/monitor/agent-query` 与时序数据接口。",
        customization="支持扩展查询模版、图表摘要风格、统计口径和科研实验分析报告输出格式。",
        entry_route="/monitor",
        docs_section="template-04",
        default_model="deepseek-r1:7b",
        knowledge_bindings=[],
        capability_tags=["数据查询接口", "应用模板库", "Web 管理界面"],
        instance_type="workflow",
        default_status="ready",
    ),
    BuiltInTemplate(
        id="template-05",
        title="05 联调测试 Workflow",
        file_name="05_orchestration_smoke_test_workflow.yml",
        template_type="Workflow",
        description="历史拆分版联调测试 Workflow，用于验证多智能体分层架构的编排结果、运行状态与准备情况。",
        function_desc="支持测试旧版多 App 交互效果，并为历史拆分结构调试提供参考。",
        usage="作为历史拆分模板保留；正式演示不需要导入本模板。",
        config="配置测试问题、调用路由、评分策略与联调开关，保证联调验证与会话记录页面可联动查看结果。",
        customization="支持扩展测试样例、联调评分逻辑与验收提示文案，适用于持续优化与功能扩展。",
        entry_route="/conversation-records",
        docs_section="template-05",
        default_model="qwen3:8b",
        knowledge_bindings=[],
        capability_tags=["应用模板库", "运行记录与调试", "Web 管理界面"],
        instance_type="workflow",
        default_status="ready",
    ),
)


def _slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return normalized or "agent-instance"


def _sanitize_storage_text(value: str) -> str:
    """当前 MySQL 字符集不保证 utf8mb4，持久化前去掉 4 字节字符（主要是 emoji）。"""
    return "".join(char for char in value if ord(char) <= 0xFFFF)


_SENSITIVE_DSL_NAMES = {
    "apikey",
    "accesstoken",
    "refreshtoken",
    "token",
    "password",
    "passwd",
    "secret",
    "clientsecret",
    "credential",
    "credentials",
    "authvalue",
}
_SENSITIVE_HEADER_PATTERN = re.compile(
    r"(?im)(\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)(?!\{\{|\$\{)([^\s'\"\\]+)"
    r"|(\b(?:x-api-key|x-agent-key|api-key)\s*:\s*)(?!\{\{|\$\{)([^\s'\"\\]+)"
)


def _normalized_secret_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _is_sensitive_dsl_name(value: Any) -> bool:
    normalized = _normalized_secret_name(value)
    return normalized in _SENSITIVE_DSL_NAMES or any(
        normalized.endswith(suffix)
        for suffix in ("apikey", "accesstoken", "refreshtoken", "password", "passwd", "secret")
    )


def _is_runtime_secret_reference(value: str) -> bool:
    text = value.strip()
    return bool(
        re.fullmatch(r"\{\{[^{}]+\}\}", text)
        or re.fullmatch(r"\$\{[^{}]+\}", text)
    )


def _redact_header_secrets(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        return match.group(1) or match.group(3) or ""

    return _SENSITIVE_HEADER_PATTERN.sub(replace, value)


def _redact_dsl_credentials(value: Any) -> Any:
    if isinstance(value, list):
        return [_redact_dsl_credentials(item) for item in value]
    if not isinstance(value, dict):
        return value

    secret_container = str(value.get("value_type") or "").strip().lower() == "secret"
    secret_container = secret_container or _is_sensitive_dsl_name(value.get("name"))
    secret_container = secret_container or _is_sensitive_dsl_name(value.get("variable"))
    sanitized: dict[Any, Any] = {}
    for key, item in value.items():
        normalized_key = _normalized_secret_name(key)
        if secret_container and normalized_key in {"value", "default", "defaultvalue"}:
            sanitized[key] = ""
        elif _is_sensitive_dsl_name(key) and not isinstance(item, (dict, list)):
            text = str(item or "")
            sanitized[key] = text if _is_runtime_secret_reference(text) else ""
        elif normalized_key in {"headers", "header"} and isinstance(item, str):
            sanitized[key] = _redact_header_secrets(item)
        else:
            sanitized[key] = _redact_dsl_credentials(item)
    return sanitized


def _redact_unparsed_dsl_credentials(value: str) -> str:
    """历史损坏 DSL 也不能因无法解析而把常见明文凭证返回给读取接口。"""
    result = _redact_header_secrets(value)
    sensitive_key = re.compile(
        r"(?im)^(\s*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|auth[_-]?value)\s*:\s*)(?!\{\{|\$\{).*$"
    )
    return sensitive_key.sub(r"\1''", result)


def _template_lookup() -> dict[str, BuiltInTemplate]:
    return {template.id: template for template in BUILT_IN_TEMPLATES}


def _read_yaml_file(file_name: str) -> dict[str, Any]:
    path = DIFY_DIR / file_name
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def get_template_docs() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for template in BUILT_IN_TEMPLATES:
        parsed = _read_yaml_file(template.file_name)
        app_meta = parsed.get("app", {}) if isinstance(parsed, dict) else {}
        result.append(
            {
                "id": template.id,
                "title": template.title,
                "file_name": template.file_name,
                "template_type": app_meta.get("mode", template.template_type),
                "description": app_meta.get("description", template.description),
                "function_desc": template.function_desc,
                "usage": template.usage,
                "config": template.config,
                "customization": template.customization,
                "entry_route": template.entry_route,
                "docs_section": template.docs_section,
                "capability_tags": template.capability_tags,
            }
        )
    return result


async def ensure_seed_instances(db: AsyncSession) -> None:
    existing_result = await db.execute(
        select(AgentInstance.source_template).where(AgentInstance.source_type == "built_in_template")
    )
    existing_templates = {item for item in existing_result.scalars().all() if item}
    runtime_config = await get_runtime_config(db)
    instances = []
    for template in BUILT_IN_TEMPLATES:
        if template.id in existing_templates:
            continue
        parsed = _read_yaml_file(template.file_name)
        app_meta = parsed.get("app", {}) if isinstance(parsed, dict) else {}
        dify_console_url = runtime_config.dify_base_url.rstrip("/") if runtime_config.dify_base_url else ""
        instances.append(
            AgentInstance(
                name=app_meta.get("name", template.title),
                slug=_slugify(template.title),
                dify_app_id="",
                instance_type=template.instance_type,
                source_type="built_in_template",
                source_template=template.id,
                dsl_file_name=template.file_name,
                status=template.default_status,
                enabled=True,
                is_default=template.id == "template-00",
                description=app_meta.get("description", template.description),
                default_model=template.default_model,
                knowledge_bindings=template.knowledge_bindings,
                capability_tags=template.capability_tags,
                entry_route=template.entry_route,
                dify_console_url=dify_console_url,
                dsl_content=_sanitize_storage_text(
                    yaml.safe_dump(parsed, allow_unicode=True, sort_keys=False) if parsed else ""
                ),
            )
        )

    if instances:
        db.add_all(instances)
        await db.flush()

    final_result = await db.execute(
        select(AgentInstance)
        .where(AgentInstance.source_template == "template-00")
        .order_by(AgentInstance.is_default.desc(), AgentInstance.updated_at.desc(), AgentInstance.id.desc())
    )
    final_instance = final_result.scalars().first()
    if final_instance:
        changed = False
        default_count = await db.scalar(select(func.count()).select_from(AgentInstance).where(AgentInstance.is_default.is_(True))) or 0
        if default_count == 0:
            final_instance.is_default = True
            final_instance.status = "ready" if final_instance.enabled else "disabled"
            changed = True
        if changed:
            await db.flush()


async def get_default_chat_agent(db: AsyncSession) -> AgentInstance | None:
    await ensure_seed_instances(db)
    result = await db.execute(
        select(AgentInstance)
        .where(
            AgentInstance.enabled.is_(True),
            AgentInstance.instance_type == "chatflow",
            AgentInstance.is_default.is_(True),
        )
        .order_by(AgentInstance.updated_at.desc(), AgentInstance.id.desc())
    )
    instance = result.scalars().first()
    if instance:
        return instance
    fallback = await db.execute(
        select(AgentInstance)
        .where(
            AgentInstance.enabled.is_(True),
            AgentInstance.instance_type == "chatflow",
            AgentInstance.source_template == "template-00",
        )
        .order_by(AgentInstance.updated_at.desc(), AgentInstance.id.desc())
    )
    return fallback.scalars().first()


def derive_dify_base_url(url: str) -> str:
    value = (url or "").strip().rstrip("/")
    if not value:
        return ""
    for route_prefix in ("/chat/", "/app/"):
        if route_prefix in value:
            return value.split(route_prefix, 1)[0].rstrip("/")
    if value.endswith("/apps"):
        return value[:-5].rstrip("/")
    return value


def agent_callable_condition(has_runtime_key: bool):
    """只有具备真实调用凭证的启用实例才计入可调用数量。"""
    credential_condition = AgentInstance.dify_api_key != ""
    if has_runtime_key:
        credential_condition = or_(credential_condition, AgentInstance.is_default.is_(True))
    return and_(AgentInstance.enabled.is_(True), credential_condition)


def agent_template_reference_condition():
    """未绑定凭证且非默认的模板实例仅作为模板参考。"""
    return and_(
        AgentInstance.source_type.in_(("built_in_template", "template_library")),
        AgentInstance.dify_api_key == "",
        AgentInstance.is_default.is_(False),
    )


async def get_overview_payload(db: AsyncSession) -> dict[str, Any]:
    await ensure_seed_instances(db)
    total_instances = await db.scalar(select(func.count()).select_from(AgentInstance)) or 0
    runtime_config = await get_runtime_config(db)
    callable_instances = await db.scalar(
        select(func.count()).select_from(AgentInstance).where(
            agent_callable_condition(bool(runtime_config.dify_api_key)),
        )
    ) or 0
    running_instances = await db.scalar(
        select(func.count()).select_from(AgentInstance).where(AgentInstance.status == "running")
    ) or 0
    template_references = await db.scalar(
        select(func.count()).select_from(AgentInstance).where(
            agent_template_reference_condition(),
        )
    ) or 0

    return {
        "title": "智能体运行与管理框架总览",
        "subtitle": "统一展示本地大语言模型服务、当前 Dify 智能体、智能家居对接能力、知识增强、历史模板库和 Web 管理界面。",
        "metrics": [
            {"label": "登记记录", "value": str(total_instances), "note": "包含模板参考与应用实例"},
            {"label": "调用已配置", "value": str(callable_instances), "note": "具备实例或默认运行时凭证"},
            {"label": "运行中实例", "value": str(running_instances), "note": "支持运行与调试"},
            {"label": "模板参考记录", "value": str(template_references), "note": "不作为已部署应用统计"},
        ],
        "modules": [
            {
                "title": "本地大语言模型服务",
                "description": "对接本地开源大语言模型，支持模型运行状态查看、配置、调用与切换。",
                "status": "ready",
                "entry_label": "查看模型运行状态",
                "entry_route": "/models",
                "deployment_scope": "本地化部署 / 离线运行能力",
                "extensible": True,
            },
            {
                "title": "智能体框架与应用",
                "description": "登记已发布的 Dify 智能体，绑定实例级 API Key，设为当前使用后由对话和测试入口统一调用。",
                "status": "ready",
                "entry_label": "进入智能体运行与管理框架",
                "entry_route": "/agents",
                "deployment_scope": "Dify + 平台中台聚合",
                "extensible": True,
            },
            {
                "title": "智能家居对接能力",
                "description": "连接 Home Assistant 与虚拟设备系统，支持设备状态、传感器数据、场景信息与控制能力。",
                "status": "ready",
                "entry_label": "查看设备与电子沙盘",
                "entry_route": "/devices",
                "deployment_scope": "可本地部署的智能家居对接组件",
                "extensible": True,
            },
            {
                "title": "知识增强",
                "description": "提供知识库管理、语义检索、知识调用与文本解析嵌入方式，支撑智能体知识增强。",
                "status": "ready",
                "entry_label": "进入知识库管理",
                "entry_route": "/knowledge",
                "deployment_scope": "本地知识增强链路",
                "extensible": True,
            },
            {
                "title": "应用模板库",
                "description": "保留统一 Chatflow 模板和历史拆分模板说明，正式运行以当前默认 Dify 智能体为准。",
                "status": "ready",
                "entry_label": "查看应用模板库",
                "entry_route": "/agents/templates",
                "deployment_scope": "1 份推荐模板 + 历史拆分版",
                "extensible": True,
            },
            {
                "title": "Web 管理界面",
                "description": "统一 Web 管理界面覆盖智能体对话、会话与运行记录、模型运行状态查看、设备控制、知识库管理等功能。",
                "status": "ready",
                "entry_label": "访问控制台",
                "entry_route": "/dashboard",
                "deployment_scope": "统一管理界面",
                "extensible": True,
            },
        ],
        "deployment_highlights": [
            "本地化部署",
            "离线运行能力",
            "开源大语言模型",
            "可本地部署的智能体框架",
            "可本地部署的智能家居对接组件",
            "支持二次开发和功能扩展",
            f"Dify 控制台入口：{runtime_config.dify_base_url.rstrip('/') if runtime_config.dify_base_url else '未配置'}",
        ],
    }


async def get_capabilities_payload(db: AsyncSession) -> dict[str, Any]:
    runtime_config = await get_runtime_config(db)
    return {
        "title": "运行框架与扩展能力",
        "subtitle": "展示本地化部署、离线运行能力、开源组件与智能家居对接能力。",
        "items": [
            {
                "title": "本地化部署",
                "description": "平台支持在无外网连接情况下完成模型推理、智能体运行与知识库检索。",
            },
            {
                "title": "离线运行能力",
                "description": "依托本地模型服务、可本地部署的智能体框架与知识增强能力完成核心科研业务。",
            },
            {
                "title": "开源大语言模型",
                "description": "接入 Ollama，支持符合国家法律法规的开源大语言模型部署与运行。",
            },
            {
                "title": "可本地部署的智能体框架",
                "description": "Dify 作为智能体框架与应用运行底座，平台负责统一管理和调用入口。",
                "console_url": runtime_config.dify_base_url.rstrip("/") if runtime_config.dify_base_url else "",
            },
            {
                "title": "可本地部署的智能家居对接组件",
                "description": "通过 Home Assistant、电子沙盘与统一设备接口实现智能家居对接能力。",
            },
            {
                "title": "支持二次开发和功能扩展",
                "description": "支持模板定制、DSL 扩展、外部接口能力绑定与平台侧功能扩展。",
            },
        ],
    }


def get_template_by_id(template_id: str) -> BuiltInTemplate | None:
    return _template_lookup().get(template_id)


def _derive_dsl_business_description(parsed: dict[str, Any]) -> str:
    """仅从作者填写的节点说明中提取用途，不根据模板名称推测业务。"""
    workflow = parsed.get("workflow")
    if not isinstance(workflow, dict):
        return ""
    graph = workflow.get("graph")
    if not isinstance(graph, dict):
        return ""
    nodes = graph.get("nodes")
    if not isinstance(nodes, list):
        return ""

    candidates: list[str] = []
    for node in nodes:
        data = node.get("data") if isinstance(node, dict) else None
        raw_description = data.get("desc") if isinstance(data, dict) else None
        if not isinstance(raw_description, str):
            continue
        description = re.sub(r"\s+", " ", raw_description).strip()
        if 12 <= len(description) <= 180:
            candidates.append(description)
    return max(candidates, key=len, default="")


def parse_dsl_content(raw_text: str) -> dict[str, Any]:
    try:
        parsed = yaml.safe_load(raw_text) or {}
    except yaml.YAMLError as exc:
        raise ValueError(f"DSL 解析失败: {exc}") from exc

    app_meta = parsed.get("app", {}) if isinstance(parsed, dict) else {}
    explicit_description = app_meta.get("description", "") if isinstance(app_meta, dict) else ""
    return {
        "name": app_meta.get("name", ""),
        "mode": app_meta.get("mode", ""),
        "description": str(explicit_description or "").strip() or _derive_dsl_business_description(parsed),
    }


def sanitize_dsl_storage(raw_text: str) -> str:
    storage_text = _sanitize_storage_text(raw_text)
    try:
        parsed = yaml.safe_load(storage_text)
    except yaml.YAMLError:
        return _redact_unparsed_dsl_credentials(storage_text)
    if not isinstance(parsed, (dict, list)):
        return _redact_unparsed_dsl_credentials(storage_text)
    sanitized = _redact_dsl_credentials(parsed)
    return yaml.safe_dump(sanitized, allow_unicode=True, sort_keys=False)
