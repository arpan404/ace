//! OpenAI Responses answers.

use serde_json::{Value, json};

use crate::{Frame, Script, Tokens};

fn usage(tokens: Tokens) -> Value {
    json!({
        "input_tokens": 11 + tokens.read, "output_tokens": 7, "total_tokens": 18 + tokens.read,
        "input_tokens_details": { "cached_tokens": tokens.read }
    })
}

fn message(text: &str) -> Value {
    json!({
        "type": "message", "id": "msg_1", "status": "completed", "role": "assistant",
        "content": [{ "type": "output_text", "text": text, "annotations": [] }]
    })
}

fn function_call(index: usize, id: &str, name: &str, arguments: &str) -> Value {
    json!({ "type": "function_call", "id": format!("fc_{index}"), "call_id": id, "name": name,
            "arguments": arguments, "status": "completed" })
}

fn output(script: &Script, text: &str) -> Vec<Value> {
    let mut items = Vec::new();
    if !text.is_empty() || script.calls.is_empty() {
        items.push(message(text));
    }
    for (index, call) in script.calls.iter().enumerate() {
        items.push(function_call(
            index,
            &call.id,
            &call.name,
            &call.arguments.to_string(),
        ));
    }
    items
}

pub(crate) fn reply(script: &Script, tokens: Tokens) -> Value {
    json!({
        "id": "resp_1", "object": "response", "status": "completed", "model": "fake",
        "output": output(script, &script.plain), "usage": usage(tokens)
    })
}

fn frame(name: &str, data: Value, text: bool) -> Frame {
    Frame {
        text,
        data: format!("event: {name}\ndata: {data}\n\n"),
    }
}

pub(crate) fn stream(script: &Script, tokens: Tokens) -> Vec<Frame> {
    let pieces = script.pieces();
    let full: String = pieces.concat();
    let mut frames = vec![frame(
        "response.created",
        json!({ "type": "response.created",
                "response": { "id": "resp_1", "status": "in_progress", "model": "fake", "output": [] } }),
        false,
    )];
    for text in &pieces {
        frames.push(frame(
            "response.output_text.delta",
            json!({ "type": "response.output_text.delta", "output_index": 0,
                    "content_index": 0, "delta": text }),
            true,
        ));
    }
    let offset = usize::from(!full.is_empty());
    for (index, call) in script.calls.iter().enumerate() {
        let arguments = call.arguments.to_string();
        frames.push(frame(
            "response.output_item.added",
            json!({ "type": "response.output_item.added", "output_index": index + offset,
                    "item": function_call(index, &call.id, &call.name, "") }),
            false,
        ));
        frames.push(frame(
            "response.output_item.done",
            json!({ "type": "response.output_item.done", "output_index": index + offset,
                    "item": function_call(index, &call.id, &call.name, &arguments) }),
            false,
        ));
    }
    frames.push(frame(
        "response.completed",
        json!({ "type": "response.completed",
                "response": { "id": "resp_1", "status": "completed", "model": "fake",
                              "output": output(script, &full), "usage": usage(tokens) } }),
        false,
    ));
    frames
}
