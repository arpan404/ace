//! Spade's skill store for Settings (ADR 0151): the skills it keeps, and **Add to ace's library**
//! for one written in Spade.

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::json;

use super::{AppState, problem};
use crate::skill_store::{AddError, PublishError};
use crate::tools::WriteError;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/skills", get(list))
        .route("/skills/{id}/add-to-ace", post(add_to_ace))
        .route("/skills/{id}/files", get(files))
}

async fn list(State(state): State<AppState>) -> Response {
    let Some(store) = state.skill_store.clone() else {
        return Json(json!({ "skills": [], "ace": false })).into_response();
    };
    let ace = state.ace.as_ref().is_some_and(|ace| ace.connected());
    let learning = state.learning.clone();
    let read = move || {
        let writers = learning.map(|l| l.writers()).unwrap_or_default();
        store.views().map(|views| {
            views
                .into_iter()
                .map(|view| {
                    let written = writers.get(&view.name).cloned().unwrap_or_default();
                    let mut shown = json!(view);
                    shown["written_by"] = json!(written);
                    shown
                })
                .collect::<Vec<_>>()
        })
    };
    match tokio::task::spawn_blocking(read).await {
        Ok(Ok(skills)) => Json(json!({ "skills": skills, "ace": ace })).into_response(),
        Ok(Err(error)) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error),
        Err(_) => problem(StatusCode::INTERNAL_SERVER_ERROR, "the request stopped"),
    }
}

async fn add_to_ace(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.skill_store.clone() else {
        return problem(StatusCode::NOT_FOUND, "no such skill");
    };
    match store.add_to_ace(&id).await {
        Ok(skill_id) => Json(json!({ "skill_id": skill_id })).into_response(),
        Err(error) => {
            let status = match &error {
                AddError::NotFound => StatusCode::NOT_FOUND,
                AddError::NotSpade => StatusCode::UNPROCESSABLE_ENTITY,
                AddError::AceAway | AddError::Library(WriteError::Unavailable(_)) => {
                    StatusCode::SERVICE_UNAVAILABLE
                }
                AddError::Library(WriteError::Exists(_) | WriteError::Conflict(_)) => {
                    StatusCode::CONFLICT
                }
                AddError::Library(WriteError::Refused(_)) => StatusCode::UNPROCESSABLE_ENTITY,
                AddError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
            };
            let words = match &error {
                AddError::Library(WriteError::Exists(_)) => {
                    "ace's library already has a skill with this name.".to_owned()
                }
                other => other.to_string(),
            };
            problem(status, &words)
        }
    }
}

/// `GET /v1/skills/{id}/files`: a skill written in Spade with all its files, for the daemon to
/// publish to ace's marketplace (ADR 0168). Other origins aren't the person's own to publish.
async fn files(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.skill_store.clone() else {
        return problem(StatusCode::NOT_FOUND, "no such skill");
    };
    match tokio::task::spawn_blocking(move || store.published(&id)).await {
        Ok(Ok(skill)) => Json(skill).into_response(),
        Ok(Err(error)) => {
            let status = match &error {
                PublishError::NotFound => StatusCode::NOT_FOUND,
                PublishError::NotSpade | PublishError::Refused(_) => {
                    StatusCode::UNPROCESSABLE_ENTITY
                }
                PublishError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
            };
            problem(status, &error.to_string())
        }
        Err(_) => problem(StatusCode::INTERNAL_SERVER_ERROR, "the request stopped"),
    }
}
