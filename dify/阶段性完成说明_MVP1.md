# 智慧家居项目 Dify 阶段性完成说明

- 文档日期：2026-03-11
- 更新版本：v1.3（补充小米真实接入方案 + Web 平台职责划分 + 修正路线图）
- 归档位置：`/Users/zyh/Work/AI/project/smart-home/project/dify`
- 项目定位：**智能家居大模型科研一体机**，对接小米智能家居真实硬件，非纯演示项目。

---

## 1. 本阶段交付物（MVP1 完成）

1. `01 Main Orchestrator Chatflow.yml`（主入口，自动分流 + 自动调用子流程，推荐导入）
2. `01_main_orchestrator_chatflow.yml`（与上同内容的兼容命名版）
3. `02_home_control_workflow.yml`（控制子流程，Mock）
4. `03_rag_qa_workflow.yml`（RAG 子流程，可绑定知识库）
5. `04_data_analysis_workflow.yml`（数据分析子流程，Mock）
6. `05_orchestration_smoke_test_workflow.yml`（联调与验收评分）
7. `README.md`（导入顺序、配置说明、联调说明）
8. `kb-seed/*.md`（知识库初始化文档）

---

## 2. 当前可运行能力

- 单一主入口对话：用户只与 `01` 交互。
- 意图分类路由：控制 / 知识问答 / 数据分析。
- 主入口自动调用子流程：通过 `/v1/workflows/run` 调 `02/03/04`。
- 返回用户可读结果：主入口不直接回显 API 原始 JSON。
- RAG 基础可用：支持命中 / 未命中分支与补库建议。

---

## 3. 本次新增升级（v1.1）

### 3.1 画布架构升级

- `01` 新增"查询增强"节点，提升入口专业度。
- `02` 新增"执行策略评估"与"客户可读回执"。
- `03` 新增"命中结果优化"与"未命中补库建议"。
- `04` 新增"数据质检"与"高管摘要"。
- `05` 新增"测试样例生成"与"验收评分"。

### 3.2 稳定性与兼容修复

- 修复 RAG IF 节点操作符兼容：`not empty`（适配当前 Dify 版本）。
- 主入口保持子流程自动调用链路，避免只做路由不执行。

### 3.3 性能优化

- 主入口 3 个 HTTP 节点关闭重试（减少失败等待）。
- 分类与结果整理节点下调 `max_tokens`。
- RAG 关闭 rerank，`top_k` 降至 3，降低检索耗时。

---

## 4. 合同条款映射与完整 Gap 分析

### 4.1 已完成（MVP1 层面）

| 条款 | 内容 | 完成情况 |
|------|------|---------|
| 13 | 智能体运行框架（Dify） | ✅ 架构完整，Docker 部署 |
| 15 | 基于上下文的多轮对话 | ✅ Chatflow 会话历史 |
| 17 | 流程/规则驱动任务执行 | ✅ 工作流节点编排 |
| 18 | 多智能体实例统一调用 | ✅ 01 调 02/03/04 |
| 25 | 应用模板库雏形 | ✅ 5 个 yml 模板文件 |
| 30 | Prompt 编辑与测试 | ✅ Dify 编辑器可配置 |
| 31 | 知识库管理基础链路 | ✅ 03 RAG 流程已建 |
| 35 | 语义检索能力 | ✅ Knowledge Retrieval 节点 |

### 4.2 缺口清单（完整版 vs MVP1）

> 按优先级排列，▲ 为合同强制项，验收必须提供截图。

---

#### 🔴 最高优先级：▲强制项

**▲14 条 — 4 种真实接口调用**（当前最大缺口）

合同要求：Agent 实际执行时可演示 4 种不同类型的外部接口调用，需截图留证。

| 接口类型 | 当前状态 | 完整版需补充 |
|---------|---------|------------|
| ① HA 设备控制（POST /api/services） | ❌ Mock（TODO_REAL_ENDPOINT） | 替换 `02` 的占位为真实 HA API |
| ② HA 状态查询（GET /api/states） | ❌ 缺失 | 在 `02` 或单独 Workflow 加"状态查询"分支 |
| ③ RAG 知识库检索 | ⚠️ 架构有，未绑真实知识库 | 在 `03` 绑定知识库并上传真实文档 |
| ④ 文件处理 或 InfluxDB 数据查询 | ❌ Mock | 替换 `04` 的 LLM Mock 为真实数据源查询 |

