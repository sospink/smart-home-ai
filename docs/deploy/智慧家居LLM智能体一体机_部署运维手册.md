智慧家居大语言模型智能体科研应用一体机
部署与运维操作手册
文档版本：v1.0
编写日期：2026-03-08
执行工程师：全栈+AI工程师
项目合同：江门定开产品合同（40项技术要求）
硬件环境：≥16核CPU | ≥32G内存 | ≥16G显存GPU

💡 说明：本手册涵盖：系统部署、日常运维、模型管理、故障排查、▲合同强制项验收全流程。适合具备基础Linux和Docker操作经验的工程师使用。

# 目录

# 第一章：环境要求与快速部署
## 1.1 硬件要求
在部署本系统之前，请确认服务器满足以下最低配置要求：
## 1.2 软件依赖安装
⚠️ 注意：以下命令在 Ubuntu 22.04 LTS 环境下执行，需要 root 或 sudo 权限。
### 1.2.1 安装 Docker & Docker Compose
# 更新包索引
sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg

# 添加 Docker GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

# 安装 Docker Engine & Compose
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 将当前用户加入 docker 组（无需 sudo 运行 docker）
sudo usermod -aG docker $USER && newgrp docker

# 验证安装
docker --version && docker compose version
### 1.2.2 安装 NVIDIA Container Toolkit（GPU支持）
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 验证 GPU 可用
docker run --rm --gpus all nvidia/cuda:12.4-base-ubuntu22.04 nvidia-smi
## 1.3 获取项目文件
# 克隆项目仓库（或解压交付包）
git clone <项目仓库URL> smart-home-llm
cd smart-home-llm

# 或从交付包解压
unzip 智慧家居LLM一体机_交付包.zip
cd smart-home-llm
## 1.4 环境变量配置
复制示例配置文件并按需修改：
cp .env.example .env
vi .env   # 修改以下关键配置
需要重点配置的变量：
SECRET_KEY — Dify加密密钥（生产环境必须修改）
POSTGRES_PASSWORD — 数据库密码（必须修改默认值）
INFLUXDB_PASSWORD — InfluxDB密码
HA_TOKEN — Home Assistant长期访问令牌（部署HA后生成）
OLLAMA_HOST — Ollama访问地址（默认 http://ollama:11434）
## 1.5 一键启动所有服务
# 首次启动（会拉取镜像，约需 10-20 分钟）
docker compose up -d

# 查看启动状态
docker compose ps

# 查看实时日志
docker compose logs -f
💡 说明：首次启动时 Dify 需要约 1-2 分钟完成数据库初始化，请等待 dify-api 日志出现 'Application startup complete' 再访问 Web UI。
## 1.6 访问各服务界面
所有服务通过 Nginx 统一入口访问（默认 http://服务器IP）：

⚠️ 注意：默认 Dify 管理员账号需要首次访问 http://服务器IP 时完成注册，之后即为管理员账号。

# 第二章：大语言模型管理
## 2.1 模型列表与推荐配置
## 2.2 拉取与切换模型
# 拉取主力模型（约4.7GB，需要等待）
docker exec ollama ollama pull qwen2.5:7b-instruct-q4_K_M

# 拉取 Embedding 模型
docker exec ollama ollama pull bge-m3

# 列出已安装模型
docker exec ollama ollama list

# 删除不需要的模型（释放磁盘空间）
docker exec ollama ollama rm <model_name>

# 查看当前运行中的模型和显存占用
docker exec ollama ollama ps
## 2.3 在 Dify 中配置模型
登录 Dify Web UI（http://服务器IP）
点击右上角头像 → 设置 → 模型供应商
选择 Ollama，填写 Base URL：http://ollama:11434
添加模型：输入模型名称（如 qwen2.5:7b-instruct-q4_K_M），保存
设置 Embedding 模型：同上步骤，模型名填 bge-m3，类型选 Text Embedding
⚠️ 注意：Dify 中填写的 Ollama 地址必须使用 Docker 内网地址 http://ollama:11434，不能用 localhost。
## 2.4 通过 API 直接调用模型
Ollama 提供 OpenAI 兼容接口，可直接调用：
# 文本生成（流式输出）
curl http://服务器IP/api/v1/chat/completions \
-H "Content-Type: application/json" \
-d '{
"model": "qwen2.5:7b-instruct-q4_K_M",
"messages": [{"role": "user", "content": "你好，请介绍一下自己"}],
"stream": false
}'

