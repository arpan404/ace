//! Digests, the decision log and escalation levels (ADR 0165), through the real API with a
//! scripted model and, for the schedule, a clock the test sets. Model calls take scripts in the
//! order they arrive.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{Value, json};
use spade_server::tools::{DecisionLog, Tool};
use spade_testkit::Script;
use support::{ManualClock, Options, Result, Spade};

const DAY_MS: i64 = 24 * 3_600_000;
const START_MS: i64 = 1_763_200_000_000;

fn tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(DecisionLog)]
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

/// The conversation's events as served, each with `seq`, `at`, `event` and maybe `level`.
async fn served(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    let (_, body) = spade
        .get(&format!("/v1/conversations/{conversation}/events"))
        .await?;
    Ok(body.as_array().cloned().unwrap_or_default())
}

fn level_of(rows: &[Value], test: impl Fn(&Value) -> bool) -> Value {
    rows.iter()
        .find(|row| test(&row["event"]))
        .map(|row| row["level"].clone())
        .unwrap_or(Value::Null)
}

async fn digest_now(spade: &Spade, agent: &str) -> Result<Value> {
    let (status, body) = spade
        .post(&format!("/v1/agents/{agent}/digests"), json!({}))
        .await?;
    assert_eq!(status, 201, "{body}");
    Ok(body["digest"].clone())
}

async fn digests_of(spade: &Spade, agent: &str) -> Result<Vec<Value>> {
    let (status, body) = spade.get(&format!("/v1/digests?agent={agent}")).await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["digests"].as_array().cloned().unwrap_or_default())
}

/// Waits until `agent` has `count` stored digests.
async fn until_digests(spade: &Spade, agent: &str, count: usize) -> Result<Vec<Value>> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let digests = digests_of(spade, agent).await?;
        if digests.len() >= count {
            return Ok(digests);
        }
        if Instant::now() > deadline {
            return Err(format!("never {count} digests: {digests:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_decision_is_recorded_for_the_person_and_shows_in_the_digest_as_inform() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "d1",
                "decision_log",
                json!({ "choice": "SQLite", "reason": "one file to back up",
                        "options": ["Postgres"] }),
            ),
            Script::reply("I picked SQLite."),
            Script::reply("").plain(r#"{"title":"Storage"}"#),
        ],
        tools(),
    )
    .await?;
    let (id, conversation) = bot(&spade, "Builder").await?;
    spade.say(&conversation, "Set up storage").await?;
    spade.wait_for(&conversation, "renamed").await?;
    let rows = served(&spade, &conversation).await?;
    assert_eq!(
        level_of(&rows, |e| e["type"] == "decision_made"),
        json!("inform")
    );
    let result = rows
        .iter()
        .find(|r| r["event"]["type"] == "tool_finished" && r["event"]["call_id"] == "d1")
        .map(|r| r["event"]["content"].clone())
        .unwrap_or_default();
    assert!(
        result.as_str().unwrap_or("").contains("decision d1"),
        "{result}"
    );
    assert_eq!(
        level_of(&rows, |e| e["type"] == "reply_finished"),
        Value::Null,
        "ordinary work has no level"
    );

    let digest = digest_now(&spade, &id).await?;
    assert_eq!(digest["kind"], "task");
    assert_eq!(digest["scheduled"], false);
    assert_eq!(digest["digest"]["decisions"][0]["decision"], "d1");
    let text = digest["text"].as_str().unwrap_or_default();
    assert!(
        text.contains("Decided for you:\n- SQLite. Why: one file to back up Set aside: Postgres."),
        "{text}"
    );
    assert!(text.contains("1 reply"), "{text}");
    let (_, one) = spade.get(&format!("/v1/digests/{}", digest["id"])).await?;
    assert_eq!(one["digest"]["text"], digest["text"]);
    Ok(())
}

/// Reads notices until `count` arrive, for at most 10 s.
async fn read_notices<S, B, E>(body: &mut S, count: usize) -> Vec<Value>
where
    S: futures_util::Stream<Item = std::result::Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
{
    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let parsed = |text: &str| -> Vec<Value> {
        text.lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|d| serde_json::from_str(d).ok())
            .collect()
    };
    while parsed(&text).len() < count && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), body.next()).await {
            Ok(Some(Ok(chunk))) => text.push_str(&String::from_utf8_lossy(chunk.as_ref())),
            _ => break,
        }
    }
    parsed(&text)
}

