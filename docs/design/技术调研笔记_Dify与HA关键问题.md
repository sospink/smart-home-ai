# 技术调研笔记：Dify 与 Home Assistant 关键问题

> 整理时间：2026-03-11
> 用途：开发前期技术选型备忘，开始写项目时参考

---

## 一、整体产品是什么？

**一台本地离线运行的 AI 智能体服务器**，部署在客户现场，专门服务于智慧家居场景的科研与演示。

- 硬件：高性能迷你PC / 工作站（≥16核CPU + ≥32G内存 + RTX 4080 16G显存）
- 访问方式：**全部通过浏览器访问，零客户端安装**，局域网内任何设备（包括手机）打开 IP 即可使用
- 核心定位：完全本地部署、数据不出门、开源可二次开发（合同 ▲7 强制要求）
- 目标用户：高校科研机构 / 地方政府产业园，用于 AI+IoT 方向科研课题与技术展示

---

## 二、各服务的访问入口

| 访问地址 | 服务 | 用途 |
|---|---|---|
| `http://服务器IP:3000` | Dify | 主要 AI 对话与工作流界面 |
| `http://服务器IP:8123` | Home Assistant | 智能家居控制面板 |
| `http://服务器IP:8501` | Streamlit | 虚拟沙盘可视化界面 |
| `http://服务器IP:11434` | Ollama API | 开发者直接调用模型接口 |

> Nginx 统一反代，对外暴露统一入口。

---

## 三、Dify 与 Home Assistant 的关系

### 结论：需要手动配置串联，不是开箱自动关联

两者通过 **Home Assistant REST API** 连接，调用链路如下：

```
用户（自然语言）→ Dify Agent → 调用 HA Tool（HTTP请求）→ Home Assistant API → 物理/虚拟设备
```

### 串联需要做的三件事

1. **在 Home Assistant 里**：生成 Long-Lived Access Token（长期访问令牌）
2. **在 Dify 里**：注册自定义工具，把 HA 常用 API 封装进去
   - 控制开关：`POST /api/services/light/turn_on`
   - 查询设备状态：`GET /api/states/<entity_id>`
   - 读传感器数据：`GET /api/states` + 过滤
3. **在 Dify 的 Agent 工作流里**：让 AI 知道什么时候调用这些工具

> 这也是合同 **▲14（4种接口调用）** 验收的核心内容——Dify 通过至少4种方式调用外部接口，HA REST API 是最核心的一种。

---

## 四、Dify 里的 Agent 架构：多 Agent 分层设计

### 结论：Dify 支持"主 Agent 调度多个子 Agent"，用户只需与主 Agent 交互

### 架构图

```
用户输入（唯一对话窗口）
        ↓
  主 Chatflow（意图识别 + 路由）
        ├── 意图=控制设备  → 调用「家居控制 Workflow」→ HA API → 执行
        ├── 意图=知识问答  → 调用「RAG问答 Workflow」→ Dify知识库 → 回答
        └── 意图=数据查询  → 调用「数据分析 Workflow」→ InfluxDB/PG → 分析
        ↓
  汇总结果返回用户
```

用户全程感知不到背后有多个 Workflow，体验就像跟一个 AI 对话。

### 计划中的四个 Agent

| Agent | 职责 | 核心工具 |
|---|---|---|
| 主调度 Chatflow | 意图识别、路由分发 | 条件分支节点 |
| 家居控制 Workflow | 理解控制指令、执行设备操作 | HA REST API |
| 知识问答 Workflow | 回答文档/设备说明书相关问题 | Dify 内置知识库（RAG） |
| 数据分析 Workflow | 查询历史数据、生成分析报告 | InfluxDB、PostgreSQL |

### 两种实现方式对比

| | Chatflow + 子Workflow节点 | Agent + 工具调用（Function Calling） |
|---|---|---|
| 调度方式 | 开发者写条件逻辑决定走哪条路 | LLM 自己判断调哪个工具 |
| 可控性 | 高，行为确定可预测 | 低，模型可能选错 |
| 灵活性 | 低，需提前穷举所有分支 | 高，能处理未预料情况 |
| 适合本项目 | ✅ **推荐**，意图分类清晰 | ⚠️ 不推荐，7B 模型 Function Calling 能力弱 |

**结论：本项目用方式一（Chatflow + 子Workflow节点），更稳定可控。**

---

## 五、Home Assistant 对小米设备的支持

### 结论：支持，且是小米官方维护的集成

**证据**：
- 官方仓库：[github.com/XiaoMi/ha_xiaomi_home](https://github.com/XiaoMi/ha_xiaomi_home)（XiaoMi 组织下，非第三方）
- 21,500+ GitHub Star，社区活跃
- 最低要求：Home Assistant Core ≥ 2024.4.4

**支持范围**：
- ✅ 支持大多数小米 IoT 设备（空气净化器、扫地机器人、智能灯等）
- ✅ 云端控制（小米账号登录）+ 本地控制（需配小米中枢网关）
- ❌ 不支持：蓝牙设备、红外遥控设备、虚拟设备

**接入方式**：Settings → Devices & Services → Add Integration → 搜索 "Xiaomi Home" → 登录小米账号 → 导入设备

### 与本项目虚拟沙盘的关系

本项目的虚拟设备（▲23）用 HA Template 实体 + MQTT 模拟器实现，与小米集成是**两条独立路线，互不干扰**。若客户真实环境有小米设备，直接装官方集成即可接入。

---

## 六、开发时的关键注意点

1. **主 Agent 意图识别要做好 Prompt**：中文口语化指令（"帮我把灯关了"）需要准确映射到对应 Workflow，Prompt 工程很重要。

2. **HA Token 安全管理**：Long-Lived Access Token 写在 Dify 的环境变量里，不要硬编码在 Workflow 配置中。

3. **7B 模型 Function Calling 能力有限**：用条件分支做路由，不要依赖模型自己选工具。

4. **虚拟设备优先开发**：先用虚拟实体跑通整个链路，再接真实设备，降低调试复杂度。

5. **▲14 验收准备**：确保能演示至少4种接口调用方式：HA REST API、Dify 知识库检索 API、InfluxDB 查询、Ollama 模型调用 API。
