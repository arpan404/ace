// SPDX-License-Identifier: Apache-2.0
//! The live buffer's binding (docs/store/porting-guide.md, task 5.4b). The state lives in
//! `ace_store::writer::live::buffer`; this file translates arguments, deadlines and JSON text,
//! and nothing here touches SQL. The shell holds the event objects, the snapshots and the
//! timer, and schedules each deadline on the thread that owns the store.

use ace_json::{JsString, Map, Number, Value};
use ace_store::writer::live::buffer::{Admission, Buffer, Metrics, Wake};
use napi_derive::napi;

/// The largest integer a JavaScript number holds exactly (`Number.isSafeInteger`).
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A JavaScript integer the buffer accepts, as `Number.isSafeInteger` reads one.
fn safe_number(value: f64, name: &str) -> napi::Result<f64> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE {
        return Ok(value);
    }
    Err(napi::Error::from_reason(format!(
        "live buffer {name} must be a JavaScript integer"
    )))
}

/// A deadline in milliseconds, as the scheduler takes it.
fn deadline(ms: u64) -> u32 {
    u32::try_from(ms).unwrap_or(u32::MAX)
}

/// `{ size, cancelled, woke }`: what a removal left for the shell's arrays, timer and waiters.
fn wake_json(wake: Wake) -> String {
    let mut map = Map::new();
    map.insert("size", Value::Number(Number::from(wake.size)));
    map.insert("cancelled", Value::Bool(wake.cancelled));
    map.insert("woke", Value::Bool(wake.woke));
    ace_json::to_string(&Value::Object(map))
}

/// The pinned thread keys in order, as the shell's snapshot map holds them.
fn threads_json(threads: &[JsString]) -> String {
    let items: Vec<Value> = threads
        .iter()
        .map(|thread| Value::String(thread.clone()))
        .collect();
    ace_json::to_string(&Value::Array(items.into()))
}

/// `LiveWriteBuffer.metrics`.
fn metrics_json(metrics: Metrics) -> String {
    let mut map = Map::new();
    map.insert("flushes", Value::Number(Number::from(metrics.flushes)));
    map.insert("rows", Value::Number(Number::from(metrics.rows)));
    map.insert("failures", Value::Number(Number::from(metrics.failures)));
    map.insert("liveBytes", Value::Number(Number::from(metrics.live_bytes)));
    map.insert("peakBytes", Value::Number(Number::from(metrics.peak_bytes)));
    ace_json::to_string(&Value::Object(map))
}

/// The live buffer's bookkeeping behind `ACE_STORE_WRITER=live` (task 5.4b). It holds
/// sequences, JSON sizes and thread keys; the shell holds the events, the snapshots and the
/// timer this class hands deadlines to.
#[napi]
pub struct NativeLiveBuffer {
    buffer: Buffer,
}

impl NativeLiveBuffer {
    /// An empty, unarmed buffer: the store's stream owns one per `Store`.
    pub fn empty() -> NativeLiveBuffer {
        NativeLiveBuffer {
            buffer: Buffer::new(),
        }
    }
}

#[napi]
impl NativeLiveBuffer {
    /// Pin `events` as `[seq, bytes]` pairs with their thread's snapshot. Returns the deadline
    /// to schedule, or null when the armed one stands.
    #[napi(catch_unwind)]
    pub fn append(&mut self, thread: String, events: Vec<f64>) -> napi::Result<Option<u32>> {
        if !events.len().is_multiple_of(2) {
            return Err(napi::Error::from_reason(
                "live buffer events must be sequence and bytes pairs",
            ));
        }
        let mut pairs = Vec::with_capacity(events.len() / 2);
        let mut items = events.iter();
        while let (Some(seq), Some(bytes)) = (items.next(), items.next()) {
            let seq = safe_number(*seq, "sequence")?;
            let bytes = safe_number(*bytes, "bytes")?;
            if bytes < 0.0 {
                return Err(napi::Error::from_reason(
                    "live buffer bytes must not be negative",
                ));
            }
            pairs.push((seq, bytes));
        }
        Ok(self.buffer.append(&thread, &pairs).map(deadline))
    }

