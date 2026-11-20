// SPDX-License-Identifier: Apache-2.0

//! Three-way merge: the person's unsaved text (mine) and the disk (theirs), both from the text
//! the person started from (base).

use editor_core::{MergeChunk, merge3};

/// The merged text when the merge is clean; fails the test otherwise.
fn clean(base: &str, mine: &str, theirs: &str) -> String {
    let merged = merge3(base, mine, theirs);
    match merged.text() {
        Some(text) => text,
        None => panic!("expected a clean merge, got {:?}", merged.chunks()),
    }
}

fn conflict(base: &str, mine: &str, theirs: &str) -> MergeChunk {
    MergeChunk::Conflict {
        base: base.to_owned(),
        mine: mine.to_owned(),
        theirs: theirs.to_owned(),
    }
}

fn clean_chunk(text: &str) -> MergeChunk {
    MergeChunk::Clean(text.to_owned())
}

#[test]
fn changes_to_different_lines_both_land() {
    let table = [
        // mine edits the top, theirs the bottom
        (
            "a\nb\nc\nd\n",
            "A\nb\nc\nd\n",
            "a\nb\nc\nD\n",
            "A\nb\nc\nD\n",
        ),
        // mine inserts, theirs appends
        (
            "a\nb\nc\n",
            "a\nnew\nb\nc\n",
            "a\nb\nc\nend\n",
            "a\nnew\nb\nc\nend\n",
        ),
        // one line apart is still apart
        ("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", "A\nb\nC\n"),
    ];
    for (base, mine, theirs, merged) in table {
        assert_eq!(clean(base, mine, theirs), merged, "base {base:?}");
    }
}

#[test]
fn a_side_that_changed_nothing_takes_the_other_side_whole() {
    assert_eq!(clean("a\nb\n", "a\nb\n", "x\ny\nz"), "x\ny\nz");
    assert_eq!(clean("a\nb\n", "q\n", "a\nb\n"), "q\n");
    assert_eq!(clean("", "", "new file\n"), "new file\n");
}

#[test]
fn identical_changes_on_both_sides_land_once() {
    let table = [
        ("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n", "a\nB\nc\n"),
        ("a\nb\nc\n", "a\nc\n", "a\nc\n", "a\nc\n"),
        ("a\nc\n", "a\nb\nc\n", "a\nb\nc\n", "a\nb\nc\n"),
    ];
    for (base, mine, theirs, merged) in table {
        assert_eq!(clean(base, mine, theirs), merged, "mine {mine:?}");
    }
}

#[test]
fn overlapping_changes_conflict_with_both_sides_and_the_base() {
    let merged = merge3("a\nb\nc\n", "a\nmine\nc\n", "a\ntheirs\nc\n");

    assert!(!merged.is_clean());
    assert_eq!(merged.text(), None);
    assert_eq!(
        merged.chunks(),
        [
            clean_chunk("a\n"),
            conflict("b\n", "mine\n", "theirs\n"),
            clean_chunk("c\n"),
        ]
    );
}

#[test]
fn a_block_both_sides_rewrote_differently_is_one_conflict_spanning_both_edits() {
    // mine rewrites b..c, theirs rewrites c..d: they share c, so the block b..d is one question.
    let merged = merge3("a\nb\nc\nd\ne\n", "a\nB\nC\nd\ne\n", "a\nb\nC2\nD\ne\n");
    assert_eq!(
        merged.chunks(),
        [
            clean_chunk("a\n"),
            conflict("b\nc\nd\n", "B\nC\nd\n", "b\nC2\nD\n"),
            clean_chunk("e\n"),
        ]
    );
}

#[test]
fn two_different_insertions_at_one_place_conflict() {
    let merged = merge3("a\nb\n", "a\nmine\nb\n", "a\ntheirs\nb\n");
    assert_eq!(
        merged.chunks(),
        [
            clean_chunk("a\n"),
            conflict("", "mine\n", "theirs\n"),
            clean_chunk("b\n"),
        ]
    );
}

#[test]
fn changes_on_neighbouring_lines_are_asked_about_not_guessed() {
    // theirs inserts just after the line mine rewrote
    let merged = merge3("a\nb\nc\n", "a\nB\nc\n", "a\nb\nafter b\nc\n");
    assert_eq!(
        merged.chunks(),
        [
            clean_chunk("a\n"),
            conflict("b\n", "B\n", "b\nafter b\n"),
            clean_chunk("c\n"),
        ]
    );
    // two rewrites of touching lines
    let merged = merge3("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nC\nd\n");
    assert_eq!(
        merged.chunks(),
        [
            clean_chunk("a\n"),
            conflict("b\nc\n", "B\nc\n", "b\nC\n"),
            clean_chunk("d\n"),
        ]
    );
}

