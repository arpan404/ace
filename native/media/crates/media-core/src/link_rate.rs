// SPDX-License-Identifier: Apache-2.0
//! Delay-based rate estimation that tolerates loss, matching link-rate.ts. No clock reads.
//!
//! Each chunk's round trip, net of its own send time at the current rate, against the lowest
//! seen lately: queueing that lasts cuts the rate, a calm link lets it climb once a round trip.
//! A jump of a retransmit timeout out of a calm link is a loss stall: it and the chunks held
//! behind it say nothing about queueing (ADR 0149).
use std::collections::VecDeque;
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub min: f64,
    pub max: f64,
    pub initial: f64,
}
/// The lowest rate any link is driven at: a 3G link at its worst still carries this.
pub const LINK_FLOOR: f64 = 150_000.0;
impl Default for Limits {
    fn default() -> Self {
        Self {
            min: LINK_FLOOR,
            max: 16_000_000.0,
            initial: 1_500_000.0,
        }
    }
}
/// What a client says about its link (ADR 0149 §4, K3), already parsed: it only lowers the start.
#[derive(Clone, Debug, Default)]
pub struct LinkHint {
    pub effective_type: Option<String>,
    pub downlink_kbps: Option<f64>,
    pub rtt_ms: Option<f64>,
    pub save_data: bool,
    pub expensive: bool,
    pub constrained: bool,
}
/// Sends awaiting an ack that are remembered; past this the oldest is forgotten. A viewer's
/// window holds 60, and even an unwindowed sender on a link that just slowed stays near 300,
/// so this only bounds memory when acks stop coming. Reserved up front: no growth.
pub const OUTSTANDING_SENDS: usize = 512;
/// Bytes in flight may hold the link's rate for its round trip plus this long, no more.
pub const BACKLOG_MS: f64 = 300.0;
const FLOOR_WINDOW_MS: f64 = 10_000.0;
const DELIVERY_WINDOW_MS: f64 = 1_000.0;
const CUT_WINDOW_MS: f64 = 2_000.0;
const STEP_MS: f64 = 200.0;
const QUEUED_MS: f64 = 80.0;
const CALM_MS: f64 = 30.0;
const PERSIST_MS: f64 = 400.0;
const STALL_MS: f64 = 200.0;
const STALL_GAP_MS: f64 = 2_000.0;

