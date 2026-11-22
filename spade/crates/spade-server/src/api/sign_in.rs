//! `/v1/accounts/chatgpt` and `/v1/endpoints/{id}/sign-out` (ADR 0214; docs/agents.md,
//! "Providers and accounts"). No route returns a token. Starting a sign-in, signing out and
//! removing a signed-in account are the person's alone: Spade's bearer token can't tell them
//! from another process that holds it, so each needs the person's stamp (`x-ace-person`), which
//! ace's daemon makes only for a window that proved it is theirs (ADR 0171, amendment 7).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_chatgpt::FlowView;

use super::body::Body;
use super::endpoints::{endpoint_problem, one_endpoint};
use super::{AppState, off_thread, problem};

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
            .map_or(Value::Null, |v| one_endpoint(state, v));
    }
    out
}

/// Whether the request carries the person's stamp on `value` for account `target`
/// (`account:<id>`; `accounts` for a new sign-in). The stamp is used up.
pub(super) fn person_says(
    state: &AppState,
    headers: &HeaderMap,
    target: &str,
    value: &str,
) -> bool {
    let stamp = headers
        .get(crate::security::attest::HEADER)
        .and_then(|v| v.to_str().ok());
    let target = if target == "accounts" {
        target.to_owned()
    } else {
        format!("account:{target}")
    };
    state.engine.person_says(stamp, &target, value)
}

pub(super) async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(body): Body<Start>,
) -> Response {
    let value = format!(
        "chatgpt_sign_in:{}:{}",
        body.method,
        body.account.as_deref().unwrap_or("")
    );
    if !person_says(&state, &headers, "accounts", &value) {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
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

pub(super) async fn read(State(state): State<AppState>, Path(flow): Path<String>) -> Response {
    off_thread(move || match state.engine.chatgpt_sign_in(&flow) {
        Some(flow) => Json(json!({ "flow": flow_json(&state, &flow) })).into_response(),
        None => problem(StatusCode::NOT_FOUND, "no such sign-in"),
    })
    .await
}

pub(super) async fn cancel(State(state): State<AppState>, Path(flow): Path<String>) -> Response {
    if state.engine.cancel_chatgpt_sign_in(&flow) {
        StatusCode::NO_CONTENT.into_response()
    } else {
        problem(StatusCode::NOT_FOUND, "no sign-in is waiting with that id")
    }
}

pub(super) async fn sign_out(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !person_says(&state, &headers, &id, "sign_out") {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
    match state.engine.sign_out(&id).await {
        Ok(view) => {
            off_thread(move || {
                Json(json!({ "endpoint": one_endpoint(&state, &view) })).into_response()
            })
            .await
        }
        Err(error) => endpoint_problem(&error),
    }
}
