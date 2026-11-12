//! Per-bot spending caps, the model review and the activity log (ADR 0135), through the API with
//! a real database and a scripted fake model. Each model call costs 92 micros (11 tokens in at
//! $2/M, 7 out at $10/M).

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, ManualClock, Options, Result, Spade, types};

/// 2026-11-09T05:30:00Z: 23:30 on the 8th in Chicago, already the 9th in UTC.
const LATE_EVENING: i64 = 1_794_202_200_000;
const HOUR: i64 = 3_600_000;

async fn bot(spade: &Spade, name: &str) -> Result<(String, String)> {
    let agent = spade.new_agent(name, "Keeps the person's notes").await?;
    Ok((
        agent["id"].as_str().unwrap_or_default().to_owned(),
        agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ))
}

async fn caps(spade: &Spade, agent: &str, body: Value) -> Result<Value> {
    let (status, shown) = spade
        .put(&format!("/v1/agents/{agent}/oversight"), body)
        .await?;
    assert_eq!(status, 200, "{shown}");
    Ok(shown)
}

async fn roster_spending(spade: &Spade, agent: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    let found = body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["id"] == agent).cloned())
        .ok_or("the bot is not in the roster")?;
    Ok(found["spending"].clone())
}

async fn approve(spade: &Spade, conversation: &str, call: &str, always: bool) -> Result {
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/{call}"),
            json!({ "allowed": true, "always": always }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok(())
}

/// Waits until the conversation has no open reply.
async fn settled(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let events = spade.events(conversation).await?;
        let opened = events
            .iter()
            .filter(|e| e["type"] == "reply_started")
            .count();
        let closed = events
            .iter()
            .filter(|e| {
                matches!(
                    e["type"].as_str(),
                    Some("reply_finished" | "reply_failed" | "reply_stopped" | "reply_interrupted")
                )
            })
            .count();
        if opened > 0 && opened == closed {
            // Give the worker a moment to finish what it does after closing (title, cap note).
            tokio::time::sleep(Duration::from_millis(150)).await;
            return spade.events(conversation).await;
        }
        if Instant::now() > deadline {
            return Err(format!("still open: {}", types(&events).join(", ")).into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_bot_at_its_daily_cap_stops_before_its_next_model_call_and_says_so_once() -> Result {
    let noop = FakeTool::new("noop", Risk::Read, "nothing");
    let ran = noop.calls();
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "noop", json!({})),
            Script::reply("Never said"),
        ],
        vec![Arc::new(noop) as Arc<dyn Tool>],
    )
    .await?;
    let (agent, conversation) = bot(&spade, "Notes").await?;
    caps(&spade, &agent, json!({ "daily_cap_micros": 50 })).await?;

    spade.say(&conversation, "Tidy my notes").await?;
    let events = settled(&spade, &conversation).await?;
    assert_eq!(
        ran.lock().map(|c| c.len()).unwrap_or(0),
        1,
        "the first step's call ran"
    );
    assert_eq!(
        spade.fake.seen().len(),
        1,
        "no second step and no title once capped"
    );
    assert_eq!(
        events.iter().filter(|e| e["type"] == "cap_reached").count(),
        1
    );
    let cap = events
        .iter()
        .find(|e| e["type"] == "cap_reached")
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        (cap["scope"].clone(), cap["cap_micros"].clone()),
        (json!("daily"), json!(50))
    );

    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Again?" }),
        )
        .await?;
    assert_eq!(status, 402);
    assert_eq!(
        body["error"], "Notes is at its daily cap of $0.0001 until midnight.",
        "the refusal says which cap"
    );
    assert_eq!(spade.fake.seen().len(), 1);
    let spending = roster_spending(&spade, &agent).await?;
    assert_eq!(spending["capped"], "daily");
    assert_eq!(spending["today_micros"], 92);
    assert_eq!(spending["daily_cap_micros"], 50);
    Ok(())
}

