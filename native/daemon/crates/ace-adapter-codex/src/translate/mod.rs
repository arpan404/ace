// SPDX-License-Identifier: Apache-2.0
//! The Codex translator: frames in, facts out, never an error.

pub mod answer_echo;
pub mod command;
pub mod content;
pub mod delta;
pub mod discover;
pub mod exit;
pub mod facts;
pub mod goal;
pub mod handle_live;
pub mod handle_method;
pub mod handle_note;
pub mod handle_response;
pub mod handle_send;
pub mod handle_status;
pub mod handle_turn;
pub mod handler;
pub mod helpers;
pub mod history;
pub mod interactions;
pub mod item;
pub mod item_finish;
pub mod item_translate;
pub mod mcp;
pub mod model;
pub mod pending;
pub mod registry;
pub mod retention;
pub mod state;
pub mod turn;

use ace_core::Fact;
use ace_json::{Map, Value};

use self::facts::{fact, raw_payload};
pub use self::state::CodexTranslator;

pub struct ParsedFrame {
    pub dir: String,
    pub channel: String,
    pub data: Value,
    pub seq: u64,
    pub t: i64,
}

impl CodexTranslator {
    fn note_signal(
        &mut self,
        agent: &str,
        raw_type: &str,
        data: &Value,
        is_frame_data: bool,
    ) -> Fact {
        if !is_frame_data {
            self.diagnostics.push(raw_payload(raw_type, data, None));
        }
        super::translate::facts::signal_fact(Some(agent))
    }

    fn warning(&mut self, agent: &str, event: &str, detail: &str) -> Fact {
        let mut inner = Map::with_capacity(2);
        inner.insert("event".to_owned(), Value::from(event.to_owned()));
        inner.insert("detail".to_owned(), Value::from(detail.to_owned()));
        let mut diag = Map::with_capacity(2);
        diag.insert(
            "type".to_owned(),
            Value::from("adapter.warning".to_owned()),
        );
        diag.insert("data".to_owned(), Value::Object(inner));
        self.diagnostics.push(Value::Object(diag));
        super::translate::facts::signal_fact(Some(agent))
    }

    fn title(&self, value: &Value, data: &Value) -> Vec<Fact> {
        let text = match value {
            Value::String(s) => s.trim().to_owned(),
            _ => String::new(),
        };
        if text.is_empty() {
            return Vec::new();
        }
        let mut draft = Map::with_capacity(7);
        draft.insert("type".to_owned(), Value::from("notice".to_owned()));
        draft.insert("code".to_owned(), Value::from("thread_title".to_owned()));
        draft.insert("title".to_owned(), Value::from(text.clone()));
        draft.insert("level".to_owned(), Value::from("info".to_owned()));
        draft.insert("text".to_owned(), Value::from(text));
        draft.insert("complete".to_owned(), Value::Bool(true));
        draft.insert(
            "raw".to_owned(),
            Value::from(vec![raw_payload("thread/name/updated", data, None)]),
        );
        let mut body = Map::with_capacity(3);
        body.insert("agent".to_owned(), Value::from(self.root_key.clone()));
        body.insert(
            "item".to_owned(),
            Value::from("codex:thread-title".to_owned()),
        );
        body.insert("draft".to_owned(), Value::Object(draft));
        vec![fact("item.upsert", body)]
    }

    pub fn replay_hydration(
        &mut self,
        method: &str,
        params: Value,
        now: i64,
        facts: &mut Vec<Fact>,
    ) {
        let mut data = Map::with_capacity(2);
        data.insert("method".to_owned(), Value::from(method.to_owned()));
        data.insert("params".to_owned(), params);
        let frame = ParsedFrame {
            dir: "recv".to_owned(),
            channel: "hydration".to_owned(),
            data: Value::Object(data),
            seq: 0,
            t: now,
        };
        self.handle_frame(&frame, now, facts);
    }

    pub fn replay_hydration_frame(&mut self, data: Value, now: i64, facts: &mut Vec<Fact>) {
        // Buffered unknown-thread frames replay verbatim, not as hydration.
        let frame = self::handle_method::buffered_frame_to_parsed(&data);
        self.handle_frame(&frame, now, facts);
    }

