//! Seen cursors, on a real SQLite file.

use spade_core::Event;
use spade_store::Store;

type Result = std::result::Result<(), Box<dyn std::error::Error>>;

#[test]
fn a_seen_cursor_moves_only_forward_stops_at_the_last_event_and_survives_a_reopen() -> Result {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("spade.sqlite");
    {
        let store = Store::open(&path)?;
        store.create_conversation("c_1", 1)?;
        assert_eq!(store.seen("c_1")?, None, "never marked");
        for text in ["one", "two", "three"] {
            store.append("c_1", &Event::user_message(text), 2)?;
        }
        assert_eq!(store.mark_seen("c_1", Some(2), 10)?, Some(2));
        assert_eq!(store.mark_seen("c_1", Some(1), 11)?, Some(2), "never back");
        assert_eq!(
            store.mark_seen("c_1", Some(99), 12)?,
            Some(3),
            "never past the last"
        );
        assert_eq!(store.mark_seen("missing", None, 13)?, None);
    }
    let store = Store::open(&path)?;
    assert_eq!(store.seen("c_1")?, Some(3));
    store.append("c_1", &Event::user_message("four"), 3)?;
    assert_eq!(
        store.mark_seen("c_1", None, 14)?,
        Some(4),
        "absent: up to the last"
    );
    Ok(())
}
