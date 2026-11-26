// SPDX-License-Identifier: Apache-2.0
//! `logs.ts`: one device's log stream, kept to the last 256 lines, delivered in batches of at
//! most 64, with one replaceable batch waiting behind a busy subscriber. The ring, the batches
//! and each subscriber's state live here and return effects; the process, the timers and the
//! delivery promises are the shell's. A push is per line, so the shell keeps this in-process
//! when the all-Rust daemon calls it (the per-frame rule); only the read a person asks for
//! (`tail`) crosses the addon.

use std::collections::VecDeque;

use ace_json::JsString;

/// The lines a device's log keeps: the oldest falls off the front.
pub const RING_LINES: usize = 256;
/// The most lines one delivered batch holds.
pub const BATCH_LINES: usize = 64;
/// Subscribers one log stream serves at once.
pub const SUBSCRIBER_LIMIT: usize = 64;

/// The most lines a read shows, before and after clamping.
pub const TAIL_LIMIT: u32 = 256;

/// One delivery: what a subscriber is sent and the sequence it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogBatch {
    pub sequence: u64,
    pub lines: Vec<JsString>,
    pub dropped: u64,
}

/// What a push asks the shell to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pushed {
    /// Start the 100 ms flush timer; false while one is already running.
    pub schedule_flush: bool,
}

/// A read of the ring: the newest `limit` lines and the sequence they end at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tailed {
    pub lines: Vec<JsString>,
    pub sequence: u64,
}

/// Why a subscriber was not added.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Log subscriber limit")]
pub struct SubscriberLimit;

#[derive(Debug, Default)]
struct Subscriber {
    id: u64,
    busy: bool,
    pending: Option<LogBatch>,
    active: bool,
}

/// One device's log ring and its subscribers.
#[derive(Debug, Default)]
pub struct Logs {
    ring: VecDeque<JsString>,
    sequence: u64,
    batch: Option<LogBatch>,
    subscribers: Vec<Subscriber>,
    next_subscriber: u64,
}

impl Logs {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes one rendered line into the ring and the open batch.
    pub fn push(&mut self, line: JsString) -> Pushed {
        if self.ring.len() == RING_LINES {
            self.ring.pop_front();
        }
        self.ring.push_back(line.clone());
        let mut batch = self.batch.take().unwrap_or(LogBatch {
            sequence: 0,
            lines: Vec::new(),
            dropped: 0,
        });
        let schedule_flush = batch.sequence == 0;
        if batch.lines.len() >= BATCH_LINES {
            batch.lines.remove(0);
            batch.dropped += 1;
        }
        batch.lines.push(line);
        self.sequence += 1;
        batch.sequence = self.sequence;
        self.batch = Some(batch);
        Pushed { schedule_flush }
    }

    /// Hands the open batch to every subscriber that is free; a busy one keeps one replaceable
    /// batch instead, and the oldest lines of the two together fall off.
    pub fn flush(&mut self) -> Vec<(u64, LogBatch)> {
        let Some(batch) = self.batch.take() else {
            return Vec::new();
        };
        let mut deliveries = Vec::new();
        for subscriber in &mut self.subscribers {
            if !subscriber.active {
                continue;
            }
            if subscriber.busy {
                let old = subscriber.pending.take();
                let mut lines = old
                    .as_ref()
                    .map(|batch| batch.lines.clone())
                    .unwrap_or_default();
                let old_dropped = old.as_ref().map(|batch| batch.dropped).unwrap_or(0);
                lines.extend(batch.lines.iter().cloned());
                let over = lines.len().saturating_sub(BATCH_LINES);
                let keep = lines.split_off(over);
                subscriber.pending = Some(LogBatch {
                    sequence: batch.sequence,
                    lines: keep,
                    dropped: old_dropped + batch.dropped + over as u64,
                });
            } else {
                subscriber.busy = true;
                deliveries.push((subscriber.id, batch.clone()));
            }
        }
        deliveries
    }

    /// A subscriber's send resolved: it is free, and any batch that waited is its next.
    pub fn delivered(&mut self, id: u64) -> Option<(u64, LogBatch)> {
        let subscriber = self.subscribers.iter_mut().find(|sub| sub.id == id)?;
        subscriber.busy = false;
        if !subscriber.active {
            return None;
        }
        let pending = subscriber.pending.take()?;
        subscriber.busy = true;
        Some((subscriber.id, pending))
    }

    /// A subscriber's send failed: it is gone, with whatever waited for it.
    pub fn failed(&mut self, id: u64) {
        self.subscribers.retain(|sub| sub.id != id);
    }

    /// Adds a subscriber, or says the log already serves as many as it can.
    pub fn subscribe(&mut self) -> Result<u64, SubscriberLimit> {
        if self.subscribers.len() >= SUBSCRIBER_LIMIT {
            return Err(SubscriberLimit);
        }
        self.next_subscriber += 1;
        let id = self.next_subscriber;
        self.subscribers.push(Subscriber {
            id,
            busy: false,
            pending: None,
            active: true,
        });
        Ok(id)
    }

    /// Removes a subscriber; a batch it was waiting on is dropped.
    pub fn unsubscribe(&mut self, id: u64) {
        self.subscribers.retain(|sub| sub.id != id);
    }

