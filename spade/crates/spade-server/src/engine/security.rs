//! The engine's side of Spade's security boundaries (ADR 0167): the security service the server
//! sets, the tree it reads grants down, and whether a grant covers a call.

use std::sync::Arc;

use serde_json::Value;
use spade_core::effect::{self, Effect, Granted};
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

    /// Which of the effective grants of the bot that owns `conversation` covers the call: a
    /// push or a comment by a grant of its own kind, any other tool by a `tool` grant, and never
    /// a tool that pays, sends, changes access or reads secrets (ADR 0171).
    pub(super) fn granted(
        &self,
        conversation: &str,
        tool: &str,
        arguments: &Value,
        declared: Option<Effect>,
    ) -> Granted {
        let (Some(security), Some(agent)) = (self.security(), self.agent_of(conversation)) else {
            return Granted::No;
        };
        let grants = security.effective_grants(&agent);
        let text = |name: &str| arguments.get(name).and_then(Value::as_str).unwrap_or("");
        let typed = match tool {
            effect::GIT_PUSH => Some(Action::GitPush {
                repo: text("repo"),
                branch: text("branch"),
            }),
            effect::PR_COMMENT => Some(Action::PrComment {
                repo: text("repo"),
                own: false,
            }),
            _ => None,
        };
        if let Some(action) = typed {
            let covered = !text("repo").is_empty() && spade_core::grant::allowed(&grants, &action);
            return if covered { Granted::Typed } else { Granted::No };
        }
        if effect::never_granted(declared).is_some() {
            return Granted::No;
        }
        if spade_core::grant::allowed(&grants, &Action::Tool { tool, arguments }) {
            Granted::Tool
        } else {
            Granted::No
        }
    }

    /// Marks the call `key` to run outside the sandbox: the gate decided so.
    pub(super) fn mark_outside(&self, key: &str) {
        self.outside_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key.to_owned());
    }

    /// Whether the call `key` runs outside the sandbox, taken (each call runs once). A call the
    /// gate didn't mark runs sandboxed, whatever changed since.
    pub(crate) fn runs_outside(&self, key: &str) -> bool {
        self.outside_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key)
    }

    /// What one of `conversation`'s tools declares it does, for a grant being made.
    pub(crate) fn tool_effect(&self, conversation: &str, tool: &str) -> Option<Effect> {
        self.tools
            .get_for(conversation, tool)
            .and_then(|found| found.effect(&Value::Null))
    }

    /// The bot whose workspace `conversation` works in: its own, or a helper's bot's.
    fn workspace_owner(&self, conversation: &str) -> Option<String> {
        self.agent_of(conversation).or_else(|| {
            self.helper_of(conversation)
                .and_then(|helper| self.agent_of(&helper.parent))
        })
    }

    /// Whether a call is held by the bot's boundaries, so it runs without a review: a shell
    /// command the sandbox contains (`shell_contained`) or a file tool's write in the workspace,
    /// once the workspace isn't reserved and a checkpoint (taken now when one is due) can undo
    /// it (ADR 0167 decision 8). When the checkpoint can't be taken, the call is reviewed.
    pub(super) async fn contained_call(
        &self,
        conversation: &str,
        tool: &str,
        shell_contained: bool,
    ) -> bool {
        if !shell_contained && !matches!(tool, "workspace_write" | "workspace_edit") {
            return false;
        }
        let (Some(security), Some(agent)) = (self.security(), self.workspace_owner(conversation))
        else {
            return false;
        };
        if !security.contains() {
            return false;
        }
        let work = security.before_unreviewed(&agent);
        match tokio::task::spawn_blocking(work).await {
            Ok(Ok(())) => true,
            Ok(Err(why)) => {
                tracing::warn!(%why, %agent, "unreviewed work goes to the review instead");
                false
            }
            Err(_) => false,
        }
    }

    /// Waits while `conversation`'s bot's workspace is reserved for maintenance, before a turn
    /// does anything (ADR 0167 decision 8).
    pub(super) async fn maintenance_wait(&self, conversation: &str) {
        let (Some(security), Some(agent)) = (self.security(), self.workspace_owner(conversation))
        else {
            return;
        };
        while security.reserved(&agent) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }
}
