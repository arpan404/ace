// SPDX-License-Identifier: Apache-2.0

//! Bounded reads of provider files: safe opens inside a registered home, inventory walks, and
//! streaming JSONL in 64 KiB buffers (`@ace/native-session`).

mod jsonl;
mod open;
mod sample;
pub mod stat;
mod walk;

pub use jsonl::{JsonLines, RECORD_LIMIT, RecordKind, read_range};
pub use open::safe_open;
pub use sample::read_head_tail;
pub use walk::{Budget, walk_files};

/// Read until `buffer` is full or the file ends; returns the bytes read.
pub fn read_at(file: &std::fs::File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    let mut done = 0;
    while done < buffer.len() {
        let read = read_once(file, &mut buffer[done..], offset + done as u64)?;
        if read == 0 {
            break;
        }
        done += read;
    }
    Ok(done)
}

/// One read at `offset`, which may return fewer bytes than asked.
pub fn read_once_public(
    file: &std::fs::File,
    buffer: &mut [u8],
    offset: u64,
) -> std::io::Result<usize> {
    read_once(file, buffer, offset)
}

#[cfg(unix)]
fn read_once(file: &std::fs::File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buffer, offset)
}

#[cfg(windows)]
fn read_once(file: &std::fs::File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buffer, offset)
}
