//! What a conversation is offered, and how often a bot ran a deferred tool, are small settings
//! (spade/docs/harness.md, Tools): they go with the conversation and the bot they belong to, and
//! never linger after a delete.

use spade_store::{NewAgent, Store, StoredGroup, StoredHelper};

type Result = std::result::Result<(), Box<dyn std::error::Error>>;

fn bot(store: &Store, id: &str) -> Result {
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

fn helper(store: &Store, parent: &str, conversation: &str) -> Result {
    store.create_helper(
        &StoredHelper {
            conversation: conversation.to_owned(),
            parent: parent.to_owned(),
            job: "j1".to_owned(),
            reply: "r1".to_owned(),
            profile: "general".to_owned(),
            system: "rules".to_owned(),
            reads_only: false,
            tools: None,
            model: "fake/m".to_owned(),
            created_ms: 1,
        },
        &[],
        1,
    )?;
    Ok(())
}

fn offer(store: &Store, conversation: &str) -> Result {
    store.set_setting(
        &spade_core::tools::snapshot::key(conversation),
        Some(r#"{"generation":0,"tools":[]}"#),
    )?;
    Ok(())
}

fn uses(store: &Store, agent: &str) -> Result {
    store.set_setting(
        &spade_core::tools::pinning::uses_key(agent),
        Some("card_show\t2\n"),
    )?;
    Ok(())
}

fn has(store: &Store, key: &str) -> Result {
    assert_eq!(store.setting(key)?, None, "{key} is gone");
    Ok(())
}

#[test]
fn deleting_a_bot_takes_its_offered_list_and_its_tool_uses_with_it() -> Result {
    let dir = tempfile::tempdir()?;
    let store = Store::open(&dir.path().join("spade.sqlite"))?;
    bot(&store, "b1")?;
    helper(&store, "c_b1", "h_1")?;
    for conversation in ["c_b1", "h_1"] {
        offer(&store, conversation)?;
    }
    uses(&store, "b1")?;

    assert!(store.delete_agent("b1")?);

    has(&store, &spade_core::tools::snapshot::key("c_b1"))?;
    has(&store, &spade_core::tools::snapshot::key("h_1"))?;
    has(&store, &spade_core::tools::pinning::uses_key("b1"))?;
    Ok(())
}

#[test]
fn a_deleted_group_takes_its_offered_list_with_it() -> Result {
    let dir = tempfile::tempdir()?;
    let store = Store::open(&dir.path().join("spade.sqlite"))?;
    let group = StoredGroup {
        id: "g1".to_owned(),
        name: "Club".to_owned(),
        lead_id: "b1".to_owned(),
        conversation: "c_g1".to_owned(),
        members: Vec::new(),
        created_ms: 1,
        updated_ms: 1,
        pinned_ms: None,
    };
    store.create_group(&group)?;
    offer(&store, "c_g1")?;

    assert!(store.delete_group("g1")?);

    has(&store, &spade_core::tools::snapshot::key("c_g1"))?;
    Ok(())
}
