// SPDX-License-Identifier: Apache-2.0

//! One computer-use request's clock (`computer/timing.ts`): durations only, never arguments,
//! window titles, text or screenshots. The clock is injected at the process boundary.

use std::collections::HashMap;
use std::sync::Arc;

use ace_json::Value;

/// The phase names a helper's own timings may carry (`timing.ts:11`-`:27`).
const PHASE_NAMES: [&str; 15] = [
    "sessionMs",
    "windowsMs",
    "actionMs",
    "guardMs",
    "betweenSettleMs",
    "finalSettleMs",
    "observationMs",
    "walkMs",
    "fetchMs",
    "actionsMs",
    "describeMs",
    "screenshotMs",
    "events",
    "visited",
    "returned",
];

/// How one request ended (`timing.ts:34`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Error,
    Cancelled,
    Timeout,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Error => "error",
            Outcome::Cancelled => "cancelled",
            Outcome::Timeout => "timeout",
        }
    }
}

/// The helper's own timings, filtered to the phase names above (`timing.ts:44`-`:49`).
#[derive(Debug, Clone, PartialEq)]
pub struct NativeTiming {
    pub elapsed_ms: Option<f64>,
    pub phases: HashMap<String, f64>,
    pub observation: HashMap<String, f64>,
}

/// One request's diagnostics (`timing.ts:44`).
#[derive(Debug, Clone, PartialEq)]
pub struct RequestTiming {
    pub op: String,
    pub app: Option<String>,
    pub outcome: &'static str,
    pub queue_ms: f64,
    pub startup_ms: f64,
    pub helper_ms: f64,
    pub decode_ms: f64,
    pub total_ms: f64,
    pub native: Option<NativeTiming>,
}

/// A monotonic milliseconds clock, injected (`timing.ts:52`).
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

fn duration(start: f64, finish: f64) -> f64 {
    (finish - start).max(0.0)
}

fn phases(values: Option<&Value>) -> HashMap<String, f64> {
    let mut kept = HashMap::new();
    let Some(object) = values.and_then(Value::as_object) else {
        return kept;
    };
    for name in PHASE_NAMES {
        if let Some(value) = object.get(name).and_then(Value::as_f64)
            && value.is_finite()
            && value >= 0.0
        {
            kept.insert(name.to_owned(), value);
        }
    }
    kept
}

/// The reply's own timings, when it carries any (`timing.ts:82`-`:95`).
fn native_timing(result: &Value) -> (bool, Option<NativeTiming>) {
    let object = result.as_object();
    let failed = object
        .and_then(|fields| fields.get("error"))
        .and_then(Value::as_object)
        .and_then(|error| error.get("code"))
        .is_some_and(|code| code.is_string());
    let Some(fields) = object else {
        return (failed, None);
    };
    let elapsed_ms = fields
        .get("elapsedMs")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0);
    let state_timings = fields
        .get("state")
        .and_then(Value::as_object)
        .and_then(|state| state.get("timings"));
    let phases_here = phases(fields.get("timings"));
    let observation = phases(state_timings);
    if elapsed_ms.is_none() && phases_here.is_empty() && observation.is_empty() {
        return (failed, None);
    }
    (
        failed,
        Some(NativeTiming {
            elapsed_ms,
            phases: phases_here,
            observation,
        }),
    )
}

/// One request's span (`timing.ts:52`). No `Debug`: the injected clock is a closure, and a span
/// is never logged (it holds durations only, and the report is their one reader).
pub struct RequestSpan {
    op: String,
    now: Clock,
    queued: f64,
    picked: Option<f64>,
    sent: Option<f64>,
    received: Option<f64>,
    decoded: Option<f64>,
    native: Option<NativeTiming>,
    failed: bool,
}

impl RequestSpan {
    pub fn new(op: impl Into<String>, now: Clock) -> Self {
        let queued = now();
        Self {
            op: op.into(),
            now,
            queued,
            picked: None,
            sent: None,
            received: None,
            decoded: None,
            native: None,
            failed: false,
        }
    }

    /// The current time, for a reply's stamp (`timing.ts:67`).
    pub fn stamp(&self) -> f64 {
        (self.now)()
    }

    /// The request left the queue (`timing.ts:70`).
    pub fn dequeue(&mut self) {
        self.picked = Some((self.now)());
    }

    /// The request reached native stdin (`timing.ts:73`).
    pub fn ready(&mut self) {
        self.sent = Some((self.now)());
    }

    /// The helper's reply arrived at `at` (`timing.ts:77`).
    pub fn reply(&mut self, at: f64, result: Option<&Value>) {
        self.received = Some(at);
        if let Some(result) = result {
            let (failed, native) = native_timing(result);
            self.failed = failed;
            self.native = native;
        }
        self.decoded = Some((self.now)());
    }

