// SPDX-License-Identifier: Apache-2.0
//! The Cursor translator: a synchronous pure fold over SDK boundary frames
//! (`translator.ts`). Never throws on provider data: a failed decode is a
//! `malformed` diagnostic plus a `signal` fact, and a budget breach fences
//! the turn.

use super::children::Children;
use super::delta::{DeltaFlow, translate_delta};
use super::envelope::{Envelope, num_units, parse_envelope, string};
use super::json::{J, encode_units, units_eq};
use super::streamed_answer::StreamedAnswer;
use super::tool_events::ToolEvents;
use super::transcript::Transcript;
use super::{BudgetError, BudgetResult};

/// A send the host holds until the run's admission (`segment`) starts it.
#[derive(Clone)]
pub(crate) struct Attempt {
    pub(crate) generation: Vec<u16>,
    pub(crate) operation_id: Vec<u16>,
    pub(crate) command_id: Option<Vec<u16>>,
    pub(crate) segment: i64,
    pub(crate) body: J,
}

/// The translator's live fold. Field-for-field what the TypeScript holds.
pub struct CursorTranslator {
    root: Vec<u16>,
    root_seen: bool,
    generation: Option<Vec<u16>>,
    operation: Option<Vec<u16>>,
    segment: i64,
    sequence: i64,
    active: bool,
    replacement: bool,
    interrupted: bool,
    cwd: Vec<u16>,
    transcript: Transcript,
    tools: ToolEvents,
    children: Children,
    max: usize,
    usage_position: u64,
    overflow: bool,
    current_raw: Option<J>,
    notice_index: u64,
    notice_sequence: i64,
    attempt: Option<Attempt>,
    turn_namespace: Vec<u16>,
    saw_text: bool,
    answer: StreamedAnswer,
    saved: Vec<u16>,
    recovered_any: bool,
    gaps: Vec<Vec<u16>>,
    now: i64,
    diagnostics: Vec<J>,
}

impl CursorTranslator {
    /// Mirrors the constructor budgets (`maxIdentities`, `maxRetainedBytes`).
    pub fn new(root_key: String, max: usize, retained_limit: usize) -> Result<Self, String> {
        if !(1..=8192).contains(&max) || !(4096..=8_388_608).contains(&retained_limit) {
            return Err("Invalid SDK translator budget".to_owned());
        }
        let root = root_key.encode_utf16().collect::<Vec<u16>>();
        Ok(CursorTranslator {
            root_seen: false,
            generation: None,
            operation: None,
            segment: 0,
            sequence: -1,
            active: false,
            replacement: false,
            interrupted: false,
            cwd: Vec::new(),
            transcript: Transcript::new(encode_units("unopened"), max),
            tools: ToolEvents::new(max, retained_limit),
            children: Children::new(max),
            max,
            usage_position: 0,
            overflow: false,
            current_raw: None,
            notice_index: 0,
            notice_sequence: -1,
            attempt: None,
            turn_namespace: Vec::new(),
            saw_text: false,
            answer: StreamedAnswer::new(),
            saved: Vec::new(),
            recovered_any: false,
            gaps: Vec::new(),
            now: 0,
            diagnostics: Vec::new(),
            root,
        })
    }

    pub(crate) fn take_diagnostics(&mut self) -> Vec<J> {
        std::mem::take(&mut self.diagnostics)
    }

    pub(crate) fn tick(&mut self) -> Vec<J> {
        Vec::new()
    }

