// SPDX-License-Identifier: Apache-2.0

//! Builds the short, lossy-UTF-8 preview a matching line carries.

use std::ops::Range;

/// The most bytes of source text one preview carries.
pub(crate) const PREVIEW_BYTES: usize = 400;

/// The leading padding kept before the first match on a line too long to show whole.
const LEAD: usize = PREVIEW_BYTES / 5;

/// A preview of `line`, plus each match's byte range inside that preview.
///
/// Long lines are cut to [`PREVIEW_BYTES`] around the first match on them, on UTF-8 boundaries,
/// so a minified file cannot stall the search with megabytes of preview text.
pub(crate) fn preview(line: &[u8], spans: &[Range<usize>]) -> (String, Vec<(u32, u32)>) {
    let line = trim_terminator(line);
    let window = window(line, spans);
    let text = String::from_utf8_lossy(&line[window.clone()]).into_owned();
    let mut ranges = Vec::with_capacity(spans.len());
    for span in spans {
        // A span that only touches the window's edge shows no text; keeping it would add an
        // empty range that points at nothing. A zero-width match survives only inside the window.
        if span.end <= window.start || span.start >= window.end {
            continue;
        }
        let start = span.start.max(window.start);
        let end = span.end.min(window.end);
        let from = lossy_len(&line[window.start..start]);
        let to = from + lossy_len(&line[start..end]);
        ranges.push((from as u32, to as u32));
    }
    (text, ranges)
}

/// The stretch of `line` a preview keeps: the whole line when it is short.
fn window(line: &[u8], spans: &[Range<usize>]) -> Range<usize> {
    if line.len() <= PREVIEW_BYTES {
        return 0..line.len();
    }
    let anchor = spans.first().map_or(0, |span| span.start);
    let mut start = anchor.saturating_sub(LEAD).min(line.len() - PREVIEW_BYTES);
    let mut end = start + PREVIEW_BYTES;
    while start < end && is_continuation(line[start]) {
        start += 1;
    }
    while end > start && end < line.len() && is_continuation(line[end]) {
        end -= 1;
    }
    start..end
}

/// Drops the line terminator, which is never part of a preview.
fn trim_terminator(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    if end > 0 && line[end - 1] == b'\n' {
        end -= 1;
    }
    if end > 0 && line[end - 1] == b'\r' {
        end -= 1;
    }
    &line[..end]
}

/// The byte length of `bytes` once invalid UTF-8 is replaced, as the preview reports it.
fn lossy_len(bytes: &[u8]) -> usize {
    String::from_utf8_lossy(bytes).len()
}

/// Whether `byte` continues a multi-byte UTF-8 character.
fn is_continuation(byte: u8) -> bool {
    byte & 0xC0 == 0x80
}
