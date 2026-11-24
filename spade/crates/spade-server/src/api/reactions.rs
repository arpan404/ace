//! Reactions (docs/chat-core.md, Messages, ids and replies): the person puts an emoji on a
//! message, or takes it back. Neither opens nor steers a reply.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::{AppState, problem};
use crate::engine::ReactError;

/// `{emoji}`: the person's reaction.
#[derive(Deserialize)]
pub(super) struct Body {
    emoji: String,
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
