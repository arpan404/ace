// SPDX-License-Identifier: Apache-2.0
//! Tool call views: upserts, outputs and surviving-call fences
//! (`tool-events.ts`).

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value, json};

use super::children::Children;
use super::envelope::{Envelope, native_identity, object, string};
use super::tool_names::{ARGS_BYTES, bounded_json, is_ace_call};
use super::tool_output::utf16_slice;
use super::tools::{tool_detail, tool_kind, tool_status};
use super::transcript::Transcript;
use super::{BudgetError, BudgetResult};

pub(crate) struct Tool {
    pub(crate) agent: String,
    pub(crate) name: String,
    pub(crate) args: Option<Value>,
    pub(crate) args_bytes: usize,
    pub(crate) terminal: bool,
    pub(crate) failed: bool,
    pub(crate) output: bool,
    pub(crate) surviving: bool,
}

/// The open tool calls of a turn, with their retained arguments.
pub struct ToolEvents {
    pub(crate) calls: BTreeMap<String, Tool>,
    retained_bytes: usize,
    pub(crate) pending_by_owner: BTreeMap<String, HashSet<String>>,
    limit: usize,
    retained_limit: usize,
}

impl ToolEvents {
    pub fn new(limit: usize, retained_limit: usize) -> Self {
        ToolEvents {
            calls: BTreeMap::new(),
            retained_bytes: 0,
            pending_by_owner: BTreeMap::new(),
            limit,
            retained_limit,
        }
    }

    /// Whether any tool call is still open.
    pub fn has_open(&self) -> bool {
        self.calls.values().any(|tool| !tool.terminal)
    }

    /// The owning agent of a tool call, if it is tracked.
    pub fn agent_of(&self, call: &str) -> Option<&str> {
        self.calls.get(call).map(|tool| tool.agent.as_str())
    }

