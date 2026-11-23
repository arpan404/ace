// SPDX-License-Identifier: Apache-2.0
//! The frame dispatch: envelope kinds into facts (`translator.ts` step).

use super::envelope::{Envelope, cat, is, native_identity, string};
use super::json::{J, encode_units, units_eq};
use super::recovered_tail::{store_gap, stored_update};
use super::translator::Step;
use super::{BudgetError, BudgetResult};

impl Step<'_> {
    pub fn step(
        &mut self,
        event: &Envelope,
        envelope: &J,
        namespace: &[u16],
        dir: &[u16],
    ) -> BudgetResult<Vec<J>> {
        let body = event.body;
        match event.kind {
            kind if units_eq(kind, "open") => {
                *self.saved = Vec::new();
                *self.root_seen = true;
                *self.cwd = string(body.get("cwd").unwrap_or(&J::Null))
                    .unwrap_or(&[])
                    .to_vec();
                let model = string(body.get("model").unwrap_or(&J::Null));
                let mut native = vec![(encode_units("provider"), J::Str(encode_units("cursor")))];
                if let Some(agent_id) = event.agent_id {
                    native.push((encode_units("nativeId"), J::Str(agent_id.to_vec())));
                }
                let mut seen = vec![
                    (encode_units("type"), J::Str(encode_units("agent.seen"))),
                    (encode_units("agent"), J::Str(self.root.to_vec())),
                    (encode_units("origin"), J::Str(encode_units("root"))),
                    (encode_units("fidelity"), J::Str(encode_units("full"))),
                    (encode_units("cwd"), J::Str(self.cwd.clone())),
                ];
                if let Some(model) = model.filter(|model| !model.is_empty()) {
                    seen.push((encode_units("model"), J::Str(model.to_vec())));
                }
                seen.push((encode_units("native"), J::Obj(native)));
                return Ok(vec![J::Obj(seen)]);
            }
            kind if units_eq(kind, "send") => {
                *self.attempt = Some(super::translator::Attempt {
                    generation: event.generation.to_vec(),
                    operation_id: event.operation_id.to_vec(),
                    command_id: event.command_id.map(|command| command.to_vec()),
                    segment: event.segment,
                    body: event.body.clone(),
                });
                // Working while Cursor takes the input, without a run that
                // would take the input before Cursor has it.
                if *self.active {
                    return Ok(Vec::new());
                }
                return Ok(vec![J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("wake.expected"))),
                    (encode_units("agent"), J::Str(self.root.to_vec())),
                    (
                        encode_units("until"),
                        J::Num((self.now + 600_000).to_string()),
                    ),
                ])]);
            }
            kind if units_eq(kind, "segment") => {
                let admitted = self.attempt.as_ref().is_some_and(|attempt| {
                    attempt.operation_id == event.operation_id && attempt.segment == event.segment
                });
                if !admitted {
                    return Ok(Vec::new());
                }
                let attempt = self.attempt.clone().ok_or(BudgetError::Exceeded)?;
                return self.admit(&attempt);
            }
            kind if units_eq(kind, "admission") => {
                let admitted = self.attempt.as_ref().is_some_and(|attempt| {
                    attempt.operation_id
                        == string(body.get("operationId").unwrap_or(&J::Null)).unwrap_or(&[])
                        && Some(attempt.segment)
                            == body
                                .get("segment")
                                .and_then(|segment| segment.as_int().ok())
                });
                if !admitted {
                    return Ok(Vec::new());
                }
                if matches!(body.get("admitted"), Some(J::Bool(true))) {
                    let attempt = self.attempt.clone().ok_or(BudgetError::Exceeded)?;
                    return self.admit(&attempt);
                }
                *self.attempt = None;
                // Cursor's store had no run for it. Whether it was sent is the
                // daemon's to say: only it knows whether the last run's
                // processes were proven gone before that read.
                return Ok(vec![J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("wake.expected"))),
                    (encode_units("agent"), J::Str(self.root.to_vec())),
                    (encode_units("until"), J::Num(self.now.to_string())),
                ])]);
            }
            kind if units_eq(kind, "recovered") => {
                if !*self.active || event.run_id.is_none() {
                    return Ok(Vec::new());
                }
                *self.recovered_any = true;
                if let Some(gap) = store_gap(event.body)
                    && self.gaps.len() < 4
                    && !self.gaps.contains(&gap)
                {
                    self.gaps.push(gap);
                }
                return match stored_update(event.body) {
                    Some(update) => {
                        let namespace = self.turn_namespace.clone();
                        self.delta(&update, self.root, &namespace, envelope, Some(event), 0)
                    }
                    None => Ok(Vec::new()),
                };
            }
            kind if units_eq(kind, "recovered-result") => {
                if self.saved.len() < 4 * 1024 * 1024 {
                    self.saved.extend_from_slice(
                        string(body.get("text").unwrap_or(&J::Null)).unwrap_or(&[]),
                    );
                }
                return Ok(Vec::new());
            }
            kind if units_eq(kind, "recovery") => return self.recover(event, envelope, body),
            kind if units_eq(kind, "snapshot") => {
                return Ok(vec![self.notice(
                    &encode_units(
                        "Checkpoint snapshot retained for reconciliation; positional UUIDs do not establish live-message identity. No uncertain history was appended.",
                    ),
                    envelope,
                    "warning",
                    &encode_units("cursor.diagnostic"),
                )]);
            }
            _ => {}
        }
        // A shared host/store failure fences execution even when an old segment caused it.
        if units_eq(event.kind, "error")
            && ["boundary_overflow", "checkpoint_budget"]
                .iter()
                .any(|code| is(body.get("code").unwrap_or(&J::Null), code))
        {
            let mut facts = Vec::new();
            facts.extend(self.tools.preserve(None));
            facts.extend(self.children.preserve());
            facts.push(
                self.notice(
                    &string(body.get("message").unwrap_or(&J::Null))
                        .map(|message| message.to_vec())
                        .unwrap_or_else(|| {
                            encode_units("SDK host resource budget failed; checkpoint retained")
                        }),
                    envelope,
                    "error",
                    &encode_units("cursor.diagnostic"),
                ),
            );
            facts.push(J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("process.exited"))),
                (encode_units("deliberate"), J::Bool(false)),
                (
                    encode_units("message"),
                    J::Str(super::turns::utf16_head(
                        &string(body.get("message").unwrap_or(&J::Null))
                            .map(|message| message.to_vec())
                            .unwrap_or_else(|| encode_units("Cursor's turn was fenced")),
                        512,
                    )),
                ),
            ]));
            return Ok(facts);
        }
        if units_eq(event.kind, "blob") {
            return Ok(vec![J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("signal"))),
                (encode_units("agent"), J::Str(self.root.to_vec())),
            ])]);
        }
        if units_eq(event.kind, "shell-output") {
            let parent = native_identity(body.get("parentCallId").unwrap_or(&J::Null))?;
            let child = match &parent {
                Some(parent) => {
                    let call = cat(&[namespace, &encode_units(":call:"), parent]);
                    self.children
                        .calls
                        .get(&call)
                        .map(|child| child.key.clone())
                }
                None => None,
            };
            if parent.is_some() && child.is_none() {
                return Ok(vec![self.notice(
                    &encode_units("Shell output has no observed owning child"),
                    envelope,
                    "warning",
                    &encode_units("cursor.diagnostic"),
                )]);
            }
            let agent = child.unwrap_or_else(|| self.root.to_vec());
            let mut notice = Step::notice_fn(
                &mut *self.diagnostics,
                &mut *self.notice_index,
                self.notice_sequence,
                &*self.current_raw,
                &*self.generation,
                self.root,
            );
            return self.tools.output(
                body,
                &agent,
                namespace,
                event,
                envelope,
                &mut *self.transcript,
                &mut *self.children,
                self.operation.as_deref(),
                *self.segment,
                &self.cwd.clone(),
                &mut notice,
            );
        }
        let stale =
            Some(event.operation_id) != self.operation.as_deref() || event.segment != *self.segment;
        if units_eq(event.kind, "host-exit") {
            let unsettled =
                self.children.calls.values().any(|child| !child.settled) || self.tools.has_open();
            let preserved = self.children.preserve();
            if !*self.active && !unsettled {
                return Ok(preserved);
            }
            let mut facts = preserved;
            facts.push(self.notice(
                &encode_units("Cursor stopped unexpectedly. Unfinished work needs your attention."),
                envelope,
                "warning",
                &encode_units("cursor.work-stopped"),
            ));
            return Ok(facts);
        }
        // A failure of the attempted send is the person's to see though no turn started.
        let attempt_failed = units_eq(event.kind, "error")
            && self
                .attempt
                .as_ref()
                .is_some_and(|attempt| attempt.operation_id == event.operation_id);
        if stale
            && !attempt_failed
            && !(units_eq(event.kind, "error")
                && units_eq(event.operation_id, "open")
                && !*self.root_seen)
        {
            // Surviving child facts belong to their original call namespace, never the replacement root.
            if units_eq(event.kind, "delta")
                && is(body.get("type").unwrap_or(&J::Null), "tool-call-completed")
            {
                let call = cat(&[
                    namespace,
                    &encode_units(":call:"),
                    &native_identity(body.get("callId").unwrap_or(&J::Null))?.unwrap_or_default(),
                ]);
                if self.tools.calls.contains_key(&call) || self.children.calls.contains_key(&call) {
                    let agent = self.tools.agent_of(&call).unwrap_or(self.root).to_vec();
                    return self.delta(body, &agent, namespace, envelope, Some(event), 0);
                }
            }
            if (units_eq(event.kind, "delta") || units_eq(event.kind, "delta-chunk"))
                && is(body.get("type").unwrap_or(&J::Null), "tool-call-delta")
            {
                let call = cat(&[
                    namespace,
                    &encode_units(":call:"),
                    &native_identity(body.get("callId").unwrap_or(&J::Null))?.unwrap_or_default(),
                ]);
                let child = self
                    .children
                    .calls
                    .get(&call)
                    .map(|child| (child.key.clone(), child.settled));
                if let Some((key, false)) = child {
                    let update = body.get("taskUpdate").unwrap_or(&J::Null).clone();
                    return self.delta(&update, &key, namespace, envelope, Some(event), 1);
                }
            }
            return Ok(Vec::new());
        }
        self.finish(event, envelope, body, namespace, dir)
    }
}
