// SPDX-License-Identifier: Apache-2.0
//! Request answers (`requests.ts` answering half).

use crate::translate::completed_tools::retire_tool;
use crate::translate::data::{object, raw};
use crate::translate::settlement::{answer_is_neutral, answer_refuses_tool};
use crate::translate::state::TranslationState;
use crate::translate::tool_final::finalize_tool;
use crate::translate::tool_raw::retain_tool_raw;
use ace_json::{Map, Value};

/// Answer an open request. Returns true when the frame is handled.
pub fn answer_request(
    state: &mut TranslationState,
    id: &crate::translate::data::RpcId,
    result: &Value,
    frame: &Value,
    facts: &mut Vec<Value>,
) -> bool {
    let key = crate::translate::state::rpc_key(id);
    let Some(pending) = state.requests.shift_remove(&key) else {
        return false;
    };
    let result_map = object(result);
    let resolution = crate::translate::interactions::decode_resolution(
        &pending.method,
        &Value::Object(pending.params.clone()),
        result,
        &pending.request,
    );
    let cancelled = object(result_map.get("outcome").unwrap_or(&Value::Null))
        .get("outcome")
        .and_then(Value::as_str)
        .is_some_and(|outcome| outcome == "cancelled");
    let mut closed = Map::with_capacity(4);
    closed.insert(
        "type".to_owned(),
        Value::from("interaction.closed".to_owned()),
    );
    closed.insert("interaction".to_owned(), Value::from(pending.key.clone()));
    closed.insert(
        "state".to_owned(),
        Value::from(if cancelled {
            "cancelled".to_owned()
        } else {
            "resolved".to_owned()
        }),
    );
    if let Some(resolution) = resolution.clone() {
        closed.insert("resolution".to_owned(), resolution);
    }
    facts.push(Value::Object(closed));
    if let Some(tool_key) = pending.tool_key {
        let request_kind = pending
            .request
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("");
        let request_options: Vec<Value> = pending
            .request
            .get("options")
            .and_then(Value::as_array)
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let declined =
            answer_refuses_tool(request_kind, &request_options, resolution.as_ref(), false);
        let neutral = answer_is_neutral(request_kind, &request_options, resolution.as_ref());
        let status = if declined {
            "declined"
        } else if cancelled {
            "cancelled"
        } else if neutral {
            "pending"
        } else {
            "running"
        };
        let settled = status != "running";
        if let Some(tool) = state.tools.get_mut(&tool_key) {
            tool.declined = declined;
            tool.status = status.to_owned();
        }
        if settled {
            state.live_tools.shift_remove(&tool_key);
        } else {
            state.live_tools.insert(tool_key.clone());
        }
        let payload = raw(frame, &pending.method, None);
        let update = Value::Object(Map::new());
        if let Some(tool) = state.tools.get_mut(&tool_key) {
            let mut owned = tool.clone();
            retain_tool_raw(&mut owned, payload, &update);
            *tool = owned;
        }
        let detail = if settled {
            let quirks = state.quirks;
            state
                .tools
                .get_mut(&tool_key)
                .map(|tool| finalize_tool(tool, quirks))
        } else {
            None
        };
        if let Some(tool) = state.tools.get(&tool_key) {
            let mut call = Map::with_capacity(3);
            call.insert("status".to_owned(), Value::from(status.to_owned()));
            if let Some(detail) = detail {
                call.insert("detail".to_owned(), detail);
            }
            call.insert("raw".to_owned(), Value::from(tool.raw.clone()));
            let mut draft = Map::with_capacity(3);
            draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(settled));
            draft.insert("call".to_owned(), Value::Object(call));
            let mut fact = Map::with_capacity(4);
            fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
            fact.insert("agent".to_owned(), Value::from(pending.owner_key.clone()));
            fact.insert("item".to_owned(), Value::from(tool.key.clone()));
            fact.insert("draft".to_owned(), Value::Object(draft));
            facts.push(Value::Object(fact));
        }
        retire_tool(state, &tool_key);
    }
    true
}
