//! Reaching the person (ADR 0195): the service-wide settings (notifications, do not disturb,
//! quiet hours, the interruption budget, the morning brief, spend alerts), each bot's own
//! switch, and the morning brief made now.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;

use super::{AppState, problem};
use crate::engine::ReachError;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/reach", get(settings).put(set_settings))
        .route("/reach/brief", post(brief_now))
        .route("/agents/{id}/reach", get(agent).put(set_agent))
}

fn reach_problem(error: &ReachError) -> Response {
    let status = match error {
        ReachError::NotFound => StatusCode::NOT_FOUND,
        ReachError::Invalid(_) => StatusCode::BAD_REQUEST,
        ReachError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

/// `GET /v1/reach`: `{settings, quiet, held}`; `quiet` says why proactive notices wait now.
async fn settings(State(state): State<AppState>) -> Response {
    match state.engine.reach_json() {
        Ok(body) => Json(body).into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `PUT /v1/reach {notify?, dnd?, quiet?, budget?, brief?, spend?}`: the fields given replace
/// the stored ones (an object's own fields one by one).
async fn set_settings(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    match state.engine.set_reach(&body) {
        Ok(body) => Json(body).into_response(),
        Err(error) => reach_problem(&error),
    }
}

/// `POST /v1/reach/brief`: the morning brief now, over the time since the last one.
async fn brief_now(State(state): State<AppState>) -> Response {
    let now = state.engine.now_ms();
    match state.engine.make_brief(now).await {
        Ok(digest) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "digest": digest })),
        )
            .into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

async fn agent(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.agent_reach_json(&id) {
        Ok(body) => Json(body).into_response(),
        Err(error) => reach_problem(&error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentBody {
    /// `null` follows the global switch.
    #[serde(default)]
    notify: Option<bool>,
}

/// `PUT /v1/agents/{id}/reach {notify}`.
async fn set_agent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AgentBody>,
) -> Response {
    match state.engine.set_agent_reach(&id, body.notify) {
        Ok(body) => Json(body).into_response(),
        Err(error) => reach_problem(&error),
    }
}
