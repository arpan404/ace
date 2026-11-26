// SPDX-License-Identifier: Apache-2.0
//! The queue's branch of `threadAttention` (`thread-attention.ts:42`) and its snooze wake
//! (`snooze-woke.ts:59`, E5.4a). Pure over the thread JSON the store returns.

use ace_json::Value;

/// `threadAttention`'s queue branch: the reason the queue needs the person, if it does.
pub fn queue_attention(queue: Option<&Value>) -> Option<String> {
    let queue = queue?;
    if queue.get("paused").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let reason = queue.get("reason").and_then(Value::as_str)?;
    if queue.get("resumeAt").is_some_and(|value| !value.is_null()) {
        return None;
    }
    if reason == "manual" {
        // `!queue.pendingCount`: an absent or zero count needs nobody.
        let pending = queue.get("pendingCount").and_then(Value::as_f64);
        if pending.is_none_or(|count| count == 0.0) {
            return None;
        }
    }
    if matches!(reason, "limit" | "snooze" | "stopped") {
        return None;
    }
    Some(reason.to_owned())
}

/// `queueWakesSnooze` (`thread-attention.ts:42`): only recovery that newly needs the person
/// wakes a snooze.
pub fn queue_wakes_snooze(thread: &Value, next: &Value, at: f64) -> bool {
    let snoozed = thread.get("snoozedUntil").and_then(Value::as_f64);
    let Some(snoozed) = snoozed else {
        return false;
    };
    if snoozed <= at {
        return false;
    }
    let after = queue_attention(Some(next));
    after.is_some() && after != queue_attention(thread.get("queue"))
}

/// `snoozeWokeByQueue` (`snooze-woke.ts:59`).
pub fn snooze_woke_by_queue(at: f64) -> Value {
    let mut map = ace_json::Map::new();
    map.insert("on", Value::from("needs_you"));
    map.insert("at", Value::from(at));
    map.insert("outcome", Value::from("asking"));
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(paused: bool, reason: &str, resume: Value) -> Value {
        let mut map = ace_json::Map::new();
        map.insert("paused", Value::Bool(paused));
        map.insert("reason", Value::from(reason));
        map.insert("resumeAt", resume);
        Value::Object(map)
    }

    #[test]
    fn only_an_unresolved_recovery_hold_needs_the_person() {
        assert_eq!(
            queue_attention(Some(&queue(true, "not_sent", Value::Null))),
            Some("not_sent".into())
        );
        assert_eq!(
            queue_attention(Some(&queue(true, "limit", Value::Null))),
            None
        );
        assert_eq!(
            queue_attention(Some(&queue(true, "not_sent", Value::from(5)))),
            None
        );
    }

    #[test]
    fn a_snooze_wakes_only_when_the_queue_newly_needs_the_person() {
        let mut snoozed = ace_json::Map::new();
        snoozed.insert("snoozedUntil", Value::from(1_000));
        snoozed.insert("queue", queue(true, "manual", Value::Null));
        let thread = Value::Object(snoozed);
        // A manual hold with messages now needs the person; before it did not.
        let next = queue(true, "manual", Value::Null);
        let mut next_map = next.as_object().cloned().unwrap_or_default();
        next_map.insert("pendingCount", Value::from(1));
        assert!(queue_wakes_snooze(&thread, &Value::Object(next_map), 10.0));
        // The same hold carrying on keeps it asleep.
        assert!(!queue_wakes_snooze(&thread, &next, 10.0));
    }
}
