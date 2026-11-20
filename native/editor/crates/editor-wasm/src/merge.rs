// SPDX-License-Identifier: Apache-2.0

//! The three-way merge of an unsaved buffer with its file on disk.

use editor_core::MergeChunk;
use wasm_bindgen::prelude::*;

/// Merges `mine` and `theirs`, both edits of `base`, as one flat list of strings: each chunk
/// is a tag followed by its texts, `"clean", text` or `"conflict", base, mine, theirs`, in
/// reading order. A list with no `"conflict"` tag is a clean merge.
#[wasm_bindgen(js_name = merge3)]
pub fn merge3(base: &str, mine: &str, theirs: &str) -> Vec<String> {
    let chunks = editor_core::merge3(base, mine, theirs).into_chunks();
    let mut flat = Vec::with_capacity(chunks.len() * 2);
    for chunk in chunks {
        match chunk {
            MergeChunk::Clean(text) => {
                flat.push("clean".to_owned());
                flat.push(text);
            }
            MergeChunk::Conflict { base, mine, theirs } => {
                flat.push("conflict".to_owned());
                flat.push(base);
                flat.push(mine);
                flat.push(theirs);
            }
        }
    }
    flat
}

/// Whole-line changes turning one text into another: `ranges` holds `(start, end)` line pairs
/// of the old text and `texts` the new lines for each, in order.
#[wasm_bindgen]
#[derive(Clone, Debug, Default)]
pub struct LineChanges {
    ranges: Vec<u32>,
    texts: Vec<String>,
}

#[wasm_bindgen]
impl LineChanges {
    /// `(start line, end line)` pairs, 0-based, end exclusive, in the old text.
    #[wasm_bindgen(getter)]
    pub fn ranges(&self) -> Vec<u32> {
        self.ranges.clone()
    }

    /// The new lines replacing each range, with their endings.
    #[wasm_bindgen(getter)]
    pub fn texts(&self) -> Vec<String> {
        self.texts.clone()
    }
}

/// How to turn `before` into `after` by whole lines, one change per changed block.
#[wasm_bindgen(js_name = lineChanges)]
pub fn line_changes(before: &str, after: &str) -> LineChanges {
    let changes = editor_core::line_changes(before, after);
    let mut flat = LineChanges {
        ranges: Vec::with_capacity(changes.len() * 2),
        texts: Vec::with_capacity(changes.len()),
    };
    for change in changes {
        flat.ranges.push(change.start);
        flat.ranges.push(change.end);
        flat.texts.push(change.text);
    }
    flat
}
