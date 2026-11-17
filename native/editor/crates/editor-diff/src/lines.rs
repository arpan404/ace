// SPDX-License-Identifier: Apache-2.0

//! The lines of a text, cut the way the editor counts them.

/// Lines of `text` without their `\n`, the number a gutter shows.
///
/// An empty text has no lines, and a trailing newline does not add an empty last line;
/// this is the same cut `splitLines` makes in `packages/ui-core`. A `\r` of a CRLF file
/// stays on its line, so changing line endings reads as a change to those lines.
pub(super) fn split(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::split;

    #[test]
    fn counts_editor_lines() {
        assert_eq!(split(""), Vec::<&str>::new());
        assert_eq!(split("a"), ["a"]);
        assert_eq!(split("a\n"), ["a"]);
        assert_eq!(split("a\nb"), ["a", "b"]);
        assert_eq!(split("\n"), [""]);
        assert_eq!(split("a\n\n"), ["a", ""]);
        assert_eq!(split("a\r\nb\r\n"), ["a\r", "b\r"]);
    }
}
