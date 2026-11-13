import json
import re


SERVICE_DISPLAY_NAMES = {
    "ollama": "Ollama",
    "dify": "Dify",
    "homeassistant": "Home Assistant",
    "influxdb": "InfluxDB",
}

TYPE_DISPLAY_NAMES = {
    "model_inference": "模型推理",
    "device_control": "设备控制",
    "user_management": "用户管理",
    "system_settings": "系统配置",
    "user_login": "用户登录",
    "agent_test": "智能体测试",
    "agent_control": "智能体设备控制",
    "agent_device_status": "智能体状态查询",
    "device_sync": "设备同步",
    "model_pull": "模型拉取",
    "model_management": "模型管理",
    "time_series": "时序数据",
    "api_doc_management": "接口文档管理",
    "agent_template": "智能体模板管理",
    "agent_instance": "智能体实例管理",
    "knowledge_management": "知识库管理",
    "sandbox_simulation": "电子沙盘联调",
}

ACTION_DISPLAY_NAMES = {
    "set_color_temperature": "设置色温",
    "set_brightness": "设置亮度",
    "select_option": "选择选项",
    "set_temperature": "设置温度",
    "set_percentage": "设置比例",
    "set_position": "设置位置",
    "set_hvac_mode": "设置温控模式",
    "set_effect": "选择灯光效果",
    "turn_on": "打开",
    "turn_off": "关闭",
    "toggle": "切换状态",
}

ROLE_DISPLAY_NAMES = {
    "admin": "管理员",
    "user": "普通用户",
}

RESULT_DISPLAY_NAMES = {
    "success": "成功",
    "failed": "失败",
    "error": "失败",
    "physical_pending": "待实机确认",
    "model_not_installed": "模型尚未安装",
    "inference_failed": "推理失败",
}


def business_log_title(title: str | None) -> str:
    """把历史日志中的服务键和动作枚举转换为统一业务标题。"""
    value = str(title or "").strip()
    for service, display_name in SERVICE_DISPLAY_NAMES.items():
        if value.startswith(f"{service} "):
            value = f"{display_name}{value[len(service):]}"
            break
    for action, display_name in ACTION_DISPLAY_NAMES.items():
        value = value.replace(action, display_name)
    return value


def business_log_type(log_type: str | None) -> str:
    return TYPE_DISPLAY_NAMES.get(str(log_type or ""), "其他系统操作")


