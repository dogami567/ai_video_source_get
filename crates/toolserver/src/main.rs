use anyhow::Context;
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::{
    io::ErrorKind,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;
use zip::write::FileOptions;
use zip::ZipWriter;

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    service: &'static str,
    data_dir: String,
    ffmpeg: bool,
    ffprobe: bool,
    ytdlp: bool,
    db_path: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let data_dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "data".to_string()));
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("failed to create DATA_DIR at {}", data_dir.display()))?;

    let ffmpeg = detect_ffmpeg();
    let ffprobe = detect_ffprobe();
    if !ffmpeg || !ffprobe {
        tracing::warn!("ffmpeg/ffprobe not found on PATH; ffmpeg-dependent features will be unavailable");
    }

    let ytdlp_cmd = std::env::var("YTDLP_PATH").unwrap_or_else(|_| "yt-dlp".to_string());
    let ytdlp = detect_ytdlp(&ytdlp_cmd);
    if !ytdlp {
        tracing::warn!("yt-dlp not found on PATH; URL download/resolve features will be unavailable");
    }

    let db_path = data_dir.join("vidunpack.sqlite3");
    init_db(&db_path)?;

    let state = AppState {
        data_dir,
        db_path,
        ffmpeg,
        ffprobe,
        ytdlp,
        ytdlp_cmd,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/profile", get(get_profile))
        .route("/profile/reset", post(reset_profile))
        .route("/projects", post(create_project).get(list_projects))
        .route("/projects/{id}", get(get_project))
        .route("/projects/{id}/consent", get(get_consent).post(upsert_consent))
        .route("/projects/{id}/settings", get(get_project_settings).post(update_project_settings))
        .route("/projects/{id}/artifacts", get(list_artifacts))
        .route("/projects/{id}/artifacts/text", post(create_text_artifact))
        .route("/projects/{id}/artifacts/upload", post(upload_file_artifact))
        .route(
            "/projects/{id}/artifacts/{artifact_id}/raw",
            get(download_artifact_raw),
        )
        .route("/projects/{id}/chats", post(create_chat).get(list_chats))
        .route(
            "/projects/{id}/chats/{chat_id}/messages",
            get(list_chat_messages).post(create_chat_message),
        )
        .route("/projects/{id}/pool/items", get(list_pool_items).post(add_pool_item))
        .route("/projects/{id}/pool/items/{item_id}/selected", post(set_pool_item_selected))
        .route("/projects/{id}/inputs/url", post(add_input_url))
        .route("/projects/{id}/media/local", post(import_local_video))
        .route("/projects/{id}/media/remote", post(import_remote_media))
        .route("/projects/{id}/pipeline/ffmpeg", post(ffmpeg_pipeline))
        .route("/projects/{id}/exports/report", post(generate_report))
        .route("/projects/{id}/exports/zip/estimate", post(estimate_export_zip))
        .route("/projects/{id}/exports/zip", post(export_zip))
        .route("/projects/{id}/exports/download/{file}", get(download_export_file))
        .route("/projects/import/manifest", post(import_manifest))
        .layer(DefaultBodyLimit::disable())
        .with_state(state);

    let port: u16 = std::env::var("TOOLSERVER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6791);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = bind_with_retry(addr).await?;

    tracing::info!("toolserver listening on http://{addr}");
    axum::serve(listener, app).await.context("toolserver failed")?;
    Ok(())
}

async fn bind_with_retry(addr: SocketAddr) -> anyhow::Result<tokio::net::TcpListener> {
    let mut last: Option<std::io::Error> = None;
    for _attempt in 0..20 {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => return Ok(listener),
            Err(e) if e.kind() == ErrorKind::AddrInUse => {
                last = Some(e);
                // Best-effort: allow a short grace period for a previous process to release the port.
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
            Err(e) => return Err(anyhow::Error::new(e).context(format!("failed to bind to {addr}"))),
        }
    }

    let msg = last
        .as_ref()
        .map(|e| e.to_string())
        .unwrap_or_else(|| "address already in use".to_string());
    Err(anyhow::anyhow!(
        "failed to bind to {addr} after retries: {msg}. Stop the process using this port or set TOOLSERVER_PORT."
    ))
}

#[derive(Clone)]
struct AppState {
    data_dir: PathBuf,
    db_path: PathBuf,
    ffmpeg: bool,
    ffprobe: bool,
    ytdlp: bool,
    ytdlp_cmd: String,
}

fn detect_ffmpeg() -> bool {
    let output = Command::new("ffmpeg").arg("-version").output();

    match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

fn detect_ffprobe() -> bool {
    let output = Command::new("ffprobe").arg("-version").output();

    match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

fn detect_ytdlp(cmd: &str) -> bool {
    let output = Command::new(cmd).arg("--version").output();

    match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfileMemoryCount {
    key: String,
    count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfileMemory {
    version: i64,
    updated_at_ms: i64,
    exports_seen: i64,
    kind_counts: Vec<ProfileMemoryCount>,
    source_domain_counts: Vec<ProfileMemoryCount>,
    prompt: String,
    last_session_summary: String,
}

impl Default for ProfileMemory {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at_ms: 0,
            exports_seen: 0,
            kind_counts: Vec::new(),
            source_domain_counts: Vec::new(),
            prompt: String::new(),
            last_session_summary: String::new(),
        }
    }
}

fn profile_file_name() -> &'static str {
    "profile.json"
}

fn truncate_with_ellipsis(s: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let mut out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        out.push('…');
    }
    out
}

fn url_domain(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }

    let without_scheme = trimmed.split("://").nth(1).unwrap_or(trimmed);
    let host_port = without_scheme.split('/').next().unwrap_or(without_scheme);
    let host_port = host_port.split('@').last().unwrap_or(host_port);
    let host = host_port.split(':').next().unwrap_or(host_port);
    let host = host.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_lowercase())
    }
}

fn merge_top_counts(existing: &mut Vec<ProfileMemoryCount>, adds: impl IntoIterator<Item = ProfileMemoryCount>, limit: usize) {
    let mut map: BTreeMap<String, i64> = existing.iter().map(|e| (e.key.clone(), e.count)).collect();
    for a in adds {
        if a.key.trim().is_empty() {
            continue;
        }
        *map.entry(a.key).or_insert(0) += a.count;
    }
    let mut out: Vec<ProfileMemoryCount> = map
        .into_iter()
        .map(|(key, count)| ProfileMemoryCount { key, count })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    out.truncate(limit);
    *existing = out;
}

fn build_profile_prompt(p: &ProfileMemory) -> String {
    let mut lines: Vec<String> = Vec::new();

    if !p.kind_counts.is_empty() {
        let kinds = p
            .kind_counts
            .iter()
            .map(|e| format!("{}({})", e.key, e.count))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Common selected asset kinds: {}", kinds));
    }

    if !p.source_domain_counts.is_empty() {
        let sources = p
            .source_domain_counts
            .iter()
            .map(|e| format!("{}({})", e.key, e.count))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Common input source domains: {}", sources));
    }

    if !p.last_session_summary.trim().is_empty() {
        lines.push(format!("Last export summary: {}", p.last_session_summary.trim()));
    }

    truncate_with_ellipsis(&lines.join("\n"), 800)
}

fn load_profile(conn: &Connection) -> anyhow::Result<ProfileMemory> {
    let row: Option<String> = conn
        .query_row("SELECT summary FROM profile WHERE id = 1", [], |r| r.get(0))
        .optional()?;

    let Some(summary) = row else {
        return Ok(ProfileMemory::default());
    };

    if let Ok(mut parsed) = serde_json::from_str::<ProfileMemory>(&summary) {
        if parsed.version <= 0 {
            parsed.version = 1;
        }
        return Ok(parsed);
    }

    // Backward/unknown format: treat as plain text prompt/summary.
    Ok(ProfileMemory {
        version: 1,
        updated_at_ms: 0,
        exports_seen: 0,
        kind_counts: Vec::new(),
        source_domain_counts: Vec::new(),
        prompt: truncate_with_ellipsis(&summary, 800),
        last_session_summary: truncate_with_ellipsis(&summary, 400),
    })
}

fn save_profile(conn: &Connection, data_dir: &FsPath, profile: &ProfileMemory) -> anyhow::Result<()> {
    let updated_at_ms = profile.updated_at_ms;
    let json = serde_json::to_string_pretty(profile)?;

    conn.execute(
        "INSERT INTO profile (id, summary, updated_at_ms) VALUES (1, ?1, ?2)\n         ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, updated_at_ms = excluded.updated_at_ms",
        params![&json, updated_at_ms],
    )?;

    let file_abs = data_dir.join(profile_file_name());
    std::fs::write(&file_abs, json.as_bytes()).with_context(|| format!("failed to write {}", file_abs.display()))?;
    Ok(())
}

fn update_profile_after_export(
    conn: &Connection,
    data_dir: &FsPath,
    project_id: &str,
    ts: i64,
    include_original_video: bool,
    include_report: bool,
    include_manifest: bool,
    include_clips: bool,
    include_audio: bool,
    include_thumbnails: bool,
) -> anyhow::Result<()> {
    let kind_counts: Vec<ProfileMemoryCount> = {
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*) FROM pool_items WHERE project_id = ?1 AND selected = 1 GROUP BY kind ORDER BY kind ASC",
        )?;
        let rows = stmt.query_map([project_id], |row| Ok(ProfileMemoryCount { key: row.get(0)?, count: row.get(1)? }))?;
        rows.filter_map(Result::ok).collect()
    };

    let input_source_domain: Option<String> = conn
        .query_row(
            "SELECT path FROM artifacts WHERE project_id = ?1 AND kind = 'input_url' ORDER BY created_at_ms DESC LIMIT 1",
            [project_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|u| url_domain(&u));

    let mut parts: Vec<String> = Vec::new();
    if let Some(domain) = input_source_domain.as_ref() {
        parts.push(format!("source={domain}"));
    }
    if !kind_counts.is_empty() {
        let selected = kind_counts
            .iter()
            .filter(|e| e.count > 0)
            .map(|e| format!("{}({})", e.key, e.count))
            .collect::<Vec<_>>()
            .join(", ");
        if !selected.is_empty() {
            parts.push(format!("selected={selected}"));
        }
    }
    parts.push(format!("include_original_video={include_original_video}"));
    parts.push(format!("include_report={include_report}"));
    parts.push(format!("include_manifest={include_manifest}"));
    parts.push(format!("include_clips={include_clips}"));
    parts.push(format!("include_audio={include_audio}"));
    parts.push(format!("include_thumbnails={include_thumbnails}"));

    let session_summary = truncate_with_ellipsis(&format!("Exported; {}", parts.join("; ")), 400);

    // Persist per-project summary artifact.
    {
        let rel = format!("projects/{}/analysis/session_summary-{}.txt", project_id, ts);
        let abs = data_dir.join(&rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&abs, format!("{session_summary}\n"))?;
        let art = ensure_artifact(conn, project_id, "session_summary", &rel, ts)?;
        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'session_summary_generated', ?3)",
            params![project_id, ts, serde_json::json!({ "artifact_id": art.id, "path": rel }).to_string()],
        )?;
    }

    let mut profile = load_profile(conn)?;
    profile.exports_seen = profile.exports_seen.saturating_add(1);
    profile.updated_at_ms = ts;
    profile.last_session_summary = session_summary;

    merge_top_counts(&mut profile.kind_counts, kind_counts, 5);
    if let Some(domain) = input_source_domain {
        merge_top_counts(
            &mut profile.source_domain_counts,
            [ProfileMemoryCount { key: domain, count: 1 }],
            5,
        );
    }

    profile.prompt = build_profile_prompt(&profile);
    save_profile(conn, data_dir, &profile)?;

    conn.execute(
        "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'profile_updated', ?3)",
        params![project_id, ts, serde_json::json!({ "file": profile_file_name() }).to_string()],
    )?;

    Ok(())
}

