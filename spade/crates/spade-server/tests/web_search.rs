//! `web_search` (ADR 0210, docs/design.md "Web search"): ace cloud search first, then the model
//! endpoint's own search, else one plain sentence. Through the real engine and API, on fake
//! endpoints and a local fake of ace cloud, with the clock in the test's hands.

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use spade_search::{Cloud, Credential, GrantFuture, NoGrant, RESTING, SIGN_IN, Search};
use spade_testkit::Script;
use support::{Options, Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Search"}"#)
}

/// A fake ace cloud: `/v1/search` answers with `answer` (a status, a `Retry-After`, a body),
/// `/v1/search/usage` with `usage`; `hits` counts searches.
#[derive(Clone)]
struct FakeCloud {
    answer: Arc<Mutex<(u16, Option<&'static str>, Value)>>,
    usage: Value,
    hits: Arc<AtomicUsize>,
}

impl FakeCloud {
    fn hits(&self) -> usize {
        self.hits.load(Ordering::Relaxed)
    }

    fn answer_with(&self, status: u16, retry: Option<&'static str>, body: Value) {
        if let Ok(mut answer) = self.answer.lock() {
            *answer = (status, retry, body);
        }
    }
}

async fn searched(State(cloud): State<FakeCloud>, headers: HeaderMap) -> Response {
    cloud.hits.fetch_add(1, Ordering::Relaxed);
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer grant-1") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some((status, retry, body)) = cloud.answer.lock().ok().map(|a| a.clone()) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (status, axum::Json(body)).into_response();
    if let Some(retry) = retry {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, header::HeaderValue::from_static(retry));
    }
    response
}

fn tokio_page() -> Value {
    json!({ "provider": "ceramic", "usage": {}, "results": [
        { "url": "https://tokio.rs/", "title": "Tokio", "snippet": "An async runtime", "site": "tokio.rs" },
        { "url": "https://docs.rs/tokio", "title": "tokio - Rust", "snippet": "API docs", "site": "docs.rs" }
    ]})
}

async fn fake_cloud(
    status: u16,
    retry: Option<&'static str>,
    body: Value,
) -> Result<(String, FakeCloud)> {
    let cloud = FakeCloud {
        answer: Arc::new(Mutex::new((status, retry, body))),
        usage: json!({ "month": { "used": 41, "allowance": 1000 }, "day": { "used": 3, "cap": 100 },
                       "resetsAt": "2026-12-01T00:00:00Z" }),
        hits: Arc::default(),
    };
    let app = axum::Router::new()
        .route("/v1/search", post(searched))
        .route(
            "/v1/search/usage",
            get(|State(cloud): State<FakeCloud>| async move { axum::Json(cloud.usage.clone()) }),
        )
        .with_state(cloud.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok((root, cloud))
}

/// The person's ace account: signed in (grant `grant-1`) or not.
struct Account(bool);

impl Credential for Account {
    fn grant(&self) -> GrantFuture<'_> {
        let signed_in = self.0;
        Box::pin(async move {
            if signed_in {
                Ok("grant-1".to_owned())
            } else {
                Err(NoGrant::SignedOut)
            }
        })
    }
}

/// A clock a test moves by hand.
#[derive(Clone)]
struct Hands(Arc<Mutex<Instant>>);

impl Hands {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(Instant::now())))
    }

    fn advance(&self, by: Duration) {
        if let Ok(mut now) = self.0.lock() {
            *now += by;
        }
    }
}

fn ace_search(url: &str, signed_in: bool, hands: &Hands) -> Result<Arc<Search>> {
    let clock = hands.0.clone();
    Ok(Arc::new(Search::new(Cloud {
        url: Some(url.to_owned()),
        credential: Arc::new(Account(signed_in)),
        ace_client: Some("spade/test".to_owned()),
        timeout: Duration::from_secs(5),
        clock: Arc::new(move || {
            clock
                .lock()
                .map(|now| *now)
                .unwrap_or_else(|_| Instant::now())
        }),
    })?))
}

fn with_search(search: Arc<Search>) -> Options {
    Options {
        search: Some(search),
        ..Options::default()
    }
}

