//! `web_search` out of the box (docs/design.md, Web search): the endpoint's own search first,
//! then the person's SearXNG and Brave, and a pointer to the settings when nothing is set up.
//! Through the real engine and API, on fake endpoints and a mock keychain.

mod support;

use axum::Json;
use axum::routing::get;
use serde_json::{Value, json};
use spade_search::SearchConfig;
use spade_server::tools::NOT_SET_UP;
use spade_testkit::Script;
use support::{Options, Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Search"}"#)
}

/// An address nothing listens on.
async fn closed_root() -> Result<String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    drop(listener);
    Ok(root)
}

/// The shipped order, SearXNG then Brave, at addresses where nothing answers.
async fn nothing_set_up() -> Result<Options> {
    let config = SearchConfig::from_json(
        &json!({ "backends": [
            { "id": "searxng", "name": "SearXNG", "kind": "searxng", "base_url": closed_root().await? },
            { "id": "brave", "name": "Brave", "kind": "brave", "base_url": closed_root().await?,
              "key": { "env": "BRAVE_API_KEY" } }
        ]})
        .to_string(),
    )?;
    Ok(Options {
        search: Some(config),
        ..Options::default()
    })
}

/// A SearXNG that answers every search with one page.
async fn searxng() -> Result<String> {
    let app = axum::Router::new().route(
        "/search",
        get(|| async {
            Json(json!({ "results": [
                { "title": "Tokio", "url": "https://tokio.rs/", "content": "An async runtime" }
            ]}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok(root)
}

/// A bot on `preset`'s model, its endpoint served by the fake.
async fn bot_on(spade: &Spade, preset: &str, model: &str) -> Result<String> {
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": preset, "preset": preset, "base_url": spade.fake.root,
                    "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let endpoint = body["endpoint"]["id"].as_str().unwrap_or_default();
    let (status, agent) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Finder", "model": format!("{endpoint}/{model}") }),
        )
        .await?;
    assert_eq!(status, 201, "{agent}");
    Ok(agent["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

fn search_result(events: &[Value]) -> Value {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["name"] == "web_search")
        .cloned()
        .unwrap_or_default()
}

async fn spent(spade: &Spade, conversation: &str) -> Result<u64> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["conversation"] == conversation))
        .and_then(|a| a["spending"]["today_micros"].as_u64())
        .unwrap_or(0))
}

#[tokio::test]
async fn an_anthropic_model_searches_with_its_own_endpoint_and_each_search_is_paid_for() -> Result {
    let answer = json!({
        "content": [
            { "type": "server_tool_use", "id": "s1", "name": "web_search", "input": {} },
            { "type": "web_search_tool_result", "tool_use_id": "s1", "content": [
                { "type": "web_search_result", "url": "https://tokio.rs/blog",
                  "title": "Tokio 2.0", "encrypted_content": "x" } ] },
            { "type": "text", "text": "Tokio 2.0 is out.",
              "citations": [{ "type": "web_search_result_location", "url": "https://tokio.rs/blog",
                              "title": "Tokio 2.0", "cited_text": "Tokio 2.0 released" }] }
        ],
        "usage": { "input_tokens": 50, "output_tokens": 10,
                   "server_tool_use": { "web_search_requests": 1 } }
    });
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio 2.0" })),
            Script::raw(answer),
            Script::reply("It is out."),
            title(),
        ],
        Vec::new(),
        nothing_set_up().await?,
    )
    .await?;
    let chat = bot_on(&spade, "seeker", "seek-1").await?;
    spade.say(&chat, "Is Tokio 2.0 out?").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let result = search_result(&events);
    assert_eq!(result["is_error"], false, "{result}");
    let content = result["content"].as_str().unwrap_or_default();
    assert!(content.starts_with("Tokio 2.0 is out."), "{content}");
    assert!(
        content.contains("https://tokio.rs/blog") && content.contains("Tokio 2.0 released"),
        "{content}"
    );
    let asked = spade
        .fake
        .seen()
        .into_iter()
        .find(|s| s.body["tools"][0]["type"] == "web_search_20250305")
        .ok_or("the endpoint's search tool was never asked for")?;
    assert_eq!(asked.path, "/messages");
    assert!(
        spent(&spade, &chat).await? >= 500_000,
        "one search at $0.50"
    );
    Ok(())
}

