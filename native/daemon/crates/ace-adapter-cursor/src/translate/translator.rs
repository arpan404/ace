// SPDX-License-Identifier: Apache-2.0
//! The Cursor translator: a synchronous pure fold over SDK boundary frames
//! (`translator.ts`). Never throws on provider data: a failed decode is a
//! `malformed` diagnostic plus a `signal` fact, and a budget breach fences
//! the turn.

use super::children::Children;
use super::delta::{DeltaFlow, translate_delta};
use super::envelope::{Envelope, num_units, parse_envelope, string};
use super::streamed_answer::StreamedAnswer;
use super::text::{JsString, Value, units_eq};
use super::tool_events::ToolEvents;
use super::transcript::Transcript;
use super::{BudgetError, BudgetResult};

/// A send the host holds until the run's admission (`segment`) starts it.
#[derive(Clone)]
pub(crate) struct Attempt {
    pub(crate) generation: JsString,
    pub(crate) operation_id: JsString,
    pub(crate) command_id: Option<JsString>,
    pub(crate) segment: i64,
    pub(crate) body: Value,
}

/// The translator's live fold. Field-for-field what the TypeScript holds.
pub struct CursorTranslator {
    root: JsString,
    root_seen: bool,
    generation: Option<JsString>,
    operation: Option<JsString>,
    segment: i64,
    sequence: i64,
    active: bool,
    replacement: bool,
    interrupted: bool,
    cwd: JsString,
    transcript: Transcript,
    tools: ToolEvents,
    children: Children,
    max: usize,
    usage_position: u64,
    overflow: bool,
    current_raw: Option<Value>,
    notice_index: u64,
    notice_sequence: i64,
    attempt: Option<Attempt>,
    turn_namespace: JsString,
    saw_text: bool,
    answer: StreamedAnswer,
    saved: JsString,
    recovered_any: bool,
    gaps: Vec<JsString>,
    now: i64,
    diagnostics: Vec<Value>,
}

impl CursorTranslator {
    /// Mirrors the constructor budgets (`maxIdentities`, `maxRetainedBytes`).
    pub fn new(root_key: String, max: usize, retained_limit: usize) -> Result<Self, String> {
        if !(1..=8192).contains(&max) || !(4096..=8_388_608).contains(&retained_limit) {
            return Err("Invalid SDK translator budget".to_owned());
        }
        let root = root_key.encode_utf16().collect::<JsString>();
        Ok(CursorTranslator {
            root_seen: false,
            generation: None,
            operation: None,
            segment: 0,
            sequence: -1,
            active: false,
            replacement: false,
            interrupted: false,
            cwd: JsString::new(),
            transcript: Transcript::new(JsString::from("unopened"), max),
            tools: ToolEvents::new(max, retained_limit),
            children: Children::new(max),
            max,
            usage_position: 0,
            overflow: false,
            current_raw: None,
            notice_index: 0,
            notice_sequence: -1,
            attempt: None,
            turn_namespace: JsString::new(),
            saw_text: false,
            answer: StreamedAnswer::new(),
            saved: JsString::new(),
            recovered_any: false,
            gaps: Vec::new(),
            now: 0,
            diagnostics: Vec::new(),
            root,
        })
    }

    pub(crate) fn take_diagnostics(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.diagnostics)
    }

    pub(crate) fn tick(&mut self) -> Vec<Value> {
        Vec::new()
    }

    /// Fold one frame's payload data into facts. Never fails on provider data.
    pub(crate) fn translate_frame(
        &mut self,
        payload_data: &Value,
        seq: i64,
        channel: &JsString,
        dir: &JsString,
        now: i64,
    ) -> Vec<Value> {
        self.now = now;
        self.diagnostics.clear();
        self.notice_index = 0;
        self.notice_sequence = seq;
        self.current_raw = None;
        if !units_eq(channel, "sdk") || self.overflow {
            return Vec::new();
        }
        self.diagnostics.push(Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("cursor.sdk.v1")),
            ),
            (JsString::from("data"), payload_data.clone()),
        ]));
        match self.translate_guarded(payload_data, seq, dir) {
            Ok(facts) => facts,
            Err(_) => self.overflowed(),
        }
    }

    /// Fence the turn after a payload or identity budget breach.
    pub(crate) fn overflowed(&mut self) -> Vec<Value> {
        if self.overflow {
            return Vec::new();
        }
        self.overflow = true;
        let mut facts = self.children.preserve();
        let overflow = Value::from(vec![(JsString::from("overflow"), Value::Bool(true))]);
        let mut step = Step::new(self);
        facts.push(step.notice(
            &JsString::from(
                "SDK payload or identity budget exceeded. Host must be stopped; checkpoint retained and surviving work remains uncertain.",
            ),
            &overflow,
            "error",
            &JsString::from("cursor.diagnostic"),
        ));
        facts.push(Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("process.exited")),
            ),
            (JsString::from("deliberate"), Value::Bool(false)),
            (
                JsString::from("message"),
                Value::String(JsString::from("SDK translation budget exceeded")),
            ),
        ]));
        facts
    }

    fn translate_guarded(
        &mut self,
        payload_data: &Value,
        seq: i64,
        dir: &JsString,
    ) -> BudgetResult<Vec<Value>> {
        let Some(event) = parse_envelope(payload_data) else {
            let mut step = Step::new(self);
            let notice = step.notice(
                &JsString::from("Malformed SDK boundary envelope"),
                payload_data,
                "error",
                &JsString::from("cursor.diagnostic"),
            );
            return Ok(vec![notice]);
        };
        if self.generation.as_ref() != Some(event.generation) && self.generation.is_some() {
            if !units_eq(event.kind, "open") {
                return Ok(Vec::new());
            }
            self.sequence = -1;
            self.generation = Some(event.generation.clone());
        }
        if seq <= self.sequence {
            return Ok(Vec::new());
        }
        self.sequence = seq;
        if self.generation.is_none() {
            self.generation = Some(event.generation.clone());
        }
        self.current_raw = event.raw.cloned();
        let mut namespace = event.generation.clone();
        namespace.push_js(&JsString::from(":"));
        namespace.push_js(event.operation_id);
        namespace.push_js(&JsString::from(":"));
        namespace.push_js(&num_units(event.segment));
        let admitted = self.attempt.as_ref().is_some_and(|attempt| {
            attempt.operation_id == event.operation_id
                && attempt.segment == event.segment
                && [
                    "delta",
                    "delta-chunk",
                    "message",
                    "shell-output",
                    "blob",
                    "result",
                ]
                .iter()
                .any(|kind| units_eq(event.kind, kind))
        });
        let mut step = Step::new(self);
        let mut facts = Vec::new();
        if admitted {
            let attempt = step.attempt.clone().ok_or(BudgetError::Exceeded)?;
            facts.extend(step.admit(&attempt)?);
        }
        facts.extend(step.step(&event, payload_data, &namespace, dir)?);
        Ok(facts)
    }
}

