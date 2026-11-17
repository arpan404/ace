// SPDX-License-Identifier: Apache-2.0

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod support;

use support::{indexed, paths};

#[test]
fn finds_file_by_scattered_letters() {
    let fixture = indexed(&["src/server/main.rs", "docs/notes.md"]);
    let hits = fixture.index.search("srvmain", 10);
    assert_eq!(paths(&hits), ["src/server/main.rs"]);
    let positions = &hits[0].positions;
    assert_eq!(positions.len(), 7, "one position per matched letter");
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(
        positions
            .iter()
            .all(|position| (*position as usize) < "src/server/main.rs".len())
    );
}

#[test]
fn file_name_match_ranks_above_folder_match() {
    let fixture = indexed(&["ace/notes.txt", "src/ace_notes.rs"]);
    let hits = fixture.index.search("ace", 10);
    assert_eq!(
        paths(&hits),
        ["src/ace_notes.rs", "ace/notes.txt"],
        "the match inside the file name wins"
    );
}

#[test]
fn slash_query_matches_path_segments() {
    let fixture = indexed(&["crates/ace/src/lib.rs", "crates/other/ace.rs"]);
    let hits = fixture.index.search("crates/ace", 10);
    assert_eq!(hits[0].path, "crates/ace/src/lib.rs");
    assert_eq!(
        hits[0].positions,
        (0..10).collect::<Vec<u32>>(),
        "the query matches the two segments it names"
    );
}

#[test]
fn empty_query_returns_nothing() {
    let fixture = indexed(&["src/main.rs"]);
    assert!(fixture.index.search("", 10).is_empty());
    assert!(fixture.index.search("   ", 10).is_empty());
    assert!(fixture.index.search("main", 0).is_empty());
}

#[test]
fn search_is_case_insensitive() {
    let fixture = indexed(&["src/PathIndex.rs"]);
    assert_eq!(
        paths(&fixture.index.search("pathindex", 10)),
        ["src/PathIndex.rs"]
    );
    assert_eq!(
        paths(&fixture.index.search("PATHINDEX", 10)),
        ["src/PathIndex.rs"]
    );
}

#[test]
fn shorter_path_wins_when_everything_else_ties() {
    let fixture = indexed(&["a/b/c/main.rs", "main.rs"]);
    let hits = fixture.index.search("main.rs", 10);
    assert_eq!(paths(&hits), ["main.rs", "a/b/c/main.rs"]);
}
