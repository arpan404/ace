//! A bot's computer for the app (ADR 0142, docs/computer.md): what it shows, taking it over and
//! handing it back, ace's reports on the browser and screen, and the live terminal.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use base64::Engine as _;
use futures_util::{Stream, StreamExt, stream};
use serde::Deserialize;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;

use super::body::Body;
use super::workspace::known;
use super::{AppState, Closing, off_thread, problem};
use crate::computer::terminal::Frame;
use crate::computer::{Computers, Driver, Kind, Report};
use crate::engine::TakeOverError;

/// Largest piece of input the person types (or pastes) at once.
const LARGEST_INPUT: usize = 64 * 1024;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents/{id}/computer", get(view))
        .route("/agents/{id}/computer/take-over", post(take_over))
        .route("/agents/{id}/computer/hand-back", post(hand_back))
        .route("/agents/{id}/computer/surfaces/{kind}", put(report))
        .route("/agents/{id}/terminal/live", get(terminal_live))
        .route("/agents/{id}/terminal/input", post(input))
        .route("/agents/{id}/terminal/resize", post(resize))
}

/// The computers, or the problem to answer: `404` for an unknown agent, `503` when this Spade
/// keeps none.
pub(super) fn computers_of(state: &AppState, id: &str) -> Result<Arc<Computers>, Box<Response>> {
    known(state, id)?;
    state.engine.computers().cloned().ok_or_else(|| {
        Box::new(problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "this Spade has no computers",
        ))
    })
}

async fn view(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match computers_of(&state, &id) {
        Ok(computers) => Json(computers.view(&id)).into_response(),
        Err(response) => *response,
    }
}

fn takeover_problem(error: &TakeOverError) -> Response {
    let status = match error {
        TakeOverError::NotFound => StatusCode::NOT_FOUND,
        TakeOverError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        TakeOverError::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

/// Spade pauses the bot first, then ace hands the person its browser and screen.
async fn take_over(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let engine = state.engine.clone();
    let agent = id.clone();
    let response = off_thread(move || match engine.take_over(&agent) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => takeover_problem(&error),
    })
    .await;
    if response.status() == StatusCode::NO_CONTENT
        && let Some(computers) = state.engine.computers()
    {
        computers.ace_takes_over(&id).await;
    }
    response
}

/// ace hands the browser and screen back first and says what the person did there; then Spade
/// stores the note and the bot carries on.
async fn hand_back(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let handback = match state.engine.computers() {
        Some(computers) if computers.driver(&id) == Driver::Person => {
            computers.ace_hands_back(&id).await
        }
        _ => None,
    };
    off_thread(
        move || match state.engine.hand_back(&id, handback.as_ref()) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => takeover_problem(&error),
        },
    )
    .await
}

/// ace reports the bot's browser or screen: `{"live", "title"?, "url"?, "person_acted"?}`.
async fn report(
    State(state): State<AppState>,
    Path((id, kind)): Path<(String, String)>,
    Body(body): Body<Report>,
) -> Response {
    let kind = match kind.as_str() {
        "browser" => Kind::Browser,
        "screen" => Kind::Screen,
        _ => {
            return problem(
                StatusCode::NOT_FOUND,
                "ace reports only the browser and the screen",
            );
        }
    };
    let computers = match computers_of(&state, &id) {
        Ok(computers) => computers,
        Err(response) => return *response,
    };
    off_thread(move || match computers.report(&id, kind, body) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    })
    .await
}

#[derive(Deserialize, Default)]
struct After {
    #[serde(default)]
    after: u64,
}

fn frame_event(frame: &Frame) -> SseEvent {
    match frame {
        Frame::Output { seq, data } => SseEvent::default().event("output").data(
            json!({ "seq": seq, "data_b64": base64::engine::general_purpose::STANDARD.encode(data) })
                .to_string(),
        ),
        Frame::Resize { cols, rows } => SseEvent::default()
            .event("resize")
            .data(json!({ "cols": cols, "rows": rows }).to_string()),
        Frame::Exit { code } => SseEvent::default()
            .event("exit")
            .data(json!({ "code": code }).to_string()),
    }
}

