// SPDX-License-Identifier: Apache-2.0
//! Session shell settlement (`packages/adapter-acp/src/shell-settlement.ts`).
//!
//! Kept in `session/` (without modifying `translate/`) so `set_root` is exposed and
//! `tool_detail` reads the merged `tool.data` rather than only the incremental update
//! frame (matching `shell-settlement.ts:47`).

use ace_json::{JsString, Map, Value};
use indexmap::{IndexMap, IndexSet};

use crate::translate::data::{js_string, object, string};
use crate::translate::quirks::QuirksKind;
use crate::translate::settlement::{shell_carried_across_turns, shell_survives_prompt};
use crate::translate::tool_text::merge_tool_data;
use crate::translate::tools::{tool_detail, tool_status};

/// Whether a live tool holds the session's next prompt (`shell-settlement.ts:19`).
pub fn holds_next_prompt(prompt_open: bool, of_root: bool, survived_shell: bool) -> bool {
    !prompt_open && of_root && !survived_shell
}

#[derive(Debug, Clone)]
struct NativeTool {
    owner: JsString,
    data: Map,
    status: String,
    shell: bool,
}

fn tool_key(owner: &JsString, id: &JsString) -> String {
    Value::Array(vec![Value::String(owner.clone()), Value::String(id.clone())].into()).to_json()
}

/// Pure native settlement, indexed by live tools rather than prior notifications.
#[derive(Debug)]
pub struct ShellSettlement {
    quirks: QuirksKind,
    tools: IndexMap<String, NativeTool>,
    unsettled: IndexSet<String>,
    carried: IndexSet<String>,
    after_prompt: IndexSet<String>,
    root: JsString,
    prompt_open: bool,
}

impl ShellSettlement {
    pub fn new(quirks: QuirksKind) -> Self {
        Self {
            quirks,
            tools: IndexMap::new(),
            unsettled: IndexSet::new(),
            carried: IndexSet::new(),
            after_prompt: IndexSet::new(),
            root: JsString::default(),
            prompt_open: false,
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
        let mut tool = self.tools.shift_remove(&key).unwrap_or_else(|| NativeTool {
            owner: owner.clone(),
            data: Map::new(),
            status: "pending".to_owned(),
            shell: false,
        });
        merge_tool_data(&mut tool.data, update_val);
        tool.status = tool_status(update_val, &tool.status);
        let merged = Value::Object(tool.data.clone());
        tool.shell = tool_detail(&merged, self.quirks)
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "shell");
        if matches!(
            tool.status.as_str(),
            "succeeded" | "failed" | "cancelled" | "declined"
        ) {
            self.forget(&key);
        } else {
            let survived = self.survived(&key);
            self.tools.insert(key.clone(), tool);
            if holds_next_prompt(self.prompt_open, owner == self.root, survived) {
                self.after_prompt.insert(key);
            }
        }
    }

    pub fn knows(&self, owner: &JsString, id: &JsString) -> bool {
        self.tools.contains_key(&tool_key(owner, id))
    }

    pub fn answered(&mut self, owner: &JsString, id: &JsString, refused: bool) {
        let key = tool_key(owner, id);
        if !self.tools.contains_key(&key) {
            return;
        }
        if refused {
            self.forget(&key);
        } else if let Some(tool) = self.tools.get_mut(&key) {
            tool.status = "running".to_owned();
        }
    }

    pub fn prompt_started(&mut self) {
        self.prompt_open = true;
    }

    /// `reason` is the prompt's stop reason, or `""` when the prompt failed.
    pub fn prompt_ended(&mut self, owner: &JsString, reason: &str) {
        self.prompt_open = false;
        let keys: Vec<String> = self.tools.keys().cloned().collect();
        for key in keys {
            if self.carried.contains(&key) {
                continue;
            }
            let Some(tool) = self.tools.get(&key) else {
                continue;
            };
            if tool.owner != *owner && reason != "cancelled" {
                continue;
            }
            if tool.shell
                && shell_carried_across_turns(self.quirks.provider(), reason, &tool.status)
            {
                self.carried.insert(key);
            } else if tool.shell
                && shell_survives_prompt(self.quirks.provider(), reason, &tool.status)
            {
                self.unsettled.insert(key);
            } else if !self.unsettled.contains(&key) {
                self.tools.shift_remove(&key);
            }
        }
    }

    fn forget(&mut self, key: &str) {
        self.tools.shift_remove(key);
        self.unsettled.shift_remove(key);
        self.carried.shift_remove(key);
        self.after_prompt.shift_remove(key);
    }

    pub fn survived(&self, key: &str) -> bool {
        self.unsettled.contains(key) || self.carried.contains(key)
    }

    /// A shell outlived its prompt with no proof it ended: new input is refused (ADR 0109).
    pub fn blocked(&self) -> bool {
        !self.unsettled.is_empty()
    }

    /// Work the agent does after its prompt answered: new input waits for it, never refused.
    pub fn busy(&self) -> bool {
        !self.after_prompt.is_empty()
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
