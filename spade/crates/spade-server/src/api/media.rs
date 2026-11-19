//! Documents, images and voice over the API (ADR 0134, docs/media.md): messages with files and
//! a recording, downloads of stored documents and recordings, and transcription.

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::json;
use spade_core::event::{DocumentRef, VoiceRef};

use super::body::Body;
use super::{AppState, problem, send_problem};
use crate::engine::{Outgoing, TranscribeError};
use crate::media::{AttachError, MOST_DOCUMENTS, save_copy};

/// The largest message body: eight 32 MB documents and eight images as base64, and a recording.
pub(super) const MESSAGE_BODY: usize = 400 * 1024 * 1024;
/// The largest transcription body: a 25 MB recording as base64.
const TRANSCRIPTION_BODY: usize = 36 * 1024 * 1024;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/conversations/{id}/messages",
            post(message).layer(DefaultBodyLimit::max(MESSAGE_BODY)),
        )
        .route("/documents/{sha256}", get(document))
        .route("/documents/{sha256}/text", get(document_text))
        .route("/audio/{sha256}", get(audio))
        .route(
            "/transcriptions",
            post(transcription).layer(DefaultBodyLimit::max(TRANSCRIPTION_BODY)),
        )
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    text: String,
    /// Attached images, each as base64 (a `data:` URL is fine). The type is read from the bytes.
    #[serde(default)]
    images: Vec<Upload>,
    /// Attached documents, each named, as base64.
    #[serde(default)]
    files: Vec<FileUpload>,
    #[serde(default)]
    voice: Option<VoiceUpload>,
}

#[derive(Deserialize)]
struct Upload {
    data: String,
}

#[derive(Deserialize)]
struct FileUpload {
    #[serde(default)]
    name: String,
    data: String,
}

#[derive(Deserialize)]
struct VoiceUpload {
    data: String,
    #[serde(default)]
    transcript: String,
}

/// Decodes base64, with or without a `data:` prefix, refusing past `most` bytes before decoding.
fn decode(data: &str, most: usize) -> Result<Vec<u8>, &'static str> {
    let data = match data.split_once(";base64,") {
        Some((prefix, rest)) if prefix.starts_with("data:") => rest,
        _ => data,
    };
    if data.len() / 4 * 3 > most + 3 {
        return Err("too large");
    }
    let bytes = STANDARD
        .decode(data.trim())
        .map_err(|_| "not valid base64")?;
    if bytes.len() > most {
        return Err("too large");
    }
    Ok(bytes)
}

fn bad(text: &str) -> Response {
    problem(StatusCode::BAD_REQUEST, text)
}

async fn message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Message>,
) -> Response {
    if body.files.len() > MOST_DOCUMENTS {
        return bad(&format!(
            "a message can carry at most {MOST_DOCUMENTS} documents"
        ));
    }
    let mut images = Vec::with_capacity(body.images.len());
    for upload in &body.images {
        match crate::images::decode(&upload.data) {
            Ok(bytes) => images.push(bytes),
            Err(error) => return bad(&error.to_string()),
        }
    }
    let voice = match &body.voice {
        Some(voice) => match store_voice(&state, voice) {
            Ok(stored) => Some(stored),
            Err(response) => return *response,
        },
        None => None,
    };
    let text = match &body.voice {
        Some(voice) if body.text.trim().is_empty() => voice.transcript.clone(),
        _ => body.text.clone(),
    };
    if voice.is_some() && text.trim().is_empty() {
        return bad("a voice message needs its transcript");
    }
    let documents = match attach(&state, &id, &body.files).await {
        Ok(documents) => documents,
        Err(response) => return *response,
    };
    let outgoing = Outgoing {
        text,
        images,
        documents,
        voice,
    };
    match state.engine.send_message(&id, outgoing) {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(error) => send_problem(&error),
    }
}

fn store_voice(state: &AppState, voice: &VoiceUpload) -> Result<VoiceRef, Box<Response>> {
    let bytes = decode(&voice.data, crate::media::audio::MOST_AUDIO_BYTES)
        .map_err(|why| Box::new(bad(&format!("the recording is {why}"))))?;
    state
        .engine
        .media()
        .audio
        .put(&bytes)
        .map_err(|error| Box::new(bad(&error.to_string())))
}

