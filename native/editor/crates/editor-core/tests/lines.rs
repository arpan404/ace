// SPDX-License-Identifier: Apache-2.0

//! Behaviour of line movement, duplication, indentation and comments.

use editor_core::{Document, Position, Range, Selection};

#[test]
fn move_line_down_keeps_selection() {
    let mut document = Document::new("alpha\nbeta\ngamma");
    document.set_selections(vec![Selection::new(
        Position::new(1, 1),
        Position::new(1, 3),
    )]);

    document.move_lines_down();

    assert_eq!(document.text(), "alpha\ngamma\nbeta");
    assert_eq!(
        document.selections(),
        &[Selection::new(Position::new(2, 1), Position::new(2, 3))]
    );
}

#[test]
fn move_lines_up_at_the_top_is_a_no_op() {
    let mut document = Document::new("a\nb");
    document.set_selections(vec![Selection::caret(Position::new(0, 0))]);

    let applied = document.move_lines_up();

    assert_eq!(document.text(), "a\nb");
    assert_eq!(document.version(), 0);
    assert_eq!(applied.version, 0);
}

#[test]
fn move_line_up_swaps_with_the_line_above() {
    let mut document = Document::new("a\nb\nc");
    document.set_selections(vec![Selection::caret(Position::new(2, 1))]);

    document.move_lines_up();

    assert_eq!(document.text(), "a\nc\nb");
    assert_eq!(document.selections()[0].head, Position::new(1, 1));
}

#[test]
fn duplicate_lines_copies_block_below() {
    let mut document = Document::new("a\nb\nc");
    document.set_selections(vec![Selection::new(
        Position::new(1, 0),
        Position::new(1, 1),
    )]);

    document.duplicate_lines();

    assert_eq!(document.text(), "a\nb\nb\nc");
    assert_eq!(
        document.selections()[0].range(),
        Range::new(Position::new(2, 0), Position::new(2, 1))
    );
}

#[test]
fn duplicate_the_last_line_adds_a_line_break() {
    let mut document = Document::new("a");
    document.set_selections(vec![Selection::caret(Position::new(0, 1))]);

    document.duplicate_lines();

    assert_eq!(document.text(), "a\na");
    assert_eq!(document.selections()[0].head, Position::new(1, 1));
}

#[test]
fn indent_adds_one_step_to_every_selected_line() {
    let mut document = Document::new("one\n  two\nthree");
    document.set_selections(vec![Selection::new(
        Position::new(0, 0),
        Position::new(2, 0),
    )]);

    document.indent_lines();

    assert_eq!(document.text(), "  one\n    two\nthree");
    assert_eq!(
        document.selections(),
        &[Selection::new(Position::new(0, 0), Position::new(2, 0))]
    );
}

#[test]
fn outdent_removes_a_tab_or_up_to_two_spaces() {
    let mut document = Document::new("\tone\n  two\n   three");
    document.set_selections(vec![
        Selection::caret(Position::new(0, 0)),
        Selection::caret(Position::new(1, 2)),
        Selection::caret(Position::new(2, 3)),
    ]);

    document.outdent_lines();

    assert_eq!(document.text(), "one\ntwo\n three");
    assert_eq!(document.selections()[0].head, Position::new(0, 0));
    assert_eq!(document.selections()[1].head, Position::new(1, 0));
    assert_eq!(document.selections()[2].head, Position::new(2, 1));
}

#[test]
fn crlf_survives_line_movement() {
    let mut document = Document::new("a\r\nb\r\nc\r\n");
    document.set_selections(vec![Selection::caret(Position::new(1, 0))]);

    document.move_lines_down();

    assert_eq!(document.text(), "a\r\nc\r\nb\r\n");
}

#[test]
fn toggle_comment_on_mixed_lines() {
    let mut document = Document::new("fn a() {}\n  // fn b() {}\n\tfn c() {}");
    let selection = Selection::new(Position::new(0, 0), Position::new(2, 10));
    document.set_selections(vec![selection]);

    document.toggle_line_comment("//");

    assert_eq!(
        document.text(),
        "// fn a() {}\n  // // fn b() {}\n\t// fn c() {}"
    );

    document.toggle_line_comment("//");

    assert_eq!(document.text(), "fn a() {}\n  // fn b() {}\n\tfn c() {}");
    assert_eq!(document.selections(), &[selection]);
}

#[test]
fn a_comment_token_already_followed_by_space_is_not_padded() {
    let mut document = Document::new("code");
    document.set_selections(vec![Selection::caret(Position::new(0, 0))]);

    document.toggle_line_comment("-- ");

    assert_eq!(document.text(), "-- code");
}
