// SPDX-License-Identifier: Apache-2.0
//! The assembler's parts, read back with media-mp4's independent test reader.
use super::*;
use std::collections::BTreeMap;

#[path = "../../../media-mp4/tests/support/reader.rs"]
mod reader;
use reader::{boxes, child, runs};

const AVCC: u8 = 2;
const OPUS: u8 = 9;

fn avcc() -> Vec<u8> {
    let fixture = include_bytes!("../../../media-mp4/tests/vectors/h264.bin");
    let n = u32::from_be_bytes([fixture[0], fixture[1], fixture[2], fixture[3]]) as usize;
    fixture[4..4 + n].to_vec()
}

fn picture(key: bool, payload: Vec<u8>) -> MediaFrame {
    MediaFrame {
        kind: 1,
        flags: u32::from(key),
        age_us: 0,
        width: 64,
        height: 64,
        display_width: 64,
        display_height: 64,
        scale: 1000,
        rotation: 0,
        codec: AVCC,
        encode: 0,
        epoch: 1,
        codec_string: String::new(),
        description: if key { avcc() } else { Vec::new() },
        extension: Vec::new(),
        payload,
    }
}

/// A 20 ms CELT packet (TOC config 31, one frame).
fn sound(byte: u8) -> MediaFrame {
    MediaFrame {
        kind: 2,
        codec: OPUS,
        flags: 0,
        description: vec![0, 0, 0xbb, 0x80, 2],
        payload: vec![31 << 3, byte, byte],
        ..picture(false, Vec::new())
    }
}

/// Runs the assembler's output into files, as the file shell would.
#[derive(Default)]
struct Disk {
    parts: BTreeMap<u32, Vec<u8>>,
    lines: BTreeMap<u32, Vec<String>>,
    closed: Vec<Closed>,
    open: Option<u32>,
}

impl Disk {
    fn take(&mut self, out: &mut Vec<Out>) {
        for o in out.drain(..) {
            match o {
                Out::Open { index } => {
                    assert!(self.open.is_none(), "a part opened inside another");
                    self.open = Some(index);
                    self.parts.insert(index, Vec::new());
                }
                Out::Bytes(b) => {
                    let Some(open) = self.open else {
                        panic!("bytes outside a part");
                    };
                    self.parts.entry(open).or_default().extend_from_slice(&b);
                }
                Out::Line(l) => {
                    let Some(open) = self.open else {
                        panic!("a line outside a part");
                    };
                    self.lines.entry(open).or_default().push(l);
                }
                Out::Close(c) => {
                    assert_eq!(self.open.take(), Some(c.index));
                    assert_eq!(c.bytes, self.parts[&c.index].len() as u64);
                    self.closed.push(c);
                }
            }
        }
    }
}

/// Every fragment of a part: (track, first decode time, durations, payloads) per run.
fn fragments(file: &[u8]) -> Vec<Vec<reader::Run>> {
    let top = boxes(file);
    assert_eq!(top[0].kind, b"ftyp");
    assert_eq!(top[1].kind, b"moov");
    top.windows(2)
        .filter(|p| p[0].kind == b"moof" && p[1].kind == b"mdat")
        .map(|p| runs(&file[p[0].offset..p[1].offset + p[1].size]))
        .collect()
}

fn tracks(file: &[u8]) -> usize {
    let moov = child(file, b"moov");
    boxes(moov).iter().filter(|b| b.kind == b"trak").count()
}

