//! A bot's wakes and owned services (ADR 0160), for the person: what it sleeps or waits for,
//! waking it early or cancelling, and its services with their output.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::{AppState, problem};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents/{id}/wakes", get(list))
        .route("/agents/{id}/wakes/{wake}", delete(cancel))
        .route("/agents/{id}/wakes/{wake}/wake", post(wake_now))
        .route("/agents/{id}/services", get(services))
        .route("/agents/{id}/services/{service}", delete(stop_service))
        .route("/agents/{id}/services/{service}/logs", get(logs))
}

fn failed(error: &impl ToString) -> Response {
    problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
}

async fn list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.agent_wakes(&id) {
        Ok(Some(wakes)) => Json(json!({ "wakes": wakes })).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => failed(&error),
    }
}

async fn wake_now(
    State(state): State<AppState>,
    Path((id, wake)): Path<(String, String)>,
) -> Response {
    match state.engine.agent_wake_now(&id, &wake) {
        Ok(Some(true)) => StatusCode::ACCEPTED.into_response(),
        Ok(Some(false)) => problem(StatusCode::CONFLICT, "that wake is not open"),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => failed(&error),
    }
}

async fn cancel(
    State(state): State<AppState>,
    Path((id, wake)): Path<(String, String)>,
) -> Response {
    match state.engine.agent_cancel_wake(&id, &wake) {
        Ok(Some(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Some(false)) => problem(StatusCode::CONFLICT, "that wake is not open"),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => failed(&error),
    }
}

async fn services(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.agent_services(&id) {
        Ok(Some(all)) => {
            let shown: Vec<_> = all
                .iter()
                .map(|s| {
                    json!({
                        "id": s.service,
                        "name": s.name,
                        "command": spade_core::redact::one_line(&s.command),
                        "cwd": s.cwd,
                        "keep": s.keep,
                        "state": s.state(),
                        "exit_code": s.ended.and_then(|(_, code)| code),
                        "restarts": s.restarts,
                    })
                })
                .collect();
            Json(json!({ "services": shown })).into_response()
        }
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => failed(&error),
    }
}

#[derive(Deserialize, Default)]
struct Window {
    #[serde(default)]
    after: Option<u64>,
    #[serde(default)]
    lines: Option<usize>,
}

async fn logs(
    State(state): State<AppState>,
    Path((id, service)): Path<(String, String)>,
    Query(window): Query<Window>,
) -> Response {
    let most = window.lines.unwrap_or(200).clamp(1, 2000);
    match state
        .engine
        .service_lines(&id, &service, window.after.unwrap_or(0), most)
    {
        Ok(Some((lines, next))) => {
            let lines: Vec<_> = lines
                .iter()
                .map(|l| json!({ "n": l.n, "text": l.text }))
                .collect();
            Json(json!({ "lines": lines, "next": next })).into_response()
        }
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such service, or no output kept"),
        Err(error) => failed(&error),
    }
}

async fn stop_service(
    State(state): State<AppState>,
    Path((id, service)): Path<(String, String)>,
) -> Response {
    match state.engine.stop_agent_service(&id, &service) {
        Ok(Some(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Some(false)) => problem(StatusCode::CONFLICT, "that service is not running"),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => failed(&error),
    }
}
