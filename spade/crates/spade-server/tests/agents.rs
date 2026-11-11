//! Agents (ADR 0126, 0127) through the API: Spade the main agent, bots with one conversation
//! each, edits from the next turn, deletion, and what the roster shows.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, Result, Spade, types};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"A title"}"#)
}

async fn roster(spade: &Spade) -> Result<Vec<Value>> {
    let (status, body) = spade.get("/v1/agents").await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["agents"].as_array().cloned().unwrap_or_default())
}

async fn agent(spade: &Spade, id: &str) -> Result<Value> {
    Ok(roster(spade)
        .await?
        .into_iter()
        .find(|a| a["id"] == id)
        .unwrap_or_default())
}

/// Polls the roster until `agent` passes `check`.
async fn wait_until(spade: &Spade, id: &str, check: impl Fn(&Value) -> bool) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let found = agent(spade, id).await?;
        if check(&found) {
            return Ok(found);
        }
        if Instant::now() > deadline {
            return Err(format!("never got there: {found}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn spade_exists_from_the_first_start_and_cannot_be_deleted_or_renamed() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let bot = spade.new_agent("Research", "").await?;
    let list = roster(&spade).await?;
    assert_eq!(list.len(), 2);
    let main = &list[0];
    assert_eq!(
        (&main["kind"], &main["name"], &main["avatar"]),
        (&json!("main"), &json!("Spade"), &json!({ "kind": "spade" })),
        "Spade is listed first"
    );
    assert_eq!(main["model"], "fake/m", "the person's first usable model");
    let id = main["id"].as_str().unwrap_or_default();

    let (status, body) = spade.delete(&format!("/v1/agents/{id}")).await?;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|e| e.contains("cannot be deleted"))
    );
    for change in [
        json!({ "name": "Bob" }),
        json!({ "avatar": { "kind": "generated" } }),
    ] {
        let response = spade
            .http
            .patch(format!("{}/v1/agents/{id}", spade.base))
            .bearer_auth(support::TOKEN)
            .json(&change)
            .send()
            .await?;
        assert_eq!(response.status().as_u16(), 409);
    }
    let changed = patch(&spade, id, json!({ "task": "Run my week." })).await?;
    assert_eq!(changed["agent"]["task"], "Run my week.");
    assert_eq!(changed["agent"]["name"], "Spade");

    // A bot is created with exactly one conversation of its own.
    let conversation = bot["conversation"].as_str().unwrap_or_default();
    assert_ne!(
        conversation,
        main["conversation"].as_str().unwrap_or_default()
    );
    let (status, events) = spade
        .get(&format!("/v1/conversations/{conversation}/events"))
        .await?;
    assert_eq!((status, events), (200, json!([])));
    assert_eq!(bot["kind"], "bot");
    assert_eq!(bot["avatar"]["kind"], "generated");
    assert_eq!(bot["avatar"]["initials"], "RE");
    assert_eq!(
        (&bot["state"], &bot["status"]),
        (&json!("idle"), &Value::Null)
    );
    let (status, _) = spade
        .post("/v1/conversations", json!({ "text": "hi" }))
        .await?;
    assert_eq!(status, 410, "there are no new chats, only agents");
    Ok(())
}

async fn patch(spade: &Spade, id: &str, body: Value) -> Result<Value> {
    let response = spade
        .http
        .patch(format!("{}/v1/agents/{id}", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&body)
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    Ok(response.json().await?)
}

#[tokio::test]
async fn spade_switched_off_on_this_machine_is_hidden_and_takes_no_messages() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let main = roster(&spade).await?.remove(0);
    let conversation = main["conversation"].as_str().unwrap_or_default();
    let (status, _) = spade.put("/v1/main", json!({ "enabled": false })).await?;
    assert_eq!(status, 204);
    assert!(roster(&spade).await?.iter().all(|a| a["kind"] != "main"));
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "hello?" }),
        )
        .await?;
    assert_eq!(status, 409);
    assert!(spade.fake.seen().is_empty());
    spade.put("/v1/main", json!({ "enabled": true })).await?;
    assert_eq!(
        roster(&spade).await?[0]["id"],
        main["id"],
        "its conversation was kept"
    );
    Ok(())
}

