// SPDX-License-Identifier: Apache-2.0
//! What a Cursor host reads back and what the daemon says it attempted (`unsettled.ts`): the runs
//! an open turn started and never saw end, how far the frames reach into Cursor's own stored
//! events, and the latest send whose fate the store decides. Pure: no store, no clock.

use ace_json::Value;
use indexmap::IndexMap;

/// A run the committed frames know of, and how far into its SDK-stored events they reach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seam {
    pub through: i64,
    pub offset: Option<String>,
    pub pending: Vec<String>,
    /// Seen only in frames an earlier build stored, which say nothing of the SDK's events.
    pub legacy: bool,
}

/// The attempt a reopened host has not settled yet: the send ace saw attempted, its run (when the
/// frames name one) and whether the host framed that run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attempt {
    pub operation_id: String,
    pub command_id: Option<String>,
    pub segment: i64,
    pub at: i64,
    pub run_id: Option<String>,
    pub run_framed: bool,
}

/// `Unsettled`: what the daemon's committed frames lack of the open turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Unsettled {
    /// Oldest first, at most 64.
    pub runs: Vec<UnsettledRun>,
    pub attempt: Option<Attempt>,
}

/// One run in [`Unsettled`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsettledRun {
    pub run_id: String,
    pub through: i64,
    pub pending: Vec<String>,
    pub after_offset: Option<String>,
    pub legacy: bool,
}

/// `UnsettledRuns`: folds committed frames, in order, into what the open turn's record lacks.
#[derive(Debug, Default)]
pub struct UnsettledRuns {
    runs: IndexMap<String, Seam>,
    attempt: Option<Attempt>,
    current: Option<String>,
}

impl UnsettledRuns {
    pub fn new() -> UnsettledRuns {
        UnsettledRuns::default()
    }

    /// A frame of `run_id` stamped against the SDK's stored events: each stamp says all there is,
    /// so the newest one stands, live or recovered.
    fn advance(
        &mut self,
        run_id: &str,
        event_seq: Option<i64>,
        pending: Option<&[String]>,
        offset: Option<&str>,
    ) {
        let mut seam = self.runs.get(run_id).cloned().unwrap_or(Seam {
            through: 0,
            offset: None,
            pending: Vec::new(),
            legacy: event_seq.is_none(),
        });
        if event_seq.is_none() || event_seq.is_some_and(|event| event < seam.through) {
            self.runs.insert(run_id.to_owned(), seam);
            return;
        }
        seam = Seam {
            through: event_seq.unwrap_or(seam.through),
            offset: offset.map(str::to_owned),
            pending: pending.map(|pending| pending.to_vec()).unwrap_or_default(),
            legacy: false,
        };
        self.runs.insert(run_id.to_owned(), seam);
    }

    /// One committed frame (`data`), as the daemon stored it.
    pub fn add(&mut self, data: &Value) {
        let Some(kind) = data.get("kind").and_then(Value::as_str) else {
            return;
        };
        let Some(operation_id) = data.get("operationId").and_then(Value::as_str) else {
            return;
        };
        if operation_id.is_empty() {
            return;
        }
        let command_id = data
            .get("commandId")
            .and_then(Value::as_str)
            .filter(|command| !command.is_empty())
            .map(str::to_owned);
        let segment = data.get("segment").and_then(Value::as_i64).unwrap_or(0);
        let run_id = data
            .get("runId")
            .and_then(Value::as_str)
            .filter(|run| !run.is_empty());
        let event_seq = data.get("eventSeq").and_then(Value::as_i64);
        let event_offset = data
            .get("eventOffset")
            .and_then(Value::as_str)
            .filter(|offset| !offset.is_empty());
        let pending: Option<Vec<String>> =
            data.get("pendingEvents")
                .and_then(Value::as_array)
                .map(|events| {
                    events
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                });
        let body = data.get("body").unwrap_or(&Value::Null);
        if kind == "send" {
            let attempted = body
                .get("attemptedAt")
                .and_then(Value::as_i64)
                .filter(|at| *at >= 0);
            self.attempt = attempted.map(|at| Attempt {
                operation_id: operation_id.to_owned(),
                command_id: command_id.clone(),
                segment,
                at,
                run_id: None,
                run_framed: body.get("runFramed").and_then(Value::as_bool) == Some(true),
            });
            return;
        }
        // The run the SDK was about to create for the attempt: whether it exists is the store's.
        if kind == "run" {
            if let Some(native_run_id) = body
                .get("nativeRunId")
                .and_then(Value::as_str)
                .filter(|run| !run.is_empty())
                && self
                    .attempt
                    .as_ref()
                    .is_some_and(|attempt| attempt.operation_id == operation_id)
            {
                let attempt = self.attempt.take().unwrap_or(Attempt {
                    operation_id: String::new(),
                    command_id: None,
                    segment: 0,
                    at: 0,
                    run_id: None,
                    run_framed: false,
                });
                self.attempt = Some(Attempt {
                    run_id: Some(native_run_id.to_owned()),
                    ..attempt
                });
            }
            return;
        }
        if kind == "segment" {
            self.attempt = None;
            let id = body
                .get("nativeRunId")
                .and_then(Value::as_str)
                .filter(|run| !run.is_empty())
                .or(run_id);
            if let Some(id) = id {
                self.current = Some(id.to_owned());
                self.advance(id, event_seq, pending.as_deref(), event_offset);
            }
            return;
        }
        // A send Cursor refused or failed is the session's own error, already in the record.
        if kind == "error"
            && self
                .attempt
                .as_ref()
                .is_some_and(|attempt| attempt.operation_id == operation_id)
        {
            self.attempt = None;
        }
        let Some(id) = run_id.map(str::to_owned).or_else(|| self.current.clone()) else {
            return;
        };
        let ends = kind == "result"
            || kind == "recovery"
            || (matches!(kind, "error" | "cancel")
                && body.get("settled").and_then(Value::as_bool) == Some(true));
        if ends {
            self.runs.shift_remove(&id);
            if self.current.as_deref() == Some(id.as_str()) {
                self.current = None;
            }
            return;
        }
        if run_id.is_none() {
            return;
        }
        // Output of the attempted send names its run: Cursor had it.
        if self
            .attempt
            .as_ref()
            .is_some_and(|attempt| attempt.operation_id == operation_id)
        {
            self.attempt = None;
            self.current = Some(id.clone());
        }
        self.advance(&id, event_seq, pending.as_deref(), event_offset);
    }

