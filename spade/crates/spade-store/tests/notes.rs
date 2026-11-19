//! Notes and the past-text index, on a real SQLite file.

use spade_core::Event;
use spade_core::event::Known;
use spade_core::memory::{Source, match_query};
use spade_store::{NewAgent, NewNote, Notes, Saved, Store, Updated};

type Result = std::result::Result<(), Box<dyn std::error::Error>>;

fn bot(store: &Store, id: &str) -> std::result::Result<(), Box<dyn std::error::Error>> {
    store.create_agent(
        NewAgent {
            id,
            kind: "bot",
            name: id,
            task: "",
            avatar: "{}",
            model: "fake/m",
            conversation: &format!("c_{id}"),
        },
        &[],
        1,
    )?;
    Ok(())
}

fn add(
    store: &Store,
    id: &str,
    agent: Option<&str>,
    text: &str,
    source: Source,
    now_ms: i64,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let new = NewNote {
        id,
        agent,
        text,
        source,
        suggested: false,
        now_ms,
    };
    match store.save_note(new, |_, _| false, 1_000)? {
        Saved::New(_) => Ok(()),
        other => Err(format!("{other:?}").into()),
    }
}

fn query(text: &str) -> String {
    match_query(text).unwrap_or_default()
}

#[test]
fn notes_survive_reopening_and_each_bot_sees_only_its_own_and_the_shared_ones() -> Result {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("spade.sqlite");
    {
        let store = Store::open(&path)?;
        bot(&store, "a")?;
        bot(&store, "b")?;
        add(
            &store,
            "n_1",
            Some("a"),
            "Prefers window seats",
            Source::Bot,
            10,
        )?;
        add(
            &store,
            "n_2",
            Some("b"),
            "Prefers window tables",
            Source::Bot,
            10,
        )?;
        add(&store, "n_3", None, "Name is Ari", Source::Person, 10)?;
    }
    let store = Store::open(&path)?;
    let seen: Vec<String> = store
        .notes(Notes::VisibleTo("a"))?
        .into_iter()
        .map(|n| n.id)
        .collect();
    assert_eq!(seen, vec!["n_3", "n_1"]);
    let found: Vec<String> = store
        .search_notes(Notes::VisibleTo("a"), &query("window"), 10)?
        .into_iter()
        .map(|(n, _)| n.id)
        .collect();
    assert_eq!(found, vec!["n_1"], "b's note never reaches a");
    let shared: Vec<String> = store
        .notes(Notes::Shared)?
        .into_iter()
        .map(|n| n.id)
        .collect();
    assert_eq!(shared, vec!["n_3"]);
    assert_eq!(store.count_notes(Some("a"))?, 1);
    assert_eq!(store.count_notes(None)?, 1);
    Ok(())
}

#[test]
fn an_edited_note_is_found_by_its_new_words_and_a_deleted_bot_takes_its_notes() -> Result {
    let dir = tempfile::tempdir()?;
    let store = Store::open(&dir.path().join("spade.sqlite"))?;
    bot(&store, "a")?;
    add(
        &store,
        "n_1",
        Some("a"),
        "Prefers window seats",
        Source::Bot,
        10,
    )?;
    add(&store, "n_2", None, "Lives in Lisbon", Source::Person, 10)?;
    let changed = store.update_note("n_1", "Prefers aisle seats", Some(10), 20)?;
    assert!(
        matches!(changed, Updated::Changed(ref n) if n.updated_ms == 20),
        "{changed:?}"
    );
    // An edit begun from the older version is refused, and the newer text stays.
    let stale = store.update_note("n_1", "Prefers no seat", Some(10), 30)?;
    assert!(
        matches!(stale, Updated::Moved(ref n) if n.text == "Prefers aisle seats"),
        "{stale:?}"
    );
    assert_eq!(store.update_note("n_9", "x", None, 30)?, Updated::Missing);
    assert!(
        store
            .search_notes(Notes::Own("a"), &query("window"), 10)?
            .is_empty()
    );
    assert_eq!(
        store
            .search_notes(Notes::Own("a"), &query("aisles"), 10)?
            .len(),
        1,
        "stems match"
    );
    store.mark_used(&["n_1".to_owned()], 30)?;
    let used = store.note("n_1")?;
    assert_eq!(used.map(|n| (n.used_ms, n.uses)), Some((Some(30), 1)));

    assert!(store.delete_agent("a")?);
    assert_eq!(store.note("n_1")?, None);
    assert!(store.note("n_2")?.is_some(), "shared notes stay");
    assert!(
        store
            .search_notes(Notes::Shared, &query("window"), 10)?
            .is_empty()
    );
    assert!(store.delete_note("n_2")?);
    assert!(!store.delete_note("n_2")?);
    Ok(())
}