    /// Fold one frame's payload data into facts. Never fails on provider data.
    pub(crate) fn translate_frame(
        &mut self,
        payload_data: &J,
        seq: i64,
        channel: &[u16],
        dir: &[u16],
        now: i64,
    ) -> Vec<J> {
        self.now = now;
        self.diagnostics.clear();
        self.notice_index = 0;
        self.notice_sequence = seq;
        self.current_raw = None;
        if !units_eq(channel, "sdk") || self.overflow {
            return Vec::new();
        }
        self.diagnostics.push(J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("cursor.sdk.v1"))),
            (encode_units("data"), payload_data.clone()),
        ]));
        match self.translate_guarded(payload_data, seq, dir) {
            Ok(facts) => facts,
            Err(_) => self.overflowed(),
        }
    }

    /// Fence the turn after a payload or identity budget breach.
    pub(crate) fn overflowed(&mut self) -> Vec<J> {
        if self.overflow {
            return Vec::new();
        }
        self.overflow = true;
        let mut facts = self.children.preserve();
        let overflow = J::Obj(vec![(encode_units("overflow"), J::Bool(true))]);
        let mut step = Step::new(self);
        facts.push(step.notice(
            &encode_units(
                "SDK payload or identity budget exceeded. Host must be stopped; checkpoint retained and surviving work remains uncertain.",
            ),
            &overflow,
            "error",
            &encode_units("cursor.diagnostic"),
        ));
        facts.push(J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("process.exited"))),
            (encode_units("deliberate"), J::Bool(false)),
            (
                encode_units("message"),
                J::Str(encode_units("SDK translation budget exceeded")),
            ),
        ]));
        facts
    }

    fn translate_guarded(
        &mut self,
        payload_data: &J,
        seq: i64,
        dir: &[u16],
    ) -> BudgetResult<Vec<J>> {
        let Some(event) = parse_envelope(payload_data) else {
            let mut step = Step::new(self);
            let notice = step.notice(
                &encode_units("Malformed SDK boundary envelope"),
                payload_data,
                "error",
                &encode_units("cursor.diagnostic"),
            );
            return Ok(vec![notice]);
        };
        if self.generation.as_deref() != Some(event.generation) && self.generation.is_some() {
            if !units_eq(event.kind, "open") {
                return Ok(Vec::new());
            }
            self.sequence = -1;
            self.generation = Some(event.generation.to_vec());
        }
        if seq <= self.sequence {
            return Ok(Vec::new());
        }
        self.sequence = seq;
        if self.generation.is_none() {
            self.generation = Some(event.generation.to_vec());
        }
        self.current_raw = event.raw.cloned();
        let mut namespace = event.generation.to_vec();
        namespace.extend_from_slice(&encode_units(":"));
        namespace.extend_from_slice(event.operation_id);
        namespace.extend_from_slice(&encode_units(":"));
        namespace.extend_from_slice(&num_units(event.segment));
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
    pub(crate) root: &'a [u16],
    pub(crate) root_seen: &'a mut bool,
    pub(crate) generation: &'a mut Option<Vec<u16>>,
    pub(crate) operation: &'a mut Option<Vec<u16>>,
    pub(crate) segment: &'a mut i64,
    pub(crate) active: &'a mut bool,
    pub(crate) replacement: &'a mut bool,
    pub(crate) interrupted: &'a mut bool,
    pub(crate) cwd: &'a mut Vec<u16>,
    pub(crate) transcript: &'a mut Transcript,
    pub(crate) tools: &'a mut ToolEvents,
    pub(crate) children: &'a mut Children,
    pub(crate) max: usize,
    pub(crate) usage_position: &'a mut u64,
    pub(crate) attempt: &'a mut Option<Attempt>,
    pub(crate) turn_namespace: &'a mut Vec<u16>,
    pub(crate) saw_text: &'a mut bool,
    pub(crate) answer: &'a mut StreamedAnswer,
    pub(crate) saved: &'a mut Vec<u16>,
    pub(crate) recovered_any: &'a mut bool,
    pub(crate) gaps: &'a mut Vec<Vec<u16>>,
    pub(crate) now: i64,
    pub(crate) diagnostics: &'a mut Vec<J>,
    pub(crate) notice_index: &'a mut u64,
    pub(crate) notice_sequence: i64,
    pub(crate) current_raw: &'a mut Option<J>,
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
        body: &J,
        agent: &[u16],
        namespace: &[u16],
        envelope: &J,
        current: Option<&Envelope>,
        depth: u32,
    ) -> BudgetResult<Vec<J>> {
        let kind = string(body.get("type").unwrap_or(&J::Null));
        if depth == 0 && agent == self.root {
            if kind.is_some_and(|kind| units_eq(kind, "text-delta")) {
                *self.saw_text = true;
                self.answer
                    .add(string(body.get("text").unwrap_or(&J::Null)).unwrap_or(&[]));
            } else if kind.is_some_and(|kind| kind.len() >= 9 && units_eq(&kind[..9], "tool-call"))
            {
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
