//! `/v1/outside/*` (ADR 0202 §3, §6): contracts out, as ace's daemon forwards them from the
//! person's own agents. The daemon signed the client in under an ace grant with
//! `spade-contracts` and stamps that grant on each request (`ace:outside:<grant>`), signed with
//! its own token; a request without that stamp is refused, so Spade's bearer token alone can't
//! claim to be any client. The MCP and A2A bodies are the clients' own, passed through.

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use spade_mcp::serve::Headers;

use super::thread_asks::{Stamp, daemon_stamp, unchecked};
use super::{AppState, problem};
use crate::engine::{FROM_OUTSIDE, OutsideCaller};
use crate::outside::{a2a, mcp};

/// The largest message: a 64 KiB input and its envelope.
const BODY: usize = 256 * 1024;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/outside/mcp",
            post(mcp_message).layer(DefaultBodyLimit::max(BODY)),
        )
        .route(
            "/outside/a2a",
            post(a2a_message).layer(DefaultBodyLimit::max(BODY)),
        )
        .route("/outside/card", get(card))
}

fn valid_grant(grant: &str) -> bool {
    (1..=128).contains(&grant.len())
        && grant
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// The outside client ace's daemon vouches for on this request, or the refusal.
fn caller(
    state: &AppState,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<OutsideCaller, Box<Response>> {
    let refused = || {
        Box::new(problem(
            StatusCode::FORBIDDEN,
            "only ace, for a client it signed in with spade-contracts, calls contracts here",
        ))
    };
    let (host, name) = daemon_stamp(state, headers, body).map_err(|stamp| match stamp {
        Stamp::Refused => refused(),
        Stamp::Unchecked => Box::new(unchecked()),
    })?;
    // The client's name as the person approved it, percent-encoded UTF-8 as every stamp is.
    let name = crate::teams::proof::decode_name(&name).ok_or_else(refused)?;
    match host.strip_prefix(FROM_OUTSIDE) {
        Some(grant) if valid_grant(grant) => Ok(OutsideCaller {
            grant: grant.to_owned(),
            name,
        }),
        _ => Err(refused()),
    }
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// One MCP message. Not moved off the request's task: when the client goes away the call's
/// guard sees it (`outside::mcp`).
async fn mcp_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let caller = match caller(&state, &headers, &body) {
        Ok(caller) => caller,
        Err(refused) => return *refused,
    };
    let mirrored = Headers {
        version: header_text(&headers, "mcp-protocol-version"),
        method: header_text(&headers, "mcp-method"),
        name: header_text(&headers, "mcp-name"),
    };
    let (status, body) = mcp::answer(state.engine.clone(), caller, mirrored, &body).await;
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    match body {
        Some(body) => (status, Json(body)).into_response(),
        None => status.into_response(),
    }
}

async fn a2a_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let caller = match caller(&state, &headers, &body) {
        Ok(caller) => caller,
        Err(refused) => return *refused,
    };
    let version = header_text(&headers, "a2a-version");
    let (status, body) = a2a::answer(state.engine.clone(), caller, version, &body).await;
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(header::CONTENT_TYPE, "application/json")],
        Json(body),
    )
        .into_response()
}

/// The Agent Card's body, for the daemon to address and sign.
async fn card(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(refused) = caller(&state, &headers, b"") {
        return *refused;
    }
    Json(a2a::card(&state.engine)).into_response()
}
