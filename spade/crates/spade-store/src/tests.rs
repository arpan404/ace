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

fn bot<'a>(id: &'a str, conversation: &'a str, model: &'a str) -> NewAgent<'a> {
    NewAgent {
        id,
        kind: "bot",
        name: "Trips",
        task: "Plan trips.",
        avatar: r#"{"kind":"generated","color":"teal"}"#,
        model,
        conversation,
    }
}

#[test]
fn an_agent_and_its_one_conversation_are_created_together() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.create_agent(bot("a1", "c1", "e/m"), &[Event::user_message("first")], 5)?;
    let agent = store.agent("a1")?.ok_or(StoreError::Poisoned)?;
    assert_eq!(
        (agent.conversation.as_str(), agent.model.as_str()),
        ("c1", "e/m")
    );
    assert!(store.conversation("c1")?.is_some());
    assert_eq!(store.events("c1", 0)?.len(), 1);
    assert_eq!(
        store.agent_for_conversation("c1")?.map(|a| a.id),
        Some("a1".into())
    );
    // A clash leaves nothing half made: no second agent and no stray conversation.
    assert!(store.create_agent(bot("a1", "c2", "e/m"), &[], 6).is_err());
    assert!(store.conversation("c2")?.is_none());
    Ok(())
}

#[test]
fn deleting_an_agent_deletes_its_conversation_and_events() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.create_agent(bot("a1", "c1", "e/m"), &[Event::user_message("x")], 5)?;
    store.record_spend("c1", "e/m", 300, 6)?;
    assert!(store.delete_agent("a1")?);
    assert!(store.agent("a1")?.is_none());
    assert!(store.conversation("c1")?.is_none());
    assert!(store.events("c1", 0)?.is_empty());
    assert_eq!(
        store.spent_since(0)?,
        300,
        "spending still counts toward the cap"
    );
    assert!(!store.delete_agent("a1")?);
    Ok(())
}

#[test]
fn a_task_change_is_stored_on_the_row_and_as_an_event_together() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.create_agent(bot("a1", "c1", "e/m"), &[], 5)?;
    let stored = store.configure_agent("a1", "Track parcels.", "e/n", 7)?;
    assert_eq!(stored.seq, 1);
    let agent = store.agent("a1")?.ok_or(StoreError::Poisoned)?;
    assert_eq!(
        (agent.task.as_str(), agent.model.as_str()),
        ("Track parcels.", "e/n")
    );
    assert_eq!(
        store.events("c1", 0)?.first().map(|e| e.event.to_json()),
        Some(json!({ "type": "agent_configured", "task": "Track parcels.", "model": "e/n" }))
    );
    assert_eq!(store.agents_using_endpoint("e")?, vec!["Trips".to_owned()]);
    assert!(store.agents_using_endpoint("e2")?.is_empty());
    Ok(())
}

