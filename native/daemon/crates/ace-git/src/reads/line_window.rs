// SPDX-License-Identifier: Apache-2.0
//! One bounded line window over immutable file text (`packages/git/src/line-window.ts`, G3b).
//!
//! Proof: `history.process`'s revision-line cases (`readRevisionLines` arrives with G3c) and
//! `review-regressions.process`.

/// Retains one bounded line window while consuming arbitrary chunks of immutable file text.
#[derive(Debug)]
pub struct LineWindow {
    start: u64,
    end: u64,
    max_chars: usize,
    number: u64,
    fragment: String,
    lines: Vec<String>,
    chars: usize,
    overflow: bool,
    seen: bool,
    terminated: bool,
}

/// What a finished window reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionLines {
    pub lines: Vec<String>,
    pub at_eof: bool,
    pub no_final_newline: bool,
}

impl LineWindow {
    pub fn new(start: u64, end: u64, max_chars: usize) -> Self {
        Self {
            start,
            end,
            max_chars,
            number: 1,
            fragment: String::new(),
            lines: Vec::new(),
            chars: 0,
            overflow: false,
            seen: false,
            terminated: false,
        }
    }

    pub fn append(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.seen = true;
        self.terminated = text.ends_with('\n');
        let mut offset = 0usize;
        while offset < text.len() {
            let newline = text[offset..].find('\n').map(|index| index + offset);
            let last = newline.unwrap_or(text.len());
            if self.number >= self.start && self.number <= self.end {
                // The TypeScript counts UTF-16 units and slices by them.
                let count = text[offset..last].encode_utf16().count();
                self.chars += count;
                if self.chars > self.max_chars {
                    self.overflow = true;
                }
                if !self.overflow {
                    self.fragment.push_str(&text[offset..last]);
                }
                if newline.is_some() {
                    if !self.overflow {
                        self.lines.push(std::mem::take(&mut self.fragment));
                    } else {
                        self.fragment.clear();
                    }
                }
            }
            let Some(newline) = newline else {
                break;
            };
            self.number += 1;
            offset = newline + 1;
        }
    }

    /// The window, or `None` when it overflowed its character budget.
    pub fn finish(mut self) -> Option<RevisionLines> {
        if self.overflow {
            return None;
        }
        let mut number = self.number;
        if self.seen && !self.terminated {
            if number >= self.start && number <= self.end {
                self.lines.push(std::mem::take(&mut self.fragment));
            }
            number += 1;
        }
        Some(RevisionLines {
            lines: self.lines,
            at_eof: number - 1 <= self.end,
            no_final_newline: self.seen && !self.terminated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_keeps_only_its_lines_and_its_end_of_file_facts() {
        let mut window = LineWindow::new(2, 3, 100);
        window.append("one\ntwo\nthree\nfour");
        assert_eq!(
            window.finish(),
            Some(RevisionLines {
                lines: vec!["two".to_owned(), "three".to_owned()],
                at_eof: false,
                no_final_newline: true,
            })
        );
        let mut window = LineWindow::new(1, 10, 100);
        window.append("a\nb\n");
        assert_eq!(
            window.finish(),
            Some(RevisionLines {
                lines: vec!["a".to_owned(), "b".to_owned()],
                at_eof: true,
                no_final_newline: false,
            })
        );
        let mut window = LineWindow::new(1, 10, 100);
        window.append("a\nb");
        assert_eq!(
            window.finish().map(|lines| lines.lines),
            Some(vec!["a".to_owned(), "b".to_owned()])
        );
    }

    #[test]
    fn a_chunk_may_split_a_line_and_the_budget_counts_utf16_units() {
        let mut window = LineWindow::new(1, 1, 100);
        window.append("half ");
        window.append("line\nnext\n");
        assert_eq!(
            window.finish().map(|lines| lines.lines),
            Some(vec!["half line".to_owned()])
        );
        // An emoji is two UTF-16 units: a bound of 1 overflows, 2 does not.
        let mut over = LineWindow::new(1, 1, 1);
        over.append("\u{1F600}\n");
        assert_eq!(over.finish(), None);
        let mut fits = LineWindow::new(1, 1, 2);
        fits.append("\u{1F600}\n");
        assert_eq!(
            fits.finish().map(|lines| lines.lines),
            Some(vec!["\u{1F600}".to_owned()])
        );
    }
}