fn init_db(db_path: &FsPath) -> anyhow::Result<()> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("failed to open sqlite db at {}", db_path.display()))?;

    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs(project_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project_id ON artifacts(project_id);

CREATE TABLE IF NOT EXISTS consents (
  project_id TEXT PRIMARY KEY,
  consented INTEGER NOT NULL DEFAULT 0,
  auto_confirm INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS project_settings (
  project_id TEXT PRIMARY KEY,
  think_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS pool_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  source_url TEXT,
  license TEXT,
  dedup_key TEXT NOT NULL,
  data_json TEXT,
  selected INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_items_dedup ON pool_items(project_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_pool_items_project_id ON pool_items(project_id);

CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  summary TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_chats_project_id ON chats(project_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  data_json TEXT,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(chat_id) REFERENCES chats(id)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_project_id ON chat_messages(project_id);
        "#,
    )
    .context("failed to init sqlite schema")?;

    Ok(())
}

#[derive(Debug)]
enum AppError {
    BadRequest(String),
    NotFound(String),
    PreconditionFailed(String),
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        Self::Internal(value)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            Self::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            Self::PreconditionFailed(msg) => (StatusCode::PRECONDITION_FAILED, msg),
            Self::Internal(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        };
        (status, Json(serde_json::json!({ "ok": false, "error": message }))).into_response()
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Deserialize)]
struct CreateProjectRequest {
    title: Option<String>,
}

#[derive(Serialize)]
struct ProjectResponse {
    id: String,
    title: String,
    created_at_ms: i64,
}

async fn create_project(State(state): State<AppState>, Json(req): Json<CreateProjectRequest>) -> AppResult<Json<ProjectResponse>> {
    let title = req.title.unwrap_or_default();
    let project_id = Uuid::new_v4().to_string();
    let created_at_ms = now_ms();

    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.clone();

    let project = tokio::task::spawn_blocking(move || -> anyhow::Result<ProjectResponse> {
        let conn = Connection::open(&db_path)?;

        conn.execute(
            "INSERT INTO projects (id, title, created_at_ms) VALUES (?1, ?2, ?3)",
            params![&project_id, &title, created_at_ms],
        )?;

        let projects_root = data_dir.join("projects");
        let project_dir = projects_root.join(&project_id);
        std::fs::create_dir_all(project_dir.join("media"))?;
        std::fs::create_dir_all(project_dir.join("assets"))?;
        std::fs::create_dir_all(project_dir.join("out"))?;
        std::fs::create_dir_all(project_dir.join("tmp"))?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'project_created', ?3)",
            params![
                &project_id,
                created_at_ms,
                serde_json::json!({ "title": &title }).to_string()
            ],
        )?;

        Ok(ProjectResponse {
            id: project_id,
            title,
            created_at_ms,
        })
    })
    .await
    .context("create_project task failed")??;

    Ok(Json(project))
}

async fn list_projects(State(state): State<AppState>) -> AppResult<Json<Vec<ProjectResponse>>> {
    let db_path = state.db_path.clone();
    let projects = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ProjectResponse>> {
        let conn = Connection::open(&db_path)?;
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at_ms FROM projects ORDER BY created_at_ms DESC LIMIT 100",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ProjectResponse {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at_ms: row.get(2)?,
            })
        })?;

        Ok(rows.filter_map(Result::ok).collect())
    })
    .await
    .context("list_projects task failed")??;

    Ok(Json(projects))
}

async fn get_project(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Json<ProjectResponse>> {
    if id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let db_path = state.db_path.clone();
    let project = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProjectResponse>> {
        let conn = Connection::open(&db_path)?;
        let mut stmt = conn.prepare("SELECT id, title, created_at_ms FROM projects WHERE id = ?1")?;
        let mut rows = stmt.query([id])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(ProjectResponse {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at_ms: row.get(2)?,
            }));
        }
        Ok(None)
    })
    .await
    .context("get_project task failed")??;

    match project {
        Some(p) => Ok(Json(p)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Serialize)]
struct ConsentResponse {
    project_id: String,
    consented: bool,
    auto_confirm: bool,
    updated_at_ms: i64,
}

async fn get_consent(State(state): State<AppState>, Path(project_id): Path<String>) -> AppResult<Json<ConsentResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let db_path = state.db_path.clone();
    let consent = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ConsentResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool =
            conn.query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
                .optional()?
                .is_some();
        if !exists {
            return Ok(None);
        }

        let mut stmt = conn.prepare("SELECT consented, auto_confirm, updated_at_ms FROM consents WHERE project_id = ?1")?;
        let mut rows = stmt.query([&project_id])?;
        if let Some(row) = rows.next()? {
            let consented_i: i64 = row.get(0)?;
            let auto_i: i64 = row.get(1)?;
            let updated_at_ms: i64 = row.get(2)?;
            return Ok(Some(ConsentResponse {
                project_id,
                consented: consented_i != 0,
                auto_confirm: auto_i != 0,
                updated_at_ms,
            }));
        }

        Ok(Some(ConsentResponse {
            project_id,
            consented: false,
            auto_confirm: false,
            updated_at_ms: 0,
        }))
    })
    .await
    .context("get_consent task failed")??;

    match consent {
        Some(c) => Ok(Json(c)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Deserialize)]
struct UpsertConsentRequest {
    consented: Option<bool>,
    auto_confirm: Option<bool>,
}

async fn upsert_consent(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<UpsertConsentRequest>,
) -> AppResult<Json<ConsentResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let db_path = state.db_path.clone();
    let consent = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ConsentResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool =
            conn.query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
                .optional()?
                .is_some();
        if !exists {
            return Ok(None);
        }

        let mut stmt = conn.prepare("SELECT consented, auto_confirm FROM consents WHERE project_id = ?1")?;
        let mut rows = stmt.query([&project_id])?;
        let mut existing_consented = false;
        let mut existing_auto_confirm = false;
        if let Some(row) = rows.next()? {
            let consented_i: i64 = row.get(0)?;
            let auto_i: i64 = row.get(1)?;
            existing_consented = consented_i != 0;
            existing_auto_confirm = auto_i != 0;
        }

        let consented = req.consented.unwrap_or(existing_consented);
        let mut auto_confirm = req.auto_confirm.unwrap_or(existing_auto_confirm);
        if !consented {
            auto_confirm = false;
        }

        let updated_at_ms = now_ms();
        conn.execute(
            "INSERT INTO consents (project_id, consented, auto_confirm, updated_at_ms) VALUES (?1, ?2, ?3, ?4)\n             ON CONFLICT(project_id) DO UPDATE SET consented = excluded.consented, auto_confirm = excluded.auto_confirm, updated_at_ms = excluded.updated_at_ms",
            params![
                &project_id,
                if consented { 1 } else { 0 },
                if auto_confirm { 1 } else { 0 },
                updated_at_ms
            ],
        )?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'consent_updated', ?3)",
            params![
                &project_id,
                updated_at_ms,
                serde_json::json!({ "consented": consented, "auto_confirm": auto_confirm }).to_string()
            ],
        )?;

        Ok(Some(ConsentResponse {
            project_id,
            consented,
            auto_confirm,
            updated_at_ms,
        }))
    })
    .await
    .context("upsert_consent task failed")??;

    match consent {
        Some(c) => Ok(Json(c)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Serialize)]
struct ProjectSettingsResponse {
    project_id: String,
    think_enabled: bool,
    updated_at_ms: i64,
}

async fn get_project_settings(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> AppResult<Json<ProjectSettingsResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let db_path = state.db_path.clone();
    let settings = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProjectSettingsResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let mut stmt =
            conn.prepare("SELECT think_enabled, updated_at_ms FROM project_settings WHERE project_id = ?1")?;
        let mut rows = stmt.query([&project_id])?;
        if let Some(row) = rows.next()? {
            let think_enabled_i: i64 = row.get(0)?;
            let updated_at_ms: i64 = row.get(1)?;
            return Ok(Some(ProjectSettingsResponse {
                project_id,
                think_enabled: think_enabled_i != 0,
                updated_at_ms,
            }));
        }

        Ok(Some(ProjectSettingsResponse {
            project_id,
            think_enabled: true,
            updated_at_ms: 0,
        }))
    })
    .await
    .context("get_project_settings task failed")??;

    match settings {
        Some(s) => Ok(Json(s)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Deserialize)]
struct UpdateProjectSettingsRequest {
    think_enabled: bool,
}

async fn update_project_settings(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<UpdateProjectSettingsRequest>,
) -> AppResult<Json<ProjectSettingsResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let db_path = state.db_path.clone();
    let settings = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProjectSettingsResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let think_enabled = req.think_enabled;
        let updated_at_ms = now_ms();
        conn.execute(
            "INSERT INTO project_settings (project_id, think_enabled, updated_at_ms) VALUES (?1, ?2, ?3)\n             ON CONFLICT(project_id) DO UPDATE SET think_enabled = excluded.think_enabled, updated_at_ms = excluded.updated_at_ms",
            params![&project_id, if think_enabled { 1 } else { 0 }, updated_at_ms],
        )?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'project_settings', ?3)",
            params![
                &project_id,
                updated_at_ms,
                serde_json::json!({ "think_enabled": think_enabled }).to_string()
            ],
        )?;

        Ok(Some(ProjectSettingsResponse {
            project_id,
            think_enabled,
            updated_at_ms,
        }))
    })
    .await
    .context("update_project_settings task failed")??;

    match settings {
        Some(s) => Ok(Json(s)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Serialize)]
struct ChatThreadResponse {
    id: String,
    project_id: String,
    title: String,
    created_at_ms: i64,
}

#[derive(Deserialize)]
struct CreateChatRequest {
    title: Option<String>,
}

