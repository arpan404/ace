//! Spade's security boundaries over HTTP (ADR 0167 decision 10; spade/docs/security.md): the
//! machine's sandbox, and per bot its network policies, toolchains, grants (consented folders
//! among them) and egress log. Only the person's API writes these. The UI (Settings › Spade ›
//! Security, the profile's Details) comes later.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, put};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::autonomy::Mode;
use spade_core::grant::{BY_PERSON, Scope};
use spade_sandbox::egress::NetworkPolicy;

use super::body::Body;
use super::{AppState, off_thread, problem};
use crate::security::{Commands, Network, Security, SecurityError};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/security", get(machine))
        .route("/security/commands", put(machine_commands))
        .route("/security/autonomy", put(machine_autonomy))
        .route("/security/network", put(machine_network))
        .route("/security/plugin-network", put(machine_plugin_network))
        .route("/agents/{id}/security", get(agent))
        .route("/agents/{id}/security/commands", put(commands))
        .route("/agents/{id}/security/autonomy", put(autonomy))
        .route(
            "/agents/{id}/security/network",
            put(network).delete(inherit_network),
        )
        .route(
            "/agents/{id}/security/plugin-network",
            put(plugin_network).delete(inherit_plugin_network),
        )
        .route("/agents/{id}/security/toolchains", put(toolchains))
        .route("/agents/{id}/security/egress", get(egress))
        .route("/agents/{id}/grants", get(grants).post(grant))
        .route("/agents/{id}/grants/{grant}", delete(revoke))
        .route(
            "/agents/{id}/checkpoints",
            get(checkpoints).post(checkpoint),
        )
        .route("/agents/{id}/checkpoints/undo", get(undo_preview))
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
        SecurityError::PersonOnly(_) => StatusCode::FORBIDDEN,
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
    let held = security.effective(id);
    // Whether this bot's commands are contained, and the plain line for why not when the machine
    // has a sandbox but this bot's runs keep the review path (on Windows: network or its folders).
    let (contained, reason) = security.bot_containment(id);
    json!({
        "contained": contained,
        "reason": reason,
        "commands": held.commands,
        "autonomy": security.autonomy(id),
        "full_access_confirmed": settings.full_access_confirmed,
        "network": held.network,
        "plugin_network": held.plugin_network,
        "own": {
            "commands": settings.commands.is_some(),
            "autonomy": settings.autonomy.is_some(),
            "network": settings.network.is_some(),
            "plugin_network": settings.plugin_network.is_some(),
        },
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
    off_thread(move || Json(machine_view(&security)).into_response()).await
}

/// The machine's view, as `GET /security` answers it.
fn machine_view(security: &Security) -> Value {
    let mut view = security.status_view();
    if let Some(object) = view.as_object_mut() {
        object.insert(
            "toolchains_found".to_owned(),
            json!(security.toolchain_candidates()),
        );
    }
    view
}

#[derive(Deserialize)]
struct MachineCommands {
    commands: Commands,
}

async fn machine_commands(
    State(state): State<AppState>,
    Body(body): Body<MachineCommands>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(
        move || match security.change_machine(|machine| machine.commands = body.commands) {
            Ok(_) => Json(machine_view(&security)).into_response(),
            Err(error) => failed(error),
        },
    )
    .await
}

#[derive(Deserialize)]
struct MachineAutonomy {
    autonomy: Mode,
}

/// How bots without their own setting decide (ADR 0163, amendment 2).
async fn machine_autonomy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(body): Body<MachineAutonomy>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    let stamp = person_stamp(&headers);
    off_thread(
        move || match security.set_machine_autonomy(body.autonomy, stamp.as_deref()) {
            Ok(_) => Json(machine_view(&security)).into_response(),
            Err(error) => failed(error),
        },
    )
    .await
}

/// The daemon's stamp of the person's say on this change (`attest`), when it sent one.
fn person_stamp(headers: &HeaderMap) -> Option<String> {
    headers
        .get(crate::security::attest::HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

async fn set_machine_network(state: AppState, which: Network, body: NetworkPolicy) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match security.set_machine_network(which, body) {
        Ok(_) => Json(machine_view(&security)).into_response(),
        Err(error) => failed(error),
    })
    .await
}

async fn machine_network(
    State(state): State<AppState>,
    Body(body): Body<NetworkPolicy>,
) -> Response {
    set_machine_network(state, Network::Commands, body).await
}

async fn machine_plugin_network(
    State(state): State<AppState>,
    Body(body): Body<NetworkPolicy>,
) -> Response {
    set_machine_network(state, Network::Plugins, body).await
}

