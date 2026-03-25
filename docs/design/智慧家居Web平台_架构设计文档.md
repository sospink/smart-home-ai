# 智慧家居 LLM 智能体一体机 · Web 管理平台架构设计

> 项目背景：江门定开合同，40 项技术要求，40 万交付
> 执行：全栈 + AI 工程师（独立开发）
> 文档日期：2026-03-18

---

## 一、为什么要自研 Web 平台

现有方案（Nginx 反代各组件原生 UI）能满足合同最低要求，但存在以下问题：

- **体验割裂**：Dify / HA / Grafana 各自一套 UI，没有统一感
- **无统一认证**：每个组件各自登录，无法做权限管理
- **开放 API 无统一出口**：调用方需分别学习 Dify API、HA API、Ollama API
- **开发文档分散**：无法提供一份完整的 API 参考文档
- **40 万交付标准**：原生 UI 拼凑不足以体现交付价值

自研 Web 平台的目标：**一个入口、一套认证、一份 API 文档、一致的用户体验**。

---

## 二、技术选型

### 前端：Next.js (React) + Tailwind CSS + shadcn/ui

| 选择理由 | 说明 |
|---------|------|
| Next.js = React 上层框架 | App Router、SSR、文件路由、API Routes 一体 |
| shadcn/ui | 管理后台组件现成，风格统一，不用从零写 |
| Tailwind CSS | 快速布局，不需要维护 CSS 文件 |
| 实时数据支持 | SSE / WebSocket 原生支持，适合设备状态实时推送 |
| recharts | 图表库，监控大屏数据可视化 |

### 后端：FastAPI (Python)

| 选择理由 | 说明 |
|---------|------|
| Python AI 生态天然契合 | Ollama / HA / InfluxDB 均有 Python SDK，无需自己封装 HTTP |
| 自动生成 OpenAPI 文档 | 访问 `/docs` 即为 Swagger UI，满足"开放 API 文档"交付要求 |
| 异步支持完善 | `async/await` 原生支持流式 AI 输出、WebSocket 推送 |
| 类型注解自动校验 | Pydantic 模型，接口稳定性高 |
| 学习曲线低 | React + Python 均已熟悉，不引入新语言 |

### 为什么不选其他

- **Hono / Elysia (Node.js)**：性能高，但调 Python AI 生态（Ollama SDK、LangChain）麻烦，增加开发量
- **NestJS**：模板多但偏重，AI 生态同样弱
- **Go (Gin/Fiber)**：性能极高，但瓶颈永远在 LLM 推理，不在 API 框架；且需自己实现所有 SDK 调用
- **Litestar**：FastAPI 精神继承者，类型系统更严格，但生态不如 FastAPI 成熟，内网服务意义不大

> **结论**：Next.js + FastAPI 是当前 AI 全栈项目的标准组合，不是将就，是真的没有更合适的。

---

## 三、整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    浏览器 / 客户端                         │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              Next.js 前端（统一 Web 平台）                  │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ AI 对话  │ │ 设备控制  │ │ 知识库   │ │ 监控大屏   │  │
│  │  页面    │ │  页面     │ │ 管理页面  │ │   页面     │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────┘  │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │           嵌入模块（部分功能 iframe 集成）              │ │
│  │    HA Lovelace  │  JupyterLab  │  Grafana  │ 沙盘    │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────┘
                       │ REST / SSE / WebSocket
┌──────────────────────▼──────────────────────────────────┐
│         FastAPI 后端（BFF - Backend For Frontend）         │
│                                                          │
│  /api/v1/chat        /api/v1/devices    /api/v1/knowledge│
│  /api/v1/models      /api/v1/system     /api/v1/sandbox  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │         统一认证（JWT）/ 鉴权 / 限流 / 操作日志       │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ ollama   │ │   dify   │ │    ha    │ │  influxdb  │  │
│  │ service  │ │ service  │ │ service  │ │  service   │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │ Docker 内网调用
┌──────────────────────▼──────────────────────────────────┐
│                   底层服务层（不变）                         │
│                                                          │
│  Ollama :11434  │  Dify :5001/:3000  │  HA :8123        │
│  InfluxDB :8086 │  PostgreSQL :5432  │  Redis :6379      │
│  Mosquitto :1883│  JupyterLab :8888  │  Grafana :3001    │
│  Streamlit :8501│  code-server :8443                     │
└─────────────────────────────────────────────────────────┘
```

---

## 四、数据流

### AI 对话流（流式输出）

```
用户输入（文字/语音）
    → Next.js 前端
    → FastAPI POST /api/v1/chat/completions
    → Ollama AsyncClient（SSE 流式）
    → StreamingResponse 实时返回
    → 前端逐字渲染
