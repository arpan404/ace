// SPDX-License-Identifier: Apache-2.0
//! Catalogs one app-server has served, by the config that chose them
//! (`CodexCatalogCache`, `tool-facts.ts:52`-`:76`).

use indexmap::IndexMap;

/// A catalog Codex served: its slugs with hidden models included.
pub type Catalog = Vec<String>;

/// One key's load in a host-wide cache (`CodexCatalogCache`).
#[derive(Debug, Default)]
struct Entry {
    /// The settled value; `None` while a load runs.
    catalog: Option<Option<Catalog>>,
    /// Reads waiting for this key, by their wake token.
    waiters: Vec<u64>,
}

/// What `read`/`put` found for one key.
#[derive(Debug, Clone, PartialEq)]
pub enum Cached {
    /// The load is done: its value, or `None` when the read failed.
    Ready(Option<Catalog>),
    /// Another read is loading it; this read waits for its wake token.
    Waiting,
    /// Nobody is loading it: this read starts the load.
    Start,
}

/// What a settled load told the shell to hand to its waiters.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogSettled {
    pub waiters: Vec<u64>,
    pub catalog: Option<Catalog>,
}

/// Catalogs one app-server has served, by the config that chose them
/// (`CodexCatalogCache`). A read that failed is forgotten so the next thread
/// retries; a catalog rarely changes while its app-server runs.
#[derive(Debug, Default)]
pub struct CodexCatalogCache {
    entries: IndexMap<String, Entry>,
}

impl CodexCatalogCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// `cache.size`: entries, a load in flight included.
    pub fn size(&self) -> usize {
        self.entries.len()
    }

    /// `read(key, load)`: the cached value, a wait, or a load to start. The
    /// caller is registered as a waiter either way.
    pub fn read(&mut self, key: &str, wake: u64) -> Cached {
        match self.entries.get_mut(key) {
            Some(entry) => match &entry.catalog {
                Some(catalog) => Cached::Ready(catalog.clone()),
                None => {
                    if !entry.waiters.contains(&wake) {
                        entry.waiters.push(wake);
                    }
                    Cached::Waiting
                }
            },
            None => {
                self.entries.insert(
                    key.to_owned(),
                    Entry {
                        catalog: None,
                        waiters: vec![wake],
                    },
                );
                Cached::Start
            }
        }
    }

    /// `put(key, catalog)`: a load started before its key was known.
    pub fn put(&mut self, key: &str, wake: u64) -> Cached {
        self.read(key, wake)
    }

    /// The load finished: keep a value, forget a failed read, and hand the
    /// waiters what the promise resolved with.
    pub fn settle(&mut self, key: &str, catalog: Option<Catalog>) -> CatalogSettled {
        let waiters = self
            .entries
            .get(key)
            .map(|entry| entry.waiters.clone())
            .unwrap_or_default();
        if catalog.is_none() {
            self.entries.shift_remove(key);
        } else if let Some(entry) = self.entries.get_mut(key) {
            entry.catalog = Some(catalog.clone());
            entry.waiters.clear();
        }
        CatalogSettled { waiters, catalog }
    }

    /// A read that finished without its catalog leaves the queue.
    pub fn abandon(&mut self, key: &str, wake: u64) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.waiters.retain(|token| *token != wake);
        }
    }
}
