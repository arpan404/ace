// SPDX-License-Identifier: Apache-2.0
//! `RecoveryRecord` and `RecoveryPatch` (`queue-store.ts:19`-`:50`): the durable queue metadata,
//! its rules, and what a patch keeps or clears. The queue's pending work is never here (the
//! brief's owner decision): a missing row defaults only these settings.

use ace_json::Value;

use crate::EngineError;

pub const REASONS: [&str; 8] = [
    "manual",
    "restart",
    "limit",
    "snooze",
    "uncertain",
    "stopped",
    "not_sent",
    "model_unavailable",
];
pub const TIMER_ACTIONS: [&str; 4] = ["resume", "snooze", "migrate", "clear"];
pub const TRIGGERS: [&str; 2] = ["restart", "limit_resume"];
/// `z.string().max(16384)` counts UTF-16 code units.
pub const CONTINUATION_UNITS: usize = 16_384;

#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryRecord {
    pub pending_count: i64,
    pub revision: i64,
    pub paused: bool,
    pub last_failure: Option<Value>,
    pub reason: Option<String>,
    pub resume_at: Option<i64>,
    pub exited: bool,
    pub hold_token: i64,
    pub limited: bool,
    pub reset_at: Option<i64>,
    pub timer_action: Option<String>,
    pub continuation: Option<String>,
    pub trigger: Option<String>,
}

impl RecoveryRecord {
    /// A thread with no `engine_queue` row: revision 0, not paused, not limited, no
    /// continuation, no trigger, hold token 0, not exited. Its pending count is its intents'.
    pub fn defaults(pending_count: i64) -> RecoveryRecord {
        RecoveryRecord {
            pending_count,
            revision: 0,
            paused: false,
            last_failure: None,
            reason: None,
            resume_at: None,
            exited: false,
            hold_token: 0,
            limited: false,
            reset_at: None,
            timer_action: None,
            continuation: None,
            trigger: None,
        }
    }

    /// The record as clients see it: a `clear` deadline lifts a limit but promises no resume
    /// (`queue-store.ts:137`).
    pub fn shown(&self) -> RecoveryRecord {
        let mut value = self.clone();
        if value.timer_action.as_deref() == Some("clear") {
            value.resume_at = None;
        }
        value
    }

    /// The `Rust` record in the protocol's key order (what `QueueState.parse` keeps).
    pub fn to_json(&self) -> Value {
        let mut map = ace_json::Map::new();
        map.insert("pendingCount", Value::from(self.pending_count));
        map.insert("revision", Value::from(self.revision));
        map.insert("paused", Value::Bool(self.paused));
        map.insert(
            "lastFailure",
            self.last_failure.clone().unwrap_or(Value::Null),
        );
        map.insert(
            "reason",
            self.reason.clone().map_or(Value::Null, Value::from),
        );
        if self.exited {
            map.insert("exited", Value::Bool(true));
        }
        map.insert("resumeAt", self.resume_at.map_or(Value::Null, Value::from));
        Value::Object(map)
    }

    /// The `QueueInfo` subset E5.3's fold reads.
    pub fn info(&self) -> crate::repository::collaborators::QueueInfo {
        crate::repository::collaborators::QueueInfo {
            continuation: self.continuation.is_some(),
            trigger: self.trigger.clone(),
            limited: self.limited,
            paused: self.paused,
            reason: self.reason.clone(),
        }
    }
}

/// A patch: every field optional, and `null` kept distinct from absent.
#[derive(Debug, Clone, Default)]
pub struct RecoveryPatch {
    pub pending_count: Option<i64>,
    pub revision: Option<i64>,
    pub paused: Option<bool>,
    pub last_failure: Option<Option<Value>>,
    pub reason: Option<Option<String>>,
    pub resume_at: Option<Option<i64>>,
    pub exited: Option<bool>,
    pub hold_token: Option<i64>,
    pub limited: Option<bool>,
    pub reset_at: Option<Option<i64>>,
    pub timer_action: Option<Option<String>>,
    pub continuation: Option<Option<String>>,
    pub trigger: Option<Option<String>>,
}

