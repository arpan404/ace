// SPDX-License-Identifier: Apache-2.0
//! The settled-frame decisions: the terminal switch of the dispatch
//! (`translator.ts` step, second half).

use super::BudgetResult;
use super::envelope::{Envelope, is, string};
use super::facts::failed_run;
use super::failure_kind::cursor_failure;
use super::text::{JsString, Value, units_eq};
use super::translator::Step;

impl Step<'_> {
    pub fn finish(
        &mut self,
        event: &Envelope,
        envelope: &Value,
        body: &Value,
        namespace: &JsString,
        dir: &JsString,
    ) -> BudgetResult<Vec<Value>> {
        match event.kind {
            kind if units_eq(kind, "segment") => Ok(Vec::new()),
            kind if units_eq(kind, "delta-chunk") || units_eq(kind, "delta") => {
                let root = self.root.clone();
                self.delta(body, &root, namespace, envelope, Some(event), 0)
            }
            kind if units_eq(kind, "message") => {
                // Frames from an earlier build: the stream's copy of onDelta, never shown twice.
                Ok(vec![Value::from(vec![
                    (JsString::from("type"), Value::String(JsString::from("signal"))),
                    (JsString::from("agent"), Value::String(self.root.clone())),
                ])])
            }
            kind if units_eq(kind, "cancel") => {
                if units_eq(dir, "send") {
                    *self.replacement = matches!(body.get("replacement"), Some(Value::Bool(true)));
                    *self.interrupted = !*self.replacement;
                }
                Ok(Vec::new())
            }
            kind if units_eq(kind, "result") => {
                if !*self.active {
                    return Ok(Vec::new());
                }
                if !is(body.get("status").unwrap_or(&Value::Null), "finished")
                    && !is(body.get("status").unwrap_or(&Value::Null), "cancelled")
                    && !is(body.get("status").unwrap_or(&Value::Null), "error")
                {
                    let mut facts = Vec::new();
                    facts.extend(self.tools.preserve(None));
                    facts.extend(self.children.preserve());
                    facts.push(self.notice(
                        &JsString::from(
                            "Unrecognized SDK terminal status; execution remains uncertain",
                        ),
                        envelope,
                        "warning",
                        &JsString::from("cursor.diagnostic"),
                    ));
                    return Ok(facts);
                }
                let mut facts = Vec::new();
                facts.extend(self.transcript.end());
                facts.extend(self.tools.preserve(None));
                facts.extend(self.children.preserve());
                if is(body.get("status").unwrap_or(&Value::Null), "error") {
                    let error = body.get("error").unwrap_or(&Value::Null);
                    facts.push(
                        self.notice(
                            &string(error.get("message").unwrap_or(&Value::Null))
                                .map(|message| message.clone())
                                .unwrap_or_else(|| JsString::from("Cursor SDK run failed")),
                            envelope,
                            "error",
                            &JsString::from("cursor.run-failed"),
                        ),
                    );
                }
                if *self.replacement {
                    return Ok(facts);
                }
                *self.active = false;
                let outcome = if is(body.get("status").unwrap_or(&Value::Null), "finished") {
                    "completed"
                } else if is(body.get("status").unwrap_or(&Value::Null), "cancelled")
                    || *self.interrupted
                {
                    "interrupted"
                } else {
                    "failed"
                };
                let mut ended = Value::from(vec![
                    (JsString::from("type"), Value::String(JsString::from("turn.ended"))),
                    (JsString::from("agent"), Value::String(self.root.clone())),
                    (
                        JsString::from("nativeTurnId"),
                        Value::String(super::envelope::cat(&[
                            &JsString::from("sdk:"),
                            event.operation_id,
                        ])),
                    ),
                    (JsString::from("outcome"), Value::String(JsString::from(outcome))),
                ]);
                if outcome == "failed" {
                    let error = body.get("error").unwrap_or(&Value::Null);
                    super::text::set(&mut ended, 
                        "error",
                        failed_run(
                            error.get("code").unwrap_or(&Value::Null),
                            &string(error.get("message").unwrap_or(&Value::Null))
                                .map(|message| message.clone())
                                .unwrap_or_else(|| JsString::from("Cursor SDK run failed")),
                            error.get("retryable").unwrap_or(&Value::Null),
                        ),
                    );
                }
                facts.push(ended);
                Ok(facts)
            }
            kind if units_eq(kind, "error") => {
                let mut facts = Vec::new();
                // A send Cursor refused or failed to take: nothing is starting any more.
                if self
                    .attempt
                    .as_ref()
                    .is_some_and(|attempt| attempt.operation_id == event.operation_id)
                {
                    *self.attempt = None;
                    facts.push(Value::from(vec![
                        (JsString::from("type"), Value::String(JsString::from("wake.expected"))),
                        (JsString::from("agent"), Value::String(self.root.clone())),
                        (JsString::from("until"), Value::from(self.now)),
                    ]));
                }
                if !*self.root_seen {
                    *self.root_seen = true;
                    facts.push(Value::from(vec![
                        (JsString::from("type"), Value::String(JsString::from("agent.seen"))),
                        (JsString::from("agent"), Value::String(self.root.clone())),
                        (JsString::from("origin"), Value::String(JsString::from("root"))),
                        (JsString::from("fidelity"), Value::String(JsString::from("full"))),
                        (
                            JsString::from("native"),
                            Value::from(vec![(
                                JsString::from("provider"),
                                Value::String(JsString::from("cursor")),
                            )]),
                        ),
                        (JsString::from("cwd"), Value::String(self.cwd.clone())),
                    ]));
                }
                let text = string(body.get("message").unwrap_or(&Value::Null))
                    .map(|text| text.clone())
                    .unwrap_or_else(|| {
                        JsString::from("SDK failure; delivery or execution is uncertain")
                    });
                let failure = cursor_failure(
                    body.get("code").unwrap_or(&Value::Null),
                    &text,
                    body.get("retryable").unwrap_or(&Value::Null),
                );
                facts.extend(self.tools.preserve(None));
                facts.extend(self.children.preserve());
                let code = failure.code.unwrap_or_else(|| {
                    if failure.kind == "quota" {
                        JsString::from("quota")
                    } else {
                        JsString::from("cursor.run-failed")
                    }
                });
                facts.push(self.notice(&text, envelope, "error", &code));
                if *self.active
                    && !*self.replacement
                    && matches!(body.get("settled"), Some(Value::Bool(true)))
                {
                    *self.active = false;
                    let message = string(body.get("message").unwrap_or(&Value::Null))
                        .map(|message| message.clone())
                        .unwrap_or_else(|| JsString::from("SDK run failed"));
                    facts.push(Value::from(vec![
                        (JsString::from("type"), Value::String(JsString::from("turn.ended"))),
                        (JsString::from("agent"), Value::String(self.root.clone())),
                        (
                            JsString::from("nativeTurnId"),
                            Value::String(super::envelope::cat(&[
                                &JsString::from("sdk:"),
                                event.operation_id,
                            ])),
                        ),
                        (JsString::from("outcome"), Value::String(JsString::from("failed"))),
                        (
                            JsString::from("error"),
                            failed_run(
                                body.get("code").unwrap_or(&Value::Null),
                                &message,
                                body.get("retryable").unwrap_or(&Value::Null),
                            ),
                        ),
                    ]));
                }
                Ok(facts)
            }
            kind if units_eq(kind, "close") => Ok(self.children.preserve()),
            _ => Ok(Vec::new()),
        }
    }
}
