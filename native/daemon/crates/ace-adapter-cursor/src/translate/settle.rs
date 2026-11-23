// SPDX-License-Identifier: Apache-2.0
//! The settled-frame decisions: the terminal switch of the dispatch
//! (`translator.ts` step, second half).

use super::BudgetResult;
use super::envelope::{Envelope, is, string};
use super::facts::failed_run;
use super::failure_kind::cursor_failure;
use super::json::{J, encode_units, units_eq};
use super::translator::Step;

impl Step<'_> {
    pub fn finish(
        &mut self,
        event: &Envelope,
        envelope: &J,
        body: &J,
        namespace: &[u16],
        dir: &[u16],
    ) -> BudgetResult<Vec<J>> {
        match event.kind {
            kind if units_eq(kind, "segment") => Ok(Vec::new()),
            kind if units_eq(kind, "delta-chunk") || units_eq(kind, "delta") => {
                let root = self.root.to_vec();
                self.delta(body, &root, namespace, envelope, Some(event), 0)
            }
            kind if units_eq(kind, "message") => {
                // Frames from an earlier build: the stream's copy of onDelta, never shown twice.
                Ok(vec![J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("signal"))),
                    (encode_units("agent"), J::Str(self.root.to_vec())),
                ])])
            }
            kind if units_eq(kind, "cancel") => {
                if units_eq(dir, "send") {
                    *self.replacement = matches!(body.get("replacement"), Some(J::Bool(true)));
                    *self.interrupted = !*self.replacement;
                }
                Ok(Vec::new())
            }
            kind if units_eq(kind, "result") => {
                if !*self.active {
                    return Ok(Vec::new());
                }
                if !is(body.get("status").unwrap_or(&J::Null), "finished")
                    && !is(body.get("status").unwrap_or(&J::Null), "cancelled")
                    && !is(body.get("status").unwrap_or(&J::Null), "error")
                {
                    let mut facts = Vec::new();
                    facts.extend(self.tools.preserve(None));
                    facts.extend(self.children.preserve());
                    facts.push(self.notice(
                        &encode_units(
                            "Unrecognized SDK terminal status; execution remains uncertain",
                        ),
                        envelope,
                        "warning",
                        &encode_units("cursor.diagnostic"),
                    ));
                    return Ok(facts);
                }
                let mut facts = Vec::new();
                facts.extend(self.transcript.end());
                facts.extend(self.tools.preserve(None));
                facts.extend(self.children.preserve());
                if is(body.get("status").unwrap_or(&J::Null), "error") {
                    let error = body.get("error").unwrap_or(&J::Null);
                    facts.push(
                        self.notice(
                            &string(error.get("message").unwrap_or(&J::Null))
                                .map(|message| message.to_vec())
                                .unwrap_or_else(|| encode_units("Cursor SDK run failed")),
                            envelope,
                            "error",
                            &encode_units("cursor.run-failed"),
                        ),
                    );
                }
                if *self.replacement {
                    return Ok(facts);
                }
                *self.active = false;
                let outcome = if is(body.get("status").unwrap_or(&J::Null), "finished") {
                    "completed"
                } else if is(body.get("status").unwrap_or(&J::Null), "cancelled")
                    || *self.interrupted
                {
                    "interrupted"
                } else {
                    "failed"
                };
                let mut ended = J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("turn.ended"))),
                    (encode_units("agent"), J::Str(self.root.to_vec())),
                    (
                        encode_units("nativeTurnId"),
                        J::Str(super::envelope::cat(&[
                            &encode_units("sdk:"),
                            event.operation_id,
                        ])),
                    ),
                    (encode_units("outcome"), J::Str(encode_units(outcome))),
                ]);
                if outcome == "failed" {
                    let error = body.get("error").unwrap_or(&J::Null);
                    ended.set(
                        "error",
                        failed_run(
                            error.get("code").unwrap_or(&J::Null),
                            &string(error.get("message").unwrap_or(&J::Null))
                                .map(|message| message.to_vec())
                                .unwrap_or_else(|| encode_units("Cursor SDK run failed")),
                            error.get("retryable").unwrap_or(&J::Null),
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
                    facts.push(J::Obj(vec![
                        (encode_units("type"), J::Str(encode_units("wake.expected"))),
                        (encode_units("agent"), J::Str(self.root.to_vec())),
                        (encode_units("until"), J::Num(self.now.to_string())),
                    ]));
                }
                if !*self.root_seen {
                    *self.root_seen = true;
                    facts.push(J::Obj(vec![
                        (encode_units("type"), J::Str(encode_units("agent.seen"))),
                        (encode_units("agent"), J::Str(self.root.to_vec())),
                        (encode_units("origin"), J::Str(encode_units("root"))),
                        (encode_units("fidelity"), J::Str(encode_units("full"))),
                        (
                            encode_units("native"),
                            J::Obj(vec![(
                                encode_units("provider"),
                                J::Str(encode_units("cursor")),
                            )]),
                        ),
                        (encode_units("cwd"), J::Str(self.cwd.clone())),
                    ]));
                }
                let text = string(body.get("message").unwrap_or(&J::Null))
                    .map(|text| text.to_vec())
                    .unwrap_or_else(|| {
                        encode_units("SDK failure; delivery or execution is uncertain")
                    });
                let failure = cursor_failure(
                    body.get("code").unwrap_or(&J::Null),
                    &text,
                    body.get("retryable").unwrap_or(&J::Null),
                );
                facts.extend(self.tools.preserve(None));
                facts.extend(self.children.preserve());
                let code = failure.code.unwrap_or_else(|| {
                    if failure.kind == "quota" {
                        encode_units("quota")
                    } else {
                        encode_units("cursor.run-failed")
                    }
                });
                facts.push(self.notice(&text, envelope, "error", &code));
                if *self.active
                    && !*self.replacement
                    && matches!(body.get("settled"), Some(J::Bool(true)))
                {
                    *self.active = false;
                    let message = string(body.get("message").unwrap_or(&J::Null))
                        .map(|message| message.to_vec())
                        .unwrap_or_else(|| encode_units("SDK run failed"));
                    facts.push(J::Obj(vec![
                        (encode_units("type"), J::Str(encode_units("turn.ended"))),
                        (encode_units("agent"), J::Str(self.root.to_vec())),
                        (
                            encode_units("nativeTurnId"),
                            J::Str(super::envelope::cat(&[
                                &encode_units("sdk:"),
                                event.operation_id,
                            ])),
                        ),
                        (encode_units("outcome"), J::Str(encode_units("failed"))),
                        (
                            encode_units("error"),
                            failed_run(
                                body.get("code").unwrap_or(&J::Null),
                                &message,
                                body.get("retryable").unwrap_or(&J::Null),
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
