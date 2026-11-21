//! `/v1/models`, `/v1/endpoints` and `/v1/settings` (docs/agents.md). Header values and keys are
//! never sent back: an endpoint shows only its header names and where its key comes from.

use std::collections::BTreeMap;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::body::{Body, present};
use super::{AppState, off_thread, problem};
use crate::engine::{EndpointError, EndpointInput, EndpointView, ModelInput};

#[derive(Deserialize)]
pub(super) struct EndpointBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    headers: Option<BTreeMap<String, String>>,
    #[serde(default, deserialize_with = "present")]
    session_header: Option<Option<String>>,
    /// Whether calls need a key; true unless said otherwise (a local server needs none).
    #[serde(default)]
    needs_key: Option<bool>,
    #[serde(default)]
    preset: Option<String>,
}

impl EndpointBody {
    fn input(self) -> EndpointInput {
        EndpointInput {
            name: self.name,
            format: self.format,
            base_url: self.base_url,
            headers: self.headers.map(|h| h.into_iter().collect()),
            session_header: self.session_header,
            needs_key: self.needs_key,
            preset: self.preset,
        }
    }
}

#[derive(Deserialize)]
pub(super) struct ModelBody {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context: Option<u64>,
    #[serde(default)]
    capabilities: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub(super) struct ModelId {
    id: String,
}

#[derive(Deserialize)]
pub(super) struct Settings {
    #[serde(default, deserialize_with = "present")]
    fast_model: Option<Option<String>>,
    /// The model that transcribes voice (ADR 0134).
    #[serde(default, deserialize_with = "present")]
    transcription_model: Option<Option<String>>,
    /// The model that reads replies aloud (ADR 0134, amended).
    #[serde(default, deserialize_with = "present")]
    speech_model: Option<Option<String>>,
    /// The model new bots start on; `null` goes back to the first usable model.
    #[serde(default, deserialize_with = "present")]
    new_bot_model: Option<Option<String>>,
}

/// How long a list of endpoints waits for the keychain before answering without it: long enough
/// for a read with no prompt, short enough that an open prompt never holds the list up.
const KEYCHAIN_WAIT: Duration = Duration::from_millis(150);

/// Whether the keychain holds each endpoint's key: `None` while its read is still waiting (a
/// keychain prompt nobody answered yet).
fn in_keychain(state: &AppState, views: &[EndpointView]) -> Vec<Option<bool>> {
    let ids: Vec<&str> = views.iter().map(|v| v.stored.id.as_str()).collect();
    match &state.keys {
        Some(keys) => keys.has_within(&ids, KEYCHAIN_WAIT),
        None => vec![Some(false); ids.len()],
    }
}

/// Where the endpoint's key comes from, if it has one: the keychain wins, as in every call.
/// `(key_set, key_source)`, each null while the keychain hasn't answered and it matters.
fn key_source(in_keychain: Option<bool>, env: Option<&str>) -> (Value, Value) {
    let in_env = env.is_some_and(|var| std::env::var(var).is_ok_and(|v| !v.trim().is_empty()));
    match (in_keychain, in_env) {
        (Some(true), _) => (json!(true), json!("keychain")),
        (Some(false), true) => (json!(true), json!("environment")),
        (Some(false), false) => (json!(false), Value::Null),
        // A key either way; which one wins waits on the keychain.
        (None, true) => (json!(true), Value::Null),
        (None, false) => (Value::Null, Value::Null),
    }
}

fn endpoint_json(state: &AppState, view: &EndpointView, in_keychain: Option<bool>) -> Value {
    let e = &view.stored;
    let (key_set, source) = key_source(in_keychain, e.key_env.as_deref());
    let local = spade_models::base_url::is_loopback(&e.base_url);
    let engine = &state.engine;
    // On this computer, what Spade's own checks found and whether ace measured its family
    // (ADR 0205 §3); `null` for any other endpoint.
    let checks = |id: &str| local.then(|| engine.probe_view(&format!("{}/{id}", e.id)));
    let known = |id: &str| {
        local
            .then(|| engine.known_good(id))
            .flatten()
            .map(|f| json!({ "name": f.name, "passed": f.passed, "cases": f.cases, "checked": f.checked }))
    };
    json!({
        "id": e.id,
        "name": e.name,
        "format": e.format,
        "base_url": e.base_url,
        // On this computer: offered before any other (ADR 0205 §1).
        "local": local,
        "session_header": e.session_header,
        "header_names": e.headers.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>(),
        "needs_key": e.needs_key,
        "key_set": key_set,
        "key_source": source,
        // Only stated facts: `null` where nobody said, never Spade's own guess.
        "models": view.models.iter().map(|shown| json!({
            "id": shown.model.id,
            "name": shown.model.name,
            "context": shown.context,
            "capabilities": shown.capabilities.as_ref()
                .map(|all| all.iter().map(|c| c.name()).collect::<Vec<_>>()),
            "source": shown.source,
            "probes": checks(&shown.model.id),
            "known_good": known(&shown.model.id),
        })).collect::<Vec<_>>(),
    })
}

/// One endpoint, as `/v1/models` lists it.
fn one_endpoint(state: &AppState, view: &EndpointView) -> Value {
    let known = in_keychain(state, std::slice::from_ref(view));
    endpoint_json(state, view, known.first().copied().flatten())
}

fn endpoint_problem(error: &EndpointError) -> Response {
    match error {
        EndpointError::InUse(names) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": error.to_string(), "agents": names })),
        )
            .into_response(),
        EndpointError::NotFound => problem(StatusCode::NOT_FOUND, &error.to_string()),
        EndpointError::Invalid(_) | EndpointError::MissingKey(_) => {
            problem(StatusCode::BAD_REQUEST, &error.to_string())
        }
        EndpointError::Conflict(_) => problem(StatusCode::CONFLICT, &error.to_string()),
        EndpointError::Keychain(_) => problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string()),
        EndpointError::Listing(_) => problem(StatusCode::BAD_GATEWAY, &error.to_string()),
        EndpointError::Store(spade_store::StoreError::Exists(_)) => {
            problem(StatusCode::CONFLICT, "an endpoint with that id exists")
        }
        EndpointError::Store(_) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

pub(super) async fn models(State(state): State<AppState>) -> Response {
    off_thread(move || models_now(&state)).await
}

/// Reads where each key comes from (waiting briefly on the keychain), so it runs off the async
/// workers.
fn models_now(state: &AppState) -> Response {
    let engine = &state.engine;
    let (views, fast) = match (engine.endpoint_views(), engine.fast_model()) {
        (Ok(views), Ok(fast)) => (views, fast),
        (Err(error), _) | (_, Err(error)) => {
            return problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
        }
    };
    let presets: Vec<Value> = engine
        .models()
        .catalog()
        .endpoints()
        .iter()
        .map(|p| {
            json!({
                "id": p.id, "name": p.name, "format": p.format.name(), "base_url": p.base_url,
                "key_env": p.key_env, "session_header": p.session_header,
            })
        })
        .collect();
    let known = in_keychain(state, &views);
    Json(json!({
        "endpoints": views.iter().zip(&known).map(|(v, k)| endpoint_json(state, v, *k)).collect::<Vec<_>>(),
        // Some keys' keychain reads are still waiting (a prompt): asked again, they may be known.
        "character_avatars": true,
        "keys_pending": known.iter().any(Option::is_none),
        "presets": presets,
        "fast_model": fast,
        "transcription_model": engine.transcription_model().ok().flatten(),
        "speech_model": engine.speech_model().ok().flatten(),
        "new_bot_model": engine.new_bot_model().ok().flatten(),
        "keychain": state.keys.is_some(),
        "starting": engine.starting().is_some(),
        "starting_reason": engine.starting(),
    }))
    .into_response()
}

pub(super) async fn create(
    State(state): State<AppState>,
    Body(body): Body<EndpointBody>,
) -> Response {
    off_thread(move || match state.engine.create_endpoint(body.input()) {
        Ok(view) => (
            StatusCode::CREATED,
            Json(json!({ "endpoint": one_endpoint(&state, &view) })),
        )
            .into_response(),
        Err(error) => endpoint_problem(&error),
    })
    .await
}

pub(super) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<EndpointBody>,
) -> Response {
    if body.preset.is_some() {
        return problem(
            StatusCode::BAD_REQUEST,
            "a preset applies only when adding an endpoint",
        );
    }
    off_thread(
        move || match state.engine.update_endpoint(&id, body.input()) {
            Ok(view) => Json(json!({ "endpoint": one_endpoint(&state, &view) })).into_response(),
            Err(error) => endpoint_problem(&error),
        },
    )
    .await
}

