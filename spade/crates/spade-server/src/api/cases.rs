//! Cases (ADR 0204 §1): a bot's finished runs the person kept as tests. A preview shows what
//! keeping would write, already redacted, so the person can mark more to hide before saving.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{AppState, problem};
use crate::engine::{CaseError, KeepInput, ReplayError, ReplayInput};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents/{id}/cases", get(list).post(keep))
        .route("/agents/{id}/cases/preview", post(preview))
        .route("/agents/{id}/cases/replay", post(replay).get(replay_cost))
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

/// `{cases?, recipe?, files?, pages?, model?}`: which kept runs, on which version (the bot's own
/// when absent), and a model replay's model (a free wiring replay when absent).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplayBody {
    #[serde(default)]
    cases: Vec<String>,
    #[serde(default)]
    recipe: Option<Value>,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    pages: BTreeMap<String, String>,
    #[serde(default)]
    model: Option<String>,
}

fn replay_failed(error: &ReplayError) -> Response {
    let status = match error {
        ReplayError::NotFound => StatusCode::NOT_FOUND,
        ReplayError::Invalid(_) => StatusCode::BAD_REQUEST,
        ReplayError::NoVersion => StatusCode::CONFLICT,
        ReplayError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

/// `POST /v1/agents/{id}/cases/replay` (ADR 0204 §2): `{replay}`, each kept run replayed and
/// judged, with a summary line.
async fn replay(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ReplayBody>,
) -> Response {
    let input = ReplayInput {
        cases: body.cases,
        recipe: body.recipe,
        files: body.files,
        pages: body.pages,
        model: body.model,
    };
    // A model replay works on a copy of the bot's own files, never the files themselves.
    let workspace = state
        .workspaces
        .as_ref()
        .and_then(|w| w.of(&id).ok())
        .and_then(|w| w.path().ok());
    match state.engine.replay(&id, &input, workspace).await {
        Ok(report) => Json(json!({ "replay": report })).into_response(),
        Err(error) => replay_failed(&error),
    }
}

#[derive(Deserialize)]
struct CostQuery {
    model: String,
}

/// `GET /v1/agents/{id}/cases/replay?model=ROLE`: `{estimate}`, about what a model replay of the
/// latest kept runs costs on that model.
async fn replay_cost(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<CostQuery>,
) -> Response {
    match state.engine.replay_estimate(&id, &query.model) {
        Ok(estimate) => Json(json!({ "estimate": estimate })).into_response(),
        Err(error) => replay_failed(&error),
    }
}
