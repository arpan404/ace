// SPDX-License-Identifier: Apache-2.0

//! Replace one match, replace all, and find inside a selection.

use editor_core::{Document, FindQuery, Position, Range, Selection};

fn range(a: (u32, u32), b: (u32, u32)) -> Range {
    Range::new(Position::new(a.0, a.1), Position::new(b.0, b.1))
}

#[test]
fn replace_all_rewrites_every_match_and_undoes_in_one_step() {
    let mut document = Document::new("cat cat\ndog cat");
    document.replace_all(&FindQuery::new("cat"), "bird", &[]);
    assert_eq!(document.text(), "bird bird\ndog bird");
    document.undo();
    assert_eq!(document.text(), "cat cat\ndog cat");
}

#[test]
fn replace_all_expands_regex_groups_and_escapes() {
    let mut document = Document::new("a=1\nb=2");
    let query = FindQuery {
        regex: true,
        ..FindQuery::new(r"(\w)=(\d)")
    };
    document.replace_all(&query, r"$2:$1\t", &[]);
    assert_eq!(document.text(), "1:a\t\n2:b\t");
}

#[test]
fn a_literal_replacement_keeps_dollars_as_typed() {
    let mut document = Document::new("price");
    document.replace_all(&FindQuery::new("price"), "$1", &[]);
    assert_eq!(document.text(), "$1");
}

#[test]
fn a_replacement_line_break_takes_the_documents_ending() {
    let mut document = Document::new("a,b\r\nc");
    let query = FindQuery {
        regex: true,
        ..FindQuery::new(",")
    };
    document.replace_all(&query, r"\n", &[]);
    assert_eq!(document.text(), "a\r\nb\r\nc");
}

#[test]
fn replace_all_inside_a_selection_leaves_the_rest() {
    let mut document = Document::new("x x\nx x\nx x");
    document.replace_all(&FindQuery::new("x"), "y", &[range((1, 0), (1, 3))]);
    assert_eq!(document.text(), "x x\ny y\nx x");
}

#[test]
fn find_within_returns_only_matches_wholly_inside_the_ranges() {
    let document = Document::new("ab ab ab ab");
    let found = document.find_within(
        &FindQuery::new("ab"),
        &[range((0, 7), (0, 11)), range((0, 0), (0, 4))],
        100,
    );
    assert_eq!(found, vec![range((0, 0), (0, 2)), range((0, 9), (0, 11))]);
}

#[test]
fn replace_match_replaces_only_a_current_match() {
    let mut document = Document::new("foo foo");
    let query = FindQuery::new("foo");
    document.replace_match(&query, range((0, 4), (0, 7)), "bar");
    assert_eq!(document.text(), "foo bar");
    // A range that is no longer a match changes nothing.
    let applied = document.replace_match(&query, range((0, 4), (0, 7)), "baz");
    assert!(applied.spans.is_empty());
    assert_eq!(document.text(), "foo bar");
}

#[test]
fn replace_all_keeps_a_caret_after_the_replaced_text() {
    let mut document = Document::new("one two one");
    document.set_selections(vec![Selection::caret(Position::new(0, 11))]);
    document.replace_all(&FindQuery::new("one"), "1", &[]);
    assert_eq!(document.text(), "1 two 1");
    assert_eq!(document.selections()[0].head, Position::new(0, 7));
}
