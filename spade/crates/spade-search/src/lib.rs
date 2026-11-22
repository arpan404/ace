//! Spade's web search: ace cloud search, `POST {cloud}/v1/search` (ADR 0210). Spade shows the
//! cloud the person's ace account credential it already holds for the sign-in broker; no secret
//! of its own is stored. After a refusal it waits out `Retry-After`, and after a failure 30
//! seconds, answering with the refusal's sentence meanwhile, so a bot can't hammer the route.

mod clean;
mod refusal;
mod usage;
mod wire;

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

pub use refusal::RESTING;
pub use usage::Usage;

/// The most results one search returns.
pub const MOST_RESULTS: usize = 10;
/// The longest query sent, in characters, after trimming.
pub const MOST_QUERY_CHARS: usize = 400;
/// The sentence when the person isn't signed in to ace.
pub const SIGN_IN: &str = "Sign in to ace to search the web.";
/// The sentence when ace search failed or couldn't be reached.
pub const AWAY: &str = "ace search isn't answering right now. Try again shortly.";
/// The sentence when ace search is turned off on this Spade (`SPADE_CLOUD_URL=off`).
pub const OFF: &str = "ace search is turned off on this Spade.";

/// The header that names the calling app and its version to ace cloud (ADR 0189).
const ACE_CLIENT_HEADER: &str = "ace-client";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub site: String,
}

/// Results, with the provider ace cloud found them with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub provider: String,
    pub results: Vec<SearchResult>,
}

/// Why no search was made or none came back. Each shows as one plain sentence.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SearchError {
    #[error("the search query is empty")]
    EmptyQuery,
    #[error("{OFF}")]
    Off,
    #[error("{SIGN_IN}")]
    SignedOut,
    /// ace cloud refused (`429`), or Spade is still waiting out an earlier refusal. `reason` is
    /// the sentence to show.
    #[error("{reason}")]
    Refused { error: String, reason: String },
    /// ace search failed, answered with something unreadable, or couldn't be reached. The detail
    /// is for logs; it never carries the grant.
    #[error("{AWAY}")]
    Failed(String),
    #[error("the HTTP client could not be built: {0}")]
    Setup(String),
}

/// Why there is no ace account credential to show the cloud.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoGrant {
    /// This machine isn't signed in to an ace account.
    SignedOut,
    /// ace didn't answer.
    Unreachable(String),
}

pub type GrantFuture<'a> = Pin<Box<dyn Future<Output = Result<String, NoGrant>> + Send + 'a>>;

/// Where the person's ace account credential comes from: ace in Spade, a fake in tests.
pub trait Credential: Send + Sync {
    /// A short-lived machine grant (ADR 0111), shown as a bearer.
    fn grant(&self) -> GrantFuture<'_>;
}

/// The time now, injected so tests can move it.
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

/// Where and how to reach ace cloud search.
#[derive(Clone)]
pub struct Cloud {
    /// The cloud's address; `None` turns ace search off.
    pub url: Option<String>,
    pub credential: Arc<dyn Credential>,
    /// `ace-client: spade/<version>` (ADR 0189), sent on every request when set.
    pub ace_client: Option<String>,
    /// Each search gives up after this.
    pub timeout: Duration,
    pub clock: Clock,
}

pub struct Search {
    http: reqwest::Client,
    url: Option<String>,
    credential: Arc<dyn Credential>,
    ace_client: Option<String>,
    clock: Clock,
    /// Until when no request is made, and what is answered meanwhile.
    waiting: Mutex<Option<(Instant, SearchError)>>,
}

