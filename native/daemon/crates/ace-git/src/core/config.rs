// SPDX-License-Identifier: Apache-2.0
//! Which files can change what a Git command reads as configuration, and
//! when one of their stamps is trustworthy (`packages/git/src/config-sources.ts`
//! and the stamp half of `config-facts.ts`, G2c).
//!
//! Nothing here launches Git: the caller passes the raw `rev-parse` and
//! `config --list` output, exactly as TypeScript hands it to the parsers.

use ace_json::{Array, JsString, Value};

use crate::core::error::GitError;

/// A file changed this recently may change again within the filesystem's
/// timestamp granularity without its stamp moving, so a snapshot is trusted
/// only once every source is older than this.
pub const SETTLE_MS: i64 = 2_000;
/// Cached checkouts (and settling windows) kept before the oldest is dropped.
pub const CAPACITY: usize = 256;

/// The pieces a fact's cache needs from its caller: where the sources are,
/// what to compute, whether the value may be kept, and the clock.
pub trait ConfigPorts: Send + Sync {
    /// The files whose change can alter this checkout's configuration.
    fn sources(
        &self,
        call: u64,
        cwd: &str,
        env_json: &str,
    ) -> crate::core::spawn::BoxFuture<'_, Option<Vec<String>>>;
    /// The fact itself, computed by its owner.
    fn compute(&self, call: u64) -> crate::core::spawn::BoxFuture<'_, Result<Value, GitError>>;
    /// Whether the owner agrees this value may be kept.
    fn keep(&self, call: u64, value: &Value) -> crate::core::spawn::BoxFuture<'_, bool>;
    /// Wall clock in epoch milliseconds, comparable with file timestamps.
    fn now_ms(&self, call: u64) -> crate::core::spawn::BoxFuture<'_, i64>;
}

/// Facts derived only from a checkout's Git configuration and discovery (its
/// root, remotes, configured filter drivers and hooks), kept until any file
/// Git would read them from changes (`ConfigFacts` in `config-facts.ts`).
/// One key's in-flight source learning, which later callers join.
type Flight = std::sync::Arc<tokio::sync::OnceCell<Option<std::sync::Arc<Snapshot>>>>;

pub struct ConfigFacts {
    snapshots: std::sync::Mutex<Snapshots>,
    flights: std::sync::Mutex<std::collections::HashMap<String, Flight>>,
    settling: std::sync::Mutex<std::collections::HashMap<String, i64>>,
    ports: std::sync::Arc<dyn ConfigPorts>,
}

struct Snapshots {
    by_key: std::collections::HashMap<String, std::sync::Arc<Snapshot>>,
    /// Insertion order, oldest first, for eviction.
    order: Vec<String>,
}

struct Snapshot {
    paths: Vec<String>,
    stamp: String,
    values: std::sync::Mutex<std::collections::BTreeMap<String, Value>>,
}

impl ConfigFacts {
    pub fn new(ports: std::sync::Arc<dyn ConfigPorts>) -> Self {
        Self {
            snapshots: std::sync::Mutex::new(Snapshots {
                by_key: std::collections::HashMap::new(),
                order: Vec::new(),
            }),
            flights: std::sync::Mutex::new(std::collections::HashMap::new()),
            settling: std::sync::Mutex::new(std::collections::HashMap::new()),
            ports,
        }
    }

    /// Reads one named fact: a kept value when every source is unchanged,
    /// otherwise `compute`, kept only when the sources are still the same
    /// before and after it and its owner allows it.
    pub async fn read(
        &self,
        call: u64,
        cwd: &str,
        env: &[(String, String)],
        name: &str,
    ) -> Result<Value, GitError> {
        let env_json = env_key(env);
        let key = format!("{cwd}\u{0}{env_json}");
        let (snapshot, checked) = self.snapshot(call, &key).await;
        let Some(snapshot) = snapshot else {
            // Sources are learned only after a computation succeeds, so a failing one never
            // adds more work. The next call can keep a value.
            let value = self.ports.compute(call).await?;
            self.learn_once(call, &key, cwd, &env_json).await;
            return Ok(value);
        };
        let kept = snapshot
            .values
            .lock()
            .ok()
            .and_then(|values| values.get(name).cloned());
        if let Some(kept) = kept {
            // A snapshot learned for another caller was stamped before this call began.
            if !checked
                && stamp_of(&snapshot.paths).map(|stamp| stamp.stamp)
                    != Some(snapshot.stamp.clone())
            {
                return self.ports.compute(call).await;
            }
            return Ok(kept);
        }
        let value = self.ports.compute(call).await?;
        let after = stamp_of(&snapshot.paths);
        let unchanged = after.as_ref().map(|stamp| &stamp.stamp) == Some(&snapshot.stamp);
        if unchanged
            && self.ports.keep(call, &value).await
            && self.is_current(&key, &snapshot)
            && let Ok(mut values) = snapshot.values.lock()
        {
            values.insert(name.to_owned(), value.clone());
        }
        Ok(value)
    }

