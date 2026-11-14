// SPDX-License-Identifier: Apache-2.0
//! The recording privacy barrier against the shared vectors in `vectors/privacy/`, an
//! exhaustive table of single-frame cases, and randomized arrival orders against a simulated
//! daemon and producer, where every frame's outcome is compared with a reference model that
//! keeps the whole history.

use media_core::privacy::{
    Barrier, Decision, DropReason, Epoch, Event, Frame, Limits, ReadStamper, Track,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::PathBuf,
};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

fn vectors(name: &str) -> Result<Vec<Value>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../vectors/privacy")
        .join(name);
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    Ok(value.as_array().ok_or("vectors are a list")?.clone())
}

fn uint(v: &Value, key: &str) -> Result<u64> {
    v[key]
        .as_u64()
        .ok_or_else(|| format!("{key} is not an unsigned integer").into())
}

fn epoch(v: &Value, key: &str) -> Result<Epoch> {
    Ok(Epoch::try_from(uint(v, key)?)?)
}

fn ranges(v: &Value) -> Result<Vec<(Epoch, Epoch)>> {
    v.as_array()
        .ok_or("ranges are a list")?
        .iter()
        .map(|r| Ok((pair(r, 0)?, pair(r, 1)?)))
        .collect()
}

fn pair(r: &Value, i: usize) -> Result<Epoch> {
    Ok(Epoch::try_from(r[i].as_u64().ok_or("range bound")?)?)
}

fn reason(r: DropReason) -> &'static str {
    match r {
        DropReason::Discarded => "discarded",
        DropReason::Stale => "stale",
        DropReason::NotIssued => "notIssued",
        DropReason::AwaitingKeyframe => "awaitingKeyframe",
        DropReason::AwaitingVideo => "awaitingVideo",
        DropReason::Overflow => "overflow",
    }
}

fn describe(e: &Event<String>) -> String {
    match e {
        Event::Write(f) => format!("write {}", f.payload),
        Event::Drop(f, r) => format!("drop {} {}", f.payload, reason(*r)),
        Event::Gap => "gap".into(),
        Event::Keyframe => "keyframe".into(),
        Event::Applied {
            seq,
            written,
            dropped,
        } => format!("applied {seq} {written} {dropped}"),
    }
}

#[test]
fn every_barrier_scenario_produces_its_events_and_never_writes_a_private_frame() -> Result {
    let scenarios = vectors("barrier.json")?;
    assert!(scenarios.len() >= 20, "the barrier vectors are all present");
    for s in scenarios {
        let name = s["name"].as_str().ok_or("name")?;
        let limits = match s.get("limits") {
            Some(l) => Limits {
                hold_ms: uint(l, "holdMs")?,
                hold_bytes: usize::try_from(uint(l, "holdBytes")?)?,
            },
            None => Limits::default(),
        };
        let mut barrier = Barrier::new(epoch(&s, "start")?, limits);
        let mut private = HashMap::new();
        for (i, step) in s["steps"].as_array().ok_or("steps")?.iter().enumerate() {
            let mut out = Vec::new();
            if let Some(f) = step.get("frame") {
                let id = f["id"].as_str().ok_or("id")?.to_string();
                private.insert(id.clone(), f["private"].as_bool().ok_or("private")?);
                let track = match f["track"].as_str() {
                    Some("video") => Track::Video,
                    Some("audio") => Track::Audio,
                    _ => return Err("track".into()),
                };
                let frame = Frame {
                    track,
                    epoch: epoch(f, "epoch")?,
                    keyframe: f["keyframe"].as_bool().ok_or("keyframe")?,
                    bytes: usize::try_from(uint(f, "bytes")?)?,
                    payload: id,
                };
                barrier.frame(frame, uint(step, "at")?, &mut out);
            } else if let Some(d) = step.get("decide") {
                let decision = Decision {
                    seq: uint(d, "seq")?,
                    decided: epoch(d, "decided")?,
                    clear: ranges(&d["clear"])?,
                    discard: ranges(&d["discard"])?,
                };
                barrier.decide(decision, uint(step, "at")?, &mut out);
            } else if let Some(at) = step.get("tick") {
                barrier.tick(at.as_u64().ok_or("tick")?, &mut out);
            } else if let Some(e) = step.get("issued") {
                barrier.issued(Epoch::try_from(e.as_u64().ok_or("issued")?)?);
            } else if step.get("interrupt").is_some() {
                barrier.interrupt(uint(step, "at")?, &mut out);
            } else if let Some(r) = step.get("restart") {
                barrier = Barrier::new(epoch(r, "start")?, limits);
            } else {
                return Err(format!("{name}: unknown step {i}").into());
            }
            for e in &out {
                if let Event::Write(f) = e {
                    assert!(
                        !private[&f.payload],
                        "{name}: wrote private frame {}",
                        f.payload
                    );
                }
            }
            let got: Vec<String> = out.iter().map(describe).collect();
            let want: Vec<String> = step["expect"]
                .as_array()
                .ok_or("expect")?
                .iter()
                .map(|e| e.as_str().unwrap_or_default().to_string())
                .collect();
            assert_eq!(got, want, "{name}: step {i}");
        }
    }
    Ok(())
}

