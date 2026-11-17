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

    document.select_column(Position::new(0, 1), Position::new(2, 3), 4);

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

#[test]
fn find_anchors_lines_and_returns_zero_length_matches() {
    let document = Document::new("one\ntwo\r\nthree");

    let starts = FindQuery {
        pattern: "^".to_owned(),
        regex: true,
        case_sensitive: true,
        whole_word: false,
    };
    assert_eq!(
        document.find(&starts, 10),
        vec![
            Range::new(Position::new(0, 0), Position::new(0, 0)),
            Range::new(Position::new(1, 0), Position::new(1, 0)),
            Range::new(Position::new(2, 0), Position::new(2, 0)),
        ]
    );

    let ends = FindQuery {
        pattern: "$".to_owned(),
        regex: true,
        case_sensitive: true,
        whole_word: false,
    };
    assert_eq!(
        document.find(&ends, 10),
        vec![
            Range::new(Position::new(0, 3), Position::new(0, 3)),
            Range::new(Position::new(1, 3), Position::new(1, 3)),
            Range::new(Position::new(2, 5), Position::new(2, 5)),
        ]
    );

    let zero_length = FindQuery {
        pattern: "x*".to_owned(),
        regex: true,
        case_sensitive: true,
        whole_word: false,
    };
    let hits = document.find(&zero_length, 4);
    assert_eq!(hits.len(), 4);
    assert!(hits.iter().all(Range::is_empty));
}

#[test]
fn find_sees_edits_after_the_cached_text_is_built() {
    let mut document = Document::new("cat");
    let query = FindQuery::new("cat");
    assert_eq!(document.find(&query, 10).len(), 1);

    document.set_selections(vec![Selection::caret(Position::new(0, 0))]);
    document.insert_text("cat ");

    let hits = document.find(&query, 10);
    assert_eq!(hits.len(), 2);
    assert_eq!(
        hits[0],
        Range::new(Position::new(0, 0), Position::new(0, 3))
    );
    assert_eq!(
        hits[1],
        Range::new(Position::new(0, 4), Position::new(0, 7))
    );
}

#[test]
fn select_next_occurrence_from_a_caret_matches_whole_words_only() {
    let mut document = Document::new("cat scatter cat");
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
        Range::new(Position::new(0, 12), Position::new(0, 15))
    );
}

#[test]
fn select_next_occurrence_from_a_selection_matches_inside_words() {
    let mut document = Document::new("cat scatter cat");
    document.set_selections(vec![Selection::new(
        Position::new(0, 0),
        Position::new(0, 3),
    )]);

    assert!(document.select_next_occurrence());
    assert_eq!(document.selections().len(), 2);
    assert_eq!(
        document.selections()[1].range(),
        Range::new(Position::new(0, 5), Position::new(0, 8))
    );
}

#[test]
fn select_next_occurrence_wraps_and_reveals_the_newest_selection() {
    let mut document = Document::new("foo a foo b foo");
    document.set_selections(vec![Selection::new(
        Position::new(0, 12),
        Position::new(0, 15),
    )]);

    assert!(document.select_next_occurrence());
    assert_eq!(document.selections().len(), 2);
    assert_eq!(
        document.selections()[0].range(),
        Range::new(Position::new(0, 0), Position::new(0, 3))
    );
    assert_eq!(document.primary_selection(), 0);

    assert!(document.select_next_occurrence());
    assert_eq!(document.selections().len(), 3);
    assert_eq!(
        document.selections()[1].range(),
        Range::new(Position::new(0, 6), Position::new(0, 9))
    );
    assert_eq!(document.primary_selection(), 1);

    assert!(!document.select_next_occurrence());
}

#[test]
fn box_selection_expands_tabs_in_visual_columns() {
    let mut document = Document::new("a\tb\nabcd");

    document.select_column(Position::new(0, 1), Position::new(1, 4), 4);

    assert_eq!(document.selections().len(), 2);
    assert_eq!(
        document.selections()[0].range(),
        Range::new(Position::new(0, 1), Position::new(0, 2))
    );
    assert_eq!(
        document.selections()[1].range(),
        Range::new(Position::new(1, 1), Position::new(1, 4))
    );
}

#[test]
fn box_selection_counts_a_combining_sequence_as_one_visual_column() {
    let mut document = Document::new("e\u{301}x");

    document.select_column(Position::new(0, 0), Position::new(0, 1), 4);

    assert_eq!(
        document.selections()[0].range(),
        Range::new(Position::new(0, 0), Position::new(0, 2))
    );
}

#[test]
fn merging_selections_keeps_the_later_selections_direction() {
    let mut document = Document::new("abcdef");
    document.set_selections(vec![
        Selection::new(Position::new(0, 0), Position::new(0, 2)),
        Selection::new(Position::new(0, 3), Position::new(0, 1)),
    ]);

    assert_eq!(document.selections().len(), 1);
    assert_eq!(
        document.selections()[0],
        Selection::new(Position::new(0, 3), Position::new(0, 0))
    );

    document.set_selections(vec![
        Selection::new(Position::new(0, 3), Position::new(0, 1)),
        Selection::new(Position::new(0, 0), Position::new(0, 2)),
    ]);

    assert_eq!(
        document.selections()[0],
        Selection::new(Position::new(0, 0), Position::new(0, 3))
    );
}
