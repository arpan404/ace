// SPDX-License-Identifier: Apache-2.0

//! The document class JavaScript drives.

use editor_core::{Document, FindQuery, Position};
use wasm_bindgen::prelude::*;

use crate::applied::Applied;
use crate::convert;

/// One open text file: text, cursors, undo history and the commands that edit it.
///
/// All positions are line plus UTF-16 column, so a position survives a round trip through the
/// DOM unchanged. Selections cross as quads and transactions as range quads plus texts; see the
/// crate documentation for the shapes.
#[wasm_bindgen]
pub struct EditorDocument {
    core: Document,
}

#[wasm_bindgen]
impl EditorDocument {
    /// A document holding `text`, with one caret at the start.
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str) -> EditorDocument {
        EditorDocument {
            core: Document::new(text),
        }
    }

    /// The whole text, with its original line endings. Ask for this only when the caller needs
    /// the full file; the view reads [`EditorDocument::lines`] instead.
    pub fn text(&self) -> String {
        self.core.text()
    }

    /// The number of lines. A trailing line break leaves a last empty line.
    #[wasm_bindgen(js_name = lenLines)]
    pub fn len_lines(&self) -> u32 {
        u32::try_from(self.core.len_lines()).unwrap_or(u32::MAX)
    }

    /// One line without its line ending. An index past the end is empty.
    pub fn line(&self, index: u32) -> String {
        self.core.line(index as usize).into_owned()
    }

    /// The lines in `start..end` without their endings, as one array for the visible range.
    #[wasm_bindgen(js_name = lines)]
    pub fn lines_range(&self, start: u32, end: u32) -> Vec<String> {
        let last = self.core.len_lines();
        let start = (start as usize).min(last);
        let end = (end as usize).min(last);
        if end <= start {
            return Vec::new();
        }
        (start..end)
            .map(|index| self.core.line(index).into_owned())
            .collect()
    }

    /// The line ending the document was loaded with: `"\n"` or `"\r\n"`.
    #[wasm_bindgen(js_name = lineEnding)]
    pub fn line_ending(&self) -> String {
        self.core.line_ending().as_str().to_owned()
    }

    /// The number of edits applied so far.
    pub fn version(&self) -> f64 {
        self.core.version() as f64
    }

    /// Every cursor as `(anchor line, anchor column, head line, head column)` quads, in document
    /// order.
    pub fn selections(&self) -> Vec<u32> {
        convert::flatten_selections(self.core.selections())
    }

    /// The index in [`EditorDocument::selections`] of the newest cursor, the one the view reveals.
    #[wasm_bindgen(js_name = primarySelection)]
    pub fn primary_selection(&self) -> u32 {
        u32::try_from(self.core.primary_selection()).unwrap_or(u32::MAX)
    }

    /// Replaces every selection from quads. The last one is the newest and becomes primary;
    /// positions are clamped and overlapping selections merged.
    #[wasm_bindgen(js_name = setSelections)]
    pub fn set_selections(&mut self, quads: &[u32]) -> Result<(), JsValue> {
        let selections = convert::selections(quads)?;
        self.core.set_selections(selections);
        Ok(())
    }

    /// Applies a transaction: one range quad per change and the replacement text of each, in the
    /// same order. Throws `INVALID_ARGUMENT` when the counts disagree or two changes overlap.
    pub fn apply(&mut self, ranges: &[u32], texts: Vec<String>) -> Result<Applied, JsValue> {
        let transaction = convert::transaction(ranges, texts)?;
        Ok(Applied::new(self.core.apply(transaction)))
    }

    /// Inserts `text` at every selection, replacing selected text.
    #[wasm_bindgen(js_name = insertText)]
    pub fn insert_text(&mut self, text: &str) -> Applied {
        Applied::new(self.core.insert_text(text))
    }

    /// Inserts a line break carrying the current line's indentation at every selection.
    #[wasm_bindgen(js_name = insertNewline)]
    pub fn insert_newline(&mut self) -> Applied {
        Applied::new(self.core.insert_newline())
    }

    /// Deletes the selected text, or one grapheme cluster before each caret.
    pub fn backspace(&mut self) -> Applied {
        Applied::new(self.core.backspace())
    }

    /// Deletes the selected text, or the word before each caret.
    #[wasm_bindgen(js_name = deleteWordBackward)]
    pub fn delete_word_backward(&mut self) -> Applied {
        Applied::new(self.core.delete_word_backward())
    }

    /// Adds one indent step to the start of every selected line.
    #[wasm_bindgen(js_name = indentLines)]
    pub fn indent_lines(&mut self) -> Applied {
        Applied::new(self.core.indent_lines())
    }

    /// Removes one indent step from every selected line.
    #[wasm_bindgen(js_name = outdentLines)]
    pub fn outdent_lines(&mut self) -> Applied {
        Applied::new(self.core.outdent_lines())
    }

    /// Swaps the selected lines with the line above them.
    #[wasm_bindgen(js_name = moveLinesUp)]
    pub fn move_lines_up(&mut self) -> Applied {
        Applied::new(self.core.move_lines_up())
    }

    /// Swaps the selected lines with the line below them.
    #[wasm_bindgen(js_name = moveLinesDown)]
    pub fn move_lines_down(&mut self) -> Applied {
        Applied::new(self.core.move_lines_down())
    }

    /// Copies the selected lines below themselves and moves the carets onto the copies.
    #[wasm_bindgen(js_name = duplicateLines)]
    pub fn duplicate_lines(&mut self) -> Applied {
        Applied::new(self.core.duplicate_lines())
    }

    /// Comments the selected lines with `token`, or removes it when every non-blank line is
    /// already commented.
    #[wasm_bindgen(js_name = toggleLineComment)]
    pub fn toggle_line_comment(&mut self, token: &str) -> Applied {
        Applied::new(self.core.toggle_line_comment(token))
    }

    /// Undoes the last step, or returns `undefined` when there is nothing to undo.
    pub fn undo(&mut self) -> Option<Applied> {
        self.core.undo().map(Applied::new)
    }

    /// Redoes the step undone last, or returns `undefined` when there is nothing to redo.
    pub fn redo(&mut self) -> Option<Applied> {
        self.core.redo().map(Applied::new)
    }

    /// Ends the current typing run, so the next keystroke is a separate undo step.
    pub fn commit(&mut self) {
        self.core.commit();
    }

    /// Finds matches for a literal or regular expression, at most `limit`, as range quads.
    pub fn find(
        &self,
        pattern: &str,
        regex: bool,
        case_sensitive: bool,
        whole_word: bool,
        limit: u32,
    ) -> Vec<u32> {
        let query = query(pattern, regex, case_sensitive, whole_word);
        let ranges = self
            .core
            .find(&query, usize::try_from(limit).unwrap_or(usize::MAX));
        convert::flatten_ranges(&ranges)
    }

    /// Finds matches lying wholly inside the `within` range quads, at most `limit`.
    #[wasm_bindgen(js_name = findWithin)]
    pub fn find_within(
        &self,
        pattern: &str,
        regex: bool,
        case_sensitive: bool,
        whole_word: bool,
        within: &[u32],
        limit: u32,
    ) -> Result<Vec<u32>, JsValue> {
        let query = query(pattern, regex, case_sensitive, whole_word);
        let within = convert::ranges(within)?;
        let ranges = self.core.find_within(
            &query,
            &within,
            usize::try_from(limit).unwrap_or(usize::MAX),
        );
        Ok(convert::flatten_ranges(&ranges))
    }

    /// Replaces every match inside the `within` range quads (all when empty) as one undo step.
    #[wasm_bindgen(js_name = replaceAll)]
    #[allow(clippy::too_many_arguments)]
    pub fn replace_all(
        &mut self,
        pattern: &str,
        regex: bool,
        case_sensitive: bool,
        whole_word: bool,
        replacement: &str,
        within: &[u32],
    ) -> Result<Applied, JsValue> {
        let query = query(pattern, regex, case_sensitive, whole_word);
        let within = convert::ranges(within)?;
        Ok(Applied::new(self.core.replace_all(
            &query,
            replacement,
            &within,
        )))
    }

    /// Replaces the match at the `at` range quad when it is still exactly a match.
    #[wasm_bindgen(js_name = replaceMatch)]
    #[allow(clippy::too_many_arguments)]
    pub fn replace_match(
        &mut self,
        pattern: &str,
        regex: bool,
        case_sensitive: bool,
        whole_word: bool,
        at: &[u32],
        replacement: &str,
    ) -> Result<Applied, JsValue> {
        let query = query(pattern, regex, case_sensitive, whole_word);
        let at = convert::range(at)?;
        Ok(Applied::new(self.core.replace_match(
            &query,
            at,
            replacement,
        )))
    }

    /// Selects a rectangular block from `anchor` to `head`, with columns as visual columns and
    /// tabs expanded to `tab_size` stops. One selection per line, clamped to that line.
    #[wasm_bindgen(js_name = selectColumn)]
    pub fn select_column(
        &mut self,
        anchor_line: u32,
        anchor_column: u32,
        head_line: u32,
        head_column: u32,
        tab_size: u32,
    ) {
        self.core.select_column(
            Position::new(anchor_line, anchor_column),
            Position::new(head_line, head_column),
            tab_size,
        );
    }

    /// Adds a selection over the next occurrence of the primary selection's text.
    #[wasm_bindgen(js_name = selectNextOccurrence)]
    pub fn select_next_occurrence(&mut self) -> bool {
        self.core.select_next_occurrence()
    }
}

fn query(pattern: &str, regex: bool, case_sensitive: bool, whole_word: bool) -> FindQuery {
    FindQuery {
        pattern: pattern.to_owned(),
        regex,
        case_sensitive,
        whole_word,
    }
}