#[test]
fn each_keyframe_starts_a_fragment_written_when_the_next_one_seals_it() {
    let mut a = Assembler::new(0, 1 << 20, false);
    let mut out = Vec::new();
    let mut disk = Disk::default();
    // 30 fps: one keyframe, two deltas, then the next keyframe.
    let captured = [1_000_000, 1_033_334, 1_066_667, 1_100_000];
    let frames = [
        picture(true, vec![1; 40]),
        picture(false, vec![2; 30]),
        picture(false, vec![3; 30]),
        picture(true, vec![4; 40]),
    ];
    for (i, (f, at)) in frames.iter().zip(captured).enumerate() {
        assert_eq!(a.frame(f, at, &mut out), Ok(()));
        disk.take(&mut out);
        let written = disk.parts.get(&0).map_or(0, |p| fragments(p).len());
        assert_eq!(written, usize::from(i == 3), "after frame {i}");
    }
    a.finish(&mut out);
    disk.take(&mut out);
    let part = &disk.parts[&0];
    let frags = fragments(part);
    assert_eq!(frags.len(), 2);
    let first = &frags[0][0];
    assert_eq!(first.time, 0, "a part starts at zero");
    assert_eq!(
        first.durations,
        [3_000, 3_000, 3_000],
        "90 kHz capture times"
    );
    assert_eq!(first.payloads, [vec![1; 40], vec![2; 30], vec![3; 30]]);
    assert_eq!(first.flags[0], 0x0200_0000, "the keyframe is a sync sample");
    assert_eq!(frags[1][0].time, 9_000);
    assert_eq!(
        disk.closed,
        [Closed {
            index: 0,
            bytes: part.len() as u64,
            duration_ms: 133,
            gaps: 0,
        }]
    );
    assert_eq!(boxes(part).last().map(|b| b.kind), Some(&b"mfra"[..]));
}

#[test]
fn a_part_closes_before_passing_its_bound_and_the_next_starts_at_a_keyframe() {
    let limit = 4_000;
    let mut a = Assembler::new(5, limit, false);
    let mut out = Vec::new();
    let mut disk = Disk::default();
    for gop in 0..12u64 {
        let at = 1_000_000 + gop * 500_000;
        assert_eq!(
            a.frame(&picture(true, vec![gop as u8; 600]), at, &mut out),
            Ok(())
        );
        assert_eq!(
            a.frame(&picture(false, vec![9; 300]), at + 250_000, &mut out),
            Ok(())
        );
        disk.take(&mut out);
    }
    a.finish(&mut out);
    disk.take(&mut out);
    assert!(disk.parts.len() >= 3, "{} parts", disk.parts.len());
    let indexes: Vec<u32> = disk.closed.iter().map(|c| c.index).collect();
    assert_eq!(
        indexes,
        (5..5 + disk.parts.len() as u32).collect::<Vec<_>>()
    );
    let mut keyframes = Vec::new();
    for part in disk.parts.values() {
        assert!(part.len() as u64 <= limit, "a part of {} bytes", part.len());
        assert_eq!(tracks(part), 1);
        let frags = fragments(part);
        assert_eq!(frags[0][0].time, 0, "every part starts at zero");
        for f in frags {
            assert_eq!(
                f[0].flags[0], 0x0200_0000,
                "every fragment starts at a keyframe"
            );
            keyframes.push(f[0].payloads[0][0]);
        }
    }
    assert_eq!(
        keyframes,
        (0..12).collect::<Vec<u8>>(),
        "no group lost or repeated"
    );
}

#[test]
fn audio_joins_the_video_fragments_timed_by_its_own_packets() {
    let mut a = Assembler::new(0, 1 << 20, false);
    let mut out = Vec::new();
    let mut disk = Disk::default();
    // Audio before the first keyframe has no fragment to join.
    a.frame(&sound(0), 990_000, &mut out).ok();
    a.frame(&picture(true, vec![1; 50]), 1_000_000, &mut out)
        .ok();
    // Packets arrive with jitter; their 20 ms durations time them.
    for (i, jitter) in [0u64, 7_000, 2_000, 9_000, 1_000].into_iter().enumerate() {
        let at = 1_005_000 + i as u64 * 20_000 + jitter;
        a.frame(&sound(i as u8 + 1), at, &mut out).ok();
    }
    a.frame(&picture(true, vec![2; 50]), 1_100_000, &mut out)
        .ok();
    a.frame(&sound(9), 1_106_000, &mut out).ok();
    a.finish(&mut out);
    disk.take(&mut out);
    let part = &disk.parts[&0];
    assert_eq!(tracks(part), 2, "video and Opus");
    let frags = fragments(part);
    let audio = &frags[0][1];
    assert_eq!(audio.id, 2);
    assert_eq!(audio.time, 240, "5 ms after the keyframe, in 48 kHz");
    assert_eq!(audio.durations, [960; 5]);
    let firsts: Vec<u8> = audio.payloads.iter().map(|p| p[1]).collect();
    assert_eq!(firsts, [1, 2, 3, 4, 5]);
    assert_eq!(
        frags[1][1].time,
        240 + 5 * 960,
        "audio carries on across fragments"
    );
}