async fn list_chats(State(state): State<AppState>, Path(project_id): Path<String>) -> AppResult<Json<Vec<ChatThreadResponse>>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let db_path = state.db_path.clone();
    let chats = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Vec<ChatThreadResponse>>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, created_at_ms FROM chats WHERE project_id = ?1 ORDER BY created_at_ms DESC LIMIT 100",
        )?;
        let rows = stmt.query_map([&project_id], |row| {
            Ok(ChatThreadResponse {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                created_at_ms: row.get(3)?,
            })
        })?;
        Ok(Some(rows.filter_map(Result::ok).collect()))
    })
    .await
    .context("list_chats task failed")??;

    match chats {
        Some(v) => Ok(Json(v)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

async fn create_chat(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<CreateChatRequest>,
) -> AppResult<Json<ChatThreadResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let title = req.title.unwrap_or_default();
    let title = title.trim().to_string();

    let db_path = state.db_path.clone();
    let chat = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ChatThreadResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let id = Uuid::new_v4().to_string();
        let created_at_ms = now_ms();
        let title = if title.is_empty() {
            format!("Chat {created_at_ms}")
        } else {
            title
        };

        conn.execute(
            "INSERT INTO chats (id, project_id, title, created_at_ms) VALUES (?1, ?2, ?3, ?4)",
            params![&id, &project_id, &title, created_at_ms],
        )?;
        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'chat_created', ?3)",
            params![&project_id, created_at_ms, serde_json::json!({ "chat_id": &id, "title": &title }).to_string()],
        )?;

        Ok(Some(ChatThreadResponse {
            id,
            project_id,
            title,
            created_at_ms,
        }))
    })
    .await
    .context("create_chat task failed")??;

    match chat {
        Some(c) => Ok(Json(c)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Serialize)]
struct ChatMessageResponse {
    id: String,
    project_id: String,
    chat_id: String,
    role: String,
    content: String,
    data: Option<serde_json::Value>,
    created_at_ms: i64,
}

#[derive(Deserialize)]
struct CreateChatMessageRequest {
    role: String,
    content: String,
    data: Option<serde_json::Value>,
}

fn is_valid_chat_role(role: &str) -> bool {
    matches!(role, "user" | "assistant" | "system" | "tool")
}

async fn list_chat_messages(
    State(state): State<AppState>,
    Path((project_id, chat_id)): Path<(String, String)>,
) -> AppResult<Json<Vec<ChatMessageResponse>>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }
    if chat_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing chat id".to_string()));
    }

    let db_path = state.db_path.clone();
    let messages = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Vec<ChatMessageResponse>>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM chats WHERE id = ?1 AND project_id = ?2", params![&chat_id, &project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let mut stmt = conn.prepare(
            "SELECT id, project_id, chat_id, role, content, data_json, created_at_ms\n             FROM chat_messages WHERE project_id = ?1 AND chat_id = ?2 ORDER BY created_at_ms ASC LIMIT 500",
        )?;
        let rows = stmt.query_map(params![&project_id, &chat_id], |row| {
            let data_json: Option<String> = row.get(5)?;
            let data: Option<serde_json::Value> = data_json.and_then(|s| serde_json::from_str(&s).ok());
            Ok(ChatMessageResponse {
                id: row.get(0)?,
                project_id: row.get(1)?,
                chat_id: row.get(2)?,
                role: row.get(3)?,
                content: row.get(4)?,
                data,
                created_at_ms: row.get(6)?,
            })
        })?;
        Ok(Some(rows.filter_map(Result::ok).collect()))
    })
    .await
    .context("list_chat_messages task failed")??;

    match messages {
        Some(v) => Ok(Json(v)),
        None => Err(AppError::NotFound("chat not found".to_string())),
    }
}

async fn create_chat_message(
    State(state): State<AppState>,
    Path((project_id, chat_id)): Path<(String, String)>,
    Json(req): Json<CreateChatMessageRequest>,
) -> AppResult<Json<ChatMessageResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }
    if chat_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing chat id".to_string()));
    }

    let role = req.role.trim().to_string();
    if role.is_empty() || !is_valid_chat_role(&role) {
        return Err(AppError::BadRequest("invalid role".to_string()));
    }

    let content = req.content.trim_end().to_string();
    let data_json = req.data.as_ref().map(|v| v.to_string());
    if content.trim().is_empty() && data_json.is_none() {
        return Err(AppError::BadRequest("missing content".to_string()));
    }
    let db_path = state.db_path.clone();

    let msg = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ChatMessageResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM chats WHERE id = ?1 AND project_id = ?2",
                params![&chat_id, &project_id],
                |_row| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let id = Uuid::new_v4().to_string();
        let created_at_ms = now_ms();
        conn.execute(
            "INSERT INTO chat_messages (id, project_id, chat_id, role, content, data_json, created_at_ms)\n             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![&id, &project_id, &chat_id, &role, &content, data_json.as_deref(), created_at_ms],
        )?;

        Ok(Some(ChatMessageResponse {
            id,
            project_id,
            chat_id,
            role,
            content,
            data: data_json.and_then(|s| serde_json::from_str(&s).ok()),
            created_at_ms,
        }))
    })
    .await
    .context("create_chat_message task failed")??;

    match msg {
        Some(m) => Ok(Json(m)),
        None => Err(AppError::NotFound("chat not found".to_string())),
    }
}

#[derive(Serialize, Clone)]
struct PoolItemResponse {
    id: String,
    project_id: String,
    kind: String,
    title: Option<String>,
    source_url: Option<String>,
    license: Option<String>,
    dedup_key: String,
    data_json: Option<String>,
    selected: bool,
    created_at_ms: i64,
}

async fn list_pool_items(State(state): State<AppState>, Path(project_id): Path<String>) -> AppResult<Json<Vec<PoolItemResponse>>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let db_path = state.db_path.clone();
    let items = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Vec<PoolItemResponse>>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, title, source_url, license, dedup_key, data_json, selected, created_at_ms\n             FROM pool_items WHERE project_id = ?1 ORDER BY created_at_ms DESC LIMIT 500",
        )?;
        let rows = stmt.query_map([&project_id], |row| {
            Ok(PoolItemResponse {
                id: row.get(0)?,
                project_id: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                source_url: row.get(4)?,
                license: row.get(5)?,
                dedup_key: row.get(6)?,
                data_json: row.get(7)?,
                selected: row.get::<_, i64>(8)? != 0,
                created_at_ms: row.get(9)?,
            })
        })?;

        Ok(Some(rows.filter_map(Result::ok).collect()))
    })
    .await
    .context("list_pool_items task failed")??;

    match items {
        Some(v) => Ok(Json(v)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Deserialize)]
struct AddPoolItemRequest {
    kind: String,
    title: Option<String>,
    url: Option<String>,
    source_url: Option<String>,
    license: Option<String>,
    dedup_key: Option<String>,
    data: Option<serde_json::Value>,
    selected: Option<bool>,
}

fn normalize_url_for_dedup(url: &str) -> String {
    let trimmed = url.trim();
    let no_hash = trimmed.split('#').next().unwrap_or(trimmed);
    let no_trailing = no_hash.trim_end_matches('/');
    no_trailing.to_lowercase()
}

async fn add_pool_item(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<AddPoolItemRequest>,
) -> AppResult<Json<PoolItemResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let kind = req.kind.trim().to_string();
    if kind.is_empty() {
        return Err(AppError::BadRequest("missing kind".to_string()));
    }

    let title = req.title.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let source_url = req
        .source_url
        .or(req.url)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let license = req.license.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    let dedup_key = req
        .dedup_key
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| source_url.as_ref().map(|u| format!("url:{}", normalize_url_for_dedup(u))))
        .unwrap_or_else(|| format!("random:{}", Uuid::new_v4()));

    let data_json = if let Some(v) = req.data {
        Some(v.to_string())
    } else if let Some(u) = &source_url {
        Some(serde_json::json!({ "url": u }).to_string())
    } else {
        None
    };

    let selected = req.selected.unwrap_or(true);

    let db_path = state.db_path.clone();
    let item = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<PoolItemResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let id = Uuid::new_v4().to_string();
        let created_at_ms = now_ms();
        conn.execute(
            "INSERT INTO pool_items (id, project_id, kind, title, source_url, license, dedup_key, data_json, selected, created_at_ms)\n             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)\n             ON CONFLICT(project_id, dedup_key) DO UPDATE SET kind = excluded.kind, title = excluded.title, source_url = excluded.source_url, license = excluded.license, data_json = excluded.data_json, selected = excluded.selected",
            params![
                &id,
                &project_id,
                &kind,
                title.as_deref(),
                source_url.as_deref(),
                license.as_deref(),
                &dedup_key,
                data_json.as_deref(),
                if selected { 1 } else { 0 },
                created_at_ms
            ],
        )?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'pool_item_upsert', ?3)",
            params![
                &project_id,
                created_at_ms,
                serde_json::json!({ "kind": &kind, "dedup_key": &dedup_key, "source_url": source_url.as_deref() }).to_string()
            ],
        )?;

        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, title, source_url, license, dedup_key, data_json, selected, created_at_ms\n             FROM pool_items WHERE project_id = ?1 AND dedup_key = ?2 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![&project_id, &dedup_key])?;
        let Some(row) = rows.next()? else {
            return Err(anyhow::anyhow!("failed to read back pool item"));
        };

        Ok(Some(PoolItemResponse {
            id: row.get(0)?,
            project_id: row.get(1)?,
            kind: row.get(2)?,
            title: row.get(3)?,
            source_url: row.get(4)?,
            license: row.get(5)?,
            dedup_key: row.get(6)?,
            data_json: row.get(7)?,
            selected: row.get::<_, i64>(8)? != 0,
            created_at_ms: row.get(9)?,
        }))
    })
    .await
    .context("add_pool_item task failed")??;

    match item {
        Some(v) => Ok(Json(v)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Deserialize)]
struct SetPoolItemSelectedRequest {
    selected: bool,
}

async fn set_pool_item_selected(
    State(state): State<AppState>,
    Path((project_id, item_id)): Path<(String, String)>,
    Json(req): Json<SetPoolItemSelectedRequest>,
) -> AppResult<Json<PoolItemResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }
    if item_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing item_id".to_string()));
    }

    let db_path = state.db_path.clone();
    let item = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<PoolItemResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let selected = req.selected;
        conn.execute(
            "UPDATE pool_items SET selected = ?1 WHERE project_id = ?2 AND id = ?3",
            params![if selected { 1 } else { 0 }, &project_id, &item_id],
        )?;

        let updated_at_ms = now_ms();
        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'pool_item_selected', ?3)",
            params![
                &project_id,
                updated_at_ms,
                serde_json::json!({ "item_id": &item_id, "selected": selected }).to_string()
            ],
        )?;

        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, title, source_url, license, dedup_key, data_json, selected, created_at_ms\n             FROM pool_items WHERE project_id = ?1 AND id = ?2 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![&project_id, &item_id])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(PoolItemResponse {
                id: row.get(0)?,
                project_id: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                source_url: row.get(4)?,
                license: row.get(5)?,
                dedup_key: row.get(6)?,
                data_json: row.get(7)?,
                selected: row.get::<_, i64>(8)? != 0,
                created_at_ms: row.get(9)?,
            }));
        }

        Ok(None)
    })
    .await
    .context("set_pool_item_selected task failed")??;

    match item {
        Some(v) => Ok(Json(v)),
        None => Err(AppError::NotFound("pool item not found".to_string())),
    }
}

#[derive(Serialize, Clone)]
struct ArtifactResponse {
    id: String,
    project_id: String,
    kind: String,
    path: String,
    created_at_ms: i64,
}

