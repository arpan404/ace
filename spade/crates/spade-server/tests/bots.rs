//! Bots on one machine talk (ADR 0127): `bot_message` wakes the bot it names, and the bot's
//! answer returns to the caller as a background job result. Loops are refused.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use spade_core::Event;
use spade_core::event::{FromAgent, Known};
use spade_testkit::{FakeProvider, Script};
use support::{Result, Spade};

/// An endpoint on its own fake, so each agent's requests follow their own script.
async fn own_endpoint(spade: &Spade, name: &str, scripts: Vec<Script>) -> Result<FakeProvider> {
    let fake = FakeProvider::start_sequence(scripts).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": name, "format": "openai-chat", "base_url": fake.root, "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok(fake)
}

async fn main_conversation(spade: &Spade) -> Result<String> {
    let (_, list) = spade.get("/v1/agents").await?;
    Ok(list["agents"][0]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

/// Titles go to a fake of their own, so they never take another agent's script.
async fn quiet_titles(spade: &Spade) -> Result<FakeProvider> {
    let fake = own_endpoint(
        spade,
        "Titles",
        vec![Script::reply("").plain(r#"{"title":"T"}"#)],
    )
    .await?;
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    Ok(fake)
}

async fn approve(spade: &Spade, conversation: &str, call: &str) -> Result {
    spade.wait_for(conversation, "approval_requested").await?;
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/{call}"),
            json!({ "allowed": true, "always": true }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok(())
}

fn job_result(events: &[Value]) -> Value {
    events
        .iter()
        .find(|e| e["type"] == "job_finished")
        .cloned()
        .unwrap_or_default()
}

#[tokio::test]
async fn a_message_wakes_the_bot_and_its_answer_returns_to_the_caller_as_a_job_result() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "b1",
                "bot_message",
                json!({ "bot": "Research", "text": "What is X?" }),
            ),
            Script::reply("Asked Research; X is 42."),
        ],
        Vec::new(),
    )
    .await?;
    let _titles = quiet_titles(&spade).await?;
    let research_fake =
        own_endpoint(&spade, "Research Net", vec![Script::reply("X is 42.")]).await?;
    let (_, research) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Research", "model": "research-net/r" }),
        )
        .await?;
    let research_conversation = research["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let spade_conversation = main_conversation(&spade).await?;

    spade
        .say(&spade_conversation, "Ask Research what X is")
        .await?;
    approve(&spade, &spade_conversation, "b1").await?;

    let theirs = spade
        .wait_for(&research_conversation, "reply_finished")
        .await?;
    let delivered = theirs
        .iter()
        .find(|e| e["type"] == "user_message")
        .cloned()
        .unwrap_or_default();
    assert_eq!(delivered["text"], "What is X?");
    assert_eq!(
        delivered["from_agent"]["name"], "Spade",
        "stored as from the calling agent"
    );
    assert_eq!(delivered["from_agent"]["depth"], 1);
    let told = research_fake.seen()[0].body["messages"].to_string();
    assert!(told.contains("bot_message from=\\\"Spade\\\""), "{told}");

    let ours = spade.wait_for(&spade_conversation, "job_finished").await?;
    let result = job_result(&ours);
    assert_eq!(result["is_error"], false);
    assert_eq!(result["content"], "Research answered:\nX is 42.");

    let (_, list) = spade.get("/v1/agents").await?;
    let shown = list["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == "Research").cloned())
        .unwrap_or_default();
    assert_eq!(shown["last_message"]["from"], "agent");
    assert_eq!(shown["last_message"]["text"], "X is 42.");
    Ok(())
}

#[tokio::test]
async fn a_bot_cannot_message_itself() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "b1",
                "bot_message",
                json!({ "bot": "Spade", "text": "Hello me" }),
            ),
            Script::reply("Fine."),
        ],
        Vec::new(),
    )
    .await?;
    let _titles = quiet_titles(&spade).await?;
    let conversation = main_conversation(&spade).await?;
    spade.say(&conversation, "Talk to yourself").await?;
    approve(&spade, &conversation, "b1").await?;
    let events = spade.wait_for(&conversation, "job_finished").await?;
    let result = job_result(&events);
    assert_eq!(result["is_error"], true);
    assert_eq!(result["content"], "A bot cannot message itself.");
    let user_messages = events
        .iter()
        .filter(|e| e["type"] == "user_message")
        .count();
    assert_eq!(user_messages, 1, "nothing was delivered");
    Ok(())
}

#[tokio::test]
async fn a_chain_of_bot_messages_deeper_than_three_is_refused() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let relay = spade.new_agent("Relay", "").await?;
    spade.new_agent("Other", "").await?;
    let relay_conversation = relay["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // Relay was asked by a bot three hops from the person, stored while Spade was away.
    {
        let store = spade_store::Store::open(&spade.database())?;
        store.append(
            &relay_conversation,
            &Event::Known(Known::UserMessage {
                text: "Pass this on".into(),
                context: None,
                images: Vec::new(),
                from_agent: Some(FromAgent {
                    id: "a_x".into(),
                    name: "Far".into(),
                    depth: 3,
                    machine: None,
                }),
                from_routine: None,
                from_group: None,
            }),
            1,
        )?;
    }
    let spade = spade
        .restart(
            Vec::new(),
            vec![
                Script::reply("").call(
                    "b1",
                    "bot_message",
                    json!({ "bot": "Other", "text": "Pass it on" }),
                ),
                Script::reply("Could not pass it on."),
                Script::reply("").plain(r#"{"title":"T"}"#),
            ],
        )
        .await?;
    approve(&spade, &relay_conversation, "b1").await?;
    let events = spade.wait_for(&relay_conversation, "job_finished").await?;
    let result = job_result(&events);
    assert_eq!(result["is_error"], true);
    assert!(
        result["content"]
            .as_str()
            .is_some_and(|c| c.contains("more than 3")),
        "{result}"
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (_, list) = spade.get("/v1/agents").await?;
    let other = list["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == "Other").cloned())
        .unwrap_or_default();
    assert_eq!(
        other["last_message"],
        Value::Null,
        "Other never heard of it"
    );
    Ok(())
}
