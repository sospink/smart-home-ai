# Dify 统一 Chatflow 模板

目录：`/Users/zyh/Work/AI/project/smart-home/project/dify`

## 推荐运行方式

当前交付主路径已经收口为一个最终 Dify 智能体：

- 本地 Dify 控制台：`http://192.168.251.190/app/d869d903-fd1f-4b24-890e-0fd7bb1ed60b/workflow`
- App ID：`d869d903-fd1f-4b24-890e-0fd7bb1ed60b`
- 模型：本地 Dify 已配置的千问 `qwen3-max`。
- Home Assistant：由平台后端连接 `http://192.168.251.190:8123`；HA Token 不进入 Dify DSL。
- 应用 API Key：在平台 `/agents` 的该智能体详情中填写，文档和仓库不保存明文。

平台 `/chat`、`/agents` 测试运行和运行记录优先调用 `/agents` 中标记为“当前使用”的 Dify 智能体；系统设置里的 Dify 应用 API Key 仅作为兼容兜底。

## 模板导入方式

当前部署和交付主路径使用以下单体 Chatflow 模板：

`00 Smart Home Unified Chatflow.yml`

该单体 Chatflow 内置四条主链路：

- 控制设备：解析控制意图，调用平台 `/api/v1/devices/search` 与 `/api/v1/devices/{entity_id}/control`。
- 知识问答：使用 Dify 知识库检索节点，导入后在控制台绑定真实 dataset。
- 数据查询：调用平台 `/api/v1/monitor/agent-query`，返回 `query_type`、`source_endpoint`、`data_source`、`fallback_note` 与查询结果摘要。
- 兜底问答：提示用户可继续使用设备控制、知识问答和数据查询能力。

## 导入后配置

导入 `00 Smart Home Unified Chatflow.yml` 后，只需要在 Dify 应用编排页完成以下配置：

1. 打开右上角“变量”或画布底部变量面板，确认应用级环境变量 `BACKEND_BASE_URL` 和 `AGENT_API_KEY` 已存在。
2. 将 `BACKEND_BASE_URL` 设置为 Dify 可访问的平台后端地址。本地联调使用 `http://192.168.251.4:8000`，不能填写 Dify 容器自身的 `localhost:8000`。
3. 将 `AGENT_API_KEY` 设置为平台 Agent 代理调用密钥；该变量类型为 `secret`，不要写入 DSL 或文档。
4. 在“知识库检索”节点绑定真实知识库 dataset。
5. 发布应用，并在平台 `/agents` 中填写该 Dify App ID、聊天或控制台地址、应用 API Key，并设为当前运行智能体。

节点中通过 `{{#env.BACKEND_BASE_URL#}}` 和 `{{#env.AGENT_API_KEY#}}` 引用上述变量。它们是 Dify 应用级环境变量，不是 Dify Docker `.env` 容器环境变量。

单体模板不需要配置旧版家居控制、RAG、数据分析三个子流程 App Key。

## 文件清单

1. `00 Smart Home Unified Chatflow.yml`：正式推荐单 DSL 入口。
2. `01 Main Orchestrator Chatflow.yml`：历史拆分版主 Chatflow。
3. `02_home_control_workflow.yml`：历史拆分版家居控制 Workflow。
4. `03_rag_qa_workflow.yml`：历史拆分版 RAG Workflow。
5. `04_data_analysis_workflow.yml`：历史拆分版数据分析 Workflow。
6. `05_orchestration_smoke_test_workflow.yml`：历史拆分版联调检查 Workflow。
7. `kb-seed/`：可上传到知识库的初始化文档。

旧 01-05 文件保留用于架构参考、单独联调和历史证据追溯；正式业务运行以 `/agents` 当前默认 Dify 智能体为准。

## 冒烟验证

在 `00 Smart Home Unified Chatflow` 中依次测试：

1. `根据知识库回答：系统支持哪些核心能力？`
   - 预期：进入知识问答分支，命中已绑定 dataset 时返回结论、依据和建议下一步。
2. `查询当前室内温度和最近 24 小时趋势`
   - 预期：进入数据查询分支，回答包含 `source_endpoint`、`data_source` 和趋势摘要。
3. `查询当前系统服务状态`
   - 预期：进入数据查询分支，回答服务名称、运行状态和延迟，不输出无关历史趋势。
4. `查询筒灯当前状态`
   - 预期：进入数据查询分支，从平台动态设备台账定位真实 HA 实体并返回 HA 当前状态。

## 合同映射

- 13/15/17/18/30：`00` 统一 Chatflow 和平台 `/agents` 绑定。
- ▲14：`00` 内置设备控制、知识问答、数据查询和系统状态接口能力。
- 31-35：`00` 的知识库检索节点与真实 dataset 绑定。
- 25/26/27：`00` 推荐模板 + 旧 01-05 历史拆分模板说明。

## 运行记录口径

- 平台主实例绑定一个 Dify App ID 和一个应用 API Key 即可，不再维护多个子 Workflow App Key。
- `/chat`、`/agents`、`/conversation-records` 后续围绕当前默认 Dify 智能体复测。
- 旧多 App `workflow_run_id` 和截图证据保留为阶段记录，不作为下一轮主路径。
