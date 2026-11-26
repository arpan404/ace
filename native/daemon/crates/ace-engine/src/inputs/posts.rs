// SPDX-License-Identifier: Apache-2.0
//! `ThreadPosts` (`thread-posts.ts`, E5.4c): the messages ace posts in a thread for the person,
//! outside any provider turn (ADR 0198), on the root agent's transcript.

use ace_json::Value;

use crate::{EngineError, EngineStore, State};

impl State {
    /// The root agent's key, or `"root"` before one exists.
    fn post_agent(&mut self, store: &EngineStore, thread: &str) -> Result<String, EngineError> {
        let snapshot = self.repo.require_state(store, thread)?;
        let root = snapshot.borrow().state.root_key.clone();
        Ok(root.unwrap_or_else(|| "root".to_owned()))
    }

    /// Marks ace's background row `task` as waiting on the person (`thread-posts.ts:24`), so the
    /// thread needs them as a waiting thread does; or no longer.
    pub fn post_waiting(
        &mut self,
        store: &EngineStore,
        thread: &str,
        task: &str,
        waiting: bool,
        at: f64,
    ) -> Result<(), EngineError> {
        let mut fact = ace_json::Map::new();
        fact.insert("type", Value::from("background.waiting"));
        fact.insert("task", Value::from(task));
        fact.insert("waiting", Value::Bool(waiting));
        self.apply_facts(store, thread, &[Value::Object(fact)], at)
    }

    /// Writes the item under `key`, or replaces what that key holds (`thread-posts.ts:28`).
    pub fn post_item(
        &mut self,
        store: &EngineStore,
        thread: &str,
        key: &str,
        draft: Value,
        at: f64,
    ) -> Result<(), EngineError> {
        let agent = self.post_agent(store, thread)?;
        let mut fact = ace_json::Map::new();
        fact.insert("type", Value::from("item.upsert"));
        fact.insert("agent", Value::from(agent.as_str()));
        fact.insert("item", Value::from(key));
        fact.insert("draft", draft);
        self.apply_facts(store, thread, &[Value::Object(fact)], at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::State;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_post_lands_on_the_root_agent_and_marks_a_waiting_task() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let mut draft = ace_json::Map::new();
        draft.insert("type", Value::from("message"));
        draft.insert("role", Value::from("user"));
        draft.insert("parts", Value::Array(Vec::new().into()));
        state
            .post_item(&store, "t", "post:1", Value::Object(draft), 10.0)
            .expect("post");
        state
            .post_waiting(&store, "t", "task:1", true, 11.0)
            .expect("waiting");
        let snapshot = state.repo.require_state(&store, "t").expect("state");
        let mut borrowed = snapshot.borrow_mut();
        let mut touched = crate::snapshot::touched::Touched::default();
        touched.items.insert("post:1".to_owned());
        borrowed.hydrate(&touched).expect("the item loads");
        assert!(
            borrowed.state.items.contains_key("post:1"),
            "the post landed on the transcript"
        );
    }
}
