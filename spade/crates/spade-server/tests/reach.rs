//! Reaching the person (ADR 0195) through the real API: the notice stream says which notices
//! interrupt now and which wait, do not disturb and the budget hold what they should, quiet's
//! end sends one summary, the morning brief lists what finished, and an unusual spend rate
//! alerts once. Scripted models; a clock the test sets where time matters.

mod support;

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use spade_testkit::Script;
use support::{ManualClock, Options, Result, Spade};

const HOUR_MS: i64 = 3_600_000;
/// 2026-11-19T07:00:00Z.
const MORNING_MS: i64 = 1_763_535_600_000;

type Notices = std::pin::Pin<Box<dyn futures_util::Stream<Item = reqwest::Result<Vec<u8>>>>>;

async fn listen(spade: &Spade) -> Result<Notices> {
    let response = spade
        .http
        .get(format!("{}/v1/notices/live", spade.base))
        .bearer_auth(support::TOKEN)
        .send()
        .await?;
    assert_eq!(response.status(), 200);
    Ok(Box::pin(
        response
            .bytes_stream()
            .map(|chunk| chunk.map(|b| b.to_vec())),
    ))
}

/// Reads notices until one matches `wanted`, for at most 10 s; answers every notice read.
async fn until_notice(body: &mut Notices, wanted: impl Fn(&Value) -> bool) -> Vec<Value> {
    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let parsed = |text: &str| -> Vec<Value> {
        text.lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|d| serde_json::from_str(d).ok())
            .collect()
    };
    while !parsed(&text).iter().any(&wanted) && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), body.next()).await {
            Ok(Some(Ok(chunk))) => text.push_str(&String::from_utf8_lossy(&chunk)),
            _ => break,
        }
    }
    parsed(&text)
}

async fn bot(spade: &Spade, name: &str) -> Result<(String, String)> {
    let agent = spade.new_agent(name, "").await?;
    Ok((
        agent["id"].as_str().unwrap_or_default().to_owned(),
        agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ))
}

async fn reach(spade: &Spade, change: Value) -> Result<Value> {
    let (status, body) = spade.put("/v1/reach", change).await?;
    assert_eq!(status, 200, "{body}");
    Ok(body)
}

/// A routine that runs now and whose reply says something.
async fn run_routine(spade: &Spade, agent: &str, name: &str) -> Result {
    let (status, made) = spade
        .post(
            &format!("/v1/agents/{agent}/routines"),
            json!({ "name": name, "instruction": "Check the deploy.",
                    "trigger": { "kind": "schedule", "schedule": "daily at 9:00" },
                    "time_zone": "UTC" }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let id = made["routine"]["id"].as_str().unwrap_or_default();
    let (status, body) = spade
        .post(&format!("/v1/routines/{id}/run"), json!({}))
        .await?;
    assert_eq!(status, 202, "{body}");
    Ok(())
}

fn about(notice: &Value) -> (Value, Value, Value) {
    (
        notice["category"].clone(),
        notice["reach"].clone(),
        notice["why"].clone(),
    )
}

#[tokio::test]
async fn a_bots_question_notifies_once_and_names_the_request_it_opens() -> Result {
    let spade = Spade::start(
        vec![Script::reply("").call("q2", "ask_user", json!({ "question": "Window or aisle?" }))],
        Vec::new(),
    )
    .await?;
    let (id, conversation) = bot(&spade, "Booker").await?;
    let mut body = listen(&spade).await?;
    spade.say(&conversation, "Book me a seat").await?;
    let notices = until_notice(&mut body, |n| n["type"] == "question_asked").await;
    let asked: Vec<&Value> = notices
        .iter()
        .filter(|n| n["type"] == "question_asked")
        .collect();
    assert_eq!(asked.len(), 1, "{notices:?}");
    let notice = asked[0];
    assert_eq!(
        about(notice),
        (json!("needs_you"), json!("now"), Value::Null)
    );
    assert_eq!(notice["request"], "q2");
    assert_eq!(notice["agent"], id.as_str());
    assert_eq!(notice["conversation"], conversation.as_str());
    assert_eq!(
        notice["id"],
        format!("event:{conversation}:{}", notice["seq"]).as_str(),
        "a stable id, so every window and device shows it once"
    );
    Ok(())
}

#[tokio::test]
async fn do_not_disturb_holds_proactive_messages_but_not_a_stop() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("The deploy is red.").plain(r#"{"title":"Deploy"}"#),
            Script::failing(400),
        ],
        Vec::new(),
    )
    .await?;
    let (id, conversation) = bot(&spade, "Scout").await?;
    let set = reach(&spade, json!({ "dnd": true })).await?;
    assert_eq!(set["quiet"], "dnd");
    let mut body = listen(&spade).await?;
    run_routine(&spade, &id, "Deploy check").await?;
    let notices = until_notice(&mut body, |n| n["category"] == "routine").await;
    let routine = notices
        .iter()
        .find(|n| n["category"] == "routine")
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        about(&routine),
        (json!("routine"), json!("held"), json!("dnd"))
    );
    assert_eq!(routine["text"], "Deploy check: The deploy is red.");

    spade.wait_for(&conversation, "renamed").await?;
    spade.say(&conversation, "Again").await?;
    let notices = until_notice(&mut body, |n| n["type"] == "reply_failed").await;
    let failed = notices
        .iter()
        .find(|n| n["type"] == "reply_failed")
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        about(&failed),
        (json!("escalation"), json!("now"), Value::Null)
    );
    assert_eq!(failed["level"], "stop");

    // Turning it off sends one summary of what waited.
    reach(&spade, json!({ "dnd": false })).await?;
    let notices = until_notice(&mut body, |n| n["kind"] == "summary").await;
    let summary: Vec<&Value> = notices.iter().filter(|n| n["kind"] == "summary").collect();
    assert_eq!(summary.len(), 1, "{notices:?}");
    assert_eq!(
        about(summary[0]),
        (json!("summary"), json!("now"), Value::Null)
    );
    assert_eq!(
        summary[0]["text"],
        "While you were away: 1 update from Scout."
    );
    assert_eq!(summary[0]["agent"], id.as_str());
    Ok(())
}

