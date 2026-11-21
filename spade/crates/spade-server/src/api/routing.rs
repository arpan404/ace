//! Model roles over HTTP (ADR 0162): the person's global and per-bot choices, each role's model
//! and what each role spent. Each role is a route (ADR 0205 §2): models in order.

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use super::body::{Body, present};
use super::{AppState, off_thread, problem};
use crate::engine::{OversightError, RolesChange};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/models/roles", get(global).put(change_global))
        .route("/agents/{id}/models", get(agent).put(change_agent))
}

/// A change: each role named maps to its route (a list of models in order, or one model), or
/// `null` (or `[]`) to clear it. `main`'s route is what the bot's own model falls back to.
#[derive(Deserialize)]
struct Change {
    #[serde(default)]
    roles: BTreeMap<String, Option<spade_core::routing::Route>>,
    #[serde(default, deserialize_with = "present")]
    allowed: Option<Option<Vec<String>>>,
    #[serde(default, deserialize_with = "present")]
    escalate: Option<Option<bool>>,
}

impl Change {
    fn into_change(self) -> RolesChange {
        RolesChange {
            roles: self.roles,
            allowed: self.allowed,
            escalate: self.escalate,
        }
    }
}

fn answer(result: Result<Value, OversightError>) -> Response {
    match result {
        Ok(view) => Json(view).into_response(),
        Err(error) => {
            let status = match error {
                OversightError::NotFound => StatusCode::NOT_FOUND,
                OversightError::Invalid(_) => StatusCode::BAD_REQUEST,
                OversightError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
            };
            problem(status, &error.to_string())
        }
    }
}

async fn global(State(state): State<AppState>) -> Response {
    off_thread(move || answer(state.engine.global_roles_view().map_err(Into::into))).await
}

async fn change_global(State(state): State<AppState>, Body(body): Body<Change>) -> Response {
    off_thread(move || answer(state.engine.set_global_roles(body.into_change()))).await
}

async fn agent(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || {
        answer(match state.engine.agent_roles_view(&id) {
            Ok(Some(view)) => Ok(view),
            Ok(None) => Err(OversightError::NotFound),
            Err(error) => Err(error.into()),
        })
    })
    .await
}

async fn change_agent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Change>,
) -> Response {
    off_thread(move || answer(state.engine.set_agent_roles(&id, body.into_change()))).await
}

/// Activity entries with the role each cost was for (ADR 0162).
pub(super) fn entries_with_roles(entries: &[spade_core::activity::Entry]) -> Vec<Value> {
    entries
        .iter()
        .map(|entry| {
            let mut value = json!(entry);
            if let (Some(role), Some(object)) =
                (crate::engine::entry_role(entry), value.as_object_mut())
            {
                object.insert("role".to_owned(), json!(role));
            }
            value
        })
        .collect()
}
