# 设备控制与 Home Assistant 映射

## 设备控制设计原则
后端不是把 Home Assistant 所有实体原样暴露给前端，而是采用“逻辑设备”模型：一个逻辑设备可以聚合多个 HA 实体，例如电源、亮度、模式、温度等。

这样做的好处是：

- 前端更容易展示
- Dify 工作流更容易理解“设备”
- 以后替换真实硬件时，只需要改映射，不需要大改前端和智能体

## 当前逻辑设备类别

- 灯光：客厅灯、卧室灯、书房灯
- 空调：主卧空调
- 开关设备：咖啡机、热水器
- 安防：前门门锁
- 传感器：室内环境、空气质量、电力监控、前门门磁

共 11 个逻辑设备。

## 典型映射关系

### 客厅灯
- power -> `input_boolean.light_living_room`
- brightness -> `input_number.light_living_room_brightness`

### 主卧空调
- power -> `input_select.ac_power`
- mode -> `input_select.ac_mode`
- temperature -> `input_number.ac_temperature`

### 咖啡机
- power -> `input_boolean.coffee_machine`

### 前门门锁
- lock -> `input_boolean.front_door_lock`

### 室内环境
- temperature -> `sensor.shi_nei_wen_du`
- humidity -> `sensor.shi_nei_shi_du`

## 后端设备能力

### 设备搜索
接口支持按中文名称搜索逻辑设备，返回：

- `device_id`
- `name`
- `category`
- `description`
- `main_entity_id`
- `available_actions`

适合给 Dify 工作流先做“设备识别”，再做控制。

### 设备列表
返回：

- `devices`
- `scenes`
- `summary`

其中 `summary` 包括总数、在线数、离线数、场景数、类别统计。

### 单实体状态
可以查询某个 HA 实体的完整状态，包括：

- `state`
- `attributes`
- `last_changed`
- `last_updated`

### 控制设备
控制接口支持：

- `turn_on`
- `turn_off`
- `toggle`
- `set_value`
- `select_option`

控制成功后会尝试回读新状态，并写入操作日志。

## 设备控制依赖

- Home Assistant 必须在线
- `HA_BASE_URL` 和 `HA_TOKEN` 必须正确配置
- 如果 HA 返回失败，后端会返回 502，而不是假装成功

## 适合作为知识库回答的问题

- 当前平台有哪些设备
- 某个设备在系统里对应什么实体
- 设备控制为什么要先搜设备再执行动作
- 为什么有些设备可以控制、有些传感器只能读不能写
