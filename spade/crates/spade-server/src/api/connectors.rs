//! `/v1/connectors` and `/v1/agents/{id}/connectors` (spade/docs/connectors.md, ADR 0131). The
//! sign-in callback is the one open route: the person's browser comes back to it, and the
//! `state` it carries is the check. No answer ever carries a token.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_connect::{Access, Callback, ConnectError, ConnectRequest, Connectors, Started};

use super::body::Body;
use super::{AppState, problem};

/// The routes behind the bearer token.
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/connectors", get(list).post(connect))
        .route("/connectors/{id}", get(one).delete(disconnect))
        .route("/connectors/{id}/connect", post(reconnect))
        .route("/agents/{id}/connectors", get(allowed).put(set_allowed))
}

/// The sign-in callbacks, open (the browser cannot carry Spade's token): each connector's own,
/// and the shared one sign-ins as Spade's client ID metadata document come back to.
pub(super) fn callback_route() -> Router<AppState> {
    Router::new()
        .route(
            &format!("{}/{{connector}}", spade_connect::CALLBACK_PATH),
            get(callback),
        )
        .route(spade_connect::CALLBACK_PATH, get(shared_callback))
}

fn hub(state: &AppState) -> Result<Arc<Connectors>, Box<Response>> {
    state.connectors.clone().ok_or_else(|| {
        Box::new(problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "connectors are not set up",
        ))
    })
}

async fn list(State(state): State<AppState>) -> Response {
    let hub = match hub(&state) {
        Ok(hub) => hub,
        Err(response) => return *response,
    };
    Json(json!({ "catalogue": hub.catalogue(), "connectors": hub.list() })).into_response()
}

async fn one(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let hub = match hub(&state) {
        Ok(hub) => hub,
        Err(response) => return *response,
    };
    match hub.get(&id) {
        Some(view) => Json(json!({ "connector": view })).into_response(),
        None => problem(StatusCode::NOT_FOUND, "no such connector"),
    }
}

async fn connect(State(state): State<AppState>, Body(body): Body<ConnectRequest>) -> Response {
    let request = ConnectRequest { id: None, ..body };
    start(&state, request).await
}

async fn reconnect(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    // The body is optional: a token or client ID when reconnecting with one.
    let body: ConnectRequest = if body.iter().all(u8::is_ascii_whitespace) {
        ConnectRequest::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(body) => body,
            Err(error) => return problem(StatusCode::BAD_REQUEST, &error.to_string()),
        }
    };
    let request = ConnectRequest {
        id: Some(id),
        catalogue: None,
        url: None,
        ..body
    };
    start(&state, request).await
}

async fn start(state: &AppState, request: ConnectRequest) -> Response {
    let hub = match hub(state) {
        Ok(hub) => hub,
        Err(response) => return *response,
    };
    match hub.connect(request).await {
        Ok(Started::Connected(view)) => Json(json!({ "connector": view })).into_response(),
        Ok(Started::SignIn { id, url }) => (
            StatusCode::ACCEPTED,
            Json(json!({ "id": id, "sign_in_url": url })),
        )
            .into_response(),
        // A device sign-in: the app shows the code and the page; `GET /v1/connectors/{id}` follows.
        Ok(Started::Device {
            id,
            code,
            url,
            expires_in,
        }) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "id": id,
                "device": { "code": code, "url": url, "expires_in": expires_in },
            })),
        )
            .into_response(),
        Err(error) => connect_problem(&error),
    }
}

fn connect_problem(error: &ConnectError) -> Response {
    let (status, needs) = match error {
        ConnectError::Invalid(_) => (StatusCode::BAD_REQUEST, None),
        ConnectError::NotFound => (StatusCode::NOT_FOUND, None),
        ConnectError::NeedsClient => (StatusCode::CONFLICT, Some("client_id")),
        ConnectError::Refused => (StatusCode::UNPROCESSABLE_ENTITY, Some("token")),
        ConnectError::NoKeychain => (StatusCode::SERVICE_UNAVAILABLE, None),
        ConnectError::Unsupported(_) => (StatusCode::UNPROCESSABLE_ENTITY, None),
        ConnectError::Unreachable(_) => (StatusCode::BAD_GATEWAY, None),
        ConnectError::Failed(_) => (StatusCode::INTERNAL_SERVER_ERROR, None),
    };
    let mut body = json!({ "error": error.to_string() });
    if let Some(needs) = needs {
        body["needs"] = Value::String(needs.to_owned());
    }
    (status, Json(body)).into_response()
}

