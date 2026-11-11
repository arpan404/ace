//! The API's edges: the token, health, the daily cap, the live stream and keys.

mod support;

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::json;
use spade_testkit::Script;
use support::{Result, Spade};

#[tokio::test]
async fn health_is_open_and_everything_else_needs_the_token() -> Result {
    let spade = Spade::start(vec![Script::reply("hi")], Vec::new()).await?;
    let health = spade
        .http
        .get(format!("{}/health", spade.base))
        .send()
        .await?;
    assert_eq!(health.status(), 200);
    let health: serde_json::Value = health.json().await?;
    assert_eq!(health["ok"], true);
    assert_eq!(health["api"], 1);
    assert_eq!(health["version"], env!("CARGO_PKG_VERSION"));
    let bare = spade
        .http
        .get(format!("{}/v1/conversations", spade.base))
        .send()
        .await?;
    assert_eq!(bare.status(), 401);
    let wrong = spade
        .http
        .get(format!("{}/v1/conversations", spade.base))
        .bearer_auth("nope")
        .send()
        .await?;
    assert_eq!(wrong.status(), 401);
    let (status, _) = spade.get("/v1/conversations").await?;
    assert_eq!(status, 200);
    Ok(())
}

#[tokio::test]
async fn over_the_daily_cap_a_message_is_refused_without_a_model_call() -> Result {
    let spade = Spade::start_with(
        vec![Script::reply("Costly answer.")],
        Vec::new(),
        support::Options {
            cap_usd: 0.00005,
            ..Default::default()
        },
    )
    .await?;
    let id = spade.ask("First").await?;
    spade.wait_for(&id, "reply_finished").await?;
    let calls_before = spade.fake.seen().len();
    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "Second" }),
        )
        .await?;
    assert_eq!(status, 402);
    assert_eq!(spade.fake.seen().len(), calls_before);
    Ok(())
}

#[tokio::test]
async fn the_live_stream_sends_stored_events_then_deltas_as_they_arrive() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("one two three four")
                .chunks(4)
                .delay(Duration::from_millis(60)),
        ],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Count").await?;
    let response = spade
        .http
        .get(format!("{}/v1/conversations/{id}/live?after=0", spade.base))
        .bearer_auth(support::TOKEN)
        .send()
        .await?;
    let mut body = response.bytes_stream();
    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !text.contains("reply_finished") && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), body.next()).await {
            Ok(Some(Ok(chunk))) => text.push_str(&String::from_utf8_lossy(&chunk)),
            _ => break,
        }
    }
    let first_stored = text.find("event: stored").unwrap_or(usize::MAX);
    let first_delta = text.find("event: delta").unwrap_or(usize::MAX);
    assert!(first_stored < first_delta, "{text}");
    assert!(text.contains("\"type\":\"user_message\""), "{text}");
    assert!(text.contains("reply_finished"), "{text}");
    Ok(())
}

#[tokio::test]
async fn a_key_is_stored_reported_as_set_and_deleted_but_never_returned() -> Result {
    let spade = Spade::start(vec![Script::reply("hi")], Vec::new()).await?;
    let (_, before) = spade.get("/v1/models").await?;
    assert_eq!(before["endpoints"][0]["key_set"], false);

    let put = spade
        .http
        .put(format!("{}/v1/keys/fake", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&json!({ "key": "sk-secret-123" }))
        .send()
        .await?;
    assert_eq!(put.status(), 204);
    let (_, after) = spade.get("/v1/models").await?;
    assert_eq!(after["endpoints"][0]["key_set"], true);
    assert!(!after.to_string().contains("sk-secret-123"));

    let delete = spade
        .http
        .delete(format!("{}/v1/keys/fake", spade.base))
        .bearer_auth(support::TOKEN)
        .send()
        .await?;
    assert_eq!(delete.status(), 204);
    let (_, gone) = spade.get("/v1/models").await?;
    assert_eq!(gone["endpoints"][0]["key_set"], false);
    Ok(())
}