# 第三章：Dify 智能体管理
## 3.1 创建第一个智能体应用
访问 http://服务器IP，登录后点击「创建空白应用」
选择「Agent」类型，命名为「智能家居控制助手」
在「编排」界面：设置提示词（System Prompt）、工具、变量
配置工具：在「工具」选项卡中添加自定义 API 工具（HA控制/查询接口）
点击「调试与预览」测试对话效果，确认无误后「发布」
## 3.2 导入预置模板工作流
项目提供 5 个预置 Dify 工作流模板，位于 templates/ 目录下：
ls templates/dify/
# 输出：
# 01_homeassistant_control.yml   - 智能家居控制助手
# 02_knowledge_qa.yml            - 知识库问答机器人
# 03_device_status_broadcast.yml - 设备状态播报
# 04_automation_planner.yml      - 场景自动化规划
# 05_data_analysis_report.yml    - 数据分析报告
在 Dify Web UI 中导入：工作室 → 导入 DSL 文件 → 选择 .yml 文件。
## 3.3 配置知识库（RAG）
进入 Dify → 知识库 → 创建知识库
选择 Embedding 模型：bge-m3（确保已在模型供应商中配置）
上传文档：支持 PDF、Word、TXT、Markdown、HTML、CSV
等待文档向量化完成（可在知识库详情页查看进度）
在 Agent 应用中添加知识库：编排 → 上下文 → 添加已创建知识库
💡 说明：单个文档建议不超过 50MB，特大型 PDF 可先分割为多个文件后上传。
## 3.4 ▲14 四种接口调用说明
⚠️ 注意：▲14 是合同强制条款，必须截图留证。以下四种接口均需完成调用演示。

▲14 接口调用示例（使用 curl 测试）：
# ① 文本生成接口
curl http://服务器IP/api/chat -H "Authorization: Bearer <DIFY_API_KEY>" \
-H "Content-Type: application/json" \
-d '{"inputs":{},"query":"打开客厅灯","response_mode":"blocking","user":"test"}'

# ④ 知识库检索接口（Dify 数据集 API）
curl "http://服务器IP/v1/datasets/<dataset_id>/retrieve" \
-H "Authorization: Bearer <DIFY_API_KEY>" \
-d '{"query":"智能家居控制命令","retrieval_model":{"search_method":"hybrid_search","top_k":5}}'

# 第四章：Home Assistant 与虚拟设备沙盘
## 4.1 Home Assistant 初始化
访问 http://服务器IP/homeassistant，完成首次设置向导
创建管理员账号，设置位置/时区
生成长期访问令牌（Token）：头像 → 安全 → 长期访问令牌 → 创建
将生成的 Token 复制到 .env 文件的 HA_TOKEN 变量中，重启相关服务
docker compose restart dify-api
## 4.2 ▲23 虚拟设备配置
⚠️ 注意：▲23 是合同强制条款。虚拟设备需在 HA 中以 Template 实体形式创建，并通过 MQTT 仿真器推送数据。
### 4.2.1 创建 HA Template 虚拟实体
编辑 homeassistant/config/configuration.yaml，添加以下内容：
# 虚拟灯光
light:
- platform: template
lights:
virtual_living_room_light:
friendly_name: '虚拟客厅灯'
value_template: "{{ states('input_boolean.virtual_light_state') }}"
turn_on:
- service: input_boolean.turn_on
target:
entity_id: input_boolean.virtual_light_state
turn_off:
- service: input_boolean.turn_off
target:
entity_id: input_boolean.virtual_light_state