async fn list_artifacts(State(state): State<AppState>, Path(project_id): Path<String>) -> AppResult<Json<Vec<ArtifactResponse>>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let db_path = state.db_path.clone();
    let artifacts = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Vec<ArtifactResponse>>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool =
            conn.query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
                .optional()?
                .is_some();
        if !exists {
            return Ok(None);
        }

        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, path, created_at_ms FROM artifacts WHERE project_id = ?1 ORDER BY created_at_ms DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([&project_id], |row| {
            Ok(ArtifactResponse {
                id: row.get(0)?,
                project_id: row.get(1)?,
                kind: row.get(2)?,
                path: row.get(3)?,
                created_at_ms: row.get(4)?,
            })
        })?;

        Ok(Some(rows.filter_map(Result::ok).collect()))
    })
    .await
    .context("list_artifacts task failed")??;

    match artifacts {
        Some(a) => Ok(Json(a)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Deserialize)]
struct CreateTextArtifactRequest {
    kind: String,
    out_path: String,
    content: String,
}

fn sanitize_out_path(out_path: &str) -> Option<String> {
    let normalized = out_path.replace('\\', "/");
    let parts = normalized
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| *s != "." && *s != "..")
        .map(sanitize_file_name)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

async fn create_text_artifact(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<CreateTextArtifactRequest>,
) -> AppResult<Json<ArtifactResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let kind = req.kind.trim().to_string();
    if kind.is_empty() {
        return Err(AppError::BadRequest("missing kind".to_string()));
    }

    let out_path = req.out_path.trim().to_string();
    let Some(safe_out_path) = sanitize_out_path(&out_path) else {
        return Err(AppError::BadRequest("invalid out_path".to_string()));
    };

    let content = req.content;

    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.clone();

    let artifact = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ArtifactResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let rel_path = format!("projects/{}/out/{}", project_id, safe_out_path);
        let abs_path = data_dir.join(&rel_path);
        if let Some(parent) = abs_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&abs_path, content.as_bytes())?;

        let created_at_ms = now_ms();
        let artifact = ensure_artifact(&conn, &project_id, &kind, &rel_path, created_at_ms)?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'text_artifact', ?3)",
            params![
                &project_id,
                created_at_ms,
                serde_json::json!({ "kind": &kind, "path": &rel_path }).to_string()
            ],
        )?;

        Ok(Some(artifact))
    })
    .await
    .context("create_text_artifact task failed")??;

    match artifact {
        Some(a) => Ok(Json(a)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Serialize)]
struct UploadFileArtifactResponse {
    artifact: ArtifactResponse,
    bytes: u64,
    file_name: String,
    mime: Option<String>,
}

async fn upload_file_artifact(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    mut multipart: Multipart,
) -> AppResult<Json<UploadFileArtifactResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    // Ensure project exists before writing files.
    let db_path = state.db_path.clone();
    let project_id_check = project_id.clone();
    let exists = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = Connection::open(&db_path)?;
        Ok(conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id_check], |_row| Ok(()))
            .optional()?
            .is_some())
    })
    .await
    .context("upload_file_artifact db preflight failed")??;
    if !exists {
        return Err(AppError::NotFound("project not found".to_string()));
    }

    while let Some(field) = multipart.next_field().await.map_err(|e| AppError::BadRequest(e.to_string()))? {
        let name = field.name().unwrap_or_default().to_string();
        if name != "file" {
            continue;
        }

        let file_name_raw = field.file_name().unwrap_or("upload").to_string();
        let file_name_safe = sanitize_file_name(&file_name_raw);
        let file_name = if file_name_safe.trim_matches('_').is_empty() {
            "upload".to_string()
        } else {
            file_name_safe
        };

        let mime = field.content_type().map(|m| m.to_string());
        let mime_for_event = mime.clone();
        let created_at_ms = now_ms();

        let rel_path = format!("projects/{}/uploads/{}-{}", project_id, created_at_ms, file_name);
        let abs_path = state.data_dir.join(&rel_path);
        if let Some(parent) = abs_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create upload dir {}", parent.display()))?;
        }

        let mut f = tokio::fs::File::create(&abs_path)
            .await
            .with_context(|| format!("failed to create {}", abs_path.display()))?;

        let mut bytes: u64 = 0;
        let mut field = field;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?
        {
            bytes = bytes.saturating_add(chunk.len() as u64);
            f.write_all(&chunk)
                .await
                .with_context(|| format!("failed to write {}", abs_path.display()))?;
        }
        f.flush().await.ok();

        let db_path = state.db_path.clone();
        let rel_path_db = rel_path.clone();
        let artifact = tokio::task::spawn_blocking(move || -> anyhow::Result<ArtifactResponse> {
            let conn = Connection::open(&db_path)?;

            let artifact = ensure_artifact(&conn, &project_id, "upload", &rel_path_db, created_at_ms)?;
            conn.execute(
                "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'upload', ?3)",
                params![
                    &project_id,
                    created_at_ms,
                    serde_json::json!({ "path": &rel_path_db, "bytes": bytes, "mime": mime_for_event }).to_string()
                ],
            )?;
            Ok(artifact)
        })
        .await
        .context("upload_file_artifact db task failed")??;

        return Ok(Json(UploadFileArtifactResponse {
            artifact,
            bytes,
            file_name,
            mime,
        }));
    }

    Err(AppError::BadRequest("missing multipart field 'file'".to_string()))
}

fn content_type_for_path(path: &FsPath) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "txt" | "log" | "md" => "text/plain; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn download_artifact_raw(
    State(state): State<AppState>,
    Path((project_id, artifact_id)): Path<(String, String)>,
) -> AppResult<Response> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }
    if artifact_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing artifact id".to_string()));
    }

    let db_path = state.db_path.clone();
    let rel_path = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<String>> {
        let conn = Connection::open(&db_path)?;
        let path: Option<String> = conn
            .query_row(
                "SELECT path FROM artifacts WHERE id = ?1 AND project_id = ?2 LIMIT 1",
                params![&artifact_id, &project_id],
                |row| Ok(row.get(0)?),
            )
            .optional()?;
        Ok(path)
    })
    .await
    .context("download_artifact_raw db task failed")??;

    let Some(rel_path) = rel_path else {
        return Err(AppError::NotFound("artifact not found".to_string()));
    };
    if rel_path.starts_with("http://") || rel_path.starts_with("https://") {
        return Err(AppError::BadRequest("artifact is not a file".to_string()));
    }

    let abs = state.data_dir.join(&rel_path);
    if !abs.exists() {
        return Err(AppError::NotFound("file not found".to_string()));
    }

    let file = tokio::fs::File::open(&abs)
        .await
        .with_context(|| format!("failed to open {}", abs.display()))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let mut res = Response::new(body);
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type_for_path(&abs)).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    Ok(res)
}

#[derive(Deserialize)]
struct AddInputUrlRequest {
    url: String,
}

async fn add_input_url(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<AddInputUrlRequest>,
) -> AppResult<Json<ArtifactResponse>> {
    let url = req.url.trim().to_string();
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }
    if url.is_empty() {
        return Err(AppError::BadRequest("missing url".to_string()));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::BadRequest("url must start with http:// or https://".to_string()));
    }

    let db_path = state.db_path.clone();
    let artifact = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ArtifactResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool =
            conn.query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
                .optional()?
                .is_some();
        if !exists {
            return Ok(None);
        }

        let id = Uuid::new_v4().to_string();
        let created_at_ms = now_ms();
        conn.execute(
            "INSERT INTO artifacts (id, project_id, kind, path, created_at_ms) VALUES (?1, ?2, 'input_url', ?3, ?4)",
            params![&id, &project_id, &url, created_at_ms],
        )?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'input_url_added', ?3)",
            params![
                &project_id,
                created_at_ms,
                serde_json::json!({ "url": &url }).to_string()
            ],
        )?;

        Ok(Some(ArtifactResponse {
            id,
            project_id,
            kind: "input_url".to_string(),
            path: url,
            created_at_ms,
        }))
    })
    .await
    .context("add_input_url task failed")??;

    match artifact {
        Some(a) => Ok(Json(a)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Serialize)]
struct ImportLocalResponse {
    artifact: ArtifactResponse,
    bytes: u64,
    file_name: String,
}

fn sanitize_file_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    while out.starts_with('.') {
        out.remove(0);
    }
    if out.is_empty() {
        "video".to_string()
    } else {
        out
    }
}

async fn import_local_video(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    mut multipart: Multipart,
) -> AppResult<Json<ImportLocalResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    // Ensure project exists first.
    let project_id_for_check = project_id.clone();
    let db_path = state.db_path.clone();
    let exists = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = Connection::open(&db_path)?;
        Ok(conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id_for_check], |_row| Ok(()))
            .optional()?
            .is_some())
    })
    .await
    .context("project existence check failed")??;
    if !exists {
        return Err(AppError::NotFound("project not found".to_string()));
    }

    while let Some(mut field) = multipart.next_field().await.context("multipart read failed")? {
        let field_name = field.name().unwrap_or("");
        if !field_name.is_empty() && field_name != "file" {
            continue;
        }

        let original_name = field.file_name().unwrap_or("video");
        let sanitized = sanitize_file_name(original_name);
        let file_name = format!("{}_{}", Uuid::new_v4(), sanitized);
        let rel_path = format!("projects/{}/media/{}", project_id, file_name);
        let abs_path = state.data_dir.join(&rel_path);

        if let Some(parent) = abs_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create dir {}", parent.display()))?;
        }

        let mut out = tokio::fs::File::create(&abs_path)
            .await
            .with_context(|| format!("failed to create file {}", abs_path.display()))?;

        let mut bytes: u64 = 0;
        while let Some(chunk) = field.chunk().await.context("multipart chunk read failed")? {
            out.write_all(&chunk).await.context("write failed")?;
            bytes = bytes.saturating_add(chunk.len() as u64);
        }
        out.flush().await.context("flush failed")?;

        let db_path = state.db_path.clone();
        let artifact = tokio::task::spawn_blocking(move || -> anyhow::Result<ArtifactResponse> {
            let conn = Connection::open(&db_path)?;
            let id = Uuid::new_v4().to_string();
            let created_at_ms = now_ms();

            conn.execute(
                "INSERT INTO artifacts (id, project_id, kind, path, created_at_ms) VALUES (?1, ?2, 'input_video', ?3, ?4)",
                params![&id, &project_id, &rel_path, created_at_ms],
            )?;

            conn.execute(
                "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'input_video_imported', ?3)",
                params![
                    &project_id,
                    created_at_ms,
                    serde_json::json!({ "path": &rel_path, "bytes": bytes }).to_string()
                ],
            )?;

            Ok(ArtifactResponse {
                id,
                project_id,
                kind: "input_video".to_string(),
                path: rel_path,
                created_at_ms,
            })
        })
        .await
        .context("import_local_video db task failed")??;

        return Ok(Json(ImportLocalResponse {
            artifact,
            bytes,
            file_name,
        }));
    }

    Err(AppError::BadRequest("missing multipart field 'file'".to_string()))
}

#[derive(Deserialize)]
struct ImportRemoteMediaRequest {
    url: String,
    download: Option<bool>,
    cookies_from_browser: Option<String>,
}

