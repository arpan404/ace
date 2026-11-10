//! Spade's HTTP server: routes and the serve loop. Configuration lives in [`config`].

pub mod config;

use std::future::Future;

use axum::{Json, Router, http::StatusCode, routing::get};
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// Every route Spade answers. Unknown paths get a JSON 404.
pub fn router() -> Router {
    Router::new()
        .route("/health", get(health))
        .fallback(not_found)
}

/// Serves [`router`] on `listener` until `shutdown` resolves, then finishes open requests.
pub async fn serve(
    listener: TcpListener,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, router())
        .with_graceful_shutdown(shutdown)
        .await
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn not_found() -> (StatusCode, Json<Value>) {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })))
}
