//! Spade's security boundaries over HTTP (ADR 0167 decision 10; spade/docs/security.md): the
//! machine's sandbox, and per bot its network policies, toolchains, grants (consented folders
//! among them) and egress log. Only the person's API writes these. The UI (Settings › Spade ›
//! Security, the profile's Details) comes later.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, put};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::grant::{BY_PERSON, Scope};
use spade_sandbox::egress::NetworkPolicy;

use super::body::Body;
use super::{AppState, off_thread, problem};
use crate::security::{Network, Security, SecurityError};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/security", get(machine))
        .route("/agents/{id}/security", get(agent))
        .route("/agents/{id}/security/network", put(network))
        .route("/agents/{id}/security/plugin-network", put(plugin_network))
        .route("/agents/{id}/security/toolchains", put(toolchains))
        .route("/agents/{id}/security/egress", get(egress))
        .route("/agents/{id}/grants", get(grants).post(grant))
        .route("/agents/{id}/grants/{grant}", delete(revoke))
        .route(
            "/agents/{id}/checkpoints",
            get(checkpoints).post(checkpoint),
        )
        .route(
            "/agents/{id}/checkpoints/{checkpoint}/restore",
            axum::routing::post(restore),
        )
}

fn security(state: &AppState) -> Option<Arc<Security>> {
    state.engine.security().cloned()
}

fn unavailable() -> Response {
    problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "Spade's security settings aren't available",
    )
}

fn failed(error: SecurityError) -> Response {
    let status = match error {
        SecurityError::NotFound => StatusCode::NOT_FOUND,
        SecurityError::Invalid(_) => StatusCode::BAD_REQUEST,
        SecurityError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

fn known(state: &AppState, id: &str) -> Result<(), SecurityError> {
    match state.engine.agent_view(id) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(SecurityError::NotFound),
        Err(error) => Err(SecurityError::Store(error.to_string())),
    }
}

/// Everything about one bot's boundaries.
fn view(security: &Security, id: &str) -> Value {
    let settings = security.bot(id);
    let effective = security.effective_grants(id);
    let folders: Vec<Value> = effective
        .iter()
        .filter_map(|grant| match &grant.scope {
            Scope::Folder { path, write } => {
                Some(json!({"grant": grant.id, "path": path, "write": write}))
            }
            _ => None,
        })
        .collect();
    json!({
        "contained": security.contains(),
        "network": settings.network,
        "plugin_network": settings.plugin_network(),
        "toolchains": settings.toolchains,
        "grants": settings.grants,
        "effective_grants": effective,
        "folders": folders,
    })
}

async fn machine(State(state): State<AppState>) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || {
        let mut view = security.status_view();
        if let Some(object) = view.as_object_mut() {
            object.insert(
                "toolchains_found".to_owned(),
                json!(security.toolchain_candidates()),
            );
        }
        Json(view).into_response()
    })
    .await
}

async fn agent(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match known(&state, &id) {
        Ok(()) => Json(view(&security, &id)).into_response(),
        Err(error) => failed(error),
    })
    .await
}

async fn set_network(state: AppState, id: String, which: Network, body: NetworkPolicy) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match security.set_network(&id, which, body) {
        Ok(_) => Json(view(&security, &id)).into_response(),
        Err(error) => failed(error),
    })
    .await
}

async fn network(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<NetworkPolicy>,
) -> Response {
    set_network(state, id, Network::Commands, body).await
}

async fn plugin_network(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<NetworkPolicy>,
) -> Response {
    set_network(state, id, Network::Plugins, body).await
}

#[derive(Deserialize)]
struct Toolchains {
    toolchains: Vec<String>,
}

async fn toolchains(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Toolchains>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(
        move || match security.set_toolchains(&id, body.toolchains) {
            Ok(_) => Json(view(&security, &id)).into_response(),
            Err(error) => failed(error),
        },
    )
    .await
}

#[derive(Deserialize)]
struct Limit {
    limit: Option<usize>,
}

async fn egress(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(limit): Query<Limit>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match known(&state, &id) {
        Ok(()) => {
            let limit = limit.limit.unwrap_or(200).clamp(1, 5_000);
            Json(json!({"entries": security.egress(&id, limit)})).into_response()
        }
        Err(error) => failed(error),
    })
    .await
}

async fn grants(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match known(&state, &id) {
        Ok(()) => Json(json!({
            "grants": security.bot(&id).grants,
            "effective": security.effective_grants(&id),
        }))
        .into_response(),
        Err(error) => failed(error),
    })
    .await
}

async fn grant(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(scope): Body<Scope>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match security.add_grant(&id, scope, BY_PERSON) {
        Ok(grant) => (StatusCode::CREATED, Json(json!({"grant": grant}))).into_response(),
        Err(error) => failed(error),
    })
    .await
}

async fn revoke(
    State(state): State<AppState>,
    Path((id, grant)): Path<(String, String)>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match security.remove_grant(&id, &grant) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => problem(StatusCode::NOT_FOUND, "there is no such grant"),
        Err(error) => failed(error),
    })
    .await
}

async fn checkpoints(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match security.checkpoints(&id) {
        Ok(list) => Json(json!({
            "checkpoints": list,
            "keep": crate::security::checkpoints::KEEP,
            "longest_days": crate::security::checkpoints::LONGEST / (24 * 60 * 60 * 1000),
            "every_seconds": crate::security::checkpoints::EVERY / 1000,
        }))
        .into_response(),
        Err(error) => failed(error),
    })
    .await
}

async fn checkpoint(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match security.take_checkpoint(&id, "person") {
        Ok(taken) => (StatusCode::CREATED, Json(json!({"checkpoint": taken}))).into_response(),
        Err(error) => failed(error),
    })
    .await
}

async fn restore(
    State(state): State<AppState>,
    Path((id, checkpoint)): Path<(String, String)>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || {
        // Reserved first, so no turn, command or file write starts while it is checked and
        // restored; then never under a bot that is changing its files.
        let Some(_reserved) = security.reserve(&id) else {
            return problem(StatusCode::CONFLICT, crate::security::RESERVED);
        };
        let view = match state.engine.agent_view(&id) {
            Ok(Some(view)) => view,
            Ok(None) => return failed(SecurityError::NotFound),
            Err(error) => return failed(SecurityError::Store(error.to_string())),
        };
        if view.state == crate::engine::State::Working {
            return problem(
                StatusCode::CONFLICT,
                "the bot is working; stop it before restoring a checkpoint",
            );
        }
        if state.engine.services_running(&view.agent.conversation) > 0 {
            return problem(
                StatusCode::CONFLICT,
                "the bot's services are running; stop them before restoring a checkpoint",
            );
        }
        match security.restore_checkpoint(&id, &checkpoint) {
            Ok(saved) => Json(json!({"restored": checkpoint, "saved": saved})).into_response(),
            Err(error) => failed(error),
        }
    })
    .await
}
