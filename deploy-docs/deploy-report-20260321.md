# Smart Home 项目部署报告

## 部署信息

| 项目 | 详情 |
|------|------|
| **项目名称** | Smart Home |
| **部署时间** | 2026-03-21 12:46 CST |
| **部署服务器** | prod-1 (172.19.4.213) |
| **部署路径** | /opt/projects/smart-home/ |
| **技术栈** | Python FastAPI + Next.js + MySQL + Redis + Nginx |

---

## STAGE 执行摘要

| STAGE | 任务 | 状态 |
|-------|------|------|
| STAGE 0 | 服务器注册 | ✅ 已注册 |
| STAGE 1 | 本地准备检查 | ✅ Python + Node.js 项目识别 |
| STAGE 2 | 服务器预检查 | ✅ SSH/磁盘/Docker/端口检查通过 |
| STAGE 3 | 备份现有版本 | ⏭️ 跳过（首次部署） |
| STAGE 4 | 文件上传 | ✅ rsync 上传成功 |
| STAGE 5 | 完整检查 | ✅ docker-compose 配置验证通过 |
| STAGE 6 | 执行部署 | ✅ 构建成功，服务启动 |
| STAGE 7 | 健康检查 | ✅ 所有服务运行正常 |
| STAGE 8 | 收尾 | ✅ 状态记录完成 |

---

## 部署过程记录

### 1. 环境配置
- 创建生产环境 `.env` 文件
- 配置 MySQL、Redis、OpenAI 等环境变量

### 2. 问题解决
| 问题 | 解决方案 |
|------|----------|
| 80/443 端口被占用 | 修改为 8088/8444 端口 |
| Backend 数据库驱动问题 | 将 pymysql 改为 aiomysql |

### 3. 服务状态

| 服务 | 容器名 | 端口 | 状态 |
|------|--------|------|------|
| MySQL | smart-home-mysql | 3306 | ✅ Healthy |
| Redis | smart-home-redis | 6379 | ✅ Healthy |
| Backend API | smart-home-backend | 8000 | ✅ Running |
| Frontend | smart-home-frontend | 3000 | ✅ Running |
| Nginx | smart-home-nginx | 8088/8444 | ✅ Running |

---

## 访问地址

| 服务 | 访问地址 |
|------|----------|
| **Web 应用** | http://172.19.4.213:8088 |
| **Backend API** | http://172.19.4.213:8000 |
| **Frontend 直接** | http://172.19.4.213:3000 |

---

## 备注

- 首次部署，无备份
- Nginx 因端口冲突使用 8088/8444 替代 80/443
- 如需使用标准 80/443 端口，需停止现有的 docker-nginx-1 容器

---

**部署完成时间：** 2026-03-21 12:46 CST  
**部署工程师：** DevOps  