验收截图需要展示：工具列表（4 种工具）+ Agent 执行过程 + 每种接口的调用日志。

---

**▲23 条 — 虚拟设备/电子沙盘**（Dify 无法覆盖，需独立模块）

合同要求：展示虚拟家居平面图界面、设备状态实时更新、点击控制前后对比。

| 子模块 | 当前状态 | 工作量估算 |
|-------|---------|-----------|
| HA Template 虚拟实体（YAML 配置） | ❌ 未做 | 约 1 天 |
| MQTT 仿真器（Python 脚本，推模拟传感器数据） | ❌ 未做 | 约 1 天 |
| Streamlit 电子沙盘可视化界面 | ❌ 未做 | 约 2-3 天 |

验收截图需要展示：Streamlit 主界面、虚拟设备状态实时变化、HA 后台虚拟实体列表、MQTT 仿真器运行日志。

---

#### 🟡 P1 优先级：功能性缺口

| 条款 | 内容 | 当前状态 | 需补充 |
|------|------|---------|--------|
| 16 | 会话记录管理与效果评估 | ⚠️ Dify 有日志，无导出/检索界面 | 做简单脚本导出运行日志，或截图 Dify Monitor 页面留证 |
| 20 | 获取设备状态/传感器/场景 | ❌ `02` 只有控制，无查询分支 | 在 `02` 或新建 Workflow 加 GET /api/states 分支 |
| 21 | 历史数据查询（时序数据） | ❌ `04` 是 LLM Mock | 替换为真实 InfluxDB 查询（Code 节点执行 Python） |
| 22 | 设备控制接口 | ❌ `02` 未接真实 HA | 同 ▲14 ① |
| 24 | 虚拟设备控制 | ❌ 依赖 ▲23 先完成 | ▲23 完成后，`02` 自动覆盖 |
| 32 | 向量数据库/语义检索 | ⚠️ 架构有，缺操作截图 | 上传文档后截图知识库管理页面 |
| 33 | 多格式文档解析 | ⚠️ Dify 支持，缺操作截图 | 上传 PDF/Word/MD，截图解析过程留证 |
| 34 | 知识库增量更新管理 | ⚠️ Dify 支持，缺操作截图 | 演示新增/修改/删除文档，截图留证 |

---

#### 🟢 P2 优先级：周边配套

| 条款 | 内容 | 需补充 |
|------|------|--------|
| 26 | 开发脚手架 | 整理 Python SDK 示例代码为独立目录 `sdk-examples/` |
| 27 | 模板说明文档 | README 已有基础，可升级为 MkDocs 文档站（可选） |
| 29 | JupyterLab | 独立 Docker 服务，与 Dify 无关，单独部署即可 |
| 37 | 设备状态可视化 Dashboard | 在 HA Lovelace 配置展示卡片，截图留证 |
| 38 | 电子沙盘嵌入统一门户 | Streamlit 完成后，iframe 嵌入 Nginx 门户的 `/sandbox` 路径 |

---

### 4.3 完整版合同覆盖度汇总

```
Dify 相关条款（13-18、25-35）：
  ✅ 已完成    8 条（13/15/17/18/25/30/31/35）
  ⚠️ 架构有但缺证据  4 条（32/33/34/16）
  ❌ 未完成    5 条（▲14/20/21/22/24）

智能家居模块（19-24）：
  ❌ 全部未完成（19/20/21/22/▲23/24）
  → 02接真实HA后可覆盖 19/20/22/24
  → 04接真实InfluxDB后可覆盖 21
  → 单独开发沙盘模块后覆盖 ▲23

周边模块（26-29/37/38）：
  → 独立配套工作，与Dify架构无关
```

---

## 5. 真实落地架构（v1.3 新增）

### 5.1 完整系统链路

