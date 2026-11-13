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

fn endpoint_json(view: &EndpointView, in_keychain: Option<bool>) -> Value {
    let e = &view.stored;
    let (key_set, source) = key_source(in_keychain, e.key_env.as_deref());
    json!({
        "id": e.id,
        "name": e.name,
        "format": e.format,
        "base_url": e.base_url,
        "session_header": e.session_header,
        "header_names": e.headers.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>(),
        "needs_key": e.needs_key,
        "key_set": key_set,
        "key_source": source,
        "models": view.models.iter().map(|(model, source)| json!({
            "id": model.id,
            "name": model.name,
            "context": model.context,
            "capabilities": model.capabilities.iter().map(|c| c.name()).collect::<Vec<_>>(),
            "source": source,
        })).collect::<Vec<_>>(),
    })
}

/// One endpoint, as `/v1/models` lists it.
fn one_endpoint(state: &AppState, view: &EndpointView) -> Value {
    let known = in_keychain(state, std::slice::from_ref(view));
    endpoint_json(view, known.first().copied().flatten())
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
        "endpoints": views.iter().zip(&known).map(|(v, k)| endpoint_json(v, *k)).collect::<Vec<_>>(),
        // Some keys' keychain reads are still waiting (a prompt): asked again, they may be known.
        "character_avatars": true,
        "keys_pending": known.iter().any(Option::is_none),
        "presets": presets,
        "fast_model": fast,
        "transcription_model": engine.transcription_model().ok().flatten(),
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
    if let Some(model) = body.transcription_model
        && let Err(error) = state.engine.set_transcription_model(model.as_deref())
    {
        return problem(StatusCode::BAD_REQUEST, &error.to_string());
    }
    StatusCode::NO_CONTENT.into_response()
}
