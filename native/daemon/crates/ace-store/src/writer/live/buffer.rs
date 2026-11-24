// SPDX-License-Identifier: Apache-2.0
//! The live write buffer's state (task 5.4b). Ports `LiveWriteBuffer`'s bookkeeping from
//! `apps/daemon/src/live-write-buffer.ts`: what each buffered event weighs, the 64 KiB
//! flush-now rule, the 8 MiB ceiling, the 75 ms and 1 s deadlines, failure counting, and the
//! retirement of a stored batch or a quarantined thread.
//!
//! It holds sequences, thread keys and sizes, never event objects: the shell owns those, in the
//! same order, and this state says what it must do with them. A deadline comes back to the shell
//! as the delay to schedule, so the timer stays on the owning thread (ADR 0222 §3); nothing here
//! owns a timer, a thread, a clock or a global.

use ace_json::JsString;

use crate::writer::live::retry::retry_delay;

/// What one buffered event adds to the weight, on top of eight times its JSON bytes: the row's
/// own cost, so a batch of many tiny events still drains.
const EVENT_OVERHEAD: f64 = 512.0;
/// The weight at which `full` asks for a flush now: 64 KiB of weighed events.
const FLUSH_WEIGHT: f64 = 64.0 * 1024.0;
/// The weight a batch may not pass: 8 MiB. Uncommitted data is pinned, never evicted.
const CEILING_WEIGHT: f64 = 8.0 * 1024.0 * 1024.0;
/// What each admitted batch adds to the ceiling while it is checked (`stream()`'s size guard).
const ADMISSION_HEADROOM: f64 = 4096.0;
/// A batch holding rows waits this long: subscribers may already hold nearby sequences.
pub const EVENT_DELAY_MS: u64 = 75;
/// A batch holding only snapshots (an agent's transport signals) waits longer: nobody has seen
/// it, and it usually rides along with the next transaction.
pub const QUIET_DELAY_MS: u64 = 1_000;

/// `weightOfBytes`: the weight of one event's JSON bytes.
fn weight_of_bytes(bytes: f64) -> f64 {
    bytes * 8.0 + EVENT_OVERHEAD
}

/// One buffered event, as the buffer holds it.
#[derive(Debug)]
struct Entry {
    /// The sequence the shell allocated when it built the event; never renumbered here.
    seq: f64,
    /// The thread whose snapshot the event travels with.
    thread: JsString,
    /// `EventEncodings.bytes(event)`: the UTF-8 bytes of the event's JSON.
    bytes: f64,
}

/// The counters the store reports (`streamingMetrics`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Metrics {
    pub flushes: u64,
    pub rows: u64,
    pub failures: u64,
    /// Every event's JSON bytes ever buffered.
    pub live_bytes: f64,
    /// The largest weight the buffer has reached.
    pub peak_bytes: f64,
}

/// Whether a batch of some size may be admitted now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// It fits: admit it without draining.
    Admit,
    /// The buffer must drain first, then admit it.
    Drain,
    /// It can never fit: the caller refuses with "Store is busy".
    Never,
}

/// What a removal left behind, for the shell: its own arrays, its timer and its waiters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wake {
    /// Pinned threads still holding events or snapshots.
    pub size: usize,
    /// A scheduled flush was dropped, so the caller cancels its timer.
    pub cancelled: bool,
    /// Nothing is pinned any more: the caller resolves `settled`'s waiters.
    pub woke: bool,
}

/// The pinned batch: uncommitted events, their snapshots' threads, and the flush bookkeeping.
#[derive(Debug, Default)]
pub struct Buffer {
    entries: Vec<Entry>,
    /// The pinned threads in first-insertion order, as a JavaScript `Map` keeps its keys.
    threads: Vec<JsString>,
    /// Consecutive failed attempts at the pinned batch; zero while healthy.
    failures: u32,
    /// The delay of the timer the caller has armed, when it has one.
    armed: Option<u64>,
    weight: f64,
    metrics: Metrics,
}

impl Buffer {
    pub fn new() -> Buffer {
        Buffer::default()
    }

    /// Whether the last attempt failed and the batch is waiting to retry.
    pub fn failed(&self) -> bool {
        self.failures > 0
    }

    /// Pinned threads; liveness-only batches count too.
    pub fn size(&self) -> usize {
        self.threads.len()
    }

    /// Whether the pinned batch holds only snapshots.
    pub fn quiet(&self) -> bool {
        !self.threads.is_empty() && self.entries.is_empty()
    }

    /// The weight of the pinned batch.
    pub fn bytes(&self) -> f64 {
        self.weight
    }

    /// The last buffered event's sequence: the next live sequence after the batch.
    pub fn head(&self) -> Option<f64> {
        self.entries.last().map(|entry| entry.seq)
    }

    pub fn has(&self, thread: &JsString) -> bool {
        self.threads.contains(thread)
    }

    pub fn threads(&self) -> &[JsString] {
        &self.threads
    }

    pub fn metrics(&self) -> Metrics {
        self.metrics
    }

