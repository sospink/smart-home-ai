# 01 Main Orchestrator Chatflow — API 文档

> 工作流编排对话型应用 API  
> 对话应用支持会话持久化，可将之前的聊天记录作为上下文进行回答，可适用于聊天/客服 AI 等。

---

## 基础 URL
```
http://172.19.9.87/v1
```

---

## 鉴权

Service API 使用 `API-Key` 进行鉴权。

> **强烈建议**开发者把 `API-Key` 放在后端存储，而非分享或者放在客户端存储，以免 `API-Key` 泄露，导致财产损失。

所有 API 请求都应在 `Authorization` HTTP Header 中包含您的 `API-Key`：
```
Authorization: Bearer {API_KEY}
```

---

## 接口列表

### 1. 发送对话消息

**POST** `/chat-messages`

创建会话消息。

#### Request Body

| 参数名 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `query` | string | 是 | 用户输入/提问内容 |
| `inputs` | object | 否 | App 定义的各变量值，默认 `{}` |
| `response_mode` | string | 是 | `streaming`（流式）或 `blocking`（阻塞） |
| `user` | string | 是 | 用户标识，需保证在应用内唯一 |
| `conversation_id` | string | 否 | 会话 ID，继续已有对话时传入 |
| `files` | array[object] | 否 | 文件列表，支持 document/image/audio/video/custom 类型 |
| `auto_generate_name` | bool | 否 | 自动生成标题，默认 `true` |
| `workflow_id` | string | 否 | 工作流ID，指定特定版本 |
| `trace_id` | string | 否 | 链路追踪ID，可通过 Header/Query/Body 传递 |

**files 字段说明：**

- `type`：支持 `document` / `image` / `audio` / `video` / `custom`
- `transfer_method`：`remote_url`（远程地址）或 `local_file`（上传文件）
- `url`：文件地址（仅 `remote_url` 时使用）
- `upload_file_id`：上传文件 ID（仅 `local_file` 时使用）

#### Response

**阻塞模式**返回 `ChatCompletionResponse`（`application/json`）：

| 字段 | 类型 | 描述 |
|---|---|---|
| `event` | string | 固定为 `message` |
| `task_id` | string | 任务 ID |
| `id` | string | 唯一 ID |
| `message_id` | string | 消息唯一 ID |
| `conversation_id` | string | 会话 ID |
| `mode` | string | 固定为 `chat` |
| `answer` | string | 完整回复内容 |
| `metadata.usage` | object | 模型用量信息 |
| `metadata.retriever_resources` | array | 引用和归属分段列表 |
| `created_at` | int | 消息创建时间戳 |

**流式模式**返回 `ChunkChatCompletionResponse`（`text/event-stream`），每个块以 `data:` 开头，块之间以 `\n\n` 分隔。

流式事件类型：

| event | 描述 |
|---|---|
| `message` | LLM 返回文本块 |
| `message_file` | 新文件事件 |
| `message_end` | 消息结束事件 |
| `tts_message` | TTS 音频流（base64 编码） |
| `tts_message_end` | TTS 音频流结束 |
| `message_replace` | 内容替换事件（审查触发） |
| `workflow_started` | 工作流开始执行 |
| `node_started` | 节点开始执行 |
| `node_finished` | 节点执行结束 |
| `workflow_finished` | 工作流执行结束 |
| `error` | 异常事件 |
| `ping` | 每 10s 一次，保持连接 |

#### 错误码

| 状态码 | 错误码 | 描述 |
|---|---|---|
| 404 | - | 对话不存在 |
| 400 | `invalid_param` | 传入参数异常 |
| 400 | `app_unavailable` | App 配置不可用 |
| 400 | `provider_not_initialize` | 无可用模型凭据配置 |
| 400 | `provider_quota_exceeded` | 模型调用额度不足 |
| 400 | `model_currently_not_support` | 当前模型不可用 |
| 400 | `workflow_not_found` | 指定的工作流版本未找到 |
| 400 | `draft_workflow_error` | 无法使用草稿工作流版本 |
| 400 | `completion_request_error` | 文本生成失败 |
| 500 | - | 服务内部异常 |

