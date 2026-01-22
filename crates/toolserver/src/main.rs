use axum::{routing::get, Json, Router};
use serde::Serialize;

#[derive(Serialize)]
struct Health {
    ok: bool,
    service: &'static str,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let app = Router::new().route("/health", get(health));

    let port: u16 = std::env::var("TOOLSERVER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6791);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("toolserver listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> Json<Health> {
    Json(Health {
        ok: true,
        service: "toolserver",
    })
}
