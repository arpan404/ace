// SPDX-License-Identifier: Apache-2.0
//! The recording privacy barrier (docs/media/plan.md, "Recording privacy barrier").
//!
//! Frames and the daemon's epoch decisions reach ace-media on separate connections, in any
//! order. [`Barrier`] writes a frame only once its epoch is decided clear, applies decisions
//! strictly in `seq` order, holds undecided frames within a bound (overflow is a gap, never a
//! leak) and keeps every written frame inside a fragment that starts at a video keyframe:
//! a fragment ends at a discarded epoch, an interruption or an overflow, and the next starts
//! only at a keyframe of a clear epoch that arrived after the break. Audio is written only
//! into such a fragment. [`ReadStamper`] is the stamping rule for producers that can only
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
    /// Video that no running fragment holds and that can't start one: a delta, or a keyframe
    /// that arrived before the last break.
    AwaitingKeyframe,
    /// Audio that no fragment holds once video has passed it.
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
struct Held<T> {
    frame: Frame<T>,
    /// When it arrived, on the caller's clock: only for the age bound.
    at: u64,
    /// Arrival order across both tracks.
    index: u64,
}

#[derive(Debug)]
struct Lane<T> {
    held: VecDeque<Held<T>>,
    /// Highest epoch accepted on this track (held or processed); lower arrivals are stale.
    seen: u64,
    /// Highest epoch processed (written or dropped) on this track; one below the start before any.
    done: u64,
    /// Arrival index of the last frame processed on this track.
    last_index: Option<u64>,
}

impl<T> Lane<T> {
    fn new(start: u64) -> Self {
        Self {
            held: VecDeque::new(),
            seen: start,
            done: start.saturating_sub(1),
            last_index: None,
        }
    }
}

/// The running fragment: where its video keyframe was. A frame of either track belongs to it
/// while no discarded epoch lies between the keyframe's epoch and the frame's, and no break
/// (an interruption or an overflow) lies between them in arrival order.
#[derive(Clone, Copy, Debug)]
struct Fragment {
    epoch: u64,
    index: u64,
}

