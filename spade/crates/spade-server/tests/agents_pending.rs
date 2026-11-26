//! What the agents list says a waiting bot needs: `pending` holds one entry per open approval,
//! in the order asked, and is empty again once the person answers. The call that waits is an
//! outside A2A agent's skill, which always asks the person first (ADR 0202 §5).

mod support;

use serde_json::{Value, json};
use spade_testkit::{FakeAgent, Script};
use support::{Result, Spade};

async fn main_agent(spade: &Spade) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|agent| agent["kind"] == "main"))
        .cloned()
        .ok_or_else(|| "no main agent".into())
}

#[tokio::test]
async fn a_bot_waiting_on_an_approval_lists_it_as_pending_until_the_person_answers() -> Result {
    let agent = FakeAgent::start().await;
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "c1",
                "call_tool",
                json!({ "name": "travel-desk__book", "arguments": { "route": "KTM-DEL" } }),
            ),
            Script::reply("Booked."),
            Script::reply("").plain(r#"{"title":"Trip"}"#),
        ],
        Vec::new(),
    )
    .await?;
    let (status, body) = spade
        .post(
            "/v1/a2a-agents",
            json!({ "address": agent.url(), "local": true }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let main = main_agent(&spade).await?;
    let conversation = main["conversation"].as_str().ok_or("no conversation")?;
    assert_eq!(main["pending"], json!([]));

    spade.say(conversation, "Book KTM-DEL").await?;
    spade.wait_for(conversation, "approval_requested").await?;
    let waiting = main_agent(&spade).await?;
    let pending = waiting["pending"].as_array().ok_or("no pending list")?;
    assert_eq!(pending.len(), 1, "{waiting}");
    assert_eq!(pending[0]["kind"], "approval");
    assert_eq!(pending[0]["name"], "travel-desk__book");

    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/c1"),
            json!({ "allowed": true, "always": false }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    spade.wait_for(conversation, "reply_finished").await?;
    assert_eq!(main_agent(&spade).await?["pending"], json!([]));
    Ok(())
}