```
小米智能家居硬件（灯/空调/传感器/插座等）
        ↕ 小米私有协议 / Zigbee / MQTT
Home Assistant（部署在科研一体机，Docker）
        ↕  xiaomi_miot_auto 集成插件
        ↕  HA REST API（Long-Lived Token 鉴权）
              ↙                    ↘
   Dify 智能体                  Web 管理平台
   （自然语言→控制）            （状态展示 + 会话历史）
        ↕ /v1/workflows/run
   02/03/04 子流程
```

### 5.2 小米设备接入方案

**核心插件：`xiaomi_miot_auto`**（HACS 安装，GitHub 活跃维护，支持 2000+ 米家设备型号）

| 接入方式 | 延迟 | 稳定性 | 适用场景 |
|---------|------|--------|---------|
| **本地局域网直连** | <100ms | 高 | 一体机与小米网关同局域网，优先选择 |
| **小米云端轮询** | 1-3秒 | 中 | 本地直连不支持的设备兜底方案 |

科研一体机与小米网关同局域网，优先走**本地直连**，速度快且不依赖外网。

**接入效果好的设备类型：**
- 米家灯具（全系基本支持）
- 小米空调伴侣 / 米家插座 / 开关面板
- Aqara/绿米 Zigbee 系列（本地直连最稳定）
- 米家温湿度传感器、人体传感器
- 小米扫地机器人

**接入后 HA 侧的 entity_id 示例：**
```
light.living_room_light        # 客厅灯
switch.bedroom_switch          # 卧室开关
sensor.temperature_bedroom     # 卧室温度
climate.air_conditioner        # 空调
```

**Dify `02` 子流程替换占位符示例：**
```
TODO_REAL_ENDPOINT
→ http://localhost:8123/api/services/light/turn_on
  Header: Authorization: Bearer <HA_LONG_LIVED_TOKEN>
  Body:   {"entity_id": "light.living_room_light"}
```

### 5.3 Web 管理平台职责划分

明确各系统边界，避免重复建设：

| 功能模块 | 归属 | 说明 |
|---------|------|------|
| 知识库管理（上传/解析/检索/删除） | **Dify 原生后台** | 直接用 Dify 界面，截图留证即可 |
| AI 智能体对话 | **Dify WebApp iframe 嵌入** | 不重复开发对话 UI |
| 会话记录 / 历史消息查看 | **Web 平台** | 调 `GET /v1/conversations` + `GET /v1/messages` |
| 设备实时状态展示 | **Web 平台** | 调 `GET /api/states`，轮询或 SSE |
| 设备控制操作 | **Web 平台** | 调 `POST /api/services/{domain}/{service}` |
| 电子沙盘（平面图可视化） | **Web 平台** | SVG 平面图 + 状态叠加 + 点击控制 |
| 历史数据 / 趋势图表 | **Web 平台** | 调 HA history API 或 InfluxDB |
| 设备列表管理 | **HA 原生 Lovelace** | 截图留证即可 |

**Web 平台需调用的 API 汇总：**
```
HA REST API（Bearer Token 鉴权）
  GET  /api/states                          → 所有设备状态
  GET  /api/states/{entity_id}              → 单设备状态
  POST /api/services/{domain}/{service}     → 控制设备
  GET  /api/history/period/{timestamp}      → 历史时序数据

Dify API（API Key 鉴权）
  GET  /v1/conversations                    → 会话列表
  GET  /v1/messages?conversation_id=xxx     → 单会话消息历史
  DELETE /v1/conversations/{id}             → 删除会话
```

### 5.4 Home Assistant 部署方式

部署在科研一体机，加入现有 `docker-compose.yml`：

```yaml
homeassistant:
  image: ghcr.io/home-assistant/home-assistant:stable
  container_name: homeassistant
  volumes:
    - ./ha-config:/config
  network_mode: host        # 局域网直连小米设备必须用 host 模式
  restart: unless-stopped
  privileged: true
```

> ⚠️ 必须使用 `network_mode: host`，否则 HA 无法发现局域网内的小米设备（mDNS/UDP 广播依赖宿主机网络栈）。

