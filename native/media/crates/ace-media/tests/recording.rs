// SPDX-License-Identifier: Apache-2.0
//! Recordings through the real binary: a fake producer's frames on the ingest socket and the
//! daemon's decisions on the priority lane, on their own connections, in whatever order the
//! test makes them arrive (docs/media/plan.md, "Recording privacy barrier"). Every part is
//! read back with media-mp4's independent reader.
//!
//! Set `ACE_MEDIA_PLAYBACK_DIR` to keep the parts, then decode them on macOS with
//! `swift crates/ace-media/tests/playback.swift <dir>`.
#![cfg(unix)]
mod support;

#[path = "../../media-mp4/tests/support/reader.rs"]
mod reader;

use media_wire::control::{ControlFrame, FromMedia, Lane, Part};
use media_wire::frame::MediaFrame;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io::{Read as _, Write};
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};
use support::*;

const FIXTURE: &[u8] = include_bytes!("../../media-mp4/tests/vectors/h264.bin");
/// Our SEI's `user_data_unregistered` UUID (H.264 D.1.6); the 2 bytes after it are the frame id.
const UUID: [u8; 16] = *b"ace-media-test-1";
/// 20 ms of Opus silence (RFC 6716: CELT fullband, one frame).
const SILENCE: [u8; 3] = [0xf8, 0xff, 0xfe];

fn avcc() -> Vec<u8> {
    let n = u32::from_be_bytes([FIXTURE[0], FIXTURE[1], FIXTURE[2], FIXTURE[3]]) as usize;
    FIXTURE[4..4 + n].to_vec()
}

/// The fixture's pictures, each a complete IDR access unit from VideoToolbox.
fn pictures() -> Vec<Vec<u8>> {
    let n = u32::from_be_bytes([FIXTURE[0], FIXTURE[1], FIXTURE[2], FIXTURE[3]]) as usize;
    let mut at = 4 + n;
    let mut out = Vec::new();
    while at < FIXTURE.len() {
        let len = u32::from_be_bytes([
            FIXTURE[at],
            FIXTURE[at + 1],
            FIXTURE[at + 2],
            FIXTURE[at + 3],
        ]) as usize;
        out.push(FIXTURE[at + 4..at + 4 + len].to_vec());
        at += 4 + len;
    }
    out
}

/// A decodable picture tagged with `id` in an SEI its decoder ignores.
fn tagged(id: u16) -> Vec<u8> {
    let mut sei = vec![0x06, 0x05, 18];
    sei.extend_from_slice(&UUID);
    sei.extend_from_slice(&[0xa0 | (id >> 8) as u8 & 0x0f, id as u8, 0x80]);
    let mut sample = (sei.len() as u32).to_be_bytes().to_vec();
    sample.extend_from_slice(&sei);
    sample.extend_from_slice(&pictures()[usize::from(id) % 3]);
    sample
}

fn id_of(sample: &[u8]) -> Option<u16> {
    let at = sample.windows(16).position(|w| w == UUID)? + 16;
    Some(u16::from(sample[at] & 0x0f) << 8 | u16::from(sample[at + 1]))
}

fn video(id: u16, key: bool, epoch: u32) -> Vec<u8> {
    let frame = MediaFrame {
        kind: 1,
        flags: u32::from(key) | if key { 4 } else { 0 },
        age_us: 0,
        width: 64,
        height: 64,
        display_width: 64,
        display_height: 64,
        scale: 1000,
        rotation: 0,
        codec: 2,
        encode: 0,
        epoch,
        codec_string: "avc1.64000b".into(),
        description: if key { avcc() } else { Vec::new() },
        extension: Vec::new(),
        payload: tagged(id),
    };
    frame
        .encode()
        .unwrap_or_else(|_| panic!("frame did not encode"))
}

fn audio(epoch: u32) -> Vec<u8> {
    let frame = MediaFrame {
        kind: 2,
        flags: 4,
        age_us: 0,
        width: 0,
        height: 0,
        display_width: 0,
        display_height: 0,
        scale: 1000,
        rotation: 0,
        codec: 9,
        encode: 0,
        epoch,
        codec_string: "opus".into(),
        description: vec![0, 0, 0xbb, 0x80, 1],
        extension: Vec::new(),
        payload: SILENCE.to_vec(),
    };
    frame
        .encode()
        .unwrap_or_else(|_| panic!("frame did not encode"))
}