```

### 设备控制流

```
用户点击控制按钮
    → FastAPI POST /api/v1/devices/{entity_id}/control
    → HA REST API POST /api/services/{domain}/{service}
    → 虚拟设备 / 真实设备执行
    → HA 状态更新
    → WebSocket 推送回前端
    → 设备状态卡片实时刷新
```

### AI 指令控制设备流

```
用户自然语言输入（"把客厅灯关掉"）
    → FastAPI POST /api/v1/chat/agent
    → Dify API（Chatflow 意图识别）
    → Dify 调用 HA Tool Plugin
    → HA REST API 执行控制
    → 返回执行结果给用户
```

---

## 五、FastAPI 接口规范

> 这套接口结构对应合同 ▲14（四种接口调用），FastAPI 自动生成 Swagger 文档满足"开放 API 文档"交付要求。

```
/api/v1/
│
├── auth/
│   ├── POST   /login                    # 登录，返回 JWT Token
│   └── POST   /refresh                  # Token 刷新
│
├── chat/                                # ▲14 接口① 文本生成 / 对话
│   ├── POST   /completions              # 流式对话（透传 Ollama，SSE）
│   ├── POST   /agent                    # 调用 Dify Chatflow Agent
│   ├── GET    /sessions                 # 会话历史列表
│   ├── GET    /sessions/{id}            # 单条会话详情
│   └── DELETE /sessions/{id}            # 删除会话
│
├── devices/                             # ▲14 接口② 设备控制
│   ├── GET    /                         # 所有设备列表
│   ├── GET    /{entity_id}              # 单设备实时状态
│   ├── POST   /{entity_id}/control      # 控制设备（开关 / 调节）
│   ├── GET    /{entity_id}/history      # 设备历史数据（InfluxDB）
│   └── WS     /stream                  # WebSocket 实时状态推送
│
├── states/                              # ▲14 接口③ 状态查询
│   ├── GET    /realtime                 # 所有设备实时状态快照
│   ├── GET    /sensors                  # 传感器数据列表
│   └── GET    /summary                  # 系统状态汇总（用于监控大屏）
│
├── knowledge/                           # ▲14 接口④ 知识库检索
│   ├── GET    /datasets                 # 知识库列表
│   ├── POST   /datasets                 # 创建知识库
│   ├── DELETE /datasets/{id}            # 删除知识库
│   ├── POST   /datasets/{id}/retrieve   # 语义检索（hybrid_search）
│   ├── POST   /datasets/{id}/documents  # 上传文档
│   └── DELETE /datasets/{id}/documents/{doc_id}  # 删除文档
│
├── models/                              # 模型管理
│   ├── GET    /                         # 已安装模型列表
│   ├── POST   /pull                     # 拉取新模型
│   ├── DELETE /{name}                   # 删除模型
│   └── GET    /status                   # 当前推理状态（显存占用等）
│
├── sandbox/                             # 电子沙盘（▲23）
│   ├── GET    /devices                  # 虚拟设备列表与状态
│   ├── POST   /devices/{id}/control     # 控制虚拟设备
│   └── GET    /scenes                   # 预设场景列表
│
└── system/                              # 系统状态
    ├── GET    /health                   # 健康检查（各子服务 ping）
    ├── GET    /metrics                  # CPU / GPU / 内存 / 磁盘
    └── GET    /services                 # 各容器服务运行状态