    /// Whether a batch of `bytes` must drain the buffer first; `Never` for one that cannot fit.
    pub fn admission(&self, bytes: f64) -> Admission {
        if weight_of_bytes(bytes) + ADMISSION_HEADROOM > CEILING_WEIGHT {
            return Admission::Never;
        }
        if self.weight + weight_of_bytes(bytes) + ADMISSION_HEADROOM > CEILING_WEIGHT {
            return Admission::Drain;
        }
        Admission::Admit
    }

    /// Pin `events` with their thread's snapshot; returns the deadline to schedule, if the
    /// armed one must be replaced. The facts behind these events are already applied in memory,
    /// so admission never refuses here; `full()` drains an overshoot at once.
    pub fn append(&mut self, thread: &str, events: &[(f64, f64)]) -> Option<u64> {
        let thread = JsString::from(thread);
        if !self.threads.contains(&thread) {
            self.threads.push(thread.clone());
        }
        for &(seq, bytes) in events {
            self.weight += weight_of_bytes(bytes);
            self.metrics.live_bytes += bytes;
            self.entries.push(Entry {
                seq,
                thread: thread.clone(),
                bytes,
            });
        }
        if self.weight > self.metrics.peak_bytes {
            self.metrics.peak_bytes = self.weight;
        }
        self.arm(self.delay())
    }

    /// The index of the first buffered event after `seq`: what `after(seq)` returns.
    pub fn after(&self, seq: f64) -> usize {
        let mut start = self.entries.len();
        while start > 0 {
            match self.entries.get(start - 1) {
                Some(entry) if entry.seq > seq => start -= 1,
                _ => break,
            }
        }
        start
    }

    /// Whether the buffer is at the flush-now weight.
    pub fn full(&self) -> bool {
        self.weight >= FLUSH_WEIGHT
    }

    /// An attempt is starting: it replaces any scheduled one. Says whether a timer was armed,
    /// so the caller cancels it.
    pub fn begin(&mut self) -> bool {
        self.armed.take().is_some()
    }

    /// The deadline the caller armed has fired; a later `arm` is still pending.
    pub fn fired(&mut self) -> bool {
        self.armed.take().is_some()
    }

    /// These threads' events and snapshots are durable: release them, settling once empty.
    pub fn committed(&mut self, threads: &[JsString], rows: u64) -> Wake {
        let wake = self.remove(threads);
        self.metrics.flushes = self.metrics.flushes.saturating_add(1);
        self.metrics.rows = self.metrics.rows.saturating_add(rows);
        wake
    }

    /// Quarantine: forget a thread's events and snapshot without storing them.
    pub fn discard(&mut self, thread: &JsString) -> Wake {
        self.remove(std::slice::from_ref(thread))
    }

    /// A failed attempt keeps the batch pinned and schedules the next one; returns its delay.
    pub fn retry(&mut self) -> u64 {
        self.failures = self.failures.saturating_add(1);
        self.metrics.failures = self.metrics.failures.saturating_add(1);
        let ms = retry_delay(self.failures);
        self.begin();
        self.arm(ms);
        ms
    }

    /// Rows written for the batch were rolled back with an enclosing transaction: write again.
    pub fn rearm(&mut self) -> Option<u64> {
        if self.threads.is_empty() {
            return None;
        }
        self.arm(self.delay())
    }

    /// Shutdown: drop any scheduled flush. The caller wakes its waiters.
    pub fn stop(&mut self) -> bool {
        self.begin()
    }

    /// The delay a batch with these events waits: rows soon, snapshots alone later.
    fn delay(&self) -> u64 {
        if self.entries.is_empty() {
            QUIET_DELAY_MS
        } else {
            EVENT_DELAY_MS
        }
    }

    /// A shorter delay replaces a longer armed one, so a quiet batch that gains events re-arms.
    /// Returns the delay to schedule, or None to keep the timer that is already armed.
    fn arm(&mut self, ms: u64) -> Option<u64> {
        if self.armed.is_some_and(|armed| armed <= ms) {
            return None;
        }
        self.armed = Some(ms);
        Some(ms)
    }

    /// Forget `threads`: their snapshots and every event they carry.
    fn remove(&mut self, gone: &[JsString]) -> Wake {
        let everything =
            gone.len() >= self.threads.len() && gone.iter().all(|thread| self.has(thread));
        if everything {
            self.entries.clear();
            self.threads.clear();
            self.weight = 0.0;
        } else {
            self.threads.retain(|thread| !gone.contains(thread));
            self.entries.retain(|entry| !gone.contains(&entry.thread));
            self.weight = self
                .entries
                .iter()
                .fold(0.0, |total, entry| total + weight_of_bytes(entry.bytes));
        }
        let size = self.threads.len();
        if size > 0 {
            return Wake {
                size,
                cancelled: false,
                woke: false,
            };
        }
        self.failures = 0;
        let cancelled = self.begin();
        Wake {
            size,
            cancelled,
            woke: true,
        }
    }
}

#[cfg(test)]
mod tests;
