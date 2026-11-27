// SPDX-License-Identifier: Apache-2.0
//! Agent facts: ensure, bind, start, end, streams, notices (`state.ts`).

use crate::translate::data::raw;
use crate::translate::keys::native_agent_key;
use crate::translate::state::{AgentState, TranslationState};
use ace_json::{JsString, Map, Value};

impl TranslationState {
    pub fn ensure_root(&mut self, facts: &mut Vec<Value>) {
        if self.initialized {
            return;
        }
        self.initialized = true;
        let mut native = Map::with_capacity(2);
        native.insert(
            "provider".to_owned(),
            Value::from(self.quirks.provider().to_owned()),
        );
        if !self.root.native_id.is_empty() {
            native.insert(
                "nativeId".to_owned(),
                Value::from(self.root.native_id.clone()),
            );
        }
        let mut fact = Map::with_capacity(6);
        fact.insert("type".to_owned(), Value::from("agent.seen".to_owned()));
        fact.insert("agent".to_owned(), Value::from(self.root.key.clone()));
        fact.insert("origin".to_owned(), Value::from("root".to_owned()));
        fact.insert("fidelity".to_owned(), Value::from("full".to_owned()));
        fact.insert("native".to_owned(), Value::Object(native));
        fact.insert("cwd".to_owned(), Value::from(self.cwd.clone()));
        facts.push(Value::Object(fact));
    }

    pub fn bind_root(&mut self, id: &JsString, facts: &mut Vec<Value>) {
        self.root.native_id = id.clone();
        let root_snapshot = self.root.clone();
        self.agents.insert(id.clone(), root_snapshot);
        let mut native = Map::with_capacity(2);
        native.insert(
            "provider".to_owned(),
            Value::from(self.quirks.provider().to_owned()),
        );
        native.insert("nativeId".to_owned(), Value::from(id.to_owned()));
        let mut fact = Map::with_capacity(6);
        fact.insert("type".to_owned(), Value::from("agent.seen".to_owned()));
        fact.insert("agent".to_owned(), Value::from(self.root.key.clone()));
        fact.insert("origin".to_owned(), Value::from("root".to_owned()));
        fact.insert("fidelity".to_owned(), Value::from("full".to_owned()));
        fact.insert("native".to_owned(), Value::Object(native));
        fact.insert("cwd".to_owned(), Value::from(self.cwd.clone()));
        facts.push(Value::Object(fact));
    }

    fn opening_session(&self) -> bool {
        self.sent
            .values()
            .any(|request| request.method == "session/new")
    }

    /// The agent for a native session id, creating a child when unknown.
    /// Returns the agent's key and whether it was newly created (for fact order).
    pub fn agent_key(&mut self, id: &JsString, facts: &mut Vec<Value>) -> String {
        if id.is_empty() || id == &self.root.native_id {
            return self.root.key.clone();
        }
        if self.agents.contains_key(id) {
            return self
                .agents
                .get(id)
                .map(|agent| agent.key.clone())
                .unwrap_or_default();
        }
        if self.opening_session() {
            self.bind_root(id, facts);
            return self.root.key.clone();
        }
        let key = native_agent_key(&self.thread_id, id);
        let agent = AgentState {
            key: key.clone(),
            native_id: id.clone(),
            parent: Some(self.root.key.clone()),
            spawn: None,
            active: false,
            terminal: false,
            background: false,
            suspended: false,
            segment: String::new(),
            input_key: None,
            stream: None,
            cancel_at: None,
            plan_tool_key: None,
            pending_spawn_key: None,
            placeholder: false,
            associated: false,
            implicit_turn: false,
            plan_state: None,
        };
        self.agents.insert(id.clone(), agent);
        self.index_agent(&key, id);
        let mut native = Map::with_capacity(2);
        native.insert(
            "provider".to_owned(),
            Value::from(self.quirks.provider().to_owned()),
        );
        native.insert("nativeId".to_owned(), Value::from(id.to_owned()));
        let mut fact = Map::with_capacity(7);
        fact.insert("type".to_owned(), Value::from("agent.seen".to_owned()));
        fact.insert("agent".to_owned(), Value::from(key.clone()));
        fact.insert("parent".to_owned(), Value::from(self.root.key.clone()));
        fact.insert(
            "origin".to_owned(),
            Value::from("provider_subagent".to_owned()),
        );
        fact.insert("fidelity".to_owned(), Value::from("full".to_owned()));
        fact.insert("native".to_owned(), Value::Object(native));
        fact.insert("cwd".to_owned(), Value::from(self.cwd.clone()));
        facts.push(Value::Object(fact));
        key
    }

