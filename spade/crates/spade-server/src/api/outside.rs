//! `/v1/outside/*` (ADR 0202 §3, §6): contracts out, as ace's daemon forwards them from the
//! person's own agents. The daemon signed the client in under an ace grant with
//! `spade-contracts` and stamps that grant on each request (`ace:outside:<grant>`), signed with
//! its own token; a request without that stamp is refused, so Spade's bearer token alone can't
//! claim to be any client. The MCP and A2A bodies are the clients' own, passed through.
//!
//! The stamp (`teams::proof::outside_proof`) signs the method, the route, the protocol headers
//! Spade acts on, the body and a nonce, and each nonce is taken once while the stamp's time
//! verifies: a captured stamp can't be replayed, nor moved to another route or method.

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, OriginalUri, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use spade_mcp::serve::Headers;

use super::thread_asks::unchecked;
use super::{AppState, problem};
use crate::engine::{FROM_OUTSIDE, OutsideCaller};
use crate::outside::{a2a, mcp};
use crate::teams::proof::{self, Forwarded, MOST_SKEW_MS, OUTSIDE_HEADERS};

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

/// The request as it reached Spade, for its stamp to be checked against.
struct Reached<'a> {
    method: &'a Method,
    route: &'a str,
    headers: &'a HeaderMap,
    body: &'a [u8],
}

/// The outside client ace's daemon vouches for on this request, or the refusal.
fn caller(state: &AppState, reached: &Reached<'_>) -> Result<OutsideCaller, Box<Response>> {
    let refused = || {
        Box::new(problem(
            StatusCode::FORBIDDEN,
            "only ace, for a client it signed in with spade-contracts, calls contracts here",
        ))
    };
    let stamp = |name: &str| {
        reached
            .headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty() && v.len() <= 1024)
    };
    let (Some(host), Some(name), Some(time), Some(nonce), Some(signature)) = (
        stamp("x-ace-from-host"),
        stamp("x-ace-from-name"),
        stamp("x-ace-inbox-time").and_then(|t| t.parse::<i64>().ok()),
        stamp("x-ace-outside-nonce").filter(|n| proof::valid_nonce(n)),
        stamp("x-ace-inbox-proof"),
    ) else {
        return Err(refused());
    };
    let Some(key) = state.ace.as_ref().and_then(|ace| ace.inbox_key()) else {
        return Err(Box::new(unchecked()));
    };
    let forwarded = Forwarded {
        time,
        nonce,
        method: reached.method.as_str(),
        route: reached.route,
        sender: host,
        name,
        headers: OUTSIDE_HEADERS.map(|h| header_text(reached.headers, h)),
        body: reached.body,
    };
    if !proof::verify_outside(&key, signature, state.engine.now_ms(), &forwarded) {
        return Err(refused());
    }
    // Once: the same stamp again is a replay. Taken only once it verified, so nobody without
    // ace's token can fill the book.
    if !state.engine.outside_take_nonce(nonce, time, MOST_SKEW_MS) {
        return Err(refused());
    }
    // The client's name as the person approved it, percent-encoded UTF-8 as every stamp is.
    let name = proof::decode_name(name).ok_or_else(refused)?;
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
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let reached = Reached {
        method: &method,
        route: uri.path(),
        headers: &headers,
        body: &body,
    };
    let caller = match caller(&state, &reached) {
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
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let reached = Reached {
        method: &method,
        route: uri.path(),
        headers: &headers,
        body: &body,
    };
    let caller = match caller(&state, &reached) {
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
async fn card(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let reached = Reached {
        method: &method,
        route: uri.path(),
        headers: &headers,
        body: b"",
    };
    if let Err(refused) = caller(&state, &reached) {
        return *refused;
    }
    Json(a2a::card(&state.engine)).into_response()
}
