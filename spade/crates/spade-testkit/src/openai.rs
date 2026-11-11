//! OpenAI Chat Completions answers.

use serde_json::{Value, json};

use crate::{Frame, Script, Tokens};

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

pub(crate) fn stream(script: &Script, tokens: Tokens) -> Vec<Frame> {
    let mut frames: Vec<Frame> = script
        .pieces()
        .into_iter()
        .map(|content| Frame {
            text: true,
            ..chunk(json!({ "content": content }), Value::Null)
        })
        .collect();
    for (index, call) in script.calls.iter().enumerate() {
        frames.push(chunk(
            json!({ "tool_calls": [{ "index": index, "id": call.id, "type": "function",
                                    "function": { "name": call.name, "arguments": "" } }] }),
            Value::Null,
        ));
        let arguments = call.arguments.to_string();
        let middle = arguments.len() / 2;
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