impl Search {
    pub fn new(cloud: Cloud) -> Result<Self, SearchError> {
        // Never follows a redirect: the grant is a bearer, and must reach only the cloud.
        let http = reqwest::Client::builder()
            .timeout(cloud.timeout)
            .user_agent("spade-search")
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| SearchError::Setup(e.to_string()))?;
        Ok(Self {
            http,
            url: cloud
                .url
                .map(|url| url.trim().trim_end_matches('/').to_owned()),
            credential: cloud.credential,
            ace_client: cloud.ace_client,
            clock: cloud.clock,
            waiting: Mutex::new(None),
        })
    }

    /// Searches the web for `query`, returning up to `count` results (at most [`MOST_RESULTS`]).
    pub async fn search(&self, query: &str, count: usize) -> Result<Found, SearchError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(SearchError::EmptyQuery);
        }
        let Some(url) = &self.url else {
            return Err(SearchError::Off);
        };
        if let Some(answer) = self.still_waiting() {
            return Err(answer);
        }
        if !wire::secure_cloud_url(url) {
            return Err(SearchError::Failed(
                "the cloud address is not https".to_owned(),
            ));
        }
        let grant = self.grant().await?;
        let limit = count.clamp(1, MOST_RESULTS);
        let query: String = query.chars().take(MOST_QUERY_CHARS).collect();
        let mut request = self
            .http
            .post(format!("{url}/v1/search"))
            .bearer_auth(grant)
            .json(&json!({ "query": query, "limit": limit }));
        if let Some(name) = &self.ace_client {
            request = request.header(ACE_CLIENT_HEADER, name);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => return Err(self.failed(transport_reason(&error))),
        };
        match response.status().as_u16() {
            200 => match wire::json_body(response, wire::MOST_BODY_BYTES).await {
                Ok(page) => Ok(Found {
                    provider: page
                        .get("provider")
                        .and_then(Value::as_str)
                        .unwrap_or("ace")
                        .to_owned(),
                    results: clean::results(wire::items(page.get("results")), limit),
                }),
                Err(error) => Err(self.failed(format!("ace search's answer: {error:?}"))),
            },
            429 => {
                let header = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let body = wire::json_body(response, wire::MOST_BODY_BYTES).await.ok();
                let (error, reason) = refusal::read(body.as_ref());
                let refused = SearchError::Refused { error, reason };
                let wait = refusal::wait(header.as_deref(), body.as_ref());
                self.wait_for(wait, refused.clone());
                Err(refused)
            }
            401 | 403 => Err(SearchError::SignedOut),
            status => Err(self.failed(format!("ace search answered HTTP {status}"))),
        }
    }

    /// The account's ace search use this month, for the settings line. Asks the cloud with a
    /// 5-second bound; never fails, answering nulls when the cloud is away.
    pub async fn usage(&self) -> Usage {
        let grant = match self.credential.grant().await {
            Ok(grant) => grant,
            Err(NoGrant::SignedOut) => return Usage::signed_out(),
            Err(NoGrant::Unreachable(_)) => return Usage::unknown(),
        };
        match &self.url {
            Some(url) if wire::secure_cloud_url(url) => {
                usage::ask(&self.http, url, &grant, self.ace_client.as_deref()).await
            }
            _ => Usage::unknown(),
        }
    }

    async fn grant(&self) -> Result<String, SearchError> {
        self.credential
            .grant()
            .await
            .map_err(|problem| match problem {
                NoGrant::SignedOut => SearchError::SignedOut,
                // ace itself is away: nothing reached the cloud, so there is nothing to wait out.
                NoGrant::Unreachable(why) => SearchError::Failed(why),
            })
    }

    fn still_waiting(&self) -> Option<SearchError> {
        let now = (self.clock)();
        let mut waiting = self.waiting.lock().unwrap_or_else(|p| p.into_inner());
        match waiting.as_ref() {
            Some((until, answer)) if now < *until => Some(answer.clone()),
            Some(_) => {
                *waiting = None;
                None
            }
            None => None,
        }
    }

    fn wait_for(&self, wait: Duration, answer: SearchError) {
        let until = (self.clock)() + wait;
        *self.waiting.lock().unwrap_or_else(|p| p.into_inner()) = Some((until, answer));
    }

    fn failed(&self, why: String) -> SearchError {
        let failed = SearchError::Failed(why);
        self.wait_for(refusal::FAILED_WAIT, failed.clone());
        failed
    }
}

/// A request error in a few words, without the URL or the grant.
fn transport_reason(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timed out".to_owned()
    } else if error.is_connect() {
        "could not connect".to_owned()
    } else {
        "the request failed".to_owned()
    }
}
