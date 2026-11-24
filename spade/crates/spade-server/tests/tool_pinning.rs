//! Learned tool pinning (spade/docs/harness.md, Tools): a deferred tool a bot keeps reaching for
//! is offered up front from its next compaction, never mid-conversation, so the prompt's top
//! stays byte-stable for the provider's cache (docs/design.md, Caching).

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, Result, Spade};

/// A bot on `fake/big`, a model with a 1,000,000-token window: its conversation's id.
async fn big_bot(spade: &Spade) -> Result<String> {
    let (status, body) = spade
        .post(
            "/v1/endpoints/fake/models",
            json!({ "id": "big", "context": 1_000_000, "capabilities": ["tools", "images"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Builder", "task": "", "model": "fake/big" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok(body["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

/// The tools one request offered, by name.
fn offered(body: &Value) -> Vec<String> {
    body["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .map(|tool| {
                    tool["function"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned()
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The step that answered the person saying `said`: the first request whose newest person
/// message carries their words (the prompt numbers them, as `[m16] And again.`).
fn request_saying(spade: &Spade, said: &str) -> Value {
    spade
        .fake
        .seen()
        .into_iter()
        .map(|seen| seen.body)
        .find(|body| last_person(body).is_some_and(|text| text.contains(said)))
        .unwrap_or(Value::Null)
}

fn last_person(body: &Value) -> Option<String> {
    body["messages"]
        .as_array()?
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .map(|message| message["content"].as_str().unwrap_or_default().to_owned())
}

/// A step that reaches twice for `often` and once for `rare`, both deferred.
fn using_often_and_rare(usage: Option<u32>) -> Script {
    let call = |id: &str, name: &str| {
        (
            id.to_owned(),
            "call_tool".to_owned(),
            json!({ "name": name, "arguments": {} }),
        )
    };
    let script = Script::reply("Looking.");
    let script = match usage {
        Some(tokens) => script.cached(tokens, 0),
        None => script,
    };
    let (a, b, c) = (call("c1", "often"), call("c2", "often"), call("c3", "rare"));
    script
        .call(&a.0, &a.1, a.2)
        .call(&b.0, &b.1, b.2)
        .call(&c.0, &c.1, c.2)
}

fn tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(FakeTool::new("often", Risk::Read, "often done").deferred("Used often")),
        Arc::new(FakeTool::new("rare", Risk::Read, "rare done").deferred("Used rarely")),
    ]
}

#[tokio::test]
async fn a_tool_a_bot_uses_twice_is_offered_up_front_after_its_next_compaction() -> Result {
    // The first step reports 905,011 tokens: past 90% of the window, so the next one compacts.
    let spade = Spade::start_turns(
        vec![
            using_often_and_rare(Some(905_000)),
            Script::reply("Done."),
            Script::reply("Still here."),
        ],
        Script::reply("").plain(r#"{"title":"Build"}"#),
        tools(),
    )
    .await?;
    let id = big_bot(&spade).await?;
    spade.say(&id, "Find the issue.").await?;
    spade.wait_for_count(&id, "reply_finished", 1).await?;
    spade.say(&id, "And again.").await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;

    let first = request_saying(&spade, "Find the issue.");
    assert!(
        !offered(&first).contains(&"often".to_owned()),
        "deferred until it is used: {:?}",
        offered(&first)
    );
    let later = request_saying(&spade, "And again.");
    let names = offered(&later);
    assert!(
        names.contains(&"often".to_owned()),
        "used twice, so it is offered up front after the compaction: {names:?}"
    );
    assert!(
        !names.contains(&"rare".to_owned()),
        "used once, so it stays deferred: {names:?}"
    );
    Ok(())
}

#[tokio::test]
async fn the_offered_tools_do_not_change_within_a_conversation() -> Result {
    // No compaction: the same conversation keeps the list it started with, whatever the bot uses.
    let spade = Spade::start_turns(
        vec![
            using_often_and_rare(None),
            Script::reply("Done."),
            Script::reply("Still here."),
        ],
        Script::reply("").plain(r#"{"title":"Build"}"#),
        tools(),
    )
    .await?;
    let id = big_bot(&spade).await?;
    spade.say(&id, "Find the issue.").await?;
    spade.wait_for_count(&id, "reply_finished", 1).await?;
    spade.say(&id, "And again.").await?;
    spade.wait_for_count(&id, "reply_finished", 2).await?;

    let first = request_saying(&spade, "Find the issue.");
    let later = request_saying(&spade, "And again.");
    assert_eq!(
        offered(&first),
        offered(&later),
        "the prompt's top must stay byte-stable for the provider's cache"
    );
    assert!(
        !offered(&later).contains(&"often".to_owned()),
        "a pin waits for the next conversation or compaction"
    );
    Ok(())
}
