// SPDX-License-Identifier: Apache-2.0
//! Pure decoding for one-level SDK deltas (`delta-events.ts`); envelope and
//! session decisions stay outside.

use super::children::Children;
use super::envelope::{Envelope, is, native_identity, string};
use super::json::{J, encode_units};
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
    pub envelope: &'a J,
    pub operation: Option<&'a [u16]>,
    pub segment: i64,
    pub cwd: &'a [u16],
    pub next_usage: &'a mut dyn FnMut() -> u64,
    pub notice: &'a mut dyn FnMut(&[u16], &J, &str) -> J,
}

/// Decode one SDK delta body into facts for `agent` in `namespace`.
pub fn translate_delta(
    body: &J,
    agent: &[u16],
    namespace: &[u16],
    flow: &mut DeltaFlow<'_>,
    depth: u32,
) -> BudgetResult<Vec<J>> {
    let kind = string(body.get("type").unwrap_or(&J::Null));
    if kind.is_some_and(|kind| {
        super::json::units_eq(kind, "text-delta") || super::json::units_eq(kind, "thinking-delta")
    }) && matches!(body.get("aceTextStream"), Some(J::Bool(true)))
    {
        return Ok(Vec::new());
    }
    if kind.is_some_and(|kind| {
        super::json::units_eq(kind, "text-delta") || super::json::units_eq(kind, "thinking-delta")
    }) {
        let field = if is(body.get("type").unwrap_or(&J::Null), "text-delta") {
            "text"
        } else {
            "thinking"
        };
        let text = string(body.get("text").unwrap_or(&J::Null)).unwrap_or(&[]);
        return flow.transcript.append(agent, field, text);
    }
    if is(body.get("type").unwrap_or(&J::Null), "step-started")
        || is(body.get("type").unwrap_or(&J::Null), "step-completed")
        || is(body.get("type").unwrap_or(&J::Null), "thinking-completed")
    {
        return Ok(flow.transcript.boundary(agent));
    }
    if is(body.get("type").unwrap_or(&J::Null), "turn-ended") {
        let counter = (flow.next_usage)();
        let usage = body.get("usage").unwrap_or(&J::Null);
        let mut counter_key = namespace.to_vec();
        counter_key.extend_from_slice(&encode_units(":"));
        counter_key.extend_from_slice(agent);
        counter_key.extend_from_slice(&encode_units(":usage:"));
        counter_key.extend_from_slice(&super::envelope::num_units(counter as i64));
        return Ok(turn_usage(usage, agent, &counter_key));
    }
    if is(body.get("type").unwrap_or(&J::Null), "tool-call-delta") {
        if depth >= 1 {
            let notice = &mut *flow.notice;
            let envelope = flow.envelope;
            return Ok(vec![notice(
                &encode_units("Nested task deltas beyond one level are incomplete"),
                envelope,
                "warning",
            )]);
        }
        let call_id = native_identity(body.get("callId").unwrap_or(&J::Null))?.unwrap_or_default();
        let call = super::envelope::cat(&[namespace, &encode_units(":call:"), &call_id]);
        if !flow.children.calls.contains_key(&call) {
            let notice = &mut *flow.notice;
            let envelope = flow.envelope;
            return Ok(vec![notice(
                &encode_units("Nested update has no observed owning task call"),
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
        let update = body.get("taskUpdate").unwrap_or(&J::Null).clone();
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
            matches!(fact.get("type"), Some(J::Str(kind)) if super::json::units_eq(kind, "item.upsert"))
                || matches!(fact.get("type"), Some(J::Str(kind)) if super::json::units_eq(kind, "item.delta"))
        }) {
            let mut seen = flow.children.observe(&call, flow.cwd);
            seen.extend(facts);
            return Ok(seen);
        }
        return Ok(facts);
    }
    if is(body.get("type").unwrap_or(&J::Null), "tool-call-started")
        || is(body.get("type").unwrap_or(&J::Null), "partial-tool-call")
        || is(body.get("type").unwrap_or(&J::Null), "tool-call-completed")
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
    if is(body.get("type").unwrap_or(&J::Null), "shell-output-delta")
        && matches!(body.get("aceOutputStream"), Some(J::Bool(true)))
    {
        return Ok(Vec::new());
    }
    if is(body.get("type").unwrap_or(&J::Null), "shell-output-delta") {
        let notice = &mut *flow.notice;
        let envelope = flow.envelope;
        return Ok(vec![notice(
            &encode_units("SDK shell output delta retained; call association unavailable"),
            envelope,
            "info",
        )]);
    }
    Ok(Vec::new())
}
