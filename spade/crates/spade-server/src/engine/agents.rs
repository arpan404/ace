//! Agents (ADR 0126, 0127): creating, changing and deleting them, the main agent Spade, and the
//! roster. Each agent has exactly one conversation, which runs like any other.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use spade_core::Event;
use spade_core::autonomy::Access;
use spade_core::event::Known;
use spade_core::face;
use spade_store::{Agent, NewAgent, StoreError};

use super::{AgentChange, AgentError, AgentInput, AgentView, AvatarInput, Engine};

pub const NAME_CHARS: usize = 40;
pub const TASK_CHARS: usize = 4_000;
const MODEL_CHARS: usize = 400;
pub const MAIN: &str = "main";
/// What a bot made from one message is called until it names itself.
pub const UNNAMED: &str = "New bot";
pub const BOT: &str = "bot";
const MAIN_NAME: &str = "Spade";
/// Set while Spade's model is the placeholder it was created with before keys could be read.
const MAIN_PLACEHOLDER: &str = "main_model_placeholder";
/// How long deleting an agent waits for its stopped work to let go.
const LET_GO: Duration = Duration::from_secs(5);

pub(super) fn name(raw: &str) -> Result<String, AgentError> {
    let name = raw.trim();
    let count = name.chars().count();
    if count == 0 || count > NAME_CHARS || name.chars().any(char::is_control) {
        return Err(AgentError::Invalid(format!(
            "the name must be 1 to {NAME_CHARS} characters on one line"
        )));
    }
    Ok(name.to_owned())
}

pub(super) fn task(raw: &str) -> Result<String, AgentError> {
    let task = raw.trim();
    if task.chars().count() > TASK_CHARS {
        return Err(AgentError::Invalid(format!(
            "the task must be at most {TASK_CHARS} characters"
        )));
    }
    Ok(task.to_owned())
}

impl Engine {
    /// Whether a bot could be made or moved to `model` here: one of this machine's endpoints
    /// serves it, or it is a well-formed subscription (ace says at its first turn whether the
    /// CLI is there).
    pub fn model_usable(&self, model: &str) -> bool {
        self.check_model(model).is_ok()
    }

    /// A model reference the person may pick: `endpoint/model` on one of their endpoints, or a
    /// subscription, `cli:<provider>[@<account>]/<model>` (ADR 0133), which ace checks when a turn
    /// runs on it.
    pub(super) fn check_model(&self, raw: &str) -> Result<String, AgentError> {
        let model = raw.trim();
        if spade_core::brain::CliModel::is(model) {
            return spade_core::brain::CliModel::parse(model)
                .map(|_| model.to_owned())
                .ok_or_else(|| {
                    AgentError::Invalid(
                        "a subscription model is cli:<provider>/<model>, for example \
                         cli:codex/gpt-6.1-sol"
                            .to_owned(),
                    )
                });
        }
        let valid = model.len() <= MODEL_CHARS
            && !model.chars().any(char::is_control)
            && model
                .split_once('/')
                .is_some_and(|(e, m)| !e.is_empty() && !m.is_empty());
        if !valid {
            return Err(AgentError::Invalid(
                "the model must be endpoint/model, for example openai/gpt-6.1-sol".to_owned(),
            ));
        }
        let endpoint = model.split_once('/').map_or("", |(e, _)| e);
        if self.retiring(endpoint) {
            return Err(AgentError::Invalid(format!(
                "the endpoint {endpoint} is being deleted"
            )));
        }
        if self.models.endpoint(endpoint).is_none() {
            return Err(AgentError::Invalid(format!(
                "there is no endpoint {endpoint}; add it first"
            )));
        }
        Ok(model.to_owned())
    }

    pub(super) fn avatar(
        &self,
        id: &str,
        input: Option<AvatarInput>,
    ) -> Result<String, AgentError> {
        Ok(match input {
            Some(AvatarInput::Image(bytes)) => {
                let image = self.put_image(&bytes)?;
                json!({ "kind": "image", "sha256": image.sha256 }).to_string()
            }
            Some(AvatarInput::Character(raw)) => face::repair(&raw).to_json().to_string(),
            // Initials from an older client, or nothing: a face seeded by the id, in a colour
            // pair no other agent wears when one is left.
            Some(AvatarInput::Generated) | None => {
                let agents = self.store.agents()?;
                let taken: Vec<&str> = agents
                    .iter()
                    .filter_map(|agent| face::worn_pair(&agent.avatar))
                    .collect();
                face::face_for_id(id, &taken).to_json().to_string()
            }
        })
    }

