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
use crate::workspace::{PathError, Workspace};

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

/// What the person changed: each path and how (`changed`, `new`, `removed`).
pub(super) type Changed = Vec<(String, &'static str)>;

/// Runs the person's file change off the async threads, holding the workspace's file lock
/// through the checks (mode, stopping, revision), the change and its record, so no bot file tool
/// lands between them (ADR 0143).
pub(super) async fn person_files(
    state: &AppState,
    id: &str,
    workspace: Workspace,
    work: impl FnOnce(&Workspace) -> Result<Changed, PathError> + Send + 'static,
) -> Response {
    let computers = state.engine.computers().cloned();
    let id = id.to_owned();
    let done = tokio::task::spawn_blocking(move || {
        let Some(computers) = computers else {
            return Err("this Spade has no computers");
        };
        workspace.changing(|| {
            let result = computers.person_file_write(&id, || work(&workspace));
            if let Ok(Ok(changed)) = &result {
                computers.person_changed(&id, changed);
            }
            result
        })
    })
    .await;
    match done {
        Ok(Ok(Ok(_))) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(Err(error))) => super::workspace::path_problem(&error),
        Ok(Err(error)) => problem(StatusCode::CONFLICT, error),
        Err(_) => problem(StatusCode::INTERNAL_SERVER_ERROR, "the request stopped"),
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
    person_files(&state, &id, workspace, move |workspace| {
        let path = workspace.normal(&path)?;
        workspace.check_base(&path, base.as_deref())?;
        let how = if workspace.revision(&path).ok().flatten().is_some() {
            "changed"
        } else {
            "new"
        };
        workspace.write_bytes(&path, &bytes, LARGEST_UPLOAD)?;
        workspace.trust().record_person(&path, &bytes);
        Ok(vec![(path, how)])
    })
    .await
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
    person_files(&state, &id, workspace, move |workspace| {
        Ok(vec![(workspace.mkdir(&at.path)?, "new")])
    })
    .await
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
    person_files(&state, &id, workspace, move |workspace| {
        workspace.check_base(&workspace.normal(&body.from)?, body.base.as_deref())?;
        let (from, to) = workspace.rename(&body.from, &body.to)?;
        workspace.trust().moved(&from, &to);
        Ok(vec![(from, "removed"), (to, "new")])
    })
    .await
}