/// Deletes an endpoint no agent uses, its key in the keychain first.
pub(super) async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || match state.engine.delete_endpoint(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => endpoint_problem(&error),
    })
    .await
}

/// The endpoint's own model list, live.
pub(super) async fn live(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.list_endpoint_models(&id).await {
        Ok(listed) => {
            let models: Vec<Value> = listed
                .iter()
                .map(|m| {
                    let mut out = json!({ "id": m.id });
                    if let Some(name) = &m.name {
                        out["name"] = json!(name);
                    }
                    if let Some(context) = m.context {
                        out["context"] = json!(context);
                    }
                    if let Some(capabilities) = &m.capabilities {
                        out["capabilities"] =
                            json!(capabilities.iter().map(|c| c.name()).collect::<Vec<_>>());
                    }
                    out
                })
                .collect();
            Json(json!({ "models": models })).into_response()
        }
        Err(error) => endpoint_problem(&error),
    }
}

pub(super) async fn save_model(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<ModelBody>,
) -> Response {
    let input = ModelInput {
        id: body.id,
        name: body.name,
        context: body.context,
        capabilities: body.capabilities,
    };
    off_thread(move || match state.engine.save_model(&id, input) {
        Ok(view) => Json(json!({ "endpoint": one_endpoint(&state, &view) })).into_response(),
        Err(error) => endpoint_problem(&error),
    })
    .await
}

