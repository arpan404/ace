//! `/v1/accounts/chatgpt` and `/v1/endpoints/{id}/sign-out` (ADR 0214; docs/agents.md,
//! "Providers and accounts"). No route returns a token. Starting, reading and cancelling a
//! sign-in, signing out, and changing or removing a signed-in account are the person's alone:
//! Spade's bearer token can't tell them from another process that holds it, so each needs the
//! person's stamp (`x-ace-person`) over the whole request, which ace's daemon makes only for a
//! window that proved it is theirs (ADR 0171, amendment 7).

use axum::Json;
use axum::body::Bytes;
use axum::extract::{OriginalUri, Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_chatgpt::FlowView;

use super::endpoints::{endpoint_problem, one_endpoint_for};
use super::{AppState, off_thread, problem};
use crate::engine::Standing;

#[derive(Deserialize)]
pub(super) struct Start {
    method: String,
    #[serde(default)]
    terms_read: bool,
    #[serde(default)]
    account: Option<String>,
}

/// A sign-in as the app reads it: once done, with the account as `GET /v1/models` lists it.
fn flow_json(state: &AppState, flow: &FlowView) -> Value {
    let mut out = json!(flow);
    if let Some(id) = &flow.endpoint {
        let views = state.engine.endpoint_views().unwrap_or_default();
        out["endpoint"] = views
            .iter()
            .find(|v| &v.stored.id == id)
            .map_or(Value::Null, |v| {
                one_endpoint_for(state, v, Standing::Person)
            });
    }
    out
}

/// Whether the request carries the person's stamp for `target` (`accounts`, or
/// `account:<id>`) over the request itself: `<METHOD> <path and query>:<SHA-256 of the body>`, so
/// a stamp holds for this request and no other, whatever the body says. Used up if it holds.
pub(super) fn standing(
    state: &AppState,
    stamp: Option<&str>,
    target: &str,
    method: &Method,
    uri: &Uri,
    body: &[u8],
) -> Standing {
    use sha2::{Digest, Sha256};
    if stamp.is_none() {
        return Standing::Unconfirmed;
    }
    let digest: String = Sha256::digest(body)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let path = uri.path_and_query().map_or(uri.path(), |p| p.as_str());
    let value = format!("{method} {path}:{digest}");
    if state.engine.person_says(stamp, target, &value) {
        Standing::Person
    } else {
        Standing::Unconfirmed
    }
}

fn forbidden() -> Response {
    problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM)
}

pub(super) async fn start(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let stamp = headers
        .get(crate::security::attest::HEADER)
        .and_then(|v| v.to_str().ok());
    if standing(&state, stamp, "accounts", &method, &uri, &body) != Standing::Person {
        return forbidden();
    }
    let body: Start = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(error) => {
            let text: String = error.to_string().chars().take(300).collect();
            return problem(StatusCode::UNPROCESSABLE_ENTITY, &text);
        }
    };
    match state
        .engine
        .start_chatgpt_sign_in(&body.method, body.terms_read, body.account)
        .await
    {
        Ok(flow) => (
            StatusCode::CREATED,
            Json(json!({ "flow": flow_json(&state, &flow) })),
        )
            .into_response(),
        Err(error) => endpoint_problem(&error),
    }
}

/// A sign-in as it stands: its link and code are the person's to read.
pub(super) async fn read(
    State(state): State<AppState>,
    Path(flow): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let stamp = headers
        .get(crate::security::attest::HEADER)
        .and_then(|v| v.to_str().ok());
    if standing(&state, stamp, "accounts", &method, &uri, &body) != Standing::Person {
        return forbidden();
    }
    off_thread(move || match state.engine.chatgpt_sign_in(&flow) {
        Some(flow) => Json(json!({ "flow": flow_json(&state, &flow) })).into_response(),
        None => problem(StatusCode::NOT_FOUND, "no such sign-in"),
    })
    .await
}

pub(super) async fn cancel(
    State(state): State<AppState>,
    Path(flow): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let stamp = headers
        .get(crate::security::attest::HEADER)
        .and_then(|v| v.to_str().ok());
    if standing(&state, stamp, "accounts", &method, &uri, &body) != Standing::Person {
        return forbidden();
    }
    if state.engine.cancel_chatgpt_sign_in(&flow) {
        StatusCode::NO_CONTENT.into_response()
    } else {
        problem(StatusCode::NOT_FOUND, "no sign-in is waiting with that id")
    }
}

pub(super) async fn sign_out(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let stamp = headers
        .get(crate::security::attest::HEADER)
        .and_then(|v| v.to_str().ok());
    let target = format!("account:{id}");
    if standing(&state, stamp, &target, &method, &uri, &body) != Standing::Person {
        return forbidden();
    }
    match state.engine.sign_out(&id).await {
        Ok(view) => {
            off_thread(move || {
                Json(json!({ "endpoint": one_endpoint_for(&state, &view, Standing::Person) }))
                    .into_response()
            })
            .await
        }
        Err(error) => endpoint_problem(&error),
    }
}
