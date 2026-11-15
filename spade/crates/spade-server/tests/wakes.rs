//! Wakes (ADR 0160) through the real engine and API on a scripted endpoint and a clock the test
//! moves: a bot sleeps and wakes once at its time, across a restart too; the person wakes it
//! early or cancels; a wait ends with the job it waits on; a turn waits out an outage on a wake
//! and a failed job is parked and tried again; a long job gets one check-in per slot.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;
use spade_server::tools::{Tool, ToolFuture, ToolOutput};
use spade_testkit::Script;
use support::{FakeTool, ManualClock, Options, Result, Spade, types};

const T0: i64 = 1_800_000_000_000;
const MINUTE: i64 = 60_000;

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Deploy"}"#)
}

fn on(clock: &Arc<ManualClock>) -> Options {
    Options {
        clock: Some(clock.clone()),
        ..Options::default()
    }
}

async fn bot(spade: &Spade, conversation: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["conversation"] == conversation))
        .cloned()
        .unwrap_or_default())
}

/// A new bot told `text`, once its first reply ended: its id and conversation.
async fn told(spade: &Spade, text: &str) -> Result<(String, String)> {
    let agent = spade.new_agent("Deployer", "").await?;
    let field = |name: &str| agent[name].as_str().unwrap_or_default().to_owned();
    let (id, conversation) = (field("id"), field("conversation"));
    spade.say(&conversation, text).await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    Ok((id, conversation))
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

/// Moves the clock to `ms` and lets the wake timer look.
async fn at(spade: &Spade, clock: &ManualClock, ms: i64) {
    clock.set(ms);
    spade.engine.kick_wakes();
    tokio::time::sleep(Duration::from_millis(150)).await;
}

fn last_prompt(spade: &Spade) -> String {
    spade
        .fake
        .seen()
        .iter()
        .rev()
        .find(|s| s.body["stream"] == true)
        .map(|s| s.body["messages"].to_string())
        .unwrap_or_default()
}

/// Waits until the bot's roster state reads `state`.
async fn state_reads(spade: &Spade, conversation: &str, state: &str) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let shown = bot(spade, conversation).await?;
        if shown["state"] == state {
            return Ok(shown);
        }
        if Instant::now() > deadline {
            return Err(format!("the state never read {state}: {shown}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_sleeping_bot_reads_sleeping_with_its_reason_and_wakes_once_at_its_time() -> Result {
    let clock = ManualClock::at(T0);
    let spade = Spade::start_with(
        vec![
            Script::reply("").call(
                "c1",
                "sleep_until",
                json!({ "after": "10m", "reason": "the deploy settles" }),
            ),
            Script::reply("Sleeping until the deploy settles."),
            title(),
            Script::reply("The deploy settled."),
        ],
        Vec::new(),
        on(&clock),
    )
    .await?;
    let (_, conversation) = told(&spade, "Watch the deploy").await?;

    let shown = state_reads(&spade, &conversation, "sleeping").await?;
    assert_eq!(shown["working"], true, "never idle while it sleeps");
    let status = shown["status"].as_str().unwrap_or_default();
    assert!(status.starts_with("Sleeping until "), "{status}");
    assert!(status.ends_with(": the deploy settles"), "{status}");
    assert_eq!(shown["wake"]["purpose"], "sleep");
    assert_eq!(shown["wake"]["due_at"], T0 + 10 * MINUTE);

    // Not yet: nothing fires a minute early.
    at(&spade, &clock, T0 + 9 * MINUTE).await;
    assert_eq!(count(&spade.events(&conversation).await?, "wake_fired"), 0);

    at(&spade, &clock, T0 + 10 * MINUTE).await;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert!(
        last_prompt(&spade)
            .contains("Your sleep is over. You gave this reason: the deploy settles."),
        "{}",
        last_prompt(&spade)
    );
    let fired: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "wake_fired")
        .collect();
    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0]["cause"], "time");

    // Looked at again, it never fires twice.
    at(&spade, &clock, T0 + 20 * MINUTE).await;
    assert_eq!(count(&spade.events(&conversation).await?, "wake_fired"), 1);
    state_reads(&spade, &conversation, "idle").await?;
    Ok(())
}

