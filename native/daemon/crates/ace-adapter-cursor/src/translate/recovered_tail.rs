// SPDX-License-Identifier: Apache-2.0
//! A cut-off run's messages, read back from the SDK store after a restart and
//! turned back into the onDelta updates they were stored from
//! (`recovered-tail.ts`).

use super::envelope::{is, string};
use super::json::{J, encode_units, units_eq};

fn tool_update(body: &J) -> Option<J> {
    let call_id = string(body.get("call_id")?)?;
    let name = match body.get("name") {
        Some(J::Str(name)) => name.clone(),
        _ => encode_units("unknown"),
    };
    let mut tool_call = vec![(encode_units("type"), J::Str(name))];
    if let Some(args) = body.get("args") {
        tool_call.push((encode_units("args"), args.clone()));
    }
    if let Some(result) = body.get("result") {
        tool_call.push((encode_units("result"), result.clone()));
    }
    Some(J::Obj(vec![
        (
            encode_units("type"),
            J::Str(encode_units(
                if is(body.get("status").unwrap_or(&J::Null), "running") {
                    "tool-call-started"
                } else {
                    "tool-call-completed"
                },
            )),
        ),
        (encode_units("callId"), J::Str(call_id.to_vec())),
        (encode_units("toolCall"), J::Obj(tool_call)),
    ]))
}

/// The update a stored SDK message came from; none for bookkeeping ones.
pub fn stored_update(message: &J) -> Option<J> {
    let body = message;
    let kind = string(body.get("type")?)?;
    if units_eq(kind, "assistant") {
        let content = match body
            .get("message")
            .and_then(|message| message.get("content"))
        {
            Some(J::Arr(content)) => content,
            _ => return None,
        };
        let mut text = Vec::new();
        for part in content {
            if !is(part.get("type").unwrap_or(&J::Null), "text") {
                continue;
            }
            if let Some(part) = string(part.get("text").unwrap_or(&J::Null)) {
                text.extend_from_slice(part);
            }
        }
        if text.is_empty() {
            return None;
        }
        return Some(J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("text-delta"))),
            (encode_units("text"), J::Str(text)),
        ]));
    }
    if units_eq(kind, "thinking") {
        let text = match body.get("text") {
            Some(value) => string(value).unwrap_or(&[]),
            None => &[],
        };
        if text.is_empty() {
            let mut update = vec![(
                encode_units("type"),
                J::Str(encode_units("thinking-completed")),
            )];
            if let J::Num(duration) = body.get("thinking_duration_ms").unwrap_or(&J::Null) {
                update.push((encode_units("thinkingDurationMs"), J::Num(duration.clone())));
            }
            return Some(J::Obj(update));
        }
        return Some(J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("thinking-delta"))),
            (encode_units("text"), J::Str(text.to_vec())),
        ]));
    }
    if units_eq(kind, "tool_call") {
        return tool_update(body);
    }
    if units_eq(kind, "task") {
        let text = string(body.get("text")?)?;
        return Some(J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("summary"))),
            (encode_units("summary"), J::Str(text.to_vec())),
        ]));
    }
    None
}

/// Why some of a recovered tail is not in the SDK's store, in plain words.
pub fn store_gap(message: &J) -> Option<Vec<u16>> {
    let body = message;
    if !is(body.get("type").unwrap_or(&J::Null), "tool_call")
        || is(body.get("status").unwrap_or(&J::Null), "running")
    {
        return None;
    }
    let truncated = body.get("truncated").unwrap_or(&J::Null);
    if matches!(truncated.get("args"), Some(J::Bool(true)))
        || matches!(truncated.get("result"), Some(J::Bool(true)))
    {
        return Some(encode_units(
            "Cursor's saved session kept only a shortened copy of some tool input or output from that time.",
        ));
    }
    if is(body.get("name").unwrap_or(&J::Null), "task") {
        return Some(encode_units(
            "What a subagent did step by step in that time is not in Cursor's saved session; only its result is.",
        ));
    }
    None
}
