# Smart Home 项目 - 交付文档

## 项目概述

| 项目 | 详情 |
|------|------|
| **项目名称** | Smart Home AI 智能家居系统 |
| **技术栈** | Python FastAPI + Next.js + MySQL + Redis + Nginx |
| **部署环境** | Docker Compose on Ubuntu 25.04 |

---

## 访问信息

### 🌐 Web 应用
- **访问地址：** http://172.19.4.213:8088
- **服务器 IP：** 172.19.4.213
- **Nginx 端口：** 8088 (HTTP) / 8444 (HTTPS)

### 🔌 API 服务
- **Backend API：** http://172.19.4.213:8000
- **API 文档：** http://172.19.4.213:8000/docs

---

## 服务架构

```
┌─────────────┐
│   Nginx     │ ← 8088/8444 端口
│  (反向代理)  │
└──────┬──────┘
       │
   ┌───┴───┐
   │       │
┌──▼──┐  ┌─▼────┐
│前端  │  │后端   │
│3000 │  │8000   │
└──┬──┘  └──┬───┘
   │        │
   │    ┌───┴───┐
   │    │       │
┌──▼──┐┌▼────┐ ┌▼────┐
│MySQL││Redis│ │其他  │
│3306 ││6379 │ │服务  │
└─────┘└─────┘ └─────┘
```

---

## 部署环境

| 配置项 | 详情 |
|--------|------|
| **服务器** | Ubuntu 25.04 |
| **Docker** | v29.2.1 |
| **部署路径** | /opt/projects/smart-home/ |
| **数据卷** | mysql_data, redis_data, nginx_cache |

---

## 运维操作

### 查看服务状态
```bash
ssh z@172.19.4.213
cd /opt/projects/smart-home
docker compose ps
```

### 重启服务
```bash
docker compose restart
```

### 查看日志
```bash
docker compose logs -f [service_name]
```

### 回滚
```bash
docker compose down
docker compose up -d
```

---

## 当前状态

| 检查项 | 状态 |
|--------|------|
| 服务运行 | ✅ 正常 |
| 数据库连接 | ✅ 正常 |
| Redis 连接 | ✅ 正常 |
| Web 访问 | ✅ 正常 |

---

## 运维联系

| 角色 | 负责人 |
|------|--------|
| **运维** | DevOps |
| **协调** | Lena (main agent) |

---

**交付时间：** 2026-03-21  
**版本：** v1.0.0
