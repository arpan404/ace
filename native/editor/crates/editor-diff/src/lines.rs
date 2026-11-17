// SPDX-License-Identifier: Apache-2.0

//! The line cut both sides of ace count with.

/// Lines of `text` without their `\n`, the number a gutter shows.
///
/// An empty text has no lines, and a trailing newline does not add an empty last line;
/// this is the cut `splitLines` makes in `packages/ui-core/src/diff.ts`. A `\r` of a CRLF
/// file stays on its line, so changing line endings reads as a change to those lines.
pub(super) fn split(text: &str) -> std::str::SplitTerminator<'_, char> {
    text.split_terminator('\n')
}
