//! Spade's local HTTP API (docs/chat-core.md, docs/agents.md). Every `/v1` request carries the
//! bearer token from Spade's data folder; keys go in and never come back out.

mod agents;
mod body;
mod connectors;
mod endpoints;
mod media;
mod memory;
mod routines;
mod workspace;

use std::convert::Infallible;
use std::sync::Arc;

use axum::Extension;
use axum::extract::DefaultBodyLimit;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::{Stream, StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_keys::KeyStore;
use spade_store::StoredEvent;
use tokio::sync::watch;
use tokio_stream::wrappers::BroadcastStream;

use crate::engine::{AnswerError, CompactError, Engine, Frame, MaintenanceState, SendError};
use crate::tools::{AceLink, GrantError};

/// Set when the server begins shutting down, so live streams end and shutdown is not held up.
#[derive(Clone)]
pub struct Closing(pub watch::Receiver<bool>);

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<Engine>,
    pub token: Arc<str>,
    /// The OS keychain, when this machine has one.
    pub keys: Option<KeyStore>,
    /// The connection to ace, when Spade knows where ace lives.
    pub ace: Option<Arc<AceLink>>,
    /// Each bot's workspace folder (ADR 0130).
    pub workspaces: Option<crate::workspace::Workspaces>,
    /// Skill proposals and notes, when Spade has a skill library.
    pub learning: Option<Arc<crate::learning::Learning>>,
    /// The person's connected apps (ADR 0131).
    pub connectors: Option<Arc<spade_connect::Connectors>>,
}

pub fn router(state: AppState) -> Router {
    let v1 = Router::new()
        .route("/conversations", get(list).post(no_new_chats))
        .route(
            "/agents",
            get(agents::list)
                .post(agents::create)
                .layer(DefaultBodyLimit::max(agents::AGENT_BODY)),
        )
        .route(
            "/agents/{id}",
            axum::routing::patch(agents::update)
                .delete(agents::delete)
                .layer(DefaultBodyLimit::max(agents::AGENT_BODY)),
        )
        .route("/main", put(agents::set_main))
        .route("/endpoints", post(endpoints::create))
        .route(
            "/endpoints/{id}",
            axum::routing::patch(endpoints::update).delete(endpoints::delete),
        )
        .route(
            "/endpoints/{id}/models",
            get(endpoints::live)
                .post(endpoints::save_model)
                .delete(endpoints::delete_model),
        )
        .route("/settings", put(endpoints::settings))
        .route(
            "/agents/{id}/routines",
            get(routines::list).post(routines::create),
        )
        .route(
            "/agents/{id}/heartbeat",
            get(routines::heartbeat).put(routines::set_heartbeat),
        )
        .route(
            "/routines/{id}",
            get(routines::get)
                .patch(routines::update)
                .delete(routines::delete),
        )
        .route("/routines/{id}/run", post(routines::run))
        .route("/conversations/{id}/events", get(events))
        .route("/conversations/{id}/stop", post(stop))
        .route("/conversations/{id}/approvals/{call_id}", post(approve))
        .route("/conversations/{id}/live", get(live))
        .route("/conversations/{id}/compact", post(compact))
        .route("/models", get(endpoints::models))
        .route("/images/{sha256}", get(image))
        .route("/keys/{endpoint}", put(set_key).delete(delete_key))
        .route("/ace", get(ace_state).put(set_grant).delete(forget_grant))
        .route(
            "/maintenance",
            get(maintenance_state)
                .post(begin_maintenance)
                .delete(end_maintenance),
        )
        .merge(connectors::routes())
        .merge(memory::routes())
        .merge(workspace::routes())
        .merge(media::routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize))
        .with_state(state.clone());
    let open = Router::new()
        .route("/health", get(health))
        .merge(connectors::callback_route())
        .with_state(state);
    Router::new()
        .merge(open)
        .nest("/v1", v1)
        .fallback(|| async { problem(StatusCode::NOT_FOUND, "not found") })
}

