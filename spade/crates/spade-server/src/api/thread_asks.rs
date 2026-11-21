//! `/v1/thread-asks` (ADR 0198): the person's words from an ace thread to a bot or a club, as
//! the local daemon delivers them. Only a request the daemon signed with its own token, as for
//! the inbox, is taken: a client holding Spade's bearer token alone can't make a message claim to
//! come from a thread.

use axum::Json;
use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::Value;

use super::{AppState, problem};
use crate::engine::FROM_ACE;
use crate::teams;

/// The largest ask: the person's words and a 16 000-character context pack.
const ASK_BODY: usize = 256 * 1024;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/thread-asks",
            post(ask).layer(DefaultBodyLimit::max(ASK_BODY)),
        )
        .route("/thread-asks/{key}", get(answer))
        .route("/thread-asks/{key}/stop", post(stop))
}

/// The refusal, unless ace's daemon signed this request, as `ace:thread`, with its own token.
fn signed(state: &AppState, headers: &HeaderMap, body: &[u8]) -> Option<Response> {
    let refused = || {
        problem(
            StatusCode::FORBIDDEN,
            "only ace itself asks for one of its threads",
        )
    };
    let host = headers.get("x-ace-from-host").and_then(|v| v.to_str().ok());
    if host.map(str::trim) != Some(FROM_ACE) {
        return Some(refused());
    }
    match daemon_stamp(state, headers, body) {
        Ok((host, _)) if host == FROM_ACE => None,
        Ok(_) | Err(Stamp::Refused) => Some(refused()),
        Err(Stamp::Unchecked) => Some(unchecked()),
    }
}

/// Why a request's stamp isn't taken.
pub(super) enum Stamp {
    /// Missing, malformed, stale, or not signed with ace's token.
    Refused,
    /// Spade can't check it: it doesn't know this machine's ace ([`unchecked`]).
    Unchecked,
}

/// The answer to a request whose stamp Spade can't check.
pub(super) fn unchecked() -> Response {
    problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "Spade doesn't know this machine's ace, so it can't check the request",
    )
}

/// The sender and its name as ace's daemon stamped and signed them on this request, with ace's
/// own token over the time, both and `body`.
pub(super) fn daemon_stamp(
    state: &AppState,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(String, String), Stamp> {
    let stamp = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty() && v.len() <= 1024)
            .map(str::to_owned)
    };
    let (Some(host), Some(name), Some(time), Some(proof)) = (
        stamp("x-ace-from-host"),
        stamp("x-ace-from-name"),
        stamp("x-ace-inbox-time").and_then(|t| t.parse::<i64>().ok()),
        stamp("x-ace-inbox-proof"),
    ) else {
        return Err(Stamp::Refused);
    };
    let Some(key) = state.ace.as_ref().and_then(|ace| ace.inbox_key()) else {
        return Err(Stamp::Unchecked);
    };
    let now = state.engine.now_ms();
    if teams::proof::verify(&key, &proof, time, now, &host, &name, body) {
        Ok((host, name))
    } else {
        Err(Stamp::Refused)
    }
}

fn reply((status, body): (u16, Value)) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

async fn ask(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Some(refused) = signed(&state, &headers, &body) {
        return refused;
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return problem(StatusCode::BAD_REQUEST, "the body is not JSON");
    };
    reply(state.engine.thread_ask(&body))
}

#[derive(Deserialize)]
struct Wait {
    #[serde(default)]
    wait_ms: u64,
}

async fn answer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(wait): Query<Wait>,
) -> Response {
    if let Some(refused) = signed(&state, &headers, b"") {
        return refused;
    }
    reply(state.engine.thread_answer(&key, wait.wait_ms).await)
}

async fn stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Response {
    if let Some(refused) = signed(&state, &headers, b"") {
        return refused;
    }
    reply(state.engine.thread_stop(&key))
}
