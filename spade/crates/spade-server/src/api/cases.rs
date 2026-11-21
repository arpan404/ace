//! Cases (ADR 0204 §1): a bot's finished runs the person kept as tests. A preview shows what
//! keeping would write, already redacted, so the person can mark more to hide before saving.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::{AppState, problem};
use crate::engine::{CaseError, KeepInput};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents/{id}/cases", get(list).post(keep))
        .route("/agents/{id}/cases/preview", post(preview))
        .route("/agents/{id}/cases/{case}", get(read).delete(remove))
}

/// `{reply, mark?, why?, hide?}`: the reply to keep, "right" or "wrong", a line of why, and the
/// values the person marked to hide.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    reply: String,
    #[serde(default)]
    mark: Option<String>,
    #[serde(default)]
    why: Option<String>,
    #[serde(default)]
    hide: Vec<String>,
}

impl From<Body> for KeepInput {
    fn from(body: Body) -> Self {
        Self {
            reply: body.reply,
            mark: body.mark,
            why: body.why,
            hide: body.hide,
        }
    }
}

fn failed(error: &CaseError) -> Response {
    let status = match error {
        CaseError::NotFound | CaseError::NoCase => StatusCode::NOT_FOUND,
        CaseError::Invalid(_) => StatusCode::BAD_REQUEST,
        CaseError::NotKept(spade_core::quality::case::NotKept::NoReply) => StatusCode::NOT_FOUND,
        CaseError::NotKept(_) => StatusCode::CONFLICT,
        CaseError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

/// `GET /v1/agents/{id}/cases`: `{cases}`, newest first.
async fn list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.cases_of(&id) {
        Ok(cases) => Json(json!({ "cases": cases })).into_response(),
        Err(error) => failed(&error),
    }
}

/// `POST /v1/agents/{id}/cases/preview`: `{case}`, what keeping would write.
async fn preview(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Body>,
) -> Response {
    match state.engine.preview_case(&id, &body.into()) {
        Ok(view) => Json(view).into_response(),
        Err(error) => failed(&error),
    }
}

/// `POST /v1/agents/{id}/cases`: keeps the reply; `201` with `{summary, case}`, or `200` with
/// the case that reply already has.
async fn keep(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Body>,
) -> Response {
    match state.engine.keep_case(&id, &body.into()) {
        Ok((view, true)) => (StatusCode::CREATED, Json(view)).into_response(),
        Ok((view, false)) => Json(view).into_response(),
        Err(error) => failed(&error),
    }
}

/// `GET /v1/agents/{id}/cases/{case}`: `{summary, case}`.
async fn read(State(state): State<AppState>, Path((id, case)): Path<(String, String)>) -> Response {
    match state.engine.case_of(&id, &case) {
        Ok(view) => Json(view).into_response(),
        Err(error) => failed(&error),
    }
}

/// `DELETE /v1/agents/{id}/cases/{case}`.
async fn remove(
    State(state): State<AppState>,
    Path((id, case)): Path<(String, String)>,
) -> Response {
    match state.engine.delete_case(&id, &case) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failed(&error),
    }
}
