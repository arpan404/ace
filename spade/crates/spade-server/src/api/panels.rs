//! Panels (ADR 0200 §5.2): a packaged bot's panels for its conversation, a panel's page by its
//! hash, and an action sent from one.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::event::PanelSender;

use super::body::Body;
use super::{AppState, off_thread, problem};
use crate::engine::PanelError;

fn refused(error: &PanelError) -> Response {
    match error {
        PanelError::NotFound => problem(StatusCode::NOT_FOUND, "no such conversation"),
        PanelError::Refused(spade_core::panel::Refused::NoPanel) => {
            problem(StatusCode::NOT_FOUND, "no such panel")
        }
        PanelError::Refused(_) => problem(StatusCode::BAD_REQUEST, &error.to_string()),
        PanelError::Store(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `GET /v1/conversations/{id}/panels`: `{panels: [{id, title, page, actions, state}]}`.
pub(super) async fn list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || match state.engine.panels(&id) {
        Ok(panels) => Json(json!({ "panels": panels })).into_response(),
        Err(error) => refused(&error),
    })
    .await
}

/// `GET /v1/panels/pages/{hash}`: a page's text. Clients build the sandboxed document from it
/// (ADR 0077), so it is served as text and never as a page of its own.
pub(super) async fn page(State(state): State<AppState>, Path(hash): Path<String>) -> Response {
    off_thread(
        move || match crate::packages::panels::page(&state.engine, &hash) {
            Some(text) => (
                [
                    (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
                    (
                        header::CACHE_CONTROL,
                        "private, max-age=31536000, immutable",
                    ),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                ],
                text,
            )
                .into_response(),
            None => problem(StatusCode::NOT_FOUND, "no such page"),
        },
    )
    .await
}

/// `{key, action, value?, confirmed?}`: the request's own key, so one sent twice lands once.
/// `confirmed` is the client's word that the person pressed Confirm on the line it drew outside
/// the page (ADR 0200 §5.2, amendment 1); a page can't reach this API, only its host can.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ActionBody {
    key: String,
    action: String,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    confirmed: bool,
}

/// `POST /v1/conversations/{id}/panels/{surface}/actions`: an action sent from a panel, checked
/// against its declaration before it reaches the bot: as its page's, or the person's once they
/// confirmed it.
pub(super) async fn act(
    State(state): State<AppState>,
    Path((id, surface)): Path<(String, String)>,
    Body(body): Body<ActionBody>,
) -> Response {
    let key_ok = !body.key.is_empty()
        && body.key.len() <= 80
        && body
            .key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !key_ok {
        return problem(StatusCode::BAD_REQUEST, "a key is a short id");
    }
    let by = if body.confirmed {
        PanelSender::Person
    } else {
        PanelSender::Page
    };
    off_thread(move || {
        match state
            .engine
            .act_on_panel(&id, &surface, &body.key, &body.action, body.value, by)
        {
            Ok(()) => StatusCode::ACCEPTED.into_response(),
            Err(error) => refused(&error),
        }
    })
    .await
}
