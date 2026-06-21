pub mod git;
pub mod github;

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
        .nest("/api/git", git::router())
        .merge(github::image_proxy_router())
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
