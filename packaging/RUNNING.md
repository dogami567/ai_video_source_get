# VidUnpack artifacts (Windows / macOS)

This package contains **pre-built outputs** (web UI + orchestrator + Rust toolserver).

## Prerequisites

- Node.js (recommended: 20+)
- ffmpeg (optional but recommended; some features will be unavailable without it)
- Optional API keys (edit `.env`):
  - `GEMINI_API_KEY` (and optional `BASE_URL`, `DEFAULT_MODEL`)
  - `EXA_API_KEY`

## Run

1. Copy `.env.example` to `.env` and fill in keys if you want AI features.
2. Install runtime deps (needed for the orchestrator):

```bash
npm ci --omit=dev
```

3. Start the app:

- Windows (PowerShell):
  - `powershell -ExecutionPolicy Bypass -File .\\run.ps1`
- macOS:
  - `chmod +x ./run.sh && ./run.sh`

4. Open `http://127.0.0.1:6785`.

## Data

All runtime data is stored under `data/` by default (SQLite + project artifacts).