/// Where a viewer's rate starts, from what its client says about its link, matching
/// link-start.ts (K3): never above `limits.initial`, never below `limits.min`. The hint was
/// parsed (and clamped) at the boundary.
pub fn hinted_start(limits: Limits, hint: Option<&LinkHint>) -> f64 {
    let Some(hint) = hint else {
        return limits.initial.round();
    };
    if hint.save_data || hint.constrained {
        return limits.min.round();
    }
    let kind = hint.effective_type.as_deref().map(str::to_ascii_lowercase);
    if matches!(kind.as_deref(), Some("slow-2g" | "2g")) {
        return limits.min.round();
    }
    let mut start = limits.initial;
    if kind.as_deref() == Some("3g") {
        start = start.min(500_000.0);
    }
    if hint.rtt_ms.is_some_and(|r| r >= 300.0) {
        start = start.min(500_000.0);
    }
    if hint.expensive {
        start = start.min(1_000_000.0);
    }
    if let Some(kbps) = hint.downlink_kbps {
        start = start.min(kbps * 1_000.0 * 0.5);
    }
    start.min(limits.initial).max(limits.min).round()
}
#[derive(Debug)]
struct Sent {
    sequence: u64,
    bytes: usize,
    at: f64,
}
#[derive(Debug)]
pub struct LinkRate {
    limits: Limits,
    start: f64,
    hinted: bool,
    rate: f64,
    inflight: VecDeque<Sent>,
    floor: VecDeque<(f64, f64)>,
    smoothed: Option<f64>,
    /// One entry per ack: (time, bytes). `recent` indexes the oldest inside the delivery window.
    delivered: VecDeque<(f64, usize)>,
    recent: usize,
    delivered_bytes: usize,
    cut_bytes: usize,
    proven: VecDeque<(f64, f64)>,
    last_step: f64,
    last_rise: f64,
    hold_until: f64,
    drop_hold_until: f64,
    dropped: bool,
    starting: bool,
    queued_since: Option<f64>,
    stall_sent_before: f64,
    stall_until: f64,
    last_stall: f64,
}
impl LinkRate {
    pub fn new(limits: Limits) -> Self {
        Self::with_hint(limits, None)
    }
    pub fn with_hint(limits: Limits, hint: Option<&LinkHint>) -> Self {
        let start = hinted_start(limits, hint);
        Self {
            limits,
            start,
            hinted: start < limits.initial,
            rate: start,
            inflight: VecDeque::with_capacity(OUTSTANDING_SENDS),
            floor: VecDeque::with_capacity(1024),
            smoothed: None,
            delivered: VecDeque::with_capacity(256),
            recent: 0,
            delivered_bytes: 0,
            cut_bytes: 0,
            proven: VecDeque::with_capacity(256),
            last_step: f64::NEG_INFINITY,
            last_rise: f64::NEG_INFINITY,
            hold_until: f64::NEG_INFINITY,
            drop_hold_until: f64::NEG_INFINITY,
            dropped: false,
            starting: true,
            queued_since: None,
            stall_sent_before: f64::NEG_INFINITY,
            stall_until: f64::NEG_INFINITY,
            last_stall: f64::NEG_INFINITY,
        }
    }
    pub fn rate(&self) -> f64 {
        self.rate
    }
    pub fn rtt(&self) -> Option<f64> {
        self.smoothed
    }
    /// Still probing up from a guessed start; a start the client's hint lowered is no guess.
    pub fn probing(&self) -> bool {
        self.starting && !self.hinted
    }
    /// The most bytes a viewer should have in flight; unbounded until a round trip is known.
    pub fn backlog_bytes(&self) -> Option<usize> {
        self.smoothed
            .map(|rtt| ((self.rate / 8.0) * ((rtt + BACKLOG_MS) / 1000.0)).round() as usize)
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
                newest = Some((c.at, c.bytes));
            }
        }
        let Some((sent_at, own_bytes)) = newest else {
            return;
        };
        // One entry per ack (they share its time), so a large cumulative ack never grows this.
        self.delivered.push_back((at, bytes));
        self.delivered_bytes = self.delivered_bytes.saturating_add(bytes);
        self.cut_bytes = self.cut_bytes.saturating_add(bytes);
        // Own send time only takes away queueing: never below the floor (see link-rate.ts).
        let rtt = at - sent_at;
        let own = own_bytes as f64 * 8000.0 / self.rate;
        let floor = self.floor.front().map_or(rtt, |c| c.1);
        self.sample(rtt.min(floor.max(rtt - own)).max(0.0), sent_at, at);
        self.step(at, false);
    }
    /// A chunk didn't fit the viewer's window. One cut a round trip; none during a stall.
    pub fn dropped(&mut self, at: f64) {
        if at < self.drop_hold_until || at <= self.stall_until {
            return;
        }
        if let Some(age) = self.inflight.front().map(|c| at - c.at) {
            if self.stalls(age, at, false) {
                let floor = self.floor.front().map_or(0.0, |c| c.1);
                self.stalled(at, STALL_MS.max(floor));
                return;
            }
        }
        // A drop on a calm link is a chunk too big for the time bound, not a slow link.
        if let Some(floor) = self.floor.front().map(|c| c.1) {
            if self.smoothed.unwrap_or(floor) - floor < QUEUED_MS {
                return;
            }
        }
        self.dropped = true;
        self.step(at, true);
        self.drop_hold_until = at + self.smoothed.unwrap_or(0.0) + STEP_MS;
    }
    fn stalls(&self, rtt: f64, at: f64, calm: bool) -> bool {
        let (Some(floor), Some(smoothed)) = (self.floor.front().map(|c| c.1), self.smoothed) else {
            return false;
        };
        rtt - smoothed >= STALL_MS.max(floor / 2.0)
            && (!calm || smoothed - floor < QUEUED_MS)
            && at - self.last_stall >= STALL_GAP_MS
    }
    fn stalled(&mut self, at: f64, length: f64) {
        self.last_stall = at;
        self.stall_sent_before = at;
        self.stall_until = at + length;
        self.hold_until = self.hold_until.max(at + length);
    }
    fn sample(&mut self, rtt: f64, sent_at: f64, at: f64) {
        if sent_at < self.stall_sent_before && at <= self.stall_until {
            return;
        }
        if self.stalls(rtt, at, true) {
            self.stalled(at, rtt - self.smoothed.unwrap_or(0.0));
            return;
        }
        let value = self.smoothed.map_or(rtt, |v| v * 0.875 + rtt * 0.125);
        self.smoothed = Some(value);
        while self.floor.back().is_some_and(|c| c.1 >= value) {
            self.floor.pop_back();
        }
        self.floor.push_back((at, value));
        while self.floor.len() > 1
            && self
                .floor
                .front()
                .is_some_and(|c| c.0 < at - FLOOR_WINDOW_MS)
        {
            self.floor.pop_front();
        }
    }
    /// Bits per second delivered over the delivery window, and over the longer cut window.
    fn delivery_rate(&mut self, at: f64) -> (f64, f64) {
        while let Some(&(when, bytes)) = self.delivered.get(self.recent) {
            if when >= at - DELIVERY_WINDOW_MS {
                break;
            }
            self.delivered_bytes = self.delivered_bytes.saturating_sub(bytes);
            self.recent += 1;
        }
        while self.recent > 0
            && self
                .delivered
                .front()
                .is_some_and(|c| c.0 < at - CUT_WINDOW_MS)
        {
            if let Some(c) = self.delivered.pop_front() {
                self.cut_bytes = self.cut_bytes.saturating_sub(c.1);
            }
            self.recent -= 1;
        }
        (
            self.delivered_bytes as f64 * 8.0 * 1000.0 / DELIVERY_WINDOW_MS,
            self.cut_bytes as f64 * 8.0 * 1000.0 / CUT_WINDOW_MS,
        )
    }
    fn step(&mut self, at: f64, now: bool) {
        if !now && at - self.last_step < STEP_MS {
            return;
        }
        self.last_step = at;
        let (delivered, longer) = self.delivery_rate(at);
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
        if queueing > QUEUED_MS {
            self.queued_since.get_or_insert(at);
        } else {
            self.queued_since = None;
        }
        let mut rate = self.rate;
        let cut = if self.dropped {
            Some(rate.min(if delivered == 0.0 { rate } else { delivered }) * 0.6)
        } else if let Some(since) = self.queued_since {
            (at >= self.hold_until && at - since >= PERSIST_MS)
                .then(|| rate.min(delivered.max(longer)) * 0.9)
        } else {
            None
        };
        if let Some(to) = cut {
            self.starting = false;
            rate = (rate * 0.6).max(rate.min(to));
            self.hold_until = at + self.smoothed.unwrap_or(0.0) + STEP_MS;
            self.queued_since = None;
        } else if self.queued_since.is_none()
            && queueing < CALM_MS
            && at >= self.hold_until
            && at - self.last_rise >= self.smoothed.unwrap_or(0.0)
        {
            self.last_rise = at;
            rate = rate.max(
                (rate * if self.starting { 1.25 } else { 1.08 }).min(self.start.max(proven * 1.3)),
            );
        }
        self.dropped = false;
        self.rate = rate.clamp(self.limits.min, self.limits.max).round();
    }
}
