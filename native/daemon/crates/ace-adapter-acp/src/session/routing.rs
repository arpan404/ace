// SPDX-License-Identifier: Apache-2.0
//! Session subagent and tool-owner routing (`packages/adapter-acp/src/session-routing.ts`).

use std::collections::VecDeque;

use ace_json::{JsString, Value};
use indexmap::{IndexMap, IndexSet};

use crate::translate::association::child_association;
use crate::translate::data::{js_string, object, string};
use crate::translate::keys::native_agent_key;

const TOOL_OWNER_LIMIT: usize = 4096;
const COMPLETED_TOOLS_LIMIT: usize = 4096;

/// One child session tracked by [`SessionRouting`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Child {
    pub id: JsString,
    pub parent: JsString,
    pub cancel: bool,
    pub live: bool,
    /// Seen only through its own updates, never a subagent association: ends with root's prompt.
    pub implicit: bool,
}

fn is_terminal_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn is_active_status(status: &str) -> bool {
    matches!(status, "pending" | "in_progress")
}

fn pair_key(parent: &JsString, tool_id: &JsString) -> String {
    Value::Array(
        vec![
            Value::String(parent.clone()),
            Value::String(tool_id.clone()),
        ]
        .into(),
    )
    .to_json()
}

/// Indexes make ordinary updates independent of historical child count (`session-routing.ts:15`).
#[derive(Debug)]
pub struct SessionRouting {
    thread_id: String,
    root: JsString,
    children: IndexMap<JsString, Child>,
    tool_owners: IndexMap<JsString, JsString>,
    completed_tools: IndexSet<String>,
    by_key: IndexMap<String, JsString>,
    live: IndexSet<JsString>,
    by_parent: IndexMap<JsString, IndexSet<JsString>>,
}

impl SessionRouting {
    pub fn new(thread_id: impl Into<String>, root: impl Into<JsString>) -> Self {
        Self {
            thread_id: thread_id.into(),
            root: root.into(),
            children: IndexMap::new(),
            tool_owners: IndexMap::new(),
            completed_tools: IndexSet::new(),
            by_key: IndexMap::new(),
            live: IndexSet::new(),
            by_parent: IndexMap::new(),
        }
    }

    pub fn root(&self) -> &JsString {
        &self.root
    }

    pub fn bind_root(&mut self, id: JsString) {
        let previous = self.root.clone();
        self.root = id.clone();
        if let Some(provisional) = self.children.shift_remove(&id) {
            self.by_key
                .shift_remove(&native_agent_key(&self.thread_id, &id));
            self.live.shift_remove(&id);
            if let Some(siblings) = self.by_parent.get_mut(&provisional.parent) {
                siblings.shift_remove(&id);
            }
        }
        let reparented: Vec<JsString> = self
            .by_parent
            .get(&previous)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default();
        for child_id in reparented {
            if let Some(child) = self.children.get_mut(&child_id) {
                child.parent = id.clone();
                let parent = child.parent.clone();
                let cid = child.id.clone();
                self.index_child(parent, cid);
            }
        }
        if previous != id {
            self.by_parent.shift_remove(&previous);
        }
    }

