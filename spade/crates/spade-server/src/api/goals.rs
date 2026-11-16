//! A bot's task: its goal, plan, evidence, the latest check and progress (ADR 0159). The person
//! reads it, and sets, changes or ends the goal; only the person changes an open goal.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::{AppState, problem};
use crate::engine::{GoalError, GoalInput};

/// `{title, criteria, text?, verifier?}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GoalBody {
    title: String,
    criteria: Vec<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    verifier: Option<String>,
}

fn goal_problem(error: &GoalError) -> Response {
    let status = match error {
        GoalError::NotFound => StatusCode::NOT_FOUND,
        GoalError::Invalid(_) => StatusCode::BAD_REQUEST,
        GoalError::NoGoal => StatusCode::CONFLICT,
        GoalError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

/// `GET /v1/agents/{id}/task`: `{task}`, `null` when the bot never had a goal.
pub(super) async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.task_view(&id) {
        Ok(task) => Json(json!({ "task": task })).into_response(),
        Err(error) => goal_problem(&error),
    }
}

/// `PUT /v1/agents/{id}/task/goal`: sets the goal, or changes the open one.
pub(super) async fn set(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<GoalBody>,
) -> Response {
    let input = GoalInput {
        title: body.title,
        text: body.text,
        criteria: body.criteria,
        verifier: body.verifier,
    };
    match state.engine.set_goal(&id, input) {
        Ok(task) => Json(json!({ "task": task })).into_response(),
        Err(error) => goal_problem(&error),
    }
}

/// `?outcome=failed` on ending a goal: its episode records it as failed (ADR 0164).
#[derive(Deserialize, Default)]
pub(super) struct Ending {
    #[serde(default)]
    outcome: Option<String>,
}

/// `DELETE /v1/agents/{id}/task/goal`: ends the open goal without it being done;
/// `?outcome=failed` ends it as failed.
pub(super) async fn clear(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(ending): Query<Ending>,
) -> Response {
    let failed = match ending.outcome.as_deref() {
        None | Some("ended") => false,
        Some("failed") => true,
        Some(_) => return problem(StatusCode::BAD_REQUEST, "outcome is ended or failed"),
    };
    match state.engine.end_goal(&id, failed) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => goal_problem(&error),
    }
}
