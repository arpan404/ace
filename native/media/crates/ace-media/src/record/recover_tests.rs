// SPDX-License-Identifier: Apache-2.0
//! Recovery against a real directory, with parts the assembler wrote.
use super::*;
use crate::record::assemble::{Assembler, Out};
use media_wire::frame::MediaFrame;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

fn dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("am-recover-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        panic!("{e}");
    }
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    dir
}

fn picture(key: bool, at: u8) -> MediaFrame {
    let fixture = include_bytes!("../../../media-mp4/tests/vectors/h264.bin");
    let n = u32::from_be_bytes([fixture[0], fixture[1], fixture[2], fixture[3]]) as usize;
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
        codec: 2,
        encode: 0,
        epoch: 1,
        codec_string: String::new(),
        description: if key {
            fixture[4..4 + n].to_vec()
        } else {
            Vec::new()
        },
        extension: Vec::new(),
        payload: vec![at; 500],
    }
}

/// The bytes of one part with `groups` whole fragments and the start of one more, as a
/// process killed mid-write leaves it, and its pointer track with a line per group.
fn crashed_part(groups: u8) -> (Vec<u8>, String) {
    let mut a = Assembler::new(0, 1 << 20, true);
    let mut out = Vec::new();
    for g in 0..=groups {
        let at = 1_000_000 + u64::from(g) * 1_000_000;
        let _ = a.frame(&picture(true, g), at, &mut out);
        a.meta(at + 500_000, 1, &serde_json::json!({ "g": g }), &mut out);
    }
    let mut file = Vec::new();
    let mut lines = String::new();
    for o in out {
        match o {
            Out::Bytes(b) => file.extend(b),
            Out::Line(l) => lines.push_str(&format!("{l}\n")),
            _ => {}
        }
    }
    // Half of the next fragment reached the disk, and half a line.
    file.extend_from_slice(&[0, 0, 0x10, 0, b'm', b'o', b'o', b'f', 1, 2, 3]);
    lines.push_str("{\"t\":99");
    (file, lines)
}

#[test]
fn a_cut_part_keeps_its_whole_fragments_and_the_pointer_lines_inside_them() {
    let d = dir("cut");
    let (file, lines) = crashed_part(3);
    let path = d.join(name(0, "mp4"));
    let _ = std::fs::write(&path, &file);
    let _ = std::fs::write(d.join(name(0, "jsonl")), &lines);
    let Ok((parts, next)) = recover(&d) else {
        panic!("recover failed");
    };
    assert_eq!(next, 1);
    assert_eq!(parts.len(), 1);
    let kept = std::fs::read(&path).unwrap_or_default();
    assert_eq!(parts[0].bytes.get(), kept.len() as u64);
    assert_eq!(kept.len(), file.len() - 11, "the partial fragment is gone");
    assert_eq!(media_mp4::recovery_prefix(&kept), Ok(kept.len()));
    // Groups 0, 1 and 2 were written whole, ending at 3 s (group 3 was still open): the
    // lines at 0.5, 1.5 and 2.5 s stay, the one at 3.5 s and the half line go.
    assert_eq!(parts[0].duration_ms.get(), 3_000);
    let track = std::fs::read_to_string(d.join(name(0, "jsonl"))).unwrap_or_default();
    let ts: Vec<u64> = track
        .lines()
        .filter_map(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .ok()?
                .get("t")?
                .as_u64()
        })
        .collect();
    assert_eq!(
        ts,
        [500, 1_500, 2_500],
        "lines past the last fragment and half lines go"
    );
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn only_our_own_parts_are_touched_and_their_numbers_never_reused() {
    let d = dir("foreign");
    let foreign = d.join(name(3, "mp4"));
    let _ = std::fs::write(&foreign, b"not a part of ours");
    // A symlink named like a part, to a file outside: never followed, never truncated.
    let outside = d.join("outside.mp4");
    let (file, _) = crashed_part(2);
    let _ = std::fs::write(&outside, &file);
    let _ = std::os::unix::fs::symlink(&outside, d.join(name(7, "mp4")));
    // Ours with nothing playable: removed with its track.
    let empty = {
        let mut a = Assembler::new(0, 1 << 20, false);
        let mut out = Vec::new();
        let _ = a.frame(&picture(true, 0), 1_000_000, &mut out);
        a.finish(&mut out);
        let init: Vec<u8> = match out.get(1) {
            Some(Out::Bytes(b)) => b.clone(),
            _ => panic!("no init"),
        };
        init
    };
    let _ = std::fs::write(d.join(name(12_345, "mp4")), &empty);
    let _ = std::fs::write(d.join(name(12_345, "jsonl")), b"{}\n");
    let Ok((parts, next)) = recover(&d) else {
        panic!("recover failed");
    };
    assert!(parts.is_empty());
    assert_eq!(next, 12_346, "five-digit parts count");
    assert_eq!(
        std::fs::read(&foreign).unwrap_or_default(),
        b"not a part of ours"
    );
    assert_eq!(
        std::fs::read(&outside).unwrap_or_default(),
        file,
        "the symlink's target"
    );
    assert!(!d.join(name(12_345, "mp4")).exists());
    assert!(!d.join(name(12_345, "jsonl")).exists());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_recording_directory_is_made_private_and_a_symlink_is_refused() {
    let d = dir("private");
    let open = d.join("open");
    let _ = std::fs::create_dir(&open);
    let _ = std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755));
    assert_eq!(private_directory(&open), Ok(()));
    let mode = std::fs::metadata(&open).map(|m| m.permissions().mode() & 0o777);
    assert_eq!(mode.ok(), Some(0o700));
    let link = d.join("link");
    let _ = std::os::unix::fs::symlink(&open, &link);
    assert_eq!(private_directory(&link), Err("directory-invalid".into()));
    let fresh = d.join("a/b");
    assert_eq!(private_directory(&fresh), Ok(()));
    let _ = std::fs::remove_dir_all(&d);
}