impl RecoveryPatch {
    /// `Partial<RecoveryRecord>` from its JSON text. A key holding `null` is present-and-null;
    /// a key the object lacks is absent.
    pub fn parse(text: &str) -> Result<RecoveryPatch, EngineError> {
        let value = ace_json::parse(text)
            .map_err(|_| EngineError::Records("Invalid queue metadata".into()))?;
        let Some(map) = value.as_object() else {
            return Err(EngineError::Records("Invalid queue metadata".into()));
        };
        let mut patch = RecoveryPatch::default();
        let present = |key: &str| map.get(key).cloned();
        if let Some(value) = present("pendingCount") {
            patch.pending_count = Some(integer(&value)?);
        }
        if let Some(value) = present("revision") {
            patch.revision = Some(integer(&value)?);
        }
        if let Some(value) = present("paused") {
            patch.paused = Some(flag(&value)?);
        }
        patch.last_failure = present("lastFailure").map(|value| match value {
            Value::Null => None,
            value => Some(value),
        });
        if let Some(value) = present("reason") {
            patch.reason = Some(optional_text(value, &REASONS)?);
        }
        if let Some(value) = present("resumeAt") {
            patch.resume_at = Some(optional_integer(value)?);
        }
        if let Some(value) = present("exited") {
            patch.exited = Some(flag(&value)?);
        }
        if let Some(value) = present("holdToken") {
            patch.hold_token = Some(integer(&value)?);
        }
        if let Some(value) = present("limited") {
            patch.limited = Some(flag(&value)?);
        }
        if let Some(value) = present("resetAt") {
            patch.reset_at = Some(optional_integer(value)?);
        }
        if let Some(value) = present("timerAction") {
            patch.timer_action = Some(optional_text(value, &TIMER_ACTIONS)?);
        }
        if let Some(value) = present("trigger") {
            patch.trigger = Some(optional_text(value, &TRIGGERS)?);
        }
        if let Some(value) = present("continuation") {
            patch.continuation = Some(optional_continuation(value)?);
        }
        Ok(patch)
    }

    /// `{...before, ...patch, exited: exitedAfter(...), lastFailure: ...}` (`:144`-`:154`).
    pub fn apply(&self, before: &RecoveryRecord) -> Result<RecoveryRecord, EngineError> {
        let mut value = before.clone();
        if let Some(pending_count) = self.pending_count {
            value.pending_count = nonnegative(pending_count)?;
        }
        if let Some(revision) = self.revision {
            value.revision = nonnegative(revision)?;
        }
        if let Some(paused) = self.paused {
            value.paused = paused;
        }
        if let Some(last_failure) = &self.last_failure {
            value.last_failure = last_failure.clone();
        }
        if let Some(reason) = &self.reason {
            value.reason = reason.clone();
        }
        if let Some(resume_at) = &self.resume_at {
            value.resume_at = resume_at.map(nonnegative).transpose()?;
        }
        if let Some(exited) = self.exited {
            value.exited = exited;
        }
        if let Some(hold_token) = self.hold_token {
            value.hold_token = nonnegative(hold_token)?;
        }
        if let Some(limited) = self.limited {
            value.limited = limited;
        }
        if let Some(reset_at) = &self.reset_at {
            value.reset_at = reset_at.map(nonnegative).transpose()?;
        }
        if let Some(timer_action) = &self.timer_action {
            value.timer_action = timer_action.clone();
        }
        if let Some(continuation) = &self.continuation {
            value.continuation = continuation.clone();
        }
        if let Some(trigger) = &self.trigger {
            value.trigger = trigger.clone();
        }
        value.exited = exited_after(before, self);
        if self.paused == Some(false)
            || self.reason.as_ref().is_some_and(|reason| {
                reason.as_deref() != Some("not_sent")
                    && reason.as_deref() != Some("model_unavailable")
            })
        {
            value.last_failure = None;
        }
        Ok(value)
    }
}

/// `exitedAfter` (`queue-store.ts:37`).
pub fn exited_after(before: &RecoveryRecord, patch: &RecoveryPatch) -> bool {
    let paused = patch.paused.unwrap_or(before.paused);
    let reason = match &patch.reason {
        Some(reason) => reason.clone(),
        None => before.reason.clone(),
    };
    if !paused || reason.as_deref() != Some("restart") {
        return false;
    }
    if let Some(exited) = patch.exited {
        return exited;
    }
    before.paused && before.reason.as_deref() == Some("restart") && before.exited
}

fn integer(value: &Value) -> Result<i64, EngineError> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .ok_or_else(|| EngineError::Records("Invalid queue metadata".into())),
        _ => Err(EngineError::Records("Invalid queue metadata".into())),
    }
}

