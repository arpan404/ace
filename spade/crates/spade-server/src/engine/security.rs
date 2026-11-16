//! The engine's side of Spade's security boundaries (ADR 0167): the security service the server
//! sets, the tree it reads grants down, and whether a grant covers a call.

use std::sync::Arc;

use serde_json::Value;
use spade_core::grant::Action;

use super::Engine;
use crate::security::Security;

impl Engine {
    /// Sets the security service, once.
    pub fn set_security(&self, security: Arc<Security>) {
        let _ = self.security.set(security);
    }

    pub(crate) fn security(&self) -> Option<&Arc<Security>> {
        self.security.get()
    }

    /// `agent`'s parent bot, grandparent and so on, nearest first: the bots a worker's grants
    /// are narrowed by (ADR 0161, ADR 0167 decision 5).
    pub(crate) fn agent_ancestors(&self, agent: &str) -> Vec<String> {
        let Ok(Some(view)) = self.agent_view(agent) else {
            return Vec::new();
        };
        let mut conversations = vec![view.agent.conversation.clone()];
        conversations.extend(self.worker_ancestors(&view.agent.conversation));
        conversations
            .iter()
            .skip(1)
            .filter_map(|conversation| self.agent_of(conversation))
            .collect()
    }

    /// Whether one of the effective grants of the bot that owns `conversation` covers calling
    /// `tool` with `arguments`.
    pub(super) fn granted(&self, conversation: &str, tool: &str, arguments: &Value) -> bool {
        let (Some(security), Some(agent)) = (self.security(), self.agent_of(conversation)) else {
            return false;
        };
        let grants = security.effective_grants(&agent);
        spade_core::grant::allowed(&grants, &Action::Tool { tool, arguments })
    }
}