    /// An attempt is starting: it replaces any scheduled one. Says whether a timer was armed.
    #[napi(catch_unwind)]
    pub fn begin(&mut self) -> bool {
        self.buffer.begin()
    }

    /// These threads' events and snapshots are durable. `rows` counts the rows written.
    #[napi(catch_unwind)]
    pub fn committed(&mut self, threads: Vec<String>, rows: f64) -> napi::Result<String> {
        let rows = safe_number(rows, "rows")?;
        let rows = Number::from_f64(rows)
            .and_then(|number| number.as_u64())
            .ok_or_else(|| {
                napi::Error::from_reason("live buffer rows must be a non-negative integer")
            })?;
        let threads: Vec<JsString> = threads.into_iter().map(JsString::from).collect();
        Ok(wake_json(self.buffer.committed(&threads, rows)))
    }

    /// Quarantine: forget a thread's events and snapshot without storing them.
    #[napi(catch_unwind)]
    pub fn discard(&mut self, thread: String) -> String {
        wake_json(self.buffer.discard(&JsString::from(thread)))
    }

    /// A failed attempt keeps the batch pinned and schedules the next one; returns its delay.
    #[napi(catch_unwind)]
    pub fn retry(&mut self) -> u32 {
        deadline(self.buffer.retry())
    }

    /// Rows written for the batch were rolled back: write again, unless a deadline stands.
    #[napi(catch_unwind)]
    pub fn rearm(&mut self) -> Option<u32> {
        self.buffer.rearm().map(deadline)
    }

    /// The deadline the shell armed has fired; a later `rearm` still arms one.
    #[napi(catch_unwind)]
    pub fn fired(&mut self) -> bool {
        self.buffer.fired()
    }

    /// Shutdown: drop any scheduled flush. Says whether a timer was armed.
    #[napi(catch_unwind)]
    pub fn stop(&mut self) -> bool {
        self.buffer.stop()
    }

    #[napi(catch_unwind)]
    pub fn failed(&self) -> bool {
        self.buffer.failed()
    }

    #[napi(catch_unwind)]
    pub fn size(&self) -> u32 {
        u32::try_from(self.buffer.size()).unwrap_or(u32::MAX)
    }

    #[napi(catch_unwind)]
    pub fn quiet(&self) -> bool {
        self.buffer.quiet()
    }

    #[napi(catch_unwind)]
    pub fn bytes(&self) -> f64 {
        self.buffer.bytes()
    }

    #[napi(catch_unwind)]
    pub fn head(&self) -> Option<f64> {
        self.buffer.head()
    }

    #[napi(catch_unwind)]
    pub fn has(&self, thread: String) -> bool {
        self.buffer.has(&JsString::from(thread))
    }

    /// The pinned thread keys, in first-insertion order, as one JSON array.
    #[napi(catch_unwind)]
    pub fn threads(&self) -> String {
        threads_json(self.buffer.threads())
    }

    /// The index of the first buffered event after `seq`.
    #[napi(catch_unwind)]
    pub fn after(&self, seq: f64) -> napi::Result<u32> {
        let seq = safe_number(seq, "sequence")?;
        Ok(u32::try_from(self.buffer.after(seq)).unwrap_or(u32::MAX))
    }

    #[napi(catch_unwind)]
    pub fn full(&self) -> bool {
        self.buffer.full()
    }

    /// Whether a batch of `bytes` must drain the buffer first; a batch that can never fit
    /// throws "Store is busy", as the TypeScript's `overfull` does.
    #[napi(catch_unwind)]
    pub fn overfull(&self, bytes: f64) -> napi::Result<bool> {
        let bytes = safe_number(bytes, "bytes")?;
        if bytes < 0.0 {
            return Err(napi::Error::from_reason(
                "live buffer bytes must not be negative",
            ));
        }
        match self.buffer.admission(bytes) {
            Admission::Never => Err(napi::Error::from_reason("Store is busy")),
            Admission::Drain => Ok(true),
            Admission::Admit => Ok(false),
        }
    }

    #[napi(catch_unwind)]
    pub fn metrics(&self) -> String {
        metrics_json(self.buffer.metrics())
    }
}
