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
