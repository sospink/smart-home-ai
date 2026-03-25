## 幻灯片 1

智慧家居大语言模型
智能体科研应用一体机
基于江门定开产品合同 · 40项技术要求全覆盖
技术路线：Ollama + Dify + Home Assistant + Docker
硬件环境：≥16核CPU | ≥32G内存 | ≥16G显存GPU
文档日期：2026-03-08
全栈 + AI工程师
从 0 → 1 实施方案

---

## 幻灯片 2

目录 · CONTENTS
01
项目定位与核心价值
Project Positioning
02
合同需求 · 40项技术要求全景
Contract Requirements Overview
03
技术选型决策
Technology Stack Decisions
04
系统架构设计
System Architecture
05
分阶段开发路线图
Phased Roadmap
06
▲合同强制项专项说明
Mandatory Requirements
07
部署方案 · Docker Compose
Deployment Plan
08
风险与交付策略
Risk & Delivery

---

## 幻灯片 3

01  项目定位与核心价值
🔒
完全离线部署
无外网依赖，全组件本地化
支持无网络环境运行
🤖
三合一集成平台
LLM + 智能体框架 + 智慧家居
一体机形态，开箱即用
🔬
科研与教学专用
支持科研复现与二次开发
面向高校实验室场景
🏠
虚拟电子沙盘
无真实硬件也可做实验
HA虚拟实体 + 可视化面板
项目本质：一台面向高校科研场景的本地化 AI 智能家居实验平台
甲方：江门客户（定开合同） ｜ 执行：全栈+AI工程师 ｜ 合同技术条款：40项全覆盖

---

## 幻灯片 4

02  合同需求 · 40项技术要求全景
1-4
4 项
硬件规格
5-8
4 项
系统基础能力
9-12
4 项
大语言模型服务
13-18
6 项
智能体框架
19-24
6 项
智慧家居对接
25-30
6 项
应用模板库
31-35
5 项
知识库与RAG
36-40
5 项
Web管理界面
▲ 强制交付项：条款 7（合规开源）、条款 14（4种接口）、条款 23（虚拟设备/电子沙盘）

---

## 幻灯片 5

03  技术选型决策
LLM推理
Ollama
Qwen2.5-7B-Instruct（INT4）
OpenAI兼容接口，INT4量化，一键管理多模型
智能体框架
Dify CE
Docker本地部署，Web UI完整
可视化工作流，内置RAG，Tool插件，Apache 2.0
知识库
Dify内置知识库
PDF/Word/MD/TXT/HTML/CSV
无需额外部署，内置Weaviate，混合检索，满足合同需求
智慧家居
Home Assistant
Container版 + Mosquitto
REST API + MQTT，虚拟实体支持，最大生态
统一网关
Nginx
端口映射：80/443统一入口
反代各服务，统一访问入口，SSL终结
数据层
PG + Redis + InfluxDB
Docker Compose编排
Dify结构化 + 缓存 + 时序数据（HA设备）

---

## 幻灯片 6

04  系统架构设计
用户访问层
浏览器/客户端
统一网关
Nginx 反向代理（:80/:443）
应用服务层
Dify CE（智能体）
Open WebUI（对话）
HA Lovelace（家居）
Streamlit（沙盘）
能力支撑层
Ollama（LLM推理）
Dify知识库（RAG）
JupyterLab（开发）
Grafana（监控）
智慧家居层
Home Assistant
MQTT Broker
HA Template虚拟实体
数据存储层
PostgreSQL
Redis
InfluxDB（时序）
Weaviate（向量）

---

## 幻灯片 7

05  分阶段开发路线图（6个Phase）
Phase 1
1-2周
基础环境搭建
▸ Docker Compose一键部署
▸ Ollama + Qwen2.5-7B推理验证
▸ Dify CE基础配置
▸ Nginx统一网关
Phase 2
2-3周
LLM+智能体核心
▸ Dify工作流Agent开发
▸ ▲4种接口调用实现
▸ Open WebUI对话界面
▸ API测试与文档
Phase 3
2周
知识库与RAG
▸ Dify内置知识库配置
▸ Embedding模型接入
▸ RAG检索效果调优
▸ 知识库API封装
Phase 4
3-4周
智慧家居对接
▸ Home Assistant安装配置
▸ ▲虚拟设备/电子沙盘
▸ Dify-HA Tool插件
▸ MQTT仿真器开发
Phase 5
1-2周
应用模板库
▸ 5+预置Dify工作流模板
▸ Python开发SDK
▸ JupyterLab示例集
▸ MkDocs文档站
Phase 6
1-2周
集成测试与交付
▸ 40项合同条款验收
▸ Grafana监控配置
▸ 部署文档编写
▸ 甲方演示与培训