```

---

## 六、前端页面规划

| 页面 | 路由 | 对应合同条款 | 核心功能 |
|------|------|------------|---------|
| AI 对话 | `/chat` | 36 | 流式对话、语音输入、历史记录、模型切换 |
| 设备控制 | `/devices` | 37 | 设备状态卡片、实时刷新、点击控制 |
| 电子沙盘 | `/sandbox` | 38、▲23 | 虚拟平面图、实时状态、AI 指令控制 |
| 监控大屏 | `/monitor` | 39 | GPU/CPU/内存、各服务状态、使用统计图表 |
| 知识库管理 | `/knowledge` | 8、31~34 | 上传文档、查看索引、检索测试 |
| 智能体管理 | `/agents` | 8、13~18 | 嵌入 Dify UI 或展示已配置 Agent 列表 |
| 模型管理 | `/models` | 8、11 | 已安装模型、切换当前使用模型、拉取新模型 |
| 系统设置 | `/settings` | - | 各服务连接配置、Token 管理 |
| 帮助文档 | `/docs` | 40 | 嵌入 MkDocs 站或内置教程页 |

---

## 七、工程目录结构

```
smart-home-web/
├── frontend/                        # Next.js 前端
│   ├── app/
│   │   ├── (auth)/
│   │   │   └── login/               # 登录页
│   │   └── (dashboard)/
│   │       ├── layout.tsx           # 侧边栏 + 顶栏布局
│   │       ├── chat/                # AI 对话页
│   │       ├── devices/             # 设备控制页
│   │       ├── sandbox/             # 电子沙盘页
│   │       ├── monitor/             # 监控大屏
│   │       ├── knowledge/           # 知识库管理
│   │       ├── agents/              # 智能体管理
│   │       ├── models/              # 模型管理
│   │       ├── settings/            # 系统设置
│   │       └── docs/                # 帮助文档
│   ├── components/
│   │   ├── ui/                      # shadcn/ui 基础组件
│   │   ├── chat/                    # ChatMessage、ChatInput、VoiceInput
│   │   ├── devices/                 # DeviceCard、DeviceControl
│   │   ├── charts/                  # 监控图表（recharts）
│   │   └── layout/                  # Sidebar、Header、Breadcrumb
│   ├── lib/
│   │   ├── api.ts                   # API 请求封装（fetch / axios）
│   │   ├── websocket.ts             # WebSocket 连接管理
│   │   └── auth.ts                  # JWT Token 管理
│   ├── .env.local
│   └── Dockerfile
│
├── backend/                         # FastAPI 后端
│   ├── app/
│   │   ├── main.py                  # 入口，注册路由、CORS、中间件
│   │   ├── core/
│   │   │   ├── config.py            # 环境变量配置（pydantic-settings）
│   │   │   ├── auth.py              # JWT 认证
│   │   │   └── logger.py            # 统一日志
│   │   ├── api/
│   │   │   └── v1/
│   │   │       ├── chat.py          # 对话接口
│   │   │       ├── devices.py       # 设备控制接口
│   │   │       ├── states.py        # 状态查询接口
│   │   │       ├── knowledge.py     # 知识库接口
│   │   │       ├── models.py        # 模型管理接口
│   │   │       ├── sandbox.py       # 电子沙盘接口
│   │   │       └── system.py        # 系统状态接口
│   │   ├── services/                # 各子服务调用封装
│   │   │   ├── ollama.py            # Ollama AsyncClient 封装
│   │   │   ├── dify.py              # Dify API 封装（httpx）
│   │   │   ├── homeassistant.py     # HA REST API + WebSocket 封装
│   │   │   └── influxdb.py          # InfluxDB 时序查询封装
│   │   └── models/                  # Pydantic 数据模型（请求/响应结构）
│   │       ├── chat.py
│   │       ├── device.py
│   │       └── knowledge.py
│   ├── tests/
│   ├── requirements.txt
│   └── Dockerfile
│
└── docker-compose.override.yml      # 加入现有 docker-compose 编排
```

---

## 八、数据库设计（Web 平台自用）

Web 平台需要一个独立的轻量数据库，存储平台自身的业务数据（不与 Dify 的 PG 混用）。

**推荐方案：复用现有 PostgreSQL 实例，新建 `webapp` schema**，避免多开一个容器。

| 表名 | 用途 |
|------|------|
| `users` | 用户账号、密码 hash、角色 |
| `chat_sessions` | 对话会话记录（session_id、标题、创建时间） |
| `chat_messages` | 对话消息记录（session 关联、role、content、时间） |
| `operation_logs` | 操作日志（用户、操作类型、目标、时间、结果） |
| `system_config` | 系统配置 KV 表（各服务连接地址、Token 等） |

---

## 九、接口分工说明（Next.js API Routes vs FastAPI）

并非所有接口都要经过 FastAPI，简单的透传可以直接在 Next.js Route Handler 里做：

| 接口类型 | 处理位置 | 理由 |
|---------|---------|------|
| 对话流式输出 | FastAPI | 需要 Python SDK，处理 SSE 流 |
| 设备控制 / 状态查询 | FastAPI | 需要鉴权 + 日志记录 + 统一格式化 |
| 知识库 CRUD | FastAPI | 需要鉴权 + 操作日志 |
| 模型管理 | FastAPI | 需要 Ollama Python SDK |
| WebSocket 推送 | FastAPI | 需要订阅 HA WebSocket，聚合后转发 |
| 静态配置读取 | Next.js Route Handler | 简单，不涉及 Python 生态 |
| 页面级 BFF 数据聚合 | Next.js Route Handler | 首屏数据聚合，减少前端请求数 |

---

## 十、部署方式

在现有 `docker-compose.yml` 基础上追加两个服务：

```yaml
# docker-compose.override.yml
services:

  web-frontend:
    build: ./smart-home-web/frontend
    ports:
      - "3100:3000"
    environment:
      - NEXT_PUBLIC_API_URL=http://web-backend:8000
    depends_on:
      - web-backend

  web-backend:
    build: ./smart-home-web/backend
    ports:
      - "8000:8000"
    environment:
      - OLLAMA_URL=http://ollama:11434
      - DIFY_URL=http://dify-api:5001
      - HA_URL=http://homeassistant:8123
      - HA_TOKEN=${HA_LONG_LIVED_TOKEN}
      - INFLUXDB_URL=http://influxdb:8086
      - DATABASE_URL=postgresql://postgres:${PG_PASSWORD}@postgres:5432/webapp
    depends_on:
      - ollama
      - dify-api
      - homeassistant
      - influxdb
      - postgres
