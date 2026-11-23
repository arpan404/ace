// SPDX-License-Identifier: Apache-2.0
//! The settled-frame decisions: the terminal switch of the dispatch
//! (`translator.ts` step, second half).

use serde_json::{Map, Value, json};

use super::BudgetResult;
use super::envelope::{Envelope, object, string};
use super::facts::failed_run;
use super::failure_kind::cursor_failure;
use super::translator::Step;

impl Step<'_> {
    pub fn finish(
        &mut self,
        event: &Envelope,
        envelope: &Value,
        body: &Map<String, Value>,
        namespace: &str,
        dir: &str,
    ) -> BudgetResult<Vec<Value>> {
        match event.kind {
            "segment" => Ok(Vec::new()),
            "delta-chunk" | "delta" => {
                let root = self.root.to_owned();
                self.delta(body, &root, namespace, envelope, Some(event), 0)
            }
            "message" => {
                // Frames from an earlier build: the stream's copy of onDelta, never shown twice.
                Ok(vec![json!({ "type": "signal", "agent": self.root })])
            }
            "cancel" => {
                if dir == "send" {
                    *self.replacement = body.get("replacement") == Some(&Value::Bool(true));
                    *self.interrupted = !*self.replacement;
                }
                Ok(Vec::new())
            }
            "result" => {
                if !*self.active {
                    return Ok(Vec::new());
                }
                if !["finished", "cancelled", "error"]
                    .contains(&string(body.get("status").unwrap_or(&Value::Null)).unwrap_or(""))
                {
                    let mut facts = Vec::new();
                    facts.extend(self.tools.preserve(None));
                    facts.extend(self.children.preserve());
                    facts.push(self.notice(
                        "Unrecognized SDK terminal status; execution remains uncertain",
                        envelope,
                        "warning",
                        "cursor.diagnostic",
                    ));
                    return Ok(facts);
                }
                let mut facts = Vec::new();
                facts.extend(self.transcript.end());
                facts.extend(self.tools.preserve(None));
                facts.extend(self.children.preserve());
                if body.get("status") == Some(&Value::String("error".to_owned())) {
                    let error = object(body.get("error").unwrap_or(&Value::Null));
                    facts.push(
                        self.notice(
                            string(error.get("message").unwrap_or(&Value::Null))
                                .unwrap_or("Cursor SDK run failed"),
                            envelope,
                            "error",
                            "cursor.run-failed",
                        ),
                    );
                }
                if *self.replacement {
                    return Ok(facts);
                }
                *self.active = false;
                let outcome = if body.get("status") == Some(&Value::String("finished".to_owned())) {
                    "completed"
                } else if body.get("status") == Some(&Value::String("cancelled".to_owned()))
                    || *self.interrupted
                {
                    "interrupted"
                } else {
                    "failed"
                };
                let mut ended = json!({
                    "type": "turn.ended",
                    "agent": self.root,
                    "nativeTurnId": format!("sdk:{}", event.operation_id),
                    "outcome": outcome,
                });
                if outcome == "failed" {
                    let error = object(body.get("error").unwrap_or(&Value::Null));
                    ended["error"] = failed_run(
                        error.get("code").unwrap_or(&Value::Null),
                        string(error.get("message").unwrap_or(&Value::Null))
                            .unwrap_or("Cursor SDK run failed"),
                        error.get("retryable").unwrap_or(&Value::Null),
                    );
                }
                facts.push(ended);
                Ok(facts)
            }
            "error" => {
                let mut facts = Vec::new();
                // A send Cursor refused or failed to take: nothing is starting any more.
                if self
                    .attempt
                    .as_ref()
                    .is_some_and(|attempt| attempt.operation_id == event.operation_id)
                {
                    *self.attempt = None;
                    facts.push(json!({
                        "type": "wake.expected",
                        "agent": self.root,
                        "until": self.now,
                    }));
                }
                if !*self.root_seen {
                    *self.root_seen = true;
                    facts.push(json!({
                        "type": "agent.seen",
                        "agent": self.root,
                        "origin": "root",
                        "fidelity": "full",
                        "native": { "provider": "cursor" },
                        "cwd": self.cwd.clone(),
                    }));
                }
                let text = string(body.get("message").unwrap_or(&Value::Null))
                    .unwrap_or("SDK failure; delivery or execution is uncertain");
                let failure = cursor_failure(
                    body.get("code").unwrap_or(&Value::Null),
                    text,
                    body.get("retryable").unwrap_or(&Value::Null),
                );
                facts.extend(self.tools.preserve(None));
                facts.extend(self.children.preserve());
                facts.push(self.notice(
                    text,
                    envelope,
                    "error",
                    &failure.code.unwrap_or_else(|| {
                        if failure.kind == "quota" {
                            "quota".to_owned()
                        } else {
                            "cursor.run-failed".to_owned()
                        }
                    }),
                ));
                if *self.active
                    && !*self.replacement
                    && body.get("settled") == Some(&Value::Bool(true))
                {
                    *self.active = false;
                    let ended = json!({
                        "type": "turn.ended",
                        "agent": self.root,
                        "nativeTurnId": format!("sdk:{}", event.operation_id),
                        "outcome": "failed",
                        "error": failed_run(
                            body.get("code").unwrap_or(&Value::Null),
                            string(body.get("message").unwrap_or(&Value::Null)).unwrap_or("SDK run failed"),
                            body.get("retryable").unwrap_or(&Value::Null),
                        ),
                    });
                    facts.push(ended);
                }
                Ok(facts)
            }
            "close" => Ok(self.children.preserve()),
            _ => Ok(Vec::new()),
        }
    }
}
