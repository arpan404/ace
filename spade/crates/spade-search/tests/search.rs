//! The real ace search client over HTTP against a local fake of ace cloud's `/v1/search`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use spade_search::{
    Cloud, Credential, GrantFuture, NoGrant, RESTING, SIGN_IN, Search, SearchError, Usage,
};
use tokio::net::TcpListener;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// How the fake cloud answers.
#[derive(Clone)]
enum Answer {
    Json(Value),
    /// A status, an optional `Retry-After` and a JSON body.
    Status(u16, Option<&'static str>, Value),
    Slow(Duration),
    Redirect(String),
    /// A body that never ends, counting the bytes handed out.
    Endless(Arc<AtomicUsize>),
}

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    bearer: Option<String>,
    client: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct Fake {
    answer: Arc<Mutex<Answer>>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Fake {
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn answer_with(&self, answer: Answer) {
        if let Ok(mut current) = self.answer.lock() {
            *current = answer;
        }
    }
}

const CHUNK: usize = 64 * 1024;

async fn reply(fake: &Fake, path: &str, headers: &HeaderMap, body: &str) -> Response {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    if let Ok(mut seen) = fake.seen.lock() {
        seen.push(Seen {
            path: path.to_owned(),
            bearer: header("authorization"),
            client: header("ace-client"),
            body: serde_json::from_str(body).unwrap_or_default(),
        });
    }
    let answer = fake.answer.lock().ok().map(|a| a.clone());
    match answer {
        Some(Answer::Json(body)) => axum::Json(body).into_response(),
        Some(Answer::Status(code, retry, body)) => {
            let status = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let mut response = (status, axum::Json(body)).into_response();
            if let Some(retry) = retry {
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, header::HeaderValue::from_static(retry));
            }
            response
        }
        Some(Answer::Slow(pause)) => {
            tokio::time::sleep(pause).await;
            axum::Json(page()).into_response()
        }
        Some(Answer::Redirect(to)) => {
            (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, to)]).into_response()
        }
        Some(Answer::Endless(sent)) => {
            let chunks = futures_util::stream::repeat_with(move || {
                sent.fetch_add(CHUNK, Ordering::Relaxed);
                Ok::<_, std::io::Error>(vec![b' '; CHUNK])
            });
            Body::from_stream(chunks).into_response()
        }
        None => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// A fake ace cloud answering `/v1/search` and `/v1/search/usage` with `answer`, at its root.
async fn cloud(answer: Answer) -> Result<(String, Fake)> {
    let fake = Fake {
        answer: Arc::new(Mutex::new(answer)),
        seen: Arc::default(),
    };
    let app = Router::new()
        .route(
            "/v1/search",
            post(
                |State(f): State<Fake>, h: HeaderMap, b: String| async move {
                    reply(&f, "/v1/search", &h, &b).await
                },
            ),
        )
        .route(
            "/v1/search/usage",
            get(|State(f): State<Fake>, h: HeaderMap| async move {
                reply(&f, "/v1/search/usage", &h, "").await
            }),
        )
        .with_state(fake.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok((root, fake))
}

fn page() -> Value {
    json!({ "provider": "ceramic", "usage": { "month": { "used": 3 } }, "extra": true,
    "results": [
        { "url": "https://www.rust-lang.org/", "title": "Rust", "snippet": "A language <b>empowering</b> everyone", "site": "rust-lang.org", "score": 0.9 },
        { "url": "https://www.rust-lang.org", "title": "Rust again", "snippet": "same page" },
        { "title": "no url", "snippet": "skipped" },
        { "url": 7, "title": "a number" },
        { "url": "https://doc.rust-lang.org/book/", "title": "The Book" },
        { "url": "https://crates.io/", "title": "crates.io", "snippet": "The registry" }
    ]})
}

/// A grant, or none because the person is signed out; counts how often it was asked for.
struct Account {
    signed_in: bool,
    asked: AtomicUsize,
}

impl Credential for Account {
    fn grant(&self) -> GrantFuture<'_> {
        self.asked.fetch_add(1, Ordering::Relaxed);
        let signed_in = self.signed_in;
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

fn search_at(
    url: Option<String>,
    signed_in: bool,
    hands: &Hands,
    timeout: Duration,
) -> Result<(Search, Arc<Account>)> {
    let account = Arc::new(Account {
        signed_in,
        asked: AtomicUsize::new(0),
    });
    let clock = hands.0.clone();
    let search = Search::new(Cloud {
        url,
        credential: account.clone(),
        ace_client: Some("spade/test".to_owned()),
        timeout,
        clock: Arc::new(move || {
            clock
                .lock()
                .map(|now| *now)
                .unwrap_or_else(|_| Instant::now())
        }),
    })?;
    Ok((search, account))
}

fn search(url: &str, hands: &Hands) -> Result<Search> {
    Ok(search_at(Some(url.to_owned()), true, hands, Duration::from_secs(2))?.0)
}

#[tokio::test]
async fn results_come_back_cleaned_with_their_links_and_the_request_carries_the_grant() -> Result {
    let (root, fake) = cloud(Answer::Json(page())).await?;
    let long = format!("  {}é{}  ", "a".repeat(398), "b".repeat(50));
    let found = search(&root, &Hands::new())?.search(&long, 50).await?;
    assert_eq!(found.provider, "ceramic");
    let shown: Vec<_> = found
        .results
        .iter()
        .map(|r| (r.url.as_str(), r.title.as_str(), r.snippet.as_str()))
        .collect();
    assert_eq!(
        shown,
        vec![
            (
                "https://www.rust-lang.org/",
                "Rust",
                "A language empowering everyone"
            ),
            ("https://doc.rust-lang.org/book/", "The Book", ""),
            ("https://crates.io/", "crates.io", "The registry"),
        ]
    );
    assert_eq!(found.results[0].site, "rust-lang.org");

    let asked = &fake.seen()[0];
    assert_eq!(asked.path, "/v1/search");
    assert_eq!(asked.bearer.as_deref(), Some("Bearer grant-1"));
    assert_eq!(asked.client.as_deref(), Some("spade/test"));
    assert_eq!(asked.body["limit"], 10, "at most 10 asked for");
    let query = asked.body["query"].as_str().unwrap_or_default();
    assert_eq!(
        query.chars().count(),
        400,
        "trimmed, then cut at 400 characters"
    );
    assert!(query.starts_with('a') && query.ends_with("éb"), "{query}");
    Ok(())
}

#[tokio::test]
async fn a_daily_refusal_is_the_answer_until_retry_after_has_passed() -> Result {
    let refusal = json!({ "error": "daily_spent",
        "reason": "You've used today's ace searches. They come back tomorrow.", "retryAfter": 120 });
    let (root, fake) = cloud(Answer::Status(429, Some("120"), refusal)).await?;
    let hands = Hands::new();
    let search = search(&root, &hands)?;
    let refused = SearchError::Refused {
        error: "daily_spent".to_owned(),
        reason: "You've used today's ace searches. They come back tomorrow.".to_owned(),
    };
    assert_eq!(search.search("tokio", 5).await, Err(refused.clone()));
    hands.advance(Duration::from_secs(119));
    assert_eq!(search.search("serde", 5).await, Err(refused));
    assert_eq!(fake.seen().len(), 1, "no request while waiting");

    hands.advance(Duration::from_secs(2));
    fake.answer_with(Answer::Json(page()));
    assert!(search.search("serde", 5).await.is_ok());
    assert_eq!(fake.seen().len(), 2, "asked again once the wait passed");
    Ok(())
}

#[tokio::test]
async fn the_breaker_says_ace_search_is_resting_and_a_missing_retry_after_waits_a_minute() -> Result
{
    let (root, fake) = cloud(Answer::Status(429, None, json!({ "error": "resting" }))).await?;
    let hands = Hands::new();
    let search = search(&root, &hands)?;
    let error = search.search("tokio", 5).await.err().ok_or("refused")?;
    assert_eq!(error.to_string(), RESTING);
    hands.advance(Duration::from_secs(59));
    assert!(search.search("tokio", 5).await.is_err());
    assert_eq!(fake.seen().len(), 1);
    hands.advance(Duration::from_secs(2));
    let _ = search.search("tokio", 5).await;
    assert_eq!(fake.seen().len(), 2);
    Ok(())
}

#[tokio::test]
async fn a_failure_waits_thirty_seconds_before_asking_again() -> Result {
    let (root, fake) = cloud(Answer::Status(
        502,
        None,
        json!({ "error": "search_failed" }),
    ))
    .await?;
    let hands = Hands::new();
    let search = search(&root, &hands)?;
    assert!(matches!(
        search.search("tokio", 5).await,
        Err(SearchError::Failed(_))
    ));
    hands.advance(Duration::from_secs(29));
    assert!(matches!(
        search.search("tokio", 5).await,
        Err(SearchError::Failed(_))
    ));
    assert_eq!(fake.seen().len(), 1);
    hands.advance(Duration::from_secs(2));
    fake.answer_with(Answer::Json(page()));
    assert!(search.search("tokio", 5).await.is_ok());
    Ok(())
}

#[tokio::test]
async fn signed_out_asks_nothing_and_a_refused_grant_means_sign_in() -> Result {
    let (root, fake) = cloud(Answer::Json(page())).await?;
    let hands = Hands::new();
    let (search, _) = search_at(Some(root.clone()), false, &hands, Duration::from_secs(2))?;
    let error = search.search("tokio", 5).await.err().ok_or("signed out")?;
    assert_eq!(
        (error.clone(), error.to_string()),
        (SearchError::SignedOut, SIGN_IN.to_owned())
    );
    assert!(fake.seen().is_empty());

    fake.answer_with(Answer::Status(
        401,
        None,
        json!({ "error": "unauthenticated" }),
    ));
    let search = self::search(&root, &hands)?;
    assert_eq!(search.search("tokio", 5).await, Err(SearchError::SignedOut));
    Ok(())
}

#[tokio::test]
async fn an_oversized_answer_is_refused_without_reading_it_all() -> Result {
    let sent = Arc::new(AtomicUsize::new(0));
    let (root, _) = cloud(Answer::Endless(sent.clone())).await?;
    let error = search(&root, &Hands::new())?.search("tokio", 5).await;
    assert!(matches!(error, Err(SearchError::Failed(_))), "{error:?}");
    assert!(
        sent.load(Ordering::Relaxed) < 4 * 1024 * 1024,
        "stopped reading early"
    );
    Ok(())
}

#[tokio::test]
async fn a_redirect_is_not_followed_so_the_grant_never_reaches_another_server() -> Result {
    let (elsewhere, other) = cloud(Answer::Json(page())).await?;
    let (root, _) = cloud(Answer::Redirect(format!("{elsewhere}/v1/search"))).await?;
    let error = search(&root, &Hands::new())?.search("tokio", 5).await;
    assert!(matches!(error, Err(SearchError::Failed(_))), "{error:?}");
    assert!(other.seen().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_slow_cloud_times_out_as_a_failure() -> Result {
    let (root, _) = cloud(Answer::Slow(Duration::from_secs(3))).await?;
    let (search, _) = search_at(Some(root), true, &Hands::new(), Duration::from_millis(300))?;
    assert!(matches!(
        search.search("tokio", 5).await,
        Err(SearchError::Failed(_))
    ));
    Ok(())
}

#[tokio::test]
async fn off_or_an_insecure_address_never_shows_the_grant() -> Result {
    let hands = Hands::new();
    let (off, account) = search_at(None, true, &hands, Duration::from_secs(2))?;
    assert_eq!(off.search("tokio", 5).await, Err(SearchError::Off));
    let (plain, _) = search_at(
        Some("http://cloud.example".to_owned()),
        true,
        &hands,
        Duration::from_secs(2),
    )?;
    assert!(matches!(
        plain.search("tokio", 5).await,
        Err(SearchError::Failed(_))
    ));
    assert_eq!(account.asked.load(Ordering::Relaxed), 0);
    assert_eq!(off.search("   ", 5).await, Err(SearchError::EmptyQuery));
    Ok(())
}

#[tokio::test]
async fn usage_reads_the_months_count_and_says_when_signed_out_or_the_cloud_is_away() -> Result {
    let counts = json!({ "month": { "used": 12, "allowance": 1000 }, "day": { "used": 2, "cap": 100 },
                         "resetsAt": "2026-12-01T00:00:00Z" });
    let (root, fake) = cloud(Answer::Json(counts)).await?;
    let hands = Hands::new();
    assert_eq!(
        search(&root, &hands)?.usage().await,
        Usage {
            signed_in: true,
            used: Some(12),
            allowance: Some(1000),
            resets_at: Some("2026-12-01T00:00:00Z".to_owned()),
        }
    );
    let asked = &fake.seen()[0];
    assert_eq!(
        (asked.path.as_str(), asked.bearer.as_deref()),
        ("/v1/search/usage", Some("Bearer grant-1"))
    );
    let (signed_out, _) = search_at(Some(root.clone()), false, &hands, Duration::from_secs(2))?;
    assert_eq!(signed_out.usage().await, Usage::signed_out());
    fake.answer_with(Answer::Status(
        503,
        None,
        json!({ "error": "search_unavailable" }),
    ));
    assert_eq!(search(&root, &hands)?.usage().await, Usage::unknown());
    Ok(())
}
