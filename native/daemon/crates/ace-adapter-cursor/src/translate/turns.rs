// SPDX-License-Identifier: Apache-2.0
//! The translator's turn decisions: Cursor admitted the send, and restart
//! recovery (`translator.ts`).

use super::envelope::string;
use super::facts::{failed_run, is_truthy};
use super::text::units_eq;
use super::text::{JsString, Value};
use super::transcript::Transcript;
use super::translator::{Attempt, Step};
use super::{BudgetError, BudgetResult};

/// Whether a JSON value validates as one message part of a send.
fn is_content_part(value: &Value) -> bool {
    let Value::Object(_) = value else {
        return false;
    };
    match string(value.get("type").unwrap_or(&Value::Null)) {
        Some(kind) if units_eq(kind, "text") => {
            string(value.get("text").unwrap_or(&Value::Null)).is_some()
        }
        Some(kind) if units_eq(kind, "image") => {
            string(value.get("mimeType").unwrap_or(&Value::Null)).is_some()
                && string(value.get("url").unwrap_or(&Value::Null)).is_some()
        }
        Some(kind) if units_eq(kind, "file") => {
            if string(value.get("path").unwrap_or(&Value::Null)).is_none() {
                return false;
            }
            if let Some(mime) = value.get("mimeType")
                && !matches!(mime, Value::String(_))
            {
                return false;
            }
            if let Some(name) = value.get("name")
                && !matches!(name, Value::String(units) if units.len_utf16() <= 255)
            {
                return false;
            }
            match value.get("content") {
                None => true,
                Some(Value::Object(_)) => {
                    let content = value.get("content").unwrap_or(&Value::Null);
                    match string(content.get("encoding").unwrap_or(&Value::Null)) {
                        Some(encoding) if units_eq(encoding, "base64") => matches!(
                            content.get("data"),
                            Some(Value::String(data)) if data.len_utf16() <= 44 * 1024 * 1024
                        ),
                        Some(encoding) if units_eq(encoding, "text") => matches!(
                            content.get("data"),
                            Some(Value::String(data)) if data.len_utf16() <= 128 * 1024
                        ),
                        _ => false,
                    }
                }
                Some(_) => false,
            }
        }
        Some(kind) if units_eq(kind, "mention") => {
            let entry =
                string(value.get("entryId").unwrap_or(&Value::Null)).unwrap_or(JsString::empty());
            let name =
                string(value.get("name").unwrap_or(&Value::Null)).unwrap_or(JsString::empty());
            !entry.is_empty()
                && entry.len_utf16() <= 256
                && !name.is_empty()
                && name.len_utf16() <= 256
        }
        _ => false,
    }
}

/// The first `max` UTF-16 code units of text, whole characters only.
pub(crate) fn utf16_head(text: &JsString, max: usize) -> JsString {
    text.slice_units(0, max)
}

