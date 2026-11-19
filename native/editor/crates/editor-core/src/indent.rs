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