#[tokio::test]
async fn a_daily_cap_lifts_at_the_persons_midnight_not_the_machines() -> Result {
    let clock = ManualClock::at(LATE_EVENING);
    let spade = Spade::start_with(
        vec![Script::reply("First"), Script::reply("Second")],
        Vec::new(),
        Options {
            clock: Some(clock.clone()),
            ..Options::default()
        },
    )
    .await?;
    let (status, body) = spade
        .put("/v1/oversight", json!({ "time_zone": "America/Chicago" }))
        .await?;
    assert_eq!(
        (status, body["oversight"]["time_zone"].clone()),
        (200, json!("America/Chicago"))
    );
    let (agent, conversation) = bot(&spade, "Notes").await?;
    caps(&spade, &agent, json!({ "daily_cap_micros": 50 })).await?;
    spade.say(&conversation, "One").await?;
    settled(&spade, &conversation).await?;
    let spending = roster_spending(&spade, &agent).await?;
    assert_eq!(spending["capped"], "daily");
    // Chicago's next midnight is 06:00 UTC on the 9th.
    assert_eq!(spending["resets_at"], LATE_EVENING + HOUR / 2);

    // Still the 9th in UTC, still the 8th in Chicago: capped.
    clock.set(LATE_EVENING + HOUR / 2 - 60_000);
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Two" }),
        )
        .await?;
    assert_eq!(status, 402);

    // Past Chicago's midnight, the same UTC day: a new day for the person.
    clock.set(LATE_EVENING + HOUR / 2 + 60_000);
    spade.say(&conversation, "Two").await?;
    let events = settled(&spade, &conversation).await?;
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "Second")
    );
    Ok(())
}

#[tokio::test]
async fn a_monthly_cap_holds_across_days_until_the_month_ends() -> Result {
    let clock = ManualClock::at(LATE_EVENING);
    let spade = Spade::start_with(
        vec![Script::reply("First"), Script::reply("Next month")],
        Vec::new(),
        Options {
            clock: Some(clock.clone()),
            ..Options::default()
        },
    )
    .await?;
    spade
        .put("/v1/oversight", json!({ "time_zone": "America/Chicago" }))
        .await?;
    let (agent, conversation) = bot(&spade, "Notes").await?;
    caps(&spade, &agent, json!({ "monthly_cap_micros": 50 })).await?;
    spade.say(&conversation, "One").await?;
    settled(&spade, &conversation).await?;
    clock.set(LATE_EVENING + 5 * 24 * HOUR);
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Two" }),
        )
        .await?;
    assert_eq!(status, 402);
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|e| e.contains("monthly cap")),
        "{body}"
    );
    // 2026-12-01T06:00:00Z is Chicago's December.
    clock.set(1_796_104_800_000 + 60_000);
    spade.say(&conversation, "Two").await?;
    let events = settled(&spade, &conversation).await?;
    assert!(events.iter().any(|e| e["text"] == "Next month"));
    Ok(())
}