    /// What the record lacks, oldest runs first, at most 64 (`result()`).
    pub fn result(&self) -> Unsettled {
        let runs = self
            .runs
            .iter()
            .rev()
            .take(64)
            .rev()
            .map(|(run_id, seam)| UnsettledRun {
                run_id: run_id.clone(),
                through: seam.through,
                pending: seam.pending.clone(),
                after_offset: seam.offset.clone(),
                legacy: seam.legacy,
            })
            .collect();
        Unsettled {
            runs,
            attempt: self.attempt.clone(),
        }
    }
}

/// What the record says of the latest attempted send: its command, and any sign Cursor had it.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecord {
    #[serde(default)]
    pub command_id: String,
    #[serde(default)]
    pub operation_id: String,
    /// Something of the send beyond the attempt itself (its run, output) was recorded.
    pub evidence: bool,
    /// What a reopened host read back from Cursor's store about it, if it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admitted: Option<bool>,
    /// Rebuilt for an earlier build's thread whose newest frames held no send, with older frames
    /// past them: a send of its can't be ruled out, so none is ever taken as unattempted.
    #[serde(default)]
    pub older: bool,
}

impl AttemptRecord {
    /// The record `older`: an earlier build's thread with no send among its newest frames.
    pub fn older() -> AttemptRecord {
        AttemptRecord {
            older: true,
            ..AttemptRecord::default()
        }
    }
}

/// Frames that say nothing of whether Cursor had the send (`unsettled.ts:236`).
fn bookkeeping(kind: &str) -> bool {
    matches!(
        kind,
        "send"
            | "admission"
            | "error"
            | "cancel"
            | "host-exit"
            | "host-output"
            | "snapshot"
            | "run"
    )
}

/// `noteAttempt` (`unsettled.ts:246`): folds one committed frame into the latest attempt's record;
/// the same record when nothing changed, so the daemon writes only on a change.
pub fn note_attempt(record: Option<AttemptRecord>, data: &Value) -> Option<AttemptRecord> {
    let Some(kind) = data.get("kind").and_then(Value::as_str) else {
        return record;
    };
    let Some(operation_id) = data.get("operationId").and_then(Value::as_str) else {
        return record;
    };
    if operation_id.is_empty() {
        return record;
    }
    let command_id = data
        .get("commandId")
        .and_then(Value::as_str)
        .filter(|command| !command.is_empty());
    let body = data.get("body").unwrap_or(&Value::Null);
    if kind == "send" {
        return Some(AttemptRecord {
            command_id: command_id.unwrap_or(operation_id).to_owned(),
            operation_id: operation_id.to_owned(),
            evidence: false,
            admitted: None,
            older: false,
        });
    }
    let record = record?;
    if kind == "admission" {
        let admitted = body.get("admitted").and_then(Value::as_bool);
        let admission_command = body.get("commandId").and_then(Value::as_str);
        return match admitted {
            Some(admitted) if admission_command == Some(record.command_id.as_str()) => {
                Some(AttemptRecord {
                    admitted: Some(admitted),
                    ..record
                })
            }
            _ => Some(record),
        };
    }
    if record.evidence || bookkeeping(kind) {
        return Some(record);
    }
    if operation_id == record.operation_id || command_id == Some(record.command_id.as_str()) {
        return Some(AttemptRecord {
            evidence: true,
            ..record
        });
    }
    Some(record)
}

#[cfg(test)]
mod tests;