/// The barrier for one recorded source. A new ace-media process starts a new barrier at the
/// source's reissued epoch with `seq` 0; frames held by the old one are lost as a gap.
///
/// Every input takes `now`, the caller's monotonic milliseconds, and enforces the hold bounds
/// before anything is released, so a frame held past them is a gap however late its decision.
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
    next_index: u64,
    /// Breaks in arrival order: a break `m` separates indices below `m` from those at or above.
    breaks: VecDeque<u64>,
    /// A fragment may only start at a keyframe arriving at or after this index: the last break.
    restart_index: u64,
    fragment: Option<Fragment>,
    /// A pending keyframe request: the arrival index when it was asked and the lowest epoch that
    /// answers it. Only a fragment starting at a keyframe that arrived since, at or above that
    /// epoch, satisfies it. Advisory; it never decides what's written.
    asked: Option<(u64, u64)>,
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
            next_index: 0,
            breaks: VecDeque::new(),
            restart_index: 0,
            fragment: None,
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

    /// The ingest stream was interrupted (a producer reconnect, a lost read). Frames that
    /// arrived before still drain into the running fragment; nothing after joins it, and the
    /// next fragment starts only at a keyframe that arrives from now on.
    pub fn interrupt(&mut self, now: u64, out: &mut Vec<Event<T>>) {
        self.enforce(now, out);
        self.add_break(self.next_index, out);
        self.pump(out, &mut (0, 0));
        self.prune();
    }

    /// A frame arrived from the producer.
    pub fn frame(&mut self, frame: Frame<T>, now: u64, out: &mut Vec<Event<T>>) {
        self.enforce(now, out);
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
        let index = self.next_index;
        self.next_index += 1;
        self.held_bytes += frame.bytes;
        let track = frame.track;
        self.lane(track).held.push_back(Held {
            frame,
            at: now,
            index,
        });
        self.enforce(now, out);
        self.pump(out, &mut (0, 0));
        self.prune();
    }

    /// Time passed with nothing arriving: drop frames held past the age bound.
    pub fn tick(&mut self, now: u64, out: &mut Vec<Event<T>>) {
        self.enforce(now, out);
        self.pump(out, &mut (0, 0));
        self.prune();
    }

    /// A `record.epochs` message. Applied strictly in `seq` order; early ones wait for the gap
    /// to fill, and ones at or behind the next expected `seq` are ignored. Past
    /// [`MAX_PENDING_DECISIONS`] early ones are refused, which can only stall the recording
    /// into a gap, never release a frame.
    pub fn decide(&mut self, decision: Decision, now: u64, out: &mut Vec<Event<T>>) {
        self.enforce(now, out);
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

    /// Frames currently held: undecided, or audio waiting for its video fragment.
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
        self.pump(out, &mut tally);
        out.push(Event::Applied {
            seq: d.seq,
            written: tally.0,
            dropped: tally.1,
        });
    }

    /// Releases held frames in arrival order across both tracks: video once its epoch is
    /// decided, audio once it is also known whether a fragment holds it.
    fn pump(&mut self, out: &mut Vec<Event<T>>, tally: &mut (u64, u64)) {
        loop {
            let video = self
                .video
                .held
                .front()
                .filter(|h| u64::from(h.frame.epoch) < self.undecided)
                .map(|h| h.index);
            let audio = self
                .audio
                .held
                .front()
                .filter(|h| self.audio_ready(h))
                .map(|h| h.index);
            let track = match (video, audio) {
                (Some(v), Some(a)) if a < v => Track::Audio,
                (Some(_), _) => Track::Video,
                (None, Some(_)) => Track::Audio,
                (None, None) => return,
            };
            let Some(held) = self.lane(track).held.pop_front() else {
                return;
            };
            self.held_bytes -= held.frame.bytes;
            match track {
                Track::Video => self.process_video(held, out, tally),
                Track::Audio => self.process_audio(held, out, tally),
            }
        }
    }

    fn verdict(&self, epoch: u64) -> Option<Verdict> {
        if epoch < self.floor || epoch >= self.undecided {
            None
        } else {
            self.verdicts.get(epoch)
        }
    }

    fn belongs(&self, epoch: u64, index: u64) -> bool {
        self.fragment.is_some_and(|f| {
            let (lo, hi) = (index.min(f.index), index.max(f.index));
            epoch >= f.epoch
                && !self.verdicts.discards_within(f.epoch, epoch)
                && !self.breaks.iter().any(|&m| lo < m && m <= hi)
        })
    }

    /// Whether held audio can be written or dropped now. Audio that the running fragment can't
    /// hold waits for video to start one that can, until video has passed it.
    fn audio_ready(&self, held: &Held<T>) -> bool {
        let epoch = u64::from(held.frame.epoch);
        if epoch >= self.undecided {
            return false;
        }
        self.verdict(epoch) != Some(Verdict::Clear)
            || self.belongs(epoch, held.index)
            || self.fragment.is_some_and(|f| epoch < f.epoch)
            || self.video.last_index.is_some_and(|v| v > held.index)
    }

    fn process_video(&mut self, held: Held<T>, out: &mut Vec<Event<T>>, tally: &mut (u64, u64)) {
        let Held { frame, index, .. } = held;
        let epoch = u64::from(frame.epoch);
        self.video.done = self.video.done.max(epoch);
        self.video.last_index = Some(index);
        if self.verdict(epoch) != Some(Verdict::Clear) {
            self.fragment = None;
            self.ask(0, out);
            tally.1 += 1;
            out.push(Event::Drop(frame, DropReason::Discarded));
            return;
        }
        if self.belongs(epoch, index) {
            tally.0 += 1;
            out.push(Event::Write(frame));
            return;
        }
        if frame.keyframe && index >= self.restart_index {
            self.fragment = Some(Fragment { epoch, index });
            self.gap_marked = false;
            if self
                .asked
                .is_some_and(|(at, from)| index >= at && epoch >= from)
            {
                self.asked = None;
            }
            tally.0 += 1;
            out.push(Event::Write(frame));
            return;
        }
        self.fragment = None;
        self.ask(0, out);
        tally.1 += 1;
        out.push(Event::Drop(frame, DropReason::AwaitingKeyframe));
    }

    fn process_audio(&mut self, held: Held<T>, out: &mut Vec<Event<T>>, tally: &mut (u64, u64)) {
        let Held { frame, index, .. } = held;
        let epoch = u64::from(frame.epoch);
        self.audio.done = self.audio.done.max(epoch);
        self.audio.last_index = Some(index);
        let reason = if self.verdict(epoch) != Some(Verdict::Clear) {
            DropReason::Discarded
        } else if self.belongs(epoch, index) {
            tally.0 += 1;
            out.push(Event::Write(frame));
            return;
        } else {
            DropReason::AwaitingVideo
        };
        tally.1 += 1;
        out.push(Event::Drop(frame, reason));
    }

    fn enforce(&mut self, now: u64, out: &mut Vec<Event<T>>) {
        loop {
            let oldest = match (self.video.held.front(), self.audio.held.front()) {
                (Some(v), Some(a)) if a.index < v.index => Track::Audio,
                (Some(_), _) => Track::Video,
                (None, Some(_)) => Track::Audio,
                (None, None) => return,
            };
            let hold_ms = self.limits.hold_ms;
            let over_bytes = self.held_bytes > self.limits.hold_bytes;
            let aged = self
                .lane(oldest)
                .held
                .front()
                .is_some_and(|h| now.saturating_sub(h.at) > hold_ms);
            if !over_bytes && !aged {
                return;
            }
            let Some(held) = self.lane(oldest).held.pop_front() else {
                return;
            };
            self.held_bytes -= held.frame.bytes;
            out.push(Event::Drop(held.frame, DropReason::Overflow));
            self.add_break(held.index + 1, out);
        }
    }

    /// Frames arriving from `index` on can't join the running fragment, and the next one starts
    /// only at a keyframe among them.
    fn add_break(&mut self, index: u64, out: &mut Vec<Event<T>>) {
        if self.breaks.back() != Some(&index) {
            self.breaks.push_back(index);
        }
        self.restart_index = self.restart_index.max(index);
        if !self.gap_marked {
            self.gap_marked = true;
            out.push(Event::Gap);
        }
        self.ask(0, out);
    }

    /// Asks the producer for a keyframe at or above epoch `from`, unless a request is still
    /// pending; a pending one is widened to `from`.
    fn ask(&mut self, from: u64, out: &mut Vec<Event<T>>) {
        match &mut self.asked {
            Some((_, pending)) => *pending = (*pending).max(from),
            None => {
                self.asked = Some((self.next_index, from));
                out.push(Event::Keyframe);
            }
        }
    }

    fn prune(&mut self) {
        let mut floor = self.video.done.min(self.audio.done);
        let mut low_index = self.next_index;
        for lane in [&self.video, &self.audio] {
            if let Some(h) = lane.held.front() {
                floor = floor.min(u64::from(h.frame.epoch));
                low_index = low_index.min(h.index);
            }
        }
        if let Some(f) = self.fragment {
            floor = floor.min(f.epoch);
            low_index = low_index.min(f.index);
        }
        while self.breaks.front().is_some_and(|&m| m <= low_index) {
            self.breaks.pop_front();
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
