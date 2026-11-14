// SPDX-License-Identifier: Apache-2.0
//! The recording privacy barrier against the shared vectors in `vectors/privacy/`, an
//! exhaustive table of single-frame cases, and randomized arrival orders against a simulated
//! daemon and producer.

use media_core::privacy::{
    Barrier, Decision, DropReason, Epoch, Event, Frame, Limits, ReadStamper, Track,
};
use serde_json::Value;
use std::{collections::HashMap, fs, path::PathBuf};

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
                barrier.decide(decision, &mut out);
            } else if let Some(at) = step.get("tick") {
                barrier.tick(at.as_u64().ok_or("tick")?, &mut out);
            } else if let Some(e) = step.get("issued") {
                barrier.issued(Epoch::try_from(e.as_u64().ok_or("issued")?)?);
            } else if step.get("interrupt").is_some() {
                barrier.interrupt(&mut out);
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
                            b.decide(clear(1), &mut out);
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
                            b.decide(decision, &mut out);
                            b.frame(frame, 0, &mut out);
                        } else {
                            b.frame(frame, 0, &mut out);
                            assert!(!out.iter().any(|e| matches!(e, Event::Write(_))), "held");
                            b.decide(decision, &mut out);
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
}

/// A daemon, a producer that stamps by capture time and two lanes with random delays: the
/// daemon decides epoch k clear only if the source was public from sending k to receiving the
/// acknowledgement of k+1, and everything reaches the barrier in a shuffled order.
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
    let epoch_at = |ms: u64| applied.iter().rposition(|&a| a <= ms);
    // Captured frames, epochs numbered from 1. Half the runs stamp by capture time against
    // the moment each epoch was applied; the rest stamp at read time, after a capture queue of
    // up to three frames, through the read-time rule.
    let read_time = rng.below(2) == 0;
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
                    let follows_private = private_at[sent[next_apply - 1] as usize];
                    stamper.apply(
                        next_apply as Epoch + 1,
                        follows_private,
                        applied[next_apply],
                    );
                    next_apply += 1;
                }
                (applied[0] <= read).then(|| stamper.stamp(read))
            } else {
                epoch_at(ms).map(|k| k as Epoch + 1)
            };
            if let Some(epoch) = stamped {
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
    // seconds and reorder; some old keyframes arrive again much later.
    let lane_delay = if rng.below(4) == 0 { 2_500 } else { 300 };
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
    arrivals.sort_by_key(|a| (a.0, a.1));

    let mut barrier = Barrier::new(1, Limits::default());
    let mut out = Vec::new();
    for (at, _, arrival) in arrivals {
        barrier.tick(at, &mut out);
        match arrival {
            Arrival::Frame(idx) => {
                let f = &frames[idx];
                let frame = Frame {
                    track: f.track,
                    epoch: f.epoch,
                    keyframe: f.keyframe,
                    bytes: 30_000,
                    payload: idx,
                };
                barrier.frame(frame, at, &mut out);
            }
            Arrival::Decision(d) => barrier.decide(d, &mut out),
        }
    }

    let mut need_key = true;
    let mut last_written = [0 as Epoch; 2];
    let mut next_applied = 0;
    for e in &out {
        match e {
            Event::Write(f) => {
                let c = &frames[f.payload];
                assert!(
                    !c.private,
                    "seed {seed}: wrote a frame captured while private"
                );
                assert!(
                    !discarded[c.epoch as usize - 1],
                    "seed {seed}: wrote a discarded epoch"
                );
                let l = usize::from(c.track == Track::Audio);
                assert!(
                    c.epoch >= last_written[l],
                    "seed {seed}: written out of epoch order"
                );
                if c.track == Track::Video {
                    let crossed =
                        (last_written[0].max(1)..c.epoch).any(|k| discarded[k as usize - 1]);
                    if need_key || (last_written[0] > 0 && crossed) {
                        assert!(c.keyframe, "seed {seed}: a fragment started on a delta");
                    }
                    need_key = false;
                }
                last_written[l] = c.epoch;
            }
            Event::Drop(f, r) => {
                let in_stream = !matches!(r, DropReason::Stale | DropReason::NotIssued);
                if f.track == Track::Video && in_stream {
                    need_key = true;
                }
            }
            Event::Gap => need_key = true,
            Event::Keyframe => {}
            Event::Applied { seq, .. } => {
                assert_eq!(
                    *seq, next_applied,
                    "seed {seed}: decisions applied in seq order"
                );
                next_applied += 1;
            }
        }
    }
    assert_eq!(
        next_applied, seq,
        "seed {seed}: every decision applied once"
    );
}

#[test]
fn shuffled_frames_and_decisions_never_write_a_private_frame_or_start_on_a_delta() {
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
            &mut out,
        );
        written += out.iter().filter(|e| matches!(e, Event::Write(_))).count();
        out.clear();
    }
    assert_eq!(written, 50 * 7);
}
