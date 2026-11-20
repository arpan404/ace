// SPDX-License-Identifier: Apache-2.0

//! The document's indentation unit: tabs or a number of spaces.

/// How one indent step is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Indent {
    /// Whether an indent step is a tab rather than spaces.
    pub tabs: bool,
    /// Spaces per step, and the width a tab is drawn at. At least one.
    pub size: u32,
}

impl Default for Indent {
    fn default() -> Indent {
        Indent {
            tabs: false,
            size: 2,
        }
    }
}

impl Indent {
    /// One whole indent step.
    pub fn unit(&self) -> String {
        if self.tabs {
            "\t".to_owned()
        } else {
            " ".repeat(self.size.max(1) as usize)
        }
    }

    /// What Tab inserts at a caret drawn `visual` cells into its line: up to the next stop.
    pub(crate) fn step_from(&self, visual: u32) -> String {
        if self.tabs {
            return "\t".to_owned();
        }
        let size = self.size.max(1);
        " ".repeat((size - visual % size) as usize)
    }

    /// The cells `text` covers, with tabs expanded to this indent's stops.
    pub(crate) fn visual_width(&self, text: &str) -> u32 {
        let size = self.size.max(1);
        let mut width = 0u32;
        for ch in text.chars() {
            width = if ch == '\t' {
                (width / size + 1) * size
            } else {
                width + 1
            };
        }
        width
    }
}

/// How many lines indentation detection reads: enough to judge, bounded for a huge file.
pub(crate) const DETECT_LINES: usize = 2_000;

/// The indentation a file's lines use, or `None` when no line is indented.
///
/// Lines that start with a tab vote for tabs; for spaces, the step is the most common change
/// in indentation between one indented line and the previous non-blank one (2, 4 or 8 win over
/// odd sizes on a tie), so a file that nests by four is not read as two because of a continuation.
pub fn detect_indent<'a>(lines: impl Iterator<Item = &'a str>) -> Option<Indent> {
    let mut tabs = 0usize;
    let mut spaced = 0usize;
    let mut steps = [0usize; 9];
    let mut previous = 0usize;
    for line in lines.take(DETECT_LINES) {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with('\t') {
            tabs += 1;
            previous = 0;
            continue;
        }
        let width = line.bytes().take_while(|b| *b == b' ').count();
        if width > 0 {
            spaced += 1;
        }
        let change = width.abs_diff(previous);
        if (1..=8).contains(&change) {
            steps[change] += 1;
        }
        previous = width;
    }
    if tabs == 0 && spaced == 0 {
        return None;
    }
    if tabs > spaced {
        return Some(Indent {
            tabs: true,
            size: Indent::default().size,
        });
    }
    let mut best = 0usize;
    for size in [2usize, 4, 8, 3, 6, 5, 7, 1] {
        // `steps[0]` is never counted, so the first size seen wins and later ones need more votes.
        if steps[size] > steps[best] {
            best = size;
        }
    }
    (best > 0).then_some(Indent {
        tabs: false,
        size: best as u32,
    })
}
