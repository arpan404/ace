//! Spade's web search. Backends listed in `config/search.json` are tried in order: the person's
//! own SearXNG (free) and Brave with their key (kept in the OS keychain, ADR 0119). A backend
//! that fails or has no key is skipped with a reason and the next one is tried. A model endpoint's
//! own built-in search, where offered, is chosen by the harness before any of these.

mod backend;
mod clean;
pub mod config;

use std::sync::RwLock;
use std::time::Duration;

use spade_keys::Keys;

pub use config::{Backend, ConfigError, Kind, SearchConfig};

/// The most results one search returns.
pub const MOST_RESULTS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Results, with the backend that found them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub backend: String,
    pub results: Vec<SearchResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SearchError {
    #[error("the search query is empty")]
    EmptyQuery,
    #[error("no search backend is set up: run SearXNG or add a Brave key")]
    NoBackends,
    /// Nothing is set up: no SearXNG answers where Spade looked and no Brave key is stored.
    #[error(
        "no web search is set up: add a Brave Search key or a SearXNG address in Spade's settings"
    )]
    NotSetUp,
    #[error("no search backend answered: {}", .0.iter().map(|(id, why)| format!("{id}: {why}")).collect::<Vec<_>>().join("; "))]
    AllFailed(Vec<(String, String)>),
    #[error("the HTTP client could not be built: {0}")]
    Setup(String),
    #[error("the SearXNG address must start with http:// or https://")]
    BadAddress,
}

/// One raw result: title, address, snippet.
type Raw = (String, String, String);

pub struct Search {
    http: reqwest::Client,
    /// For requests that carry a key: never follows a redirect, so the key only reaches the
    /// configured server.
    keyed: reqwest::Client,
    backends: Vec<Backend>,
    keys: Keys,
    /// The person's own SearXNG, set in Spade's settings: used in place of the file's address.
    searxng: RwLock<Option<String>>,
}

/// Why one backend gave no results, and whether that is only because it is not set up (no key,
/// or no SearXNG where the file says one may be).
struct Failure {
    reason: String,
    absent: bool,
}

impl Failure {
    fn absent(reason: &str) -> Self {
        Self {
            reason: reason.to_owned(),
            absent: true,
        }
    }
}

impl Search {
    /// Each backend call gives up after `timeout`.
    pub fn new(config: SearchConfig, keys: Keys, timeout: Duration) -> Result<Self, SearchError> {
        let client = |redirects: reqwest::redirect::Policy| {
            reqwest::Client::builder()
                .timeout(timeout)
                .user_agent("spade-search")
                .redirect(redirects)
                .build()
                .map_err(|e| SearchError::Setup(e.to_string()))
        };
        Ok(Self {
            http: client(reqwest::redirect::Policy::default())?,
            keyed: client(reqwest::redirect::Policy::none())?,
            backends: config.backends,
            keys,
            searxng: RwLock::new(None),
        })
    }

    /// Uses the person's own SearXNG at `url` (`None` goes back to the file's address). Only an
    /// `http` or `https` address is taken.
    pub fn set_searxng(&self, url: Option<&str>) -> Result<(), SearchError> {
        let url = url.map(str::trim).filter(|url| !url.is_empty());
        let url = match url {
            None => None,
            Some(url) => Some(searxng_address(url).ok_or(SearchError::BadAddress)?),
        };
        *self.searxng.write().unwrap_or_else(|p| p.into_inner()) = url;
        Ok(())
    }

    /// Whether a key for backend `id` is found (keychain, then its environment variable).
    pub async fn has_key(&self, id: &str) -> bool {
        let Some(backend) = self.backends.iter().find(|b| b.id == id) else {
            return false;
        };
        self.keys
            .find(&backend.id, backend.key_env.as_deref())
            .await
            .is_some()
    }

    /// The person's own SearXNG address, when they set one.
    pub fn searxng(&self) -> Option<String> {
        self.searxng
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Searches the web for `query`, returning up to `count` results (at most [`MOST_RESULTS`]).
    pub async fn search(&self, query: &str, count: usize) -> Result<Found, SearchError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(SearchError::EmptyQuery);
        }
        if self.backends.is_empty() {
            return Err(SearchError::NoBackends);
        }
        let count = count.clamp(1, MOST_RESULTS);
        let mut failures = Vec::new();
        let mut set_up = false;
        for backend in &self.backends {
            match self.ask(backend, query, count).await {
                Ok(raw) => {
                    return Ok(Found {
                        backend: backend.id.clone(),
                        results: clean::results(raw, count),
                    });
                }
                Err(failure) => {
                    set_up |= !failure.absent;
                    failures.push((backend.id.clone(), failure.reason));
                }
            }
        }
        if set_up {
            Err(SearchError::AllFailed(failures))
        } else {
            Err(SearchError::NotSetUp)
        }
    }

    async fn ask(&self, backend: &Backend, query: &str, count: usize) -> Result<Vec<Raw>, Failure> {
        let key = if backend.needs_key {
            // Off the async workers: a keychain read can block on a prompt.
            Some(
                self.keys
                    .find(&backend.id, backend.key_env.as_deref())
                    .await
                    .ok_or_else(|| Failure::absent("no key in the keychain or environment"))?,
            )
        } else {
            None
        };
        let failed = |reason: String| Failure {
            reason,
            absent: false,
        };
        match (backend.kind, key) {
            (Kind::Searxng, _) => {
                let mine = self.searxng();
                let base = mine.as_deref().unwrap_or(&backend.base_url);
                backend::searxng::search(&self.http, base, query)
                    .await
                    .map_err(|reason| Failure {
                        // Nothing listening where the file looks, and the person named no
                        // SearXNG of their own: there is none.
                        absent: mine.is_none() && reason == backend::NO_CONNECTION,
                        reason,
                    })
            }
            (Kind::Brave, Some(key)) => {
                backend::brave::search(&self.keyed, &backend.base_url, &key, query, count)
                    .await
                    .map_err(failed)
            }
            (Kind::Brave, None) => Err(Failure::absent("no key")),
        }
    }
}

/// A SearXNG address as used: `http` or `https` with a host, ending with `/`.
fn searxng_address(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    let text = parsed.to_string();
    Some(if text.ends_with('/') {
        text
    } else {
        format!("{text}/")
    })
}