def _legacy_detail_fields(detail: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for part in re.split(r"[;,]\s*", detail):
        key, separator, value = part.partition("=")
        if separator and key.strip() and value.strip():
            fields[key.strip().lower()] = value.strip()
    return fields


def _business_diagnostic(value: str) -> str:
    translated = str(value or "").strip()
    replacements = {
        "All connection attempts failed": "无法连接目标服务",
        "Server disconnected": "服务端连接已断开",
        "model_not_installed": "模型尚未安装",
        "inference_failed": "推理失败",
        "physical_pending": "待实机确认",
    }
    for source, target in replacements.items():
        translated = re.sub(re.escape(source), target, translated, flags=re.IGNORECASE)
    translated = re.sub(r"\s*without sending a response\.?", "", translated, flags=re.IGNORECASE)
    translated = re.sub(r"https?://\S+", "目标服务", translated, flags=re.IGNORECASE)
    if re.search(r"traceback|exception|\b[a-z]+error\b|connection refused|timed?\s*out", translated, re.IGNORECASE):
        return "相关服务调用失败，请检查服务状态和技术日志"
    return business_log_title(translated)[:240]


def _positive_int_text(value: str | None, unit: str) -> str:
    try:
        number = int(str(value or "").strip())
    except (TypeError, ValueError):
        return ""
    return f"{max(0, number)} {unit}"


def _known_field_summary(log_type: str | None, fields: dict[str, str]) -> str:
    """只解释已有稳定契约的字段，未知字段继续留在技术信息中。"""
    action = business_log_title(fields.get("action", "")).strip()
    result_key = fields.get("result", "").strip().lower()
    result = RESULT_DISPLAY_NAMES.get(result_key, "")

    if log_type == "user_login":
        role = ROLE_DISPLAY_NAMES.get(fields.get("role", "").strip().lower())
        return f"登录成功，当前身份为{role}。" if role else "登录成功。"

    if log_type == "model_inference":
        model = fields.get("model", "").strip()
        latency = _positive_int_text(fields.get("latency_ms"), "ms")
        subject = f"模型 {model} " if model else "模型"
        if result_key == "success":
            return f"{subject}推理完成{f'，耗时 {latency}' if latency else ''}。"
        if result:
            return f"{subject}推理结果：{result}{f'，耗时 {latency}' if latency else ''}。"

    if log_type in {"device_control", "agent_control"}:
        if result_key == "success":
            return f"设备控制完成{f'：{action}' if action else ''}。"
        if result:
            return f"设备控制结果：{result}{f'；执行动作：{action}' if action else ''}。"
        if action:
            return f"已提交设备操作：{action}。"

    if log_type == "agent_device_status":
        if result_key in {"failed", "error"}:
            return "智能体状态查询失败；请在技术信息中查看原始诊断。"
        answer = _business_diagnostic(fields.get("answer", ""))
        if answer:
            answer = re.sub(r"\bpower\s*[：:]\s*on\b", "电源：开启", answer, flags=re.IGNORECASE)
            answer = re.sub(r"\bpower\s*[：:]\s*off\b", "电源：关闭", answer, flags=re.IGNORECASE)
            return f"状态查询结果：{answer}"

    if log_type == "agent_test":
        answer = _business_diagnostic(fields.get("answer", ""))
        if answer:
            return f"智能体测试完成：{answer}"

    if log_type == "time_series":
        written = _positive_int_text(fields.get("written"), "个数据点")
        entities = _positive_int_text(fields.get("entity_count"), "个实体")
        if written or entities:
            scope = f"，覆盖 {entities}" if entities else ""
            return f"时序数据同步完成：写入 {written or '0 个数据点'}{scope}。"

    return ""


def business_log_summary(log_type: str | None, detail: str | None) -> str:
    """生成业务优先摘要；原始详情仍独立保留供审计排障。"""
    value = str(detail or "").strip()
    type_name = business_log_type(log_type)
    if not value:
        return "暂无补充说明"
    if value.startswith("{"):
        try:
            payload = json.loads(value)
            if isinstance(payload, dict):
                if log_type == "knowledge_management" and payload.get("action") == "hit_testing":
                    duration = payload.get("duration_ms")
                    duration_text = f"，耗时 {duration} ms" if isinstance(duration, (int, float)) else ""
                    if payload.get("status") == "success":
                        hit_count = max(0, int(payload.get("hit_count") or 0))
                        return f"语义检索完成，命中 {hit_count} 条{duration_text}。"
                    return f"语义检索失败{duration_text}；请在技术信息中查看错误分类。"
                return f"已记录{type_name}操作；完整字段请在技术信息中查看。"
        except (TypeError, ValueError, json.JSONDecodeError):
            pass
    if "InfluxDB 写入失败" in value:
        return "时序数据库写入暂时不可用，系统已进入退避重试；原始诊断请在技术信息中查看。"

    fields = _legacy_detail_fields(value)
    if len(fields) >= 2:
        diagnostic_value = fields.get("reason") or fields.get("error") or ""
        if not diagnostic_value:
            known_summary = _known_field_summary(log_type, fields)
            if known_summary:
                return known_summary
        diagnostic = _business_diagnostic(diagnostic_value)
        if diagnostic:
            if log_type in {"device_control", "agent_control"}:
                return f"设备控制未完成：{diagnostic}"
            if log_type == "model_inference":
                model = fields.get("model", "").strip()
                return f"{f'模型 {model} ' if model else '模型'}推理未完成：{diagnostic}"
            return f"{type_name}未完成：{diagnostic}"
        known_summary = _known_field_summary(log_type, fields)
        if known_summary:
            return known_summary
        result = _business_diagnostic(fields.get("result") or "")
        if result:
            return f"{type_name}结果：{result}；原始字段请在技术信息中查看。"
        return f"已记录{type_name}操作；原始字段请在技术信息中查看。"
    if re.search(r"(^|[;,\s])(action|target_user_id|target_username|deleted|retained_failures|scope|signature|user_id|role)=", value, re.IGNORECASE):
        return f"已记录{type_name}操作；原始字段请在技术信息中查看。"
    diagnostic = _business_diagnostic(value)
    return diagnostic or f"已记录{type_name}操作。"
