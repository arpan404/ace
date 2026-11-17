// SPDX-License-Identifier: Apache-2.0

//! The lines of a text, and the runs of them two texts share.

/// Lines of `text` without their `\n`, the number a gutter shows.
///
/// An empty text has no lines, and a trailing newline does not add an empty last line;
/// this is the same cut `splitLines` makes in `packages/ui-core`. A `\r` of a CRLF file
/// stays on its line, so changing line endings reads as a change to those lines.
pub(super) fn split(text: &str) -> std::str::SplitTerminator<'_, char> {
    text.split_terminator('\n')
}

/// How many lines at the start and at the end the two texts share.
///
/// Those runs cannot contain a change, so the diff only needs the lines between them.
/// The two counts never overlap: together they are at most the shorter text.
pub(super) fn shared_ends(before: &[&str], after: &[&str]) -> (usize, usize) {
    let prefix = before
        .iter()
        .zip(after)
        .take_while(|(left, right)| left == right)
        .count();
    let longest = before.len().min(after.len()) - prefix;
    let suffix = before[prefix..]
        .iter()
        .rev()
        .zip(after[prefix..].iter().rev())
        .take(longest)
        .take_while(|(left, right)| left == right)
        .count();
    (prefix, suffix)
}

#[cfg(test)]
mod tests {
    use super::{shared_ends, split};

    fn lines(text: &str) -> Vec<&str> {
        split(text).collect()
    }

    #[test]
    fn counts_editor_lines() {
        assert_eq!(lines(""), Vec::<&str>::new());
        assert_eq!(lines("a"), ["a"]);
        assert_eq!(lines("a\n"), ["a"]);
        assert_eq!(lines("a\nb"), ["a", "b"]);
        assert_eq!(lines("\n"), [""]);
        assert_eq!(lines("a\n\n"), ["a", ""]);
        assert_eq!(lines("a\r\nb\r\n"), ["a\r", "b\r"]);
    }

    #[test]
    fn shared_ends_never_overlap() {
        assert_eq!(shared_ends(&[], &[]), (0, 0));
        assert_eq!(shared_ends(&[], &["a"]), (0, 0));
        assert_eq!(shared_ends(&["a", "b"], &["a", "b"]), (2, 0));
        assert_eq!(shared_ends(&["a", "x", "b"], &["a", "y", "b"]), (1, 1));
        assert_eq!(shared_ends(&["a"], &["a", "a"]), (1, 0));
    }
}