/// A write the person allowed "always" in a first turn, then called again in a second.
async fn always_allowed_write(
    review_on: bool,
    second_turn: Vec<Script>,
) -> Result<(Spade, String, Arc<std::sync::Mutex<Vec<Value>>>)> {
    let send = FakeTool::new("send_email", Risk::Write, "Sent");
    let sent = send.calls();
    let mut scripts = vec![
        Script::reply("").call("c1", "send_email", json!({ "to": "sam@example.com" })),
        Script::reply("Sent it."),
        Script::reply("").plain(r#"{"title":"Email"}"#),
        Script::reply("").call("c2", "send_email", json!({ "to": "everyone@example.com" })),
    ];
    scripts.extend(second_turn);
    let spade = Spade::start(scripts, vec![Arc::new(send) as Arc<dyn Tool>]).await?;
    let (_, conversation) = bot(&spade, "Mail").await?;
    spade.say(&conversation, "Email Sam the minutes").await?;
    spade.wait_for(&conversation, "approval_requested").await?;
    approve(&spade, &conversation, "c1", true).await?;
    settled(&spade, &conversation).await?;
    if review_on {
        let (status, _) = spade
            .put("/v1/oversight", json!({ "review_default": true }))
            .await?;
        assert_eq!(status, 200);
    }
    spade.say(&conversation, "Now the rest").await?;
    Ok((spade, conversation, sent))
}

#[tokio::test]
async fn the_review_escalates_a_write_it_judges_wrong_with_its_reason() -> Result {
    let (spade, conversation, sent) = always_allowed_write(
        true,
        vec![Script::reply("").plain(
            r#"{"verdict":"escalate","reason":"The person asked to email Sam, not everyone."}"#,
        )],
    )
    .await?;
    let events = spade
        .wait_for_count(&conversation, "approval_requested", 2)
        .await?;
    let review = events
        .iter()
        .find(|e| e["type"] == "call_reviewed")
        .cloned()
        .ok_or("no verdict stored")?;
    assert_eq!(review["verdict"], "escalate");
    assert_eq!(review["call_id"], "c2");
    assert_eq!(
        review["reason"],
        "The person asked to email Sam, not everyone."
    );
    let asked_at = events
        .iter()
        .rposition(|e| e["type"] == "approval_requested");
    let reviewed_at = events.iter().position(|e| e["type"] == "call_reviewed");
    assert!(
        reviewed_at < asked_at,
        "the verdict is stored before the question"
    );
    assert_eq!(
        sent.lock().map(|c| c.len()).unwrap_or(0),
        1,
        "the second email waits"
    );
    // The review read the person's words and the call.
    let asked = spade
        .fake
        .seen()
        .last()
        .map(|s| s.body.to_string())
        .unwrap_or_default();
    assert!(asked.contains("Now the rest") && asked.contains("everyone@example.com"));
    // Its verdict is in the activity log.
    let (_, agents) = spade.get("/v1/agents").await?;
    let agent = agents["agents"]
        .as_array()
        .and_then(|l| {
            l.iter()
                .find(|a| a["conversation"] == conversation.as_str())
                .cloned()
        })
        .ok_or("no agent")?;
    let (_, log) = spade
        .get(&format!(
            "/v1/agents/{}/activity?kind=review",
            agent["id"].as_str().unwrap_or("")
        ))
        .await?;
    assert_eq!(log["entries"][0]["outcome"], "escalated");
    Ok(())
}

#[tokio::test]
async fn a_write_the_review_allows_runs_and_its_verdict_is_kept() -> Result {
    let (spade, conversation, sent) = always_allowed_write(
        true,
        vec![
            Script::reply("").plain(r#"{"verdict":"allow","reason":"It is what was asked."}"#),
            Script::reply("Done."),
        ],
    )
    .await?;
    let events = settled(&spade, &conversation).await?;
    assert_eq!(sent.lock().map(|c| c.len()).unwrap_or(0), 2);
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "call_reviewed" && e["verdict"] == "allow")
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "approval_requested")
            .count(),
        1
    );
    Ok(())
}

#[tokio::test]
async fn with_the_review_off_no_extra_model_call_is_made() -> Result {
    let (spade, conversation, sent) =
        always_allowed_write(false, vec![Script::reply("Done.")]).await?;
    let events = settled(&spade, &conversation).await?;
    assert_eq!(sent.lock().map(|c| c.len()).unwrap_or(0), 2);
    assert!(!events.iter().any(|e| e["type"] == "call_reviewed"));
    // Turn one: two steps and a title; turn two: two steps. Nothing else.
    assert_eq!(spade.fake.seen().len(), 5);
    Ok(())
}

#[tokio::test]
async fn the_review_can_never_let_through_a_call_the_gate_asks_about() -> Result {
    let send = FakeTool::new("send_email", Risk::Write, "Sent");
    let wipe = FakeTool::new("wipe", Risk::Destructive, "Wiped");
    let (sent, wiped) = (send.calls(), wipe.calls());
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call("c1", "send_email", json!({ "to": "sam@example.com" }))
                .call("c2", "wipe", json!({})),
            // Were a review asked, it would allow.
            Script::reply("").plain(r#"{"verdict":"allow","reason":"Fine."}"#),
        ],
        vec![Arc::new(send) as Arc<dyn Tool>, Arc::new(wipe)],
    )
    .await?;
    spade
        .put("/v1/oversight", json!({ "review_default": true }))
        .await?;
    let (_, conversation) = bot(&spade, "Mail").await?;
    spade
        .say(&conversation, "Email Sam and wipe the drafts")
        .await?;
    let events = spade
        .wait_for_count(&conversation, "approval_requested", 2)
        .await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!events.iter().any(|e| e["type"] == "call_reviewed"));
    assert_eq!(spade.fake.seen().len(), 1, "no review call");
    assert_eq!(sent.lock().map(|c| c.len()).unwrap_or(0), 0);
    assert_eq!(wiped.lock().map(|c| c.len()).unwrap_or(0), 0);
    Ok(())
}

