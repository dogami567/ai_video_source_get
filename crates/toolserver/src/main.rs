use anyhow::Context;
use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use std::{net::SocketAddr, path::PathBuf};

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    service: &'static str,
    data_dir: String,
    ffmpeg: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "data".to_string());
    let data_dir = PathBuf::from(data_dir);
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("failed to create DATA_DIR at {}", data_dir.display()))?;

    ensure_ffmpeg_available()?;

    let state = AppState { data_dir };

    let app = Router::new().route("/health", get(health)).with_state(state);

    let port: u16 = std::env::var("TOOLSERVER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6791);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("toolserver listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.context("toolserver failed")?;
    Ok(())
}

#[derive(Clone)]
struct AppState {
    data_dir: PathBuf,
}

fn ensure_ffmpeg_available() -> anyhow::Result<()> {
    let output = std::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .context("failed to run `ffmpeg -version`. Is ffmpeg installed and on PATH?")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "`ffmpeg -version` exited with {}: {}",
            output.status,
            stderr.trim()
        );
    }

    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "toolserver",
        data_dir: state.data_dir.display().to_string(),
        ffmpeg: true,
    })
}
