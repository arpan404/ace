//! A bot's tree of workers (ADR 0161): the tree with each node's state, progress, cost, budget
//! and needs-you, and a worker's budget, which the person sets.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::{AppState, problem};

/// `GET /v1/agents/{id}/tree`: `{tree: Node}`.
pub(super) async fn tree(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.agent_tree(&id) {
        Ok(Some(tree)) => Json(tree).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `{budget_usd}`: dollars, or `null` to take the budget away.
#[derive(Deserialize)]
pub(super) struct BudgetBody {
    budget_usd: Option<f64>,
}

/// `PUT /v1/agents/{id}/budget`: sets a worker's subtree budget. `409` for a bot that is no
/// worker.
pub(super) async fn budget(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<BudgetBody>,
) -> Response {
    let micros = match body.budget_usd {
        None => None,
        Some(usd) if usd.is_finite() && usd > 0.0 => Some(spade_core::spending::usd_to_micros(usd)),
        Some(_) => {
            return problem(
                StatusCode::BAD_REQUEST,
                "budget_usd is a positive amount of dollars, or null",
            );
        }
    };
    match state.engine.set_agent_budget(&id, micros) {
        Ok(Some(true)) => match state.engine.agent_tree(&id) {
            Ok(Some(tree)) => Json(tree).into_response(),
            _ => Json(json!({})).into_response(),
        },
        Ok(Some(false)) => problem(
            StatusCode::CONFLICT,
            "this bot is no worker; only a worker has a budget",
        ),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}