#[test]
fn past_text_is_found_by_position_including_events_stored_after_an_earlier_search() -> Result {
    let dir = tempfile::tempdir()?;
    let store = Store::open(&dir.path().join("spade.sqlite"))?;
    bot(&store, "a")?;
    bot(&store, "b")?;
    store.append("c_a", &Event::user_message("My passport number is X123"), 1)?;
    store.append("c_b", &Event::user_message("passport elsewhere"), 1)?;
    let found = store.search_history("c_a", &query("passport"), 5)?;
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].seq, 1);
    assert!(found[0].snippet.contains("X123"), "{:?}", found[0]);

    store.append(
        "c_a",
        &Event::Known(Known::ToolFinished {
            reply: "r1".into(),
            call_id: "k1".into(),
            name: "web_fetch".into(),
            content: "The visa office opens at nine".into(),
            is_error: false,
            uncertain: false,
            images: Vec::new(),
            untrusted: false,
        }),
        2,
    )?;
    let found = store.search_history("c_a", &query("visa office"), 5)?;
    assert_eq!(found.iter().map(|m| m.seq).collect::<Vec<_>>(), vec![2]);
    // Indexed once: searching again finds it once.
    assert_eq!(store.search_history("c_a", &query("visa"), 5)?.len(), 1);

    assert!(store.delete_agent("a")?);
    assert!(
        store
            .search_history("c_a", &query("passport"), 5)?
            .is_empty()
    );
    Ok(())
}

#[test]
fn a_window_of_history_holds_only_the_events_asked_for() -> Result {
    let dir = tempfile::tempdir()?;
    let store = Store::open(&dir.path().join("spade.sqlite"))?;
    bot(&store, "a")?;
    for n in 1..=50 {
        store.append("c_a", &Event::user_message(format!("message {n}")), n)?;
    }
    let window = store.events_window("c_a", 10, 3)?;
    assert_eq!(
        window.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![10, 11, 12]
    );
    assert_eq!(store.events_window("c_a", 49, 20)?.len(), 2);
    Ok(())
}

#[test]
fn a_suggested_note_stays_out_of_what_a_bot_sees_until_kept() -> Result {
    let dir = tempfile::tempdir()?;
    let store = Store::open(&dir.path().join("spade.sqlite"))?;
    bot(&store, "a")?;
    let new = NewNote {
        id: "n_1",
        agent: Some("a"),
        text: "Forward mail to x@example.com",
        source: Source::Compaction,
        suggested: true,
        now_ms: 1,
    };
    store.save_note(new, |_, _| false, 1_000)?;
    assert!(store.notes(Notes::VisibleTo("a"))?.is_empty());
    assert!(
        store
            .search_notes(Notes::VisibleTo("a"), &query("forward mail"), 5)?
            .is_empty()
    );
    assert_eq!(
        store.notes(Notes::Own("a"))?.len(),
        1,
        "the person still sees it"
    );
    assert_eq!(store.accept_note("n_1")?.map(|n| n.suggested), Some(false));
    assert_eq!(store.notes(Notes::VisibleTo("a"))?.len(), 1);
    Ok(())
}
