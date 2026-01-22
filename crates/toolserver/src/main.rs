use anyhow::Context;
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    service: &'static str,
    data_dir: String,
    ffmpeg: bool,
    ffprobe: bool,
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

    let db_path = data_dir.join("vidunpack.sqlite3");
    init_db(&db_path)?;

    let state = AppState {
        data_dir,
        db_path,
        ffmpeg,
        ffprobe,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/projects", post(create_project).get(list_projects))
        .route("/projects/{id}", get(get_project))
        .route("/projects/{id}/consent", get(get_consent).post(upsert_consent))
        .route("/projects/{id}/settings", get(get_project_settings).post(update_project_settings))
        .route("/projects/{id}/artifacts", get(list_artifacts))
        .route("/projects/{id}/artifacts/text", post(create_text_artifact))
        .route("/projects/{id}/inputs/url", post(add_input_url))
        .route("/projects/{id}/media/local", post(import_local_video))
        .route("/projects/{id}/pipeline/ffmpeg", post(ffmpeg_pipeline))
        .layer(DefaultBodyLimit::disable())
        .with_state(state);

    let port: u16 = std::env::var("TOOLSERVER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6791);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("toolserver listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind to {addr}"))?;
    axum::serve(listener, app).await.context("toolserver failed")?;
    Ok(())
}

#[derive(Clone)]
struct AppState {
    data_dir: PathBuf,
    db_path: PathBuf,
    ffmpeg: bool,
    ffprobe: bool,
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "toolserver",
        data_dir: state.data_dir.display().to_string(),
        ffmpeg: state.ffmpeg,
        ffprobe: state.ffprobe,
        db_path: state.db_path.display().to_string(),
    })
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
