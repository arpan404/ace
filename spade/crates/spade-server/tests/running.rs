//! The process model's pause and the task manager (ADR 0200 §6) through the real engine and API,
//! on a scripted endpoint and a clock the test moves: Pause holds a due wake and a routine slot
//! across a restart and Resume fires each once; a message to a paused bot waits for Resume; Stop
//! from the running view stops the bot's workers; `GET /v1/running` says each state in words.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::clock::Ids;
use spade_server::routines;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, ManualClock, Options, Result, Spade, types};

const MINUTE: i64 = 60_000;

/// Milliseconds of an RFC 3339 instant.
fn at(text: &str) -> i64 {
    text.parse::<jiff::Timestamp>()
        .unwrap_or_else(|e| panic!("{text}: {e}"))
        .as_millisecond()
}

/// Ids that never repeat a first run's, so a restarted engine never reuses one.
struct LaterIds(AtomicU64);

impl Ids for LaterIds {
    fn next(&self, prefix: &str) -> String {
        format!("{prefix}_later_{}", self.0.fetch_add(1, Ordering::SeqCst))
    }
}

fn on(clock: &Arc<ManualClock>) -> Options {
    Options {
        clock: Some(clock.clone()),
        ..Options::default()
    }
}

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Deploy"}"#)
}

fn count(events: &[Value], test: impl Fn(&Value) -> bool) -> usize {
    events.iter().filter(|e| test(e)).count()
}

fn of_type(kind: &'static str) -> impl Fn(&Value) -> bool {
    move |e| e["type"] == kind
}

fn from_routine(e: &Value) -> bool {
    e["type"] == "user_message" && e["from_routine"].is_object()
}

/// Moves the clock to `ms`, and lets the wake timer and the routines look.
async fn move_to(spade: &Spade, clock: &ManualClock, ms: i64) -> Result {
    clock.set(ms);
    spade.engine.kick_wakes();
    routines::tick(&spade.engine).await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    Ok(())
}

async fn running(spade: &Spade) -> Result<Vec<Value>> {
    let (status, body) = spade.get("/v1/running").await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["bots"].as_array().cloned().unwrap_or_default())
}

async fn row(spade: &Spade, agent: &str) -> Result<Value> {
    running(spade)
        .await?
        .into_iter()
        .find(|r| r["id"] == agent)
        .ok_or_else(|| format!("{agent} isn't in the running view").into())
}

