//! The waits compose (ADR 0158, 0159, 0160): a check of done that meets an outage parks and
//! survives a restart, reading as checking and never done; a capped bot that sleeps parks on its
//! cap only once its sleep ends; a turn waiting out an outage and a parked job both resume once
//! after a restart. Through the API with a real database, a scripted fake endpoint and a clock
//! the test moves.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;
use spade_server::tools::{TaskGoal, TaskPlan, TaskStatus, Tool, ToolFuture, ToolOutput};
use spade_testkit::Script;
use support::{FakeTool, ManualClock, Options, Result, Spade};

/// 2026-11-09T05:30:00Z: 23:30 on the 8th in Chicago.
const LATE_EVENING: i64 = 1_794_202_200_000;
const MINUTE: i64 = 60_000;
const VERIFIER: &str = "You check whether a task is done";

fn on(clock: &Arc<ManualClock>) -> Options {
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

async fn roster_entry(spade: &Spade, conversation: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|l| {
            l.iter()
                .find(|a| a["conversation"] == conversation)
                .cloned()
        })
        .ok_or_else(|| "the bot is not in the roster".into())
}

/// Waits until the conversation has a `wake_set` whose purpose is `kind` (and `reason`, for a
/// park), and answers it.
async fn wake_set(spade: &Spade, conversation: &str, kind: &str, reason: &str) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let events = spade.events(conversation).await?;
        let found = events.iter().find(|e| {
            e["type"] == "wake_set"
                && e["purpose"]["kind"] == kind
                && (reason.is_empty() || e["purpose"]["reason"] == reason)
        });
        if let Some(found) = found {
            return Ok(found.clone());
        }
        if Instant::now() > deadline {
            return Err(format!("no {kind} wake was set: {events:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Moves the clock to `ms` and lets the wake timer look.
async fn move_to(spade: &Spade, clock: &ManualClock, ms: i64) {
    clock.set(ms);
    spade.engine.kick_wakes();
    tokio::time::sleep(Duration::from_millis(150)).await;
}

fn verifier_calls(spade: &Spade) -> usize {
    spade
        .fake
        .seen()
        .iter()
        .filter(|s| s.body.to_string().contains(VERIFIER))
        .count()
}

fn goal_tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(FakeTool::new(
            "run_tests",
            Risk::Read,
            "test result: ok. 2 passed",
        )),
        Arc::new(TaskStatus),
        Arc::new(TaskGoal),
        Arc::new(TaskPlan),
    ]
}

#[tokio::test]
async fn an_outage_during_the_check_of_done_parks_it_through_a_restart_and_it_is_never_done_meanwhile()
-> Result {
    let clock = ManualClock::at(LATE_EVENING);
    let spade = Spade::start_with(
        vec![
            Script::reply("")
                .call(
                    "c1",
                    "task_goal",
                    json!({ "title": "Tests", "criteria": ["tests pass"] }),
                )
                .call(
                    "c2",
                    "task_plan",
                    json!({ "op": "add", "text": "run them" }),
                ),
            Script::reply("").call("c3", "run_tests", json!({})),
            Script::reply("")
                .call(
                    "c4",
                    "task_plan",
                    json!({ "op": "done", "item": "1",
                            "evidence": [{ "kind": "output", "call": "c3" }] }),
                )
                .call("c5", "task_status", json!({ "status": "done" })),
            Script::reply("Done."),
            title(),
            // The verifier's model is down.
            Script::failing(503),
        ],
        goal_tools(),
        on(&clock),
    )
    .await?;
    let agent = spade.new_agent("Builder", "Keep the build green").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Run the tests").await?;
    let park = wake_set(&spade, &conversation, "park", "check").await?;
    assert_eq!(park["due_ms"], LATE_EVENING + MINUTE, "{park}");
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "task_verified"), 0, "nothing was judged");
    let shown = roster_entry(&spade, &conversation).await?;
    assert_eq!(shown["state"], "sleeping", "{shown}");
    assert_eq!(shown["task_progress"]["state"], "checking", "{shown}");
    assert_eq!(shown["wake"]["parked"], "check", "{shown}");
    assert_eq!(verifier_calls(&spade), 1);

    // Spade restarts while the check waits: it still waits, and is still not done.
    let spade = spade
        .restart_after_stop_with(
            Duration::from_secs(1),
            goal_tools(),
            vec![
                Script::reply("")
                    .plain(r#"{"criteria":[{"id":"1","met":true,"why":"2 passed"}],"done":true}"#),
            ],
            on(&clock),
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        verifier_calls(&spade),
        0,
        "not checked again before its time"
    );
    let shown = roster_entry(&spade, &conversation).await?;
    assert_eq!(shown["state"], "sleeping", "{shown}");
    assert_eq!(shown["task_progress"]["state"], "checking", "{shown}");

    move_to(&spade, &clock, LATE_EVENING + MINUTE).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let shown = roster_entry(&spade, &conversation).await?;
        if shown["task_progress"]["state"] == "done" {
            assert_eq!(shown["state"], "idle", "{shown}");
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("the check never ran again: {shown}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "task_verified"), 1, "judged once");
    assert_eq!(verifier_calls(&spade), 1);
    Ok(())
}

/// A background download whose first run fails for a while and whose second works.
struct Flaky(Arc<AtomicUsize>);

impl Tool for Flaky {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "download".into(),
                description: "Downloads a file".into(),
                schema: json!({ "type": "object" }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: true,
        }
    }

    fn run(&self, _key: &str, _arguments: Value) -> ToolFuture {
        let runs = self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if runs == 0 {
                ToolOutput::error("the server answered 503").transient()
            } else {
                ToolOutput::ok("Downloaded.")
            }
        })
    }
}