#[tokio::test]
async fn the_activity_log_lists_what_a_bot_did_filtered_and_without_secrets() -> Result {
    let fetch = FakeTool::new("web_fetch", Risk::Read, "A page");
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call(
                    "c1",
                    "web_fetch",
                    json!({ "url": "https://example.com/report", "api_key": "sk-live-abcdef1234567890" }),
                ),
            Script::reply("Read it."),
        ],
        vec![Arc::new(fetch) as Arc<dyn Tool>],
    )
    .await?;
    let (agent, conversation) = bot(&spade, "Reader").await?;
    spade.say(&conversation, "Read the report").await?;
    settled(&spade, &conversation).await?;

    let (status, log) = spade.get(&format!("/v1/agents/{agent}/activity")).await?;
    assert_eq!(status, 200);
    assert!(!log.to_string().contains("sk-live"), "{log}");
    let kinds: Vec<&str> = log["entries"]
        .as_array()
        .map(|l| l.iter().filter_map(|e| e["kind"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(
        kinds.first(),
        Some(&"spend"),
        "newest first: {kinds:?} {log}"
    );
    assert!(kinds.contains(&"tool"));

    let (_, tools) = spade
        .get(&format!("/v1/agents/{agent}/activity?kind=tool&q=REPORT"))
        .await?;
    assert_eq!(tools["entries"].as_array().map(Vec::len), Some(1));
    assert_eq!(tools["entries"][0]["name"], "web_fetch");
    assert_eq!(tools["entries"][0]["outcome"], "ok");
    let (_, none) = spade
        .get(&format!("/v1/agents/{agent}/activity?day=2001-01-01"))
        .await?;
    assert_eq!(none["entries"].as_array().map(Vec::len), Some(0));
    let (status, _) = spade
        .get(&format!("/v1/agents/{agent}/activity?kind=nonsense"))
        .await?;
    assert_eq!(status, 400);
    let (status, _) = spade.get("/v1/agents/nobody/activity").await?;
    assert_eq!(status, 404);
    Ok(())
}

#[tokio::test]
async fn compacting_by_hand_is_refused_for_a_bot_at_its_cap() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("One"),
            Script::reply("").plain(r#"{"title":"Notes"}"#),
            Script::reply("Two"),
        ],
        Vec::new(),
    )
    .await?;
    let (agent, conversation) = bot(&spade, "Notes").await?;
    spade.say(&conversation, "First").await?;
    settled(&spade, &conversation).await?;
    spade.say(&conversation, "Second").await?;
    settled(&spade, &conversation).await?;
    caps(&spade, &agent, json!({ "daily_cap_micros": 50 })).await?;
    let calls = spade.fake.seen().len();
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/compact"),
            json!({}),
        )
        .await?;
    assert_eq!(status, 402, "{body}");
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|e| e.contains("daily cap")),
        "{body}"
    );
    assert_eq!(spade.fake.seen().len(), calls, "no summary was asked for");
    Ok(())
}

#[tokio::test]
async fn the_service_cap_lifts_at_the_persons_midnight_too() -> Result {
    let clock = ManualClock::at(LATE_EVENING);
    let spade = Spade::start_with(
        vec![
            Script::reply("First"),
            Script::reply("").plain(r#"{"title":"Notes"}"#),
            Script::reply("Second"),
        ],
        Vec::new(),
        Options {
            clock: Some(clock.clone()),
            // 100 micros: one reply and its title use it up.
            cap_usd: 0.0001,
            ..Options::default()
        },
    )
    .await?;
    spade
        .put("/v1/oversight", json!({ "time_zone": "America/Chicago" }))
        .await?;
    let (_, conversation) = bot(&spade, "Notes").await?;
    spade.say(&conversation, "One").await?;
    settled(&spade, &conversation).await?;
    clock.set(LATE_EVENING + HOUR / 2 - 60_000);
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Two" }),
        )
        .await?;
    assert_eq!(status, 402, "still the 8th in Chicago");
    let (_, view) = spade.get("/v1/oversight").await?;
    assert_eq!(view["oversight"]["today_micros"], 184);
    // Chicago's 9th, though UTC's day has not changed.
    clock.set(LATE_EVENING + HOUR / 2 + 60_000);
    let (_, view) = spade.get("/v1/oversight").await?;
    assert_eq!(
        view["oversight"]["today_micros"], 0,
        "the view and the cap agree"
    );
    spade.say(&conversation, "Two").await?;
    let events = settled(&spade, &conversation).await?;
    assert!(events.iter().any(|e| e["text"] == "Second"));
    Ok(())
}

