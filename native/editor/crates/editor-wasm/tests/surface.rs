// SPDX-License-Identifier: Apache-2.0

//! Behaviour of the Wasm surface: flat arrays in, flat arrays and line strings out.

use editor_wasm::{EditorDocument, line_marks, merge3};

/// Three carets on one line each, as the quads JavaScript sends.
fn carets() -> [u32; 12] {
    [0, 3, 0, 3, 1, 3, 1, 3, 2, 5, 2, 5]
}

#[test]
fn typing_at_three_cursors_inserts_at_each() {
    let mut document = EditorDocument::new("one\ntwo\nthree");
    document
        .set_selections(&carets())
        .expect("three valid carets");

    let applied = document.insert_text("!");

    assert_eq!(document.text(), "one!\ntwo!\nthree!");
    assert_eq!(document.selections(), [0, 4, 0, 4, 1, 4, 1, 4, 2, 6, 2, 6]);
    assert_eq!(applied.spans(), [0, 3, 3]);
    assert_eq!(applied.version(), 1.0);
}

#[test]
fn undo_restores_text_and_selections() {
    let mut document = EditorDocument::new("hello world");
    document
        .set_selections(&[0, 6, 0, 11])
        .expect("one valid selection");
    document.insert_text("there");
    document.commit();

    let undone = document.undo().expect("an edit to undo");

    assert_eq!(document.text(), "hello world");
    assert_eq!(document.selections(), [0, 6, 0, 11]);
    assert_eq!(undone.version(), 2.0);
    assert!(document.undo().is_none());
    assert!(document.redo().is_some());
}

#[test]
fn spans_for_far_apart_cursors_are_separate() {
    let mut document = EditorDocument::new(&"a\n".repeat(100));

    let applied = document
        .apply(
            &[0, 0, 0, 0, 99, 0, 99, 0],
            vec!["first".to_owned(), "second".to_owned()],
        )
        .expect("two changes that do not overlap");

    assert_eq!(applied.spans(), [0, 1, 1, 99, 1, 1]);
    assert_eq!(document.line(0), "firsta");
    assert_eq!(document.line(99), "seconda");
}

#[test]
fn lines_reads_only_the_requested_range() {
    let mut document = EditorDocument::new("alpha\nbeta\ngamma\ndelta");

    assert_eq!(document.lines_range(1, 3), ["beta", "gamma"]);

    document
        .apply(&[1, 0, 1, 4], vec!["BETA".to_owned()])
        .expect("a valid replacement");
    assert_eq!(document.lines_range(0, 2), ["alpha", "BETA"]);
    assert_eq!(document.lines_range(10, 20), Vec::<String>::new());
    assert_eq!(document.len_lines(), 4);
}

#[test]
fn find_reports_range_quads() {
    let document = EditorDocument::new("one two one");

    assert_eq!(
        document.find("one", false, true, true, 10),
        [0, 0, 0, 3, 0, 8, 0, 11]
    );
}

#[test]
fn line_marks_match_the_gutter() {
    assert_eq!(line_marks("a\nb\n", "a\nnew\nb\n"), [2, 0]);
    assert_eq!(line_marks("keep\nold\ntail\n", "keep\nnew\ntail\n"), [2, 1]);
    assert_eq!(line_marks("a\nx\ny\nb\n", "a\nX\nb\n"), [2, 1, 3, 2]);
}

#[test]
fn select_column_makes_one_selection_per_line() {
    let mut document = EditorDocument::new("abcdef\nabcdef\nabcdef");

    document.select_column(0, 1, 2, 3, 4);

    assert_eq!(document.selections(), [0, 1, 0, 3, 1, 1, 1, 3, 2, 1, 2, 3]);
    assert_eq!(document.primary_selection(), 2);
}

#[test]
fn merge3_tags_clean_text_and_conflicting_blocks() {
    assert_eq!(
        merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n"),
        ["clean", "A\nb\nC\n"]
    );
    assert_eq!(
        merge3("a\nb\nc\n", "a\nmine\nc\n", "a\ntheirs\nc\n"),
        [
            "clean", "a\n", "conflict", "b\n", "mine\n", "theirs\n", "clean", "c\n"
        ]
    );
}
