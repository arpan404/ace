// SPDX-License-Identifier: Apache-2.0
//! The translator's turn decisions: Cursor admitted the send, and restart
//! recovery (`translator.ts`).

use super::envelope::string;
use super::facts::{failed_run, is_truthy};
use super::json::units_eq;
use super::json::{J, encode_units};
use super::transcript::Transcript;
use super::translator::{Attempt, Step};
use super::{BudgetError, BudgetResult};

/// Whether a JSON value validates as one message part of a send.
fn is_content_part(value: &J) -> bool {
    let J::Obj(_) = value else {
        return false;
    };
    match string(value.get("type").unwrap_or(&J::Null)) {
        Some(kind) if units_eq(kind, "text") => {
            string(value.get("text").unwrap_or(&J::Null)).is_some()
        }
        Some(kind) if units_eq(kind, "image") => {
            string(value.get("mimeType").unwrap_or(&J::Null)).is_some()
                && string(value.get("url").unwrap_or(&J::Null)).is_some()
        }
        Some(kind) if units_eq(kind, "file") => {
            if string(value.get("path").unwrap_or(&J::Null)).is_none() {
                return false;
            }
            if let Some(mime) = value.get("mimeType")
                && !matches!(mime, J::Str(_))
            {
                return false;
            }
            if let Some(name) = value.get("name")
                && !matches!(name, J::Str(units) if units.len() <= 255)
            {
                return false;
            }
            match value.get("content") {
                None => true,
                Some(J::Obj(_)) => {
                    let content = value.get("content").unwrap_or(&J::Null);
                    match string(content.get("encoding").unwrap_or(&J::Null)) {
                        Some(encoding) if units_eq(encoding, "base64") => matches!(
                            content.get("data"),
                            Some(J::Str(data)) if data.len() <= 44 * 1024 * 1024
                        ),
                        Some(encoding) if units_eq(encoding, "text") => matches!(
                            content.get("data"),
                            Some(J::Str(data)) if data.len() <= 128 * 1024
                        ),
                        _ => false,
                    }
                }
                Some(_) => false,
            }
        }
        Some(kind) if units_eq(kind, "mention") => {
            let entry = string(value.get("entryId").unwrap_or(&J::Null)).unwrap_or(&[]);
            let name = string(value.get("name").unwrap_or(&J::Null)).unwrap_or(&[]);
            !entry.is_empty() && entry.len() <= 256 && !name.is_empty() && name.len() <= 256
        }
        _ => false,
    }
}

/// The first `max` UTF-16 code units of text, whole characters only.
pub(crate) fn utf16_head(text: &[u16], max: usize) -> Vec<u16> {
    text[..text.len().min(max)].to_vec()
}