#[tokio::test]
async fn a_wake_set_before_a_restart_fires_once_after_it() -> Result {
    let clock = ManualClock::at(T0);
    let spade = Spade::start_with(
        vec![
            Script::reply("").call(
                "c1",
                "sleep_until",
                json!({ "after": 3600, "reason": "the nightly build" }),
            ),
            Script::reply("Sleeping."),
            title(),
        ],
        Vec::new(),
        on(&clock),
    )
    .await?;
    let (_, conversation) = told(&spade, "Check the nightly build").await?;

    let spade = spade
        .restart_with(
            Vec::new(),
            vec![Script::reply("Build checked.")],
            on(&clock),
        )
        .await?;
    state_reads(&spade, &conversation, "sleeping").await?;
    at(&spade, &clock, T0 + 61 * MINUTE).await;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;

    // Another restart, and the timer looking again, deliver nothing more.
    let spade = spade
        .restart_with(Vec::new(), Vec::new(), on(&clock))
        .await?;
    at(&spade, &clock, T0 + 120 * MINUTE).await;
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "wake_fired"), 1);
    assert_eq!(count(&events, "reply_finished"), 2);
    Ok(())
}

#[tokio::test]
async fn the_person_wakes_a_sleeping_bot_early_or_cancels_its_sleep() -> Result {
    let clock = ManualClock::at(T0);
    let spade = Spade::start_with(
        vec![
            Script::reply("").call(
                "c1",
                "sleep_until",
                json!({ "after": "1d", "reason": "a reply" }),
            ),
            Script::reply("Sleeping."),
            title(),
            Script::reply("Awake early."),
            Script::reply("").call(
                "c2",
                "sleep_until",
                json!({ "after": "1d", "reason": "again" }),
            ),
            Script::reply("Sleeping again."),
        ],
        Vec::new(),
        on(&clock),
    )
    .await?;
    let (agent, conversation) = told(&spade, "Wait for the reply").await?;

    let (_, listed) = spade.get(&format!("/v1/agents/{agent}/wakes")).await?;
    let wake = listed["wakes"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert_eq!(listed["wakes"][0]["reason"], "a reply");
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/wakes/{wake}/wake"), json!({}))
        .await?;
    assert_eq!(status, 202);
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert!(last_prompt(&spade).contains("The person woke you early."));
    let (status, _) = spade
        .post(&format!("/v1/agents/{agent}/wakes/{wake}/wake"), json!({}))
        .await?;
    assert_eq!(status, 409, "a wake fires once");

    spade.say(&conversation, "Sleep again").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 3)
        .await?;
    let (_, listed) = spade.get(&format!("/v1/agents/{agent}/wakes")).await?;
    let again = listed["wakes"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, _) = spade
        .delete(&format!("/v1/agents/{agent}/wakes/{again}"))
        .await?;
    assert_eq!(status, 204);
    state_reads(&spade, &conversation, "idle").await?;
    at(&spade, &clock, T0 + 3 * 24 * 60 * MINUTE).await;
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "wake_fired"), 1);
    assert_eq!(count(&events, "wake_cancelled"), 1);
    Ok(())
}

#[tokio::test]
async fn stop_ends_a_sleep() -> Result {
    let clock = ManualClock::at(T0);
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "sleep_until", json!({ "after": "2h", "reason": "x" })),
            Script::reply("Sleeping."),
            title(),
        ],
        Vec::new(),
        on(&clock),
    )
    .await?;
    let (_, conversation) = told(&spade, "Sleep").await?;
    state_reads(&spade, &conversation, "sleeping").await?;
    let (status, body) = spade
        .post(&format!("/v1/conversations/{conversation}/stop"), json!({}))
        .await?;
    assert!(status < 300, "{body}");
    state_reads(&spade, &conversation, "idle").await?;
    let events = spade.events(&conversation).await?;
    assert_eq!(
        events
            .iter()
            .find(|e| e["type"] == "wake_cancelled")
            .map(|e| e["by"].clone()),
        Some(json!("stop"))
    );
    Ok(())
}