    /// The checkout's snapshot if its sources are unchanged; one being learned is joined.
    async fn snapshot(&self, _call: u64, key: &str) -> (Option<std::sync::Arc<Snapshot>>, bool) {
        let known = self
            .snapshots
            .lock()
            .ok()
            .and_then(|snapshots| snapshots.by_key.get(key).cloned());
        if let Some(known) = known {
            if stamp_of(&known.paths).map(|stamp| stamp.stamp) == Some(known.stamp.clone()) {
                return (Some(known), true);
            }
            if let Ok(mut snapshots) = self.snapshots.lock()
                && snapshots
                    .by_key
                    .get(key)
                    .is_some_and(|current| std::sync::Arc::ptr_eq(current, &known))
            {
                snapshots.by_key.remove(key);
                snapshots.order.retain(|entry| entry != key);
            }
        }
        let flight = self
            .flights
            .lock()
            .ok()
            .and_then(|flights| flights.get(key).cloned());
        match flight {
            Some(cell) => (cell.get_or_init(|| async { None }).await.clone(), false),
            None => (None, false),
        }
    }

    async fn learn_once(&self, call: u64, key: &str, cwd: &str, env_json: &str) {
        if self
            .snapshots
            .lock()
            .ok()
            .is_some_and(|snapshots| snapshots.by_key.contains_key(key))
        {
            return;
        }
        let existing = self
            .flights
            .lock()
            .ok()
            .and_then(|flights| flights.get(key).cloned());
        if let Some(cell) = existing {
            let _ = cell.get_or_init(|| async { None }).await;
            return;
        }
        // Sources still settling: asking Git again before then can't produce a snapshot either.
        let settling = self
            .settling
            .lock()
            .ok()
            .and_then(|settling| settling.get(key).copied());
        if let Some(until) = settling {
            if self.ports.now_ms(call).await < until {
                return;
            }
            if let Ok(mut settling) = self.settling.lock() {
                settling.remove(key);
            }
        }
        let cell = std::sync::Arc::new(tokio::sync::OnceCell::new());
        if let Ok(mut flights) = self.flights.lock() {
            flights.insert(key.to_owned(), std::sync::Arc::clone(&cell));
        }
        let learned = self.learn(call, key, cwd, env_json).await;
        let _ = cell.set(learned);
        if let Ok(mut flights) = self.flights.lock() {
            flights.remove(key);
        }
    }

    async fn learn(
        &self,
        call: u64,
        key: &str,
        cwd: &str,
        env_json: &str,
    ) -> Option<std::sync::Arc<Snapshot>> {
        let started = self.ports.now_ms(call).await;
        let paths = self.ports.sources(call, cwd, env_json).await?;
        let stamped = stamp_of(&paths)?;
        // Anything written since just before Git listed the sources may hold an include it
        // didn't see, so the snapshot waits for every source to settle.
        if stamped.newest_ms >= started - SETTLE_MS {
            if let Ok(mut settling) = self.settling.lock() {
                settling.insert(key.to_owned(), stamped.newest_ms.max(started) + SETTLE_MS);
                if settling.len() > CAPACITY {
                    settling.clear();
                }
            }
            return None;
        }
        let snapshot = std::sync::Arc::new(Snapshot {
            paths,
            stamp: stamped.stamp,
            values: std::sync::Mutex::new(std::collections::BTreeMap::new()),
        });
        if let Ok(mut snapshots) = self.snapshots.lock() {
            snapshots
                .by_key
                .insert(key.to_owned(), std::sync::Arc::clone(&snapshot));
            snapshots.order.retain(|entry| entry != key);
            snapshots.order.push(key.to_owned());
            while snapshots.by_key.len() > CAPACITY {
                let oldest = snapshots.order.remove(0);
                snapshots.by_key.remove(&oldest);
            }
        }
        Some(snapshot)
    }

    fn is_current(&self, key: &str, snapshot: &std::sync::Arc<Snapshot>) -> bool {
        self.snapshots.lock().ok().is_some_and(|snapshots| {
            snapshots
                .by_key
                .get(key)
                .is_some_and(|current| std::sync::Arc::ptr_eq(current, snapshot))
        })
    }
}

fn env_key(env: &[(String, String)]) -> String {
    let pairs: Vec<Value> = env
        .iter()
        .map(|(key, value)| {
            Value::Array(Array::from(vec![
                Value::String(JsString::from(key.as_str())),
                Value::String(JsString::from(value.as_str())),
            ]))
        })
        .collect();
    ace_json::to_string(&Value::Array(Array::from(pairs)))
}

mod sources;
mod stamp;

pub use sources::{
    CONFIG_NEUTRAL, Layout, WatchInput, config_environment, invalid_request, listed_sources,
    parse_layout, paths_to_json, single, watch_input_from_json, watched_paths,
};
pub use stamp::{Stamp, stamp_of};

#[cfg(test)]
mod tests;