#[tokio::test]
async fn questions_carry_ask_or_block_and_each_reaches_the_notice_stream_with_its_level() -> Result
{
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call(
                    "q1",
                    "ask_user",
                    json!({ "questions": [{ "kind": "text", "prompt": "Which date?" }],
                            "wait": false }),
                )
                .call("q2", "ask_user", json!({ "question": "Window or aisle?" })),
        ],
        Vec::new(),
    )
    .await?;
    let (id, conversation) = bot(&spade, "Booker").await?;
    let response = spade
        .http
        .get(format!("{}/v1/notices/live", spade.base))
        .bearer_auth(support::TOKEN)
        .send()
        .await?;
    assert_eq!(response.status(), 200);
    let mut body = response.bytes_stream();
    spade.say(&conversation, "Book me a seat").await?;
    let notices = read_notices(&mut body, 2).await;
    let shown: Vec<(Value, Value, Value)> = notices
        .iter()
        .map(|n| (n["kind"].clone(), n["level"].clone(), n["text"].clone()))
        .collect();
    assert_eq!(
        shown,
        vec![
            (
                json!("event"),
                json!("ask"),
                json!("Asks, for later: Which date?")
            ),
            (
                json!("event"),
                json!("block"),
                json!("Asks: Window or aisle?")
            ),
        ]
    );
    assert_eq!(notices[0]["agent"], id.as_str());
    assert_eq!(notices[0]["name"], "Booker");
    let rows = served(&spade, &conversation).await?;
    assert_eq!(
        level_of(&rows, |e| e["type"] == "question_asked"
            && e["call_id"] == "q1"),
        json!("ask")
    );
    assert_eq!(
        level_of(&rows, |e| e["type"] == "question_asked"
            && e["call_id"] == "q2"),
        json!("block")
    );

    let digest = digest_now(&spade, &id).await?;
    let waiting: Vec<(Value, Value)> = digest["digest"]["waiting"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|w| (w["level"].clone(), w["what"].clone()))
        .collect();
    assert_eq!(
        waiting,
        vec![
            (
                json!("block"),
                json!("A question for you: Window or aisle?")
            ),
            (json!("ask"), json!("A question for you: Which date?")),
        ]
    );
    let notice = read_notices(&mut body, 1).await;
    assert_eq!(
        notice.first().map(|n| n["kind"].clone()),
        Some(json!("digest"))
    );
    assert_eq!(
        notice.first().map(|n| n["digest"].clone()),
        Some(digest["id"].clone())
    );
    Ok(())
}

#[tokio::test]
async fn the_schedule_makes_one_digest_a_day_and_none_for_a_quiet_one() -> Result {
    let clock = ManualClock::at(START_MS);
    let options = Options {
        clock: Some(clock.clone()),
        ..Options::default()
    };
    let spade = Spade::start_with(
        vec![
            Script::reply("Hello."),
            Script::reply("").plain(r#"{"title":"Hi"}"#),
            Script::reply("Hello again."),
        ],
        Vec::new(),
        options,
    )
    .await?;
    let (id, conversation) = bot(&spade, "Builder").await?;
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    let (_, settings) = spade.get(&format!("/v1/agents/{id}/digest")).await?;
    assert_eq!(settings["every_ms"], DAY_MS, "daily by default");
    assert_eq!(settings["next_ms"], START_MS + DAY_MS);

    // A day passes: the timer makes the digest. Changing a setting makes it look at once.
    clock.set(START_MS + DAY_MS + 1_000);
    let (status, body) = spade.put("/v1/digests/settings", json!({})).await?;
    assert_eq!(status, 200, "{body}");
    let digests = until_digests(&spade, &id, 1).await?;
    assert_eq!(digests[0]["scheduled"], true);
    assert_eq!(digests[0]["from_ms"], START_MS);
    let text = digests[0]["text"].as_str().unwrap_or_default();
    assert!(text.starts_with("Builder: from "), "{text}");
    assert!(text.contains("1 reply"), "{text}");

    // A quiet day makes none.
    clock.set(START_MS + 2 * DAY_MS + 2_000);
    spade.put("/v1/digests/settings", json!({})).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(digests_of(&spade, &id).await?.len(), 1);

    // Work the next day is in the next digest.
    clock.set(START_MS + 2 * DAY_MS + 3_000);
    spade.say(&conversation, "Again").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    clock.set(START_MS + 3 * DAY_MS + 3_000);
    spade.put("/v1/digests/settings", json!({})).await?;
    let digests = until_digests(&spade, &id, 2).await?;
    let text = digests[0]["text"].as_str().unwrap_or_default();
    assert!(text.contains("1 reply"), "only the new day's work: {text}");

    // Off for this bot: nothing more, whatever happens.
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{id}/digest"),
            json!({ "every": "off" }),
        )
        .await?;
    assert_eq!(
        (status, body["every_ms"].clone()),
        (200, Value::Null),
        "{body}"
    );
    let (status, _) = spade
        .put(&format!("/v1/agents/{id}/digest"), json!({ "every": "5m" }))
        .await?;
    assert_eq!(status, 400, "shorter than an hour");
    Ok(())
}

