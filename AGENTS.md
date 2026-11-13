# AGENTS.md

## Scope
适用于当前目录及所有子目录。

## 项目定位
本项目是“智慧家居大语言模型智能体科研应用一体机”的前后端与交付资料仓库，核心目标是围绕合同参数完成统一后台、智能体运行与管理、Dify 工作流、Home Assistant 智能家居对接、Ollama 本地模型、知识库增强、API 参考和帮助文档演示。

## 快速上手
- 启动本地开发环境：`./start.sh -d`
- 查看服务状态：`./start.sh status`
- 重启服务：`./start.sh restart`
- 前端入口：`http://localhost:8088`
- 后端入口：`http://localhost:8000`
- 后端接口文档：`http://localhost:8000/api/docs`
- 后端日志：`.logs/backend.log`
- 前端日志：`.logs/frontend.log`

## 目录速读
- `smart-home-ai-frontend/`：Next.js 16 + React 前端，包含公共首页、文档中心和单后台页面。
- `smart-home-ai-backend/`：FastAPI 后端，包含认证、聊天、设备、沙盘、监控、模型、知识库、接口文档、智能体和系统设置接口。
- `dify/`：Dify DSL 模板、主 Chatflow、子 Workflow、知识库种子资料和模板说明。
- `docs/`：合同对照、技术设计、部署运维、API 规划等正式文档。
- `scripts/`：云端同步、部署和辅助脚本。
- `docker-service/`：可选容器服务资料。

## 关键页面
- `/home`：公共首页。
- `/docs`：帮助文档和教程，包含文档中心与 API 参考。
- `/dashboard`：后台系统运行状况入口。
- `/chat`：智能体对话。
- `/conversation-records`：会话与运行记录。
- `/devices`：设备控制。
- `/sandbox`：电子沙盘。
- `/monitor`：数据可视化和监控。
- `/knowledge`：知识库管理。
- `/models`：开源大语言模型。
- `/agents`：智能体运行与管理框架。
- `/api-console`：接口控制台。
- `/dify`：Dify 平台入口。
- `/home-assistant`：Home Assistant 入口。
- `/settings`：系统设置。
- `/users`：用户管理，仅管理员访问。

## 当前开发进度
- 单后台架构已收口，公共页面保留 `/home` 和 `/docs`。
- 合同化菜单和页面命名已推进，验收页面优先使用合同原词。
- `/docs` 已接入文档中心和 API 参考，API 参考支持接口调试器视图。
- `/api-console` 已作为接口文档与调试配置入口。
- `/agents` 已改为基于 Dify 的智能体运行与管理框架，支持 DSL 模板和一键部署入口。
- `/settings` 已向真实运行时配置收口，Dify、HA、Ollama 配置应通过系统设置或 `config.yaml` 兜底管理。
- Dify / Home Assistant 页面使用封面图和新窗口入口兜底，避免 iframe 限制影响演示。

## 可交付页面视觉基线（强制）
- 后台页面唯一视觉基线为 `build/deploy-cloud/smart-home-20260729-121725-7cde634.tar.gz`，只读对照服务为 `http://localhost:8090`。
- 必须保留各页面原有布局、内容宽度、留白、区块顺序和独立设计语言；功能补强只能嵌入原页面，不得借机重做页面骨架。
- 禁止用 `AdminPage`、`MetricStrip`、`WorkspacePanel`、`DataTable` 等共享组件批量替换既有页面结构。共享组件仅用于确有需要的局部行为和一致性能力。
- `/docs` API 参考中的全屏调试工作台是唯一已确认的布局例外。
- 视觉修改验收必须同时对照当前 `8088` 与基线 `8090`；不能只依据组件规范或新截图判断完成。

## 运行边界
- 运行时配置优先读取 `system_config`，`config.yaml` 作为启动兜底和首次部署默认值。
- Dify 负责 Workflow、Prompt、智能体深度编辑、运行调试和知识库能力。
- 平台负责统一后台、合同化页面、实例元数据、接口文档、调试器和演示入口。
- Home Assistant 负责智能家居设备、场景和传感器对接。
- Ollama 负责本地开源大语言模型推理。
- InfluxDB 是可选时序库扩展，不能阻塞主要页面和验收链路。

