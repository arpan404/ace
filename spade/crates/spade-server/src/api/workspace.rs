//! A bot's workspace and skill proposals for the app (ADR 0130, docs/workspace.md): list, open,
//! download and delete files; list proposals and answer them.

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::json;

use super::body::Body;
use super::{AppState, problem};
use crate::learning::AnswerError;
use crate::tools::WriteError;
use crate::workspace::{PathError, Workspace};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents/{id}/workspace", get(list).delete(delete))
        .route("/agents/{id}/workspace/file", get(open))
        .route("/agents/{id}/workspace/download", get(download))
        .route("/agents/{id}/skill-proposals", get(proposals))
        .route("/agents/{id}/skill-proposals/{proposal}", post(answer))
}

#[derive(Deserialize, Default)]
struct At {
    #[serde(default)]
    path: String,
    /// The revision the person opened (delete only): refused with `409 changed` if it moved on.
    #[serde(default)]
    base: Option<String>,
}

/// The agent's workspace, or the problem to answer: `404` for an unknown agent, `503` when this
/// Spade keeps no workspaces.
pub(super) fn workspace_of(state: &AppState, id: &str) -> Result<Workspace, Box<Response>> {
    let Some(all) = &state.workspaces else {
        return Err(Box::new(problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "this Spade keeps no workspaces",
        )));
    };
    known(state, id)?;
    all.of(id)
        .map_err(|error| Box::new(problem(StatusCode::NOT_FOUND, &error.to_string())))
}

pub(super) fn known(state: &AppState, id: &str) -> Result<(), Box<Response>> {
    match state.engine.agent_view(id) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(Box::new(problem(StatusCode::NOT_FOUND, "no such agent"))),
        Err(error) => Err(Box::new(problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            &error.to_string(),
        ))),
    }
}

pub(super) fn path_problem(error: &PathError) -> Response {
    if let PathError::Changed(revision) = error {
        // `error` is the code the app reads; `revision` is the file's now, for "Reload".
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "changed",
                "code": "changed",
                "message": "The file changed since you opened it.",
                "revision": revision,
            })),
        )
            .into_response();
    }
    let status = match error {
        PathError::Missing(_) => StatusCode::NOT_FOUND,
        PathError::Exists(_) => StatusCode::CONFLICT,
        PathError::Absolute(_)
        | PathError::Parent
        | PathError::Outside(_)
        | PathError::Unusable(_) => StatusCode::BAD_REQUEST,
        PathError::Io(_) => StatusCode::UNPROCESSABLE_ENTITY,
        PathError::Changed(_) => StatusCode::CONFLICT,
    };
    problem(status, &error.to_string())
}

/// Runs file work off the async threads.
pub(super) async fn files<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, PathError> + Send + 'static,
) -> Result<T, Box<Response>> {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(Box::new(path_problem(&error))),
        Err(_) => Err(Box::new(problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            "the request stopped",
        ))),
    }
}

async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(at): Query<At>,
) -> Response {
    let workspace = match workspace_of(&state, &id) {
        Ok(workspace) => workspace,
        Err(response) => return *response,
    };
    match files(move || workspace.list(&at.path)).await {
        Ok(listing) => Json(listing).into_response(),
        Err(response) => *response,
    }
}

async fn open(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(at): Query<At>,
) -> Response {
    let workspace = match workspace_of(&state, &id) {
        Ok(workspace) => workspace,
        Err(response) => return *response,
    };
    match files(move || workspace.open(&at.path)).await {
        Ok(view) => Json(view).into_response(),
        Err(response) => *response,
    }
}

async fn download(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(at): Query<At>,
) -> Response {
    let workspace = match workspace_of(&state, &id) {
        Ok(workspace) => workspace,
        Err(response) => return *response,
    };
    match files(move || workspace.bytes(&at.path)).await {
        Ok(bytes) => (
            [
                (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
                (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Err(response) => *response,
    }
}

async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(at): Query<At>,
) -> Response {
    let workspace = match workspace_of(&state, &id) {
        Ok(workspace) => workspace,
        Err(response) => return *response,
    };
    super::files::person_files(&state, &id, workspace, move |workspace| {
        let path = workspace.normal(&at.path)?;
        workspace.check_base(&path, at.base.as_deref())?;
        workspace.delete(&path)?;
        Ok(vec![(path, "removed")])
    })
    .await
}

async fn proposals(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if let Err(response) = known(&state, &id) {
        return *response;
    }
    let Some(learning) = state.learning.clone() else {
        return Json(json!({ "proposals": [] })).into_response();
    };
    match tokio::task::spawn_blocking(move || learning.proposals(&id)).await {
        Ok(proposals) => Json(json!({ "proposals": proposals })).into_response(),
        Err(_) => problem(StatusCode::INTERNAL_SERVER_ERROR, "the request stopped"),
    }
}

#[derive(Deserialize)]
struct Answer {
    save: bool,
}

async fn answer(
    State(state): State<AppState>,
    Path((id, proposal)): Path<(String, String)>,
    Body(body): Body<Answer>,
) -> Response {
    if let Err(response) = known(&state, &id) {
        return *response;
    }
    let Some(learning) = state.learning.clone() else {
        return problem(StatusCode::NOT_FOUND, "no such proposal");
    };
    match learning.answer(&id, &proposal, body.save).await {
        Ok(proposal) => Json(json!({ "proposal": proposal })).into_response(),
        Err(error) => {
            let status = match &error {
                AnswerError::NotFound => StatusCode::NOT_FOUND,
                AnswerError::Answered | AnswerError::Busy | AnswerError::Unconfirmed(_) => {
                    StatusCode::CONFLICT
                }
                AnswerError::Library(WriteError::Conflict(_) | WriteError::Exists(_)) => {
                    StatusCode::CONFLICT
                }
                AnswerError::Library(WriteError::Unavailable(_)) => StatusCode::SERVICE_UNAVAILABLE,
                AnswerError::Library(WriteError::Refused(_)) => StatusCode::UNPROCESSABLE_ENTITY,
                AnswerError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
            };
            let words = match &error {
                AnswerError::Library(WriteError::Conflict(_)) => {
                    "The skill changed since this was proposed. Ask the bot to propose it again."
                        .to_owned()
                }
                AnswerError::Library(WriteError::Exists(_)) => {
                    "A skill with this name was added since. Ask the bot to propose an edit of it."
                        .to_owned()
                }
                other => other.to_string(),
            };
            problem(status, &words)
        }
    }
}
