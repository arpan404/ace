//! Moving a bot to another of the person's machines, and where Spade lives (ADR 0187,
//! docs/agents.md "Moving a bot").

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use super::body::Body;
use super::{AppState, problem};
use crate::engine::{AcceptFor, HostRecord, MoveError};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/main/host", put(offer_host))
        .route("/agents/{id}/move", get(read).post(start).delete(cancel))
        .route("/agents/{id}/arrival", delete(dismiss_arrival))
        .route("/moves/{id}/accept", put(accept))
}

/// `GET /v1/main`, beside `PUT /v1/main` in the agents routes.
pub(super) async fn main_state(State(state): State<AppState>) -> Response {
    match state.engine.main_json() {
        Ok(main) => Json(main).into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// Keeps a newer host record; answers the one held after.
async fn offer_host(State(state): State<AppState>, Body(body): Body<Value>) -> Response {
    let Some(record) = HostRecord::parse(&body) else {
        return problem(
            StatusCode::BAD_REQUEST,
            "a host record is {host, version, at, by}",
        );
    };
    match state.engine.offer_host(&record) {
        Ok(held) => Json(json!({ "host": held.to_json() })).into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

fn move_problem(error: &MoveError) -> Response {
    let status = match error {
        MoveError::NotFound => StatusCode::NOT_FOUND,
        MoveError::Refused(_) => StatusCode::CONFLICT,
        MoveError::Invalid(_) => StatusCode::BAD_REQUEST,
        MoveError::PersonOnly(_) => StatusCode::FORBIDDEN,
        MoveError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

#[derive(Deserialize)]
struct To {
    to: String,
    /// The move's id, as the person accepted it on the machine it goes to.
    #[serde(rename = "move")]
    id: String,
}

/// The person accepts, here, this move as it names it (the bot, the machines, the manifest's
/// hash, what it replaces): only with their stamp over all of it, which ace's daemon adds for a
/// caller with their standing (ADR 0163 amendment 2, ADR 0187).
async fn accept(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Body(body): Body<AcceptFor>,
) -> Response {
    let stamp = headers
        .get(crate::security::attest::HEADER)
        .and_then(|value| value.to_str().ok());
    match state.engine.accept_move(&id, &body, stamp) {
        Ok(()) => Json(json!({ "accepted": true })).into_response(),
        Err(error) => move_problem(&error),
    }
}

async fn start(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<To>,
) -> Response {
    let connectors = state.connectors.clone();
    match state
        .engine
        .start_move(&id, body.to.trim(), body.id.trim(), connectors.as_deref())
        .await
    {
        Ok(started) => (StatusCode::ACCEPTED, Json(json!({ "move": started }))).into_response(),
        Err(error) => move_problem(&error),
    }
}

async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    Json(json!({
        "move": state.engine.move_view(&id),
        "arrival": state.engine.arrival_view(&id),
    }))
    .into_response()
}

/// Cancels a move still sending, or dismisses one that ended.
async fn cancel(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.cancel_move(&id) {
        Ok(shown) => Json(json!({ "move": shown })).into_response(),
        Err(error) => move_problem(&error),
    }
}

async fn dismiss_arrival(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.dismiss_arrival(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}
