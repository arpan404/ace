//! Digests and notices (ADR 0165): stored digests, their settings globally and per bot, making
//! one now, and the notice stream ace's daemon turns into pushes.

use std::convert::Infallible;

use axum::Extension;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use spade_core::digest::schedule::Settings;
use tokio_stream::wrappers::BroadcastStream;

use super::{AppState, Closing, problem};
use crate::engine::{DigestError, MOST_DIGESTS};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/digests", get(list))
        .route("/digests/settings", get(settings).put(set_settings))
        .route("/digests/{id}", get(one))
        .route(
            "/agents/{id}/digest",
            get(agent_settings).put(set_agent_settings),
        )
        .route("/agents/{id}/digests", axum::routing::post(make_now))
        .route("/notices/live", get(notices))
}

fn digest_problem(error: &DigestError) -> Response {
    let status = match error {
        DigestError::NotFound => StatusCode::NOT_FOUND,
        DigestError::Invalid(_) => StatusCode::BAD_REQUEST,
        DigestError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

fn failed(error: &impl ToString) -> Response {
    problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    #[serde(default)]
    agent: Option<String>,
    /// Only digests with a larger id: what a client that reconnects missed.
    #[serde(default)]
    after: Option<i64>,
    #[serde(default)]
    limit: Option<usize>,
}

/// `GET /v1/digests?agent=&after=&limit=`: `{digests}`, newest first.
async fn list(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Response {
    let limit = q.limit.unwrap_or(50).min(MOST_DIGESTS);
    match state
        .engine
        .digests_json(q.agent.as_deref(), q.after, limit)
    {
        Ok(body) => Json(body).into_response(),
        Err(error) => failed(&error),
    }
}

async fn one(State(state): State<AppState>, Path(id): Path<i64>) -> Response {
    match state.engine.digest_by_id(id) {
        Ok(Some(digest)) => Json(serde_json::json!({ "digest": digest })).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such digest"),
        Err(error) => failed(&error),
    }
}

async fn settings(State(state): State<AppState>) -> Response {
    match state.engine.digest_settings_json() {
        Ok(body) => Json(body).into_response(),
        Err(error) => failed(&error),
    }
}

/// `PUT /v1/digests/settings {every?, polish?}`: replaces the global settings.
async fn set_settings(State(state): State<AppState>, Json(body): Json<SettingsBody>) -> Response {
    match state.engine.set_digest_settings(body.into()) {
        Ok(body) => Json(body).into_response(),
        Err(error) => digest_problem(&error),
    }
}

async fn agent_settings(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.agent_digest_json(&id) {
        Ok(body) => Json(body).into_response(),
        Err(error) => digest_problem(&error),
    }
}

/// `PUT /v1/agents/{id}/digest {every?, polish?}`: a field left out or `null` inherits.
async fn set_agent_settings(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SettingsBody>,
) -> Response {
    match state.engine.set_agent_digest(&id, body.into()) {
        Ok(body) => Json(body).into_response(),
        Err(error) => digest_problem(&error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsBody {
    #[serde(default)]
    every: Option<String>,
    #[serde(default)]
    polish: Option<bool>,
}

impl From<SettingsBody> for Settings {
    fn from(body: SettingsBody) -> Self {
        Self {
            every: body.every,
            polish: body.polish,
        }
    }
}

/// `POST /v1/agents/{id}/digests`: a digest now, over the time since the last one.
async fn make_now(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.digest_now(&id).await {
        Ok(digest) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "digest": digest })),
        )
            .into_response(),
        Err(error) => digest_problem(&error),
    }
}

/// `GET /v1/notices/live`: server-sent `notice` events, from now on. Not stored: a client that
/// reconnects reads digests with `?after=` and events from the conversations.
async fn notices(State(state): State<AppState>, closing: Option<Extension<Closing>>) -> Response {
    let notices = BroadcastStream::new(state.engine.subscribe_notices())
        // A listener that falls behind is closed; it reconnects and catches up from storage.
        .take_while(|item| std::future::ready(item.is_ok()))
        .filter_map(|item| {
            std::future::ready(
                item.ok()
                    .map(|notice| SseEvent::default().event("notice").data(notice.to_string())),
            )
        });
    let closed = async move {
        match closing {
            Some(Extension(Closing(mut rx))) => {
                let _ = rx.wait_for(|closing| *closing).await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    let all: std::pin::Pin<Box<dyn Stream<Item = Result<SseEvent, Infallible>> + Send>> =
        Box::pin(notices.take_until(closed).map(Ok));
    Sse::new(all)
        .keep_alive(KeepAlive::default())
        .into_response()
}
