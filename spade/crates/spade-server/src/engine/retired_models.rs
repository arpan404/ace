//! Bots whose model was a coding subscription (`cli:<provider>[@<account>]/<model>`, ADR 0133).
//! Bots no longer think with subscriptions (ADR 0219): such a bot thinks with the person's
//! default model (ADR 0205 §1: its `main` route, else the global one, then the first usable
//! model), and once, at setup, its stored model is moved there with one line in its chat. With
//! no model to move to it waits for the person, as a new bot does. Only bots' settings change;
//! the history keeps its old references and reads as before.

use spade_core::event::{Event, Known};
use spade_core::routing::{Overrides, Role};
use spade_store::{Agent, MODEL_ROLES, StoreError, roles_key};

use super::Engine;

/// Every subscription reference began with this.
const PREFIX: &str = "cli:";

/// Whether `model` is a subscription reference from before ADR 0219.
pub(crate) fn is_retired(model: &str) -> bool {
    model.trim().starts_with(PREFIX)
}

/// The subscription's name as people know it, from its reference.
fn subscription_name(model: &str) -> &'static str {
    let provider = model
        .trim()
        .trim_start_matches(PREFIX)
        .split(['@', '/'])
        .next()
        .unwrap_or_default();
    match provider {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "cursor" => "Cursor",
        "antigravity" => "Antigravity",
        "pi" => "Pi",
        _ => "coding",
    }
}

impl Engine {
    /// The model a bot whose own model is a subscription thinks with: the first of its `main`
    /// route, the global `main` route and `fallback` that is on the person's endpoints; `""` when
    /// none is.
    pub(crate) fn replacement_model(&self, agent: &str, fallback: String) -> String {
        let mut choices: Vec<String> = Vec::new();
        for key in [roles_key(agent), MODEL_ROLES.to_owned()] {
            let overrides: Overrides = self
                .store
                .setting(&key)
                .ok()
                .flatten()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default();
            if let Some(route) = overrides.roles.get(&Role::Main) {
                choices.extend(route.0.iter().cloned());
            }
        }
        choices.push(fallback);
        choices
            .into_iter()
            .find(|model| !model.is_empty() && !is_retired(model) && self.configured(model))
            .unwrap_or_default()
    }

    /// Moves every bot still on a subscription to its replacement, with its chat's line. Bounded
    /// by the number of bots, never by history; run by setup, which may read keys.
    pub(super) fn retire_subscription_models(&self) -> Result<(), StoreError> {
        for agent in self.store.agents()? {
            if is_retired(&agent.model) {
                self.retire_one(&agent)?;
            }
        }
        Ok(())
    }

    fn retire_one(&self, agent: &Agent) -> Result<(), StoreError> {
        // Read without any lock: it may wait on the keychain.
        let to = self.replacement_model(&agent.id, self.default_model());
        let _settings = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
        // The person may have picked a model meanwhile.
        let Some(agent) = self.store.agent(&agent.id)? else {
            return Ok(());
        };
        if !is_retired(&agent.model) {
            return Ok(());
        }
        let line = if to.is_empty() {
            format!(
                "Spade bots no longer think with coding subscriptions, so this bot's {} model was \
                 removed. Pick a model for it to carry on.",
                subscription_name(&agent.model)
            )
        } else {
            format!(
                "Spade bots no longer think with coding subscriptions, so this bot moved from its \
                 {} model to {}.",
                subscription_name(&agent.model),
                self.model_name(&to)
            )
        };
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let now = self.now_ms();
        let configured = self
            .store
            .configure_agent(&agent.id, &agent.task, &to, None, now);
        self.forget_activity(&agent.conversation);
        let configured = configured?;
        let replaced = Event::Known(Known::ModelReplaced {
            from: agent.model.clone(),
            to,
            line,
        });
        let replaced = self.store.append(&agent.conversation, &replaced, now);
        self.forget_activity(&agent.conversation);
        let replaced = replaced?;
        let frames = &self.live(&agent.conversation).frames;
        let _ = frames.send(super::Frame::Stored(configured));
        let _ = frames.send(super::Frame::Stored(replaced));
        Ok(())
    }
}