```

Nginx 新增路由：

```nginx
# 自研 Web 平台（主入口，优先级最高）
location / {
    proxy_pass http://web-frontend:3000;
}

# FastAPI 对外 API
location /api/ {
    proxy_pass http://web-backend:8000;
}

# Swagger 文档
location /api/docs {
    proxy_pass http://web-backend:8000/docs;
}
```

---

## 十一、合同 40 条全量覆盖验证

> 说明：
> - ✅ **Web平台直接实现**：由自研 Next.js + FastAPI 平台实现
> - 🔧 **底层服务支撑**：由 Ollama / Dify / HA 等底层服务提供能力，Web 平台通过接口调用呈现
> - ▲ **合同强制截图项**：必须在对应阶段完成截图留证

### 硬件规格（条款 1~4）

| 条款 | 要求 | 实现方式 | 状态 |
|------|------|---------|------|
| 1 | CPU ≥ 16核24线程 | 硬件采购要求 | 🔧 硬件层 |
| 2 | 内存 ≥ 32G | 硬件采购要求 | 🔧 硬件层 |
| 3 | 固态硬盘 ≥ 512G | 硬件采购要求 | 🔧 硬件层 |
| 4 | 显存 ≥ 16G；计算单元 ≥ 4608；位宽 ≥ 128bit | 硬件采购要求（RTX 4080/4090） | 🔧 硬件层 |

### 系统基础能力（条款 5~8）

| 条款 | 要求 | 实现方式 | 状态 |
|------|------|---------|------|
| 5 | 支持至少 6 项功能模块 | Ollama + Dify + HA + Jupyter + 知识库 + Web平台 = 6项 ✓ | 🔧 底层服务 |
| 6 | 离线运行 3 项核心功能（推理/智能体/知识库检索） | 全部 Docker 本地部署，无外网依赖 | 🔧 底层服务 |
| ▲7 | 合规开源 + 支持二次开发（投标截图） | Ollama(MIT) + Dify(Apache2.0) + HA(Apache2.0)；Python SDK脚手架 | ▲ Phase 2 截图 |
| 8 | 统一 Web 管理界面，支持 ≥4 项功能 | ✅ 自研平台：对话 + 模型状态 + 设备状态 + 知识库管理，全覆盖 | ✅ Web平台 |

### 大语言模型服务（条款 9~12）

| 条款 | 要求 | 实现方式 | 状态 |
|------|------|---------|------|
| 9 | 本地部署 6B~10B 级别开源大模型 | Ollama 运行 Qwen2.5-7B-Instruct（q4_K_M量化）| 🔧 Ollama |
| 10 | 单卡GPU运行 + 量化推理模式 | INT4/INT8 量化，16G显存可运行 | 🔧 Ollama |
| 11 | 同时部署 ≥1 个本地模型 + **Web界面切换模型** | ✅ `/models` 页面展示已安装模型列表 + 切换当前模型 | ✅ Web平台 |
| 12 | 统一本地模型调用接口，支持文本生成 + 多轮对话 | ✅ `POST /api/v1/chat/completions`（文本生成）+ `POST /api/v1/chat/agent`（多轮对话） | ✅ Web平台 |

### 智能体框架（条款 13~18）

| 条款 | 要求 | 实现方式 | 状态 |
|------|------|---------|------|
| 13 | 集成可本地部署的智能体运行管理框架 | Dify CE（Docker本地部署），创建/配置/运行Agent | 🔧 Dify |
| ▲14 | 支持 ≥4 种接口调用（设备控制/数据查询/知识库检索/文件系统） | ✅ FastAPI 接口：①`/chat` ②`/devices/control` ③`/states` ④`/knowledge/retrieve` | ✅ Web平台 ▲截图 |
| 15 | 基于上下文的多轮对话 | ✅ `chat_sessions` + `chat_messages` 表持久化，`/chat/sessions/{id}` 历史接口 | ✅ Web平台 |
| 16 | 会话与运行记录存储管理，支持历史查询/调试/效果评估 | ✅ `/chat` 页面历史列表 + 单条会话详情；`operation_logs` 表记录运行记录 | ✅ Web平台 |
| 17 | 基于流程或规则的任务执行机制 | Dify Workflow 节点编排（条件分支 + 子Workflow路由） | 🔧 Dify |
| 18 | 部署多个智能体实例 + 统一平台管理调用 | ✅ `/agents` 页面展示已配置Agent列表；Dify多App实例 | ✅ Web平台 |

### 智慧家居对接（条款 19~24）

| 条款 | 要求 | 实现方式 | 状态 |
|------|------|---------|------|
| 19 | 对接主流智能家居系统，支持设备数据接入与控制 | Home Assistant Container + REST API + MQTT | 🔧 HA |
| 20 | 对接智能家居平台，获取设备状态/传感器数据/场景信息 | ✅ `GET /api/v1/devices`（设备列表）、`GET /api/v1/states/sensors`（传感器）、`GET /api/v1/states/summary`（场景） | ✅ Web平台 |
| 21 | 统一设备数据访问接口，支持实时状态/历史数据/设备运行信息 | ✅ `GET /api/v1/devices/{id}`（实时）、`GET /api/v1/devices/{id}/history`（历史，InfluxDB）、`GET /api/v1/states/realtime`（运行信息） | ✅ Web平台 |
| 22 | 统一设备控制接口，发送控制请求并获取执行结果 | ✅ `POST /api/v1/devices/{entity_id}/control` → HA REST API → 返回执行结果 | ✅ Web平台 |
| ▲23 | 对接虚拟设备/电子沙盘，获取虚拟设备状态/传感器/场景（投标截图） | ✅ `/sandbox` 页面；`GET /api/v1/sandbox/devices`（状态）；HA Template虚拟实体 + MQTT仿真器 | ✅ Web平台 ▲截图 |
| 24 | 向虚拟设备/电子沙盘发送控制请求，实现交互控制 | ✅ `POST /api/v1/sandbox/devices/{id}/control` → HA虚拟实体控制 | ✅ Web平台 |

### 应用模板库（条款 25~30）

| 条款 | 要求 | 实现方式 | 状态 |
|------|------|---------|------|
| 25 | 智能体应用模板库，支持搭建/测试 | Dify 5个预置工作流模板（智能家居助手/知识库问答/设备播报/场景自动化/数据分析） | 🔧 Dify模板 |
| 26 | 开发脚手架/基础模板，支持功能扩展与二次开发 | Python SDK（`smart-home-web/sdk/`）+ Jupyter Notebook示例集 | 🔧 SDK |
| 27 | 模板说明文档（功能说明/使用方法/配置方式/定制指南） | MkDocs文档站（`/docs` 页面嵌入），≥4项说明全覆盖 | ✅ Web平台 `/docs` |
| 28 | 基础开发环境，支持代码编辑/基本调试 | code-server（浏览器VS Code），Nginx `/code` 路由 | 🔧 code-server |
| 29 | 交互式开发环境（Jupyter Notebook），支持数据分析/模型调试 | JupyterLab，Nginx `/jupyter` 路由；预置5+示例Notebook | 🔧 JupyterLab |
| 30 | Prompt 编辑与管理，支持配置/测试交互效果 | ✅ Dify Prompt编辑器（嵌入`/agents`页面）；`/settings` 可配置全局System Prompt | ✅ Web平台 |

### 知识库与 RAG（条款 31~35）

| 条款 | 要求 | 实现方式 | 状态 |
|------|------|---------|------|
| 31 | 知识库管理与文档接入，支持导入/存储/组织 | ✅ `/knowledge` 页面：上传文档（PDF/Word/TXT/MD/HTML/CSV）、知识库列表、文档组织 | ✅ Web平台 |
| 32 | 集成向量数据库或语义检索组件，支持查询/检索 | ✅ `POST /api/v1/knowledge/{id}/retrieve`（语义检索）；Dify内置Weaviate向量库 | ✅ Web平台 |
| 33 | 多种文本解析和嵌入方式，支持不同格式文档处理/知识向量化 | Dify自动分块 + BGE-M3 Embedding（本地Ollama），多格式解析 | 🔧 Dify + Ollama |
| 34 | 知识库增量更新与管理，支持动态添加/修改/删除 | ✅ `POST/DELETE /api/v1/knowledge/{id}/documents`；`/knowledge` 页面CRUD操作 | ✅ Web平台 |
| 35 | 语义检索，支持相关内容匹配/知识调用 | ✅ `POST /api/v1/knowledge/{id}/retrieve`，hybrid_search模式（语义+关键词） | ✅ Web平台 |

### Web 管理界面（条款 36~40）

| 条款 | 要求 | 实现方式 | 状态 |
|------|------|---------|------|
| 36 | 智能体交互界面，支持文本输入/历史查看/**语音输入** | ✅ `/chat` 页面：流式文本输入 + VoiceInput语音组件 + 会话历史侧栏 | ✅ Web平台 |
| 37 | 智能家居和设备状态可视化，支持查看设备状态/系统运行 | ✅ `/devices` 页面：DeviceCard组件 + WebSocket实时刷新 + 系统运行状态 | ✅ Web平台 |
| 38 | 嵌入虚拟设备/电子沙盘界面，展示智能体与虚拟环境交互 | ✅ `/sandbox` 页面：虚拟平面图 + 实时设备状态 + AI自然语言控制入口 | ✅ Web平台 |
| 39 | 数据可视化和监控界面，展示系统运行状况/使用情况/统计信息 | ✅ `/monitor` 页面：GPU/CPU/内存图表（recharts）+ 各服务状态 + 对话量统计 | ✅ Web平台 |
| 40 | 帮助文档和教程，支持功能说明/操作指南/常见问题 | ✅ `/docs` 页面：嵌入MkDocs站，含功能说明/操作指南/FAQ/API参考，≥3项全覆盖 | ✅ Web平台 |

---

### 覆盖率汇总

| 分类 | 条款数 | Web平台直接实现 | 底层服务支撑 | ▲强制截图项 |
|------|--------|--------------|------------|-----------|
| 硬件规格（1~4） | 4 | 0 | 4 | 0 |
| 系统基础（5~8） | 4 | 1 | 2 | ▲7 |
| LLM服务（9~12） | 4 | 2 | 2 | 0 |
| 智能体（13~18） | 6 | 4 | 2 | ▲14 |
| 智慧家居（19~24） | 6 | 5 | 1 | ▲23 |
| 应用模板（25~30） | 6 | 2 | 4 | 0 |
| 知识库（31~35） | 5 | 4 | 1 | 0 |
| Web界面（36~40） | 5 | 5 | 0 | 0 |
| **合计** | **40** | **23** | **16** | **3项▲全覆盖** |

> ✅ **40 条合同条款全部覆盖，无遗漏。**
> Web 平台直接承担 23 条的实现主体，底层服务（Ollama/Dify/HA）支撑剩余 16 条（硬件 4 条不在软件范围内）。
> 三项 ▲ 强制截图项（▲7/▲14/▲23）均有明确实现路径。

---

*文档版本：v1.1 · 2026-03-18*
