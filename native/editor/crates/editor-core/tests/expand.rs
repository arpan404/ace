// SPDX-License-Identifier: Apache-2.0

//! Expand selection, one unit at a time.

use editor_core::{Document, Position, Selection};

fn texts(document: &Document) -> Vec<String> {
    let text = document.text();
    let lines: Vec<&str> = text.split('\n').collect();
    document
        .selections()
        .iter()
        .map(|selection| {
            let range = selection.range();
            if range.start.line == range.end.line {
                let line = lines[range.start.line as usize];
                line[range.start.column as usize..range.end.column as usize].to_owned()
            } else {
                let mut out =
                    lines[range.start.line as usize][range.start.column as usize..].to_owned();
                for line in &lines[range.start.line as usize + 1..range.end.line as usize] {
                    out.push('\n');
                    out.push_str(line);
                }
                out.push('\n');
                out.push_str(&lines[range.end.line as usize][..range.end.column as usize]);
                out
            }
        })
        .collect()
}

#[test]
fn expansion_goes_word_then_brackets_then_line_then_block_then_document() {
    let text = "fn a() {\n    call(first, second);\n}";
    let mut document = Document::new(text);
    document.set_selections(vec![Selection::caret(Position::new(1, 12))]);
    let mut steps = Vec::new();
    while document.expand_selection() {
        steps.push(texts(&document)[0].clone());
    }
    assert_eq!(
        steps,
        vec![
            "first",
            "first, second",
            "(first, second)",
            "call(first, second);",
            "    call(first, second);",
            "\n    call(first, second);\n",
            "{\n    call(first, second);\n}",
            text,
        ]
    );
}

#[test]
fn every_cursor_expands_on_its_own() {
    let mut document = Document::new("one two");
    document.set_selections(vec![
        Selection::caret(Position::new(0, 1)),
        Selection::caret(Position::new(0, 5)),
    ]);
    assert!(document.expand_selection());
    assert_eq!(texts(&document), vec!["one", "two"]);
}
