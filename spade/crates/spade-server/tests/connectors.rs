//! Connectors through Spade's API and engine (ADR 0131), against a fake app and OAuth server on
//! 127.0.0.1: the sign-in comes back to Spade's own callback, no answer or database row carries a
//! token, and a bot finds and runs only the connector tools the person allowed it.

mod support;

use serde_json::{Value, json};
use spade_testkit::connector::tool;
use spade_testkit::{FakeConnector, Script};
use support::{Options, Result, Spade};

async fn with_connectors(scripts: Vec<Script>) -> Result<Spade> {
    Spade::start_with(
        scripts,
        Vec::new(),
        Options {
            connectors: true,
            ..Options::default()
        },
    )
    .await
}

fn app_tools() -> Vec<rmcp::model::Tool> {
    vec![
        tool("echo", Some(true), None),
        tool("create_issue", None, None),
    ]
}

async fn wait_connected(spade: &Spade, id: &str) -> Result<Value> {
    for _ in 0..250 {
        let (_, body) = spade.get(&format!("/v1/connectors/{id}")).await?;
        if body["connector"]["state"] == "connected" && body["connector"]["tools"] != 0 {
            return Ok(body["connector"].clone());
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Err(format!("{id} never connected").into())
}

async fn main_conversation(spade: &Spade) -> Result<String> {
    let (_, body) = spade.get("/v1/agents").await?;
    let main = body["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["kind"] == "main"))
        .ok_or("no main agent")?;
    Ok(main["conversation"].as_str().unwrap_or_default().to_owned())
}

#[tokio::test]
async fn signing_in_ends_at_spades_callback_and_no_answer_or_row_carries_a_token() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = with_connectors(Vec::new()).await?;
    let mut answers = Vec::new();

    let (status, listed) = spade.get("/v1/connectors").await?;
    assert_eq!(status, 200);
    assert!(
        listed["catalogue"]
            .as_array()
            .is_some_and(|c| c.iter().any(|e| e["id"] == "linear"))
    );

    let (status, started) = spade
        .post(
            "/v1/connectors",
            json!({ "url": app.url(), "name": "Fake" }),
        )
        .await?;
    assert_eq!(status, 202, "{started}");
    let id = started["id"].as_str().unwrap_or_default().to_owned();
    let back = app
        .approve(started["sign_in_url"].as_str().unwrap_or_default())
        .await;
    assert!(
        back.starts_with(&format!("{}/v1/connectors/callback?", spade.base)),
        "{back}"
    );

    // A forged callback is refused and spends nothing.
    let forged = back.replace("state=", "state=x");
    let page = reqwest::get(&forged).await?;
    assert_eq!(page.status().as_u16(), 400);
    assert_eq!(app.token_requests(), 0);

    // The browser follows the redirect, without Spade's token.
    let page = reqwest::get(&back).await?;
    assert_eq!(page.status().as_u16(), 200);
    assert_eq!(page.headers()["cache-control"], "no-store");
    let html = page.text().await?;
    assert!(html.contains("Connected to Fake"), "{html}");

    let view = wait_connected(&spade, &id).await?;
    assert_eq!(view["account"], "person@example.com");
    answers.push(view.to_string());
    answers.push(spade.get("/v1/connectors").await?.1.to_string());
    answers.push(html);

    let database = std::fs::read(spade.database())?;
    let wal = std::fs::read(spade.database().with_extension("sqlite-wal")).unwrap_or_default();
    for token in app.issued_tokens() {
        let bytes = token.as_bytes();
        assert!(
            answers.iter().all(|a| !a.contains(&token)),
            "{token} in an answer"
        );
        assert!(
            !database.windows(bytes.len()).any(|w| w == bytes),
            "{token} in the database"
        );
        assert!(
            !wal.windows(bytes.len()).any(|w| w == bytes),
            "{token} in the database log"
        );
    }

    let (status, _) = spade.delete(&format!("/v1/connectors/{id}")).await?;
    assert_eq!(status, 204);
    assert_eq!(spade.keys.connector_secret(&id, "access")?, None);
    let (status, _) = spade.get(&format!("/v1/connectors/{id}")).await?;
    assert_eq!(status, 404);
    Ok(())
}

fn result<'a>(events: &'a [Value], call: &str) -> Result<&'a str> {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        .and_then(|e| e["content"].as_str())
        .ok_or_else(|| format!("no result for {call}").into())
}