#[derive(Serialize)]
struct RemoteMediaInfoSummary {
    extractor: String,
    id: String,
    title: String,
    duration_s: Option<f64>,
    webpage_url: String,
    thumbnail: Option<String>,
    description: Option<String>,
}

#[derive(Serialize)]
struct ImportRemoteMediaResponse {
    info: RemoteMediaInfoSummary,
    info_artifact: ArtifactResponse,
    input_video: Option<ArtifactResponse>,
}

enum ImportRemoteMediaOutcome {
    Ok(ImportRemoteMediaResponse),
    NotFound,
    PreconditionFailed(String),
}

fn env_trim(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn json_string(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn json_f64(v: &serde_json::Value, key: &str) -> Option<f64> {
    let x = v.get(key)?;
    if let Some(n) = x.as_f64() {
        return Some(n);
    }
    x.as_str().and_then(|s| s.parse::<f64>().ok())
}

fn clean_one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars).collect();
    out.push('…');
    out
}

fn pick_downloaded_file(out_dir: &FsPath, file_base: &str) -> anyhow::Result<Option<PathBuf>> {
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let rd = match std::fs::read_dir(out_dir) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };
        if !name.starts_with(file_base) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((modified, path));
    }
    candidates.sort_by_key(|(ts, _)| *ts);
    Ok(candidates.pop().map(|(_, p)| p))
}

async fn import_remote_media(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<ImportRemoteMediaRequest>,
) -> AppResult<Json<ImportRemoteMediaResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let url = req.url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::BadRequest("missing url".to_string()));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::BadRequest("url must start with http:// or https://".to_string()));
    }

    if !state.ytdlp {
        return Err(AppError::PreconditionFailed(
            "yt-dlp not found; install yt-dlp (and restart toolserver) to enable URL resolve/download".to_string(),
        ));
    }

    let download = req.download.unwrap_or(false);
    if download && !state.ffmpeg {
        return Err(AppError::PreconditionFailed(
            "ffmpeg not found on PATH; install ffmpeg to enable URL downloads (mp4 merge)".to_string(),
        ));
    }

    let cookies_from_browser = req
        .cookies_from_browser
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| env_trim("YTDLP_COOKIES_FROM_BROWSER"));

    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.clone();
    let ytdlp_cmd = state.ytdlp_cmd.clone();

    let outcome = tokio::task::spawn_blocking(move || -> anyhow::Result<ImportRemoteMediaOutcome> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(ImportRemoteMediaOutcome::NotFound);
        }

        let consented: bool = conn
            .query_row("SELECT consented FROM consents WHERE project_id = ?1", [&project_id], |r| {
                Ok(r.get::<_, i64>(0)? != 0)
            })
            .optional()?
            .unwrap_or(false);
        if !consented {
            return Ok(ImportRemoteMediaOutcome::PreconditionFailed(
                "consent required: save URL and confirm consent first".to_string(),
            ));
        }

        // Resolve URL to yt-dlp info JSON (works for bilibili + other supported sites).
        let mut cmd = Command::new(&ytdlp_cmd);
        cmd.args(["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings"]);
        if let Some(c) = cookies_from_browser.as_ref() {
            cmd.args(["--cookies-from-browser", c]);
        }
        cmd.arg(&url);

        let output = run_cmd_output(&mut cmd)?;
        let stdout = String::from_utf8(output.stdout)?;
        let info_json: serde_json::Value = serde_json::from_str(stdout.trim())?;

        let created_at_ms = now_ms();
        let safe_out_path = sanitize_out_path(&format!("ytdlp/info-{created_at_ms}.json"))
            .ok_or_else(|| anyhow::anyhow!("failed to build safe out_path"))?;
        let rel_info_path = format!("projects/{}/out/{}", project_id, safe_out_path);
        let abs_info_path = data_dir.join(&rel_info_path);
        if let Some(parent) = abs_info_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&abs_info_path, serde_json::to_vec_pretty(&info_json)?)?;
        let info_artifact = ensure_artifact(&conn, &project_id, "ytdlp_info", &rel_info_path, created_at_ms)?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'remote_resolve', ?3)",
            params![&project_id, created_at_ms, serde_json::json!({ "url": &url }).to_string()],
        )?;

        let extractor = json_string(&info_json, "extractor")
            .or_else(|| json_string(&info_json, "extractor_key"))
            .unwrap_or_else(|| "unknown".to_string());
        let id = json_string(&info_json, "id").unwrap_or_else(|| "unknown".to_string());
        let title = json_string(&info_json, "title").unwrap_or_else(|| "untitled".to_string());
        let webpage_url = json_string(&info_json, "webpage_url").unwrap_or_else(|| url.clone());
        let duration_s = json_f64(&info_json, "duration");
        let thumbnail = json_string(&info_json, "thumbnail")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let description = json_string(&info_json, "description")
            .map(|s| truncate_chars(&clean_one_line(&s), 280))
            .filter(|s| !s.is_empty());

        let mut input_video: Option<ArtifactResponse> = None;

        if download {
            let out_dir_rel = format!("projects/{}/media/remote", project_id);
            let out_dir_abs = data_dir.join(&out_dir_rel);
            std::fs::create_dir_all(&out_dir_abs)?;

            let file_base = {
                let ex = sanitize_file_name(&extractor);
                let vid = sanitize_file_name(&id);
                let base = format!("{ex}-{vid}");
                if base.trim_matches('_').is_empty() {
                    format!("remote-{created_at_ms}")
                } else {
                    base
                }
            };

            let out_template = out_dir_abs.join(format!("{file_base}.%(ext)s"));
            let out_template_str = out_template.display().to_string();

            let mut dl = Command::new(&ytdlp_cmd);
            dl.args([
                "--no-playlist",
                "--restrict-filenames",
                "--no-warnings",
                "--no-progress",
                "--merge-output-format",
                "mp4",
                "-o",
                &out_template_str,
            ]);
            if let Some(c) = cookies_from_browser.as_ref() {
                dl.args(["--cookies-from-browser", c]);
            }
            dl.arg(&url);
            run_cmd(&mut dl)?;

            let expected = out_dir_abs.join(format!("{file_base}.mp4"));
            let downloaded_abs = if expected.exists() {
                expected
            } else {
                pick_downloaded_file(&out_dir_abs, &file_base)?
                    .ok_or_else(|| anyhow::anyhow!("download finished but output file not found"))?
            };

            let rel_video_path = downloaded_abs
                .strip_prefix(&data_dir)
                .unwrap_or(&downloaded_abs)
                .display()
                .to_string();
            let video_artifact = ensure_artifact(&conn, &project_id, "input_video", &rel_video_path, created_at_ms)?;
            input_video = Some(video_artifact);

            conn.execute(
                "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'remote_download', ?3)",
                params![
                    &project_id,
                    created_at_ms,
                    serde_json::json!({ "url": &url, "path": &rel_video_path }).to_string()
                ],
            )?;
        }

        Ok(ImportRemoteMediaOutcome::Ok(ImportRemoteMediaResponse {
            info: RemoteMediaInfoSummary {
                extractor,
                id,
                title,
                duration_s,
                webpage_url,
                thumbnail,
                description,
            },
            info_artifact,
            input_video,
        }))
    })
    .await
    .context("import_remote_media task failed")??;

    match outcome {
        ImportRemoteMediaOutcome::Ok(r) => Ok(Json(r)),
        ImportRemoteMediaOutcome::NotFound => Err(AppError::NotFound("project not found".to_string())),
        ImportRemoteMediaOutcome::PreconditionFailed(msg) => Err(AppError::PreconditionFailed(msg)),
    }
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "toolserver",
        data_dir: state.data_dir.display().to_string(),
        ffmpeg: state.ffmpeg,
        ffprobe: state.ffprobe,
        ytdlp: state.ytdlp,
        db_path: state.db_path.display().to_string(),
    })
}

#[derive(Serialize)]
struct ProfileResponse {
    profile: ProfileMemory,
    profile_rel_path: String,
    profile_abs_path: String,
}

async fn get_profile(State(state): State<AppState>) -> AppResult<Json<ProfileResponse>> {
    let db_path = state.db_path.clone();
    let data_dir = state.data_dir.clone();

    let resp = tokio::task::spawn_blocking(move || -> anyhow::Result<ProfileResponse> {
        let conn = Connection::open(&db_path)?;
        let mut profile = load_profile(&conn)?;
        if profile.prompt.trim().is_empty() {
            profile.prompt = build_profile_prompt(&profile);
        }
        Ok(ProfileResponse {
            profile,
            profile_rel_path: profile_file_name().to_string(),
            profile_abs_path: data_dir.join(profile_file_name()).display().to_string(),
        })
    })
    .await
    .context("get_profile task failed")??;

    Ok(Json(resp))
}

async fn reset_profile(State(state): State<AppState>) -> AppResult<Json<ProfileResponse>> {
    let db_path = state.db_path.clone();
    let data_dir = state.data_dir.clone();

    let resp = tokio::task::spawn_blocking(move || -> anyhow::Result<ProfileResponse> {
        let conn = Connection::open(&db_path)?;
        conn.execute("DELETE FROM profile WHERE id = 1", [])?;

        let file_abs = data_dir.join(profile_file_name());
        if file_abs.exists() {
            let _ = std::fs::remove_file(&file_abs);
        }

        Ok(ProfileResponse {
            profile: ProfileMemory::default(),
            profile_rel_path: profile_file_name().to_string(),
            profile_abs_path: file_abs.display().to_string(),
        })
    })
    .await
    .context("reset_profile task failed")??;

    Ok(Json(resp))
}

#[derive(Deserialize)]
struct FfmpegPipelineRequest {
    input_video_artifact_id: String,
}

#[derive(Serialize)]
struct FfmpegPipelineResponse {
    input_video_artifact_id: String,
    fingerprint: String,
    metadata: ArtifactResponse,
    clips: Vec<ArtifactResponse>,
    audio: ArtifactResponse,
    thumbnails: Vec<ArtifactResponse>,
}

fn file_fingerprint(path: &FsPath) -> anyhow::Result<String> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(format!("{size}_{mtime_ms}"))
}

