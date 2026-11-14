// SPDX-License-Identifier: Apache-2.0
//! The recorder's thin I/O: parts as files in the recording's directory, and recovery of the
//! parts a crashed process left there.
//!
//! - Part `n` is `part-<n>.mp4` (four digits), with its pointer track in `part-<n>.jsonl`.
//! - Each fragment is one `write` of the file, unbuffered, so a process killed at any moment
//!   leaves every earlier fragment in the file. A part is synced when it closes.
//! - On `record.start` the directory's parts are read: one that a crash cut off is truncated
//!   to its last whole fragment (`media_mp4::recovery_prefix_by`), one with no fragment is
//!   removed, and the recording continues in the next part. Every part found is reported, so
//!   the daemon knows of the one the crash cut before it heard `record.part`.
use super::assemble::{Assembler, Closed, Out};
use crate::engine::recorder::{RecordSpec, Recorder, Recorders, Started};
use media_wire::control::{Part, Sequence};
use media_wire::frame::MediaFrame;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const VIDEO_HZ: u64 = 90_000;

/// Writes recordings as fragmented MP4 straight from the encoded stream.
pub struct Mp4Recorders;

impl Recorders for Mp4Recorders {
    fn start(&mut self, spec: &RecordSpec<'_>) -> Result<Started, String> {
        let dir = PathBuf::from(spec.directory);
        if !dir.is_absolute() {
            return Err("directory-invalid".into());
        }
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(|e| format!("directory: {}", e.kind()))?;
        let recovered = recover(&dir)?;
        let next = recovered.iter().map(|p| p.index + 1).max().unwrap_or(0);
        let mut assembler = Assembler::new(next, spec.max_bytes, spec.pointer_track);
        if !recovered.is_empty() {
            // What the previous process held when it ended is lost.
            assembler.gap(&mut Vec::new());
        }
        Ok(Started {
            recorder: Box::new(FileRecorder {
                dir,
                pointer: spec.pointer_track,
                assembler,
                open: None,
                parts: Vec::new(),
                out: Vec::new(),
            }),
            recovered,
        })
    }
}

struct Open {
    index: u32,
    path: PathBuf,
    file: File,
    track: Option<File>,
}

struct FileRecorder {
    dir: PathBuf,
    pointer: bool,
    assembler: Assembler,
    open: Option<Open>,
    parts: Vec<Part>,
    out: Vec<Out>,
}

fn name(index: u32, extension: &str) -> String {
    format!("part-{index:04}.{extension}")
}

fn create(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("part: {}", e.kind()))
}

fn part(path: &Path, index: u32, bytes: u64, duration_ms: u64, gaps: u32) -> Part {
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

impl FileRecorder {
    fn apply(&mut self, closed: &mut Vec<Part>) -> Result<(), String> {
        for out in std::mem::take(&mut self.out) {
            match out {
                Out::Open { index } => {
                    let path = self.dir.join(name(index, "mp4"));
                    let file = create(&path)?;
                    let track = if self.pointer {
                        Some(create(&self.dir.join(name(index, "jsonl")))?)
                    } else {
                        None
                    };
                    self.open = Some(Open {
                        index,
                        path,
                        file,
                        track,
                    });
                }
                Out::Bytes(bytes) => {
                    if let Some(open) = &mut self.open {
                        open.file
                            .write_all(&bytes)
                            .map_err(|e| format!("write: {}", e.kind()))?;
                    }
                }
                Out::Line(line) => {
                    if let Some(track) = self.open.as_mut().and_then(|o| o.track.as_mut()) {
                        track
                            .write_all(format!("{line}\n").as_bytes())
                            .map_err(|e| format!("write: {}", e.kind()))?;
                    }
                }
                Out::Close(Closed {
                    index,
                    bytes,
                    duration_ms,
                    gaps,
                }) => {
                    let Some(open) = self.open.take() else {
                        continue;
                    };
                    debug_assert_eq!(open.index, index);
                    open.file
                        .sync_all()
                        .map_err(|e| format!("sync: {}", e.kind()))?;
                    if let Some(track) = &open.track {
                        let _ = track.sync_all();
                    }
                    let done = part(&open.path, index, bytes, duration_ms, gaps);
                    self.parts.push(done.clone());
                    closed.push(done);
                }
            }
        }
        Ok(())
    }
}

impl Recorder for FileRecorder {
    fn write(
        &mut self,
        frame: &MediaFrame,
        captured_us: u64,
        closed: &mut Vec<Part>,
    ) -> Result<(), String> {
        self.assembler
            .frame(frame, captured_us, &mut self.out)
            .map_err(str::to_owned)?;
        self.apply(closed)
    }

    fn gap(&mut self, closed: &mut Vec<Part>) -> Result<(), String> {
        self.assembler.gap(&mut self.out);
        self.apply(closed)
    }

    fn cut(&mut self) {
        self.assembler.cut();
    }

    fn meta(&mut self, at_us: u64, epoch: u32, data: &serde_json::Value) -> Result<(), String> {
        self.assembler.meta(at_us, epoch, data, &mut self.out);
        let mut closed = Vec::new();
        self.apply(&mut closed)
    }

    fn finish(mut self: Box<Self>) -> Result<Vec<Part>, String> {
        self.assembler.finish(&mut self.out);
        let mut closed = Vec::new();
        self.apply(&mut closed)?;
        Ok(self.parts)
    }
}

/// Makes every part in `dir` playable and lists them, in index order.
fn recover(dir: &Path) -> Result<Vec<Part>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("directory: {}", e.kind()))?;
    let mut indexes: Vec<u32> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let digits = name.strip_prefix("part-")?.strip_suffix(".mp4")?;
            (digits.len() == 4 && digits.bytes().all(|b| b.is_ascii_digit()))
                .then(|| digits.parse().ok())?
        })
        .collect();
    indexes.sort_unstable();
    let mut parts = Vec::new();
    for index in indexes {
        let path = dir.join(name(index, "mp4"));
        match recover_part(&path) {
            Ok(Some((bytes, duration_ms))) => parts.push(part(&path, index, bytes, duration_ms, 0)),
            Ok(None) => {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(dir.join(name(index, "jsonl")));
            }
            Err(reason) => return Err(reason),
        }
    }
    Ok(parts)
}

/// Truncates one part to its last whole fragment. Its size and duration then, or `None` when
/// it holds no fragment (nothing playable).
fn recover_part(path: &Path) -> Result<Option<(u64, u64)>, String> {
    let io = |e: std::io::Error| format!("recover: {}", e.kind());
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(io)?;
    let length = file.metadata().map_err(io)?.len();
    let mut read = |at: u64, buf: &mut [u8]| -> Option<()> {
        file.seek(SeekFrom::Start(at)).ok()?;
        file.read_exact(buf).ok()
    };
    let prefix = media_mp4::recovery_prefix_by(length, |at| {
        let mut h = [0u8; 8];
        read(at, &mut h).map(|()| h)
    });
    let Ok(prefix) = prefix else {
        return Ok(None);
    };
    let Some((at, size)) = prefix.last_moof else {
        return Ok(None);
    };
    let mut moof = vec![0u8; size as usize];
    let end = read(at, &mut moof)
        .and_then(|()| media_mp4::fragment_end(&moof, 1))
        .unwrap_or(0);
    if !prefix.finished && prefix.length < length {
        file.set_len(prefix.length).map_err(io)?;
        file.sync_all().map_err(io)?;
    }
    let bytes = if prefix.finished {
        length
    } else {
        prefix.length
    };
    Ok(Some((bytes, end * 1_000 / VIDEO_HZ)))
}