#[derive(Deserialize, Default)]
struct Challenge {
    #[serde(default)]
    nonce: Option<String>,
}

/// Open without a token, so the daemon and updater can tell Spade is up and which API it speaks.
/// With `?nonce=`, it also proves it holds the token file's token (see `proof`), so nobody sends a
/// secret to a process that merely took Spade's old port.
async fn health(State(state): State<AppState>, Query(challenge): Query<Challenge>) -> Response {
    let mut body = json!({
        "ok": true,
        "version": crate::home::VERSION,
        "api": crate::home::API_VERSION,
        // Setup that reads keys runs after Spade listens; until it is done, why not.
        "starting": state.engine.starting().is_some(),
        "starting_reason": state.engine.starting(),
    });
    if let Some(nonce) = challenge.nonce {
        match crate::proof::answer(&state.token, &nonce) {
            Some(proof) => body["proof"] = Value::String(proof),
            None => {
                return problem(
                    StatusCode::BAD_REQUEST,
                    "nonce must be 16 to 64 hex characters",
                );
            }
        }
    }
    Json(body).into_response()
}

async fn authorize(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let expected = format!("Bearer {}", state.token);
    let given = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let token = given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;
    // A routine's webhook carries the routine's own secret, which its route checks.
    if !token
        && request.method() == axum::http::Method::POST
        && routines::is_run_route(request.uri().path())
        && let Some(secret) = given.strip_prefix("Bearer ")
    {
        let secret = routines::WebhookBearer(secret.to_owned());
        request.extensions_mut().insert(secret);
        return next.run(request).await;
    }
    if token {
        next.run(request).await
    } else {
        problem(StatusCode::UNAUTHORIZED, "missing or wrong token")
    }
}

/// Runs `work` on the blocking pool. Anything that may read the keychain goes through here: a
/// read can block for as long as a prompt waits, and must never hold up an async worker.
pub(super) async fn off_thread(work: impl FnOnce() -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| problem(StatusCode::INTERNAL_SERVER_ERROR, "the request stopped"))
}

