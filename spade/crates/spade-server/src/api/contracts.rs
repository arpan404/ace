//! `/v1/agents/{id}/contracts` (ADR 0200 §7; spade/docs/contracts.md): the contracts a bot's
//! package publishes, and the person's switch for calls to it from their other bots. Nothing here
//! is reached by a bot's tool: a bot can't open itself to calls.

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use serde_json::json;

use super::body::Body;
use super::{AppState, off_thread, problem};
use crate::engine::Engine;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/agents/{id}/contracts", get(read).put(switch))
}

fn shown(engine: &Engine, id: &str) -> Response {
    match engine.store().agent(id) {
        Ok(Some(_)) => Json(json!({
            "contracts": engine.contracts_of(id),
            "incoming": engine.takes_calls(id),
        }))
        .into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such bot"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `GET`: `{contracts: [{name, summary, input, output, effects, examples}], incoming}`.
async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || shown(&state.engine, &id)).await
}

#[derive(Deserialize)]
struct SwitchBody {
    incoming: bool,
}

/// `PUT {incoming}`: the person turns calls to this bot from their other bots on or off.
async fn switch(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<SwitchBody>,
) -> Response {
    off_thread(move || {
        if !matches!(state.engine.store().agent(&id), Ok(Some(_))) {
            return problem(StatusCode::NOT_FOUND, "no such bot");
        }
        match state.engine.set_takes_calls(&id, body.incoming) {
            Ok(()) => shown(&state.engine, &id),
            Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        }
    })
    .await
}
