//! Keeping a finished run as a test (ADR 0204 §1), through the real engine and API on a scripted
//! fake endpoint and a real SQLite file: what is written holds no secret and none of the
//! person's own addresses or names, reads back exactly, and goes when deleted.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, Result, Spade};

const SECRETS: [&str; 4] = [
    "sk-live-4f9a8b7c6d5e4f3a2b1c",
    "ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z",
    "hunter2-very-private",
    "AKIAIOSFODNN7EXAMPLE",
];

/// Every case body as stored, read straight from the database file.
fn stored_bodies(spade: &Spade) -> Result<Vec<String>> {
    let connection = rusqlite::Connection::open(spade.database())?;
    let mut statement = connection.prepare("SELECT body FROM cases")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[tokio::test]
async fn a_kept_run_stores_no_secret_reads_back_exactly_and_goes_when_deleted() -> Result {
    let lookup = FakeTool::new(
        "lookup",
        Risk::Read,
        &format!(
            "Order ORD-55821 for Dana Reyes <dana.reyes@example.org>, token={} aws {}",
            SECRETS[1], SECRETS[3]
        ),
    );
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "c1",
                "lookup",
                json!({ "order": "ORD-55821", "api_key": SECRETS[0] }),
            ),
            Script::reply("Dana, order ORD-55821 ships Friday."),
            Script::reply("").plain(r#"{"title":"Orders"}"#),
        ],
        vec![Arc::new(lookup) as Arc<dyn Tool>],
    )
    .await?;
    let (status, _) = spade
        .post(
            "/v1/notes",
            json!({ "text": "My name is Dana Reyes; signs in as dana.reyes@example.org" }),
        )
        .await?;
    assert_eq!(status, 201);
    let agent = spade.new_agent("Orders", "Track my orders").await?;
    let (bot, chat) = (
        agent["id"].as_str().unwrap_or_default().to_owned(),
        agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    );
    spade
        .say(
            &chat,
            &format!(
                "Where is ORD-55821? Use key {} and password: {}",
                SECRETS[0], SECRETS[2]
            ),
        )
        .await?;
    let events = spade.wait_for(&chat, "renamed").await?;
    let reply = events
        .iter()
        .find(|e| e["type"] == "reply_finished")
        .and_then(|e| e["reply"].as_str())
        .unwrap_or_default()
        .to_owned();
    let cases = format!("/v1/agents/{bot}/cases");

    // The review shows what would be written, already hidden; nothing is kept yet.
    let (status, preview) = spade
        .post(&format!("{cases}/preview"), json!({ "reply": reply }))
        .await?;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["case"]["tool_results"][0]["tool"], "lookup");
    assert!(stored_bodies(&spade)?.is_empty());

    let (status, kept) = spade
        .post(
            &cases,
            json!({ "reply": reply, "mark": "wrong", "why": "Dana wanted the date", "hide": ["ORD-55821"] }),
        )
        .await?;
    assert_eq!(status, 201, "{kept}");
    let bodies = stored_bodies(&spade)?;
    assert_eq!(bodies.len(), 1);
    for secret in
        SECRETS
            .iter()
            .copied()
            .chain(["dana.reyes@example.org", "Dana", "Reyes", "ORD-55821"])
    {
        assert!(
            !bodies[0].contains(secret),
            "{secret} was kept: {}",
            bodies[0]
        );
    }
    let case: Value = serde_json::from_str(&bodies[0])?;
    assert_eq!(case["given"]["messages"].as_array().map(Vec::len), Some(1));
    assert_eq!(case["steps"].as_array().map(Vec::len), Some(2));
    assert_eq!(case["mark"], "wrong");
    assert_eq!(case["why"], "Person wanted the date");
    // The run itself stays in the conversation as it was.
    let after = spade.events(&chat).await?;
    assert!(after.iter().any(|e| e.to_string().contains(SECRETS[1])));

    let id = kept["summary"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (_, listed) = spade.get(&cases).await?;
    assert_eq!(listed["cases"], json!([kept["summary"]]));
    let (status, read) = spade.get(&format!("{cases}/{id}")).await?;
    assert_eq!(status, 200);
    assert_eq!(read, kept, "it reads back exactly");
    assert_eq!(read["case"], case);

    // Kept again, the reply keeps its first case.
    let (status, again) = spade.post(&cases, json!({ "reply": reply })).await?;
    assert_eq!((status, &again["summary"]["id"]), (200, &json!(id)));

    let (status, _) = spade.delete(&format!("{cases}/{id}")).await?;
    assert_eq!(status, 204);
    let (status, _) = spade.get(&format!("{cases}/{id}")).await?;
    assert_eq!(status, 404);
    assert!(stored_bodies(&spade)?.is_empty());
    Ok(())
}

#[tokio::test]
async fn only_a_finished_reply_of_the_bot_can_be_kept() -> Result {
    let spade = Spade::start(vec![Script::reply("Hi.")], Vec::new()).await?;
    let agent = spade.new_agent("Orders", "").await?;
    let bot = agent["id"].as_str().unwrap_or_default();
    let cases = format!("/v1/agents/{bot}/cases");
    let (status, _) = spade.post(&cases, json!({ "reply": "r_nothing" })).await?;
    assert_eq!(status, 404);
    let (status, _) = spade
        .post("/v1/agents/a_nobody/cases", json!({ "reply": "r_1" }))
        .await?;
    assert_eq!(status, 404);
    let (status, _) = spade
        .post(&cases, json!({ "reply": "r_1", "mark": "maybe" }))
        .await?;
    assert_eq!(status, 400);
    Ok(())
}
