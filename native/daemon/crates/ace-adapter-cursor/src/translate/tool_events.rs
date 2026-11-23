// SPDX-License-Identifier: Apache-2.0
//! Tool call views: upserts, outputs and surviving-call fences
//! (`tool-events.ts`).

use std::collections::{BTreeMap, BTreeSet};

use super::children::Children;
use super::envelope::{cat, is, native_identity, string};
use super::text::{JsString, Value, units_eq};
use super::tool_names::{ARGS_BYTES, bounded_json, is_ace_call, utf16_slice};
use super::tools::{tool_detail, tool_kind, tool_status};
use super::transcript::Transcript;
use super::{BudgetError, BudgetResult};

pub(crate) struct Tool {
    pub(crate) agent: JsString,
    pub(crate) name: JsString,
    pub(crate) args: Option<Value>,
    pub(crate) args_bytes: usize,
    pub(crate) terminal: bool,
    pub(crate) failed: bool,
    pub(crate) output: bool,
    pub(crate) surviving: bool,
}

/// The open tool calls of a turn, with their retained arguments.
pub struct ToolEvents {
    pub(crate) calls: BTreeMap<JsString, Tool>,
    retained_bytes: usize,
    pub(crate) pending_by_owner: BTreeMap<JsString, BTreeSet<JsString>>,
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
    pub fn agent_of(&self, call: &JsString) -> Option<&JsString> {
        self.calls.get(call).map(|tool| &tool.agent)
    }

