// SPDX-License-Identifier: Apache-2.0
//! The translator's turn decisions: admission, restart recovery and the frame
//! dispatch (`translator.ts` minus the state it folds).

use serde_json::{Map, Value, json};

use super::envelope::{object, string};
use super::facts::{failed_run, is_truthy};
use super::transcript::Transcript;
use super::translator::{Attempt, Step};
use super::{BudgetError, BudgetResult};

/// Whether a JSON value validates as one message part of a send.
fn is_content_part(value: &Value) -> bool {
    let map = match value {
        Value::Object(map) => map,
        _ => return false,
    };
    match string(map.get("type").unwrap_or(&Value::Null)) {
        Some("text") => string(map.get("text").unwrap_or(&Value::Null)).is_some(),
        Some("image") => {
            string(map.get("mimeType").unwrap_or(&Value::Null)).is_some()
                && string(map.get("url").unwrap_or(&Value::Null)).is_some()
        }
        Some("file") => {
            if string(map.get("path").unwrap_or(&Value::Null)).is_none() {
                return false;
            }
            if let Some(mime) = map.get("mimeType")
                && !mime.is_string()
            {
                return false;
            }
            if let Some(name) = map.get("name")
                && !(name.is_string() && name.as_str().unwrap_or("").len() <= 255)
            {
                return false;
            }
            match map.get("content") {
                None => true,
                Some(Value::Object(content)) => {
                    match string(content.get("encoding").unwrap_or(&Value::Null)) {
                        Some("base64") => {
                            matches!(content.get("data"), Some(Value::String(data)) if data.len() <= 44 * 1024 * 1024)
                        }
                        Some("text") => {
                            matches!(content.get("data"), Some(Value::String(data)) if data.len() <= 128 * 1024)
                        }
                        _ => false,
                    }
                }
                Some(_) => false,
            }
        }
        Some("mention") => {
            let entry = string(map.get("entryId").unwrap_or(&Value::Null)).unwrap_or("");
            let name = string(map.get("name").unwrap_or(&Value::Null)).unwrap_or("");
            !entry.is_empty() && entry.len() <= 256 && !name.is_empty() && name.len() <= 256
        }
        _ => false,
    }
}

/// The first `max` UTF-16 code units of text, whole characters only.
pub(crate) fn utf16_head(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_owned();
    }
    String::from_utf16_lossy(&units[..max])
}

