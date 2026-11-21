// SPDX-License-Identifier: Apache-2.0

//! `readHeadTail`: the first and last 64 KiB of a transcript, decoded line by line.

use std::path::Path;

use history_text::js;
use serde_json::Value;

use super::stat::{fingerprint, mtime_ms};
use super::{read_at, safe_open};
use crate::cancel::Cancel;
use crate::error::{CHANGED_WHILE, Error, Result};

const WINDOW: u64 = 64 * 1024;
const EXACT: u64 = 128 * 1024;

#[derive(Debug)]
pub struct Sample {
    pub records: Vec<Value>,
    /// How many of `records` came from the head window.
    pub head_count: usize,
    /// The whole file was small enough to decode, and every line decoded.
    pub exact: bool,
    pub bytes: u64,
    pub fingerprint: String,
    /// `Math.floor(mtimeMs)`.
    pub mtime: i64,
}

fn lines(bytes: &[u8], records: &mut Vec<Value>) -> bool {
    crate::hooks::decoding(bytes);
    let text = String::from_utf8_lossy(bytes);
    let mut failed = false;
    for line in text.split('\n') {
        if js::trim(line).is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(value) => records.push(value),
            Err(_) => failed = true,
        }
    }
    failed
}

pub fn read_head_tail(home: &Path, path: &Path, cancel: &Cancel) -> Result<Sample> {
    let file = safe_open(home, path)?;
    cancel.check()?;
    let before = file.metadata()?;
    let size = before.len();
    let mut head = vec![0u8; size.min(WINDOW) as usize];
    let tail_start = (head.len() as u64).max(size.saturating_sub(WINDOW));
    let mut tail = vec![0u8; (size - tail_start) as usize];
    read_at(&file, &mut head, 0)?;
    if !tail.is_empty() {
        read_at(&file, &mut tail, tail_start)?;
    }
    if fingerprint(&before) != fingerprint(&file.metadata()?) {
        return Err(Error::message(CHANGED_WHILE));
    }
    cancel.check()?;
    let mut records = Vec::new();
    let mut failed;
    let head_count;
    // When the two windows meet, decode as one so a crossing line is not lost.
    if tail_start == head.len() as u64 {
        let mut joined = head.clone();
        joined.extend_from_slice(&tail);
        failed = lines(&joined, &mut records);
        head_count = records.len();
    } else {
        failed = lines(&head, &mut records);
        head_count = records.len();
        let from = tail.iter().position(|b| *b == b'\n').map_or(0, |i| i + 1);
        failed |= lines(&tail[from..], &mut records);
    }
    if records.is_empty() && size <= EXACT {
        let mut joined = head.clone();
        joined.extend_from_slice(&tail);
        if let Some(value) = super::jsonl::decode(&joined) {
            records.push(value);
            failed = false;
        }
    }
    Ok(Sample {
        records,
        head_count,
        exact: size <= EXACT && !failed,
        bytes: head.len() as u64 + tail.len() as u64,
        fingerprint: fingerprint(&before),
        mtime: mtime_ms(&before).floor() as i64,
    })
}