/// Reads and stores each file, and copies it into the bot's workspace.
async fn attach(
    state: &AppState,
    conversation: &str,
    files: &[FileUpload],
) -> Result<Vec<DocumentRef>, Box<Response>> {
    let most = spade_docs::Limits::default().file_bytes;
    let mut documents = Vec::with_capacity(files.len());
    for file in files {
        let name = crate::media::documents::file_name(&file.name);
        let bytes = decode(&file.data, most).map_err(|why| {
            let why = if why == "too large" {
                "larger than 32 MB"
            } else {
                why
            };
            Box::new(bad(&format!("{name} is {why}")))
        })?;
        let document = state
            .engine
            .media()
            .attach(&name, bytes.clone())
            .await
            .map_err(|error| {
                let status = match error {
                    AttachError::Read { .. } => StatusCode::BAD_REQUEST,
                    AttachError::Io { .. } => StatusCode::INTERNAL_SERVER_ERROR,
                };
                Box::new(problem(status, &error.to_string()))
            })?;
        copy_to_workspace(state, conversation, &document, bytes).await;
        documents.push(document);
    }
    Ok(documents)
}

/// The bot's own copy of an attached file. A copy that fails is logged, never a failed message:
/// the file is kept in the document store either way.
async fn copy_to_workspace(
    state: &AppState,
    conversation: &str,
    document: &DocumentRef,
    bytes: Vec<u8>,
) {
    let (Some(all), Some(bot)) = (&state.workspaces, state.engine.agent_of(conversation)) else {
        return;
    };
    let Ok(workspace) = all.of(&bot) else {
        return;
    };
    let name = document.name.clone();
    let copied = tokio::task::spawn_blocking(move || save_copy(&workspace, &name, &bytes)).await;
    if let Ok(Err(error)) = copied {
        tracing::warn!(%error, "an attached file was not copied into the bot's workspace");
    }
}

#[derive(Deserialize, Default)]
struct Named {
    #[serde(default)]
    name: Option<String>,
}

async fn document(
    State(state): State<AppState>,
    Path(sha256): Path<String>,
    Query(named): Query<Named>,
) -> Response {
    let Some(bytes) = state.engine.document(&sha256) else {
        return problem(StatusCode::NOT_FOUND, "no such document");
    };
    let name = crate::media::documents::file_name(named.name.as_deref().unwrap_or("document"));
    let media_type = spade_docs::sniff(&bytes, &name)
        .map_or("application/octet-stream", spade_docs::Kind::media_type);
    (
        [
            (header::CONTENT_TYPE, media_type.to_owned()),
            (header::CONTENT_DISPOSITION, disposition(&name)),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".to_owned(),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
        ],
        bytes,
    )
        .into_response()
}

/// `attachment` with the name as plain ASCII and, for any other characters, RFC 5987's form.
fn disposition(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

#[derive(Deserialize, Default)]
struct WindowQuery {
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: Option<usize>,
}

async fn document_text(
    State(state): State<AppState>,
    Path(sha256): Path<String>,
    Query(q): Query<WindowQuery>,
) -> Response {
    let documents = state.engine.media().documents.clone();
    let limit = q.limit.unwrap_or(crate::media::documents::WINDOW_CHARS);
    let window = tokio::task::spawn_blocking(move || documents.window(&sha256, q.offset, limit))
        .await
        .ok()
        .flatten();
    match window {
        Some(window) => Json(json!({
            "text": window.text, "total_chars": window.total_chars,
            "next_offset": window.next_offset,
        }))
        .into_response(),
        None => problem(StatusCode::NOT_FOUND, "no such document"),
    }
}

async fn audio(State(state): State<AppState>, Path(sha256): Path<String>) -> Response {
    match state.engine.media().audio.read(&sha256) {
        Some((bytes, media_type)) => (
            [
                (header::CONTENT_TYPE, media_type),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable",
                ),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        None => problem(StatusCode::NOT_FOUND, "no such recording"),
    }
}

#[derive(Deserialize)]
struct Recording {
    data: String,
}

async fn transcription(State(state): State<AppState>, Body(body): Body<Recording>) -> Response {
    let bytes = match decode(&body.data, crate::media::audio::MOST_AUDIO_BYTES) {
        Ok(bytes) => bytes,
        Err(why) => return bad(&format!("the recording is {why}")),
    };
    match state.engine.transcribe(bytes).await {
        Ok(text) => Json(json!({ "text": text })).into_response(),
        Err(error @ TranscribeError::NotSet) => problem(StatusCode::CONFLICT, &error.to_string()),
        Err(error @ TranscribeError::Audio(_)) => bad(&error.to_string()),
        Err(error @ TranscribeError::Model(_)) => {
            problem(StatusCode::BAD_GATEWAY, &error.to_string())
        }
        Err(error @ TranscribeError::Store(_)) => {
            problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        }
    }
}