# 虚拟温度传感器
sensor:
- platform: mqtt
name: '虚拟室内温度'
state_topic: 'smarthome/sensors/temperature'
unit_of_measurement: '°C'
### 4.2.2 启动 MQTT 仿真器
# 仿真器脚本位于 scripts/mqtt_simulator.py
# 直接在 Jupyter 中运行，或以 Docker 容器形式运行
docker exec jupyterlab python /workspace/scripts/mqtt_simulator.py
### 4.2.3 访问虚拟沙盘界面
Streamlit 可视化沙盘通过 http://服务器IP/streamlit 访问，实时显示所有虚拟设备状态，并支持通过界面控制设备。
## 4.3 设备状态查询与控制 API
# 获取所有设备状态
curl "http://服务器IP/homeassistant/api/states" \
-H "Authorization: Bearer <HA_TOKEN>"

# 控制设备（开灯示例）
curl -X POST "http://服务器IP/homeassistant/api/services/light/turn_on" \
-H "Authorization: Bearer <HA_TOKEN>" \
-H "Content-Type: application/json" \
-d '{"entity_id": "light.virtual_living_room_light"}'

# 第五章：日常运维操作
## 5.1 服务启停管理
# 启动所有服务
docker compose up -d

# 停止所有服务
docker compose down

# 重启单个服务
docker compose restart <service_name>

# 查看所有服务状态
docker compose ps

# 查看服务日志（最近200行）
docker compose logs --tail=200 <service_name>

# 实时日志监控
docker compose logs -f dify-api homeassistant
## 5.2 数据备份
⚠️ 注意：建议每日备份一次，关键操作（如更新版本）前必须先备份。
# 备份脚本（位于 scripts/backup.sh）
#!/bin/bash
BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p $BACKUP_DIR

# 备份数据库
docker exec db pg_dump -U postgres dify > $BACKUP_DIR/dify_db.sql

# 备份 Home Assistant 配置
cp -r ./homeassistant/config $BACKUP_DIR/ha_config

# 备份 Dify 上传的文件
cp -r ./volumes/app/storage $BACKUP_DIR/dify_storage

echo "备份完成：$BACKUP_DIR"
## 5.3 更新升级
❗ 重要：升级前必须先备份数据，并在测试环境验证后再升级生产环境。
# 1. 备份数据
bash scripts/backup.sh

# 2. 拉取最新镜像
docker compose pull

# 3. 重建并启动
docker compose up -d --force-recreate

# 4. 检查服务状态
docker compose ps && docker compose logs --tail=50
## 5.4 资源监控
# 查看容器资源占用（CPU/内存/网络）
docker stats

# 查看 GPU 使用情况
nvidia-smi

# 查看磁盘空间
df -h && du -sh volumes/

# 清理未使用的 Docker 资源（慎用）
docker system prune -f
Grafana 监控面板（http://服务器IP/grafana）提供可视化的系统运行指标，默认 admin/admin 首次登录后需修改密码。

# 第六章：常见故障排查
## 6.1 故障排查速查表
## 6.2 日志位置汇总
# 容器日志（实时查看）
docker compose logs -f <service>

# Nginx 访问日志
docker exec nginx cat /var/log/nginx/access.log | tail -100

# Dify 错误日志
docker logs dify-api 2>&1 | grep -i error | tail -50

# Home Assistant 日志
docker logs homeassistant | tail -100
## 6.3 完全重置（谨慎操作）
❗ 重要：此操作会清空所有数据，包括知识库、工作流、HA配置。请确认已备份后再执行。
# 停止所有服务并删除数据卷
docker compose down -v

# 删除本地数据（慎！）
rm -rf volumes/

# 重新初始化
docker compose up -d

