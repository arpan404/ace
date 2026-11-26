// SPDX-License-Identifier: Apache-2.0
//! What a frame's content does once captured: a notification's update, an agent's own
//! request, the questions it asks, and the deadlines that end an unanswered one.

use super::super::protocol::client_methods;
use super::{AcpEffect, MAX_PENDING_INTERACTIONS, PendingInteraction};
use crate::translate::approval::interaction_key;
use crate::translate::data::{js_string, object, string};
use crate::translate::interactions::interaction_request;
use crate::translate::requests::request_tool;
use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::INTERNAL_ERROR;
use std::collections::HashSet;

impl super::AcpCore {
    pub(crate) fn handle_notification(
        &mut self,
        method: &JsString,
        params: Option<&Value>,
        effects: &mut Vec<AcpEffect>,
    ) {
        if method.as_str() != client_methods::SESSION_UPDATE {
            return;
        }
        // Borrowed: this runs for every `session/update` frame, and the whole tree is only
        // read here (`session.ts:217`).
        let empty = Value::Object(Map::new());
        let params_val = params.unwrap_or(&empty);
        let params_map = object(params_val);
        let update_val = params_map.get("update").unwrap_or(&Value::Null);
        let update = object(update_val);
        let session_id = js_string(params_map.get("sessionId").unwrap_or(&Value::Null))
            .cloned()
            .unwrap_or_default();

        // Antigravity names a new session in its updates before answering session/new.
        if self.open_id.is_some()
            && self.opening_session.is_empty()
            && self.native_session_id.is_empty()
        {
            self.opening_session = session_id.clone();
        }

        let active_session = if !self.native_session_id.is_empty() {
            &self.native_session_id
        } else {
            &self.opening_session
        };
        let update_kind = string(update.get("sessionUpdate").unwrap_or(&Value::Null));
        if !session_id.is_empty()
            && session_id == *active_session
            && update_kind == "config_option_update"
            && let Some(options) = update.get("configOptions")
            && options.is_array()
        {
            let mut patch = Map::with_capacity(1);
            patch.insert("configOptions", options.clone());
            let cfg_effects = self.configuration.update(&Value::Object(patch));
            self.push_config_effects(cfg_effects, effects);
        } else if !self.native_session_id.is_empty()
            && session_id == self.native_session_id
            && update_kind == "current_mode_update"
            && let Some(mode_id) = update.get("currentModeId").and_then(Value::as_str)
        {
            let cfg_effects = self.configuration.mode_changed(mode_id);
            self.push_config_effects(cfg_effects, effects);
        }

        if self.loading {
            return;
        }
        self.routing.receive(params_val);
        self.shells.receive(params_val);
        if !self.routing.has_live_children() {
            self.clear_deadline("children", effects);
        }
        if !self.shells.blocked() {
            self.clear_deadline("shells", effects);
        }
        let finished_children: Vec<JsString> = self
            .cancelling_children
            .iter()
            .filter(|id| !self.routing.is_live(id))
            .cloned()
            .collect();
        for id in finished_children {
            self.cancelling_children.shift_remove(&id);
            self.clear_deadline(&format!("child:{id}"), effects);
        }
        // A child that ended releases the prompt it held (`session.ts:251`).
        self.drain(effects);
    }