    /// The id of the agent whose conversation is `conversation`.
    pub(crate) fn agent_of(&self, conversation: &str) -> Option<String> {
        self.store
            .agent_for_conversation(conversation)
            .ok()
            .flatten()
            .map(|agent| agent.id)
    }

    /// Creates a bot and its one conversation.
    pub fn create_agent(&self, input: AgentInput) -> Result<AgentView, AgentError> {
        self.create_agent_with(input, |_| Vec::new())
    }

    /// [`Engine::create_agent`] with the settings `settings` names for the new bot's id stored
    /// in the bot's own transaction: a packaged bot's ceiling is there from its first moment.
    pub fn create_agent_with(
        &self,
        input: AgentInput,
        settings: impl FnOnce(&str) -> Vec<(String, String)>,
    ) -> Result<AgentView, AgentError> {
        let name = if input.naming && input.name.trim().is_empty() {
            UNNAMED.to_owned()
        } else {
            name(&input.name)?
        };
        let task = task(&input.task)?;
        let model = self.check_model(&input.model)?;
        let id = self.ids.next("a");
        let avatar = self.avatar(&id, input.avatar)?;
        let conversation = self.ids.next("c");
        // The task the first turn reads. With none there is nothing to read: the model is named
        // by each `reply_started`.
        let mut configured: Vec<Event> = (!task.is_empty())
            .then(|| {
                Event::Known(Known::AgentConfigured {
                    task: task.clone(),
                    model: model.clone(),
                    personality: None,
                    change: None,
                })
            })
            .into_iter()
            .collect();
        if input.naming {
            configured.push(Event::Known(Known::NamingOpened {}));
        }
        let settings = settings(&id);
        let settings: Vec<(&str, &str)> = settings
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        self.store.create_agent_with(
            NewAgent {
                id: &id,
                kind: BOT,
                name: &name,
                task: &task,
                avatar: &avatar,
                model: &model,
                conversation: &conversation,
            },
            &configured,
            &settings,
            self.now_ms(),
        )?;
        self.view(&id)
    }

    /// Gives a bot just made its personality (a template's, a recipe's or the person's), from its
    /// first turn on.
    pub fn start_with_personality(
        &self,
        id: &str,
        personality: spade_core::personality::Personality,
    ) -> Result<AgentView, AgentError> {
        self.update_agent(
            id,
            AgentChange {
                personality: Some(Some(personality)),
                ..AgentChange::default()
            },
        )
    }

    /// Changes an agent. Name and avatar apply at once; a task or model change is stored as an
    /// event and used from the agent's next turn. Spade's own name and face stay.
    pub fn update_agent(&self, id: &str, change: AgentChange) -> Result<AgentView, AgentError> {
        // Read, merge and write as one, so a concurrent change is never overwritten.
        let _settings = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
        let chooses_model = change.model.is_some();
        let view = self.update_agent_locked(id, change)?;
        if chooses_model && view.agent.kind == MAIN {
            // The person chose Spade's model (the same one counts): setup never replaces it. Only
            // once the change went through, so a refused one leaves the placeholder to correct.
            self.store.set_setting(MAIN_PLACEHOLDER, None)?;
        }
        Ok(view)
    }