#[tokio::test]
async fn a_long_history_is_read_a_bounded_part_at_a_time_and_paged_to_its_start() -> Result {
    let fetch = FakeTool::new("web_fetch", Risk::Read, "A page");
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call(
                    "c1",
                    "web_fetch",
                    json!({ "url": "https://example.com/one" }),
                )
                .call(
                    "c2",
                    "web_fetch",
                    json!({ "url": "https://example.com/two" }),
                ),
            Script::reply("Read them."),
        ],
        vec![Arc::new(fetch) as Arc<dyn Tool>],
    )
    .await?;
    let (agent, conversation) = bot(&spade, "Reader").await?;
    spade.say(&conversation, "Read both").await?;
    settled(&spade, &conversation).await?;
    // Then a long stretch with nothing for the log: 25,000 checkpoints of a later reply.
    let store = spade_store::Store::open(&spade.database())?;
    let filler: Vec<spade_core::Event> = (0..25_000)
        .map(|_| spade_core::Event::reply_progress("r_late", "…"))
        .collect();
    store.append_all(&conversation, &filler, 1)?;

    // The first request reads at most 20,000 events: it finds nothing yet, and says where to
    // go on rather than reading the whole history at once.
    let (status, first) = spade.get(&format!("/v1/agents/{agent}/activity")).await?;
    assert_eq!(status, 200);
    assert_eq!(
        first["entries"].as_array().map(Vec::len),
        Some(0),
        "{first}"
    );
    assert_eq!(first["more"], true);
    let next = first["next_before"].as_i64().ok_or("no cursor")?;

    // Following the cursor one entry at a time reaches every entry once, newest first, each
    // with its arguments (the step that made the call is read with it).
    let mut seen = Vec::new();
    let mut before = Some(next);
    let mut requests = 0;
    while let Some(cursor) = before {
        let (_, page) = spade
            .get(&format!(
                "/v1/agents/{agent}/activity?kind=tool&limit=1&before={cursor}"
            ))
            .await?;
        for entry in page["entries"].as_array().cloned().unwrap_or_default() {
            seen.push(entry["summary"].as_str().unwrap_or("").to_owned());
        }
        before = page["next_before"].as_i64();
        assert!(seen.len() <= 4, "paging never repeats: {seen:?}");
        requests += 1;
        assert!(requests < 20, "the cursor always moves on");
    }
    assert_eq!(
        seen,
        vec![
            "url: https://example.com/two",
            "url: https://example.com/one"
        ]
    );
    Ok(())
}

