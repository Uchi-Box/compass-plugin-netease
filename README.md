# compass-plugin-netease

> 网易云音乐数据源插件 for [Compass Music](https://github.com/Uchi-Box/CompassMusic)

搜索、播放网易云音乐，支持二维码登录和歌单同步。

## 功能

- 🔍 **搜索** — 搜索网易云音乐曲库
- 🎵 **播放** — 获取音频流 URL（支持标准/高品质/无损/Hi-Res）
- 📝 **歌词** — 获取逐行时间轴歌词（含翻译）
- 📋 **歌单同步** — 登录后一键同步网易云歌单到 Compass
- 🔐 **二维码登录** — 使用网易云音乐 APP 扫码登录

## 前提条件

本插件需要一个自部署的 [NeteaseCloudMusicApi Enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 服务。

### 快速部署 API 服务

```bash
# Docker（推荐）
docker run -d -p 3000:3000 moefurina/ncm-api:latest

# 或 Node.js
git clone https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced
cd api-enhanced && pnpm i && node app.js
```

## 安装

从 Compass Music 的 Plugin Store 安装，或手动 symlink 到插件目录：

```bash
# 开发模式
ln -s /path/to/compass-plugin-netease ~/.compass/packages/compass-plugin-netease
```

## 配置

在 Compass Music 设置中配置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| API 服务地址 | `http://localhost:3000` | NeteaseCloudMusicApi 服务的 URL |
| 搜索结果数量 | 30 | 每次搜索返回的最大结果数 |
| 音质 | exhigh (320kbps) | standard / exhigh / lossless / hires |

## 使用

### 搜索

安装并配置好 API 地址后，在 Compass 搜索框中搜索即可自动包含网易云结果。

### 登录

使用命令面板执行 `netease:login`，弹出二维码窗口，用网易云 APP 扫码即可。

### 同步歌单

登录后执行命令 `netease:sync-playlists`，将网易云中的所有歌单同步到 Compass。

### 可用命令

| 命令 | 说明 |
|------|------|
| `netease:login` | 二维码登录 |
| `netease:logout` | 退出登录 |
| `netease:sync-playlists` | 同步歌单到 Compass |
| `netease:check-status` | 查看登录状态 |

## 开发

```bash
pnpm install
pnpm dev      # 监听模式构建
pnpm test     # 运行测试
pnpm build    # 构建
```

## 许可证

MIT
