//! `/v1/agents` and `/v1/main` (docs/agents.md).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::body::Body;
use super::{AppState, off_thread, problem, send_problem};
use crate::engine::{
    AgentChange, AgentError, AgentInput, AgentView, AvatarInput, Outgoing, State as AgentState,
};
use spade_core::autonomy::Access;

/// An agent body may carry one avatar image as base64 (3.75 MB, a third larger encoded).
pub(super) const AGENT_BODY: usize = 6 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AvatarBody {
    Image {
        data: String,
    },
    /// A character face; any value it doesn't know is repaired.
    Character(serde_json::Map<String, Value>),
    /// Initials from an older client (its colour is ignored): Spade picks a face.
    Generated {},
}

impl AvatarBody {
    fn input(self) -> Result<AvatarInput, Box<Response>> {
        match self {
            Self::Image { data } => crate::images::decode(&data)
                .map(AvatarInput::Image)
                .map_err(|e| Box::new(problem(StatusCode::BAD_REQUEST, &e.to_string()))),
            Self::Character(fields) => Ok(AvatarInput::Character(Value::Object(fields))),
            Self::Generated {} => Ok(AvatarInput::Generated),
        }
    }
}

#[derive(Deserialize)]
pub(super) struct NewAgent {
    /// The template's name when a template is given.
    #[serde(default)]
    name: Option<String>,
    /// A shipped template to start from (docs/teams.md).
    #[serde(default)]
    template: Option<String>,
    /// The IANA time zone a template's routines run in.
    #[serde(default)]
    time_zone: Option<String>,
    #[serde(default)]
    task: String,
    /// The engine's default (the person's first usable model) when absent.
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    avatar: Option<AvatarBody>,
    /// `ask`, `auto_review` or `full_access` (ADR 0144); the new-bot level when absent.
    #[serde(default)]
    access: Option<String>,
    /// The bot's first message, sent as it is made (the new-bot conversation): the bot and the
    /// message are made together, or neither is.
    #[serde(default)]
    first_message: Option<FirstMessage>,
}

/// A first message: its text and images, as `POST /conversations/{id}/messages` takes them.
#[derive(Deserialize)]
pub(super) struct FirstMessage {
    #[serde(default)]
    text: String,
    #[serde(default)]
    images: Vec<ImageUpload>,
}

#[derive(Deserialize)]
pub(super) struct ImageUpload {
    data: String,
}

impl FirstMessage {
    fn outgoing(self) -> Result<Outgoing, Box<Response>> {
        let images = self
            .images
            .iter()
            .map(|upload| crate::images::decode(&upload.data))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| Box::new(problem(StatusCode::BAD_REQUEST, &e.to_string())))?;
        Ok(Outgoing {
            text: self.text,
            images,
            ..Outgoing::default()
        })
    }
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
    /// `ask`, `auto_review` or `full_access` (ADR 0144). Holds from the bot's next tool call.
    #[serde(default)]
    access: Option<String>,
}

/// The access level a body names; a word Spade doesn't know is refused.
fn access(word: Option<&str>) -> Result<Option<Access>, Box<Response>> {
    match word {
        None => Ok(None),
        Some(word) => Access::parse(word).map(Some).ok_or_else(|| {
            Box::new(problem(
                StatusCode::BAD_REQUEST,
                "access must be ask, auto_review or full_access",
            ))
        }),
    }
}

#[derive(Deserialize)]
pub(super) struct Pin {
    pub(super) pinned: bool,
}