    pub fn trim(&mut self) {
        let terminal: Vec<JsString> = self
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
        body: &Value,
        agent: &JsString,
        namespace: &JsString,
        event: Option<&super::envelope::Envelope>,
        envelope: &Value,
        transcript: &mut Transcript,
        children: &mut Children,
        operation: Option<&JsString>,
        segment: i64,
        cwd: &JsString,
        notice: &mut dyn FnMut(&JsString, &Value, &str) -> Value,
    ) -> BudgetResult<Vec<Value>> {
        let kind = string(body.get("type").unwrap_or(&Value::Null));
        if !kind.is_some_and(|kind| {
            units_eq(kind, "tool-call-started")
                || units_eq(kind, "partial-tool-call")
                || units_eq(kind, "tool-call-completed")
        }) {
            return Ok(Vec::new());
        }
        let call_id = native_identity(body.get("callId").unwrap_or(&Value::Null))?;
        let Some(call_id) = call_id else {
            return Ok(vec![notice(
                &JsString::from("SDK tool update lacks native call identity"),
                envelope,
                "warning",
            )]);
        };
        let call = cat(&[namespace, &JsString::from(":call:"), &call_id]);
        let native = body.get("toolCall").unwrap_or(&Value::Null);
        let existing_name = self.calls.get(&call).map(|tool| tool.name.clone());
        let name = native_identity(native.get("name").unwrap_or(&Value::Null))?
            .or(native_identity(native.get("type").unwrap_or(&Value::Null))?)
            .or(existing_name)
            .unwrap_or_else(|| JsString::from("unknown"));
        if !self.calls.contains_key(&call) {
            if self.calls.len() + children.calls.len() >= self.limit {
                return Err(BudgetError::Exceeded);
            }
            self.calls.insert(
                call.clone(),
                Tool {
                    agent: agent.clone(),
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
                .entry(agent.clone())
                .or_default()
                .insert(call.clone());
        }
        if let Some(args) = native.get("args") {
            let text = bounded_json(args, ARGS_BYTES)?;
            let args_bytes = text.len();
            let retained = self
                .calls
                .get(&call)
                .map(|tool| tool.args_bytes)
                .ok_or(BudgetError::Exceeded)?;
            let retained = self.retained_bytes - retained + args_bytes;
            if retained > self.retained_limit {
                return Err(BudgetError::Exceeded);
            }
            self.retained_bytes = retained;
            let tool = self.calls.get_mut(&call).ok_or(BudgetError::Exceeded)?;
            tool.args_bytes = args_bytes;
            tool.args = Some(args.clone());
        }
        let result = native.get("result").unwrap_or(&Value::Null);
        let status_word = if is(body.get("type").unwrap_or(&Value::Null), "tool-call-completed") {
            JsString::from("completed")
        } else {
            JsString::from("running")
        };
        let status = tool_status(&status_word, result);
        let tool = self.calls.get_mut(&call).ok_or(BudgetError::Exceeded)?;
        tool.name = name.clone();
        tool.failed = tool.failed || status == "failed";
        if tool.terminal && !is(body.get("type").unwrap_or(&Value::Null), "tool-call-completed") {
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
        let stale = event
            .is_none_or(|event| Some(event.operation_id) != operation || event.segment != segment);
        let mut facts = if stale {
            Vec::new()
        } else {
            transcript.boundary(agent)
        };
        let tool = self.calls.get_mut(&call).ok_or(BudgetError::Exceeded)?;
        if terminal && tool.surviving {
            tool.surviving = false;
            facts.push(Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("background.ended")),
                ),
                (
                    JsString::from("task"),
                    Value::String(cat(&[&JsString::from("surviving:"), &call])),
                ),
                (
                    JsString::from("status"),
                    Value::String(JsString::from(if failed { "failed" } else { "completed" })),
                ),
            ]));
        }
        if tool_kind(&name) == "agent.spawn" {
            let args = tool.args.clone().unwrap_or(Value::Null);
            facts.extend(children.ensure(&call, agent, &args, cwd)?);
            if terminal {
                let child_result = children.result(&call, result, failed, cwd)?;
                let settled = child_result.iter().any(|fact| {
                    matches!(fact.get("type"), Some(Value::String(outcome)) if units_eq(outcome, "turn.ended"))
                });
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
        let ace = is_ace_call(&detail, tool_kind(&name), &tool.name);
        let real_error = if ace {
            result.get("value").unwrap_or(&Value::Null)
        } else {
            &Value::Null
        };
        let error_text = match real_error.get("content") {
            Some(Value::Array(content)) => {
                let mut joined = JsString::new();
                for block in content {
                    let text = string(block.get("text").unwrap_or(&Value::Null)).unwrap_or(JsString::empty());
                    if text.is_empty() {
                        continue;
                    }
                    if !joined.is_empty() {
                        joined.push_str("\n");
                    }
                    joined.push_js(text);
                }
                utf16_slice(&joined, 4096)
            }
            _ => string(real_error.get("message").unwrap_or(&Value::Null))
                .unwrap_or(JsString::empty())
                .clone(),
        };
        let mut call_view = vec![
            (JsString::from("kind"), Value::String(JsString::from(tool_kind(&name)))),
            (JsString::from("title"), Value::String(name.clone())),
            (
                JsString::from("status"),
                Value::String(JsString::from(if failed { "failed" } else { status })),
            ),
            (JsString::from("detail"), detail),
            (
                JsString::from("raw"),
                Value::from(vec![
                    event
                        .and_then(|event| event.raw)
                        .cloned()
                        .unwrap_or_else(|| {
                            Value::from(vec![
                                (
                                    JsString::from("type"),
                                    Value::String(JsString::from("cursor.sdk.tool")),
                                ),
                                (JsString::from("name"), Value::String(name.clone())),
                                (JsString::from("data"), envelope.clone()),
                            ])
                        }),
                ]),
            ),
        ];
        if failed {
            call_view.push((
                JsString::from("error"),
                Value::String(if error_text.is_empty() {
                    JsString::from("Cursor tool failed or was denied by execution policy")
                } else {
                    error_text
                }),
            ));
        }
        facts.push(Value::from(vec![
            (JsString::from("type"), Value::String(JsString::from("item.upsert"))),
            (JsString::from("agent"), Value::String(agent.clone())),
            (JsString::from("item"), Value::String(call.clone())),
            (
                JsString::from("draft"),
                Value::from(vec![
                    (JsString::from("type"), Value::String(JsString::from("tool_call"))),
                    (JsString::from("complete"), Value::Bool(terminal)),
                    (JsString::from("call"), Value::from(call_view)),
                ]),
            ),
        ]));
        if event.and_then(|event| event.raw).is_some() {
            facts.push(notice(
                &JsString::from(
                    "SDK semantic preview is bounded; full redacted raw data is retained in the referenced blob",
                ),
                envelope,
                "warning",
            ));
        }
        let truncation = native.get("truncated").unwrap_or(&Value::Null);
        if matches!(truncation.get("args"), Some(Value::Bool(true)))
            || matches!(truncation.get("result"), Some(Value::Bool(true)))
        {
            facts.push(notice(
                &JsString::from("Cursor SDK tool args/result were truncated by the SDK"),
                envelope,
                "warning",
            ));
        }
        let result_value = result.get("value").unwrap_or(&Value::Null);
        if tool_kind(&name) == "shell"
            && terminal
            && !self.calls.get(&call).ok_or(BudgetError::Exceeded)?.output
            && !matches!(body.get("aceOutputStream"), Some(Value::Bool(true)))
        {
            let mut output = string(result_value.get("stdout").unwrap_or(&Value::Null))
                .unwrap_or(JsString::empty())
                .clone();
            output.push_js(
                string(result_value.get("stderr").unwrap_or(&Value::Null)).unwrap_or(JsString::empty()),
            );
            if !output.is_empty() {
                facts.push(Value::from(vec![
                    (JsString::from("type"), Value::String(JsString::from("item.delta"))),
                    (JsString::from("agent"), Value::String(agent.clone())),
                    (JsString::from("item"), Value::String(call.clone())),
                    (JsString::from("field"), Value::String(JsString::from("output"))),
                    (JsString::from("append"), Value::String(output)),
                ]));
                self.calls
                    .get_mut(&call)
                    .ok_or(BudgetError::Exceeded)?
                    .output = true;
            }
        }
        Ok(facts)
    }
}