#[tokio::test]
async fn two_agents_answer_at_once_and_stop_on_one_leaves_the_other_running() -> Result {
    let slow = Script::reply("one two three four five six seven eight nine ten")
        .chunks(10)
        .delay(Duration::from_millis(150));
    let spade = Spade::start(vec![slow], Vec::new()).await?;
    let first = spade.ask("Tell me a long story").await?;
    let second = spade.ask("Tell me another").await?;
    for id in [&first, &second] {
        spade.wait_for(id, "reply_progress").await?;
    }
    let (status, _) = spade
        .post(&format!("/v1/conversations/{first}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202);
    let stopped = spade.wait_for(&first, "reply_stopped").await?;
    assert!(!types(&stopped).contains(&"reply_finished".to_owned()));
    let still = spade.events(&second).await?;
    assert!(
        !types(&still)
            .iter()
            .any(|t| t.starts_with("reply_") && t != "reply_started" && t != "reply_progress"),
        "the other agent is still answering: {:?}",
        types(&still)
    );
    let finished = spade.wait_for(&second, "reply_finished").await?;
    let text = finished.iter().find(|e| e["type"] == "reply_finished");
    assert_eq!(
        text.map(|e| e["text"].clone()),
        Some(json!("one two three four five six seven eight nine ten"))
    );
    Ok(())
}

/// The system prompt of the `n`th request the fake saw.
fn system(spade: &Spade, n: usize) -> Value {
    spade.fake.seen()[n].body["messages"][0].clone()
}

#[tokio::test]
async fn a_task_or_model_change_applies_from_the_next_turn_and_survives_a_restart() -> Result {
    let spade = Spade::start(
        vec![Script::reply("Sure."), title(), Script::reply("Okay.")],
        Vec::new(),
    )
    .await?;
    let agent = spade.new_agent("Trips", "Plan trips.").await?;
    let (id, conversation) = (
        agent["id"].as_str().unwrap_or_default().to_owned(),
        agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    );
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    assert!(system(&spade, 0).to_string().contains("Plan trips."));
    assert_eq!(spade.fake.seen()[0].body["model"], "m");

    let changed = patch(
        &spade,
        &id,
        json!({ "task": "Track parcels.", "model": "fake/other" }),
    )
    .await?;
    assert_eq!(changed["agent"]["model"], "fake/other");
    spade.say(&conversation, "Where is it?").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    let second = spade.fake.seen()[2].clone();
    assert_eq!(second.body["model"], "other");
    let prompt = second.body["messages"][0].to_string();
    assert!(
        prompt.contains("Track parcels.") && !prompt.contains("Plan trips."),
        "{prompt}"
    );

    let spade = spade
        .restart(Vec::new(), vec![Script::reply("Still here.")])
        .await?;
    spade.say(&conversation, "Again").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 3)
        .await?;
    let after = spade.fake.seen()[0].clone();
    assert_eq!(after.body["model"], "other");
    assert_eq!(
        after.body["messages"][0], second.body["messages"][0],
        "the same prompt top"
    );
    Ok(())
}

#[tokio::test]
async fn deleting_an_agent_stops_its_work_and_removes_its_conversation() -> Result {
    let slow = Script::reply("a b c d e f g h")
        .chunks(8)
        .delay(Duration::from_millis(200));
    let spade = Spade::start(vec![slow], Vec::new()).await?;
    let conversation = spade.ask("Go slowly").await?;
    spade.wait_for(&conversation, "reply_progress").await?;
    let id = roster(&spade)
        .await?
        .into_iter()
        .find(|a| a["conversation"] == conversation.as_str())
        .map(|a| a["id"].as_str().unwrap_or_default().to_owned())
        .unwrap_or_default();
    let (status, _) = spade.delete(&format!("/v1/agents/{id}")).await?;
    assert_eq!(status, 204);
    let (status, _) = spade
        .get(&format!("/v1/conversations/{conversation}/events"))
        .await?;
    assert_eq!(status, 404);
    assert!(roster(&spade).await?.iter().all(|a| a["id"] != id.as_str()));
    let (status, _) = spade.delete(&format!("/v1/agents/{id}")).await?;
    assert_eq!(status, 404);
    Ok(())
}

#[tokio::test]
async fn the_roster_shows_a_running_turn_and_an_approval_wait() -> Result {
    let email = FakeTool::new("send_email", Risk::Write, "sent");
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "send_email", json!({ "to": "sam@example.com" })),
            Script::reply("Sent it.")
                .chunks(6)
                .delay(Duration::from_millis(150)),
            title(),
        ],
        vec![Arc::new(email) as Arc<dyn Tool>],
    )
    .await?;
    let conversation = spade.ask("Email Sam about **lunch**").await?;
    let id = roster(&spade)
        .await?
        .into_iter()
        .find(|a| a["conversation"] == conversation.as_str())
        .map(|a| a["id"].as_str().unwrap_or_default().to_owned())
        .unwrap_or_default();
    let mut live = spade
        .http
        .get(format!(
            "{}/v1/conversations/{conversation}/live?after=0",
            spade.base
        ))
        .bearer_auth(support::TOKEN)
        .send()
        .await?
        .bytes_stream();

    let waiting = wait_until(&spade, &id, |a| a["state"] == "waiting").await?;
    assert_eq!(waiting["status"], "Waiting for you");
    assert_eq!(waiting["working"], true);
    assert_eq!(
        waiting["last_message"]["text"], "Email Sam about lunch",
        "plain text"
    );
    assert_eq!(waiting["last_message"]["from"], "person");
    let mut seen = String::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !seen.contains(r#""state":"waiting""#) && Instant::now() < deadline {
        if let Ok(Some(Ok(chunk))) = tokio::time::timeout(Duration::from_secs(1), live.next()).await
        {
            seen.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    assert!(seen.contains("event: status"), "{seen}");
    assert!(seen.contains(r#""status":"Waiting for you""#), "{seen}");

    spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/c1"),
            json!({ "allowed": true }),
        )
        .await?;
    let working = wait_until(&spade, &id, |a| a["state"] == "working").await?;
    assert!(
        matches!(
            working["status"].as_str(),
            Some("Thinking" | "Using send email")
        ),
        "{working}"
    );
    let idle = wait_until(&spade, &id, |a| a["state"] == "idle").await?;
    assert_eq!(idle["status"], Value::Null);
    assert_eq!(idle["working"], false);
    assert_eq!(
        (&idle["last_message"]["from"], &idle["last_message"]["text"]),
        (&json!("agent"), &json!("Sent it."))
    );
    Ok(())
}

#[tokio::test]
async fn titles_use_the_fast_model_when_one_is_set_and_the_agents_own_otherwise() -> Result {
    let spade = Spade::start(vec![Script::reply("Hi."), title()], Vec::new()).await?;
    let first = spade.ask("Hello").await?;
    spade.wait_for(&first, "renamed").await?;
    assert_eq!(
        spade.fake.seen()[1].body["model"],
        "m",
        "the agent's own model"
    );

    let (status, body) = spade
        .put("/v1/settings", json!({ "fast_model": "fake/quick" }))
        .await?;
    assert_eq!(status, 204, "{body}");
    let (_, models) = spade.get("/v1/models").await?;
    assert_eq!(models["fast_model"], "fake/quick");
    let second = spade.ask("Hello again").await?;
    spade.wait_for(&second, "renamed").await?;
    let seen = spade.fake.seen();
    assert_eq!(
        seen[2].body["model"], "m",
        "replies stay on the agent's model"
    );
    assert_eq!(
        seen[3].body["model"], "quick",
        "the title uses the fast model"
    );

    let (status, _) = spade
        .put("/v1/settings", json!({ "fast_model": "nowhere/x" }))
        .await?;
    assert_eq!(
        status, 400,
        "a fast model must be on one of the person's endpoints"
    );
    Ok(())
}

#[tokio::test]
async fn a_typed_model_id_nobody_saved_works_end_to_end() -> Result {
    let spade = Spade::start(vec![Script::reply("Typed works."), title()], Vec::new()).await?;
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Odd", "model": "fake/vendor/typed-1", "unknown_field": 1 }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let conversation = body["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hi").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_started" && e["model"] == "fake/vendor/typed-1")
    );
    assert_eq!(spade.fake.seen()[0].body["model"], "vendor/typed-1");

    for bad in [
        json!({ "name": "", "model": "fake/m" }),
        json!({ "name": "x".repeat(41), "model": "fake/m" }),
        json!({ "name": "Ok", "task": "t".repeat(4001), "model": "fake/m" }),
        json!({ "name": "Ok", "model": "no-slash" }),
        json!({ "name": "Ok", "model": "nowhere/m" }),
        json!({ "name": "Ok", "model": "fake/m", "avatar": { "kind": "generated", "color": "plaid" } }),
        json!({ "task": "no name" }),
    ] {
        let (status, body) = spade.post("/v1/agents", bad.clone()).await?;
        assert!(matches!(status, 400 | 422), "{bad} gave {status}");
        assert!(body["error"].is_string(), "{body}");
    }
    Ok(())
}
