//! Bots' caps (ADR 0135) where groups and other machines ask them (ADR 0132): a member at its
//! cap fails the ask with why instead of a blank answer, and so does a remote ask.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::engine::InboxSender;
use spade_server::tools::Tool;
use spade_testkit::{FakeProvider, Script};
use support::{FakeTool, Result, Spade};

/// A bot on an endpoint of its own answering with `scripts`, so the lead's script is untouched.
async fn member(spade: &Spade, name: &str, scripts: Vec<Script>) -> Result<(Value, FakeProvider)> {
    let fake = FakeProvider::start_sequence(scripts).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": format!("{name} Net"), "format": "openai-chat",
                    "base_url": fake.root, "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let model = format!("{}-net/m", name.to_lowercase());
    let (status, body) = spade
        .post("/v1/agents", json!({ "name": name, "model": model }))
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok((body["agent"].clone(), fake))
}

async fn cap(spade: &Spade, agent: &Value, micros: u64) -> Result {
    let id = agent["id"].as_str().unwrap_or_default();
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{id}/oversight"),
            json!({ "daily_cap_micros": micros }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(())
}

/// A group of `members` (Spade leads), and the person's `@Writer …` post in it; its answer.
async fn ask_writer(spade: &Spade, members: &[&Value]) -> Result<Value> {
    let listed: Vec<Value> = members
        .iter()
        .map(|m| json!({ "agent": m["id"] }))
        .collect();
    let (status, group) = spade
        .post("/v1/groups", json!({ "name": "Docs", "members": listed }))
        .await?;
    assert_eq!(status, 201, "{group}");
    let group = group["group"].clone();
    let id = group["id"].as_str().unwrap_or_default();
    let (status, body) = spade
        .post(
            &format!("/v1/groups/{id}/messages"),
            json!({ "text": "@writer draft the intro" }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let conversation = group["conversation"].as_str().unwrap_or_default();
    let events = spade.wait_for(conversation, "group_answered").await?;
    Ok(events
        .iter()
        .find(|e| e["type"] == "group_answered")
        .cloned()
        .unwrap_or_default())
}

#[tokio::test]
async fn a_member_at_its_cap_fails_a_group_ask_with_why_and_is_never_woken() -> Result {
    let spade = Spade::start(vec![Script::reply("lead")], Vec::new()).await?;
    let (research, _r) = member(&spade, "Research", vec![Script::reply("unused")]).await?;
    let (writer, writer_fake) = member(&spade, "Writer", vec![Script::reply("A draft.")]).await?;
    cap(&spade, &writer, 0).await?;
    let answered = ask_writer(&spade, &[&research, &writer]).await?;
    assert_eq!(answered["outcome"], "failed", "{answered}");
    assert!(
        answered["detail"]
            .as_str()
            .is_some_and(|d| d.contains("Writer is at its daily cap")),
        "{answered}"
    );
    assert!(
        writer_fake.seen().is_empty(),
        "no model call for a capped member"
    );
    let theirs = spade
        .events(writer["conversation"].as_str().unwrap_or_default())
        .await?;
    assert!(!theirs.iter().any(|e| e["type"] == "user_message"));
    Ok(())
}

#[tokio::test]
async fn a_member_that_reaches_its_cap_while_answering_fails_the_ask_rather_than_answering_blank()
-> Result {
    let noop = FakeTool::new("noop", Risk::Read, "nothing");
    // The writer is on the priced fake model (a mention never asks the lead): its first step
    // costs 92 of its 50, so there is no second step and its reply closes at the cap.
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "noop", json!({})),
            Script::reply("never said"),
        ],
        vec![Arc::new(noop) as Arc<dyn Tool>],
    )
    .await?;
    let (research, _r) = member(&spade, "Research", vec![Script::reply("unused")]).await?;
    let writer = spade.new_agent("Writer", "Writes drafts").await?;
    cap(&spade, &writer, 50).await?;
    let answered = ask_writer(&spade, &[&research, &writer]).await?;
    assert_eq!(answered["outcome"], "failed", "{answered}");
    assert!(
        answered["detail"]
            .as_str()
            .is_some_and(|d| d.contains("daily cap")),
        "{answered}"
    );
    Ok(())
}

#[tokio::test]
async fn a_remote_ask_to_a_bot_at_its_cap_is_refused_with_why() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (writer, writer_fake) = member(&spade, "Writer", vec![Script::reply("A draft.")]).await?;
    cap(&spade, &writer, 0).await?;
    let sender = InboxSender {
        host: "studio".into(),
        name: "Studio Mac".into(),
    };
    let (status, body) = spade
        .engine
        .inbox(
            &sender,
            &json!({ "op": "ask", "key": "k1", "to": writer["id"], "text": "Draft it",
                     "from": { "id": "b1", "name": "Planner" }, "depth": 1 }),
        )
        .await;
    assert_eq!(status, 402, "{body}");
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|e| e.contains("Writer is at its daily cap")),
        "{body}"
    );
    assert!(writer_fake.seen().is_empty());
    Ok(())
}
