//! The task manager (ADR 0200 §6.3): every bot that runs, in one read, and the person's Stop,
//! Pause and Resume on each, and Unarchive on an archived one. Behind the API's token like every `/v1` route.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use spade_store::StoreError;

use super::{AppState, problem};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/running", get(list))
        .route("/agents/{id}/stop", post(stop))
        .route("/agents/{id}/pause", post(pause))
        .route("/agents/{id}/resume", post(resume))
        .route("/agents/{id}/unarchive", post(unarchive))
}

fn failed(error: &impl ToString) -> Response {
    problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
}

async fn list(State(state): State<AppState>) -> Response {
    match state.engine.running() {
        Ok(bots) => Json(json!({ "bots": bots })).into_response(),
        Err(error) => failed(&error),
    }
}

/// An action's answer: whether it changed anything, and every row as it reads now, so the page
/// shows the result without another read.
fn answered(state: &AppState, done: Result<Option<bool>, StoreError>) -> Response {
    match done {
        Ok(Some(changed)) => match state.engine.running() {
            Ok(bots) => Json(json!({ "changed": changed, "bots": bots })).into_response(),
            Err(error) => failed(&error),
        },
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => failed(&error),
    }
}

async fn stop(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let done = state.engine.stop_agent(&id);
    answered(&state, done)
}

async fn pause(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let done = state.engine.pause_agent(&id);
    answered(&state, done)
}

async fn resume(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // Not while its organization's policy still blocks the version it runs (ADR 0206 §3).
    if let Some(why) = state
        .engine
        .bot_package(&id)
        .and_then(|link| state.engine.org_blocked(&link.package))
    {
        return super::problem(StatusCode::FORBIDDEN, &why);
    }
    let done = state.engine.resume_agent(&id);
    answered(&state, done)
}

async fn unarchive(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let done = state.engine.unarchive_agent(&id);
    answered(&state, done)
}