#[tokio::test]
async fn an_openai_responses_model_searches_with_its_own_endpoint() -> Result {
    let answer = json!({
        "output": [
            { "type": "web_search_call", "id": "ws1", "status": "completed",
              "action": { "type": "search", "query": "tokio" } },
            { "type": "message", "role": "assistant", "content": [
                { "type": "output_text", "text": "Tokio is an async runtime.",
                  "annotations": [{ "type": "url_citation", "url": "https://tokio.rs/",
                                    "title": "Tokio", "start_index": 0, "end_index": 25 }] }] }
        ],
        "usage": { "input_tokens": 50, "output_tokens": 10 }
    });
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio" })),
            Script::raw(answer),
            Script::reply("Found it."),
            title(),
        ],
        Vec::new(),
        nothing_set_up().await?,
    )
    .await?;
    let chat = bot_on(&spade, "looker", "look-1").await?;
    spade.say(&chat, "What is Tokio?").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let content = search_result(&events)["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(
        content.contains("https://tokio.rs/") && content.contains("Tokio is an async runtime"),
        "{content}"
    );
    assert!(
        spade
            .fake
            .seen()
            .iter()
            .any(|s| s.path == "/responses" && s.body["tools"][0]["type"] == "web_search")
    );
    assert!(spent(&spade, &chat).await? >= 500_000);
    Ok(())
}

#[tokio::test]
async fn with_nothing_set_up_the_bot_is_told_to_point_the_person_at_the_setting() -> Result {
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio" })),
            Script::reply("Add a search key in Settings."),
            title(),
        ],
        Vec::new(),
        nothing_set_up().await?,
    )
    .await?;
    let chat = spade.ask("Search for tokio").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let result = search_result(&events);
    assert_eq!(result["is_error"], true);
    let content = result["content"].as_str().unwrap_or_default();
    assert!(content.starts_with(NOT_SET_UP), "{content}");
    assert!(
        content.contains("Settings › Spade › Web search"),
        "{content}"
    );
    Ok(())
}

#[tokio::test]
async fn the_person_sets_up_brave_and_searxng_in_settings_and_search_uses_them() -> Result {
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio" })),
            Script::reply("Tokio is a runtime."),
            title(),
        ],
        Vec::new(),
        nothing_set_up().await?,
    )
    .await?;
    let (status, shown) = spade.get("/v1/search").await?;
    assert_eq!(status, 200, "{shown}");
    assert_eq!(
        (&shown["searxng_url"], &shown["brave_key_set"]),
        (&Value::Null, &json!(false))
    );

    let (status, _) = spade
        .put("/v1/search/brave-key", json!({ "key": "BSA-secret" }))
        .await?;
    assert_eq!(status, 204);
    let (_, shown) = spade.get("/v1/search").await?;
    assert_eq!(shown["brave_key_set"], true);
    assert!(
        !shown.to_string().contains("BSA-secret"),
        "never shown again"
    );

    let (status, refused) = spade
        .put("/v1/search", json!({ "searxng_url": "ftp://example.org" }))
        .await?;
    assert_eq!(status, 400, "{refused}");
    let mine = searxng().await?;
    let (status, shown) = spade
        .put(
            "/v1/search",
            json!({ "searxng_url": mine.trim_end_matches('/') }),
        )
        .await?;
    assert_eq!((status, &shown["searxng_url"]), (200, &json!(mine)));

    let chat = spade.ask("Search for tokio").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let content = search_result(&events)["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(content.contains("https://tokio.rs/"), "{content}");

    let (status, _) = spade.delete("/v1/search/brave-key").await?;
    assert_eq!(status, 204);
    let (status, shown) = spade
        .put("/v1/search", json!({ "searxng_url": null }))
        .await?;
    assert_eq!(status, 200);
    assert_eq!(
        (&shown["searxng_url"], &shown["brave_key_set"]),
        (&Value::Null, &json!(false))
    );
    Ok(())
}

#[tokio::test]
async fn when_the_endpoints_own_search_fails_the_backends_are_tried_and_answer() -> Result {
    let mine = searxng().await?;
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio" })),
            Script::failing(400),
            Script::reply("Found it."),
            title(),
        ],
        Vec::new(),
        nothing_set_up().await?,
    )
    .await?;
    let (status, _) = spade
        .put("/v1/search", json!({ "searxng_url": mine }))
        .await?;
    assert_eq!(status, 200);
    let chat = bot_on(&spade, "seeker", "seek-1").await?;
    spade.say(&chat, "What is Tokio?").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let result = search_result(&events);
    assert_eq!(result["is_error"], false, "{result}");
    assert!(
        result["content"]
            .as_str()
            .is_some_and(|c| c.contains("https://tokio.rs/")),
        "{result}"
    );
    Ok(())
}