/// Producers send in real time; a burst would give every picture the same capture time.
fn pace() {
    std::thread::sleep(Duration::from_millis(5));
}

/// One running ace-media as the daemon sees it: its messages, its lanes and a producer.
struct Run {
    media: Media,
    messages: Receiver<FromMedia>,
    priority: UnixStream,
    _egress: UnixStream,
    producer: UnixStream,
}

impl Run {
    fn start(name: &str, epoch: u32, directory: &Path, max_bytes: u64) -> Self {
        let mut media = Media::spawn(name);
        let (control, ingest, _) = media.start();
        let priority = lane(&control, 1, SECRET).unwrap_or_else(|| panic!("priority lane"));
        let egress = lane(&control, 2, SECRET).unwrap_or_else(|| panic!("egress lane"));
        media.send(
            json!({ "type": "source.open", "source": "s1", "handle": 1, "epoch": epoch,
                    "origin": { "kind": "tab" } }),
            &[3; 32],
        );
        media.send(
            json!({ "type": "record.start", "recording": "r1", "source": "s1",
                    "directory": directory.to_string_lossy(), "maxBytes": max_bytes,
                    "pointerTrack": true }),
            &[],
        );
        let fd = media
            .stdout
            .as_fd()
            .try_clone_to_owned()
            .unwrap_or_else(|e| panic!("stdout: {e}"));
        let mut stdout = std::fs::File::from(fd);
        let (tx, messages) = channel();
        std::thread::spawn(move || {
            while let Some(message) = next_message(&mut stdout) {
                if tx.send(message).is_err() {
                    return;
                }
            }
        });
        let mut producer =
            UnixStream::connect(&ingest).unwrap_or_else(|e| panic!("ingest socket: {e}"));
        let _ = producer.write_all(&media_frame(5, 0, vec![3; 32]));
        Self {
            media,
            messages,
            priority,
            _egress: egress,
            producer,
        }
    }

    fn produce(&mut self, frame: &[u8]) {
        self.producer
            .write_all(frame)
            .unwrap_or_else(|e| panic!("producer: {e}"));
    }

    fn decide(&mut self, seq: u64, decided: u32, clear: Value, discard: Value) {
        let message = json!({ "type": "record.epochs", "source": "s1", "seq": seq,
                              "decided": decided, "clear": clear, "discard": discard });
        let _ = self
            .priority
            .write_all(&frame(message, &[], Lane::Priority));
    }

    /// Waits for the next message `pick` accepts, skipping the rest.
    fn expect<T>(&self, mut pick: impl FnMut(FromMedia) -> Option<T>) -> T {
        let end = Instant::now() + Duration::from_secs(5);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.messages.recv_timeout(left) {
                Ok(message) => {
                    if let Some(found) = pick(message) {
                        return found;
                    }
                }
                Err(_) => break,
            }
        }
        panic!("the expected message never came");
    }

    /// Lets ace-media take in what was sent: a ping is answered after everything before it.
    fn settle(&mut self) {
        std::thread::sleep(Duration::from_millis(150));
        self.media
            .send(json!({ "type": "ping", "id": "settle" }), &[]);
        self.expect(|m| matches!(m, FromMedia::Pong { .. }).then_some(()));
    }

    fn stop(mut self) -> Vec<Part> {
        self.settle();
        self.media
            .send(json!({ "type": "record.stop", "recording": "r1" }), &[]);
        self.expect(|m| match m {
            FromMedia::RecordDone { parts, .. } => Some(parts),
            FromMedia::RecordFailed { reason, .. } => panic!("recording failed: {reason}"),
            _ => None,
        })
    }

    fn kill(mut self) {
        let _ = self.media.child.kill();
        let _ = self.media.child.wait();
    }
}

/// The next stdout message, or `None` once ace-media is gone.
fn next_message(stdout: &mut std::fs::File) -> Option<FromMedia> {
    let mut prefix = [0u8; 4];
    stdout.read_exact(&mut prefix).ok()?;
    let mut bytes = prefix.to_vec();
    bytes.resize(4 + u32::from_be_bytes(prefix) as usize, 0);
    stdout.read_exact(&mut bytes[4..]).ok()?;
    ControlFrame::<FromMedia>::decode(&bytes, Lane::Normal)
        .ok()
        .map(|f| f.message)
}