impl Step<'_> {
    /// Cursor admitted the attempted send: the turn starts and its input shows.
    pub fn admit(&mut self, attempt: &Attempt) -> BudgetResult<Vec<Value>> {
        *self.attempt = None;
        let body = object(&attempt.body);
        let namespace = format!(
            "{}:{}:{}",
            attempt.generation, attempt.operation_id, attempt.segment
        );
        let mut facts = Vec::new();
        if self.operation.as_deref() != Some(attempt.operation_id.as_str()) || !*self.active {
            self.tools.trim();
            self.children.trim();
            *self.usage_position = 0;
            *self.operation = Some(attempt.operation_id.clone());
            *self.active = true;
            facts.push(json!({
                "type": "turn.started",
                "agent": self.root,
                "nativeTurnId": format!("sdk:{}", attempt.operation_id),
                "trigger": "user",
            }));
        }
        facts.extend(self.transcript.end());
        if let Some(Value::Array(input)) = body.get("input")
            && !input.is_empty()
            && input.len() <= 64
            && input.iter().all(is_content_part)
        {
            let suffix = attempt
                .command_id
                .clone()
                .unwrap_or_else(|| attempt.segment.to_string());
            let mut draft = json!({
                "type": "message",
                "role": "user",
                "parts": input,
                "complete": true,
            });
            if let Some(command_id) = &attempt.command_id
                && command_id.len() <= 256
            {
                draft["nativeId"] = Value::String(command_id.clone());
            }
            facts.push(json!({
                "type": "item.upsert",
                "agent": self.root,
                "item": format!("{namespace}:user:{suffix}"),
                "draft": draft,
            }));
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
        body: &Map<String, Value>,
    ) -> BudgetResult<Vec<Value>> {
        let status = string(body.get("nativeStatus").unwrap_or(&Value::Null)).unwrap_or("unknown");
        let result: Option<String> = if matches!(body.get("resultParts"), Some(Value::Number(_))) {
            Some(std::mem::take(self.saved))
        } else {
            *self.saved = String::new();
            string(body.get("result").unwrap_or(&Value::Null)).map(str::to_owned)
        };
        let result_cut = body.get("resultCut") == Some(&Value::Bool(true));
        // The stored result is the turn's final answer: whatever of it was
        // never shown is shown, so a finished turn never ends on a fragment.
        let mut answer = Vec::new();
        let mut apart = false;
        if status == "finished"
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
            let mut update = Map::new();
            update.insert("type".to_owned(), Value::String("text-delta".to_owned()));
            update.insert("text".to_owned(), Value::String(missing.text));
            answer.extend(self.delta(&update, self.root, &namespace, envelope, Some(event), 0)?);
        }
        let mut from_result = Vec::new();
        if !answer.is_empty() && *self.saw_text {
            from_result.push(self.notice(
                if apart {
                    "The answer above is Cursor's saved result for this turn; what ace showed of it as it streamed differs."
                } else {
                    "The end of this answer is from Cursor's saved result for this turn."
                },
                envelope,
                "info",
                "cursor.recovered",
            ));
        }
        let what = if status == "finished" {
            "Cursor finished this run while ace was restarting.".to_owned()
        } else if status == "running" || status == "queued" {
            "ace restarted while this Cursor run was working, so it was stopped. Nothing was sent again.".to_owned()
        } else {
            format!("Cursor's run ended ({status}) while ace was restarting.")
        };
        let source = if *self.recovered_any || !answer.is_empty() {
            " What it did after the live stream was cut off is recovered from Cursor's saved session."
        } else {
            ""
        };
        let mut facts = Vec::new();
        facts.extend(answer);
        facts.extend(self.transcript.end());
        facts.extend(self.tools.preserve(None));
        facts.extend(self.children.preserve());
        let level = if is_truthy(body.get("interrupted").unwrap_or(&Value::Null)) {
            "warning"
        } else {
            "info"
        };
        facts.push(self.notice(
            &format!("{what}{source}"),
            envelope,
            level,
            "cursor.recovered",
        ));
        facts.extend(from_result);
        if result_cut {
            facts.push(self.notice(
                "Cursor's saved answer is longer than ace shows; it is cut after the first 4 MiB.",
                envelope,
                "info",
                "cursor.recovered",
            ));
        }
        for gap in std::mem::take(self.gaps) {
            facts.push(self.notice(&gap, envelope, "info", "cursor.recovered"));
        }
        if body.get("tailOmitted") == Some(&Value::Bool(true)) {
            facts.push(self.notice(
                "This turn began before ace was updated, so what Cursor did after the restart can't be lined up with what is shown here; it isn't repeated.",
                envelope,
                "info",
                "cursor.recovered",
            ));
        }
        self.gaps.clear();
        if !*self.active || self.operation.is_none() {
            return Ok(facts);
        }
        *self.active = false;
        // A run a restart cut off is not done: it stopped part-way and needs the person's look.
        let outcome = if status == "finished" {
            "completed"
        } else if status == "cancelled" {
            "interrupted"
        } else {
            "failed"
        };
        let operation = self.operation.clone().ok_or(BudgetError::Exceeded)?;
        let mut ended = json!({
            "type": "turn.ended",
            "agent": self.root,
            "nativeTurnId": format!("sdk:{operation}"),
            "outcome": outcome,
        });
        if outcome == "failed" {
            let message = string(body.get("error").unwrap_or(&Value::Null))
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    if is_truthy(body.get("interrupted").unwrap_or(&Value::Null)) {
                        "ace restarted while Cursor was working, so the run was stopped".to_owned()
                    } else {
                        "Cursor SDK run failed".to_owned()
                    }
                });
            ended["error"] = failed_run(&Value::Null, &message, &Value::Null);
        }
        facts.push(ended);
        Ok(facts)
    }
}
