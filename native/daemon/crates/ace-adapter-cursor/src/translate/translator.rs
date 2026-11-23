// SPDX-License-Identifier: Apache-2.0
//! The Cursor translator: a synchronous pure fold over SDK boundary frames
//! (`translator.ts`). Never throws on provider data: a failed decode is a
//! `malformed` diagnostic plus a `signal` fact, and a budget breach fences
//! the turn.

use serde_json::{Value, json};

use super::children::Children;
use super::envelope::parse_envelope;
use super::streamed_answer::StreamedAnswer;
use super::tool_events::ToolEvents;
use super::transcript::Transcript;
use super::{BudgetError, BudgetResult};

/// A send the host holds until the run's admission (`segment`) starts it.
#[derive(Clone)]
pub(crate) struct Attempt {
    pub(crate) generation: String,
    pub(crate) operation_id: String,
    pub(crate) command_id: Option<String>,
    pub(crate) segment: i64,
    pub(crate) body: Value,
}

/// The translator's live fold. Field-for-field what the TypeScript holds.
pub struct CursorTranslator {
    root: String,
    root_seen: bool,
    generation: Option<String>,
    operation: Option<String>,
    segment: i64,
    sequence: i64,
    active: bool,
    replacement: bool,
    interrupted: bool,
    cwd: String,
    transcript: Transcript,
    tools: ToolEvents,
    children: Children,
    pub(crate) max: usize,
    usage_position: u64,
    overflow: bool,
    current_raw: Option<Value>,
    notice_index: u64,
    pub(crate) notice_sequence: i64,
    attempt: Option<Attempt>,
    turn_namespace: String,
    saw_text: bool,
    answer: StreamedAnswer,
    saved: String,
    recovered_any: bool,
    gaps: Vec<String>,
    pub(crate) now: i64,
    diagnostics: Vec<Value>,
}

impl CursorTranslator {
    /// Mirrors the constructor budgets (`maxIdentities`, `maxRetainedBytes`).
    pub fn new(root_key: String, max: usize, retained_limit: usize) -> Result<Self, String> {
        if !(1..=8192).contains(&max) || !(4096..=8_388_608).contains(&retained_limit) {
            return Err("Invalid SDK translator budget".to_owned());
        }
        Ok(CursorTranslator {
            root: root_key,
            root_seen: false,
            generation: None,
            operation: None,
            segment: 0,
            sequence: -1,
            active: false,
            replacement: false,
            interrupted: false,
            cwd: String::new(),
            transcript: Transcript::new("unopened".to_owned(), max),
            tools: ToolEvents::new(max, retained_limit),
            children: Children::new(max),
            max,
            usage_position: 0,
            overflow: false,
            current_raw: None,
            notice_index: 0,
            notice_sequence: -1,
            attempt: None,
            turn_namespace: String::new(),
            saw_text: false,
            answer: StreamedAnswer::new(),
            saved: String::new(),
            recovered_any: false,
            gaps: Vec::new(),
            now: 0,
            diagnostics: Vec::new(),
        })
    }

