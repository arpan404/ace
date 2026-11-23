// SPDX-License-Identifier: Apache-2.0
//! The frame dispatch: envelope kinds into facts (`translator.ts` step).

use serde_json::{Map, Value, json};

use super::envelope::{native_identity, object, string};
use super::recovered_tail::{store_gap, stored_update};
use super::translator::{Attempt, Step};
use super::turns::utf16_head;
use super::{BudgetError, BudgetResult};

impl Step<'_> {
    pub fn step(
        &mut self,
        event: &super::envelope::Envelope,
        envelope: &Value,
        namespace: &str,
        dir: &str,
    ) -> BudgetResult<Vec<Value>> {
        let body = object(event.body);
        match event.kind {
            "open" => {
                *self.saved = String::new();
                *self.root_seen = true;
                *self.cwd = string(body.get("cwd").unwrap_or(&Value::Null))
                    .unwrap_or("")
                    .to_owned();
                let model = string(body.get("model").unwrap_or(&Value::Null));
                let mut native = Map::new();
                native.insert("provider".to_owned(), Value::String("cursor".to_owned()));
                if let Some(agent_id) = event.agent_id {
                    native.insert("nativeId".to_owned(), Value::String(agent_id.to_owned()));
                }
                let mut seen = Map::new();
                seen.insert("type".to_owned(), Value::String("agent.seen".to_owned()));
                seen.insert("agent".to_owned(), Value::String(self.root.to_owned()));
                seen.insert("origin".to_owned(), Value::String("root".to_owned()));
                seen.insert("fidelity".to_owned(), Value::String("full".to_owned()));
                seen.insert("cwd".to_owned(), Value::String(self.cwd.clone()));
                if let Some(model) = model {
                    seen.insert("model".to_owned(), Value::String(model.to_owned()));
                }
                seen.insert("native".to_owned(), Value::Object(native));
                return Ok(vec![Value::Object(seen)]);
            }
            "send" => {
                *self.attempt = Some(Attempt {
                    generation: event.generation.to_owned(),
                    operation_id: event.operation_id.to_owned(),
                    command_id: event.command_id.map(str::to_owned),
                    segment: event.segment,
                    body: event.body.clone(),
                });
                // Working while Cursor takes the input, without a run that
                // would take the input before Cursor has it.
                if *self.active {
                    return Ok(Vec::new());
                }
                return Ok(vec![json!({
                    "type": "wake.expected",
                    "agent": self.root,
                    "until": self.now + 600_000,
                })]);
            }
            "segment" => {
                let admitted = self.attempt.as_ref().is_some_and(|attempt| {
                    attempt.operation_id == event.operation_id && attempt.segment == event.segment
                });
                if !admitted {
                    return Ok(Vec::new());
                }
                let attempt = self.attempt.clone().ok_or(BudgetError::Exceeded)?;
                return self.admit(&attempt);
            }
            "admission" => {
                let admitted = self.attempt.as_ref().is_some_and(|attempt| {
                    attempt.operation_id
                        == string(body.get("operationId").unwrap_or(&Value::Null)).unwrap_or("")
                        && Some(attempt.segment)
                            == body.get("segment").and_then(|segment| segment.as_i64())
                });
                if !admitted {
                    return Ok(Vec::new());
                }
                if body.get("admitted") == Some(&Value::Bool(true)) {
                    let attempt = self.attempt.clone().ok_or(BudgetError::Exceeded)?;
                    return self.admit(&attempt);
                }
                *self.attempt = None;
                // Cursor's store had no run for it. Whether it was sent is the
                // daemon's to say: only it knows whether the last run's
                // processes were proven gone before that read.
                return Ok(vec![json!({
                    "type": "wake.expected",
                    "agent": self.root,
                    "until": self.now,
                })]);
            }
            "recovered" => {
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
                        let update = object(&update).clone();
                        let namespace = self.turn_namespace.clone();
                        self.delta(&update, self.root, &namespace, envelope, Some(event), 0)
                    }
                    None => Ok(Vec::new()),
                };
            }
            "recovered-result" => {
                if self.saved.encode_utf16().count() < 4 * 1024 * 1024 {
                    self.saved
                        .push_str(string(body.get("text").unwrap_or(&Value::Null)).unwrap_or(""));
                }
                return Ok(Vec::new());
            }
            "recovery" => return self.recover(event, envelope, body),
            "snapshot" => {
                return Ok(vec![self.notice(
                    "Checkpoint snapshot retained for reconciliation; positional UUIDs do not establish live-message identity. No uncertain history was appended.",
                    envelope,
                    "warning",
                    "cursor.diagnostic",
                )]);
            }
            _ => {}
        }
        // A shared host/store failure fences execution even when an old segment caused it.
        if event.kind == "error"
            && ["boundary_overflow", "checkpoint_budget"]
                .contains(&string(body.get("code").unwrap_or(&Value::Null)).unwrap_or(""))
        {
            let mut facts = Vec::new();
            facts.extend(self.tools.preserve(None));
            facts.extend(self.children.preserve());
            facts.push(
                self.notice(
                    string(body.get("message").unwrap_or(&Value::Null))
                        .unwrap_or("SDK host resource budget failed; checkpoint retained"),
                    envelope,
                    "error",
                    "cursor.diagnostic",
                ),
            );
            facts.push(json!({
                "type": "process.exited",
                "deliberate": false,
                "message": utf16_head(
                    string(body.get("message").unwrap_or(&Value::Null)).unwrap_or("Cursor's turn was fenced"),
                    512,
                ),
            }));
            return Ok(facts);
        }
        if event.kind == "blob" {
            return Ok(vec![json!({ "type": "signal", "agent": self.root })]);
        }
        if event.kind == "shell-output" {
            let parent = native_identity(body.get("parentCallId").unwrap_or(&Value::Null))?;
            let child = match &parent {
                Some(parent) => {
                    let call = format!("{namespace}:call:{parent}");
                    self.children
                        .calls
                        .get(&call)
                        .map(|child| child.key.clone())
                }
                None => None,
            };
            if parent.is_some() && child.is_none() {
                return Ok(vec![self.notice(
                    "Shell output has no observed owning child",
                    envelope,
                    "warning",
                    "cursor.diagnostic",
                )]);
            }
            let agent = child.unwrap_or_else(|| self.root.to_owned());
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
        if event.kind == "host-exit" {
            let unsettled =
                self.children.calls.values().any(|child| !child.settled) || self.tools.has_open();
            let preserved = self.children.preserve();
            if !*self.active && !unsettled {
                return Ok(preserved);
            }
            let mut facts = preserved;
            facts.push(self.notice(
                "Cursor stopped unexpectedly. Unfinished work needs your attention.",
                envelope,
                "warning",
                "cursor.work-stopped",
            ));
            return Ok(facts);
        }
        // A failure of the attempted send is the person's to see though no turn started.
        let attempt_failed = event.kind == "error"
            && self
                .attempt
                .as_ref()
                .is_some_and(|attempt| attempt.operation_id == event.operation_id);
        if stale
            && !attempt_failed
            && !(event.kind == "error" && event.operation_id == "open" && !*self.root_seen)
        {
            // Surviving child facts belong to their original call namespace, never the replacement root.
            if event.kind == "delta"
                && string(body.get("type").unwrap_or(&Value::Null)) == Some("tool-call-completed")
            {
                let call = format!(
                    "{namespace}:call:{}",
                    native_identity(body.get("callId").unwrap_or(&Value::Null))?
                        .unwrap_or_default()
                );
                if self.tools.calls.contains_key(&call) || self.children.calls.contains_key(&call) {
                    let agent = self.tools.agent_of(&call).unwrap_or(self.root).to_owned();
                    return self.delta(body, &agent, namespace, envelope, Some(event), 0);
                }
            }
            if (event.kind == "delta" || event.kind == "delta-chunk")
                && string(body.get("type").unwrap_or(&Value::Null)) == Some("tool-call-delta")
            {
                let call = format!(
                    "{namespace}:call:{}",
                    native_identity(body.get("callId").unwrap_or(&Value::Null))?
                        .unwrap_or_default()
                );
                let child = self
                    .children
                    .calls
                    .get(&call)
                    .map(|child| (child.key.clone(), child.settled));
                if let Some((key, false)) = child {
                    let update = object(body.get("taskUpdate").unwrap_or(&Value::Null)).clone();
                    return self.delta(&update, &key, namespace, envelope, Some(event), 1);
                }
            }
            return Ok(Vec::new());
        }
        self.finish(event, envelope, body, namespace, dir)
    }
}
