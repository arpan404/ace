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
/// A package's manifest with its panels' pages (ADR 0200 §5.2): up to eight of 1 MB each.
pub(super) const PACKAGE_BODY: usize = 10 * 1024 * 1024;

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
    /// Only `auto_review`, Spade's one level (ADR 0163); any other word is refused.
    #[serde(default)]
    access: Option<String>,
    /// The bot's first message, sent as it is made (the new-bot conversation): the bot and the
    /// message are made together, or neither is.
    #[serde(default)]
    first_message: Option<FirstMessage>,
    /// How the bot talks from its first turn; over a template's own.
    #[serde(default)]
    personality: Option<spade_core::personality::Personality>,
    /// A marketplace recipe to make the bot from (ADR 0168, docs/teams.md), with where it came
    /// from, what the person granted by pressing Install, and whether its routines start on.
    #[serde(default)]
    recipe: Option<Value>,
    #[serde(default)]
    from_recipe: Option<crate::engine::FromRecipe>,
    #[serde(default)]
    grants: Option<crate::teams::RecipeGrants>,
    /// Its routines start on now. A recipe's or package's are paused unless this says so; an
    /// ace template's start unless this says no: the person chose to make that bot.
    #[serde(default)]
    start_routines: Option<bool>,
    /// A version 3 package's market identity (ADR 0200 §3.9): the bot it makes stays linked.
    /// Believed only as `envelope` proves it.
    #[serde(default)]
    package: Option<spade_core::package::link::PackageId>,
    /// The market's signed manifest and `bot.json` as it signed it (ADR 0200 §3.2).
    #[serde(default)]
    envelope: Option<crate::packages::envelope::Envelope>,
    /// The person's effect switches on the review, by key; one missing is off.
    #[serde(default)]
    switches: std::collections::BTreeMap<String, bool>,
    /// A package's panel pages (ADR 0200 §5.2), by path: `panels/<id>/index.html` to its text.
    #[serde(default)]
    pages: std::collections::BTreeMap<String, String>,
    /// A package's components (ADR 0203 §5), by path: `code/<name>.wasm` to its bytes in base64.
    #[serde(default)]
    code: std::collections::BTreeMap<String, String>,
    /// Made from one message: the bot names itself in its first reply, and is "New bot" until
    /// then when no name was given.
    #[serde(default)]
    naming: bool,
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
    /// Only `auto_review`, Spade's one level (ADR 0163); any other word is refused.
    #[serde(default)]
    access: Option<String>,
    /// How the bot talks; `null` leaves it to the bot.
    #[serde(default, deserialize_with = "super::body::present")]
    personality: Option<Option<spade_core::personality::Personality>>,
    /// The person's one line on a task change (Undo, a restore), kept in its history.
    #[serde(default)]
    task_why: Option<String>,
    /// Whether it may make bots for the person: `yes`, `ask` or `no` (ADR 0161, amendment 1).
    #[serde(default)]
    may_create_bots: Option<String>,
    /// Its accent (ADR 0200 §5.3): `{"accent": "#rrggbb"}`, or `{"accent": null}` for its face's
    /// colour.
    #[serde(default)]
    style: Option<StyleBody>,
}

#[derive(Deserialize)]
pub(super) struct StyleBody {
    #[serde(default)]
    accent: Option<String>,
}