#[tokio::test]
async fn a_wait_on_a_job_ends_with_the_jobs_result_and_adds_no_note() -> Result {
    let research = FakeTool::new("research", Risk::Read, "Three good options")
        .background()
        .slow(Duration::from_millis(400));
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "research", json!({ "topic": "flights" })),
            Script::reply("").call(
                "c2",
                "wait_for",
                json!({ "condition": { "kind": "job", "job": "c1" }, "reason": "the research" }),
            ),
            Script::reply("Waiting for the research."),
            title(),
            Script::reply("It found three options."),
        ],
        vec![Arc::new(research) as Arc<dyn Tool>],
        Options::default(),
    )
    .await?;
    let (_, conversation) = told(&spade, "Research flights").await?;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    let order: Vec<String> = types(&events)
        .into_iter()
        .filter(|t| t == "job_finished" || t == "wake_fired" || t == "reply_started")
        .collect();
    assert_eq!(
        order,
        [
            "reply_started",
            "job_finished",
            "wake_fired",
            "reply_started"
        ],
        "settled with the result, which opens the reply"
    );
    let fired = events
        .iter()
        .find(|e| e["type"] == "wake_fired")
        .cloned()
        .unwrap_or_default();
    assert_eq!(fired["cause"], "condition");
    assert!(fired.get("note").is_none(), "{fired}");
    assert!(!last_prompt(&spade).contains("<wake id="));
    Ok(())
}

#[tokio::test]
async fn a_wait_for_the_person_ends_when_they_write() -> Result {
    let spade = Spade::start_with(
        vec![
            Script::reply("").call(
                "c1",
                "wait_for",
                json!({ "condition": { "kind": "person" }, "timeout": "1d", "reason": "your go-ahead" }),
            ),
            Script::reply("Waiting for your go-ahead."),
            title(),
            Script::reply("Going ahead."),
        ],
        Vec::new(),
        Options::default(),
    )
    .await?;
    let (_, conversation) = told(&spade, "Ship it when I say").await?;
    let shown = state_reads(&spade, &conversation, "sleeping").await?;
    assert_eq!(
        shown["status"],
        "Waiting for the person to write: your go-ahead"
    );
    spade.say(&conversation, "Go").await?;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(count(&events, "wake_fired"), 1);
    state_reads(&spade, &conversation, "idle").await?;
    Ok(())
}

fn retrying(clock: &Arc<ManualClock>) -> Options {
    Options {
        model_retry: Some(spade_server::engine::Retry {
            tries: 2,
            first_wait: Duration::from_millis(5),
            longest: Duration::from_millis(20),
        }),
        ..on(clock)
    }
}

#[tokio::test]
async fn a_reply_that_fails_for_a_while_waits_on_a_wake_and_its_step_is_sent_again() -> Result {
    let clock = ManualClock::at(T0);
    let spade = Spade::start_with(
        vec![
            Script::failing(503),
            Script::failing(503),
            Script::reply("Back again."),
            title(),
        ],
        Vec::new(),
        retrying(&clock),
    )
    .await?;
    let agent = spade.new_agent("Deployer", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hello").await?;
    let shown = state_reads(&spade, &conversation, "sleeping").await?;
    assert_eq!(shown["wake"]["purpose"], "outage");
    assert_eq!(shown["wake"]["attempt"], 1);
    assert_eq!(shown["wake"]["due_at"], T0 + MINUTE);
    assert_eq!(
        count(&spade.events(&conversation).await?, "reply_failed"),
        0,
        "the reply stays open"
    );

    at(&spade, &clock, T0 + MINUTE).await;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert_eq!(count(&events, "reply_started"), 1);
    assert_eq!(count(&events, "wake_fired"), 1);
    assert!(
        !last_prompt(&spade).contains("<wake"),
        "the step is sent again as it was; nothing is added for the model"
    );
    state_reads(&spade, &conversation, "idle").await?;
    Ok(())
}

#[tokio::test]
async fn the_person_writing_ends_an_outage_wait_and_the_step_goes_again_with_their_message()
-> Result {
    let clock = ManualClock::at(T0);
    let spade = Spade::start_with(
        vec![
            Script::failing(503),
            Script::failing(503),
            Script::reply("Here, with your note."),
            title(),
        ],
        Vec::new(),
        retrying(&clock),
    )
    .await?;
    let agent = spade.new_agent("Deployer", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hello").await?;
    state_reads(&spade, &conversation, "sleeping").await?;
    spade.say(&conversation, "Also mention the date").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert_eq!(
        count(&events, "reply_started"),
        1,
        "the same reply answered"
    );
    let fired: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "wake_fired")
        .collect();
    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0]["cause"], "message");
    assert!(last_prompt(&spade).contains("Also mention the date"));
    Ok(())
}