    /// The request is over (`timing.ts:97`).
    pub fn finish(self, outcome: Outcome, app: Option<String>) -> RequestTiming {
        let end = (self.now)();
        let queue_ms = duration(self.queued, self.picked.unwrap_or(end));
        let startup_ms = self
            .picked
            .map_or(0.0, |picked| duration(picked, self.sent.unwrap_or(end)));
        let helper_ms = self
            .sent
            .map_or(0.0, |sent| duration(sent, self.received.unwrap_or(end)));
        let decode_ms = self.received.map_or(0.0, |received| {
            duration(received, self.decoded.unwrap_or(end))
        });
        let reported = match outcome {
            Outcome::Ok if self.failed => Outcome::Error,
            other => other,
        };
        RequestTiming {
            op: self.op,
            app,
            outcome: reported.as_str(),
            queue_ms,
            startup_ms,
            helper_ms,
            decode_ms,
            total_ms: duration(self.queued, end),
            native: self.native,
        }
    }
}

#[cfg(test)]
// The `computer/timing` cases, moved from TypeScript
// (`packages/screen/src/computer/timing.test.ts`): the phase durations, an older helper's
// malformed metrics, and a partially completed batch's outcome.
mod tests {
    use super::{Clock, Outcome, RequestSpan};
    use ace_json::{Value, json};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A clock the test moves by hand, in milliseconds.
    fn clock() -> (Arc<AtomicU64>, Clock) {
        let ticks = Arc::new(AtomicU64::new(0));
        let handle = Arc::clone(&ticks);
        let clock: Clock = Arc::new(move || handle.load(Ordering::Relaxed) as f64);
        (ticks, clock)
    }

    #[test]
    fn a_span_reports_each_phase_it_saw_and_none_it_did_not() {
        let (ticks, now) = clock();
        let mut span = RequestSpan::new("state", now);
        ticks.store(5, Ordering::Relaxed);
        span.dequeue();
        ticks.store(9, Ordering::Relaxed);
        span.ready();
        ticks.store(29, Ordering::Relaxed);
        let at = span.stamp();
        ticks.store(31, Ordering::Relaxed);
        span.reply(at, None);
        let timing = span.finish(Outcome::Ok, Some("notes".to_owned()));
        assert_eq!(timing.op, "state");
        assert_eq!(timing.app.as_deref(), Some("notes"));
        assert_eq!(timing.outcome, "ok");
        assert_eq!(timing.queue_ms, 5.0);
        assert_eq!(timing.startup_ms, 4.0);
        assert_eq!(timing.helper_ms, 20.0);
        assert_eq!(timing.decode_ms, 2.0);
        assert_eq!(timing.total_ms, 31.0);
        assert_eq!(timing.native, None);
    }

    #[test]
    fn a_span_that_never_reached_the_helper_reports_zero_for_the_later_phases() {
        let (ticks, now) = clock();
        let span = RequestSpan::new("act", now);
        ticks.store(40, Ordering::Relaxed);
        let timing = span.finish(Outcome::Cancelled, None);
        assert_eq!(timing.queue_ms, 40.0);
        assert_eq!(timing.startup_ms, 0.0);
        assert_eq!(timing.helper_ms, 0.0);
        assert_eq!(timing.decode_ms, 0.0);
        assert_eq!(timing.outcome, "cancelled");
    }

    #[test]
    fn the_helper_timings_keep_only_the_phase_names_and_an_error_reply_is_an_error() {
        let (_, now) = clock();
        let mut span = RequestSpan::new("state", now);
        let reply = json!({
            "error": { "code": "no_access" },
            "elapsedMs": 12,
            "timings": { "sessionMs": 3, "unknownMs": 9, "walkMs": -1 },
            "state": { "timings": { "fetchMs": 4, "events": 2 } }
        });
        span.reply(span.stamp(), Some(&reply));
        let timing = span.finish(Outcome::Ok, None);
        assert_eq!(timing.outcome, "error");
        let Some(native) = timing.native else {
            panic!("expected the helper's timings");
        };
        assert_eq!(native.elapsed_ms, Some(12.0));
        assert_eq!(native.phases.get("sessionMs"), Some(&3.0));
        assert_eq!(native.phases.get("unknownMs"), None);
        assert_eq!(native.phases.get("walkMs"), None);
        assert_eq!(native.observation.get("fetchMs"), Some(&4.0));
        assert_eq!(native.observation.get("events"), Some(&2.0));
    }

    #[test]
    fn a_result_without_timings_reports_none() {
        let (_, now) = clock();
        let mut span = RequestSpan::new("apps", now);
        span.reply(span.stamp(), Some(&Value::Null));
        assert_eq!(span.finish(Outcome::Ok, None).native, None);
    }
}
