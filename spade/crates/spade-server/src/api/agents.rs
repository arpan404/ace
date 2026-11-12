//! `/v1/agents` and `/v1/main` (docs/agents.md).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::body::Body;
use super::{AppState, off_thread, problem};
use crate::engine::{
    AgentChange, AgentError, AgentInput, AgentView, AvatarInput, State as AgentState, roster,
};

/// An agent body may carry one avatar image as base64 (3.75 MB, a third larger encoded).
pub(super) const AGENT_BODY: usize = 6 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AvatarBody {
    Image {
        data: String,
    },
    Generated {
        #[serde(default)]
        color: Option<String>,
    },
}

impl AvatarBody {
    fn input(self) -> Result<AvatarInput, Box<Response>> {
        match self {
            Self::Image { data } => crate::images::decode(&data)
                .map(AvatarInput::Image)
                .map_err(|e| Box::new(problem(StatusCode::BAD_REQUEST, &e.to_string()))),
            Self::Generated { color } => Ok(AvatarInput::Generated(color)),
        }
    }
}

#[derive(Deserialize)]
pub(super) struct NewAgent {
    name: String,
    #[serde(default)]
    task: String,
    /// The engine's default (the person's first usable model) when absent.
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    avatar: Option<AvatarBody>,
}

#[derive(Deserialize)]
pub(super) struct Change {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    task: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    avatar: Option<AvatarBody>,
}

#[derive(Deserialize)]
pub(super) struct Main {
    enabled: bool,
}

/// An agent as the API shows it. The task is the person's own text, sent back only to them.
pub(super) fn agent_json(view: &AgentView) -> Value {
    let agent = &view.agent;
    let mut avatar: Value =
        serde_json::from_str(&agent.avatar).unwrap_or_else(|_| json!({ "kind": "generated" }));
    if avatar["kind"] == "generated" {
        avatar["initials"] = Value::String(roster::initials(&agent.name));
        if !avatar["color"].is_string() {
            avatar["color"] = json!(spade_store::generated_color(&agent.id));
        }
    }
    let last_message = view.last_message.as_ref().map(|m| {
        json!({
            "from": if m.by_agent { "agent" } else { "person" },
            "text": m.text,
            "at": m.at_ms,
            "from_agent": m.from_agent.as_ref().map(|f| json!({ "id": f.id, "name": f.name })),
        })
    });
    json!({
        "id": agent.id,
        "kind": agent.kind,
        "name": agent.name,
        "task": agent.task,
        "avatar": avatar,
        "model": agent.model,
        "conversation": agent.conversation,
        "created_at": agent.created_ms,
        "updated_at": agent.updated_ms,
        "last_activity": agent.last_activity_ms,
        "state": view.state.name(),
        "working": view.state != AgentState::Idle,
        // Only approvals wait on the person today; "question" is kept for an ask-the-person tool.
        "waiting_for": if view.state == AgentState::Waiting { json!("approval") } else { Value::Null },
        "status": view.status,
        "last_message": last_message,
    })
}

fn agent_problem(error: &AgentError) -> Response {
    let status = match error {
        AgentError::NotFound => StatusCode::NOT_FOUND,
        AgentError::Invalid(_) | AgentError::Image(_) => StatusCode::BAD_REQUEST,
        AgentError::Main(_) => StatusCode::CONFLICT,
        AgentError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

pub(super) async fn list(State(state): State<AppState>) -> Response {
    match state.engine.agents() {
        Ok(views) => Json(json!({ "agents": views.iter().map(agent_json).collect::<Vec<_>>() }))
            .into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

pub(super) async fn create(State(state): State<AppState>, Body(body): Body<NewAgent>) -> Response {
    let avatar = match body.avatar.map(AvatarBody::input).transpose() {
        Ok(avatar) => avatar,
        Err(response) => return *response,
    };
    // The default model is the first one with a key, which reads the keychain.
    off_thread(move || {
        let input = AgentInput {
            name: body.name,
            task: body.task,
            model: body.model.unwrap_or_else(|| state.engine.default_model()),
            avatar,
        };
        create_now(&state, input)
    })
    .await
}

fn create_now(state: &AppState, input: AgentInput) -> Response {
    match state.engine.create_agent(input) {
        Ok(view) => (
            StatusCode::CREATED,
            Json(json!({ "agent": agent_json(&view) })),
        )
            .into_response(),
        Err(error) => agent_problem(&error),
    }
}

pub(super) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Change>,
) -> Response {
    let avatar = match body.avatar.map(AvatarBody::input).transpose() {
        Ok(avatar) => avatar,
        Err(response) => return *response,
    };
    let change = AgentChange {
        name: body.name,
        task: body.task,
        model: body.model,
        avatar,
    };
    match state.engine.update_agent(&id, change) {
        Ok(view) => Json(json!({ "agent": agent_json(&view) })).into_response(),
        Err(error) => agent_problem(&error),
    }
}

pub(super) async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.delete_agent(&id).await {
        Ok(()) => {
            // Its workspace and proposals go with it (ADR 0130).
            let (workspaces, learning) = (state.workspaces.clone(), state.learning.clone());
            let forgotten = tokio::task::spawn_blocking(move || {
                if let Some(learning) = learning {
                    learning.forget(&id);
                }
                workspaces.map(|all| all.remove(&id))
            })
            .await;
            if let Ok(Some(Err(error))) = forgotten {
                tracing::warn!(%error, "a deleted bot's workspace was not removed");
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => agent_problem(&error),
    }
}

/// Switches Spade, the main agent, on or off on this machine (ADR 0127: it runs on one).
pub(super) async fn set_main(State(state): State<AppState>, Body(body): Body<Main>) -> Response {
    match state.engine.set_main_enabled(body.enabled) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}
