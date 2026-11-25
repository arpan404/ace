// SPDX-License-Identifier: Apache-2.0
//! Control requests this side sends and the tags waiting on their answers. Request ids are
//! `ace-<n>` from a counter here, so ids are ours and stay unique across reconnects of a line.

use ace_json::{Map, Value};

use crate::error::ControlError;

/// A `control_request` this side sends. Key order inside `request` is the order written here,
/// `subtype` first.
#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    Initialize(Initialize),
    Interrupt { cancel_queued: bool },
    SetModel(Option<String>),
    SetPermissionMode(String),
    ApplyFlagSettings(Map),
    StopTask(String),
    BackgroundTasks { tool_use_id: Option<String> },
    McpStatus,
    McpSetServers(Map),
    McpReconnect(String),
    McpToggle { server: String, enabled: bool },
    GetUsage { skip_behaviors: bool },
}

/// The `initialize` request's fields. Q2's recording shows the envelope, Q4's the isolated
/// `systemPrompt`. A `claude_code` preset sends no system prompt field at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Initialize {
    /// `(event, callback ids)` in insertion order; the ids are this side's own.
    pub hooks: Vec<(String, Vec<String>)>,
    /// `appendSystemPrompt`: the `claude_code` preset plus ace's text.
    pub append_system_prompt: Option<String>,
    /// `systemPrompt`: the isolated configuration sends `[""]` (Q4).
    pub system_prompt: Option<Vec<String>>,
    pub forward_subagent_text: bool,
    pub per_task_stop_affordance: bool,
}

/// Pending control requests and the tags waiting on them. Insertion order is kept; the pending
/// set is small (one per open call), so a list is enough and keeps the crate's dependencies to
/// `ace-json` and `thiserror`.
#[derive(Debug)]
pub struct Controls {
    next_id: u64,
    pending: Vec<(String, u64)>,
    closed: bool,
}

impl Default for Controls {
    fn default() -> Controls {
        Controls::new()
    }
}

impl Controls {
    pub fn new() -> Controls {
        Controls {
            next_id: 1,
            pending: Vec::new(),
            closed: false,
        }
    }

    /// The envelope to write, its request id, under the caller's `tag`. The envelope is
    /// `{request_id, type, request}`. A closed set refuses before anything is recorded.
    pub fn request(&mut self, request: Request, tag: u64) -> Result<(String, Value), ControlError> {
        if self.closed {
            return Err(ControlError::Closed);
        }
        let request_id = format!("ace-{}", self.next_id);
        self.next_id += 1;
        let mut envelope = Map::with_capacity(3);
        envelope.insert("request_id", Value::from(request_id.as_str()));
        envelope.insert("type", Value::from("control_request"));
        envelope.insert("request", Value::Object(request.into_map()));
        self.pending.push((request_id.clone(), tag));
        Ok((request_id, Value::Object(envelope)))
    }

    /// Which tag a response settles; `None` for an id nobody waits on, which stays a `wire`
    /// frame.
    pub fn settle(&mut self, request_id: &str) -> Option<u64> {
        let at = self.pending.iter().position(|(id, _)| id == request_id)?;
        Some(self.pending.remove(at).1)
    }

    /// Every tag still pending, in insertion order, for closing. The controls close with this
    /// call, so every later `request` is refused.
    pub fn drain(&mut self) -> Vec<u64> {
        self.closed = true;
        self.pending.drain(..).map(|(_, tag)| tag).collect()
    }
}

impl Request {
    fn into_map(self) -> Map {
        let mut map = Map::new();
        match self {
            Request::Initialize(init) => {
                map.insert("subtype", Value::from("initialize"));
                if !init.hooks.is_empty() {
                    let mut hooks = Map::new();
                    for (event, ids) in init.hooks {
                        let mut matcher = Map::with_capacity(1);
                        let ids = Value::from(ids.into_iter().map(Value::from).collect::<Vec<_>>());
                        matcher.insert("hookCallbackIds", ids);
                        hooks.insert(event, Value::from(vec![Value::Object(matcher)]));
                    }
                    map.insert("hooks", Value::Object(hooks));
                }
                if let Some(prompt) = init.append_system_prompt {
                    map.insert("appendSystemPrompt", Value::from(prompt));
                }
                if let Some(prompts) = init.system_prompt {
                    map.insert(
                        "systemPrompt",
                        Value::from(prompts.into_iter().map(Value::from).collect::<Vec<_>>()),
                    );
                }
                map.insert(
                    "forwardSubagentText",
                    Value::Bool(init.forward_subagent_text),
                );
                map.insert(
                    "perTaskStopAffordance",
                    Value::Bool(init.per_task_stop_affordance),
                );
            }
            Request::Interrupt { cancel_queued } => {
                map.insert("subtype", Value::from("interrupt"));
                if cancel_queued {
                    map.insert("cancel_queued", Value::Bool(true));
                }
            }
            Request::SetModel(model) => {
                map.insert("subtype", Value::from("set_model"));
                if let Some(model) = model {
                    map.insert("model", Value::from(model));
                }
            }
            Request::SetPermissionMode(mode) => {
                map.insert("subtype", Value::from("set_permission_mode"));
                map.insert("mode", Value::from(mode));
            }
            Request::ApplyFlagSettings(settings) => {
                map.insert("subtype", Value::from("apply_flag_settings"));
                map.insert("settings", Value::Object(settings));
            }
            Request::StopTask(task_id) => {
                map.insert("subtype", Value::from("stop_task"));
                map.insert("task_id", Value::from(task_id));
            }
            Request::BackgroundTasks { tool_use_id } => {
                map.insert("subtype", Value::from("background_tasks"));
                if let Some(tool_use_id) = tool_use_id {
                    map.insert("tool_use_id", Value::from(tool_use_id));
                }
            }
            Request::McpStatus => {
                map.insert("subtype", Value::from("mcp_status"));
            }
            Request::McpSetServers(servers) => {
                map.insert("subtype", Value::from("mcp_set_servers"));
                map.insert("servers", Value::Object(servers));
            }
            Request::McpReconnect(server) => {
                map.insert("subtype", Value::from("mcp_reconnect"));
                map.insert("serverName", Value::from(server));
            }
            Request::McpToggle { server, enabled } => {
                map.insert("subtype", Value::from("mcp_toggle"));
                map.insert("serverName", Value::from(server));
                map.insert("enabled", Value::Bool(enabled));
            }
            Request::GetUsage { skip_behaviors } => {
                map.insert("subtype", Value::from("get_usage"));
                if skip_behaviors {
                    map.insert("skip_behaviors", Value::Bool(true));
                }
            }
        }
        map
    }
}
