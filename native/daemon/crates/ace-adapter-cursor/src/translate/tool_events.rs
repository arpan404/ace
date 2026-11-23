// SPDX-License-Identifier: Apache-2.0
//! Tool call views: upserts, outputs and surviving-call fences
//! (`tool-events.ts`).

use std::collections::{BTreeMap, BTreeSet};

use super::children::Children;
use super::envelope::{cat, is, native_identity, string};
use super::json::{J, encode_units, units_eq};
use super::tool_names::{ARGS_BYTES, bounded_json, is_ace_call, utf16_slice};
use super::tools::{tool_detail, tool_kind, tool_status};
use super::transcript::Transcript;
use super::{BudgetError, BudgetResult};

pub(crate) struct Tool {
    pub(crate) agent: Vec<u16>,
    pub(crate) name: Vec<u16>,
    pub(crate) args: Option<J>,
    pub(crate) args_bytes: usize,
    pub(crate) terminal: bool,
    pub(crate) failed: bool,
    pub(crate) output: bool,
    pub(crate) surviving: bool,
}

/// The open tool calls of a turn, with their retained arguments.
pub struct ToolEvents {
    pub(crate) calls: BTreeMap<Vec<u16>, Tool>,
    retained_bytes: usize,
    pub(crate) pending_by_owner: BTreeMap<Vec<u16>, BTreeSet<Vec<u16>>>,
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
    pub fn agent_of(&self, call: &[u16]) -> Option<&[u16]> {
        self.calls.get(call).map(|tool| tool.agent.as_slice())
    }