## 后期开发完整性约束
- 不允许把合同参数实现为只有菜单、卡片、静态列表或单个按钮；必须按真实业务流程补齐页面、交互、后端接口、运行日志和验收证据。
- 每个功能模块至少按“入口导航、总览、查询/筛选、详情、创建/编辑/删除或执行、结果反馈、日志/历史、异常/空态/权限、测试证据”检查完整性。
- 新增或修改页面前，先查看相邻模块的页面结构、组件、API、状态管理和错误处理，避免只完成当前按钮或当前接口。
- 前端页面必须考虑加载态、空态、错误态、权限不足、外部服务未配置、硬件离线、接口超时、操作确认、成功/失败提示和刷新后的状态一致性。
- 后端接口必须考虑真实数据来源、权限校验、输入校验、错误返回、操作审计、外部系统失败降级和可追踪日志。
- 涉及 Dify、Home Assistant、Ollama、知识库或硬件的功能，必须形成“页面现象 + 平台接口 + 外部系统状态/日志”的闭环证据，不能只看前端展示。
- 修改合同验收相关功能时，同步维护 `docs/delivery/06_功能模块完整性评审清单.md` 中对应模块的状态、缺口和验收证据要求。
- 如果真实硬件、Dify 应用、知识库或外部账号尚未确认，页面可以保留兜底演示，但文档和 UI 说明必须标注“待实机验证/硬件阻塞/非最终实现”，不能包装成已完成。
- 后期开发任务优先按 `docs/delivery/08_后期开发任务执行手册.md` 的流程执行：先读文档、审计现状、建立 Todo、实现验证、同步进度和台账。

## 文档入口
- 合同对照：`docs/contract/合同技术参数与完成度对照.md`
- 技术设计：`docs/design/技术设计文档.md`
- API 规划：`docs/design/开发者平台_外部功能接口规划.md`
- Dify API：`docs/design/dify-api.md`
- 深度审核：`docs/delivery/01_深度审核与真实完成度评估.md`
- 交付范围：`docs/delivery/02_后期交付阶段开发计划.md`
- 进度日志：`docs/delivery/03_开发进度日志.md`
- 验收指引：`docs/delivery/04_验收专家操作指引.md`
- 小米与沙盘接入：`docs/delivery/05_小米设备与真实电子沙盘接入方案.md`
- 模块完整性评审：`docs/delivery/06_功能模块完整性评审清单.md`
- 页面闭环整改台账：`docs/delivery/07_前端页面闭环整改台账.md`
- 后期开发任务执行手册：`docs/delivery/08_后期开发任务执行手册.md`
- 部署运维：`docs/deploy/部署运维手册.md`
- 云端发布：`docs/deploy/云服务器一键发布.md`
- Dify 模板：`dify/README.md`
- 知识库种子：`dify/kb-seed/README.md`

## 常用验证
- 前端构建：进入 `smart-home-ai-frontend/` 后执行 `npm run build`
- 后端语法检查：进入 `smart-home-ai-backend/` 后执行 `python -m compileall app`
- 健康检查：`curl http://localhost:8000/api/v1/system/health`
- 云端部署前先确认本地 `/docs`、`/api-console`、`/agents`、`/settings`、`/users` 可访问。

## 强制规则（Hard Rules）
- 文件编码必须 UTF-8；日志、异常信息、注释、开发说明默认使用中文。
- 仅修改与当前需求直接相关的文件；发现无关问题只在最终响应提示，不顺手大改。
- 保持现有代码风格与目录边界，不做无关重构。
- 禁止编辑项目目录外的文件。
- 禁止在前端代码中硬编码任何 API Key、Token、密码或外部系统凭证。
- 修改合同验收相关页面、菜单和文档时，优先使用合同参数原词。
- 修改文件时，尽量避免“删除整个文件再重建整个文件”的粗暴方式。
- 搜索代码优先用 `rg`；代码编辑优先用最小补丁。
- 后端复杂逻辑可补充简洁中文注释，但不要堆砌空洞注释。
- 不要回退已经完成的单后台、合同化命名、运行时配置、Dify/HA 封面入口等主线改造。

## 常见问题
- 浏览器报 CORS 时，优先查看 `.logs/backend.log`，很多时候实际是后端 500 或路由未注册。
- 云端 `/api-console` 404 时，优先检查前端构建产物、Nginx fallback 和部署 release 是否切换成功。
- Dify / Home Assistant 若拒绝 iframe，页面应展示封面图并提供新窗口打开入口。
- 用户管理无法访问时，优先确认当前登录用户角色、cookie/localStorage 登录态和 `/users` 路由。
- Dify 工作流失败时，先检查 Dify API Key、Dataset API Key、HA Token 和 `config.yaml`/系统设置中的运行时配置。
