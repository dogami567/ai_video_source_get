# VidUnpack MVP Plan (2026-01-22)

## Product

- Name: VidUnpack（视频拆解箱）
- Form: Local-first Web app (localhost)
- Default port: `6785`
- Data root: `data/` (project-scoped folders + SQLite index)
- License: MIT

## Core idea

Chat-driven workflow: import a reference video (local file, or paste link with one-time confirmation) → AI “watches” short clips + uses web search → aggregates reusable assets (meme images/GIFs, audio, etc.) → user selects → one-click pack download (zip) + static report.

## Fixed decisions (current defaults)

- Orchestration: LangGraphJS (Node/TS)
- Tooling: Rust (axum) as the “tool server” for media/fs/sqlite/zip
- Video understanding: Gemini API (via `BASE_URL`), default model `gemini-3-pro-preview`
- Clip sampling: start with 3 clips (start/mid/end), model can request more clips if needed
- Web search: Exa (API key), 5 results per round, up to 3 rounds, allow fetching URL content
- “Think MCP”: enabled by default and visible in UI; can be toggled off by user
- Consent: confirm once per project; “auto confirm” toggle within project; new project re-confirms
- Export: include original video by default; show size estimate before zip export; default de-dup on
- Output files: static `report.html` + `manifest.json` + selected assets + zip export
- User profile: model-maintained cross-project summary (stored locally; file view optional)

## Phase breakdown

## Phase 0 - Repo reset & new scaffold
- Replace existing repo contents with VidUnpack scaffold (React + Node + Rust).
- Development workflow: `npm run dev` (frontend + orchestrator + tool server).

## Phase 1 - Backend tool server baseline (Rust)
- axum HTTP API, health, config, ffmpeg preflight.
- Paths: data root, per-project folder layout, file IO helpers.

## Phase 2 - Storage (SQLite) + project workspace model
- SQLite schema for projects, runs, artifacts, consent flags, profile summary.
- CRUD: create/list/open project; append events/logs.

## Phase 3 - Project creation UI + import (local file + link w/ confirm)
- Web UI to create/open project, import local video.
- Paste link → show disclaimer + one-time confirm (project-scoped).

## Phase 4 - Media pipeline (ffmpeg)
- Probe metadata; extract 3 clips; optional extra clip extraction on demand.
- Extract audio + thumbnails/frames; cache outputs under project folder.

## Phase 5 - Gemini integration (video understanding)
- Send clips (and optionally transcript) to Gemini via API (`BASE_URL`).
- Model select in UI; default `gemini-3-pro-preview`.

## Phase 6 - Exa search + web fetch (3-round budget)
- `web_search` tool (Exa) with 5 results/round; allow 2nd/3rd round refinement.
- `web_fetch` to read a small set of URLs; store citations for report.

## Phase 7 - Think MCP (visible planning panel) + toggles
- `think()` tool produces next-step plan, search queries, and “need confirm” decisions.
- UI shows plan; user can toggle think on/off; record all steps to project log.

## Phase 8 - Asset aggregation (meme-first MVP)
- Aggregate candidate assets into a “selection pool” (grouping + dedup + source/license metadata).
- Allow “keep searching for X” iteration in chat.

## Phase 9 - Static report generation
- Generate `report.html` (static) + `manifest.json` (machine reproducible).
- Report includes sources/citations and per-asset provenance.

## Phase 10 - Selection + zip export (include original video)
- UI defaults to “select all”; user can uncheck.
- Export zip with only selected items; show size estimate; include original video by default.

## Phase 11 - Frontend UX via gemini-skill (Gemini leads visuals)
- Use gemini-skill workflow: minimal functional requirements, let Gemini design UI/layout/animations.
- Codex integrates output, fixes build/type/runtime, ensures accessibility and smooth UX.

## Phase 12 - Profile summary update (cross-project)
- After export: generate short “session summary” and update global profile (overwrite/merge, not append forever).
- Inject profile into future orchestration prompts.

## Phase 13 - CI build & packaging artifacts
- GitHub Actions: build/test; package downloadable artifacts for Windows/macOS users.