    pub fn receive(&mut self, params: &Value) {
        let params_map = object(params);
        let parent = js_string(params_map.get("sessionId").unwrap_or(&Value::Null))
            .cloned()
            .unwrap_or_default();
        let update_val = params_map.get("update").unwrap_or(&Value::Null);
        let update = object(update_val);
        let update_type = string(update.get("sessionUpdate").unwrap_or(&Value::Null));
        let tool_id = js_string(update.get("toolCallId").unwrap_or(&Value::Null))
            .cloned()
            .unwrap_or_default();
        let status = string(update.get("status").unwrap_or(&Value::Null));
        let tool_key = pair_key(&parent, &tool_id);

        let is_tool_frame = matches!(update_type, "tool_call" | "tool_call_update");
        // A tool frame that only reports an end is never proof that its session is working:
        // it can arrive after the child finished, and must not bring the child back.
        let passive = is_tool_frame
            && (is_terminal_status(status)
                || (update_type == "tool_call_update"
                    && self.completed_tools.contains(&tool_key)
                    && !is_active_status(status)));

        if !tool_id.is_empty() && is_tool_frame {
            if is_terminal_status(status) {
                self.completed_tools.shift_remove(&tool_key);
                self.completed_tools.insert(tool_key);
                if self.completed_tools.len() > COMPLETED_TOOLS_LIMIT {
                    self.completed_tools.shift_remove_index(0);
                }
            } else if is_active_status(status) {
                self.completed_tools.shift_remove(&tool_key);
            }
        }

        if !tool_id.is_empty() && is_terminal_status(status) {
            if self.tool_owners.get(&tool_id) == Some(&parent) {
                self.tool_owners.shift_remove(&tool_id);
            }
        } else if update_type == "tool_call" && !tool_id.is_empty() {
            self.tool_owners.shift_remove(&tool_id);
            self.tool_owners.insert(tool_id, parent.clone());
            if self.tool_owners.len() > TOOL_OWNER_LIMIT {
                self.tool_owners.shift_remove_index(0);
            }
        }

        let association = child_association(update_val);
        let Some(association) = association else {
            if !parent.is_empty()
                && parent != self.root
                && !passive
                && matches!(
                    update_type,
                    "agent_message_chunk"
                        | "agent_thought_chunk"
                        | "tool_call"
                        | "tool_call_update"
                )
            {
                let child = self
                    .children
                    .entry(parent.clone())
                    .or_insert_with(|| Child {
                        id: parent.clone(),
                        parent: self.root.clone(),
                        cancel: true,
                        live: true,
                        implicit: true,
                    });
                child.live = true;
                let parent_id = child.parent.clone();
                let child_id = child.id.clone();
                self.by_key
                    .insert(native_agent_key(&self.thread_id, &parent), child_id.clone());
                self.live.insert(parent);
                self.index_child(parent_id, child_id);
            }
            return;
        };

        if association.id == parent {
            return;
        }
        let id = association.id;
        let previous = self.children.get(&id).cloned();
        if let Some(prev) = &previous
            && prev.parent != parent
            && let Some(siblings) = self.by_parent.get_mut(&prev.parent)
        {
            siblings.shift_remove(&id);
        }
        let cancel = update_type != "subagent_update"
            || match update.get("capabilities") {
                Some(caps) => !matches!(object(caps).get("cancel"), None | Some(Value::Null)),
                None => previous.as_ref().is_some_and(|prev| prev.cancel),
            };
        let live = if association.terminal {
            false
        } else {
            association.status == "running" || previous.as_ref().is_none_or(|prev| prev.live)
        };
        let child = Child {
            id: id.clone(),
            parent: parent.clone(),
            cancel,
            live,
            implicit: false,
        };
        self.children.insert(id.clone(), child);
        self.by_key
            .insert(native_agent_key(&self.thread_id, &id), id.clone());
        if live {
            self.live.insert(id.clone());
        } else {
            self.live.shift_remove(&id);
        }
        self.index_child(parent, id);
    }

    /// The root's prompt answered: a session nothing associates as a subagent ends with it.
    pub fn prompt_ended(&mut self) {
        let live_ids: Vec<JsString> = self.live.iter().cloned().collect();
        for id in live_ids {
            if let Some(child) = self.children.get_mut(&id)
                && child.implicit
            {
                child.live = false;
                self.live.shift_remove(&id);
            }
        }
    }

    /// A cancelled child gave no sign within its grace: no longer counted as working.
    pub fn expire(&mut self, id: &JsString) -> bool {
        let Some(child) = self.children.get_mut(id) else {
            return false;
        };
        if !child.live {
            return false;
        }
        child.live = false;
        self.live.shift_remove(id);
        true
    }

    fn index_child(&mut self, parent: JsString, child_id: JsString) {
        self.by_parent.entry(parent).or_default().insert(child_id);
    }

    pub fn has_live_children(&self) -> bool {
        !self.live.is_empty()
    }

    pub fn is_live(&self, id: &JsString) -> bool {
        self.live.contains(id)
    }

    /// Live children that hold new input back. A stray session ends with the root's prompt.
    pub fn holds_input(&self) -> bool {
        self.live
            .iter()
            .any(|id| self.children.get(id).is_some_and(|child| !child.implicit))
    }

    pub fn child(&self, id: &JsString) -> Option<&Child> {
        self.children.get(id)
    }

    pub fn by_key(&self, key: &str) -> Option<&Child> {
        let id = self.by_key.get(key)?;
        self.children.get(id)
    }

    pub fn descendants(&self, id: &JsString) -> Vec<Child> {
        let mut result = Vec::new();
        let mut found = IndexSet::new();
        let mut queue = VecDeque::new();
        found.insert(id.clone());
        queue.push_back(id.clone());
        while let Some(current) = queue.pop_front() {
            let Some(children) = self.by_parent.get(&current) else {
                continue;
            };
            for child_id in children {
                if found.contains(child_id) {
                    continue;
                }
                let Some(child) = self.children.get(child_id) else {
                    continue;
                };
                found.insert(child_id.clone());
                queue.push_back(child_id.clone());
                result.push(child.clone());
            }
        }
        result
    }

