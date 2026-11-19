//! A bot's tree of workers (ADR 0161): the tree with each node's state, progress, cost and
//! needs-you. Workers have no budgets (ADR 0166).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::{AppState, problem};

/// `GET /v1/agents/{id}/tree`: `{tree: Node}`.
pub(super) async fn tree(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.agent_tree(&id) {
        Ok(Some(tree)) => Json(tree).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}