    /// The newest `limit` lines, clamped the way the TypeScript clamps them: at least one, at
    /// most 256, truncated, and no lines at all for a value that is not a number.
    pub fn tail(&self, limit: f64) -> Tailed {
        let limit = clamp_tail(limit);
        let start = self.ring.len().saturating_sub(limit);
        Tailed {
            lines: self.ring.range(start..).cloned().collect(),
            sequence: self.sequence,
        }
    }

    /// Forgets every line, batch and subscriber.
    pub fn close(&mut self) {
        self.ring.clear();
        self.batch = None;
        for subscriber in &mut self.subscribers {
            subscriber.active = false;
            subscriber.pending = None;
        }
        self.subscribers.clear();
    }
}

/// The clamp `tail` applies, as `Math.max(1, Math.min(256, Math.trunc(limit)))` gives it.
pub fn clamp_tail(limit: f64) -> usize {
    if limit.is_nan() {
        return 0;
    }
    limit.trunc().clamp(1.0, f64::from(TAIL_LIMIT)) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str) -> JsString {
        JsString::from(text)
    }

    fn texts(batch: &LogBatch) -> Vec<&str> {
        batch.lines.iter().map(JsString::as_str).collect()
    }

    #[test]
    fn the_ring_keeps_the_newest_256_lines() {
        let mut logs = Logs::new();
        for index in 0..1_000 {
            logs.push(line(&format!("log-{index}")));
        }
        let tailed = logs.tail(256.0);
        assert_eq!(tailed.lines.len(), 256);
        assert_eq!(tailed.lines.last().map(JsString::as_str), Some("log-999"));
        assert_eq!(tailed.lines.first().map(JsString::as_str), Some("log-744"));
        assert_eq!(tailed.sequence, 1_000);
    }

    #[test]
    fn a_busy_subscriber_gets_the_latest_64_lines_and_the_count_it_lost() {
        let mut logs = Logs::new();
        let id = logs.subscribe().expect("room");
        logs.push(line("first"));
        let first = logs
            .flush()
            .into_iter()
            .find(|(subscriber, _)| *subscriber == id)
            .expect("the first batch")
            .1;
        assert_eq!(texts(&first), vec!["first"]);
        for index in 0..1_000 {
            logs.push(line(&format!("line-{index}")));
        }
        assert!(logs.flush().is_empty(), "the subscriber is still busy");
        let waited = logs.delivered(id).expect("a waiting batch").1;
        assert_eq!(waited.lines.len(), 64);
        assert_eq!(waited.lines.last().map(JsString::as_str), Some("line-999"));
        assert_eq!(waited.dropped, 936);
    }

    #[test]
    fn a_waiting_batch_keeps_the_latest_64_lines() {
        let mut logs = Logs::new();
        let id = logs.subscribe().expect("room");
        logs.push(line("a"));
        assert_eq!(logs.flush().len(), 1);
        for index in 0..70 {
            logs.push(line(&format!("b{index}")));
        }
        logs.flush();
        let waited = logs.delivered(id).expect("the waiting batch").1;
        assert_eq!(waited.lines.len(), BATCH_LINES);
        assert_eq!(waited.dropped, 6);
    }

    #[test]
    fn the_open_batch_schedules_one_flush_and_a_new_one_after_it_was_taken() {
        let mut logs = Logs::new();
        assert!(logs.push(line("a")).schedule_flush);
        assert!(!logs.push(line("b")).schedule_flush);
        let _ = logs.flush();
        assert!(logs.push(line("c")).schedule_flush);
    }

    #[test]
    fn a_log_serves_at_most_64_subscribers() {
        let mut logs = Logs::new();
        for _ in 0..SUBSCRIBER_LIMIT {
            logs.subscribe().expect("room");
        }
        assert_eq!(logs.subscribe(), Err(SubscriberLimit));
        logs.close();
        logs.subscribe().expect("closed logs serve again");
    }

    #[test]
    fn an_unsubscribed_subscriber_is_not_sent_and_a_failed_one_is_forgotten() {
        let mut logs = Logs::new();
        let gone = logs.subscribe().expect("room");
        let failed = logs.subscribe().expect("room");
        logs.unsubscribe(gone);
        logs.push(line("a"));
        let deliveries = logs.flush();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].0, failed);
        logs.failed(failed);
        logs.push(line("b"));
        assert!(logs.flush().is_empty());
    }

    #[test]
    fn the_read_clamp_is_the_scripts_own() {
        assert_eq!(clamp_tail(f64::NAN), 0);
        assert_eq!(clamp_tail(-5.0), 1);
        assert_eq!(clamp_tail(0.9), 1);
        assert_eq!(clamp_tail(1.0), 1);
        assert_eq!(clamp_tail(256.7), 256);
        assert_eq!(clamp_tail(10_000.0), 256);
        assert_eq!(clamp_tail(f64::INFINITY), 256);
        assert_eq!(clamp_tail(f64::NEG_INFINITY), 1);
    }

    #[test]
    fn closing_forgets_every_line_and_subscriber() {
        let mut logs = Logs::new();
        logs.subscribe().expect("room");
        logs.push(line("a"));
        logs.close();
        assert!(logs.tail(256.0).lines.is_empty());
        let id = logs.subscribe().expect("room");
        assert!(logs.flush().is_empty());
        assert_eq!(logs.delivered(id), None);
    }
}