fn ensure_artifact(conn: &Connection, project_id: &str, kind: &str, path: &str, created_at_ms: i64) -> anyhow::Result<ArtifactResponse> {
    if let Some(existing) = conn
        .query_row(
            "SELECT id, created_at_ms FROM artifacts WHERE project_id = ?1 AND kind = ?2 AND path = ?3 LIMIT 1",
            params![project_id, kind, path],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?
    {
        return Ok(ArtifactResponse {
            id: existing.0,
            project_id: project_id.to_string(),
            kind: kind.to_string(),
            path: path.to_string(),
            created_at_ms: existing.1,
        });
    }

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO artifacts (id, project_id, kind, path, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![&id, project_id, kind, path, created_at_ms],
    )?;
    Ok(ArtifactResponse {
        id,
        project_id: project_id.to_string(),
        kind: kind.to_string(),
        path: path.to_string(),
        created_at_ms,
    })
}

fn run_cmd(cmd: &mut Command) -> anyhow::Result<()> {
    let output = cmd.output()?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!("command failed: {stderr}");
}

fn run_cmd_output(cmd: &mut Command) -> anyhow::Result<std::process::Output> {
    let output = cmd.output()?;
    if output.status.success() {
        return Ok(output);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!("command failed: {stderr}");
}

async fn ffmpeg_pipeline(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<FfmpegPipelineRequest>,
) -> AppResult<Json<FfmpegPipelineResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }
    let input_artifact_id = req.input_video_artifact_id.trim().to_string();
    if input_artifact_id.is_empty() {
        return Err(AppError::BadRequest("missing input_video_artifact_id".to_string()));
    }
    if !state.ffmpeg || !state.ffprobe {
        return Err(AppError::PreconditionFailed(
            "ffmpeg/ffprobe not found on PATH; please install ffmpeg and restart".to_string(),
        ));
    }

    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<FfmpegPipelineResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let mut stmt = conn.prepare(
            "SELECT kind, path FROM artifacts WHERE id = ?1 AND project_id = ?2 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![&input_artifact_id, &project_id])?;
        let Some(row) = rows.next()? else {
            return Err(anyhow::anyhow!("input artifact not found"));
        };
        let kind: String = row.get(0)?;
        let rel_path: String = row.get(1)?;
        if kind != "input_video" {
            return Err(anyhow::anyhow!("artifact kind must be input_video"));
        }

        let input_abs = data_dir.join(&rel_path);
        if !input_abs.exists() {
            return Err(anyhow::anyhow!("input file missing on disk: {}", input_abs.display()));
        }

        let fingerprint = file_fingerprint(&input_abs)?;
        let out_dir_rel = format!("projects/{}/out/ffmpeg/{}", project_id, fingerprint);
        let out_dir_abs = data_dir.join(&out_dir_rel);
        std::fs::create_dir_all(&out_dir_abs)?;

        let metadata_rel = format!("{out_dir_rel}/metadata.json");
        let metadata_abs = data_dir.join(&metadata_rel);
        if !metadata_abs.exists() {
            let output = Command::new("ffprobe")
                .args(["-v", "error", "-show_format", "-show_streams", "-print_format", "json"])
                .arg(&input_abs)
                .output()?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("ffprobe failed: {stderr}");
            }
            std::fs::write(&metadata_abs, &output.stdout)?;
        }

        let metadata_json: serde_json::Value = serde_json::from_slice(&std::fs::read(&metadata_abs)?)?;
        let duration_s: f64 = metadata_json
            .get("format")
            .and_then(|f| f.get("duration"))
            .and_then(|d| d.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);

        let clip_len_s: f64 = 6.0;
        let start_s = 0.0;
        let mid_s = (duration_s / 2.0 - clip_len_s / 2.0).max(0.0);
        let end_s = if duration_s > clip_len_s {
            (duration_s - clip_len_s).max(0.0)
        } else {
            0.0
        };

        let clip_start_rel = format!("{out_dir_rel}/clip_start.mp4");
        let clip_mid_rel = format!("{out_dir_rel}/clip_mid.mp4");
        let clip_end_rel = format!("{out_dir_rel}/clip_end.mp4");
        let audio_rel = format!("{out_dir_rel}/audio.wav");
        let thumb_start_rel = format!("{out_dir_rel}/thumb_start.jpg");
        let thumb_mid_rel = format!("{out_dir_rel}/thumb_mid.jpg");
        let thumb_end_rel = format!("{out_dir_rel}/thumb_end.jpg");

        let clip_specs = [
            (start_s, &clip_start_rel),
            (mid_s, &clip_mid_rel),
            (end_s, &clip_end_rel),
        ];
        for (ss, rel) in clip_specs {
            let abs = data_dir.join(rel);
            if abs.exists() {
                continue;
            }
            let mut cmd = Command::new("ffmpeg");
            cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
                .arg("-ss")
                .arg(format!("{ss:.3}"))
                .arg("-t")
                .arg(format!("{clip_len_s:.3}"))
                .arg("-i")
                .arg(&input_abs)
                .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"])
                .args(["-c:a", "aac", "-b:a", "128k"])
                .arg(&abs);
            run_cmd(&mut cmd)?;
        }

        let audio_abs = data_dir.join(&audio_rel);
        if !audio_abs.exists() {
            let mut cmd = Command::new("ffmpeg");
            cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
                .arg("-i")
                .arg(&input_abs)
                .args(["-vn", "-ac", "1", "-ar", "16000"])
                .arg(&audio_abs);
            run_cmd(&mut cmd)?;
        }

        let thumb_specs = [(start_s, &thumb_start_rel), (mid_s, &thumb_mid_rel), (end_s, &thumb_end_rel)];
        for (ss, rel) in thumb_specs {
            let abs = data_dir.join(rel);
            if abs.exists() {
                continue;
            }
            let mut cmd = Command::new("ffmpeg");
            cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
                .arg("-ss")
                .arg(format!("{ss:.3}"))
                .arg("-i")
                .arg(&input_abs)
                .args(["-frames:v", "1", "-q:v", "2"])
                .arg(&abs);
            run_cmd(&mut cmd)?;
        }

        let created_at_ms = now_ms();
        let metadata_art = ensure_artifact(&conn, &project_id, "metadata_json", &metadata_rel, created_at_ms)?;
        let clip_start_art = ensure_artifact(&conn, &project_id, "clip_start", &clip_start_rel, created_at_ms)?;
        let clip_mid_art = ensure_artifact(&conn, &project_id, "clip_mid", &clip_mid_rel, created_at_ms)?;
        let clip_end_art = ensure_artifact(&conn, &project_id, "clip_end", &clip_end_rel, created_at_ms)?;
        let audio_art = ensure_artifact(&conn, &project_id, "audio_wav", &audio_rel, created_at_ms)?;
        let thumb_start_art = ensure_artifact(&conn, &project_id, "thumb_start", &thumb_start_rel, created_at_ms)?;
        let thumb_mid_art = ensure_artifact(&conn, &project_id, "thumb_mid", &thumb_mid_rel, created_at_ms)?;
        let thumb_end_art = ensure_artifact(&conn, &project_id, "thumb_end", &thumb_end_rel, created_at_ms)?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'ffmpeg_pipeline', ?3)",
            params![
                &project_id,
                created_at_ms,
                serde_json::json!({ "input_artifact_id": &input_artifact_id, "fingerprint": &fingerprint, "duration_s": duration_s }).to_string()
            ],
        )?;

        Ok(Some(FfmpegPipelineResponse {
            input_video_artifact_id: input_artifact_id,
            fingerprint,
            metadata: metadata_art,
            clips: vec![clip_start_art, clip_mid_art, clip_end_art],
            audio: audio_art,
            thumbnails: vec![thumb_start_art, thumb_mid_art, thumb_end_art],
        }))
    })
    .await
    .context("ffmpeg_pipeline task failed")??;

    match result {
        Some(r) => Ok(Json(r)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Serialize)]
struct GenerateReportResponse {
    report_html: ArtifactResponse,
    manifest_json: ArtifactResponse,
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

async fn generate_report(State(state): State<AppState>, Path(project_id): Path<String>) -> AppResult<Json<GenerateReportResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.clone();

    let res = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<GenerateReportResponse>> {
        let conn = Connection::open(&db_path)?;

        let mut stmt = conn.prepare("SELECT id, title, created_at_ms FROM projects WHERE id = ?1")?;
        let mut rows = stmt.query([&project_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let project_title: String = row.get(1)?;
        let project_created_at_ms: i64 = row.get(2)?;

        let consent = conn
            .query_row(
                "SELECT consented, auto_confirm, updated_at_ms FROM consents WHERE project_id = ?1",
                [&project_id],
                |r| Ok((r.get::<_, i64>(0)? != 0, r.get::<_, i64>(1)? != 0, r.get::<_, i64>(2)?)),
            )
            .optional()?
            .map(|(consented, auto_confirm, updated_at_ms)| {
                serde_json::json!({ "consented": consented, "auto_confirm": auto_confirm, "updated_at_ms": updated_at_ms })
            })
            .unwrap_or_else(|| serde_json::json!({ "consented": false, "auto_confirm": false, "updated_at_ms": 0 }));

        let settings = conn
            .query_row(
                "SELECT think_enabled, updated_at_ms FROM project_settings WHERE project_id = ?1",
                [&project_id],
                |r| Ok((r.get::<_, i64>(0)? != 0, r.get::<_, i64>(1)?)),
            )
            .optional()?
            .map(|(think_enabled, updated_at_ms)| serde_json::json!({ "think_enabled": think_enabled, "updated_at_ms": updated_at_ms }))
            .unwrap_or_else(|| serde_json::json!({ "think_enabled": true, "updated_at_ms": 0 }));

        let artifacts: Vec<ArtifactResponse> = {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, kind, path, created_at_ms FROM artifacts WHERE project_id = ?1 ORDER BY created_at_ms ASC",
            )?;
            let rows = stmt.query_map([&project_id], |r| {
                Ok(ArtifactResponse {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    kind: r.get(2)?,
                    path: r.get(3)?,
                    created_at_ms: r.get(4)?,
                })
            })?;
            rows.filter_map(Result::ok).collect()
        };

        let pool_items: Vec<PoolItemResponse> = {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, kind, title, source_url, license, dedup_key, data_json, selected, created_at_ms\n                 FROM pool_items WHERE project_id = ?1 ORDER BY created_at_ms ASC",
            )?;
            let rows = stmt.query_map([&project_id], |row| {
                Ok(PoolItemResponse {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    kind: row.get(2)?,
                    title: row.get(3)?,
                    source_url: row.get(4)?,
                    license: row.get(5)?,
                    dedup_key: row.get(6)?,
                    data_json: row.get(7)?,
                    selected: row.get::<_, i64>(8)? != 0,
                    created_at_ms: row.get(9)?,
                })
            })?;
            rows.filter_map(Result::ok).collect()
        };

        let generated_at_ms = now_ms();
        let manifest = serde_json::json!({
            "version": 1,
            "generated_at_ms": generated_at_ms,
            "project": { "id": &project_id, "title": &project_title, "created_at_ms": project_created_at_ms },
            "consent": consent,
            "settings": settings,
            "artifacts": artifacts.clone(),
            "pool_items": pool_items.clone(),
        });

        let export_dir_rel = format!("projects/{}/out/export", project_id);
        let export_dir_abs = data_dir.join(&export_dir_rel);
        std::fs::create_dir_all(&export_dir_abs)?;

        let manifest_rel = format!("{export_dir_rel}/manifest.json");
        let report_rel = format!("{export_dir_rel}/report.html");
        std::fs::write(data_dir.join(&manifest_rel), serde_json::to_vec_pretty(&manifest)?)?;

        let citations_html = {
            let mut out = String::new();
            let exa_searches = artifacts.iter().filter(|a| a.kind == "exa_search").collect::<Vec<_>>();
            if exa_searches.is_empty() {
                out.push_str("<p class=\"muted\">No Exa search artifacts.</p>");
            } else {
                for a in exa_searches {
                    let abs = data_dir.join(&a.path);
                    if let Ok(bytes) = std::fs::read(&abs) {
                        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                            let query = v.get("query").and_then(|x| x.as_str()).unwrap_or("");
                            out.push_str(&format!("<h4>Search: {}</h4>", html_escape(query)));
                            out.push_str("<ul>");
                            if let Some(results) = v.get("results").and_then(|x| x.as_array()) {
                                for r in results {
                                    let title = r.get("title").and_then(|x| x.as_str()).unwrap_or("");
                                    let url = r.get("url").and_then(|x| x.as_str()).unwrap_or("");
                                    out.push_str(&format!(
                                        "<li><a href=\"{}\">{}</a></li>",
                                        html_escape(url),
                                        html_escape(if title.is_empty() { url } else { title })
                                    ));
                                }
                            }
                            out.push_str("</ul>");
                        }
                    }
                }
            }
            out
        };

