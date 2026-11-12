//! Routines and the heartbeat (ADR 0129): a bot is woken by its schedule, an ace thread event or
//! its webhook, once per slot, with missed slots caught up once and overlapping runs skipped.
//! Time is a hand-set clock; the timer's tick is driven by the test.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::clock::Ids;
use spade_server::routines;
use spade_testkit::{FakeProvider, Script};
use support::{FakeTool, ManualClock, Options, Result, Spade};
use tokio_tungstenite::tungstenite::Message;

/// Milliseconds of an RFC 3339 instant.
fn at(text: &str) -> i64 {
    text.parse::<jiff::Timestamp>()
        .unwrap_or_else(|e| panic!("{text}: {e}"))
        .as_millisecond()
}

/// Milliseconds of a wall time in `zone`.
fn local(zone: &str, text: &str) -> i64 {
    let civil: jiff::civil::DateTime = text.parse().unwrap_or_else(|e| panic!("{text}: {e}"));
    civil
        .in_tz(zone)
        .unwrap_or_else(|e| panic!("{text}: {e}"))
        .timestamp()
        .as_millisecond()
}

/// Ids that start past a first run's, so a restarted engine never reuses one.
struct LaterIds(AtomicU64);

impl Ids for LaterIds {
    fn next(&self, prefix: &str) -> String {
        format!("{prefix}_later_{}", self.0.fetch_add(1, Ordering::SeqCst))
    }
}

fn reply(text: &str) -> Script {
    Script::reply(text).plain(r#"{"title":"T"}"#)
}

async fn start(clock: &Arc<ManualClock>, scripts: Vec<Script>) -> Result<Spade> {
    start_with_tools(clock, scripts, Vec::new()).await
}

async fn start_with_tools(
    clock: &Arc<ManualClock>,
    scripts: Vec<Script>,
    tools: Vec<Arc<dyn spade_server::tools::Tool>>,
) -> Result<Spade> {
    let options = Options {
        clock: Some(clock.clone()),
        ..Options::default()
    };
    Spade::start_with(scripts, tools, options).await
}

/// Creates a bot and returns `(agent id, conversation id)`.
async fn bot(spade: &Spade) -> Result<(String, String)> {
    let agent = spade.new_agent("Scout", "Keeps an eye on things.").await?;
    Ok((
        agent["id"].as_str().unwrap_or_default().to_owned(),
        agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ))
}

async fn add_routine(spade: &Spade, agent: &str, body: Value) -> Result<Value> {
    let (status, body) = spade
        .post(&format!("/v1/agents/{agent}/routines"), body)
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok(body["routine"].clone())
}

async fn routine(spade: &Spade, id: &str) -> Result<Value> {
    let (status, body) = spade.get(&format!("/v1/routines/{id}")).await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["routine"].clone())
}

/// The routine messages in a conversation, as stored.
async fn fired(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    Ok(spade
        .events(conversation)
        .await?
        .into_iter()
        .filter(|e| e["type"] == "user_message" && e["from_routine"].is_object())
        .collect())
}

async fn tick(spade: &Spade) -> Result {
    routines::tick(&spade.engine).await?;
    Ok(())
}

#[tokio::test]
async fn a_schedule_wakes_the_bot_once_per_slot_even_across_a_restart() -> Result {
    let clock = ManualClock::at(at("2026-11-12T08:59:00Z"));
    let spade = start(&clock, vec![reply("Here is today's briefing.")]).await?;
    let (agent, conversation) = bot(&spade).await?;
    let made = add_routine(
        &spade,
        &agent,
        json!({ "name": "Daily briefing", "instruction": "Brief me on the day.",
                "trigger": { "kind": "schedule", "schedule": "daily at 9:00" },
                "time_zone": "UTC" }),
    )
    .await?;
    assert_eq!(made["words"], "Every day at 9:00");
    assert_eq!(made["next_run"], at("2026-11-12T09:00:00Z"));
    let id = made["id"].as_str().unwrap_or_default().to_owned();

    tick(&spade).await?;
    assert!(fired(&spade, &conversation).await?.is_empty());

    clock.set(at("2026-11-12T09:00:20Z"));
    tick(&spade).await?;
    tick(&spade).await?;
    let messages = fired(&spade, &conversation).await?;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["text"], "Brief me on the day.");
    assert_eq!(messages[0]["from_routine"]["name"], "Daily briefing");
    assert_eq!(messages[0]["from_routine"]["label"], "9:00");
    spade.wait_for(&conversation, "reply_finished").await?;
    let shown = routine(&spade, &id).await?;
    assert_eq!(shown["last_run"]["result"], "answered");
    assert_eq!(shown["last_run"]["cause"], "schedule");
    assert_eq!(shown["next_run"], at("2026-11-13T09:00:00Z"));

    // A restart in the same minute does not run the slot again.
    let options = Options {
        clock: Some(clock.clone()),
        ids: Some(Arc::new(LaterIds(AtomicU64::new(1)))),
        ..Options::default()
    };
    let spade = spade
        .restart_with(Vec::new(), vec![reply("Tomorrow's.")], options)
        .await?;
    tick(&spade).await?;
    assert_eq!(fired(&spade, &conversation).await?.len(), 1);

    clock.set(at("2026-11-13T09:00:05Z"));
    tick(&spade).await?;
    assert_eq!(fired(&spade, &conversation).await?.len(), 2);
    Ok(())
}

