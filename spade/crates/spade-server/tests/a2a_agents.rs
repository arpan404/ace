//! Outside A2A agents as the person's apps (ADR 0202 §5), against a fake agent on 127.0.0.1 and
//! a scripted model: added by its address, its card's signature is checked (a card changed after
//! signing, or unsigned, reads "Not signed"); a call of one of its skills goes to the person
//! first and sends nothing until they allow it; what comes back is the agent's untrusted words;
//! and Stop cancels the task with `CancelTask`.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use spade_testkit::a2a::RESULT_TEXT;
use spade_testkit::{FakeAgent, Script};
use support::{Result, Spade};

async fn main_conversation(spade: &Spade) -> Result<String> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["kind"] == "main"))
        .and_then(|a| a["conversation"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| "no main agent".into())
}

async fn add(spade: &Spade, agent: &FakeAgent) -> Result<Value> {
    let (status, body) = spade
        .post("/v1/a2a-agents", json!({ "address": agent.url() }))
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok(body["agent"].clone())
}

fn book(id: &str) -> Script {
    Script::reply("").call(
        id,
        "call_tool",
        json!({ "name": "travel-desk__book", "arguments": { "route": "KTM-DEL" } }),
    )
}

async fn allow(spade: &Spade, conversation: &str, call: &str) -> Result {
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/{call}"),
            json!({ "allowed": true, "always": false }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok(())
}

async fn until(mut done: impl FnMut() -> bool, what: &str) -> Result {
    for _ in 0..500 {
        if done() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err(format!("never: {what}").into())
}

#[tokio::test]
async fn an_agent_added_by_address_has_its_signed_card_verified_and_its_skills_listed() -> Result {
    let agent = FakeAgent::start().await;
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let added = add(&spade, &agent).await?;
    assert_eq!(added["id"], "travel-desk");
    assert_eq!(added["signed"], true, "{added}");
    assert_eq!(added["signature"], "Signed by its publisher's key");
    assert_eq!(added["endpoint"], format!("{}/a2a", agent.url()));
    let skills: Vec<(&Value, &Value, &Value)> = added["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| (&s["tool"], &s["effect"], &s["json"]))
        .collect();
    assert_eq!(
        skills,
        vec![
            (
                &json!("travel-desk__book"),
                &json!("send_as_person"),
                &json!(true)
            ),
            (
                &json!("travel-desk__chat"),
                &json!("send_as_person"),
                &json!(false)
            ),
        ]
    );
    let (_, listed) = spade.get("/v1/a2a-agents").await?;
    assert_eq!(listed["agents"][0]["id"], "travel-desk");
    // The same agent twice is refused.
    let (status, _) = spade
        .post("/v1/a2a-agents", json!({ "address": agent.url() }))
        .await?;
    assert_eq!(status, 400);
    Ok(())
}

#[tokio::test]
async fn a_card_changed_after_signing_or_unsigned_is_marked_not_signed() -> Result {
    let tampered = FakeAgent::start().await;
    tampered.tamper();
    let unsigned = FakeAgent::start().await;
    unsigned.unsigned();
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let read = add(&spade, &tampered).await?;
    assert_eq!(
        (&read["signed"], &read["signature"]),
        (&json!(false), &json!("Not signed"))
    );
    assert!(
        read["unsigned_because"]
            .as_str()
            .is_some_and(|why| why.contains("changed after it was signed")),
        "{read}"
    );
    let read = add(&spade, &unsigned).await?;
    assert_eq!(read["signature"], "Not signed");
    // Not https and not this machine: refused before anything is fetched.
    let (status, body) = spade
        .post(
            "/v1/a2a-agents",
            json!({ "address": "http://agents.example.com" }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_skill_call_asks_the_person_first_and_its_result_is_the_agents_untrusted_words() -> Result
{
    let agent = FakeAgent::start().await;
    let spade = Spade::start(
        vec![
            book("c1"),
            Script::reply("Booked."),
            Script::reply("").plain(r#"{"title":"Trip"}"#),
        ],
        Vec::new(),
    )
    .await?;
    add(&spade, &agent).await?;
    let main = main_conversation(&spade).await?;
    spade.say(&main, "Book KTM-DEL").await?;
    let events = spade.wait_for(&main, "approval_requested").await?;
    let asked = events
        .iter()
        .find(|e| e["type"] == "approval_requested" && e["call_id"] == "c1")
        .ok_or("the call didn't ask the person")?;
    assert!(asked.to_string().contains("in your name"), "{asked}");
    assert!(
        agent.sent().is_empty(),
        "it was sent before the person answered"
    );

    allow(&spade, &main, "c1").await?;
    let events = spade.wait_for(&main, "reply_finished").await?;
    let finished = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c1")
        .ok_or("no result")?;
    let content = finished["content"].as_str().unwrap_or_default();
    assert!(
        content
            .starts_with("<agent_result agent=\"Travel desk\" skill=\"book\" untrusted=\"true\">"),
        "{content}"
    );
    assert!(
        content.contains(RESULT_TEXT) && content.contains(r#""fare":120"#),
        "{content}"
    );
    let sent = agent.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["role"], "ROLE_USER");
    assert_eq!(sent[0]["parts"][0]["data"], json!({ "route": "KTM-DEL" }));
    // The message's id is the call's key, so a call run again reaches the same task.
    assert_eq!(sent[0]["messageId"], format!("{main}.c1"));
    assert!(agent.versions().iter().all(|v| v == "1.0"));
    Ok(())
}

#[tokio::test]
async fn stop_cancels_the_agents_task() -> Result {
    let agent = FakeAgent::start().await;
    agent.hold();
    let spade = Spade::start(vec![book("c1")], Vec::new()).await?;
    add(&spade, &agent).await?;
    let main = main_conversation(&spade).await?;
    spade.say(&main, "Book KTM-DEL").await?;
    spade.wait_for(&main, "approval_requested").await?;
    allow(&spade, &main, "c1").await?;
    until(|| !agent.sent().is_empty(), "the message went").await?;
    assert!(agent.cancels().is_empty());
    let (status, body) = spade
        .post(&format!("/v1/conversations/{main}/stop"), json!({}))
        .await?;
    assert!(status < 300, "{status} {body}");
    until(|| agent.cancels() == ["task-1"], "the task was cancelled").await?;
    Ok(())
}
