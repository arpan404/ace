pub mod checkpoint;
pub mod codex;
pub mod editor;
pub mod git;
pub mod github;
pub mod project;
pub mod ws;

use axum::{Json, Router, routing::get};
use serde::Serialize;
use std::net::SocketAddr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

impl ServerConfig {
    #[must_use]
    pub fn new(host: String, port: u16) -> Self {
        Self { host, port }
    }

    #[must_use]
    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusResponse {
    pub ok: bool,
    pub protocol_version: u16,
}

pub fn router() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/status", get(status))
        .merge(ws::router())
        .nest("/api/git", git::router())
        .nest("/api/github", github::router())
}

pub fn parse_bind_addr(config: &ServerConfig) -> Result<SocketAddr, std::net::AddrParseError> {
    config.bind_addr().parse()
}

async fn health() -> &'static str {
    "ok"
}

async fn status() -> Json<StatusResponse> {
    Json(StatusResponse {
        ok: true,
        protocol_version: ace_protocol::PROTOCOL_VERSION,
    })
}

#[cfg(test)]
mod tests {
    use super::router;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn product_router_does_not_expose_http_github_image_proxy() {
        let response = router()
            .oneshot(
                Request::builder()
                    .uri("/api/github-issue-image?cwd=%2Frepo&url=https%3A%2F%2Fprivate-user-images.githubusercontent.com%2F123%2Fexample.png")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
