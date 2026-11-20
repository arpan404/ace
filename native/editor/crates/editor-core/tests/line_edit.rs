// SPDX-License-Identifier: Apache-2.0

//! Copy line up, delete line, insert line above and below, join lines, Tab, block comments.

use editor_core::{Document, Indent, Position, Selection};

fn caret(line: u32, column: u32) -> Selection {
    Selection::caret(Position::new(line, column))
}

fn select(a: (u32, u32), b: (u32, u32)) -> Selection {
    Selection::new(Position::new(a.0, a.1), Position::new(b.0, b.1))
}

fn doc(text: &str, selections: Vec<Selection>) -> Document {
    let mut document = Document::new(text);
    document.set_selections(selections);
    document
}

#[test]
fn copy_lines_up_keeps_the_caret_on_the_upper_copy() {
    let mut document = doc("a\nb\nc", vec![caret(1, 1)]);
    document.copy_lines_up();
    assert_eq!(document.text(), "a\nb\nb\nc");
    assert_eq!(document.selections(), &[caret(1, 1)]);
}

#[test]
fn copy_lines_up_copies_a_last_line_without_a_break() {
    let mut document = doc("a\nb", vec![caret(1, 0)]);
    document.copy_lines_up();
    assert_eq!(document.text(), "a\nb\nb");
    assert_eq!(document.selections(), &[caret(1, 0)]);
}

#[test]
fn delete_lines_removes_the_line_and_keeps_the_column_on_the_next() {
    let mut document = doc("one\ntwo\nthree", vec![caret(1, 2)]);
    document.delete_lines();
    assert_eq!(document.text(), "one\nthree");
    assert_eq!(document.selections(), &[caret(1, 2)]);
}

#[test]
fn delete_lines_on_the_last_line_takes_the_break_before_it() {
    let mut document = doc("one\ntwo", vec![caret(1, 1)]);
    document.delete_lines();
    assert_eq!(document.text(), "one");
    assert_eq!(document.selections(), &[caret(0, 1)]);
}

#[test]
fn delete_lines_removes_every_line_a_selection_touches_and_undoes_once() {
    let mut document = doc("a\nb\nc\nd", vec![select((0, 0), (1, 1)), caret(3, 0)]);
    document.delete_lines();
    assert_eq!(document.text(), "c");
    document.undo();
    assert_eq!(document.text(), "a\nb\nc\nd");
}

#[test]
fn insert_line_below_opens_an_indented_line_wherever_the_caret_is() {
    let mut document = doc("  if x {\nend", vec![caret(0, 3)]);
    document.insert_line_below();
    assert_eq!(document.text(), "  if x {\n  \nend");
    assert_eq!(document.selections(), &[caret(1, 2)]);
}

#[test]
fn insert_line_above_opens_an_indented_line_above() {
    let mut document = doc("a\n    b", vec![caret(1, 5)]);
    document.insert_line_above();
    assert_eq!(document.text(), "a\n    \n    b");
    assert_eq!(document.selections(), &[caret(1, 4)]);
}

#[test]
fn join_lines_drops_the_next_lines_indent_and_adds_one_space() {
    let mut document = doc("let a =\n    1;", vec![caret(0, 2)]);
    document.join_lines();
    assert_eq!(document.text(), "let a = 1;");
    assert_eq!(document.selections(), &[caret(0, 7)]);
}

#[test]
fn join_lines_joins_every_line_of_a_selection() {
    let mut document = doc("a\nb\nc\nd", vec![select((0, 0), (2, 1))]);
    document.join_lines();
    assert_eq!(document.text(), "a b c\nd");
}

#[test]
fn join_lines_adds_no_space_before_an_empty_line() {
    let mut document = doc("a \n\nb", vec![caret(0, 0)]);
    document.join_lines();
    assert_eq!(document.text(), "a \nb");
}

#[test]
fn tab_at_a_caret_inserts_spaces_up_to_the_next_stop() {
    let mut document = doc("abc", vec![caret(0, 1)]);
    document.set_indent(Indent {
        tabs: false,
        size: 4,
    });
    document.tab();
    assert_eq!(document.text(), "a   bc");
    assert_eq!(document.selections(), &[caret(0, 4)]);
}

#[test]
fn tab_over_lines_indents_them_and_with_tabs_writes_a_tab() {
    let mut document = doc("a\nb", vec![select((0, 0), (1, 1))]);
    document.set_indent(Indent {
        tabs: true,
        size: 4,
    });
    document.tab();
    assert_eq!(document.text(), "\ta\n\tb");
}

#[test]
fn outdent_removes_one_step_of_the_documents_indent() {
    let mut document = doc("        x", vec![caret(0, 8)]);
    document.set_indent(Indent {
        tabs: false,
        size: 4,
    });
    document.outdent_lines();
    assert_eq!(document.text(), "    x");
}

#[test]
fn block_comment_wraps_a_selection_and_toggles_back() {
    let mut document = doc("call(a, b)", vec![select((0, 5), (0, 9))]);
    document.toggle_block_comment("/*", "*/");
    assert_eq!(document.text(), "call(/* a, b */)");
    assert_eq!(document.selections(), &[select((0, 8), (0, 12))]);
    document.toggle_block_comment("/*", "*/");
    assert_eq!(document.text(), "call(a, b)");
    assert_eq!(document.selections(), &[select((0, 5), (0, 9))]);
}

#[test]
fn block_comment_unwraps_a_selection_that_includes_the_delimiters() {
    let mut document = doc("<!-- hi -->", vec![select((0, 0), (0, 11))]);
    document.toggle_block_comment("<!--", "-->");
    assert_eq!(document.text(), "hi");
}

#[test]
fn block_comment_at_a_caret_inserts_an_empty_comment_around_it() {
    let mut document = doc("x", vec![caret(0, 1)]);
    document.toggle_block_comment("/*", "*/");
    assert_eq!(document.text(), "x/*  */");
    assert_eq!(document.selections(), &[caret(0, 4)]);
}
