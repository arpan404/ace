// SPDX-License-Identifier: Apache-2.0

//! Gutter marks as the diff view draws them. The cases mirror `line-marks.test.ts` in
//! `packages/ui-core`, so both sides of ace agree on what a mark means.

use editor_diff::{MarkKind, line_marks};

/// Marks as `(line, kind)` pairs, in the order the gutter gets them.
fn marks(original: &str, current: &str) -> Vec<(u32, MarkKind)> {
    line_marks(original, current)
        .into_iter()
        .map(|mark| (mark.line, mark.kind))
        .collect()
}

fn numbered(last: usize) -> String {
    (1..=last).map(|line| format!("{line}\n")).collect()
}

#[test]
fn identical_text_has_no_marks() {
    assert_eq!(marks("", ""), []);
    assert_eq!(marks("one\ntwo\nthree\n", "one\ntwo\nthree\n"), []);
    assert_eq!(marks("one\ntwo", "one\ntwo"), []);
}

#[test]
fn added_lines() {
    assert_eq!(
        marks("a\nb\n", "a\nnew\nb\n"),
        [(2, MarkKind::Added)],
        "a line inserted between two lines",
    );
    assert_eq!(
        marks("b\nc\n", "a\nb\nc\n"),
        [(1, MarkKind::Added)],
        "a line inserted at the start",
    );
    assert_eq!(
        marks("a\nb\n", "a\nb\nc\nd\n"),
        [(3, MarkKind::Added), (4, MarkKind::Added)],
        "lines appended at the end",
    );
}

#[test]
fn removed_lines_mark_the_line_below() {
    assert_eq!(
        marks("one\ntwo\nthree\n", "one\nthree\n"),
        [(2, MarkKind::Removed)],
        "a removal in the middle marks the line that now follows it",
    );
    assert_eq!(
        marks("one\ntwo\n", "one\n"),
        [(1, MarkKind::Removed)],
        "a removal at the end marks the last line",
    );
    assert_eq!(
        marks("x\na\n", "a\n"),
        [(1, MarkKind::Removed)],
        "a removal above a shared tail line marks that line",
    );
    assert_eq!(
        marks("one\ntwo\nthree\n", "one\nthree\nnew\n"),
        [(2, MarkKind::Removed), (3, MarkKind::Added)],
        "a removal above an added line keeps the removal on that line",
    );
}

#[test]
fn modified_block() {
    assert_eq!(
        marks("keep\nold\ntail\n", "keep\nnew\ntail\n"),
        [(2, MarkKind::Modified)],
        "a rewritten line",
    );
    assert_eq!(
        marks("a\nx\nb\n", "a\nX\nY\nZ\nb\n"),
        [
            (2, MarkKind::Modified),
            (3, MarkKind::Added),
            (4, MarkKind::Added),
        ],
        "one removed line against three added lines",
    );
    assert_eq!(
        marks("a\nx\ny\nb\n", "a\nX\nb\n"),
        [(2, MarkKind::Modified), (3, MarkKind::Removed)],
        "a block that removes more than it adds leaves a removal below",
    );
    assert_eq!(
        marks("a\nx\ny\n", "a\nX\n"),
        [(2, MarkKind::Modified)],
        "a block at the end keeps its own mark instead of a removal",
    );
    assert_eq!(
        marks("a\nb\nc\nd\n", "A\nb\nc\n"),
        [(1, MarkKind::Modified), (3, MarkKind::Removed)],
        "a changed first line and a removal after the last shared line",
    );
}

#[test]
fn reordered_block_matches_the_diff_view() {
    assert_eq!(
        marks("u\nc\nc\nX\n", "c\nc\nY\nu\n"),
        [
            (1, MarkKind::Removed),
            (3, MarkKind::Modified),
            (4, MarkKind::Added),
        ],
        "the diff view's alignment, not one that merely minimises the edit count",
    );
}

#[test]
fn marks_keep_line_numbers_across_separate_blocks() {
    let original = numbered(60);
    let mut current = String::new();
    for line in 1..=60 {
        match line {
            2 => current.push_str("two\n"),
            _ => current.push_str(&format!("{line}\n")),
        }
        if line == 41 {
            current.push_str("inserted\n");
        }
    }
    assert_eq!(
        marks(&original, &current),
        [(2, MarkKind::Modified), (42, MarkKind::Added)],
    );
}

#[test]
fn nothing_to_mark_when_the_text_is_gone() {
    assert_eq!(
        marks("one\ntwo\n", ""),
        [],
        "an empty file has no line to mark",
    );
    assert_eq!(
        marks("a\n", ""),
        [],
        "a file emptied from its last line has no line to mark either",
    );
    assert_eq!(marks("", "one\n"), [(1, MarkKind::Added)]);
}

#[test]
fn blank_lines_are_lines() {
    assert_eq!(marks("", ""), []);
    assert_eq!(
        marks("", "\n"),
        [(1, MarkKind::Added)],
        "one empty line is one added line",
    );
    assert_eq!(
        marks("a\n", "a\n\n"),
        [(2, MarkKind::Added)],
        "a blank line appended after a newline is a second line",
    );
    assert_eq!(
        marks("a\n\n", "a\n"),
        [(1, MarkKind::Removed)],
        "removing that blank line marks the line above it",
    );
}

#[test]
fn a_trailing_newline_is_not_a_change() {
    assert_eq!(marks("a\nb", "a\nb\n"), []);
}

#[test]
fn a_line_ending_change_marks_those_lines() {
    assert_eq!(
        marks("a\nb\n", "a\r\nb\r\n"),
        [(1, MarkKind::Modified), (2, MarkKind::Modified)],
        "the carriage return belongs to the line's text",
    );
}

#[test]
fn marks_are_ascending_and_one_per_line() {
    let original = numbered(200);
    let current: String = (1..=200)
        .filter(|line| line % 3 != 0)
        .map(|line| {
            if line % 2 == 0 {
                format!("changed {line}\n")
            } else {
                format!("{line}\n")
            }
        })
        .collect();
    let marks = line_marks(&original, &current);
    assert!(!marks.is_empty());
    assert!(
        marks
            .windows(2)
            .all(|pair| match (pair.first(), pair.get(1)) {
                (Some(left), Some(right)) => left.line < right.line,
                _ => false,
            }),
        "one mark per line, in ascending order: {marks:?}",
    );
}
