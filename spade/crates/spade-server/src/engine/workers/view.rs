//! The tree as the API and `worker_status` show it (ADR 0161): each node's state rolled up from
//! everything under it, its own state, progress from its goal (ADR 0159), what it and its subtree
//! spent (information only, ADR 0166) and whether anything under it needs the person.

use serde_json::{Map, Value, json};
use spade_core::tree;
use spade_store::StoreError;

use super::super::roster::State;
use super::super::{Activity, Engine};
use super::DEEPEST;

impl Engine {
    /// `{"tree": Node}` for agent `agent`, or `None` for no such agent.
    pub fn agent_tree(&self, agent: &str) -> Result<Option<Value>, StoreError> {
        let Some(found) = self.store.agent(agent)? else {
            return Ok(None);
        };
        Ok(Some(
            json!({ "tree": self.bot_node(&found.conversation, 0)? }),
        ))
    }

    /// The node for bot conversation `id` and everything under it.
    pub(crate) fn bot_node(&self, id: &str, depth: usize) -> Result<Value, StoreError> {
        let agent = self.store.agent_for_conversation(id)?;
        let activity = self.activity(id)?;
        let own = self.own_activity(id)?;
        let events = self.load(id)?;
        let mut children = Vec::new();
        if depth < DEEPEST {
            for child in self.worker_children(id) {
                children.push(self.bot_node(&child, depth + 1)?);
            }
        }
        for helper in self.helpers_view(id)?.unwrap_or_default() {
            children.push(json!({
                "kind": "helper",
                "id": helper["job"],
                "name": helper["profile"],
                "conversation": helper["conversation"],
                "task": helper["task"],
                "state": helper["state"],
                "needs_you": helper["state"] == "waiting",
                "cost_micros": helper["cost_micros"],
                "children": [],
            }));
        }
        for ace in tree::ace_children(events.iter()) {
            children.push(json!({
                "kind": "ace",
                "id": ace.thread,
                "name": ace.name,
                "state": ace.state.name(),
                "needs_you": ace.state.waiting(),
                "job": ace.job,
                "cost_micros": Value::Null,
                "children": [],
            }));
        }
        let mut node = Map::new();
        node.insert("kind".into(), "bot".into());
        node.insert(
            "id".into(),
            agent.as_ref().map_or(Value::Null, |a| a.id.clone().into()),
        );
        node.insert(
            "name".into(),
            agent
                .as_ref()
                .map_or(Value::Null, |a| a.name.clone().into()),
        );
        node.insert("conversation".into(), id.into());
        node.insert("state".into(), activity.state.name().into());
        node.insert("own_state".into(), own.state.name().into());
        node.insert(
            "status".into(),
            self.status_for(id, &activity)
                .map_or(Value::Null, Value::from),
        );
        node.insert(
            "needs_you".into(),
            (activity.state == State::Waiting).into(),
        );
        node.insert(
            "waiting_for".into(),
            activity.waiting_for.map_or(Value::Null, Value::from),
        );
        node.insert(
            "progress".into(),
            serde_json::to_value(&activity.task_progress).unwrap_or_default(),
        );
        node.insert(
            "cost_micros".into(),
            self.store.spent_by(id, 0).unwrap_or(0).into(),
        );
        node.insert("subtree_cost_micros".into(), self.subtree_spent(id).into());
        node.insert("queued".into(), self.worker_queued(id).into());
        node.insert("children".into(), Value::Array(children));
        Ok(Value::Object(node))
    }

    /// What the roster adds for an agent in a tree: its parent (`{id, name}` or null) and how many
    /// of its worker bots have not settled.
    pub(crate) fn tree_fields(
        &self,
        id: &str,
        activity: &Activity,
        shown: &mut Map<String, Value>,
    ) {
        let parent = self.worker_link(id).map_or(Value::Null, |link| {
            let name = self
                .store
                .agent(&link.parent)
                .ok()
                .flatten()
                .map_or(link.parent_name.clone(), |a| a.name);
            json!({ "id": link.parent, "name": name })
        });
        shown.insert("parent".into(), parent);
        shown.insert("workers".into(), activity.workers.into());
    }

    /// The node of one worker of `caller`: a bot's subtree, a helper's or an ace child's line.
    pub(crate) fn worker_node(&self, caller: &str, worker: &str) -> Option<Value> {
        let tree = self.bot_node(caller, 0).ok()?;
        find(&tree, worker).cloned()
    }
}

/// The node with id or name `worker` anywhere under `node`.
fn find<'a>(node: &'a Value, worker: &str) -> Option<&'a Value> {
    for child in node["children"].as_array()? {
        let named = child["id"] == worker
            || child["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(worker));
        if named {
            return Some(child);
        }
        if let Some(found) = find(child, worker) {
            return Some(found);
        }
    }
    None
}
