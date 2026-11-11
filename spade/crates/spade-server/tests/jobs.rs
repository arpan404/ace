//! Background tools through the real API: a long call answers at once, its result comes back as a
//! `<job_result>` that starts or steers a turn, Stop cancels it, and a restart reports it lost.

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, Result, Spade, types};

fn research(delay: Duration) -> FakeTool {
    FakeTool::new("research", Risk::Read, "Three good options")
        .background()
        .slow(delay)
}

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Research"}"#)
}

#[tokio::test]
async fn a_background_result_starts_a_new_turn_when_it_arrives() -> Result {
    let tool = research(Duration::from_millis(600));
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "research", json!({ "topic": "flights" })),
            Script::reply("I started the research."),
            title(),
            Script::reply("The research found three good options."),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Research flights").await?;
    spade.wait_for(&id, "reply_finished").await?;

    // The first turn is over but the job still runs, and the list says so.
    let (_, list) = spade.get("/v1/conversations").await?;
    assert_eq!(list[0]["answering"], false);
    assert_eq!(list[0]["jobs"], 1);

    let events = spade.wait_for_count(&id, "reply_finished", 2).await?;
    let order: Vec<String> = types(&events)
        .into_iter()
        .filter(|t| t.starts_with("job_") || t.starts_with("reply_s") || t == "reply_finished")
        .collect();
    assert_eq!(
        order,
        vec![
            "reply_started",
            "job_started",
            "reply_finished",
            "job_finished",
            "reply_started",
            "reply_finished"
        ]
    );
    let seen = spade.fake.seen();
    let second = seen[1].body["messages"].to_string();
    assert!(second.contains("in the background as job c1"), "{second}");
    let last = seen
        .last()
        .map(|s| s.body["messages"].to_string())
        .unwrap_or_default();
    assert!(
        last.contains("<job_result job=\\\"c1\\\" tool=\\\"research\\\" status=\\\"ok\\\">\\nThree good options"),
        "{last}"
    );
    let (_, list) = spade.get("/v1/conversations").await?;
    assert_eq!(list[0]["jobs"], 0);
    Ok(())
}

#[tokio::test]
async fn a_background_result_arriving_mid_reply_steers_that_reply() -> Result {
    let tool = research(Duration::from_millis(100));
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "research", json!({})),
            // Still streaming when the job ends.
            Script::reply(&"waiting ".repeat(20))
                .chunks(20)
                .delay(Duration::from_millis(30)),
            Script::reply("Here are the three options."),
            title(),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Research flights").await?;
    let events = spade.wait_for(&id, "renamed").await?;
    assert_eq!(
        types(&events)
            .iter()
            .filter(|t| *t == "reply_started")
            .count(),
        1,
        "the job result joins the open reply: {:?}",
        types(&events)
    );
    let finished = events.iter().find(|e| e["type"] == "reply_finished");
    assert_eq!(
        finished.map(|e| e["text"].clone()),
        Some(json!("Here are the three options."))
    );
    Ok(())
}

#[tokio::test]
async fn stop_cancels_a_background_job_without_starting_a_turn() -> Result {
    let tool = research(Duration::from_secs(5));
    let ran = tool.calls();
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "research", json!({})),
            Script::reply("Started."),
            title(),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Research flights").await?;
    spade.wait_for(&id, "renamed").await?;
    let (status, _) = spade
        .post(&format!("/v1/conversations/{id}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202);
    let events = spade.wait_for(&id, "job_finished").await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let after = spade.events(&id).await?;
    assert_eq!(
        after.len(),
        events.len(),
        "no turn starts: {:?}",
        types(&after)
    );
    let job = after.iter().find(|e| e["type"] == "job_finished");
    assert_eq!(job.map(|e| e["is_error"].clone()), Some(json!(true)));
    assert!(
        ran.lock().map(|r| r.is_empty()).unwrap_or(false),
        "the job never completed"
    );
    Ok(())
}

#[tokio::test]
async fn a_job_lost_to_a_restart_is_reported_as_unknown_and_the_model_hears_it() -> Result {
    let tool = research(Duration::from_secs(30));
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "research", json!({})),
            Script::reply("Started."),
            title(),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Research flights").await?;
    spade.wait_for(&id, "renamed").await?;

    let spade = spade
        .restart(
            vec![Arc::new(research(Duration::ZERO)) as Arc<dyn Tool>],
            vec![Script::reply(
                "The research was cut off; shall I run it again?",
            )],
        )
        .await?;
    let events = spade.wait_for_count(&id, "reply_finished", 2).await?;
    let job = events.iter().find(|e| e["type"] == "job_finished");
    assert_eq!(job.map(|e| e["is_error"].clone()), Some(json!(true)));
    let content = job.and_then(|e| e["content"].as_str()).unwrap_or("");
    assert!(content.starts_with("Unknown outcome"), "{content}");
    let told = spade.fake.seen()[0].body["messages"].to_string();
    assert!(told.contains("status=\\\"error\\\""), "{told}");
    Ok(())
}

#[tokio::test]
async fn a_job_the_person_stopped_stays_stopped_after_a_restart() -> Result {
    let tool = research(Duration::from_secs(30));
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "research", json!({})),
            Script::reply("Started."),
            title(),
        ],
        vec![Arc::new(tool) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Research flights").await?;
    spade.wait_for(&id, "renamed").await?;
    let (status, _) = spade
        .post(&format!("/v1/conversations/{id}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202);
    // The stop is stored before Stop answers.
    let stored = spade.events(&id).await?;
    assert!(
        types(&stored).contains(&"job_finished".to_owned()),
        "{:?}",
        types(&stored)
    );

    let spade = spade
        .restart(
            vec![Arc::new(research(Duration::ZERO)) as Arc<dyn Tool>],
            vec![Script::reply("This must not be asked for.")],
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let events = spade.events(&id).await?;
    assert_eq!(events.len(), stored.len(), "{:?}", types(&events));
    assert!(
        spade.fake.seen().is_empty(),
        "no reply opens for a stopped job"
    );
    Ok(())
}
