# Dify 架构重构模板（按“主 Chatflow + 子 Workflow”）

目录：`/Users/zyh/Work/AI/project/smart-home/project/dify`

## 架构（完全对应你的调研文档）

用户输入（唯一对话窗口）
→ `01_main_orchestrator_chatflow.yml`（主 Chatflow 意图识别 + 路由）
- 意图=控制设备 → `02_home_control_workflow.yml`
- 意图=知识问答 → `03_rag_qa_workflow.yml`
- 意图=数据查询 → `04_data_analysis_workflow.yml`
→ 汇总结果返回用户

`05_orchestration_smoke_test_workflow.yml` 用于联调与验收，不是主业务入口。

## 文件清单

1. `01 Main Orchestrator Chatflow.yml`（主入口，唯一对话窗口，推荐导入）
2. `01_main_orchestrator_chatflow.yml`（与上面同内容的兼容命名版）
3. `02_home_control_workflow.yml`（家居控制子流程，当前 Mock）
4. `03_rag_qa_workflow.yml`（RAG 子流程，dataset_ids 留空占位）
5. `04_data_analysis_workflow.yml`（数据分析子流程，当前 Mock）
6. `05_orchestration_smoke_test_workflow.yml`（架构联调检查）
7. `kb-seed/`（可直接上传到知识库的初始化文档）

## 高阶画布升级（已内置）

- `01`：新增“查询增强”节点 + 子流程结果产品化节点（控制/RAG/数据）。
- `02`：新增“执行策略评估”与“客户可读回执”节点。
- `03`：新增“命中结果优化”与“未命中补库建议”节点。
- `04`：新增“数据质检”与“高管摘要”节点。
- `05`：新增“测试样例生成”与“验收评分”节点。

## 你“主要调用哪个”？

- 对外主调用：**只调 `01_main_orchestrator_chatflow.yml`**。
- 其余 02/03/04 是被主流程自动调用的子能力模板（HTTP Request 调 Dify Workflow API）。

## 导入顺序

`02 -> 03 -> 04 -> 05 -> 01`

## 当前阶段说明（你要求的）

- 第一阶段不接 Home Assistant、虚拟设备。
- `02`/`04` 里保留 `TODO_REAL_ENDPOINT` 作为第二阶段替换位。
- `03` 的 `dataset_ids` 为空，导入后在 Dify 里绑定知识库。
- `01/02/03/04` 中的 `user_id/session_id/context` 已设为隐藏预留字段，不影响预览测试。

## `01` 自动调用版必配项

在 `01_main_orchestrator_chatflow` 里有 3 个 HTTP Request 节点（调用控制/RAG/数据子流程），需要把以下占位符改成真实值：

- `http://TODO_DIFY_HOST:3000/v1/workflows/run`
  - 改成你的 Dify 地址，例如：`http://192.168.1.10:3000/v1/workflows/run`
- `Authorization: Bearer TODO_API_KEY_02`
  - 改成 `02_home_control_workflow` 的 API Key（`app-...`）
- `Authorization: Bearer TODO_API_KEY_03`
  - 改成 `03_rag_qa_workflow` 的 API Key（`app-...`）
- `Authorization: Bearer TODO_API_KEY_04`
  - 改成 `04_data_analysis_workflow` 的 API Key（`app-...`）

说明：主入口会先调用子流程 `/v1/workflows/run`，再将响应清洗为用户可读文本后返回（不直接展示 JSON 原包）。

## 合同映射

- 13/15/17/18/30：`01`
- ▲14（4类接口能力预埋）：`02` + `04` + `05`
- 31-35：`03`
- 25/26/27（模板库与可扩展）：整套 5 个模板

## 冒烟验证（最短路径）

1. 在 `01` 输入：`打开客厅灯`
- 预期：执行到“调用控制子流程”节点，最终返回 `02` 的 workflow API 响应

2. 在 `01` 输入：`根据知识库回答：系统支持哪些能力`
- 预期：执行到“调用RAG子流程”节点，最终返回 `03` 的 workflow API 响应

3. 在 `01` 输入：`查询最近7天趋势`
- 预期：执行到“调用数据子流程”节点，最终返回 `04` 的 workflow API 响应