/// Checks a body's `access`: Spade has one level, so only `auto_review` (or none) is accepted,
/// and it changes nothing.
fn access(word: Option<&str>) -> Result<(), Box<Response>> {
    match word.map(Access::parse) {
        None | Some(Some(Access::AutoReview)) => Ok(()),
        Some(None) => Err(Box::new(problem(
            StatusCode::BAD_REQUEST,
            "access must be auto_review: Spade reviews every step a bot would need you for, \
             and the ask and full_access levels were removed",
        ))),
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
    #[serde(default)]
    by: Option<String>,
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
        "personality": agent.personality,
        "state": view.state.name(),
        // A paused bot isn't working: a client from before `paused` reads it at rest.
        "working": !matches!(view.state, AgentState::Idle | AgentState::Paused),
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

pub(super) fn agent_problem(error: &AgentError) -> Response {
    let status = match error {
        AgentError::NotFound => StatusCode::NOT_FOUND,
        AgentError::Invalid(_) | AgentError::Image(_) => StatusCode::BAD_REQUEST,
        AgentError::Main(_) | AgentError::HasWorkers(_) => StatusCode::CONFLICT,
        // The person reads what the subscription means and ticks Use it (ADR 0205 §1).
        AgentError::Terms { provider, text } => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": text,
                    "terms": { "provider": provider, "acknowledgement": text },
                })),
            )
                .into_response();
        }
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
    if let Err(response) = access(body.access.as_deref()) {
        return *response;
    }
    if body.recipe.is_some() || body.envelope.is_some() {
        return super::recipes::create(state, body.into_recipe()).await;
    }
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
        let (view, left_out) = match make(&state, body, avatar) {
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

impl NewAgent {
    /// The recipe parts of the body, for [`super::recipes::create`].
    fn into_recipe(self) -> super::recipes::RecipeBody {
        super::recipes::RecipeBody {
            recipe: self.recipe.unwrap_or_default(),
            from_recipe: self.from_recipe,
            grants: self.grants.unwrap_or_default(),
            start_routines: self.start_routines.unwrap_or(false),
            time_zone: self.time_zone,
            package: self.package,
            envelope: self.envelope,
            switches: self.switches,
            pages: self.pages,
            code: self.code,
            also: self.template.is_some() || self.first_message.is_some(),
        }
    }
}

/// Makes the bot, from a template or not; a template's answer says what it left out.
fn make(
    state: &AppState,
    body: NewAgent,
    avatar: Option<AvatarInput>,
) -> Result<(AgentView, Option<Vec<String>>), Box<Response>> {
    let personality = body.personality;
    let (view, left_out) = make_bot(state, body, avatar)?;
    let Some(personality) = personality else {
        return Ok((view, left_out));
    };
    match state
        .engine
        .start_with_personality(&view.agent.id, personality)
    {
        Ok(view) => Ok((view, left_out)),
        Err(error) => Err(Box::new(agent_problem(&error))),
    }
}

/// [`make`] before the person's personality is applied.
fn make_bot(
    state: &AppState,
    body: NewAgent,
    avatar: Option<AvatarInput>,
) -> Result<(AgentView, Option<Vec<String>>), Box<Response>> {
    if let Some(template) = &body.template {
        // A template is ace's own package: it installs the way a package does, linked to it.
        let model = body
            .model
            .clone()
            .or_else(|| crate::teams::template_model(&state.engine, template));
        let choices = crate::teams::TemplateChoices {
            name: body.name.clone(),
            task: body.task.clone(),
            model,
            avatar,
            time_zone: body.time_zone.clone(),
            switches: (!body.switches.is_empty()).then(|| body.switches.clone()),
            start_routines: body.start_routines.unwrap_or(true),
        };
        return match crate::teams::from_template(
            &state.engine,
            state.connectors.as_deref(),
            state.engine.plugins().map(|p| &**p),
            template,
            choices,
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
        naming: body.naming,
    };
    state
        .engine
        .create_agent(input)
        .map(|view| (view, None))
        .map_err(|error| Box::new(agent_problem(&error)))
}

/// Sends a new bot its first message. When Spade refuses it (a storage failure), the bot is deleted again: the person gets both or neither.
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
    if let Err(response) = access(body.access.as_deref()) {
        return *response;
    }
    if let Some(word) = body.may_create_bots.as_deref() {
        let Some(may) = spade_core::made::May::parse(word) else {
            return problem(StatusCode::BAD_REQUEST, "may_create_bots is yes, ask or no");
        };
        if let Err(error) = state.engine.set_may_create(&id, may) {
            return agent_problem(&error);
        }
    }
    if let Some(style) = &body.style
        && let Err(error) = state.engine.set_accent(&id, style.accent.as_deref())
    {
        return agent_problem(&error);
    }
    let change = AgentChange {
        name: body.name,
        task: body.task,
        model: body.model,
        avatar,
        personality: body.personality,
        why: body.task_why,
        by: None,
    };
    let held = change.model.is_some() && state.engine.agent_held_by_terms(&id);
    match state.engine.update_agent(&id, change) {
        Ok(view) => {
            // Picked another model for a bot its subscription's terms held: what waited is
            // answered now (ADR 0205 §4).
            if held && let Err(error) = state.engine.release_terms_hold(&id) {
                tracing::error!(%error, "a bot moved off a refused subscription didn't resume");
            }
            let view = state.engine.agent_view(&id).ok().flatten().unwrap_or(view);
            Json(json!({ "agent": agent_json(&view) })).into_response()
        }
        Err(error) => agent_problem(&error),
    }
}

/// `GET /agents/{id}/task/history`: each version of the bot's task, newest first, with who
/// changed it and why (`by` is `person`, `bot` or empty for one from before task history).
pub(super) async fn task_history(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    off_thread(move || match state.engine.task_history(&id) {
        Ok(versions) => {
            let versions: Vec<Value> = versions
                .into_iter()
                .map(|v| json!({ "seq": v.seq, "at": v.at, "task": v.task, "by": v.by, "why": v.why }))
                .collect();
            Json(json!({ "versions": versions })).into_response()
        }
        Err(error) => agent_problem(&error),
    })
    .await
}

/// `POST /agents/{id}/undo-made`: Undo on a bot another bot made. `{"undone": "removed"}` when
/// nothing it did reached outside it, else `{"undone": "archived"}` (stopped, routines paused).
pub(super) async fn undo_made(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.undo_made(&id).await {
        Ok(undone) => Json(json!({ "undone": undone.name() })).into_response(),
        Err(error) => agent_problem(&error),
    }
}

/// `?workers=stop|keep`: what becomes of a deleted bot's workers (ADR 0161).
#[derive(Deserialize, Default)]
pub(super) struct DeleteQuery {
    #[serde(default)]
    workers: Option<String>,
}

pub(super) async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<DeleteQuery>,
) -> Response {
    let deleted = match query.workers.as_deref() {
        None => state.engine.delete_agent(&id).await,
        Some(word) => match crate::engine::Workers::parse(word) {
            Some(workers) => state.engine.delete_agent_with(&id, workers).await,
            None => return problem(StatusCode::BAD_REQUEST, "workers is stop or keep"),
        },
    };
    if let Err(AgentError::HasWorkers(count)) = &deleted {
        let error = AgentError::HasWorkers(*count).to_string();
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": error, "workers": count })),
        )
            .into_response();
    }
    match deleted {
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

/// Switches Spade, the main agent, on or off on this machine. With `by: "person"` it is the
/// person's own switch; without, the old election's, which a host record overrides (ADR 0187).
pub(super) async fn set_main(State(state): State<AppState>, Body(body): Body<Main>) -> Response {
    let by_person = body.by.as_deref() == Some("person");
    match state.engine.set_main_enabled(body.enabled, by_person) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}
