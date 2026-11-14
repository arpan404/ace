// SPDX-License-Identifier: Apache-2.0
//! The recorder's thin I/O: parts as files in the recording's private directory.
//!
//! - Part `n` is `part-<n>.mp4` (at least four digits), with its pointer track in
//!   `part-<n>.jsonl`. Files are created new, owner-only, never through a symlink.
//! - Each fragment is one `write` of the file, unbuffered, so a process killed at any moment
//!   leaves every earlier fragment in the file. A part is synced when it closes.
//! - On `record.start` the parts a crash left are made playable ([`super::recover`]) and every
//!   one is reported, so the daemon knows of the one the crash cut before it heard
//!   `record.part`; the recording continues in the next part.
use super::assemble::{Assembler, Closed, Out};
use super::recover::{name, part, private_directory, recover};
use crate::engine::recorder::{RecordSpec, Recorder, Recorders, Started};
use media_wire::control::Part;
use media_wire::frame::MediaFrame;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// Writes recordings as fragmented MP4 straight from the encoded stream.
pub struct Mp4Recorders;

impl Recorders for Mp4Recorders {
    fn start(&mut self, spec: &RecordSpec<'_>) -> Result<Started, String> {
        let dir = PathBuf::from(spec.directory);
        if !dir.is_absolute() {
            return Err("directory-invalid".into());
        }
        private_directory(&dir)?;
        let (recovered, next) = recover(&dir)?;
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

fn create(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| format!("part: {}", e.kind()))
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
                Out::Discard { index } => {
                    // A part that never got a fragment: nothing in it plays.
                    if let Some(open) = self.open.take() {
                        debug_assert_eq!(open.index, index);
                        let _ = std::fs::remove_file(&open.path);
                        if open.track.is_some() {
                            let _ = std::fs::remove_file(self.dir.join(name(index, "jsonl")));
                        }
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