async fn disconnect(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let hub = match hub(&state) {
        Ok(hub) => hub,
        Err(response) => return *response,
    };
    match hub.disconnect(&id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => problem(StatusCode::NOT_FOUND, "no such connector"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

/// `{all, connectors}`: whether the bot may use every connector, else which.
#[derive(Deserialize)]
struct Allowed {
    #[serde(default)]
    all: bool,
    #[serde(default)]
    connectors: Vec<String>,
}

fn access_json(access: &Access) -> Value {
    match access {
        Access::All => json!({ "all": true, "connectors": [] }),
        Access::Only(ids) => json!({ "all": false, "connectors": ids }),
    }
}

/// The agent's id and whether it is Spade, the main bot.
fn agent(state: &AppState, id: &str) -> Result<bool, Box<Response>> {
    match state.engine.agent_view(id) {
        Ok(Some(view)) => Ok(view.agent.kind == crate::engine::MAIN),
        Ok(None) => Err(Box::new(problem(StatusCode::NOT_FOUND, "no such agent"))),
        Err(error) => Err(Box::new(problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            &error.to_string(),
        ))),
    }
}

async fn allowed(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let hub = match hub(&state) {
        Ok(hub) => hub,
        Err(response) => return *response,
    };
    match agent(&state, &id) {
        Ok(is_main) => Json(access_json(&hub.access(&id, is_main))).into_response(),
        Err(response) => *response,
    }
}

async fn set_allowed(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Allowed>,
) -> Response {
    let hub = match hub(&state) {
        Ok(hub) => hub,
        Err(response) => return *response,
    };
    if let Err(response) = agent(&state, &id) {
        return *response;
    }
    let access = if body.all {
        Access::All
    } else {
        Access::Only(
            body.connectors
                .iter()
                .map(|c| c.trim().to_owned())
                .filter(|c| !c.is_empty())
                .collect(),
        )
    };
    match hub.set_access(&id, access.clone()) {
        Ok(()) => Json(access_json(&access)).into_response(),
        Err(error) => connect_problem(&error),
    }
}

async fn callback(
    State(state): State<AppState>,
    Path(connector): Path<String>,
    Query(query): Query<Callback>,
) -> Response {
    let query = Callback {
        connector: Some(connector),
        ..query
    };
    finish(&state, query).await
}

/// The `state` alone names the sign-in here; `finish` then insists on `iss`.
async fn shared_callback(State(state): State<AppState>, Query(query): Query<Callback>) -> Response {
    finish(
        &state,
        Callback {
            connector: None,
            ..query
        },
    )
    .await
}

async fn finish(state: &AppState, query: Callback) -> Response {
    let hub = match hub(state) {
        Ok(hub) => hub,
        Err(response) => return *response,
    };
    match hub.finish(query).await {
        Ok(view) => page(
            StatusCode::OK,
            &format!("Connected to {}", view.name),
            "You can close this tab.",
        ),
        Err(error) => page(
            StatusCode::BAD_REQUEST,
            "Not connected",
            &format!("{}.", capitalised(&error.to_string())),
        ),
    }
}

/// A plain page for the browser tab the sign-in ends in. It loads nothing, is never cached and
/// sends no referrer (its address carried the code).
fn page(status: StatusCode, title: &str, line: &str) -> Response {
    let (title, line) = (escape(title), escape(line));
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" \
         content=\"width=device-width\"><title>{title}</title><style>body{{font:16px/1.5 \
         system-ui,sans-serif;margin:20vh auto;max-width:28rem;padding:0 1rem;color:#222}}\
         @media(prefers-color-scheme:dark){{body{{background:#111;color:#ddd}}}}h1{{font-size:\
         1.25rem;font-weight:600}}</style></head><body><h1>{title}</h1><p>{line}</p></body></html>"
    );
    (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'",
            ),
        ],
        html,
    )
        .into_response()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}
