// SPDX-License-Identifier: Apache-2.0
//! What a crashed process left in a recording's directory, made playable.
//!
//! - Only parts this recorder wrote are touched: regular files named `part-<n>.mp4` that start
//!   with its own `ftyp` (`media_mp4::FILE_TYPE`). Anything else is left alone, though its
//!   number is never reused.
//! - Files are opened without following symlinks.
//! - A part a crash cut is truncated to its last whole fragment, and its pointer track to the
//!   lines inside that fragment's time; a part with no fragment is removed with its track.
use media_wire::control::{Part, Sequence};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

const VIDEO_HZ: u64 = 90_000;

pub fn name(index: u32, extension: &str) -> String {
    format!("part-{index:04}.{extension}")
}

/// The part number of a file name this recorder could have written.
pub fn index_of(name: &str) -> Option<u32> {
    let digits = name.strip_prefix("part-")?.strip_suffix(".mp4")?;
    if digits.len() < 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

pub fn part(path: &Path, index: u32, bytes: u64, duration_ms: u64, gaps: u32) -> Part {
    let sequence =
        |n: u64| Sequence::new(n.min(9_007_199_254_740_991)).unwrap_or_else(|_| unreachable!());
    Part {
        path: path.to_string_lossy().into_owned(),
        index,
        bytes: sequence(bytes),
        duration_ms: sequence(duration_ms),
        gaps,
    }
}

fn open(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

/// Makes `dir` the recording's private directory: created 0700 if absent; an existing one
/// must be a real directory of this user, and is tightened to 0700.
pub fn private_directory(dir: &Path) -> Result<(), String> {
    std::os::unix::fs::DirBuilderExt::mode(std::fs::DirBuilder::new().recursive(true), 0o700)
        .create(dir)
        .map_err(|e| format!("directory: {}", e.kind()))?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("directory: {}", e.kind()))?;
    if !meta.file_type().is_dir() {
        return Err("directory-invalid".into());
    }
    if crate::os::private_dir(dir).is_ok() {
        return Ok(());
    }
    // Ours but too open: tighten it. Another user's directory can't be changed, and fails.
    if meta.mode() & 0o777 != 0o700 {
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    crate::os::private_dir(dir).map_err(|_| "directory-invalid".into())
}

/// Every part of ours in `dir`, made playable, in index order, and the next free index.
pub fn recover(dir: &Path) -> Result<(Vec<Part>, u32), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("directory: {}", e.kind()))?;
    let mut found: Vec<(u32, bool)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let index = index_of(e.file_name().to_str()?)?;
            let regular = e.file_type().is_ok_and(|t| t.is_file());
            Some((index, regular))
        })
        .collect();
    found.sort_unstable();
    let next = found
        .iter()
        .map(|&(i, _)| i.saturating_add(1))
        .max()
        .unwrap_or(0);
    let mut parts = Vec::new();
    for (index, regular) in found {
        if !regular {
            continue;
        }
        let path = dir.join(name(index, "mp4"));
        let track = dir.join(name(index, "jsonl"));
        match recover_part(&path)? {
            Recovered::Foreign => {}
            Recovered::Empty => {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(&track);
            }
            Recovered::Kept { bytes, duration_ms } => {
                trim_track(&track, duration_ms)?;
                parts.push(part(&path, index, bytes, duration_ms, 0));
            }
        }
    }
    Ok((parts, next))
}

enum Recovered {
    /// Not a part this recorder wrote.
    Foreign,
    /// Ours, with no whole fragment.
    Empty,
    Kept {
        bytes: u64,
        duration_ms: u64,
    },
}

fn recover_part(path: &Path) -> Result<Recovered, String> {
    let io = |e: std::io::Error| format!("recover: {}", e.kind());
    let Ok(mut file) = open(path) else {
        return Ok(Recovered::Foreign);
    };
    let length = file.metadata().map_err(io)?.len();
    let mut read = |at: u64, buf: &mut [u8]| -> Option<()> {
        file.seek(SeekFrom::Start(at)).ok()?;
        file.read_exact(buf).ok()
    };
    let mut head = [0u8; 24];
    if read(0, &mut head).is_none() || head != media_mp4::FILE_TYPE {
        return Ok(Recovered::Foreign);
    }
    let prefix = media_mp4::recovery_prefix_by(length, |at| {
        let mut h = [0u8; 8];
        read(at, &mut h).map(|()| h)
    });
    let Ok(prefix) = prefix else {
        // Our header and a cut-off movie box: nothing in it ever played.
        return Ok(Recovered::Empty);
    };
    let Some((at, size)) = prefix.last_moof else {
        return Ok(Recovered::Empty);
    };
    let mut moof = vec![0u8; size as usize];
    let end = read(at, &mut moof)
        .and_then(|()| media_mp4::fragment_end(&moof, 1))
        .unwrap_or(0);
    if !prefix.finished && prefix.length < length {
        file.set_len(prefix.length).map_err(io)?;
        file.sync_all().map_err(io)?;
    }
    Ok(Recovered::Kept {
        bytes: if prefix.finished {
            length
        } else {
            prefix.length
        },
        duration_ms: end * 1_000 / VIDEO_HZ,
    })
}

/// Keeps the pointer track's whole lines that fall inside the part's recovered time.
fn trim_track(path: &Path, duration_ms: u64) -> Result<(), String> {
    let io = |e: std::io::Error| format!("recover: {}", e.kind());
    let Ok(mut file) = open(path) else {
        return Ok(());
    };
    let mut text = Vec::new();
    file.read_to_end(&mut text).map_err(io)?;
    let mut kept = Vec::with_capacity(text.len());
    let whole = text.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    for line in text[..whole]
        .split(|&b| b == b'\n')
        .filter(|l| !l.is_empty())
    {
        let at = serde_json::from_slice::<serde_json::Value>(line)
            .ok()
            .and_then(|v| v.get("t").and_then(serde_json::Value::as_u64));
        if at.is_some_and(|t| t <= duration_ms) {
            kept.extend_from_slice(line);
            kept.push(b'\n');
        }
    }
    if kept.len() != text.len() {
        file.set_len(0).map_err(io)?;
        file.seek(SeekFrom::Start(0)).map_err(io)?;
        file.write_all(&kept).map_err(io)?;
        file.sync_all().map_err(io)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "recover_tests.rs"]
mod tests;
