// SPDX-License-Identifier: Apache-2.0
//! The session's shell settlement (`packages/adapter-acp/src/shell-settlement.ts`).
//!
//! Every rule lives in the translator's pure settlement (`translate::shell_settlement`),
//! which `translate/` owns. This adds only what a session has and the translator does
//! not: the root id it hands that settlement as soon as it is known, and `JsString`
//! owners. The pure settlement keeps the merged tool data itself, so a notification is
//! read where it arrived (`shell-settlement.ts:40`).

use ace_json::{JsString, Value};

use crate::translate::quirks::QuirksKind;
use crate::translate::shell_settlement::ShellSettlement as PureSettlement;
pub use crate::translate::shell_settlement::holds_next_prompt;

/// Settlement over live tools, rooted at this session (`shell-settlement.ts:16`).
pub struct ShellSettlement {
    settlement: PureSettlement,
    root: JsString,
}

impl ShellSettlement {
    pub fn new(quirks: QuirksKind) -> Self {
        Self {
            settlement: PureSettlement::new(quirks),
            root: JsString::default(),
        }
    }

    /// The session's root, once `session/new` names it. Tools already reported keep the
    /// owner the agent gave them, so the root's earlier work still matches.
    pub fn set_root(&mut self, root: JsString) {
        self.settlement.set_root(root.as_str());
        self.root = root;
    }

    pub fn root(&self) -> &JsString {
        &self.root
    }

    pub fn receive(&mut self, params: &Value) {
        self.settlement.receive(params);
    }

    pub fn knows(&self, owner: &JsString, id: &JsString) -> bool {
        self.settlement.knows(owner.as_str(), id.as_str())
    }

    /// The person answered (or ace cancelled) the request for a tool: a refusal settles
    /// it, an allow starts it (`shell-settlement.ts:77`).
    pub fn answered(&mut self, owner: &JsString, id: &JsString, refused: bool) {
        self.settlement
            .answered(owner.as_str(), id.as_str(), refused);
    }

    pub fn prompt_started(&mut self) {
        self.settlement.prompt_started();
    }

    /// `reason` is the prompt's stop reason, or `""` when the prompt failed.
    pub fn prompt_ended(&mut self, owner: &JsString, reason: &str) {
        self.settlement.prompt_ended(owner.as_str(), reason);
    }

    pub fn survived(&self, key: &str) -> bool {
        self.settlement.survived(key)
    }

    /// A shell outlived its prompt with no proof it ended: new input is refused (ADR 0109).
    pub fn blocked(&self) -> bool {
        self.settlement.blocked()
    }

    /// Work the agent does after its prompt answered: new input waits for it, never refused.
    pub fn busy(&self) -> bool {
        self.settlement.busy()
    }
}

#[cfg(test)]
mod tests {
    use super::ShellSettlement;
    use crate::translate::quirks::QuirksKind;
    use ace_json::{JsString, json};

    #[test]
    fn tool_call_update_without_kind_keeps_shell_classification_and_blocks_after_cancel() {
        let mut shells = ShellSettlement::new(QuirksKind::Generic);
        shells.set_root(JsString::from("root"));
        shells.prompt_started();
        shells.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "sh-1", "kind": "execute", "status": "pending" }
        }));
        // Follow-up update omits `kind`, only moves to `in_progress`.
        shells.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "tool_call_update", "toolCallId": "sh-1", "status": "in_progress" }
        }));
        shells.prompt_ended(&JsString::from("root"), "cancelled");
        assert!(
            shells.blocked(),
            "running shell surviving cancel must block"
        );

        shells.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "tool_call_update", "toolCallId": "sh-1", "status": "completed" }
        }));
        assert!(!shells.blocked());
    }

    #[test]
    fn antigravity_running_shell_carries_across_turns_without_blocking() {
        let mut shells = ShellSettlement::new(QuirksKind::Antigravity);
        shells.set_root(JsString::from("root"));
        shells.prompt_started();
        shells.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "sh-ag", "name": "run_command", "status": "in_progress" }
        }));
        shells.prompt_ended(&JsString::from("root"), "end_turn");
        assert!(!shells.blocked());
        assert!(!shells.busy());
        assert!(shells.knows(&JsString::from("root"), &JsString::from("sh-ag")));
    }

    #[test]
    fn a_root_tool_reported_before_the_root_is_named_settles_after_it() {
        let mut shells = ShellSettlement::new(QuirksKind::Generic);
        // Antigravity names the session in an update before `session/new` answers
        // (`session.ts:222`), and reports a shell there.
        shells.receive(&json!({
            "sessionId": "agy-1",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "sh-early", "kind": "execute", "status": "in_progress" }
        }));
        shells.set_root(JsString::from("agy-1"));
        shells.receive(&json!({
            "sessionId": "agy-1",
            "update": { "sessionUpdate": "tool_call_update", "toolCallId": "sh-early", "status": "completed" }
        }));
        assert!(
            !shells.knows(&JsString::from("agy-1"), &JsString::from("sh-early")),
            "the update found the tool it first reported"
        );
        // A cancelled prompt has nothing left to cancel: the early tool was that one.
        shells.prompt_started();
        shells.prompt_ended(&JsString::from("agy-1"), "cancelled");
        assert!(!shells.blocked());
    }

    #[test]
    fn an_owner_of_the_empty_string_is_not_root_work() {
        let mut shells = ShellSettlement::new(QuirksKind::Generic);
        shells.set_root(JsString::from("sess-1"));
        shells.receive(&json!({
            "sessionId": "",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "anon-1", "kind": "read", "status": "in_progress" }
        }));
        assert!(shells.knows(&JsString::default(), &JsString::from("anon-1")));
        assert!(
            !shells.busy(),
            "only the root's work with no prompt open holds the next prompt"
        );
    }

    #[test]
    fn post_prompt_root_tool_marks_session_busy_until_completed() {
        let mut shells = ShellSettlement::new(QuirksKind::Generic);
        shells.set_root(JsString::from("root"));
        shells.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "t1", "kind": "read", "status": "in_progress" }
        }));
        assert!(shells.busy());
        shells.answered(&JsString::from("root"), &JsString::from("t1"), true);
        assert!(!shells.busy());
    }
}
