// SPDX-License-Identifier: Apache-2.0

//! Quick open: the answer before the walk lands, the answer after it, and the answer when the
//! walk never finishes.
#![allow(clippy::unwrap_used, clippy::expect_used)]
// Every test here delays or stops the build through the binary's `test-hooks` feature.
#![cfg(feature = "test-hooks")]

mod common;

use std::path::Path;
use std::time::{Duration, Instant};

use common::{Client, WATCH_DEADLINE, await_reported, checkout, watch, write_file};
use files_wire::{EventPayload, Op, Reply};

/// How long the build may take before the test calls it hung.
const DEADLINE: Duration = Duration::from_secs(10);

/// Enough files that the walk outlasts the round trip of the first query.
const FILES: usize = 3_000;

#[test]
fn answers_an_index_query_before_and_after_the_build() {
    let checkout = checkout(&[("src/server_main.rs", "")]);
    for index in 0..FILES {
        write_file(checkout.path(), &format!("bulk/file{index:04}.txt"), "");
    }

    // The build publishes late on purpose, so "before" is a real state and not a race the test
    // loses on a fast machine.
    let mut client = Client::launch(&[("ACE_FILES_HOLD_INDEX_MS", "500")], false);
    client.hello();
    let root = client.open_root(checkout.path());
    let deadline = Instant::now() + DEADLINE;

    let first = client.request(Op::IndexQuery {
        root,
        query: "srvmain".to_owned(),
        limit: 10,
    });
    let index = match client.reply(first) {
        Reply::Index(index) => index,
        other => panic!("indexQuery answered {other:?}"),
    };
    assert!(
        !index.ready,
        "a freshly opened root reports its index as still building"
    );
    assert!(index.hits.is_empty(), "nothing to answer before the walk");
    assert_eq!(index.total, 0);

    let mut ready = false;
    while Instant::now() < deadline {
        let id = client.request(Op::IndexQuery {
            root,
            query: "srvmain".to_owned(),
            limit: 10,
        });
        let index = match client.reply(id) {
            Reply::Index(index) => index,
            other => panic!("indexQuery answered {other:?}"),
        };
        if index.ready {
            assert!(
                index
                    .hits
                    .iter()
                    .any(|hit| hit.path == "src/server_main.rs"),
                "the built index finds the file: {:?}",
                index.hits
            );
            assert!(index.total >= FILES as u64);
            assert!(!index.truncated);
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(ready, "the index finished within {DEADLINE:?}");
}

#[test]
fn an_edited_gitignore_walks_again_so_quick_open_follows_it() {
    let checkout = checkout(&[
        (".gitignore", "generated/\n"),
        ("generated/result.txt", "one\n"),
        ("src/main.rs", "fn main() {}\n"),
    ]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    await_ready(&mut client, root);
    await_hits(&mut client, root, "result", "generated/result.txt", false);
    let subscription = watch(&mut client, root);

    // The path exists all along; only the rules changed. Nothing in the tree tells the watcher
    // that, so the index has to walk the folder again under the new rules.
    write_file(checkout.path(), ".gitignore", "# nothing is ignored\n");
    await_ignore_change(
        &mut client,
        checkout.path(),
        subscription,
        "# nothing is ignored\n",
    );
    await_hits(&mut client, root, "result", "generated/result.txt", true);

    write_file(checkout.path(), ".gitignore", "generated/\n");
    await_ignore_change(&mut client, checkout.path(), subscription, "generated/\n");
    await_hits(&mut client, root, "result", "generated/result.txt", false);
}

#[test]
fn a_failed_walk_still_starts_the_walk_a_batch_asked_for() {
    let checkout = checkout(&[("a.txt", ""), (".gitignore", "# nothing is ignored\n")]);
    let mut client = Client::launch(
        &[
            ("ACE_FILES_HOLD_INDEX_MS", "600"),
            ("ACE_FILES_REBUILD_AFTER_MS", "100"),
            ("ACE_FILES_PANIC_INDEX_ONCE", "1"),
            ("ACE_FILES_INDEX_EVENTS", "1"),
        ],
        true,
    );
    client.hello();
    let root = client.open_root(checkout.path());
    client.await_index_published(1);
    let subscription = watch(&mut client, root);

    // The scheduled rebuild is walking and held now. An ignore-rule edit asks for a walk of the
    // folders it governs, which has to follow the running one.
    std::thread::sleep(Duration::from_millis(250));
    write_file(checkout.path(), ".gitignore", "ignored/\n");
    await_reported(&mut client, checkout.path(), subscription, ".gitignore");

    // That rebuild then fails on purpose. Its failure says nothing about the walk the rule
    // change asked for, which must still run and publish.
    client.await_index_published(2);
}

#[test]
fn an_ordinary_edit_during_a_walk_is_replayed_without_another_walk() {
    let checkout = checkout(&[("a.txt", "")]);
    let mut client = Client::launch(
        &[
            ("ACE_FILES_HOLD_INDEX_MS", "400"),
            ("ACE_FILES_REBUILD_AFTER_MS", "50"),
            ("ACE_FILES_INDEX_EVENTS", "1"),
        ],
        true,
    );
    client.hello();
    let root = client.open_root(checkout.path());
    client.await_index_published(1);
    let subscription = watch(&mut client, root);

    // The scheduled rebuild is walking and held; this edit waits in the pending queue and is
    // replayed onto the new index when it publishes.
    std::thread::sleep(Duration::from_millis(150));
    write_file(checkout.path(), "late.txt", "found me\n");
    await_reported(&mut client, checkout.path(), subscription, "late.txt");
    client.await_index_published(2);
    await_hits(&mut client, root, "late", "late.txt", true);

    // Only a lost-event rescan or a rule change asks for a follow-up walk; an ordinary edit
    // must not, or a busy checkout would walk itself on every save.
    std::thread::sleep(Duration::from_millis(900));
    assert_eq!(
        client.index_publishes(),
        2,
        "an ordinary edit during a walk must not start another walk"
    );
}

#[test]
fn refuses_a_quick_open_page_above_a_thousand_hits() {
    let checkout = checkout(&[("a.txt", "")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let too_big = client.request(Op::IndexQuery {
        root,
        query: "a".to_owned(),
        limit: 1_001,
    });
    assert_eq!(client.error(too_big).code, "INVALID_ARGUMENT");

    // A thousand is allowed, so the cap is a cap and not an off-by-one.
    let capped = client.request(Op::IndexQuery {
        root,
        query: "a".to_owned(),
        limit: 1_000,
    });
    assert!(matches!(client.reply(capped), Reply::Index(_)));
}

#[test]
fn a_file_created_during_the_first_build_is_found_afterwards() {
    let checkout = checkout(&[("a.txt", "")]);
    // The walk finishes at once and is then held before publishing, so a file that appears after
    // it can only reach the index through the change the watcher reports meanwhile.
    let mut client = Client::launch(&[("ACE_FILES_HOLD_INDEX_MS", "3000")], false);
    client.hello();
    let root = client.open_root(checkout.path());
    let subscription = watch(&mut client, root);
    write_file(checkout.path(), "late.txt", "found me\n");
    await_reported(&mut client, checkout.path(), subscription, "late.txt");

    let deadline = Instant::now() + DEADLINE;
    loop {
        assert!(
            Instant::now() < deadline,
            "the index never became ready after the build"
        );
        let id = client.request(Op::IndexQuery {
            root,
            query: "late".to_owned(),
            limit: 10,
        });
        if let Reply::Index(index) = client.reply(id)
            && index.ready
        {
            assert!(
                index.hits.iter().any(|hit| hit.path == "late.txt"),
                "the change that arrived during the build is in the index: {:?}",
                index.hits
            );
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn quick_open_keeps_answering_while_a_rescan_walks() {
    let checkout = checkout(&[("src/server_main.rs", "fn main() {}\n")]);
    // The first build publishes, a rebuild starts soon after, and each walk is held before it
    // publishes, so the queries below land while a rescan is walking.
    let mut client = Client::launch(
        &[
            ("ACE_FILES_HOLD_INDEX_MS", "600"),
            ("ACE_FILES_REBUILD_AFTER_MS", "200"),
            ("ACE_FILES_INDEX_EVENTS", "1"),
        ],
        true,
    );
    client.hello();
    let root = client.open_root(checkout.path());
    client.await_index_published(1);

    let deadline = Instant::now() + DEADLINE;
    let mut answered = 0;
    while client.index_publishes() < 2 {
        assert!(Instant::now() < deadline, "the rebuild never published");
        let id = client.request(Op::IndexQuery {
            root,
            query: "srvmain".to_owned(),
            limit: 10,
        });
        let index = match client.reply(id) {
            Reply::Index(index) => index,
            other => panic!("indexQuery answered {other:?}"),
        };
        assert!(
            index.ready,
            "quick open answers from the index it already has while a rescan walks"
        );
        assert!(
            index
                .hits
                .iter()
                .any(|hit| hit.path == "src/server_main.rs"),
            "the old index still answers: {:?}",
            index.hits
        );
        answered += 1;
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(answered > 5, "queries ran while the rebuild was walking");
}

#[test]
fn a_panicked_build_answers_an_error_instead_of_never_being_ready() {
    let checkout = checkout(&[("a.txt", "")]);
    let mut client = Client::launch(&[("ACE_FILES_PANIC_INDEX", "1")], false);
    client.hello();
    let root = client.open_root(checkout.path());
    let deadline = Instant::now() + DEADLINE;

    let mut failure = None;
    while Instant::now() < deadline {
        let id = client.request(Op::IndexQuery {
            root,
            query: "a".to_owned(),
            limit: 10,
        });
        match client.answer(id) {
            Ok(Reply::Index(index)) => {
                assert!(
                    !index.ready,
                    "a build that panicked never publishes an index"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(other) => panic!("indexQuery answered {other:?}"),
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    let failure = failure.unwrap_or_else(|| {
        panic!("a failed build is reported, not left saying 'not ready' forever")
    });
    assert_eq!(failure.code, "IO_ERROR");
    assert!(
        failure.message.contains("panicked") || failure.message.contains("stopped"),
        "the error says the build never finished: {}",
        failure.message
    );
}

/// Wait until the root serves a built index.
fn await_ready(client: &mut Client, root: u64) {
    let deadline = Instant::now() + DEADLINE;
    loop {
        assert!(
            Instant::now() < deadline,
            "the index never became ready before the rules changed"
        );
        let id = client.request(Op::IndexQuery {
            root,
            query: "main".to_owned(),
            limit: 5,
        });
        if let Reply::Index(index) = client.reply(id)
            && index.ready
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Wait until quick open does or does not name `path`, as the rules now say.
fn await_hits(client: &mut Client, root: u64, query: &str, path: &str, present: bool) {
    let deadline = Instant::now() + DEADLINE;
    loop {
        assert!(
            Instant::now() < deadline,
            "quick open never {} {path}",
            if present { "found" } else { "dropped" }
        );
        let id = client.request(Op::IndexQuery {
            root,
            query: query.to_owned(),
            limit: 20,
        });
        if let Reply::Index(index) = client.reply(id)
            && index.ready
            && index.hits.iter().any(|hit| hit.path == path) == present
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Wait for the watch to report the `.gitignore` rewrite, writing the same rules again if the
/// stream started too late to see it. `await_reported` cannot be used: its retry writes its own
/// contents, which would replace the rules under test.
fn await_ignore_change(client: &mut Client, base: &Path, subscription: u64, contents: &str) {
    let deadline = Instant::now() + WATCH_DEADLINE;
    loop {
        assert!(
            Instant::now() < deadline,
            "the watch never reported the .gitignore rewrite"
        );
        match client.try_event(subscription, Duration::from_millis(500)) {
            Some(EventPayload::Changes { changes })
                if changes.iter().any(|change| change.path == ".gitignore") =>
            {
                return;
            }
            Some(_) => {}
            None => write_file(base, ".gitignore", contents),
        }
    }
}
