//! A bot changing itself (spade/docs/agents.md, "A bot's task over time"): `task_update` rewrites
//! its standing task, `profile_update` its name and face. Whether a call runs or goes to the
//! person is `spade_core::self_edit::route`, decided before the call gets here; these only apply
//! what was allowed, through the same change the person's profile makes.

use serde::Deserialize;
use serde_json::Value;
use spade_core::self_edit::{BY_BOT, Version};

use super::{AgentChange, AgentError, AvatarInput, Engine};
use crate::tools::ToolOutput;

/// The most a `why` keeps: one line.
const WHY_CHARS: usize = 200;

#[derive(Deserialize)]
struct TaskUpdate {
    new_task: String,
    #[serde(default)]
    why: String,
}

#[derive(Deserialize)]
struct ProfileUpdate {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    face: Option<Value>,
}

/// One line, at most [`WHY_CHARS`] characters.
fn one_line(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty());
    line.unwrap_or("").chars().take(WHY_CHARS).collect()
}

fn refused(error: &AgentError) -> ToolOutput {
    ToolOutput::error(match error {
        AgentError::Main(why) => (*why).to_owned(),
        other => other.to_string(),
    })
}

impl Engine {
    /// `task_update` from `conversation`: the bot's task becomes `new_task` from its next turn,
    /// recorded as the bot's change with its `why`.
    pub(crate) fn bot_task_update(&self, conversation: &str, arguments: Value) -> ToolOutput {
        let Ok(update) = serde_json::from_value::<TaskUpdate>(arguments) else {
            return ToolOutput::error("task_update takes new_task (the whole task) and why.");
        };
        let Some(id) = self.agent_of(conversation) else {
            return ToolOutput::error("Only a bot's own conversation has a task to update.");
        };
        let task = update.new_task.trim();
        if task.is_empty() {
            return ToolOutput::error("The new task is empty; say the whole task.");
        }
        match self.store.agent(&id) {
            Ok(Some(agent)) if agent.task.trim() == task => {
                return ToolOutput::ok("Your task already says that; nothing changed.");
            }
            Ok(Some(_)) => {}
            Ok(None) => return ToolOutput::error("This bot is gone."),
            Err(error) => return ToolOutput::error(error.to_string()),
        }
        let change = AgentChange {
            task: Some(task.to_owned()),
            why: Some(one_line(&update.why)),
            by: Some(BY_BOT),
            ..AgentChange::default()
        };
        match self.update_agent(&id, change) {
            Ok(_) => ToolOutput::ok(
                "Updated your task. It applies from your next turn; the person sees the change \
                 in the chat and can undo it.",
            ),
            Err(error) => refused(&error),
        }
    }

    /// `profile_update` from `conversation`: the bot's new name, face or both.
    pub(crate) fn bot_profile_update(&self, conversation: &str, arguments: Value) -> ToolOutput {
        let Ok(update) = serde_json::from_value::<ProfileUpdate>(arguments) else {
            return ToolOutput::error("profile_update takes a name, a face or both.");
        };
        let Some(id) = self.agent_of(conversation) else {
            return ToolOutput::error("Only a bot's own conversation can change its name.");
        };
        let name = update
            .name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        let face = update.face.filter(Value::is_object);
        if name.is_none() && face.is_none() {
            return ToolOutput::error("Give a name, a face or both.");
        }
        let said = match (&name, &face) {
            (Some(name), Some(_)) => format!("You are {name} now, with your new face."),
            (Some(name), None) => format!("You are {name} now."),
            (None, _) => "Your face changed.".to_owned(),
        };
        let change = AgentChange {
            name,
            avatar: face.map(AvatarInput::Character),
            by: Some(BY_BOT),
            ..AgentChange::default()
        };
        match self.update_agent(&id, change) {
            Ok(_) => ToolOutput::ok(said),
            Err(error) => refused(&error),
        }
    }

    /// The versions of agent `id`'s task, newest first.
    pub fn task_history(&self, id: &str) -> Result<Vec<Version>, AgentError> {
        let agent = self.store.agent(id)?.ok_or(AgentError::NotFound)?;
        let events = self.store.task_events(&agent.conversation)?;
        Ok(spade_core::self_edit::history(events.iter().map(|e| {
            (u64::try_from(e.seq).unwrap_or_default(), e.at_ms, &e.event)
        })))
    }
}
