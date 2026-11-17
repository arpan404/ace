// SPDX-License-Identifier: Apache-2.0

//! Toggling line comments on the selected lines.

use super::{adjust_selection_columns, merged_line_spans};
use crate::document::Document;
use crate::transaction::{Applied, Edit, EditSet};

impl Document {
    /// Comments the selected lines, or removes the comment from all of them when every non-blank
    /// line is already commented.
    ///
    /// `token` is the language's line comment (`"//"`, `"--"`, `"#"`). It is inserted after the
    /// line's indentation followed by one space, and that space is removed with it.
    pub fn toggle_line_comment(&mut self, token: &str) -> Applied {
        if token.is_empty() {
            return self.unchanged();
        }
        let spans = merged_line_spans(&self.buffer, &self.selections);
        let mut lines = Vec::new();
        for (start, end) in &spans {
            lines.extend(*start..*end);
        }
        let mut infos = Vec::with_capacity(lines.len());
        for line in lines {
            let content = self.buffer.line(line);
            let trimmed = content.trim_start_matches([' ', '\t']);
            let indent = content.len() - trimmed.len();
            infos.push((
                line,
                indent,
                trimmed.trim().is_empty(),
                trimmed.starts_with(token),
            ));
        }
        let non_blank = infos.iter().filter(|info| !info.2).count();
        let commented = infos.iter().filter(|info| !info.2 && info.3).count();
        if non_blank == 0 {
            return self.unchanged();
        }
        let remove = non_blank == commented;
        let insert = if token.ends_with(char::is_whitespace) {
            token.to_owned()
        } else {
            format!("{token} ")
        };
        let insert_width = insert.chars().map(char::len_utf16).sum::<usize>() as i64;

        let mut raw = Vec::new();
        let mut columns = Vec::new();
        for (line, indent, blank, is_commented) in infos {
            if blank {
                continue;
            }
            let offset = self.buffer.line_start(line) + indent;
            if remove && is_commented {
                let mut width = token.len();
                if self.buffer.slice(offset + width, offset + width + 1) == " " {
                    width += 1;
                }
                raw.push(Edit {
                    start: offset,
                    end: offset + width,
                    text: String::new(),
                });
                columns.push((line as u32, indent as u32, -(width as i64)));
            } else if !remove {
                raw.push(Edit {
                    start: offset,
                    end: offset,
                    text: insert.clone(),
                });
                columns.push((line as u32, indent as u32, insert_width));
            }
        }
        let edits = EditSet::new(raw);
        if edits.is_empty() {
            return self.unchanged();
        }
        let outcome = self.run(&edits);
        let after = self
            .selections
            .iter()
            .map(|selection| adjust_selection_columns(*selection, &columns))
            .collect();
        self.finish(edits, outcome, after, false)
    }
}
