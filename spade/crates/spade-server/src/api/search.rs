//! Settings › Spade › Web search (docs/design.md, Web search): the person's own SearXNG address
//! and a Brave Search key, kept in the OS keychain (ADR 0119) and never returned.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::{AppState, off_thread, problem};

/// The Brave backend's id in `config/search.json`, whose key the settings hold.
const BRAVE: &str = "brave";

/// What web search is set up with: the person's SearXNG address and whether a Brave key is
/// found (keychain or environment). Never the key.
pub(super) async fn read(State(state): State<AppState>) -> Response {
    let Some(search) = state.search else {
        return problem(StatusCode::NOT_FOUND, "web search is not available here");
    };
    let brave_key_set = search.has_key(BRAVE).await;
    Json(json!({
        "searxng_url": search.searxng(),
        "brave_key_set": brave_key_set,
        "keychain": state.keys.is_some(),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(super) struct Change {
    /// `null` or empty forgets it.
    searxng_url: Option<String>,
}

/// Sets or forgets the person's own SearXNG address.
pub(super) async fn change(State(state): State<AppState>, Json(body): Json<Change>) -> Response {
    let Some(search) = state.search.clone() else {
        return problem(StatusCode::NOT_FOUND, "web search is not available here");
    };
    let previous = search.searxng();
    if let Err(error) = search.set_searxng(body.searxng_url.as_deref()) {
        return problem(StatusCode::BAD_REQUEST, &error.to_string());
    }
    if let Err(error) = state.engine.set_searxng_url(search.searxng().as_deref()) {
        // Not kept, so not used either.
        let _ = search.set_searxng(previous.as_deref());
        return problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string());
    }
    read(State(state)).await
}

#[derive(Deserialize)]
pub(super) struct Key {
    key: String,
}

pub(super) async fn set_brave_key(
    State(state): State<AppState>,
    Json(body): Json<Key>,
) -> Response {
    let Some(keys) = state.keys else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "this machine has no keychain; set BRAVE_API_KEY instead",
        );
    };
    off_thread(move || match keys.set_search_key(BRAVE, &body.key) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(spade_keys::KeyError::Invalid(why)) => problem(StatusCode::BAD_REQUEST, why),
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string()),
    })
    .await
}

pub(super) async fn delete_brave_key(State(state): State<AppState>) -> Response {
    let Some(keys) = state.keys else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "this machine has no keychain",
        );
    };
    off_thread(move || match keys.delete_search_key(BRAVE) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => problem(StatusCode::NOT_FOUND, "no Brave Search key is stored"),
        Err(error) => problem(StatusCode::SERVICE_UNAVAILABLE, &error.to_string()),
    })
    .await
}
