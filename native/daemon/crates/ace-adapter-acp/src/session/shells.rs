// SPDX-License-Identifier: Apache-2.0
//! The session's shell settlement (`packages/adapter-acp/src/shell-settlement.ts`).
//!
//! Every rule lives in the translator's pure settlement (`translate::shell_settlement`),
//! which `translate/` owns. This adds only what a session has and the translator does
//! not: the root it compares tools against (the translator's root is empty and it has no
//! setter), the merged tool data a follow-up update omits -- `tool_detail` reads the
//! merged tool there (`shell-settlement.ts:41`) -- and `JsString` owners.

use ace_json::{JsString, Map, Value};
use indexmap::IndexMap;

use crate::translate::data::{js_string, object, string};
use crate::translate::quirks::QuirksKind;
use crate::translate::shell_settlement::ShellSettlement as PureSettlement;
pub use crate::translate::shell_settlement::holds_next_prompt;
use crate::translate::tool_text::merge_tool_data;

/// Settlement over live tools, rooted at this session (`shell-settlement.ts:16`).
pub struct ShellSettlement {
    settlement: PureSettlement,
    /// Merged tool data per key, so an update that omits `kind` keeps its class.
    data: IndexMap<String, Map>,
    root: JsString,
}

impl ShellSettlement {
    pub fn new(quirks: QuirksKind) -> Self {
        Self {
            settlement: PureSettlement::new(quirks),
            data: IndexMap::new(),
            root: JsString::default(),
        }
    }

    pub fn set_root(&mut self, root: JsString) {
        self.root = root;
    }

    pub fn root(&self) -> &JsString {
        &self.root
    }

    pub fn receive(&mut self, params: &Value) {
        let params_map = object(params);
        let update_val = params_map.get("update").unwrap_or(&Value::Null);
        let update = object(update_val);
        let session_update = string(update.get("sessionUpdate").unwrap_or(&Value::Null));
        if !matches!(session_update, "tool_call" | "tool_call_update") {
            return;
        }
        let owner = js_string(params_map.get("sessionId").unwrap_or(&Value::Null))
            .cloned()
            .unwrap_or_default();
        let id = js_string(update.get("toolCallId").unwrap_or(&Value::Null))
            .cloned()
            .unwrap_or_default();
        if id.is_empty() {
            return;
        }
        let key = tool_key(&owner, &id);
        let mut merged = self.data.get(&key).cloned().unwrap_or_default();
        merge_tool_data(&mut merged, update_val);
        let owner = self.masked(&owner);
        // The update as the translator reads it: this update's own fields, over the tool
        // data merged so far, so a follow-up that omits `kind` keeps its class.
        let mut forwarded_update = update.clone();
        for (field, value) in merged.iter() {
            forwarded_update.insert(field.clone(), value.clone());
        }
        let mut forwarded = Map::with_capacity(2);
        forwarded.insert("sessionId", Value::String(owner.clone()));
        forwarded.insert("update", Value::Object(forwarded_update));
        self.settlement.receive(&Value::Object(forwarded));
        if self.settlement.knows(owner.as_str(), id.as_str()) {
            self.data.insert(key, merged);
        } else {
            // A terminal status settled the tool: its data has no reader now.
            self.data.shift_remove(&key);
        }
    }

    pub fn knows(&self, owner: &JsString, id: &JsString) -> bool {
        self.settlement
            .knows(self.masked(owner).as_str(), id.as_str())
    }

    /// The person answered (or ace cancelled) the request for a tool: a refusal settles
    /// it, an allow starts it (`shell-settlement.ts:77`).
    pub fn answered(&mut self, owner: &JsString, id: &JsString, refused: bool) {
        self.settlement
            .answered(self.masked(owner).as_str(), id.as_str(), refused);
    }

    pub fn prompt_started(&mut self) {
        self.settlement.prompt_started();
    }

    /// `reason` is the prompt's stop reason, or `""` when the prompt failed.
    pub fn prompt_ended(&mut self, owner: &JsString, reason: &str) {
        self.settlement
            .prompt_ended(self.masked(owner).as_str(), reason);
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

    /// The settlement's root is empty once, at construction, so this session's root is
    /// the only owner it compares as "" and every other owner passes through unchanged.
    fn masked(&self, owner: &JsString) -> JsString {
        if *owner == self.root {
            JsString::default()
        } else {
            owner.clone()
        }
    }
}

fn tool_key(owner: &JsString, id: &JsString) -> String {
    Value::Array(vec![Value::String(owner.clone()), Value::String(id.clone())].into()).to_json()
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
