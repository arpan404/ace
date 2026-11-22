// SPDX-License-Identifier: Apache-2.0

//! The content id: which text the document holds, as its undo history sees it.

use editor_core::{Document, Position, Selection};

fn typed(text: &str) -> Document {
    let mut document = Document::new(text);
    document.set_selections(vec![Selection::caret(Position::new(0, 0))]);
    document
}

#[test]
fn undoing_back_to_the_opening_text_gives_back_its_content_id() {
    let mut document = typed("abc");
    let clean = document.content_id();

    document.insert_text("x");
    document.insert_text("y");
    assert_ne!(document.content_id(), clean);

    document.undo().expect("the typing run");
    assert_eq!(document.text(), "abc");
    assert_eq!(document.content_id(), clean);
}

#[test]
fn redo_returns_to_the_edited_content_id() {
    let mut document = typed("abc");
    document.insert_text("x");
    document.commit();
    let edited = document.content_id();

    document.undo().expect("the edit");
    document.redo().expect("the edit again");

    assert_eq!(document.content_id(), edited);
}

#[test]
fn each_typed_key_in_one_run_is_a_new_content_id() {
    let mut document = typed("abc");
    document.insert_text("x");
    let first = document.content_id();
    document.insert_text("y");

    assert_ne!(document.content_id(), first);
}

#[test]
fn a_new_edit_after_an_undo_never_reuses_an_undone_content_id() {
    let mut document = typed("abc");
    document.insert_text("x");
    document.commit();
    let undone = document.content_id();
    document.undo().expect("the edit");

    document.insert_text("z");

    assert_ne!(document.content_id(), undone);
}
