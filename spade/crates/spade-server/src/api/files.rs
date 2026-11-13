//! The person's changes to a bot's files (ADR 0142, ADR 0143, docs/computer.md): write, upload,
//! make a folder, move. In cowork they need no take-over: a write carries the revision the person
//! opened (`base`) and is refused `409 changed` when the file moved on since. Confined like every workspace operation. What the person writes is theirs, so
//! it is trusted (ADR 0130's allowlist records it); a move keeps what was trusted trusted.

use axum::Router;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{post, put};
use base64::Engine as _;
use serde::Deserialize;

use super::AppState;
use super::body::Body;
use super::problem;
use super::workspace::workspace_of;
use crate::workspace::PathError;

/// Largest file the person writes or uploads at once.
pub const LARGEST_UPLOAD: usize = 32 * 1024 * 1024;
/// Room for that as base64 in JSON.
const BODY_LIMIT: usize = LARGEST_UPLOAD / 3 * 4 + 64 * 1024;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/agents/{id}/files",
            put(write).layer(DefaultBodyLimit::max(BODY_LIMIT)),
        )
        .route(
            "/agents/{id}/files/upload",
            post(upload).layer(DefaultBodyLimit::max(BODY_LIMIT)),
        )
        .route("/agents/{id}/files/mkdir", post(mkdir))
        .route("/agents/{id}/files/move", post(rename))
}

#[derive(Deserialize, Default)]
struct At {
    #[serde(default)]
    path: String,
}

/// `{"text"}` or `{"data_b64"}`, with `base`: the revision the person opened.
#[derive(Deserialize)]
struct Content {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    data_b64: Option<String>,
    #[serde(default)]
    base: Option<String>,
}

impl Content {
    fn bytes(self) -> Result<Vec<u8>, Box<Response>> {
        match (self.text, self.data_b64) {
            (Some(text), None) => Ok(text.into_bytes()),
            (None, Some(data)) => decode(&data),
            _ => Err(Box::new(problem(
                StatusCode::BAD_REQUEST,
                "send the file as text or as data_b64",
            ))),
        }
    }
}

fn decode(data: &str) -> Result<Vec<u8>, Box<Response>> {
    base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| Box::new(problem(StatusCode::BAD_REQUEST, "data_b64 is not base64")))
}

fn too_large() -> Response {
    problem(
        StatusCode::PAYLOAD_TOO_LARGE,
        "files are written 32 MiB at most",
    )
}

/// Runs the check and mutation together off the async threads.
pub(super) async fn person_files<T: Send + 'static>(
    state: &AppState,
    id: &str,
    work: impl FnOnce() -> Result<T, PathError> + Send + 'static,
) -> Result<T, Box<Response>> {
    let computers = state.engine.computers().cloned();
    let id = id.to_owned();
    match tokio::task::spawn_blocking(move || {
        let Some(computers) = computers else {
            return Err("this Spade has no computers");
        };
        computers.person_file_write(&id, work)
    })
    .await
    {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(error))) => Err(Box::new(super::workspace::path_problem(&error))),
        Ok(Err(error)) => Err(Box::new(problem(StatusCode::CONFLICT, error))),
        Err(_) => Err(Box::new(problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            "the request stopped",
        ))),
    }
}

/// Writes `bytes` at `path` as the person's, then tells the bot's computer. With `base`, only
/// while the file is still that revision (`409 changed` otherwise, and nothing is written).
async fn person_writes(
    state: AppState,
    id: String,
    path: String,
    bytes: Vec<u8>,
    base: Option<String>,
) -> Response {
    if bytes.len() > LARGEST_UPLOAD {
        return too_large();
    }
    let workspace = match workspace_of(&state, &id) {
        Ok(workspace) => workspace,
        Err(response) => return *response,
    };
    let written = person_files(&state, &id, move || {
        let path = workspace.normal(&path)?;
        workspace.check_base(&path, base.as_deref())?;
        let how = if workspace.revision(&path).ok().flatten().is_some() {
            "changed"
        } else {
            "new"
        };
        workspace.write_bytes(&path, &bytes, LARGEST_UPLOAD)?;
        workspace.trust().record_person(&path, &bytes);
        Ok((path, how))
    })
    .await;
    match written {
        Ok((path, how)) => {
            if let Some(computers) = state.engine.computers() {
                computers.person_changed(&id, &[(path, how)]);
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Err(response) => *response,
    }
}

async fn write(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(at): Query<At>,
    Body(body): Body<Content>,
) -> Response {
    let base = body.base.clone();
    match body.bytes() {
        Ok(bytes) => person_writes(state, id, at.path, bytes, base).await,
        Err(response) => *response,
    }
}

#[derive(Deserialize)]
struct Upload {
    path: String,
    data_b64: String,
    #[serde(default)]
    base: Option<String>,
}

async fn upload(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Upload>,
) -> Response {
    match decode(&body.data_b64) {
        Ok(bytes) => person_writes(state, id, body.path, bytes, body.base).await,
        Err(response) => *response,
    }
}

async fn mkdir(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(at): Body<At>,
) -> Response {
    let workspace = match workspace_of(&state, &id) {
        Ok(workspace) => workspace,
        Err(response) => return *response,
    };
    match person_files(&state, &id, move || workspace.mkdir(&at.path)).await {
        Ok(path) => {
            if let Some(computers) = state.engine.computers() {
                computers.person_changed(&id, &[(path, "new")]);
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Err(response) => *response,
    }
}

#[derive(Deserialize)]
struct Move {
    from: String,
    to: String,
    /// The revision of the file at `from` the person saw (files only).
    #[serde(default)]
    base: Option<String>,
}

async fn rename(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Move>,
) -> Response {
    let workspace = match workspace_of(&state, &id) {
        Ok(workspace) => workspace,
        Err(response) => return *response,
    };
    let moved = person_files(&state, &id, move || {
        workspace.check_base(&workspace.normal(&body.from)?, body.base.as_deref())?;
        let (from, to) = workspace.rename(&body.from, &body.to)?;
        workspace.trust().moved(&from, &to);
        Ok::<_, PathError>((from, to))
    })
    .await;
    match moved {
        Ok((from, to)) => {
            if let Some(computers) = state.engine.computers() {
                computers.person_changed(&id, &[(from, "removed"), (to, "new")]);
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Err(response) => *response,
    }
}