# 第七章：合同验收操作指南
## 7.1 ▲强制项截图操作指引
⚠️ 注意：▲7、▲14、▲23 三项为合同强制截图项。请严格按照以下步骤操作并保存截图。
### ▲7：合规开源协议截图
打开 Ollama 官方页面（https://github.com/ollama/ollama），截图 MIT License 说明
打开 Dify GitHub 页面（https://github.com/langgenius/dify），截图 Apache 2.0 License
打开 Home Assistant GitHub 页面，截图 Apache 2.0 License
在本地终端执行 docker inspect ollama | grep Image，截图显示版本号的输出
💡 说明：截图需包含：网站URL可见、License文字清晰可读、截图时间戳（建议系统时间显示在截图中）。
### ▲14：四种接口调用截图
接口①（文本生成）：在 Jupyter Notebook 中执行 API 调用示例，截图请求代码和成功响应
接口②（设备控制）：通过 Postman 或 curl 发送设备控制命令，截图命令和 HA 设备状态变化
接口③（状态查询）：执行 HA states 查询，截图返回的设备状态 JSON
接口④（知识库检索）：调用 Dify 知识库检索 API，截图查询和返回的相关文档片段
### ▲23：虚拟设备沙盘截图
打开 Streamlit 沙盘界面（http://服务器IP/streamlit），截图完整面板
在 Dify 对话中输入「打开客厅灯」，截图 AI 响应并同时截图 HA 设备状态变化
截图 HA Lovelace Dashboard 中虚拟设备卡片
录制 30 秒视频：AI 对话 → 设备控制 → 沙盘实时变化
## 7.2 40项合同条款验收清单
所有条款验收截图请保存至 deliverables/screenshots/ 目录，按条款编号命名。
💡 说明：完整验收清单和截图模板请参考项目根目录下的 合同验收清单.xlsx 文件。

# 附录 A：.env 配置项说明
# 附录 B：开发文档与参考资料
Dify 官方文档：https://docs.dify.ai/zh-hans
Ollama 官方文档：https://ollama.com/docs
Home Assistant 开发者文档：https://developers.home-assistant.io/
项目 Jupyter Notebook 示例集：http://服务器IP/jupyter（目录 /workspace/examples/）
API 接口文档（Postman 集合）：deliverables/api/smart-home-api.postman_collection.json
MkDocs 文档站：http://服务器IP:8000（Phase 5 完成后上线）

文档版本 v1.0  |  2026-03-08  |  本文档随项目迭代更新

| 配置项 | 最低要求 | 推荐配置 |
| --- | --- | --- |
| CPU | ≥16核24线程 | Intel i9-13980HX 或 AMD Ryzen 9 7945HX |
| 内存 | ≥32G DDR5 | 64G（多任务并发推荐） |
| 存储 | ≥512G NVMe SSD | 2TB（模型文件约15G+） |
| GPU | ≥16G显存，≥4608计算核心，≥128bit位宽 | NVIDIA RTX 4080(16G) 或 RTX 4090(24G) |
| 操作系统 | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS Server |
| CUDA | ≥12.0 | CUDA 12.4 + cuDNN 8.9+ |


| 服务名称 | Docker容器名 | 内部端口 | Nginx路由 | 说明 |
| --- | --- | --- | --- | --- |
| Ollama | ollama | 11434 | /api/v1/ | LLM推理，OpenAI兼容API |
| Dify API | dify-api | 5001 | /(主入口) | 智能体框架核心API |
| Dify Web | dify-web | 3000 | /(转发到3000) | 智能体管理界面 |
| Open WebUI | open-webui | 8080 | /open-webui/ | 对话交互界面 |
| Home Assistant | homeassistant | 8123 | /homeassistant/ | 智慧家居中控 |
| Mosquitto | mosquitto | 1883 | （TCP直连） | MQTT Broker |
| JupyterLab | jupyterlab | 8888 | /jupyter/ | 科研开发环境 |
| Streamlit | streamlit-sandbox | 8501 | /streamlit/ | 虚拟沙盘可视化 |
| Grafana | grafana | 3001 | /grafana/ | 监控面板 |
| PostgreSQL | db | 5432 | （内网） | Dify数据库 |
| Redis | redis | 6379 | （内网） | 缓存 |
| InfluxDB | influxdb | 8086 | （内网） | 时序数据库 |