#### 示例
```bash
curl -X POST 'http://172.19.9.87/v1/chat-messages' \
  --header 'Authorization: Bearer {api_key}' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "inputs": {},
    "query": "What are the specs of the iPhone 13 Pro Max?",
    "response_mode": "streaming",
    "conversation_id": "",
    "user": "abc-123",
    "files": [
      {
        "type": "image",
        "transfer_method": "remote_url",
        "url": "https://cloud.dify.ai/logo/logo-site.png"
      }
    ]
  }'
```

---

### 2. 上传文件

**POST** `/files/upload`

上传文件并在发送消息时使用（multipart/form-data）。

#### Request Body

| 参数名 | 类型 | 描述 |
|---|---|---|
| `file` | file | 要上传的文件 |
| `user` | string | 用户标识，需与发送消息接口一致 |

#### Response

| 字段 | 类型 | 描述 |
|---|---|---|
| `id` | uuid | 文件 ID |
| `name` | string | 文件名 |
| `size` | int | 文件大小（byte） |
| `extension` | string | 文件后缀 |
| `mime_type` | string | 文件 MIME 类型 |
| `created_by` | uuid | 上传人 ID |
| `created_at` | timestamp | 上传时间 |

#### 示例
```bash
curl -X POST 'http://172.19.9.87/v1/files/upload' \
  --header 'Authorization: Bearer {api_key}' \
  --form 'file=@localfile;type=image/[png|jpeg|jpg|webp|gif]' \
  --form 'user=abc-123'
```

---

### 3. 获取终端用户

**GET** `/end-users/:end_user_id`

通过终端用户 ID 获取终端用户信息。

#### 路径参数

| 参数名 | 类型 | 描述 |
|---|---|---|
| `end_user_id` | uuid | 终端用户 ID |

#### Response

| 字段 | 类型 | 描述 |
|---|---|---|
| `id` | uuid | ID |
| `tenant_id` | uuid | 工作空间 ID |
| `app_id` | uuid | 应用 ID |
| `type` | string | 终端用户类型 |
| `external_user_id` | string | 外部用户 ID |
| `name` | string | 名称 |
| `is_anonymous` | boolean | 是否匿名 |
| `session_id` | string | 会话 ID |
| `created_at` | string | ISO 8601 时间 |
| `updated_at` | string | ISO 8601 时间 |

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/end-users/6ad1ab0a-73ff-4ac1-b9e4-cdb312f71f13' \
  --header 'Authorization: Bearer {api_key}'
```

---

### 4. 文件预览

**GET** `/files/:file_id/preview`

预览或下载已上传的文件。

#### 路径参数

| 参数名 | 类型 | 描述 |
|---|---|---|
| `file_id` | string | 文件唯一标识符 |

#### 查询参数

| 参数名 | 类型 | 描述 |
|---|---|---|
| `as_attachment` | boolean | 是否强制下载，默认 `false` |

#### 示例
```bash
# 预览
curl -X GET 'http://172.19.9.87/v1/files/72fa9618-8f89-4a37-9b33-7e1178a24a67/preview' \
  --header 'Authorization: Bearer {api_key}'

# 下载
curl -X GET 'http://172.19.9.87/v1/files/72fa9618-8f89-4a37-9b33-7e1178a24a67/preview?as_attachment=true' \
  --header 'Authorization: Bearer {api_key}' \
  --output downloaded_file.png
```

---

### 5. 停止响应

**POST** `/chat-messages/:task_id/stop`

停止流式响应（仅支持流式模式）。

#### 路径参数

| 参数名 | 类型 | 描述 |
|---|---|---|
| `task_id` | string | 任务 ID，从流式返回中获取 |

#### Request Body

| 参数名 | 类型 | 描述 |
|---|---|---|
| `user` | string | 用户标识 |

#### 示例
```bash
curl -X POST 'http://172.19.9.87/v1/chat-messages/:task_id/stop' \
  -H 'Authorization: Bearer {api_key}' \
  -H 'Content-Type: application/json' \
  --data-raw '{"user": "abc-123"}'
```

---

### 6. 消息反馈（点赞）

**POST** `/messages/:message_id/feedbacks`

消息终端用户反馈/点赞。

#### Request Body

| 参数名 | 类型 | 描述 |
|---|---|---|
| `rating` | string | `like` / `dislike` / `null`（撤销） |
| `user` | string | 用户标识 |
| `content` | string | 反馈的具体信息 |

#### 示例
```bash
curl -X POST 'http://172.19.9.87/v1/messages/:message_id/feedbacks' \
  --header 'Authorization: Bearer {api_key}' \
  --header 'Content-Type: application/json' \
  --data-raw '{"rating": "like", "user": "abc-123", "content": "message feedback information"}'
