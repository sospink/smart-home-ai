# Smart Home 云服务器核心全量迁移工具包

本目录用于把当前项目从一台云服务器迁移到另一台云服务器。目标是复刻核心演示链路：平台前后端、MySQL、InfluxDB、Dify、Home Assistant 和运行时配置。

## 目录结构

```text
deploy-kit/cloud-migration/
├── MANIFEST.md
├── README.md
├── config/
│   └── migration.env.example
├── scripts/
│   ├── 00_inventory_source.sh
│   ├── 01_export_source_bundle.sh
│   ├── 02_prepare_target.sh
│   ├── 03_restore_target.sh
│   ├── 04_deploy_app_release.sh
│   └── 05_validate_target.sh
└── templates/
```

## 迁移前准备

1. 准备新云服务器，推荐 Ubuntu 24.04 LTS。
2. 确认本机可 SSH 到源服务器和目标服务器。
3. 复制配置：

```bash
cp deploy-kit/cloud-migration/config/migration.env.example \
  deploy-kit/cloud-migration/config/migration.env
```

4. 编辑 `migration.env`：

- 填写 `TARGET_HOST`、`TARGET_PUBLIC_HOST`。
- 修改 `TARGET_DATABASE_URL` 的数据库用户名和密码。
- 设置 `INFLUXDB_ADMIN_PASSWORD`。
- 如果使用现有发布脚本部署应用，填写 `TARGET_SSH_PASSWORD`。

`migration.env` 会包含敏感信息，不要提交。

## 推荐执行顺序

### 1. 盘点源服务器

```bash
CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env \
  deploy-kit/cloud-migration/scripts/00_inventory_source.sh
```

输出位于 `build/migration/<timestamp>/source-inventory.json`。

### 2. 预估导出体积

```bash
CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env \
  deploy-kit/cloud-migration/scripts/01_export_source_bundle.sh --dry-run
```

### 3. 导出迁移包

```bash
CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env \
  deploy-kit/cloud-migration/scripts/01_export_source_bundle.sh
```

记录输出目录，例如：

```text
build/migration/20260611-120000
```

### 4. 初始化目标服务器

```bash
CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env \
  deploy-kit/cloud-migration/scripts/02_prepare_target.sh
```

该步骤会安装基础依赖、Docker、MySQL、InfluxDB、Nginx，并创建目标目录。

### 5. 恢复数据和外部服务

```bash
CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env \
  deploy-kit/cloud-migration/scripts/03_restore_target.sh \
  --bundle-dir build/migration/<timestamp>
```

该步骤会恢复 MySQL、InfluxDB、Dify、Home Assistant 和平台 shared 配置，并按新 IP/域名重写运行时配置。

### 6. 发布平台应用

```bash
CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env \
  deploy-kit/cloud-migration/scripts/04_deploy_app_release.sh
```

此脚本复用项目现有 `scripts/deploy-cloud.sh`。由于原发布脚本使用 `sshpass`，需要在 `migration.env` 中填写 `TARGET_SSH_PASSWORD`。

### 7. 验证目标服务器

```bash
CONFIG_FILE=deploy-kit/cloud-migration/config/migration.env \
  deploy-kit/cloud-migration/scripts/05_validate_target.sh
```

至少确认：

- `http://<目标IP>:8088/home` 返回 200。
- `/api/v1/system/health` 返回 200。
- Dify、Home Assistant、InfluxDB 可达。
- `/activity-logs` 不再持续出现 InfluxDB 写入失败。

## 注意事项

- 迁移包包含数据库、Dify `.env`、HA Token、平台密钥，传输和保存时按敏感数据处理。
- 目标服务器默认联网拉 Docker 镜像；不生成几十 GB 的离线镜像包。
- MySQL 和 InfluxDB 默认只建议本机/内网访问，不建议直接公网开放。
- Dify 的应用 API Key、Dataset Key 会随平台配置迁移，但 Dify 控制台域名/IP 仍需要在新环境复核。
- Ollama 当前是外部地址配置，核心迁移不部署本地 Ollama；如新服务器需要本地 Ollama，可在迁移后单独补充。

