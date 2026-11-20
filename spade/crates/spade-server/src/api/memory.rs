//! Notes over HTTP (ADR 0128, docs/memory.md): each bot's own under `/agents/{id}/notes`, the
//! shared "About you" set under `/notes`, and any one note by id.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::body::Body;
use super::{AppState, off_thread, problem};
use crate::engine::{NoteError, NoteScope, note_json};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents/{id}/notes", get(list_own).post(add_own))
        .route("/notes", get(list_shared).post(add_shared))
        .route("/notes/{note}", patch(change).delete(forget))
        .route("/notes/{note}/accept", post(accept))
        .route("/notes/{note}/provenance", get(note_provenance))
        .route("/agents/{id}/learned", get(learned))
        .route("/agents/{id}/learned/forget", post(forget_source))
}

/// Where a note came from: its conversation and the message it answered, what was in view, an
/// import, its sources labelled, and when.
async fn note_provenance(State(state): State<AppState>, Path(note): Path<String>) -> Response {
    off_thread(move || match state.engine.note_provenance(&note) {
        Ok(Some(shown)) => Json(shown).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "there is no such note"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    })
    .await
}

/// Every source a bot's notes and knowledge came from, with how many of each.
async fn learned(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || {
        match state.engine.agent_view(&id) {
            Ok(Some(_)) => {}
            Ok(None) => return problem(StatusCode::NOT_FOUND, "there is no such agent"),
            Err(error) => return problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        }
        match state.engine.learned(&id) {
            Ok(sources) => Json(json!({
                "sources": sources.iter().map(|s| json!({
                    "key": s.key, "label": s.label, "notes": s.notes, "entries": s.entries,
                })).collect::<Vec<_>>(),
            }))
            .into_response(),
            Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        }
    })
    .await
}

#[derive(Deserialize)]
struct Forget {
    /// A source key from `GET …/learned`.
    source: String,
}

/// Forgets everything a bot learned from one source; the person's own words stay.
async fn forget_source(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Forget>,
) -> Response {
    off_thread(move || {
        match state.engine.agent_view(&id) {
            Ok(Some(_)) => {}
            Ok(None) => return problem(StatusCode::NOT_FOUND, "there is no such agent"),
            Err(error) => return problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        }
        match state.engine.forget_source(&id, body.source.trim()) {
            Ok(gone) => {
                Json(json!({ "notes": gone.notes, "entries": gone.entries })).into_response()
            }
            Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        }
    })
    .await
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

#[derive(Deserialize)]
struct Change {
    text: String,
    /// The `updated_at` of the version the edit started from.
    #[serde(default)]
    updated_at: Option<i64>,
}

fn note_problem(error: &NoteError) -> Response {
    let status = match error {
        NoteError::NotFound | NoteError::NoAgent => StatusCode::NOT_FOUND,
        NoteError::Invalid => StatusCode::BAD_REQUEST,
        NoteError::Full => StatusCode::CONFLICT,
        NoteError::Moved(note) => {
            let body = json!({ "error": error.to_string(), "note": note_json(note) });
            return (StatusCode::CONFLICT, Json(body)).into_response();
        }
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
        Ok((note, true)) => (StatusCode::CREATED, Json(note_json(&note))).into_response(),
        Ok((note, false)) => Json(note_json(&note)).into_response(),
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
    Body(body): Body<Change>,
) -> Response {
    match state.engine.change_note(&note, &body.text, body.updated_at) {
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

async fn accept(State(state): State<AppState>, Path(note): Path<String>) -> Response {
    match state.engine.accept_note(&note) {
        Ok(note) => Json(note_json(&note)).into_response(),
        Err(error) => note_problem(&error),
    }
}
