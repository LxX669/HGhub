# HGhub → SenPlayer IPTV 适配服务（v0.1）

本目录是**独立的 Cloudflare Worker**，把 HGhub 使用的公开短剧目录转换成 SenPlayer 能订阅的 M3U 播放列表。不修改现有 HGhub Windows / Android 客户端。

> **测试版**：目前依据仓库的 `docs/API.md` 开发，已完成模拟接口的单元测试，尚未验证 Cloudflare 环境中的真实上游接口和 iPhone 实际播放。非上游官方服务。请仅访问你有权使用的内容，并遵守来源网站的使用条款和当地法律。

## 功能

- `GET /playlist.m3u`：按分类生成 M3U 列表，**每一集是一个 IPTV 条目**，不是 Emby/Jellyfin 式影视库。
- `GET /play/{剧目ID}/{集数}/index.m3u8`：在点击播放时向上游实时请求新的 M3U8 地址，然后 **HTTP 302 跳转**至视频 CDN，避免把短期有效的 `auth_key` 写死在订阅里。
- `GET /health`：检查 Worker 本身能否访问（**不**代表上游可用）。
- 可通过 Worker 运行时密钥 `ACCESS_KEY` 保护私人订阅链接。
- **不托管或中转视频分片，不破解 DRM/付费内容，不绕过登录**；媒体由 SenPlayer 直接访问上游 CDN。
- 暂不提供海报：上游部分封面采用加密格式，直接放进 M3U 会出现损坏图片。

## 从 GitHub 部署到 Cloudflare（推荐）

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/) → **Workers & Pages** → **Create application** → 选择 **GitHub**，授权仓库 `LxX669/HGhub`。
2. 选择仓库 `LxX669/HGhub`，分支 `main`，将 **Root directory（根目录）设置为 `bridge`**，这一项非常重要，不能选择整个 Tauri 工程的根目录。
3. Worker 名称设置为 **`hghub-senplayer`**（与 `wrangler.jsonc` 中的 `name` 一致）。**Build command** 留空，**Deploy command** 用默认 `npx wrangler deploy`。点击 **Save and Deploy**。
4. 建议在 Worker 的 **Settings → Variables & Secrets** 设置一个运行时 Secret，名称为 `ACCESS_KEY`，值为你自行生成的长随机字符串。**不要把密钥发到聊天或提交到 GitHub。**
5. 部署后先访问：`https://hghub-senplayer.<你的workers子域名>.workers.dev/health`。它返回 `ok: true` 表示 Worker 已运行。
6. 在 iPhone 的 **SenPlayer → IPTV → + → 在线订阅** 填入：

   `https://hghub-senplayer.<你的workers子域名>.workers.dev/playlist.m3u?category=all`

   如果设置了 `ACCESS_KEY`，再在链接末尾加 `&key=<你的密钥>`。

**重要：** 第一次一定要打开 `/playlist.m3u`，确认看到 `#EXTM3U` 和后面的节目行。只有 `/health` 成功不足以证明上游接口能访问。

## 订阅参数

| 参数 | 默认 | 可选 |
| --- | --- | --- |
| `category` | `all` | `all`、`ai-duanju`、`ai-manju`、`ai-huanlian`、`ai-mogai` |
| `pages` | `1` | `1`～`3` |
| `size` | `20` | `1`～`30` |
| `max_episodes` | `60` | `1`～`120` |

例如：`/playlist.m3u?category=ai-duanju&pages=2&size=20&max_episodes=30`

如有新剧或新增集数，使用 SenPlayer 的刷新/更新订阅按钮。已经导入的每一集播放地址，会在请求时重新向上游获取临时链接。

## 已知限制

- 仍需验证 SenPlayer 是否接受视频地址的 **302 跳转**，以及 CDN 是否允许 iOS 设备直接播放。如果不支持，本版本可能导入成功却无法播放。
- IPTV 订阅本质是平铺的频道列表，不支持按剧目进入完整详情页、观看进度同步、内建选集界面。
- 按目录中的 `episode_count` 生成条目；如果个别集数暂未开放播放，点击后会报错。
- 默认只允许重定向至 `hzjvlo.cn` 和 `drleao.cn` 下的 HTTPS 视频域名。若 CDN 更换，可在 Worker 运行时变量 `ALLOWED_MEDIA_HOSTS` 中填入**经过核实**的其他域名，以英文逗号分隔。
- 若来源官网域名变动，可在 Worker 运行时变量 `UPSTREAM_ORIGIN` 中配置新的 HTTPS 官网，不会自动查找镜像或绕过访问限制。
- 不设 `ACCESS_KEY` 时，Worker 的订阅和播放跳转接口是公开的。设了密钥后，带 `key=` 的订阅地址也应当保密。
- Worker 只按需调用上游：每页目录一次请求、每次播放一次请求，不缓存带签名的播放链接。

## 本地测试

Node.js 20+，测试无需安装依赖：

```bash
cd bridge
npm test
```

本地调试及手动部署（需要 Cloudflare 账户授权）：

```bash
cd bridge
npm install
npx wrangler dev
npx wrangler deploy
```