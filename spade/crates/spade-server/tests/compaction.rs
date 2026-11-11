//! Automatic and manual compaction through the real engine and API.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use spade_server::engine::Limits;
use spade_testkit::Script;
use support::{Options, Result, Spade, types};

const SUMMARY: &str = r#"{"goal":"Plan a trip to Oxford","decisions":["Go by train"],"facts":[],"open":["Book a hotel"],"references":[]}"#;

/// A tiny budget, so a reported prompt of 111 tokens (11 + 100 cached) is past the high mark.
fn small_budget() -> Options {
    Options {
        limits: Limits {
            context_budget: 100,
            ..Default::default()
        },
        ..Default::default()
    }
}

fn person_texts(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter(|m| m["role"] == "user")
                .map(|m| m["content"].as_str().unwrap_or("").to_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn past_the_high_mark_the_next_turn_compacts_and_the_model_sees_the_summary() -> Result {
    let spade = Spade::start_with(
        vec![
            Script::reply("Take the train.").cached(100, 0),
            Script::reply("").plain(r#"{"title":"Oxford trip"}"#),
            Script::reply("").plain(SUMMARY),
            Script::reply("Try the Randolph."),
        ],
        Vec::new(),
        small_budget(),
    )
    .await?;
    let id = spade.ask("How do I get to Oxford?").await?;
    spade.wait_for(&id, "renamed").await?;
    spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Where should I stay?" }),
        )
        .await?;
    let events = spade.wait_for(&id, "reply_finished").await?;
    let events = if types(&events)
        .iter()
        .filter(|t| *t == "reply_finished")
        .count()
        < 2
    {
        tokio::time::sleep(Duration::from_millis(300)).await;
        spade.events(&id).await?
    } else {
        events
    };

    let compacted = events.iter().find(|e| e["type"] == "context_compacted");
    let summary = compacted.and_then(|e| e["summary"].as_str()).unwrap_or("");
    assert!(
        summary.contains("Plan a trip to Oxford") && summary.contains("Book a hotel"),
        "{summary}"
    );
    assert_eq!(
        compacted.map(|e| e["tokens_before"].clone()),
        Some(json!(111))
    );

    let last = spade
        .fake
        .seen()
        .last()
        .map(|s| s.body.clone())
        .unwrap_or(Value::Null);
    let people = person_texts(&last);
    assert!(people[0].starts_with("<summary>"), "{people:?}");
    assert!(
        people.iter().any(|t| t.contains("Where should I stay?")),
        "{people:?}"
    );
    assert!(
        !people.iter().any(|t| t.contains("How do I get to Oxford?")),
        "{people:?}"
    );
    Ok(())
}

#[tokio::test]
async fn when_the_summary_fails_older_turns_are_left_out_visibly() -> Result {
    let spade = Spade::start_with(
        vec![
            Script::reply("Take the train.").cached(100, 0),
            Script::reply("").plain(r#"{"title":"Oxford trip"}"#),
            Script::reply("").plain("not a summary"),
            Script::reply("Try the Randolph."),
        ],
        Vec::new(),
        small_budget(),
    )
    .await?;
    let id = spade.ask("How do I get to Oxford?").await?;
    spade.wait_for(&id, "renamed").await?;
    spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Where should I stay?" }),
        )
        .await?;
    let events = spade.wait_for(&id, "context_compacted").await?;
    let compacted = events.iter().find(|e| e["type"] == "context_compacted");
    let summary = compacted.and_then(|e| e["summary"].as_str()).unwrap_or("");
    assert!(summary.contains("left out"), "{summary}");
    Ok(())
}

#[tokio::test]
async fn compact_on_request_works_between_turns_and_is_refused_mid_reply() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("First answer."),
            Script::reply("").plain(r#"{"title":"Chat"}"#),
            Script::reply("Second answer.")
                .chunks(20)
                .delay(Duration::from_millis(50)),
            Script::reply("").plain(SUMMARY),
        ],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("First question").await?;
    spade.wait_for(&id, "renamed").await?;
    spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Second question" }),
        )
        .await?;
    spade.wait_for(&id, "reply_progress").await?;
    let (busy, _) = spade
        .post(&format!("/v1/conversations/{id}/compact"), json!({}))
        .await?;
    assert_eq!(busy, 409);

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while types(&spade.events(&id).await?)
        .iter()
        .filter(|t| *t == "reply_finished")
        .count()
        < 2
    {
        assert!(
            std::time::Instant::now() < deadline,
            "second reply never finished"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{id}/compact"),
            json!({ "focus": "the trip" }),
        )
        .await?;
    assert_eq!(status, 204);
    let events = spade.events(&id).await?;
    assert_eq!(
        types(&events).last().map(String::as_str),
        Some("context_compacted")
    );
    let request = spade
        .fake
        .seen()
        .last()
        .map(|s| s.body["messages"].to_string())
        .unwrap_or_default();
    assert!(
        request.contains("Keep in particular: the trip"),
        "{request}"
    );
    Ok(())
}

#[tokio::test]
async fn the_summary_call_reuses_the_turns_tools_and_every_model_call_is_paid_for() -> Result {
    let lookup = support::FakeTool::new("lookup", spade_core::tools::Risk::Read, "12C");
    let spade = Spade::start_with(
        vec![
            Script::reply("Take the train.").cached(100, 0),
            Script::reply("").plain(r#"{"title":"Oxford trip"}"#),
            Script::reply("").plain(SUMMARY),
            Script::reply("Try the Randolph."),
        ],
        vec![std::sync::Arc::new(lookup) as std::sync::Arc<dyn spade_server::tools::Tool>],
        small_budget(),
    )
    .await?;
    let id = spade.ask("How do I get to Oxford?").await?;
    spade.wait_for(&id, "renamed").await?;
    spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Where should I stay?" }),
        )
        .await?;
    let events = spade.wait_for_count(&id, "reply_finished", 2).await?;

    let seen = spade.fake.seen();
    assert_eq!(seen.len(), 4);
    assert!(seen[0].body["tools"].is_array());
    assert_eq!(
        seen[2].body["tools"], seen[0].body["tools"],
        "same tools, same cached prefix"
    );
    assert!(seen[2].body.get("response_format").is_none());

    // Every call is in the spend table: both steps, the title and the summary (92 micros each
    // for the last two: 11 input × $2/M + 7 output × $10/M).
    let steps: u64 = events
        .iter()
        .filter(|e| e["type"] == "step_finished")
        .map(|e| e["cost_micros"].as_u64().unwrap_or(0))
        .sum();
    let spent = spade_store::Store::open(&spade.database())?.spent_since(0)?;
    assert_eq!(spent, steps + 92 + 92);
    Ok(())
}
