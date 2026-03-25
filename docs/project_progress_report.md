# 基于智慧家居场景的大语言模型智能体科研应用平台

## 开发进度总览 · 2026-03-19

> 📅 最后更新：2026-03-19 22:59
> 📊 总体完成度：**约 35%**

---

## 一、合同功能模块 vs 实现状态

### 📌 用户端功能

| # | 功能模块 | 路由 | 前端 UI | 后端 API | 前后端联调 | 完成度 |
|---|---------|------|:-------:|:-------:|:---------:|:------:|
| 1 | **首页 / Landing** | `/home` | ✅ 完成 | N/A | N/A | **100%** |
| 2 | **AI 对话** | `/chat` | ⚠️ 静态 UI | ❌ 仅 health | ❌ | **15%** |
| 3 | **设备控制** | `/devices` | ⚠️ Mock 数据 | ❌ 仅 health | ❌ | **15%** |
| 4 | **电子沙盘** | `/sandbox` | ⚠️ 占位页 | ❌ 仅 health | ❌ | **10%** |
| 5 | **监控大屏** | `/monitor` | ⚠️ Mock 数据 | ❌ 仅 health | ❌ | **15%** |
| 6 | **用户登录/注册** | `/` (Dialog) | ✅ 完成 | ✅ 完成 | ✅ 联调 | **100%** |

### 📌 管理端功能

| # | 功能模块 | 路由 | 前端 UI | 后端 API | 前后端联调 | 完成度 |
|---|---------|------|:-------:|:-------:|:---------:|:------:|
| 1 | **仪表盘** | `/admin` | ✅ 完成 | ✅ 完成 | ✅ 联调 | **100%** |
| 2 | **知识库管理** | `/admin/knowledge` | ⚠️ 静态 UI | ❌ 仅 health | ❌ | **15%** |
| 3 | **模型管理** | `/admin/models` | ⚠️ 静态 UI | ❌ 仅 health | ❌ | **15%** |
| 4 | **智能体管理** | `/admin/agents` | ⚠️ 静态 UI | ❌ 无路由 | ❌ | **10%** |
| 5 | **用户管理** | `/admin/users` | ✅ 完成 | ✅ 完成 | ✅ 联调 | **100%** |
| 6 | **系统设置** | `/admin/settings` | ✅ 完成 | ✅ 完成 | ✅ 联调 | **100%** |
| 7 | **API 文档** | `/admin/docs` | ✅ 完成 | N/A (嵌入 Swagger) | ✅ | **100%** |

### 📌 基础设施

| 组件 | 状态 | 说明 |
|------|:----:|------|
| FastAPI 后端框架 | ✅ | 路由注册、中间件、CORS |
| MySQL 数据库 | ✅ | User 表 + SystemConfig 表 |
| JWT 认证系统 | ✅ | 登录/注册/Token 刷新 |
| Next.js 前端框架 | ✅ | App Router + Tailwind + shadcn/ui |
| 管理后台 Layout | ✅ | 可折叠侧边栏 + 深色模式 |
| 用户端 Layout | ✅ | 导航栏 + 页面布局 |
| i18n 国际化 | ✅ | 中/英文切换 |
| 全局通知组件 | ✅ | Toast 通知系统 |
| Ollama 服务封装 | ⚠️ | Service 类已有，API 路由未实现 |
| Dify 服务封装 | ⚠️ | Service 类已有，API 路由未实现 |
| HA 服务封装 | ⚠️ | Service 类已有，API 路由未实现 |
| InfluxDB 服务封装 | ⚠️ | Service 类已有，API 路由未实现 |

---

## 二、合同核心功能交付状态

基于合同名称「基于智慧家居场景的大语言模型智能体科研应用平台」，核心功能包括：

| 合同核心功能 | 对应模块 | 交付状态 | 优先级 |
|-------------|---------|:--------:|:------:|
| **大语言模型对话** | `/chat` + Ollama | ❌ 未实现 | 🔴 P0 |
| **智能体编排 (RAG)** | `/admin/agents` + Dify | ❌ 未实现 | 🔴 P0 |
| **知识库管理** | `/admin/knowledge` + Dify | ❌ 未实现 | 🔴 P0 |
| **模型管理** | `/admin/models` + Ollama | ❌ 未实现 | 🟡 P1 |
| **设备控制** | `/devices` + HA | ❌ 未实现 | 🟡 P1 |
| **电子沙盘** | `/sandbox` | ❌ 未实现 | 🟡 P1 |
| **监控大屏** | `/monitor` + InfluxDB | ❌ 未实现 | 🟢 P2 |
| 用户认证 | 登录/注册/JWT | ✅ 已交付 | — |
| 用户管理 | `/admin/users` | ✅ 已交付 | — |
| 系统设置 | `/admin/settings` | ✅ 已交付 | — |
| 仪表盘 | `/admin` | ✅ 已交付 | — |
| 平台首页 | `/home` | ✅ 已交付 | — |

---

## 三、推荐开发顺序

按依赖关系 + 合同优先级排序：

```
Phase 1 (核心功能 - P0)
  ① 模型管理    /admin/models     ← 最独立，仅代理 Ollama，无 DB
  ② 知识库管理  /admin/knowledge  ← 代理 Dify Knowledge API
  ③ 智能体管理  /admin/agents     ← 需新建 MySQL 表，依赖 ①②
  ④ AI 对话     /chat             ← 依赖 ③，用户端核心功能

Phase 2 (设备功能 - P1)
  ⑤ 设备控制    /devices          ← 代理 HA API
  ⑥ 电子沙盘    /sandbox          ← 依赖 ⑤

Phase 3 (数据展示 - P2)
  ⑦ 监控大屏    /monitor          ← 依赖 InfluxDB 时序数据
```

---

## 四、后端路由实现详情

| 路由文件 | 代码行数 | 功能端点数 | TODO 数 | 状态 |
|---------|:-------:|:---------:|:------:|:----:|
| `system.py` | 277 | 6 | 0 | ✅ 完整 |
| `auth.py` | 127 | 4 | 0 | ✅ 完整 |
| `users.py` | 187 | 6 | 0 | ✅ 完整 |
| `chat.py` | 21 | 1 (health) | 5 | ❌ 骨架 |
| `devices.py` | 20 | 1 (health) | 5 | ❌ 骨架 |
| `knowledge.py` | 20 | 1 (health) | 6 | ❌ 骨架 |
| `models_router.py` | 18 | 1 (health) | 4 | ❌ 骨架 |
| `sandbox.py` | 18 | 1 (health) | 3 | ❌ 骨架 |
| `states.py` | 18 | 1 (health) | 3 | ❌ 骨架 |

---

## 五、已有外部服务封装

| 服务 | 文件 | 已有方法 | 状态 |
|------|------|---------|:----:|
| Ollama | `services/ollama.py` | `list_models()`, `chat_stream()`, `generate()`, `check_status()` | ⚠️ 未被路由调用 |
| Dify | `services/dify.py` | `chat()`, `run_workflow()` | ⚠️ 未被路由调用 |
| HA | `services/homeassistant.py` | `get_states()`, `call_service()`, `check_health()` | ⚠️ 仅 dashboard 调用 |
| InfluxDB | `services/influxdb.py` | `query()`, `write()` | ⚠️ 未被路由调用 |

> 好消息：所有外部服务的封装类已准备好，实现路由时直接调用即可。