    pub fn start(&mut self, agent_key: &str, facts: &mut Vec<Value>, trigger: &str) {
        // agent.reconnected always, even when already active.
        let mut reconnected = Map::with_capacity(2);
        reconnected.insert(
            "type".to_owned(),
            Value::from("agent.reconnected".to_owned()),
        );
        reconnected.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
        facts.push(Value::Object(reconnected));
        let already_active = self
            .agent_by_key(agent_key)
            .is_some_and(|agent| agent.active);
        if already_active {
            return;
        }
        if let Some(agent) = self.agent_by_key_mut(agent_key) {
            agent.active = true;
            agent.terminal = false;
            agent.segment.clear();
        }
        let mut cleared = Map::with_capacity(2);
        cleared.insert("type".to_owned(), Value::from("retry.cleared".to_owned()));
        cleared.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
        facts.push(Value::Object(cleared));
        let turn_id = self.key("turn");
        let mut started = Map::with_capacity(4);
        started.insert("type".to_owned(), Value::from("turn.started".to_owned()));
        started.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
        started.insert("nativeTurnId".to_owned(), Value::from(turn_id));
        started.insert("trigger".to_owned(), Value::from(trigger.to_owned()));
        facts.push(Value::Object(started));
    }

    pub fn end(
        &mut self,
        agent_key: &str,
        facts: &mut Vec<Value>,
        outcome: &str,
        error: Option<Value>,
    ) {
        self.finish_stream(agent_key, facts);
        if let Some(agent) = self.agent_by_key_mut(agent_key) {
            agent.active = false;
        }
        let mut ended = Map::with_capacity(4);
        ended.insert("type".to_owned(), Value::from("turn.ended".to_owned()));
        ended.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
        ended.insert("outcome".to_owned(), Value::from(outcome.to_owned()));
        if let Some(error) = error {
            ended.insert("error".to_owned(), error);
        }
        facts.push(Value::Object(ended));
    }

    pub fn finish_stream(&mut self, agent_key: &str, facts: &mut Vec<Value>) {
        let stream = self
            .agent_by_key(agent_key)
            .and_then(|agent| agent.stream.clone());
        let Some(stream) = stream else {
            return;
        };
        let mut draft = Map::with_capacity(2);
        if stream.kind == "agent_thought_chunk" {
            draft.insert("type".to_owned(), Value::from("reasoning".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(true));
        } else {
            draft.insert("type".to_owned(), Value::from("message".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(true));
        }
        let mut fact = Map::with_capacity(4);
        fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
        fact.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
        fact.insert("item".to_owned(), Value::from(stream.key));
        fact.insert("draft".to_owned(), Value::Object(draft));
        facts.push(Value::Object(fact));
        if let Some(agent) = self.agent_by_key_mut(agent_key) {
            agent.stream = None;
        }
    }

    pub fn notice(
        &mut self,
        facts: &mut Vec<Value>,
        data: &Value,
        typ: &str,
        text: Option<&str>,
        owner_key: Option<&str>,
    ) {
        if let Some(text) = text {
            let item_key = self.key("raw");
            let agent_key = owner_key.unwrap_or(&self.root.key.clone()).to_owned();
            let mut draft = Map::with_capacity(5);
            draft.insert("type".to_owned(), Value::from("notice".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(true));
            draft.insert("level".to_owned(), Value::from("info".to_owned()));
            draft.insert("text".to_owned(), Value::from(text.to_owned()));
            draft.insert("raw".to_owned(), Value::from(vec![raw(data, typ, None)]));
            let mut fact = Map::with_capacity(4);
            fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
            fact.insert("agent".to_owned(), Value::from(agent_key));
            fact.insert("item".to_owned(), Value::from(item_key));
            fact.insert("draft".to_owned(), Value::Object(draft));
            facts.push(Value::Object(fact));
        } else {
            self.diagnostics.push(raw(data, typ, None));
        }
    }
}