---

## 幻灯片 8

06  ▲合同强制项专项说明（投标截图要求）
▲7
合规开源 + 支持二次开发
✓ Ollama：MIT 开源协议
✓ Dify CE：Apache 2.0 协议
✓ Home Assistant：Apache 2.0 协议
✓ 所有组件均可商用、可修改、可分发
✓ 预置 Python SDK 脚手架，支持扩展
✓ 完整源码，不含私有云服务依赖
▲14
4种接口调用实现
✓ ① 文本生成接口：/api/chat（OpenAI兼容）
✓ ② 设备控制接口：/api/ha/control（HA REST API）
✓ ③ 状态查询接口：/api/ha/states（HA WebSocket）
✓ ④ 知识库检索接口：/api/rag/search（Dify知识库API）
✓ 所有接口通过 Dify Tool 插件封装
✓ 提供 Postman 集合 + Jupyter 演示 Notebook
▲23
虚拟设备 / 电子沙盘
✓ HA Template Entity 创建虚拟灯/空调/传感器
✓ Python MQTT 仿真器推送模拟数据
✓ Streamlit 可视化沙盘面板（实时更新）
✓ HA Lovelace Dashboard 设备状态展示
✓ 第二阶段完成虚拟实体，第三阶段完成可视化
✓ 无需真实设备即可完成所有实验演示

---

## 幻灯片 9

07  部署方案 · Docker Compose 一键启动
服务组件清单
ollama
:11434
LLM推理引擎
dify-api
:5001
智能体框架API
dify-web
:3000
智能体前端UI
open-webui
:8080
对话交互界面
homeassistant
:8123
智慧家居中控
mosquitto
:1883
MQTT Broker
jupyterlab
:8888
科研开发环境
streamlit
:8501
虚拟沙盘可视化
grafana
:3001
系统监控面板
nginx
:80/443
统一反代网关
统一访问入口（Nginx）
/
→
Dify Web UI（主入口）
/open-webui
→
Open WebUI 对话界面
/homeassistant
→
Home Assistant 家居中控
/jupyter
→
JupyterLab 开发环境
/grafana
→
Grafana 监控面板
/streamlit
→
Streamlit 虚拟沙盘
/api/v1
→
Ollama OpenAI兼容API
一键启动命令：
$ docker compose up -d

---

## 幻灯片 10

08  风险识别与交付策略
高
GPU显存不足
应对：INT4量化降低显存占用；若RTX 4060(8G)则换DeepSeek-R1-7B-Q4
中
▲23虚拟沙盘工期
应对：Phase 2完成HA虚拟实体，Phase 3完成Streamlit可视化，分层交付
中
合同▲标投标截图
应对：▲7/▲14/▲23 三项在Phase 2前必须完成截图，提前验收
低
Dify版本兼容性
应对：锁定版本号，docker-compose.yml固定image tag，不使用latest
低
开发工期超期
应对：Phase 1-3核心功能优先，Phase 4-6可并行；总工期控制12-14周

---

## 幻灯片 11

交付物清单 · Deliverables
软件系统
● 完整 Docker Compose 一键部署包
● 10+ 服务容器编排（含环境变量配置）
● 5+ Dify 工作流应用模板
● 4种合同要求接口实现（▲14）
● Python SDK + Jupyter Notebook 示例集
文档资料
● 项目规划文档（本文档）
● 系统部署与运维手册
● API接口文档（Postman集合）
● MkDocs 文档站（在线访问）
● 合同40项条款验收清单
演示验收
● 甲方演示 PPT（本文件）
● 功能演示录屏视频
● ▲7/▲14/▲23 投标截图素材
● Grafana 监控面板
● 完整测试报告

---

## 幻灯片 12

Thank You
智慧家居LLM智能体一体机项目
项目交付时间：约 12-14 周
技术栈：Ollama · Dify · Home Assistant · Docker
合同条款：40 项全覆盖，▲强制3项重点保障
随时开始，准备就绪 🚀
40
合同技术条款
6
开发阶段
10+
容器服务
14周
预计工期

---