/// Waits until `test` holds, looking every 20 ms for up to 10 s.
async fn until<F, Fut>(what: &str, test: F) -> Result
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<bool>>,
{
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if test().await? {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("never: {what}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn act(spade: &Spade, agent: &str, action: &str) -> Result<Value> {
    let (status, body) = spade
        .post(&format!("/v1/agents/{agent}/{action}"), json!({}))
        .await?;
    assert_eq!(status, 200, "{action}: {body}");
    Ok(body)
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

#[tokio::test]
async fn pause_holds_a_due_wake_and_a_routine_slot_across_a_restart_and_resume_fires_each_once()
-> Result {
    let t0 = at("2026-11-20T08:00:00Z");
    let clock = ManualClock::at(t0);
    let spade = Spade::start_with(
        vec![
            Script::reply("").call(
                "c1",
                "sleep_until",
                json!({ "after": "30m", "reason": "the deploy settles" }),
            ),
            Script::reply("Sleeping until the deploy settles."),
            title(),
        ],
        Vec::new(),
        on(&clock),
    )
    .await?;
    let (agent, conversation) = told(&spade, "Watch the deploy").await?;
    let (status, made) = spade
        .post(
            &format!("/v1/agents/{agent}/routines"),
            json!({ "name": "Morning check", "instruction": "Check the deploy.",
                    "trigger": { "kind": "schedule", "schedule": "daily at 8:20" },
                    "time_zone": "UTC" }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let sleeping = row(&spade, &agent).await?;
    assert_eq!(sleeping["reads"], "sleeping", "{sleeping}");
    assert_eq!(
        sleeping["next_wake"]["at_ms"],
        t0 + 20 * MINUTE,
        "the routine comes first"
    );

    let paused = act(&spade, &agent, "pause").await?;
    assert_eq!(paused["changed"], true);
    let shown = row(&spade, &agent).await?;
    assert_eq!(
        (&shown["state"], &shown["reads"], &shown["doing"]),
        (&json!("paused"), &json!("paused"), &json!("Paused")),
        "{shown}"
    );
    assert_eq!(shown["actions"], json!(["resume"]));
    // Its held wake is kept, not cancelled.
    let (_, wakes) = spade.get(&format!("/v1/agents/{agent}/wakes")).await?;
    assert_eq!(wakes["wakes"].as_array().map(Vec::len), Some(1), "{wakes}");

    // Both come due while it is paused: neither fires.
    move_to(&spade, &clock, t0 + 45 * MINUTE).await?;
    let events = spade.events(&conversation).await?;
    assert_eq!(
        count(&events, of_type("wake_fired")),
        0,
        "{:?}",
        types(&events)
    );
    assert_eq!(count(&events, from_routine), 0);

    // Through a restart the pause holds, and so do they.
    let options = Options {
        clock: Some(clock.clone()),
        ids: Some(Arc::new(LaterIds(AtomicU64::new(1)))),
        ..Options::default()
    };
    let spade = spade
        .restart_with(
            Vec::new(),
            vec![
                Script::reply("The deploy settled."),
                Script::reply("Checked the deploy."),
                Script::reply("All done."),
            ],
            options,
        )
        .await?;
    move_to(&spade, &clock, t0 + 50 * MINUTE).await?;
    let events = spade.events(&conversation).await?;
    assert_eq!(
        count(&events, of_type("wake_fired")),
        0,
        "{:?}",
        types(&events)
    );
    assert_eq!(count(&events, from_routine), 0);
    assert_eq!(row(&spade, &agent).await?["reads"], "paused");

    let resumed = act(&spade, &agent, "resume").await?;
    assert_eq!(resumed["changed"], true);
    move_to(&spade, &clock, t0 + 51 * MINUTE).await?;
    until("the wake and the routine were answered", || async {
        let events = spade.events(&conversation).await?;
        let started = count(&events, of_type("reply_started"));
        let ended = count(&events, |e| {
            matches!(
                e["type"].as_str(),
                Some("reply_finished" | "reply_stopped" | "reply_failed")
            )
        });
        Ok(count(&events, of_type("wake_fired")) == 1
            && count(&events, from_routine) == 1
            && started == ended)
    })
    .await?;
    let routine_run = spade
        .events(&conversation)
        .await?
        .into_iter()
        .find(from_routine)
        .unwrap_or_default();
    assert_eq!(routine_run["from_routine"]["name"], "Morning check");

    // Looked at again, and after another restart, neither fires twice.
    move_to(&spade, &clock, t0 + 60 * MINUTE).await?;
    let spade = spade
        .restart_with(
            Vec::new(),
            Vec::new(),
            Options {
                clock: Some(clock.clone()),
                ids: Some(Arc::new(LaterIds(AtomicU64::new(1_000)))),
                ..Options::default()
            },
        )
        .await?;
    move_to(&spade, &clock, t0 + 70 * MINUTE).await?;
    let events = spade.events(&conversation).await?;
    assert_eq!(
        count(&events, of_type("wake_fired")),
        1,
        "{:?}",
        types(&events)
    );
    assert_eq!(count(&events, from_routine), 1);
    let shown = row(&spade, &agent).await?;
    assert_eq!(shown["reads"], "idle", "{shown}");
    assert_eq!(shown["actions"], json!(["pause"]));
    Ok(())
}

#[tokio::test]
async fn a_message_to_a_paused_bot_waits_and_resume_answers_it() -> Result {
    let clock = ManualClock::at(at("2026-11-20T08:00:00Z"));
    let spade = Spade::start_with(
        vec![
            Script::reply("Hello."),
            title(),
            Script::reply("Here is the summary."),
        ],
        Vec::new(),
        on(&clock),
    )
    .await?;
    let (agent, conversation) = told(&spade, "Hi").await?;
    act(&spade, &agent, "pause").await?;

    spade.say(&conversation, "Summarise the day").await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let events = spade.events(&conversation).await?;
    assert_eq!(
        count(&events, of_type("reply_started")),
        1,
        "nothing answers while paused: {:?}",
        types(&events)
    );
    let (_, roster) = spade.get("/v1/agents").await?;
    let listed = roster["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["id"] == agent.as_str()).cloned())
        .unwrap_or_default();
    assert_eq!(
        (&listed["state"], &listed["working"], &listed["status"]),
        (&json!("paused"), &json!(false), &json!("Paused")),
        "{listed}"
    );

    act(&spade, &agent, "resume").await?;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(count(&events, of_type("reply_started")), 2);
    assert_eq!(row(&spade, &agent).await?["reads"], "idle");
    Ok(())
}

fn pause_tool(ms: u64) -> Arc<dyn Tool> {
    Arc::new(FakeTool::new("pause", Risk::Read, "ok").slow(Duration::from_millis(ms)))
}

#[tokio::test]
async fn stop_from_the_running_view_stops_the_bot_and_its_workers() -> Result {
    let scripts = vec![
        Script::reply("Hello."),
        Script::reply("").plain(r#"{"title":"Lead"}"#),
        Script::reply("")
            .call(
                "make-Slow",
                "bot_create",
                json!({ "name": "Slow", "task": "Slow: find the sources." }),
            )
            .call("pause-Slow", "pause", json!({})),
        Script::reply("")
            .plain(r#"{"verdict":"approve","reason":"It makes a worker for the task."}"#),
        Script::reply("Never finished").held(Duration::from_secs(5)),
        Script::reply("Slow is working."),
    ];
    let options = Options {
        reviewer: None,
        ..Options::default()
    };
    let spade = Spade::start_with(scripts, vec![pause_tool(300)], options).await?;
    let lead = spade.new_agent("Lead", "").await?;
    let lead_id = lead["id"].as_str().unwrap_or_default().to_owned();
    let lead_chat = lead["conversation"].as_str().unwrap_or_default().to_owned();
    spade.say(&lead_chat, "Hi").await?;
    spade.wait_for(&lead_chat, "renamed").await?;
    spade.say(&lead_chat, "Start slow work").await?;
    spade
        .wait_for_count(&lead_chat, "reply_finished", 2)
        .await?;

    until("the lead's row shows its working worker", || async {
        let shown = row(&spade, &lead_id).await?;
        Ok(shown["reads"] == "working"
            && shown["workers"].as_array().is_some_and(|w| {
                w.len() == 1 && w[0]["name"] == "Slow" && w[0]["state"] == "working"
            }))
    })
    .await?;
    let shown = row(&spade, &lead_id).await?;
    assert_eq!(shown["actions"], json!(["stop", "pause"]), "{shown}");
    assert!(
        running(&spade).await?.iter().all(|r| r["name"] != "Slow"),
        "a worker is listed under its maker, not as a row of its own"
    );

    let stopped = act(&spade, &lead_id, "stop").await?;
    assert_eq!(stopped["changed"], true);
    let (_, roster) = spade.get("/v1/agents").await?;
    let slow_chat = roster["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["name"] == "Slow"))
        .and_then(|a| a["conversation"].as_str())
        .unwrap_or_default()
        .to_owned();
    spade.wait_for(&slow_chat, "reply_stopped").await?;
    until("the lead and its worker read idle", || async {
        let shown = row(&spade, &lead_id).await?;
        Ok(shown["reads"] == "idle"
            && shown["workers"]
                .as_array()
                .is_some_and(|w| w.iter().all(|w| w["state"] == "idle")))
    })
    .await?;
    Ok(())
}