    pub fn trim(&mut self) {
        let terminal: Vec<Vec<u16>> = self
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
        body: &J,
        agent: &[u16],
        namespace: &[u16],
        event: Option<&super::envelope::Envelope>,
        envelope: &J,
        transcript: &mut Transcript,
        children: &mut Children,
        operation: Option<&[u16]>,
        segment: i64,
        cwd: &[u16],
        notice: &mut dyn FnMut(&[u16], &J, &str) -> J,
    ) -> BudgetResult<Vec<J>> {
        let kind = string(body.get("type").unwrap_or(&J::Null));
        if !kind.is_some_and(|kind| {
            units_eq(kind, "tool-call-started")
                || units_eq(kind, "partial-tool-call")
                || units_eq(kind, "tool-call-completed")
        }) {
            return Ok(Vec::new());
        }
        let call_id = native_identity(body.get("callId").unwrap_or(&J::Null))?;
        let Some(call_id) = call_id else {
            return Ok(vec![notice(
                &encode_units("SDK tool update lacks native call identity"),
                envelope,
                "warning",
            )]);
        };
        let call = cat(&[namespace, &encode_units(":call:"), &call_id]);
        let native = body.get("toolCall").unwrap_or(&J::Null);
        let existing_name = self.calls.get(&call).map(|tool| tool.name.clone());
        let name = native_identity(native.get("name").unwrap_or(&J::Null))?
            .or(native_identity(native.get("type").unwrap_or(&J::Null))?)
            .or(existing_name)
            .unwrap_or_else(|| encode_units("unknown"));
        if !self.calls.contains_key(&call) {
            if self.calls.len() + children.calls.len() >= self.limit {
                return Err(BudgetError::Exceeded);
            }
            self.calls.insert(
                call.clone(),
                Tool {
                    agent: agent.to_vec(),
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
                .entry(agent.to_vec())
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
        let result = native.get("result").unwrap_or(&J::Null);
        let status_word = if is(body.get("type").unwrap_or(&J::Null), "tool-call-completed") {
            encode_units("completed")
        } else {
            encode_units("running")
        };
        let status = tool_status(&status_word, result);
        let tool = self.calls.get_mut(&call).ok_or(BudgetError::Exceeded)?;
        tool.name = name.clone();
        tool.failed = tool.failed || status == "failed";
        if tool.terminal && !is(body.get("type").unwrap_or(&J::Null), "tool-call-completed") {
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
            facts.push(J::Obj(vec![
                (
                    encode_units("type"),
                    J::Str(encode_units("background.ended")),
                ),
                (
                    encode_units("task"),
                    J::Str(cat(&[&encode_units("surviving:"), &call])),
                ),
                (
                    encode_units("status"),
                    J::Str(encode_units(if failed { "failed" } else { "completed" })),
                ),
            ]));
        }
        if tool_kind(&name) == "agent.spawn" {
            let args = tool.args.clone().unwrap_or(J::Null);
            facts.extend(children.ensure(&call, agent, &args, cwd)?);
            if terminal {
                let child_result = children.result(&call, result, failed, cwd)?;
                let settled = child_result.iter().any(|fact| {
                    matches!(fact.get("type"), Some(J::Str(outcome)) if units_eq(outcome, "turn.ended"))
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
        let detail = tool_detail(&name, tool.args.as_ref().unwrap_or(&J::Null), result);
        let ace = is_ace_call(&detail, tool_kind(&name), &tool.name);
        let real_error = if ace {
            result.get("value").unwrap_or(&J::Null)
        } else {
            &J::Null
        };
        let error_text = match real_error.get("content") {
            Some(J::Arr(content)) => {
                let mut joined: Vec<u16> = Vec::new();
                for block in content {
                    let text = string(block.get("text").unwrap_or(&J::Null)).unwrap_or(&[]);
                    if text.is_empty() {
                        continue;
                    }
                    if !joined.is_empty() {
                        joined.push(0x0a);
                    }
                    joined.extend_from_slice(text);
                }
                utf16_slice(&joined, 4096)
            }
            _ => string(real_error.get("message").unwrap_or(&J::Null))
                .unwrap_or(&[])
                .to_vec(),
        };
        let mut call_view = vec![
            (encode_units("kind"), J::Str(encode_units(tool_kind(&name)))),
            (encode_units("title"), J::Str(name.clone())),
            (
                encode_units("status"),
                J::Str(encode_units(if failed { "failed" } else { status })),
            ),
            (encode_units("detail"), detail),
            (
                encode_units("raw"),
                J::Arr(vec![
                    event
                        .and_then(|event| event.raw)
                        .cloned()
                        .unwrap_or_else(|| {
                            J::Obj(vec![
                                (
                                    encode_units("type"),
                                    J::Str(encode_units("cursor.sdk.tool")),
                                ),
                                (encode_units("name"), J::Str(name.clone())),
                                (encode_units("data"), envelope.clone()),
                            ])
                        }),
                ]),
            ),
        ];
        if failed {
            call_view.push((
                encode_units("error"),
                J::Str(if error_text.is_empty() {
                    encode_units("Cursor tool failed or was denied by execution policy")
                } else {
                    error_text
                }),
            ));
        }
        facts.push(J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("item.upsert"))),
            (encode_units("agent"), J::Str(agent.to_vec())),
            (encode_units("item"), J::Str(call.clone())),
            (
                encode_units("draft"),
                J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("tool_call"))),
                    (encode_units("complete"), J::Bool(terminal)),
                    (encode_units("call"), J::Obj(call_view)),
                ]),
            ),
        ]));
        if event.and_then(|event| event.raw).is_some() {
            facts.push(notice(
                &encode_units(
                    "SDK semantic preview is bounded; full redacted raw data is retained in the referenced blob",
                ),
                envelope,
                "warning",
            ));
        }
        let truncation = native.get("truncated").unwrap_or(&J::Null);
        if matches!(truncation.get("args"), Some(J::Bool(true)))
            || matches!(truncation.get("result"), Some(J::Bool(true)))
        {
            facts.push(notice(
                &encode_units("Cursor SDK tool args/result were truncated by the SDK"),
                envelope,
                "warning",
            ));
        }
        let result_value = result.get("value").unwrap_or(&J::Null);
        if tool_kind(&name) == "shell"
            && terminal
            && !self.calls.get(&call).ok_or(BudgetError::Exceeded)?.output
            && !matches!(body.get("aceOutputStream"), Some(J::Bool(true)))
        {
            let mut output = string(result_value.get("stdout").unwrap_or(&J::Null))
                .unwrap_or(&[])
                .to_vec();
            output.extend_from_slice(
                string(result_value.get("stderr").unwrap_or(&J::Null)).unwrap_or(&[]),
            );
            if !output.is_empty() {
                facts.push(J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("item.delta"))),
                    (encode_units("agent"), J::Str(agent.to_vec())),
                    (encode_units("item"), J::Str(call.clone())),
                    (encode_units("field"), J::Str(encode_units("output"))),
                    (encode_units("append"), J::Str(output)),
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
