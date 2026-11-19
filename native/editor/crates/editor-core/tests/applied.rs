// SPDX-License-Identifier: Apache-2.0

//! Transactions and the line spans they report to a highlighter.

use editor_core::{Document, LineEdit, Position, Replacement, Selection, Transaction};

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
fn an_edit_reports_the_range_it_replaced_and_where_its_text_ends() {
    let mut document = Document::new("abc\ndef");
    let applied = document.apply(Transaction::replace(
        editor_core::Range::new(Position::new(0, 1), Position::new(1, 2)),
        "X\nY",
    ));

    assert_eq!(
        applied.replacements,
        vec![Replacement {
            start: Position::new(0, 1),
            end: Position::new(1, 2),
            post_end: Position::new(1, 1),
        }]
    );

    // Undo replaces the text the edit inserted; its range is in the coordinates it starts from.
    let undone = document.undo().expect("the replacement");
    assert_eq!(
        undone.replacements,
        vec![Replacement {
            start: Position::new(0, 1),
            end: Position::new(1, 1),
            post_end: Position::new(1, 2),
        }]
    );
}

#[test]
fn an_edit_inside_one_line_reports_columns_the_view_can_map() {
    let mut document = Document::new("hello world");
    document.set_selections(vec![Selection::caret(Position::new(0, 5))]);

    let applied = document.insert_text("!");

    assert_eq!(
        applied.replacements,
        vec![Replacement {
            start: Position::new(0, 5),
            end: Position::new(0, 5),
            post_end: Position::new(0, 6),
        }]
    );
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

#[test]
fn applied_merges_changes_on_one_line() {
    let mut document = Document::new("abcdef");
    document.set_selections(vec![
        Selection::caret(Position::new(0, 1)),
        Selection::caret(Position::new(0, 4)),
    ]);

    let applied = document.insert_text("x");

    assert_eq!(
        applied.spans,
        vec![LineEdit {
            first_line: 0,
            removed_lines: 1,
            inserted_lines: 1,
        }]
    );
    assert_eq!(applied.first_line, 0);
    assert_eq!(applied.removed_lines, 1);
    assert_eq!(applied.inserted_lines, 1);
}

#[test]
fn applied_merges_changes_on_touching_lines() {
    let mut document = Document::new("a\nb");
    document.set_selections(vec![
        Selection::caret(Position::new(0, 0)),
        Selection::caret(Position::new(1, 0)),
    ]);

    let applied = document.insert_text("x");

    assert_eq!(
        applied.spans,
        vec![LineEdit {
            first_line: 0,
            removed_lines: 2,
            inserted_lines: 2,
        }]
    );
}

#[test]
fn applied_keeps_cursors_on_line_zero_and_the_last_line_apart() {
    let source = format!("{}x", "x\n".repeat(199_999));
    let mut document = Document::new(&source);
    document.set_selections(vec![
        Selection::caret(Position::new(0, 0)),
        Selection::caret(Position::new(199_999, 0)),
    ]);

    let applied = document.insert_text("q");

    assert_eq!(
        applied.spans,
        vec![
            LineEdit {
                first_line: 0,
                removed_lines: 1,
                inserted_lines: 1,
            },
            LineEdit {
                first_line: 199_999,
                removed_lines: 1,
                inserted_lines: 1,
            },
        ]
    );
    assert_eq!(applied.first_line, 0);
    assert_eq!(applied.removed_lines, 200_000);
    assert_eq!(applied.inserted_lines, 200_000);
}

#[test]
fn a_no_op_reports_no_spans_and_keeps_the_version() {
    let mut document = Document::new("x");
    let applied = document.apply(Transaction::new());

    assert!(applied.spans.is_empty());
    assert_eq!(applied.first_line, 0);
    assert_eq!(applied.removed_lines, 0);
    assert_eq!(applied.inserted_lines, 0);
    assert_eq!(applied.version, 0);
}

#[test]
fn editing_the_last_line_reports_a_span_and_undo_restores_it() {
    let mut document = Document::new("first\nlast");
    document.set_selections(vec![Selection::caret(Position::new(1, 4))]);

    let applied = document.insert_text("!");

    assert_eq!(document.text(), "first\nlast!");
    assert_eq!(
        applied.spans,
        vec![LineEdit {
            first_line: 1,
            removed_lines: 1,
            inserted_lines: 1,
        }]
    );

    let undone = document.undo().expect("the insert");
    assert_eq!(document.text(), "first\nlast");
    assert_eq!(
        document.selections(),
        &[Selection::caret(Position::new(1, 4))]
    );
    assert_eq!(
        undone.spans,
        vec![LineEdit {
            first_line: 1,
            removed_lines: 1,
            inserted_lines: 1,
        }]
    );

    document.set_selections(vec![Selection::new(
        Position::new(1, 0),
        Position::new(1, 4),
    )]);
    document.backspace();
    assert_eq!(document.text(), "first\n");
    assert_eq!(document.len_lines(), 2);
    document.undo().expect("the delete");
    assert_eq!(document.text(), "first\nlast");
}

#[test]
fn applying_spans_top_to_bottom_rebuilds_the_new_lines() {
    let mut document = Document::new("a\nb\nc\nd\ne\nf");
    let mut old: Vec<String> = (0..document.len_lines())
        .map(|line| document.line(line).to_string())
        .collect();
    document.set_selections(vec![
        Selection::caret(Position::new(0, 1)),
        Selection::caret(Position::new(4, 1)),
    ]);

    let applied = document.insert_text("\n");

    let new: Vec<String> = (0..document.len_lines())
        .map(|line| document.line(line).to_string())
        .collect();
    assert_eq!(
        applied.spans,
        vec![
            LineEdit {
                first_line: 0,
                removed_lines: 1,
                inserted_lines: 2,
            },
            LineEdit {
                first_line: 5,
                removed_lines: 1,
                inserted_lines: 2,
            },
        ]
    );
    for span in &applied.spans {
        let start = span.first_line as usize;
        let removed = span.removed_lines as usize;
        let inserted = span.inserted_lines as usize;
        old.splice(
            start..start + removed,
            new[start..start + inserted].to_vec(),
        );
    }
    assert_eq!(old, new);
}
