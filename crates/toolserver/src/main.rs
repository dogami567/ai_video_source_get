use anyhow::Context;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    service: &'static str,
    data_dir: String,
    ffmpeg: bool,
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
    if !ffmpeg {
        tracing::warn!("ffmpeg not found on PATH; ffmpeg-dependent features will be unavailable");
    }

    let db_path = data_dir.join("vidunpack.sqlite3");
    init_db(&db_path)?;

    let state = AppState {
        data_dir,
        db_path,
        ffmpeg,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/projects", post(create_project).get(list_projects))
        .route("/projects/{id}", get(get_project))
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
}

fn detect_ffmpeg() -> bool {
    let output = std::process::Command::new("ffmpeg")
        .arg("-version")
        .output();

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

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "toolserver",
        data_dir: state.data_dir.display().to_string(),
        ffmpeg: state.ffmpeg,
        db_path: state.db_path.display().to_string(),
    })
}
