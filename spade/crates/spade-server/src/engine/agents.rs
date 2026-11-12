//! Agents (ADR 0126, 0127): creating, changing and deleting them, the main agent Spade, and the
//! roster. Each agent has exactly one conversation, which runs like any other.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use spade_core::Event;
use spade_core::event::Known;
use spade_store::{AVATAR_COLORS, Agent, NewAgent, StoreError, generated_color};

use super::{AgentChange, AgentError, AgentInput, AgentView, AvatarInput, Engine};

pub const NAME_CHARS: usize = 40;
pub const TASK_CHARS: usize = 4_000;
const MODEL_CHARS: usize = 400;
pub const MAIN: &str = "main";
pub const BOT: &str = "bot";
const MAIN_NAME: &str = "Spade";
const MAIN_ENABLED: &str = "main_enabled";
/// Set while Spade's model is the placeholder it was created with before keys could be read.
const MAIN_PLACEHOLDER: &str = "main_model_placeholder";
/// How long deleting an agent waits for its stopped work to let go.
const LET_GO: Duration = Duration::from_secs(5);

fn name(raw: &str) -> Result<String, AgentError> {
    let name = raw.trim();
    let count = name.chars().count();
    if count == 0 || count > NAME_CHARS || name.chars().any(char::is_control) {
        return Err(AgentError::Invalid(format!(
            "the name must be 1 to {NAME_CHARS} characters on one line"
        )));
    }
    Ok(name.to_owned())
}

fn task(raw: &str) -> Result<String, AgentError> {
    let task = raw.trim();
    if task.chars().count() > TASK_CHARS {
        return Err(AgentError::Invalid(format!(
            "the task must be at most {TASK_CHARS} characters"
        )));
    }
    Ok(task.to_owned())
}

impl Engine {
    /// A model reference the person may pick: `endpoint/model` on one of their endpoints.
    /// Whether a bot could be made or moved to `model` here: one of this machine's endpoints
    /// serves it.
    pub fn model_usable(&self, model: &str) -> bool {
        self.check_model(model).is_ok()
    }

    pub(super) fn check_model(&self, raw: &str) -> Result<String, AgentError> {
        let model = raw.trim();
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

    fn avatar(&self, id: &str, input: Option<AvatarInput>) -> Result<String, AgentError> {
        Ok(match input {
            Some(AvatarInput::Image(bytes)) => {
                let image = self.images.put(&bytes)?;
                json!({ "kind": "image", "sha256": image.sha256 }).to_string()
            }
            Some(AvatarInput::Generated(Some(color))) => {
                if !AVATAR_COLORS.contains(&color.as_str()) {
                    return Err(AgentError::Invalid(format!(
                        "the colour must be one of {}",
                        AVATAR_COLORS.join(", ")
                    )));
                }
                json!({ "kind": "generated", "color": color }).to_string()
            }
            Some(AvatarInput::Generated(None)) | None => {
                json!({ "kind": "generated", "color": generated_color(id) }).to_string()
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
        let name = name(&input.name)?;
        let task = task(&input.task)?;
        let model = self.check_model(&input.model)?;
        let id = self.ids.next("a");
        let avatar = self.avatar(&id, input.avatar)?;
        let conversation = self.ids.next("c");
        // The task the first turn reads. With none there is nothing to read: the model is named
        // by each `reply_started`.
        let configured: Vec<Event> = (!task.is_empty())
            .then(|| {
                Event::Known(Known::AgentConfigured {
                    task: task.clone(),
                    model: model.clone(),
                })
            })
            .into_iter()
            .collect();
        self.store.create_agent(
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
            self.now_ms(),
        )?;
        self.view(&id)
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
        if new_name.is_some() || new_avatar.is_some() {
            self.store.set_agent_profile(
                id,
                new_name.as_deref().unwrap_or(&agent.name),
                new_avatar.as_deref().unwrap_or(&agent.avatar),
                self.now_ms(),
            )?;
        }
        let task = new_task.unwrap_or_else(|| agent.task.clone());
        let model = new_model.unwrap_or_else(|| agent.model.clone());
        if task != agent.task || model != agent.model {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let stored = self.store.configure_agent(id, &task, &model, self.now_ms());
            self.forget_activity(&agent.conversation);
            let stored = stored?;
            let _ = self
                .live(&agent.conversation)
                .frames
                .send(super::Frame::Stored(stored));
        }
        self.view(id)
    }

    /// Stops the agent's work, then deletes it with its conversation. Spade cannot be deleted.
    pub async fn delete_agent(self: &Arc<Self>, id: &str) -> Result<(), AgentError> {
        let agent = self.store.agent(id)?.ok_or(AgentError::NotFound)?;
        if agent.kind == MAIN {
            return Err(AgentError::Main("Spade, the main agent, cannot be deleted"));
        }
        let conversation = agent.conversation;
        // Marked first, under the lock deliveries take: from here no message or job result is
        // delivered, and no turn or job starts, so stopping drains everything there is.
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            self.deleting
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(conversation.clone());
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
        let deleted = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let deleted = self.store.delete_agent(id);
            self.forget_activity(&conversation);
            deleted
        };
        self.live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&conversation);
        self.deleting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&conversation);
        deleted?;
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
        let oversight = self.oversight_json(&agent)?;
        Ok(AgentView {
            oversight,
            state: activity.state,
            status,
            last_message: activity.last_message,
            waiting_for: activity.waiting_for,
            agent,
        })
    }

    /// Whether the main agent runs on this machine (ADR 0127: the app picks one machine).
    pub fn main_enabled(&self) -> Result<bool, StoreError> {
        Ok(self.store.setting(MAIN_ENABLED)?.as_deref() != Some("false"))
    }

    pub fn set_main_enabled(&self, enabled: bool) -> Result<(), StoreError> {
        self.store
            .set_setting(MAIN_ENABLED, (!enabled).then_some("false"))
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

    /// The model a new reply in `conversation` uses: its agent's model now.
    pub(super) fn reply_model(&self, conversation: &str) -> String {
        match self.store.agent_for_conversation(conversation) {
            Ok(Some(agent)) if !agent.model.is_empty() => agent.model,
            // Without reading keys: this runs while closing replies at start, before Spade
            // listens.
            _ => self.keyless_default_model(),
        }
    }
}