        let pool_html = {
            let mut out = String::new();
            if pool_items.is_empty() {
                out.push_str("<p class=\"muted\">Pool is empty.</p>");
            } else {
                out.push_str("<table><thead><tr><th>Selected</th><th>Kind</th><th>Title</th><th>Source</th><th>License</th></tr></thead><tbody>");
                for it in &pool_items {
                    out.push_str(&format!(
                        "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                        if it.selected { "yes" } else { "no" },
                        html_escape(&it.kind),
                        html_escape(it.title.as_deref().unwrap_or("")),
                        html_escape(it.source_url.as_deref().unwrap_or("")),
                        html_escape(it.license.as_deref().unwrap_or("")),
                    ));
                }
                out.push_str("</tbody></table>");
            }
            out
        };

        let report_html = format!(
            r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VidUnpack Report</title>
  <style>
    :root {{ color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }}
    body {{ margin: 0; padding: 24px; background: #0b0f14; color: #e7eef8; }}
    a {{ color: #93c5fd; }}
    .muted {{ color: #9bb0c9; }}
    .card {{ margin: 16px 0; padding: 16px; border-radius: 12px; border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.04); }}
    table {{ width: 100%; border-collapse: collapse; }}
    th, td {{ border-bottom: 1px solid rgba(255,255,255,.08); padding: 8px; text-align: left; vertical-align: top; }}
    code, pre {{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; }}
  </style>
</head>
<body>
  <h1>VidUnpack Report</h1>
  <p class="muted">Generated at {generated_at_ms}</p>

  <div class="card">
    <h2>Project</h2>
    <p><strong>Title:</strong> {title}</p>
    <p><strong>ID:</strong> {pid}</p>
    <p><strong>Created:</strong> {created}</p>
  </div>

  <div class="card">
    <h2>Asset Pool</h2>
    {pool_html}
  </div>

  <div class="card">
    <h2>Citations</h2>
    {citations_html}
  </div>

  <div class="card">
    <h2>Manifest</h2>
    <p class="muted">This report ships with a manifest.json for reproducibility.</p>
  </div>
</body>
</html>"#,
            generated_at_ms = generated_at_ms,
            title = html_escape(&project_title),
            pid = html_escape(&project_id),
            created = project_created_at_ms,
            pool_html = pool_html,
            citations_html = citations_html,
        );

        std::fs::write(data_dir.join(&report_rel), report_html.as_bytes())?;

        let report_art = ensure_artifact(&conn, &project_id, "report_html", &report_rel, generated_at_ms)?;
        let manifest_art = ensure_artifact(&conn, &project_id, "manifest_json", &manifest_rel, generated_at_ms)?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'report_generated', ?3)",
            params![
                &project_id,
                generated_at_ms,
                serde_json::json!({ "report": &report_rel, "manifest": &manifest_rel, "version": 1 }).to_string()
            ],
        )?;

        Ok(Some(GenerateReportResponse {
            report_html: report_art,
            manifest_json: manifest_art,
        }))
    })
    .await
    .context("generate_report task failed")??;

    match res {
        Some(r) => Ok(Json(r)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

async fn import_manifest(State(state): State<AppState>, Json(manifest): Json<serde_json::Value>) -> AppResult<Json<ProjectResponse>> {
    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.clone();

    let project = tokio::task::spawn_blocking(move || -> anyhow::Result<ProjectResponse> {
        let conn = Connection::open(&db_path)?;

        let title = manifest
            .get("project")
            .and_then(|p| p.get("title"))
            .and_then(|t| t.as_str())
            .unwrap_or("imported");
        let title = format!("imported: {}", title);

        let project_id = Uuid::new_v4().to_string();
        let created_at_ms = now_ms();

        conn.execute(
            "INSERT INTO projects (id, title, created_at_ms) VALUES (?1, ?2, ?3)",
            params![&project_id, &title, created_at_ms],
        )?;

        let project_dir = data_dir.join("projects").join(&project_id);
        std::fs::create_dir_all(project_dir.join("media"))?;
        std::fs::create_dir_all(project_dir.join("assets"))?;
        std::fs::create_dir_all(project_dir.join("out"))?;
        std::fs::create_dir_all(project_dir.join("tmp"))?;

        // Restore pool items (best-effort).
        if let Some(items) = manifest.get("pool_items").and_then(|x| x.as_array()) {
            for it in items {
                let kind = it.get("kind").and_then(|x| x.as_str()).unwrap_or("link");
                let title = it.get("title").and_then(|x| x.as_str());
                let source_url = it.get("source_url").and_then(|x| x.as_str());
                let license = it.get("license").and_then(|x| x.as_str());
                let dedup_key = it
                    .get("dedup_key")
                    .and_then(|x| x.as_str())
                    .unwrap_or_else(|| source_url.unwrap_or("random"));
                let data_json = it.get("data_json").and_then(|x| x.as_str());
                let selected = it.get("selected").and_then(|x| x.as_bool()).unwrap_or(true);

                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO pool_items (id, project_id, kind, title, source_url, license, dedup_key, data_json, selected, created_at_ms)\n                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)\n                     ON CONFLICT(project_id, dedup_key) DO UPDATE SET kind = excluded.kind, title = excluded.title, source_url = excluded.source_url, license = excluded.license, data_json = excluded.data_json, selected = excluded.selected",
                    params![
                        &id,
                        &project_id,
                        kind,
                        title,
                        source_url,
                        license,
                        dedup_key,
                        data_json,
                        if selected { 1 } else { 0 },
                        created_at_ms
                    ],
                )?;
            }
        }

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'project_imported_manifest', ?3)",
            params![
                &project_id,
                created_at_ms,
                serde_json::json!({ "version": manifest.get("version") }).to_string()
            ],
        )?;

        Ok(ProjectResponse {
            id: project_id,
            title,
            created_at_ms,
        })
    })
    .await
    .context("import_manifest task failed")??;

    Ok(Json(project))
}

#[derive(Deserialize)]
struct ExportZipRequest {
    include_original_video: Option<bool>,
    include_report: Option<bool>,
    include_manifest: Option<bool>,
    include_clips: Option<bool>,
    include_audio: Option<bool>,
    include_thumbnails: Option<bool>,
}

#[derive(Serialize)]
struct ExportZipFileEstimate {
    name: String,
    bytes: u64,
}

#[derive(Serialize)]
struct ExportZipEstimateResponse {
    total_bytes: u64,
    files: Vec<ExportZipFileEstimate>,
}