    pub fn replay_buffered(&mut self, frame: ParsedFrame, now: i64, facts: &mut Vec<Fact>) {
        self.handle_frame(&frame, now, facts);
    }

    fn handle_frame(&mut self, frame: &ParsedFrame, now: i64, facts: &mut Vec<Fact>) {
        self::handler::handle(self, frame, now, facts);
    }

    pub fn translate_value(&mut self, frame: ParsedFrame, now: i64) -> Vec<Fact> {
        let is_exit = frame.dir == "note" && self::exit::is_codex_session_exit(&frame.data);
        let initial_type = if frame.dir == "stderr" {
            "stderr".to_owned()
        } else if is_exit {
            "codex.session-exit".to_owned()
        } else {
            let method = frame
                .data
                .as_object()
                .and_then(|m| m.get("method"))
                .and_then(|v| v.as_str())
                .unwrap_or("codex.frame")
                .to_owned();
            if method.is_empty() {
                "codex.frame".to_owned()
            } else {
                method
            }
        };
        let frame_json = ace_json::ser::to_string(&frame.data).unwrap_or_default();
        self.diagnostic_frame_json = Some(frame_json);
        self.diagnostics = vec![raw_payload(&initial_type, &frame.data, None)];
        let mut facts = Vec::new();
        self.handle_frame(&frame, now, &mut facts);
        facts
    }

    pub fn tick_value(&mut self, now: i64) -> Vec<Fact> {
        let mut facts = Vec::new();
        let natives: Vec<String> = self.agents.keys().cloned().collect();
        for native in natives {
            let (agent_key, flag) = match self.agents.get(&native) {
                Some(agent) => match &agent.unmatched_flag {
                    Some(flag) if now >= flag.since => (agent.key.clone(), flag.data.clone()),
                    _ => continue,
                },
                None => continue,
            };
            let mut request = Map::with_capacity(3);
            request.insert("kind".to_owned(), Value::from("approval".to_owned()));
            request.insert(
                "title".to_owned(),
                Value::from("Codex is waiting for input".to_owned()),
            );
            request.insert("options".to_owned(), Value::Array(ace_json::Array::new()));
            let mut body = Map::with_capacity(5);
            body.insert("agent".to_owned(), Value::from(agent_key));
            body.insert(
                "interaction".to_owned(),
                Value::from(format!("status:{native}")),
            );
            body.insert("blocking".to_owned(), Value::Bool(true));
            body.insert("request".to_owned(), Value::Object(request));
            body.insert(
                "raw".to_owned(),
                Value::from(vec![raw_payload("thread/status/changed", &flag, None)]),
            );
            facts.push(fact("interaction.opened", body));
        }
        facts
    }

    pub fn take_diagnostics_value(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        std::mem::swap(&mut self.diagnostics, &mut out);
        self.diagnostic_frame_json = None;
        out
    }
}

impl ace_adapter_api::translator::Translator for CodexTranslator {
    fn take_diagnostics(&mut self) -> Vec<String> {
        self.take_diagnostics_value()
            .iter()
            .map(|v| ace_json::ser::to_string(v).unwrap_or_else(|_| "null".to_owned()))
            .collect()
    }

    fn next_deadline(&self) -> Option<i64> {
        None
    }

    fn translate(&mut self, frame: &ace_adapter_api::frame::Frame, now_ms: i64) -> Vec<Fact> {
        let data: Value = ace_json::parse(frame.data.get()).unwrap_or(Value::Null);
        let dir = match frame.dir {
            ace_adapter_api::frame::FrameDirection::Send => "send",
            ace_adapter_api::frame::FrameDirection::Recv => "recv",
            ace_adapter_api::frame::FrameDirection::Stderr => "stderr",
            ace_adapter_api::frame::FrameDirection::Note => "note",
        }
        .to_owned();
        self.translate_value(
            ParsedFrame {
                dir,
                channel: frame.channel.clone(),
                data,
                seq: frame.seq,
                t: frame.t,
            },
            now_ms,
        )
    }

    fn tick(&mut self, now_ms: i64) -> Vec<Fact> {
        self.tick_value(now_ms)
    }
}
