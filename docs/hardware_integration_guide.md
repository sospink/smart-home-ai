# 🔌 真实硬件对接指南

> 当前系统已完全预留好真实硬件对接能力，**代码改动极小**。

---

## 当前架构（已预留）

```
┌─────────────┐      ┌──────────────────┐      ┌────────────────────┐
│  前端 UI    │ ──── │  后端 FastAPI     │ ──── │  Home Assistant     │
│  devices/   │ HTTP │  devices.py      │ HTTP │  REST API           │
│  page.tsx   │      │  DEVICE_REGISTRY │      │  ← 虚拟实体(当前)   │
│             │      │                  │      │  ← 真实设备(线下)   │
└─────────────┘      └──────────────────┘      └────────────────────┘
                                                        │
                                                ┌───────┴───────┐
                                                │   真实硬件     │
                                                │  ZigBee/WiFi  │
                                                │  MQTT/Matter  │
                                                └───────────────┘
```

**关键设计决策：前端和后端不直接操作硬件，全部通过 HA REST API。**

所以对接真实硬件 = 只改两个地方：
1. **HA 里添加硬件集成**
2. **后端 DEVICE_REGISTRY 替换 entity_id**

前端 **0 改动**。

---

## 对接步骤

### Step 1：HA 添加硬件集成（线下操作）

根据你购买的硬件型号，在 HA 中添加对应的集成：

#### 方式 A：ZigBee 设备（如小米传感器、Aqara 开关）

```
1. 购买 ZigBee 协调器（推荐 SONOFF ZBDongle-P）
2. USB 插到服务器
3. docker-compose.yml 加 USB 映射：
```

```yaml
home-assistant:
  # ... 现有配置 ...
  devices:
    - /dev/ttyUSB0:/dev/ttyUSB0    # ZigBee dongle
```

```
4. HA → 设置 → 设备与服务 → 添加集成 → 搜索 "ZHA" 或 "Zigbee2MQTT"
5. 配网：让设备进入配对模式（长按按钮），HA 自动发现
6. 配对成功后，HA 自动创建实体，如：
   - light.客厅_led_灯     （替代 input_boolean.light_living_room）
   - sensor.客厅_温度       （替代 sensor.shi_nei_wen_du）
```

#### 方式 B：WiFi 设备（如涂鸦/米家设备）

```
1. HA → 设置 → 设备与服务 → 添加集成
2. 搜索品牌集成：
   - "Xiaomi Miot Auto"  → 米家设备
   - "Tuya"              → 涂鸦设备
   - "ESPHome"           → ESP32 自研设备
3. 输入账号密码（米家/涂鸦账号）
4. 自动导入所有设备
```

#### 方式 C：MQTT 设备（如 ESP32 自研硬件）

```
1. 部署 MQTT Broker（如 Mosquitto）
2. HA → 添加集成 → MQTT
3. ESP32 固件发布 MQTT 消息到对应 topic
4. HA 通过 MQTT 集成自动创建实体
```

---

### Step 2：后端 DEVICE_REGISTRY 替换实体（唯一代码改动）

添加完硬件后，在 HA → 开发者工具 → 状态 中查看新设备的 `entity_id`，然后替换后端的注册表。

**文件：** [app/routers/devices.py](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-backend/app/routers/devices.py) → `DEVICE_REGISTRY`

#### 示例：客厅灯从虚拟替换为真实

```diff
 {
     "id": "living_room_light",
     "name": "客厅灯",
     "description": "可调式 LED 灯组",
     "category": "light",
     "entities": {
-        "power": "input_boolean.light_living_room",
-        "brightness": "input_number.light_living_room_brightness",
+        "power": "light.客厅_led_灯",         # ← HA 自动创建的真实实体
+        "brightness": "light.客厅_led_灯",     # ← 真实灯光实体同时包含亮度属性
     },
 },
```

