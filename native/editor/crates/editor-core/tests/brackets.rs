// SPDX-License-Identifier: Apache-2.0

//! The bracket pair a caret highlights.

use editor_core::{Document, Position, Range};

fn one(line: u32, column: u32) -> Range {
    Range::new(Position::new(line, column), Position::new(line, column + 1))
}

#[test]
fn a_caret_after_an_opening_bracket_finds_its_closer_across_lines() {
    let document = Document::new("f(a, (b)\n)");
    assert_eq!(
        document.matching_bracket(Position::new(0, 2), 10_000),
        Some((one(0, 1), one(1, 0)))
    );
}

#[test]
fn a_caret_before_a_closer_finds_its_opener_skipping_nested_pairs() {
    let document = Document::new("{ [x] { } }");
    assert_eq!(
        document.matching_bracket(Position::new(0, 10), 10_000),
        Some((one(0, 0), one(0, 10)))
    );
}

#[test]
fn an_unmatched_bracket_or_no_bracket_highlights_nothing() {
    let document = Document::new("(( x");
    assert_eq!(document.matching_bracket(Position::new(0, 1), 10_000), None);
    assert_eq!(document.matching_bracket(Position::new(0, 4), 10_000), None);
}

#[test]
fn the_scan_stops_at_its_limit() {
    let text = format!("({})", "x".repeat(100));
    let document = Document::new(&text);
    assert_eq!(document.matching_bracket(Position::new(0, 1), 50), None);
    assert!(
        document
            .matching_bracket(Position::new(0, 1), 200)
            .is_some()
    );
}
