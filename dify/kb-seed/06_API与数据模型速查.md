# API 与数据模型速查

## 后端统一前缀
后端 API 统一前缀为：

`/api/v1`

## 主要 API 模块

### 认证
- `/auth/login`
- `/auth/register`
- `/auth/me`
- `/auth/password`

### 对话
- `/chat/health`
- `/chat/completions`
- `/chat/blocking`
- `/chat/conversations`
- `/chat/messages`
- `/chat/stop`

### 设备
- `/devices/health`
- `/devices/search`
- `/devices/`
- `/devices/summary`
- `/devices/{entity_id}`
- `/devices/{entity_id}/control`

### 知识库
- `/knowledge/health`
- `/knowledge/datasets`
- `/knowledge/datasets/{id}/documents`
- `/knowledge/datasets/{id}/documents/text`
- `/knowledge/datasets/{id}/documents/file`
- `/knowledge/datasets/{id}/hit-testing`

### 系统
- `/system/health`
- `/system/dashboard`
- `/system/settings`
- `/system/test-connection`

### 监控
- `/monitor/resources`
- `/monitor/ai-status`
- `/monitor/services`
- `/monitor/activity`
- `/monitor/sensor-history`

### 模型
- `/models/health`
- `/models/version`
- `/models/current`
- `/models/pull`
- `/models/system-metrics`

## 典型数据模型

### User
- 用户信息
- 包括用户名、密码哈希、昵称、角色、启用状态

### OperationLog
- 操作日志
- 记录登录、设备控制等行为

### SystemConfig
- 系统配置
- 保存外部服务地址、密钥、注册开关、密码长度等配置项

## 典型接口语义

### 登录
输入用户名和密码，返回 JWT Token。

### 流式对话
请求体中包含：

- `query`
- `conversation_id`

返回 `text/event-stream`。

### 设备控制
请求体中包含：

- `service`
- `domain`（可选）
- `data`（可选）

### 文本创建知识库文档
请求体中包含：

- `name`
- `text`

## 知识库适合回答的问题

- 某个功能对应哪个 API 模块
- 当前系统支持哪些核心路由
- 操作日志、系统配置、用户信息分别存在哪张表