#[test]
fn lines_one_side_deleted_go_when_the_other_side_left_them_alone() {
    assert_eq!(
        clean("a\nb\nc\nd\ne\n", "a\nd\ne\n", "a\nb\nc\nd\nE\n"),
        "a\nd\nE\n"
    );
}

#[test]
fn deleting_lines_the_other_side_edited_conflicts() {
    let merged = merge3("a\nb\nc\n", "a\nc\n", "a\nB\nc\n");
    assert_eq!(
        merged.chunks(),
        [
            clean_chunk("a\n"),
            conflict("b\n", "", "B\n"),
            clean_chunk("c\n"),
        ]
    );
}

#[test]
fn a_file_emptied_on_disk_under_edits_conflicts_whole() {
    let merged = merge3("a\nb\n", "a\nb\nmore\n", "");
    assert_eq!(merged.chunks(), [conflict("a\nb\n", "a\nb\nmore\n", "")]);
}

#[test]
fn crlf_line_endings_are_kept_as_they_were() {
    assert_eq!(
        clean("a\r\nb\r\nc\r\n", "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n"),
        "A\r\nb\r\nC\r\n"
    );
    let merged = merge3("a\r\nb\r\n", "a\r\nmine\r\n", "a\r\ntheirs\r\n");
    assert_eq!(
        merged.chunks(),
        [
            clean_chunk("a\r\n"),
            conflict("b\r\n", "mine\r\n", "theirs\r\n"),
        ]
    );
}

#[test]
fn a_last_line_without_a_newline_merges_with_an_append() {
    assert_eq!(clean("a\nx\nb", "A\nx\nb", "a\nx\nb\nc"), "A\nx\nb\nc");
}

#[test]
fn text_outside_any_change_is_copied_through_exactly() {
    let base = "α\n\tβ  \n\n日本\n";
    let mine = "α\n\tβ  \n\n日本\nmine\n";
    assert_eq!(clean(base, mine, base), mine);
    assert_eq!(clean(base, base, base), base);
}

#[test]
fn a_large_file_with_edits_at_both_ends_merges_cleanly() {
    let base: String = (0..200_000).map(|line| format!("line {line}\n")).collect();
    let mine = base.replacen("line 10\n", "mine 10\n", 1);
    let theirs = base.replacen("line 199990\n", "theirs 199990\n", 1);

    let merged = clean(&base, &mine, &theirs);

    assert!(merged.contains("mine 10\n"));
    assert!(merged.contains("theirs 199990\n"));
    assert_eq!(merged.len(), base.len() + 2);
}

mod line_changes {
    use editor_core::{LineChange, line_changes};

    fn change(start: u32, end: u32, text: &str) -> LineChange {
        LineChange {
            start,
            end,
            text: text.to_owned(),
        }
    }

    /// Applies changes the way a client does: whole lines, bottom first.
    fn apply(before: &str, changes: &[LineChange]) -> String {
        let mut lines: Vec<String> = before.split_inclusive('\n').map(str::to_owned).collect();
        for change in changes.iter().rev() {
            lines.splice(
                change.start as usize..change.end as usize,
                [change.text.clone()],
            );
        }
        lines.concat()
    }

    #[test]
    fn each_changed_block_is_its_own_change_so_text_between_stays_put() {
        let before = "a\nb\nc\nd\ne\n";
        let after = "A\nb\nc\nd\nE\nf\n";
        let changes = line_changes(before, after);
        assert_eq!(changes, [change(0, 1, "A\n"), change(4, 5, "E\nf\n")]);
        assert_eq!(apply(before, &changes), after);
    }

    #[test]
    fn insertions_deletions_and_line_endings_round_trip() {
        let table = [
            ("a\nb\n", "a\nnew\nb\n"),
            ("a\nb\nc\n", "a\nc\n"),
            ("a\r\nb\r\n", "a\r\nB\r\n"),
            ("a\nb", "a\nb\nc"),
            ("", "x\n"),
            ("x\n", ""),
            ("same\n", "same\n"),
        ];
        for (before, after) in table {
            assert_eq!(
                apply(before, &line_changes(before, after)),
                after,
                "{before:?}"
            );
        }
        assert_eq!(line_changes("same\n", "same\n"), []);
    }
}