async fn estimate_export_zip(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<ExportZipRequest>,
) -> AppResult<Json<ExportZipEstimateResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let include_original_video = req.include_original_video.unwrap_or(true);
    let include_report = req.include_report.unwrap_or(true);
    let include_manifest = req.include_manifest.unwrap_or(true);
    let include_clips = req.include_clips.unwrap_or(false);
    let include_audio = req.include_audio.unwrap_or(false);
    let include_thumbnails = req.include_thumbnails.unwrap_or(false);

    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.clone();

    let estimate = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ExportZipEstimateResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let mut files: Vec<ExportZipFileEstimate> = Vec::new();

        if include_report {
            if let Some((path, _)) = conn
                .query_row(
                    "SELECT path, created_at_ms FROM artifacts WHERE project_id = ?1 AND kind = 'report_html' ORDER BY created_at_ms DESC LIMIT 1",
                    [&project_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional()?
            {
                let abs = data_dir.join(&path);
                if abs.exists() {
                    files.push(ExportZipFileEstimate {
                        name: "report.html".to_string(),
                        bytes: std::fs::metadata(abs)?.len(),
                    });
                }
            }
        }

        if include_manifest {
            if let Some((path, _)) = conn
                .query_row(
                    "SELECT path, created_at_ms FROM artifacts WHERE project_id = ?1 AND kind = 'manifest_json' ORDER BY created_at_ms DESC LIMIT 1",
                    [&project_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional()?
            {
                let abs = data_dir.join(&path);
                if abs.exists() {
                    files.push(ExportZipFileEstimate {
                        name: "manifest.json".to_string(),
                        bytes: std::fs::metadata(abs)?.len(),
                    });
                }
            }
        }

        // Always include a selected_pool.json snapshot (selected items only).
        let selected_items: Vec<PoolItemResponse> = {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, kind, title, source_url, license, dedup_key, data_json, selected, created_at_ms\n                 FROM pool_items WHERE project_id = ?1 AND selected = 1 ORDER BY created_at_ms ASC",
            )?;
            let rows = stmt.query_map([&project_id], |row| {
                Ok(PoolItemResponse {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    kind: row.get(2)?,
                    title: row.get(3)?,
                    source_url: row.get(4)?,
                    license: row.get(5)?,
                    dedup_key: row.get(6)?,
                    data_json: row.get(7)?,
                    selected: row.get::<_, i64>(8)? != 0,
                    created_at_ms: row.get(9)?,
                })
            })?;
            rows.filter_map(Result::ok).collect()
        };
        let selected_pool_bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "project_id": &project_id,
            "generated_at_ms": now_ms(),
            "selected_pool_items": selected_items,
        }))?;
        files.push(ExportZipFileEstimate {
            name: "selected_pool.json".to_string(),
            bytes: selected_pool_bytes.len() as u64,
        });

        if include_original_video {
            if let Some((path, _)) = conn
                .query_row(
                    "SELECT path, created_at_ms FROM artifacts WHERE project_id = ?1 AND kind = 'input_video' ORDER BY created_at_ms DESC LIMIT 1",
                    [&project_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional()?
            {
                let abs = data_dir.join(&path);
                if abs.exists() {
                    let file_name = FsPath::new(&path)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("input_video");
                    files.push(ExportZipFileEstimate {
                        name: format!("input_video/{}", file_name),
                        bytes: std::fs::metadata(abs)?.len(),
                    });
                }
            }
        }

        if include_clips {
            for kind in ["clip_start", "clip_mid", "clip_end"] {
                if let Some((path, _)) = conn
                    .query_row(
                        "SELECT path, created_at_ms FROM artifacts WHERE project_id = ?1 AND kind = ?2 ORDER BY created_at_ms DESC LIMIT 1",
                        params![&project_id, kind],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                    )
                    .optional()?
                {
                    let abs = data_dir.join(&path);
                    if abs.exists() {
                        let file_name = FsPath::new(&path)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or(kind);
                        files.push(ExportZipFileEstimate {
                            name: format!("clips/{}", file_name),
                            bytes: std::fs::metadata(abs)?.len(),
                        });
                    }
                }
            }
        }

        if include_audio {
            if let Some((path, _)) = conn
                .query_row(
                    "SELECT path, created_at_ms FROM artifacts WHERE project_id = ?1 AND kind = 'audio_wav' ORDER BY created_at_ms DESC LIMIT 1",
                    [&project_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional()?
            {
                let abs = data_dir.join(&path);
                if abs.exists() {
                    let file_name = FsPath::new(&path)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("audio.wav");
                    files.push(ExportZipFileEstimate {
                        name: format!("audio/{}", file_name),
                        bytes: std::fs::metadata(abs)?.len(),
                    });
                }
            }
        }

        if include_thumbnails {
            for kind in ["thumb_start", "thumb_mid", "thumb_end"] {
                if let Some((path, _)) = conn
                    .query_row(
                        "SELECT path, created_at_ms FROM artifacts WHERE project_id = ?1 AND kind = ?2 ORDER BY created_at_ms DESC LIMIT 1",
                        params![&project_id, kind],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                    )
                    .optional()?
                {
                    let abs = data_dir.join(&path);
                    if abs.exists() {
                        let file_name = FsPath::new(&path)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or(kind);
                        files.push(ExportZipFileEstimate {
                            name: format!("thumbnails/{}", file_name),
                            bytes: std::fs::metadata(abs)?.len(),
                        });
                    }
                }
            }
        }

        let total_bytes = files.iter().map(|f| f.bytes).sum();
        Ok(Some(ExportZipEstimateResponse { total_bytes, files }))
    })
    .await
    .context("estimate_export_zip task failed")??;

    match estimate {
        Some(e) => Ok(Json(e)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

#[derive(Serialize)]
struct ExportZipResponse {
    zip: ArtifactResponse,
    total_bytes: u64,
    download_url: String,
}

async fn export_zip(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<ExportZipRequest>,
) -> AppResult<Json<ExportZipResponse>> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let include_original_video = req.include_original_video.unwrap_or(true);
    let include_report = req.include_report.unwrap_or(true);
    let include_manifest = req.include_manifest.unwrap_or(true);
    let include_clips = req.include_clips.unwrap_or(false);
    let include_audio = req.include_audio.unwrap_or(false);
    let include_thumbnails = req.include_thumbnails.unwrap_or(false);

    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.clone();

    let res = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ExportZipResponse>> {
        let conn = Connection::open(&db_path)?;

        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project_id], |_row| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let export_dir_rel = format!("projects/{}/out/export", project_id);
        let export_dir_abs = data_dir.join(&export_dir_rel);
        std::fs::create_dir_all(&export_dir_abs)?;

        let report_path = if include_report {
            conn.query_row(
                "SELECT path FROM artifacts WHERE project_id = ?1 AND kind = 'report_html' ORDER BY created_at_ms DESC LIMIT 1",
                [&project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        } else {
            None
        };

        let manifest_path = if include_manifest {
            conn.query_row(
                "SELECT path FROM artifacts WHERE project_id = ?1 AND kind = 'manifest_json' ORDER BY created_at_ms DESC LIMIT 1",
                [&project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        } else {
            None
        };

        let input_video_path = if include_original_video {
            conn.query_row(
                "SELECT path FROM artifacts WHERE project_id = ?1 AND kind = 'input_video' ORDER BY created_at_ms DESC LIMIT 1",
                [&project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        } else {
            None
        };

        let clip_paths: Vec<String> = if include_clips {
            let mut out: Vec<String> = Vec::new();
            for kind in ["clip_start", "clip_mid", "clip_end"] {
                if let Some(p) = conn
                    .query_row(
                        "SELECT path FROM artifacts WHERE project_id = ?1 AND kind = ?2 ORDER BY created_at_ms DESC LIMIT 1",
                        params![&project_id, kind],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?
                {
                    out.push(p);
                }
            }
            out
        } else {
            Vec::new()
        };

        let audio_path: Option<String> = if include_audio {
            conn.query_row(
                "SELECT path FROM artifacts WHERE project_id = ?1 AND kind = 'audio_wav' ORDER BY created_at_ms DESC LIMIT 1",
                [&project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        } else {
            None
        };

        let thumbnail_paths: Vec<String> = if include_thumbnails {
            let mut out: Vec<String> = Vec::new();
            for kind in ["thumb_start", "thumb_mid", "thumb_end"] {
                if let Some(p) = conn
                    .query_row(
                        "SELECT path FROM artifacts WHERE project_id = ?1 AND kind = ?2 ORDER BY created_at_ms DESC LIMIT 1",
                        params![&project_id, kind],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?
                {
                    out.push(p);
                }
            }
            out
        } else {
            Vec::new()
        };

        // selected_pool.json snapshot
        let selected_items: Vec<PoolItemResponse> = {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, kind, title, source_url, license, dedup_key, data_json, selected, created_at_ms\n                 FROM pool_items WHERE project_id = ?1 AND selected = 1 ORDER BY created_at_ms ASC",
            )?;
            let rows = stmt.query_map([&project_id], |row| {
                Ok(PoolItemResponse {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    kind: row.get(2)?,
                    title: row.get(3)?,
                    source_url: row.get(4)?,
                    license: row.get(5)?,
                    dedup_key: row.get(6)?,
                    data_json: row.get(7)?,
                    selected: row.get::<_, i64>(8)? != 0,
                    created_at_ms: row.get(9)?,
                })
            })?;
            rows.filter_map(Result::ok).collect()
        };
        let selected_pool = serde_json::json!({
            "version": 1,
            "project_id": &project_id,
            "generated_at_ms": now_ms(),
            "selected_pool_items": selected_items,
        });
        let selected_pool_rel = format!("{export_dir_rel}/selected_pool.json");
        std::fs::write(data_dir.join(&selected_pool_rel), serde_json::to_vec_pretty(&selected_pool)?)?;

        let ts = now_ms();
        let zip_name = format!("vidunpack-export-{project_id}-{ts}.zip");
        let zip_rel = format!("{export_dir_rel}/{zip_name}");
        let zip_abs = data_dir.join(&zip_rel);

        let file = std::fs::File::create(&zip_abs)?;
        let mut zip = ZipWriter::new(file);
        let options = FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);

        let mut total_bytes: u64 = 0;

        let add_file = |zip: &mut ZipWriter<std::fs::File>, abs: &FsPath, name: &str| -> anyhow::Result<u64> {
            let size = std::fs::metadata(abs)?.len();
            zip.start_file(name, options)?;
            let mut f = std::fs::File::open(abs)?;
            std::io::copy(&mut f, zip)?;
            Ok(size)
        };

        // report / manifest
        if let Some(p) = report_path {
            let abs = data_dir.join(&p);
            if abs.exists() {
                total_bytes = total_bytes.saturating_add(add_file(&mut zip, &abs, "report.html")?);
            }
        }
        if let Some(p) = manifest_path {
            let abs = data_dir.join(&p);
            if abs.exists() {
                total_bytes = total_bytes.saturating_add(add_file(&mut zip, &abs, "manifest.json")?);
            }
        }

        // selected_pool snapshot
        {
            let abs = data_dir.join(&selected_pool_rel);
            total_bytes = total_bytes.saturating_add(add_file(&mut zip, &abs, "selected_pool.json")?);
        }

        // original video
        if let Some(p) = input_video_path {
            let abs = data_dir.join(&p);
            if abs.exists() {
                let file_name = FsPath::new(&p)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("input_video");
                total_bytes = total_bytes.saturating_add(add_file(&mut zip, &abs, &format!("input_video/{file_name}"))?);
            }
        }

        // clips / audio / thumbnails (if present)
        if !clip_paths.is_empty() {
            for p in clip_paths {
                let abs = data_dir.join(&p);
                if !abs.exists() {
                    continue;
                }
                let file_name = FsPath::new(&p)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("clip.mp4");
                total_bytes = total_bytes.saturating_add(add_file(&mut zip, &abs, &format!("clips/{file_name}"))?);
            }
        }

        if let Some(p) = audio_path {
            let abs = data_dir.join(&p);
            if abs.exists() {
                let file_name = FsPath::new(&p)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("audio.wav");
                total_bytes = total_bytes.saturating_add(add_file(&mut zip, &abs, &format!("audio/{file_name}"))?);
            }
        }

        if !thumbnail_paths.is_empty() {
            for p in thumbnail_paths {
                let abs = data_dir.join(&p);
                if !abs.exists() {
                    continue;
                }
                let file_name = FsPath::new(&p)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("thumb.jpg");
                total_bytes = total_bytes.saturating_add(add_file(&mut zip, &abs, &format!("thumbnails/{file_name}"))?);
            }
        }

        zip.finish()?;

        let zip_art = ensure_artifact(&conn, &project_id, "export_zip", &zip_rel, ts)?;

        conn.execute(
            "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'info', 'export_zip', ?3)",
            params![
                &project_id,
                ts,
                serde_json::json!({ "zip": &zip_rel, "bytes": total_bytes }).to_string()
            ],
        )?;

        if let Err(err) = update_profile_after_export(
            &conn,
            &data_dir,
            &project_id,
            ts,
            include_original_video,
            include_report,
            include_manifest,
            include_clips,
            include_audio,
            include_thumbnails,
        )
        {
            tracing::warn!("failed to update profile after export: {err:#}");
            let _ = conn.execute(
                "INSERT INTO events (project_id, ts_ms, level, message, data_json) VALUES (?1, ?2, 'warn', 'profile_update_failed', ?3)",
                params![&project_id, ts, serde_json::json!({ "error": err.to_string() }).to_string()],
            );
        }

        let download_url = format!("/projects/{}/exports/download/{}", project_id, zip_name);
        Ok(Some(ExportZipResponse {
            zip: zip_art,
            total_bytes,
            download_url,
        }))
    })
    .await
    .context("export_zip task failed")??;

    match res {
        Some(r) => Ok(Json(r)),
        None => Err(AppError::NotFound("project not found".to_string())),
    }
}

async fn download_export_file(
    State(state): State<AppState>,
    Path((project_id, file)): Path<(String, String)>,
) -> AppResult<Response> {
    if project_id.trim().is_empty() {
        return Err(AppError::BadRequest("missing project id".to_string()));
    }

    let safe_name = sanitize_file_name(&file);
    if safe_name.is_empty() {
        return Err(AppError::BadRequest("invalid file".to_string()));
    }

    let rel = format!("projects/{}/out/export/{}", project_id, safe_name);
    let abs = state.data_dir.join(&rel);
    if !abs.exists() {
        return Err(AppError::NotFound("file not found".to_string()));
    }

    let file = tokio::fs::File::open(&abs)
        .await
        .with_context(|| format!("failed to open {}", abs.display()))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let mut res = Response::new(body);
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    let disp = format!("attachment; filename=\"{}\"", safe_name);
    res.headers_mut()
        .insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disp).unwrap_or_else(|_| HeaderValue::from_static("attachment")));
    Ok(res)
}