    pub fn owner(&self, params: &Value, root: &JsString) -> JsString {
        let params_map = object(params);
        if let Some(session_id) = js_string(params_map.get("sessionId").unwrap_or(&Value::Null))
            && !session_id.is_empty()
        {
            return session_id.clone();
        }
        let tool_id = params_map
            .get("toolCallId")
            .and_then(js_string)
            .filter(|id| !id.is_empty())
            .or_else(|| {
                object(params_map.get("toolCall").unwrap_or(&Value::Null))
                    .get("toolCallId")
                    .and_then(js_string)
                    .filter(|id| !id.is_empty())
            });
        if let Some(tool_id) = tool_id
            && let Some(owner) = self.tool_owners.get(tool_id)
            && !owner.is_empty()
        {
            return owner.clone();
        }
        root.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::SessionRouting;
    use crate::translate::keys::native_agent_key;
    use ace_json::{JsString, json};

    #[test]
    fn explicit_and_implicit_children_track_liveness_input_hold_and_expiry() {
        let mut routing = SessionRouting::new("thread-1", "root");

        // Implicit child from a stray session's update.
        routing.receive(&json!({
            "sessionId": "stray",
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "hi" } }
        }));
        assert!(routing.has_live_children());
        assert!(!routing.holds_input());
        routing.prompt_ended();
        assert!(!routing.has_live_children());

        // Explicit subagent holds input across prompt_ended until terminal or expire.
        routing.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "subagent_spawned", "subagentSessionId": "child-1", "state": "running" }
        }));
        assert!(routing.has_live_children());
        assert!(routing.holds_input());
        routing.prompt_ended();
        assert!(routing.holds_input());

        // Lookup by native agent key returns the child.
        let key = native_agent_key("thread-1", &JsString::from("child-1"));
        assert_eq!(routing.by_key(&key).map(|c| c.cancel), Some(true));

        // Passive terminal tool update after completion does not resurrect the child.
        routing.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "subagent_state_update", "subagentSessionId": "child-1", "state": "completed" }
        }));
        assert!(!routing.has_live_children());
        routing.receive(&json!({
            "sessionId": "child-1",
            "update": { "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed" }
        }));
        assert!(!routing.has_live_children());
        // Follow-up statusless tool_call_update on the completed tool is also passive.
        routing.receive(&json!({
            "sessionId": "child-1",
            "update": { "sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "done" }
        }));
        assert!(!routing.has_live_children());
    }

    #[test]
    fn bind_root_reparents_provisional_children_and_clears_root_entry() {
        let mut routing = SessionRouting::new("thread-1", "");
        routing.receive(&json!({
            "sessionId": "root-new",
            "update": { "sessionUpdate": "agent_message_chunk" }
        }));
        routing.receive(&json!({
            "sessionId": "",
            "update": { "sessionUpdate": "subagent_spawned", "subagentSessionId": "child-a", "state": "running" }
        }));
        routing.bind_root(JsString::from("root-new"));
        assert!(routing.child(&JsString::from("root-new")).is_none());
        let descendants = routing.descendants(&JsString::from("root-new"));
        assert_eq!(descendants.len(), 1);
        assert_eq!(descendants[0].id, JsString::from("child-a"));
        assert_eq!(descendants[0].parent, JsString::from("root-new"));
    }

    #[test]
    fn owner_resolves_from_session_id_then_tool_call_owner_then_root() {
        let mut routing = SessionRouting::new("thread-1", "root");
        routing.receive(&json!({
            "sessionId": "child-1",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "tc-1", "status": "in_progress" }
        }));
        assert_eq!(
            routing.owner(
                &json!({ "sessionId": "explicit", "toolCallId": "tc-1" }),
                &JsString::from("root")
            ),
            JsString::from("explicit")
        );
        assert_eq!(
            routing.owner(
                &json!({ "toolCall": { "toolCallId": "tc-1" } }),
                &JsString::from("root")
            ),
            JsString::from("child-1")
        );
        // Completing the tool removes its owner mapping.
        routing.receive(&json!({
            "sessionId": "child-1",
            "update": { "sessionUpdate": "tool_call_update", "toolCallId": "tc-1", "status": "completed" }
        }));
        assert_eq!(
            routing.owner(&json!({ "toolCallId": "tc-1" }), &JsString::from("root")),
            JsString::from("root")
        );
    }

    #[test]
    fn subagent_update_cancel_capability_preserves_or_overrides_flag() {
        let mut routing = SessionRouting::new("thread-1", "root");
        routing.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "subagent_update", "subagentSessionId": "c1", "state": "running", "capabilities": { "cancel": {} } }
        }));
        assert_eq!(
            routing.child(&JsString::from("c1")).map(|c| c.cancel),
            Some(true)
        );
        routing.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "subagent_update", "subagentSessionId": "c1", "state": "running" }
        }));
        assert_eq!(
            routing.child(&JsString::from("c1")).map(|c| c.cancel),
            Some(true)
        );
        routing.receive(&json!({
            "sessionId": "root",
            "update": { "sessionUpdate": "subagent_update", "subagentSessionId": "c1", "state": "running", "capabilities": { "cancel": null } }
        }));
        assert_eq!(
            routing.child(&JsString::from("c1")).map(|c| c.cancel),
            Some(false)
        );
        assert!(routing.expire(&JsString::from("c1")));
        assert!(!routing.expire(&JsString::from("c1")));
    }
}