#[tokio::test]
async fn slots_missed_while_spade_was_down_run_once_as_caught_up() -> Result {
    let clock = ManualClock::at(at("2026-11-12T08:30:00Z"));
    let spade = start(&clock, vec![reply("Checked.")]).await?;
    let (agent, conversation) = bot(&spade).await?;
    let made = add_routine(
        &spade,
        &agent,
        json!({ "name": "Inbox", "instruction": "Check the inbox.",
                "trigger": { "kind": "schedule", "schedule": "every hour" },
                "time_zone": "UTC" }),
    )
    .await?;
    let id = made["id"].as_str().unwrap_or_default().to_owned();
    // Asleep from before 9:00 until 13:20: five slots passed.
    clock.set(at("2026-11-12T13:20:00Z"));
    tick(&spade).await?;
    tick(&spade).await?;
    let messages = fired(&spade, &conversation).await?;
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert_eq!(messages[0]["from_routine"]["label"], "caught up from 13:00");
    spade.wait_for(&conversation, "reply_finished").await?;
    let shown = routine(&spade, &id).await?;
    assert_eq!(shown["last_run"]["cause"], "caught_up");
    assert_eq!(shown["next_run"], at("2026-11-12T14:00:00Z"));
    Ok(())
}

#[tokio::test]
async fn a_daily_routine_keeps_its_wall_time_across_the_spring_change() -> Result {
    let zone = "America/New_York";
    let clock = ManualClock::at(local(zone, "2026-03-07T08:00"));
    let spade = start(&clock, vec![reply("Morning.")]).await?;
    let (agent, conversation) = bot(&spade).await?;
    let made = add_routine(
        &spade,
        &agent,
        json!({ "name": "Morning", "instruction": "Say good morning.",
                "trigger": { "kind": "schedule", "schedule": "daily at 9:00" },
                "time_zone": zone }),
    )
    .await?;
    let id = made["id"].as_str().unwrap_or_default().to_owned();
    clock.set(local(zone, "2026-03-07T09:00") + 10_000);
    tick(&spade).await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    let shown = routine(&spade, &id).await?;
    // The clocks spring forward overnight: the next 9:00 is 23 real hours later.
    assert_eq!(shown["next_run"], local(zone, "2026-03-08T09:00"));
    assert_eq!(
        shown["next_run"].as_i64().unwrap_or_default() - local(zone, "2026-03-07T09:00"),
        23 * 3_600_000
    );
    clock.set(local(zone, "2026-03-08T09:00") + 10_000);
    tick(&spade).await?;
    let messages = fired(&spade, &conversation).await?;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["from_routine"]["label"], "9:00");
    Ok(())
}

#[tokio::test]
async fn a_slot_that_comes_while_the_last_run_is_still_open_is_skipped_and_recorded() -> Result {
    let clock = ManualClock::at(at("2026-11-12T08:30:00Z"));
    // The run asks to send a note, which waits for the person: the run stays open.
    let note: Arc<dyn spade_server::tools::Tool> =
        Arc::new(FakeTool::new("send_note", Risk::Write, "sent"));
    let scripts = vec![
        reply("").call("call_1", "send_note", json!({ "text": "hi" })),
        reply("Done."),
    ];
    let spade = start_with_tools(&clock, scripts, vec![note]).await?;
    let (agent, conversation) = bot(&spade).await?;
    let made = add_routine(
        &spade,
        &agent,
        json!({ "name": "Notes", "instruction": "Send the note.",
                "trigger": { "kind": "schedule", "schedule": "every hour" },
                "time_zone": "UTC" }),
    )
    .await?;
    let id = made["id"].as_str().unwrap_or_default().to_owned();
    clock.set(at("2026-11-12T09:00:05Z"));
    tick(&spade).await?;
    spade.wait_for(&conversation, "approval_requested").await?;

    clock.set(at("2026-11-12T10:00:05Z"));
    tick(&spade).await?;
    assert_eq!(fired(&spade, &conversation).await?.len(), 1);
    let shown = routine(&spade, &id).await?;
    assert_eq!(shown["last_run"]["result"], "skipped");
    assert_eq!(shown["last_run"]["detail"], "The last run was still going.");
    assert_eq!(shown["next_run"], at("2026-11-12T11:00:00Z"));
    Ok(())
}

