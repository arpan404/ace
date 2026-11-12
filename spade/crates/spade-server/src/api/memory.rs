//! Notes over HTTP (ADR 0128, docs/memory.md): each bot's own under `/agents/{id}/notes`, the
//! shared "About you" set under `/notes`, and any one note by id.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::body::Body;
use super::{AppState, problem};
use crate::engine::{NoteError, NoteScope, note_json};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents/{id}/notes", get(list_own).post(add_own))
        .route("/notes", get(list_shared).post(add_shared))
        .route("/notes/{note}", patch(change).delete(forget))
}

#[derive(Deserialize, Default)]
struct Search {
    #[serde(default)]
    q: Option<String>,
}

#[derive(Deserialize)]
struct Text {
    text: String,
}

fn note_problem(error: &NoteError) -> Response {
    let status = match error {
        NoteError::NotFound | NoteError::NoAgent => StatusCode::NOT_FOUND,
        NoteError::Invalid => StatusCode::BAD_REQUEST,
        NoteError::Full => StatusCode::CONFLICT,
        NoteError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

fn list(state: &AppState, scope: &NoteScope, search: &Search) -> Response {
    match state.engine.notes(scope, search.q.as_deref()) {
        Ok(notes) => Json(json!({ "notes": notes.iter().map(note_json).collect::<Vec<_>>() }))
            .into_response(),
        Err(error) => note_problem(&error),
    }
}

fn add(state: &AppState, scope: &NoteScope, text: &str) -> Response {
    match state.engine.add_note(scope, text) {
        Ok(note) => (StatusCode::CREATED, Json(note_json(&note))).into_response(),
        Err(error) => note_problem(&error),
    }
}

async fn list_own(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(search): Query<Search>,
) -> Response {
    list(&state, &NoteScope::Agent(id), &search)
}

async fn add_own(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Text>,
) -> Response {
    add(&state, &NoteScope::Agent(id), &body.text)
}

async fn list_shared(State(state): State<AppState>, Query(search): Query<Search>) -> Response {
    list(&state, &NoteScope::Shared, &search)
}

async fn add_shared(State(state): State<AppState>, Body(body): Body<Text>) -> Response {
    add(&state, &NoteScope::Shared, &body.text)
}

async fn change(
    State(state): State<AppState>,
    Path(note): Path<String>,
    Body(body): Body<Text>,
) -> Response {
    match state.engine.change_note(&note, &body.text) {
        Ok(note) => Json(note_json(&note)).into_response(),
        Err(error) => note_problem(&error),
    }
}

async fn forget(State(state): State<AppState>, Path(note): Path<String>) -> Response {
    match state.engine.forget_note(&note) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => note_problem(&error),
    }
}
