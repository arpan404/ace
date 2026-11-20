//! `FakeMedia` stands in for an endpoint's image, transcription and speech routes (ADR 0134): the
//! OpenAI-format `POST /images/generations`, `POST /audio/transcriptions` and
//! `POST /audio/speech`, and a chat model that answers `POST /chat/completions` with images. It
//! records every request. Its speech sends the first part of the audio at once and holds the
//! rest until the test calls [`FakeMedia::finish_speech`], so a test can see audio pass through
//! before the endpoint is done.

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
    delay: std::time::Duration,
    image: Arc<Vec<u8>>,
    transcript: Arc<String>,
    seen: Arc<Mutex<Vec<MediaRequest>>>,
    rest_of_speech: Arc<tokio::sync::Semaphore>,
}

/// The first bytes of the fake's spoken answer, sent as soon as it is asked.
pub const SPEECH_START: &[u8] = b"ID3\x04first-sentence-audio";
/// The rest, sent once the test lets it go.
pub const SPEECH_REST: &[u8] = b"-rest-of-the-audio";

pub struct FakeMedia {
    /// The fake's address, to use as an endpoint's base URL.
    pub root: String,
    seen: Arc<Mutex<Vec<MediaRequest>>>,
    rest_of_speech: Arc<tokio::sync::Semaphore>,
}

impl FakeMedia {
    /// Answers images with `image` and transcriptions with `transcript`.
    pub async fn start(image: &[u8], transcript: &str) -> Result<Self, crate::Error> {
        Self::slow(image, transcript, std::time::Duration::ZERO).await
    }

    /// Like `start`, answering images only after `delay`, as a real image model can take long.
    pub async fn slow(
        image: &[u8],
        transcript: &str,
        delay: std::time::Duration,
    ) -> Result<Self, crate::Error> {
        let shared = Shared {
            delay,
            image: Arc::new(image.to_vec()),
            transcript: Arc::new(transcript.to_owned()),
            seen: Arc::default(),
            rest_of_speech: Arc::new(tokio::sync::Semaphore::new(0)),
        };
        let app = Router::new()
            .route("/images/generations", post(images))
            .route("/chat/completions", post(chat))
            .route("/audio/transcriptions", post(transcribe))
            .route("/audio/speech", post(speak))
            .with_state(shared.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address: SocketAddr = listener.local_addr()?;
        tokio::spawn(async move { axum::serve(listener, app).await });
        Ok(Self {
            root: format!("http://{address}/"),
            seen: shared.seen,
            rest_of_speech: shared.rest_of_speech,
        })
    }

    /// Lets one spoken answer send the rest of its audio.
    pub fn finish_speech(&self) {
        self.rest_of_speech.add_permits(1);
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
    tokio::time::sleep(shared.delay).await;
    axum::Json(
        json!({ "created": 1, "data": [{ "b64_json": STANDARD.encode(&*shared.image) }],
                       "usage": { "input_tokens": 50, "output_tokens": 1000 } }),
    )
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
    axum::Json(json!({ "text": format!(" {} ", shared.transcript),
                       "usage": { "type": "tokens", "input_tokens": 20, "output_tokens": 5 } }))
    .into_response()
}

async fn speak(
    State(shared): State<Shared>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    record(&shared, &uri, &headers, &body);
    let gate = shared.rest_of_speech.clone();
    let parts = futures_util::stream::unfold(0u8, move |part| {
        let gate = gate.clone();
        async move {
            match part {
                0 => Some((Ok::<_, std::io::Error>(Bytes::from_static(SPEECH_START)), 1)),
                1 => {
                    if let Ok(permit) = gate.acquire().await {
                        permit.forget();
                    }
                    Some((Ok(Bytes::from_static(SPEECH_REST)), 2))
                }
                _ => None,
            }
        }
    });
    (
        [(axum::http::header::CONTENT_TYPE, "audio/mpeg")],
        axum::body::Body::from_stream(parts),
    )
        .into_response()
}
