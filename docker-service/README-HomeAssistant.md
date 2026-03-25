# Home Assistant 部署与使用指南

> 基于官方文档整理：https://www.home-assistant.io/installation/
> REST API 文档：https://developers.home-assistant.io/docs/api/rest/

---

## 目录

- [一、部署（Docker）](#一部署docker)
- [二、初始化配置（Onboarding）](#二初始化配置onboarding)
- [三、核心概念](#三核心概念)
- [四、添加设备与集成](#四添加设备与集成)
- [五、自动化配置](#五自动化配置)
- [六、REST API 接入项目](#六rest-api-接入项目)
- [七、接入本项目（smart-home-ai-backend）](#七接入本项目smart-home-ai-backend)

---

## 一、部署（Docker）

### 前置要求
- Docker Engine 23.0.0+（**不支持 Docker Desktop**）
- 服务器开放端口：`8123`

### docker-compose.yml 配置

```yaml
home-assistant:
  image: ghcr.io/home-assistant/home-assistant:stable
  container_name: home-assistant
  privileged: true
  network_mode: host        # 官方要求，用于 mDNS/设备自动发现
  environment:
    - TZ=Asia/Shanghai
  volumes:
    - ./ha-config:/config          # 持久化配置目录
    - /run/dbus:/run/dbus:ro       # 蓝牙支持
    - /etc/localtime:/etc/localtime:ro
  restart: unless-stopped
```

> **为什么用 `network_mode: host`？**
> HA 需要 host 网络才能自动扫描局域网内的智能设备（mDNS、Zigbee、Matter 协议等）。
> 使用 host 模式后无需额外映射端口，直接通过服务器 IP 的 8123 端口访问。

### 启动命令

```bash
mkdir -p ha-config
sudo docker compose up -d home-assistant

# 查看日志
sudo docker logs -f home-assistant
```

---

## 二、初始化配置（Onboarding）

部署成功后，浏览器访问 `http://<服务器IP>:8123`，按以下步骤完成初始化：

### 步骤 1 — 创建管理员账号

- 设置用户名 + 密码（Owner 角色，权限最高，不可更改）
- 或从备份恢复

### 步骤 2 — 配置家庭位置

- 设置城市/地区（影响时区、日出日落时间、天气集成）
- 单位制：公制 / 英制

### 步骤 3 — 数据分享选项

- 可选择是否向官方发送匿名统计数据

### 步骤 4 — 进入主界面

- 默认 Dashboard 自动展示已发现的设备
- 左侧导航：概览 / 地图 / 日志 / 开发者工具 / 设置

---

## 三、核心概念

| 概念 | 说明 |
|------|------|
| **Entity（实体）** | HA 中最小的数据单元，如 `light.living_room`、`sensor.temperature` |
| **Device（设备）** | 物理或逻辑设备，包含多个实体，如一个智能灯泡包含亮度、色温等实体 |
| **Integration（集成）** | 连接设备/服务的插件，如小米、Zigbee2MQTT、MQTT、REST |
| **State（状态）** | 实体当前的值，如 `on`/`off`、`23.5`（温度）|
| **Service（服务）** | 可调用的操作，如 `light.turn_on`、`switch.toggle` |
| **Automation（自动化）** | 触发器 + 条件 + 动作的组合逻辑 |
| **Blueprint（蓝图）** | 社区共享的自动化模板，开箱即用 |

---

## 四、添加设备与集成

### 方式 1：UI 添加（推荐）

```
设置 → 设备与服务 → 添加集成 → 搜索集成名称
```

常用集成：
- `MQTT` — 接入 Zigbee2MQTT、自研设备
- `小米` — 米家生态设备
- `HomeKit` — Apple HomeKit 设备
- `ESPHome` — ESP32/ESP8266 自研固件
- `RESTful` — 通过 HTTP 接入自定义设备

### 方式 2：YAML 配置

编辑 `/config/configuration.yaml`（对应容器内路径，宿主机为 `./ha-config/configuration.yaml`）：

```yaml
# 示例：通过 REST 接入自定义传感器
rest:
  - resource: http://your-device-ip/api/sensor
    scan_interval: 30
    sensor:
      - name: "室内温度"
        value_template: "{{ value_json.temperature }}"
        unit_of_measurement: "°C"
      - name: "室内湿度"
        value_template: "{{ value_json.humidity }}"
        unit_of_measurement: "%"
```

修改配置后执行热重载（无需重启容器）：
```
开发者工具 → YAML → 全部重新加载
```

---

## 五、自动化配置

### 基本结构

自动化由三部分组成：

```yaml
automation:
  - alias: "示例：人回家开灯"
    trigger:           # 触发器：什么时候触发
      - platform: state
        entity_id: person.zhang_san
        to: "home"
    condition:         # 条件（可选）：满足什么条件才执行
      - condition: sun
        after: sunset
    action:            # 动作：执行什么
      - service: light.turn_on
        target:
          entity_id: light.living_room
        data:
          brightness: 200
```

### 常用触发器类型

| 触发器 | 说明 | 示例 |
|--------|------|------|
| `state` | 实体状态变化 | 门传感器从 closed → open |
| `time` | 定时触发 | 每天早上 7:00 |
| `sun` | 日出/日落 | sunset、sunrise |
| `numeric_state` | 数值超过阈值 | 温度 > 28°C |
| `webhook` | 外部 HTTP 请求触发 | 接收项目后端推送 |
| `mqtt` | MQTT 消息触发 | 设备上报数据 |

### 通过 UI 创建自动化

```
设置 → 自动化与场景 → 创建自动化
```

支持可视化编辑，无需手写 YAML。

---

## 六、REST API 接入项目

### 获取 Long-Lived Access Token

1. 登录 HA Web 界面
2. 点击左下角 **头像** → **用户资料**（Profile）
3. 滚动到页面底部 → **长期访问令牌** → **创建令牌**
4. 复制保存（只显示一次）

### API 基础信息

```
Base URL:  http://<服务器IP>:8123/api
认证方式:  Authorization: Bearer <TOKEN>
Content-Type: application/json
```

### 常用 API 示例

#### 获取所有实体状态

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     http://localhost:8123/api/states
```

#### 获取单个实体状态

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
     http://localhost:8123/api/states/light.living_room
```

响应示例：
```json
{
  "entity_id": "light.living_room",
  "state": "on",
  "attributes": {
    "brightness": 200,
    "friendly_name": "客厅灯"
  },
  "last_changed": "2024-01-01T10:00:00+08:00"
}
```

#### 调用服务（控制设备）

```bash
# 开灯
curl -X POST \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"entity_id": "light.living_room", "brightness": 255}' \
     http://localhost:8123/api/services/light/turn_on

# 关灯
curl -X POST \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"entity_id": "light.living_room"}' \
     http://localhost:8123/api/services/light/turn_off

# 触发场景
curl -X POST \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"entity_id": "scene.movie_mode"}' \
     http://localhost:8123/api/services/scene/turn_on
```

#### 触发 Webhook 自动化

```bash
curl -X POST http://localhost:8123/api/webhook/your_webhook_id
```

#### 查询可用服务列表

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
     http://localhost:8123/api/services
```

---

## 七、接入本项目（smart-home-ai-backend）

### 环境变量配置

在后端 `.env` 中设置：

```env
HA_BASE_URL=http://localhost:8123
HA_TOKEN=your_long_lived_access_token
```

> 如果 HA 和后端在同一台服务器，用 `localhost:8123`。
> 如果分布在不同机器，用 HA 服务器内网 IP。

### Python 调用示例

```python
import httpx

HA_URL = "http://localhost:8123/api"
HA_TOKEN = "your_token"

headers = {
    "Authorization": f"Bearer {HA_TOKEN}",
    "Content-Type": "application/json",
}

# 异步获取所有设备状态
async def get_all_states():
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{HA_URL}/states", headers=headers)
        return resp.json()

# 控制设备
async def control_device(domain: str, service: str, entity_id: str, data: dict = {}):
    async with httpx.AsyncClient() as client:
        payload = {"entity_id": entity_id, **data}
        resp = await client.post(
            f"{HA_URL}/services/{domain}/{service}",
            headers=headers,
            json=payload
        )
        return resp.json()

# 示例：开灯
# await control_device("light", "turn_on", "light.living_room", {"brightness": 200})
```

### 项目中已有配置

`smart-home-ai-backend/app/config.py` 中已预配置：

```python
HA_BASE_URL: str = "http://localhost:8123"
```

只需补充 `HA_TOKEN` 环境变量即可联通。

---

## 常见问题

**Q：容器启动后访问不了 8123？**
A：HA 首次启动需要 1-2 分钟初始化，用 `docker logs -f home-assistant` 看日志，出现 `Starting Home Assistant` 后再访问。

**Q：修改 configuration.yaml 后不生效？**
A：进入 HA → 开发者工具 → YAML → 点击"全部重新加载"，无需重启容器。

**Q：API 返回 401 Unauthorized？**
A：Token 已过期或复制不完整，重新在用户资料页生成新 Token。

**Q：局域网设备发现不了？**
A：确认 docker-compose 使用了 `network_mode: host`，且服务器防火墙未屏蔽 mDNS（UDP 5353）。
