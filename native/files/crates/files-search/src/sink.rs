// SPDX-License-Identifier: Apache-2.0

//! Searches one file and streams what it found to the caller's sink.

use std::io;
use std::path::Path;
use std::sync::atomic::Ordering;

use grep_matcher::Matcher;
use grep_searcher::{Searcher, Sink, SinkMatch};

use crate::preview;
use crate::result::{FileMatches, LineMatch};
use crate::walk::Shared;

/// Searches one file the walker handed over.
///
/// A file that cannot be read, changes while the walk runs, or looks binary is skipped: one bad
/// file in a checkout must not fail the whole search.
pub(crate) fn search_file(searcher: &mut Searcher, shared: &Shared<'_>, path: &Path) {
    let Some(relative) = shared.root.relative(path) else {
        return;
    };
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    if !metadata.is_file() {
        return;
    }
    let size = metadata.len();
    if shared.max_file_bytes > 0 && size > shared.max_file_bytes {
        return;
    }
    let mut sink = FileSink::new(shared);
    if searcher
        .search_path(&shared.matcher, path, &mut sink)
        .is_err()
    {
        return;
    }
    if shared.cancel.load(Ordering::SeqCst) {
        return;
    }
    shared.bytes.fetch_add(size, Ordering::Relaxed);
    if sink.binary || sink.lines.is_empty() {
        return;
    }
    shared.files.fetch_add(1, Ordering::Relaxed);
    if !(shared.sink)(FileMatches {
        path: relative,
        lines: sink.lines,
    }) {
        shared.stop.store(true, Ordering::SeqCst);
    }
}

/// Collects the matching lines of the file being searched.
struct FileSink<'a> {
    shared: &'a Shared<'a>,
    lines: Vec<LineMatch>,
    binary: bool,
}

impl<'a> FileSink<'a> {
    fn new(shared: &'a Shared<'a>) -> FileSink<'a> {
        FileSink {
            shared,
            lines: Vec::new(),
            binary: false,
        }
    }
}

impl Sink for FileSink<'_> {
    type Error = io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        matched: &SinkMatch<'_>,
    ) -> Result<bool, io::Error> {
        if self.binary || self.shared.halted() {
            return Ok(false);
        }
        let Some(line) = matched.line_number() else {
            return Ok(true);
        };
        let bytes = matched.bytes();
        let shared = self.shared;
        let mut spans = Vec::new();
        let mut capped = false;
        let scanned = shared.matcher.find_iter(bytes, |found| {
            if shared.reserve() {
                spans.push(found.start()..found.end());
                true
            } else {
                capped = true;
                false
            }
        });
        if scanned.is_err() || spans.is_empty() {
            return Ok(!capped);
        }
        let (text, ranges) = preview::preview(bytes, &spans);
        self.lines.push(LineMatch {
            line,
            preview: text,
            ranges,
        });
        Ok(!capped)
    }

    fn binary_data(&mut self, _searcher: &Searcher, _offset: u64) -> Result<bool, io::Error> {
        self.binary = true;
        Ok(false)
    }
}