/// `PUT /v1/agents/{id}/pin`: pins the bot to the top of the list, or unpins it.
pub(super) async fn pin(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<Pin>,
) -> Response {
    match state.engine.pin_agent(&id, body.pinned) {
        Ok(Some(view)) => Json(json!({ "agent": agent_json(&view) })).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

#[derive(Deserialize)]
pub(super) struct Main {
    enabled: bool,
}

/// An agent as the API shows it. The task is the person's own text, sent back only to them.
pub(super) fn agent_json(view: &AgentView) -> Value {
    let agent = &view.agent;
    let avatar = spade_core::face::shown_avatar(&agent.id, &agent.avatar);
    let last_message = view.last_message.as_ref().map(|m| {
        json!({
            "from": if m.by_agent { "agent" } else { "person" },
            "text": m.text,
            "at": m.at_ms,
            "seq": m.seq,
            "from_agent": m.from_agent.as_ref().map(|f| json!({ "id": f.id, "name": f.name })),
        })
    });
    let mut shown = json!({
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
        "pinned_at": agent.pinned_ms,
        "state": view.state.name(),
        "working": view.state != AgentState::Idle,
        "waiting_for": view.waiting_for,
        "questions_for_later": view.questions_for_later,
        "status": view.status,
        "problem": view.problem,
        "last_message": last_message,
        "seen_seq": view.seen,
        "unseen": crate::engine::roster::unseen(view.state, view.last_message.as_ref(), view.seen),
    });
    // `spending` and `review` (ADR 0135); `access`, `task_state` and `continuing` (ADR 0144).
    if let (Some(shown), Some(extra)) = (shown.as_object_mut(), view.oversight.as_object()) {
        for (key, value) in extra {
            shown.insert(key.clone(), value.clone());
        }
    }
    shown
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
        Ok(views) => {
            let computers = state.engine.computers();
            let agents: Vec<Value> = views
                .iter()
                .map(|view| {
                    let mut agent = agent_json(view);
                    // What its computer is doing, so the roster needs no request per bot.
                    if let Some(computers) = computers {
                        agent["computer"] = json!(computers.view(&view.agent.id));
                    }
                    agent
                })
                .collect();
            Json(json!({ "agents": agents })).into_response()
        }
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

pub(super) async fn create(State(state): State<AppState>, Body(body): Body<NewAgent>) -> Response {
    let level = match access(body.access.as_deref()) {
        Ok(level) => level,
        Err(response) => return *response,
    };
    let mut body = body;
    let avatar = match body.avatar.take().map(AvatarBody::input).transpose() {
        Ok(avatar) => avatar,
        Err(response) => return *response,
    };
    let first = match body
        .first_message
        .take()
        .map(FirstMessage::outgoing)
        .transpose()
    {
        Ok(first) => first,
        Err(response) => return *response,
    };
    // A message that would be refused makes no bot.
    if let Some(first) = &first
        && let Err(error) = state.engine.check_first_message(first)
    {
        return send_problem(&error);
    }
    // The default model is the first one with a key, which reads the keychain.
    off_thread(move || {
        let (view, left_out) = match make(&state, body, avatar, level) {
            Ok(made) => made,
            Err(response) => return *response,
        };
        let view = match first {
            Some(first) => match send_first(&state, &view, first) {
                Ok(view) => view,
                Err(response) => return *response,
            },
            None => view,
        };
        let mut answer = json!({ "agent": agent_json(&view) });
        if let Some(left_out) = left_out {
            answer["left_out"] = json!(left_out);
        }
        (StatusCode::CREATED, Json(answer)).into_response()
    })
    .await
}

/// Makes the bot, from a template or not; a template's answer says what it left out.
fn make(
    state: &AppState,
    body: NewAgent,
    avatar: Option<AvatarInput>,
    level: Option<Access>,
) -> Result<(AgentView, Option<Vec<String>>), Box<Response>> {
    if let Some(template) = &body.template {
        let model = body
            .model
            .clone()
            .or_else(|| crate::teams::template_model(&state.engine, template))
            .unwrap_or_else(|| state.engine.new_bot_default());
        let named = body.name.as_deref().is_some_and(|n| !n.trim().is_empty());
        let input = AgentInput {
            name: body.name.unwrap_or_default(),
            task: body.task,
            model,
            avatar,
            access: level,
        };
        return match crate::teams::from_template(
            &state.engine,
            template,
            input,
            named,
            body.time_zone,
        ) {
            Ok(made) => Ok((made.agent, Some(made.left_out))),
            Err(crate::teams::PortableError::NotFound) => {
                Err(Box::new(problem(StatusCode::NOT_FOUND, "no such template")))
            }
            Err(crate::teams::PortableError::Agent(error)) => Err(Box::new(agent_problem(&error))),
            Err(error) => Err(Box::new(problem(
                StatusCode::BAD_REQUEST,
                &error.to_string(),
            ))),
        };
    }
    let input = AgentInput {
        name: body.name.unwrap_or_default(),
        task: body.task,
        model: body.model.unwrap_or_else(|| state.engine.new_bot_default()),
        avatar,
        access: level,
    };
    state
        .engine
        .create_agent(input)
        .map(|view| (view, None))
        .map_err(|error| Box::new(agent_problem(&error)))
}

/// Sends a new bot its first message. When Spade refuses it (a cap reached since the check, a
/// storage failure), the bot is deleted again: the person gets both or neither.
fn send_first(
    state: &AppState,
    view: &AgentView,
    first: Outgoing,
) -> Result<AgentView, Box<Response>> {
    let sent = state.engine.send_message(&view.agent.conversation, first);
    match sent {
        Ok(()) => Ok(state
            .engine
            .agent_view(&view.agent.id)
            .ok()
            .flatten()
            .unwrap_or_else(|| view.clone())),
        Err(error) => {
            let engine = state.engine.clone();
            let id = view.agent.id.clone();
            // On the blocking pool, so waiting here holds up no async worker.
            if let Err(undo) = tokio::runtime::Handle::current()
                .block_on(async move { engine.delete_agent(&id).await })
            {
                tracing::warn!(%undo, "a bot whose first message was refused could not be removed");
            }
            Err(Box::new(send_problem(&error)))
        }
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
    let level = match access(body.access.as_deref()) {
        Ok(level) => level,
        Err(response) => return *response,
    };
    let change = AgentChange {
        name: body.name,
        task: body.task,
        model: body.model,
        avatar,
    };
    let changed = state
        .engine
        .update_agent(&id, change)
        .and_then(|view| match level {
            Some(level) => state.engine.set_access(&id, level),
            None => Ok(view),
        });
    match changed {
        Ok(view) => Json(json!({ "agent": agent_json(&view) })).into_response(),
        Err(error) => agent_problem(&error),
    }
}

pub(super) async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.delete_agent(&id).await {
        Ok(()) => {
            // Its workspace and proposals go with it (ADR 0130).
            let (workspaces, learning) = (state.workspaces.clone(), state.learning.clone());
            let computers = state.engine.computers().cloned();
            let forgotten = tokio::task::spawn_blocking(move || {
                if let Some(computers) = computers {
                    computers.remove(&id);
                }
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