fn directory(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("am-rec-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// What one part holds: video ids in order, the number of audio samples, and whether every
/// fragment starts at a sync sample after a complete init segment.
struct Read {
    ids: Vec<u16>,
    audio: usize,
    fragments: usize,
}

fn read(path: &Path) -> Read {
    let file = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let top = reader::boxes(&file);
    assert_eq!(
        top[0].kind,
        b"ftyp",
        "{} starts with its own init",
        path.display()
    );
    assert_eq!(top[1].kind, b"moov");
    let mut out = Read {
        ids: Vec::new(),
        audio: 0,
        fragments: 0,
    };
    for pair in top.windows(2) {
        if pair[0].kind != b"moof" || pair[1].kind != b"mdat" {
            continue;
        }
        out.fragments += 1;
        let runs = reader::runs(&file[pair[0].offset..pair[1].offset + pair[1].size]);
        for run in runs {
            if run.id == 2 {
                out.audio += run.payloads.len();
                assert!(run.payloads.iter().all(|p| p == &SILENCE));
                continue;
            }
            assert_eq!(run.flags[0], 0x0200_0000, "a fragment starts at a keyframe");
            out.ids.extend(
                run.payloads
                    .iter()
                    .map(|p| id_of(p).unwrap_or_else(|| panic!("untagged"))),
            );
        }
    }
    if let Ok(keep) = std::env::var("ACE_MEDIA_PLAYBACK_DIR") {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let parent = path
            .parent()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let _ = std::fs::copy(path, Path::new(&keep).join(format!("{parent}-{name}")));
    }
    out
}

/// The plan's reordered barrier test. Each step arrives in an order a real system can produce:
/// frames ahead of decisions, the priority lane seconds late, decisions out of `seq` order, a
/// late acknowledgement making an epoch discarded, an old keyframe after a resume, audio across
/// transitions, and ace-media killed between a pause and its resume.
#[test]
fn no_frame_captured_while_private_is_ever_written_whatever_the_arrival_order() {
    let dir = directory("barrier");
    let mut private: BTreeSet<u16> = BTreeSet::new();
    let mut clear: BTreeSet<u16> = BTreeSet::new();

    // Process 1. Epoch 1 is public. Its frames flow for 2.4 s while the priority lane is held
    // back, so the barrier holds them, and the oldest overflow its 2 s bound into a gap.
    let mut run = Run::start("barrier-1", 1, &dir, 1 << 20);
    let mut id = 0u16;
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(2_400) {
        run.produce(&video(id, id % 10 == 0, 1));
        run.produce(&audio(1));
        clear.insert(id);
        id += 1;
        std::thread::sleep(Duration::from_millis(33));
    }
    let overflowed = 0..10;
    // Epoch 2's acknowledgement came only after the source went private: discarded. Epoch 3
    // is private. Their frames, video and audio, arrive before any decision.
    for epoch in [2, 3] {
        for n in 0..12 {
            run.produce(&video(id, n % 4 == 0, epoch));
            run.produce(&audio(epoch));
            pace();
            private.insert(id);
            id += 1;
        }
    }
    // Decisions out of order: seq 1 first, held until seq 0 arrives.
    run.decide(1, 3, json!([]), json!([[2, 3]]));
    std::thread::sleep(Duration::from_millis(100));
    run.decide(0, 1, json!([[1, 1]]), json!([]));
    // Both are answered on the priority lane, in seq order.
    let applied: Vec<(u64, u64)> = (0..2)
        .map(|_| match read_frame(&mut run.priority, Lane::Priority) {
            FromMedia::EpochsApplied { seq, written, .. } => (seq.get(), written.get()),
            other => panic!("expected epochs.applied, got {other:?}"),
        })
        .collect();
    assert_eq!(applied[0].0, 0);
    assert_eq!(applied[1], (1, 0), "nothing of epochs 2 and 3 written");
    assert!(
        applied[0].1 > 0,
        "frames still held were written once epoch 1 was decided"
    );
    run.settle();
    // The source is still private when ace-media dies.
    run.kill();

    // Process 2. The daemon reissues the current epoch, 4 (public again), and seq starts at 0.
    // The recording continues in a new part; the part the kill cut is reported first.
    let mut run = Run::start("barrier-2", 4, &dir, 1 << 20);
    let recovered = run.expect(|m| match m {
        FromMedia::RecordPart { index, bytes, .. } => Some((index, bytes.get())),
        _ => None,
    });
    assert_eq!(recovered.0, 0);
    assert!(recovered.1 > 0);
    // An old keyframe from private epoch 3 arrives after the resume.
    run.produce(&video(id, true, 3));
    private.insert(id);
    id += 1;
    // Epoch 4 public; epoch 5 discarded (its acknowledgement was late past a transition);
    // epoch 6 private; epoch 7 public.
    for (epoch, frames) in [(4, 6), (5, 4), (6, 4), (7, 6)] {
        for n in 0..frames {
            run.produce(&video(id, n % 3 == 0, epoch));
            run.produce(&audio(epoch));
            pace();
            if matches!(epoch, 4 | 7) {
                clear.insert(id);
            } else {
                private.insert(id);
            }
            id += 1;
        }
    }
    run.decide(0, 7, json!([[4, 4], [7, 7]]), json!([[5, 6]]));
    let parts = run.stop();
    assert_eq!(parts.iter().map(|p| p.index).collect::<Vec<_>>(), [1]);

    let first = read(&dir.join("part-0000.mp4"));
    let second = read(&dir.join("part-0001.mp4"));
    for part in [&first, &second] {
        assert!(part.fragments > 0);
        for id in &part.ids {
            assert!(
                !private.contains(id),
                "frame {id} was captured while private"
            );
            assert!(clear.contains(id));
        }
        let mut sorted = part.ids.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, part.ids, "frames in capture order");
    }
    assert!(
        overflowed.clone().all(|id| !first.ids.contains(&id)),
        "frames held past the bound are a gap, never written late"
    );
    // Epoch 4 and 7 written whole; audio only from public epochs (6 + 6 packets after
    // their keyframes), never the 8 discarded ones.
    assert_eq!(second.ids.len(), 12);
    assert_eq!(second.audio, 12);
    let _ = std::fs::remove_dir_all(&dir);
}

/// kill -9 mid-recording: what was written plays to its last whole fragment, and the next
/// process continues the recording in a new part.
#[test]
fn a_recording_cut_by_kill_plays_to_its_last_fragment_and_continues() {
    let dir = directory("kill");
    let mut run = Run::start("kill-1", 1, &dir, 1 << 20);
    for id in 0..40u16 {
        run.produce(&video(id, id % 5 == 0, 1));
        run.produce(&audio(1));
        pace();
    }
    run.decide(0, 1, json!([[1, 1]]), json!([]));
    run.settle();
    run.kill();
    let path = dir.join("part-0000.mp4");
    let before = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    let run = Run::start("kill-2", 2, &dir, 1 << 20);
    let (bytes, duration) = run.expect(|m| match m {
        FromMedia::RecordPart {
            index: 0,
            bytes,
            duration_ms,
            ..
        } => Some((bytes.get(), duration_ms.get())),
        _ => None,
    });
    assert!(bytes > 0 && bytes <= before);
    let cut = read(&path);
    // The last group (35..40) was still open in the killed process: everything before it
    // was on disk.
    assert_eq!(cut.ids, (0..35).collect::<Vec<_>>());
    assert_eq!(cut.audio, 35, "audio rides in the same fragments");
    assert_eq!(cut.fragments, 7);
    assert!(duration > 0);
    let parts = run.stop();
    assert!(parts.is_empty(), "nothing new was recorded");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Parts end before their bound, each a playable file starting at a keyframe, and every one
/// is reported as it closes and again in `record.done`.
#[test]
fn a_long_recording_rolls_into_parts_within_its_bound() {
    let dir = directory("rollover");
    let max = 8_000;
    let mut run = Run::start("rollover", 1, &dir, max);
    run.decide(0, 1, json!([[1, 1]]), json!([]));
    let mut id = 0u16;
    while id < 300 {
        run.produce(&video(id, id % 10 == 0, 1));
        run.produce(&audio(1));
        pace();
        id += 1;
    }
    let parts = run.stop();
    assert!(parts.len() >= 4, "{} parts", parts.len());
    let mut all = Vec::new();
    for (n, part) in parts.iter().enumerate() {
        assert_eq!(part.index as usize, n);
        assert!(
            part.bytes.get() <= max,
            "part {n} has {} bytes",
            part.bytes.get()
        );
        let got = read(Path::new(&part.path));
        assert_eq!(got.audio, got.ids.len(), "audio in every part");
        all.extend(got.ids);
    }
    assert_eq!(
        all,
        (0..300).collect::<Vec<_>>(),
        "no frame lost at a part boundary"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