/// The terminal live: `resize` with its size, the output kept after `after`, then what follows.
/// Starts the terminal when it is not running.
async fn terminal_live(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<After>,
    closing: Option<Extension<Closing>>,
) -> Response {
    let computers = match computers_of(&state, &id) {
        Ok(computers) => computers,
        Err(response) => return *response,
    };
    let attached = computers
        .terminals()
        .of(&id)
        .and_then(|terminal| terminal.attach(q.after));
    let (backlog, frames) = match attached {
        Ok(attached) => attached,
        Err(error) => return problem(StatusCode::SERVICE_UNAVAILABLE, &error),
    };
    let last = backlog
        .iter()
        .filter_map(|f| match f {
            Frame::Output { seq, .. } => Some(*seq),
            _ => None,
        })
        .max()
        .unwrap_or(q.after);
    let first: Vec<SseEvent> = backlog.iter().map(frame_event).collect();
    let live = BroadcastStream::new(frames)
        // A viewer that falls behind is closed; it comes back with its last seq.
        .take_while(|item| std::future::ready(item.is_ok()))
        .scan(last, |last, item| {
            let event = match item {
                Ok(Frame::Output { seq, .. }) if seq <= *last => None,
                Ok(frame) => {
                    if let Frame::Output { seq, .. } = &frame {
                        *last = *seq;
                    }
                    Some(frame_event(&frame))
                }
                Err(_) => None,
            };
            std::future::ready(Some(event))
        })
        .filter_map(std::future::ready);
    let closed = async move {
        match closing {
            Some(Extension(Closing(mut rx))) => {
                let _ = rx.wait_for(|closing| *closing).await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    let all: std::pin::Pin<Box<dyn Stream<Item = Result<SseEvent, Infallible>> + Send>> =
        Box::pin(stream::iter(first).chain(live).take_until(closed).map(Ok));
    Sse::new(all)
        .keep_alive(KeepAlive::default())
        .into_response()
}

#[derive(Deserialize)]
struct Input {
    data_b64: String,
}

/// The person types into the terminal: only while they have the computer (`409` otherwise),
/// so nothing the person types is ever mixed into the bot's command.
async fn input(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Input>,
) -> Response {
    let computers = match computers_of(&state, &id) {
        Ok(computers) => computers,
        Err(response) => return *response,
    };
    if computers.driver(&id) != Driver::Person {
        return problem(
            StatusCode::CONFLICT,
            "take over the bot's computer before typing in its terminal",
        );
    }
    let Ok(data) = base64::engine::general_purpose::STANDARD.decode(body.data_b64.as_bytes())
    else {
        return problem(StatusCode::BAD_REQUEST, "data_b64 is not base64");
    };
    if data.len() > LARGEST_INPUT {
        return problem(
            StatusCode::PAYLOAD_TOO_LARGE,
            "send the input in smaller pieces (64 KiB at most)",
        );
    }
    let terminal = match computers.terminals().of(&id) {
        Ok(terminal) => terminal,
        Err(error) => return problem(StatusCode::SERVICE_UNAVAILABLE, &error),
    };
    match terminal.input(data).await {
        Ok(entered) => {
            let _ =
                tokio::task::spawn_blocking(move || computers.person_entered(&id, entered)).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error),
    }
}

#[derive(Deserialize)]
struct Size {
    cols: u16,
    rows: u16,
}

async fn resize(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Size>,
) -> Response {
    let computers = match computers_of(&state, &id) {
        Ok(computers) => computers,
        Err(response) => return *response,
    };
    match computers
        .terminals()
        .of(&id)
        .and_then(|terminal| terminal.resize(body.cols, body.rows))
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error),
    }
}