/// Titles go to a fake of their own, so they never take the bot's script.
async fn own_titles(spade: &Spade) -> Result<FakeProvider> {
    let fake =
        FakeProvider::start_sequence(vec![Script::reply("").plain(r#"{"title":"T"}"#)]).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Titles", "format": "openai-chat", "base_url": fake.root,
                    "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    Ok(fake)
}

async fn roster_preview(spade: &Spade, agent: &str) -> Result<Value> {
    let (_, list) = spade.get("/v1/agents").await?;
    Ok(list["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|a| a["id"] == agent))
        .map(|a| a["last_message"].clone())
        .unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_heartbeat_with_nothing_to_report_stays_silent_and_one_that_has_something_speaks()
-> Result {
    let clock = ManualClock::at(at("2026-11-12T10:00:00Z"));
    let spade = start(
        &clock,
        vec![Script::reply("[quiet]"), Script::reply("The build is red.")],
    )
    .await?;
    let _titles = own_titles(&spade).await?;
    let (agent, conversation) = bot(&spade).await?;
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{agent}/heartbeat"),
            json!({ "enabled": true, "every_minutes": 30, "checklist": "Is the build green?",
                    "quiet": { "start": "22:00", "end": "07:00" }, "time_zone": "UTC" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["heartbeat"]["next_run"], at("2026-11-12T10:30:00Z"));

    clock.set(at("2026-11-12T10:30:10Z"));
    tick(&spade).await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let beats = fired(&spade, &conversation).await?;
    assert_eq!(beats.len(), 1);
    assert_eq!(beats[0]["from_routine"]["heartbeat"], true);
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "[quiet]")
    );
    // Nothing to show: no preview in the roster, and the heartbeat says it stayed quiet.
    assert_eq!(roster_preview(&spade, &agent).await?, Value::Null);
    let (_, shown) = spade.get(&format!("/v1/agents/{agent}/heartbeat")).await?;
    assert_eq!(shown["heartbeat"]["last_run"]["result"], "quiet");

    clock.set(at("2026-11-12T11:00:10Z"));
    tick(&spade).await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(
        roster_preview(&spade, &agent).await?["text"],
        "The build is red."
    );

    // Quiet hours: the 23:00 beat is passed over without a message.
    clock.set(at("2026-11-12T23:00:10Z"));
    tick(&spade).await?;
    assert_eq!(fired(&spade, &conversation).await?.len(), 2);
    let (_, shown) = spade.get(&format!("/v1/agents/{agent}/heartbeat")).await?;
    assert_eq!(shown["heartbeat"]["next_run"], at("2026-11-12T23:30:00Z"));
    Ok(())
}

/// A stand-in for the daemon's WebSocket: welcomes Spade, answers its threads subscription with
/// one working thread, then reports that thread done.
async fn fake_daemon() -> Result<std::net::SocketAddr> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        let thread = |state: &str| json!({ "t1": { "id": "t1", "title": "Fix login", "status": { "state": state } } });
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            let message: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let frames = match message["type"].as_str() {
                Some("hello") => vec![json!({ "type": "welcome" })],
                Some("subscribe") => vec![
                    json!({ "type": "snapshot", "subscriptionId": message["subscriptionId"],
                            "seq": 1, "view": { "kind": "threads", "seq": 1,
                                                "threads": thread("working") } }),
                    json!({ "type": "threads.patch", "subscriptionId": message["subscriptionId"],
                            "seq": 2, "threads": thread("done"), "removed": [],
                            "window": { "before": null, "total": 1, "counts": [] } }),
                ],
                _ => Vec::new(),
            };
            for frame in frames {
                if socket.send(Message::text(frame.to_string())).await.is_err() {
                    return;
                }
            }
        }
    });
    Ok(addr)
}

#[tokio::test]
async fn an_ace_thread_finishing_wakes_the_bot_waiting_for_it() -> Result {
    let clock = ManualClock::at(at("2026-11-12T10:00:00Z"));
    let spade = start(&clock, vec![reply("I'll look at what it changed.")]).await?;
    let (agent, conversation) = bot(&spade).await?;
    add_routine(
        &spade,
        &agent,
        json!({ "name": "Review finished work", "instruction": "Review what the thread changed.",
                "trigger": { "kind": "event", "event": "thread_done" } }),
    )
    .await?;
    let addr = fake_daemon().await?;
    let config = spade_ace::SkillsConfig::new(
        spade_ace::LoopbackUrl::parse(&format!("ws://{addr}/"))?,
        spade_ace::Secret::new("local-token"),
        "spade",
        Duration::from_secs(5),
    )?;
    let watcher = routines::watch_ace(&spade.engine, move || Some(config.clone()));
    spade.wait_for(&conversation, "reply_finished").await?;
    watcher.abort();
    let messages = fired(&spade, &conversation).await?;
    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0]["from_routine"]["label"],
        "thread finished: Fix login"
    );
    assert!(messages[0]["from_routine"]["event"].is_string());
    Ok(())
}

