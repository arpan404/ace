//! Which plugins each bot may use, kept in Spade's database (`settings`, key `plugins.access`):
//! a bot's plugin names. A bot gets none until the person turns one on (ADR 0151, point 8).

use std::collections::{BTreeMap, BTreeSet};

use spade_store::Store;

const KEY: &str = "plugins.access";

pub struct Access {
    store: std::sync::Arc<Store>,
    /// Held across reading and writing the list, so changes never overwrite each other.
    lock: std::sync::Mutex<()>,
}

impl Access {
    pub fn new(store: std::sync::Arc<Store>) -> Self {
        Self {
            store,
            lock: std::sync::Mutex::new(()),
        }
    }

    pub fn allowed(&self, agent: &str) -> BTreeSet<String> {
        self.all().remove(agent).unwrap_or_default()
    }

    pub fn set(&self, agent: &str, names: BTreeSet<String>) -> Result<(), spade_store::StoreError> {
        let _held = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut all = self.all();
        if names.is_empty() {
            all.remove(agent);
        } else {
            all.insert(agent.to_owned(), names);
        }
        let text = serde_json::to_string(&all).unwrap_or_else(|_| "{}".to_owned());
        self.store.set_setting(KEY, Some(&text))
    }

    fn all(&self) -> BTreeMap<String, BTreeSet<String>> {
        match self.store.setting(KEY) {
            Ok(Some(text)) => serde_json::from_str(&text).unwrap_or_else(|error| {
                tracing::warn!(%error, "the bots' plugin lists could not be read; none allowed");
                BTreeMap::new()
            }),
            Ok(None) => BTreeMap::new(),
            Err(error) => {
                tracing::warn!(%error, "could not read the bots' plugin lists; none allowed");
                BTreeMap::new()
            }
        }
    }
}