impl Step<'_> {
    /// Cursor admitted the attempted send: the turn starts and its input shows.
    pub fn admit(&mut self, attempt: &Attempt) -> BudgetResult<Vec<Value>> {
        *self.attempt = None;
        let body = &attempt.body;
        let mut namespace = attempt.generation.clone();
        namespace.push_js(&JsString::from(":"));
        namespace.push_js(&attempt.operation_id);
        namespace.push_js(&JsString::from(":"));
        namespace.push_js(&super::envelope::num_units(attempt.segment));
        let mut facts = Vec::new();
        if self.operation.as_ref() != Some(&attempt.operation_id) || !*self.active {
            self.tools.trim();
            self.children.trim();
            *self.usage_position = 0;
            *self.operation = Some(attempt.operation_id.clone());
            *self.active = true;
            facts.push(Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("turn.started")),
                ),
                (JsString::from("agent"), Value::String(self.root.clone())),
                (
                    JsString::from("nativeTurnId"),
                    Value::String(super::envelope::cat(&[
                        &JsString::from("sdk:"),
                        &attempt.operation_id,
                    ])),
                ),
                (
                    JsString::from("trigger"),
                    Value::String(JsString::from("user")),
                ),
            ]));
        }
        facts.extend(self.transcript.end());
        if let Some(Value::Array(input)) = body.get("input")
            && !input.is_empty()
            && input.len() <= 64
            && input.iter().all(is_content_part)
        {
            let suffix = match &attempt.command_id {
                Some(command_id) => command_id.clone(),
                None => super::envelope::num_units(attempt.segment),
            };
            let mut draft = vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("message")),
                ),
                (
                    JsString::from("role"),
                    Value::String(JsString::from("user")),
                ),
                (JsString::from("parts"), Value::Array(input.clone())),
                (JsString::from("complete"), Value::Bool(true)),
            ];
            if let Some(command_id) = &attempt.command_id
                && command_id.len_utf16() <= 256
            {
                draft.push((
                    JsString::from("nativeId"),
                    Value::String(command_id.clone()),
                ));
            }
            facts.push(Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("item.upsert")),
                ),
                (JsString::from("agent"), Value::String(self.root.clone())),
                (
                    JsString::from("item"),
                    Value::String(super::envelope::cat(&[
                        &namespace,
                        &JsString::from(":user:"),
                        &suffix,
                    ])),
                ),
                (JsString::from("draft"), Value::from(draft)),
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
        envelope: &Value,
        body: &Value,
    ) -> BudgetResult<Vec<Value>> {
        let status =
            string(body.get("nativeStatus").unwrap_or(&Value::Null)).unwrap_or(JsString::empty());
        let result: Option<JsString> = if matches!(body.get("resultParts"), Some(Value::Number(_)))
        {
            Some(std::mem::take(self.saved))
        } else {
            *self.saved = JsString::new();
            string(body.get("result").unwrap_or(&Value::Null)).cloned()
        };
        let result_cut = matches!(body.get("resultCut"), Some(Value::Bool(true)));
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
            let update = Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("text-delta")),
                ),
                (JsString::from("text"), Value::String(missing.text)),
            ]);
            answer.extend(self.delta(&update, self.root, &namespace, envelope, Some(event), 0)?);
        }
        let mut from_result = Vec::new();
        if !answer.is_empty() && *self.saw_text {
            from_result.push(self.notice(
                &JsString::from(if apart {
                    "The answer above is Cursor's saved result for this turn; what ace showed of it as it streamed differs."
                } else {
                    "The end of this answer is from Cursor's saved result for this turn."
                }),
                envelope,
                "info",
                &JsString::from("cursor.recovered"),
            ));
        }
        let what = if units_eq(status, "finished") {
            JsString::from("Cursor finished this run while ace was restarting.")
        } else if units_eq(status, "running") || units_eq(status, "queued") {
            JsString::from(
                "ace restarted while this Cursor run was working, so it was stopped. Nothing was sent again.",
            )
        } else {
            let mut what = JsString::from("Cursor's run ended (");
            what.push_js(status);
            what.push_js(&JsString::from(") while ace was restarting."));
            what
        };
        let source = if *self.recovered_any || !answer.is_empty() {
            JsString::from(
                " What it did after the live stream was cut off is recovered from Cursor's saved session.",
            )
        } else {
            JsString::new()
        };
        let mut facts = Vec::new();
        facts.extend(answer);
        facts.extend(self.transcript.end());
        facts.extend(self.tools.preserve(None));
        facts.extend(self.children.preserve());
        let mut noticed = what;
        noticed.push_js(&source);
        let level = if is_truthy(body.get("interrupted").unwrap_or(&Value::Null)) {
            "warning"
        } else {
            "info"
        };
        facts.push(self.notice(
            &noticed,
            envelope,
            level,
            &JsString::from("cursor.recovered"),
        ));
        facts.extend(from_result);
        if result_cut {
            facts.push(self.notice(
                &JsString::from(
                    "Cursor's saved answer is longer than ace shows; it is cut after the first 4 MiB.",
                ),
                envelope,
                "info",
                &JsString::from("cursor.recovered"),
            ));
        }
        for gap in std::mem::take(self.gaps) {
            facts.push(self.notice(&gap, envelope, "info", &JsString::from("cursor.recovered")));
        }
        if matches!(body.get("tailOmitted"), Some(Value::Bool(true))) {
            facts.push(self.notice(
                &JsString::from(
                    "This turn began before ace was updated, so what Cursor did after the restart can't be lined up with what is shown here; it isn't repeated.",
                ),
                envelope,
                "info",
                &JsString::from("cursor.recovered"),
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
        let mut ended = Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("turn.ended")),
            ),
            (JsString::from("agent"), Value::String(self.root.clone())),
            (
                JsString::from("nativeTurnId"),
                Value::String(super::envelope::cat(&[&JsString::from("sdk:"), &operation])),
            ),
            (
                JsString::from("outcome"),
                Value::String(JsString::from(outcome)),
            ),
        ]);
        if outcome == "failed" {
            let message = string(body.get("error").unwrap_or(&Value::Null)).cloned()
                .unwrap_or_else(|| {
                    if is_truthy(body.get("interrupted").unwrap_or(&Value::Null)) {
                        JsString::from(
                            "ace restarted while Cursor was working, so the run was stopped",
                        )
                    } else {
                        JsString::from("Cursor SDK run failed")
                    }
                });
            super::text::set(
                &mut ended,
                "error",
                failed_run(&Value::Null, &message, &Value::Null),
            );
        }
        facts.push(ended);
        Ok(facts)
    }
}