fn nonnegative(value: i64) -> Result<i64, EngineError> {
    if value < 0 {
        return Err(EngineError::Records("Invalid queue metadata".into()));
    }
    Ok(value)
}

fn flag(value: &Value) -> Result<bool, EngineError> {
    match value {
        Value::Bool(value) => Ok(*value),
        _ => Err(EngineError::Records("Invalid queue metadata".into())),
    }
}

fn optional_text(value: Value, allowed: &[&str]) -> Result<Option<String>, EngineError> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => {
            let text = text.as_str().to_owned();
            if allowed.contains(&text.as_str()) {
                Ok(Some(text))
            } else {
                Err(EngineError::Records("Invalid queue metadata".into()))
            }
        }
        _ => Err(EngineError::Records("Invalid queue metadata".into())),
    }
}

fn optional_integer(value: Value) -> Result<Option<i64>, EngineError> {
    match value {
        Value::Null => Ok(None),
        value => Ok(Some(nonnegative(integer(&value)?)?)),
    }
}

fn optional_continuation(value: Value) -> Result<Option<String>, EngineError> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => {
            let units = text.len_utf16();
            if units > CONTINUATION_UNITS {
                return Err(EngineError::Records("Invalid queue metadata".into()));
            }
            Ok(Some(text.as_str().to_owned()))
        }
        _ => Err(EngineError::Records("Invalid queue metadata".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> RecoveryRecord {
        RecoveryRecord::defaults(0)
    }

    #[test]
    fn exited_only_describes_a_restart_hold_kept_or_set_anew() {
        // A restart hold that was not already exited clears it; one already exited keeps it.
        let held = RecoveryRecord {
            paused: true,
            reason: Some("restart".into()),
            exited: true,
            ..record()
        };
        let patch = RecoveryPatch::default();
        assert!(exited_after(&held, &patch));
        let fresh = RecoveryRecord {
            paused: true,
            reason: Some("restart".into()),
            exited: false,
            ..record()
        };
        assert!(!exited_after(&fresh, &patch));
        // Any other reason, or no hold, is false whatever `before` said.
        let manual = RecoveryRecord {
            paused: true,
            reason: Some("manual".into()),
            exited: true,
            ..record()
        };
        assert!(!exited_after(&manual, &patch));
        // An explicit patch value wins.
        let explicit = RecoveryPatch {
            exited: Some(true),
            ..RecoveryPatch::default()
        };
        assert!(exited_after(&fresh, &explicit));
    }

    #[test]
    fn last_failure_clears_when_the_hold_is_released_or_replaced() {
        let before = RecoveryRecord {
            last_failure: Some(Value::from("failed")),
            paused: true,
            reason: Some("not_sent".into()),
            ..record()
        };
        // Releasing the hold clears it.
        let release = RecoveryPatch {
            paused: Some(false),
            ..RecoveryPatch::default()
        };
        assert!(release.apply(&before).unwrap().last_failure.is_none());
        // So does a reason other than the two failed-send holds.
        let manual = RecoveryPatch {
            reason: Some(Some("manual".into())),
            ..RecoveryPatch::default()
        };
        assert!(manual.apply(&before).unwrap().last_failure.is_none());
        // Keeping `not_sent` keeps it.
        let same = RecoveryPatch {
            reason: Some(Some("not_sent".into())),
            ..RecoveryPatch::default()
        };
        assert!(same.apply(&before).unwrap().last_failure.is_some());
    }

    #[test]
    fn shown_hides_the_resume_time_of_a_clear_deadline() {
        let value = RecoveryRecord {
            resume_at: Some(100),
            timer_action: Some("clear".into()),
            ..record()
        };
        assert_eq!(value.shown().resume_at, None);
        let resume = RecoveryRecord {
            resume_at: Some(100),
            timer_action: Some("resume".into()),
            ..record()
        };
        assert_eq!(resume.shown().resume_at, Some(100));
    }

    #[test]
    fn a_continuation_is_capped_at_16384_utf16_units() {
        let fits = RecoveryPatch::parse(&format!(
            "{{\"continuation\":\"{}\"}}",
            "a".repeat(CONTINUATION_UNITS)
        ))
        .unwrap();
        assert!(fits.apply(&record()).is_ok());
        let over = RecoveryPatch::parse(&format!(
            "{{\"continuation\":\"{}\"}}",
            "a".repeat(CONTINUATION_UNITS + 1)
        ));
        assert!(over.is_err());
    }
}
