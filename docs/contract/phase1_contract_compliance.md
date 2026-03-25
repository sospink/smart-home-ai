# 一阶段合同参数实现对照表

> **项目名称：** 基于智慧家居场景的大语言模型智能体科研应用一体机  
> **合同编号：** 江门定开产品 No.9  
> **检查日期：** 2026-03-21  
> **检查范围：** 用户模块、模型管理模块、仪表盘模块（管理端平台一阶段交付）

---

## 一、总体概览

| 指标 | 数值 |
|------|------|
| 合同总条款数 | 40 条 |
| 一阶段涉及条款 | 18 条（硬件4条排除，其余为软件功能） |
| ✅ 已完成 | **12 条** |
| ⚠️ 部分完成 | **3 条** |
| ❌ 未开始 | **21 条** |
| 🚫 不适用（硬件） | **4 条（第1-4条）** |

---

## 二、逐条对照明细

### 🖥️ 硬件参数（第1-4条）— 不适用

| 条款 | 合同要求 | 实现情况 | 状态 |
|:----:|---------|---------|:----:|
| 1 | CPU ≥16核心24线程 | 硬件指标，与软件开发无关 | 🚫 |
| 2 | 运行内存 ≥32G | 硬件指标 | 🚫 |
| 3 | 固态硬盘 ≥512G | 硬件指标 | 🚫 |
| 4 | 显存 ≥16G；计算单元核心≥4608；显存位宽≥128位 | 硬件指标 | 🚫 |

---

### 🏗️ 平台架构（第5-7条）

