// SPDX-License-Identifier: Apache-2.0

//! Behaviour of typing, newlines, deletion and undo.

use editor_core::{Document, LineEnding, Position, Selection, Transaction};

#[test]
fn typing_at_three_cursors_inserts_at_each() {
    let mut document = Document::new("one\ntwo\nthree");
    document.set_selections(vec![
        Selection::caret(Position::new(0, 3)),
        Selection::caret(Position::new(1, 3)),
        Selection::caret(Position::new(2, 5)),
    ]);

    let applied = document.insert_text("!");

    assert_eq!(document.text(), "one!\ntwo!\nthree!");
    assert_eq!(document.selections().len(), 3);
    assert_eq!(document.selections()[0].head, Position::new(0, 4));
    assert_eq!(document.selections()[1].head, Position::new(1, 4));
    assert_eq!(document.selections()[2].head, Position::new(2, 6));
    assert_eq!(applied.first_line, 0);
    assert_eq!(applied.removed_lines, 3);
    assert_eq!(applied.inserted_lines, 3);
}

#[test]
fn undo_restores_text_and_selections() {
    let mut document = Document::new("hello world");
    let selection = Selection::new(Position::new(0, 6), Position::new(0, 11));
    document.set_selections(vec![selection]);

    document.insert_text("there");
    assert_eq!(document.text(), "hello there");
    assert_eq!(document.selections()[0].head, Position::new(0, 11));

    let undone = document.undo().expect("an edit to undo");
    assert_eq!(document.text(), "hello world");
    assert_eq!(document.selections(), &[selection]);
    assert_eq!(undone.version, 2);

    document.redo().expect("an edit to redo");
    assert_eq!(document.text(), "hello there");
    assert_eq!(document.selections()[0].head, Position::new(0, 11));
    assert_eq!(document.version(), 3);
}

#[test]
fn typing_run_undoes_as_one_step() {
    let mut document = Document::new("");
    document.insert_text("a");
    document.insert_text("b");
    document.insert_text("c");

    assert_eq!(document.text(), "abc");
    assert_eq!(document.version(), 3);

    document.undo().expect("the typing run");
    assert_eq!(document.text(), "");
    assert!(document.undo().is_none());

    document.redo().expect("the typing run");
    assert_eq!(document.text(), "abc");
}

#[test]
fn a_typing_run_at_several_cursors_undoes_as_one_step() {
    let mut document = Document::new("ab\ncd");
    document.set_selections(vec![
        Selection::caret(Position::new(0, 1)),
        Selection::caret(Position::new(1, 1)),
    ]);

    document.insert_text("x");
    document.insert_text("y");

    assert_eq!(document.text(), "axyb\ncxyd");
    document.undo().expect("the typing run");
    assert_eq!(document.text(), "ab\ncd");
    assert_eq!(
        document.selections(),
        &[
            Selection::caret(Position::new(0, 1)),
            Selection::caret(Position::new(1, 1)),
        ]
    );

    document.redo().expect("the typing run");
    assert_eq!(document.text(), "axyb\ncxyd");
    assert_eq!(document.selections()[0].head, Position::new(0, 3));
    assert_eq!(document.selections()[1].head, Position::new(1, 3));
}

#[test]
fn a_commit_splits_the_typing_run() {
    let mut document = Document::new("");
    document.insert_text("a");
    document.commit();
    document.insert_text("b");

    document.undo().expect("the second run");
    assert_eq!(document.text(), "a");
    document.undo().expect("the first run");
    assert_eq!(document.text(), "");
}

#[test]
fn newline_keeps_indentation() {
    let mut document = Document::new("  foo");
    document.set_selections(vec![Selection::caret(Position::new(0, 5))]);

    document.insert_newline();

    assert_eq!(document.text(), "  foo\n  ");
    assert_eq!(document.selections()[0].head, Position::new(1, 2));
}

#[test]
fn newline_inside_indentation_copies_up_to_the_caret() {
    let mut document = Document::new("    foo");
    document.set_selections(vec![Selection::caret(Position::new(0, 2))]);

    document.insert_newline();

    assert_eq!(document.text(), "  \n    foo");
}

#[test]
fn backspace_removes_one_grapheme_cluster() {
    let mut document = Document::new("a\u{1f44d}\u{1f3fd}");
    document.set_selections(vec![Selection::caret(Position::new(0, 5))]);

    document.backspace();

    assert_eq!(document.text(), "a");
    assert_eq!(document.selections()[0].head, Position::new(0, 1));
}

#[test]
fn backspace_at_two_points_inside_one_grapheme_deletes_it_once() {
    let mut document = Document::new("a\u{1f44d}\u{1f3fd}b");
    document.set_selections(vec![
        Selection::caret(Position::new(0, 3)),
        Selection::caret(Position::new(0, 5)),
    ]);

    document.backspace();

    assert_eq!(document.text(), "ab");
    assert_eq!(document.selections().len(), 1);
    assert_eq!(document.selections()[0].head, Position::new(0, 1));
}

#[test]
fn deleting_a_word_at_two_carets_in_one_word_deletes_it_once() {
    let mut document = Document::new("foobar");
    document.set_selections(vec![
        Selection::caret(Position::new(0, 3)),
        Selection::caret(Position::new(0, 6)),
    ]);

    document.delete_word_backward();

    assert_eq!(document.text(), "");
    assert_eq!(document.selections().len(), 1);
    assert_eq!(document.selections()[0].head, Position::new(0, 0));
}

#[test]
fn backspace_at_a_line_start_removes_the_whole_line_break() {
    let mut document = Document::new("a\r\nb");
    document.set_selections(vec![Selection::caret(Position::new(1, 0))]);

    document.backspace();

    assert_eq!(document.text(), "ab");
    assert_eq!(document.selections()[0].head, Position::new(0, 1));
}

