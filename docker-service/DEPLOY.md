# Smart Home — 部署文档

> 部署日期：2026-03-25
> 服务器环境：Ubuntu + Docker
> 部署目录：`~/docker-service`

---

## 一、服务总览

| 服务 | 用途 | 端口 | 访问地址 |
|------|------|------|----------|
| **Code Server** | Web IDE，代码编辑 / 调试 | `8443` | `http://<服务器IP>:8443` |
| **JupyterLab** | 交互式 Python 笔记本，数据分析 / 模型实验 | `8888` | `http://<服务器IP>:8888` |
| **Home Assistant** | 智能家居控制平台 | `8123` | `http://<服务器IP>:8123` |

---

## 二、快速访问

将 `<服务器IP>` 替换为你的云服务器公网 IP。

### Code Server（Web IDE）
```
http://<服务器IP>:8443
```
- 无需密码，直接进入 VS Code 界面
- 工作区已挂载项目根目录（`/home/coder/project`）
- 支持终端、插件、Git 操作

### JupyterLab（Python 笔记本）
```
http://<服务器IP>:8888
```
- 无需 Token，直接进入 JupyterLab 界面
- Notebooks 保存在服务器 `~/docker-service/notebooks/`
- 已预装 scipy、numpy、pandas、matplotlib 等科学计算库

### Home Assistant（智能家居）
```
http://<服务器IP>:8123
```
- 首次访问需完成 Onboarding（创建管理员账号）
- 登录后进入主控制台
- REST API 地址：`http://<服务器IP>:8123/api`

---

## 三、云服务器安全组放行端口

在云控制台（阿里云 / 腾讯云 / 华为云）的**安全组入方向规则**中添加：

| 端口 | 协议 | 用途 |
|------|------|------|
| `8443` | TCP | Code Server |
| `8888` | TCP | JupyterLab |
| `8123` | TCP | Home Assistant |

---

## 四、部署命令

```bash
# 进入部署目录
cd ~/docker-service

# 首次部署（后台启动所有服务）
sudo docker compose up -d

# 查看运行状态
sudo docker ps

# 查看某个服务日志
sudo docker logs -f code-server
sudo docker logs -f jupyterlab
sudo docker logs -f home-assistant

# 停止所有服务
sudo docker compose down

# 重启某个服务
sudo docker compose restart code-server
```

---

## 五、目录结构

```
docker-service/
├── docker-compose.yml       # 服务编排配置
├── .env                     # 环境变量（密码/Token）
├── .env.example             # 环境变量模板
├── notebooks/               # JupyterLab notebooks 持久化目录
├── ha-config/               # Home Assistant 配置持久化目录
├── DEPLOY.md                # 本文档
└── README-HomeAssistant.md  # Home Assistant 使用指南
```

---

## 六、Home Assistant 接入后端项目

HA 启动并完成 Onboarding 后：

1. 进入 **用户资料**（左下角头像）→ 滚动到底部 → **长期访问令牌** → 创建
2. 复制 Token，填入后端项目 `.env`：

```env
HA_BASE_URL=http://<服务器IP>:8123
HA_TOKEN=your_long_lived_access_token
```

---

## 七、常用运维命令

```bash
# 检查端口监听情况
sudo ss -tlnp | grep -E '8443|8888|8123'

# 检查磁盘占用
df -h

# 查看容器资源使用
sudo docker stats --no-stream

# 更新镜像到最新版
sudo docker compose pull
sudo docker compose up -d
```
