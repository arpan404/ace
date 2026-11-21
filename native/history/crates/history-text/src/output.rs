// SPDX-License-Identifier: Apache-2.0

//! `summarizeOutput` (`packages/projection/src/delta.ts`) for a whole output: its byte count and
//! the last 4 KiB, budgeted in JSON-escaped bytes.

/// A shell call's output summary, as the projection stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputSummary {
    pub stream_id: String,
    pub bytes: usize,
    pub tail: String,
    pub truncated: bool,
}

/// `outputStreamId`.
pub fn output_stream_id(item_id: &str) -> String {
    format!("output:{item_id}")
}

const BUDGET: usize = 4096;

/// What one character costs in the transport budget: JSON escapes expand controls sixfold.
fn cost(c: char) -> usize {
    match c {
        '"' | '\\' => 2,
        '\u{8}' | '\t' | '\n' | '\u{C}' | '\r' => 2,
        c if (c as u32) < 32 => 6,
        c => c.len_utf8(),
    }
}

/// `summarizeOutput(itemId, text)` with no earlier output.
pub fn summarize_output(item_id: &str, text: &str) -> OutputSummary {
    let mut start = text.len();
    let mut size = 0;
    for (offset, c) in text.char_indices().rev() {
        if size + cost(c) > BUDGET {
            break;
        }
        size += cost(c);
        start = offset;
    }
    let mut tail = &text[start..];
    // A decoded run drops one leading byte-order mark, as the projection's decoder does.
    if let Some(rest) = tail.strip_prefix('\u{FEFF}') {
        tail = rest;
    }
    OutputSummary {
        stream_id: output_stream_id(item_id),
        bytes: text.len(),
        tail: tail.to_owned(),
        truncated: text.len() > tail.len(),
    }
}
