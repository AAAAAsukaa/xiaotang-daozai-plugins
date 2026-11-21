# 岛仔集市统计

下载次数统计安装包下载并校验成功的事件。同一事件重试只计一次。收藏次数统计该频道内仍有效的收藏，取消时减一。预览与正式频道分别计数。

服务只接收匿名安装 ID、事件 ID、频道、插件 ID、已下载版本或收藏状态。每个安装每分钟最多写入 120 条新事件。

## 部署

`wrangler.toml` 配置了生产 D1 数据库 `daozai-market-metrics`。使用有 D1 和 Workers 权限的 Cloudflare 账号，在本目录执行迁移并部署 Worker。

    npx wrangler d1 migrations apply daozai-market-metrics --remote
    npx wrangler deploy

本地验证使用 Node.js 24 的内置 SQLite 和 Wrangler 的本地 D1。

    node --test
    npx wrangler d1 migrations apply daozai-market-metrics --local
    npx wrangler dev

## 上架登记

统计上线后，预览和正式频道的 `scripts/publish.py` 上架命令都加 `--metrics`。发布脚本确认 Gitee 可公开下载已校验的 ZIP 后，使用维护者的 Cloudflare 授权登记插件及版本，再推送索引。重复执行保留现有计数和历史版本。

网页发布时同时加 `--prepare` 和 `--metrics`。在 Gitee 确认可公开下载的 ZIP 通过 SHA-256 核对后，在本目录执行登记命令，再上传 `catalog.json`。

    npx wrangler d1 execute daozai-market-metrics --remote --file 'D:/待发布/发薪倒计时/metrics.sql'

保留已经上架的版本和下架插件的历史登记，供离线事件补报及取消收藏。

## 接口

- GET /v1/stats?channel=preview 返回该频道的 plugins 对象，每项包含 downloads 和 favorites。
- POST /v1/events 接收 JSON，包含 channel、installation_id 和最多 32 个 events。下载事件包含 kind=download、event_id、plugin_id、version。收藏事件包含 kind=favorite、event_id、plugin_id、saved。成功时返回同样的 plugins 对象。
- preview 和 stable 是有效频道。每个匿名安装按操作顺序发送事件。错误码 422 表示批次包含未经登记的插件或版本，整批未写入。
