//! Question cards (ADR 0154, docs/questions.md): the person answers, leaves for later or
//! dismisses a bot's `ask_user` card.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{AppState, problem};
use crate::engine::{QuestionError, QuestionReply};

/// `{answers}`, `{defer: true}` or `{dismiss: true}`: exactly one.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Body {
    #[serde(default)]
    answers: Option<Vec<Value>>,
    #[serde(default)]
    defer: bool,
    #[serde(default)]
    dismiss: bool,
}

pub(super) async fn reply(
    State(state): State<AppState>,
    Path((id, call_id)): Path<(String, String)>,
    Json(body): Json<Body>,
) -> Response {
    let reply = match (body.answers, body.defer, body.dismiss) {
        (Some(answers), false, false) => QuestionReply::Answers(answers),
        (None, true, false) => QuestionReply::Defer,
        (None, false, true) => QuestionReply::Dismiss,
        _ => {
            return problem(
                StatusCode::BAD_REQUEST,
                "send one of {\"answers\": [...]}, {\"defer\": true} or {\"dismiss\": true}",
            );
        }
    };
    match state.engine.answer_question(&id, &call_id, reply) {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(QuestionError::NotFound) => problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(error @ QuestionError::NotOpen) => problem(StatusCode::CONFLICT, &error.to_string()),
        Err(QuestionError::Invalid(why)) => problem(StatusCode::BAD_REQUEST, &why),
        Err(QuestionError::Store(error)) => {
            problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        }
    }
}

pub(super) async fn list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.questions_view(&id) {
        Ok(Some(cards)) => {
            let later = cards
                .iter()
                .filter(|c| c.standing == spade_core::question::Standing::Deferred)
                .count();
            Json(json!({ "questions": cards, "for_later": later })).into_response()
        }
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}