#[test]
fn conversations_from_before_agents_become_bots_with_nothing_lost() -> Result<()> {
    let (_dir, path) = temp();
    {
        // Schema 1 as shipped, with two conversations.
        let connection = rusqlite::Connection::open(&path)?;
        connection.execute_batch(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT,
                 created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
             CREATE INDEX conversations_by_update ON conversations (updated_ms DESC);
             CREATE TABLE events (conversation_id TEXT NOT NULL REFERENCES conversations (id),
                 seq INTEGER NOT NULL, at_ms INTEGER NOT NULL, body TEXT NOT NULL,
                 PRIMARY KEY (conversation_id, seq)) WITHOUT ROWID;
             CREATE TABLE spend (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL,
                 model TEXT NOT NULL, cost_micros INTEGER NOT NULL, at_ms INTEGER NOT NULL);
             CREATE INDEX spend_by_time ON spend (at_ms);
             INSERT INTO conversations VALUES ('c_old', 'A very long title that goes well past forty characters', 1, 10);
             INSERT INTO conversations VALUES ('c_new', NULL, 2, 20);
             INSERT INTO events VALUES ('c_old', 1, 3, '{\"type\":\"user_message\",\"text\":\"hi\"}');
             INSERT INTO events VALUES ('c_old', 2, 4, '{\"type\":\"reply_started\",\"reply\":\"r1\",\"model\":\"go/kimi\"}');
             INSERT INTO events VALUES ('c_old', 3, 5, '{\"type\":\"reply_finished\",\"reply\":\"r1\",\"text\":\"hello\"}');
             PRAGMA user_version = 1;",
        )?;
    }
    let store = Store::open(&path)?;
    let agents = store.agents()?;
    let summary: Vec<_> = agents
        .iter()
        .map(|a| {
            (
                a.conversation.as_str(),
                a.kind.as_str(),
                a.name.as_str(),
                a.task.as_str(),
                a.model.as_str(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("c_new", "bot", "Agent", "", ""),
            (
                "c_old",
                "bot",
                "A very long title that goes well past fo",
                "",
                "go/kimi"
            ),
        ]
    );
    let old_face = spade_core::face::face_for_id("a_c_old", &[]);
    let new_face = spade_core::face::face_for_id(
        "a_c_new",
        &old_face.get("pair").into_iter().collect::<Vec<_>>(),
    );
    let faces: Vec<serde_json::Value> = agents
        .iter()
        .map(|a| serde_json::from_str(&a.avatar).unwrap_or_default())
        .collect();
    assert_eq!(
        faces,
        vec![new_face.to_json(), old_face.to_json()],
        "seeded by id, oldest first"
    );
    assert_eq!(store.events("c_old", 0)?.len(), 3, "every event kept");
    store.fill_missing_models("preset/main")?;
    assert_eq!(
        store.agent_for_conversation("c_new")?.map(|a| a.model),
        Some("preset/main".into())
    );
    Ok(())
}

#[test]
fn only_one_main_agent_can_exist() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    let main = |id, conversation| NewAgent {
        kind: "main",
        ..bot(id, conversation, "e/m")
    };
    store.create_agent(main("a1", "c1"), &[], 1)?;
    assert!(store.create_agent(main("a2", "c2"), &[], 2).is_err());
    store.create_agent(bot("a3", "c3", "e/m"), &[], 3)?;
    // Main first, whatever its activity.
    let order: Vec<_> = store.agents()?.into_iter().map(|a| a.id).collect();
    assert_eq!(order, vec!["a1".to_owned(), "a3".to_owned()]);
    Ok(())
}

#[test]
fn endpoints_models_and_settings_are_kept_and_never_hold_a_key() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    let endpoint = StoredEndpoint {
        id: "go".into(),
        name: "Go".into(),
        format: "openai-chat".into(),
        base_url: "https://example.test/v1/".into(),
        headers: vec![("x-team".into(), "blue".into())],
        session_header: Some("x-session".into()),
        needs_key: true,
        key_env: Some("GO_KEY".into()),
        preset: Some("opencode-go".into()),
        created_ms: 1,
        models: vec![StoredModel {
            id: "kimi".into(),
            name: None,
            context: Some(1000),
            capabilities: Some(vec!["tools".into()]),
            source: "preset".into(),
        }],
    };
    store.insert_endpoint(&endpoint)?;
    assert!(store.insert_endpoint(&endpoint).is_err());
    let typed = StoredModel {
        id: "vendor/odd".into(),
        name: Some("Odd".into()),
        context: None,
        capabilities: None,
        source: "typed".into(),
    };
    assert!(store.put_model("go", &typed)?);
    assert!(!store.put_model("nope", &typed)?);
    let read = store.endpoints()?;
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].headers, endpoint.headers);
    assert_eq!(read[0].models.len(), 2);
    assert!(store.delete_model("go", "vendor/odd")?);
    store.set_setting("fast_model", Some("go/kimi"))?;
    assert_eq!(store.setting("fast_model")?, Some("go/kimi".into()));
    store.set_setting("fast_model", None)?;
    assert_eq!(store.setting("fast_model")?, None);
    assert!(store.delete_endpoint("go")?);
    assert!(store.endpoints()?.is_empty());
    Ok(())
}

#[test]
fn initials_avatars_become_faces_seeded_by_the_agent_and_pictures_stay() -> Result<()> {
    let (_dir, path) = temp();
    let store = Store::open(&path)?;
    store.create_agent(bot("a_one", "c_one", "m/x"), &[], 1)?;
    store.create_agent(bot("a_two", "c_two", "m/x"), &[], 2)?;
    drop(store);
    let picture = json!({ "kind": "image", "sha256": "ab".repeat(32) }).to_string();
    {
        let connection = rusqlite::Connection::open(&path)?;
        connection.execute(
            "UPDATE agents SET avatar = ?1 WHERE id = 'a_two'",
            [&picture],
        )?;
        connection.pragma_update(
            None,
            "user_version",
            crate::schema::current_version() as i64 - 1,
        )?;
    }
    let store = Store::open(&path)?;
    let one = store.agent("a_one")?.map(|a| a.avatar).unwrap_or_default();
    let two = store.agent("a_two")?.map(|a| a.avatar).unwrap_or_default();
    assert_eq!(
        one,
        spade_core::face::face_for_id("a_one", &[])
            .to_json()
            .to_string()
    );
    assert_eq!(two, picture, "a picture is kept");
    drop(store);
    // Opening again changes nothing: the migration ran once.
    let store = Store::open(&path)?;
    assert_eq!(
        store.agent("a_one")?.map(|a| a.avatar).unwrap_or_default(),
        one
    );
    Ok(())
}
