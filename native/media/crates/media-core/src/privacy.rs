// SPDX-License-Identifier: Apache-2.0
//! The recording privacy barrier (docs/media/plan.md, "Recording privacy barrier").
//!
//! Frames and the daemon's epoch decisions reach ace-media on separate connections, in any
//! order. [`Barrier`] writes a frame only once its epoch is decided clear, applies decisions
//! strictly in `seq` order, holds undecided frames within a bound (overflow is a gap, never a
//! leak) and restarts a recording's video only at a keyframe of a clear epoch captured after
//! the last discarded one. [`ReadStamper`] is the stamping rule for producers that can only
//! stamp at read time. Nothing here reads a clock: callers pass their own monotonic
//! milliseconds, which only bound holding and never order anything.

use std::collections::{BTreeMap, VecDeque};

/// A per-source privacy epoch, as stamped in `MediaFrame` header offset 36.
pub type Epoch = u32;

/// How long and how much a barrier holds before it drops the oldest frames as a gap.
pub const HOLD_MS: u64 = 2_000;
pub const HOLD_BYTES: usize = 32 * 1024 * 1024;
/// Decisions ahead of a `seq` gap kept while waiting for it to fill.
pub const MAX_PENDING_DECISIONS: usize = 1_024;
/// Verdict ranges kept; past this the oldest are forgotten and their epochs refused.
pub const MAX_VERDICT_RANGES: usize = 4_096;
/// How long a read-time producer keeps stamping the private epoch after applying the next one.
pub const READ_GAP_MS: u64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Track {
    Video,
    Audio,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame<T> {
    pub track: Track,
    pub epoch: Epoch,
    pub keyframe: bool,
    pub bytes: usize,
    pub payload: T,
}

/// One `record.epochs` message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub seq: u64,
    pub decided: Epoch,
    pub clear: Vec<(Epoch, Epoch)>,
    pub discard: Vec<(Epoch, Epoch)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropReason {
    /// The frame's epoch was decided discarded (including epochs no clear range covered).
    Discarded,
    /// The frame's epoch is below one its track already passed, or below the barrier's start.
    Stale,
    /// The frame's epoch is above any the daemon issued to ace-media as producer.
    NotIssued,
    /// A video delta while the recording waits for a keyframe.
    AwaitingKeyframe,
    /// Audio while the video fragment hasn't started.
    AwaitingVideo,
    /// Held past [`Limits`].
    Overflow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event<T> {
    Write(Frame<T>),
    Drop(Frame<T>, DropReason),
    /// The recording lost frames it could have written: mark a gap.
    Gap,
    /// Ask the producer for a keyframe (`source.keyframe reason: "resume"`).
    Keyframe,
    /// A decision was applied (`epochs.applied`), with the frames it released.
    Applied {
        seq: u64,
        written: u64,
        dropped: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub hold_ms: u64,
    pub hold_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            hold_ms: HOLD_MS,
            hold_bytes: HOLD_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    Clear,
    Discard,
}

/// Decided epochs as sorted, disjoint, merged inclusive ranges (u64 so `to + 1` never wraps).
#[derive(Debug, Default)]
struct Verdicts {
    ranges: Vec<(u64, u64, Verdict)>,
}

impl Verdicts {
    fn set(&mut self, from: u64, to: u64, verdict: Verdict) {
        if from > to {
            return;
        }
        let mut out = Vec::with_capacity(self.ranges.len() + 2);
        for &(a, b, v) in &self.ranges {
            if b < from || a > to {
                out.push((a, b, v));
                continue;
            }
            if a < from {
                out.push((a, from - 1, v));
            }
            if b > to {
                out.push((to + 1, b, v));
            }
        }
        out.push((from, to, verdict));
        out.sort_unstable_by_key(|r| r.0);
        self.ranges.clear();
        for r in out {
            match self.ranges.last_mut() {
                Some(last) if last.2 == r.2 && last.1 + 1 == r.0 => last.1 = r.1,
                _ => self.ranges.push(r),
            }
        }
    }

    fn get(&self, epoch: u64) -> Option<Verdict> {
        let i = self.ranges.partition_point(|r| r.1 < epoch);
        self.ranges.get(i).filter(|r| r.0 <= epoch).map(|r| r.2)
    }

    fn discards_within(&self, from: u64, to: u64) -> bool {
        self.ranges
            .iter()
            .any(|&(a, b, v)| v == Verdict::Discard && a <= to && b >= from)
    }

    /// Forgets ranges wholly below `floor`, and the oldest past `cap`. Returns the first epoch
    /// still remembered when the cap forced out ranges that were still needed.
    fn prune(&mut self, floor: u64, cap: usize) -> Option<u64> {
        let unneeded = self.ranges.partition_point(|r| r.1 < floor);
        let excess = self.ranges.len().saturating_sub(cap);
        self.ranges.drain(..unneeded.max(excess));
        (excess > unneeded).then(|| self.ranges.first().map_or(u64::MAX, |r| r.0))
    }
}

/// Clip and merge ranges to `[lo, hi]`.
fn clipped(ranges: &[(Epoch, Epoch)], lo: u64, hi: u64) -> impl Iterator<Item = (u64, u64)> {
    ranges.iter().filter_map(move |&(a, b)| {
        let (a, b) = (u64::from(a).max(lo), u64::from(b).min(hi));
        (a <= b).then_some((a, b))
    })
}

#[derive(Debug)]
struct Lane<T> {
    held: VecDeque<(Frame<T>, u64)>,
    /// Highest epoch accepted on this track (held or processed); lower arrivals are stale.
    seen: u64,
    /// Highest epoch processed (written or dropped) on this track; one below the start before any.
    done: u64,
}

impl<T> Lane<T> {
    fn new(start: u64) -> Self {
        Self {
            held: VecDeque::new(),
            seen: start,
            done: start.saturating_sub(1),
        }
    }
}

/// The barrier for one recorded source. A new ace-media process starts a new barrier at the
/// source's reissued epoch with `seq` 0; frames held by the old one are lost as a gap.
#[derive(Debug)]
pub struct Barrier<T> {
    limits: Limits,
    next_seq: u64,
    pending: BTreeMap<u64, Decision>,
    /// Every epoch below this is decided.
    undecided: u64,
    /// Epochs below this are forgotten and refused.
    floor: u64,
    verdicts: Verdicts,
    /// Highest epoch issued to ace-media as the producer, for sources ace-media reads itself.
    ceiling: Option<u64>,
    video: Lane<T>,
    audio: Lane<T>,
    held_bytes: usize,
    started: bool,
    /// A pending keyframe request, satisfied by a keyframe written at or above this epoch.
    asked: Option<u64>,
    gap_marked: bool,
}

impl<T> Barrier<T> {
    /// A barrier whose first epoch is `start`: earlier epochs are refused as stale.
    pub fn new(start: Epoch, limits: Limits) -> Self {
        let start = u64::from(start);
        Self {
            limits,
            next_seq: 0,
            pending: BTreeMap::new(),
            undecided: start,
            floor: start,
            verdicts: Verdicts::default(),
            ceiling: None,
            video: Lane::new(start),
            audio: Lane::new(start),
            held_bytes: 0,
            started: false,
            asked: None,
            gap_marked: false,
        }
    }

    /// For sources ace-media reads itself: the daemon issued `epoch` (`source.epoch`). Once
    /// called, frames above the highest issued epoch are dropped.
    pub fn issued(&mut self, epoch: Epoch) {
        let e = u64::from(epoch);
        self.ceiling = Some(self.ceiling.map_or(e, |c| c.max(e)));
    }

    /// The ingest stream was interrupted (a producer reconnect, a lost read): the recording
    /// marks a gap and restarts at a keyframe.
    pub fn interrupt(&mut self, out: &mut Vec<Event<T>>) {
        self.mark_gap(out);
        let seen = self.video.seen;
        self.require_keyframe(seen, out);
    }

    /// A frame arrived from the producer at `now` on the caller's monotonic clock.
    pub fn frame(&mut self, frame: Frame<T>, now: u64, out: &mut Vec<Event<T>>) {
        let epoch = u64::from(frame.epoch);
        if self.ceiling.is_some_and(|c| epoch > c) {
            out.push(Event::Drop(frame, DropReason::NotIssued));
            return;
        }
        let floor = self.floor;
        let lane = self.lane(frame.track);
        if epoch < lane.seen || epoch < floor {
            out.push(Event::Drop(frame, DropReason::Stale));
            return;
        }
        lane.seen = epoch;
        if epoch < self.undecided {
            // The lane's queue is empty: anything held is above `undecided`, and so above this.
            let mut tally = (0, 0);
            self.process(frame, out, &mut tally);
        } else {
            self.held_bytes += frame.bytes;
            self.lane(frame.track).held.push_back((frame, now));
            self.enforce(now, out);
        }
        self.prune();
    }

    /// Time passed with nothing arriving: drop frames held past the age bound.
    pub fn tick(&mut self, now: u64, out: &mut Vec<Event<T>>) {
        self.enforce(now, out);
    }

    /// A `record.epochs` message. Applied strictly in `seq` order; early ones wait for the gap
    /// to fill, and ones at or behind the next expected `seq` are ignored. Past
    /// [`MAX_PENDING_DECISIONS`] early ones are refused, which can only stall the recording
    /// into a gap, never release a frame.
    pub fn decide(&mut self, decision: Decision, out: &mut Vec<Event<T>>) {
        if decision.seq < self.next_seq {
            return;
        }
        if decision.seq > self.next_seq {
            if self.pending.len() < MAX_PENDING_DECISIONS {
                self.pending.entry(decision.seq).or_insert(decision);
            }
            return;
        }
        self.apply(decision, out);
        while let Some(next) = self.pending.remove(&self.next_seq) {
            self.apply(next, out);
        }
        self.prune();
    }

    /// Frames currently held, awaiting a decision.
    pub fn held(&self) -> usize {
        self.video.held.len() + self.audio.held.len()
    }

    fn apply(&mut self, d: Decision, out: &mut Vec<Event<T>>) {
        self.next_seq = d.seq + 1;
        let decided = u64::from(d.decided);
        let first_new = self.undecided;
        if decided >= first_new {
            self.verdicts.set(first_new, decided, Verdict::Discard);
            for (a, b) in clipped(&d.clear, first_new, decided) {
                self.verdicts.set(a, b, Verdict::Clear);
            }
            self.undecided = decided + 1;
        }
        let top = self.undecided.saturating_sub(1);
        for (a, b) in clipped(&d.discard, self.floor, top) {
            self.verdicts.set(a, b, Verdict::Discard);
        }
        // Video will have to restart past a discard it hasn't reached: ask now, so the
        // keyframe is on its way. Frames before the discard still write in the old fragment.
        if self.verdicts.discards_within(self.video.done + 1, top) {
            self.ask(top + 1, out);
        }
        let mut tally = (0, 0);
        self.release(Track::Video, out, &mut tally);
        self.release(Track::Audio, out, &mut tally);
        out.push(Event::Applied {
            seq: d.seq,
            written: tally.0,
            dropped: tally.1,
        });
    }

    fn release(&mut self, track: Track, out: &mut Vec<Event<T>>, tally: &mut (u64, u64)) {
        let undecided = self.undecided;
        loop {
            let lane = self.lane(track);
            match lane.held.front() {
                Some((f, _)) if u64::from(f.epoch) < undecided => {}
                _ => return,
            }
            let Some((frame, _)) = lane.held.pop_front() else {
                return;
            };
            self.held_bytes -= frame.bytes;
            self.process(frame, out, tally);
        }
    }

    /// Writes or drops a frame whose epoch is decided.
    fn process(&mut self, frame: Frame<T>, out: &mut Vec<Event<T>>, tally: &mut (u64, u64)) {
        let epoch = u64::from(frame.epoch);
        let done = self.lane(frame.track).done;
        let crossed = epoch > done && self.verdicts.discards_within(done + 1, epoch);
        let lane = self.lane(frame.track);
        lane.done = lane.done.max(epoch);
        let verdict = if epoch < self.floor {
            None
        } else {
            self.verdicts.get(epoch)
        };
        if verdict != Some(Verdict::Clear) {
            if frame.track == Track::Video {
                self.require_keyframe(epoch + 1, out);
            }
            tally.1 += 1;
            out.push(Event::Drop(frame, DropReason::Discarded));
            return;
        }
        match frame.track {
            Track::Video => {
                if crossed {
                    self.require_keyframe(epoch, out);
                }
                if frame.keyframe && self.asked.is_some_and(|at| epoch >= at) {
                    self.asked = None;
                }
                if self.started || frame.keyframe {
                    if !self.started {
                        self.started = true;
                        self.gap_marked = false;
                    }
                    tally.0 += 1;
                    out.push(Event::Write(frame));
                } else {
                    self.ask(epoch, out);
                    tally.1 += 1;
                    out.push(Event::Drop(frame, DropReason::AwaitingKeyframe));
                }
            }
            Track::Audio => {
                if self.started {
                    tally.0 += 1;
                    out.push(Event::Write(frame));
                } else {
                    tally.1 += 1;
                    out.push(Event::Drop(frame, DropReason::AwaitingVideo));
                }
            }
        }
    }

    fn enforce(&mut self, now: u64, out: &mut Vec<Event<T>>) {
        loop {
            let over_bytes = self.held_bytes > self.limits.hold_bytes;
            let oldest = match (self.video.held.front(), self.audio.held.front()) {
                (Some(v), Some(a)) if a.1 < v.1 => Track::Audio,
                (Some(_), _) => Track::Video,
                (None, Some(_)) => Track::Audio,
                (None, None) => return,
            };
            let hold_ms = self.limits.hold_ms;
            let aged = self
                .lane(oldest)
                .held
                .front()
                .is_some_and(|(_, at)| now.saturating_sub(*at) > hold_ms);
            if !over_bytes && !aged {
                return;
            }
            let Some((frame, _)) = self.lane(oldest).held.pop_front() else {
                return;
            };
            self.held_bytes -= frame.bytes;
            out.push(Event::Drop(frame, DropReason::Overflow));
            self.mark_gap(out);
            let seen = self.video.seen;
            self.require_keyframe(seen, out);
        }
    }

    fn mark_gap(&mut self, out: &mut Vec<Event<T>>) {
        if !self.gap_marked {
            self.gap_marked = true;
            out.push(Event::Gap);
        }
    }

    /// The next video written must be a keyframe at or above `at`.
    fn require_keyframe(&mut self, at: u64, out: &mut Vec<Event<T>>) {
        self.started = false;
        self.ask(at, out);
    }

    /// Asks the producer for a keyframe unless a request is still pending; a pending one is
    /// only satisfied by a keyframe at or above every epoch it was raised for.
    fn ask(&mut self, at: u64, out: &mut Vec<Event<T>>) {
        match &mut self.asked {
            Some(pending) => *pending = (*pending).max(at),
            None => {
                self.asked = Some(at);
                out.push(Event::Keyframe);
            }
        }
    }

    fn prune(&mut self) {
        let mut floor = self.video.done.min(self.audio.done);
        for lane in [&self.video, &self.audio] {
            if let Some((f, _)) = lane.held.front() {
                floor = floor.min(u64::from(f.epoch));
            }
        }
        if let Some(forgotten) = self.verdicts.prune(floor, MAX_VERDICT_RANGES) {
            self.floor = self.floor.max(forgotten);
        }
    }

    fn lane(&mut self, track: Track) -> &mut Lane<T> {
        match track {
            Track::Video => &mut self.video,
            Track::Audio => &mut self.audio,
        }
    }
}

/// The stamping rule for producers that only learn a frame's time when they read it (the
/// offscreen document, the encoder page, ace-media's own reads).
///
/// After applying an epoch that follows a private one, frames read less than
/// [`READ_GAP_MS`] later still get the private epoch: the capture queue may hold pictures
/// captured while private. Later applies don't shorten that window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadStamper {
    current: Epoch,
    /// The latest private epoch and when frames may stop carrying it.
    hold: Option<(Epoch, u64)>,
}

impl ReadStamper {
    pub fn new(epoch: Epoch) -> Self {
        Self {
            current: epoch,
            hold: None,
        }
    }

    /// Apply `epoch` at `now`; `follows_private` says the epoch it replaces was private.
    pub fn apply(&mut self, epoch: Epoch, follows_private: bool, now: u64) {
        if follows_private {
            self.hold = Some((self.current, now.saturating_add(READ_GAP_MS)));
        }
        self.current = epoch;
    }

    /// The epoch for a frame read at `now`.
    pub fn stamp(&self, now: u64) -> Epoch {
        match self.hold {
            Some((private, until)) if now < until => private,
            _ => self.current,
        }
    }
}
