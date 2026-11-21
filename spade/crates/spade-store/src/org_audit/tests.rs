//! The org host's audit log as stored (ADR 0206 §4.2).

use spade_core::Event;
use spade_core::event::Known;
use spade_core::org::audit::{self, Checkpoint, Entry, Line, Ref};

use super::CRASH_BEFORE_ENTRIES;
use crate::Store;

fn store(dir: &tempfile::TempDir) -> Store {
    let store = Store::open(&dir.path().join("spade.db")).expect("open");
    store.create_conversation("c_1", 1).expect("conversation");
    store
}

fn effect(at: i64, by: &str) -> Entry {
    Entry::new(
        "bot.effect",
        at,
        Ref::new("bot", "a_1"),
        vec![Ref::new("bot", "a_1")],
    )
    .with("effect", "send_as_person")
    .with("allowed_by_account", by)
}

fn started(call: &str) -> Event {
    Event::Known(Known::ToolStarted {
        reply: "r_1".to_owned(),
        call_id: call.to_owned(),
        name: "send_message".to_owned(),
        risk: None,
        background: false,
        effect: None,
    })
}

fn export(store: &Store) -> String {
    let mut lines = vec![Line::Header {
        org: "org_acme".to_owned(),
        host: "HOST".to_owned(),
        key: String::new(),
    }];
    let checkpoints = store.audit_checkpoints(0, i64::MAX).expect("checkpoints");
    for chained in store.audit_entries(0, 1000).expect("entries") {
        let seq = chained.seq;
        lines.push(Line::Entry(chained));
        for checkpoint in checkpoints.iter().filter(|c| c.count == seq) {
            lines.push(Line::Checkpoint(checkpoint.clone()));
        }
    }
    lines
        .iter()
        .map(|line| serde_json::to_string(line).expect("json"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn a_steps_entry_is_chained_and_kept_with_the_step_across_a_reopen() {
    let dir = tempfile::tempdir().expect("dir");
    {
        let store = store(&dir);
        let (stored, chained) = store
            .append_audited("c_1", &[started("k_1")], &[effect(10, "user_ana")], 10)
            .expect("appended");
        assert_eq!(stored.len(), 1);
        assert_eq!(chained[0].seq, 1);
        assert_eq!(chained[0].prev, audit::GENESIS);
    }
    let store = Store::open(&dir.path().join("spade.db")).expect("reopen");
    let (_, chained) = store
        .append_audited("c_1", &[started("k_2")], &[effect(20, "user_bob")], 20)
        .expect("appended");
    let first = store.audit_entries(0, 10).expect("entries");
    assert_eq!(first.len(), 2);
    assert_eq!(chained[0].prev, first[0].hash);
    let none = |_: &[u8], _: &str| false;
    assert_eq!(
        audit::verify(&export(&store), &none).map(|v| v.entries),
        Ok(2)
    );
}

#[test]
fn a_step_whose_entry_cant_be_written_isnt_stored_either() {
    let dir = tempfile::tempdir().expect("dir");
    let store = store(&dir);
    let raw = Store::connect(dir.path().join("spade.db")).expect("connect");
    raw.execute_batch(
        "CREATE TRIGGER no_more BEFORE INSERT ON org_audit
         BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    )
    .expect("trigger");
    assert!(
        store
            .append_audited("c_1", &[started("k_1")], &[effect(10, "user_ana")], 10)
            .is_err()
    );
    assert!(store.events("c_1", 0).expect("events").is_empty());
}

/// Run only as the child of the crash test below: it ends its own process between a step's
/// events and its entries.
#[test]
#[ignore = "the crash test's child"]
fn crashing_child() {
    let Some(path) = std::env::var_os("SPADE_AUDIT_CRASH_DB") else {
        return;
    };
    let store = Store::open(std::path::Path::new(&path)).expect("open");
    CRASH_BEFORE_ENTRIES.with(|crash| crash.set(true));
    let _ = store.append_audited("c_1", &[started("k_1")], &[effect(10, "user_ana")], 10);
    unreachable!("the child ends before its entries are written");
}

#[test]
fn a_crash_between_a_steps_events_and_its_entry_leaves_neither() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("spade.db");
    drop(store(&dir));
    let child = std::process::Command::new(std::env::current_exe().expect("this test"))
        .args(["--exact", "org_audit::tests::crashing_child", "--ignored"])
        .env("SPADE_AUDIT_CRASH_DB", &path)
        .output()
        .expect("the child ran");
    assert_eq!(child.status.code(), Some(86), "{child:?}");
    let store = Store::open(&path).expect("reopen");
    assert!(store.events("c_1", 0).expect("events").is_empty());
    assert!(store.audit_entries(0, 10).expect("entries").is_empty());
}

#[test]
fn the_log_refuses_a_rewrite_or_a_delete() {
    let dir = tempfile::tempdir().expect("dir");
    let store = store(&dir);
    store.audit(&[effect(10, "user_ana")], 10).expect("entry");
    let raw = Store::connect(dir.path().join("spade.db")).expect("connect");
    for sql in [
        "UPDATE org_audit SET body = '{}' WHERE seq = 1",
        "UPDATE org_audit SET hash = 'x' WHERE seq = 1",
        "DELETE FROM org_audit",
    ] {
        assert!(raw.execute(sql, []).is_err(), "{sql}");
    }
    // Marking an entry forwarded is the only change it takes.
    assert_eq!(store.audit_forwarded(1, 20).expect("forwarded"), 1);
}

#[test]
fn the_outbox_gives_entries_in_order_and_keeps_what_the_backend_hasnt_taken() {
    let dir = tempfile::tempdir().expect("dir");
    let store = store(&dir);
    for at in 1..=5 {
        store.audit(&[effect(at, "user_ana")], at).expect("entry");
    }
    let first: Vec<i64> = store
        .audit_outbox(2)
        .expect("outbox")
        .iter()
        .map(|c| c.seq)
        .collect();
    assert_eq!(first, vec![1, 2]);
    assert_eq!(store.audit_forwarded(2, 9).expect("forwarded"), 2);
    // Taken again after a restart: from where it stopped, never twice.
    let store = Store::open(&dir.path().join("spade.db")).expect("reopen");
    let rest: Vec<i64> = store
        .audit_outbox(10)
        .expect("outbox")
        .iter()
        .map(|c| c.seq)
        .collect();
    assert_eq!(rest, vec![3, 4, 5]);
}

#[test]
fn a_checkpoint_covers_only_the_chains_own_head_and_its_record_needs_none_of_its_own() {
    let dir = tempfile::tempdir().expect("dir");
    let store = store(&dir);
    for at in 1..=3 {
        store.audit(&[effect(at, "user_ana")], at).expect("entry");
    }
    assert_eq!(store.audit_unsigned().expect("unsigned"), (3, Some(1)));
    let head = store.audit_head().expect("head").expect("a head");
    let record = |count| {
        Entry::new(
            "audit.checkpoint",
            50,
            Ref::new("host", "HOST"),
            vec![Ref::new("host", "HOST")],
        )
        .with("count", count)
    };
    let wrong = Checkpoint {
        count: 3,
        head: "f".repeat(64),
        at: 50,
        signature: "s".to_owned(),
    };
    assert!(!store.put_checkpoint(&wrong, &record(3), 50).expect("put"));
    let right = Checkpoint {
        head: head.hash,
        ..wrong
    };
    assert!(store.put_checkpoint(&right, &record(3), 50).expect("put"));
    // The checkpoint's own record is in the chain, for the backend, and owes no checkpoint.
    assert_eq!(store.audit_head().expect("head").map(|h| h.count), Some(4));
    assert_eq!(store.audit_unsigned().expect("unsigned"), (0, None));
}