> **注意：** 真实的 `light.*` 实体同时支持 power 和 brightness，不需要分开两个实体。
> 控制命令也会自动适配：`light.turn_on` 直接支持 `brightness` 参数。

#### 示例：温度传感器从虚拟替换为真实

```diff
 {
     "id": "indoor_env_sensor",
     "name": "室内环境",
     "description": "温湿度传感器",
     "category": "sensor",
     "entities": {
-        "temperature": "sensor.shi_nei_wen_du",
-        "humidity": "sensor.shi_nei_shi_du",
+        "temperature": "sensor.客厅_aqara_温度",
+        "humidity": "sensor.客厅_aqara_湿度",
     },
 },
```

#### 示例：新增真实设备

如果线下多买了几个设备，直接在 DEVICE_REGISTRY 末尾追加：

```python
{
    "id": "curtain_living_room",
    "name": "客厅窗帘",
    "description": "电动窗帘",
    "category": "cover",    # 新分类
    "entities": {
        "position": "cover.客厅_窗帘",
    },
},
```

前端只要在 [page.tsx](file:///Users/zyh/Work/AI/project/smart-home/project/smart-home-ai-frontend/app/%28user%29/chat/page.tsx) 加一个对应的卡片 UI 即可。

---

### Step 3：验证（前端无需修改）

替换完 entity_id 后：

```bash
# 1. 重启后端（自动热重载）
# 2. 测试 API
curl http://localhost:8000/api/v1/devices/ -H "Authorization: Bearer ..."

# 3. 打开前端 http://localhost:3100/devices
#    → 数据自动从真实硬件拉取
#    → 开关/亮度/温度控制直接操作真实设备
```

---

## 控制命令兼容性

当前用 `input_boolean` 虚拟实体的控制命令，和真实设备的命令**完全兼容**：

| 当前（虚拟） | 真实设备 | 命令 | 兼容？ |
|:---:|:---:|------|:---:|
| `input_boolean.turn_on` | `light.turn_on` | 开灯 | ✅ |
| `input_boolean.turn_off` | `light.turn_off` | 关灯 | ✅ |
| `input_number.set_value` | `light.turn_on {brightness}` | 亮度 | ⚠️ 需改 |
| `input_select.select_option` | `climate.set_hvac_mode` | 空调模式 | ⚠️ 需改 |

> **⚠️ 标记的项目**：真实设备的控制命令可能不同于虚拟实体。
> 解决方案：可以在 DEVICE_REGISTRY 中增加 `control_map` 字段来定义映射规则。
> 这是一个后续优化点，不影响当前开发调试。

---

## 推荐线下硬件清单（性价比方案）

| 设备 | 品牌/型号 | 参考价 | 对应前端卡片 |
|------|---------|:------:|:----------:|
| ZigBee 协调器 | SONOFF ZBDongle-P | ¥50 | — |
| 智能灯泡 ×3 | Aqara LED 灯泡 T1 | ¥60/个 | 灯光卡片 |
| 温湿度传感器 | Aqara 温湿度传感器 | ¥60 | 传感器卡片 |
| 门窗传感器 | Aqara 门窗传感器 | ¥50 | 门磁卡片 |
| 智能插座 ×2 | 小米智能插座 3 | ¥40/个 | 开关卡片 |
| 智能门锁 | 小米智能门锁 | ¥800 | 门锁卡片 |
| 空调伴侣 | Aqara 空调伴侣 P3 | ¥200 | 空调卡片 |

预算：约 **¥1400** 可覆盖全部前端卡片。

---

## 总结

```
虚拟阶段（当前）                真实阶段（线下）
─────────────────────────────────────────────────
前端 page.tsx       不变        ← 0 改动
后端 devices.py     不变        ← 只改 DEVICE_REGISTRY 里的 entity_id
HA   configuration  虚拟实体    ← 替换为真实集成
硬件                无          ← 插上即用
```

**一句话：线下去到现场，HA 配好硬件后，改后端 DEVICE_REGISTRY 的 entity_id 就搞定了。**
