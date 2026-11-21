//! `notify` (ADR 0200 §4.2) through Spade's API: a bot's own notice reaches the person once
//! outside quiet hours, waits for the morning brief inside them, and a bot past its rate has the
//! rest held for the brief. The notice stream and the bot's conversation say the same. Scripted
//! models; a clock the test sets.

mod support;

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use spade_testkit::Script;
use support::{ManualClock, Options, Result, Spade};

/// 2026-11-19T23:00:00Z: inside a 22:00–07:00 quiet window.
const NIGHT_MS: i64 = 1_763_593_200_000;
/// 2026-11-19T14:00:00Z: outside it.
const AFTERNOON_MS: i64 = 1_763_560_800_000;

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

/// The bot's notices read from the stream until `count` arrived, for at most 10 s.
async fn notices(body: &mut Notices, count: usize) -> Vec<Value> {
    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let parsed = |text: &str| -> Vec<Value> {
        text.lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|d| serde_json::from_str::<Value>(d).ok())
            .filter(|n| n["kind"] == "notice")
            .collect()
    };
    while parsed(&text).len() < count && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), body.next()).await {
            Ok(Some(Ok(chunk))) => text.push_str(&String::from_utf8_lossy(&chunk)),
            _ => break,
        }
    }
    parsed(&text)
}

fn notify(title: &str) -> Value {
    json!({ "title": title, "body": "LIS to NRT is €612 on 12 March." })
}

/// One step that sends `titles` as notices, then a reply.
fn sends(titles: &[&str]) -> Vec<Script> {
    let mut step = Script::reply("");
    for (at, title) in titles.iter().enumerate() {
        step = step.call(&format!("n{at}"), "notify", notify(title));
    }
    vec![
        step,
        Script::reply("").plain(r#"{"title":"Fares"}"#),
        Script::reply("Told you."),
    ]
}

async fn spade_at(ms: i64, scripts: Vec<Script>) -> Result<Spade> {
    let options = Options {
        clock: Some(ManualClock::at(ms)),
        ..Options::default()
    };
    let spade = Spade::start_with(scripts, Vec::new(), options).await?;
    spade
        .put("/v1/oversight", json!({ "time_zone": "UTC" }))
        .await?;
    let (status, body) = spade
        .put("/v1/reach", json!({ "quiet": { "from": 1320, "to": 420 } }))
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(spade)
}

async fn chat(spade: &Spade) -> Result<String> {
    let agent = spade.new_agent("Fare watch", "").await?;
    Ok(agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

fn results(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e["type"] == "tool_finished")
        .map(|e| e["content"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn stored(events: &[Value]) -> Vec<(Value, Value)> {
    events
        .iter()
        .filter(|e| e["type"] == "notice_sent")
        .map(|e| (e["reach"].clone(), e["why"].clone()))
        .collect()
}

#[tokio::test]
async fn a_notice_outside_quiet_hours_reaches_the_person_once() -> Result {
    let spade = spade_at(AFTERNOON_MS, sends(&["Fare dropped"])).await?;
    let chat = chat(&spade).await?;
    let mut stream = listen(&spade).await?;
    spade.say(&chat, "Watch LIS to NRT").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let sent = notices(&mut stream, 1).await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    let notice = &sent[0];
    assert_eq!(
        json!([
            notice["category"],
            notice["reach"],
            notice["title"],
            notice["conversation"]
        ]),
        json!(["notice", "now", "Fare dropped", chat])
    );
    assert_eq!(
        notice["text"],
        "Fare dropped: LIS to NRT is €612 on 12 March."
    );
    assert_eq!(stored(&events), vec![(json!("now"), Value::Null)]);
    assert_eq!(results(&events), vec!["Sent to the person.".to_owned()]);
    // It counted against the interruption budget, once.
    let (_, reach) = spade.get("/v1/reach").await?;
    assert_eq!(reach["held"], 0);
    Ok(())
}

#[tokio::test]
async fn a_notice_in_quiet_hours_waits_and_lands_in_the_morning_brief() -> Result {
    let spade = spade_at(NIGHT_MS, sends(&["Fare dropped"])).await?;
    let chat = chat(&spade).await?;
    let mut stream = listen(&spade).await?;
    spade.say(&chat, "Watch LIS to NRT").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let sent = notices(&mut stream, 1).await;
    assert_eq!(
        sent.iter()
            .map(|n| (n["reach"].clone(), n["why"].clone()))
            .collect::<Vec<_>>(),
        vec![(json!("held"), json!("quiet"))]
    );
    assert_eq!(stored(&events), vec![(json!("held"), json!("quiet"))]);
    assert!(results(&events)[0].contains("quiet hours"), "{events:?}");

    let (status, brief) = spade.post("/v1/reach/brief", json!({})).await?;
    assert_eq!(status, 201, "{brief}");
    assert_eq!(
        brief["digest"]["digest"]["away"][0]["text"],
        "Fare dropped: LIS to NRT is €612 on 12 March."
    );
    let text = brief["digest"]["text"].as_str().unwrap_or_default();
    assert!(
        text.contains("While you were away:\n- Fare watch: Fare dropped: LIS to NRT is €612"),
        "{text}"
    );
    Ok(())
}

#[tokio::test]
async fn a_bot_past_its_rate_has_the_rest_held_for_the_brief() -> Result {
    let spade = spade_at(AFTERNOON_MS, sends(&["One", "Two", "Three", "Four"])).await?;
    let chat = chat(&spade).await?;
    let mut stream = listen(&spade).await?;
    spade.say(&chat, "Watch every route").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let sent = notices(&mut stream, 4).await;
    let reached: Vec<(Value, Value, Value)> = sent
        .iter()
        .map(|n| (n["title"].clone(), n["reach"].clone(), n["why"].clone()))
        .collect();
    assert_eq!(
        reached,
        vec![
            (json!("One"), json!("now"), Value::Null),
            (json!("Two"), json!("now"), Value::Null),
            (json!("Three"), json!("now"), Value::Null),
            (json!("Four"), json!("held"), json!("rate")),
        ]
    );
    assert!(
        results(&events)
            .iter()
            .any(|r| r.starts_with("Held: you've sent 3 notices this hour")),
        "{events:?}"
    );
    let (_, reach) = spade.get("/v1/reach").await?;
    assert_eq!(reach["held"], 1, "the fourth waits for the brief");
    Ok(())
}
