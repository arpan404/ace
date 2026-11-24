//! Reactions (docs/chat-core.md, Messages, ids and replies): the person puts an emoji on a
//! message, or takes it back. Neither opens nor steers a reply.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::{AppState, problem};
use crate::engine::ReactError;

/// `{emoji}`: the person's reaction.
#[derive(Deserialize)]
pub(super) struct Body {
    emoji: String,
}

/// `GET /v1/conversations/{id}/reactions`: standing reactions per message as `{ emoji, by[] }`.
pub(super) async fn list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.reactions_summary(&id) {
        Ok(Some(reactions)) => Json(json!({ "reactions": reactions })).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `GET /v1/conversations/{id}/messages/{message}/reactions`: standing reactions on one message.
pub(super) async fn for_message(
    State(state): State<AppState>,
    Path((id, message)): Path<(String, String)>,
) -> Response {
    match state.engine.message_reactions(&id, &message) {
        Ok(reactions) => Json(json!({ "reactions": reactions })).into_response(),
        Err(error @ (ReactError::NotFound | ReactError::NoMessage)) => {
            problem(StatusCode::NOT_FOUND, &error.to_string())
        }
        Err(error @ ReactError::Emoji) => problem(StatusCode::BAD_REQUEST, &error.to_string()),
        Err(ReactError::Store(error)) => {
            problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        }
    }
}

/// `POST /v1/conversations/{id}/messages/{message}/reactions`.
pub(super) async fn react(
    State(state): State<AppState>,
    Path((id, message)): Path<(String, String)>,
    Json(body): Json<Body>,
) -> Response {
    answer(state.engine.react(&id, &message, &body.emoji))
}

/// `DELETE /v1/conversations/{id}/messages/{message}/reactions`.
pub(super) async fn take_back(
    State(state): State<AppState>,
    Path((id, message)): Path<(String, String)>,
) -> Response {
    answer(state.engine.take_back_reaction(&id, &message))
}

fn answer(result: Result<(), ReactError>) -> Response {
    match result {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(error @ (ReactError::NotFound | ReactError::NoMessage)) => {
            problem(StatusCode::NOT_FOUND, &error.to_string())
        }
        Err(error @ ReactError::Emoji) => problem(StatusCode::BAD_REQUEST, &error.to_string()),
        Err(ReactError::Store(error)) => {
            problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        }
    }
}
