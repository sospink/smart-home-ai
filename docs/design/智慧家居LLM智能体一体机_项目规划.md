# 智慧家居大语言模型智能体科研应用一体机
## 从 0 到 1 完整项目规划文档

> 基于江门定开产品合同（40项技术要求）
> 面向：全栈开发者 / AI工程师
> 硬件环境：≥16核24线程 CPU | ≥32G 内存 | ≥16G 显存 GPU（≥4608 计算核心，≥128bit 显存位宽）
> 文档日期：2026-03-08

---

## 目录

1. [项目概述与目标](#1-项目概述与目标)
2. [合同需求拆解与映射](#2-合同需求拆解与映射)
3. [技术选型决策](#3-技术选型决策)
4. [整体系统架构](#4-整体系统架构)
5. [各功能模块详细设计](#5-各功能模块详细设计)
6. [目录结构与工程组织](#6-目录结构与工程组织)
7. [Docker Compose 一键部署方案](#7-docker-compose-一键部署方案)
8. [开发路线图（分阶段实施）](#8-开发路线图分阶段实施)
9. [合同强制项（▲标）专项说明](#9-合同强制项标专项说明)
10. [风险与注意事项](#10-风险与注意事项)

---

## 1. 项目概述与目标

### 1.1 项目定位

本项目是一台面向高校科研场景的**本地化 AI 智能家居实验平台**，核心价值是：

- 无外网依赖，完全离线运行
- 大语言模型 + 智能体框架 + 智能家居三合一
- 支持科研复现与二次开发
- 具备虚拟设备电子沙盘，可在无真实硬件条件下做实验

### 1.2 核心功能模块（合同第5条）

| 模块 | 描述 | 对应合同条款 |
|------|------|------------|
| 本地大语言模型服务 | 离线推理引擎 + OpenAI兼容接口 | 9、10、11、12 |
| 智能体框架与应用 | Agent 创建/运行/管理 | 13~18 |
| 智能家居对接 | 真实设备 + 虚拟沙盘 | 19~24 |
| 知识增强（RAG） | 向量库 + 文档检索 | 31~35 |
| 应用模板库 | 示例模板 + 开发脚手架 | 25~30 |
| Web 管理界面 | 统一可视化操作台 | 8、36~39 |

---

## 2. 合同需求拆解与映射

### 2.1 硬件层要求（条款 1~4）

```
CPU：≥16核24线程（建议 Intel i9-13980HX 或 AMD Ryzen 9 7945HX）
内存：≥32G（建议 64G 以获得更好多任务性能）
存储：≥512G SSD（建议 2T NVMe，模型文件较大）
GPU：≥16G 显存，≥4608 CUDA 核心，≥128bit 位宽
  → 对应显卡：RTX 4080 (16G)、RTX 4090(24G)、RTX 4070Ti Super(16G)
```

### 2.2 软件功能要求全量映射

| 条款编号 | 要求描述 | 技术实现方案 | 优先级 |
|---------|---------|------------|--------|
| 5 | 6项功能模块 | Ollama + Dify + HA + Jupyter + Open WebUI（知识库用Dify内置） | P0 |
| 6 | 离线运行3项核心功能 | 全部组件支持完全本地化 Docker 部署 | P0 |
| ▲7 | 合规开源，支持二次开发 | MIT/Apache2.0 协议选型，预留扩展接口 | P0（投标截图） |
| 8 | Web管理界面4项功能 | 统一门户（Nginx反代各组件UI） | P0 |
| 9 | 本地6B-10B模型 | Qwen2.5-7B / DeepSeek-R1-7B | P0 |
| 10 | 单卡量化推理 | Ollama INT4/INT8 量化模式 | P0 |
| 11 | ≥1个模型，可切换 | Ollama 多模型管理 + Open WebUI 切换 | P0 |
| 12 | 文本生成+多轮对话接口 | OpenAI 兼容 REST API | P0 |
| 13 | 智能体运行框架 | Dify（本地Docker部署）| P0 |
| ▲14 | 4种接口调用 | Dify Tool 自定义插件（HA控制/查询/RAG/文件） | P0（投标截图） |
| 15 | 多轮对话 | Dify 会话历史 + LLM context window | P1 |
| 16 | 会话记录管理 | Dify 内置日志 + PostgreSQL 持久化 | P1 |
| 17 | 流程/规则驱动任务 | Dify Workflow 节点编排 | P1 |
| 18 | 多智能体管理 | Dify 多应用实例 | P1 |
| 19 | 智能家居对接能力 | Home Assistant + MQTT + REST API | P0 |
| 20 | 对接平台获取状态/传感/场景 | HA 状态接口 + Dify Tool Plugin | P1 |
| 21 | 实时/历史/运行数据查询 | HA REST API + InfluxDB | P1 |
| 22 | 设备控制接口 | HA Service Call API | P1 |
| ▲23 | 虚拟设备/电子沙盘 | HA 虚拟实体 + MQTT 仿真器 + Streamlit 可视化 | P0（投标截图） |
| 24 | 虚拟设备控制 | HA Template Entity + MQTT 消息 | P1 |
| 25 | 应用模板库 | 预置 5+ Dify 模板工作流 | P1 |
| 26 | 开发脚手架 | Python SDK + 示例项目 | P2 |
| 27 | 模板说明文档 | MkDocs 文档站 | P2 |
| 28 | 基础开发环境 | VS Code Server（code-server） | P2 |
| 29 | Jupyter Notebook | JupyterLab 集成 | P1 |
| 30 | Prompt 管理 | Dify Prompt 编辑器 | P1 |
| 31 | 知识库管理 | Dify 内置知识库（文档导入/存储/组织） | P0 |
| 32 | 向量数据库/语义检索 | Dify 内置 Weaviate 向量库 | P0 |
| 33 | 多格式文档解析 | Dify 内置解析引擎（PDF/Word/MD/TXT/HTML/CSV） | P1 |
| 34 | 增量更新管理 | Dify 知识库 CRUD（Web UI + API） | P1 |
| 35 | 语义检索 | Dify 语义检索 + 混合检索模式 | P1 |
| 36 | 智能体交互界面（含语音） | Open WebUI（支持语音输入） | P1 |
| 37 | 设备状态可视化 | Home Assistant Lovelace Dashboard | P1 |
| 38 | 嵌入虚拟沙盘界面 | Streamlit iframe 嵌入 | P2 |
| 39 | 数据监控界面 | Grafana（系统运行/使用统计） | P2 |
| 40 | 帮助文档 | MkDocs Material 文档站 | P2 |

---

## 3. 技术选型决策

### 3.1 大语言模型

**首选：Qwen2.5-7B-Instruct（量化版）**

```
理由：
✅ 阿里巴巴开源，MIT-like 协议，符合国内法律法规
✅ 7B 参数，INT4量化后显存需求约 4.7GB，16G显卡绰绰有余
✅ 中文指令跟随能力最强，专门优化过中文场景
✅ 支持 32K 上下文，适合长文档 RAG
✅ 支持 Function Calling（工具调用），是 Agent 的基础能力
```

**备选：DeepSeek-R1-Distill-Qwen-7B**
```
理由：
✅ MIT 开源协议，完全商业友好
✅ 推理能力强，适合复杂任务分解
✅ 7B 体积，本地部署轻量
```

**Embedding 模型：BAAI/bge-m3**
```
理由：
✅ 北航开源，中文效果最佳
✅ 支持多语言，768维向量
✅ 完全本地运行
```

### 3.2 模型推理引擎

**选择：Ollama**

```
对比分析：
+----------+--------+----------+--------+--------+
| 工具     | 易用性 | 量化支持 | 接口   | 社区   |
+----------+--------+----------+--------+--------+
| Ollama   | ⭐⭐⭐⭐⭐ | ✅ INT4/8 | OpenAI兼容 | 活跃 |
| vLLM     | ⭐⭐⭐   | ✅        | OpenAI兼容 | 活跃 |
| LM Studio| ⭐⭐⭐⭐  | ✅        | OpenAI兼容 | 活跃 |
+----------+--------+----------+--------+--------+

结论：Ollama 作为默认推理引擎
- 一行命令启动：ollama serve
- 模型下载：ollama pull qwen2.5:7b
- API 完全兼容 OpenAI 格式
- 支持同时加载多个模型（内存允许情况下）
```

### 3.3 智能体框架

**选择：Dify（自托管版）**

```
对比分析：
+----------+-------+--------+--------+--------+----------+
| 框架     | 部署  | RAG内置| 工作流 | 多Agent| Web UI   |
+----------+-------+--------+--------+--------+----------+
| Dify     | Docker| ✅     | ✅可视化 | ✅    | ✅完整   |
| FastGPT  | Docker| ✅     | ✅      | 有限   | ✅较完整 |
| LangChain| Python| ❌内置 | 代码级  | ✅    | ❌需自建 |
| AutoGen  | Python| ❌内置 | 代码级  | ✅    | ❌需自建 |
+----------+-------+--------+--------+--------+----------+

结论：Dify 作为主平台
- Apache 2.0 开源协议
- 可视化工作流 = 合同第17条
- 内置 RAG = 可与 RAGFlow 互补
- 工具插件系统 = 合同第14条的4种接口
- 自定义工具用 Python 函数实现 HA 控制
```

### 3.4 智能家居中控

**选择：Home Assistant（Container 版）**

```
理由：
✅ Apache 2.0 开源
✅ 支持 2000+ 设备集成
✅ 内置 MQTT 集成
✅ REST API 完善（Dify 可直接调用）
✅ 支持创建虚拟（Template）实体 → 满足合同第23条
✅ Lovelace Dashboard 满足合同第37条
✅ Python 原生，极易二次开发

关键使用方式：
- Long-Lived Token 认证
- /api/states 接口获取设备状态
- /api/services 接口控制设备
- MQTT 接口对接虚拟设备仿真器
```

### 3.5 知识库与向量数据库

**选择：Dify 内置知识库（不额外部署 RAGFlow / Milvus）**

```
Dify 内置知识库能力：
✅ 支持 PDF/Word/TXT/MD/HTML/CSV 文档导入（满足条款33）
✅ 内置 Weaviate 向量库，无需独立部署（满足条款32）
✅ 支持自动分块 / 自定义分块策略
✅ 语义检索 + 关键词检索 + 混合检索三种模式（满足条款35）
✅ Web UI 直接管理知识库（增/删/改，满足条款34）
✅ 知识库与 Agent/Workflow 深度集成，无缝调用
✅ 提供 HTTP API，支持外部程序查询

为什么不用 RAGFlow + Milvus：
- 合同没有大规模文档需求，Dify 内置方案完全覆盖条款31-35
- 少两个独立服务，系统更轻，内存节省约 4-6GB
- 出问题只需排查一个系统，运维更简单
- 后期若确实需要更强解析能力，可随时接入 RAGFlow（改一个 Tool 插件即可）
```

### 3.6 Web 管理界面

采用 **统一门户** + 各组件原生 UI 的方案：

```
Nginx 统一入口（:80）
├── /          → Open WebUI（模型对话，默认首页）
├── /agent     → Dify UI（智能体管理 + 知识库管理）
├── /home      → Home Assistant（家居控制 + 设备状态）
├── /jupyter   → JupyterLab
├── /monitor   → Grafana（监控）
├── /sandbox   → 电子沙盘（虚拟家居可视化）
└── /code      → code-server（在线IDE）

注：知识库管理入口在 Dify UI（/agent）内，无需独立路由
```

### 3.7 虚拟设备/电子沙盘

> ⚠️ **开发阶段说明：此模块属于第二、三阶段，核心 AI 链路跑通后再做。**
>
> - **虚拟设备**（HA Template 实体 + MQTT 仿真器）→ 第二阶段，配合智能家居对接一起做
> - **电子沙盘可视化**（Streamlit 前端界面）→ 第三阶段，功能验收前完成，主要用于演示

**方案：HA虚拟实体 + MQTT仿真器 + Streamlit可视化**

三层架构说明：

```
层1：HA 虚拟设备（YAML 配置，约1天）
  → 在 Home Assistant 里用 template 定义假设备
  → 无需任何真实硬件，AI 可以像控制真实设备一样控制它

层2：MQTT 仿真器（Python 脚本，约1天）
  → 定时向 MQTT 推送模拟数据（温度波动、湿度变化等）
  → 让虚拟设备的传感器数值"活"起来，更真实

层3：Streamlit 电子沙盘（约2-3天）
  → 网页可视化平面图，实时显示虚拟设备状态
  → 支持点击控制，也支持输入自然语言指令调 AI
```

---

## 4. 整体系统架构

### 4.1 逻辑架构图

```
╔══════════════════════════════════════════════════════════════════╗
║                      用户层 / 界面层                              ║
║  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌────────────────────┐ ║
║  │Open WebUI│  │ Dify UI │  │ Grafana  │  │  Streamlit 电子沙盘 │ ║
║  │ (对话)  │  │(智能体) │  │  (监控)  │  │    (虚拟家居展示)   │ ║
║  └────┬────┘  └────┬────┘  └────┬─────┘  └────────┬───────────┘ ║
╚═══════╪════════════╪════════════╪═══════════════════╪════════════╝
        │            │            │                   │
╔═══════╪════════════╪════════════╪═══════════════════╪════════════╗
║               Nginx 统一反代网关（端口 :80）                       ║
╚═══════╪════════════╪════════════╪═══════════════════╪════════════╝
        │            │            │                   │
╔═══════╪════════════╪════════════╪═══════════════════╪════════════╗
║                       服务层                                      ║
║  ┌────┴────────────────┴────┐   │   ┌───────────────┴──────────┐ ║
║  │         Dify             │   │   │     Home Assistant        │ ║
║  │  ┌──────────────────┐    │   │   │  ┌────────┐ ┌─────────┐  │ ║
║  │  │  工作流编排引擎    │    │   │   │  │ MQTT   │ │ REST API│  │ ║
║  │  │ (合同17、18条)   │    │   │   │  │ Broker │ │  :8123  │  │ ║
║  │  └────────┬─────────┘    │   │   │  └───┬────┘ └────┬────┘  │ ║
║  │  ┌────────┴─────────┐    │   │   │      │           │        │ ║
║  │  │   Tool 插件系统   │    │   │   │  ┌───┴───────────┴──────┐│ ║
║  │  │(4种接口合同14条) │    │   │   │  │  Template 虚拟设备    ││ ║
║  │  └──────────────────┘    │   │   │  │  真实设备集成          ││ ║
║  └──────────────────────────┘   │   │  └──────────────────────┘│ ║
║                                 │   └──────────────────────────┘ ║
║  ┌──────────────────────────┐   │   ┌──────────────────────────┐ ║
║  │    Dify 内置知识库        │   │   │       JupyterLab          │ ║
║  │  文档导入/向量化/检索     │   │   │   科研数据分析/模型调试    │ ║
║  │  (Weaviate 内置向量库)    │   │   │                          │ ║
║  └────────────┬─────────────┘   │   └──────────────────────────┘ ║
╚═══════════════╪═════════════════╪═══════════════════════════════╝
                │                 │
╔═══════════════╪═════════════════╪═══════════════════════════════╗
║                       数据层                                      ║
║  ┌────────────┴──┐  ┌──────────┴───┐  ┌─────────┐  ┌─────────┐ ║
║  │  Weaviate     │  │  PostgreSQL  │  │  Redis  │  │InfluxDB │ ║
║  │(Dify内置向量) │  │ (结构化数据) │  │ (缓存)  │  │(时序库) │ ║
║  └───────────────┘  └──────────────┘  └─────────┘  └─────────┘ ║
╚═══════════════════════════════════════════════════════════════════╝
                        │
╔═══════════════════════╪═══════════════════════════════════════════╗
║                      推理层                                        ║
║  ┌─────────────────────┴──────────────────────────────────────┐  ║
║  │                    Ollama 推理服务 (:11434)                  │  ║
║  │  ┌─────────────────┐     ┌──────────────────────────────┐  │  ║
║  │  │ Qwen2.5-7B INT4 │     │ BAAI/bge-m3 (Embedding模型)  │  │  ║
║  │  │ （主对话模型）   │     │     （语义向量化）            │  │  ║
║  │  └─────────────────┘     └──────────────────────────────┘  │  ║
║  └────────────────────────────────────────────────────────────┘  ║
║                              ↑ GPU 直通                           ║
╚════════════════════════════════════════════════════════════════════╝
```

### 4.2 数据流图（用户发出指令 → 设备响应）

```
用户语音/文字输入
      ↓
Open WebUI / Dify 对话界面
      ↓
Dify 智能体应用（解析意图）
      ↓ 调用 Function Call
Qwen2.5-7B（via Ollama API）
      ↓ 返回结构化指令
Dify Tool Plugin（HA控制工具）
      ↓ HTTP POST /api/services
Home Assistant
      ↓ MQTT / 直接控制
物理设备 或 虚拟模拟设备
      ↓ 状态反馈
HA REST API → Dify → 用户界面
```

---

## 5. 各功能模块详细设计

### 5.1 模块一：本地模型推理服务

**技术栈：** Ollama + Open WebUI

**部署方式：**
```bash
# 拉取并启动 Ollama
docker run -d --gpus all \
  -v ollama_data:/root/.ollama \
  -p 11434:11434 \
  --name ollama \
  ollama/ollama

# 下载模型
docker exec ollama ollama pull qwen2.5:7b
docker exec ollama ollama pull bge-m3

# 验证 API
curl http://localhost:11434/api/chat -d '{
  "model": "qwen2.5:7b",
  "messages": [{"role": "user", "content": "你好"}]
}'
```

**API 接口规范（OpenAI 兼容）：**
```
POST /api/chat         → 多轮对话（流式）
POST /api/generate     → 单次文本生成
GET  /api/tags         → 已安装模型列表
POST /api/embeddings   → 文本向量化
```

**满足合同条款：** 9、10、11、12

---

### 5.2 模块二：智能体框架（Dify）

**技术栈：** Dify CE（社区版）+ PostgreSQL + Redis

**核心配置：**

```yaml
# Dify 连接本地 Ollama 配置
Model Provider: Ollama
Base URL: http://ollama:11434
Model: qwen2.5:7b

# 工具插件开发（满足合同第14条4种接口）
tools/
├── ha_control.py      # 设备控制接口
├── ha_query.py        # 数据查询接口
├── rag_search.py      # 知识库检索接口
└── file_system.py     # 文件与系统接口
```

**HA 控制工具示例：**
```python
# tools/ha_control.py
import requests

class HomeAssistantControlTool:
    """设备控制接口 - 对应合同第14条"""

    def __init__(self):
        self.base_url = "http://homeassistant:8123/api"
        self.token = "your_long_lived_token"

    def call_service(self, domain: str, service: str, entity_id: str, **kwargs):
        """调用 HA 服务控制设备"""
        headers = {"Authorization": f"Bearer {self.token}"}
        payload = {"entity_id": entity_id, **kwargs}
        resp = requests.post(
            f"{self.base_url}/services/{domain}/{service}",
            json=payload,
            headers=headers
        )
        return resp.json()

    def turn_on_light(self, entity_id: str, brightness: int = 255):
        return self.call_service("light", "turn_on", entity_id, brightness=brightness)

    def set_temperature(self, entity_id: str, temperature: float):
        return self.call_service("climate", "set_temperature", entity_id,
                                  temperature=temperature)
```

**HA 查询工具示例：**
```python
# tools/ha_query.py
class HomeAssistantQueryTool:
    """数据查询接口 - 对应合同第21条"""

    def get_state(self, entity_id: str) -> dict:
        """获取实时状态"""
        resp = requests.get(
            f"{self.base_url}/states/{entity_id}",
            headers=self.headers
        )
        return resp.json()

    def get_history(self, entity_id: str, start_time: str) -> list:
        """获取历史数据"""
        resp = requests.get(
            f"{self.base_url}/history/period/{start_time}",
            params={"filter_entity_id": entity_id},
            headers=self.headers
        )
        return resp.json()

    def get_all_states(self) -> list:
        """获取所有设备状态"""
        resp = requests.get(f"{self.base_url}/states", headers=self.headers)
        return resp.json()
```

**预置智能体模板（满足合同第25条）：**

```
templates/
├── 01_smart_home_assistant.yaml   # 智能家居语音助手
├── 02_energy_optimizer.yaml       # 能耗优化智能体
├── 03_security_monitor.yaml       # 安防监控智能体
├── 04_scene_automation.yaml       # 场景自动化规划
└── 05_research_assistant.yaml     # 科研问答助手
```

**满足合同条款：** 13、14、15、16、17、18、25、26、27、30

---

### 5.3 模块三：智能家居对接（Home Assistant）

**部署配置：**
```yaml
# configuration.yaml 核心配置
homeassistant:
  name: "智慧家居实验平台"
  latitude: 22.5
  longitude: 113.4

# MQTT 集成
mqtt:
  broker: mosquitto
  port: 1883

# API 接口开启
api:

# HTTP 长生命周期 Token（供 Dify 调用）
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.16.0.0/12
```

**虚拟设备定义（满足合同第23条）：**
```yaml
# virtual_devices.yaml
template:
  - sensor:
      - name: "虚拟温度传感器_客厅"
        unique_id: virtual_temp_living
        unit_of_measurement: "°C"
        state: "{{ states('input_number.virtual_temp') | float }}"
        device_class: temperature

  - light:
      - name: "虚拟灯光_卧室"
        unique_id: virtual_light_bedroom
        state: "{{ states('input_boolean.virtual_bedroom_light') }}"
        brightness: "{{ states('input_number.virtual_brightness') | int }}"

  - climate:
      - name: "虚拟空调_客厅"
        unique_id: virtual_ac_living
        current_temperature: "{{ states('sensor.virtual_temp_living') | float }}"
        target_temperature: "{{ states('input_number.virtual_target_temp') | float }}"

input_number:
  virtual_temp:
    name: 虚拟温度值
    min: 0
    max: 50
    step: 0.1
    initial: 25.0

input_boolean:
  virtual_bedroom_light:
    name: 虚拟卧室灯
    initial: off
```

**MQTT 虚拟设备仿真器（Python）：**
```python
# simulator/device_simulator.py
import paho.mqtt.client as mqtt
import json
import time
import random
import threading

class SmartHomeSimulator:
    """
    电子沙盘虚拟设备仿真器
    满足合同第23、24条
    """

    def __init__(self, broker="localhost", port=1883):
        self.client = mqtt.Client(client_id="simulator")
        self.client.connect(broker, port)
        self.running = False

        # 虚拟设备定义
        self.devices = {
            "living_room": {
                "temperature": 25.0,
                "humidity": 60.0,
                "light_status": False,
                "ac_status": False,
                "ac_target_temp": 26.0,
            },
            "bedroom": {
                "temperature": 24.0,
                "humidity": 55.0,
                "light_status": False,
                "curtain_position": 100,  # 0=关闭, 100=全开
            },
            "kitchen": {
                "temperature": 28.0,
                "humidity": 70.0,
                "smoke_sensor": False,
                "exhaust_fan": False,
            }
        }

    def simulate_temperature(self, room: str):
        """模拟温度自然波动"""
        base = self.devices[room].get("temperature", 25.0)
        drift = random.uniform(-0.2, 0.2)
        new_temp = round(base + drift, 1)
        self.devices[room]["temperature"] = new_temp

        # 发布 MQTT 消息
        topic = f"smartHome/{room}/temperature"
        payload = json.dumps({
            "value": new_temp,
            "unit": "°C",
            "timestamp": time.time()
        })
        self.client.publish(topic, payload, retain=True)

    def handle_control_command(self, room: str, device: str, command: dict):
        """处理来自 HA 的控制指令"""
        if device == "light":
            self.devices[room]["light_status"] = command.get("state") == "on"
        elif device == "ac":
            self.devices[room]["ac_status"] = command.get("state") == "on"
            if "temperature" in command:
                self.devices[room]["ac_target_temp"] = command["temperature"]

        # 回报状态
        topic = f"smartHome/{room}/{device}/state"
        self.client.publish(topic, json.dumps(self.devices[room]), retain=True)

    def run(self):
        """启动仿真循环"""
        self.running = True
        self.client.loop_start()

        while self.running:
            for room in self.devices:
                self.simulate_temperature(room)
            time.sleep(5)  # 每5秒更新一次

if __name__ == "__main__":
    sim = SmartHomeSimulator()
    sim.run()
```

**满足合同条款：** 19、20、21、22、23、24

---

### 5.4 模块四：知识库与 RAG（Dify 内置）

> 直接使用 Dify 自带的知识库功能，无需额外部署 RAGFlow 或独立 Milvus。

**在 Dify 中创建知识库（Web UI 操作）：**

```
1. 进入 Dify → 知识库 → 创建知识库
2. 填写知识库名称（如：智慧家居知识库）
3. 上传文档（支持 PDF / Word / TXT / MD / HTML / CSV）
4. 选择分块策略（推荐：自动分块，chunk size 500）
5. 选择 Embedding 模型（使用本地 Ollama 的 bge-m3）
6. 点击保存并索引，等待向量化完成
```

**在 Agent 中绑定知识库：**

```
Dify Agent 配置 → 上下文 → 选择知识库
→ 检索模式：混合检索（语义 + 关键词）
→ Top K：5
→ Score 阈值：0.5
```

**通过 Dify API 查询知识库（供外部程序调用）：**

```python
# tools/rag_search.py
# 调用 Dify 内置知识库检索接口 - 对应合同第32、35条
import requests

class DifyKnowledgeSearchTool:
    """使用 Dify 内置知识库 API 进行语义检索"""

    def __init__(self):
        self.dify_url = "http://dify-api:5001"
        self.api_key = "your_dify_dataset_api_key"

    def search(self, query: str, dataset_id: str, top_k: int = 5) -> list:
        """语义检索 - 满足合同第35条"""
        resp = requests.post(
            f"{self.dify_url}/v1/datasets/{dataset_id}/retrieve",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "query": query,
                "retrieval_model": {
                    "search_method": "hybrid_search",
                    "top_k": top_k,
                    "score_threshold": 0.5,
                }
            }
        )
        return resp.json().get("records", [])

    def list_datasets(self) -> list:
        """列出所有知识库 - 满足合同第31条"""
        resp = requests.get(
            f"{self.dify_url}/v1/datasets",
            headers={"Authorization": f"Bearer {self.api_key}"}
        )
        return resp.json().get("data", [])
```

**文档增量更新（满足合同第34条）：**

```bash
# 通过 Dify API 上传新文档
curl -X POST "http://localhost/v1/datasets/{dataset_id}/document/create_by_file" \
  -H "Authorization: Bearer {api_key}" \
  -F "file=@/path/to/new_document.pdf" \
  -F 'data={"indexing_technique":"high_quality","process_rule":{"mode":"automatic"}}'

# 删除文档
curl -X DELETE "http://localhost/v1/datasets/{dataset_id}/documents/{document_id}" \
  -H "Authorization: Bearer {api_key}"
```

**满足合同条款：** 31、32、33、34、35

---

### 5.5 模块五：电子沙盘可视化（Streamlit）

```python
# sandbox/app.py
import streamlit as st
import requests
import json
import time
from datetime import datetime

st.set_page_config(
    page_title="智慧家居电子沙盘",
    page_icon="🏠",
    layout="wide"
)

HA_URL = "http://homeassistant:8123"
HA_TOKEN = "your_long_lived_token"
HEADERS = {"Authorization": f"Bearer {HA_TOKEN}"}

def get_all_states():
    """从 HA 获取所有设备状态"""
    resp = requests.get(f"{HA_URL}/api/states", headers=HEADERS)
    states = {s["entity_id"]: s for s in resp.json()}
    return states

def control_device(entity_id: str, service: str, **kwargs):
    """控制设备"""
    domain = entity_id.split(".")[0]
    requests.post(
        f"{HA_URL}/api/services/{domain}/{service}",
        headers=HEADERS,
        json={"entity_id": entity_id, **kwargs}
    )

# 主界面
st.title("🏠 智慧家居电子沙盘 - 虚拟设备系统")
st.caption(f"实时状态 | 最后更新: {datetime.now().strftime('%H:%M:%S')}")

# 自动刷新
if st.button("🔄 刷新状态") or True:
    states = get_all_states()

    # 三列布局：客厅 | 卧室 | 厨房
    col1, col2, col3 = st.columns(3)

    with col1:
        st.subheader("🛋️ 客厅")

        # 温度传感器
        temp = states.get("sensor.virtual_temp_living", {})
        if temp:
            st.metric("🌡️ 温度", f"{temp.get('state', '--')}°C")

        # 灯光控制
        light = states.get("light.virtual_bedroom_light", {})
        light_on = light.get("state") == "on"
        if st.toggle("💡 灯光", value=light_on, key="living_light"):
            control_device("light.virtual_bedroom_light", "turn_on")
        else:
            control_device("light.virtual_bedroom_light", "turn_off")

        # 空调控制
        ac = states.get("climate.virtual_ac_living", {})
        ac_temp = st.slider("❄️ 空调温度", 16, 30, 26, key="living_ac")
        if st.button("开启空调", key="ac_on"):
            control_device("climate.virtual_ac_living", "set_temperature",
                          temperature=ac_temp)

    with col2:
        st.subheader("🛏️ 卧室")
        temp2 = states.get("sensor.virtual_temp_bedroom", {})
        if temp2:
            st.metric("🌡️ 温度", f"{temp2.get('state', '--')}°C")
        st.info("更多设备可在此添加...")

    with col3:
        st.subheader("🍳 厨房")
        temp3 = states.get("sensor.virtual_temp_kitchen", {})
        if temp3:
            st.metric("🌡️ 温度", f"{temp3.get('state', '--')}°C")
        smoke = states.get("binary_sensor.virtual_smoke_kitchen", {})
        if smoke.get("state") == "on":
            st.error("⚠️ 烟雾警报！")
        else:
            st.success("✅ 环境正常")

# 底部：AI 快速控制
st.divider()
st.subheader("🤖 AI 快速指令")
user_input = st.text_input("输入自然语言指令（例：打开客厅的灯）")
if st.button("执行") and user_input:
    # 调用 Dify API 执行指令
    st.info(f"正在处理：{user_input}")
```

**满足合同条款：** 23、24、37、38、39

---

### 5.6 模块六：Web 统一门户（Nginx）

```nginx
# nginx/nginx.conf
worker_processes auto;
events { worker_connections 1024; }

http {
    upstream ollama_webui { server open-webui:3000; }
    upstream dify_api     { server dify-api:5001; }
    upstream dify_web     { server dify-web:3000; }
    upstream homeassistant{ server homeassistant:8123; }
    upstream jupyterlab   { server jupyter:8888; }
    upstream grafana      { server grafana:3000; }
    upstream sandbox      { server streamlit:8501; }

    server {
        listen 80;

        # 主页 → Open WebUI
        location / {
            proxy_pass http://ollama_webui;
            proxy_set_header Host $host;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }

        # 智能体管理
        location /agent/ {
            proxy_pass http://dify_web/;
        }
        location /v1/ {
            proxy_pass http://dify_api/v1/;
        }

        # 智能家居
        location /home/ {
            proxy_pass http://homeassistant/;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }

        # Jupyter
        location /jupyter/ {
            proxy_pass http://jupyterlab/;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }

        # 监控
        location /monitor/ {
            proxy_pass http://grafana/;
        }

        # 电子沙盘
        location /sandbox/ {
            proxy_pass http://sandbox/;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }
}
```

**满足合同条款：** 8、36、37、38、39

---

## 6. 目录结构与工程组织

```
smart-home-llm/                          # 项目根目录
├── README.md                            # 项目说明
├── docker-compose.yml                   # 一键部署配置
├── .env                                 # 环境变量（不提交git）
├── .env.example                         # 环境变量模板
│
├── docs/                                # MkDocs 文档站（合同40条）
│   ├── mkdocs.yml
│   ├── index.md                         # 首页
│   ├── getting-started/
│   │   ├── installation.md              # 安装指南
│   │   ├── quick-start.md               # 快速开始
│   │   └── configuration.md            # 配置说明
│   ├── user-guide/
│   │   ├── model-management.md          # 模型管理
│   │   ├── agent-creation.md            # 智能体创建
│   │   ├── knowledge-base.md            # 知识库管理
│   │   └── smart-home.md               # 智能家居对接
│   └── developer-guide/
│       ├── api-reference.md             # API文档
│       ├── tool-development.md          # 工具开发指南
│       └── templates.md                 # 模板使用指南
│
├── models/                              # 模型相关（gitignore大文件）
│   └── .gitkeep
│
├── nginx/                               # Nginx 配置
│   ├── nginx.conf
│   └── ssl/                             # SSL 证书（如需）
│
├── homeassistant/                       # HA 配置
│   ├── configuration.yaml               # 主配置
│   ├── virtual_devices.yaml             # 虚拟设备定义
│   ├── automations.yaml                 # 自动化规则
│   └── custom_components/              # 自定义集成
│
├── simulator/                           # 虚拟设备仿真器
│   ├── device_simulator.py
│   ├── Dockerfile
│   ├── requirements.txt
│   └── scenarios/                       # 预设场景
│       ├── normal_day.json
│       ├── high_energy.json
│       └── security_alert.json
│
├── sandbox/                             # 电子沙盘 Streamlit 应用
│   ├── app.py
│   ├── Dockerfile
│   ├── requirements.txt
│   └── pages/
│       ├── 01_floor_plan.py             # 平面图可视化
│       ├── 02_history_data.py           # 历史数据分析
│       └── 03_ai_control.py             # AI 指令控制
│
├── dify-tools/                          # Dify 自定义工具
│   ├── ha_control.py                    # 设备控制
│   ├── ha_query.py                      # 状态查询
│   ├── rag_search.py                    # 知识库检索
│   ├── file_system.py                   # 文件操作
│   └── schemas/                         # OpenAPI 工具描述
│       ├── ha_control_schema.yaml
│       ├── ha_query_schema.yaml
│       └── rag_search_schema.yaml
│
├── dify-templates/                      # 智能体模板（合同25条）
│   ├── 01_voice_assistant/
│   │   ├── app.yaml                     # Dify DSL 导出
│   │   └── README.md
│   ├── 02_energy_optimizer/
│   ├── 03_security_monitor/
│   ├── 04_scene_automation/
│   └── 05_research_assistant/
│
├── notebooks/                           # Jupyter Notebook 示例
│   ├── 01_model_inference.ipynb         # 模型推理测试
│   ├── 02_rag_demo.ipynb               # RAG 演示
│   ├── 03_ha_api_tutorial.ipynb         # HA API 教程
│   ├── 04_agent_evaluation.ipynb        # 智能体评估
│   └── 05_virtual_device_demo.ipynb     # 虚拟设备演示
│
├── sdk/                                  # Python 开发 SDK（合同26条）
│   ├── smart_home_llm/
│   │   ├── __init__.py
│   │   ├── client.py                    # 统一客户端
│   │   ├── ha.py                        # HA 封装
│   │   ├── llm.py                       # LLM 封装
│   │   └── rag.py                       # RAG 封装
│   ├── setup.py
│   └── examples/
│       ├── basic_chat.py
│       ├── device_control.py
│       └── rag_qa.py
│
├── grafana/                             # 监控配置（合同39条）
│   ├── provisioning/
│   │   ├── dashboards/
│   │   │   └── main_dashboard.json
│   │   └── datasources/
│   │       └── influxdb.yaml
│   └── dashboards/
│
└── scripts/                             # 运维脚本
    ├── init.sh                          # 初始化脚本
    ├── backup.sh                        # 数据备份
    ├── model_download.sh                # 模型预下载
    └── health_check.sh                  # 健康检查
```

---

## 7. Docker Compose 一键部署方案

```yaml
# docker-compose.yml
version: "3.9"

# 网络
networks:
  smart-home-net:
    driver: bridge

# 存储卷
volumes:
  ollama_data:
  dify_db_data:
  dify_redis_data:
  dify_storage:
  ha_config:
  jupyter_data:
  influxdb_data:
  grafana_data:
  # ragflow_data:   # 暂不使用，Dify 内置知识库已满足需求
  # milvus_data:    # 暂不使用，Dify 内置 Weaviate 已满足需求

services:
  # ═══════════════════════════════════════════
  # 1. 模型推理层
  # ═══════════════════════════════════════════
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: unless-stopped
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    networks:
      - smart-home-net

  # Open WebUI（模型对话界面）
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    container_name: open-webui
    restart: unless-stopped
    ports:
      - "3000:8080"
    environment:
      - OLLAMA_BASE_URL=http://ollama:11434
      - WEBUI_AUTH=false
    depends_on:
      - ollama
    networks:
      - smart-home-net

  # ═══════════════════════════════════════════
  # 2. 数据层
  # ═══════════════════════════════════════════
  postgres:
    image: postgres:15-alpine
    container_name: dify-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: dify
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-difypassword}
      POSTGRES_DB: dify
    volumes:
      - dify_db_data:/var/lib/postgresql/data
    networks:
      - smart-home-net

  redis:
    image: redis:7-alpine
    container_name: dify-redis
    restart: unless-stopped
    command: redis-server --requirepass ${REDIS_PASSWORD:-redispassword}
    volumes:
      - dify_redis_data:/data
    networks:
      - smart-home-net

  # milvus:  # 暂不启用，Dify 内置 Weaviate 已满足向量检索需求
  #   image: milvusdb/milvus:v2.4-latest
  #   如后期需要更强向量性能，取消注释并配置

  influxdb:
    image: influxdb:2.7-alpine
    container_name: influxdb
    restart: unless-stopped
    ports:
      - "8086:8086"
    volumes:
      - influxdb_data:/var/lib/influxdb2
    environment:
      DOCKER_INFLUXDB_INIT_MODE: setup
      DOCKER_INFLUXDB_INIT_USERNAME: admin
      DOCKER_INFLUXDB_INIT_PASSWORD: ${INFLUX_PASSWORD:-influxpassword}
      DOCKER_INFLUXDB_INIT_ORG: smart-home
      DOCKER_INFLUXDB_INIT_BUCKET: smart-home-data
    networks:
      - smart-home-net

  # ═══════════════════════════════════════════
  # 3. 智能体层（Dify）
  # ═══════════════════════════════════════════
  dify-api:
    image: langgenius/dify-api:latest
    container_name: dify-api
    restart: unless-stopped
    depends_on:
      - postgres
      - redis
    environment:
      MODE: api
      SECRET_KEY: ${DIFY_SECRET_KEY:-sk-your-secret-key}
      DB_USERNAME: dify
      DB_PASSWORD: ${POSTGRES_PASSWORD:-difypassword}
      DB_HOST: postgres
      DB_DATABASE: dify
      REDIS_HOST: redis
      REDIS_PASSWORD: ${REDIS_PASSWORD:-redispassword}
      STORAGE_TYPE: local
      STORAGE_LOCAL_PATH: /app/api/storage
    volumes:
      - dify_storage:/app/api/storage
    networks:
      - smart-home-net

  dify-worker:
    image: langgenius/dify-api:latest
    container_name: dify-worker
    restart: unless-stopped
    depends_on:
      - dify-api
    environment:
      MODE: worker
      SECRET_KEY: ${DIFY_SECRET_KEY:-sk-your-secret-key}
      DB_USERNAME: dify
      DB_PASSWORD: ${POSTGRES_PASSWORD:-difypassword}
      DB_HOST: postgres
      DB_DATABASE: dify
      REDIS_HOST: redis
      REDIS_PASSWORD: ${REDIS_PASSWORD:-redispassword}
    volumes:
      - dify_storage:/app/api/storage
    networks:
      - smart-home-net

  dify-web:
    image: langgenius/dify-web:latest
    container_name: dify-web
    restart: unless-stopped
    environment:
      CONSOLE_API_URL: http://dify-api:5001
      APP_API_URL: http://dify-api:5001
    networks:
      - smart-home-net

  # 知识库：使用 Dify 内置知识库，无需独立部署 RAGFlow
  # 如需接入 RAGFlow，参考文档中"扩展建议"章节

  # ═══════════════════════════════════════════
  # 4. 智能家居层（Home Assistant）
  # ═══════════════════════════════════════════
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    container_name: homeassistant
    restart: unless-stopped
    privileged: true
    ports:
      - "8123:8123"
    volumes:
      - ha_config:/config
      - ./homeassistant:/config/custom
    environment:
      TZ: Asia/Shanghai
    networks:
      - smart-home-net

  mosquitto:
    image: eclipse-mosquitto:2
    container_name: mosquitto
    restart: unless-stopped
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto/config:/mosquitto/config
    networks:
      - smart-home-net

  # ═══════════════════════════════════════════
  # 6. 虚拟仿真层
  # ═══════════════════════════════════════════
  device-simulator:
    build: ./simulator
    container_name: device-simulator
    restart: unless-stopped
    depends_on:
      - mosquitto
    environment:
      MQTT_BROKER: mosquitto
    networks:
      - smart-home-net

  sandbox:
    build: ./sandbox
    container_name: sandbox
    restart: unless-stopped
    ports:
      - "8501:8501"
    environment:
      HA_URL: http://homeassistant:8123
      HA_TOKEN: ${HA_LONG_LIVED_TOKEN}
    depends_on:
      - homeassistant
    networks:
      - smart-home-net

  # ═══════════════════════════════════════════
  # 7. 开发工具层
  # ═══════════════════════════════════════════
  jupyterlab:
    image: jupyter/scipy-notebook:latest
    container_name: jupyterlab
    restart: unless-stopped
    ports:
      - "8888:8888"
    volumes:
      - jupyter_data:/home/jovyan/work
      - ./notebooks:/home/jovyan/notebooks
    environment:
      JUPYTER_ENABLE_LAB: "yes"
      JUPYTER_TOKEN: ${JUPYTER_TOKEN:-smarthomelabtoken}
    networks:
      - smart-home-net

  code-server:
    image: codercom/code-server:latest
    container_name: code-server
    restart: unless-stopped
    ports:
      - "8090:8080"
    volumes:
      - ./:/home/coder/project
    environment:
      PASSWORD: ${CODE_SERVER_PASSWORD:-codepassword}
    networks:
      - smart-home-net

  # ═══════════════════════════════════════════
  # 8. 监控层
  # ═══════════════════════════════════════════
  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    restart: unless-stopped
    ports:
      - "3100:3000"
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD:-grafanapassword}
    depends_on:
      - influxdb
    networks:
      - smart-home-net

  # ═══════════════════════════════════════════
  # 9. 统一网关（Nginx）
  # ═══════════════════════════════════════════
  nginx:
    image: nginx:alpine
    container_name: nginx
    restart: unless-stopped
    ports:
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - open-webui
      - dify-web
      - homeassistant
      - jupyterlab
      - grafana
      - sandbox
    networks:
      - smart-home-net
```

**启动命令：**
```bash
# 1. 初始化
cp .env.example .env
vim .env  # 修改密码等配置

# 2. 启动所有服务
docker compose up -d

# 3. 下载模型（首次运行）
bash scripts/model_download.sh

# 4. 初始化 HA、Dify 等服务
bash scripts/init.sh

# 5. 查看状态
docker compose ps

# 访问地址（默认）
# 主界面：http://localhost/
# 智能体：http://localhost/agent/
# 家居：  http://localhost/home/
# 知识库：http://localhost/knowledge/
# Jupyter：http://localhost/jupyter/
# 监控：   http://localhost/monitor/
# 沙盘：   http://localhost/sandbox/
```

---

## 8. 开发路线图（分阶段实施）

### Phase 0：环境准备（第1-2天）

```
□ 安装 Docker Engine + NVIDIA Container Toolkit
□ 配置 GPU 驱动（确认 cuda 版本与 docker 兼容）
□ clone 本项目，配置 .env 文件
□ 运行 docker compose up -d，验证所有容器启动
□ 运行健康检查脚本 health_check.sh
```

### Phase 1：核心推理（第3-5天）

```
□ Ollama 启动，下载 Qwen2.5-7B 量化模型
□ 验证 API：curl http://localhost:11434/api/chat
□ Open WebUI 连通性测试（能否对话）
□ 下载 bge-m3 embedding 模型
□ 测试量化效果（INT4 vs INT8 速度/质量对比）
□ 截图：模型管理界面（用于合同投标）
```

### Phase 2：智能体框架（第6-10天）

```
□ Dify 完成初始化（admin 账号设置）
□ Dify 连接本地 Ollama 模型
□ 创建第一个 ChatBot 应用，测试多轮对话
□ 开发 ha_control 工具插件（Python）
□ 开发 ha_query 工具插件（Python）
□ 开发 rag_search 工具插件（Python）
□ 开发 file_system 工具插件（Python）
□ 创建 Agent 应用，绑定4个工具
□ 测试 Agent 调用工具的能力
□ 截图：工具调用界面（合同▲14条投标截图）
```

### Phase 3：知识库与 RAG（第11-13天）

> 使用 Dify 内置知识库，无需额外部署服务，直接在 Dify UI 里操作。

```
□ 在 Dify 中进入"知识库"页面，创建第一个知识库
□ 上传示例文档（PDF/Word/MD 各一份，验证多格式支持）
□ 配置 Embedding 模型（连接本地 Ollama 的 bge-m3）
□ 等待向量化完成，验证文档已被分块索引
□ 在 Dify Agent 中绑定知识库，测试 RAG 问答效果
□ 测试增量更新：添加新文档、删除旧文档
□ 开发 rag_search 工具（调用 Dify 知识库 API）
□ 验证 Agent 能调用知识库工具返回相关内容
```

### Phase 4：智能家居对接（第14-18天）

> 先做虚拟设备（不需要真实硬件），再考虑真实设备接入。

```
□ Home Assistant 初始化配置（Docker 启动，设置账号）
□ 配置 MQTT Broker（Mosquitto）
□ 编写 virtual_devices.yaml，在 HA 中创建虚拟设备
  （虚拟灯光、虚拟温度传感器、虚拟空调各至少一个）
□ 启动 device_simulator.py，验证 MQTT 数据推送正常
□ 验证 HA 虚拟设备状态随仿真数据变化
□ HA Lovelace 仪表板配置（显示虚拟设备状态）
□ 在 Dify 中开发 ha_control / ha_query 工具插件
□ 测试 Agent 通过工具成功控制虚拟设备
□ 截图：AI控制虚拟设备演示（合同▲23条投标截图）
```

### Phase 5：电子沙盘与可视化（第19-22天）

```
□ Streamlit 电子沙盘开发（房间平面图布局）
□ 接入 HA REST API，实时显示虚拟设备状态
□ 实现点击控制（调用 HA Service API）
□ 集成 AI 快速指令输入框（调用 Dify API）
□ Grafana 监控仪表板（系统资源、对话请求统计）
□ JupyterLab 示例 Notebook 完善（5个示例）
```

### Phase 6：门户整合与文档（第23-25天）

```
□ Nginx 统一门户配置完成
□ 所有 7 个服务通过 Nginx 可访问
□ MkDocs 文档站搭建（功能说明、操作指南、FAQ）
□ 5个 Dify 应用模板整理并导出 YAML
□ Python SDK 基础功能完善
□ 系统整体集成测试
□ 性能压测（并发对话测试）
□ 最终截图整理（用于投标材料）
```

---

## 9. 合同强制项（▲标）专项说明

合同中有3个 ▲ 标（强制要求，投标时须提供产品功能截图并加盖公章）：

### ▲ 第7条：合规开源+支持二次开发

**截图内容需要展示：**
1. Ollama 模型列表页面（显示 Qwen2.5 已加载）
2. Dify 工作流编辑器（显示节点可视化编排）
3. GitHub/Gitee 项目地址（体现开源可二次开发）
4. 代码仓库结构截图（custom_components 等扩展目录）

**关键文件需准备：**
```
- 开源协议说明文档（列出所有组件及其协议）
- 二次开发接口文档（API Reference）
- 自定义工具开发说明
```

### ▲ 第14条：4种接口调用

**截图内容需要展示：**
1. Dify Agent 工具列表（4种工具显示：控制/查询/知识库/文件）
2. Agent 实际执行时调用工具的过程截图（工具调用日志）
3. 每种接口的调用示例（Swagger/API 文档截图）

**操作流程（用于生成截图）：**
```
1. 打开 Dify，进入 Agent 应用
2. 输入："把客厅灯调到50%亮度"
3. 截图：Agent 调用 ha_control 工具的过程
4. 输入："查询客厅当前温度"
5. 截图：Agent 调用 ha_query 工具返回结果
6. 输入："查询知识库中关于节能的建议"
7. 截图：Agent 调用 rag_search 工具返回结果
```

### ▲ 第23条：虚拟设备/电子沙盘

**截图内容需要展示：**
1. Streamlit 电子沙盘主界面（显示虚拟家居平面图）
2. 虚拟设备状态实时更新（温度传感器数值变化）
3. 通过界面点击控制虚拟设备（控制前后对比）
4. Home Assistant 后台显示虚拟实体列表
5. MQTT 仿真器运行日志截图

---

## 10. 风险与注意事项

### 10.1 技术风险

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| GPU 驱动兼容问题 | 中 | 高 | 提前测试 CUDA 版本，准备 CPU 降级方案 |
| Dify 与 Ollama 版本兼容 | 低 | 中 | 固定版本号，不用 latest 标签 |
| Dify 知识库向量化速度慢 | 低 | 低 | bge-m3 本地运行，速度取决于文档量，正常可接受 |
| HA 虚拟设备 YAML 语法错误 | 中 | 中 | 使用 HA 配置检查工具（Developer Tools → Check config）验证 |
| 模型推理速度不达预期 | 低 | 中 | 使用 INT4 量化，调整 context window 大小 |

### 10.2 合规注意事项

```
✅ 所有模型必须使用国内可公开访问的开源模型（Qwen、DeepSeek 等）
✅ 避免使用 Meta LLaMA（版权限制）、GPT 系列（商业限制）
✅ Dify、Home Assistant、Ollama 均为 Apache/MIT 协议，可商用
✅ 项目代码建议使用 Apache 2.0 或 MIT 开源协议
⚠️  注意：合同要求提供"符合国家法律法规"的说明文档
```

### 10.3 性能基准参考

```
Qwen2.5-7B INT4 + RTX 4080(16G)：
- 推理速度：约 30-50 tokens/秒
- 首次响应延迟：< 2秒
- 支持并发：2-3 个同时对话
- 内存占用：约 10-12G 显存

完整系统运行（去掉 RAGFlow/Milvus 后）：
- 内存使用：约 18-22GB（比原方案节省约 4-6GB）
- CPU 使用：40-60%（空载推理时）
- 磁盘需求：约 25-40GB（含模型文件）
```

### 10.4 扩展建议

```
短期（投标/验收阶段）：
- 专注P0条款，确保▲标项目有清晰截图
- 优先实现端到端演示：用户说话 → AI理解 → 控制虚拟设备

中期（科研应用深化）：
- 增加更多预置 Agent 模板（节能优化、安防、老人看护等）
- 接入真实 Zigbee/Z-Wave 设备（需要真实硬件配合）
- 加入实验数据记录与分析功能
- 如知识库需求增大，可接入 RAGFlow（改 rag_search.py 一个文件即可）

长期（平台化方向）：
- 支持多用户权限管理
- 增加模型微调功能（基于科研数据）
- 接入更多 AI 能力（图像识别、语音唤醒）
```

---

## 附录 A：环境变量说明（.env.example）

```bash
# 数据库密码
POSTGRES_PASSWORD=change_me_postgres
REDIS_PASSWORD=change_me_redis

# Dify 密钥
DIFY_SECRET_KEY=change_me_32char_secret_key

# Home Assistant（首次启动后在 HA 中生成长期令牌粘贴到这里）
HA_LONG_LIVED_TOKEN=paste_your_ha_token_here

# Jupyter
JUPYTER_TOKEN=change_me_jupyter_token

# 其他
GRAFANA_PASSWORD=change_me_grafana
CODE_SERVER_PASSWORD=change_me_code
INFLUX_PASSWORD=change_me_influx

# 以下为可选扩展服务（暂不使用）
# RAGFLOW_API_KEY=  # 若后期接入 RAGFlow 再填写
```

---

## 附录 B：常用命令速查

```bash
# 查看所有服务状态
docker compose ps

# 查看某服务日志
docker compose logs -f ollama

# 下载模型
docker exec ollama ollama pull qwen2.5:7b
docker exec ollama ollama pull bge-m3

# 重启某服务
docker compose restart homeassistant

# 停止所有服务
docker compose down

# 完全清理（危险！）
docker compose down -v

# 检查 GPU 状态
docker exec ollama nvidia-smi

# 进入 JupyterLab 容器
docker exec -it jupyterlab bash

# 查看系统资源使用
docker stats
```

---

## 附录 C：技术栈一览表

| 组件 | 版本 | 用途 | 协议 | 合同条款 |
|------|------|------|------|---------|
| Qwen2.5-7B | latest | 主语言模型 | Apache-like | 9、10 |
| BAAI/bge-m3 | latest | Embedding模型 | MIT | 32 |
| Ollama | latest | 模型推理引擎 | MIT | 10、11、12 |
| Open WebUI | latest | 对话管理界面 | MIT | 36 |
| Dify CE | latest | 智能体框架 + 知识库管理 | Apache 2.0 | 13-18、25-30、31-35 |
| Weaviate | 内置 | 向量数据库（Dify内置，无需独立部署） | BSD-3 | 32 |
| Home Assistant | stable | 智能家居中控 | Apache 2.0 | 19-24 |
| Mosquitto | 2 | MQTT Broker | EPL-2.0 | 19、20 |
| JupyterLab | latest | 交互式开发环境 | BSD | 29 |
| Streamlit | latest | 电子沙盘UI | Apache 2.0 | 23、38 |
| Grafana | latest | 数据监控 | AGPL-3.0 | 39 |
| code-server | latest | 在线IDE | MIT | 28 |
| Nginx | alpine | 统一反代网关 | BSD | 8 |
| PostgreSQL | 15 | 结构化数据库 | PostgreSQL | — |
| Redis | 7 | 缓存队列 | BSD | — |
| InfluxDB | 2.7 | 时序数据库 | MIT | 39 |

---

> 文档生成日期：2026-03-08
> 如需更新某模块的详细实现代码，请告知具体需求
