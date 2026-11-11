//! Spade's web search. Backends listed in `config/search.json` are tried in order: the person's
//! own SearXNG (free) and Brave with their key (kept in the OS keychain, ADR 0119). A backend
//! that fails or has no key is skipped with a reason and the next one is tried. A model endpoint's
//! own built-in search, where offered, is chosen by the harness before any of these.

mod backend;
mod clean;
pub mod config;

use std::time::Duration;

use spade_keys::{KeyRequest, Keys};

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
    #[error("no search backend answered: {}", .0.iter().map(|(id, why)| format!("{id}: {why}")).collect::<Vec<_>>().join("; "))]
    AllFailed(Vec<(String, String)>),
    #[error("the HTTP client could not be built: {0}")]
    Setup(String),
}

pub struct Search {
    http: reqwest::Client,
    /// For requests that carry a key: never follows a redirect, so the key only reaches the
    /// configured server.
    keyed: reqwest::Client,
    backends: Vec<Backend>,
    keys: Keys,
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
        })
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
        for backend in &self.backends {
            match self.ask(backend, query, count).await {
                Ok(raw) => {
                    return Ok(Found {
                        backend: backend.id.clone(),
                        results: clean::results(raw, count),
                    });
                }
                Err(reason) => failures.push((backend.id.clone(), reason)),
            }
        }
        Err(SearchError::AllFailed(failures))
    }

    async fn ask(
        &self,
        backend: &Backend,
        query: &str,
        count: usize,
    ) -> Result<Vec<(String, String, String)>, String> {
        let key = if backend.needs_key {
            let request = KeyRequest {
                endpoint: &backend.id,
                env: backend.key_env.as_deref(),
            };
            Some(
                self.keys
                    .get(request)
                    .ok_or("no key in the keychain or environment")?,
            )
        } else {
            None
        };
        match (backend.kind, key) {
            (Kind::Searxng, _) => {
                backend::searxng::search(&self.http, &backend.base_url, query).await
            }
            (Kind::Brave, Some(key)) => {
                backend::brave::search(&self.keyed, &backend.base_url, &key, query, count).await
            }
            (Kind::Brave, None) => Err("no key".to_owned()),
        }
    }
}
