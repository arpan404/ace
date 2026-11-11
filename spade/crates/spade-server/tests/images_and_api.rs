//! Attached images and the API details clients rely on: event paging, the live stream's caught-up
//! marker, where a key comes from, waiting-on-you in the list, and shutdown with streams open.

mod support;

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_util::StreamExt;
use serde_json::json;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, Result, Spade};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDRpixels";

#[tokio::test]
async fn an_attached_image_is_stored_once_shown_to_the_model_and_served_back() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("A tiny PNG."),
            Script::reply("").plain(r#"{"title":"Image"}"#),
        ],
        Vec::new(),
    )
    .await?;
    let encoded = STANDARD.encode(PNG);
    let agent = spade.new_agent("Looker", "").await?;
    let id = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "What is this?", "images": [{ "data": format!("data:image/png;base64,{encoded}") }] }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let events = spade.wait_for(&id, "renamed").await?;

    let message = events
        .iter()
        .find(|e| e["type"] == "user_message")
        .cloned()
        .unwrap_or_default();
    let image = &message["images"][0];
    assert_eq!(image["media_type"], "image/png");
    assert_eq!(image["bytes"], PNG.len());
    assert!(
        message.get("data").is_none(),
        "the bytes are not in the event log"
    );

    let sent = spade.fake.seen()[0].body["messages"][1]["content"].clone();
    assert_eq!(sent[0]["text"], "What is this?");
    assert_eq!(
        sent[1]["image_url"]["url"],
        format!("data:image/png;base64,{encoded}")
    );

    let sha = image["sha256"].as_str().unwrap_or_default();
    let served = spade
        .http
        .get(format!("{}/v1/images/{sha}", spade.base))
        .bearer_auth(support::TOKEN)
        .send()
        .await?;
    assert_eq!(served.headers()["content-type"], "image/png");
    assert_eq!(served.headers()["x-content-type-options"], "nosniff");
    assert_eq!(served.bytes().await?.as_ref(), PNG);

    // A full-size image, past the server's default 2 MB body limit, is taken too.
    let mut large = PNG.to_vec();
    large.resize(3_500_000, 7);
    let (big, body) = spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "text": "And this one?", "images": [{ "data": STANDARD.encode(&large) }] }),
        )
        .await?;
    assert_eq!(big, 202, "{body}");

    let (bad, _) = spade
        .post(
            &format!("/v1/conversations/{id}/messages"),
            json!({ "images": [{ "data": STANDARD.encode(b"<svg/>") }] }),
        )
        .await?;
    assert_eq!(bad, 400, "only real images are accepted");
    Ok(())
}

#[tokio::test]
async fn events_page_and_the_live_stream_says_when_it_is_caught_up() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("Hello!"),
            Script::reply("").plain(r#"{"title":"Hi"}"#),
        ],
        Vec::new(),
    )
    .await?;
    let id = spade.ask("Hi").await?;
    let all = spade.wait_for(&id, "renamed").await?;
    let (_, page) = spade
        .get(&format!("/v1/conversations/{id}/events?after=0&limit=2"))
        .await?;
    let seqs: Vec<i64> = page
        .as_array()
        .map(|p| p.iter().filter_map(|e| e["seq"].as_i64()).collect())
        .unwrap_or_default();
    assert_eq!(seqs, vec![1, 2]);
    let (_, rest) = spade
        .get(&format!("/v1/conversations/{id}/events?after=2&limit=100"))
        .await?;
    assert_eq!(rest.as_array().map(Vec::len), Some(all.len() - 2));

    let response = spade
        .http
        .get(format!("{}/v1/conversations/{id}/live?after=0", spade.base))
        .bearer_auth(support::TOKEN)
        .send()
        .await?;
    let mut body = response.bytes_stream();
    let mut text = String::new();
    while !text.contains("event: caught_up") {
        match tokio::time::timeout(Duration::from_secs(5), body.next()).await {
            Ok(Some(Ok(chunk))) => text.push_str(&String::from_utf8_lossy(&chunk)),
            _ => break,
        }
    }
    let marker = text.find("event: caught_up").unwrap_or(0);
    assert!(
        text[..marker].contains("renamed"),
        "the backlog comes first: {text}"
    );
    assert!(
        text[marker..].contains(&format!("\"seq\":{}", all.len())),
        "{text}"
    );

    // An open live stream does not hold shutdown up.
    spade.shut_down(Duration::from_secs(3)).await?;
    Ok(())
}

#[tokio::test]
async fn the_list_says_when_a_conversation_waits_on_the_person_and_keys_say_where_they_live()
-> Result {
    let email = FakeTool::new("send_email", Risk::Write, "sent");
    let spade = Spade::start(
        vec![Script::reply("").call("c1", "send_email", json!({}))],
        vec![std::sync::Arc::new(email) as std::sync::Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Email Sam").await?;
    spade.wait_for(&id, "approval_requested").await?;
    let (_, list) = spade.get("/v1/conversations").await?;
    assert_eq!(list[0]["waiting_on_you"], true);
    assert_eq!(list[0]["answering"], true);

    let (_, models) = spade.get("/v1/models").await?;
    assert_eq!(models["endpoints"][0]["key_source"], json!(null));
    spade
        .http
        .put(format!("{}/v1/keys/fake", spade.base))
        .bearer_auth(support::TOKEN)
        .json(&json!({ "key": "sk-test" }))
        .send()
        .await?;
    let (_, models) = spade.get("/v1/models").await?;
    assert_eq!(models["endpoints"][0]["key_source"], "keychain");
    Ok(())
}

#[tokio::test]
async fn an_image_a_tool_returns_is_kept_and_shown_to_the_model_after_the_results() -> Result {
    let shot = FakeTool::new("screenshot", Risk::Read, "Took a screenshot.").returning_image(PNG);
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "screenshot", json!({})),
            Script::reply("The page shows a login form."),
            Script::reply("").plain(r#"{"title":"Page"}"#),
        ],
        vec![std::sync::Arc::new(shot) as std::sync::Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("What is on the page?").await?;
    let events = spade.wait_for(&id, "renamed").await?;
    let finished = events.iter().find(|e| e["type"] == "tool_finished");
    assert_eq!(
        finished.map(|e| e["images"][0]["media_type"].clone()),
        Some(json!("image/png"))
    );
    let second = &spade.fake.seen()[1].body["messages"];
    let last = second
        .as_array()
        .and_then(|m| m.last())
        .cloned()
        .unwrap_or_default();
    assert_eq!(last["role"], "user");
    assert_eq!(
        last["content"][0]["text"],
        "[Images returned by screenshot]"
    );
    assert_eq!(
        last["content"][1]["image_url"]["url"],
        format!("data:image/png;base64,{}", STANDARD.encode(PNG))
    );
    Ok(())
}

#[tokio::test]
async fn a_refused_avatar_image_leaves_no_agent_behind() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (status, _) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Odd", "model": "fake/m",
                    "avatar": { "kind": "image", "data": STANDARD.encode(b"\x00\x00\x00\x18ftypheic") } }),
        )
        .await?;
    assert_eq!(status, 400);
    let (_, list) = spade.get("/v1/agents").await?;
    let kinds: Vec<_> = list["agents"]
        .as_array()
        .map(|a| a.iter().map(|a| a["kind"].clone()).collect())
        .unwrap_or_default();
    assert_eq!(kinds, vec![json!("main")], "only Spade itself");
    assert!(spade.fake.seen().is_empty());
    Ok(())
}