/// Options whose ace search is signed out, at a cloud nothing should reach.
fn signed_out(hands: &Hands) -> Result<(Options, Arc<Search>)> {
    let search = ace_search("http://127.0.0.1:9", false, hands)?;
    Ok((with_search(search.clone()), search))
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
        signed_out(&Hands::new())?.0,
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
        signed_out(&Hands::new())?.0,
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

fn content(result: &Value) -> String {
    result["content"].as_str().unwrap_or_default().to_owned()
}

fn searches(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .filter(|e| e["type"] == "tool_finished" && e["name"] == "web_search")
        .cloned()
        .collect()
}

#[tokio::test]
async fn signed_in_a_bot_searches_with_ace_and_each_result_keeps_its_link() -> Result {
    let (root, cloud) = fake_cloud(200, None, tokio_page()).await?;
    let search = ace_search(&root, true, &Hands::new())?;
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio" })),
            Script::reply("Tokio is a runtime."),
            title(),
        ],
        Vec::new(),
        with_search(search),
    )
    .await?;
    let chat = spade.ask("Search for tokio").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let result = search_result(&events);
    assert_eq!(result["is_error"], false, "{result}");
    let text = content(&result);
    assert!(
        text.contains("1. Tokio\nhttps://tokio.rs/\nAn async runtime")
            && text.contains("https://docs.rs/tokio"),
        "{text}"
    );
    assert_eq!(cloud.hits(), 1);
    Ok(())
}

#[tokio::test]
async fn when_ace_search_refuses_the_endpoints_own_search_answers() -> Result {
    let answer = json!({
        "content": [
            { "type": "server_tool_use", "id": "s1", "name": "web_search", "input": {} },
            { "type": "web_search_tool_result", "tool_use_id": "s1", "content": [
                { "type": "web_search_result", "url": "https://tokio.rs/blog",
                  "title": "Tokio 2.0", "encrypted_content": "x" } ] },
            { "type": "text", "text": "Tokio 2.0 is out." }
        ],
        "usage": { "input_tokens": 50, "output_tokens": 10,
                   "server_tool_use": { "web_search_requests": 1 } }
    });
    let refusal = json!({ "error": "daily_spent", "retryAfter": 3600,
        "reason": "You've used today's ace searches. They come back tomorrow." });
    let (root, cloud) = fake_cloud(429, Some("3600"), refusal).await?;
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio 2.0" })),
            Script::raw(answer),
            Script::reply("It is out."),
            title(),
        ],
        Vec::new(),
        with_search(ace_search(&root, true, &Hands::new())?),
    )
    .await?;
    let chat = bot_on(&spade, "seeker", "seek-1").await?;
    spade.say(&chat, "Is Tokio 2.0 out?").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let result = search_result(&events);
    assert_eq!(result["is_error"], false, "{result}");
    assert!(
        content(&result).contains("https://tokio.rs/blog"),
        "{result}"
    );
    assert_eq!(cloud.hits(), 1, "ace search was asked first");
    Ok(())
}

#[tokio::test]
async fn a_refusal_is_the_answer_without_asking_again_until_retry_after_passes() -> Result {
    let reason = "You've used today's ace searches. They come back tomorrow.";
    let refusal = json!({ "error": "daily_spent", "reason": reason, "retryAfter": 600 });
    let (root, cloud) = fake_cloud(429, Some("600"), refusal).await?;
    let hands = Hands::new();
    let search = ace_search(&root, true, &hands)?;
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio" })),
            Script::reply("").call("w2", "web_search", json!({ "query": "tokio again" })),
            Script::reply("No searches left today."),
            title(),
        ],
        Vec::new(),
        with_search(search.clone()),
    )
    .await?;
    let chat = spade.ask("Search for tokio").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let results = searches(&events);
    assert_eq!(results.len(), 2, "{events:?}");
    for result in &results {
        assert_eq!(
            (result["is_error"].clone(), content(result)),
            (json!(true), reason.to_owned())
        );
    }
    assert_eq!(cloud.hits(), 1, "the second search waited");

    hands.advance(Duration::from_secs(601));
    cloud.answer_with(200, None, tokio_page());
    assert!(search.search("tokio", 5).await.is_ok());
    assert_eq!(cloud.hits(), 2, "asked again once Retry-After passed");
    Ok(())
}

