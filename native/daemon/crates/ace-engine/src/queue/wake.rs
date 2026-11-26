// SPDX-License-Identifier: Apache-2.0
//! The snooze wake before a queue change (`snooze-wake.ts:6`, E5.4a). The queue branch of
//! `threadAttention` and `queueWakesSnooze` are the pure rules; this reads the thread through
//! the store port and builds the one event they ask for.

use ace_json::Value;

use crate::EngineError;

/// `wakeFor` (`snooze-wake.ts:6`): the wake to publish before a queue change that newly needs
/// the person on a snoozed thread.
pub fn wake_for(
    store: &crate::EngineStore,
    thread: &str,
    next: &Value,
    at: f64,
) -> Result<Vec<Value>, EngineError> {
    let Some(json) = store.get_thread(thread)? else {
        return Ok(Vec::new());
    };
    let current =
        ace_json::parse(&json).map_err(|_| EngineError::Records("Invalid thread".into()))?;
    if !ace_projection::attention::queue_wakes_snooze(&current, next, at) {
        return Ok(Vec::new());
    }
    let mut changes = ace_json::Map::new();
    changes.insert("snoozedUntil", Value::Null);
    changes.insert(
        "snoozeWoke",
        ace_projection::attention::snooze_woke_by_queue(at),
    );
    let mut event = ace_json::Map::new();
    event.insert("type", Value::from("thread.client.updated"));
    event.insert("changes", Value::Object(changes));
    Ok(vec![Value::Object(event)])
}