| 模型名称 | 量化版本 | 显存占用 | 推荐用途 | 拉取命令 |
| --- | --- | --- | --- | --- |
| Qwen2.5-7B-Instruct | Q4_K_M | ~5.0G | 主力对话/指令执行 | ollama pull qwen2.5:7b-instruct-q4_K_M |
| DeepSeek-R1-7B | Q4_K_M | ~4.7G | 推理/链式思考任务 | ollama pull deepseek-r1:7b-q4_K_M |
| BAAI/bge-m3 | FP16 | ~1.1G | 文本Embedding/RAG | ollama pull bge-m3 |
| Qwen2.5-14B | Q4_K_M | ~9.5G | 需要>=16G显存 | ollama pull qwen2.5:14b-q4_K_M |


| 条款 | 要求内容 | 实现方案 | 截图要求 | 最晚完成时间 |
| --- | --- | --- | --- | --- |
| ▲7 | 合规开源+支持二次开发 | Ollama(MIT)+Dify CE(Apache2.0)+Home Assistant(Apache2.0)；预留Python SDK脚手架 | 各组件License页面截图 | Phase 2 W5 |
| ▲14 | 4种接口调用实现 | ①文本生成/api/chat ②设备控制/ha/control ③状态查询/ha/states ④知识库检索/datasets/{id}/retrieve | 4种接口各一次成功调用截图 | Phase 2 W5 |
| ▲23 | 虚拟设备/电子沙盘 | HA Template实体(灯/空调/传感器)+Python MQTT仿真器+Streamlit实时可视化面板 | 沙盘运行界面截图+AI控制演示录屏 | Phase 4 W11 |


| 现象 | 可能原因 | 排查命令 | 解决方案 |
| --- | --- | --- | --- |
| Ollama 无响应 | 服务未启动/端口占用 | docker logs ollama curl localhost:11434 | docker restart ollama 检查GPU驱动：nvidia-smi |
| Dify 无法访问 | API或Web容器异常 | docker ps | grep dify docker logs dify-api | docker compose restart dify-api dify-web 检查PostgreSQL是否正常 |
| HA 无法访问 | 容器崩溃/配置错误 | docker logs homeassistant 检查8123端口 | docker restart homeassistant 检查configuration.yaml语法 |
| MQTT消息不通 | Broker未启动/认证失败 | docker logs mosquitto mosquitto_sub -t '#' -v | 检查mosquitto.conf 确认用户名密码配置 |
| LLM推理极慢 | 未使用GPU/量化问题 | docker exec ollama ollama ps nvidia-smi | 确认CUDA可用 换Q4_K_M量化版本 |
| Dify知识库上传失败 | 文件格式/大小限制 | docker logs dify-api | grep error | 检查文件格式(PDF/MD/TXT/CSV) 单文件建议<50MB |
| Nginx 502 Bad Gateway | 后端服务未启动 | docker ps --format 'table{{.Names}}\t{{.Status}}' | docker compose up -d nginx -t检查配置 |


| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| SECRET_KEY | your_secret_key_here | Dify加密密钥，生产必须修改 |
| POSTGRES_PASSWORD | difyai123456 | 数据库密码，必须修改 |
| POSTGRES_DB | dify | 数据库名称 |
| REDIS_PASSWORD | difyai123456 | Redis密码，可选 |
| INFLUXDB_ADMIN_PASSWORD |  | InfluxDB管理密码 |
| INFLUXDB_TOKEN |  | InfluxDB访问Token，初始化后自动生成 |
| HA_TOKEN |  | HA长期访问令牌，HA安装后手动设置 |
| OLLAMA_HOST | http://ollama:11434 | Ollama内网地址，通常无需修改 |
| DIFY_API_URL | http://dify-api:5001 | Dify API内网地址 |
| NGINX_PORT | 80 | Nginx监听端口 |
| JUPYTER_TOKEN | smarthome2026 | JupyterLab访问密码 |
