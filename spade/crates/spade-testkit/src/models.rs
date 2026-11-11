//! A fake endpoint that answers `GET …/models` with a fixed body, after a delay, and records each
//! request's path and headers.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tokio::net::TcpListener;

use crate::Seen;

#[derive(Clone)]
struct Shared {
    body: Arc<String>,
    status: u16,
    delay: Duration,
    seen: Arc<Mutex<Vec<Seen>>>,
}

pub struct FakeModelList {
    /// The fake's address, to use as an endpoint's base URL.
    pub root: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl FakeModelList {
    /// Answers every `GET` with `status` and `body` (JSON) after `delay`.
    pub async fn start(
        status: u16,
        body: impl Into<String>,
        delay: Duration,
    ) -> Result<Self, crate::Error> {
        let shared = Shared {
            body: Arc::new(body.into()),
            status,
            delay,
            seen: Arc::default(),
        };
        let app = Router::new()
            .route("/{*path}", get(answer))
            .with_state(shared.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address: SocketAddr = listener.local_addr()?;
        tokio::spawn(async move { axum::serve(listener, app).await });
        Ok(Self {
            root: format!("http://{address}/"),
            seen: shared.seen,
        })
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen
            .lock()
            .map(|seen| seen.clone())
            .unwrap_or_default()
    }
}

async fn answer(State(shared): State<Shared>, uri: Uri, headers: HeaderMap) -> Response {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    if let Ok(mut seen) = shared.seen.lock() {
        seen.push(Seen {
            path: uri
                .path_and_query()
                .map_or_else(|| uri.path().to_owned(), |p| p.as_str().to_owned()),
            key: header("authorization").or_else(|| header("x-api-key")),
            headers: headers
                .iter()
                .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
                .collect(),
            body: serde_json::Value::Null,
        });
    }
    if !shared.delay.is_zero() {
        tokio::time::sleep(shared.delay).await;
    }
    let status =
        axum::http::StatusCode::from_u16(shared.status).unwrap_or(axum::http::StatusCode::OK);
    (
        status,
        [("content-type", "application/json")],
        shared.body.as_str().to_owned(),
    )
        .into_response()
}
