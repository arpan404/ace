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

#[tokio::test]
async fn health_proves_spade_holds_its_token_without_revealing_it() -> Result {
    let spade = Spade::start(vec![Script::reply("hi")], Vec::new()).await?;
    let nonce = "00112233445566778899aabbccddeeff";
    let answer: serde_json::Value = spade
        .http
        .get(format!("{}/health?nonce={nonce}", spade.base))
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(
        answer["proof"].as_str(),
        spade_server::proof::answer(support::TOKEN, nonce).as_deref()
    );
    assert!(!answer.to_string().contains(support::TOKEN));
    let plain: serde_json::Value = spade
        .http
        .get(format!("{}/health", spade.base))
        .send()
        .await?
        .json()
        .await?;
    assert!(plain.get("proof").is_none());
    let bad = spade
        .http
        .get(format!("{}/health?nonce=xyz", spade.base))
        .send()
        .await?;
    assert_eq!(bad.status(), 400);
    Ok(())
}

#[tokio::test]
async fn a_start_sent_again_with_its_client_key_gets_the_same_conversation() -> Result {
    let spade = Spade::start(vec![Script::reply("Here's your week.")], Vec::new()).await?;
    let key = "6f1c0b3e-2a4d-4f8e-9b1a-0c2d3e4f5a6b";
    let start = json!({ "text": "Plan my week", "client_key": key });
    let (status, first) = spade.post("/v1/conversations", start.clone()).await?;
    assert_eq!(status, 201, "{first}");
    let id = first["id"].as_str().unwrap_or_default().to_owned();
    spade.wait_for(&id, "reply_finished").await?;
    let calls_before = spade.fake.seen().len();
    // The answer was lost, so the client asks again with the same key.
    let (status, again) = spade.post("/v1/conversations", start).await?;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["id"], first["id"]);
    let events = spade.events(&id).await?;
    assert_eq!(
        support::types(&events)
            .iter()
            .filter(|kind| *kind == "user_message")
            .count(),
        1
    );
    assert_eq!(
        spade.fake.seen().len(),
        calls_before,
        "the repeat called no model"
    );
    // The list says which start made each conversation; one without a key says none.
    let other = spade.ask("Plan my week").await?;
    let (_, list) = spade.get("/v1/conversations").await?;
    let keys: Vec<(String, serde_json::Value)> = list
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    (
                        row["id"].as_str().unwrap_or_default().to_owned(),
                        row["client_key"].clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        keys,
        vec![(other, serde_json::Value::Null), (id, json!(key))]
    );
    Ok(())
}

#[tokio::test]
async fn a_start_with_a_client_key_that_is_not_a_plain_token_is_refused() -> Result {
    let spade = Spade::start(vec![Script::reply("hi")], Vec::new()).await?;
    for key in ["", "has space", &"k".repeat(129)] {
        let (status, body) = spade
            .post(
                "/v1/conversations",
                json!({ "text": "Hi", "client_key": key }),
            )
            .await?;
        assert_eq!(status, 400, "{key:?}: {body}");
    }
    let (_, list) = spade.get("/v1/conversations").await?;
    assert_eq!(list, json!([]));
    Ok(())
}

#[tokio::test]
async fn a_keyed_start_cut_off_before_its_message_was_kept_delivers_it_when_sent_again() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let key = "0b9e2f4a-6c1d-4e3b-8a7f-5d2c1b0a9e8f";
    // The crash window: the start's conversation and key were written, its message never was.
    spade_store::Store::open(&spade.database())?.create_keyed_conversation(
        "c_cut",
        Some(key),
        1,
    )?;
    let spade = spade
        .restart(
            Vec::new(),
            vec![
                Script::reply("Here's your week."),
                Script::reply("").plain(r#"{"title":"Week"}"#),
            ],
        )
        .await?;
    // The client never heard back, so it sends the same start again.
    let (status, body) = spade
        .post(
            "/v1/conversations",
            json!({ "text": "Plan my week", "client_key": key }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["id"], "c_cut");
    let events = spade.wait_for("c_cut", "reply_finished").await?;
    let messages: Vec<&str> = events
        .iter()
        .filter(|event| event["type"] == "user_message")
        .filter_map(|event| event["text"].as_str())
        .collect();
    assert_eq!(messages, ["Plan my week"]);
    // Sent once more, it is answered with the same conversation and delivered no second time.
    let (status, _) = spade
        .post(
            "/v1/conversations",
            json!({ "text": "Plan my week", "client_key": key }),
        )
        .await?;
    assert_eq!(status, 200);
    let events = spade.events("c_cut").await?;
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "user_message")
            .count(),
        1
    );
    Ok(())
}