#[tokio::test]
async fn the_budget_sends_the_rest_to_the_digest() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("First finding.").plain(r#"{"title":"Watch"}"#),
            Script::reply("Second finding."),
        ],
        Vec::new(),
    )
    .await?;
    let (id, conversation) = bot(&spade, "Scout").await?;
    reach(&spade, json!({ "budget": { "per_hour": 1 } })).await?;
    let mut body = listen(&spade).await?;
    run_routine(&spade, &id, "Watch").await?;
    until_notice(&mut body, |n| n["category"] == "routine").await;
    spade.wait_for(&conversation, "renamed").await?;
    run_routine(&spade, &id, "Watch again").await?;
    let notices = until_notice(&mut body, |n| {
        n["category"] == "routine" && n["text"] == "Watch again: Second finding."
    })
    .await;
    let second = notices
        .iter()
        .find(|n| n["text"] == "Watch again: Second finding.")
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        about(&second),
        (json!("routine"), json!("held"), json!("budget"))
    );

    let (status, digest) = spade
        .post(&format!("/v1/agents/{id}/digests"), json!({}))
        .await?;
    assert_eq!(status, 201, "{digest}");
    assert_eq!(
        digest["digest"]["digest"]["away"],
        json!(["Scout: Watch again: Second finding."])
    );
    let text = digest["digest"]["text"].as_str().unwrap_or_default();
    assert!(
        text.contains("While you were away:\n- Scout: Watch again: Second finding."),
        "{text}"
    );
    let (_, after) = spade.get("/v1/reach").await?;
    assert_eq!(
        after["held"], 1,
        "the digest told what waited; its own notice is past the budget too and waits"
    );
    Ok(())
}

#[tokio::test]
async fn nothing_reaches_the_person_from_a_bot_whose_notifications_are_off() -> Result {
    let spade = Spade::start(
        vec![Script::reply("").call("q1", "ask_user", json!({ "question": "Which one?" }))],
        Vec::new(),
    )
    .await?;
    let (id, conversation) = bot(&spade, "Quiet one").await?;
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{id}/reach"),
            json!({ "notify": false }),
        )
        .await?;
    assert_eq!((status, body["notify"].clone()), (200, json!(false)));
    let mut stream = listen(&spade).await?;
    spade.say(&conversation, "Pick").await?;
    let notices = until_notice(&mut stream, |n| n["type"] == "question_asked").await;
    let asked = notices
        .iter()
        .find(|n| n["type"] == "question_asked")
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        about(&asked),
        (json!("needs_you"), json!("none"), json!("bot_off"))
    );
    Ok(())
}