    pub fn take_diagnostics(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.diagnostics)
    }

    pub fn tick(&mut self) -> Vec<Value> {
        Vec::new()
    }

    /// Fold one frame's payload data into facts. Never fails on provider data.
    pub fn translate_frame(
        &mut self,
        payload_data: &Value,
        seq: i64,
        channel: &str,
        dir: &str,
        now: i64,
    ) -> Vec<Value> {
        self.now = now;
        self.diagnostics.clear();
        self.notice_index = 0;
        self.notice_sequence = seq;
        self.current_raw = None;
        if channel != "sdk" || self.overflow {
            return Vec::new();
        }
        self.diagnostics
            .push(json!({ "type": "cursor.sdk.v1", "data": payload_data.clone() }));
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
        let overflow = json!({ "overflow": true });
        let mut step = Step::new(self);
        facts.push(step.notice(
            "SDK payload or identity budget exceeded. Host must be stopped; checkpoint retained and surviving work remains uncertain.",
            &overflow,
            "error",
            "cursor.diagnostic",
        ));
        facts.push(json!({
            "type": "process.exited",
            "deliberate": false,
            "message": "SDK translation budget exceeded",
        }));
        facts
    }

    fn translate_guarded(
        &mut self,
        payload_data: &Value,
        seq: i64,
        dir: &str,
    ) -> BudgetResult<Vec<Value>> {
        let Some(event) = parse_envelope(payload_data) else {
            let mut step = Step::new(self);
            let notice = step.notice(
                "Malformed SDK boundary envelope",
                payload_data,
                "error",
                "cursor.diagnostic",
            );
            return Ok(vec![notice]);
        };
        if self.generation.as_deref() != Some(event.generation) && self.generation.is_some() {
            if event.kind != "open" {
                return Ok(Vec::new());
            }
            self.sequence = -1;
            self.generation = Some(event.generation.to_owned());
        }
        if seq <= self.sequence {
            return Ok(Vec::new());
        }
        self.sequence = seq;
        if self.generation.is_none() {
            self.generation = Some(event.generation.to_owned());
        }
        self.current_raw = event.raw.cloned();
        let namespace = format!(
            "{}:{}:{}",
            event.generation, event.operation_id, event.segment
        );
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
                .contains(&event.kind)
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
    pub(crate) root: &'a str,
    pub(crate) root_seen: &'a mut bool,
    pub(crate) generation: &'a mut Option<String>,
    pub(crate) operation: &'a mut Option<String>,
    pub(crate) segment: &'a mut i64,
    pub(crate) active: &'a mut bool,
    pub(crate) replacement: &'a mut bool,
    pub(crate) interrupted: &'a mut bool,
    pub(crate) cwd: &'a mut String,
    pub(crate) transcript: &'a mut Transcript,
    pub(crate) tools: &'a mut ToolEvents,
    pub(crate) children: &'a mut Children,
    pub(crate) max: usize,
    pub(crate) usage_position: &'a mut u64,
    pub(crate) attempt: &'a mut Option<Attempt>,
    pub(crate) turn_namespace: &'a mut String,
    pub(crate) saw_text: &'a mut bool,
    pub(crate) answer: &'a mut StreamedAnswer,
    pub(crate) saved: &'a mut String,
    pub(crate) recovered_any: &'a mut bool,
    pub(crate) gaps: &'a mut Vec<String>,
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

    pub(crate) fn notice(&mut self, text: &str, data: &Value, level: &str, code: &str) -> Value {
        let item = format!(
            "sdk:notice:{}:{}:{}",
            self.generation.as_deref().unwrap_or("invalid"),
            self.notice_sequence,
            *self.notice_index
        );
        *self.notice_index += 1;
        let mut raw = vec![
            self.current_raw
                .clone()
                .unwrap_or(json!({ "type": "cursor.sdk.v1", "data": data.clone() })),
        ];
        if [
            "Malformed SDK boundary",
            "Checkpoint snapshot retained",
            "Shell output has no observed",
            "SDK task summary",
            "SDK checkpoint recovery",
        ]
        .iter()
        .any(|prefix| text.starts_with(prefix))
        {
            raw.push(json!({ "type": "native-notice", "data": {} }));
        }
        json!({
            "type": "item.upsert",
            "agent": self.root,
            "item": item,
            "draft": {
                "type": "notice",
                "diagnostic": true,
                "code": code,
                "text": text,
                "level": level,
                "complete": true,
                "raw": raw,
            },
        })
    }

    /// A notice closure over this frame's notice state, for the delta helpers.
    pub(crate) fn notice_fn<'x>(
        diagnostics: &'x mut Vec<Value>,
        index: &'x mut u64,
        sequence: i64,
        current_raw: &'x Option<Value>,
        generation: &'x Option<String>,
        root: &'x str,
    ) -> impl FnMut(&str, &Value, &str) -> Value + 'x {
        move |text: &str, data: &Value, level: &str| {
            let item = format!(
                "sdk:notice:{}:{sequence}:{}",
                generation.as_deref().unwrap_or("invalid"),
                *index
            );
            *index += 1;
            let mut raw = vec![
                current_raw
                    .clone()
                    .unwrap_or(json!({ "type": "cursor.sdk.v1", "data": data.clone() })),
            ];
            if [
                "Malformed SDK boundary",
                "Checkpoint snapshot retained",
                "Shell output has no observed",
                "SDK task summary",
                "SDK checkpoint recovery",
            ]
            .iter()
            .any(|prefix| text.starts_with(prefix))
            {
                raw.push(json!({ "type": "native-notice", "data": {} }));
            }
            let _ = diagnostics;
            json!({
                "type": "item.upsert",
                "agent": root,
                "item": item,
                "draft": {
                    "type": "notice",
                    "diagnostic": true,
                    "code": "cursor.diagnostic",
                    "text": text,
                    "level": level,
                    "complete": true,
                    "raw": raw,
                },
            })
        }
    }
}
