# 书架同步与公开阅读

纸间的正文、导入记录和阅读位置同步到自己的服务器。设备通过配对码或同步密钥连接。AI 使用独立的导入密钥。

## 部署

服务使用 Python 3.9+、SQLite 和 HTTPS 反向代理。进程默认只监听 `127.0.0.1:8794`。可用本目录的 systemd 单元。将脚本装到 `/opt/paperfold/paperfold_sync.py`，将两个随机密钥写入权限为 0600 的 `/etc/paperfold/sync.env`。每个密钥可用 `openssl rand -hex 32` 单独生成。密钥名称为 `PAPERFOLD_SYNC_TOKEN` 和 `PAPERFOLD_INGEST_TOKEN`。备份 SQLite 时使用 SQLite 的备份命令，以包含 WAL 中已提交的数据。

在专用 HTTPS 入口中按原路径转发 `/paperfold-api/*`。例如，Caddy 站点片段如下。

```caddyfile
handle /paperfold-api/* {
    reverse_proxy 127.0.0.1:8794
}
```

`GET /paperfold-api/healthz` 用于检查服务可达性。部署后，在纸间首页点「管理」，输入 HTTPS 服务器地址和同步密钥。首次连接会上传本机书架。正文按需下载，下载过的文章可以离线读。联网后会补传阅读进度。原系统只保留最近一篇，升级会自动迁移这一篇及其阅读进度。

可以通过服务环境变量 `PAPERFOLD_PAIR_PIN` 设置六位数字的设备配对码。网页与安卓 1.2.1 支持输入配对码，服务验证后下发同步凭据。每个小时窗口限五次失败，次数保存在 SQLite。更换同步密钥后，已有设备需要重新连接。

## AI 导入

`POST /paperfold-api/v1/books` 支持 `title`、`text`、`format`。标题可省略，正文必填。新文章默认用 `plain` 保存和阅读。传 `auto` 会在打开文章时用设备上的解析器识别 Markdown。AI 先整理好的 Markdown 可显式传 `markdown`。JSON 请求最大 8 MiB。使用同一个 `Idempotency-Key` 重试同一篇文章时，服务会返回原来的书籍 ID。

```sh
curl --fail-with-body "$PAPERFOLD_URL/paperfold-api/v1/books" \
  -H "Authorization: Bearer $PAPERFOLD_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: reading-note-2026-11-27" \
  --data-binary @article.json
```

```json
{
  "title": "读书笔记",
  "text": "# 第一章\n\n**把这一段留到晚上读。**",
  "format": "markdown"
}
```

导入密钥仅可提交文章。设备密钥可读取自己的书架与正文，也可管理书架和写入个人阅读进度。设备的翻页模式、字号、字体和背景继续由本机保存。多个设备打开同一本书时，以最近一次保存的翻页或跳页进度作为下次打开的位置。

## 公开书架

在环境文件中设置 `PAPERFOLD_PUBLIC_SHELF=1` 并重启服务来启用公开书架。已同步的旧书默认是私有的，所有者可选择「公开上架」。启用后，AI 接口新提交的文章默认公开。保留的旧幂等键重试会返回原文章与原公开状态。

匿名接口 `GET /paperfold-api/v1/public/books` 返回公开书籍的书名、格式、正文大小和归档状态。用 `?archived=1` 浏览归档，用 `after` 继续分页。正文可从 `GET /paperfold-api/v1/public/books/{id}` 按需读取。访客返回值没有个人阅读位置和进度时间。

设备可在 `PUT /paperfold-api/v1/books/{id}` 传 `"publish": true` 来公开上传新书。普通设备同步仍保存到自己的书架。设备在 `PATCH /paperfold-api/v1/books/{id}/shelf` 传 `action` 值 `publish`、`archive`、`restore` 或 `read`，分别对应上架已有书、手动归档、恢复和登记阅读。所有者的有效翻页进度也会更新活动时间。分类使用服务端时钟。满 72 小时的公开书进入归档。已归档的书可以阅读，恢复操作重新开始 72 小时。

读取列表只查询元数据。网页默认按当前书架视图逐本缓存不超过 65,536 字节的正文，大文本由当前设备手动下载。
