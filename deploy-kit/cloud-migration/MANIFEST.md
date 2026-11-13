# 云服务器迁移清单

## 目标范围

本工具包覆盖核心演示全量迁移：

- 平台前端、后端、systemd、Nginx。
- MySQL `smart_home_web`。
- InfluxDB `smart-home-data` bucket。
- Dify docker 栈及其持久化目录。
- Home Assistant 配置目录。
- 平台共享运行时配置 `backend.env` / `frontend.env`。

不默认迁移 Weknora/vLLM、JupyterLab、Code Server、main-llm 等大模型或开发环境容器。

## 中间件版本基线

| 组件 | 当前源服务器版本/口径 | 目标要求 |
| --- | --- | --- |
| OS | Ubuntu 24.04 LTS | Ubuntu 24.04 或兼容 LTS |
| Nginx | 1.24 | apt 安装即可 |
| MySQL | 8.0 | apt 安装 `mysql-server` |
| InfluxDB | 2.8 | `influxdb2` + `influxdb2-cli` |
| Docker | 29.x | Docker Engine + Compose Plugin |
| Node.js | 20.x | 用于 Next.js standalone 运行 |
| Python | 3.12 | 用于 FastAPI venv |

## 必要端口

| 端口 | 暴露范围 | 用途 |
| --- | --- | --- |
| 80 / 443 | 公网 | Dify Nginx |
| 8088 | 公网 | Smart Home 平台入口 |
| 8123 | 公网/验收网段 | Home Assistant |
| 8000 | 本机 | 后端 FastAPI |
| 3100 | 本机 | 前端 Next.js |
| 3306 | 本机/内网 | MySQL |
| 8086 | 本机/内网 | InfluxDB |

## 必拉 Docker 镜像

```text
langgenius/dify-api:1.13.3
langgenius/dify-web:1.13.3
langgenius/dify-sandbox:0.2.14
langgenius/dify-plugin-daemon:0.5.3-local
postgres:15-alpine
redis:6-alpine
semitechnologies/weaviate:1.27.0
ubuntu/squid:latest
nginx:latest
ghcr.io/home-assistant/home-assistant:stable
```

## 迁移包产物

`01_export_source_bundle.sh` 会生成：

- `source-inventory.json`
- `app-source.tar.gz`
- `mysql-smart_home_web.sql.gz`
- `influxdb-backup.tar.gz`
- `dify-docker.tar.gz`
- `ha-config.tar.gz`
- `app-shared-config.tar.gz`
- `docker-images-required.txt`
- `SHA256SUMS`

这些文件可能包含真实密钥或业务数据，只允许保存在 `build/migration/` 或受控传输介质中，不提交 Git。

## 新 IP/域名重写点

恢复脚本会重写：

- `backend.env`
  - `DATABASE_URL`
  - `DIFY_BASE_URL`
  - `HA_BASE_URL`
  - `INFLUXDB_URL`
  - `CORS_ORIGINS`
- MySQL `system_config`
  - `dify_base_url`
  - `ha_base_url`
  - `influxdb_url`
- MySQL `agent_instances`
  - `dify_console_url` 中的旧源服务器 IP。