#[tokio::test]
async fn when_ace_search_is_resting_and_the_model_has_no_search_the_bot_is_told_so() -> Result {
    let (root, _) = fake_cloud(
        429,
        Some("60"),
        json!({ "error": "resting",
        "reason": "ace search is resting today.", "retryAfter": 60 }),
    )
    .await?;
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio" })),
            Script::reply("Search is resting."),
            title(),
        ],
        Vec::new(),
        with_search(ace_search(&root, true, &Hands::new())?),
    )
    .await?;
    let chat = spade.ask("Search for tokio").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let result = search_result(&events);
    assert_eq!(
        (result["is_error"].clone(), content(&result)),
        (json!(true), RESTING.to_owned())
    );
    Ok(())
}

#[tokio::test]
async fn signed_out_with_no_endpoint_search_the_bot_is_told_to_sign_in() -> Result {
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio" })),
            Script::reply("Sign in to ace."),
            title(),
        ],
        Vec::new(),
        signed_out(&Hands::new())?.0,
    )
    .await?;
    let chat = spade.ask("Search for tokio").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    let result = search_result(&events);
    assert_eq!(
        (result["is_error"].clone(), content(&result)),
        (json!(true), SIGN_IN.to_owned())
    );
    Ok(())
}

#[tokio::test]
async fn a_home_with_old_search_settings_starts_and_searches_with_ace() -> Result {
    let dir = tempfile::tempdir()?;
    std::fs::write(
        dir.path().join("search.json"),
        json!({ "backends": [
            { "id": "searxng", "name": "SearXNG", "kind": "searxng", "base_url": "http://127.0.0.1:9/" },
            { "id": "brave", "name": "Brave", "kind": "brave", "key": { "env": "BRAVE_API_KEY" } },
            { "id": "other", "kind": "someday", "surprise": true }
        ]})
        .to_string(),
    )?;
    let store = spade_store::Store::open(&dir.path().join("spade.sqlite"))?;
    store.set_setting("searxng_url", Some("http://127.0.0.1:9/"))?;
    drop(store);
    let (root, cloud) = fake_cloud(200, None, tokio_page()).await?;
    let spade = Spade::start_in(
        dir,
        vec![
            Script::reply("").call("w1", "web_search", json!({ "query": "tokio" })),
            Script::reply("Found it."),
            title(),
        ],
        with_search(ace_search(&root, true, &Hands::new())?),
    )
    .await?;
    let chat = spade.ask("Search for tokio").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    assert!(content(&search_result(&events)).contains("https://tokio.rs/"));
    assert_eq!(cloud.hits(), 1);
    Ok(())
}

#[tokio::test]
async fn there_is_no_search_setting_to_change() -> Result {
    let spade = Spade::start_with(Vec::new(), Vec::new(), signed_out(&Hands::new())?.0).await?;
    for (status, _) in [
        spade.get("/v1/search").await?,
        spade
            .put(
                "/v1/search",
                json!({ "searxng_url": "http://127.0.0.1:8888" }),
            )
            .await?,
        spade
            .put("/v1/search/brave-key", json!({ "key": "BSA-secret" }))
            .await?,
        spade.delete("/v1/search/brave-key").await?,
    ] {
        assert!(matches!(status, 404 | 405), "{status}");
    }
    Ok(())
}

#[tokio::test]
async fn usage_shows_this_months_searches_or_that_the_person_is_signed_out() -> Result {
    let (root, _) = fake_cloud(200, None, tokio_page()).await?;
    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        with_search(ace_search(&root, true, &Hands::new())?),
    )
    .await?;
    let (status, usage) = spade.get("/v1/usage/search").await?;
    assert_eq!(status, 200, "{usage}");
    assert_eq!(
        usage,
        json!({ "signed_in": true, "used": 41, "allowance": 1000,
                "resets_at": "2026-12-01T00:00:00Z" })
    );

    let away = Spade::start_with(
        Vec::new(),
        Vec::new(),
        with_search(ace_search("http://127.0.0.1:9", true, &Hands::new())?),
    )
    .await?;
    let (_, usage) = away.get("/v1/usage/search").await?;
    assert_eq!(
        usage,
        json!({ "signed_in": true, "used": null, "allowance": null, "resets_at": null })
    );

    let out = Spade::start_with(Vec::new(), Vec::new(), signed_out(&Hands::new())?.0).await?;
    let (_, usage) = out.get("/v1/usage/search").await?;
    assert_eq!(usage["signed_in"], false);
    assert_eq!(usage["used"], Value::Null);
    Ok(())
}
