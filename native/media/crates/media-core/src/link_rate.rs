// SPDX-License-Identifier: Apache-2.0
//! Delay-based rate estimation, matching link-rate.ts. No clock reads.
use std::collections::VecDeque;
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub min: f64,
    pub max: f64,
    pub initial: f64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            min: 500_000.0,
            max: 16_000_000.0,
            initial: 1_500_000.0,
        }
    }
}
/// Sends awaiting an ack that are remembered; past this the oldest is forgotten. A viewer's
/// window holds 60, and even an unwindowed sender on a link that just slowed stays near 300,
/// so this only bounds memory when acks stop coming. Reserved up front: no growth.
pub const OUTSTANDING_SENDS: usize = 512;
#[derive(Debug)]
struct Sent {
    sequence: u64,
    bytes: usize,
    at: f64,
}
#[derive(Debug)]
pub struct LinkRate {
    limits: Limits,
    rate: f64,
    inflight: VecDeque<Sent>,
    floor: VecDeque<(f64, f64)>,
    smoothed: Option<f64>,
    delivered: VecDeque<(f64, usize)>,
    delivered_bytes: usize,
    proven: VecDeque<(f64, f64)>,
    last_step: f64,
    hold_until: f64,
    starting: bool,
}
impl LinkRate {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            rate: limits.initial,
            inflight: VecDeque::with_capacity(OUTSTANDING_SENDS),
            floor: VecDeque::with_capacity(1024),
            smoothed: None,
            delivered: VecDeque::with_capacity(128),
            delivered_bytes: 0,
            proven: VecDeque::with_capacity(256),
            last_step: f64::NEG_INFINITY,
            hold_until: f64::NEG_INFINITY,
            starting: true,
        }
    }
    pub fn rate(&self) -> f64 {
        self.rate
    }
    pub fn rtt(&self) -> Option<f64> {
        self.smoothed
    }
    pub fn sent(&mut self, sequence: u64, bytes: usize, at: f64) {
        if self.inflight.len() >= OUTSTANDING_SENDS {
            self.inflight.pop_front();
        }
        self.inflight.push_back(Sent {
            sequence,
            bytes,
            at,
        });
    }
    pub fn reset(&mut self) {
        self.inflight.clear();
    }
    pub fn acknowledged(&mut self, sequence: u64, at: f64) {
        let mut newest = None;
        let mut bytes = 0_usize;
        while self
            .inflight
            .front()
            .is_some_and(|c| c.sequence <= sequence)
        {
            if let Some(c) = self.inflight.pop_front() {
                // Saturates rather than wraps on absurd sizes; the rate is clamped anyway.
                bytes = bytes.saturating_add(c.bytes);
                newest = Some(c.at);
            }
        }
        let Some(sent_at) = newest else {
            return;
        };
        // One entry per ack (they share its time), so a large cumulative ack never grows this.
        self.delivered.push_back((at, bytes));
        self.delivered_bytes = self.delivered_bytes.saturating_add(bytes);
        let sample = (at - sent_at).max(0.0);
        let value = self.smoothed.map_or(sample, |v| v * 0.875 + sample * 0.125);
        self.smoothed = Some(value);
        while self.floor.back().is_some_and(|c| c.1 >= value) {
            self.floor.pop_back();
        }
        self.floor.push_back((at, value));
        while self.floor.len() > 1 && self.floor.front().is_some_and(|c| c.0 < at - 10_000.0) {
            self.floor.pop_front();
        }
        if at - self.last_step >= 200.0 {
            self.step(at, false);
        }
    }
    pub fn dropped(&mut self, at: f64) {
        self.step(at, true);
    }
    fn step(&mut self, at: f64, dropped: bool) {
        self.last_step = at;
        while self.delivered.front().is_some_and(|c| c.0 < at - 1000.0) {
            if let Some(c) = self.delivered.pop_front() {
                self.delivered_bytes = self.delivered_bytes.saturating_sub(c.1);
            }
        }
        let delivered = self.delivered_bytes as f64 * 8.0;
        let floor = self.floor.front().map_or(0.0, |c| c.1);
        let queueing = self.smoothed.unwrap_or(floor) - floor;
        while self.proven.front().is_some_and(|c| c.0 < at - 30_000.0) {
            self.proven.pop_front();
        }
        while self.proven.back().is_some_and(|c| c.1 <= delivered) {
            self.proven.pop_back();
        }
        self.proven.push_back((at, delivered));
        let proven = self.proven.front().map_or(delivered, |c| c.1);
        let cut = if dropped {
            Some(
                self.rate.min(if delivered == 0.0 {
                    self.rate
                } else {
                    delivered
                }) * 0.6,
            )
        } else if queueing > 80.0 && at >= self.hold_until {
            Some(delivered * 0.9)
        } else {
            None
        };
        if let Some(to) = cut {
            self.starting = false;
            self.rate = (self.rate * 0.6).max(self.rate.min(to));
            self.hold_until = at + self.smoothed.unwrap_or(0.0) + 200.0;
        } else if queueing < 30.0 && at >= self.hold_until {
            self.rate = self.rate.max(
                (self.rate * if self.starting { 1.25 } else { 1.08 })
                    .min(self.limits.initial.max(proven * 1.3)),
            );
        }
        self.rate = self.rate.clamp(self.limits.min, self.limits.max).round();
    }
}
