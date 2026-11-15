//! `/v1/agents/{id}/plugins` (spade/docs/plugins.md, ADR 0151): which of the person's accepted
//! plugins a bot may use, what of each it uses, and what it doesn't with why.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use super::body::Body;
use super::{AppState, problem};
use crate::plugins::{AllowError, Plugins};

/// How long a page waits for ace's plugins before showing the last copy.
const WAIT: Duration = Duration::from_secs(5);

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/agents/{id}/plugins", get(view).put(set))
}

fn plugins(state: &AppState) -> Result<Arc<Plugins>, Box<Response>> {
    state.engine.plugins().cloned().ok_or_else(|| {
        Box::new(problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "plugins come from ace, and Spade isn't set up with ace",
        ))
    })
}

/// The bot, and whether it runs on a subscription (it then gets only rules).
fn agent(state: &AppState, id: &str) -> Result<bool, Box<Response>> {
    match state.engine.agent_view(id) {
        Ok(Some(view)) => Ok(spade_core::brain::CliModel::is(&view.agent.model)),
        Ok(None) => Err(Box::new(problem(StatusCode::NOT_FOUND, "no such agent"))),
        Err(error) => Err(Box::new(problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            &error.to_string(),
        ))),
    }
}

async fn view(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let (plugins, cli) = match (plugins(&state), agent(&state, &id)) {
        (Ok(plugins), Ok(cli)) => (plugins, cli),
        (Err(response), _) | (_, Err(response)) => return *response,
    };
    let _ = tokio::time::timeout(WAIT, plugins.refresh_now()).await;
    Json(plugins.view(&id, cli)).into_response()
}

#[derive(Deserialize)]
struct Allowed {
    plugins: Vec<String>,
}

async fn set(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Allowed>,
) -> Response {
    let (plugins, cli) = match (plugins(&state), agent(&state, &id)) {
        (Ok(plugins), Ok(cli)) => (plugins, cli),
        (Err(response), _) | (_, Err(response)) => return *response,
    };
    let names: BTreeSet<String> = body
        .plugins
        .iter()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    let _ = tokio::time::timeout(WAIT, plugins.refresh()).await;
    match plugins.set_allowed(&id, names) {
        Ok(()) => {
            if let Err(error) = state.engine.plugins_changed(&id) {
                tracing::error!(%error, "could not note the bot's changed plugins");
            }
            Json(plugins.view(&id, cli)).into_response()
        }
        Err(error @ AllowError::Unknown(_)) => problem(StatusCode::BAD_REQUEST, &error.to_string()),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}
