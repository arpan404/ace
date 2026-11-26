// SPDX-License-Identifier: Apache-2.0
//! `covered`: whether a snapshot the pass read already says a buffered event, so
//! replaying it would duplicate it (`recovery-evidence.ts`'s `covered`). Four
//! shapes have an absence proof: an interaction a snapshot no longer lists, an
//! idle active snapshot for a started execution, a shell's snapshot, and the
//! tail of a message for a delta.

use ace_json::{Map, Value};

use crate::translate::data::{fields, get, n_in, s_in};

use super::{EvidenceError, RecoveryEvidence, key};

impl RecoveryEvidence {
    /// `covered`: whether a replayed snapshot already says this event.
    /// `session` is the event's `eventSession`, which the caller already read.
    /// A malformed interaction key list is the TypeScript's thrown ZodError:
    /// it fails the pass rather than covering nothing.
    pub fn covered(
        &self,
        typ: &str,
        payload: &Map,
        session: &str,
        created: Option<f64>,
        watermark: u64,
    ) -> Result<bool, EvidenceError> {
        if typ == "shell.created" {
            let id = s_in(fields(get(payload, "info")), "id");
            return Ok(self
                .shells
                .get(id)
                .is_some_and(|state| state.owner == session && watermark <= state.started));
        }
        if typ == "permission.asked" || typ == "form.created" || typ == "session.execution.started"
        {
            // `Array.prototype.some`: the first match answers, in stage order.
            for snapshot in &self.snapshots {
                if snapshot.session != session || watermark > snapshot.started {
                    continue;
                }
                let data = fields(&snapshot.data);
                if typ == "session.execution.started" {
                    let idle_at = data.get("idleAt");
                    let running = data.get("running");
                    if snapshot.channel == "snapshot.active"
                        && running == Some(&Value::Bool(false))
                        && idle_at.and_then(Value::as_f64).is_some()
                        && (created.is_none()
                            || idle_at.and_then(Value::as_f64).unwrap_or(0.0)
                                >= created.unwrap_or(0.0))
                    {
                        return Ok(true);
                    }
                    continue;
                }
                if snapshot.channel != "snapshot.interactions" {
                    continue;
                }
                let interaction = if typ == "form.created" {
                    fields(get(payload, "form"))
                } else {
                    payload
                };
                let prefix = if typ == "form.created" {
                    "form"
                } else {
                    "permission"
                };
                let key = format!("{prefix}:{session}:{}", s_in(interaction, "id"));
                if !self.interaction_keys(&snapshot.data)?.contains(&key) {
                    return Ok(true);
                }
            }
            return Ok(false);
        }
        if typ != "session.text.delta" && typ != "session.reasoning.delta" {
            return Ok(false);
        }
        let kind = if typ.contains("reasoning") {
            "reasoning"
        } else {
            "text"
        };
        let key = key(
            kind,
            s_in(payload, "sessionID"),
            s_in(payload, "assistantMessageID"),
            n_in(payload, "ordinal"),
        );
        Ok(self
            .deltas
            .get(&key)
            .is_some_and(|entry| watermark <= entry.covered))
    }
}
