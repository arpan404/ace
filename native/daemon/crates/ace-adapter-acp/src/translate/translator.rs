// SPDX-License-Identifier: Apache-2.0
//! The ACP translator (`translator.ts`): frames in, facts out.

use crate::translate::answers::answer_request;
use crate::translate::child_expiry::expire_children;
use crate::translate::content::decode_content;
use crate::translate::data::{RpcId, js_string, list, object, raw, rpc_id, string};
use crate::translate::implicit::settle_implicit_turn;
use crate::translate::lifecycle::end_prompt;
use crate::translate::quirks::QuirksKind;
use crate::translate::requests::open_request;
use crate::translate::settlement::{cancellation_deadline, prompt_end};
use crate::translate::shell_output::ShellOutput;
use crate::translate::state::{TranslationState, TranslatorIdentity};
use crate::translate::update::handle_update;
use ace_json::{Map, Value};

/// The ACP translator: pure, synchronous, never fails on provider data.
pub struct AcpTranslator {
    pub state: TranslationState,
    input_native_id: Option<String>,
    shell_output: ShellOutput,
}

impl AcpTranslator {
    pub fn new(
        root_key: String,
        quirks: QuirksKind,
        thread_id: String,
        identity: TranslatorIdentity,
    ) -> Self {
        Self {
            state: TranslationState::new(root_key, quirks, thread_id, identity),
            input_native_id: None,
            shell_output: ShellOutput::default(),
        }
    }

