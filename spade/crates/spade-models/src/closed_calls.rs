//! Observe explicit call boundaries without replacing the SDK's final reply decoder.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use genai::chat::ChatOptions;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::ToolCall;

pub(crate) fn tap(mut options: ChatOptions) -> (ChatOptions, mpsc::UnboundedReceiver<ToolCall>) {
    let (send, receive) = mpsc::unbounded_channel();
    let blocks = Mutex::new(HashMap::new());
    let chat = Mutex::new(ChatChoices::default());
    let responses = Mutex::new(Vec::new());
    let previous = options.raw_frame_sink.take();
    let options = options.with_raw_frame_fn(move |context, frame| {
        if let Some(previous) = &previous {
            previous.on_frame(context, frame);
        }
        let event = frame.event.unwrap_or("message");
        match event {
            "response.output_item.done" | "response.completed" | "response.incomplete" => {
                if let Some(value) = frame.json() {
                    response_frame(&responses, &send, event, &value);
                }
            }
            "content_block_start" | "content_block_delta" | "content_block_stop" => {
                if let Some(value) = frame.json()
                    && let Some(call) = anthropic_call(
                        &mut blocks.lock().unwrap_or_else(|p| p.into_inner()),
                        event,
                        &value,
                    )
                {
                    let _ = send.send(call);
                }
            }
            "message" => {
                if let Some(value) = frame.json() {
                    if let Some(event) = value["type"].as_str() {
                        response_frame(&responses, &send, event, &value);
                    }
                    for call in
                        chat_calls(&mut chat.lock().unwrap_or_else(|p| p.into_inner()), &value)
                    {
                        let _ = send.send(call);
                    }
                }
            }
            _ => {}
        }
    });
    (options, receive)
}

// The Responses SDK also synthesizes a final reply at EOF. Only an explicit terminal
// event lets us offer those boundaries to the early gate.
fn response_frame(
    pending: &Mutex<Vec<ToolCall>>,
    send: &mpsc::UnboundedSender<ToolCall>,
    event: &str,
    value: &Value,
) {
    match event {
        "response.output_item.done" => {
            if let Some(call) = response_call(&value["item"]) {
                pending.lock().unwrap_or_else(|p| p.into_inner()).push(call);
            }
        }
        "response.completed" | "response.incomplete"
            if value["type"] == event && value["response"]["id"].is_string() =>
        {
            let mut pending = pending.lock().unwrap_or_else(|p| p.into_inner());
            for call in pending.drain(..) {
                let _ = send.send(call);
            }
        }
        _ => {}
    }
}

fn response_call(item: &Value) -> Option<ToolCall> {
    if item["type"] != "function_call" || item["status"] != "completed" {
        return None;
    }
    Some(ToolCall {
        id: item["call_id"].as_str()?.to_owned(),
        name: item["name"].as_str()?.to_owned(),
        arguments: serde_json::from_str(item["arguments"].as_str()?).ok()?,
    })
}

struct Block {
    call: ToolCall,
    json: String,
}

fn anthropic_call(
    blocks: &mut HashMap<u64, Block>,
    event: &str,
    value: &Value,
) -> Option<ToolCall> {
    let index = value["index"].as_u64()?;
    match event {
        "content_block_start" => {
            let item = &value["content_block"];
            if item["type"] == "tool_use" {
                blocks.insert(
                    index,
                    Block {
                        call: ToolCall {
                            id: item["id"].as_str()?.to_owned(),
                            name: item["name"].as_str()?.to_owned(),
                            arguments: item["input"].as_object().map(|_| item["input"].clone())?,
                        },
                        json: String::new(),
                    },
                );
            }
            None
        }
        "content_block_delta" => {
            let delta = &value["delta"];
            if delta["type"] == "input_json_delta" {
                blocks
                    .get_mut(&index)?
                    .json
                    .push_str(delta["partial_json"].as_str()?);
            }
            None
        }
        "content_block_stop" => {
            let Block { mut call, json } = blocks.remove(&index)?;
            if !json.is_empty() {
                call.arguments = serde_json::from_str(&json).ok()?;
            }
            Some(call)
        }
        _ => None,
    }
}

#[derive(Default)]
struct ChatCall {
    id: String,
    name: String,
    json: String,
}

#[derive(Default)]
struct ChatChoices {
    selected: Option<u64>,
    pending: BTreeMap<u64, BTreeMap<u64, ChatCall>>,
}

// The SDK builds the final reply from one choice. Track each choice structurally, but only
// expose calls from the selected one to the early gate.
fn chat_calls(choices: &mut ChatChoices, value: &Value) -> Vec<ToolCall> {
    let mut closed = Vec::new();
    let Some(frames) = value["choices"].as_array() else {
        return closed;
    };
    if let Some(first) = frames.first() {
        choices
            .selected
            .get_or_insert(first["index"].as_u64().unwrap_or(0));
    }
    for (position, choice) in frames.iter().enumerate() {
        let index = choice["index"].as_u64().unwrap_or(position as u64);
        if let Some(deltas) = choice["delta"]["tool_calls"].as_array() {
            let calls = choices.pending.entry(index).or_default();
            for delta in deltas {
                let Some(index) = delta["index"].as_u64() else {
                    continue;
                };
                let call = calls.entry(index).or_default();
                if let Some(id) = delta["id"].as_str() {
                    call.id.push_str(id);
                }
                if let Some(name) = delta["function"]["name"].as_str() {
                    call.name.push_str(name);
                }
                if let Some(part) = delta["function"]["arguments"].as_str() {
                    call.json.push_str(part);
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str()
            && let Some(calls) = choices.pending.remove(&index)
            && reason == "tool_calls"
            && choices.selected == Some(index)
        {
            closed.extend(calls.into_values().filter_map(|call| {
                if call.id.is_empty() || call.name.is_empty() {
                    return None;
                }
                Some(ToolCall {
                    id: call.id,
                    name: call.name,
                    arguments: serde_json::from_str(&call.json).ok()?,
                })
            }));
        }
    }
    closed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_boundaries_decode_escaped_keys_and_keep_choice_arguments_separate()
    -> serde_json::Result<()> {
        let mut choices = ChatChoices::default();
        let start = serde_json::from_str(
            r#"{"choices":[
            {"index":0,"delta":{"tool\u005fcalls":[{"index":0,"id":"a","function":{"name":"read","arguments":"1"}}]}},
            {"index":1,"delta":{"tool_calls":[{"index":0,"id":"b","function":{"name":"read","arguments":"2"}}]}}
        ]}"#,
        )?;
        assert!(chat_calls(&mut choices, &start).is_empty());
        let finish = serde_json::from_str(
            r#"{"choices":[
            {"index":1,"finish_reason":"tool_calls"},
            {"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"0"}}]},"finish_reason":"tool\u005fcalls"}
        ]}"#,
        )?;
        let calls = chat_calls(&mut choices, &finish);
        assert_eq!(
            calls
                .into_iter()
                .map(|call| (call.id, call.arguments))
                .collect::<Vec<_>>(),
            vec![("a".to_owned(), serde_json::json!(10))]
        );
        Ok(())
    }
}
