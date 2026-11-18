// SPDX-License-Identifier: Apache-2.0

//! The applied-edit result JavaScript reads.

use wasm_bindgen::prelude::*;

/// What a highlighter and the view need after an edit.
///
/// `spans` holds `(first line, removed lines, inserted lines)` triples in post-edit coordinates,
/// in document order: exactly the arguments for a line highlighter's `edit` call, top to bottom.
/// `version` is the document version after the edit, so a client can discard stale results.
#[wasm_bindgen]
#[derive(Clone, Debug, Default)]
pub struct Applied {
    version: f64,
    spans: Vec<u32>,
}

#[wasm_bindgen]
impl Applied {
    /// The document version after the edit.
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> f64 {
        self.version
    }

    /// `(first line, removed lines, inserted lines)` triples, one per changed region.
    #[wasm_bindgen(getter)]
    pub fn spans(&self) -> Vec<u32> {
        self.spans.clone()
    }
}

impl Applied {
    /// Flattens one `editor_core::Applied` into the shape the boundary carries.
    pub(crate) fn new(applied: editor_core::Applied) -> Applied {
        let mut spans = Vec::with_capacity(applied.spans.len() * 3);
        for span in &applied.spans {
            spans.push(span.first_line);
            spans.push(span.removed_lines);
            spans.push(span.inserted_lines);
        }
        Applied {
            // Edit counts stay far below the 2^53 where an f64 stops counting integers.
            version: applied.version as f64,
            spans,
        }
    }
}