    /// Handle incoming agent-to-client JSON-RPC requests (`session.ts:798`–`:819`).
    pub(crate) fn handle_server_request(
        &mut self,
        id: RpcId,
        method: JsString,
        params: Option<Value>,
        effects: &mut Vec<AcpEffect>,
    ) {
        let params_val = params.unwrap_or_else(|| Value::Object(Map::new()));
        if matches!(
            method.as_str(),
            "cursor/task" | "cursor/update_todos" | "cursor/generate_image"
        ) {
            let reply = self.peer.answer(&id, &Value::Object(Map::new()));
            self.apply_peer_effects(reply, effects);
            return;
        }
        if interaction_request(method.as_str(), &params_val, self.quirks.translate_kind()).is_none()
        {
            let reply = self.peer.answer_not_found(&id);
            self.apply_peer_effects(reply, effects);
            return;
        }
        if self.closed {
            let reply = self.peer.answer(&id, &cancelled_outcome());
            self.apply_peer_effects(reply, effects);
            return;
        }
        let key = interaction_key(&to_translate_rpc_id(&id));
        if self.pending.contains_key(&key) {
            let reply =
                self.peer
                    .answer_error(&id, INTERNAL_ERROR, "Duplicate pending ACP request");
            self.apply_peer_effects(reply, effects);
            return;
        }
        if self.pending.len() >= MAX_PENDING_INTERACTIONS {
            self.fail("ACP incoming interaction capacity reached", effects);
            let reply =
                self.peer
                    .answer_error(&id, INTERNAL_ERROR, "ACP interaction capacity reached");
            self.apply_peer_effects(reply, effects);
            return;
        }
        let owner = self.routing.owner(&params_val, &self.native_session_id);
        if let Some(tool) = request_tool(method.as_str(), &params_val)
            && let Some(tool_id) = tool.get("toolCallId").and_then(js_string).cloned()
            && !self.shells.knows(&owner, &tool_id)
        {
            let mut synth = Map::with_capacity(2);
            synth.insert("sessionId", Value::String(owner.clone()));
            synth.insert("update", Value::Object(tool));
            self.shells.receive(&Value::Object(synth));
        }
        self.pending.insert(
            key,
            PendingInteraction {
                id,
                method,
                params: params_val,
                owner,
            },
        );
    }

    /// Cancel matching pending interaction requests (`session.ts:842`–`:849`).
    pub fn cancel_questions(
        &mut self,
        owners: Option<&HashSet<JsString>>,
        only: Option<&HashSet<JsString>>,
        effects: &mut Vec<AcpEffect>,
    ) {
        let matching: Vec<JsString> = self
            .pending
            .iter()
            .filter(|(key, item)| {
                owners.is_none_or(|set| set.contains(&item.owner))
                    && only.is_none_or(|set| set.contains(*key))
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in matching {
            let Some(item) = self.pending.shift_remove(&key) else {
                continue;
            };
            self.answered(&item, true);
            let reply = self.peer.answer(&item.id, &cancelled_outcome());
            self.apply_peer_effects(reply, effects);
        }
    }

    /// Notify shell settlement how a tool's request was answered (`session.ts:851`–`:855`).
    pub(crate) fn answered(&mut self, pending: &PendingInteraction, refused: bool) {
        let params = object(&pending.params);
        let tool = params
            .get("toolCallId")
            .and_then(js_string)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                object(params.get("toolCall").unwrap_or(&Value::Null))
                    .get("toolCallId")
                    .and_then(js_string)
                    .filter(|s| !s.is_empty())
            })
            .cloned();
        if let Some(tool_id) = tool {
            self.shells.answered(&pending.owner, &tool_id, refused);
        }
    }

    pub(crate) fn handle_deadline(&mut self, logical: &str, effects: &mut Vec<AcpEffect>) {
        if logical == "open" {
            self.on_open_stalled(effects);
        } else if logical == "children" {
            if self.routing.has_live_children() {
                self.fail(
                    "ACP child cancellation completion is unconfirmed after grace",
                    effects,
                );
            }
        } else if logical == "shells" {
            if self.shells.blocked() {
                self.fail(
                    "ACP shell cancellation completion is unconfirmed after grace",
                    effects,
                );
            }
        } else if logical == "root" {
            if self.prompt_id.is_some() {
                self.fail(
                    "ACP prompt cancellation is unconfirmed after grace",
                    effects,
                );
            }
        } else if let Some(child_id) = logical.strip_prefix("child:") {
            let child_js = JsString::from(child_id);
            self.cancelling_children.shift_remove(&child_js);
            if self.routing.expire(&child_js) && !self.routing.has_live_children() {
                self.clear_deadline("children", effects);
            }
            // A child given up at its grace no longer holds the queue (`session.ts:905`).
            self.drain(effects);
        }
    }
}

fn to_translate_rpc_id(id: &RpcId) -> crate::translate::data::RpcId {
    match id {
        RpcId::Text(text) => crate::translate::data::RpcId::Str(text.clone()),
        RpcId::Number(value) => crate::translate::data::RpcId::FloatBits(value.to_bits()),
    }
}

fn cancelled_outcome() -> Value {
    let mut inner = Map::with_capacity(1);
    inner.insert("outcome", Value::from("cancelled"));
    let mut outer = Map::with_capacity(1);
    outer.insert("outcome", Value::Object(inner));
    Value::Object(outer)
}
