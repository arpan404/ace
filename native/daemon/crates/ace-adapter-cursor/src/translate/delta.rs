// SPDX-License-Identifier: Apache-2.0
//! Pure decoding for one-level SDK deltas (`delta-events.ts`); envelope and
//! session decisions stay outside.

use serde_json::{Map, Value};

use super::children::Children;
use super::envelope::{Envelope, native_identity, object, string};
use super::tool_events::ToolEvents;
use super::transcript::Transcript;
use super::usage::turn_usage;
use super::{BudgetError, BudgetResult};

/// The live fold the delta decodes into. Plain references, so the
/// translator's fields borrow independently at the call site.
pub struct DeltaFlow<'a> {
    pub children: &'a mut Children,
    pub tools: &'a mut ToolEvents,
    pub transcript: &'a mut Transcript,
    pub current: Option<&'a Envelope<'a>>,
    pub envelope: &'a Value,
    pub operation: Option<&'a str>,
    pub segment: i64,
    pub cwd: &'a str,
    pub next_usage: &'a mut dyn FnMut() -> u64,
    pub notice: &'a mut dyn FnMut(&str, &Value, &str) -> Value,
}

/// Decode one SDK delta body into facts for `agent` in `namespace`.
pub fn translate_delta(
    body: &Map<String, Value>,
    agent: &str,
    namespace: &str,
    flow: &mut DeltaFlow<'_>,
    depth: u32,
) -> BudgetResult<Vec<Value>> {
    let kind = string(body.get("type").unwrap_or(&Value::Null));
    if (kind == Some("text-delta") || kind == Some("thinking-delta"))
        && body.get("aceTextStream") == Some(&Value::Bool(true))
    {
        return Ok(Vec::new());
    }
    if kind == Some("text-delta") || kind == Some("thinking-delta") {
        let field = if kind == Some("text-delta") {
            "text"
        } else {
            "thinking"
        };
        let text = string(body.get("text").unwrap_or(&Value::Null)).unwrap_or("");
        return flow.transcript.append(agent, field, text);
    }
    if kind == Some("step-started")
        || kind == Some("step-completed")
        || kind == Some("thinking-completed")
    {
        return Ok(flow.transcript.boundary(agent));
    }
    if kind == Some("turn-ended") {
        let counter = (flow.next_usage)();
        let usage = body.get("usage").unwrap_or(&Value::Null);
        return Ok(turn_usage(
            usage,
            agent,
            &format!("{namespace}:{agent}:usage:{counter}"),
        ));
    }
    if kind == Some("tool-call-delta") {
        if depth >= 1 {
            let notice = &mut *flow.notice;
            let envelope = flow.envelope;
            return Ok(vec![notice(
                "Nested task deltas beyond one level are incomplete",
                envelope,
                "warning",
            )]);
        }
        let call_id =
            native_identity(body.get("callId").unwrap_or(&Value::Null))?.unwrap_or_default();
        let call = format!("{namespace}:call:{call_id}");
        if !flow.children.calls.contains_key(&call) {
            let notice = &mut *flow.notice;
            let envelope = flow.envelope;
            return Ok(vec![notice(
                "Nested update has no observed owning task call",
                envelope,
                "warning",
            )]);
        }
        let child_key = flow
            .children
            .calls
            .get(&call)
            .ok_or(BudgetError::Exceeded)?
            .key
            .clone();
        let update = object(body.get("taskUpdate").unwrap_or(&Value::Null)).clone();
        let facts = {
            let flow = &mut *flow;
            translate_delta(
                &update,
                &child_key,
                namespace,
                &mut DeltaFlow {
                    children: &mut *flow.children,
                    tools: &mut *flow.tools,
                    transcript: &mut *flow.transcript,
                    current: flow.current,
                    envelope: flow.envelope,
                    operation: flow.operation,
                    segment: flow.segment,
                    cwd: flow.cwd,
                    next_usage: &mut *flow.next_usage,
                    notice: &mut *flow.notice,
                },
                depth + 1,
            )?
        };
        if facts.iter().any(|fact| {
            fact.get("type") == Some(&Value::String("item.upsert".to_owned()))
                || fact.get("type") == Some(&Value::String("item.delta".to_owned()))
        }) {
            let mut seen = flow.children.observe(&call, flow.cwd);
            seen.extend(facts);
            return Ok(seen);
        }
        return Ok(facts);
    }
    if kind == Some("tool-call-started")
        || kind == Some("partial-tool-call")
        || kind == Some("tool-call-completed")
    {
        let flow = &mut *flow;
        return flow.tools.translate(
            body,
            agent,
            namespace,
            flow.current,
            flow.envelope,
            &mut *flow.transcript,
            &mut *flow.children,
            flow.operation,
            flow.segment,
            flow.cwd,
            &mut *flow.notice,
        );
    }
    // Shell output events are opaque records; keep them rather than inventing call association.
    if kind == Some("shell-output-delta") && body.get("aceOutputStream") == Some(&Value::Bool(true))
    {
        return Ok(Vec::new());
    }
    if kind == Some("shell-output-delta") {
        let notice = &mut *flow.notice;
        let envelope = flow.envelope;
        return Ok(vec![notice(
            "SDK shell output delta retained; call association unavailable",
            envelope,
            "info",
        )]);
    }
    Ok(Vec::new())
}

impl super::translator::Step<'_> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn delta(
        &mut self,
        body: &Map<String, Value>,
        agent: &str,
        namespace: &str,
        envelope: &Value,
        current: Option<&Envelope>,
        depth: u32,
    ) -> BudgetResult<Vec<Value>> {
        let kind = string(body.get("type").unwrap_or(&Value::Null));
        if depth == 0 && agent == self.root {
            if kind == Some("text-delta") {
                *self.saw_text = true;
                self.answer
                    .add(string(body.get("text").unwrap_or(&Value::Null)).unwrap_or(""));
            } else if kind.is_some_and(|kind| kind.starts_with("tool-call")) {
                self.answer.reset();
            }
        }
        let mut usage = || {
            *self.usage_position += 1;
            *self.usage_position
        };
        let mut notice = Self::notice_fn(
            &mut *self.diagnostics,
            &mut *self.notice_index,
            self.notice_sequence,
            &*self.current_raw,
            &*self.generation,
            self.root,
        );
        let mut flow = DeltaFlow {
            children: &mut *self.children,
            tools: &mut *self.tools,
            transcript: &mut *self.transcript,
            current,
            envelope,
            operation: self.operation.as_deref(),
            segment: *self.segment,
            cwd: self.cwd,
            next_usage: &mut usage,
            notice: &mut notice,
        };
        translate_delta(body, agent, namespace, &mut flow, depth)
    }
}