```

---

### 7. 获取 APP 消息反馈列表

**GET** `/app/feedbacks`

获取应用所有终端用户的反馈/点赞列表。

#### 查询参数

| 参数名 | 类型 | 描述 |
|---|---|---|
| `page` | string | 分页，默认 1 |
| `limit` | string | 每页数量，默认 20 |

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/app/feedbacks?page=1&limit=20' \
  --header 'Authorization: Bearer {api_key}'
```

---

### 8. 获取建议问题列表

**GET** `/messages/{message_id}/suggested`

获取下一轮建议问题列表。

#### 查询参数

| 参数名 | 类型 | 描述 |
|---|---|---|
| `user` | string | 用户标识 |

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/messages/{message_id}/suggested?user=abc-123' \
  --header 'Authorization: Bearer ENTER-YOUR-SECRET-KEY'
```

---

### 9. 获取会话历史消息

**GET** `/messages`

滚动加载形式返回历史聊天记录（倒序）。

#### 查询参数

| 参数名 | 类型 | 描述 |
|---|---|---|
| `conversation_id` | string | 会话 ID |
| `user` | string | 用户标识 |
| `first_id` | string | 当前页第一条记录的 ID，默认 null |
| `limit` | int | 返回条数，默认 20 |

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/messages?user=abc-123&conversation_id={conversation_id}' \
  --header 'Authorization: Bearer {api_key}'
```

---

### 10. 获取会话列表

**GET** `/conversations`

获取当前用户的会话列表。

#### 查询参数

| 参数名 | 类型 | 描述 |
|---|---|---|
| `user` | string | 用户标识 |
| `last_id` | string | 当前页最后一条记录的 ID |
| `limit` | int | 返回条数，默认 20，最大 100 |
| `sort_by` | string | 排序字段，默认 `-updated_at` |

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/conversations?user=abc-123&last_id=&limit=20' \
  --header 'Authorization: Bearer {api_key}'
```

---

### 11. 删除会话

**DELETE** `/conversations/:conversation_id`

#### Request Body

| 参数名 | 类型 | 描述 |
|---|---|---|
| `user` | string | 用户标识 |

#### 示例
```bash
curl -X DELETE 'http://172.19.9.87/v1/conversations/{conversation_id}' \
  --header 'Authorization: Bearer {api_key}' \
  --data '{"user": "abc-123"}'
```

---

### 12. 会话重命名

**POST** `/conversations/:conversation_id/name`

#### Request Body

| 参数名 | 类型 | 描述 |
|---|---|---|
| `name` | string | 名称（`auto_generate` 为 true 时可不传） |
| `auto_generate` | bool | 自动生成标题，默认 `false` |
| `user` | string | 用户标识 |

#### 示例
```bash
curl -X POST 'http://172.19.9.87/v1/conversations/{conversation_id}/name' \
  --header 'Authorization: Bearer {api_key}' \
  --data-raw '{"name": "", "auto_generate": true, "user": "abc-123"}'
```

---

### 13. 获取对话变量

**GET** `/conversations/:conversation_id/variables`

从特定对话中检索变量。

#### 查询参数

| 参数名 | 类型 | 描述 |
|---|---|---|
| `user` | string | 用户标识 |
| `last_id` | string | 当前页最后一条记录的 ID |
| `limit` | int | 返回条数，默认 20，最大 100 |

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/conversations/{conversation_id}/variables?user=abc-123' \
  --header 'Authorization: Bearer {api_key}'
```

---

### 14. 更新对话变量

**PUT** `/conversations/:conversation_id/variables/:variable_id`

#### Request Body

| 参数名 | 类型 | 描述 |
|---|---|---|
| `value` | any | 变量的新值，需匹配变量类型 |
| `user` | string | 用户标识 |

#### 示例
```bash
curl -X PUT 'http://172.19.9.87/v1/conversations/{conversation_id}/variables/{variable_id}' \
  --header 'Authorization: Bearer {api_key}' \
  --data-raw '{"value": "Updated Value", "user": "abc-123"}'
```

---

### 15. 语音转文字

**POST** `/audio-to-text`

（multipart/form-data）

#### Request Body

