use serde_json::json;
use spade_core::Event;

use super::*;

fn temp() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("temp dir: {e}"));
    let path = dir.path().join("spade.sqlite");
    (dir, path)
}

#[test]
fn events_are_numbered_per_conversation_in_order() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.create_conversation("a", 1)?;
    store.create_conversation("b", 1)?;
    let first = store.append("a", &Event::user_message("one"), 10)?;
    let other = store.append("b", &Event::user_message("x"), 11)?;
    let second = store.append("a", &Event::user_message("two"), 12)?;
    assert_eq!((first.seq, other.seq, second.seq), (1, 1, 2));
    let after_first: Vec<_> = store.events("a", 1)?.into_iter().map(|e| e.event).collect();
    assert_eq!(after_first, vec![Event::user_message("two")]);
    Ok(())
}

#[test]
fn everything_survives_reopening_the_file() -> Result<()> {
    let (_dir, path) = temp();
    {
        let store = Store::open(&path)?;
        store.create_conversation("a", 1)?;
        store.append("a", &Event::user_message("kept"), 5)?;
        store.record_spend("a", "glm-5.3", 700, 5)?;
    }
    let store = Store::open(&path)?;
    assert_eq!(store.events("a", 0)?.len(), 1);
    assert_eq!(store.spent_since(0)?, 700);
    Ok(())
}

#[test]
fn the_list_puts_the_latest_activity_first_and_carries_the_title() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.create_conversation("old", 1)?;
    store.create_conversation("new", 2)?;
    store.append("old", &Event::renamed("Trip plans"), 30)?;
    let list: Vec<_> = store
        .conversations()?
        .into_iter()
        .map(|c| (c.id, c.title))
        .collect();
    assert_eq!(
        list,
        vec![
            ("old".to_owned(), Some("Trip plans".to_owned())),
            ("new".to_owned(), None),
        ]
    );
    Ok(())
}

#[test]
fn an_event_spade_does_not_know_is_stored_and_read_back_unchanged() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.create_conversation("a", 1)?;
    let raw = json!({ "type": "tool_called", "tool": "search", "extra": [1, 2] });
    store.append("a", &Event::from_json(raw.clone()), 2)?;
    let read = store.events("a", 0)?;
    assert_eq!(read.first().map(|e| e.event.to_json()), Some(raw));
    Ok(())
}

#[test]
fn appending_to_a_missing_conversation_is_refused() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    let result = store.append("nope", &Event::user_message("hi"), 1);
    assert!(matches!(result, Err(StoreError::NoConversation(id)) if id == "nope"));
    Ok(())
}

#[test]
fn a_conversation_id_cannot_be_reused() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.create_conversation("a", 1)?;
    assert!(matches!(
        store.create_conversation("a", 2),
        Err(StoreError::Exists(_))
    ));
    Ok(())
}

#[test]
fn spending_counts_only_from_the_given_time() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.record_spend("a", "m", 1_000, 100)?;
    store.record_spend("a", "m", 2_000, 200)?;
    store.record_spend("a", "m", 4_000, 300)?;
    assert_eq!(store.spent_since(200)?, 6_000);
    assert_eq!(store.spent_since(301)?, 0);
    Ok(())
}

#[test]
fn events_appended_together_are_numbered_in_order_after_the_rest() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.create_conversation("a", 1)?;
    store.append("a", &Event::user_message("one"), 10)?;
    let together = store.append_all(
        "a",
        &[Event::user_message("two"), Event::reply_started("r1", "m")],
        11,
    )?;
    let seqs: Vec<i64> = together.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, vec![2, 3]);
    assert_eq!(store.events("a", 0)?.len(), 3);
    assert!(
        store
            .append_all("missing", &[Event::user_message("x")], 12)
            .is_err()
    );
    assert!(store.events("missing", 0)?.is_empty());
    Ok(())
}

#[test]
fn a_good_database_passes_the_check_and_a_damaged_or_missing_one_does_not()
-> std::result::Result<(), Box<dyn std::error::Error>> {
    let (dir, path) = temp();
    {
        let store = Store::open(&path)?;
        store.create_conversation("a", 1)?;
        for n in 0..200 {
            store.append(
                "a",
                &Event::user_message(format!("message {n} {}", "x".repeat(200))),
                n,
            )?;
        }
    }
    assert_eq!(Store::check(&path), Ok(()));

    let garbage = dir.path().join("garbage.sqlite");
    std::fs::write(&garbage, vec![0x5a_u8; 8192])?;
    let why = Store::check(&garbage).err().unwrap_or_default();
    assert!(
        why.contains("not a Spade database") || why.contains("not a database"),
        "{why}"
    );
    assert!(!why.contains('\n'));

    // Cut short, as a copy interrupted part way would be.
    let bytes = std::fs::read(&path)?;
    let truncated = dir.path().join("truncated.sqlite");
    std::fs::write(&truncated, &bytes[..bytes.len() / 2])?;
    assert!(Store::check(&truncated).is_err());

    let missing = dir.path().join("missing.sqlite");
    assert!(Store::check(&missing).is_err());
    assert!(!missing.exists(), "the check never creates a database");
    Ok(())
}

#[test]
fn a_database_from_a_newer_spade_is_refused_by_the_check() -> Result<()> {
    let (_dir, path) = temp();
    drop(Store::open(&path)?);
    rusqlite::Connection::open(&path)?.pragma_update(None, "user_version", 999)?;
    let why = Store::check(&path).err().unwrap_or_default();
    assert!(why.contains("newer"), "{why}");
    Ok(())
}

#[test]
fn a_database_from_a_newer_spade_is_refused_not_used() -> Result<()> {
    let (_dir, path) = temp();
    Store::open(&path)?.create_conversation("a", 1)?;
    {
        let connection = rusqlite::Connection::open(&path)?;
        connection.pragma_update(None, "user_version", 999)?;
    }
    let refused = Store::open(&path);
    assert!(
        matches!(&refused, Err(StoreError::Sqlite(e)) if e.to_string().contains("newer Spade")),
        "{:?}",
        refused.err()
    );
    let version: i64 =
        rusqlite::Connection::open(&path)?
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
    assert_eq!(version, 999, "left as it was");
    Ok(())
}
