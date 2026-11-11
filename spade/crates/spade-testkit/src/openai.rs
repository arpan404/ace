//! OpenAI Chat Completions answers.

use serde_json::{Value, json};

use crate::{FakeThought, Frame, Script, Tokens};

/// OpenAI counts cached tokens inside `prompt_tokens`.
fn usage(tokens: Tokens) -> Value {
    json!({
        "prompt_tokens": 11 + tokens.read, "completion_tokens": 7,
        "total_tokens": 18 + tokens.read,
        "prompt_tokens_details": { "cached_tokens": tokens.read }
    })
}

fn finish(script: &Script) -> &'static str {
    if script.calls.is_empty() {
        "stop"
    } else {
        "tool_calls"
    }
}

pub(crate) fn reply(script: &Script, tokens: Tokens) -> Value {
    let calls: Vec<Value> = script
        .calls
        .iter()
        .map(|c| {
            json!({ "id": c.id, "type": "function",
                         "function": { "name": c.name, "arguments": c.arguments.to_string() } })
        })
        .collect();
    let mut message = json!({ "role": "assistant", "content": script.plain });
    let reasoning = reasoning(script);
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }
    json!({
        "id": "chatcmpl-1", "object": "chat.completion", "created": 0, "model": "fake",
        "choices": [{ "index": 0, "message": message, "finish_reason": finish(script) }],
        "usage": usage(tokens)
    })
}

fn chunk(delta: Value, finish_reason: Value) -> Frame {
    let event = json!({
        "id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0, "model": "fake",
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }]
    });
    Frame {
        text: false,
        data: format!("data: {event}\n\n"),
    }
}

/// Signed thinking, as the `reasoning_content` some OpenAI-compatible endpoints send.
fn reasoning(script: &Script) -> String {
    script
        .thoughts
        .iter()
        .filter_map(|t| match t {
            FakeThought::Signed { thinking, .. } => Some(thinking.as_str()),
            FakeThought::Redacted { .. } => None,
        })
        .collect()
}

pub(crate) fn stream(script: &Script, tokens: Tokens) -> Vec<Frame> {
    let mut frames: Vec<Frame> = Vec::new();
    let reasoning = reasoning(script);
    if !reasoning.is_empty() {
        frames.push(chunk(
            json!({ "reasoning_content": reasoning }),
            Value::Null,
        ));
    }
    frames.extend(script.pieces().into_iter().map(|content| Frame {
        text: true,
        ..chunk(json!({ "content": content }), Value::Null)
    }));
    for (index, call) in script.calls.iter().enumerate() {
        frames.push(chunk(
            json!({ "tool_calls": [{ "index": index, "id": call.id, "type": "function",
                                    "function": { "name": call.name, "arguments": "" } }] }),
            Value::Null,
        ));
        let arguments = call.arguments.to_string();
        let mut middle = arguments.len() / 2;
        while !arguments.is_char_boundary(middle) {
            middle += 1;
        }
        for part in [&arguments[..middle], &arguments[middle..]] {
            frames.push(chunk(
                json!({ "tool_calls": [{ "index": index, "function": { "arguments": part } }] }),
                Value::Null,
            ));
        }
    }
    frames.push(chunk(json!({}), json!(finish(script))));
    let usage_event = json!({
        "id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0, "model": "fake",
        "choices": [], "usage": usage(tokens)
    });
    frames.push(Frame {
        text: false,
        data: format!("data: {usage_event}\n\n"),
    });
    frames.push(Frame {
        text: false,
        data: "data: [DONE]\n\n".to_owned(),
    });
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The argument text the streamed frames add up to, in order.
    fn streamed_arguments(frames: &[Frame]) -> String {
        frames
            .iter()
            .filter_map(|frame| {
                let body = frame.data.strip_prefix("data: ")?.trim();
                let event: Value = serde_json::from_str(body).ok()?;
                let part = event["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"]
                    .as_str()?
                    .to_owned();
                Some(part)
            })
            .collect()
    }

    #[test]
    fn streams_non_ascii_tool_arguments_whole() {
        let arguments = json!({ "x": "€€" });
        let script = Script::reply("").call("call-1", "note", arguments.clone());
        let frames = stream(&script, Tokens { read: 0, write: 0 });
        let joined = streamed_arguments(&frames);
        assert_eq!(serde_json::from_str::<Value>(&joined).ok(), Some(arguments));
    }
}
