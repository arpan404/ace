//! Writes that fail and then succeed: the engine keeps what it could not store and stores it once
//! storage recovers, instead of dropping it. The test database refuses chosen event types through
//! a trigger, from a second connection.

mod support;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, Result, Spade};

/// Makes the database refuse every event of type `kind` until [`allow`].
fn refuse(database: &Path, kind: &str) -> Result {
    let connection = rusqlite::Connection::open(database)?;
    connection.execute_batch(&format!(
        "CREATE TRIGGER refuse_{kind} BEFORE INSERT ON events \
         WHEN json_extract(NEW.body, '$.type') = '{kind}' \
         BEGIN SELECT RAISE(ABORT, 'refused for a test'); END;"
    ))?;
    Ok(())
}

fn allow(database: &Path, kind: &str) -> Result {
    let connection = rusqlite::Connection::open(database)?;
    connection.execute_batch(&format!("DROP TRIGGER refuse_{kind};"))?;
    Ok(())
}

fn count(events: &[serde_json::Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

// Several threads, so a worker that never yields shows as a timeout rather than a hang.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_result_that_fails_to_store_is_kept_and_stored_once_storage_recovers() -> Result {
    let search = FakeTool::new("web_search", Risk::Read, "Sunny").slow(Duration::from_millis(300));
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "web_search", json!({ "q": "weather" })),
            Script::reply("It is sunny."),
        ],
        vec![Arc::new(search) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Weather?").await?;
    spade.wait_for(&id, "tool_started").await?;
    refuse(&spade.database(), "tool_finished")?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    let meanwhile = spade.events(&id).await?;
    assert_eq!(
        count(&meanwhile, "tool_finished"),
        0,
        "the write was refused"
    );
    assert_eq!(
        count(&meanwhile, "step_finished"),
        1,
        "the turn waits for the result"
    );
    allow(&spade.database(), "tool_finished")?;

    let events = spade.wait_for(&id, "reply_finished").await?;
    let results: Vec<_> = events
        .iter()
        .filter(|e| e["type"] == "tool_finished")
        .map(|e| e["content"].clone())
        .collect();
    assert_eq!(results, vec![json!("Sunny")]);
    let second = spade.fake.seen().get(1).map(|s| s.body.to_string());
    assert!(
        second.as_deref().is_some_and(|b| b.contains("Sunny")),
        "{second:?}"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_reply_whose_close_fails_closes_once_storage_recovers_and_the_next_message_is_answered()
-> Result {
    let spade = Spade::start(
        vec![
            Script::reply(&"word ".repeat(40))
                .chunks(40)
                .delay(Duration::from_millis(40)),
            Script::reply("").plain(r#"{"title":"Talk"}"#),
            Script::reply("Second answer."),
        ],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Talk").await?;
    spade.wait_for(&id, "reply_progress").await?;
    refuse(&spade.database(), "reply_stopped")?;
    spade
        .post(&format!("/v1/conversations/{id}/stop"), json!({}))
        .await?;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        count(&spade.events(&id).await?, "reply_stopped"),
        0,
        "the close was refused"
    );
    allow(&spade.database(), "reply_stopped")?;

    spade.wait_for(&id, "reply_stopped").await?;
    spade.wait_for(&id, "renamed").await?;
    spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Again" }),
        )
        .await?;
    let events = spade.wait_for(&id, "reply_finished").await?;
    let finished = events.iter().find(|e| e["type"] == "reply_finished");
    assert_eq!(
        finished.map(|e| e["text"].clone()),
        Some(json!("Second answer."))
    );
    Ok(())
}
