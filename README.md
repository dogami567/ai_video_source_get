# VidUnpack（视频拆解箱）

本地优先的 Web 应用：用对话驱动把参考视频“拆解”成可复用素材与可下载打包。

## 本地运行

```powershell
copy .env.example .env
npm install
npm run dev
```

打开 `http://127.0.0.1:6785`。

## 依赖

- Node.js (npm workspaces)
- Rust（后端工具服务）
- ffmpeg（后续媒体处理会用到）

## GitHub Actions 打包（Windows / macOS）

仓库的 CI 会在 Push/PR 时构建并产出可下载的 artifacts（包含 web UI + orchestrator + toolserver 二进制）。

下载并解压后：

```powershell
copy .env.example .env
npm ci --omit=dev
powershell -ExecutionPolicy Bypass -File .\run.ps1
```

macOS 参考 `RUNNING.md`。
