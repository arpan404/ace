//! What research reads the web through: searches and page reads, behind a trait so tests give
//! fixed pages. The live one uses `web_search`'s backends and `web_fetch`'s fetcher, with all
//! their protections (no local or private addresses, size and time bounds).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use spade_core::research::Hit;
use spade_fetch::{Fetcher, Page};
use spade_search::Search;

pub type WebFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

/// A page read for research.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Read {
    pub url: String,
    pub title: String,
    pub text: String,
}

pub trait Web: Send + Sync {
    fn search(&self, query: &str, count: usize) -> WebFuture<Vec<Hit>>;
    fn read(&self, url: &str) -> WebFuture<Read>;
}

/// Most characters of one page research reads.
const PAGE_CHARS: usize = 40_000;

pub struct LiveWeb {
    pub search: Arc<Search>,
    pub fetcher: Arc<Fetcher>,
}

impl Web for LiveWeb {
    fn search(&self, query: &str, count: usize) -> WebFuture<Vec<Hit>> {
        let (search, query) = (self.search.clone(), query.to_owned());
        Box::pin(async move {
            let found = search
                .search(&query, count)
                .await
                .map_err(|e| e.to_string())?;
            Ok(found
                .results
                .into_iter()
                .map(|r| Hit {
                    url: r.url,
                    title: r.title,
                })
                .collect())
        })
    }

    fn read(&self, url: &str) -> WebFuture<Read> {
        let (fetcher, url) = (self.fetcher.clone(), url.to_owned());
        Box::pin(async move {
            let page = Page {
                offset: 0,
                max_chars: PAGE_CHARS,
            };
            let fetched = fetcher.fetch(&url, page).await.map_err(|e| e.to_string())?;
            Ok(Read {
                url: fetched.url,
                title: fetched.title.unwrap_or_default(),
                text: fetched.text,
            })
        })
    }
}
