use spade_core::Event;

use crate::{NewAgent, Store, StoredCase};

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let store = Store::open(&dir.path().join("spade.sqlite")).unwrap_or_else(|e| panic!("{e}"));
    for id in ["a_1", "a_2"] {
        store
            .create_agent(
                NewAgent {
                    id,
                    kind: "bot",
                    name: id,
                    task: "",
                    avatar: "{}",
                    model: "e/m",
                    conversation: &format!("c_{id}"),
                },
                &[Event::user_message("hello")],
                1,
            )
            .unwrap_or_else(|e| panic!("{e}"));
    }
    (dir, store)
}

fn case(id: &str, agent: &str, reply: &str, made_ms: i64) -> StoredCase {
    StoredCase {
        id: id.into(),
        agent: agent.into(),
        reply: reply.into(),
        mark: Some("right".into()),
        body: format!(
            r#"{{"id":"{id}","given":{{"messages":["Find fares"]}},"made_at":{made_ms}}}"#
        ),
        made_ms,
    }
}

#[test]
fn a_kept_case_reads_back_exactly_and_lists_newest_first_for_its_bot_only() -> crate::Result<()> {
    let (_dir, store) = store();
    let first = case("case_1", "a_1", "r_1", 10);
    let second = StoredCase {
        mark: None,
        ..case("case_2", "a_1", "r_2", 20)
    };
    assert_eq!(store.save_case(&first)?, (first.clone(), true));
    assert_eq!(store.save_case(&second)?, (second.clone(), true));
    store.save_case(&case("case_3", "a_2", "r_1", 30))?;
    assert_eq!(store.case("a_1", "case_1")?, Some(first.clone()));
    assert_eq!(store.cases("a_1", 10)?, vec![second, first.clone()]);
    assert_eq!(
        store.case("a_2", "case_1")?,
        None,
        "another bot's case isn't found"
    );
    // The same reply kept again keeps the case it has.
    let again = case("case_9", "a_1", "r_1", 99);
    assert_eq!(store.save_case(&again)?, (first, false));
    Ok(())
}

#[test]
fn deleting_a_case_removes_it_and_deleting_its_bot_removes_them_all() -> crate::Result<()> {
    let (_dir, store) = store();
    store.save_case(&case("case_1", "a_1", "r_1", 10))?;
    store.save_case(&case("case_2", "a_1", "r_2", 20))?;
    assert!(
        !store.delete_case("a_2", "case_1")?,
        "only its own bot deletes it"
    );
    assert!(store.delete_case("a_1", "case_1")?);
    assert_eq!(store.case("a_1", "case_1")?, None);
    assert!(!store.delete_case("a_1", "case_1")?);
    assert!(store.delete_agent("a_1")?);
    assert!(store.cases("a_1", 10)?.is_empty());
    Ok(())
}