#[tokio::test]
async fn a_turn_waiting_out_an_outage_and_a_parked_job_both_resume_once_after_a_restart() -> Result
{
    let clock = ManualClock::at(LATE_EVENING);
    let runs = Arc::new(AtomicUsize::new(0));
    let flaky = || vec![Arc::new(Flaky(runs.clone())) as Arc<dyn Tool>];
    let quick = |clock: &Arc<ManualClock>| Options {
        model_retry: Some(spade_server::engine::Retry {
            tries: 2,
            first_wait: Duration::from_millis(5),
            longest: Duration::from_millis(20),
        }),
        ..on(clock)
    };
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "download", json!({})),
            Script::failing(503),
            Script::failing(503),
        ],
        flaky(),
        quick(&clock),
    )
    .await?;
    let agent = spade.new_agent("Fetcher", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Fetch it").await?;
    let outage = wake_set(&spade, &conversation, "outage", "").await?;
    let job = wake_set(&spade, &conversation, "retry", "").await?;
    assert_eq!(job["purpose"]["job"], "c1", "{job}");
    let shown = roster_entry(&spade, &conversation).await?;
    assert_eq!(
        shown["state"], "working",
        "the parked job is still its work: {shown}"
    );

    let spade = spade
        .restart_after_stop_with(
            Duration::from_secs(1),
            flaky(),
            vec![
                Script::reply("Waiting for the download."),
                Script::reply("The download is done."),
                title(),
                title(),
            ],
            quick(&clock),
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let events = spade.events(&conversation).await?;
    assert_eq!(
        count(&events, "reply_interrupted"),
        0,
        "the open reply was kept"
    );
    assert_eq!(
        count(&events, "job_finished"),
        0,
        "the parked job was not reported lost"
    );
    assert_eq!(runs.load(Ordering::SeqCst), 1);

    move_to(&spade, &clock, LATE_EVENING + MINUTE).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let shown = roster_entry(&spade, &conversation).await?;
        let events = spade.events(&conversation).await?;
        if shown["state"] == "idle" && count(&events, "job_finished") == 1 {
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("never settled: {shown} {events:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let events = spade.events(&conversation).await?;
    assert_eq!(runs.load(Ordering::SeqCst), 2, "the job ran again once");
    let finished: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "job_finished")
        .collect();
    assert_eq!(finished[0]["content"], "Downloaded.");
    let fired: Vec<&str> = events
        .iter()
        .filter(|e| e["type"] == "wake_fired")
        .filter_map(|e| e["wake"].as_str())
        .collect();
    assert_eq!(fired.len(), 2, "each wake fired once: {fired:?}");
    assert!(fired.contains(&outage["wake"].as_str().unwrap_or_default()));
    assert!(fired.contains(&job["wake"].as_str().unwrap_or_default()));
    assert_eq!(count(&events, "reply_failed"), 0);
    Ok(())
}
