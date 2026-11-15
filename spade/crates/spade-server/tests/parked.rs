//! Work that waits instead of ending (ADR 0158): a working task stopped by a spending cap is
//! parked on a wake (ADR 0160) and carries on at the cap's reset or once the cap is raised,
//! across a restart, and reads as sleeping with the reason meanwhile. Through the API with a real
//! database, a scripted fake model and a manual clock. Each model call costs 92 micros, so a cap
//! of 50 holds after one call.

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

/// The cap parks among `events`.
fn cap_parks(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|e| {
            e["type"] == "wake_set"
                && e["purpose"]["kind"] == "park"
                && e["purpose"]["reason"] == "cap"
        })
        .collect()
}

/// Waits until the task is parked on its cap.
async fn parked(spade: &Spade, chat: &str) -> Result<Vec<Value>> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let events = spade.wait_for(chat, "wake_set").await?;
        if !cap_parks(&events).is_empty() {
            return Ok(events);
        }
        if std::time::Instant::now() > deadline {
            return Err("the task never parked on its cap".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// Moves the clock to `ms` and lets the wake timer look.
async fn move_to(spade: &Spade, clock: &ManualClock, ms: i64) {
    clock.set(ms);
    spade.engine.kick_wakes();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
}

#[tokio::test]
async fn a_task_stopped_by_its_cap_waits_through_a_restart_and_carries_on_at_the_reset() -> Result {
    let clock = ManualClock::at(LATE_EVENING);
    let spade = Spade::start_with(vec![working()], tools(), at(&clock)).await?;
    let (agent, chat) = capped_bot(&spade).await?;
    let events = parked(&spade, &chat).await?;
    let park = cap_parks(&events).first().map(|p| p["due_ms"].clone());
    assert_eq!(park, Some(json!(MIDNIGHT)));
    let shown = roster_entry(&spade, &agent).await?;
    assert_eq!(shown["state"], "sleeping", "{shown}");
    assert_eq!(shown["wake"]["purpose"], "park", "{shown}");
    assert_eq!(shown["wake"]["parked"], "cap", "{shown}");
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
    assert_eq!(cap_parks(&events).len(), 1);
    assert_eq!(count(&events, "task_continued"), 0, "not before midnight");
    assert_eq!(roster_entry(&spade, &agent).await?["state"], "sleeping");

    move_to(&spade, &clock, MIDNIGHT + 60_000).await;
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
    parked(&spade, &chat).await?;
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
