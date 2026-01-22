# ai_video_source_get

一个用于“AI 视频源获取”的项目骨架（当前为最小可运行 CLI + GitHub Actions 跨平台打包流水线）。

## 本地运行

```powershell
python -m pip install -e .
ai-video-source-get --help

# 或者（无需安装）：
python .\\pyinstaller_entry.py --help
```

## 打包产物

本仓库已配置 GitHub Actions，在 `push` / `pull_request` 时会在：

- Windows：生成 `dist/ai-video-source-get.exe`
- macOS：生成 `dist/ai-video-source-get`

并作为 Actions Artifacts 上传（后续也可改为打 tag 自动发 Release）。

> 目前已支持：推送 `v*` tag 时自动创建 GitHub Release 并附带打包产物。
