//! Cards (ADR 0200 §5.1): the person presses a choice on a bot's card.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::{AppState, problem};
use crate::engine::CardError;

/// `{action, version}`: the choice pressed, on the version of the card the person saw.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Body {
    action: String,
    version: u32,
}

pub(super) async fn choose(
    State(state): State<AppState>,
    Path((id, card)): Path<(String, String)>,
    Json(body): Json<Body>,
) -> Response {
    match state
        .engine
        .choose_on_card(&id, &card, body.version, &body.action)
    {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(CardError::NotFound) => problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(CardError::Refused(spade_core::card::Refused::NoCard)) => {
            problem(StatusCode::NOT_FOUND, "no such card")
        }
        Err(error @ CardError::Refused(_)) => problem(StatusCode::CONFLICT, &error.to_string()),
        Err(CardError::Store(error)) => {
            problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        }
    }
}