#[derive(Deserialize)]
struct BotCommands {
    /// `null` follows the machine.
    commands: Option<Commands>,
}

async fn commands(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<BotCommands>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match security.set_commands(&id, body.commands) {
        Ok(_) => Json(view(&security, &id)).into_response(),
        Err(error) => failed(error),
    })
    .await
}

#[derive(Deserialize)]
struct BotAutonomy {
    /// `null` follows the bot above it, or the machine.
    autonomy: Option<Mode>,
}

/// How one bot decides: the auto-review or Full access (ADR 0163, amendment 2).
async fn autonomy(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    member: Option<axum::Extension<super::org_guard::Stamped>>,
    Body(body): Body<BotAutonomy>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    let stamp = person_stamp(&headers);
    off_thread(move || {
        // A shared bot rises to Full access only as its organization's policy allows, for the
        // member who configures it (ADR 0206 §2.3); the person's stamp counts for nothing there.
        let set = match &member {
            Some(axum::Extension(super::org_guard::Stamped(member))) => {
                let may = state
                    .engine
                    .org_policy()
                    .may_raise_full_access(member.role(), true);
                security.set_autonomy_as_member(&id, body.autonomy, may)
            }
            None => security.set_autonomy(&id, body.autonomy, stamp.as_deref()),
        };
        match set {
            Ok(_) => Json(view(&security, &id)).into_response(),
            Err(error) => failed(error),
        }
    })
    .await
}

async fn inherit(state: AppState, id: String, which: Network) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || match security.inherit_network(&id, which) {
        Ok(_) => Json(view(&security, &id)).into_response(),
        Err(error) => failed(error),
    })
    .await
}

async fn inherit_network(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    inherit(state, id, Network::Commands).await
}

async fn inherit_plugin_network(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    inherit(state, id, Network::Plugins).await
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
    member: Option<axum::Extension<super::org_guard::Stamped>>,
    Body(scope): Body<Scope>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    // A shared bot's grant names the member who made it (ADR 0206 §4.1).
    let by = match &member {
        Some(axum::Extension(super::org_guard::Stamped(member))) => {
            format!("{}{}", crate::engine::MEMBER_BY, member.account)
        }
        None => BY_PERSON.to_owned(),
    };
    off_thread(move || match security.add_grant(&id, scope, &by) {
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

#[derive(Deserialize)]
struct UndoQuery {
    /// The position in the bot's conversation of the step (its `tool_started`) whose changes,
    /// and everything after them, would be undone.
    seq: i64,
}

/// What undoing a step (or a turn, from its first file-changing step) would revert: the
/// checkpoint taken just before it and the files that would go back, be removed or come back.
async fn undo_preview(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<UndoQuery>,
) -> Response {
    let Some(security) = security(&state) else {
        return unavailable();
    };
    off_thread(move || {
        let started = match state.engine.bot_event_time(&id, query.seq) {
            Ok(Some(at)) => at,
            Ok(None) => return problem(StatusCode::NOT_FOUND, "there is no such step"),
            Err(error) => return failed(SecurityError::Store(error.to_string())),
        };
        match security.undo_preview(&id, started) {
            Ok(Some((checkpoint, changes))) => {
                Json(json!({"checkpoint": checkpoint, "changes": changes})).into_response()
            }
            Ok(None) => problem(
                StatusCode::NOT_FOUND,
                "no checkpoint was kept from before this step",
            ),
            Err(error) => failed(error),
        }
    })
    .await
}

/// `2026-11-19 14:03 UTC`, for the bot's note after an undo.
fn utc_minute(at_ms: i64) -> String {
    jiff::Timestamp::from_millisecond(at_ms)
        .map(|at| at.strftime("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|_| "an earlier checkpoint".to_owned())
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
        // What goes back, read before it does, for the bot's note.
        let reverted = security.changes_since(&id, &checkpoint);
        let at = security
            .checkpoints(&id)
            .ok()
            .and_then(|all| all.into_iter().find(|c| c.id == checkpoint))
            .map(|c| c.at);
        match security.restore_checkpoint(&id, &checkpoint) {
            Ok(saved) => {
                if let (Ok(changes), Some(at)) = (&reverted, at)
                    && !changes.is_empty()
                {
                    let note = crate::security::undo::note_for_bot(&utc_minute(at), changes);
                    if let Err(error) = state.engine.note_workspace_restored(&id, note) {
                        tracing::warn!(%error, "the bot couldn't be told of the restore");
                    }
                }
                Json(json!({"restored": checkpoint, "saved": saved})).into_response()
            }
            Err(error) => failed(error),
        }
    })
    .await
}