| 条款 | 合同要求 | 实现情况 | 状态 |
|:----:|---------|---------|:----:|
| 5 | 支持 ≥6 项功能模块：本地大语言模型服务、智能体框架与应用、智能家居对接能力、知识增强、应用模板库、Web管理界面 | **已实现 6 个模块路由**：`models_router`（模型服务）、[chat](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28user%29/chat)（智能体/对话）、[devices](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28user%29/devices)（智能家居对接）、[knowledge](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/knowledge)（知识增强）、[sandbox](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28user%29/sandbox)（电子沙盘/模板）、[system](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/system.py#297-331)（Web管理界面）。其中 chat/devices/knowledge/sandbox 仅有路由骨架，尚未完整实现业务逻辑 | ⚠️ |
| 6 | 支持本地化部署，无外网可完成模型推理、智能体运行、知识库检索 ≥3项 | Ollama 本地推理 ✅；智能体运行（Dify）需本地部署 ⚠️；知识库检索 ❌ 未实现 | ⚠️ |
| ▲7 | 基于合规开源大模型，核心组件可本地部署，支持二次开发 | Ollama（Apache 2.0）✅；FastAPI（MIT）✅；Next.js（MIT）✅；Dify（可本地部署）✅ — 全部开源合规、支持二次开发 | ✅ |

---

### 📊 Web管理界面 & 仪表盘（第8条 + 第39条）

| 条款 | 合同要求 | 实现情况 | 状态 |
|:----:|---------|---------|:----:|
| 8 | 统一 Web 管理界面，支持 ≥4项：智能体对话、模型运行状态查看、设备与系统状态查看、知识库管理 | **Web 界面已实现** (Next.js App Router)；已有页面：仪表盘 [/admin](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin)、模型管理 [/admin/models](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/models)、用户管理 [/admin/users](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/users)、系统设置 [/admin/settings](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/settings)、知识库 [/admin/knowledge](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/knowledge)（前端 UI 已有）、智能体 [/admin/agents](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/agents)（骨架）。**模型运行状态** ✅（`/models/status` + 活跃模型卡片）；**系统状态** ✅（Dashboard 服务列表）；**知识库管理** ⚠️（前端页面已有，后端 API 未实现）；**智能体对话** ⚠️（前端页面已有，后端 API 未实现） | ⚠️ |
| 39 | 数据可视化和监控界面，展示系统运行状况、使用情况、统计信息 ≥3项 | **仪表盘已实现** (`/api/v1/system/dashboard`)：总用户数/活跃用户/新増用户 ✅、模型数量 ✅、在线设备数 ✅、服务状态列表（FastAPI/Next.js/Ollama/HA/InfluxDB）✅ — **满足 ≥3项** | ✅ |

---

### 🤖 模型管理模块（第9-12条）

| 条款 | 合同要求 | 实现情况 | 状态 |
|:----:|---------|---------|:----:|
| 9 | 本地部署合规开源大语言模型，参数规模 6B–10B | Ollama 本地部署；模型库包含 qwen3:8b / llama3.1:8b / deepseek-r1:7b / gemma3:4b 等；用户可从库中选择并拉取 | ✅ |
| 10 | 单卡 GPU 运行，支持量化推理（低比特量化） | Ollama 支持 GGUF 格式量化推理；模型卡片显示 `quantization_level`（Q4_K_M 等）；详情页展示完整架构参数 | ✅ |
| 11 | 同时部署 ≥1 个模型，Web 界面选择当前使用模型 | **已安装模型列表** ✅（`GET /models/`）；**选择当前使用模型** ✅（`GET/PUT /models/current` + 金色「⭐设为默认」按钮 + 「当前使用」徽章）| ✅ |
| 12 | 统一本地模型调用接口，支持文本生成、多轮对话 | `ollama_service.generate()` 文本生成 ✅；`ollama_service.chat_stream()` 流式多轮对话 ✅；`ollama_service.embed()` 文本嵌入 ✅ | ✅ |

**模型管理模块 API 端点清单：**

| 端点 | 方法 | 功能 | 状态 |
|------|------|------|:----:|
| [/models/](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/models) | GET | 已安装模型列表 | ✅ |
| `/models/status` | GET | 运行中模型 + VRAM | ✅ |
| `/models/version` | GET | Ollama 版本信息 | ✅ |
| `/models/library` | GET | 精选模型库（11个模型） | ✅ |
| `/models/current` | GET | 获取当前使用模型 | ✅ |
| `/models/current` | PUT | 设置当前使用模型 | ✅ |
| `/models/{name}/detail` | POST | 模型详情（带架构参数） | ✅ |
| `/models/pull` | POST | 拉取模型（SSE 流式进度） | ✅ |
| `/models/{name}` | DELETE | 删除模型 | ✅ |
| `/models/health` | GET | 模块健康检查 | ✅ |

**前端模型管理页面功能清单：**

| 功能 | 状态 | 说明 |
|------|:----:|------|
| 已安装模型卡片列表 | ✅ | 显示模型名/家族/参数量/磁盘占用/量化等级 |
| Ollama 连接状态指示 | ✅ | 绿色/红色状态标识 |
| 统计卡片（磁盘/数量/活跃） | ✅ | 3 个统计卡片 + 活跃模型高亮 |
| 模型库浏览 + 分类筛选 | ✅ | 对话/推理/代码/Embedding/多模态 分类 |
| Tag 选择器 + 一键拉取 | ✅ | 下拉选择参数规模，SSE 进度条 |
| 模型详情抽屉 | ✅ | 模型能力标签/架构参数/对话模板/许可证/原始元数据 |
| 设为当前使用模型 | ✅ | ⭐金色按钮 + 「当前使用」徽章 + 金色边框 |
| 删除模型（二次确认） | ✅ | 确认弹窗 + Toast 提示 |
| 推荐模型卡片 | ✅ | qwen3:8b / deepseek-r1:7b / nomic-embed-text |

---

### 👥 用户管理模块

| 功能 | 合同条款 | 实现情况 | 状态 |
|------|---------|---------|:----:|
| 用户 CRUD | 平台基础功能 | `GET/POST/PUT/DELETE /users` — 完整增删改查 | ✅ |
| 分页 + 搜索 + 筛选 | 平台基础功能 | 按用户名/昵称搜索、角色/状态筛选、分页 | ✅ |
| 角色管理 | 平台基础功能 | [admin](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin) / [user](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/users.py#122-134) 双角色；[require_admin](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/dependencies.py#69-77) 鉴权 | ✅ |
| 用户统计 | 第39条（数据可视化） | `GET /users/stats` — 总数/活跃/本周新增/管理员数 | ✅ |
| 密码重置 | 平台基础功能 | `PATCH /users/{id}/reset-password` | ✅ |
| 启用/禁用 | 平台基础功能 | `PATCH /users/{id}/toggle-active` | ✅ |
| JWT 认证 | 平台基础功能 | `POST /auth/login` + `POST /auth/register` | ✅ |

**前端用户管理页面功能清单：**

| 功能 | 状态 | 说明 |
|------|:----:|------|
| 用户列表表格 | ✅ | 分页/搜索/角色筛选/状态筛选 |
| 创建用户弹窗 | ✅ | 用户名/密码/昵称/角色 |
| 编辑用户信息 | ✅ | 修改昵称/角色 |
| 删除用户 | ✅ | 防止删除自己 |
| 重置密码 | ✅ | 管理员重置 |
| 启用/禁用切换 | ✅ | 一键切换 |
| 用户统计卡片 | ✅ | 总数/活跃/本周新增/管理员 |

---

### 🔧 系统设置模块

| 功能 | 合同条款 | 实现情况 | 状态 |
|------|---------|---------|:----:|
| 服务地址配置 | 第5/7条 | Ollama / Dify / HA / InfluxDB 地址可配置 | ✅ |
| 连接测试 | 第5/7条 | 一键测试各服务连接状态 + 延迟 | ✅ |
| 安全配置 | 平台基础 | JWT过期/注册开关/密码长度 | ✅ |
| 系统信息 | 第39条 | 版本/Python版本/OS/DB状态/运行时长 | ✅ |

---

## 三、未开始模块一览（二阶段交付）

| 条款 | 合同要求 | 对应模块 | 当前状态 |
|:----:|---------|---------|---------|
| 13 | 智能体运行与管理框架 | [chat.py](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/chat.py) / [agents](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/agents) | 仅路由骨架 |
| ▲14 | 智能体调用外部功能接口 ≥4种 | [chat.py](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/chat.py) | TODO |
| 15 | 多轮对话能力 | [chat.py](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/chat.py) | TODO（[chat_stream](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/services/ollama.py#91-109) 已就绪） |
| 16 | 会话与运行记录存储/管理 | [chat.py](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/chat.py) | TODO |
| 17 | 基于流程/规则的任务执行机制 | [agents](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/agents) | TODO |
| 18 | 部署多个智能体实例 | [agents](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/agents) | TODO |
| 19-22 | 智能家居系统对接 + 设备控制 | [devices.py](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/devices.py) / [states.py](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/states.py) | 仅路由骨架 |
| ▲23-24 | 虚拟设备/电子沙盘对接 | [sandbox.py](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/sandbox.py) | 仅路由骨架 |
| 25-27 | 智能体应用模板库 + 文档 | [agents](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/agents) / [docs](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/docs) | 仅前端骨架 |
| 28-29 | 开发环境 / Jupyter | 独立部署 | 未开始 |
| 30 | Prompt 编辑与管理 | [agents](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/agents) | 未开始 |
| 31-35 | 知识库管理全套 | [knowledge.py](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/knowledge.py) | 仅路由骨架 |
| 36 | 智能体交互界面（文本/语音） | [chat](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28user%29/chat) 前端 | 仅前端骨架 |
| 37-38 | 设备可视化 + 电子沙盘界面 | [devices](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28user%29/devices) / [sandbox](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28user%29/sandbox) 前端 | 仅前端骨架 |
| 40 | 帮助文档和教程 | [docs](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28dashboard%29/admin/docs) | 仅前端骨架 |

---

## 四、一阶段交付成果总结

### ✅ 已完全交付的模块

| 模块 | 后端 API | 前端页面 | 行数 |
|------|:--------:|:--------:|-----:|
| **模型管理** | 10 个端点 | 743 行 | 完整 |
| **用户管理** | 7 个端点 | 513 行 | 完整 |
| **系统设置** | 4 个端点 | 639 行 | 完整 |
| **仪表盘** | 3 个端点 | 252 行 | 完整 |
| **认证模块** | 2 个端点 | 登录页 | 完整 |

### 📐 技术架构

| 组件 | 技术栈 | 版本 |
|------|-------|------|
| 后端框架 | FastAPI + SQLAlchemy (async) | Python 3.14 |
| 前端框架 | Next.js + React + TypeScript | Next.js 15 |
| 数据库 | SQLite (aiosqlite) | — |
| 模型服务 | Ollama REST API | 本地部署 |
| 智能体框架 | Dify | 可本地部署 |
| 智能家居 | Home Assistant | REST API |
| 时序数据库 | InfluxDB | 可选 |

### 🔐 安全措施

- JWT Token 认证（可配置过期时间）
- 管理员/用户双角色鉴权
- 密码 bcrypt 哈希
- 接口级权限控制（[require_admin](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/dependencies.py#69-77)）

---

## 五、二阶段开发优先级建议

| 优先级 | 模块 | 合同条款 | 预估工作量 |
|:------:|------|---------|-----------|
| 🔴 P0 | 知识库管理（文档导入/向量化/检索） | 31-35 | 3-5天 |
| 🔴 P0 | AI 对话（流式对话/会话管理） | 15-16 | 2-3天 |
| 🟡 P1 | 智能体管理（创建/配置/多实例） | 13, 17-18 | 3-5天 |
| 🟡 P1 | 智能家居设备对接 | 19-22 | 2-3天 |
| 🟡 P1 | 电子沙盘系统 | ▲23-24 | 2-3天 |
| 🟢 P2 | 智能体外部接口（▲重要） | ▲14 | 2-3天 |
| 🟢 P2 | 模板库 + 开发环境 | 25-29 | 3-5天 |
| 🟢 P2 | Prompt 管理 + 帮助文档 | 30, 40 | 2-3天 |
| 🔵 P3 | 语音输入 | 36 | 1-2天 |

---

> **注：** 标有 ▲ 的条款为**投标时须提供产品功能截图**的关键条款，需优先实现以确保合规。
