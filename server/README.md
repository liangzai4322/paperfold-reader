# 私人书架同步

纸间的正文、导入记录和阅读位置同步到自己的服务器。网页和安卓使用同一个同步密钥连接。AI 使用独立的导入密钥。

## 部署

服务使用 Python 3.9+、SQLite 和 HTTPS 反向代理。进程默认只监听 `127.0.0.1:8794`。可用本目录的 systemd 单元。将脚本装到 `/opt/paperfold/paperfold_sync.py`，将两个随机密钥写入权限为 0600 的 `/etc/paperfold/sync.env`。每个密钥可用 `openssl rand -hex 32` 单独生成。密钥名称为 `PAPERFOLD_SYNC_TOKEN` 和 `PAPERFOLD_INGEST_TOKEN`。备份 SQLite 时使用 SQLite 的备份命令，以包含 WAL 中已提交的数据。

在专用 HTTPS 入口中按原路径转发 `/paperfold-api/*`。例如，Caddy 站点片段如下。

```caddyfile
handle /paperfold-api/* {
    reverse_proxy 127.0.0.1:8794
}
```

`GET /paperfold-api/healthz` 用于检查服务可达性。部署后，在纸间首页点「云同步」，输入 HTTPS 服务器地址和同步密钥。首次连接会上传本机书架。正文按需下载，下载过的文章可以离线读。联网后会补传阅读进度。原系统只保留最近一篇，升级会自动迁移这一篇及其阅读进度。

## AI 导入

`POST /paperfold-api/v1/books` 支持 `title`、`text`、`format`。标题可省略，正文必填。格式可为 `auto`、`markdown` 或 `plain`，默认 `auto`。JSON 请求最大 8 MiB。使用同一个 `Idempotency-Key` 重试同一篇文章时，服务会返回原来的书籍 ID。

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

导入密钥仅可提交文章。设备密钥可读取书架和文章正文，也可写入阅读进度。设备的翻页模式、字号、字体和背景继续由本机保存。多个设备打开同一本书时，以最近一次保存的翻页或跳页进度作为下次打开的位置。
