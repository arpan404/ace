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
    let chat = Mutex::new(BTreeMap::new());
    let previous = options.raw_frame_sink.take();
    let options = options.with_raw_frame_fn(move |context, frame| {
        if let Some(previous) = &previous {
            previous.on_frame(context, frame);
        }
        let event = frame.event.unwrap_or("message");
        match event {
            "response.output_item.done" => {
                if let Some(value) = frame.json()
                    && let Some(call) = response_call(&value["item"])
                {
                    let _ = send.send(call);
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
            "message" if frame.data.contains("\"tool_calls\"") => {
                if let Some(value) = frame.json() {
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

// Chat Completions closes the whole call list with a finish reason, before usage or [DONE].
fn chat_calls(calls: &mut BTreeMap<u64, ChatCall>, value: &Value) -> Vec<ToolCall> {
    let choice = &value["choices"][0];
    if let Some(deltas) = choice["delta"]["tool_calls"].as_array() {
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
    if choice["finish_reason"] != "tool_calls" {
        return Vec::new();
    }
    std::mem::take(calls)
        .into_values()
        .filter_map(|call| {
            if call.id.is_empty() || call.name.is_empty() {
                return None;
            }
            Some(ToolCall {
                id: call.id,
                name: call.name,
                arguments: serde_json::from_str(&call.json).ok()?,
            })
        })
        .collect()
}
