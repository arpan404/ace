// SPDX-License-Identifier: Apache-2.0

//! Behaviour of find, next-occurrence selection and box selection.

use editor_core::{Document, FindQuery, Position, Range, Selection};

#[test]
fn find_regex_and_whole_word() {
    let document = Document::new("cat scatter Cat concatenate cat");

    let whole_word = FindQuery {
        pattern: "cat".to_owned(),
        regex: false,
        case_sensitive: false,
        whole_word: true,
    };
    assert_eq!(
        document.find(&whole_word, 10),
        vec![
            Range::new(Position::new(0, 0), Position::new(0, 3)),
            Range::new(Position::new(0, 12), Position::new(0, 15)),
            Range::new(Position::new(0, 28), Position::new(0, 31)),
        ]
    );

    let regex = FindQuery {
        pattern: r"\bcat\b".to_owned(),
        regex: true,
        case_sensitive: true,
        whole_word: false,
    };
    assert_eq!(
        document.find(&regex, 10),
        vec![
            Range::new(Position::new(0, 0), Position::new(0, 3)),
            Range::new(Position::new(0, 28), Position::new(0, 31)),
        ]
    );
}

#[test]
fn find_honours_the_limit_and_an_empty_pattern() {
    let document = Document::new("cat cat cat");
    let query = FindQuery::new("cat");

    assert_eq!(document.find(&query, 2).len(), 2);
    assert!(document.find(&query, 0).is_empty());
    assert!(document.find(&FindQuery::new(""), 10).is_empty());
}

#[test]
fn an_invalid_regex_finds_nothing() {
    let document = Document::new("text");
    let query = FindQuery {
        pattern: "(".to_owned(),
        regex: true,
        case_sensitive: true,
        whole_word: false,
    };

    assert!(document.find(&query, 10).is_empty());
}

#[test]
fn select_next_occurrence_adds_cursor() {
    let mut document = Document::new("foo bar foo baz foo");
    document.set_selections(vec![Selection::new(
        Position::new(0, 0),
        Position::new(0, 3),
    )]);

    assert!(document.select_next_occurrence());
    assert_eq!(document.selections().len(), 2);
    assert_eq!(
        document.selections()[1].range(),
        Range::new(Position::new(0, 8), Position::new(0, 11))
    );

    assert!(document.select_next_occurrence());
    assert_eq!(document.selections().len(), 3);
    assert_eq!(
        document.selections()[2].range(),
        Range::new(Position::new(0, 16), Position::new(0, 19))
    );

    assert!(!document.select_next_occurrence());
    assert_eq!(document.selections().len(), 3);
}

#[test]
fn select_next_occurrence_selects_the_word_under_a_caret_first() {
    let mut document = Document::new("foo foo");
    document.set_selections(vec![Selection::caret(Position::new(0, 1))]);

    assert!(document.select_next_occurrence());
    assert_eq!(
        document.selections(),
        &[Selection::new(Position::new(0, 0), Position::new(0, 3))]
    );

    assert!(document.select_next_occurrence());
    assert_eq!(document.selections().len(), 2);
    assert_eq!(
        document.selections()[1].range(),
        Range::new(Position::new(0, 4), Position::new(0, 7))
    );
}

#[test]
fn box_selection_clamps_short_lines() {
    let mut document = Document::new("abcd\nab\nabcdef");

    document.select_column(Position::new(0, 1), Position::new(2, 3));

    assert_eq!(document.selections().len(), 3);
    assert_eq!(
        document.selections()[0].range(),
        Range::new(Position::new(0, 1), Position::new(0, 3))
    );
    assert_eq!(
        document.selections()[1].range(),
        Range::new(Position::new(1, 1), Position::new(1, 2))
    );
    assert_eq!(
        document.selections()[2].range(),
        Range::new(Position::new(2, 1), Position::new(2, 3))
    );
}