    /// [`Engine::update_agent`] with `agent_lock` held.
    fn update_agent_locked(&self, id: &str, change: AgentChange) -> Result<AgentView, AgentError> {
        let agent = self.store.agent(id)?.ok_or(AgentError::NotFound)?;
        if agent.kind == MAIN && (change.name.is_some() || change.avatar.is_some()) {
            return Err(AgentError::Main(
                "Spade's name and face cannot be changed; its task and model can",
            ));
        }
        let new_name = change.name.as_deref().map(name).transpose()?;
        let new_task = change.task.as_deref().map(task).transpose()?;
        let new_model = change
            .model
            .as_deref()
            .map(|m| self.check_model(m))
            .transpose()?;
        let new_avatar = change
            .avatar
            .map(|a| self.avatar(id, Some(a)))
            .transpose()?;
        let by = change.by.unwrap_or(spade_core::self_edit::BY_PERSON);
        if new_name.is_some() || new_avatar.is_some() {
            let name = new_name.as_deref().unwrap_or(&agent.name);
            self.store.set_agent_profile(
                id,
                name,
                new_avatar.as_deref().unwrap_or(&agent.avatar),
                self.now_ms(),
            )?;
            // Kept in the conversation: it closes the bot's own naming, and the chat says when
            // the bot renamed itself.
            let event = Event::Known(Known::ProfileChanged {
                name: name.to_owned(),
                by: by.to_owned(),
                face: new_avatar.is_some(),
            });
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let stored = self
                .store
                .append(&agent.conversation, &event, self.now_ms())?;
            let _ = self
                .live(&agent.conversation)
                .frames
                .send(super::Frame::Stored(stored));
        }
        if let Some(personality) = change.personality
            && personality != agent.personality
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let stored = self
                .store
                .set_agent_personality(id, personality, self.now_ms());
            self.forget_activity(&agent.conversation);
            let stored = stored?;
            let _ = self
                .live(&agent.conversation)
                .frames
                .send(super::Frame::Stored(stored));
        }
        let task = new_task.unwrap_or_else(|| agent.task.clone());
        let model = new_model.unwrap_or_else(|| agent.model.clone());
        if task != agent.task || model != agent.model {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let why = change.why.as_deref().unwrap_or("");
            let recorded = spade_core::self_edit::change(&agent.task, &task, by, why);
            let stored = self
                .store
                .configure_agent(id, &task, &model, recorded, self.now_ms());
            self.forget_activity(&agent.conversation);
            let stored = stored?;
            let _ = self
                .live(&agent.conversation)
                .frames
                .send(super::Frame::Stored(stored));
        }
        self.view(id)
    }

    /// Stops the agent's work, then deletes it with its conversation. Spade cannot be deleted. A
    /// bot with workers is not deleted until the person says what becomes of them
    /// ([`Engine::delete_agent_with`], ADR 0161).
    pub async fn delete_agent(self: &Arc<Self>, id: &str) -> Result<(), AgentError> {
        let agent = self.store.agent(id)?.ok_or(AgentError::NotFound)?;
        if agent.kind == MAIN {
            return Err(AgentError::Main("Spade, the main agent, cannot be deleted"));
        }
        let workers = self.worker_children(&agent.conversation).len();
        if workers > 0 {
            return Err(AgentError::HasWorkers(workers));
        }
        self.delete_agent_now(id).await
    }

    /// [`Engine::delete_agent`] once its workers are dealt with.
    pub(super) async fn delete_agent_now(self: &Arc<Self>, id: &str) -> Result<(), AgentError> {
        let agent = self.store.agent(id)?.ok_or(AgentError::NotFound)?;
        if agent.kind == MAIN {
            return Err(AgentError::Main("Spade, the main agent, cannot be deleted"));
        }
        let conversation = agent.conversation;
        // Its parent's tree notes it gone (ADR 0161).
        self.worker_deleted(&conversation);
        // Marked first, under the lock deliveries take: from here no message or job result is
        // delivered, and no turn or job starts, so stopping drains everything there is.
        let helpers = self.helper_conversations(&conversation);
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let mut deleting = self.deleting.lock().unwrap_or_else(|p| p.into_inner());
            deleting.insert(conversation.clone());
            // Its helpers' conversations go with it (ADR 0152).
            deleting.extend(helpers.iter().cloned());
        }
        if let Err(error) = self.stop(&conversation) {
            tracing::warn!(%error, "deleting an agent: its stop was not stored");
        }
        let live = self.live(&conversation);
        let busy = || {
            live.turn_running.load(std::sync::atomic::Ordering::SeqCst)
                || !live
                    .jobs
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .is_empty()
        };
        let deadline = Instant::now() + LET_GO;
        while Instant::now() < deadline && busy() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Whatever did not let go in time is cancelled, so nothing acts after the delete.
        if let Some(worker) = live.worker.lock().unwrap_or_else(|p| p.into_inner()).take() {
            worker.abort();
        }
        super::jobs::cancel_all(&live);
        self.forget_wakes(&conversation);
        let deleted = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let deleted = self.store.delete_agent(id);
            self.forget_activity(&conversation);
            deleted
        };
        // Its network policies, grants, egress log and checkpoints go with it (ADR 0167).
        if matches!(deleted, Ok(true))
            && let Some(security) = self.security()
        {
            let (security, id) = (security.clone(), id.to_owned());
            let _ = tokio::task::spawn_blocking(move || security.forget(&id)).await;
        }
        self.live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&conversation);
        {
            let mut deleting = self.deleting.lock().unwrap_or_else(|p| p.into_inner());
            deleting.remove(&conversation);
            let mut live = self.live.lock().unwrap_or_else(|p| p.into_inner());
            for helper in &helpers {
                deleting.remove(helper);
                if let Some(gone) = live.remove(helper)
                    && let Some(worker) =
                        gone.worker.lock().unwrap_or_else(|p| p.into_inner()).take()
                {
                    worker.abort();
                }
            }
        }
        deleted?;
        if let Some(plugins) = self.plugins() {
            plugins.forget(id);
        }
        self.bot_left(id)?;
        Ok(())
    }

    /// The roster: Spade first (unless switched off here), then bots by latest activity.
    pub fn agents(&self) -> Result<Vec<AgentView>, StoreError> {
        let enabled = self.main_enabled()?;
        self.store
            .agents()?
            .into_iter()
            .filter(|a| enabled || a.kind != MAIN)
            .map(|agent| self.view_of(agent))
            .collect()
    }

    pub fn agent_view(&self, id: &str) -> Result<Option<AgentView>, StoreError> {
        self.store
            .agent(id)?
            .map(|agent| self.view_of(agent))
            .transpose()
    }

    fn view(&self, id: &str) -> Result<AgentView, AgentError> {
        self.agent_view(id)?.ok_or(AgentError::NotFound)
    }

    fn view_of(&self, agent: Agent) -> Result<AgentView, StoreError> {
        let activity = self.activity(&agent.conversation)?;
        let status = self.status_for(&agent.conversation, &activity);
        let mut oversight = self.oversight_json(&agent)?;
        // Its task (ADR 0144), and its access level: one level since ADR 0163, still shown so a
        // client from before reads it rather than taking a missing one for `ask`.
        if let Some(shown) = oversight.as_object_mut() {
            shown.insert("access".into(), Access::AutoReview.name().into());
            // How it decides (ADR 0163, amendment 2), for its profile and its conversation's head.
            shown.insert("autonomy".into(), self.autonomy_of(&agent.id).name().into());
            // Whether it may make bots, who made it, and whether Undo archived it (ADR 0161,
            // amendment 1).
            for (key, value) in self.made_fields(&agent) {
                shown.insert(key.into(), value);
            }
            // The marketplace recipe it was made from (ADR 0168), for its profile.
            if let Some(recipe) = self.bot_recipe(&agent.id) {
                shown.insert(
                    "from_recipe".into(),
                    serde_json::to_value(&recipe.from_recipe).unwrap_or_default(),
                );
                if let Some(tools) = recipe.tools {
                    shown.insert("tools".into(), tools.into());
                }
            }
            // The package it is linked to (ADR 0200 §3.9), for its profile.
            if let Some(link) = self.bot_package(&agent.id) {
                shown.insert(
                    "package".into(),
                    crate::packages::shown(self, &agent.id, &link),
                );
            }
            shown.insert(
                "task_state".into(),
                serde_json::to_value(&activity.task).unwrap_or_default(),
            );
            shown.insert(
                "task_progress".into(),
                serde_json::to_value(&activity.task_progress).unwrap_or_default(),
            );
            shown.insert(
                "continuing".into(),
                self.continuing(&agent.conversation, activity.continued)
                    .into(),
            );
            // What it sleeps or waits for, and its running services (ADR 0160).
            shown.insert(
                "wake".into(),
                activity
                    .wake
                    .as_ref()
                    .map_or(serde_json::Value::Null, |open| self.wake_json(open)),
            );
            shown.insert("services".into(), activity.services.into());
            // A move to another machine, and what needs the person after one (ADR 0187).
            shown.insert(
                "move".into(),
                self.move_view(&agent.id).unwrap_or(serde_json::Value::Null),
            );
            shown.insert(
                "arrived".into(),
                self.arrival_view(&agent.id)
                    .unwrap_or(serde_json::Value::Null),
            );
            // Its place in a tree (ADR 0161).
            self.tree_fields(&agent.conversation, &activity, shown);
        }
        let seen = self.store.seen(&agent.conversation)?;
        // While it moves its line says where to.
        let status = match self.moving_to(&agent.conversation) {
            Some((_, machine)) => Some(format!("Moving to {machine}")),
            None => status,
        };
        Ok(AgentView {
            oversight,
            seen,
            state: activity.state,
            status,
            last_message: activity.last_message,
            waiting_for: activity.waiting_for,
            questions_for_later: activity.questions_for_later,
            problem: activity.problem,
            agent,
        })
    }

    /// Pins an agent to the top of the person's list, or unpins it. Answers its view, or `None`
    /// for no such agent.
    pub fn pin_agent(&self, id: &str, pinned: bool) -> Result<Option<AgentView>, StoreError> {
        if !self
            .store
            .set_agent_pinned(id, pinned, self.clock.now_ms())?
        {
            return Ok(None);
        }
        self.agent_view(id)
    }

    /// Whether `conversation` is Spade's while Spade is switched off here.
    pub(super) fn disabled_main(&self, conversation: &str) -> Result<bool, StoreError> {
        Ok(self
            .store
            .agent_for_conversation(conversation)?
            .is_some_and(|a| a.kind == MAIN)
            && !self.main_enabled()?)
    }

    /// Creates Spade, the main agent, if this service has none yet. From the database alone (it
    /// runs before Spade listens), so its model is a placeholder setup may correct later.
    pub(super) fn ensure_main(&self) -> Result<(), StoreError> {
        if self.store.agents()?.iter().any(|a| a.kind == MAIN) {
            return Ok(());
        }
        let model = self.keyless_default_model();
        self.store.set_setting(MAIN_PLACEHOLDER, Some("1"))?;
        let (id, conversation) = (self.ids.next("a"), self.ids.next("c"));
        self.store.create_agent(
            NewAgent {
                id: &id,
                kind: MAIN,
                name: MAIN_NAME,
                task: "",
                avatar: r#"{"kind":"spade"}"#,
                model: &model,
                conversation: &conversation,
            },
            &[],
            self.now_ms(),
        )
    }

    /// Gives Spade the person's first usable model (which needs keys to know) if its model is
    /// still the placeholder it was created with and nobody has chosen one since.
    pub(super) fn correct_main_model(&self) -> Result<(), AgentError> {
        if self.store.setting(MAIN_PLACEHOLDER)?.is_none() {
            return Ok(());
        }
        // Read without any lock: it may wait on the keychain.
        let model = self.default_model();
        let _settings = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
        if self.store.setting(MAIN_PLACEHOLDER)?.is_none() {
            return Ok(());
        }
        let main = self.store.agents()?.into_iter().find(|a| a.kind == MAIN);
        if let Some(main) = main
            && main.model != model
            && self.check_model(&model).is_ok()
        {
            self.update_agent_locked(
                &main.id,
                AgentChange {
                    model: Some(model),
                    ..AgentChange::default()
                },
            )?;
        }
        self.store.set_setting(MAIN_PLACEHOLDER, None)?;
        Ok(())
    }

    /// Whether `conversation`'s bot has no model, so nothing could answer it: only once setup is
    /// done, since setup gives Spade the person's first usable model (and while the keychain
    /// keeps setup waiting, a message is still taken, as before setup was split off).
    pub(super) fn lacks_model(&self, conversation: &str) -> bool {
        self.starting().is_none() && self.reply_model(conversation).trim().is_empty()
    }

    /// The model a new reply in `conversation` uses: its agent's model now.
    pub(crate) fn reply_model(&self, conversation: &str) -> String {
        match self.store.agent_for_conversation(conversation) {
            Ok(Some(agent)) if !agent.model.is_empty() => agent.model,
            // Without reading keys: this runs while closing replies at start, before Spade
            // listens.
            _ => self.keyless_default_model(),
        }
    }
}