#[tokio::test]
async fn a_polished_digest_keeps_both_texts_and_a_failed_polish_keeps_the_plain_one() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("Hello."),
            Script::reply("").plain(r#"{"title":"Hi"}"#),
            Script::reply("").plain(r#"{"text":"Builder answered once today."}"#),
            Script::reply("Hello again."),
            Script::failing(400),
        ],
        Vec::new(),
    )
    .await?;
    let (status, _) = spade
        .put("/v1/digests/settings", json!({ "polish": true }))
        .await?;
    assert_eq!(status, 200);
    let (id, conversation) = bot(&spade, "Builder").await?;
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    let digest = digest_now(&spade, &id).await?;
    assert_eq!(digest["polished"], "Builder answered once today.");
    assert!(
        digest["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Builder: from")
    );
    let polish = spade
        .fake
        .seen()
        .iter()
        .map(|s| s.body.to_string())
        .find(|b| b.contains("<digest>"))
        .unwrap_or_default();
    assert!(
        polish.contains("Builder: from"),
        "the model sees the plain digest"
    );

    spade.say(&conversation, "Again").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    let digest = digest_now(&spade, &id).await?;
    assert_eq!(digest["polished"], Value::Null);
    assert!(
        digest["text"]
            .as_str()
            .unwrap_or_default()
            .contains("1 reply")
    );
    Ok(())
}

#[tokio::test]
async fn an_orchestrators_digest_holds_its_workers_under_it() -> Result {
    let pause = support::FakeTool::new("pause", spade_core::tools::Risk::Read, "ok")
        .slow(Duration::from_millis(500));
    let options = Options {
        reviewer: None,
        ..Options::default()
    };
    let spade = Spade::start_with(
        vec![
            Script::reply("Hello."),
            Script::reply("").plain(r#"{"title":"Lead"}"#),
            Script::reply("")
                .call(
                    "make-Scout",
                    "bot_create",
                    json!({ "name": "Scout", "task": "Scout: find the sources.",
                            "brief": "Find three sources on tides." }),
                )
                .call("pause-Scout", "pause", json!({})),
            Script::reply("").plain(r#"{"verdict":"approve","reason":"It makes a worker."}"#),
            Script::reply("Found three sources."),
            Script::reply("Scout reported."),
        ],
        vec![Arc::new(pause)],
        options,
    )
    .await?;
    let (lead, conversation) = bot(&spade, "Lead").await?;
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    spade
        .say(&conversation, "Research tides with a worker")
        .await?;
    spade.wait_for(&conversation, "worker_reported").await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;

    let digest = digest_now(&spade, &lead).await?;
    assert_eq!(digest["kind"], "tree");
    let workers = digest["digest"]["workers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(workers.len(), 1, "{digest}");
    assert_eq!(workers[0]["name"], "Scout");
    assert_eq!(workers[0]["activity"]["replies"], 1);
    let text = digest["text"].as_str().unwrap_or_default();
    assert!(text.contains("- Started worker Scout"), "{text}");
    assert!(text.contains("- Worker Scout finished"), "{text}");
    assert!(text.contains("Workers:\n  Scout: from "), "{text}");
    let (_, settings) = spade
        .get(&format!(
            "/v1/agents/{}/digest",
            workers[0]["agent"].as_str().unwrap_or_default()
        ))
        .await?;
    assert_eq!(
        settings["every_ms"],
        Value::Null,
        "a worker is in its root's digest"
    );
    Ok(())
}