#[tokio::test]
async fn a_bot_finds_and_runs_only_the_connectors_it_is_allowed() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    app.accept_token("api-key-1");
    let echo = |call: &str, say: &str| {
        Script::reply("").call(
            call,
            "call_tool",
            json!({ "name": "127-0-0-1__echo", "arguments": { "say": say } }),
        )
    };
    let spade = with_connectors(vec![
        // Spade, which may use every connector by default.
        Script::reply("").call("c1", "tool_search", json!({ "query": "Fake echo" })),
        echo("c2", "from spade"),
        Script::reply("Done."),
        Script::reply("").plain(r#"{"title":"Echo"}"#),
        // A new bot, which may use none until the person allows one.
        Script::reply("").call("c3", "tool_search", json!({ "query": "Fake echo" })),
        echo("c4", "from the bot"),
        Script::reply("Could not."),
        Script::reply("").plain(r#"{"title":"Echo"}"#),
        // Allowed now; a write still asks.
        echo("c5", "allowed now"),
        Script::reply("").call(
            "c6",
            "call_tool",
            json!({ "name": "127-0-0-1__create_issue", "arguments": {} }),
        ),
    ])
    .await?;
    let (status, body) = spade
        .post(
            "/v1/connectors",
            json!({ "url": app.url(), "name": "Fake", "token": "api-key-1" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["connector"]["state"], "connected");
    assert!(!body.to_string().contains("api-key-1"));
    // Named after its host when added by URL.
    assert_eq!(body["connector"]["id"], "127-0-0-1");

    let main = main_conversation(&spade).await?;
    spade.say(&main, "Echo something").await?;
    let events = spade.wait_for(&main, "reply_finished").await?;
    assert!(result(&events, "c1")?.contains("127-0-0-1__echo: Fake: echo in the fake app"));
    assert_eq!(result(&events, "c2")?, "from spade");

    let bot = spade.new_agent("Helper", "").await?;
    let (bot_id, conversation) = (
        bot["id"].as_str().unwrap_or_default().to_owned(),
        bot["conversation"].as_str().unwrap_or_default().to_owned(),
    );
    let (_, allowed) = spade
        .get(&format!("/v1/agents/{bot_id}/connectors"))
        .await?;
    assert_eq!(allowed, json!({ "all": false, "connectors": [] }));
    spade.say(&conversation, "Echo something").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert!(result(&events, "c3")?.starts_with("No tools matched"));
    assert!(result(&events, "c4")?.contains("no tool named 127-0-0-1__echo"));
    let runs = app.tool_runs();

    let (status, allowed) = spade
        .put(
            &format!("/v1/agents/{bot_id}/connectors"),
            json!({ "connectors": ["127-0-0-1"] }),
        )
        .await?;
    assert_eq!(status, 200, "{allowed}");
    spade.say(&conversation, "Try again").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    assert_eq!(result(&events, "c5")?, "allowed now");
    assert_eq!(
        app.tool_runs(),
        runs + 1,
        "the write ran before it was approved"
    );

    let (status, _) = spade
        .put(
            &format!("/v1/agents/{bot_id}/connectors"),
            json!({ "connectors": ["nope"] }),
        )
        .await?;
    assert_eq!(status, 400);
    let (_, everything) = spade
        .get(&format!(
            "/v1/agents/{}/connectors",
            main_agent(&spade).await?
        ))
        .await?;
    assert_eq!(everything["all"], true);
    Ok(())
}

async fn main_agent(spade: &Spade) -> Result<String> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["kind"] == "main"))
        .and_then(|a| a["id"].as_str())
        .unwrap_or_default()
        .to_owned())
}
