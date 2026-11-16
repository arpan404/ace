//! Spade has no spending limits (ADR 0166): nothing parks for spend, and a cap or budget park an
//! earlier build stored is cancelled when Spade opens, so its task carries on. What each call
//! cost is still recorded. Through the API with a real database, a scripted fake model (each
//! call costs 92 micros) and a manual clock.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_server::tools::{TaskStatus, Tool};
use spade_testkit::Script;
use support::{ManualClock, Options, Result, Spade};

/// 2026-11-09T05:30:00Z.
const EVENING: i64 = 1_794_202_200_000;

fn tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(TaskStatus)]
}

fn at(clock: &Arc<ManualClock>) -> Options {
    Options {
        clock: Some(clock.clone()),
        ..Options::default()
    }
}

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Work"}"#)
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

async fn roster_entry(spade: &Spade, agent: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["id"] == agent).cloned())
        .ok_or_else(|| "the bot is not in the roster".into())
}

async fn new_bot(spade: &Spade) -> Result<(String, String)> {
    let agent = spade.new_agent("Porter", "Port the modules").await?;
    let id = agent["id"].as_str().unwrap_or_default().to_owned();
    let chat = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok((id, chat))
}

/// Waits until `chat` has `n` events of `kind`.
async fn wait_count(spade: &Spade, chat: &str, kind: &str, n: usize) -> Result<Vec<Value>> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let events = spade.events(chat).await?;
        if count(&events, kind) >= n {
            return Ok(events);
        }
        if Instant::now() > deadline {
            return Err(format!("never saw {n} {kind}: {events:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn nothing_parks_for_spend_and_what_each_call_cost_is_still_recorded() -> Result {
    let clock = ManualClock::at(EVENING);
    let spade = Spade::start_with(
        vec![
            Script::reply("").call(
                "c1",
                "task_status",
                json!({ "status": "working", "note": "porting" }),
            ),
            Script::reply("Ported the first one."),
            title(),
            Script::reply("").call(
                "c2",
                "task_status",
                json!({ "status": "done", "note": "all ported" }),
            ),
            Script::reply("Ported them all."),
        ],
        tools(),
        at(&clock),
    )
    .await?;
    let (agent, chat) = new_bot(&spade).await?;
    // A cap of nothing an earlier build left in the bot's settings: ignored.
    spade_store::Store::open(&spade.database())?.set_setting(
        &format!("oversight:{agent}"),
        Some(r#"{"daily_cap_micros":0,"monthly_cap_micros":0}"#),
    )?;
    // The person's old app may still send caps: they change nothing.
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{agent}/oversight"),
            json!({ "daily_cap_micros": 0, "review": false }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    spade.say(&chat, "Port all of them").await?;

    let events = wait_count(&spade, &chat, "reply_finished", 2).await?;
    assert_eq!(count(&events, "task_continued"), 1, "the task carried on");
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "Ported them all."),
        "{events:?}"
    );
    assert!(
        events.iter().all(|e| e["type"] != "wake_set"
            && e["type"] != "cap_reached"
            && e["type"] != "reply_failed"),
        "nothing parked, capped or failed: {events:?}"
    );
    let shown = roster_entry(&spade, &agent).await?;
    assert_ne!(shown["state"], "sleeping", "{shown}");

    // Every model call is still paid for: the four steps and the title, 92 micros each.
    let (status, body) = spade.get(&format!("/v1/agents/{agent}/oversight")).await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["spending"]["today_micros"], 5 * 92, "{body}");
    assert_eq!(body["spending"]["month_micros"], 5 * 92, "{body}");
    assert!(
        body["spending"].get("daily_cap_micros").is_none()
            && body["spending"].get("capped").is_none(),
        "no caps are shown: {body}"
    );
    assert_eq!(body["review"], false, "{body}");
    let (_, service) = spade.get("/v1/oversight").await?;
    assert_eq!(service["oversight"]["today_micros"], 5 * 92, "{service}");
    assert!(
        service["oversight"].get("daily_cap_micros").is_none(),
        "{service}"
    );
    Ok(())
}

/// A bot whose task works and sleeps, stopped; its sleep is rewritten in storage as the park
/// `wake` (`purpose`, `condition`) an earlier build set for spend. Spade opens again and the
/// task must carry on.
async fn an_old_spend_park_is_cancelled_on_start(purpose: Value, condition: Value) -> Result {
    let clock = ManualClock::at(EVENING);
    let spade = Spade::start_with(
        vec![
            Script::reply("")
                .call(
                    "c1",
                    "task_status",
                    json!({ "status": "working", "note": "porting" }),
                )
                .call(
                    "c2",
                    "sleep_until",
                    json!({ "after": "10h", "reason": "the build settles" }),
                ),
            title(),
        ],
        tools(),
        at(&clock),
    )
    .await?;
    let (agent, chat) = new_bot(&spade).await?;
    spade.say(&chat, "Port all of them").await?;
    let events = wait_count(&spade, &chat, "wake_set", 1).await?;
    assert_eq!(count(&events, "task_continued"), 0, "it sleeps");
    spade.wait_for(&chat, "reply_finished").await?;
    spade.engine.pause_for_stop(Duration::from_secs(1)).await;

    // As an earlier build left it: the task parked at a cap, or a worker waiting for budget.
    let rewritten = rusqlite::Connection::open(spade.database())?.execute(
        "UPDATE events
            SET body = json_set(body, '$.purpose', json(?1), '$.condition', json(?2),
                                '$.reason', 'Porter is at its daily cap of $0.00 until midnight.')
          WHERE conversation_id = ?3 AND json_extract(body, '$.type') = 'wake_set'",
        rusqlite::params![purpose.to_string(), condition.to_string(), chat],
    )?;
    assert_eq!(rewritten, 1);

    let spade = spade
        .restart_with(tools(), vec![Script::reply("Carried on.")], at(&clock))
        .await?;
    let events = spade.wait_for(&chat, "task_continued").await?;
    let cancelled: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "wake_cancelled")
        .collect();
    assert_eq!(cancelled.len(), 1, "{events:?}");
    assert_eq!(cancelled[0]["by"], "spade");
    let events = wait_count(&spade, &chat, "reply_finished", 2).await?;
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "Carried on."),
        "the task carried on: {events:?}"
    );
    assert_eq!(count(&events, "task_continued"), 1);
    assert_eq!(count(&events, "wake_fired"), 0, "cancelled, never fired");
    let (_, wakes) = spade.get(&format!("/v1/agents/{agent}/wakes")).await?;
    assert_eq!(wakes["wakes"], json!([]), "{wakes}");
    Ok(())
}

#[tokio::test]
async fn an_old_cap_park_found_open_on_start_is_cancelled_and_the_task_carries_on() -> Result {
    an_old_spend_park_is_cancelled_on_start(
        json!({ "kind": "park", "reason": "cap", "attempt": 0 }),
        Value::Null,
    )
    .await
}

#[tokio::test]
async fn an_old_wait_for_budget_found_open_on_start_is_cancelled_and_the_task_carries_on() -> Result
{
    an_old_spend_park_is_cancelled_on_start(json!({ "kind": "wait" }), json!({ "kind": "budget" }))
        .await
}
