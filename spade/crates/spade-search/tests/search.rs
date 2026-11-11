//! The real search client over HTTP against local fake SearXNG and Brave servers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};
use spade_keys::Keys;
use spade_search::{Search, SearchConfig, SearchError};
use tokio::net::TcpListener;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// How a fake service answers.
#[derive(Clone)]
enum Answer {
    Json(Value),
    Status(u16),
    Slow(Duration, Value),
    /// A redirect to this address.
    Redirect(String),
    /// A body that never ends, counting the bytes handed out in `sent`.
    Endless(Arc<AtomicUsize>),
}

#[derive(Clone, Debug)]
struct Seen {
    query: HashMap<String, String>,
    token: Option<String>,
}

#[derive(Clone)]
struct Fake {
    answer: Answer,
    seen: Arc<Mutex<Vec<Seen>>>,
}

struct Running {
    root: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Running {
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

async fn answer(
    State(fake): State<Fake>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let token = headers
        .get("x-subscription-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if let Ok(mut seen) = fake.seen.lock() {
        seen.push(Seen { query, token });
    }
    match fake.answer {
        Answer::Json(body) => axum::Json(body).into_response(),
        Answer::Status(code) => StatusCode::from_u16(code)
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
            .into_response(),
        Answer::Slow(pause, body) => {
            tokio::time::sleep(pause).await;
            axum::Json(body).into_response()
        }
        Answer::Redirect(to) => (StatusCode::FOUND, [(header::LOCATION, to)]).into_response(),
        Answer::Endless(sent) => {
            let chunks = futures_util::stream::repeat_with(move || {
                sent.fetch_add(CHUNK, Ordering::Relaxed);
                Ok::<_, std::io::Error>(vec![b' '; CHUNK])
            });
            Body::from_stream(chunks).into_response()
        }
    }
}

const CHUNK: usize = 64 * 1024;

async fn start(answer_with: Answer) -> Result<Running> {
    let fake = Fake {
        answer: answer_with,
        seen: Arc::default(),
    };
    let app = Router::new()
        .route("/search", get(answer))
        .route("/web/search", get(answer))
        .with_state(fake.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok(Running {
        root,
        seen: fake.seen,
    })
}

fn searxng_page() -> Value {
    json!({ "query": "rust", "results": [
        { "url": "https://www.rust-lang.org/", "title": "Rust", "content": "A language <b>empowering</b> everyone", "engine": "duckduckgo" },
        { "url": "https://www.rust-lang.org", "title": "Rust again", "content": "same page" },
        { "url": "https://doc.rust-lang.org/book/", "title": "The Book", "content": "Learn &amp; build" },
        { "url": "https://crates.io/", "title": "crates.io", "content": "The registry" }
    ]})
}

fn brave_page() -> Value {
    json!({ "type": "search", "web": { "results": [
        { "url": "https://tokio.rs/", "title": "<strong>Tokio</strong>", "description": "An async runtime" }
    ]}})
}

/// SearXNG at `searxng`, then Brave at `brave` with its key in the keychain (or not).
fn search(
    searxng: &str,
    brave: &str,
    brave_key: Option<&'static str>,
    timeout_ms: u64,
) -> Result<Search> {
    let config = SearchConfig::from_json(
        &json!({ "backends": [
            { "id": "searxng", "name": "SearXNG", "kind": "searxng", "base_url": searxng },
            { "id": "brave", "name": "Brave", "kind": "brave", "base_url": brave, "key": {} }
        ]})
        .to_string(),
    )?;
    let keys = Keys::keychain_then_env(
        move |endpoint| {
            (endpoint == "brave")
                .then(|| brave_key.map(str::to_owned))
                .flatten()
        },
        |_| None,
    );
    Ok(Search::new(
        config,
        keys,
        Duration::from_millis(timeout_ms),
    )?)
}

#[tokio::test]
async fn searxng_results_come_back_cleaned_deduplicated_and_counted() -> Result {
    let searxng = start(Answer::Json(searxng_page())).await?;
    let brave = start(Answer::Json(brave_page())).await?;
    let found = search(&searxng.root, &brave.root, Some("brave-key"), 2000)?
        .search("  rust  ", 2)
        .await?;

    assert_eq!(found.backend, "searxng");
    let read: Vec<_> = found
        .results
        .iter()
        .map(|r| (r.title.as_str(), r.snippet.as_str()))
        .collect();
    assert_eq!(
        read,
        vec![
            ("Rust", "A language empowering everyone"),
            ("The Book", "Learn & build")
        ]
    );
    let request = &searxng.seen()[0];
    assert_eq!(request.query.get("q").map(String::as_str), Some("rust"));
    assert_eq!(
        request.query.get("format").map(String::as_str),
        Some("json")
    );
    assert!(brave.seen().is_empty(), "Brave should not be asked");
    Ok(())
}

#[tokio::test]
async fn when_searxng_is_down_brave_answers_with_the_keychain_key() -> Result {
    let searxng = start(Answer::Status(502)).await?;
    let brave = start(Answer::Json(brave_page())).await?;
    let found = search(&searxng.root, &brave.root, Some("brave-key"), 2000)?
        .search("tokio", 5)
        .await?;

    assert_eq!(found.backend, "brave");
    assert_eq!(found.results[0].title, "Tokio");
    let request = &brave.seen()[0];
    assert_eq!(request.token.as_deref(), Some("brave-key"));
    assert_eq!(request.query.get("count").map(String::as_str), Some("5"));
    Ok(())
}

#[tokio::test]
async fn a_slow_backend_is_abandoned_for_the_next() -> Result {
    let searxng = start(Answer::Slow(Duration::from_secs(3), searxng_page())).await?;
    let brave = start(Answer::Json(brave_page())).await?;
    let found = search(&searxng.root, &brave.root, Some("brave-key"), 300)?
        .search("tokio", 5)
        .await?;
    assert_eq!(found.backend, "brave");
    Ok(())
}

#[tokio::test]
async fn when_every_backend_fails_each_reason_is_given_and_no_key_appears() -> Result {
    let searxng = start(Answer::Status(403)).await?;
    let brave = start(Answer::Status(401)).await?;
    let error = search(&searxng.root, &brave.root, Some("brave-secret"), 2000)?
        .search("tokio", 5)
        .await;

    let Err(SearchError::AllFailed(reasons)) = &error else {
        return Err(format!("expected AllFailed, got {error:?}").into());
    };
    assert_eq!(reasons.len(), 2);
    assert!(reasons[0].1.contains("settings.yml"), "{reasons:?}");
    assert!(reasons[1].1.contains("check the key"), "{reasons:?}");
    let shown = format!(
        "{error:?} {}",
        error
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_default()
    );
    assert!(!shown.contains("brave-secret"), "{shown}");
    Ok(())
}

#[tokio::test]
async fn brave_without_a_key_is_skipped_without_a_request() -> Result {
    let searxng = start(Answer::Status(500)).await?;
    let brave = start(Answer::Json(brave_page())).await?;
    let error = search(&searxng.root, &brave.root, None, 2000)?
        .search("tokio", 5)
        .await;

    assert!(
        matches!(&error, Err(SearchError::AllFailed(r)) if r[1].1.contains("no key")),
        "{error:?}"
    );
    assert!(brave.seen().is_empty());
    Ok(())
}

#[tokio::test]
async fn an_empty_query_never_reaches_a_backend() -> Result {
    let searxng = start(Answer::Json(searxng_page())).await?;
    let brave = start(Answer::Json(brave_page())).await?;
    let error = search(&searxng.root, &brave.root, Some("k"), 2000)?
        .search("   ", 5)
        .await;
    assert_eq!(error, Err(SearchError::EmptyQuery));
    assert!(searxng.seen().is_empty() && brave.seen().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_brave_redirect_is_not_followed_so_the_key_never_reaches_another_server() -> Result {
    let elsewhere = start(Answer::Json(brave_page())).await?;
    let searxng = start(Answer::Status(502)).await?;
    let brave = start(Answer::Redirect(format!("{}web/search", elsewhere.root))).await?;
    let error = search(&searxng.root, &brave.root, Some("brave-secret"), 2000)?
        .search("tokio", 5)
        .await;

    assert!(
        matches!(&error, Err(SearchError::AllFailed(r)) if r[1].1.contains("redirected")),
        "{error:?}"
    );
    assert_eq!(brave.seen().len(), 1);
    assert!(elsewhere.seen().is_empty(), "{:?}", elsewhere.seen());
    Ok(())
}

#[tokio::test]
async fn an_oversized_answer_is_refused_early_and_the_next_backend_answers() -> Result {
    let sent = Arc::new(AtomicUsize::new(0));
    let searxng = start(Answer::Endless(sent.clone())).await?;
    let brave = start(Answer::Json(brave_page())).await?;
    let found = search(&searxng.root, &brave.root, Some("brave-key"), 5000)?
        .search("tokio", 5)
        .await?;

    assert_eq!(found.backend, "brave");
    // The cap is 2 MiB; what was handed out past it is only what socket buffers held.
    let sent = sent.load(Ordering::Relaxed);
    assert!(sent < 32 * 1024 * 1024, "{sent} bytes were sent");
    Ok(())
}

#[tokio::test]
async fn one_odd_item_does_not_lose_the_good_ones() -> Result {
    let page = json!({ "results": [
        { "url": "https://www.rust-lang.org/", "title": "Rust", "content": null },
        { "url": "https://doc.rust-lang.org/book/", "title": 42, "content": "The book" },
        { "title": "No address", "content": "skipped" },
        { "url": "https://crates.io/", "title": "crates.io", "content": "The registry" }
    ]});
    let searxng = start(Answer::Json(page)).await?;
    let brave = start(Answer::Json(brave_page())).await?;
    let found = search(&searxng.root, &brave.root, Some("brave-key"), 2000)?
        .search("rust", 10)
        .await?;

    assert_eq!(found.backend, "searxng");
    let read: Vec<_> = found
        .results
        .iter()
        .map(|r| (r.title.as_str(), r.url.as_str(), r.snippet.as_str()))
        .collect();
    assert_eq!(
        read,
        vec![
            ("Rust", "https://www.rust-lang.org/", ""),
            ("", "https://doc.rust-lang.org/book/", "The book"),
            ("crates.io", "https://crates.io/", "The registry"),
        ]
    );
    Ok(())
}