/// The translator's fields, borrowed disjointly for one frame.
pub struct Step<'a> {
    pub(crate) root: &'a JsString,
    pub(crate) root_seen: &'a mut bool,
    pub(crate) generation: &'a mut Option<JsString>,
    pub(crate) operation: &'a mut Option<JsString>,
    pub(crate) segment: &'a mut i64,
    pub(crate) active: &'a mut bool,
    pub(crate) replacement: &'a mut bool,
    pub(crate) interrupted: &'a mut bool,
    pub(crate) cwd: &'a mut JsString,
    pub(crate) transcript: &'a mut Transcript,
    pub(crate) tools: &'a mut ToolEvents,
    pub(crate) children: &'a mut Children,
    pub(crate) max: usize,
    pub(crate) usage_position: &'a mut u64,
    pub(crate) attempt: &'a mut Option<Attempt>,
    pub(crate) turn_namespace: &'a mut JsString,
    pub(crate) saw_text: &'a mut bool,
    pub(crate) answer: &'a mut StreamedAnswer,
    pub(crate) saved: &'a mut JsString,
    pub(crate) recovered_any: &'a mut bool,
    pub(crate) gaps: &'a mut Vec<JsString>,
    pub(crate) now: i64,
    pub(crate) diagnostics: &'a mut Vec<Value>,
    pub(crate) notice_index: &'a mut u64,
    pub(crate) notice_sequence: i64,
    pub(crate) current_raw: &'a mut Option<Value>,
}

impl<'a> Step<'a> {
    pub(crate) fn new(translator: &'a mut CursorTranslator) -> Self {
        Step {
            root: &translator.root,
            root_seen: &mut translator.root_seen,
            generation: &mut translator.generation,
            operation: &mut translator.operation,
            segment: &mut translator.segment,
            active: &mut translator.active,
            replacement: &mut translator.replacement,
            interrupted: &mut translator.interrupted,
            cwd: &mut translator.cwd,
            transcript: &mut translator.transcript,
            tools: &mut translator.tools,
            children: &mut translator.children,
            max: translator.max,
            usage_position: &mut translator.usage_position,
            attempt: &mut translator.attempt,
            turn_namespace: &mut translator.turn_namespace,
            saw_text: &mut translator.saw_text,
            answer: &mut translator.answer,
            saved: &mut translator.saved,
            recovered_any: &mut translator.recovered_any,
            gaps: &mut translator.gaps,
            now: translator.now,
            diagnostics: &mut translator.diagnostics,
            notice_index: &mut translator.notice_index,
            notice_sequence: translator.notice_sequence,
            current_raw: &mut translator.current_raw,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn delta(
        &mut self,
        body: &Value,
        agent: &JsString,
        namespace: &JsString,
        envelope: &Value,
        current: Option<&Envelope>,
        depth: u32,
    ) -> BudgetResult<Vec<Value>> {
        let kind = string(body.get("type").unwrap_or(&Value::Null));
        if depth == 0 && agent == self.root {
            if kind.is_some_and(|kind| units_eq(kind, "text-delta")) {
                *self.saw_text = true;
                self.answer.add(
                    string(body.get("text").unwrap_or(&Value::Null)).unwrap_or(JsString::empty()),
                );
            } else if kind.is_some_and(|kind| kind.starts_with_js(&JsString::from("tool-call"))) {
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
            operation: self.operation.as_ref(),
            segment: *self.segment,
            cwd: self.cwd,
            next_usage: &mut usage,
            notice: &mut notice,
        };
        translate_delta(body, agent, namespace, &mut flow, depth)
    }
}
