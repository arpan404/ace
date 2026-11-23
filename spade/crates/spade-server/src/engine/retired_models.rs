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
    /// route, the global `main` route, the person's model for new bots and `fallbacks` that is on
    /// their endpoints and can run a bot (it calls tools, ADR 0205 §3); `""` when none is.
    pub(crate) fn replacement_model(&self, agent: &str, fallbacks: &[String]) -> String {
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
        if let Ok(Some(model)) = self.new_bot_model() {
            choices.push(model);
        }
        choices.extend_from_slice(fallbacks);
        choices
            .into_iter()
            .find(|model| {
                !model.is_empty()
                    && !is_retired(model)
                    && self.configured(model)
                    && self.check_runs_bots(model).is_ok()
            })
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
        // Read without any lock: it may wait on the keychain. A model whose key isn't known to be
        // there still beats none while the person has endpoints: its first turn says what's
        // missing, where "Pick a model" would be wrong.
        let to = self.replacement_model(
            &agent.id,
            &[self.default_model(), self.keyless_default_model()],
        );
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
        let replaced = Event::Known(Known::ModelReplaced {
            from: agent.model.clone(),
            to: to.clone(),
            line,
        });
        // The change and its line in one write: a crash keeps both or neither.
        let stored = self.store.configure_agent_then(
            &agent.id,
            &agent.task,
            &to,
            std::slice::from_ref(&replaced),
            self.now_ms(),
        );
        self.forget_activity(&agent.conversation);
        let frames = &self.live(&agent.conversation).frames;
        for event in stored? {
            let _ = frames.send(super::Frame::Stored(event));
        }
        Ok(())
    }
}
