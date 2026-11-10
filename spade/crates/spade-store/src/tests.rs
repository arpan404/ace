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
