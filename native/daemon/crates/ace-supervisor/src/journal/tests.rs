// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::test_scratch::Scratch;

fn member(pid: u32, start: &str) -> JournalMember {
    JournalMember {
        pid,
        start: start.to_owned(),
    }
}

#[test]
fn escapees_record_forget_and_read_back_by_run() {
    let scratch = Scratch::new();
    let path = scratch.file("processes.sqlite");
    let journal = EscapeeJournal::open(&path, "run-a").expect("journal opens");
    journal
        .record(&[member(10, "s10"), member(20, "s20")])
        .expect("records");
    journal.forget(&[member(10, "s10")]).expect("forgets");
    // Same run sees nothing earlier; a later run sees the leftover.
    assert!(journal.earlier().expect("earlier").is_empty());
    let next = EscapeeJournal::open(&path, "run-b").expect("journal opens");
    assert_eq!(
        next.earlier().expect("earlier"),
        vec![crate::journal::EscapeeRow {
            pid: 20,
            start: "s20".to_owned(),
            run: "run-a".to_owned(),
        }]
    );
    journal.close().expect("closes");
    next.close().expect("closes");
}

#[test]
fn kept_and_lineage_read_back_for_stop() {
    let scratch = Scratch::new();
    let path = scratch.file("processes.sqlite");
    let journal = EscapeeJournal::open(&path, "run-a").expect("journal opens");
    journal.keep(&member(30, "s30"), &|_| true).expect("keeps");
    journal
        .record_lineage(&["u1".to_owned()])
        .expect("records lineage");
    journal.forget_earlier_lineage().expect("forgets earlier");
    let ownership = read_ownership(&path, Some("run-a")).expect("reads");
    assert_eq!(ownership.kept, vec![member(30, "s30")]);
    assert_eq!(ownership.lineage, vec!["u1".to_owned()]);
    assert!(ownership.escapees.is_empty());
    assert!(
        read_ownership(&scratch.file("missing.sqlite"), Some("run-a"))
            .expect("reads")
            .kept
            .is_empty()
    );
}