    pub fn trim(&mut self) {
        let terminal: Vec<String> = self
            .calls
            .iter()
            .filter(|(_, tool)| tool.terminal)
            .map(|(call, _)| call.clone())
            .collect();
        for call in terminal {
            if let Some(tool) = self.calls.remove(&call) {
                self.retained_bytes -= tool.args_bytes;
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn translate(
        &mut self,
        body: &Map<String, Value>,
        agent: &str,
        namespace: &str,
        event: Option<&Envelope>,
        envelope: &Value,
        transcript: &mut Transcript,
        children: &mut Children,
        operation: Option<&str>,
        segment: i64,
        cwd: &str,
        notice: &mut dyn FnMut(&str, &Value, &str) -> Value,
    ) -> BudgetResult<Vec<Value>> {
        let kind = string(body.get("type").unwrap_or(&Value::Null));
        if kind != Some("tool-call-started")
            && kind != Some("partial-tool-call")
            && kind != Some("tool-call-completed")
        {
            return Ok(Vec::new());
        }
        let call_id = native_identity(body.get("callId").unwrap_or(&Value::Null))?;
        let Some(call_id) = call_id else {
            return Ok(vec![notice(
                "SDK tool update lacks native call identity",
                envelope,
                "warning",
            )]);
        };
        let call = format!("{namespace}:call:{call_id}");
        let native = object(body.get("toolCall").unwrap_or(&Value::Null));
        let existing_name = self.calls.get(&call).map(|tool| tool.name.clone());
        let name = native_identity(native.get("name").unwrap_or(&Value::Null))?
            .or(native_identity(native.get("type").unwrap_or(&Value::Null))?)
            .or(existing_name)
            .unwrap_or_else(|| "unknown".to_owned());
        if !self.calls.contains_key(&call) {
            if self.calls.len() + children.calls.len() >= self.limit {
                return Err(BudgetError::Exceeded);
            }
            self.calls.insert(
                call.clone(),
                Tool {
                    agent: agent.to_owned(),
                    name: name.clone(),
                    args: None,
                    args_bytes: 0,
                    terminal: false,
                    failed: false,
                    output: false,
                    surviving: false,
                },
            );
            self.pending_by_owner
                .entry(agent.to_owned())
                .or_default()
                .insert(call.clone());
        }
        let tool = self.calls.get_mut(&call).ok_or(BudgetError::Exceeded)?;
        tool.name = name.clone();
        if let Some(args) = native.get("args") {
            let text = bounded_json(args, ARGS_BYTES)?;
            let args_bytes = text.len();
            let retained = self.retained_bytes - tool.args_bytes + args_bytes;
            if retained > self.retained_limit {
                return Err(BudgetError::Exceeded);
            }
            self.retained_bytes = retained;
            tool.args_bytes = args_bytes;
            tool.args = Some(args.clone());
        }
        let result = native.get("result").unwrap_or(&Value::Null);
        let status = tool_status(
            if kind == Some("tool-call-completed") {
                "completed"
            } else {
                "running"
            },
            result,
        );
        let tool = self.calls.get_mut(&call).ok_or(BudgetError::Exceeded)?;
        tool.failed = tool.failed || status == "failed";
        if tool.terminal && kind != Some("tool-call-completed") {
            return Ok(Vec::new());
        }
        tool.terminal = tool.terminal || status != "running";
        let owner = tool.agent.clone();
        let terminal = tool.terminal;
        let failed = tool.failed;
        if (terminal || tool_kind(&name) == "agent.spawn")
            && let Some(pending) = self.pending_by_owner.get_mut(&owner)
        {
            pending.remove(&call);
            if pending.is_empty() {
                self.pending_by_owner.remove(&owner);
            }
        }
        let stale = event.is_none_or(|event| {
            event.operation_id != operation.unwrap_or("") || event.segment != segment
        });
        let mut facts = if stale {
            Vec::new()
        } else {
            transcript.boundary(agent)
        };
        let tool = self.calls.get_mut(&call).ok_or(BudgetError::Exceeded)?;
        if terminal && tool.surviving {
            tool.surviving = false;
            facts.push(json!({
                "type": "background.ended",
                "task": format!("surviving:{call}"),
                "status": if failed { "failed" } else { "completed" },
            }));
        }
        if tool_kind(&name) == "agent.spawn" {
            let args = tool.args.clone().unwrap_or(Value::Null);
            facts.extend(children.ensure(&call, agent, &args, cwd)?);
            if terminal {
                let child_result = children.result(&call, result, failed, cwd)?;
                let settled = child_result
                    .iter()
                    .any(|fact| fact.get("type") == Some(&Value::String("turn.ended".to_owned())));
                let child_key = children.calls.get(&call).map(|child| child.key.clone());
                if settled && let Some(child_key) = child_key {
                    facts.extend(transcript.boundary(&child_key));
                    facts.extend(self.preserve(Some(&child_key)));
                    facts.extend(children.preserve_owned(&child_key));
                }
                facts.extend(child_result);
            }
        }
        let tool = self.calls.get(&call).ok_or(BudgetError::Exceeded)?;
        let detail = tool_detail(&name, tool.args.as_ref().unwrap_or(&Value::Null), result);
        let detail_kind = string(detail.get("kind").unwrap_or(&Value::Null)).unwrap_or("");
        let ace = is_ace_call(object(&detail), detail_kind, &tool.name);
        let real_error = if ace {
            object(object(result).get("value").unwrap_or(&Value::Null)).clone()
        } else {
            Map::new()
        };
        let error_text = match real_error.get("content") {
            Some(Value::Array(content)) => {
                let joined = content
                    .iter()
                    .map(|block| {
                        string(object(block).get("text").unwrap_or(&Value::Null)).unwrap_or("")
                    })
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                utf16_slice(&joined, 4096)
            }
            _ => string(real_error.get("message").unwrap_or(&Value::Null))
                .unwrap_or("")
                .to_owned(),
        };
        let mut call_view = json!({
            "kind": tool_kind(&name),
            "title": name,
            "status": if failed { "failed" } else { status },
            "detail": detail,
            "raw": [event.and_then(|event| event.raw.cloned()).unwrap_or_else(|| json!({
                "type": "cursor.sdk.tool",
                "name": name,
                "data": envelope.clone(),
            }))],
        });
        if failed {
            call_view["error"] = Value::String(if error_text.is_empty() {
                "Cursor tool failed or was denied by execution policy".to_owned()
            } else {
                error_text
            });
        }
        facts.push(json!({
            "type": "item.upsert",
            "agent": agent,
            "item": call,
            "draft": { "type": "tool_call", "complete": terminal, "call": call_view },
        }));
        if event.and_then(|event| event.raw).is_some() {
            facts.push(notice(
                "SDK semantic preview is bounded; full redacted raw data is retained in the referenced blob",
                envelope,
                "warning",
            ));
        }
        let truncation = object(native.get("truncated").unwrap_or(&Value::Null));
        if truncation.get("args") == Some(&Value::Bool(true))
            || truncation.get("result") == Some(&Value::Bool(true))
        {
            facts.push(notice(
                "Cursor SDK tool args/result were truncated by the SDK",
                envelope,
                "warning",
            ));
        }
        let result_value = object(object(result).get("value").unwrap_or(&Value::Null));
        if tool_kind(&name) == "shell"
            && terminal
            && !self.calls.get(&call).ok_or(BudgetError::Exceeded)?.output
            && body.get("aceOutputStream") != Some(&Value::Bool(true))
        {
            let output = format!(
                "{}{}",
                string(result_value.get("stdout").unwrap_or(&Value::Null)).unwrap_or(""),
                string(result_value.get("stderr").unwrap_or(&Value::Null)).unwrap_or("")
            );
            if !output.is_empty() {
                facts.push(json!({
                    "type": "item.delta",
                    "agent": agent,
                    "item": call,
                    "field": "output",
                    "append": output,
                }));
                self.calls
                    .get_mut(&call)
                    .ok_or(BudgetError::Exceeded)?
                    .output = true;
            }
        }
        Ok(facts)
    }
}
