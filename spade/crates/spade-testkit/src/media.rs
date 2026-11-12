//! `FakeMedia` stands in for an endpoint's image and transcription routes (ADR 0134): the
//! OpenAI-format `POST /images/generations` and `POST /audio/transcriptions`, and a chat model
//! that answers `POST /chat/completions` with images. It records every request.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;
use tokio::net::TcpListener;

/// One request the fake received.
#[derive(Debug, Clone)]
pub struct MediaRequest {
    pub path: String,
    pub authorization: Option<String>,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl MediaRequest {
    /// The body as text (multipart and JSON bodies are text apart from file parts).
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

#[derive(Clone)]
struct Shared {
    image: Arc<Vec<u8>>,
    transcript: Arc<String>,
    seen: Arc<Mutex<Vec<MediaRequest>>>,
}

pub struct FakeMedia {
    /// The fake's address, to use as an endpoint's base URL.
    pub root: String,
    seen: Arc<Mutex<Vec<MediaRequest>>>,
}

impl FakeMedia {
    /// Answers images with `image` and transcriptions with `transcript`.
    pub async fn start(image: &[u8], transcript: &str) -> Result<Self, crate::Error> {
        let shared = Shared {
            image: Arc::new(image.to_vec()),
            transcript: Arc::new(transcript.to_owned()),
            seen: Arc::default(),
        };
        let app = Router::new()
            .route("/images/generations", post(images))
            .route("/chat/completions", post(chat))
            .route("/audio/transcriptions", post(transcribe))
            .with_state(shared.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address: SocketAddr = listener.local_addr()?;
        tokio::spawn(async move { axum::serve(listener, app).await });
        Ok(Self {
            root: format!("http://{address}/"),
            seen: shared.seen,
        })
    }

    pub fn seen(&self) -> Vec<MediaRequest> {
        self.seen
            .lock()
            .map(|seen| seen.clone())
            .unwrap_or_default()
    }
}

fn record(shared: &Shared, uri: &Uri, headers: &HeaderMap, body: &Bytes) {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    if let Ok(mut seen) = shared.seen.lock() {
        seen.push(MediaRequest {
            path: uri.path().to_owned(),
            authorization: header("authorization"),
            content_type: header("content-type"),
            body: body.to_vec(),
        });
    }
}

async fn images(
    State(shared): State<Shared>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    record(&shared, &uri, &headers, &body);
    axum::Json(json!({ "created": 1, "data": [{ "b64_json": STANDARD.encode(&*shared.image) }] }))
        .into_response()
}

async fn chat(State(shared): State<Shared>, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    record(&shared, &uri, &headers, &body);
    let url = format!("data:image/png;base64,{}", STANDARD.encode(&*shared.image));
    axum::Json(json!({ "choices": [{ "message": {
        "role": "assistant", "content": "Here it is.",
        "images": [
            { "type": "image_url", "image_url": { "url": "https://elsewhere.example/x.png" } },
            { "type": "image_url", "image_url": { "url": url } }
        ]
    }}]}))
    .into_response()
}

async fn transcribe(
    State(shared): State<Shared>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    record(&shared, &uri, &headers, &body);
    axum::Json(json!({ "text": format!(" {} ", shared.transcript) })).into_response()
}
