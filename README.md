# VidUnpack（视频拆解箱）

本地优先的 Web 应用：用对话驱动把参考视频“拆解”成可复用素材与可下载打包。

## 本地运行

```powershell
copy .env.example .env
npm install
npm run dev
```

打开 `http://127.0.0.1:6785`。

（Windows 一键测试启动）也可以直接双击运行 `run_test.bat`。
（仅启动后端：orchestrator + toolserver）可以运行 `run_backend.bat`。

## 设置（可选）

应用右上角 **Settings/设置** 支持在浏览器本地保存 `BASE_URL`、Gemini/Exa 的 API Key 与默认模型：

- 留空：使用 `.env`（环境变量）
- 填写并保存：优先使用浏览器本地设置（localStorage）

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