#[tokio::test]
async fn a_webhook_runs_only_with_its_own_secret() -> Result {
    let clock = ManualClock::at(at("2026-11-12T10:00:00Z"));
    let spade = start(&clock, vec![reply("Deployed build noted.")]).await?;
    let (agent, conversation) = bot(&spade).await?;
    let made = add_routine(
        &spade,
        &agent,
        json!({ "name": "Deploy hook", "instruction": "A deploy finished; check it.",
                "trigger": { "kind": "webhook" } }),
    )
    .await?;
    let id = made["id"].as_str().unwrap_or_default();
    let secret = made["webhook"]["secret"].as_str().unwrap_or_default();
    assert!(secret.len() >= 32);
    let url = format!("{}/v1/routines/{id}/run", spade.base);
    let call = |bearer: Option<&str>| {
        let request = spade.http.post(&url);
        match bearer {
            Some(bearer) => request.bearer_auth(bearer),
            None => request,
        }
        .send()
    };
    assert_eq!(call(None).await?.status().as_u16(), 401);
    assert_eq!(call(Some("not-the-secret")).await?.status().as_u16(), 401);
    assert!(fired(&spade, &conversation).await?.is_empty());
    // The secret opens nothing else.
    let other = spade
        .http
        .get(format!("{}/v1/agents", spade.base))
        .bearer_auth(secret)
        .send()
        .await?;
    assert_eq!(other.status().as_u16(), 401);

    let response = call(Some(secret)).await?;
    assert_eq!(response.status().as_u16(), 202);
    let body: Value = response.json().await?;
    assert_eq!(body["run"]["cause"], "webhook");
    let messages = fired(&spade, &conversation).await?;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["from_routine"]["label"], "webhook");
    Ok(())
}

#[tokio::test]
async fn a_bot_creates_its_own_routine_once_the_person_approves() -> Result {
    let clock = ManualClock::at(at("2026-11-12T10:00:00Z"));
    let scripts = vec![
        reply("").call(
            "call_1",
            "routine_save",
            json!({ "name": "Morning", "instruction": "Brief me.", "schedule": "weekdays at 9:00",
                    "time_zone": "UTC" }),
        ),
        reply("Every weekday at 9:00 I'll brief you."),
    ];
    let spade = start(&clock, scripts).await?;
    let (agent, conversation) = bot(&spade).await?;
    spade
        .say(&conversation, "Brief me every weekday morning.")
        .await?;
    spade.wait_for(&conversation, "approval_requested").await?;
    let (_, before) = spade.get(&format!("/v1/agents/{agent}/routines")).await?;
    assert_eq!(before["routines"], json!([]));
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/call_1"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202);
    spade.wait_for(&conversation, "reply_finished").await?;
    let (_, after) = spade.get(&format!("/v1/agents/{agent}/routines")).await?;
    let saved = &after["routines"][0];
    assert_eq!(saved["words"], "Weekdays at 9:00");
    assert_eq!(saved["created_by"], "agent");
    // 2026-11-13 is a Friday.
    assert_eq!(saved["next_run"], at("2026-11-13T09:00:00Z"));
    Ok(())
}
