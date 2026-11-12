//! `/v1/groups`, `/v1/templates`, duplicate, export, import and `/v1/inbox` (docs/teams.md,
//! ADR 0132).

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::{Value, json};

use super::agents::{AGENT_BODY, agent_json};
use super::body::Body;
use super::{AppState, off_thread, problem};
use crate::engine::{GroupError, GroupInput, GroupView, InboxSender, MemberRef};
use crate::teams::{self, PortableError};

/// The largest inbox request, as the daemon forwards it.
const INBOX_BODY: usize = 512 * 1024;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/groups", get(list).post(create))
        .route("/groups/{id}", axum::routing::patch(update).delete(delete))
        .route("/groups/{id}/messages", post(post_message))
        .route("/groups/{id}/stop", post(stop))
        .route("/templates", get(templates))
        .route("/agents/{id}/duplicate", post(duplicate))
        .route("/agents/{id}/export", get(export))
        .route(
            "/agents/import",
            post(import).layer(DefaultBodyLimit::max(AGENT_BODY)),
        )
        .route(
            "/inbox",
            post(inbox).layer(DefaultBodyLimit::max(INBOX_BODY)),
        )
}

#[derive(Deserialize)]
struct MemberBody {
    agent: String,
    #[serde(default)]
    machine: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct GroupBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    members: Option<Vec<MemberBody>>,
    #[serde(default)]
    lead: Option<String>,
}

impl GroupBody {
    fn input(self) -> GroupInput {
        GroupInput {
            name: self.name,
            members: self.members.map(|members| {
                members
                    .into_iter()
                    .map(|m| MemberRef {
                        agent: m.agent,
                        machine: m.machine.filter(|h| !h.is_empty()),
                        name: m.name,
                    })
                    .collect()
            }),
            lead: self.lead,
        }
    }
}

fn group_json(view: &GroupView) -> Value {
    let group = &view.group;
    let member = |index: usize| {
        let m = &group.members[index];
        json!({
            "agent": m.agent_id,
            "machine": (!m.machine.is_empty()).then(|| m.machine.clone()),
            "name": m.name,
            "avatar": m.avatar.as_deref().and_then(|a| serde_json::from_str::<Value>(a).ok()),
            "away": view.away.get(index).copied().unwrap_or(false),
        })
    };
    let members: Vec<Value> = (0..group.members.len()).map(member).collect();
    let lead = group
        .members
        .iter()
        .position(|m| m.machine.is_empty() && m.agent_id == group.lead_id)
        .map_or(Value::Null, member);
    let last_message = view.last_message.as_ref().map(|m| {
        json!({
            "from": if m.from.is_some() { "agent" } else { "person" },
            "text": m.text,
            "at": m.at_ms,
            "agent": m.from.as_ref().map(|b| json!({ "id": b.id, "name": b.name, "machine": b.machine })),
        })
    });
    json!({
        "id": group.id,
        "name": group.name,
        "lead": lead,
        "members": members,
        "conversation": group.conversation,
        "created_at": group.created_ms,
        "updated_at": group.updated_ms,
        "last_activity": view.last_activity_ms,
        "state": view.state.name(),
        "status": view.status,
        "last_message": last_message,
    })
}

