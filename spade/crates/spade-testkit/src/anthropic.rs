//! Anthropic Messages answers.

use serde_json::{Value, json};

use crate::{FakeThought, Frame, Script, Tokens};

/// Anthropic reports uncached input apart from cache reads and writes.
fn usage(tokens: Tokens) -> Value {
    json!({
        "input_tokens": 11, "output_tokens": 7,
        "cache_read_input_tokens": tokens.read, "cache_creation_input_tokens": tokens.write
    })
}

fn stop(script: &Script) -> &'static str {
    if script.calls.is_empty() {
        "end_turn"
    } else {
        "tool_use"
    }
}

fn thought_block(thought: &FakeThought) -> Value {
    match thought {
        FakeThought::Signed {
            thinking,
            signature,
        } => json!({ "type": "thinking", "thinking": thinking, "signature": signature }),
        FakeThought::Redacted { data } => json!({ "type": "redacted_thinking", "data": data }),
    }
}

pub(crate) fn reply(script: &Script, tokens: Tokens) -> Value {
    let mut content: Vec<Value> = script.thoughts.iter().map(thought_block).collect();
    if !script.plain.is_empty() || script.calls.is_empty() {
        content.push(json!({ "type": "text", "text": script.plain }));
    }
    for call in &script.calls {
        content.push(json!({ "type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments }));
    }
    json!({
        "id": "msg_1", "type": "message", "role": "assistant", "model": "fake",
        "content": content, "stop_reason": stop(script), "stop_sequence": null,
        "usage": usage(tokens)
    })
}

fn frame(name: &str, data: Value, text: bool) -> Frame {
    Frame {
        text,
        data: format!("event: {name}\ndata: {data}\n\n"),
    }
}

pub(crate) fn stream(script: &Script, tokens: Tokens) -> Vec<Frame> {
    let mut frames = vec![frame(
        "message_start",
        json!({ "type": "message_start", "message": {
            "id": "msg_1", "type": "message", "role": "assistant", "model": "fake",
            "content": [], "stop_reason": null, "stop_sequence": null,
            "usage": { "input_tokens": 11, "output_tokens": 0,
                       "cache_read_input_tokens": tokens.read,
                       "cache_creation_input_tokens": tokens.write } } }),
        false,
    )];
    let mut index = 0;
    for thought in &script.thoughts {
        let (start, deltas) = match thought {
            FakeThought::Signed {
                thinking,
                signature,
            } => (
                json!({ "type": "thinking", "thinking": "" }),
                vec![
                    json!({ "type": "thinking_delta", "thinking": thinking }),
                    json!({ "type": "signature_delta", "signature": signature }),
                ],
            ),
            FakeThought::Redacted { .. } => (thought_block(thought), Vec::new()),
        };
        frames.push(frame(
            "content_block_start",
            json!({ "type": "content_block_start", "index": index, "content_block": start }),
            false,
        ));
        for delta in deltas {
            frames.push(frame(
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": index, "delta": delta }),
                false,
            ));
        }
        frames.push(frame(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": index }),
            false,
        ));
        index += 1;
    }
    let pieces = script.pieces();
    if !pieces.is_empty() {
        frames.push(frame(
            "content_block_start",
            json!({ "type": "content_block_start", "index": index,
                    "content_block": { "type": "text", "text": "" } }),
            false,
        ));
        for text in pieces {
            frames.push(frame(
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": index,
                        "delta": { "type": "text_delta", "text": text } }),
                true,
            ));
        }
        frames.push(frame(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": index }),
            false,
        ));
        index += 1;
    }
    for call in &script.calls {
        frames.push(frame(
            "content_block_start",
            json!({ "type": "content_block_start", "index": index,
                    "content_block": { "type": "tool_use", "id": call.id, "name": call.name, "input": {} } }),
            false,
        ));
        frames.push(frame(
            "content_block_delta",
            json!({ "type": "content_block_delta", "index": index,
                    "delta": { "type": "input_json_delta", "partial_json": call.arguments.to_string() } }),
            false,
        ));
        frames.push(frame(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": index }),
            false,
        ));
        index += 1;
    }
    frames.push(frame(
        "message_delta",
        json!({ "type": "message_delta", "delta": { "stop_reason": stop(script), "stop_sequence": null },
                "usage": { "output_tokens": 7 } }),
        false,
    ));
    frames.push(frame(
        "message_stop",
        json!({ "type": "message_stop" }),
        false,
    ));
    frames
}