#[tokio::test]
async fn a_step_stopped_mid_stream_is_still_paid_for() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply(&"word ".repeat(40))
                .chunks(40)
                .delay(Duration::from_millis(40)),
        ],
        Vec::new(),
    )
    .await?;
    let (agent, conversation) = bot(&spade, "Talker").await?;
    spade.say(&conversation, "Talk").await?;
    spade.wait_for(&conversation, "reply_progress").await?;
    let (status, _) = spade
        .post(&format!("/v1/conversations/{conversation}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202);
    settled(&spade, &conversation).await?;
    // No usage came (the stream was cut), but its prompt and what streamed are charged, on
    // top of the title asked for afterwards (92).
    let spending = roster_spending(&spade, &agent).await?;
    assert!(
        spending["today_micros"].as_u64().is_some_and(|m| m > 92),
        "{spending}"
    );
    Ok(())
}

/// Events for a stored history, built by hand.
mod history {
    use serde_json::json;
    use spade_core::Event;
    use spade_core::event::{Call, Known, Tokens};

    pub fn step(reply: &str, call: &str, name: &str, url: &str) -> Event {
        Event::Known(Known::StepFinished {
            reply: reply.into(),
            text: String::new(),
            calls: vec![Call {
                id: call.into(),
                name: name.into(),
                arguments: json!({ "url": url }),
            }],
            thoughts: Vec::new(),
            usage: Tokens::default(),
            cost_micros: 0,
            seen: None,
        })
    }

    pub fn started(reply: &str, call: &str, name: &str, background: bool) -> Event {
        Event::Known(Known::ToolStarted {
            reply: reply.into(),
            call_id: call.into(),
            name: name.into(),
            risk: None,
            background,
        })
    }

    pub fn finished(reply: &str, call: &str, name: &str) -> Event {
        Event::Known(Known::ToolFinished {
            reply: reply.into(),
            call_id: call.into(),
            name: name.into(),
            content: "done".into(),
            is_error: false,
            uncertain: false,
            images: Vec::new(),
            untrusted: false,
        })
    }

    pub fn closed(reply: &str) -> Event {
        Event::Known(Known::ReplyFinished {
            reply: reply.into(),
            text: String::new(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        })
    }
}

#[tokio::test]
async fn a_job_started_below_the_cursor_shows_how_it_ended_above_it() -> Result {
    use spade_core::event::Known;
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (agent, conversation) = bot(&spade, "Worker").await?;
    let store = spade_store::Store::open(&spade.database())?;
    let base = store.last_seq(&conversation)?;
    store.append_all(
        &conversation,
        &[
            spade_core::Event::reply_started("r1", "fake/m"),
            history::step("r1", "c1", "slow_job", "https://example.com/a"),
            history::started("r1", "c1", "slow_job", true),
            spade_core::Event::Known(Known::JobStarted {
                reply: "r1".into(),
                job: "c1".into(),
                name: "slow_job".into(),
            }),
            history::finished("r1", "c1", "slow_job"),
            history::closed("r1"),
            spade_core::Event::Known(Known::JobFinished {
                job: "c1".into(),
                name: "slow_job".into(),
                content: "All done".into(),
                is_error: false,
                uncertain: false,
                files: Vec::new(),
            }),
        ],
        1,
    )?;
    // The page below the job's end.
    let ended = base + 7;
    let (_, page) = spade
        .get(&format!(
            "/v1/agents/{agent}/activity?kind=tool&before={ended}"
        ))
        .await?;
    assert_eq!(page["entries"][0]["name"], "slow_job", "{page}");
    assert_eq!(page["entries"][0]["outcome"], "ok", "{page}");
    Ok(())
}

#[tokio::test]
async fn a_day_filter_keeps_the_entries_at_a_read_windows_edge() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let (agent, conversation) = bot(&spade, "Night").await?;
    let store = spade_store::Store::open(&spade.database())?;
    // 2026-11-12 in UTC (the zone when none is set).
    let midnight = 1_794_441_600_000;
    // A turn that starts the evening before and fetches just after midnight…
    store.append_all(
        &conversation,
        &[
            spade_core::Event::reply_started("r1", "fake/m"),
            history::step("r1", "c1", "web_fetch", "https://example.com/night"),
        ],
        midnight - 1_000,
    )?;
    store.append_all(
        &conversation,
        &[
            history::started("r1", "c1", "web_fetch", false),
            history::finished("r1", "c1", "web_fetch"),
            history::closed("r1"),
        ],
        midnight + 1_000,
    )?;
    // …then a long stretch, and a later turn the same day. The first window read starts at the
    // night turn's step, cutting it.
    // 2,000 events back from the end lands on the night turn's step (written before midnight).
    let filler = 1_991;
    let mut later: Vec<spade_core::Event> = (0..filler)
        .map(|_| spade_core::Event::reply_progress("r1", "…"))
        .collect();
    later.extend([
        spade_core::Event::reply_started("r2", "fake/m"),
        history::step("r2", "c2", "web_fetch", "https://example.com/day"),
        history::started("r2", "c2", "web_fetch", false),
        history::finished("r2", "c2", "web_fetch"),
        history::closed("r2"),
    ]);
    store.append_all(&conversation, &later, midnight + 3_600_000)?;

    let mut urls = Vec::new();
    let mut before: Option<i64> = None;
    for _ in 0..10 {
        let cursor = before.map_or_else(String::new, |b| format!("&before={b}"));
        let (_, page) = spade
            .get(&format!(
                "/v1/agents/{agent}/activity?kind=tool&day=2026-11-12{cursor}"
            ))
            .await?;
        for entry in page["entries"].as_array().cloned().unwrap_or_default() {
            urls.push(entry["summary"].as_str().unwrap_or("").to_owned());
        }
        before = page["next_before"].as_i64();
        if before.is_none() {
            break;
        }
    }
    assert_eq!(
        urls,
        vec![
            "url: https://example.com/day",
            "url: https://example.com/night"
        ]
    );
    Ok(())
}
