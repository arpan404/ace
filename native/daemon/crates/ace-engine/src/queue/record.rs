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

    /// `RecoveryRecord.parse`'s strictness over a stored row: the enums, the non-negative
    /// numbers, and the continuation's UTF-16 cap.
    pub fn validate(&self) -> Result<(), EngineError> {
        let invalid = || EngineError::Records("Invalid queue metadata".into());
        if self.pending_count < 0 || self.revision < 0 || self.hold_token < 0 {
            return Err(invalid());
        }
        if self.reset_at.is_some_and(|value| value < 0)
            || self.resume_at.is_some_and(|value| value < 0)
        {
            return Err(invalid());
        }
        if self
            .reason
            .as_deref()
            .is_some_and(|reason| !REASONS.contains(&reason))
        {
            return Err(invalid());
        }
        if self
            .timer_action
            .as_deref()
            .is_some_and(|action| !TIMER_ACTIONS.contains(&action))
        {
            return Err(invalid());
        }
        if self
            .trigger
            .as_deref()
            .is_some_and(|trigger| !TRIGGERS.contains(&trigger))
        {
            return Err(invalid());
        }
        if self
            .continuation
            .as_deref()
            .is_some_and(|text| text.encode_utf16().count() > CONTINUATION_UNITS)
        {
            return Err(invalid());
        }
        if let Some(failure) = &self.last_failure
            && !valid_failure(failure)
        {
            return Err(invalid());
        }
        Ok(())
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

/// `QueueState.lastFailure`: `{title: 1..256, code: 1..128}`, nothing else kept by the parse.
fn valid_failure(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let length = |key: &str| match map.get(key) {
        Some(Value::String(text)) => Some(text.as_str().chars().count()),
        _ => None,
    };
    matches!(length("title"), Some(1..=256)) && matches!(length("code"), Some(1..=128))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> RecoveryRecord {
        RecoveryRecord::defaults(0)
    }

    #[test]
    fn failure_titles_are_limited_to_256_code_points() {
        let with_title = |count| RecoveryRecord {
            last_failure: Some(
                ace_json::parse(&format!(
                    r#"{{"title":"{}","code":"failed"}}"#,
                    "😀".repeat(count)
                ))
                .unwrap(),
            ),
            ..record()
        };
        assert!(with_title(256).validate().is_ok());
        assert!(with_title(257).validate().is_err());
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
}