初始化后在 HA 中：
1. 安装 HACS（社区插件商店）
2. 通过 HACS 安装 `xiaomi_miot_auto`
3. 配置页添加小米账号，自动发现设备
4. 生成 Long-Lived Access Token 供 Dify 和 Web 平台调用

---

## 6. 当前边界与风险

- `02`、`04` 仍为 Mock，不代表真实设备控制与真实数据查询。
- 子流程调用依赖 3 组 API Key（02/03/04），Key 映射错误会导致分支串线。
- 主入口存在两个文件名版本（`01 Main...` 和 `01_main...`），建议统一为一个发布口径。
- API Key / HA Token 需保密治理，不得明文提交 Git（建议 `.env` 文件 + `.gitignore`）。
- 依赖 `langgenius/tongyi` 插件（通义千问），**离线环境导入后需手动切换模型为 Ollama**。
- HA 接小米设备需要小米账号授权；部分 2023 年后新品可能仅支持云端轮询，存在 1-3 秒延迟。
- `xiaomi_miot_auto` 为社区插件，小米协议变更时需等待插件更新，存在短期兼容风险。

---

## 7. 后续阶段路线图（修正版）

> 基于真实落地目标修正，▲ 为合同强制验收项。

### 第一步：部署 HA + 接入小米设备（前置条件，预计 1-2 天）

1. 在科研一体机 `docker-compose.yml` 中添加 HA 服务（`network_mode: host`）
2. HA 初始化，安装 HACS，安装 `xiaomi_miot_auto` 插件
3. 添加小米账号，确认设备列表出现在 HA 实体列表中
4. 生成 HA Long-Lived Access Token
5. 在 HA Lovelace 配置设备卡片，截图留证（覆盖条款 37）

### 第二步：Dify 接真实 HA 接口，打通 ▲14（预计 1 周）

6. 替换 `02` 的 `TODO_REAL_ENDPOINT` → 真实 HA REST API（控制：POST /api/services）
7. 在 `02` 增加"状态查询"分支（GET /api/states/{entity_id}）
8. `03` 绑定真实知识库，上传小米设备手册等文档（同时覆盖条款 32/33/34）
9. `04` 接真实数据源：HA history API 或 InfluxDB 查询（Code 节点执行 Python）
10. 跑 `05` 冒烟测试，截图 4 种接口的调用日志（▲14 验收证据）

### 第三步：开发 Web 管理平台（预计 1-2 周）

11. 技术选型：**Streamlit**（纯 Python，快速开发）或 **单文件 HTML + fetch**（轻量）
12. 页面一：设备控制台（实时状态卡片 + 控制按钮，调 HA REST API）
13. 页面二：AI 对话（iframe 嵌入 Dify WebApp，或直接调 Chatflow API）
14. 页面三：会话历史（调 `GET /v1/conversations` + `GET /v1/messages`）
15. 页面四：电子沙盘（SVG 平面图 + 设备状态叠加 + 点击控制，覆盖 ▲23）
16. 页面五：历史数据图表（调 HA history API，折线图展示传感器趋势）

### 第四步：收尾截图归档，完成验收包（预计 3-5 天）

17. 整理 ▲7 截图包（开源协议 + Dify 工作流编辑器 + 代码仓库）
18. 整理 ▲14 截图包（4 种接口调用日志 + 工具列表）
19. 整理 ▲23 截图包（电子沙盘界面 + 设备状态前后对比）
20. 补齐知识库操作截图（上传/解析/检索，条款 32/33/34）
21. HA Lovelace Dashboard 截图（条款 37）

---

## 8. 结论

- **MVP1 结论**：Dify 主从 Agent 架构已完成，高阶画布版本（v1.1）可运行，架构设计正确。
- **项目定位修正**：本项目是**真实落地**的智能家居大模型科研一体机，需对接小米真实硬件，不是纯演示项目。
- **核心路径**：HA 接小米 → Dify 接 HA → Web 平台统一管理，三层架构，职责清晰。
- **最大缺口**：▲14（4种真实接口）和 ▲23（电子沙盘），均在 Web 平台开发阶段一并覆盖。
- **知识库管理**：完全由 Dify 原生后台承担，不在 Web 平台重复建设。