| 参数名 | 类型 | 描述 |
|---|---|---|
| `file` | file | 语音文件，支持 mp3/mp4/mpeg/mpga/m4a/wav/webm，最大 15MB |
| `user` | string | 用户标识 |

#### 示例
```bash
curl -X POST 'http://172.19.9.87/v1/audio-to-text' \
  --header 'Authorization: Bearer {api_key}' \
  --form 'file=@localfile;type=audio/[mp3|mp4|mpeg|mpga|m4a|wav|webm]'
```

---

### 16. 文字转语音

**POST** `/text-to-audio`

#### Request Body

| 参数名 | 类型 | 描述 |
|---|---|---|
| `message_id` | string | Dify 生成的消息 ID（优先使用） |
| `text` | string | 语音生成内容（无 message_id 时使用） |
| `user` | string | 用户标识 |

#### 示例
```bash
curl -o text-to-audio.mp3 -X POST 'http://172.19.9.87/v1/text-to-audio' \
  --header 'Authorization: Bearer {api_key}' \
  --header 'Content-Type: application/json' \
  --data-raw '{"message_id": "5ad4cb98-f0c7-4085-b384-88c403be6290", "text": "Hello Dify", "user": "abc-123"}'
```

---

### 17. 获取应用基本信息

**GET** `/info`

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/info' \
  -H 'Authorization: Bearer {api_key}'
```

#### Response

| 字段 | 类型 | 描述 |
|---|---|---|
| `name` | string | 应用名称 |
| `description` | string | 应用描述 |
| `tags` | array[string] | 应用标签 |
| `mode` | string | 应用模式 |
| `author_name` | string | 作者名称 |

---

### 18. 获取应用参数

**GET** `/parameters`

获取功能开关、输入参数名称、类型及默认值等。

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/parameters'
```

#### Response 主要字段

| 字段 | 类型 | 描述 |
|---|---|---|
| `opening_statement` | string | 开场白 |
| `suggested_questions` | array | 开场推荐问题列表 |
| `suggested_questions_after_answer.enabled` | bool | 是否开启回答后推荐问题 |
| `speech_to_text.enabled` | bool | 语音转文本是否开启 |
| `text_to_speech.enabled` | bool | 文本转语音是否开启 |
| `user_input_form` | array | 用户输入表单配置 |
| `file_upload` | object | 文件上传配置（document/image/audio/video/custom） |
| `system_parameters` | object | 系统参数（各类文件大小限制） |

---

### 19. 获取应用 Meta 信息

**GET** `/meta`

获取工具图标信息。

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/meta' \
  -H 'Authorization: Bearer {api_key}'
```

---

### 20. 获取 WebApp 设置

**GET** `/site`

#### 示例
```bash
curl -X GET 'http://172.19.9.87/v1/site' \
  -H 'Authorization: Bearer {api_key}'
```

#### Response 主要字段

| 字段 | 类型 | 描述 |
|---|---|---|
| `title` | string | WebApp 名称 |
| `icon_type` | string | 图标类型（emoji/image） |
| `icon` | string | 图标 |
| `description` | string | 描述 |
| `default_language` | string | 默认语言 |
| `show_workflow_steps` | bool | 是否显示工作流详情 |

---

## 标注管理

### 21. 获取标注列表

**GET** `/apps/annotations`

| 查询参数 | 描述 |
|---|---|
| `page` | 页码 |
| `limit` | 每页数量 |

### 22. 创建标注

**POST** `/apps/annotations`

| 参数 | 描述 |
|---|---|
| `question` | 问题 |
| `answer` | 答案内容 |

### 23. 更新标注

**PUT** `/apps/annotations/{annotation_id}`

### 24. 删除标注

**DELETE** `/apps/annotations/{annotation_id}`

返回 `204 No Content`。

### 25. 标注回复初始设置

**POST** `/apps/annotation-reply/{action}`

`action` 只能为 `enable` 或 `disable`。

| 参数 | 类型 | 描述 |
|---|---|---|
| `score_threshold` | number | 相似度阈值 |
| `embedding_provider_name` | string | 嵌入模型提供商 |
| `embedding_model_name` | string | 嵌入模型名称 |

返回异步 job_id，可通过下方接口查询状态。

### 26. 查询标注回复任务状态

**GET** `/apps/annotation-reply/{action}/status/{job_id}`

---

*文档来源：http://172.19.9.87/app/59670e38-3af8-42f3-b73a-6d35d225a334/develop*
