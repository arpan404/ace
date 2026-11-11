//! Writes that fail and then succeed: the engine keeps what it could not store and stores it once
//! storage recovers, instead of dropping it. The test database refuses chosen event types through
//! a trigger, from a second connection.

mod support;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::json;
use spade_core::tools::Risk;
use spade_core::tools::ToolDef;
use spade_models::ToolSpec;
use spade_server::tools::{Tool, ToolFuture, ToolOutput};
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
    let search = FakeTool::new("web_search", Risk::Read, "Sunny");
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "web_search", json!({ "q": "weather" })),
            Script::reply("It is sunny."),
        ],
        vec![Arc::new(search) as Arc<dyn Tool>],
    )
    .await?;
    // Refused from the start, so the result can never be stored before the refusal is in place.
    refuse(&spade.database(), "tool_finished")?;
    let id = spade.ask("Weather?").await?;
    spade.wait_for(&id, "tool_started").await?;
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

/// A read tool that runs until cancelled, and says when it was.
struct Endless {
    cancelled: Arc<AtomicBool>,
}

/// Marks the call cancelled if it is dropped before it finishes.
struct Cancelled(Arc<AtomicBool>);

impl Drop for Cancelled {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl Tool for Endless {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "watch_page".to_owned(),
                description: "watch_page tool".to_owned(),
                schema: json!({ "type": "object" }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, _call_id: &str, _arguments: serde_json::Value) -> ToolFuture {
        let guard = Cancelled(self.cancelled.clone());
        Box::pin(async move {
            let _guard = guard;
            std::future::pending::<ToolOutput>().await
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_cancels_a_call_in_flight_while_a_siblings_result_cannot_be_stored() -> Result {
    let cancelled = Arc::new(AtomicBool::new(false));
    let endless = Endless {
        cancelled: cancelled.clone(),
    };
    let search = FakeTool::new("web_search", Risk::Read, "Sunny");
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "watch_page", json!({})).call(
                "c2",
                "web_search",
                json!({ "q": "weather" }),
            ),
            Script::reply("").plain(r#"{"title":"Weather"}"#),
        ],
        vec![Arc::new(endless) as Arc<dyn Tool>, Arc::new(search)],
    )
    .await?;
    refuse(&spade.database(), "tool_finished")?;
    let id = spade.ask("Weather?").await?;
    spade.wait_for_count(&id, "tool_started", 2).await?;
    // web_search has answered and its result is being retried.
    tokio::time::sleep(Duration::from_millis(300)).await;
    spade
        .post(&format!("/v1/conversations/{id}/stop"), json!({}))
        .await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !cancelled.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        cancelled.load(Ordering::SeqCst),
        "watch_page kept running while storage refused web_search's result"
    );

    allow(&spade.database(), "tool_finished")?;
    let events = spade.wait_for(&id, "reply_stopped").await?;
    let results: Vec<_> = events
        .iter()
        .filter(|e| e["type"] == "tool_finished")
        .map(|e| (e["call_id"].clone(), e["content"].clone()))
        .collect();
    assert!(
        results.contains(&(json!("c2"), json!("Sunny"))),
        "the result that came back is kept: {results:?}"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_reply_still_closes_when_reading_the_conversation_fails_for_a_while() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply(&"word ".repeat(40))
                .chunks(40)
                .delay(Duration::from_millis(40)),
            Script::reply("").plain(r#"{"title":"Talk"}"#),
        ],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Talk").await?;
    spade.wait_for(&id, "reply_progress").await?;
    // Every read and write of events fails until the table is back.
    let database = spade.database();
    let hide = rusqlite::Connection::open(&database)?;
    hide.execute_batch("ALTER TABLE events RENAME TO events_away;")?;
    let _ = spade
        .post(&format!("/v1/conversations/{id}/stop"), json!({}))
        .await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    hide.execute_batch("ALTER TABLE events_away RENAME TO events;")?;

    let events = spade.wait_for(&id, "reply_stopped").await?;
    assert_eq!(count(&events, "reply_stopped"), 1);
    Ok(())
}
