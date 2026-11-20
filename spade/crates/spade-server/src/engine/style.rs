//! A bot's accent (ADR 0200 §5.3): one colour for its own marks. Its package's `style.accent`
//! until the person chooses in its profile; their choice, even "its face's colour", wins from
//! then on, through updates of its package. Spade itself has none. Clients check the colour
//! against the live Suit and fall back to the face's pair colour, so nothing here does.

use serde_json::{Value, json};
use spade_store::style_key;

use super::{AgentError, Engine, MAIN};

impl Engine {
    /// The person's accent for `agent`: `Some(hex)`, or `None` for its face's colour.
    pub fn set_accent(&self, agent: &str, accent: Option<&str>) -> Result<(), AgentError> {
        let found = self.store.agent(agent)?.ok_or(AgentError::NotFound)?;
        if found.kind == MAIN {
            return Err(AgentError::Main("Spade has no accent of its own"));
        }
        let accent = accent
            .map(|hex| {
                spade_core::package::manifest::accent(hex.trim()).ok_or_else(|| {
                    AgentError::Invalid("style.accent is one colour, like #2f7bea".into())
                })
            })
            .transpose()?;
        let stored = json!({ "accent": accent }).to_string();
        self.store.set_setting(&style_key(agent), Some(&stored))?;
        Ok(())
    }

    /// What the agent view shows as `style`: the person's choice, else its package's, else none.
    pub(super) fn style_of(&self, agent: &spade_store::Agent) -> Value {
        if agent.kind == MAIN {
            return Value::Null;
        }
        let chosen = self
            .store
            .setting(&style_key(&agent.id))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        if let Some(chosen) = chosen {
            let accent = chosen
                .get("accent")
                .and_then(Value::as_str)
                .and_then(spade_core::package::manifest::accent);
            return json!({ "accent": accent, "chosen": true });
        }
        self.bot_package(&agent.id)
            .and_then(|link| link.manifest.style)
            .map_or(
                Value::Null,
                |style| json!({ "accent": style.accent, "chosen": false }),
            )
    }
}