#[tokio::test]
async fn a_refused_key_is_reported_and_not_parked() -> Result {
    let clock = ManualClock::at(T0);
    let spade = Spade::start_with(
        vec![Script::failing(401), title()],
        Vec::new(),
        retrying(&clock),
    )
    .await?;
    let agent = spade.new_agent("Deployer", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hello").await?;
    spade.wait_for(&conversation, "reply_failed").await?;
    state_reads(&spade, &conversation, "idle").await?;
    assert_eq!(count(&spade.events(&conversation).await?, "wake_set"), 0);
    Ok(())
}

/// A background tool whose first run fails for a while and whose second works.
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
async fn a_job_that_fails_for_a_while_is_parked_and_runs_again_at_its_retry() -> Result {
    let clock = ManualClock::at(T0);
    let runs = Arc::new(AtomicUsize::new(0));
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "download", json!({})),
            Script::reply("Downloading."),
            title(),
            Script::reply("The download is done."),
        ],
        vec![Arc::new(Flaky(runs.clone())) as Arc<dyn Tool>],
        on(&clock),
    )
    .await?;
    let (_, conversation) = told(&spade, "Download it").await?;
    spade.wait_for(&conversation, "wake_set").await?;
    let shown = bot(&spade, &conversation).await?;
    assert_eq!(
        shown["state"], "working",
        "the parked job is still the bot's work"
    );
    assert_eq!(
        count(&spade.events(&conversation).await?, "job_finished"),
        0
    );

    at(&spade, &clock, T0 + MINUTE).await;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(runs.load(Ordering::SeqCst), 2);
    let finished: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "job_finished")
        .collect();
    assert_eq!(finished.len(), 1);
    assert_eq!(finished[0]["content"], "Downloaded.");
    Ok(())
}

#[tokio::test]
async fn a_long_job_gets_one_check_in_per_slot() -> Result {
    let clock = ManualClock::at(T0);
    let slow = FakeTool::new("research", Risk::Read, "Done")
        .background()
        .slow(Duration::from_secs(30));
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("c1", "research", json!({ "topic": "x" })),
            Script::reply("Researching."),
            title(),
            Script::reply("Still going; I will keep waiting."),
        ],
        vec![Arc::new(slow) as Arc<dyn Tool>],
        on(&clock),
    )
    .await?;
    let (_, conversation) = told(&spade, "Research").await?;
    at(&spade, &clock, T0 + 14 * MINUTE).await;
    assert_eq!(
        count(&spade.events(&conversation).await?, "job_progress"),
        0
    );

    at(&spade, &clock, T0 + 15 * MINUTE).await;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    let progress = events
        .iter()
        .find(|e| e["type"] == "job_progress")
        .cloned()
        .unwrap_or_default();
    assert_eq!(progress["job"], "c1");
    assert_eq!(progress["minutes"], 15);
    assert!(
        last_prompt(&spade)
            .contains("<job_progress job=\\\"c1\\\" tool=\\\"research\\\" minutes=\\\"15\\\"")
    );

    at(&spade, &clock, T0 + 20 * MINUTE).await;
    assert_eq!(
        count(&spade.events(&conversation).await?, "job_progress"),
        1
    );
    Ok(())
}