    pub fn take_diagnostics(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.state.diagnostics)
    }

    pub fn tick(&mut self, now: i64) -> Vec<Value> {
        if self.state.process_dead {
            return Vec::new();
        }
        expire_children(&mut self.state, now)
    }

    pub fn translate(&mut self, frame: &Value, now: i64) -> Vec<Value> {
        let mut facts = self.translate_frame(frame, now);
        settle_implicit_turn(&mut self.state, &mut facts);
        facts
    }

    fn translate_frame(&mut self, frame: &Value, now: i64) -> Vec<Value> {
        let mut facts = Vec::new();
        let frame_map = object(frame);
        let dir = frame_map.get("dir").and_then(Value::as_str).unwrap_or("");
        let channel = frame_map
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or("");
        let data = frame_map.get("data").unwrap_or(&Value::Null).clone();
        self.state.diagnostics.clear();
        self.state.ensure_root(&mut facts);
        let data_map = object(&data).clone();
        if dir == "note" {
            crate::translate::frame_note::handle_note(
                &mut self.state,
                &mut self.input_native_id,
                &data,
                &data_map,
                &mut facts,
            );
            return facts;
        }
        if channel != "stdio" || dir == "stderr" {
            let channel_name = if frame_map.get("channel").is_some() {
                channel
            } else {
                ""
            };
            self.state
                .notice(&mut facts, &data, channel_name, None, None);
            return facts;
        }
        let method = string(data_map.get("method").unwrap_or(&Value::Null)).to_owned();
        let params = object(data_map.get("params").unwrap_or(&Value::Null)).clone();
        let params_value = Value::Object(params.clone());
        let _ = params_value;
        let id = data_map.get("id").and_then(rpc_id_owned);
        if dir == "send" && !method.is_empty() {
            if let Some(id) = id.clone() {
                let params_map = object(data_map.get("params").unwrap_or(&Value::Null)).clone();
                self.state.request(&id, &method, &params_map);
            }
            if method == "session/cancel" {
                let session_id = js_string(params.get("sessionId").unwrap_or(&Value::Null))
                    .cloned()
                    .unwrap_or_default();
                let child_native = session_id.clone();
                let should_arm = state_child_should_arm(&self.state, &child_native);
                if should_arm {
                    let child_key = self
                        .state
                        .agents
                        .get(&child_native)
                        .map(|agent| agent.key.clone())
                        .unwrap_or_default();
                    self.state
                        .arm_cancel(&child_key, cancellation_deadline(now));
                }
                if self.state.prompt_open && session_id == self.state.root.native_id {
                    self.state.root_cancelled = true;
                }
            }
            if ["session/new", "session/load", "session/resume"].contains(&method.as_str()) {
                self.state.cwd = string(params.get("cwd").unwrap_or(&Value::Null)).to_owned();
                if let Some(Value::String(session_id)) = params.get("sessionId") {
                    let session_id = session_id.clone();
                    self.state.bind_root(&session_id, &mut facts);
                }
            }
            if method == "session/prompt" {
                let session_id = js_string(params.get("sessionId").unwrap_or(&Value::Null))
                    .cloned()
                    .unwrap_or_default();
                let agent_key = self.state.agent_key(&session_id, &mut facts);
                if let Some(agent) = self.state.agent_by_key_mut(&agent_key) {
                    agent.terminal = false;
                }
                self.state.prompt_open = true;
                self.state.root_cancelled = false;
                if let Some(agent) = self.state.agent_by_key_mut(&agent_key) {
                    agent.implicit_turn = false;
                }
                self.state.finish_stream(&agent_key, &mut facts);
                self.state.start(&agent_key, &mut facts, "user");
                let input_key = self.state.key("input");
                if let Some(agent) = self.state.agent_by_key_mut(&agent_key) {
                    agent.input_key = Some(input_key.clone());
                }
                let prompt = params.get("prompt").unwrap_or(&Value::Null);
                let mut parts: Vec<Value> = Vec::new();
                for entry in list(prompt) {
                    parts.extend(decode_content(entry));
                }
                let mut draft = Map::with_capacity(6);
                draft.insert("type".to_owned(), Value::from("message".to_owned()));
                draft.insert("role".to_owned(), Value::from("user".to_owned()));
                if let Some(native_id) = self.input_native_id.clone()
                    && !native_id.is_empty()
                {
                    draft.insert("nativeId".to_owned(), Value::from(native_id));
                }
                draft.insert("parts".to_owned(), Value::from(parts));
                draft.insert("complete".to_owned(), Value::Bool(true));
                draft.insert(
                    "raw".to_owned(),
                    Value::from(vec![raw(&data, &method, None)]),
                );
                // Order: type, role, nativeId?, parts, complete, raw.
                let mut ordered = Map::with_capacity(6);
                ordered.insert("type".to_owned(), Value::from("message".to_owned()));
                ordered.insert("role".to_owned(), Value::from("user".to_owned()));
                if let Some(Value::String(native_id)) = draft.get("nativeId") {
                    ordered.insert("nativeId".to_owned(), Value::String(native_id.clone()));
                }
                ordered.insert(
                    "parts".to_owned(),
                    draft
                        .get("parts")
                        .cloned()
                        .unwrap_or(Value::Array(ace_json::Array::new())),
                );
                ordered.insert("complete".to_owned(), Value::Bool(true));
                ordered.insert(
                    "raw".to_owned(),
                    draft.get("raw").cloned().unwrap_or(Value::Null),
                );
                let mut fact = Map::with_capacity(4);
                fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
                fact.insert("agent".to_owned(), Value::from(agent_key));
                fact.insert("item".to_owned(), Value::from(input_key));
                fact.insert("draft".to_owned(), Value::Object(ordered));
                facts.push(Value::Object(fact));
                self.input_native_id = None;
                return facts;
            }
        }
        if dir == "recv" && method == "session/update" {
            if !self.state.loads.is_empty() {
                self.state
                    .diagnostics
                    .push(raw(&data, "session/load replay", None));
                return facts;
            }
            let session_id = js_string(params.get("sessionId").unwrap_or(&Value::Null))
                .cloned()
                .unwrap_or_default();
            let agent_key = self.state.agent_key(&session_id, &mut facts);
            let agent_native = session_id.as_str().to_owned();
            let update = object(params.get("update").unwrap_or(&Value::Null)).clone();
            let update_value = Value::Object(update);
            if handle_update(
                &mut self.state,
                &mut self.shell_output,
                &agent_key,
                &agent_native,
                &update_value,
                &data,
                &mut facts,
            ) {
                return facts;
            }
        }
        if dir == "recv"
            && !method.is_empty()
            && let Some(id) = id.clone()
        {
            let params_map = object(data_map.get("params").unwrap_or(&Value::Null)).clone();
            let params_value = Value::Object(params_map);
            // Clone what open_request needs to avoid borrow conflicts.
            let mut request_facts = Vec::new();
            // open_request may push agent.seen facts; run it with a temporary
            // split borrow via raw pointers is avoided by inlining the call
            // with reborrowed state. NLL allows this direct call.
            if open_request(
                &mut self.state,
                &mut self.shell_output,
                &id,
                &method,
                &object(data_map.get("params").unwrap_or(&Value::Null)).clone(),
                &data,
                &mut request_facts,
            ) {
                // open_request internally calls update for synthesized tools;
                // to match TypeScript it must run the translator update path.
                // Our open_request creates the tool but does not run the
                // full update; run it here for parity when needed.
                facts.extend(request_facts);
                let _ = params_value;
                return facts;
            }
            facts.extend(request_facts);
        }
        if method.is_empty()
            && let Some(id) = id.clone()
        {
            if dir == "send" && data_map.contains_key("result") {
                let result = object(data_map.get("result").unwrap_or(&Value::Null)).clone();
                let result_value = Value::Object(result);
                if answer_request(&mut self.state, &id, &result_value, &data, &mut facts) {
                    return facts;
                }
            }
            if dir == "recv" {
                let sent = self
                    .state
                    .sent
                    .get(&crate::translate::state::rpc_key(&id))
                    .cloned();
                if let Some(sent) = sent {
                    let result = object(data_map.get("result").unwrap_or(&Value::Null)).clone();
                    let result_value = Value::Object(result.clone());
                    let ended = if sent.method == "session/prompt" {
                        prompt_end(&data)
                    } else {
                        None
                    };
                    if sent.method == "session/prompt" && ended.is_none() {
                        self.state.notice(
                            &mut facts,
                            &data,
                            "jsonrpc",
                            Some("Unrecognized ACP prompt response; completion unconfirmed"),
                            None,
                        );
                        return facts;
                    }
                    self.state.reply(&id);
                    if ["session/new", "session/load", "session/resume"]
                        .contains(&sent.method.as_str())
                        && let Some(Value::String(session_id)) = result.get("sessionId")
                    {
                        let session_id = session_id.clone();
                        self.state.bind_root(&session_id, &mut facts);
                    }
                    if ["session/load", "session/resume"].contains(&sent.method.as_str())
                        && self.state.root.active
                        && !self.state.prompt_open
                    {
                        let root_key = self.state.root.key.clone();
                        self.state.end(&root_key, &mut facts, "completed", None);
                    }
                    if sent.method == "session/prompt"
                        && let Some((reason, known)) = ended
                    {
                        let session_id =
                            js_string(sent.params.get("sessionId").unwrap_or(&Value::Null))
                                .cloned()
                                .unwrap_or_default();
                        let agent_key = self.state.agent_key(&session_id, &mut facts);
                        let error = data_map
                            .get("error")
                            .cloned()
                            .unwrap_or(Value::Object(Map::new()));
                        end_prompt(
                            &mut self.state,
                            &agent_key,
                            &reason,
                            &error,
                            now,
                            &mut facts,
                        );
                        if !known {
                            let text = format!(
                                "The agent ended its turn with a stop reason ace doesn't know: {reason}."
                            );
                            let agent_key_clone = agent_key.clone();
                            self.state.notice(
                                &mut facts,
                                &data,
                                "jsonrpc",
                                Some(&text),
                                Some(&agent_key_clone),
                            );
                        }
                        return facts;
                    }
                    let _ = result_value;
                }
            }
        }
        let notice_type = if method.is_empty() {
            "jsonrpc".to_owned()
        } else {
            method.clone()
        };
        self.state
            .notice(&mut facts, &data, &notice_type, None, None);
        facts
    }
}

fn rpc_id_owned(value: &Value) -> Option<RpcId> {
    rpc_id(value)
}

fn state_child_should_arm(state: &TranslationState, native_id: &ace_json::JsString) -> bool {
    if native_id.is_empty() {
        return false;
    }
    match state.agents.get(native_id) {
        Some(child) => child.key != state.root.key && !child.terminal,
        None => false,
    }
}