pub(super) async fn delete_model(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(model): Query<ModelId>,
) -> Response {
    match state.engine.delete_model(&id, &model.id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => problem(StatusCode::NOT_FOUND, "that model is not saved"),
        Err(error) => endpoint_problem(&error),
    }
}

pub(super) async fn settings(
    State(state): State<AppState>,
    Body(body): Body<Settings>,
) -> Response {
    if let Some(fast) = body.fast_model
        && let Err(error) = state.engine.set_fast_model(fast.as_deref())
    {
        return endpoint_problem(&error);
    }
    if let Some(model) = body.new_bot_model
        && let Err(error) = state.engine.set_new_bot_model(model.as_deref())
    {
        return endpoint_problem(&error);
    }
    if let Some(model) = body.transcription_model
        && let Err(error) = state.engine.set_transcription_model(model.as_deref())
    {
        return problem(StatusCode::BAD_REQUEST, &error.to_string());
    }
    if let Some(model) = body.speech_model
        && let Err(error) = state.engine.set_speech_model(model.as_deref())
    {
        return problem(StatusCode::BAD_REQUEST, &error.to_string());
    }
    StatusCode::NO_CONTENT.into_response()
}

/// Model servers on this computer (Ollama, LM Studio): whether each runs, its models, and the
/// endpoint already added for it.
pub(super) async fn local(State(state): State<AppState>) -> Response {
    let servers: Vec<Value> = state
        .engine
        .local_servers()
        .await
        .into_iter()
        .map(|s| {
            json!({
                "id": s.server.id, "name": s.server.name, "base_url": s.server.base_url,
                "running": s.running, "models": s.models, "endpoint": s.endpoint,
            })
        })
        .collect();
    Json(json!({ "servers": servers })).into_response()
}

#[derive(Deserialize)]
pub(super) struct LocalModel {
    model: String,
}

/// Uses one of a local server's models: its endpoint added the first time, the model saved.
pub(super) async fn use_local(
    State(state): State<AppState>,
    Path(server): Path<String>,
    Body(body): Body<LocalModel>,
) -> Response {
    off_thread(
        move || match state.engine.use_local_model(&server, &body.model) {
            Ok((_, value)) => {
                // Its three checks start now; the answer shows them running.
                state.engine.start_probe(&value);
                let endpoint = value.split_once('/').map_or("", |(e, _)| e);
                let views = state.engine.endpoint_views().unwrap_or_default();
                let Some(view) = views.iter().find(|v| v.stored.id == endpoint) else {
                    return problem(StatusCode::NOT_FOUND, "the endpoint is gone");
                };
                Json(json!({
                    "endpoint": one_endpoint(&state, view),
                    "value": value,
                }))
                .into_response()
            }
            Err(error) => endpoint_problem(&error),
        },
    )
    .await
}

/// Runs a local model's three checks again (ADR 0205 §3): `202` once they start, `409` while
/// they already run, `400` for a model not on this computer, whose checks would cost money.
pub(super) async fn probe(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<ModelId>,
) -> Response {
    let reference = format!("{id}/{}", body.id.trim());
    if state.engine.models_endpoint(&id).is_none() {
        return problem(StatusCode::NOT_FOUND, "no such endpoint");
    }
    if !state.engine.is_local(&reference) {
        return problem(
            StatusCode::BAD_REQUEST,
            "only a model on this computer is checked; its checks cost nothing there",
        );
    }
    if !state.engine.start_probe(&reference) {
        return problem(StatusCode::CONFLICT, "its checks are already running");
    }
    (
        StatusCode::ACCEPTED,
        Json(json!({ "probes": state.engine.probe_view(&reference) })),
    )
        .into_response()
}

// `/endpoints/local` also names the local-server routes, and a static path wins over
// `/endpoints/{id}`, so an endpoint whose id is `local` (one named "Local") is reached here.
const LOCAL: &str = "local";

pub(super) async fn update_local(state: State<AppState>, body: Body<EndpointBody>) -> Response {
    update(state, Path(LOCAL.to_owned()), body).await
}

pub(super) async fn delete_local(state: State<AppState>) -> Response {
    delete(state, Path(LOCAL.to_owned())).await
}

pub(super) async fn live_local(state: State<AppState>) -> Response {
    live(state, Path(LOCAL.to_owned())).await
}

pub(super) async fn save_local_model(state: State<AppState>, body: Body<ModelBody>) -> Response {
    save_model(state, Path(LOCAL.to_owned()), body).await
}

pub(super) async fn delete_local_model(state: State<AppState>, model: Query<ModelId>) -> Response {
    delete_model(state, Path(LOCAL.to_owned()), model).await
}

pub(super) async fn probe_local(state: State<AppState>, body: Body<ModelId>) -> Response {
    probe(state, Path(LOCAL.to_owned()), body).await
}
