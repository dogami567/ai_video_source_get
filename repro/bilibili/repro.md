# Bilibili 登录态（session）获取与复用（不存 cookie）

目标：让本项目在处理 B 站链接时，**尽量使用你浏览器里已登录的会话**（避免在应用里保存账号密码或 cookie）。

## 前置条件

- 你已经在本机浏览器（Chrome/Edge/Firefox 等）登录了 B 站
- 安装好 `yt-dlp`（并在 PATH 可用）
- 如需打包/合并 mp4：安装 `ffmpeg`（并在 PATH 可用）

> 安全边界：不提供绕过验证码/风控的方法；如遇验证码，请在浏览器中手动完成登录。

## 推荐方案：`--cookies-from-browser`（最少配置）

1. 先在浏览器里正常登录 B 站。
2. 在 `.env` 或 Web UI 的 Settings 里配置：
   - `.env`：`YTDLP_COOKIES_FROM_BROWSER=chrome`（或 `edge` / `firefox`）
   - 或 UI：Settings → Downloader → Cookies from browser
3. 验证 session 是否可用（不会输出/保存 cookie）：

```bash
npx tsx repro/bilibili/session.ts --url "https://www.bilibili.com/video/BVxxxxxxxx"
```

输出里会包含 extractor/id/title 等摘要信息。

## 应用内使用

- 在项目里粘贴 URL 并保存（首次需要确认授权）。
- 在 URL 列表右侧点击：
  - `Resolve/解析`：只解析元数据并写入 `ytdlp_info` 工件
  - `Download/下载`：下载到项目 `media/remote/`，并作为 `input_video` 出现在本地视频列表中