pub(super) fn problem(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn stored(event: &StoredEvent) -> Value {
    json!({ "seq": event.seq, "at": event.at_ms, "event": event.event.to_json() })
}

pub(super) fn send_problem(error: &SendError) -> Response {
    let status = match error {
        SendError::NotFound => StatusCode::NOT_FOUND,
        SendError::Disabled => StatusCode::CONFLICT,
        SendError::Empty
        | SendError::TooLong
        | SendError::TooManyImages
        | SendError::TooManyDocuments
        | SendError::Image(_) => StatusCode::BAD_REQUEST,
        SendError::OverCap => StatusCode::PAYMENT_REQUIRED,
        SendError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

async fn list(State(state): State<AppState>) -> Response {
    match state.engine.conversations() {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|(c, activity)| {
                    json!({ "id": c.id, "title": c.title, "updated_at": c.updated_ms,
                            "answering": activity.answering, "jobs": activity.jobs,
                            "waiting_on_you": activity.waiting_on_you })
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// There is no "new chat" (ADR 0126): each agent has one conversation, created with it.
async fn no_new_chats() -> Response {
    problem(
        StatusCode::GONE,
        "conversations are created with their agent: POST /v1/agents",
    )
}

#[derive(Deserialize)]
struct After {
    #[serde(default)]
    after: i64,
    /// At most this many events; page with `after` set to the last `seq` received.
    #[serde(default)]
    limit: Option<usize>,
}

async fn events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<After>,
) -> Response {
    match state.engine.events(&id, q.after) {
        Ok(Some(events)) => {
            let shown = q.limit.map_or(events.len(), |limit| limit.max(1));
            Json(events.iter().take(shown).map(stored).collect::<Vec<_>>()).into_response()
        }
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

async fn stop(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.stop(&id) {
        Ok(true) => StatusCode::ACCEPTED.into_response(),
        Ok(false) => problem(StatusCode::NOT_FOUND, "nothing is answering"),
        Err(error) => problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("stopped, but the stop could not be saved yet ({error}); Spade keeps trying"),
        ),
    }
}

#[derive(Deserialize, Default)]
struct Focus {
    #[serde(default)]
    focus: Option<String>,
}

async fn compact(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<Focus>>,
) -> Response {
    let focus = body.map(|Json(b)| b).unwrap_or_default().focus;
    match state.engine.compact(&id, focus.as_deref()).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(CompactError::NotFound) => problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(error @ (CompactError::Busy | CompactError::Nothing)) => {
            problem(StatusCode::CONFLICT, &error.to_string())
        }
        Err(error @ CompactError::OverCap) => {
            problem(StatusCode::PAYMENT_REQUIRED, &error.to_string())
        }
        Err(CompactError::Failed(error)) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

#[derive(Deserialize)]
struct Approval {
    allowed: bool,
    #[serde(default)]
    always: bool,
}

async fn approve(
    State(state): State<AppState>,
    Path((id, call_id)): Path<(String, String)>,
    Json(body): Json<Approval>,
) -> Response {
    match state
        .engine
        .answer(&id, &call_id, body.allowed, body.always)
    {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(AnswerError::NotFound) => problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(AnswerError::NotAwaiting) => problem(
            StatusCode::CONFLICT,
            "that call is not waiting for an answer",
        ),
        Err(AnswerError::Store(error)) => {
            problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        }
    }
}

async fn live(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<After>,
    closing: Option<Extension<Closing>>,
) -> Response {
    let subscription = match state.engine.subscribe(&id, q.after) {
        Ok(Some(subscription)) => subscription,
        Ok(None) => return problem(StatusCode::NOT_FOUND, "no such conversation"),
        Err(error) => return problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    let last = subscription.backlog.last().map_or(q.after, |e| e.seq);
    let mut first: Vec<SseEvent> = subscription
        .backlog
        .iter()
        .map(|e| {
            SseEvent::default()
                .event("stored")
                .data(stored(e).to_string())
        })
        .collect();
    if let Some(snapshot) = subscription.snapshot {
        first.push(
            SseEvent::default()
                .event("snapshot")
                .data(json!({ "reply": snapshot.reply, "text": snapshot.text }).to_string()),
        );
    }
    // Everything stored so far has been sent; what follows is new.
    first.push(
        SseEvent::default()
            .event("caught_up")
            .data(json!({ "seq": last }).to_string()),
    );
    first.push(status_event(
        subscription.state,
        subscription.status.as_deref(),
    ));
    let frames = BroadcastStream::new(subscription.frames)
        // A subscriber that falls behind is closed; it reconnects with its last seq.
        .take_while(|item| std::future::ready(item.is_ok()))
        .scan(last, |last, item| {
            let event = match item {
                Ok(Frame::Stored(e)) if e.seq > *last => {
                    *last = e.seq;
                    Some(
                        SseEvent::default()
                            .event("stored")
                            .data(stored(&e).to_string()),
                    )
                }
                Ok(Frame::Delta { reply, text }) => Some(
                    SseEvent::default()
                        .event("delta")
                        .data(json!({ "reply": reply, "text": text }).to_string()),
                ),
                Ok(Frame::Status { state, status }) => Some(status_event(state, status.as_deref())),
                _ => None,
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
        Box::pin(stream::iter(first).chain(frames).take_until(closed).map(Ok));
    Sse::new(all)
        .keep_alive(KeepAlive::default())
        .into_response()
}

async fn image(State(state): State<AppState>, Path(sha256): Path<String>) -> Response {
    match state.engine.image(&sha256) {
        Some((bytes, media_type)) => (
            [
                (axum::http::header::CONTENT_TYPE, media_type),
                (
                    axum::http::header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable",
                ),
                (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        None => problem(StatusCode::NOT_FOUND, "no such image"),
    }
}

/// What the agent is doing now: `{"state","status"}`. Older clients ignore the event.
fn status_event(state: crate::engine::State, status: Option<&str>) -> SseEvent {
    SseEvent::default()
        .event("status")
        .data(json!({ "state": state.name(), "status": status }).to_string())
}

#[derive(Deserialize)]
struct Key {
    key: String,
}

async fn set_key(
    State(state): State<AppState>,
    Path(endpoint): Path<String>,
    Json(body): Json<Key>,
) -> Response {
    let Some(keys) = state.keys else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "this machine has no keychain; set the endpoint's environment variable",
        );
    };
    off_thread(move || match keys.set(&endpoint, &body.key) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(spade_keys::KeyError::Invalid(why)) => problem(StatusCode::BAD_REQUEST, why),
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string()),
    })
    .await
}

async fn delete_key(State(state): State<AppState>, Path(endpoint): Path<String>) -> Response {
    let Some(keys) = state.keys else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "this machine has no keychain",
        );
    };
    off_thread(move || match keys.delete(&endpoint) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => problem(StatusCode::NOT_FOUND, "no key stored for that endpoint"),
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string()),
    })
    .await
}

fn maintenance_json(state: MaintenanceState) -> Value {
    json!({
        "admission": if state.admission_open { "open" } else { "closed" },
        "running_turns": state.running_turns,
        "running_jobs": state.running_jobs,
    })
}

async fn maintenance_state(State(state): State<AppState>) -> Response {
    Json(maintenance_json(state.engine.maintenance_state())).into_response()
}

#[derive(Deserialize)]
struct Maintenance {
    mode: String,
    #[serde(default)]
    deadline_ms: Option<u64>,
}

/// Closes admission for an update (docs/ace-integration.md, "Updates"). Answers at once; the
/// updater polls `GET /v1/maintenance` until no turn (and, for `idle`, no job) is running.
async fn begin_maintenance(
    State(state): State<AppState>,
    Json(body): Json<Maintenance>,
) -> Response {
    let Some(mode) = spade_core::maintenance::Mode::parse(&body.mode) else {
        return problem(StatusCode::BAD_REQUEST, "mode must be \"idle\" or \"now\"");
    };
    let deadline = body.deadline_ms.map(std::time::Duration::from_millis);
    state.engine.begin_maintenance(mode, deadline);
    (
        StatusCode::ACCEPTED,
        Json(maintenance_json(state.engine.maintenance_state())),
    )
        .into_response()
}

/// Reopens admission: an aborted update. Paused turns carry on.
async fn end_maintenance(State(state): State<AppState>) -> Response {
    state.engine.end_maintenance();
    Json(maintenance_json(state.engine.maintenance_state())).into_response()
}

/// Whether Spade holds a grant for ace and is connected; never the grant itself.
async fn ace_state(State(state): State<AppState>) -> Response {
    let (grant, connected) = match state.ace.as_ref() {
        // The stored grant is read in the background at start; answer once it has been.
        Some(ace) => (
            ace.holds_grant(std::time::Duration::from_secs(3)).await,
            ace.connected(),
        ),
        None => (false, false),
    };
    Json(json!({ "grant": grant, "connected": connected })).into_response()
}

#[derive(Deserialize)]
struct Grant {
    grant: String,
}

/// The daemon hands over Spade's grant: kept in the keychain, used at once.
async fn set_grant(State(state): State<AppState>, Json(body): Json<Grant>) -> Response {
    let Some(ace) = state.ace else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "Spade was started without SPADE_ACE_HOME, so it does not know where ace is",
        );
    };
    // Kept in the keychain, which can block: off the async workers.
    off_thread(move || match ace.set_grant(&body.grant) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error @ GrantError::Empty) => problem(StatusCode::BAD_REQUEST, &error.to_string()),
        Err(GrantError::Keychain(spade_keys::KeyError::Invalid(why))) => {
            problem(StatusCode::BAD_REQUEST, why)
        }
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string()),
    })
    .await
}

/// Forgets the grant and disconnects from ace.
async fn forget_grant(State(state): State<AppState>) -> Response {
    let Some(ace) = state.ace else {
        return StatusCode::NO_CONTENT.into_response();
    };
    off_thread(move || match ace.forget_grant() {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string()),
    })
    .await
}