fn group_problem(error: &GroupError) -> Response {
    let status = match error {
        GroupError::NotFound | GroupError::NoBot(_) => StatusCode::NOT_FOUND,
        GroupError::Invalid(_) => StatusCode::BAD_REQUEST,
        GroupError::Conflict(_) => StatusCode::CONFLICT,
        GroupError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

async fn list(State(state): State<AppState>) -> Response {
    // Members' machines are listed first, so the answer says which are away.
    let _ = state.engine.machines().await;
    match state.engine.groups() {
        Ok(views) => Json(json!({ "groups": views.iter().map(group_json).collect::<Vec<_>>() }))
            .into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

async fn create(State(state): State<AppState>, Body(body): Body<GroupBody>) -> Response {
    let _ = state.engine.machines().await;
    match state.engine.create_group(body.input()).await {
        Ok(view) => (StatusCode::CREATED, Json(json!({ "group": group_json(&view) })))
            .into_response(),
        Err(error) => group_problem(&error),
    }
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<GroupBody>,
) -> Response {
    match state.engine.update_group(&id, body.input()).await {
        Ok(view) => Json(json!({ "group": group_json(&view) })).into_response(),
        Err(error) => group_problem(&error),
    }
}

async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.delete_group(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => group_problem(&error),
    }
}

#[derive(Deserialize)]
struct Message {
    text: String,
}

async fn post_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Message>,
) -> Response {
    match state.engine.post_group(&id, &body.text) {
        Ok(run) => (StatusCode::ACCEPTED, Json(json!({ "run": run }))).into_response(),
        Err(error) => group_problem(&error),
    }
}

async fn stop(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.stop_group(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => group_problem(&error),
    }
}

async fn templates() -> Response {
    Json(json!({ "templates": teams::templates() })).into_response()
}

fn portable_problem(error: &PortableError) -> Response {
    let status = match error {
        PortableError::NotFound => StatusCode::NOT_FOUND,
        PortableError::Invalid(_) => StatusCode::BAD_REQUEST,
        PortableError::Agent(crate::engine::AgentError::NotFound) => StatusCode::NOT_FOUND,
        PortableError::Agent(
            crate::engine::AgentError::Invalid(_) | crate::engine::AgentError::Image(_),
        ) => StatusCode::BAD_REQUEST,
        PortableError::Agent(_) | PortableError::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

#[derive(Deserialize, Default)]
struct Duplicate {
    #[serde(default)]
    name: Option<String>,
}

async fn duplicate(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    // The body is optional: none, or `{}`, names the copy `<name> copy`.
    let name = serde_json::from_slice::<Duplicate>(&body)
        .ok()
        .and_then(|b| b.name);
    off_thread(move || {
        match teams::duplicate(&state.engine, state.connectors.as_deref(), &id, name) {
            Ok(view) => {
                (StatusCode::CREATED, Json(json!({ "agent": agent_json(&view) }))).into_response()
            }
            Err(error) => portable_problem(&error),
        }
    })
    .await
}

async fn export(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || match teams::export(&state.engine, state.connectors.as_deref(), &id) {
        Ok(file) => {
            let name: String = file
                .name
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
                .collect();
            let disposition = format!("attachment; filename=\"{name}.spade-bot.json\"");
            let mut response = Json(file).into_response();
            if let Ok(value) = disposition.parse() {
                response
                    .headers_mut()
                    .insert(header::CONTENT_DISPOSITION, value);
            }
            response
        }
        Err(error) => portable_problem(&error),
    })
    .await
}

async fn import(State(state): State<AppState>, Body(file): Body<Value>) -> Response {
    let file: teams::BotFile = match serde_json::from_value(file) {
        Ok(file) => file,
        Err(_) => return problem(StatusCode::BAD_REQUEST, "this is not a Spade bot file"),
    };
    off_thread(move || {
        match teams::import(&state.engine, state.connectors.as_deref(), file) {
            Ok(imported) => (
                StatusCode::CREATED,
                Json(json!({
                    "agent": agent_json(&imported.agent),
                    "left_out": imported.left_out,
                })),
            )
                .into_response(),
            Err(error) => portable_problem(&error),
        }
    })
    .await
}

/// `POST /v1/inbox`: only with the daemon's stamp of which machine sent it.
async fn inbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Body(body): Body<Value>,
) -> Response {
    let stamp = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty() && v.len() <= 256)
            .map(str::to_owned)
    };
    let (Some(host), Some(name)) = (stamp("x-ace-from-host"), stamp("x-ace-from-name")) else {
        return problem(
            StatusCode::FORBIDDEN,
            "only another machine, through ace, can deliver here",
        );
    };
    let (status, answer) = state.engine.inbox(&InboxSender { host, name }, &body).await;
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(answer),
    )
        .into_response()
}