#[test]
fn read_time_stamping_holds_the_private_epoch_for_100_ms() -> Result {
    for s in vectors("read-stamping.json")? {
        let name = s["name"].as_str().ok_or("name")?;
        let mut stamper = ReadStamper::new(epoch(&s, "start")?);
        for step in s["steps"].as_array().ok_or("steps")? {
            if let Some(a) = step.get("apply") {
                let follows = a["followsPrivate"].as_bool().ok_or("followsPrivate")?;
                stamper.apply(epoch(a, "epoch")?, follows, uint(a, "at")?);
            } else {
                let r = &step["read"];
                assert_eq!(stamper.stamp(uint(r, "at")?), epoch(r, "expect")?, "{name}");
            }
        }
    }
    Ok(())
}

/// One frame against every state the barrier can be in for it: each verdict its epoch can
/// have (decided before arrival or after), each frame kind, and whether a fragment runs.
#[test]
fn a_single_frame_is_written_only_when_its_epoch_is_clear_and_its_fragment_can_hold_it() {
    let clear = |e: Epoch| Decision {
        seq: 0,
        decided: e,
        clear: vec![(1, e)],
        discard: vec![],
    };
    for decided_first in [true, false] {
        for is_clear in [true, false] {
            for track in [Track::Video, Track::Audio] {
                for keyframe in [true, false] {
                    for running in [true, false] {
                        let mut b = Barrier::new(1, Limits::default());
                        let mut out = Vec::new();
                        let mut seq = 0;
                        if running {
                            b.decide(clear(1), 0, &mut out);
                            seq = 1;
                            let k = Frame {
                                track: Track::Video,
                                epoch: 1,
                                keyframe: true,
                                bytes: 1,
                                payload: 0,
                            };
                            b.frame(k, 0, &mut out);
                        }
                        let decision = Decision {
                            seq,
                            decided: 2,
                            clear: if is_clear { vec![(2, 2)] } else { vec![] },
                            discard: if is_clear { vec![] } else { vec![(2, 2)] },
                        };
                        let frame = Frame {
                            track,
                            epoch: 2,
                            keyframe,
                            bytes: 1,
                            payload: 1,
                        };
                        out.clear();
                        if decided_first {
                            b.decide(decision, 0, &mut out);
                            b.frame(frame, 0, &mut out);
                        } else {
                            b.frame(frame, 0, &mut out);
                            assert!(!out.iter().any(|e| matches!(e, Event::Write(_))), "held");
                            b.decide(decision, 0, &mut out);
                        }
                        let written = out
                            .iter()
                            .any(|e| matches!(e, Event::Write(f) if f.payload == 1));
                        let can_start = match track {
                            Track::Video => keyframe || running,
                            Track::Audio => running,
                        };
                        assert_eq!(
                            written,
                            is_clear && can_start,
                            "decided_first={decided_first} clear={is_clear} {track:?} key={keyframe} running={running}: {out:?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn a_never_decided_epoch_holds_its_frames_and_then_gaps_but_never_writes() {
    let mut b = Barrier::new(1, Limits::default());
    let mut out = Vec::new();
    for i in 0..400u64 {
        let f = Frame {
            track: Track::Video,
            epoch: 1,
            keyframe: i % 30 == 0,
            bytes: 200_000,
            payload: i,
        };
        b.frame(f, i * 16, &mut out);
        assert!(b.held() <= 168, "32 MiB bound holds");
    }
    b.tick(400 * 16 + 2_001, &mut out);
    assert_eq!(b.held(), 0);
    assert!(out.contains(&Event::Gap));
    assert!(!out.iter().any(|e| matches!(e, Event::Write(_))));
}

/// Deterministic xorshift, so a failing seed reproduces.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

#[derive(Clone)]
struct Captured {
    track: Track,
    epoch: Epoch,
    keyframe: bool,
    private: bool,
}

enum Arrival {
    Frame(usize),
    Decision(Decision),
    Interrupt,
}

/// The epoch a read-time producer must give a frame read at `read`, straight from the plan's
/// rule over the apply history: the latest applied epoch, unless an epoch that followed a
/// private one was applied less than 100 ms earlier, in which case the newest such private one.
fn expected_read_stamp(read: u64, applied: &[u64], private_before: &[bool]) -> Option<Epoch> {
    let latest = applied.iter().rposition(|&a| a <= read)?;
    let held = (1..=latest)
        .filter(|&j| private_before[j] && applied[j] <= read && read < applied[j] + 100)
        .max();
    // Epoch numbers start at 1, so applies[j] is epoch j + 1 and its predecessor is epoch j.
    Some(match held {
        Some(j) => j as Epoch,
        None => latest as Epoch + 1,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Write,
    Drop(DropReason),
}

struct ModelFrame {
    arrival: u64,
    track: Track,
    epoch: u64,
    keyframe: bool,
    bytes: usize,
    at: u64,
    ordinal: u64,
}

/// The plan's barrier written as a plain reference, from inputs, time and limits alone: it
/// keeps every break and every verdict, scans instead of caching, and never compacts, so the
/// barrier's compacted state is checked against the whole history.
struct Model {
    limits: Limits,
    start: u64,
    now: u64,
    held: Vec<ModelFrame>,
    seen: [u64; 2],
    next_ordinal: u64,
    next_seq: u64,
    pending: BTreeMap<u64, Decision>,
    undecided: u64,
    clear: BTreeMap<u64, bool>,
    breaks: Vec<u64>,
    fragment: Option<(u64, u64)>,
    video_last: Option<u64>,
    outcomes: Vec<(u64, Outcome)>,
}

impl Model {
    fn new(start: Epoch, limits: Limits) -> Self {
        let start = u64::from(start);
        Self {
            limits,
            start,
            now: 0,
            held: Vec::new(),
            seen: [start; 2],
            next_ordinal: 0,
            next_seq: 0,
            pending: BTreeMap::new(),
            undecided: start,
            clear: BTreeMap::new(),
            breaks: Vec::new(),
            fragment: None,
            video_last: None,
            outcomes: Vec::new(),
        }
    }

    fn time(&mut self, at: u64) {
        self.now = self.now.max(at);
        // Overflow: the oldest held frame goes while any is too old or all are too big.
        while let Some(oldest) = self.held.iter().min_by_key(|f| f.ordinal) {
            let bytes: usize = self.held.iter().map(|f| f.bytes).sum();
            if self.now - oldest.at <= self.limits.hold_ms && bytes <= self.limits.hold_bytes {
                break;
            }
            let ordinal = oldest.ordinal;
            let f = self.take(ordinal);
            self.breaks.push(ordinal + 1);
            self.outcomes
                .push((f.arrival, Outcome::Drop(DropReason::Overflow)));
        }
    }

    fn take(&mut self, ordinal: u64) -> ModelFrame {
        let i = self
            .held
            .iter()
            .position(|f| f.ordinal == ordinal)
            .unwrap_or(0);
        self.held.remove(i)
    }

    fn verdict(&self, epoch: u64) -> Option<bool> {
        (epoch < self.undecided).then(|| self.clear.get(&epoch).copied().unwrap_or(false))
    }

    fn belongs(&self, epoch: u64, ordinal: u64) -> bool {
        self.fragment.is_some_and(|(fe, fo)| {
            let (lo, hi) = (ordinal.min(fo), ordinal.max(fo));
            epoch >= fe
                && (fe..=epoch).all(|e| self.verdict(e) != Some(false))
                && !self.breaks.iter().any(|&m| lo < m && m <= hi)
        })
    }

    fn frame(
        &mut self,
        arrival: u64,
        track: Track,
        epoch: Epoch,
        keyframe: bool,
        bytes: usize,
        at: u64,
    ) {
        self.time(at);
        let epoch = u64::from(epoch);
        let l = usize::from(track == Track::Audio);
        if epoch < self.seen[l] || epoch < self.start {
            self.outcomes
                .push((arrival, Outcome::Drop(DropReason::Stale)));
            return;
        }
        self.seen[l] = epoch;
        let ordinal = self.next_ordinal;
        self.next_ordinal += 1;
        self.held.push(ModelFrame {
            arrival,
            track,
            epoch,
            keyframe,
            bytes,
            at: self.now,
            ordinal,
        });
        self.time(at);
        self.release();
    }

    fn decide(&mut self, d: Decision, at: u64) {
        self.time(at);
        if d.seq < self.next_seq {
            return;
        }
        self.pending.entry(d.seq).or_insert(d);
        while let Some(d) = self.pending.remove(&self.next_seq) {
            self.next_seq += 1;
            let decided = u64::from(d.decided);
            for e in self.undecided..=decided {
                let named = d
                    .clear
                    .iter()
                    .any(|&(a, b)| (u64::from(a)..=u64::from(b)).contains(&e));
                self.clear.insert(e, named);
            }
            self.undecided = self.undecided.max(decided + 1);
            for &(a, b) in &d.discard {
                for e in u64::from(a).max(self.start)..=u64::from(b).min(self.undecided - 1) {
                    self.clear.insert(e, false);
                }
            }
            self.release();
        }
    }

    fn interrupt(&mut self, at: u64) {
        self.time(at);
        self.breaks.push(self.next_ordinal);
        self.release();
    }

    fn tick(&mut self, at: u64) {
        self.time(at);
        self.release();
    }

    fn release(&mut self) {
        loop {
            let first = |t: Track| {
                self.held
                    .iter()
                    .filter(|f| f.track == t)
                    .min_by_key(|f| f.ordinal)
            };
            let video = first(Track::Video).filter(|f| self.verdict(f.epoch).is_some());
            let audio = first(Track::Audio).filter(|f| match self.verdict(f.epoch) {
                None => false,
                Some(false) => true,
                Some(true) => {
                    self.belongs(f.epoch, f.ordinal)
                        || self.fragment.is_some_and(|(fe, _)| f.epoch < fe)
                        || self.video_last.is_some_and(|v| v > f.ordinal)
                }
            });
            let next = match (video, audio) {
                (Some(v), Some(a)) => v.ordinal.min(a.ordinal),
                (Some(v), None) => v.ordinal,
                (None, Some(a)) => a.ordinal,
                (None, None) => return,
            };
            let f = self.take(next);
            let clear = self.verdict(f.epoch) == Some(true);
            let outcome = match f.track {
                Track::Video => {
                    self.video_last = Some(f.ordinal);
                    let restart = self.breaks.iter().copied().max().unwrap_or(0);
                    if !clear {
                        self.fragment = None;
                        Outcome::Drop(DropReason::Discarded)
                    } else if self.belongs(f.epoch, f.ordinal) {
                        Outcome::Write
                    } else if f.keyframe && f.ordinal >= restart {
                        self.fragment = Some((f.epoch, f.ordinal));
                        Outcome::Write
                    } else {
                        self.fragment = None;
                        Outcome::Drop(DropReason::AwaitingKeyframe)
                    }
                }
                Track::Audio if !clear => Outcome::Drop(DropReason::Discarded),
                Track::Audio if self.belongs(f.epoch, f.ordinal) => Outcome::Write,
                Track::Audio => Outcome::Drop(DropReason::AwaitingVideo),
            };
            self.outcomes.push((f.arrival, outcome));
        }
    }
}

/// The barrier's frame outcomes, in order, keyed by delivery number.
fn outcomes(events: &[Event<(usize, u64)>]) -> Vec<(u64, Outcome)> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Write(f) => Some((f.payload.1, Outcome::Write)),
            Event::Drop(f, r) => Some((f.payload.1, Outcome::Drop(*r))),
            _ => None,
        })
        .collect()
}

/// A daemon, a producer and two lanes with random delays: the daemon decides epoch k clear
/// only if the source was public from sending k to receiving the acknowledgement of k+1, and
/// everything reaches the barrier in a shuffled order, with interruptions.
fn simulate(seed: u64) {
    let mut rng = Rng(seed | 1);
    let end = 4_000u64;
    let mut private_at = vec![false; end as usize + 2_000];
    let mut state = rng.below(2) == 0;
    let mut t = 0;
    while t < private_at.len() {
        let run = 50 + rng.below(700) as usize;
        for p in private_at.iter_mut().skip(t).take(run) {
            *p = state;
        }
        state = !state;
        t += run;
    }
    // The daemon issues an epoch on every transition and every 100 ms.
    let mut sent = vec![0u64];
    for ms in 1..end {
        if private_at[ms as usize] != private_at[ms as usize - 1]
            || ms - sent[sent.len() - 1] >= 100
        {
            sent.push(ms);
        }
    }
    let private_before: Vec<bool> = (0..sent.len())
        .map(|j| j > 0 && private_at[sent[j - 1] as usize])
        .collect();
    let slow_acks = rng.below(3) == 0;
    let mut applied = Vec::new();
    let mut acked = Vec::new();
    for &s in &sent {
        let a = s.max(applied.last().copied().unwrap_or(0)) + rng.below(40);
        let lag = if slow_acks {
            rng.below(400)
        } else {
            rng.below(60)
        };
        let k = (a + lag).max(acked.last().copied().unwrap_or(0));
        applied.push(a);
        acked.push(k);
    }
    // Captured frames, epochs numbered from 1. Half the runs stamp by capture time against the
    // moment each epoch was applied; the rest stamp at read time through `ReadStamper`, after a
    // capture queue of up to three frames, checked against the rule computed from the history.
    let read_time = rng.below(2) == 0;
    // Capture pauses (a still screen, silence): some stop video only, some both tracks, so
    // epochs pass with no frames of their own and decisions land after a silence.
    let pauses: Vec<(u64, u64, bool)> = (0..rng.below(4))
        .map(|_| {
            let from = rng.below(end);
            (from, from + 100 + rng.below(2_900), rng.below(2) == 0)
        })
        .collect();
    let paused = |track: Track, ms: u64| {
        pauses
            .iter()
            .any(|&(a, b, both)| (a..b).contains(&ms) && (both || track == Track::Video))
    };
    let mut frames = Vec::new();
    let mut captured_at = Vec::new();
    for (track, period) in [(Track::Video, 16), (Track::Audio, 20)] {
        let mut n = 0;
        let mut ms = 5;
        let mut stamper = ReadStamper::new(1);
        let mut next_apply = 1;
        let mut read = 0;
        while ms < end {
            let stamped = if read_time {
                read = (ms + rng.below(3 * period + 1)).max(read);
                while next_apply < applied.len() && applied[next_apply] <= read {
                    stamper.apply(
                        next_apply as Epoch + 1,
                        private_before[next_apply],
                        applied[next_apply],
                    );
                    next_apply += 1;
                }
                let expected = expected_read_stamp(read, &applied, &private_before);
                let stamped = (applied[0] <= read).then(|| stamper.stamp(read));
                assert_eq!(stamped, expected, "seed {seed}: read-time stamp at {read}");
                stamped
            } else {
                applied
                    .iter()
                    .rposition(|&a| a <= ms)
                    .map(|k| k as Epoch + 1)
            };
            if let Some(epoch) = stamped.filter(|_| !paused(track, ms)) {
                frames.push(Captured {
                    track,
                    epoch,
                    keyframe: track == Track::Video && (n % 20 == 0 || rng.below(15) == 0),
                    private: private_at[ms as usize],
                });
                captured_at.push(ms);
                n += 1;
            }
            ms += period;
        }
    }
    // Decisions: epoch k (index i) is decided when the acknowledgement of k+1 arrives.
    let discarded: Vec<bool> = (0..sent.len().saturating_sub(1))
        .map(|i| (sent[i]..=acked[i + 1]).any(|ms| private_at[ms as usize]))
        .collect();
    let mut decisions = Vec::new();
    let mut i = 0;
    let mut seq = 0;
    while i < discarded.len() {
        let mut j = i;
        while j + 1 < discarded.len() && acked[j + 2] == acked[i + 1] {
            j += 1;
        }
        let at = acked[j + 1];
        let mut clear = Vec::new();
        let mut discard = Vec::new();
        for (k, &d) in discarded.iter().enumerate().take(j + 1).skip(i) {
            let e = k as Epoch + 1;
            if d {
                discard.push((e, e))
            } else {
                clear.push((e, e))
            }
        }
        decisions.push((
            at,
            Decision {
                seq,
                decided: j as Epoch + 1,
                clear,
                discard,
            },
        ));
        seq += 1;
        i = j + 1;
    }
    // Shuffle arrivals: each frame lane keeps its order, the priority lane may be late by
    // seconds and reorder; some old keyframes arrive again much later; the stream is
    // sometimes interrupted.
    let lane_delay = [300, 2_500, 4_000][rng.below(3) as usize];
    let mut arrivals: Vec<(u64, u64, Arrival)> = Vec::new();
    let mut last = [0u64; 2];
    for (idx, f) in frames.iter().enumerate() {
        let l = usize::from(f.track == Track::Audio);
        let at = (captured_at[idx] + rng.below(80)).max(last[l]);
        last[l] = at;
        arrivals.push((at, rng.next(), Arrival::Frame(idx)));
        if f.keyframe && rng.below(6) == 0 {
            arrivals.push((at + 200 + rng.below(1_500), rng.next(), Arrival::Frame(idx)));
        }
    }
    for (at, d) in decisions {
        arrivals.push((at + rng.below(lane_delay), rng.next(), Arrival::Decision(d)));
    }
    for _ in 0..rng.below(4) {
        arrivals.push((rng.below(end), rng.next(), Arrival::Interrupt));
    }
    arrivals.sort_by_key(|a| (a.0, a.1));

    let mut model = Model::new(1, Limits::default());
    let mut barrier = Barrier::new(1, Limits::default());
    let mut delivery = 0u64;
    let mut delivered = Vec::new();
    let mut last_written = [0 as Epoch; 2];
    let mut next_applied = 0;
    let mut out = Vec::new();
    for (at, _, arrival) in arrivals {
        // Some inputs carry a time earlier than one already seen: it counts as the latest.
        let at = if rng.below(5) == 0 {
            at.saturating_sub(rng.below(400))
        } else {
            at
        };
        // Each input, then sometimes a later tick, checked one at a time.
        for step in 0..2 {
            out.clear();
            model.outcomes.clear();
            if step == 0 {
                match &arrival {
                    Arrival::Frame(idx) => {
                        let f = &frames[*idx];
                        let frame = Frame {
                            track: f.track,
                            epoch: f.epoch,
                            keyframe: f.keyframe,
                            bytes: 30_000,
                            payload: (*idx, delivery),
                        };
                        model.frame(delivery, f.track, f.epoch, f.keyframe, 30_000, at);
                        barrier.frame(frame, at, &mut out);
                        delivered.push((*idx, model.now));
                        delivery += 1;
                    }
                    Arrival::Decision(d) => {
                        model.decide(d.clone(), at);
                        barrier.decide(d.clone(), at, &mut out);
                    }
                    Arrival::Interrupt => {
                        model.interrupt(at);
                        barrier.interrupt(at, &mut out);
                    }
                }
            } else if rng.below(12) == 0 {
                let later = at + rng.below(2_500);
                model.tick(later);
                barrier.tick(later, &mut out);
            } else {
                continue;
            }
            assert_eq!(
                outcomes(&out),
                model.outcomes,
                "seed {seed}: frame outcomes differ from the model"
            );
            for e in &out {
                match e {
                    Event::Write(f) => {
                        let c = &frames[f.payload.0];
                        assert!(
                            !c.private,
                            "seed {seed}: wrote a frame captured while private"
                        );
                        assert!(
                            !discarded[c.epoch as usize - 1],
                            "seed {seed}: wrote a discarded epoch"
                        );
                        let held = model.now - delivered[f.payload.1 as usize].1;
                        assert!(held <= 2_000, "seed {seed}: wrote a frame held {held} ms");
                        let l = usize::from(c.track == Track::Audio);
                        assert!(
                            c.epoch >= last_written[l],
                            "seed {seed}: written out of epoch order"
                        );
                        last_written[l] = c.epoch;
                    }
                    Event::Applied { seq, .. } => {
                        assert_eq!(
                            *seq, next_applied,
                            "seed {seed}: decisions applied in seq order"
                        );
                        next_applied += 1;
                    }
                    _ => {}
                }
            }
        }
    }
    assert_eq!(
        next_applied, seq,
        "seed {seed}: every decision applied once"
    );
    assert!(
        barrier.retained() < 4_000,
        "seed {seed}: retained state stays bounded"
    );
}

#[test]
fn shuffled_frames_decisions_and_interruptions_never_write_private_or_outside_a_fragment() {
    for seed in 1..=300u64 {
        simulate(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    }
}

#[test]
fn with_prompt_decisions_and_no_private_time_every_frame_after_the_first_keyframe_is_written() {
    let mut b = Barrier::new(1, Limits::default());
    let mut out = Vec::new();
    let mut written = 0;
    for k in 1..=50u32 {
        for n in 0..6u32 {
            let f = Frame {
                track: Track::Video,
                epoch: k,
                keyframe: k == 1 && n == 0,
                bytes: 1,
                payload: (),
            };
            b.frame(f, u64::from(k) * 100, &mut out);
        }
        let a = Frame {
            track: Track::Audio,
            epoch: k,
            keyframe: false,
            bytes: 1,
            payload: (),
        };
        b.frame(a, u64::from(k) * 100, &mut out);
        b.decide(
            Decision {
                seq: u64::from(k) - 1,
                decided: k,
                clear: vec![(k, k)],
                discard: vec![],
            },
            u64::from(k) * 100,
            &mut out,
        );
        written += out.iter().filter(|e| matches!(e, Event::Write(_))).count();
        out.clear();
    }
    assert_eq!(written, 50 * 7);
}

#[test]
fn an_hour_of_stalled_decisions_keeps_the_barrier_bounded_and_resumes_at_a_keyframe() {
    let mut b = Barrier::new(1, Limits::default());
    let mut out = Vec::new();
    let clear = |seq, e| Decision {
        seq,
        decided: e,
        clear: vec![(e, e)],
        discard: vec![],
    };
    b.decide(clear(0, 1), 0, &mut out);
    let key = Frame {
        track: Track::Video,
        epoch: 1,
        keyframe: true,
        bytes: 40_000,
        payload: 0u64,
    };
    b.frame(key, 0, &mut out);
    assert!(matches!(out[..], [_, Event::Write(_)]));
    // An hour at 60 fps of epoch 2 with no decision: everything ages out as gaps.
    let mut peak = 0;
    for n in 1..=216_000u64 {
        out.clear();
        let f = Frame {
            track: if n % 3 == 0 {
                Track::Audio
            } else {
                Track::Video
            },
            epoch: 2,
            keyframe: n % 60 == 1,
            bytes: 40_000,
            payload: n,
        };
        b.frame(f, n * 1_000 / 60, &mut out);
        assert!(!out.iter().any(|e| matches!(e, Event::Write(_))));
        peak = peak.max(b.retained());
    }
    assert!(
        peak <= 130,
        "two seconds of frames and a few ranges, got {peak}"
    );
    out.clear();
    b.decide(clear(1, 2), 216_000 * 1_000 / 60, &mut out);
    let first = out.iter().find_map(|e| match e {
        Event::Write(f) => Some(f),
        _ => None,
    });
    assert!(
        first.is_some_and(|f| f.keyframe),
        "resumes at a keyframe: {first:?}"
    );
}
