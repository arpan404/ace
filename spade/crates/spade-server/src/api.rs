//! Spade's local HTTP API (docs/chat-core.md). Every `/v1` request carries the bearer token
//! from Spade's data folder; keys go in and never come back out.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::{Stream, StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_keys::KeyStore;
use spade_store::StoredEvent;
use tokio_stream::wrappers::BroadcastStream;

use crate::engine::{AnswerError, Engine, Frame, SendError};

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<Engine>,
    pub token: Arc<str>,
    /// The OS keychain, when this machine has one.
    pub keys: Option<KeyStore>,
}

pub fn router(state: AppState) -> Router {
    let v1 = Router::new()
        .route("/conversations", get(list).post(create))
        .route("/conversations/{id}/events", get(events))
        .route("/conversations/{id}/messages", post(message))
        .route("/conversations/{id}/stop", post(stop))
        .route("/conversations/{id}/approvals/{call_id}", post(approve))
        .route("/conversations/{id}/live", get(live))
        .route("/models", get(models))
        .route("/keys/{endpoint}", put(set_key).delete(delete_key))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize))
        .with_state(state);
    Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true })) }))
        .nest("/v1", v1)
        .fallback(|| async { problem(StatusCode::NOT_FOUND, "not found") })
}

async fn authorize(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let expected = format!("Bearer {}", state.token);
    let given = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    {
        next.run(request).await
    } else {
        problem(StatusCode::UNAUTHORIZED, "missing or wrong token")
    }
}

fn problem(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn stored(event: &StoredEvent) -> Value {
    json!({ "seq": event.seq, "at": event.at_ms, "event": event.event.to_json() })
}

fn send_problem(error: &SendError) -> Response {
    let status = match error {
        SendError::NotFound => StatusCode::NOT_FOUND,
        SendError::Empty | SendError::TooLong => StatusCode::BAD_REQUEST,
        SendError::OverCap => StatusCode::PAYMENT_REQUIRED,
        SendError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

async fn list(State(state): State<AppState>) -> Response {
    match state.engine.conversations() {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|(c, answering)| {
                    json!({ "id": c.id, "title": c.title, "updated_at": c.updated_ms, "answering": answering })
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

#[derive(Deserialize)]
struct Text {
    text: String,
}

async fn create(State(state): State<AppState>, Json(body): Json<Text>) -> Response {
    match state.engine.start_conversation(&body.text) {
        Ok(id) => (StatusCode::CREATED, Json(json!({ "id": id }))).into_response(),
        Err(error) => send_problem(&error),
    }
}

#[derive(Deserialize)]
struct After {
    #[serde(default)]
    after: i64,
}

async fn events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<After>,
) -> Response {
    match state.engine.events(&id, q.after) {
        Ok(Some(events)) => Json(events.iter().map(stored).collect::<Vec<_>>()).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

async fn message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Text>,
) -> Response {
    match state.engine.send(&id, &body.text) {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(error) => send_problem(&error),
    }
}

async fn stop(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if state.engine.stop(&id) {
        StatusCode::ACCEPTED.into_response()
    } else {
        problem(StatusCode::NOT_FOUND, "nothing is answering")
    }
}

#[derive(Deserialize)]
struct Approval {
    allowed: bool,
    #[serde(default)]
    always: bool,
}

async fn approve(
    State(state): State<AppState>,
    Path((id, call_id)): Path<(String, String)>,
    Json(body): Json<Approval>,
) -> Response {
    match state
        .engine
        .answer(&id, &call_id, body.allowed, body.always)
    {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(AnswerError::NotFound) => problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(AnswerError::NotAwaiting) => problem(
            StatusCode::CONFLICT,
            "that call is not waiting for an answer",
        ),
        Err(AnswerError::Store(error)) => {
            problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        }
    }
}

async fn live(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<After>,
) -> Response {
    let subscription = match state.engine.subscribe(&id, q.after) {
        Ok(Some(subscription)) => subscription,
        Ok(None) => return problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(error) => return problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    let last = subscription.backlog.last().map_or(q.after, |e| e.seq);
    let mut first: Vec<SseEvent> = subscription
        .backlog
        .iter()
        .map(|e| {
            SseEvent::default()
                .event("stored")
                .data(stored(e).to_string())
        })
        .collect();
    if let Some(snapshot) = subscription.snapshot {
        first.push(
            SseEvent::default()
                .event("snapshot")
                .data(json!({ "reply": snapshot.reply, "text": snapshot.text }).to_string()),
        );
    }
    let frames = BroadcastStream::new(subscription.frames)
        // A subscriber that falls behind is closed; it reconnects with its last seq.
        .take_while(|item| std::future::ready(item.is_ok()))
        .scan(last, |last, item| {
            let event = match item {
                Ok(Frame::Stored(e)) if e.seq > *last => {
                    *last = e.seq;
                    Some(
                        SseEvent::default()
                            .event("stored")
                            .data(stored(&e).to_string()),
                    )
                }
                Ok(Frame::Delta { reply, text }) => Some(
                    SseEvent::default()
                        .event("delta")
                        .data(json!({ "reply": reply, "text": text }).to_string()),
                ),
                _ => None,
            };
            std::future::ready(Some(event))
        })
        .filter_map(std::future::ready);
    let all: std::pin::Pin<Box<dyn Stream<Item = Result<SseEvent, Infallible>> + Send>> =
        Box::pin(stream::iter(first).chain(frames).map(Ok));
    Sse::new(all)
        .keep_alive(KeepAlive::default())
        .into_response()
}

async fn models(State(state): State<AppState>) -> Response {
    let catalog = state.engine.models().catalog();
    let endpoints: Vec<Value> = catalog
        .endpoints()
        .iter()
        .map(|endpoint| {
            let key_set = state
                .keys
                .as_ref()
                .and_then(|keys| keys.has(&endpoint.id).ok())
                .unwrap_or(false)
                || endpoint
                    .key_env
                    .as_deref()
                    .is_some_and(|var| std::env::var(var).is_ok_and(|v| !v.trim().is_empty()));
            json!({
                "id": endpoint.id, "name": endpoint.name, "format": endpoint.format.name(),
                "needs_key": endpoint.needs_key, "key_set": key_set,
                "models": endpoint.models.iter().map(|m| json!({ "id": m.id, "name": m.name })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let roles = json!({
        "main": catalog.role(spade_models::Role::Main),
        "fast": catalog.role(spade_models::Role::Fast),
        "deep": catalog.role(spade_models::Role::Deep),
    });
    Json(json!({ "endpoints": endpoints, "roles": roles, "keychain": state.keys.is_some() }))
        .into_response()
}

#[derive(Deserialize)]
struct Key {
    key: String,
}

async fn set_key(
    State(state): State<AppState>,
    Path(endpoint): Path<String>,
    Json(body): Json<Key>,
) -> Response {
    let Some(keys) = state.keys else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "this machine has no keychain; set the endpoint's environment variable",
        );
    };
    match keys.set(&endpoint, &body.key) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(spade_keys::KeyError::Invalid(why)) => problem(StatusCode::BAD_REQUEST, why),
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string()),
    }
}

async fn delete_key(State(state): State<AppState>, Path(endpoint): Path<String>) -> Response {
    let Some(keys) = state.keys else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "this machine has no keychain",
        );
    };
    match keys.delete(&endpoint) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => problem(StatusCode::NOT_FOUND, "no key stored for that endpoint"),
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string()),
    }
}
