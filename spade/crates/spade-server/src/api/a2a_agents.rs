//! `/v1/a2a-agents` (ADR 0202 §5): the person's outside A2A agents, added by address like an app.
//! Adding one fetches and checks its Agent Card; the answer says whether its signature holds.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::body::Body;
use super::{AppState, problem};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/a2a-agents", get(list).post(add))
        .route("/a2a-agents/{id}", delete(remove))
}

fn unavailable() -> Response {
    problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "outside agents are not set up here",
    )
}

/// `{agents: [{id, name, address, endpoint, signed, signature, skills}]}`.
async fn list(State(state): State<AppState>) -> Response {
    let Some(agents) = state.engine.outside_agents() else {
        return unavailable();
    };
    let listed: Vec<_> = agents.list().into_iter().map(|a| a.agent).collect();
    Json(json!({ "agents": listed })).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AddBody {
    address: String,
    /// The person says it is on their own machine or network: only then may it be reached at
    /// local or private addresses, or plain http on loopback.
    #[serde(default)]
    local: bool,
}

/// `{address, local?}`: `201 {agent}`, or `400` with why the card can't be used.
async fn add(State(state): State<AppState>, Body(body): Body<AddBody>) -> Response {
    let Some(agents) = state.engine.outside_agents() else {
        return unavailable();
    };
    match agents.add(&body.address, body.local).await {
        Ok(agent) => (StatusCode::CREATED, Json(json!({ "agent": agent }))).into_response(),
        Err(why) => problem(StatusCode::BAD_REQUEST, &why),
    }
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(agents) = state.engine.outside_agents() else {
        return unavailable();
    };
    match agents.remove(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(why) => problem(StatusCode::INTERNAL_SERVER_ERROR, &why),
    }
}
