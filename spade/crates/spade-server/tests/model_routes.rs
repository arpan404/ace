//! A role's route (ADR 0205 §2) through the real engine and API, on `spade-testkit`'s fake
//! endpoint: a bot's step moves to the next model of its route only on a definite sign (a refused
//! connection, a 429, a server error once its tries are used up), never on a slow answer, a bad
//! answer or a refusal; the step records which model served it and why; the rest of the reply
//! stays on that model; and a route never takes a subscription.
//!
//! The person's endpoints: `fake/m` (the fake), `backup/b` (the same fake under another id) and
//! `off/m` (a server on this computer that isn't running). The fake answers in order, whichever
//! model is asked; the model a request named is what tells them apart.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use spade_server::engine::Retry;
use spade_testkit::Script;
use support::{FakeTool, Options, Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Logs"}"#)
}

fn quick_retries() -> Options {
    Options {
        model_retry: Some(Retry {
            tries: 3,
            first_wait: Duration::from_millis(20),
            longest: Duration::from_secs(5),
        }),
        ..Options::default()
    }
}

/// A port nothing listens on, on this computer.
async fn closed_port() -> Result<String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    drop(listener);
    Ok(format!("http://{address}/v1/"))
}

/// Adds a keyless endpoint at `base_url` with one model that calls tools.
async fn endpoint(spade: &Spade, name: &str, base_url: &str, model: &str) -> Result {
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": name, "format": "openai-chat", "base_url": base_url,
                    "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let id = body["endpoint"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .post(
            &format!("/v1/endpoints/{id}/models"),
            json!({ "id": model, "name": model.to_uppercase(), "capabilities": ["tools"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    Ok(())
}

/// The fake as `backup/b`, the global main route `["backup/b"]`, titles on `backup/b`.
async fn with_backup(spade: &Spade) -> Result {
    endpoint(spade, "Backup", &spade.fake.root, "b").await?;
    let (status, body) = spade
        .put(
            "/v1/models/roles",
            json!({ "roles": { "main": ["backup/b"] } }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["routes"]["main"], json!(["backup/b"]));
    let (status, body) = spade
        .put("/v1/settings", json!({ "fast_model": "backup/b" }))
        .await?;
    assert!(status < 300, "{body}");
    Ok(())
}

/// A bot on `model`; its conversation.
async fn bot_on(spade: &Spade, model: &str) -> Result<String> {
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Logs", "task": "", "model": model }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok(body["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

/// The model each streamed request (a bot's step) named, in order.
fn steps_asked(spade: &Spade) -> Vec<String> {
    spade
        .fake
        .seen()
        .into_iter()
        .filter(|seen| seen.body["stream"] == true)
        .map(|seen| seen.body["model"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn served(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|e| e["type"] == "step_served")
        .collect()
}

#[tokio::test]
async fn a_refused_connection_on_the_first_model_serves_the_step_on_the_next_and_says_why() -> Result
{
    let spade = Spade::start(vec![Script::reply("Here you go."), title()], Vec::new()).await?;
    with_backup(&spade).await?;
    endpoint(&spade, "Off", &closed_port().await?, "m").await?;
    let chat = bot_on(&spade, "off/m").await?;
    spade.say(&chat, "Hi").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let finished = events.iter().find(|e| e["type"] == "reply_finished");
    assert_eq!(
        finished.map(|e| e["text"].clone()),
        Some(json!("Here you go."))
    );
    assert_eq!(steps_asked(&spade), ["b"]);
    let served = served(&events);
    assert_eq!(served.len(), 1, "{events:?}");
    assert_eq!(served[0]["model"], "backup/b");
    assert_eq!(
        served[0]["skipped"],
        json!([{ "model": "off/m", "reason": "unreachable" }])
    );
    assert_eq!(served[0]["line"], "Ran on B: the local server was off.");
    Ok(())
}

#[tokio::test]
async fn a_429_moves_the_step_on_and_the_rest_of_the_reply_stays_on_the_model_that_served_it()
-> Result {
    let note = FakeTool::new("note", spade_core::tools::Risk::Read, "noted");
    let spade = Spade::start(
        vec![
            Script::failing(429),
            Script::reply("").call("c1", "note", json!({})),
            Script::reply("Done."),
            title(),
            Script::reply("Back on the first."),
        ],
        vec![std::sync::Arc::new(note)],
    )
    .await?;
    with_backup(&spade).await?;
    let chat = bot_on(&spade, "fake/m").await?;
    spade.say(&chat, "Hi").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    // The 429 moved the first step on; its second step stayed there, warm.
    assert_eq!(steps_asked(&spade), ["m", "b", "b"]);
    let served = served(&events);
    assert_eq!(served.len(), 2, "{events:?}");
    assert_eq!(
        served[0]["skipped"],
        json!([{ "model": "fake/m", "reason": "rate_limited" }])
    );
    assert_eq!(served[0]["line"], "Ran on B: M was rate limited.");
    assert_eq!(served[1]["model"], "backup/b");
    assert_eq!(served[1]["line"], "Ran on B, like the step before.");
    // The next reply reads the route from its start.
    spade.wait_for(&chat, "renamed").await?;
    spade.say(&chat, "Again").await?;
    spade.wait_for_count(&chat, "reply_finished", 2).await?;
    assert_eq!(steps_asked(&spade), ["m", "b", "b", "m"]);
    Ok(())
}

#[tokio::test]
async fn a_server_error_moves_on_only_once_its_tries_with_backoff_are_used_up() -> Result {
    let spade = Spade::start_with(
        vec![
            Script::failing(503),
            Script::failing(503),
            Script::failing(503),
            Script::reply("From the backup."),
            title(),
        ],
        Vec::new(),
        quick_retries(),
    )
    .await?;
    with_backup(&spade).await?;
    let chat = bot_on(&spade, "fake/m").await?;
    spade.say(&chat, "Hi").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    assert_eq!(steps_asked(&spade), ["m", "m", "m", "b"]);
    assert_eq!(
        served(&events)[0]["skipped"],
        json!([{ "model": "fake/m", "reason": "server_error" }])
    );
    Ok(())
}

#[tokio::test]
async fn a_slow_answer_stays_on_its_model() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("Slowly, but here.").held(Duration::from_millis(1_500)),
            title(),
        ],
        Vec::new(),
    )
    .await?;
    with_backup(&spade).await?;
    let chat = bot_on(&spade, "fake/m").await?;
    spade.say(&chat, "Hi").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    assert_eq!(steps_asked(&spade), ["m"]);
    let served = served(&events);
    assert_eq!(served[0]["model"], "fake/m");
    assert_eq!(served[0]["skipped"], Value::Null, "nothing was passed over");
    assert_eq!(
        served[0]["line"],
        Value::Null,
        "it ran on the route's first model"
    );
    Ok(())
}

#[tokio::test]
async fn a_bad_answer_never_falls_back() -> Result {
    // An answer with nothing in it: the endpoint answered, so it is the model's.
    let spade = Spade::start(vec![Script::reply(""), title()], Vec::new()).await?;
    with_backup(&spade).await?;
    let chat = bot_on(&spade, "fake/m").await?;
    spade.say(&chat, "Hi").await?;
    let events = spade
        .wait_for_any(&chat, &["reply_finished", "reply_failed"])
        .await?;
    assert_eq!(steps_asked(&spade), ["m"], "the backup was never asked");
    assert!(
        served(&events)
            .iter()
            .all(|s| s["model"] == "fake/m" && s["skipped"].is_null()),
        "{events:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_refusal_never_falls_back() -> Result {
    let spade = Spade::start(vec![Script::failing(400)], Vec::new()).await?;
    with_backup(&spade).await?;
    let chat = bot_on(&spade, "fake/m").await?;
    spade.say(&chat, "Hi").await?;
    let events = spade.wait_for(&chat, "reply_failed").await?;
    assert_eq!(steps_asked(&spade), ["m"], "the backup was never asked");
    assert!(served(&events).is_empty(), "no step ran: {events:?}");
    Ok(())
}

#[tokio::test]
async fn a_route_never_gains_a_subscription() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    with_backup(&spade).await?;
    for refused in [
        json!({ "roles": { "main": ["backup/b", "cli:codex/gpt-6.1-sol"] } }),
        json!({ "roles": { "helper": ["cli:claude/opus-5.5"] } }),
        json!({ "roles": { "main": ["fake/m", "backup/b", "fake/m", "backup/b", "fake/m"] } }),
    ] {
        let (status, body) = spade.put("/v1/models/roles", refused.clone()).await?;
        assert_eq!(status, 400, "{refused} gave {body}");
    }
    let (_, roles) = spade.get("/v1/models/roles").await?;
    assert_eq!(roles["routes"]["main"], json!(["backup/b"]), "{roles}");
    // A bot on a subscription runs on it alone, whatever the routes say.
    spade
        .put("/v1/subscriptions/codex/terms", json!({ "use": true }))
        .await?;
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Notes", "task": "", "model": "cli:codex/gpt-6.1-sol" }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let id = body["agent"]["id"].as_str().unwrap_or_default();
    let (_, view) = spade.get(&format!("/v1/agents/{id}/models")).await?;
    let main = view["roles"]
        .as_array()
        .and_then(|roles| roles.iter().find(|r| r["role"] == "main"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(main["route"], json!(["cli:codex/gpt-6.1-sol"]), "{view}");
    // A model route of an endpoint bot never lists one either.
    let chat_bot = bot_on(&spade, "fake/m").await?;
    let (_, agents) = spade.get("/v1/agents").await?;
    let endpoint_bot = agents["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["conversation"] == chat_bot.as_str()))
        .and_then(|a| a["id"].as_str())
        .unwrap_or_default()
        .to_owned();
    let (_, view) = spade
        .get(&format!("/v1/agents/{endpoint_bot}/models"))
        .await?;
    for role in view["roles"].as_array().cloned().unwrap_or_default() {
        for model in role["route"].as_array().cloned().unwrap_or_default() {
            assert!(
                !model.as_str().unwrap_or_default().starts_with("cli:"),
                "{role}"
            );
        }
    }
    Ok(())
}
