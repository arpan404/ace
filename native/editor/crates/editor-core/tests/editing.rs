// SPDX-License-Identifier: Apache-2.0

//! Behaviour of typing, newlines, deletion and undo.

use editor_core::{Document, LineEnding, Position, Selection};

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
fn a_column_past_the_end_of_a_long_line_clamps_to_its_end() {
    let mut document = Document::new(&"x".repeat(1_000_000));
    document.set_selections(vec![Selection::caret(Position::new(0, 5_000_000))]);

    document.insert_text("!");

    assert_eq!(document.text().len(), 1_000_001);
    assert!(document.text().ends_with('!'));
    assert_eq!(document.selections()[0].head, Position::new(0, 1_000_001));
}

#[test]
fn backspace_after_a_combining_mark_line_removes_only_the_crlf() {
    let mut document = Document::new("e\u{301}\r\nx");
    document.set_selections(vec![Selection::caret(Position::new(1, 0))]);

    document.backspace();

    assert_eq!(document.text(), "e\u{301}x");
    assert_eq!(document.selections()[0].head, Position::new(0, 2));

    document.backspace();

    assert_eq!(document.text(), "x");
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
fn crlf_join_keeps_the_document_ending() {
    let mut document = Document::new("one\r\ntwo\r\n");
    document.set_selections(vec![Selection::caret(Position::new(1, 0))]);

    document.backspace();

    assert_eq!(document.text(), "onetwo\r\n");
    assert_eq!(document.line_ending(), LineEnding::Crlf);

    document.insert_text("\n");

    assert_eq!(document.text(), "one\r\ntwo\r\n");
}

#[test]
fn typing_normalises_line_endings_to_the_document() {
    let mut crlf = Document::new("x\r\n");
    crlf.set_selections(vec![Selection::caret(Position::new(1, 0))]);
    crlf.insert_text("a\r\nb\rc\nd");
    assert_eq!(crlf.text(), "x\r\na\r\nb\r\nc\r\nd");

    let mut lf = Document::new("x\n");
    lf.set_selections(vec![Selection::caret(Position::new(1, 0))]);
    lf.insert_text("a\r\nb\rc\nd");
    assert_eq!(lf.text(), "x\na\nb\nc\nd");
}

#[test]
fn echoing_the_same_caret_does_not_split_the_typing_run() {
    let mut document = Document::new("");
    document.insert_text("a");
    let caret = document.selections()[0];
    document.set_selections(vec![caret]);
    document.insert_text("b");

    assert_eq!(document.text(), "ab");
    document.undo().expect("one typing run");
    assert_eq!(document.text(), "");
}

#[test]
fn lines_split_on_lf_only() {
    let document = Document::new("a\n");
    assert_eq!(document.len_lines(), 2);
    assert_eq!(document.line(1), "");

    let document = Document::new("a\rb");
    assert_eq!(document.len_lines(), 1);
    assert_eq!(document.line(0), "a\rb");
}

#[test]
fn changing_the_line_ending_rewrites_every_break_and_undoes_in_one_step() {
    let mut document = editor_core::Document::new("a\r\nb\r\nc");
    document.set_line_ending(editor_core::LineEnding::Lf);
    assert_eq!(document.text(), "a\nb\nc");
    assert_eq!(document.line_ending(), editor_core::LineEnding::Lf);
    document.insert_newline();
    assert_eq!(document.text(), "\na\nb\nc");
    document.undo();
    document.undo();
    assert_eq!(document.text(), "a\r\nb\r\nc");
    assert_eq!(document.line_ending(), editor_core::LineEnding::Crlf);
}
