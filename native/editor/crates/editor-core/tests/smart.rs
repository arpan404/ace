// SPDX-License-Identifier: Apache-2.0

//! Auto-closing pairs, typing over closers, wrapping, Enter's indent, smart Backspace, and
//! indentation detection.

use editor_core::{Document, Indent, Position, Selection, detect_indent};

fn caret(line: u32, column: u32) -> Selection {
    Selection::caret(Position::new(line, column))
}

fn doc(text: &str, at: Selection) -> Document {
    let mut document = Document::new(text);
    document.set_selections(vec![at]);
    document
}

#[test]
fn an_opening_bracket_closes_itself_and_the_closer_types_over() {
    let mut document = doc("", caret(0, 0));
    document.type_text("(");
    assert_eq!(document.text(), "()");
    assert_eq!(document.selections(), &[caret(0, 1)]);
    document.type_text("a");
    document.type_text(")");
    assert_eq!(document.text(), "(a)");
    assert_eq!(document.selections(), &[caret(0, 3)]);
}

#[test]
fn a_bracket_before_a_word_does_not_close() {
    let mut document = doc("word", caret(0, 0));
    document.type_text("(");
    assert_eq!(document.text(), "(word");
}

#[test]
fn a_quote_after_a_word_is_an_apostrophe() {
    let mut document = doc("don", caret(0, 3));
    document.type_text("'");
    assert_eq!(document.text(), "don'");
    let mut document = doc("x = ", caret(0, 4));
    document.type_text("\"");
    assert_eq!(document.text(), "x = \"\"");
}

#[test]
fn a_bracket_over_a_selection_wraps_it_and_keeps_it_selected() {
    let mut document = doc(
        "a b",
        Selection::new(Position::new(0, 0), Position::new(0, 3)),
    );
    document.type_text("[");
    assert_eq!(document.text(), "[a b]");
    assert_eq!(
        document.selections(),
        &[Selection::new(Position::new(0, 1), Position::new(0, 4))]
    );
}

#[test]
fn a_paste_is_never_paired() {
    let mut document = doc("", caret(0, 0));
    document.type_text("((");
    assert_eq!(document.text(), "((");
}

#[test]
fn a_pair_undoes_in_one_step() {
    let mut document = doc("", caret(0, 0));
    document.type_text("{");
    document.undo();
    assert_eq!(document.text(), "");
}

#[test]
fn enter_between_braces_puts_the_closer_on_its_own_line() {
    let mut document = doc("  if x {}", caret(0, 8));
    document.smart_newline();
    assert_eq!(document.text(), "  if x {\n    \n  }");
    assert_eq!(document.selections(), &[caret(1, 4)]);
}

#[test]
fn enter_after_an_opening_bracket_indents_one_step() {
    let mut document = doc("call(", caret(0, 5));
    document.set_indent(Indent {
        tabs: true,
        size: 4,
    });
    document.smart_newline();
    assert_eq!(document.text(), "call(\n\t");
}

#[test]
fn enter_elsewhere_keeps_the_lines_indentation() {
    let mut document = doc("    x = 1", caret(0, 9));
    document.smart_newline();
    assert_eq!(document.text(), "    x = 1\n    ");
}

#[test]
fn enter_in_crlf_keeps_crlf() {
    let mut document = doc("a {}\r\n", caret(0, 3));
    document.smart_newline();
    assert_eq!(document.text(), "a {\r\n  \r\n}\r\n");
}

#[test]
fn backspace_in_leading_spaces_removes_one_indent_step() {
    let mut document = doc("        x", caret(0, 8));
    document.set_indent(Indent {
        tabs: false,
        size: 4,
    });
    document.smart_backspace();
    assert_eq!(document.text(), "    x");
    // Off a stop, it goes back to the previous stop.
    let mut document = doc("      x", caret(0, 6));
    document.set_indent(Indent {
        tabs: false,
        size: 4,
    });
    document.smart_backspace();
    assert_eq!(document.text(), "    x");
}

#[test]
fn backspace_in_an_empty_pair_removes_both_halves() {
    let mut document = doc("f()", caret(0, 2));
    document.smart_backspace();
    assert_eq!(document.text(), "f");
}

#[test]
fn backspace_after_text_removes_one_character() {
    let mut document = doc("  ab", caret(0, 4));
    document.smart_backspace();
    assert_eq!(document.text(), "  a");
}

#[test]
fn detection_reads_tabs_and_space_steps() {
    assert_eq!(
        detect_indent("fn a() {\n\tb();\n\tc();\n}".lines()),
        Some(Indent {
            tabs: true,
            size: 2
        })
    );
    assert_eq!(
        detect_indent("a:\n    b:\n        c\n    d".lines()),
        Some(Indent {
            tabs: false,
            size: 4
        })
    );
    assert_eq!(
        detect_indent("{\n  a\n  b\n    c\n}".lines()),
        Some(Indent {
            tabs: false,
            size: 2
        })
    );
    assert_eq!(detect_indent("a\nb".lines()), None);
}

#[test]
fn a_document_detects_its_own_indent() {
    let document = Document::new("x\n    y\n");
    assert_eq!(
        document.detect_indent(),
        Some(Indent {
            tabs: false,
            size: 4
        })
    );
}
