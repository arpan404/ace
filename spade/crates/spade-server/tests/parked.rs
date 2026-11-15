//! Work that waits instead of ending (ADR 0158): a working task stopped by a spending cap carries
//! on at the cap's reset or once the cap is raised, across a restart, and reads as waiting
//! meanwhile. Through the API with a real database, a scripted fake model and a manual clock.
//! Each model call costs 92 micros, so a cap of 50 holds after one call.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_server::tools::{TaskStatus, Tool};
use spade_testkit::Script;
use support::{ManualClock, Options, Result, Spade};

/// 2026-11-09T05:30:00Z: 23:30 on the 8th in Chicago.
const LATE_EVENING: i64 = 1_794_202_200_000;
/// Chicago's next midnight.
const MIDNIGHT: i64 = LATE_EVENING + 1_800_000;

fn tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(TaskStatus)]
}

fn at(clock: &Arc<ManualClock>) -> Options {
    Options {
        clock: Some(clock.clone()),
        ..Options::default()
    }
}

/// A bot with a daily cap of 50 micros whose first reply marks its task working.
async fn capped_bot(spade: &Spade) -> Result<(String, String)> {
    spade
        .put("/v1/oversight", json!({ "time_zone": "America/Chicago" }))
        .await?;
    let agent = spade.new_agent("Porter", "Port the modules").await?;
    let id = agent["id"].as_str().unwrap_or_default().to_owned();
    let chat = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{id}/oversight"),
            json!({ "daily_cap_micros": 50 }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    spade.say(&chat, "Port all of them").await?;
    Ok((id, chat))
}

fn working() -> Script {
    Script::reply("").call(
        "c1",
        "task_status",
        json!({ "status": "working", "note": "porting" }),
    )
}

async fn roster_entry(spade: &Spade, agent: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["id"] == agent).cloned())
        .ok_or_else(|| "the bot is not in the roster".into())
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

#[tokio::test]
async fn a_task_stopped_by_its_cap_waits_through_a_restart_and_carries_on_at_the_reset() -> Result {
    let clock = ManualClock::at(LATE_EVENING);
    let spade = Spade::start_with(vec![working()], tools(), at(&clock)).await?;
    let (agent, chat) = capped_bot(&spade).await?;
    let events = spade.wait_for(&chat, "task_parked").await?;
    let parked = events.iter().find(|e| e["type"] == "task_parked");
    assert_eq!(parked.map(|p| p["until_ms"].clone()), Some(json!(MIDNIGHT)));
    let shown = roster_entry(&spade, &agent).await?;
    assert_eq!(shown["state"], "waiting", "{shown}");
    assert!(
        shown["status"]
            .as_str()
            .is_some_and(|s| s.contains("daily cap") && s.contains("carries on")),
        "{shown}"
    );

    // Spade restarts while the task waits: it still waits, said once.
    spade
        .engine
        .pause_for_stop(std::time::Duration::from_secs(1))
        .await;
    let spade = spade
        .restart_with(
            tools(),
            vec![Script::reply("Ported the next one.")],
            at(&clock),
        )
        .await?;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let events = spade.events(&chat).await?;
    assert_eq!(count(&events, "task_parked"), 1);
    assert_eq!(count(&events, "task_continued"), 0, "not before midnight");

    clock.set(MIDNIGHT + 60_000);
    let events = spade.wait_for(&chat, "task_continued").await?;
    assert_eq!(count(&events, "task_continued"), 1);
    let events = spade.wait_for_count(&chat, "reply_finished", 2).await?;
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "Ported the next one."),
        "the task carried on at the reset: {:?}",
        events
            .iter()
            .map(|e| format!("{} {}", e["type"], e["text"]))
            .collect::<Vec<_>>()
    );
    Ok(())
}

#[tokio::test]
async fn raising_the_cap_carries_a_waiting_task_on_at_once() -> Result {
    let clock = ManualClock::at(LATE_EVENING);
    let spade = Spade::start_with(
        vec![working(), Script::reply("Ported the next one.")],
        tools(),
        at(&clock),
    )
    .await?;
    let (agent, chat) = capped_bot(&spade).await?;
    spade.wait_for(&chat, "task_parked").await?;
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{agent}/oversight"),
            json!({ "daily_cap_micros": 1_000_000 }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let events = spade.wait_for(&chat, "task_continued").await?;
    assert_eq!(count(&events, "task_continued"), 1);
    spade.wait_for_count(&chat, "reply_finished", 2).await?;
    Ok(())
}
