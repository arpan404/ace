// SPDX-License-Identifier: Apache-2.0
//! Pure native settlement (`shell-settlement.ts`).

use crate::translate::quirks::QuirksKind;
use crate::translate::settlement::{shell_carried_across_turns, shell_survives_prompt};
use crate::translate::tool_text::merge_tool_data;
use crate::translate::tools::{tool_detail, tool_status};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Whether a live tool holds the session's next prompt.
pub fn holds_next_prompt(prompt_open: bool, of_root: bool, survived_shell: bool) -> bool {
    !prompt_open && of_root && !survived_shell
}

#[derive(Debug, Clone)]
struct NativeTool {
    owner: String,
    data: Map<String, Value>,
    status: String,
    shell: bool,
}

/// Pure native settlement, indexed by live tools rather than notifications.
pub struct ShellSettlement {
    quirks: QuirksKind,
    tools: HashMap<String, NativeTool>,
    unsettled: HashSet<String>,
    carried: HashSet<String>,
    after_prompt: HashSet<String>,
    root: String,
    prompt_open: bool,
}

impl ShellSettlement {
    pub fn new(quirks: QuirksKind) -> Self {
        Self {
            quirks,
            tools: HashMap::new(),
            unsettled: HashSet::new(),
            carried: HashSet::new(),
            after_prompt: HashSet::new(),
            root: String::new(),
            prompt_open: false,
        }
    }

    fn tool_key(owner: &str, id: &str) -> String {
        serde_json::to_string(&(owner, id)).unwrap_or_default()
    }

    pub fn receive(&mut self, params: &Value) {
        let params_map = params.as_object();
        let Some(params_map) = params_map else {
            return;
        };
        let update = params_map
            .get("update")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let update_value = Value::Object(update.clone());
        let session_update = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        if session_update != "tool_call" && session_update != "tool_call_update" {
            return;
        }
        let owner = params_map
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let id = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if id.is_empty() {
            return;
        }
        let key = Self::tool_key(&owner, &id);
        let mut tool = self.tools.remove(&key).unwrap_or(NativeTool {
            owner: owner.clone(),
            data: Map::new(),
            status: "pending".to_owned(),
            shell: false,
        });
        tool.owner = owner.clone();
        merge_tool_data(&mut tool.data, &update_value);
        tool.status = tool_status(&update_value, &tool.status);
        let detail = tool_detail(&update_value, self.quirks);
        tool.shell = detail
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "shell");
        if ["succeeded", "failed", "cancelled", "declined"].contains(&tool.status.as_str()) {
            self.forget(&key);
        } else {
            let survived = self.survived(&key);
            self.tools.insert(key.clone(), tool);
            if holds_next_prompt(self.prompt_open, owner == self.root, survived) {
                self.after_prompt.insert(key);
            }
        }
    }

    pub fn knows(&self, owner: &str, id: &str) -> bool {
        self.tools.contains_key(&Self::tool_key(owner, id))
    }

    pub fn answered(&mut self, owner: &str, id: &str, refused: bool) {
        let key = Self::tool_key(owner, id);
        if refused {
            self.forget(&key);
            return;
        }
        if let Some(tool) = self.tools.get_mut(&key) {
            tool.status = "running".to_owned();
        }
    }

    pub fn prompt_started(&mut self) {
        self.prompt_open = true;
    }

    pub fn prompt_ended(&mut self, owner: &str, reason: &str) {
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
                self.tools.remove(&key);
            }
        }
    }

    fn forget(&mut self, key: &str) {
        self.tools.remove(key);
        self.unsettled.remove(key);
        self.carried.remove(key);
        self.after_prompt.remove(key);
    }

    pub fn survived(&self, key: &str) -> bool {
        self.unsettled.contains(key) || self.carried.contains(key)
    }

    pub fn blocked(&self) -> bool {
        !self.unsettled.is_empty()
    }

    pub fn busy(&self) -> bool {
        !self.after_prompt.is_empty()
    }
}