#[test]
fn audio_appearing_in_a_silent_part_starts_a_new_part_with_both_tracks() {
    let mut a = Assembler::new(0, 1 << 20, false);
    let mut out = Vec::new();
    let mut disk = Disk::default();
    a.frame(&picture(true, vec![1; 50]), 1_000_000, &mut out)
        .ok();
    a.frame(&picture(true, vec![2; 50]), 1_100_000, &mut out)
        .ok();
    a.frame(&sound(1), 1_110_000, &mut out).ok();
    a.frame(&picture(true, vec![3; 50]), 1_200_000, &mut out)
        .ok();
    a.finish(&mut out);
    disk.take(&mut out);
    let counts: Vec<usize> = disk.parts.values().map(|p| tracks(p)).collect();
    assert_eq!(counts, [1, 2]);
}

#[test]
fn after_a_gap_deltas_wait_for_a_keyframe_and_the_gap_is_counted() {
    let mut a = Assembler::new(0, 1 << 20, false);
    let mut out = Vec::new();
    let mut disk = Disk::default();
    a.frame(&picture(true, vec![1; 50]), 1_000_000, &mut out)
        .ok();
    a.frame(&picture(false, vec![2; 50]), 1_033_000, &mut out)
        .ok();
    a.gap(&mut out);
    a.frame(&picture(false, vec![3; 50]), 1_066_000, &mut out)
        .ok();
    a.frame(&picture(true, vec![4; 50]), 1_500_000, &mut out)
        .ok();
    a.finish(&mut out);
    disk.take(&mut out);
    let frags = fragments(&disk.parts[&0]);
    let payloads: Vec<u8> = frags
        .iter()
        .flat_map(|f| f[0].payloads.iter().map(|p| p[0]))
        .collect();
    assert_eq!(
        payloads,
        [1, 2, 4],
        "the delta after the gap is never written"
    );
    assert_eq!(frags[1][0].time, 45_000, "the gap keeps its time");
    assert_eq!(disk.closed[0].gaps, 1);
}

#[test]
fn a_cut_starts_the_next_part_at_the_next_keyframe() {
    let mut a = Assembler::new(0, 1 << 20, false);
    let mut out = Vec::new();
    let mut disk = Disk::default();
    a.frame(&picture(true, vec![1; 50]), 1_000_000, &mut out)
        .ok();
    a.cut();
    a.frame(&picture(false, vec![2; 50]), 1_033_000, &mut out)
        .ok();
    a.frame(&picture(true, vec![3; 50]), 1_066_000, &mut out)
        .ok();
    a.finish(&mut out);
    disk.take(&mut out);
    let firsts: Vec<Vec<u8>> = disk
        .parts
        .values()
        .map(|p| {
            fragments(p)
                .iter()
                .flat_map(|f| f[0].payloads.iter().map(|x| x[0]).collect::<Vec<_>>())
                .collect()
        })
        .collect();
    assert_eq!(firsts, [vec![1, 2], vec![3]]);
}

#[test]
fn pointer_lines_share_the_part_time_base_and_wait_for_a_part() {
    let mut a = Assembler::new(0, 1 << 20, true);
    let mut out = Vec::new();
    let mut disk = Disk::default();
    a.meta(900_000, 1, &serde_json::json!({ "x": 1 }), &mut out);
    a.frame(&picture(true, vec![1; 50]), 1_000_000, &mut out)
        .ok();
    a.frame(&picture(true, vec![2; 50]), 1_100_000, &mut out)
        .ok();
    a.meta(1_250_000, 2, &serde_json::json!({ "x": 2 }), &mut out);
    a.finish(&mut out);
    disk.take(&mut out);
    assert_eq!(
        disk.lines[&0],
        [
            r#"{"data":{"x":1},"epoch":1,"t":0}"#,
            r#"{"data":{"x":2},"epoch":2,"t":250}"#
        ]
    );
}

#[test]
fn pictures_mp4_cannot_hold_end_the_recording() {
    let mut a = Assembler::new(0, 1 << 20, false);
    let jpeg = MediaFrame {
        codec: 7,
        ..picture(true, vec![0xff, 0xd8])
    };
    assert_eq!(a.frame(&jpeg, 0, &mut Vec::new()), Err("unsupported-codec"));
}