impl Step<'_> {
    /// Cursor admitted the attempted send: the turn starts and its input shows.
    pub fn admit(&mut self, attempt: &Attempt) -> BudgetResult<Vec<J>> {
        *self.attempt = None;
        let body = &attempt.body;
        let mut namespace = attempt.generation.clone();
        namespace.extend_from_slice(&encode_units(":"));
        namespace.extend_from_slice(&attempt.operation_id);
        namespace.extend_from_slice(&encode_units(":"));
        namespace.extend_from_slice(&super::envelope::num_units(attempt.segment));
        let mut facts = Vec::new();
        if self.operation.as_deref() != Some(attempt.operation_id.as_slice()) || !*self.active {
            self.tools.trim();
            self.children.trim();
            *self.usage_position = 0;
            *self.operation = Some(attempt.operation_id.clone());
            *self.active = true;
            facts.push(J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("turn.started"))),
                (encode_units("agent"), J::Str(self.root.to_vec())),
                (
                    encode_units("nativeTurnId"),
                    J::Str(super::envelope::cat(&[
                        &encode_units("sdk:"),
                        &attempt.operation_id,
                    ])),
                ),
                (encode_units("trigger"), J::Str(encode_units("user"))),
            ]));
        }
        facts.extend(self.transcript.end());
        if let Some(J::Arr(input)) = body.get("input")
            && !input.is_empty()
            && input.len() <= 64
            && input.iter().all(is_content_part)
        {
            let suffix = match &attempt.command_id {
                Some(command_id) => command_id.clone(),
                None => super::envelope::num_units(attempt.segment),
            };
            let mut draft = vec![
                (encode_units("type"), J::Str(encode_units("message"))),
                (encode_units("role"), J::Str(encode_units("user"))),
                (encode_units("parts"), J::Arr(input.clone())),
                (encode_units("complete"), J::Bool(true)),
            ];
            if let Some(command_id) = &attempt.command_id
                && command_id.len() <= 256
            {
                draft.push((encode_units("nativeId"), J::Str(command_id.clone())));
            }
            facts.push(J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("item.upsert"))),
                (encode_units("agent"), J::Str(self.root.to_vec())),
                (
                    encode_units("item"),
                    J::Str(super::envelope::cat(&[
                        &namespace,
                        &encode_units(":user:"),
                        &suffix,
                    ])),
                ),
                (encode_units("draft"), J::Obj(draft)),
            ]));
        }
        *self.segment = attempt.segment;
        *self.replacement = false;
        *self.interrupted = false;
        *self.transcript = Transcript::new(namespace.clone(), self.max);
        *self.turn_namespace = namespace;
        *self.saw_text = false;
        self.answer.reset();
        *self.recovered_any = false;
        self.gaps.clear();
        Ok(facts)
    }

    /**
     * A run's outcome read back from the SDK store after a restart. It ends
     * the open turn as the run ended, so a run that finished just before the
     * crash shows finished with its answer; a run that was still working was
     * stopped first, never shown done.
     */
    pub fn recover(
        &mut self,
        event: &super::envelope::Envelope,
        envelope: &J,
        body: &J,
    ) -> BudgetResult<Vec<J>> {
        let status = string(body.get("nativeStatus").unwrap_or(&J::Null)).unwrap_or(&[]);
        let result: Option<Vec<u16>> = if matches!(body.get("resultParts"), Some(J::Num(_))) {
            Some(std::mem::take(self.saved))
        } else {
            *self.saved = Vec::new();
            string(body.get("result").unwrap_or(&J::Null)).map(|result| result.to_vec())
        };
        let result_cut = matches!(body.get("resultCut"), Some(J::Bool(true)));
        // The stored result is the turn's final answer: whatever of it was
        // never shown is shown, so a finished turn never ends on a fragment.
        let mut answer = Vec::new();
        let mut apart = false;
        if units_eq(status, "finished")
            && *self.active
            && let Some(result) = &result
            && !result.is_empty()
            && let Some(missing) = self.answer.missing(result, result_cut)
        {
            apart = missing.apart;
            if missing.apart {
                answer.extend(self.transcript.end());
            }
            let namespace = self.turn_namespace.clone();
            let update = J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("text-delta"))),
                (encode_units("text"), J::Str(missing.text)),
            ]);
            answer.extend(self.delta(&update, self.root, &namespace, envelope, Some(event), 0)?);
        }
        let mut from_result = Vec::new();
        if !answer.is_empty() && *self.saw_text {
            from_result.push(self.notice(
                &encode_units(if apart {
                    "The answer above is Cursor's saved result for this turn; what ace showed of it as it streamed differs."
                } else {
                    "The end of this answer is from Cursor's saved result for this turn."
                }),
                envelope,
                "info",
                &encode_units("cursor.recovered"),
            ));
        }
        let what = if units_eq(status, "finished") {
            encode_units("Cursor finished this run while ace was restarting.")
        } else if units_eq(status, "running") || units_eq(status, "queued") {
            encode_units(
                "ace restarted while this Cursor run was working, so it was stopped. Nothing was sent again.",
            )
        } else {
            let mut what = encode_units("Cursor's run ended (");
            what.extend_from_slice(status);
            what.extend_from_slice(&encode_units(") while ace was restarting."));
            what
        };
        let source = if *self.recovered_any || !answer.is_empty() {
            encode_units(
                " What it did after the live stream was cut off is recovered from Cursor's saved session.",
            )
        } else {
            Vec::new()
        };
        let mut facts = Vec::new();
        facts.extend(answer);
        facts.extend(self.transcript.end());
        facts.extend(self.tools.preserve(None));
        facts.extend(self.children.preserve());
        let mut noticed = what;
        noticed.extend_from_slice(&source);
        let level = if is_truthy(body.get("interrupted").unwrap_or(&J::Null)) {
            "warning"
        } else {
            "info"
        };
        facts.push(self.notice(&noticed, envelope, level, &encode_units("cursor.recovered")));
        facts.extend(from_result);
        if result_cut {
            facts.push(self.notice(
                &encode_units(
                    "Cursor's saved answer is longer than ace shows; it is cut after the first 4 MiB.",
                ),
                envelope,
                "info",
                &encode_units("cursor.recovered"),
            ));
        }
        for gap in std::mem::take(self.gaps) {
            facts.push(self.notice(&gap, envelope, "info", &encode_units("cursor.recovered")));
        }
        if matches!(body.get("tailOmitted"), Some(J::Bool(true))) {
            facts.push(self.notice(
                &encode_units(
                    "This turn began before ace was updated, so what Cursor did after the restart can't be lined up with what is shown here; it isn't repeated.",
                ),
                envelope,
                "info",
                &encode_units("cursor.recovered"),
            ));
        }
        self.gaps.clear();
        if !*self.active || self.operation.is_none() {
            return Ok(facts);
        }
        *self.active = false;
        // A run a restart cut off is not done: it stopped part-way and needs the person's look.
        let outcome = if units_eq(status, "finished") {
            "completed"
        } else if units_eq(status, "cancelled") {
            "interrupted"
        } else {
            "failed"
        };
        let operation = self.operation.clone().ok_or(BudgetError::Exceeded)?;
        let mut ended = J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("turn.ended"))),
            (encode_units("agent"), J::Str(self.root.to_vec())),
            (
                encode_units("nativeTurnId"),
                J::Str(super::envelope::cat(&[&encode_units("sdk:"), &operation])),
            ),
            (encode_units("outcome"), J::Str(encode_units(outcome))),
        ]);
        if outcome == "failed" {
            let message = string(body.get("error").unwrap_or(&J::Null))
                .map(|message| message.to_vec())
                .unwrap_or_else(|| {
                    if is_truthy(body.get("interrupted").unwrap_or(&J::Null)) {
                        encode_units(
                            "ace restarted while Cursor was working, so the run was stopped",
                        )
                    } else {
                        encode_units("Cursor SDK run failed")
                    }
                });
            ended.set("error", failed_run(&J::Null, &message, &J::Null));
        }
        facts.push(ended);
        Ok(facts)
    }
}