#[tokio::test]
async fn the_morning_brief_lists_what_finished_overnight_in_the_main_chat() -> Result {
    let clock = ManualClock::at(MORNING_MS - 6 * HOUR_MS);
    let options = Options {
        clock: Some(clock.clone()),
        ..Options::default()
    };
    let spade = Spade::start_with(
        vec![Script::reply("All green overnight.").plain(r#"{"title":"Night"}"#)],
        Vec::new(),
        options,
    )
    .await?;
    spade
        .put("/v1/oversight", json!({ "time_zone": "UTC" }))
        .await?;
    let (id, conversation) = bot(&spade, "Night watch").await?;
    let mut body = listen(&spade).await?;
    run_routine(&spade, &id, "Nightly check").await?;
    spade.wait_for(&conversation, "renamed").await?;

    // 07:00 is the brief's time; the timer looks again when a setting changes.
    clock.set(MORNING_MS + 60_000);
    reach(&spade, json!({ "brief": { "on": true, "at": 420 } })).await?;
    let notices = until_notice(&mut body, |n| n["kind"] == "brief").await;
    let brief = notices
        .iter()
        .find(|n| n["kind"] == "brief")
        .cloned()
        .unwrap_or_default();
    assert_eq!(about(&brief), (json!("brief"), json!("now"), Value::Null));
    assert!(
        brief["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("1 finished"),
        "{brief}"
    );
    let main = brief["agent"].as_str().unwrap_or_default().to_owned();
    let (_, listed) = spade.get(&format!("/v1/digests?agent={main}")).await?;
    let row = listed["digests"][0].clone();
    assert_eq!(row["kind"], "brief");
    let finished = &row["digest"]["finished"][0];
    assert_eq!(finished["text"], "Nightly check: All green overnight.");
    assert_eq!(finished["conversation"], conversation.as_str());
    assert!(
        finished["seq"].as_i64().unwrap_or(0) > 0,
        "it opens the reply it came from"
    );
    let text = row["text"].as_str().unwrap_or_default();
    assert!(
        text.contains("- Night watch: Nightly check: All green overnight."),
        "{text}"
    );

    // Once a day: another look the same morning makes no second brief.
    reach(&spade, json!({ "brief": { "on": true } })).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (_, again) = spade.get(&format!("/v1/digests?agent={main}")).await?;
    let briefs = again["digests"]
        .as_array()
        .map_or(0, |d| d.iter().filter(|r| r["kind"] == "brief").count());
    assert_eq!(briefs, 1);
    Ok(())
}

#[tokio::test]
async fn an_unusual_spend_rate_alerts_once() -> Result {
    let clock = ManualClock::at(MORNING_MS);
    let options = Options {
        clock: Some(clock.clone()),
        ..Options::default()
    };
    let spade = Spade::start_with(Vec::new(), Vec::new(), options).await?;
    let (id, conversation) = bot(&spade, "Spender").await?;
    let mut body = listen(&spade).await?;
    {
        let db = rusqlite::Connection::open(spade.database())?;
        for hour in 1..=24 {
            db.execute(
                "INSERT INTO spend (conversation_id, model, role, cost_micros, at_ms)
                 VALUES (?1, 'fake/m', 'main', 200000, ?2)",
                rusqlite::params![conversation, MORNING_MS - hour * HOUR_MS - 1_000],
            )?;
        }
        db.execute(
            "INSERT INTO spend (conversation_id, model, role, cost_micros, at_ms)
             VALUES (?1, 'fake/m', 'main', 4000000, ?2)",
            rusqlite::params![conversation, MORNING_MS - 60_000],
        )?;
    }
    reach(&spade, json!({})).await?;
    let notices = until_notice(&mut body, |n| n["kind"] == "spend").await;
    let alert = notices
        .iter()
        .find(|n| n["kind"] == "spend")
        .cloned()
        .unwrap_or_default();
    assert_eq!(alert["agent"], id.as_str());
    assert_eq!(alert["category"], "spend");
    assert_eq!(
        alert["text"],
        "Spent $4.00 in the last hour, about 20× its usual $0.20 an hour."
    );

    // Still spending fast ten minutes on: no second alert.
    clock.set(MORNING_MS + 10 * 60_000);
    reach(&spade, json!({})).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (_, listed) = spade.get(&format!("/v1/digests?agent={id}")).await?;
    let alerts: Vec<&Value> = listed["digests"]
        .as_array()
        .map(|d| d.iter().filter(|r| r["kind"] == "spend").collect())
        .unwrap_or_default();
    assert_eq!(alerts.len(), 1, "once per episode: {listed}");
    assert_eq!(
        alerts[0]["text"], alert["text"],
        "and a line in the bot's chat"
    );
    Ok(())
}
