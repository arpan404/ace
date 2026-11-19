//! Closing for an update or a stop, through the real API: messages sent while closed are stored
//! and answered once turns can start, open turns pause rather than break, and a restarted Spade
//! finishes them from their events.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, Result, Spade, types};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Trip"}"#)
}

/// A reply that streams for about two seconds.
fn slow_reply(text: &str) -> Script {
    Script::reply(text)
        .chunks(20)
        .delay(Duration::from_millis(100))
}

async fn wait_until(spade: &Spade, test: impl Fn(&Value) -> bool) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (_, state) = spade.get("/v1/maintenance").await?;
        if test(&state) {
            return Ok(state);
        }
        if Instant::now() > deadline {
            return Err(format!("maintenance never got there: {state}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn last_text(events: &[Value], kind: &str) -> String {
    events
        .iter()
        .rev()
        .find(|e| e["type"] == kind)
        .and_then(|e| e["text"].as_str())
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn a_message_sent_while_closed_is_stored_and_answered_once_admission_reopens() -> Result {
    let spade = Spade::start(vec![Script::reply("Hello again."), title()], Vec::new()).await?;
    let (status, state) = spade
        .post("/v1/maintenance", json!({ "mode": "idle" }))
        .await?;
    assert_eq!(status, 202);
    assert_eq!(state["admission"], "closed");

    let id = spade.ask("Are you there?").await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(types(&spade.events(&id).await?), vec!["user_message"]);
    assert!(spade.fake.seen().is_empty(), "no model call while closed");

    let (status, state) = spade.delete("/v1/maintenance").await?;
    assert_eq!(status, 200);
    assert_eq!(state["admission"], "open");
    let events = spade.wait_for(&id, "reply_finished").await?;
    assert_eq!(last_text(&events, "reply_finished"), "Hello again.");
    Ok(())
}

#[tokio::test]
async fn now_pauses_a_streaming_reply_and_a_restarted_spade_finishes_it() -> Result {
    let spade = Spade::start(vec![slow_reply("A long answer about trains.")], Vec::new()).await?;
    let id = spade.ask("Tell me about trains").await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The updater allows the running step 100 ms; it is cut and asked for again later.
    spade
        .post(
            "/v1/maintenance",
            json!({ "mode": "now", "deadline_ms": 100 }),
        )
        .await?;
    spade.wait_for(&id, "turn_paused").await?;
    wait_until(&spade, |s| s["running_turns"] == 0).await?;
    let (_, list) = spade.get("/v1/conversations").await?;
    assert_eq!(
        list[0]["answering"], true,
        "a paused reply is still working"
    );

    let spade = spade
        .restart(
            Vec::new(),
            vec![Script::reply("Trains are great."), title()],
        )
        .await?;
    let events = spade.wait_for(&id, "reply_finished").await?;
    let kinds = types(&events);
    assert!(
        !kinds.contains(&"reply_interrupted".to_owned()),
        "{kinds:?}"
    );
    assert_eq!(
        kinds.iter().filter(|k| *k == "reply_started").count(),
        1,
        "the same reply carried on"
    );
    assert_eq!(last_text(&events, "reply_finished"), "Trains are great.");
    Ok(())
}

#[tokio::test]
async fn a_running_model_step_finishes_before_the_turn_pauses() -> Result {
    let lookup = FakeTool::new("lookup", Risk::Read, "Two trains a day");
    let ran = lookup.calls();
    let spade = Spade::start(
        vec![slow_reply("Let me check.").call("c1", "lookup", json!({ "route": "A-B" }))],
        vec![Arc::new(lookup) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Trains from A to B?").await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    spade
        .post("/v1/maintenance", json!({ "mode": "now" }))
        .await?;
    let events = spade.wait_for(&id, "turn_paused").await?;
    let kinds = types(&events);
    let step = kinds.iter().position(|k| k == "step_finished");
    let paused = kinds.iter().position(|k| k == "turn_paused");
    assert!(step.is_some() && step < paused, "{kinds:?}");
    assert!(!kinds.contains(&"tool_started".to_owned()), "{kinds:?}");
    assert!(ran.lock().map(|c| c.is_empty()).unwrap_or(false));

    let lookup = FakeTool::new("lookup", Risk::Read, "Two trains a day");
    let ran = lookup.calls();
    let spade = spade
        .restart(
            vec![Arc::new(lookup) as Arc<dyn Tool>],
            vec![Script::reply("Two a day."), title()],
        )
        .await?;
    let events = spade.wait_for(&id, "reply_finished").await?;
    assert_eq!(last_text(&events, "reply_finished"), "Two a day.");
    assert_eq!(ran.lock().map(|c| c.len()).unwrap_or(0), 1);
    Ok(())
}

#[tokio::test]
async fn idle_waits_for_a_background_job_and_its_result_waits_for_reopening() -> Result {
    let research = FakeTool::new("research", Risk::Read, "Three good options")
        .background()
        .slow(Duration::from_millis(700));
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "research", json!({ "topic": "flights" })),
            Script::reply("I started the research."),
            title(),
            Script::reply("The research found three options."),
        ],
        vec![Arc::new(research) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Research flights").await?;
    spade.wait_for(&id, "reply_finished").await?;

    let (_, state) = spade
        .post("/v1/maintenance", json!({ "mode": "idle" }))
        .await?;
    assert_eq!(state["running_jobs"], 1);
    let state = wait_until(&spade, |s| s["running_jobs"] == 0).await?;
    assert_eq!(state["running_turns"], 0);
    assert_eq!(state["admission"], "closed");
    // The job's result is stored but opens no reply while closed.
    let events = spade.wait_for(&id, "job_finished").await?;
    assert_eq!(
        types(&events)
            .iter()
            .filter(|k| *k == "reply_started")
            .count(),
        1
    );

    spade.delete("/v1/maintenance").await?;
    let events = spade.wait_for_count(&id, "reply_finished", 2).await?;
    assert_eq!(
        last_text(&events, "reply_finished"),
        "The research found three options."
    );
    Ok(())
}

#[tokio::test]
async fn a_stop_pauses_a_running_tool_as_maybe_run_and_the_restart_carries_on() -> Result {
    let book = FakeTool::new("check_status", Risk::Read, "Confirmed").slow(Duration::from_secs(5));
    let spade = Spade::start(
        vec![Script::reply("").call("c1", "check_status", json!({}))],
        vec![Arc::new(book) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Is my booking confirmed?").await?;
    spade.wait_for(&id, "tool_started").await?;

    let spade = spade
        .restart_after_stop(
            Duration::from_millis(200),
            Vec::new(),
            vec![Script::reply("I could not tell; please check."), title()],
        )
        .await?;
    let events = spade.wait_for(&id, "reply_finished").await?;
    let kinds = types(&events);
    assert!(
        !kinds.contains(&"reply_interrupted".to_owned()),
        "{kinds:?}"
    );
    let cut = events
        .iter()
        .find(|e| e["type"] == "tool_finished")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default();
    assert!(cut.starts_with("Unknown outcome"), "{cut}");
    assert!(
        kinds.iter().position(|k| k == "tool_finished")
            < kinds.iter().position(|k| k == "turn_paused")
    );
    Ok(())
}

#[tokio::test]
async fn stopping_a_paused_reply_closes_it_as_stopped() -> Result {
    let spade = Spade::start(vec![slow_reply("A long answer.")], Vec::new()).await?;
    let id = spade.ask("Tell me a story").await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    spade
        .post(
            "/v1/maintenance",
            json!({ "mode": "now", "deadline_ms": 50 }),
        )
        .await?;
    spade.wait_for(&id, "turn_paused").await?;
    let (status, _) = spade
        .post(&format!("/v1/conversations/{id}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202);
    spade.wait_for(&id, "reply_stopped").await?;
    Ok(())
}

#[tokio::test]
async fn an_unknown_mode_is_refused_and_admission_stays_open() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (status, _) = spade
        .post("/v1/maintenance", json!({ "mode": "later" }))
        .await?;
    assert_eq!(status, 400);
    let (_, state) = spade.get("/v1/maintenance").await?;
    assert_eq!(
        state,
        json!({ "admission": "open", "running_turns": 0, "running_jobs": 0 })
    );
    Ok(())
}

#[tokio::test]
async fn reopening_without_a_restart_resumes_paused_turns_and_answers_new_messages() -> Result {
    let spade = Spade::start(
        vec![
            slow_reply("A long answer about boats."),
            Script::reply("Boats float."),
            title(),
            Script::reply("Fresh answer."),
            title(),
        ],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Tell me about boats").await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    spade
        .post(
            "/v1/maintenance",
            json!({ "mode": "now", "deadline_ms": 50 }),
        )
        .await?;
    spade.wait_for(&id, "turn_paused").await?;
    wait_until(&spade, |s| s["running_turns"] == 0).await?;

    // The update was aborted: the same Spade carries on.
    spade.delete("/v1/maintenance").await?;
    let events = spade.wait_for(&id, "reply_finished").await?;
    assert_eq!(last_text(&events, "reply_finished"), "Boats float.");
    spade.wait_for(&id, "renamed").await?;
    let next = spade.ask("And ships?").await?;
    let events = spade.wait_for(&next, "reply_finished").await?;
    assert_eq!(last_text(&events, "reply_finished"), "Fresh answer.");
    Ok(())
}

#[tokio::test]
async fn an_update_aborted_at_once_never_pauses_a_turn() -> Result {
    let lookup = FakeTool::new("lookup", Risk::Read, "Two trains a day");
    let spade = Spade::start(
        vec![
            slow_reply("Let me check.").call("c1", "lookup", json!({})),
            Script::reply("Two a day."),
            title(),
        ],
        vec![Arc::new(lookup) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Trains?").await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Closed and reopened before the closing task first runs.
    spade
        .engine
        .begin_maintenance(spade_core::maintenance::Mode::Now, None);
    spade.engine.end_maintenance();
    let events = spade.wait_for(&id, "reply_finished").await?;
    let kinds = types(&events);
    assert!(!kinds.contains(&"turn_paused".to_owned()), "{kinds:?}");
    assert_eq!(last_text(&events, "reply_finished"), "Two a day.");
    Ok(())
}