#[test]
fn utf16_columns_round_trip() {
    let mut document = Document::new("a\u{1f600}b\nsecond");
    document.set_selections(vec![Selection::caret(Position::new(0, 3))]);

    document.insert_text("X");

    assert_eq!(document.text(), "a\u{1f600}Xb\nsecond");
    assert_eq!(document.selections()[0].head, Position::new(0, 4));
}

#[test]
fn a_column_inside_a_surrogate_pair_clamps_to_the_character_start() {
    let mut document = Document::new("a\u{1f600}b");
    document.set_selections(vec![Selection::caret(Position::new(0, 2))]);

    document.insert_text("|");

    assert_eq!(document.text(), "a|\u{1f600}b");
    assert_eq!(document.selections()[0].head, Position::new(0, 2));
}

#[test]
fn crlf_survives_edit() {
    let mut document = Document::new("one\r\ntwo\r\n");
    assert_eq!(document.line_ending(), LineEnding::Crlf);
    assert_eq!(document.line(0), "one");

    document.set_selections(vec![Selection::caret(Position::new(0, 3))]);
    document.insert_newline();
    document.insert_text("x");

    assert_eq!(document.text(), "one\r\nx\r\ntwo\r\n");
    assert_eq!(document.line(1), "x");
    assert!(!document.text().replace("\r\n", "").contains('\n'));
}

#[test]
fn deleting_a_selection_across_lines_reports_the_changed_span() {
    let mut document = Document::new("a\nb\nc\nd");
    document.set_selections(vec![Selection::new(
        Position::new(1, 0),
        Position::new(3, 0),
    )]);

    let applied = document.backspace();

    assert_eq!(document.text(), "a\nd");
    assert_eq!(applied.first_line, 1);
    assert_eq!(applied.removed_lines, 3);
    assert_eq!(applied.inserted_lines, 1);
}

#[test]
fn inserting_a_newline_reports_a_two_line_change() {
    let mut document = Document::new("a\nb");
    document.set_selections(vec![Selection::caret(Position::new(0, 1))]);

    let applied = document.insert_newline();

    assert_eq!(document.text(), "a\n\nb");
    assert_eq!(applied.first_line, 0);
    assert_eq!(applied.removed_lines, 1);
    assert_eq!(applied.inserted_lines, 2);
}

#[test]
fn apply_replaces_a_range_and_undo_restores_it() {
    let mut document = Document::new("hello");
    let applied = document.apply(Transaction::replace(
        editor_core::Range::new(Position::new(0, 1), Position::new(0, 4)),
        "i",
    ));

    assert_eq!(document.text(), "hio");
    assert_eq!(applied.first_line, 0);
    assert_eq!(applied.removed_lines, 1);
    assert_eq!(applied.inserted_lines, 1);

    document.undo().expect("the replacement");
    assert_eq!(document.text(), "hello");
}

#[test]
fn an_empty_transaction_keeps_the_version() {
    let mut document = Document::new("text");
    let applied = document.apply(Transaction::new());

    assert_eq!(document.text(), "text");
    assert_eq!(document.version(), 0);
    assert_eq!(applied.version, 0);
}

#[test]
fn new_edits_drop_the_redo_stack() {
    let mut document = Document::new("");
    document.insert_text("a");
    document.undo().expect("the first character");
    document.insert_text("b");

    assert!(document.redo().is_none());
    assert_eq!(document.text(), "b");
}

#[test]
fn a_caret_at_a_selection_edge_merges_into_it() {
    let mut document = Document::new("abc");
    document.set_selections(vec![
        Selection::new(Position::new(0, 0), Position::new(0, 2)),
        Selection::caret(Position::new(0, 0)),
        Selection::caret(Position::new(0, 2)),
    ]);

    assert_eq!(document.selections().len(), 1);
    assert_eq!(
        document.selections()[0].range(),
        editor_core::Range::new(Position::new(0, 0), Position::new(0, 2))
    );
}

#[test]
fn apply_carries_each_selection_through_a_multi_cursor_transaction() {
    let mut document = Document::new("abc\ndef");
    document.set_selections(vec![
        Selection::new(Position::new(0, 0), Position::new(0, 3)),
        Selection::new(Position::new(1, 0), Position::new(1, 1)),
    ]);
    let mut transaction = Transaction::new();
    transaction
        .push(
            editor_core::Range::new(Position::new(0, 0), Position::new(0, 3)),
            "one",
        )
        .expect("first change");
    transaction
        .push(
            editor_core::Range::new(Position::new(1, 0), Position::new(1, 1)),
            "two",
        )
        .expect("second change");

    document.apply(transaction);

    assert_eq!(document.text(), "one\ntwoef");
    assert_eq!(document.selections()[0].head, Position::new(0, 3));
    assert_eq!(document.selections()[1].head, Position::new(1, 3));
}

#[test]
fn a_transaction_rejects_overlapping_changes() {
    let mut transaction = Transaction::replace(
        editor_core::Range::new(Position::new(0, 1), Position::new(0, 4)),
        "x",
    );

    let rejected = transaction.push(
        editor_core::Range::new(Position::new(0, 3), Position::new(0, 5)),
        "y",
    );
    assert!(rejected.is_err());
    assert_eq!(rejected.expect_err("overlap").code(), "INVALID_ARGUMENT");

    transaction
        .push(
            editor_core::Range::new(Position::new(0, 4), Position::new(0, 5)),
            "y",
        )
        .expect("adjacent change");
    assert_eq!(transaction.len(), 2);
}
